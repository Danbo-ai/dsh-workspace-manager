/**
 * 标题整理自检：离线造 ~/.dsh 沙盒，验证采集跳过规则、标题校验、
 * 预演不写、正式写回（备份 / 记账 / runs）、identity 对齐与一次性修复。
 *
 * 不碰真实 ~/.dsh：全部落在临时目录，通过 WSM_HOME_DIR 重定向。
 * 运行：node tests/titles.mjs
 */
import './env.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wsm-titles-'))
process.env.WSM_HOME_DIR = HOME
process.env.WSM_STATE_DIR = path.join(HOME, 'state')

const titles = await import('../lib/titles.js')
const { dshPaths, encodeCwd } = await import('../lib/move-session.js')

let passed = 0
const failed = []
async function check(title, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${title}`)
  } catch (error) {
    failed.push({ title, error })
    console.log(`  ✗ ${title}\n      ${error?.message ?? String(error)}`)
  }
}
const equal = (actual, expected, label = '') => assert.deepEqual(actual, expected, label)
const ok = (value, label = '') => assert.ok(value, label)

const { sessions, projcache } = dshPaths()
fs.mkdirSync(sessions, { recursive: true })
fs.mkdirSync(projcache, { recursive: true })

const CWD = 'D:/wsm-titles'
const EVENT_HEADER = (session) => ({
  type: 'session',
  version: session.version ?? 4,
  id: session.id,
  createdAt: session.createdAt ?? '2026-11-20T00:00:00.000Z',
  cwd: session.cwd ?? CWD,
  isSeeded: false,
  delegationDepth: session.delegationDepth ?? 0,
})

/** 造一条两帧日志：header + 一条用户消息。 */
function writeLog(session) {
  const dir = path.join(sessions, encodeCwd(session.cwd ?? CWD), session.id)
  fs.mkdirSync(dir, { recursive: true })
  const first = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(EVENT_HEADER(session))}\n`, 'utf8'))
  const event = {
    seq: 1,
    type: 'user/message',
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text: session.prompt ?? '帮我整理一下这个会话的标题' }],
    },
  }
  const second = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'))
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([first, second]))
}

/** 造投影缓存；identityCwd 用来故意制造错位。 */
function writeProjection(session) {
  const active = session.active ?? Date.now()
  const rows = {
    workingDirectory: { ver: 3, seq: 3, val: session.cwd ?? CWD },
    title: { ver: 1, seq: 1, val: session.title ?? '' },
    timeContext: { ver: 1, seq: 1, val: { lastMessageTime: active } },
    sessionListMetadata: { ver: 1, seq: 1, val: { blank: session.blank === true } },
  }
  if (session.source !== undefined) {
    rows[titles.TITLE_SOURCE_KEY] = { ver: 1, seq: 1, val: session.source }
  }
  const doc = {
    version: 7,
    record: {
      identity: {
        formatVersion: 4,
        createdAt: session.createdAt ?? '2026-11-20T00:00:00.000Z',
        cwd: session.identityCwd ?? session.cwd ?? CWD,
        isSeeded: false,
      },
      rows,
    },
  }
  fs.writeFileSync(path.join(projcache, `${session.id}.json`), JSON.stringify(doc))
}

const now = Date.now()
const STALE = 'session-ffff6666-0000-0000-0000-000000000006'
const SESSIONS = [
  { id: 'session-aaaa1111-0000-0000-0000-000000000001', title: '未命名', active: now },
  { id: 'session-bbbb2222-0000-0000-0000-000000000002', title: '未命名', active: now, delegationDepth: 1 },
  { id: 'session-cccc3333-0000-0000-0000-000000000003', title: '未命名', active: now, source: 'user' },
  { id: 'session-dddd4444-0000-0000-0000-000000000004', title: '工作区优化/整理标题', active: now },
  { id: 'session-eeee5555-0000-0000-0000-000000000005', title: '未命名', active: now, blank: true },
  { id: STALE, title: '未命名', active: now - 30 * 24 * 60 * 60 * 1000 },
]
for (const session of SESSIONS) {
  writeLog(session)
  writeProjection(session)
}

