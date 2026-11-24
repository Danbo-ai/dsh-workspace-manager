/**
 * 会话搬家：把一条会话从一个工作区挪到另一个工作区。
 *
 * 宿主的会话归属由「会话日志 header 里的 cwd」决定：
 *   - workspace 记录里的 sessionIds 只是名单，读取时按 candidateMatches(id, path) 过滤，
 *     而 candidateMatches 比的是 header.cwd 与工作区 path（realpath 后精确相等）。
 *   - 所以「换个文件夹」= 改 header.cwd + 把日志目录移到目标 cwd 的桶 + 同步投影 + 改归属。
 *
 * 会话日志 `session.v4.jsonl.zstd` 是**多帧 zstd 拼接**：第一帧是 header 行，后面每帧是增量事件。
 * 改 cwd 只解第一帧 → 改 JSON → 重压 → 拼回后面的原始字节，其余内容一个字节都不动。
 *
 * 投影缓存 `session_projcache/sessions/<id>.json` 有两处要跟着改：
 *   - `record.rows.workingDirectory.val`：侧栏与「子目录优先」读它；
 *   - `record.identity.cwd`：宿主冷启动时用它和日志 header 逐字段比对，
 *     **对不上就当这条缓存不成立，侧栏回落成「未命名」**（这正是上一版漏掉的那一步）。
 *
 * 磁盘改完后再改归属：宿主在跑就调 workspaceRegistry 的内存接口，让侧栏立刻动、不用重启；
 * 拿不到注册表才退回改 workspace.json 并提示重启。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { mark } from './mark.js'
import { service } from './service.js'

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSION_LOG = 'session.v4.jsonl.zstd'

/** `~/.dsh` 下与搬家相关的固定位置（支持环境变量覆盖，便于离线测试）。 */
export function dshPaths() {
  const home = process.env.WSM_HOME_DIR ?? process.env.USERPROFILE ?? os.homedir()
  const root = process.env.WSM_DSH_DIR ?? path.join(home, '.dsh')
  const storages = path.join(root, 'storages')
  return {
    root,
    sessions: path.join(root, 'sessions'),
    projcache: path.join(storages, 'session_projcache', 'sessions'),
    workspaceFile: path.join(storages, 'workspace.json'),
    backups: path.join(root, 'workspace-manager-backups'),
  }
}

/**
 * 把 cwd 编码成会话桶目录名：`\` `/` `:` → `-`，空格 → `~0020`，非 ASCII → `~XXXX`，整体包 `--`。
 * 例：`D:\dsh\projects\打杂` → `--D-dsh-projects-~6253~6742--`。
 * @param cwd - 绝对路径。
 */
export function encodeCwd(cwd) {
  const out = []
  for (const char of String(cwd ?? '')) {
    const code = char.codePointAt(0)
    if (char === '\\' || char === '/' || char === ':') out.push('-')
    else if (char === ' ') out.push('~0020')
    else if (code >= 0x21 && code <= 0x7e) out.push(char)
    else out.push(`~${code.toString(16).toUpperCase().padStart(4, '0')}`)
  }
  const body = out.join('').replace(/-+/gu, '-')
  return `--${body}--`
}

