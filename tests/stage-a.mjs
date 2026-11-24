#!/usr/bin/env node
/**
 * 阶段 A 自检：语法 + 工作区结构逻辑。不连宿主，全部用内存桩。
 *
 * 跑法：node test/stage-a.mjs
 */
import './env.mjs'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
let passed = 0
const failures = []

const check = async (label, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.log(`  ✗ ${label}\n      ${error?.message ?? error}`)
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const equal = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message ?? '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

console.log('阶段 A 自检')

// —— 1. 语法 ——
console.log('\n[1] 模块语法')
for (const file of ['index.js', 'client.js', 'lib/workspace.js', 'lib/json.js', 'lib/mark.js', 'lib/service.js']) {
  await check(`${file} 可解析`, () => {
    execFileSync(process.execPath, ['--check', join(ROOT, file)], { stdio: 'pipe' })
  })
}

const {
  DIRECTORY_NAME,
  parseCommandInput,
  ensureSkeleton,
  createChildWorkspace,
  listWorkspaces,
  owningParentPath,
  samePath,
  describeSkeleton,
} = await import('../lib/workspace.js')
const { jsonSafe, readJson, writeJsonAtomic, safeStamp } = await import('../lib/json.js')

// —— 2. 目录名规则 ——
console.log('\n[2] 目录名规则')
await check('普通名字通过', () => {
  for (const ok of ['backend', '子项目', 'v2-api', 'a.b']) assert(DIRECTORY_NAME.test(ok), `${ok} 应通过`)
})
await check('非法字符被拒', () => {
  for (const bad of ['', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', 'x'.repeat(81)]) {
    assert(!DIRECTORY_NAME.test(bad), `${JSON.stringify(bad)} 应被拒`)
  }
})

// —— 3. 命令参数解析 ——
console.log('\n[3] /mkws 参数解析')
await check('单个名字', () => {
  const parsed = parseCommandInput('backend')
  equal(parsed.name, 'backend')
  equal(parsed.parent, '')
})
await check('名字 + 带引号父目录', () => {
  const parsed = parseCommandInput('"backend" "D:/work/main"')
  equal(parsed.name, 'backend')
  equal(parsed.parent, 'D:/work/main')
})
await check('名字 + 无引号父目录', () => {
  const parsed = parseCommandInput('backend D:/work/main')
  equal(parsed.name, 'backend')
  equal(parsed.parent, 'D:/work/main')
})
await check('空输入', () => {
  const parsed = parseCommandInput('   ')
  equal(parsed.name, '')
  equal(parsed.parent, '')
})

// —— 4. 骨架生成 ——
console.log('\n[4] 骨架生成')
const sandbox = mkdtempSync(join(tmpdir(), 'wsm-stage-a-'))
const skeletonDir = join(sandbox, 'backend')
mkdirSync(skeletonDir)

const skeletonResult = await ensureSkeleton(skeletonDir, 'backend', sandbox)
await check('AGENTS.md 已新建', () => equal(skeletonResult.agentsMd, 'created'))
await check('memory 已新建', () => equal(skeletonResult.memory, 'created'))
await check('两个文件都落盘且非空', () => {
  const agents = readFileSync(join(skeletonDir, 'AGENTS.md'), 'utf8')
  const memory = readFileSync(join(skeletonDir, '.dsh', 'memory.md'), 'utf8')
  assert(agents.includes('backend'), 'AGENTS.md 应含子项目名')
  assert(agents.includes(sandbox.replace(/\\/gu, '/')) || agents.includes(sandbox), 'AGENTS.md 应含父目录')
  assert(memory.includes('事实') && memory.includes('决定') && memory.includes('待办'), 'memory 应有三节')
})
await check('二次调用不覆盖（内容被用户改过）', async () => {
  const file = join(skeletonDir, 'AGENTS.md')
  writeFileSync(file, '# 用户自己写的规则\n')
  const again = await ensureSkeleton(skeletonDir, 'backend', sandbox)
  equal(again.agentsMd, 'existing')
  equal(readFileSync(file, 'utf8'), '# 用户自己写的规则\n')
})
await check('不建 .git', () => {
  assert(!existsSync(join(skeletonDir, '.git')), '不应创建 .git')
})
await check('describeSkeleton 输出人话', () => {
  assert(describeSkeleton({ agentsMd: 'created', memory: 'existing' }).includes('AGENTS.md 新建'))
})

// —— 5. createChildWorkspace（注册桩） ——
console.log('\n[5] 建目录 + 注册工作区')
const makeCtx = () => {
  const registry = {
    rows: new Map(),
    calls: { create: 0, resolveByPath: 0 },
    async resolveByPath(path) {
      this.calls.resolveByPath += 1
      for (const row of this.rows.values()) if (samePath(row.path, path)) return row
      return undefined
    },
    async create(path) {
      this.calls.create += 1
      const row = { id: `ws-${this.calls.create}`, path, title: path.split(/[\\/]/u).pop(), sessionIds: [] }
      this.rows.set(row.id, row)
      return row
    },
    list() {
      return [...this.rows.values()]
    },
  }
  return { ctx: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) }, registry }
}