const CANDIDATE = SESSIONS[0].id
const CANDIDATE_FILE = path.join(projcache, `${CANDIDATE}.json`)

console.log('\n[1] 标题校验与短号')
await check('validateTitle 接受「项目/事情」', () => {
  equal(titles.validateTitle('工作区优化/整理对话标题'), { ok: true, title: '工作区优化/整理对话标题' })
})
await check('validateTitle 拒绝超长、换行、网址、缺格式、项目过长', () => {
  ok(!titles.validateTitle(`工作区优化/${'很'.repeat(40)}`).ok, '超长')
  ok(!titles.validateTitle('工作区优化/整理\n标题').ok, '换行')
  ok(!titles.validateTitle('https://example.com/整理').ok, '网址')
  ok(!titles.validateTitle('没有斜杠').ok, '缺格式')
  ok(!titles.validateTitle('这个项目名太长了/整理').ok, '项目过长')
})
await check('shortId 去掉 session- 取前 8 位', () => {
  equal(titles.shortId(CANDIDATE), 'aaaa1111')
})
await check('resolveSessionId 接受短号与唯一前缀', () => {
  equal(titles.resolveSessionId('aaaa1111').id, CANDIDATE)
  equal(titles.resolveSessionId('session-aaaa1111').id, CANDIDATE)
  ok(titles.resolveSessionId('不存在').error !== undefined, '找不到应报错')
})

console.log('\n[2] collect 默认全量 / 天数过滤 / 指定会话')
const collected = titles.collect({ days: 7 })
await check('显式天数仍只留下近期可整理候选', () => {
  equal(collected.entries.map((entry) => entry.id), [CANDIDATE])
  equal(collected.entries[0].short, 'aaaa1111')
  ok(collected.entries[0].prompts.length > 0, '应带用户 prompt')
})
await check('跳过原因分别计数（含 7 天前不活跃）', () => {
  equal(collected.stats.skipped, 5)
  equal(collected.stats.byReason['子代理会话'], 1)
  equal(collected.stats.byReason['已人工改名'], 1)
  equal(collected.stats.byReason['标题已合规'], 1)
  equal(collected.stats.byReason['空会话'], 1)
  equal(collected.stats.byReason['7 天前不活跃'], 1)
})
await check('不传 days 时整理全部，不按活跃时间裁剪', () => {
  const all = titles.collect()
  equal(all.entries.map((entry) => entry.id), [CANDIDATE, STALE])
  equal(all.days, undefined)
  equal(all.stats.byReason['7 天前不活跃'], undefined)
})
await check('不传 limit 时默认不限条数', () => {
  equal(titles.collect({ limit: 1 }).entries.length, 1)
  equal(titles.collect().entries.length, 2)
})
await check('onlyIds 只收指定会话', () => {
  const scoped = titles.collect({ onlyIds: ['cccc3333'] })
  equal(scoped.entries.length, 0)
  equal(scoped.stats.byReason['已人工改名'], 1)
  equal(scoped.mode, 'session')
})
await check('forceIds 让指定会话绕过来源/合规检查', () => {
  const forced = titles.collect({ onlyIds: ['dddd4444'], forceIds: ['dddd4444'] })
  equal(forced.entries.map((entry) => entry.short), ['dddd4444'])
  equal(forced.entries[0].reason, '指定会话，强制重排')
})
await check('短号解析失败记 errors，且不退回全量', () => {
  const bad = titles.collect({ onlyIds: ['zzzz9999'] })
  equal(bad.stats.scanned, 0)
  equal(bad.stats.errors.length, 1)
  equal(bad.entries.length, 0)
})
await check('pending.json / pending.md 已落盘', () => {
  ok(fs.existsSync(path.join(HOME, 'state', 'titles', 'pending.json')), 'pending.json')
  ok(fs.existsSync(path.join(HOME, 'state', 'titles', 'pending.md')), 'pending.md')
})

