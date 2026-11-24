/**
 * 会话标题规范化：采集、校验、写回投影缓存。
 *
 * 侧栏冷启动读的是投影缓存 `~/.dsh/storages/session_projcache/sessions/<id>.json`，
 * 而不是会话日志；缓存里的 `record.identity` 与日志 header 只要有一项对不上，
 * 宿主就当这条缓存不成立，侧栏回落成「未命名」。所以写标题前先把 identity
 * 按 header 对齐，再写 `record.rows.title`，冷启动才能直接看到新标题。
 *
 * 本模块只做文件层的事：不调模型、不碰侧栏。模型链在 llm-titles.js，
 * 会话对象（侧栏即时改名）在 index.js 里按需推。
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'

import { mark, statePath } from './mark.js'
import { dshPaths, findSessionDir, frameOffsets, readLogHeader } from './move-session.js'

/** 当前会话日志格式版本；低版本需要宿主迁移，不碰。 */
export const CURRENT_FORMAT = 4

/** 标题长度上限（按字符数，不按 UTF-16 码元）。 */
export const TITLE_MAX_CHARS = 40

/** 本插件写在投影缓存里的标题来源行。 */
export const TITLE_SOURCE_KEY = 'betterWorkspace/titleSource'

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const DAY_MS = 24 * 60 * 60 * 1000

/** 状态目录：state/titles。 */
export function titlesDir() {
  return statePath('titles')
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** 先写临时文件再 rename，避免半个文件。 */
function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file))
  const temp = `${file}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`
  fs.writeFileSync(temp, text)
  fs.renameSync(temp, file)
}

export function writeJsonAtomic(file, value) {
  writeTextAtomic(file, JSON.stringify(value))
}

export function readJsonFile(file, fallback) {
  return readJson(file, fallback)
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 本地时间戳：20261123-111500。 */
export function stampNow(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

/** 会话短号：去掉 session- 前缀取前 8 位。 */
export function shortId(id) {
  return String(id ?? '').replace(/^session-/u, '').slice(0, 8)
}

/**
 * 把完整 id / 8 位短号 / 唯一前缀解析成完整会话 id。
 * 找不到或命中多条时返回 `{ error }`，不猜。
 */
export function resolveSessionId(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { error: '缺少会话 id' }
  const ids = allSessionIds()
  if (ids.includes(text)) return { id: text }
  const matches = ids.filter((id) => id === text || shortId(id) === text || id.startsWith(text) || id.includes(text))
  if (matches.length === 1) return { id: matches[0] }
  if (matches.length === 0) return { error: `找不到会话：${text}` }
  return { error: `会话短号不唯一：${text}，命中 ${matches.length} 条` }
}

/** 投影缓存目录。 */
export function sessionsDir() {
  return dshPaths().projcache
}

/** 所有有投影缓存的会话 id。 */
export function allSessionIds() {
  const dir = sessionsDir()
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
}

/** 读一条会话的投影缓存；坏文件返回 undefined。 */
export function loadSession(sessionId) {
  const file = path.join(sessionsDir(), `${sessionId}.json`)
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(file).mtimeMs
  } catch {
    return undefined
  }
  const data = readJson(file, undefined)
  const record = data?.record
  if (record === undefined || record === null) return undefined
  return { id: sessionId, file, mtimeMs, data, record, rows: record.rows ?? {} }
}

/** 标题文本。 */
export function titleOf(rows) {
  const value = rows?.title?.val
  return typeof value === 'string' ? value : ''
}

/** 标题来源（本插件写的标记行）。 */
export function sourceOf(rows) {
  const value = rows?.[TITLE_SOURCE_KEY]?.val
  return typeof value === 'string' ? value : null
}

/** 最后活跃时间（毫秒）。 */
export function lastActiveOf(rows) {
  const value = rows?.timeContext?.val?.lastMessageTime ?? rows?.sessionListMetadata?.val?.lastPromptAt
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 读日志 header：只读前 64 KB 够第一帧就够，不够再整文件。 */
export function readSessionHeader(sessionId) {
  let found
  try {
    found = findSessionDir(sessionId)
  } catch (error) {
    return { error: error?.message ?? String(error) }
  }
  try {
    const fd = fs.openSync(found.logFile, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const take = Math.min(size, 64 * 1024)
      const buffer = Buffer.alloc(take)
      fs.readSync(fd, buffer, 0, take, 0)
      const second = buffer.indexOf(FRAME_MAGIC, FRAME_MAGIC.length)
      if (second > 0) {
        const text = zlib.zstdDecompressSync(buffer.subarray(0, second)).toString('utf8')
        const header = JSON.parse(text.split('\n')[0])
        return { header, logFile: found.logFile, dir: found.dir, size }
      }
    } finally {
      fs.closeSync(fd)
    }
    const { header } = readLogHeader(found.logFile)
    return { header, logFile: found.logFile, dir: found.dir, size: fs.statSync(found.logFile).size }
  } catch (error) {
    return { error: error?.message ?? String(error) }
  }
}

/** 解一条会话的完整事件流。多帧 zstd 逐帧解，坏帧跳过。 */
export function readSessionEvents(sessionId) {
  const found = findSessionDir(sessionId)
  const buffer = fs.readFileSync(found.logFile)
  const offsets = frameOffsets(buffer)
  const events = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = offsets[index + 1] ?? buffer.length
    try {
      const text = zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          events.push(JSON.parse(trimmed))
        } catch {
          /* 单行坏了不影响其它事件 */
        }
      }
    } catch {
      /* 单帧坏了不影响其它帧 */
    }
  }
  return events
}