const { ctx, registry } = makeCtx()
// 注意：`sandbox/backend` 在第 4 节已被建出来，这里换一个全新名字验证「目录是插件建的」。
const freshName = 'backend2'
const first = await createChildWorkspace(ctx, { name: freshName, parent: sandbox })
await check('目录已建', () => assert(first.directoryCreated === true, '应新建目录'))
await check('登记已完成', () => {
  assert(first.workspaceCreated === true, '首次应创建登记')
  assert(first.workspaceId !== undefined, '应返回工作区 id')
  equal(registry.calls.create, 1)
})
await check('骨架一并生成', () => {
  assert(existsSync(join(sandbox, freshName, 'AGENTS.md')), 'AGENTS.md 应存在')
  assert(existsSync(join(sandbox, freshName, '.dsh', 'memory.md')), 'memory.md 应存在')
})

const second = await createChildWorkspace(ctx, { name: freshName, parent: sandbox })
await check('幂等：目录复用、登记复用、不再 create', () => {
  assert(second.directoryCreated === false, '目录应复用')
  assert(second.workspaceCreated === false, '登记应复用')
  equal(second.workspaceId, first.workspaceId)
  equal(registry.calls.create, 1, 'create 只应调用一次')
})

const badName = await createChildWorkspace(ctx, { name: 'a/b', parent: sandbox }).then(() => undefined, (error) => error)
await check('非法名字被拒', () => assert(badName instanceof Error && badName.message.includes('目录名不合法'), '应抛目录名错误'))

const missingParent = await createChildWorkspace(ctx, { name: 'x', parent: join(sandbox, 'nope') }).then(() => undefined, (error) => error)
await check('父目录不存在时报错而不是造一棵树', () => {
  assert(missingParent instanceof Error && missingParent.message.includes('父目录不存在'), '应抛父目录错误')
  assert(!existsSync(join(sandbox, 'nope')), '不应创建缺失的父目录')
})

const deepRow = await registry.create(join(sandbox, freshName, 'api'))
await check('workspace_list 计算磁盘父工作区', async () => {
  const rows = await listWorkspaces(ctx)
  const api = rows.find((row) => row.id === deepRow.id)
  assert(api !== undefined, 'api 应在列表里')
  assert(api.parent !== undefined && api.parent.endsWith(freshName), `父应为 ${freshName}，实际 ${api.parent}`)
})
await check('owningParentPath 选最近的那层', () => {
  const deep = owningParentPath(registry, join(sandbox, freshName, 'api', 'v1'))
  assert(deep !== undefined && deep.endsWith('api'), `应选 api 而不是 ${freshName}，实际 ${deep}`)
})

