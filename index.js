/**
 * dsh-workspace-manager — 宿主半体：工作区结构 + 会话标题，一个插件管完。
 *
 * 两件事本来就是一条链：先有「多层目录 / 子工作区」，才有「这个会话属于哪个语义项目」；
 * 标题规范化的落点（projcache）与工作区的落点（workspace.json）都是宿主的持久层。
 *
 * 当前阶段（A）已就位的能力：
 *   - `/mkws <名字> [父目录]`      建目录 + 写骨架 + 注册工作区
 *   - 工具 workspace_child_create 同一动作，给 agent 用
 *   - 工具 workspace_list         列出登记表（含磁盘父工作区，用于核对树形关系）
 *   - 工具 workspace_remove       只移除登记，不删目录与会话日志
 *   - `/mvws <会话 id> <目标工作区>` 连同文件把会话搬到另一个工作区
 *   - 工具 workspace_move_session 同一动作（带 dryRun）
 *   - `/retitle [天数]` 整理会话标题：采集 → 模型拟「语义项目/事情」→ 写回投影缓存 → 推侧栏
 *   - 工具 session_titles_refresh / collect / apply / models / config / repair / set_session_titles
 *
 * 服务一律**惰性解析**：inject 一个不存在的服务会让整行插件静默不挂载。
 */
export const name = 'dsh-workspace-manager'

import { mark } from './lib/mark.js'
import { jsonSafe } from './lib/json.js'
import { registerHttpRoutes } from './lib/http.js'
import { reconcileWorkspaces, describeReconcile } from './lib/reconcile.js'
import { service } from './lib/service.js'
import { moveSession } from './lib/move-session.js'
import { applyTitles, collect, repairIdentities } from './lib/titles.js'
import { describeRoute, modelCatalog, parseModelSpec, readConfig, resolveRoute, writeConfig } from './lib/titles-config.js'
import { refreshTitles } from './lib/llm-titles.js'
import { probeServices, setMany } from './lib/session-live.js'
import {
  createChildWorkspace,
  describeSkeleton,
  listWorkspaces,
  parseCommandInput,
  removeWorkspaces,
} from './lib/workspace.js'

mark('module-imported')

/**
 * 浏览器半体调后台用的路由前缀。
 *
 * 不用 `/wsm/`：0.6.x 那几版在宿主里注册过 `/wsm/*` 的 exact 路由，
 * 而当时没把清理函数交给 cordis，热重载后旧路由还挂着，新的一注册就撞 `duplicate exact route`。
 * 换一个没被占用的前缀，新老两代就能并存，等到下次重启自然只剩新的这一代。
 */
const HTTP_BASE = '/workspace-manager'

/**
 * 工具输出统一走 `jsonSafe`：宿主要求返回值是**无损 JSON**，
 * 直接 JSON.stringify 一个含 undefined 的对象会被判 `value is not lossless JSON`。
 */
const textOutput = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    return [{ type: 'text', text: JSON.stringify(jsonSafe(value), null, 2) }]
  },
}

/**
 * 解析 `/retitle` 的参数。
 *
 * 形式：`/retitle [天数] [--dry] [--force] [--models] [--set provider/model] [--repair]`。
 * 天数不传表示整理全部缓存；显式传天数才按活跃时间裁剪。`--model` 是 `--set` 的别名，保留旧习惯。
 * @param rawInput - 命令原始输入。
 */
function parseRetitleArgs(rawInput) {
  const tokens = String(rawInput ?? '').trim().split(/\s+/u).filter(Boolean)
  const options = { days: undefined, dryRun: false, force: false, models: false, repair: false, routeSpec: undefined }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--models' || token === 'models') {
      options.models = true
    } else if (token === '--dry' || token === '--dry-run' || token === '--dryrun') {
      options.dryRun = true
    } else if (token === '--force') {
      options.force = true
    } else if (token === '--repair') {
      options.repair = true
    } else if (token === '--set' || token === '--model') {
      const spec = tokens[index + 1]
      if (spec === undefined) throw new Error('--set 后面要跟 provider/model')
      options.routeSpec = spec
      index += 1
    } else if (/^\d+$/u.test(token)) {
      options.days = Math.max(1, Number(token))
    } else {
      throw new Error(`不认识的参数：${token}`)
    }
  }
  return options
}