/** 从事件流里取标题来源、最后一个标题事件的 seq、用户消息与轮数。 */
export function summarizeEvents(events) {
  let titleSource = null
  let lastTitleSeq = -1
  let lastEventSeq = -1
  const prompts = []
  for (const event of events) {
    if (typeof event?.seq === 'number') lastEventSeq = Math.max(lastEventSeq, event.seq)
    if (event?.type === 'session/title') {
      titleSource = event?.data?.source?.kind ?? null
      if (typeof event.seq === 'number') lastTitleSeq = Math.max(lastTitleSeq, event.seq)
      continue
    }
    if (event?.type !== 'user/message') continue
    if (event?.data?.source?.kind !== 'user') continue
    const text = messageText(event?.data?.content)
    if (text !== '') prompts.push(text)
  }
  return { titleSource, lastTitleSeq, lastEventSeq, prompts, turns: prompts.length }
}

function messageText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
    .trim()
}

/** 已知项目：已经规范化过（来源 user）且带 `/` 的标题前缀。 */
export function knownProjectsFrom(ids) {
  const projects = new Set()
  for (const id of ids) {
    const session = loadSession(id)
    if (session === undefined) continue
    if (sourceOf(session.rows) !== 'user') continue
    const title = titleOf(session.rows)
    const slash = title.indexOf('/')
    if (slash > 0) projects.add(title.slice(0, slash))
  }
  return [...projects].sort()
}

/** 标题是否满足 `<语义项目>/<对应的事情>` 的硬规则。 */
export function validateTitle(title) {
  const text = typeof title === 'string' ? title.trim() : ''
  if (text === '') return { ok: false, reason: '标题为空' }
  if (Array.from(text).length > TITLE_MAX_CHARS) return { ok: false, reason: `超过 ${TITLE_MAX_CHARS} 字` }
  if (/[\r\n]/u.test(text)) return { ok: false, reason: '含换行' }
  if (/^(https?:\/\/|www\.)/iu.test(text)) return { ok: false, reason: '以网址开头' }
  const slash = text.indexOf('/')
  if (slash <= 0) return { ok: false, reason: '缺少「项目/事情」格式' }
  if (slash === text.length - 1) return { ok: false, reason: '「/」后面没有事情' }
  const project = text.slice(0, slash).trim()
  if (Array.from(project).length < 2 || Array.from(project).length > 6) return { ok: false, reason: '项目名需 2–6 字' }
  return { ok: true, title: text }
}

