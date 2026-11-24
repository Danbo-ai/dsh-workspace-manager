/**
 * 浏览器半体直连宿主半体的后台通道。
 *
 * 为什么要有它：浏览器里没有文件权限，而搬家要改写会话日志、挪目录、同步投影缓存。
 * 早先的做法是「借一条会话跑 /mvws 命令」——那会让被借的会话真的跑起一轮模型，
 * 既慢又会在对话里留下痕迹。宿主有 `ctx.webServer`，插件可以自己注册一条 HTTP 路由，
 * 于是改成：页面 POST 一个请求，宿主在自己的进程里直接做完，全程不涉及任何会话。
 *
 * 安全：这些路由只服务本机 GUI。要求调用方带 `x-workspace-manager` 自定义头，
 * 跨站请求带自定义头会先触发预检，而我们不回应预检，所以外部页面无法借用户浏览器调进来。
 * 另外只接受与页面同源的请求（Origin 或 Sec-Fetch-Site 必须对得上）。
 */

import { mark } from './mark.js'


/**
 * 上一次注册装下来的清理函数，挂在进程级 Symbol 上。
 * 热重载会重新 import 这个模块（模块级变量归零），但旧上下文的路由还留在 webServer 里，
 * 再注册就报 `duplicate exact route`；所以交接点必须放在模块之外。
 */
const HANDOFF = Symbol.for('dsh-workspace-manager/http-cleanup')
const HEADER = 'x-workspace-manager'
const MAX_BODY = 64 * 1024

/** 读取请求体（有上限，避免被长连接拖住）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 同源校验：只接受页面自己发来的请求。 */
function sameOrigin(req, origin) {
  const site = String(req.headers['sec-fetch-site'] ?? '')
  if (site === 'same-origin' || site === 'none') return true
  const sent = String(req.headers.origin ?? '')
  if (sent === '') return true
  try {
    return new URL(sent).origin === origin
  } catch {
    return false
  }
}

/** 回一个 JSON 响应。失败也用 200，让页面按 `ok` 分支处理，不用区分状态码。 */
function reply(res, value) {
  const body = JSON.stringify(value)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 注册全部后台路由。
 * @param ctx - 插件上下文。
 * @param routes - `{ 路径: async (input) => result }`。
 * @returns 是否注册成功。
 */
export function registerHttpRoutes(ctx, routes) {
  /**
   * 同一进程里热重载会再次 apply，而宿主的 webServer 还留着上一次注册的路由
   * （重复注册会抛 `duplicate exact route`）。所以先把上一次的撤掉再装新的。
   */
  const previous = globalThis[HANDOFF]
  if (typeof previous === 'function') {
    try {
      previous()
    } catch {
      /* 上一次的上下文可能已经没了 */
    }
    globalThis[HANDOFF] = undefined
  }

  const server = (() => {
    try {
      return ctx.get?.('webServer') ?? ctx.webServer
    } catch {
      return undefined
    }
  })()
  if (server === undefined || server === null || typeof server.register !== 'function') {
    mark('http-unavailable 宿主没有 webServer 服务，页面将无法直接调后台')
    return false
  }

  let origin = ''
  try {
    origin = String(server.getOrigin?.() ?? '')
  } catch {
    origin = ''
  }

  const registered = new Set()
  const disposers = []
  for (const [path, run] of Object.entries(routes)) {
    const handler = async (req, res) => {
      try {
        // 每个请求都留一行：页面到底调了哪个路径、什么方法、被谁挡掉，看日志就知道。
        mark(`http-in ${String(req.method ?? 'GET').toUpperCase()} ${path}`)
        if (String(req.method ?? '').toUpperCase() !== 'POST') {
          mark(`http-405 ${path} 只接 POST`)
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        if (req.headers[HEADER] === undefined) {
          mark(`http-403 ${path} 缺 ${HEADER} 头（可能是别的调用方）`)
          res.writeHead(403)
          res.end()
          return
        }
        if (!sameOrigin(req, origin)) {
          mark(`http-403 ${path} 跨站 ${req.headers.origin ?? req.headers['sec-fetch-site'] ?? '?'}`)
          res.writeHead(403)
          res.end()
          return
        }
        const raw = await readBody(req)
        let input = {}
        if (raw.trim() !== '') {
          try {
            input = JSON.parse(raw)
          } catch {
            reply(res, { ok: false, error: '请求体不是合法 JSON' })
            return
          }
        }
        const value = await run(input === null || typeof input !== 'object' ? {} : input)
        reply(res, value)
      } catch (error) {
        mark(`http-failed ${path} ${error?.message ?? String(error)}`)
        try {
          reply(res, { ok: false, error: error?.message ?? String(error) })
        } catch {
          /* 响应已经发出去了，忽略 */
        }
      }
    }
    try {
      disposers.push(server.register({ kind: 'exact', path, handler }))
      registered.add(path)
    } catch (error) {
      mark(`http-register-failed ${path} ${error?.message ?? String(error)}`)
    }
  }

  const okPaths = Object.keys(routes).filter((path) => disposers.length > 0 && registered.has(path))
  if (okPaths.length > 0) mark(`http-routes ${okPaths.join(',')}`)
  else mark('http-none 一条路由都没装上')

  const cleanup = () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 卸载时路由可能已经没了 */
      }
    }
  }
  globalThis[HANDOFF] = cleanup
  return cleanup
}
