/**
 * 标题整理的模型链：把采集到的候选交给宿主 llm，按 `<语义项目>/<对应的事情>` 拟标题。
 *
 * 不新建会话，也不经过当前会话；命令/工具在插件内直接调模型。
 * 解析失败、模型返回空、路由不存在时都只返回可读错误，不写缓存。
 */
import { mark } from './mark.js'
import { service } from './service.js'
import { applyTitles, collect, validateTitle } from './titles.js'
import { describeRoute, resolveRoute } from './titles-config.js'

const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_TIMEOUT_MS = 120_000

const SYSTEM_PROMPT = [
  '你在整理 DeepSeek Harness 的会话标题。',
  '为每个候选生成「<语义项目>/<对应的事情>」格式的标题。',
  '',
  '硬规则：',
  '1. 总长度不超过 40 个字符，单行，不含换行；',
  '2. 语义项目 2–6 个汉字，优先从「已知项目」里选；不要直接把工作区目录名当项目名；',
  '3. 事情必须写成动词短语（做什么、查什么、修什么），不要照抄第一条 prompt；',
  '4. 标题不以网址开头，不加引号，不加书名号；',
  '5. 周期性自动化会话在事情后面补「 · MM-DD HH:mm」（用最后活跃时间）；',
  '6. id 必须原样返回，不能增删候选。',
  '',
  '只输出 JSON 数组，不要解释，不要 Markdown 代码块。',
  '格式：[{"id":"会话 id","title":"项目/事情"}, ...]',
].join('\n')

/** 把候选压成模型输入。 */
export function buildTitleInput(entries, knownProjects = []) {
  const lines = []
  if (knownProjects.length > 0) lines.push(`已知项目：${knownProjects.join('、')}`, '')
  else lines.push('已知项目：（暂无，可自行提炼 2–6 字项目名）', '')
  entries.forEach((entry, index) => {
    lines.push(`#${index + 1}`)
    lines.push(`id=${entry.id}`)
    lines.push(`短号=${entry.short}`)
    lines.push(`工作区=${entry.workspace || '?'}`)
    lines.push(`当前标题=${entry.title || '(空)'}（来源=${entry.titleSource ?? '未标记'}，${entry.turns ?? '?'} 轮）`)
    lines.push(`最后活跃=${entry.lastActive || '未知'}`)
    lines.push(`命中原因=${entry.reason}`)
    const prompts = Array.isArray(entry.prompts) ? entry.prompts.slice(0, 8) : []
    prompts.forEach((prompt, promptIndex) => lines.push(`prompt${promptIndex + 1}=${prompt}`))
    lines.push('')
  })
  return lines.join('\n').trim()
}

/** 从模型输出里取 JSON 数组；允许前后有解释文字。 */
export function parseDecisions(text) {
  const source = String(text ?? '')
  const start = source.indexOf('[')
  const end = source.lastIndexOf(']')
  if (start === -1 || end <= start) throw new Error('模型输出里没有 JSON 数组')
  let parsed
  try {
    parsed = JSON.parse(source.slice(start, end + 1))
  } catch (error) {
    throw new Error(`模型输出的 JSON 解析失败：${error?.message ?? String(error)}`)
  }
  if (!Array.isArray(parsed)) throw new Error('模型输出不是数组')
  return parsed
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id.trim() : '',
      title: typeof item.title === 'string' ? item.title.trim() : '',
    }))
    .filter((item) => item.id !== '' && item.title !== '')
}

/** 收集流里的文本增量；错误/中断直接抛。 */
async function streamText(stream) {
  const parts = []
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      parts.push(chunk.text)
      continue
    }
    if (chunk?.type === 'finish') {
      if (chunk.reason === 'error') throw new Error('模型调用失败（finish=error）')
      if (chunk.reason === 'aborted') throw new Error('模型调用被中断（finish=aborted）')
    }
  }
  return parts.join('')
}