/** 把 applyTitles 的结果推给活会话，返回侧栏即时/待重启计数。 */
function pushLiveTitles(ctx, rows) {
  const list = (Array.isArray(rows) ? rows : [])
    .map((row) => ({ id: row?.id, title: row?.title }))
    .filter((row) => typeof row.id === 'string' && row.id !== '')
  return setMany(ctx, list)
}

/** `/retitle` 的成功回执：一行，带即时/待重启/跳过。 */
function receiptLine(result, live) {
  const skipped = Number.isFinite(result?.collected?.skipped) ? result.collected.skipped : 0
  const count = Array.isArray(result?.applied) ? result.applied.length : 0
  if (live === undefined) return `规范化 ${count} 条（侧栏即时 0 / 待重启 0；跳过 ${skipped}）`
  return `规范化 ${count} 条（侧栏即时 ${live.applied} / 待重启 ${live.notLoaded}；跳过 ${skipped}）`
}

/**
 * 注册宿主命令：`/mkws`。
 * @param ctx - cordis 插件上下文。
 */
function registerCommands(ctx) {
  const commands = service(ctx, 'commands')
  if (commands === undefined || typeof commands.register !== 'function') {
    mark('commands-unavailable')
    return false
  }

  const definitions = [
    {
      name: 'mkws',
      description: '新建子工作区：在磁盘上建出同名目录并注册到侧栏（多层目录一步到位）',
      input: { hint: '目录名 [父目录，绝对或相对当前工作区]' },
      handler: async ({ agent, rawInput, signal }) => {
        const { name: directoryName, parent } = parseCommandInput(rawInput)
        try {
          const result = await createChildWorkspace(ctx, { name: directoryName, parent, agent, signal })
          const created = result.directoryCreated ? '已新建成目录' : '目录已存在，直接复用'
          const registered = result.workspaceCreated ? '已注册为工作区' : '该目录已是工作区'
          return {
            kind: 'success',
            text: `「${directoryName}」${created}，${registered}：${result.path}（父目录 ${result.parent}）；${describeSkeleton(result.skeleton)}`,
          }
        } catch (error) {
          mark(`mkws-failed ${error?.message ?? String(error)}`)
          return { kind: 'error', text: error?.message ?? String(error) }
        }
      },
    },
    {
      name: 'mvws',
      description: '移动会话：把一条会话连同它的文件搬到另一个工作区',
      input: { hint: '<会话 id> <目标工作区：id / 路径 / 标题>' },
      handler: async ({ rawInput }) => {
        const parts = String(rawInput ?? '').trim().split(/\s+/u).filter(Boolean)
        if (parts.length < 2) return { kind: 'error', text: '用法：/mvws <会话 id> <目标工作区>' }
        const sessionId = parts[0]
        const target = parts.slice(1).join(' ')
        try {
          const result = await moveSession(ctx, { sessionId, target })
          if (result.ok === false) return { kind: 'error', text: `搬家失败：${result.error}` }
          if (result.changed === false) return { kind: 'success', text: `会话 ${sessionId} 已经在「${result.title}」里，不用搬。` }
          const tail = result.restartRequired ? '（归属写在文件里，重启 DSH 后侧栏更新）' : ''
          return {
            kind: 'success',
            text: `会话 ${sessionId} 已移到「${result.title}」：${result.to}${tail}；备份 ${result.backup}`,
          }
        } catch (error) {
          mark(`mvws-failed ${error?.message ?? String(error)}`)
          return { kind: 'error', text: error?.message ?? String(error) }
        }
      },
    },
    {
      name: 'reconcile',
      description: '收尾被删目录：把无家可归的会话交给父工作区，父工作区是一级目录时归为未分组',
      input: { hint: '可选 --dry 只看计划' },
      handler: async ({ rawInput }) => {
        const raw = String(rawInput ?? '').trim()
        try {
          const result = await reconcileWorkspaces(ctx, { dryRun: /--dry|--dryrun|--dry-run/u.test(raw) })
          return { kind: 'success', text: describeReconcile(result) }
        } catch (error) {
          mark(`reconcile-failed ${error?.message ?? String(error)}`)
          return { kind: 'error', text: error?.message ?? String(error) }
        }
      },
    },
    {
      name: 'retitle',
      description: '整理会话标题：按「语义项目/对应的事情」规范化会话（默认全部，天数可选），写回缓存并即时推侧栏',
      input: { hint: '[天数] [--dry] [--force] [--models] [--set provider/model] [--repair]' },
      handler: async ({ rawInput }) => {
        try {
          const args = parseRetitleArgs(rawInput)
          if (args.models) {
            const routes = await modelCatalog(ctx)
            let current
            try {
              current = describeRoute(resolveRoute(ctx))
            } catch (error) {
              current = `(未设置：${error?.message ?? String(error)})`
            }
            const lines = [`当前标题整理路由：${current}`, `可用路由 ${routes.length} 条：`]
            for (const route of routes.slice(0, 40)) {
              lines.push(`- ${route.provider}/${route.model} — ${route.name}`)
            }
            if (routes.length > 40) lines.push(`… 其余 ${routes.length - 40} 条省略`)
            const probes = probeServices(ctx)
            lines.push(`服务：sessions=${probes.sessions}，sessionTitle=${probes.sessionTitle}`)
            return { kind: 'success', text: lines.join('\n') }
          }
          if (args.routeSpec !== undefined) {
            const spec = parseModelSpec(args.routeSpec)
            writeConfig({ provider: spec.provider, model: spec.model })
            return {
              kind: 'success',
              text: `已设定标题整理路由：${spec.provider}/${spec.model}（存于 state/titles/config.json）`,
            }
          }
          if (args.repair) {
            const result = repairIdentities({ dryRun: args.dryRun })
            if (args.dryRun) {
              return { kind: 'success', text: `预演：扫描 ${result.scan} 条缓存，identity 不一致 ${result.matched} 条（未写）` }
            }
            return { kind: 'success', text: `修复 identity：扫描 ${result.scan} 条缓存，改写 ${result.repaired} 条` }
          }

          const result = await refreshTitles(ctx, {
            days: args.days,
            force: args.force,
            dryRun: args.dryRun,
          })
          const skipped = Number.isFinite(result?.collected?.skipped) ? result.collected.skipped : 0
          if (result.status === 'applied') {
            const live = pushLiveTitles(ctx, result.applied)
            return { kind: 'success', text: receiptLine(result, live) }
          }
          if (result.status === 'dry-run') {
            const count = Array.isArray(result.applied) ? result.applied.length : 0
            const samples = (result.applied ?? []).slice(0, 5).map((row) => `${row.short}  ${row.title}`)
            const tail = samples.length > 0 ? `\n- ${samples.join('\n- ')}` : ''
            return { kind: 'success', text: `预演 ${count} 条（未写缓存；跳过 ${skipped}）${tail}` }
          }
          if (result.status === 'empty') {
            return { kind: 'success', text: `没有需要整理的会话（跳过 ${skipped}）` }
          }
          if (result.status === 'no-route') {
            return {
              kind: 'error',
              text: `${result.message}。用 /retitle --models 看可用路由，再 /retitle --set provider/model`,
            }
          }
          return { kind: 'error', text: result.message ?? `整理失败：${result.status}` }
        } catch (error) {
          mark(`retitle-failed ${error?.message ?? String(error)}`)
          return { kind: 'error', text: error?.message ?? String(error) }
        }
      },
    },
  ]

  const register = () => {
    const disposers = []
    const registered = []
    for (const definition of definitions) {
      try {
        disposers.push(commands.register(definition))
        registered.push(definition.name)
      } catch (error) {
        // 单条命令注册失败不拖垮其它命令；日志里留名字方便排查重名。
        mark(`command-failed ${definition.name} ${error?.message ?? String(error)}`)
      }
    }
    mark(`commands-registered ${registered.join(',')}`)
    return disposers
  }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(register, 'workspace-manager.commands')
    else register()
    return true
  } catch (error) {
    mark(`command-register-failed ${error?.message ?? String(error)}`)
    return false
  }
}

