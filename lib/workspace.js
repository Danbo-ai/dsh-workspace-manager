/**
 * 工作区结构：在磁盘上建子项目目录、生成骨架、注册成工作区。
 *
 * 背景：宿主注册工作区只接受**已经存在**的目录（`dsh-workspace` 的 `create()`
 * 先 realpath 再 stat，不存在直接报错），而侧栏只有「添加工作区…」。
 * 这个模块把「建目录 + 写骨架 + 注册」合成一个动作，供 `/mkws` 命令、
 * 右键菜单（经 `/mkws` 转交）与 `workspace_child_create` 工具共用。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { mark } from './mark.js'
import { service } from './service.js'

/** 单段目录名：不能为空、不能含路径分隔符与 Windows 非法字符、不能是 . 或 .. */
export const DIRECTORY_NAME = /^[^\u0000/\\:*?"<>|]{1,80}$/u

/**
 * 解析「父目录」：绝对路径直接用；相对路径按当前工作区拼；未给则用当前工作区。
 * @param ctx - cordis 插件上下文。
 * @param agent - 当前会话的 agent（工具/命令都会带）。
 * @param signal - 取消信号。
 * @returns 父目录绝对路径。
 */
export async function resolveParent(ctx, agent, signal) {
  const workingDirectory = service(ctx, 'workingDirectory')
  if (workingDirectory !== undefined && typeof workingDirectory.ensure === 'function') {
    try {
      // agent 可能缺失（离线测试、或宿主某些入口不带），ensure 内部会给出可读错误。
      const cwd = await workingDirectory.ensure(agent, signal)
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch {
      /* 落回下面的兜底 */
    }
  }
  const metaCwd = agent?.session?.meta?.cwd
  if (typeof metaCwd === 'string' && metaCwd !== '') return metaCwd
  if (typeof agent?.cwd === 'string' && agent.cwd !== '') return agent.cwd
  return process.cwd()
}

/**
 * 子项目 AGENTS.md 骨架。
 * 写的是**已核实**的加载规则：指令按「宽泛 → 具体」叠加（顶层先、本文件后）；
 * 项目根由最近的 `.git` 决定，所以本层不建 `.git`、也不放 `.dsh/skills`。
 * @param name - 子目录名。
 * @param parent - 父目录绝对路径。
 */
function agentsSkeleton(name, parent) {
  return [
    `# ${name} — 子项目规则`,
    '',
    `本目录是一个独立的 DSH 工作区（子项目），父目录：\`${parent}\`。`,
    '',
    '## 层级与加载顺序',
    '- 指令按「宽泛 → 具体」加载：顶层 AGENTS.md 先，本文件后；同一结论冲突时以本文件为准。',
    '- 项目根由最近的 `.git` 决定。本层不新建 `.git`，沿用顶层仓库，因此顶层 `.dsh/skills` 对本层同样生效。',
    '- 本层不要放 `.dsh/skills`：没有 `.git` 时它不会被扫描到。',
    '',
    '## 记忆',
    '- `.dsh/memory.md` 是子项目记忆的落点：事实、决定、待办都记在那里。',
    '- 需要跨会话检索的关键事实，另存一份到本工作区的 Mnemon Documents。',
    '',
    '## 边界',
    '- 默认只改本目录；要动父目录或其他子项目，先在 `.dsh/memory.md` 记下原因与影响范围。',
    '',
  ].join('\n')
}

/**
 * 子项目记忆文件骨架。
 * @param name - 子目录名。
 */
function memorySkeleton(name) {
  return [
    `# ${name} — 子项目记忆`,
    '',
    '> 由 dsh-workspace-manager 生成，可自由改写。记事实、决定与待办，不记过程日志。',
    '',
    '## 事实',
    '',
    '## 决定',
    '',
    '## 待办',
    '',
  ].join('\n')
}

/**
 * 只在文件不存在时写入（`wx` 标志天然不覆盖）。
 * @param file - 目标文件绝对路径。
 * @param content - 文件内容。
 * @returns `created` 或 `existing`。
 */
async function writeIfMissing(file, content) {
  try {
    await writeFile(file, content, { encoding: 'utf8', flag: 'wx' })
    return 'created'
  } catch (error) {
    if (error?.code === 'EEXIST') return 'existing'
    throw new Error(`写骨架失败：${file}（${error?.code ?? error?.message ?? String(error)}）`)
  }
}

/**
 * 生成子项目骨架：`AGENTS.md` 与 `.dsh/memory.md`。已存在的文件一律不动，
 * 也**不建 `.git`**（层级标记留在顶层，避免切断父级指令与技能）。
 * @param target - 子目录绝对路径。
 * @param name - 子目录名。
 * @param parent - 父目录绝对路径。
 */
export async function ensureSkeleton(target, name, parent) {
  await mkdir(join(target, '.dsh'), { recursive: true })
  const agentsMd = await writeIfMissing(join(target, 'AGENTS.md'), agentsSkeleton(name, parent))
  const memory = await writeIfMissing(join(target, '.dsh', 'memory.md'), memorySkeleton(name))
  return { agentsMd, memory }
}

/**
 * 建目录 + 注册工作区（幂等：目录已存在就复用，工作区已注册就返回原记录）。
 * @param ctx - cordis 插件上下文。
 * @param options - 目录名、可选父目录、agent、取消信号与是否生成骨架。
 */
export async function createChildWorkspace(ctx, options) {
  const rawName = typeof options.name === 'string' ? options.name.trim() : ''
  if (!DIRECTORY_NAME.test(rawName) || rawName === '.' || rawName === '..') {
    throw new Error(`目录名不合法：「${rawName}」（不能为空，不能含 / \\ : * ? " < > |，不能是 . 或 ..）`)
  }

  const parentInput = typeof options.parent === 'string' ? options.parent.trim() : ''
  let parentDir
  if (parentInput === '') {
    parentDir = await resolveParent(ctx, options.agent, options.signal)
  } else if (isAbsolute(parentInput)) {
    parentDir = parentInput
  } else {
    parentDir = resolve(await resolveParent(ctx, options.agent, options.signal), parentInput)
  }

  const target = join(parentDir, rawName)
  let directoryCreated = false
  try {
    await mkdir(target, { recursive: false })
    directoryCreated = true
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // 父目录不存在就直接报错：层级靠「在某工作区下建子工作区」逐级长出来，
      // 不替用户把打错的父路径悄悄建成一整棵树。
      throw new Error(`父目录不存在：${parentDir}（子工作区只能建在已有目录下）`)
    }
    if (error?.code !== 'EEXIST') {
      throw new Error(`建目录失败：${target}（${error?.code ?? error?.message ?? String(error)}）`)
    }
  }

  const skeleton = options.skeleton === false ? undefined : await ensureSkeleton(target, rawName, parentDir)

  const registry = service(ctx, 'workspaceRegistry')
  if (registry === undefined || typeof registry.create !== 'function') {
    throw new Error(`目录已建好（${target}），但工作区注册服务不可用，需要手动添加工作区`)
  }

  const before = typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(target) : undefined
  // 已注册就别再 create：重复调用虽然幂等，但会把它重新顶到列表最前面。
  const workspace = before === undefined ? await registry.create(target) : before
  mark(`create ${workspace?.id ?? 'undefined'} ${target}`)
  return {
    path: target,
    parent: parentDir,
    directoryCreated,
    workspaceCreated: before === undefined,
    workspaceId: workspace?.id === undefined ? undefined : String(workspace.id),
    title: workspace?.title,
    skeleton,
  }
}

/**
 * 列出已注册工作区（只读投影，按注册顺序）。
 * @param ctx - cordis 插件上下文。
 */
export async function listWorkspaces(ctx) {
  const registry = service(ctx, 'workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') {
    throw new Error('workspaceRegistry.list 不可用')
  }
  return registry.list().map((workspace) => ({
    id: String(workspace.id),
    path: workspace.path,
    title: workspace.title,
    parent: owningParentPath(registry, workspace.path),
    sessions: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : undefined,
  }))
}

/**
 * 按磁盘包含关系找「最近的父工作区」——侧栏的树就是这个关系。
 * @param registry - 工作区注册表。
 * @param path - 目标目录。
 */
export function owningParentPath(registry, path) {
  let best
  let bestLength = 0
  for (const candidate of registry.list()) {
    const base = sameTreeBase(candidate.path)
    if (base === '' || base === sameTreeBase(path)) continue
    if (sameTreeBase(path).startsWith(`${base}/`) && base.length > bestLength) {
      best = candidate.path
      bestLength = base.length
    }
  }
  return best
}

/** 路径比较前先统一分隔符与尾斜杠，避免 `D:/a/b` 与 `D:\a\b\` 配不上。 */
function sameTreeBase(value) {
  return String(value ?? '').replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
}

/** 两个路径是否指向同一位置（忽略分隔符风格与大小写）。 */
export function samePath(left, right) {
  const normalized = sameTreeBase(left)
  return normalized !== '' && normalized === sameTreeBase(right)
}

/**
 * 移除工作区**登记**（不删目录、不动会话日志）。
 *
 * 侧栏里残留的测试登记、或指向已删目录的失效条目，用它清掉；
 * 目录本身的去留由调用方自己决定。
 * @param ctx - cordis 插件上下文。
 * @param options - `{ id?, path?, dryRun? }`，id 与 path 至少给一个。
 */
export async function removeWorkspaces(ctx, options = {}) {
  const registry = service(ctx, 'workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function' || typeof registry.delete !== 'function') {
    throw new Error('workspaceRegistry 不可用')
  }
  const wantedId = options.id === undefined ? undefined : String(options.id)
  const wantedPath = options.path === undefined ? undefined : String(options.path)
  if (wantedId === undefined && wantedPath === undefined) throw new Error('需要 id 或 path 至少一个')
  const all = await listWorkspaces(ctx)
  const matched = all.filter((workspace) => (
    (wantedId !== undefined && workspace.id === wantedId)
    || (wantedPath !== undefined && samePath(workspace.path, wantedPath))
  ))
  if (options.dryRun === true) return { dryRun: true, matched: matched.length, entries: matched, removed: [], failed: [] }
  const removed = []
  const failed = []
  for (const workspace of matched) {
    try {
      const deleted = await registry.delete(workspace.id)
      if (deleted === false) failed.push({ id: workspace.id, path: workspace.path, error: 'registry 未返回已删除' })
      else removed.push({ id: workspace.id, path: workspace.path, title: workspace.title })
    } catch (error) {
      failed.push({ id: workspace.id, path: workspace.path, error: error?.message ?? String(error) })
    }
  }
  return { dryRun: false, matched: matched.length, entries: matched, removed, failed }
}

/**
 * 解析命令参数：`<名字> [父目录]`，父目录允许带空格（引号可选）。
 * @param rawInput - 命令名之后的原始文本。
 */
export function parseCommandInput(rawInput) {
  const text = String(rawInput ?? '').trim()
  if (text === '') return { name: '', parent: '' }
  const quoted = /^"([^"]+)"\s*(.*)$/u.exec(text)
  const withoutName = quoted === null ? text.replace(/^\S+\s*/u, '') : quoted[2]
  const name = quoted === null ? (text.match(/^\S+/u)?.[0] ?? '') : quoted[1]
  const parent = withoutName
    .trim()
    .replace(/^"(.*)"$/u, '$1')
    .trim()
  return { name, parent }
}

/**
 * 把骨架结果翻成一句人话（命令回显用）。
 * @param skeleton - ensureSkeleton 的返回值，可能为 undefined。
 */
export function describeSkeleton(skeleton) {
  if (skeleton === undefined) return '未生成骨架'
  const label = (state) => (state === 'created' ? '新建' : '已存在')
  return `骨架：AGENTS.md ${label(skeleton.agentsMd)}、.dsh/memory.md ${label(skeleton.memory)}`
}