console.log('\n[3] applyTitles 预演与正式写回')
const before = fs.readFileSync(CANDIDATE_FILE, 'utf8')
const dry = titles.applyTitles([{ id: 'aaaa1111', title: '工作区优化/整理对话标题' }], { dryRun: true })
await check('预演接受 8 位短号，只返回计划，不写缓存、不备份', () => {
  equal(dry.status, 'dry-run')
  equal(dry.applied.length, 1)
  equal(dry.applied[0].id, CANDIDATE)
  equal(dry.applied[0].titleChanged, true)
  equal(fs.readFileSync(CANDIDATE_FILE, 'utf8'), before)
  ok(!fs.existsSync(path.join(HOME, 'state', 'titles', 'backups')), '不应有备份目录')
})

const real = titles.applyTitles([{ id: CANDIDATE, title: '工作区优化/整理对话标题' }], { days: 7 })
await check('正式写回 title 与 titleSource', () => {
  equal(real.status, 'applied')
  equal(real.applied.length, 1)
  const doc = JSON.parse(fs.readFileSync(CANDIDATE_FILE, 'utf8'))
  equal(doc.record.rows.title.val, '工作区优化/整理对话标题')
  equal(doc.record.rows[titles.TITLE_SOURCE_KEY].val, 'user')
})
await check('写前备份、ledger、runs 均有记录', () => {
  const backups = fs.readdirSync(path.join(HOME, 'state', 'titles', 'backups'))
  ok(backups.some((name) => name.startsWith(`${CANDIDATE}.`)), '备份')
  const ledger = JSON.parse(fs.readFileSync(path.join(HOME, 'state', 'titles', 'ledger.json'), 'utf8'))
  equal(ledger.entries[CANDIDATE].title, '工作区优化/整理对话标题')
  const runs = fs.readdirSync(path.join(HOME, 'state', 'titles', 'runs'))
  ok(runs.length > 0, 'runs')
})
await check('重复 id 只处理一次', () => {
  const result = titles.applyTitles([
    { id: CANDIDATE, title: '工作区优化/整理对话标题' },
    { id: CANDIDATE, title: '工作区优化/另一个标题' },
  ])
  equal(result.applied.length, 0)
  equal(result.unchanged.length, 1)
})

console.log('\n[4] identity 对齐与一次性修复')
const cache = JSON.parse(fs.readFileSync(CANDIDATE_FILE, 'utf8'))
cache.record.identity.cwd = 'D:/wrong-cwd'
fs.writeFileSync(CANDIDATE_FILE, JSON.stringify(cache))

const repaired = titles.applyTitles([{ id: CANDIDATE, title: '工作区优化/再次整理标题' }])
await check('写标题时把 identity 的 cwd 对齐到日志 header', () => {
  equal(repaired.identityRepaired, 1)
  ok(repaired.applied[0].repairedFields.includes('cwd'), 'repairedFields 应含 cwd')
  const doc = JSON.parse(fs.readFileSync(CANDIDATE_FILE, 'utf8'))
  equal(doc.record.identity.cwd, CWD)
  equal(doc.record.rows.title.val, '工作区优化/再次整理标题')
})

const mismatch = JSON.parse(fs.readFileSync(CANDIDATE_FILE, 'utf8'))
mismatch.record.identity.createdAt = '2020-01-01T00:00:00.000Z'
fs.writeFileSync(CANDIDATE_FILE, JSON.stringify(mismatch))
const titleBeforeRepair = JSON.parse(fs.readFileSync(CANDIDATE_FILE, 'utf8')).record.rows.title.val

const preview = titles.repairIdentities({ dryRun: true })
await check('repair 预演只报错位，不改文件', () => {
  equal(preview.matched, 1)
  equal(preview.entries[0].fields.includes('createdAt'), true)
  const doc = JSON.parse(fs.readFileSync(CANDIDATE_FILE, 'utf8'))
  equal(doc.record.identity.createdAt, '2020-01-01T00:00:00.000Z')
})
const fixed = titles.repairIdentities({ dryRun: false })
await check('repair 只修 identity，不碰标题', () => {
  equal(fixed.repaired, 1)
  const doc = JSON.parse(fs.readFileSync(CANDIDATE_FILE, 'utf8'))
  equal(doc.record.identity.createdAt, '2026-11-20T00:00:00.000Z')
  equal(doc.record.rows.title.val, titleBeforeRepair)
  equal(titles.repairIdentities({ dryRun: true }).matched, 0)
})