/** 扫描所有桶，找出这条会话的日志目录。 */
export function findSessionDir(sessionId) {
  const { sessions } = dshPaths()
  if (!fs.existsSync(sessions)) throw new Error(`会话根目录不存在：${sessions}`)
  for (const bucket of fs.readdirSync(sessions, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    const dir = path.join(sessions, bucket.name, sessionId)
    if (fs.existsSync(path.join(dir, SESSION_LOG))) {
      return { bucket: bucket.name, dir, logFile: path.join(dir, SESSION_LOG) }
    }
  }
  throw new Error(`找不到会话日志：${sessionId}`)
}

/** 每帧 zstd 都以同一 magic 开头；返回各帧起始偏移（第一项恒为 0）。 */
export function frameOffsets(buffer) {
  const offsets = []
  let index = buffer.indexOf(FRAME_MAGIC, 0)
  while (index !== -1) {
    offsets.push(index)
    index = buffer.indexOf(FRAME_MAGIC, index + FRAME_MAGIC.length)
  }
  if (offsets.length === 0 || offsets[0] !== 0) offsets.unshift(0)
  return offsets
}

/** 读 header 行（第一帧）：返回 `{header, frameCount, bytes, offsets, text, buffer}`。 */
export function readLogHeader(logFile) {
  const buffer = fs.readFileSync(logFile)
  const offsets = frameOffsets(buffer)
  const firstEnd = offsets.length > 1 ? offsets[1] : buffer.length
  let text = ''
  try {
    text = zlib.zstdDecompressSync(buffer.subarray(0, firstEnd)).toString('utf8')
  } catch (error) {
    throw new Error(`会话日志第一帧解不开：${error?.message ?? String(error)}`)
  }
  const line = text.split('\n')[0]
  let header
  try {
    header = JSON.parse(line)
  } catch (error) {
    throw new Error(`会话日志 header 不是合法 JSON：${error?.message ?? String(error)}`)
  }
  return { header, frameCount: offsets.length, bytes: buffer.length, offsets, text, buffer }
}

/**
 * 把 header 里的 cwd 改掉，其余帧原样拼回。
 * @returns `{changed, bytes}`。
 */
export function rewriteLogCwd(logFile, newCwd) {
  const { header, offsets, text, buffer } = readLogHeader(logFile)
  const firstEnd = offsets.length > 1 ? offsets[1] : buffer.length
  if (header.cwd === newCwd) return { changed: false, bytes: buffer.length }
  header.cwd = newCwd
  const lines = text.split('\n')
  lines[0] = JSON.stringify(header)
  const frame = zlib.zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8'))
  const next = Buffer.concat([frame, buffer.subarray(firstEnd)])
  const temp = `${logFile}.tmp-${Date.now().toString(36)}`
  fs.writeFileSync(temp, next)
  fs.renameSync(temp, logFile)
  return { changed: true, bytes: next.length }
}

/**
 * 同步投影缓存：`rows.workingDirectory` 与 `record.identity.cwd` 一起改。
 *
 * identity 必须与日志 header 逐字段一致（formatVersion/createdAt/cwd/isSeeded），
 * 否则宿主冷启动时丢弃这条缓存、侧栏显示「未命名」——所以搬完必须补上这一步。
 * @param sessionId - 会话 id。
 * @param newCwd - 新工作目录。
 * @param header - 会话日志 header（用来对齐 createdAt/isSeeded 等字段）。
 */
export function patchProjection(sessionId, newCwd, header = undefined) {
  const { projcache } = dshPaths()
  const file = path.join(projcache, `${sessionId}.json`)
  if (!fs.existsSync(file)) return { updated: false, reason: '投影缓存里没有这条会话' }
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return { updated: false, reason: `投影缓存不是合法 JSON：${error?.message ?? String(error)}` }
  }
  const record = doc?.record
  const rows = record?.rows
  if (rows === undefined || rows === null) return { updated: false, reason: '投影缓存缺少 record.rows' }

  const previous = rows.workingDirectory?.val
  rows.workingDirectory = {
    ver: (rows.workingDirectory?.ver ?? 0) + 1,
    seq: (rows.workingDirectory?.seq ?? 0) + 1,
    val: newCwd,
  }

  let identitySynced = false
  const identity = record?.identity
  if (identity !== undefined && identity !== null) {
    identity.cwd = newCwd
    // header 里能对上的字段一并校准，避免「cwd 改了但其它字段还差一点」。
    if (header !== undefined && header !== null) {
      if (identity.formatVersion === undefined && header.version !== undefined) identity.formatVersion = header.version
      if (identity.createdAt === undefined && header.createdAt !== undefined) identity.createdAt = header.createdAt
      if (identity.isSeeded === undefined && header.isSeeded !== undefined) identity.isSeeded = header.isSeeded
    }
    identitySynced = true
  }

  const temp = `${file}.tmp-${Date.now().toString(36)}`
  fs.writeFileSync(temp, JSON.stringify(doc))
  fs.renameSync(temp, file)
  return {
    updated: true,
    identitySynced,
    from: typeof previous === 'string' ? previous : undefined,
  }
}

/** 读 workspace.json。 */
export function readWorkspaceTable(file = dshPaths().workspaceFile) {
  const raw = fs.readFileSync(file, 'utf8')
  return { raw, doc: JSON.parse(raw) }
}

/** 在登记表里算「源 → 目标」的迁移计划（只读，不改对象）。 */
export function planMembership(doc, sessionId, targetPath) {
  const table = doc?.tables?.workspaces
  if (table === undefined || table === null) throw new Error('workspace.json 缺少 tables.workspaces')
  const entries = Object.entries(table)
  const target = entries.find(([, record]) => samePath(record?.path, targetPath))
  if (target === undefined) throw new Error(`目标工作区未注册：${targetPath}`)
  const source = entries.find(([id, record]) => id !== target[0]
    && Array.isArray(record?.sessionIds)
    && record.sessionIds.includes(sessionId))
  return {
    sourceId: source?.[0],
    targetId: target[0],
    sameWorkspace: source?.[0] === target[0],
  }
}