/** 已经合规的标题不再重排，除非显式 force。 */
export function isCompliant(title) {
  const checked = validateTitle(title)
  if (!checked.ok) return false
  return !/^(未命名|新会话|untitled|new session)/iu.test(checked.title)
}

function skip(stats, reason) {
  stats.skipped += 1
  stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1
}

/**
 * 采集待整理会话。
 *
 * 手动整理默认看全部缓存，不按活跃时间裁剪；`days` 只在显式传入时生效。
 * `onlyIds` 把范围收到指定会话，`forceIds` 让指定会话绕过「已人工改名 / 已合规 / 已整理」检查。
 *
 * @param options.days - 可选回看天数；不传表示全部。
 * @param options.limit - 可选上限；不传表示不限。
 * @param options.force - 全部候选都绕过来源/合规/账本检查。
 * @param options.onlyIds - 只处理这些会话（完整 id、短号或唯一前缀）。
 * @param options.forceIds - 强制包含这些会话，即使它们已被整理过。
 * @param options.skipIds - 指定跳过的会话 id。
 */
export function collect(options = {}) {
  const days = Number.isFinite(options.days) && options.days > 0 ? Math.max(1, Math.round(options.days)) : undefined
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.max(1, Math.round(options.limit)) : Number.POSITIVE_INFINITY
  const force = options.force === true
  const skipIds = new Set(Array.isArray(options.skipIds) ? options.skipIds.map(String) : [])
  const onlyList = Array.isArray(options.onlyIds) ? options.onlyIds : undefined
  const onlyIds = resolveIdList(onlyList)
  const forceIds = resolveIdList(options.forceIds)
  const cutoff = days === undefined ? 0 : Date.now() - days * DAY_MS
  const ledger = readLedger()
  const allIds = allSessionIds()
  // 显式传了 onlyIds 就只扫解析出来的那些；全解析失败时不再退回全量。
  const ids = onlyList !== undefined ? onlyIds.ids : allIds
  const stats = { scanned: ids.length, skipped: 0, byReason: {}, errors: [...onlyIds.errors, ...forceIds.errors] }
  const entries = []

  for (const id of ids) {
    const forced = force || forceIds.ids.includes(id)
    if (skipIds.has(id)) {
      skip(stats, '指定跳过')
      continue
    }
    const session = loadSession(id)
    if (session === undefined) {
      skip(stats, '缓存不可读')
      continue
    }
    const rows = session.rows
    const title = titleOf(rows)
    const active = lastActiveOf(rows)
    if (!forced && days !== undefined && active > 0 && active < cutoff) {
      skip(stats, `${days} 天前不活跃`)
      continue
    }
    if (rows?.sessionListMetadata?.val?.blank === true) {
      skip(stats, '空会话')
      continue
    }
    if (rows?.archived?.val === true || session.record?.archived === true) {
      skip(stats, '已归档')
      continue
    }

    const headerInfo = readSessionHeader(id)
    if (headerInfo.error !== undefined) {
      skip(stats, '日志 header 不可读')
      continue
    }
    const header = headerInfo.header
    if (Number(header?.delegationDepth ?? 0) > 0 || header?.origin === 'subagent') {
      skip(stats, '子代理会话')
      continue
    }
    if (header?.version !== CURRENT_FORMAT) {
      skip(stats, 'migration-required')
      continue
    }

    let summary
    try {
      summary = summarizeEvents(readSessionEvents(id))
    } catch {
      skip(stats, '日志不可读')
      continue
    }
    const source = sourceOf(rows) ?? summary.titleSource
    if (!forced && source === 'user') {
      skip(stats, '已人工改名')
      continue
    }
    if (!forced && isCompliant(title)) {
      skip(stats, '标题已合规')
      continue
    }
    const done = ledger.entries?.[id]
    if (!forced && done !== undefined && done.title === title) {
      skip(stats, '已整理过')
      continue
    }
    if (summary.turns === 0) {
      skip(stats, '没有用户消息')
      continue
    }

    entries.push({
      id,
      short: shortId(id),
      workspace: typeof header?.cwd === 'string' ? header.cwd : '',
      title,
      titleSource: source ?? null,
      turns: summary.turns,
      lastActive: active > 0 ? new Date(active).toISOString() : '',
      reason: forced && (source === 'user' || isCompliant(title)) ? '指定会话，强制重排' : (title === '' ? '标题缺失' : '标题不符合格式'),
      prevTitle: title,
      prompts: summary.prompts.slice(0, 8).map((text) => text.replace(/\s+/gu, ' ').slice(0, 160)),
    })
  }

  entries.sort((left, right) => String(right.lastActive).localeCompare(String(left.lastActive)))
  const picked = entries.slice(0, limit)
  const knownProjects = knownProjectsFrom(allIds)
  const pending = {
    version: 1,
    generatedAt: new Date().toISOString(),
    days,
    mode: onlyIds.ids.length > 0 ? 'session' : 'all',
    onlyCount: onlyIds.ids.length,
    scanned: stats.scanned,
    skipped: stats.skipped,
    byReason: stats.byReason,
    errors: stats.errors,
    knownProjects,
    entries: picked,
  }
  const file = statePath('titles', 'pending.json')
  writeJsonAtomic(file, pending)
  writePendingMarkdown(pending, picked)
  return {
    days,
    mode: pending.mode,
    onlyCount: pending.onlyCount,
    entries: picked,
    knownProjects,
    stats,
    file,
  }
}