/** 一小批一次模型调用：全量候选可能上百条，单次上下文放不下。 */
async function callTitleBatch(llm, config, entries, knownProjects, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('模型调用超时')), timeoutMs)
  timer.unref?.()
  try {
    const call = await llm.prepareCall(config, controller.signal)
    const stream = call.stream({
      ...call.config,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: buildTitleInput(entries, knownProjects) }],
        },
      ],
      signal: controller.signal,
    })
    return await streamText(stream)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 一键整理：采集 → 分批调模型 → 校验 → 写回。
 * @param ctx - 插件上下文。
 * @param options.days - 可选回看天数；不传表示全部。
 * @param options.limit - 可选上限；不传表示不限。
 * @param options.force - 连已合规/人工改名的也重排。
 * @param options.onlyIds - 只整理这些会话。
 * @param options.forceIds - 强制整理这些会话。
 * @param options.dryRun - 只预览，不写缓存。
 * @param options.route - 覆盖路由（`provider/model` 或对象）。
 * @param options.batchSize - 每次模型调用处理几条，默认 20。
 */
export async function refreshTitles(ctx, options = {}) {
  const collected = collect({
    days: options.days,
    limit: options.limit,
    force: options.force,
    onlyIds: options.onlyIds,
    forceIds: options.forceIds,
  })
  if (collected.entries.length === 0) {
    return {
      status: 'empty',
      days: collected.days,
      route: undefined,
      collected,
      message: '没有需要整理的会话',
    }
  }

  let route
  try {
    route = resolveRoute(ctx, options.route)
  } catch (error) {
    return { status: 'no-route', collected, message: error?.message ?? String(error) }
  }
  const llm = service(ctx, 'llm')
  if (llm === undefined || typeof llm.prepareCall !== 'function') {
    return { status: 'no-llm', collected, route, message: '宿主没有提供 llm 服务' }
  }

  const config = { provider: route.provider, model: route.model }
  if (typeof route.reasoningEffort === 'string') config.reasoningEffort = route.reasoningEffort
  config.maxTokens = Number.isFinite(options.maxTokens) && options.maxTokens > 0 ? Math.round(options.maxTokens) : route.maxTokens ?? DEFAULT_MAX_TOKENS

  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const batchSize = Number.isFinite(options.batchSize) && options.batchSize > 0 ? Math.max(1, Math.round(options.batchSize)) : 20
  const batches = []
  for (let index = 0; index < collected.entries.length; index += batchSize) {
    batches.push(collected.entries.slice(index, index + batchSize))
  }

  const decisions = []
  const batchErrors = []
  for (const [index, batch] of batches.entries()) {
    try {
      const text = await callTitleBatch(llm, config, batch, collected.knownProjects, timeoutMs)
      decisions.push(...parseDecisions(text))
    } catch (error) {
      const message = error?.message ?? String(error)
      batchErrors.push({ batch: index + 1, total: batches.length, count: batch.length, message })
      mark(`titles: 第 ${index + 1}/${batches.length} 批失败 route=${describeRoute(route)} ${message}`)
    }
  }

  const byId = new Map()
  for (const entry of collected.entries) {
    byId.set(entry.id, entry)
    byId.set(entry.short, entry)
  }
  const accepted = []
  const rejected = []
  const seen = new Set()
  for (const decision of decisions) {
    const entry = byId.get(decision.id) ?? [...byId.values()].find((item) => item.short === decision.id)
    if (entry === undefined) {
      rejected.push({ id: decision.id, title: decision.title, reason: '不在候选里' })
      continue
    }
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    const checked = validateTitle(decision.title)
    if (!checked.ok) {
      rejected.push({ id: entry.id, short: entry.short, title: decision.title, reason: checked.reason })
      continue
    }
    accepted.push({ id: entry.id, short: entry.short, title: checked.title })
  }

  if (accepted.length === 0) {
    const allFailed = batchErrors.length === batches.length
    return {
      status: allFailed ? 'llm-error' : 'no-decision',
      collected,
      route,
      rejected,
      batchCount: batches.length,
      batchErrors,
      message: allFailed ? (batchErrors[0]?.message ?? '模型调用失败') : '模型没有给出可用标题',
    }
  }

  const applied = applyTitles(accepted, { dryRun: options.dryRun === true, days: collected.days })
  return {
    status: applied.status,
    route,
    collected: {
      days: collected.days,
      candidateCount: collected.entries.length,
      skipped: collected.stats.skipped,
      byReason: collected.stats.byReason,
      knownProjects: collected.knownProjects,
      pending: collected.file,
    },
    batchCount: batches.length,
    batchErrors,
    ...applied,
    rejected: [...rejected, ...applied.rejected],
    message: options.dryRun === true
      ? '预演完成，未写缓存'
      : (batchErrors.length > 0 ? `已写回投影缓存（${batchErrors.length} 个批次失败）` : '已写回投影缓存'),
  }
}