// —— 6. JSON 落盘 ——
console.log('\n[6] 落盘工具')
const jsonFile = join(sandbox, 'state', 'x.json')
await check('writeJsonAtomic 建目录并写盘', async () => {
  await writeJsonAtomic(jsonFile, { a: 1, b: [2, 3] })
  equal(JSON.parse(readFileSync(jsonFile, 'utf8')).a, 1)
  assert(!existsSync(`${jsonFile}.tmp`), '不应留临时文件')
})
await check('readJson 缺文件时给默认值', async () => {
  const value = await readJson(join(sandbox, 'missing.json'), { fallback: true })
  equal(value.fallback, true)
})
await check('jsonSafe 去掉函数与 undefined 并识别环', () => {
  const cyclic = { keep: 1, drop: undefined, fn: () => 1 }
  cyclic.self = cyclic
  const safe = jsonSafe(cyclic)
  equal(safe.keep, 1)
  assert(safe.fn === undefined, '函数应被丢掉')
  assert(safe.self === '[Circular]' || safe.self === undefined, '环应被标记')
})
await check('工作区行经 jsonSafe 后是无损 JSON（parent 缺省时宿主不再拒收）', () => {
  const rows = [
    { id: 'a', path: 'D:/x/a', title: 'a', sessions: 0 },
    { id: 'b', path: 'D:/x/b', title: 'b', parent: 'D:/x', sessions: 1 },
  ]
  const safe = jsonSafe({ ok: true, workspaces: rows })
  const text = JSON.stringify(safe)
  assert(!text.includes('undefined'), '不应残留 undefined')
  const round = JSON.parse(text)
  equal(JSON.stringify(round), text)
})
await check('safeStamp 可用于文件名（不含冒号）', () => {
  assert(!safeStamp().includes(':'), '不应含冒号')
})

// —— 7. 索引自检脚本 ——
console.log('\n[7] check-workspace-index.mjs')
const broken = join(sandbox, 'workspace.json')
writeFileSync(broken, JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, defaultWorkspaceId: 'b', workspaceIds: ['a', 'ghost', 'a'] },
  tables: { workspaces: {
    a: { path: 'D:/a', title: 'a', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z' },
    b: { path: 'D:/b', title: 'b', sessionIds: [], createdAt: '2026-01-02T00:00:00.000Z' },
  } },
}, null, 2))
await check('坏文件被检出并以非零退出', () => {
  let code = 0
  try {
    execFileSync(process.execPath, [join(ROOT, 'tools', 'check-workspace-index.mjs'), '--file', broken], { stdio: 'pipe' })
  } catch (error) {
    code = error.status
  }
  equal(code, 1, '退出码')
})
await check('--repair 修好后能通过', () => {
  execFileSync(process.execPath, [join(ROOT, 'tools', 'check-workspace-index.mjs'), '--file', broken, '--repair'], { stdio: 'pipe' })
  const fixed = JSON.parse(readFileSync(broken, 'utf8'))
  assert(!fixed.global.workspaceIds.includes('ghost'), '幽灵 id 应被移除')
  assert(fixed.global.workspaceIds.includes('a') && fixed.global.workspaceIds.includes('b'), '两条有效 id 都应在')
  equal(new Set(fixed.global.workspaceIds).size, fixed.global.workspaceIds.length, '不应有重复 id')
  execFileSync(process.execPath, [join(ROOT, 'tools', 'check-workspace-index.mjs'), '--file', broken], { stdio: 'pipe' })
})

rmSync(sandbox, { recursive: true, force: true })


// —— 8. 客户端半体（桩环境） ——
console.log('\n[8] client.js 装载与菜单')
const clientLoaded = await (async () => {
  let captured
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
  }
  globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry } } }
  await import(`../client.js?stamp=${Date.now()}`)
  if (captured === undefined) throw new Error('client.js 没有调用 __ModuleLoader__.load')
  const exports_ = captured.factory((name) => {
    if (name === 'react') return React
    return {}
  })
  return { id: captured.id, mod: exports_ }
})()

await check('id 与包名一致', () => equal(clientLoaded.id, 'dsh-workspace-manager'))
await check('导出 inject 与 apply', () => {
  assert(Array.isArray(clientLoaded.mod.inject), 'inject 应是数组')
  assert(typeof clientLoaded.mod.apply === 'function', 'apply 应是函数')
})
await check('inject 只留 slots 与 contextMenus（后台直连后不再借会话）', () => {
  equal(clientLoaded.mod.inject.join(','), 'slots,contextMenus')
})

const clientProbe = { menus: [], slot: undefined, notifications: [] }
clientLoaded.mod.apply({
  slots: {
    inject: (name, fn) => { fn.call(null) },
    register: (spec, component) => {
      clientProbe.slot = { name: spec.name, id: spec.id, component }
      return { dispose() {} }
    },
  },
  contextMenus: {
    register: (spec) => {
      clientProbe.menus.push(spec)
      return { dispose() {} }
    },
    notify: (text, success) => clientProbe.notifications.push({ text, success }),
  },
  effect: (fn) => { fn() },
  get: () => undefined,
})