/** 把 id 列表解析成完整 id；解析不了的记进 errors，不猜。 */
function resolveIdList(rawList) {
  const ids = []
  const errors = []
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    const found = resolveSessionId(raw)
    if (found.error !== undefined) {
      errors.push({ id: String(raw ?? ''), error: found.error })
      continue
    }
    if (!ids.includes(found.id)) ids.push(found.id)
  }
  return { ids, errors }
}

function writePendingMarkdown(pending, entries) {
  const scope = pending.mode === 'session' ? `指定会话 ${pending.onlyCount} 条` : (pending.days === undefined ? '全部' : `近 ${pending.days} 天`)
  const lines = [
    `# 待整理会话（${scope}）`,
    '',
    `生成时间：${pending.generatedAt}`,
    `扫描 ${pending.scanned} 条，跳过 ${pending.skipped} 条，候选中 ${entries.length} 条。`,
    '',
  ]
  if (pending.byReason !== undefined) {
    lines.push('跳过原因：')
    for (const [reason, count] of Object.entries(pending.byReason)) lines.push(`- ${reason}：${count}`)
    lines.push('')
  }
  if (Array.isArray(pending.errors) && pending.errors.length > 0) {
    lines.push('无法解析的 id：')
    for (const item of pending.errors) lines.push(`- ${item.id || '(空)'}：${item.error}`)
    lines.push('')
  }
  if (pending.knownProjects.length > 0) {
    lines.push(`已知项目：${pending.knownProjects.join('、')}`, '')
  }
  entries.forEach((entry, index) => {
    lines.push(`## ${index + 1}. ${entry.short}  [${entry.workspace || '?'}]`)
    lines.push(`- 当前：${entry.title || '(空)'}（${entry.titleSource ?? '未标记'}，${entry.turns} 轮）`)
    lines.push(`- 最后活跃：${entry.lastActive || '未知'}`)
    lines.push(`- 原因：${entry.reason}`)
    if (Array.isArray(entry.prompts) && entry.prompts.length > 0) {
      lines.push(`- 首条：${entry.prompts[0]}`)
    }
    lines.push('')
  })
  writeTextAtomic(statePath('titles', 'pending.md'), lines.join('\n'))
}