/** 把会话写进目标、从源里删掉（只改内存对象）。 */
export function applyMembership(doc, plan, sessionId) {
  const table = doc.tables.workspaces
  const stamp = new Date().toISOString()
  let moved = false
  if (plan.sourceId !== undefined && plan.sourceId !== plan.targetId) {
    const record = table[plan.sourceId]
    record.sessionIds = record.sessionIds.filter((id) => id !== sessionId)
    record.updatedAt = stamp
    moved = true
  }
  const target = table[plan.targetId]
  target.sessionIds = Array.isArray(target.sessionIds) ? target.sessionIds : []
  if (!target.sessionIds.includes(sessionId)) {
    target.sessionIds = [sessionId, ...target.sessionIds]
    target.updatedAt = stamp
    moved = true
  }
  return moved
}

/** 路径比较：统一分隔符、去尾斜杠、忽略大小写。 */
export function samePath(left, right) {
  const norm = (value) => String(value ?? '').replace(/[\\/]+/gu, '/').replace(/\/+$/u, '').toLowerCase()
  const a = norm(left)
  return a !== '' && a === norm(right)
}

/** 整目录复制（备份用）。 */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(source, dest)
    else fs.copyFileSync(source, dest)
  }
}

/** 把目录挪到新桶；跨盘时退回复制 + 删除。 */
function moveDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
    return 'renamed'
  } catch (error) {
    copyDir(from, to)
    fs.rmSync(from, { recursive: true, force: true })
    return `copied (${error?.code ?? 'unknown'})`
  }
}

const shortId = (value) => String(value ?? '').replace(/^session-/u, '').slice(0, 8)

/**
 * 在运行中的宿主里直接改归属，让侧栏立刻刷新（不用重启）。
 *
 * 三层兜底：
 *   T1 `attachSession`：缓存/活会话的 header 已刷新时可用；
 *   T2 `host.rememberSessionPath` + `mutate`：TS private 只约束编译期，运行时可用；
 *   T3 改 workspace.json（由调用方执行）+ 提示重启。
 * @param ctx - cordis 插件上下文。
 * @param input - `{sessionId, target, from}`。
 */
async function syncMembership(ctx, { sessionId, target, from }) {
  const registry = service(ctx, 'workspaceRegistry')
  if (registry === undefined || typeof registry.get !== 'function') {
    return { applied: false, reason: 'workspaceRegistry 不可用' }
  }
  const list = typeof registry.list === 'function' ? registry.list() : []
  const sourceWorkspace = list.find((workspace) => samePath(workspace.path, from))
  const targetEntity = registry.get(target.id)
  if (targetEntity === undefined) return { applied: false, reason: '目标工作区不在注册表里' }

  const out = {
    applied: false,
    fromId: sourceWorkspace === undefined ? null : String(sourceWorkspace.id),
    toId: target.id,
    tier: 'none',
    target: 'skipped',
    source: 'skipped',
  }

  // T1：正常接口（header 已刷新时走这条）。
  try {
    await targetEntity.attachSession(sessionId)
    out.target = 'attached'
    out.tier = 'attach'
  } catch (error) {
    out.attachError = error?.message ?? String(error)
  }

  // T2：绕过候选过滤，直接把「已知路径」改成新 cwd 再写名单。
  if (out.tier === 'none') {
    try {
      targetEntity.host?.rememberSessionPath?.(sessionId, target.path)
      await targetEntity.mutate((record) => (record.sessionIds.includes(sessionId)
        ? record
        : { ...record, sessionIds: [sessionId, ...record.sessionIds] }))
      out.target = 'attached'
      out.tier = 'mutate'
    } catch (error) {
      out.target = `error: ${error?.message ?? String(error)}`
      return out
    }
  }

  if (sourceWorkspace !== undefined && String(sourceWorkspace.id) !== target.id) {
    const sourceEntity = registry.get(sourceWorkspace.id)
    try {
      if (sourceEntity === undefined) out.source = 'missing'
      else if (typeof sourceEntity.detachSession === 'function') {
        await sourceEntity.detachSession(sessionId)
        out.source = 'detached'
      } else out.source = 'unsupported'
    } catch (error) {
      out.source = `error: ${error?.message ?? String(error)}`
    }
  }
  out.applied = true
  return out
}

/**
 * 把一条会话搬到目标工作区。
 *
 * 顺序：定位 → 备份 → 改 header.cwd → 挪目录 → 改投影（含 identity）→ 改归属。
 * @param ctx - cordis 插件上下文（取 workspaceRegistry）。
 * @param options - `{sessionId, target, dryRun}`；target 可以是 id、路径或标题。
 */