/**
 * 会话搬家工具。
 * @param ctx - cordis 插件上下文。
 */
function moveTool(ctx) {
  return {
    name: 'workspace_move_session',
    description: [
      '把一条会话连同它的文件搬到另一个工作区：改写会话日志的 cwd、把日志目录挪到目标桶、同步投影缓存、再改登记归属。',
      '搬家前备份到 ~/.dsh/workspace-manager-backups/。dryRun 只看计划不落盘。',
      '侧栏归属会尽量即时更新；拿不到注册表时写进 workspace.json，重启后生效。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', description: '会话 id，完整 id 或 8 位短 id。' },
        target: { type: 'string', description: '目标工作区：工作区 id、绝对路径或标题。' },
        dryRun: { type: 'boolean', description: '只返回搬家计划，不动磁盘。' },
      },
      required: ['sessionId', 'target'],
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    async execute(rawArgs) {
      const input = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
      try {
        const result = await moveSession(ctx, {
          sessionId: input.sessionId,
          target: input.target,
          dryRun: input.dryRun === true,
        })
        return jsonSafe(result)
      } catch (error) {
        mark(`move-tool-failed ${error?.message ?? String(error)}`)
        return jsonSafe({ ok: false, error: error?.message ?? String(error) })
      }
    },
  }
}