console.log('\n[5] 侧栏即时改名')
const sessionLive = await import('../lib/session-live.js')
const renameCalls = []
const fakeSession = { id: CANDIDATE }
const fakeCtx = {
  get(name) {
    if (name === 'sessions') return { get: (id) => (id === CANDIDATE ? fakeSession : undefined) }
    if (name === 'sessionTitle') return { rename: (session, title) => renameCalls.push([session.id, title]) }
    return undefined
  },
}

await check('setOne 对冷会话返回 not-loaded，不 resume', () => {
  equal(sessionLive.setOne(fakeCtx, 'session-not-open', '工作区优化/不该写'), { status: 'not-loaded' })
  equal(renameCalls.length, 0)
})
await check('setMany 用短号解析到活会话并改名', () => {
  const result = sessionLive.setMany(fakeCtx, [{ id: 'aaaa1111', title: '工作区优化/即时改名' }])
  equal(result.total, 1)
  equal(result.applied, 1)
  equal(result.notLoaded, 0)
  equal(renameCalls.length, 1)
  equal(renameCalls[0][0], CANDIDATE)
  equal(renameCalls[0][1], '工作区优化/即时改名')
  equal(result.results[0].status, 'applied')
})
await check('setMany 的未知短号记失败而不是抛错', () => {
  const result = sessionLive.setMany(fakeCtx, [{ id: 'zzzz9999', title: '工作区优化/找不到' }])
  equal(result.failed, 1)
  equal(result.results[0].status, 'error')
})

console.log('\n[6] 分批调模型')
const llmTitles = await import('../lib/llm-titles.js')
function fakeTitleCtx(handler) {
  const calls = []
  const serviceCtx = {
    calls,
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }
      }
      if (name === 'llm') {
        return {
          prepareCall: async (config) => ({
            config,
            stream: async function* (options) {
              calls.push(options)
              const text = handler(options, calls.length)
              yield { type: 'text-delta', text }
              yield { type: 'finish', reason: 'stop' }
            },
          }),
        }
      }
      return undefined
    },
  }
  return serviceCtx
}

await check('batchSize 控制每批条数，逐批解析并汇总', async () => {
  const ctx = fakeTitleCtx((options) => {
    const short = String(options.messages[0].content[0].text).match(/session-([0-9a-f]{8})/u)?.[1]
    return JSON.stringify([{ id: short, title: `工作区优化/批量${short}` }])
  })
  const result = await llmTitles.refreshTitles(ctx, {
    onlyIds: ['aaaa1111', 'dddd4444'],
    forceIds: ['aaaa1111', 'dddd4444'],
    batchSize: 1,
    dryRun: true,
  })
  equal(result.status, 'dry-run')
  equal(result.batchCount, 2)
  equal(result.batchErrors.length, 0)
  equal(result.applied.length, 2)
  equal(ctx.calls.length, 2)
})

await check('单批失败不拖垮其余批次', async () => {
  let call = 0
  const ctx = fakeTitleCtx((options) => {
    call += 1
    if (call === 2) throw new Error('模拟模型超时')
    const short = String(options.messages[0].content[0].text).match(/session-([0-9a-f]{8})/u)?.[1]
    return JSON.stringify([{ id: short, title: `工作区优化/部分${short}` }])
  })
  const result = await llmTitles.refreshTitles(ctx, {
    onlyIds: ['aaaa1111', 'dddd4444'],
    forceIds: ['aaaa1111', 'dddd4444'],
    batchSize: 1,
    dryRun: true,
  })
  equal(result.status, 'dry-run')
  equal(result.applied.length, 1)
  equal(result.batchErrors.length, 1)
  equal(result.batchErrors[0].batch, 2)
})

if (failed.length > 0) {
  console.error(`\n${passed} passed, ${failed.length} failed`)
  process.exit(1)
}
console.log(`\n${passed} passed`)
