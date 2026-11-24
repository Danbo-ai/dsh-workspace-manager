import './env.mjs'
import { registerHttpRoutes } from '../lib/http.js'

/**
 * 后台入口（/wsm/*）的守门测试。
 *
 * 这里不打真实的业务流程（那要宿主服务），只验三件必须成立的事：
 * ①四条路由都按 exact 注册；②不是 POST 一律 405；③没有插件自定义头或跨站来的请求一律 403，
 * ④正常请求把 JSON 原样回给页面、处理函数抛错时回 `{ok:false}` 而不是把异常抛到连接上。
 */

let passed = 0
let failed = 0

async function check(label, run) {
  try {
    await run()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${label}\n    ${error?.message ?? error}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** 造一个够用的 IncomingMessage：事件式 body + 头。 */
function fakeRequest({ method = 'POST', headers = {}, body = '' }) {
  const listeners = new Map()
  return {
    method,
    headers,
    on(event, handler) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
      if (event === 'end') {
        queueMicrotask(() => {
          for (const one of listeners.get('data') ?? []) one(Buffer.from(body))
          for (const one of listeners.get('end') ?? []) one()
        })
      }
      return this
    },
    destroy() {},
  }
}

/** 造一个捕获型 ServerResponse。 */
function fakeResponse() {
  const captured = { status: 0, headers: {}, body: '' }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers ?? {}
    },
    end(chunk) {
      captured.body = chunk === undefined ? '' : String(chunk)
    },
  }
}

const routes = new Map()
const fakeServer = {
  getOrigin: () => 'http://127.0.0.1:55845',
  register(route) {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
}

const ctx = { get: (name) => (name === 'webServer' ? fakeServer : undefined) }

const dispose = registerHttpRoutes(ctx, {
  '/wsm/child': async (input) => ({ ok: true, result: { echo: input } }),
  '/wsm/move': async () => ({ ok: true, result: { moved: true } }),
  '/wsm/reconcile': async () => ({ ok: true, result: { plans: [] } }),
  '/wsm/state': async () => ({ ok: true, result: { workspaces: [] } }),
  '/wsm/boom': async () => {
    throw new Error('故意失败')
  },
})

console.log('[http] 后台入口守门')

await check('四条业务路由 + 一条失败路由都按 exact 注册', () => {
  assert(routes.size === 5, `路由数不对：${[...routes.keys()].join(',')}`)
  for (const path of ['/wsm/child', '/wsm/move', '/wsm/reconcile', '/wsm/state']) {
    assert(routes.has(path), `缺路由 ${path}`)
    assert(routes.get(path).kind === 'exact', `${path} 不是 exact`)
    assert(typeof routes.get(path).handler === 'function', `${path} 没有 handler`)
  }
})

await check('GET 一律 405 并回 Allow: POST', async () => {
  const res = fakeResponse()
  await routes.get('/wsm/move').handler(fakeRequest({ method: 'GET' }), res)
  assert(res.captured.status === 405, `状态码应为 405，实际 ${res.captured.status}`)
  assert(String(res.captured.headers.allow).toUpperCase() === 'POST', 'Allow 头不对')
})

await check('缺 x-workspace-manager 头一律 403', async () => {
  const res = fakeResponse()
  await routes.get('/wsm/move').handler(fakeRequest({}), res)
  assert(res.captured.status === 403, `状态码应为 403，实际 ${res.captured.status}`)
})

await check('跨站来的请求 403（Origin 对不上）', async () => {
  const res = fakeResponse()
  await routes.get('/wsm/move').handler(fakeRequest({
    headers: { 'x-workspace-manager': '1', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  }), res)
  assert(res.captured.status === 403, `状态码应为 403，实际 ${res.captured.status}`)
})

await check('同源请求拿回 JSON，且 body 被反序列化传进处理函数', async () => {
  const res = fakeResponse()
  await routes.get('/wsm/child').handler(fakeRequest({
    headers: { 'x-workspace-manager': '1', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ name: 'demo', parent: 'D:/a' }),
  }), res)
  assert(res.captured.status === 200, `状态码应为 200，实际 ${res.captured.status}`)
  assert(String(res.captured.headers['content-type']).includes('application/json'), 'content-type 不对')
  const body = JSON.parse(res.captured.body)
  assert(body.ok === true, 'ok 应为 true')
  assert(body.result.echo.name === 'demo', 'body 没有传进处理函数')
})

await check('非法 JSON 回可读错误而不是 500', async () => {
  const res = fakeResponse()
  await routes.get('/wsm/move').handler(fakeRequest({
    headers: { 'x-workspace-manager': '1' },
    body: '{ 不是 JSON',
  }), res)
  const body = JSON.parse(res.captured.body)
  assert(body.ok === false, 'ok 应为 false')
  assert(String(body.error).includes('JSON'), `error 文案不对：${body.error}`)
})

await check('处理函数抛错时回 {ok:false,error}，连接不炸', async () => {
  const res = fakeResponse()
  await routes.get('/wsm/boom').handler(fakeRequest({
    headers: { 'x-workspace-manager': '1' },
    body: '{}',
  }), res)
  assert(res.captured.status === 200, `状态码应为 200，实际 ${res.captured.status}`)
  const body = JSON.parse(res.captured.body)
  assert(body.ok === false && body.error === '故意失败', `错误回包不对：${res.captured.body}`)
})

await check('dispose 之后路由全部撤下', () => {
  dispose()
  assert(routes.size === 0, `还有 ${routes.size} 条路由没撤`)
})

await check('同一进程里再注册一次会先撤掉旧的（热重载不报 duplicate）', () => {
  const again = registerHttpRoutes(ctx, { '/wsm/x': async () => ({ ok: true, result: {} }) })
  assert(routes.size === 1 && routes.has('/wsm/x'), `重载后路由不对：${[...routes.keys()].join(',')}`)
  assert(typeof again === 'function', '应返回清理函数')
  again()
  assert(routes.size === 0, '清理后应没有路由')
})

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