/** 新建子工作区工具。 */
function childCreateTool(ctx) {
  return {
    name: 'workspace_child_create',
    description: [
      '在 DSH 侧栏里新建一个子工作区：先在本地磁盘建出同名文件夹，再把该文件夹注册成工作区。',
      '用于「多层目录管理」——父目录默认是当前会话工作区，也可以显式给 parent（绝对路径或相对当前工作区的路径）。',
      '目录已存在时复用；工作区已注册时返回原记录。',
      '默认同时生成子项目骨架：AGENTS.md（层级与记忆约定）与 .dsh/memory.md；已存在的文件不覆盖。',
      '不会创建 .git——层级标记留在顶层仓库，避免切断父级指令与技能发现。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '子目录名（单段，不含路径分隔符，如 "backend" 或 "2026-Q1"）。' },
        parent: { type: 'string', description: '父目录，绝对路径或相对当前工作区的路径；省略时用当前会话工作区。' },
        skeleton: { type: 'boolean', description: '是否生成 AGENTS.md 与 .dsh/memory.md 骨架，默认 true；已有文件不会被覆盖。' },
      },
      required: ['name'],
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    async execute(rawArgs, exec) {
      const input = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
      try {
        const result = await createChildWorkspace(ctx, {
          name: input.name,
          parent: input.parent,
          skeleton: input.skeleton !== false,
          agent: exec?.agent,
          signal: exec?.signal,
        })
        return jsonSafe({ ok: true, ...result })
      } catch (error) {
        mark(`child-create-failed ${error?.message ?? String(error)}`)
        return { ok: false, error: error?.message ?? String(error) }
      }
    },
  }
}

/** 工作区登记表工具（list / remove）。 */
function workspaceTools(ctx) {
  return [
    {
      name: 'workspace_list',
      description: [
        '列出当前登记的全部工作区（按登记顺序），并给出每个目录的「磁盘父工作区」。',
        '宿主侧栏的树就是按这个包含关系排出来的：每深一级缩进一格。',
        '只读，不改任何状态。',
      ].join(' '),
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: textOutput,
      async execute() {
        try {
          return jsonSafe({ ok: true, workspaces: await listWorkspaces(ctx) })
        } catch (error) {
          return { ok: false, error: error?.message ?? String(error) }
        }
      },
    },
    {
      name: 'workspace_remove',
      description: [
        '移除工作区**登记**：只从侧栏登记表里删掉，不删磁盘目录、不动会话日志。',
        '用于清理测试残留或指向已删目录的失效条目；id 与 path 至少给一个。',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '工作区 id。' },
          path: { type: 'string', description: '工作区目录（绝对路径）。' },
          dryRun: { type: 'boolean', description: '只看会命中哪些，不真的删。' },
        },
        required: [],
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(rawArgs) {
        const input = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
        try {
          return jsonSafe({ ok: true, ...(await removeWorkspaces(ctx, { id: input.id, path: input.path, dryRun: input.dryRun === true })) })
        } catch (error) {
          return { ok: false, error: error?.message ?? String(error) }
        }
      },
    },
  ]
}

