/**
 * 标题整理用的模型路由：读取/保存 `state/titles/config.json`，并解析出实际使用的 provider/model。
 *
 * 优先级：调用方显式覆盖 > 插件配置 > 宿主默认模型（agentDefaultModel.currentSelection()）。
 * 插件不自己存密钥，只存路由名；密钥和连接参数仍归宿主。
 */
import { mark, statePath } from './mark.js'
import { service } from './service.js'
import { readJsonFile, writeJsonAtomic } from './titles.js'

const PROVIDERS = new Set(['provider', 'model', 'reasoningEffort', 'maxTokens'])

/** 配置文件位置：state/titles/config.json。 */
export function configFile() {
  return statePath('titles', 'config.json')
}

/** 读配置；坏文件当空配置。 */
export function readConfig() {
  const value = readJsonFile(configFile(), undefined)
  if (value === null || typeof value !== 'object') return {}
  const config = {}
  if (typeof value.provider === 'string' && value.provider !== '') config.provider = value.provider
  if (typeof value.model === 'string' && value.model !== '') config.model = value.model
  if (typeof value.reasoningEffort === 'string' && value.reasoningEffort !== '') {
    config.reasoningEffort = value.reasoningEffort
  }
  if (Number.isFinite(value.maxTokens) && value.maxTokens > 0) config.maxTokens = Math.round(value.maxTokens)
  return config
}

/** 合并写配置；只认已知字段。 */
export function writeConfig(patch) {
  const next = { ...readConfig() }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!PROVIDERS.has(key)) continue
    if (value === null || value === undefined || value === '') delete next[key]
    else next[key] = value
  }
  writeJsonAtomic(configFile(), next)
  return next
}

/** 宿主默认模型路由。 */
export function defaultRoute(ctx) {
  const selector = service(ctx, 'agentDefaultModel')
  if (selector === undefined || typeof selector.currentSelection !== 'function') {
    throw new Error('宿主没有提供 agentDefaultModel 服务，无法取默认模型')
  }
  const selection = selector.currentSelection()
  if (selection === null || typeof selection !== 'object' || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
    throw new Error('宿主默认模型为空，先用 /retitle --set provider/model 指定一个')
  }
  const route = { provider: selection.provider, model: selection.model }
  if (typeof selection.reasoningEffort === 'string') route.reasoningEffort = selection.reasoningEffort
  return route
}

/** `provider/model` → 路由对象。 */
export function parseModelSpec(spec) {
  const text = String(spec ?? '').trim()
  const slash = text.indexOf('/')
  if (slash <= 0 || slash === text.length - 1) {
    throw new Error(`模型写法应为 provider/model，收到：${text || '(空)'}`)
  }
  return { provider: text.slice(0, slash).trim(), model: text.slice(slash + 1).trim() }
}

/**
 * 解析实际路由。
 * @param ctx - 插件上下文。
 * @param override - 可选的 `provider/model` 字符串或 `{provider,model}`。
 */
export function resolveRoute(ctx, override) {
  let route
  if (typeof override === 'string' && override.trim() !== '') route = parseModelSpec(override)
  else if (override !== null && typeof override === 'object' && typeof override.provider === 'string' && typeof override.model === 'string') {
    route = { provider: override.provider, model: override.model }
  } else {
    const config = readConfig()
    if (typeof config.provider === 'string' && typeof config.model === 'string') {
      route = { provider: config.provider, model: config.model }
      if (typeof config.reasoningEffort === 'string') route.reasoningEffort = config.reasoningEffort
      if (Number.isFinite(config.maxTokens)) route.maxTokens = config.maxTokens
    } else {
      route = defaultRoute(ctx)
    }
  }
  if (route.reasoningEffort === undefined) {
    const config = readConfig()
    if (typeof config.reasoningEffort === 'string') route.reasoningEffort = config.reasoningEffort
  }
  if (route.maxTokens === undefined) {
    const config = readConfig()
    if (Number.isFinite(config.maxTokens)) route.maxTokens = config.maxTokens
  }
  return route
}

/** 列出宿主已注册的模型路由。 */
export async function modelCatalog(ctx) {
  const llm = service(ctx, 'llm')
  if (llm === undefined) throw new Error('宿主没有提供 llm 服务')
  const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
  const rows = []
  for (const provider of Array.isArray(providers) ? providers : []) {
    const providerId = typeof provider?.id === 'string' ? provider.id : undefined
    if (providerId === undefined) continue
    const providerName = typeof provider?.name === 'string' ? provider.name : providerId
    try {
      const models = await llm.listModels(providerId)
      for (const model of Array.isArray(models) ? models : []) {
        if (typeof model?.id !== 'string') continue
        rows.push({
          provider: providerId,
          providerName,
          model: model.id,
          name: typeof model?.name === 'string' ? model.name : model.id,
          label: `${providerName} / ${typeof model?.name === 'string' ? model.name : model.id}`,
          description: typeof model?.description === 'string' ? model.description : undefined,
        })
      }
    } catch (error) {
      mark(`titles: listModels ${providerId} 失败：${error?.message ?? String(error)}`)
    }
  }
  return rows
}

/** 一行可读的路由。 */
export function describeRoute(route) {
  if (route === null || typeof route !== 'object') return '(未设置)'
  const head = `${route.provider}/${route.model}`
  return route.reasoningEffort === undefined ? head : `${head} (${route.reasoningEffort})`
}