/** 读账本。 */
export function readLedger() {
  const value = readJson(statePath('titles', 'ledger.json'), undefined)
  if (value !== null && typeof value === 'object' && value.entries !== null && typeof value.entries === 'object') {
    return value
  }
  return { version: 1, entries: {} }
}

function identityDiff(identity, header) {
  const stored = identity ?? {}
  // inheritedEventCount 不一定写在日志 header 里（seeded 会话把它放在持久化元数据里），
  // header 没给就沿用缓存自己的值，不能拿 0 去覆盖，否则宿主会当成另一条生命周期。
  const inherited = Number.isFinite(header?.inheritedEventCount)
    ? header.inheritedEventCount
    : (Number.isFinite(stored.inheritedEventCount) ? stored.inheritedEventCount : 0)
  const expected = {
    formatVersion: header?.version,
    createdAt: header?.createdAt,
    cwd: header?.cwd,
    isSeeded: header?.isSeeded ?? stored.isSeeded ?? false,
    inheritedEventCount: inherited,
  }
  const fields = []
  if (stored.formatVersion !== expected.formatVersion) fields.push('formatVersion')
  if (stored.createdAt !== expected.createdAt) fields.push('createdAt')
  if (stored.cwd !== expected.cwd) fields.push('cwd')
  if ((stored.isSeeded ?? false) !== expected.isSeeded) fields.push('isSeeded')
  if ((stored.inheritedEventCount ?? 0) !== expected.inheritedEventCount) fields.push('inheritedEventCount')
  return { expected, fields }
}

/**
 * 一次性修复：扫描全部投影缓存，只把 identity 对齐到日志 header，不碰标题。
 * @param options.dryRun - 默认 true，只列不改；命令层显式传 false 才写。
 */
export function repairIdentities(options = {}) {
  const dryRun = options.dryRun !== false
  const stamp = stampNow()
  const backupsDir = statePath('titles', 'backups')
  const ids = allSessionIds()
  const mismatched = []
  let repaired = 0
  for (const id of ids) {
    const session = loadSession(id)
    if (session === undefined) continue
    const headerInfo = readSessionHeader(id)
    if (headerInfo.error !== undefined) continue
    const { expected, fields } = identityDiff(session.record.identity, headerInfo.header)
    if (fields.length === 0) continue
    const row = {
      id,
      short: shortId(id),
      title: titleOf(session.rows),
      fields,
      from: { ...(session.record.identity ?? {}) },
      to: expected,
    }
    if (!dryRun) {
      try {
        ensureDir(backupsDir)
        fs.copyFileSync(session.file, path.join(backupsDir, `${id}.${stamp}.json`))
        session.record.identity = { ...(session.record.identity ?? {}), ...expected }
        writeJsonAtomic(session.file, session.data)
        repaired += 1
        row.repaired = true
      } catch (error) {
        row.error = error?.message ?? String(error)
      }
    }
    mismatched.push(row)
  }
  return { scan: ids.length, dryRun, matched: mismatched.length, repaired, entries: mismatched }
}

/**
 * 批量写标题。
 * @param list - `[{id,title}]`。
 * @param options.dryRun - 只预演，不写缓存、不记账。
 */