/**
 * 目录被删之后收尾：会话归父目录，父目录是一级目录则归未分组。
 * @param ctx - 插件上下文。
 */
function reconcileTool(ctx) {
  return {
    name: 'workspace_reconcile',
    description: [
      '扫一遍工作区：哪个目录已经不在磁盘上，就把它名下的会话交给最近的、目录还在的父工作区；',
      '父工作区自己是一级目录（上面再没有工作区）时，这批会话退回未分组。被删目录的登记行一并摘掉。',
      '只动登记与会话 cwd，不删任何文件；dryRun 只看计划不落盘。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dryRun: { type: 'boolean', description: '只返回计划，不动登记。' },
      },
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    async execute(rawArgs) {
      const input = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
      try {
        return jsonSafe(await reconcileWorkspaces(ctx, { dryRun: input.dryRun === true }))
      } catch (error) {
        return jsonSafe({ error: String(error?.message ?? error) })
      }
    },
  }
}

/**
 * 会话标题工具：给对话里的 agent 用，参数与 `/retitle` 对齐。
 * @param ctx - 插件上下文。
 */
function titleTools(ctx) {
  const titleListSchema = {
    type: 'array',
    description: '要写入的标题：[{ id: 会话 id（完整或 8 位短号）, title: "语义项目/事情" }]。',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '会话 id。' },
        title: { type: 'string', description: '标题，格式「语义项目/对应的事情」，≤40 字。' },
      },
      required: ['id', 'title'],
    },
  }

  return [
    {
      name: 'session_titles_refresh',
      description: [
        '一键整理会话标题：采集会话，分批让模型按「语义项目/对应的事情」拟标题，校验后写回投影缓存，并推给已打开的会话。',
        '默认整理全部缓存中的候选；已人工改名、已合规、子代理、归档、空会话会被跳过。',
        '传 onlyIds 只整理指定会话，forceIds 让指定会话绕过「已人工改名 / 已合规 / 已整理」检查。',
        'dryRun=true 只预演不写；force=true 让全部候选都重排。',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          days: { type: 'number', description: '可选回看天数；不传表示全部。' },
          limit: { type: 'number', description: '可选上限；不传表示不限。' },
          force: { type: 'boolean', description: '全部候选都绕过来源/合规/账本检查。' },
          onlyIds: { type: 'array', items: { type: 'string' }, description: '只整理这些会话（完整 id、8 位短号或唯一前缀）。' },
          forceIds: { type: 'array', items: { type: 'string' }, description: '强制整理这些会话，即使它们已被整理过。' },
          batchSize: { type: 'number', description: '每批交给模型的会话数；默认 20。' },
          dryRun: { type: 'boolean', description: '只预演，不写缓存。' },
          route: { type: 'string', description: '覆盖模型路由，形如 provider/model。' },
        },
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(rawArgs) {
        const input = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
        try {
          const result = await refreshTitles(ctx, {
            days: input.days,
            limit: input.limit,
            force: input.force === true,
            onlyIds: input.onlyIds,
            forceIds: input.forceIds,
            batchSize: input.batchSize,
            dryRun: input.dryRun === true,
            route: input.route,
          })
          let live
          if (result.status === 'applied' && input.dryRun !== true) live = pushLiveTitles(ctx, result.applied)
          return jsonSafe({ ok: true, ...result, live })
        } catch (error) {
          mark(`titles-refresh-failed ${error?.message ?? String(error)}`)
          return jsonSafe({ ok: false, error: error?.message ?? String(error) })
        }
      },
    },
    {
      name: 'session_titles_models',
      description: '列出标题整理可用的模型路由，以及当前实际使用的路由。只读。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: textOutput,
      async execute() {
        try {
          const routes = await modelCatalog(ctx)
          let current
          try {
            current = describeRoute(resolveRoute(ctx))
          } catch (error) {
            current = `未设置：${error?.message ?? String(error)}`
          }
          return jsonSafe({ ok: true, current, routes, services: probeServices(ctx) })
        } catch (error) {
          return jsonSafe({ ok: false, error: error?.message ?? String(error) })
        }
      },
    },
    {
      name: 'session_titles_config',
      description: '读取或保存标题整理的路由配置（provider / model / reasoningEffort / maxTokens），存在 state/titles/config.json。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', description: '服务商 id；与 model 一起设置。' },
          model: { type: 'string', description: '模型 id；与 provider 一起设置。' },
          reasoningEffort: { type: 'string', description: '可选推理档位。' },
          maxTokens: { type: 'number', description: '可选输出上限。' },
        },
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(rawArgs) {
        const input = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
        try {
          const patch = {}
          for (const key of ['provider', 'model', 'reasoningEffort', 'maxTokens']) {
            if (input[key] !== undefined) patch[key] = input[key]
          }
          if (Object.keys(patch).length > 0) writeConfig(patch)
          const config = readConfig()
          let route
          try {
            route = describeRoute(resolveRoute(ctx))
          } catch (error) {
            route = `未设置：${error?.message ?? String(error)}`
          }
          return jsonSafe({ ok: true, config, route })
        } catch (error) {
          return jsonSafe({ ok: false, error: error?.message ?? String(error) })
        }
      },
    },
    {
      name: 'session_titles_collect',
      description: '只采集候选会话（默认全部），产出 state/titles/pending.json 与 pending.md，不调模型、不写缓存。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          days: { type: 'number', description: '可选回看天数；不传表示全部。' },
          limit: { type: 'number', description: '可选上限；不传表示不限。' },
          force: { type: 'boolean', description: '全部候选都绕过来源/合规/账本检查。' },
          onlyIds: { type: 'array', items: { type: 'string' }, description: '只采集这些会话（完整 id、8 位短号或唯一前缀）。' },
          forceIds: { type: 'array', items: { type: 'string' }, description: '强制采集这些会话，即使它们已被整理过。' },
        },
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(rawArgs) {
        const input = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
        try {
          return jsonSafe({
            ok: true,
            ...collect({
              days: input.days,
              limit: input.limit,
              force: input.force === true,
              onlyIds: input.onlyIds,
              forceIds: input.forceIds,
            }),
          })
        } catch (error) {
          return jsonSafe({ ok: false, error: error?.message ?? String(error) })
        }
      },
    },
    {
      name: 'session_titles_apply',
      description: [
        '把拟好的标题写回投影缓存：写前对齐 identity、备份、记 ledger 与 runs。',
        'dryRun=true 只预演；默认不推侧栏，需要即时显示再调 set_session_titles。',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          titles: titleListSchema,
          dryRun: { type: 'boolean', description: '只预演，不写缓存。' },
          live: { type: 'boolean', description: '写成功后顺手推给已打开的会话，默认 false。' },
        },
        required: ['titles'],
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(rawArgs) {
        const input = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
        try {
          const result = applyTitles(input.titles, { dryRun: input.dryRun === true })
          let live
          if (input.dryRun !== true && input.live === true) live = pushLiveTitles(ctx, result.applied)
          return jsonSafe({ ok: true, ...result, live })
        } catch (error) {
          mark(`titles-apply-failed ${error?.message ?? String(error)}`)
          return jsonSafe({ ok: false, error: error?.message ?? String(error) })
        }
      },
    },
    {
      name: 'session_titles_repair',
      description: '一次性修复投影缓存的 identity：只按日志 header 对齐，不碰标题。默认 dryRun 只列不改。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dryRun: { type: 'boolean', description: '只列不一致，不写，默认 true。' },
        },
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(rawArgs) {
        const input = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
        try {
          return jsonSafe({ ok: true, ...repairIdentities({ dryRun: input.dryRun !== false }) })
        } catch (error) {
          return jsonSafe({ ok: false, error: error?.message ?? String(error) })
        }
      },
    },
    {
      name: 'set_session_titles',
      description: '把标题推给已经打开的会话，让侧栏即时显示；未加载的冷会话不重试，留给下次启动读缓存。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { titles: titleListSchema },
        required: ['titles'],
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(rawArgs) {
        const input = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
        try {
          return jsonSafe({ ok: true, ...setMany(ctx, input.titles) })
        } catch (error) {
          return jsonSafe({ ok: false, error: error?.message ?? String(error) })
        }
      },
    },
    {
      name: 'session_titles_schedule',
      description: '定时整理标题的接口占位。本期只做手动，定时不启用；调用只返回未启用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', description: '是否启用定时（本期固定 false）。' },
          days: { type: 'number', description: '回看天数。' },
        },
      },
      output: textOutput,
      async execute() {
        return jsonSafe({
          ok: true,
          enabled: false,
          message: '定时整理本期未启用；手动用 /retitle 或 session_titles_refresh。',
        })
      },
    },
  ]
}