const workspaceMenu = clientProbe.menus.find((menu) => menu.target === 'workspace')
const sessionMenu = clientProbe.menus.find((menu) => menu.target === 'session')

await check('菜单分别注册到 workspace 与 session 目标', () => {
  assert(workspaceMenu !== undefined, '应注册工作区菜单')
  assert(sessionMenu !== undefined, '应注册会话菜单')
  equal(workspaceMenu.order, 200)
  equal(sessionMenu.order, 250)
})
await check('工作区菜单三项都能解出标签与动作', () => {
  const actions = workspaceMenu.resolve({ workspaceId: 'ws-1', path: 'D:/work/main', displayTitle: 'main' })
  equal(actions.length, 3)
  equal(actions[0].id, 'new-child')
  equal(actions[0].label, '新建子工作区…')
  equal(actions[1].id, 'new-sibling')
  equal(actions[2].id, 'titles')
  equal(actions[2].label, '整理全部对话标题…')
  assert(typeof actions[0].run === 'function', 'run 应是函数')
})
await check('会话菜单追加「整理本会话标题…」', () => {
  const actions = sessionMenu.resolve({ sessionId: 'session-aaaa1111', displayTitle: '旧标题' })
  equal(actions.length, 1)
  equal(actions[0].id, 'titles')
  equal(actions[0].label, '整理本会话标题…')
  assert(typeof actions[0].run === 'function', 'run 应是函数')
})
await check('点「新建同级」时父目录取上一层', () => {
  const actions = workspaceMenu.resolve({ workspaceId: 'ws-1', path: 'D:/work/main', displayTitle: 'main' })
  actions[1].run()
  const wrapper = clientProbe.slot.component({})
  assert(wrapper !== null, '应渲染出对话框')
  // apply 注册的是 (props) => h(Dialog, props)，这里再往里走一层拿到真正渲染结果。
  const tree = typeof wrapper.type === 'function' ? wrapper.type(wrapper.props) : wrapper
  const text = JSON.stringify(tree)
  assert(text.includes('新建同级工作区'), '对话框标题应为新建同级工作区')
  assert(text.includes('D:/work'), `父目录应上移一层，实际内容 ${text.slice(0, 200)}`)
})

await check('工作区菜单直接 POST 全量整理，不投会话', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return {
      ok: true,
      async json() {
        return { ok: true, result: { status: 'applied', receipt: '规范化 0 条（侧栏即时 0 / 待重启 0；跳过 0）' } }
      },
    }
  }
  try {
    const actions = workspaceMenu.resolve({ workspaceId: 'ws-1', path: 'D:/work/main' })
    actions[2].run()
    await new Promise((resolve) => setTimeout(resolve, 20))
    equal(calls.length, 1)
    equal(calls[0].url, '/workspace-manager/retitle')
    equal(Object.keys(calls[0].body).length, 0)
    equal(clientProbe.notifications.at(-1).text.includes('规范化'), true)
  } finally {
    globalThis.fetch = original
  }
})

await check('会话菜单只 POST 该会话并强制重排', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return {
      ok: true,
      async json() {
        return { ok: true, result: { status: 'applied', receipt: '规范化 1 条（侧栏即时 1 / 待重启 0；跳过 0）' } }
      },
    }
  }
  try {
    const actions = sessionMenu.resolve({ sessionId: 'session-aaaa1111', displayTitle: '旧标题' })
    actions[0].run()
    await new Promise((resolve) => setTimeout(resolve, 20))
    equal(calls.length, 1)
    equal(calls[0].url, '/workspace-manager/retitle')
    equal(calls[0].body.sessionId, 'session-aaaa1111')
    equal(calls[0].body.force, true)
  } finally {
    globalThis.fetch = original
  }
})
await check('空路径不挂菜单', () => {
  equal(workspaceMenu.resolve({ workspaceId: 'ws-1', path: '', displayTitle: '' }).length, 0)
})

console.log(`\n结果：${passed} 通过，${failures.length} 失败`)
if (failures.length > 0) {
  for (const { label, error } of failures) console.error(`✗ ${label}\n${error?.stack ?? error}`)
  process.exit(1)
}
