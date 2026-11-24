/**
 * 惰性取宿主服务。
 *
 * 为什么不用 inject：inject 一个不存在的服务会让整行插件静默不挂载，
 * 代价太大。这里全部在执行时按名字取，取不到就让调用方给出可读错误。
 */
import { mark } from './mark.js'

/**
 * 取一个宿主服务。
 * 顺序很关键：`ctx.get` 不需要 inject；直接读 `ctx.x` 对未 inject 的服务会抛；
 * `reflect.get` 是 cordis 4 的内部入口，作为最后兜底。
 * @param ctx - cordis 插件上下文。
 * @param serviceName - 服务名。
 */
export function service(ctx, serviceName) {
  const attempts = []
  const tryOne = (label, read) => {
    try {
      const value = read()
      if (value !== undefined && value !== null) return value
      attempts.push(`${label}=null`)
    } catch (error) {
      attempts.push(`${label}!${error?.message ?? String(error)}`)
    }
    return undefined
  }

  let found = tryOne('ctx.get', () => (typeof ctx?.get === 'function' ? ctx.get(serviceName) : undefined))
  if (found === undefined) found = tryOne('property', () => ctx?.[serviceName])
  if (found === undefined) {
    found = tryOne('reflect.get', () => (typeof ctx?.reflect?.get === 'function' ? ctx.reflect.get(serviceName) : undefined))
  }
  if (found === undefined) mark(`service ${serviceName} unavailable (${attempts.join(' | ')})`)
  return found
}
