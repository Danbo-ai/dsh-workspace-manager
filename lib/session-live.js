/**
 * 侧栏即时改名：把标题推给**已加载**的会话，让侧栏不用重启就变。
 *
 * 冷启动看到的是投影缓存（titles.js 已写回）；进程里打开的会话走
 * `sessionTitle.rename(session, title)`。rename 要求传进来的 session
 * 必须是 `sessions.get(id)` 返回的同一对象（宿主用它确认活态），
 * 所以这里只从 sessions 取，不自己造对象、也不 resume 冷会话——
 * 冷会话留给下次启动读缓存，PRD 明确不重试。
 */
import { service } from './service.js'
import { resolveSessionId, shortId } from './titles.js'

/** 活会话的取法：只认 sessions.get(id)。 */
export function liveSession(ctx, sessionId) {
  const sessions = service(ctx, 'sessions')
  if (sessions === undefined || typeof sessions.get !== 'function') return undefined
  try {
    const session = sessions.get(sessionId)
    if (session !== undefined && session !== null) return session
  } catch {
    /* 取活会话本身抛了，按未加载处理 */
  }
  return undefined
}

/**
 * 改一个会话的标题。
 * @returns {{status: 'applied'|'not-loaded'|'error', error?: string}}
 */
export function setOne(ctx, sessionId, title) {
  const session = liveSession(ctx, sessionId)
  if (session === undefined) return { status: 'not-loaded' }

  const sessionTitle = service(ctx, 'sessionTitle')
  if (sessionTitle === undefined || typeof sessionTitle.rename !== 'function') {
    return { status: 'error', error: 'sessionTitle 服务不可用' }
  }
  try {
    sessionTitle.rename(session, title)
    return { status: 'applied' }
  } catch (error) {
    return { status: 'error', error: error?.message ?? String(error) }
  }
}

/**
 * 批量推侧栏。
 * @param titles - [{id, title}]；重复 id 只取第一条。
 */
export function setMany(ctx, titles) {
  const list = Array.isArray(titles) ? titles : []
  const seen = new Set()
  const results = []
  let applied = 0
  let notLoaded = 0
  let failed = 0

  for (const item of list) {
    const rawId = String(item?.id ?? '').trim()
    const title = String(item?.title ?? '').trim()
    if (rawId === '' || title === '') continue
    const resolved = resolveSessionId(rawId)
    if (resolved.error !== undefined) {
      failed += 1
      results.push({ id: rawId, short: shortId(rawId), title, status: 'error', error: resolved.error })
      continue
    }
    const id = resolved.id
    if (seen.has(id)) continue
    seen.add(id)
    const outcome = setOne(ctx, id, title)
    if (outcome.status === 'applied') applied += 1
    else if (outcome.status === 'not-loaded') notLoaded += 1
    else failed += 1
    results.push({
      id,
      short: shortId(id),
      title,
      status: outcome.status,
      error: outcome.error,
    })
  }

  return { total: seen.size, applied, notLoaded, failed, results }
}

/** 诊断：宿主侧栏相关服务在不在。 */
export function probeServices(ctx) {
  const sessionTitle = service(ctx, 'sessionTitle')
  const sessions = service(ctx, 'sessions')
  return {
    sessions: typeof sessions?.get === 'function' ? 'ok' : 'missing',
    sessionTitle: typeof sessionTitle?.rename === 'function' ? 'ok' : 'missing',
  }
}