/**
 * 注册全部工具。
 * @param ctx - cordis 插件上下文。
 */
function registerTools(ctx) {
  const tools = service(ctx, 'tools')
  if (tools === undefined || typeof tools.register !== 'function') {
    mark('tools-unavailable')
    return false
  }
  const definitions = [
    childCreateTool(ctx),
    moveTool(ctx),
    reconcileTool(ctx),
    ...workspaceTools(ctx),
    ...titleTools(ctx),
  ]
  for (const definition of definitions) {
    try {
      const register = () => tools.register(definition)
      if (typeof ctx.effect === 'function') ctx.effect(register, `workspace-manager.${definition.name}`)
      else register()
      mark(`tool-registered ${definition.name}`)
    } catch (error) {
      const message = String(error?.message ?? error)
      // 重载期间旧实例重试会撞上「已注册」：那是已经就位，不算失败。
      if (message.includes('already registered')) mark(`tool-present ${definition.name}`)
      else mark(`tool-register-failed ${definition.name} ${message}`)
    }
  }
  return true
}

/**
 * 插件入口。
 * @param ctx - cordis 插件上下文。
 */
export function apply(ctx) {
  mark('apply-start')

  /**
   * 冷启动时 `commands` / `tools` / `webServer` 可能还没挂上来（服务按插件顺序逐步就位），
   * 早一步取就是 null —— 那会让插件整个哑掉（2026-11-19 16:18、18:03 两次重启日志都是这样）。
   * 所以：到齐了立刻注册，没到齐就等 inject 回调。
   */
  const ready = { commands: false, tools: false, http: false }
  /**
   * 服务到齐了再注册：`ctx.inject(deps, scope => …)` 是 cordis 的正规写法，
   * 依赖还没就位时先挂着，一到齐就回调（官方插件挂 webServer 路由也是这么写的）。
   * 只用退避重试不够——2026-11-19 18:03 那次重启就是退避窗口在服务就位前耗完，
   * 插件整场哑掉，只能手动重载。
   * @param {string} name - ready 里的键。
   * @param {string[]} deps - 需要的服务名。
   * @param {(scope: object) => boolean} run - 注册动作，返回 false 表示服务仍不在。
   */
  const whenReady = (name, deps, run) => {
    const attempt = (scope) => {
      if (ready[name]) return
      try {
        if (run(scope) !== false) {
          ready[name] = true
          return
        }
        mark(`${name}-still-missing`)
      } catch (error) {
        mark(`${name}-register-failed ${error?.message ?? String(error)}`)
      }
    }
    try {
      if (deps.every((dep) => service(ctx, dep) !== undefined)) {
        attempt(ctx)
        if (ready[name]) return
      }
    } catch {
      /* 取服务本身就抛了，交给 inject */
    }
    if (typeof ctx.inject !== 'function') {
      mark(`${name}-no-inject ${deps.join(',')}`)
      return
    }
    try {
      ctx.inject(deps, (scope) => attempt(scope))
      mark(`${name}-awaiting ${deps.join(',')}`)
    } catch (error) {
      mark(`${name}-inject-error ${error?.message ?? String(error)}`)
    }
  }

  /**
   * 给浏览器半体的后台入口：页面 POST 过来，宿主直接在进程里做完。
   * 建目录、搬家、收尾都不再借任何会话跑命令——那几个动作本来就是纯文件操作。
   */
  let disposeHttp
  const registerHttp = (scope) => {
    if (ready.http) return true
    const dispose = registerHttpRoutes(scope, {
      [`${HTTP_BASE}/child`]: async (input) => {
        const result = await createChildWorkspace(scope, {
          name: input.name,
          parent: input.parent,
          skeleton: input.skeleton !== false,
        })
        return { ok: true, result: jsonSafe(result) }
      },
      [`${HTTP_BASE}/move`]: async (input) => {
        const result = await moveSession(scope, {
          sessionId: input.sessionId,
          target: input.target,
          dryRun: input.dryRun === true,
        })
        return { ok: true, result: jsonSafe(result) }
      },
      [`${HTTP_BASE}/reconcile`]: async (input) => {
        const result = await reconcileWorkspaces(scope, { dryRun: input.dryRun === true })
        return { ok: true, result: jsonSafe(result) }
      },
      [`${HTTP_BASE}/state`]: async () => ({
        ok: true,
        result: { workspaces: jsonSafe(await listWorkspaces(scope)) },
      }),
      [`${HTTP_BASE}/retitle`]: async (input) => {
        const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim() !== ''
          ? input.sessionId.trim()
          : undefined
        const result = await refreshTitles(scope, {
          days: input.days,
          limit: input.limit,
          force: input.force === true,
          onlyIds: sessionId === undefined ? undefined : [sessionId],
          forceIds: sessionId === undefined ? undefined : [sessionId],
          dryRun: input.dryRun === true,
          route: input.route,
        })
        let live
        if (result.status === 'applied' && input.dryRun !== true) live = pushLiveTitles(scope, result.applied)
        return {
          ok: true,
          result: jsonSafe({
            ...result,
            live,
            receipt: receiptLine(result, live),
          }),
        }
      },
    })
    if (typeof dispose !== 'function') return false
    disposeHttp = dispose
    ctx.on?.('dispose', dispose)
    return true
  }

  const steps = [
    ['commands', ['commands'], (scope) => registerCommands(scope)],
    ['tools', ['tools'], (scope) => registerTools(scope)],
    ['http', ['webServer'], (scope) => registerHttp(scope)],
  ]
  for (const [name, deps, run] of steps) whenReady(name, deps, run)

  /**
   * 兜底：inject 万一没触发（服务晚于事件、或上下文没有 inject），60 秒内每秒补一次。
   * 就绪三项即撤掉，不留常驻计时器。
   */
  let guardTicks = 0
  const guard = setInterval(() => {
    guardTicks += 1
    if (ready.commands && ready.tools && ready.http) {
      clearInterval(guard)
      return
    }
    if (guardTicks > 60) {
      clearInterval(guard)
      mark(`bootstrap-timeout commands=${ready.commands} tools=${ready.tools} http=${ready.http}`)
      return
    }
    for (const [name, deps, run] of steps) {
      if (ready[name]) continue
      try {
        if (deps.every((dep) => service(ctx, dep) !== undefined) && run(ctx) !== false) ready[name] = true
      } catch {
        /* 下一拍再试 */
      }
    }
  }, 1000)
  if (typeof guard?.unref === 'function') guard.unref()

  const log = ctx?.logger?.info === undefined ? undefined : ctx.logger
  log?.info?.('[dsh-workspace-manager] /mkws /mvws /reconcile /retitle、13 个工具与后台入口已就绪')
  mark('apply-done')

  /**
   * 启动后静默收尾一次：上一轮若删掉了某个工作区目录，它名下的对话会在这里归位。
   * 数据都齐了再跑（等 4 秒），失败只记日志，不影响插件本体。
   */
  const sweep = setTimeout(() => {
    try {
      ctx.assertActive?.()
    } catch {
      return
    }
    reconcileWorkspaces(ctx, {})
      .then((result) => {
        if (result.plans.length > 0) mark(`startup-reconcile ${describeReconcile(result).replace(/\n/gu, ' ')}`)
      })
      .catch((error) => mark(`startup-reconcile-failed ${error?.message ?? String(error)}`))
  }, 4000)
  if (typeof sweep?.unref === 'function') sweep.unref()

  // 交给 cordis：插件退场时把这条路由撤掉，下次重载才不会撞到自己的旧路由。
  return () => {
    try {
      disposeHttp?.()
    } catch {
      /* 上下文已经没了 */
    }
  }
}