export async function moveSession(ctx, options = {}) {
  const sessionId = normalizeSessionId(options.sessionId)
  if (!sessionId) throw new Error('缺少会话 id（sessionId）')
  const registry = service(ctx, 'workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') throw new Error('workspaceRegistry 不可用')
  const workspaces = registry.list().map((workspace) => ({
    id: String(workspace.id),
    path: workspace.path,
    title: workspace.title,
  }))
  const target = resolveTarget(workspaces, options.target)
  const source = findSessionDir(sessionId)
  const { header } = readLogHeader(source.logFile)
  const from = String(header.cwd ?? '')
  if (samePath(from, target.path)) {
    return {
      ok: true,
      changed: false,
      reason: '会话已经在这个工作区里',
      sessionId,
      workspaceId: target.id,
      path: target.path,
    }
  }

  const live = service(ctx, 'sessions')
  let running = false
  try {
    running = typeof live?.get === 'function' ? live.get(sessionId) !== undefined : false
  } catch {
    running = false
  }

  const plan = { sessionId, from, to: target.path, workspaceId: target.id, title: target.title, bucket: source.bucket }
  if (options.dryRun === true) return { ok: true, dryRun: true, ...plan, running, restartRequired: true }

  const { backups, workspaceFile } = dshPaths()
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const backupDir = path.join(backups, `${sessionId}-${stamp}`)
  copyDir(source.dir, backupDir)
  fs.copyFileSync(workspaceFile, path.join(backupDir, 'workspace.json'))

  const result = {
    ok: true,
    sessionId,
    from,
    to: target.path,
    workspaceId: target.id,
    title: target.title,
    backup: backupDir,
  }
  let how = 'file'
  try {
    const logStep = rewriteLogCwd(source.logFile, target.path)
    result.headerRewritten = logStep.changed

    const targetBucket = encodeCwd(target.path)
    const targetDir = path.join(dshPaths().sessions, targetBucket, sessionId)
    // 只认 sessions/<桶>/<会话> 这个布局；不认识的布局只改 header，不瞎挪目录。
    const inBucket = samePath(path.dirname(path.dirname(source.dir)), dshPaths().sessions)
    if (inBucket === false) {
      result.dirMoved = 'skipped'
    } else {
      result.dirMoved = moveDir(source.dir, targetDir)
      result.targetLog = path.join(targetDir, SESSION_LOG)
    }

    result.projection = patchProjection(sessionId, target.path, header)

    const liveSync = await syncMembership(ctx, { sessionId, target, from })
    result.live = liveSync
    if (liveSync.applied === true) {
      result.membership = { from: liveSync.fromId, to: liveSync.toId }
      result.membershipChanged = true
      result.restartRequired = false
      how = `live:${liveSync.tier}`
    } else {
      const { doc } = readWorkspaceTable()
      const membership = planMembership(doc, sessionId, target.path)
      result.membership = { from: membership.sourceId, to: membership.targetId }
      if (membership.sameWorkspace) {
        result.membershipChanged = false
      } else {
        result.membershipChanged = applyMembership(doc, membership, sessionId)
        const temp = `${workspaceFile}.tmp-${Date.now().toString(36)}`
        fs.writeFileSync(temp, JSON.stringify(doc, null, 2))
        fs.renameSync(temp, workspaceFile)
      }
      result.restartRequired = true
    }
    result.running = running
    mark(`move ${sessionId} ${shortId(from)}->${shortId(target.path)} (${how})`)
    return result
  } catch (error) {
    mark(`move-failed ${sessionId} ${error?.message ?? String(error)}`)
    return { ...result, ok: false, error: error?.message ?? String(error) }
  }
}

/** 允许 `session-xxxx` / `xxxx`（8 位短 id 会去投影缓存里补全）。 */
export function normalizeSessionId(value) {
  const text = String(value ?? '').trim()
  if (text === '') throw new Error('需要会话 id')
  if (text.startsWith('session-')) return text
  const { projcache } = dshPaths()
  const files = fs.existsSync(projcache) ? fs.readdirSync(projcache) : []
  const hit = files.find((name) => name.startsWith(`session-${text}`) && name.endsWith('.json'))
  return hit === undefined ? `session-${text}` : hit.replace(/\.json$/u, '')
}

/** 目标可以是 id、路径或标题。 */
export function resolveTarget(workspaces, wanted) {
  const text = String(wanted ?? '').trim()
  if (text === '') throw new Error('需要目标工作区（id、路径或标题）')
  const byId = workspaces.find((workspace) => workspace.id === text)
  if (byId !== undefined) return byId
  const byPath = workspaces.find((workspace) => samePath(workspace.path, text))
  if (byPath !== undefined) return byPath
  const byTitle = workspaces.filter((workspace) => String(workspace.title ?? '') === text)
  if (byTitle.length === 1) return byTitle[0]
  if (byTitle.length > 1) throw new Error(`有 ${byTitle.length} 个工作区都叫「${text}」，请用 id 或路径`)
  throw new Error(`找不到目标工作区：${text}`)
}

export { shortId as sessionShortId }