export function applyTitles(list, options = {}) {
  const dryRun = options.dryRun === true
  const stamp = stampNow()
  const backupsDir = statePath('titles', 'backups')
  const ledger = readLedger()
  const applied = []
  const unchanged = []
  const rejected = []
  const conflicted = []
  const seen = new Set()
  let identityRepaired = 0

  for (const item of Array.isArray(list) ? list : []) {
    const rawId = String(item?.id ?? '').trim()
    const checked = validateTitle(item?.title)
    if (rawId === '') {
      rejected.push({ id: rawId, title: item?.title, reason: '缺少会话 id' })
      continue
    }
    const resolved = resolveSessionId(rawId)
    if (resolved.error !== undefined) {
      rejected.push({ id: rawId, short: shortId(rawId), title: item?.title, reason: resolved.error })
      continue
    }
    const id = resolved.id
    if (seen.has(id)) continue
    seen.add(id)
    if (!checked.ok) {
      rejected.push({ id, short: shortId(id), title: item?.title, reason: checked.reason })
      continue
    }
    const title = checked.title
    const session = loadSession(id)
    if (session === undefined) {
      rejected.push({ id, short: shortId(id), title, reason: '没有投影缓存' })
      continue
    }
    const headerInfo = readSessionHeader(id)
    if (headerInfo.error !== undefined) {
      rejected.push({ id, short: shortId(id), title, reason: `日志 header 不可读：${headerInfo.error}` })
      continue
    }
    const header = headerInfo.header
    if (header?.version !== CURRENT_FORMAT) {
      rejected.push({ id, short: shortId(id), title, reason: '会话格式需要迁移' })
      continue
    }

    let summary
    try {
      summary = summarizeEvents(readSessionEvents(id))
    } catch (error) {
      rejected.push({ id, short: shortId(id), title, reason: `日志不可读：${error?.message ?? String(error)}` })
      continue
    }
    const { expected, fields } = identityDiff(session.record.identity, header)
    const prevTitle = titleOf(session.rows)
    const needsTitle = prevTitle !== title
    if (!needsTitle && fields.length === 0) {
      unchanged.push({ id, short: shortId(id), title })
      continue
    }

    const row = {
      id,
      short: shortId(id),
      title,
      prevTitle,
      titleChanged: needsTitle,
      identityRepaired: fields.length > 0,
      repairedFields: fields,
    }
    if (dryRun) {
      applied.push(row)
      if (fields.length > 0) identityRepaired += 1
      continue
    }

    try {
      const before = fs.statSync(session.file).mtimeMs
      if (session.mtimeMs > 0 && before !== session.mtimeMs) {
        conflicted.push({ id, short: shortId(id), title, reason: '读后文件被改动' })
        continue
      }
      ensureDir(backupsDir)
      fs.copyFileSync(session.file, path.join(backupsDir, `${id}.${stamp}.json`))
      if (fields.length > 0) {
        session.record.identity = { ...(session.record.identity ?? {}), ...expected }
        identityRepaired += 1
      }
      const previousSeq = Number.isFinite(session.rows?.title?.seq) ? session.rows.title.seq : -1
      const seq = Math.max(previousSeq, summary.lastTitleSeq, 0)
      session.rows.title = { ver: 1, seq, val: title }
      session.rows[TITLE_SOURCE_KEY] = { ver: 1, seq, val: 'user' }
      writeJsonAtomic(session.file, session.data)
      applied.push(row)
      ledger.entries[id] = { title, prevTitle, at: Date.now() }
    } catch (error) {
      rejected.push({ id, short: shortId(id), title, reason: error?.message ?? String(error) })
    }
  }

  const result = {
    stamp,
    dryRun,
    status: dryRun ? 'dry-run' : 'applied',
    applied,
    unchanged,
    rejected,
    conflicted,
    identityRepaired,
  }
  if (!dryRun) {
    writeJsonAtomic(statePath('titles', 'ledger.json'), { ...ledger, version: 1 })
    writeJsonAtomic(statePath('titles', 'runs', `${stamp}.json`), {
      at: new Date().toISOString(),
      days: options.days,
      ...result,
    })
  }
  return result
}

/** 诊断：列出现有标题。 */
export function listTitles(limit = 100) {
  return allSessionIds()
    .map((id) => {
      const session = loadSession(id)
      if (session === undefined) return undefined
      return {
        id,
        short: shortId(id),
        title: titleOf(session.rows),
        titleSource: sourceOf(session.rows),
        lastActive: lastActiveOf(session.rows),
      }
    })
    .filter((row) => row !== undefined)
    .sort((left, right) => right.lastActive - left.lastActive)
    .slice(0, limit)
}
