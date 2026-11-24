/**
 * 搬家自检：离线造一份 ~/.dsh 沙盒，验证「改 header → 挪目录 → 改投影 → 改登记」四步。
 *
 * 不碰真实 ~/.dsh：全部落在临时目录，通过 WSM_HOME_DIR 重定向。
 * 运行：node tests/move.mjs
 */
import './env.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wsm-move-'))
process.env.WSM_HOME_DIR = HOME
process.env.WSM_STATE_DIR = path.join(HOME, 'state')

const {
  dshPaths,
  encodeCwd,
  frameOffsets,
  moveSession,
  patchProjection,
  readLogHeader,
  rewriteLogCwd,
  samePath,
} = await import('../lib/move-session.js')

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

const { sessions, projcache, workspaceFile, backups } = dshPaths()
const SOURCE = 'D:/wsm-src'
const TARGET = 'D:/wsm-dst'
const SESSION = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const HEADER = {
  type: 'session',
  id: SESSION,
  createdAt: '2026-11-19T00:00:00.000Z',
  cwd: SOURCE,
  isSeeded: false,
  version: 7,
}
const SECOND_LINE = '{"type":"user/message","data":{"text":"第二帧原样保留"}}'

/** 造一条两帧的会话日志：第一帧 header，第二帧随便一条事件。 */
function writeLog(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const first = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(HEADER)}\n`, 'utf8'))
  const second = zlib.zstdCompressSync(Buffer.from(`${SECOND_LINE}\n`, 'utf8'))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(file, Buffer.concat([first, second]))
  return file
}

/** 造投影缓存：identity 与 header 逐字段一致，rows 里有 workingDirectory 与 title。 */
function writeProjection() {
  fs.mkdirSync(projcache, { recursive: true })
  const doc = {
    version: 7,
    record: {
      identity: {
        formatVersion: HEADER.version,
        createdAt: HEADER.createdAt,
        cwd: SOURCE,
        isSeeded: HEADER.isSeeded,
      },
      rows: {
        workingDirectory: { ver: 3, seq: 3, val: SOURCE },
        title: { ver: 1, seq: 1, val: { title: '工作区优化/搬家会话' } },
        turnBoundary: { ver: 1, seq: 1, val: 12 },
      },
    },
  }
  fs.writeFileSync(path.join(projcache, `${SESSION}.json`), JSON.stringify(doc))
}

/** 造登记表：A 里有这条会话，B 是目标。 */
function writeTable() {
  fs.mkdirSync(path.dirname(workspaceFile), { recursive: true })
  const doc = {
    version: 2,
    global: { initialized: true, defaultWorkspaceId: 'ws-a', workspaceIds: ['ws-a', 'ws-b'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-a': { path: SOURCE, title: '源', sessionIds: [SESSION], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
        'ws-b': { path: TARGET, title: '目标', sessionIds: [], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' },
      },
    },
  }
  fs.writeFileSync(workspaceFile, JSON.stringify(doc, null, 2))
}

/** 桩上下文：注册表只给 list，get 拿不到 → 走「改文件 + 提示重启」那条兜底路径。 */
function stubCtx(workspaces) {
  return {
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          list: () => workspaces.map((workspace) => ({ ...workspace })),
          get: () => undefined,
        }
      }
      return undefined
    },
  }
}

fs.mkdirSync(path.join(TARGET), { recursive: true })
const logFile = writeLog(path.join(sessions, encodeCwd(SOURCE), SESSION))
writeProjection()
writeTable()

console.log('\n[1] 路径与帧解析')
await check('encodeCwd 把分隔符与中文编码成宿主桶名', () => {
  equal(encodeCwd('D:\\dsh\\projects\\打杂'), '--D-dsh-projects-~6253~6742--')
  equal(encodeCwd('D:/a b'), '--D-a~0020b--')
})
await check('frameOffsets 认出两帧', () => {
  equal(frameOffsets(fs.readFileSync(logFile)).length, 2)
})
await check('readLogHeader 读出 cwd 与帧数', () => {
  const { header, frameCount } = readLogHeader(logFile)
  equal(header.cwd, SOURCE)
  equal(header.id, SESSION)
  equal(frameCount, 2)
})

console.log('\n[2] 只改第一帧，其余字节不动')
await check('rewriteLogCwd 改 cwd 且第二帧原样', () => {
  const before = fs.readFileSync(logFile)
  const secondFrameBefore = before.subarray(frameOffsets(before)[1])
  const step = rewriteLogCwd(logFile, TARGET)
  equal(step.changed, true)
  const after = fs.readFileSync(logFile)
  const secondFrameAfter = after.subarray(frameOffsets(after)[1])
  ok(secondFrameBefore.equals(secondFrameAfter), '第二帧字节应完全一致')
  equal(readLogHeader(logFile).header.cwd, TARGET)
})

console.log('\n[3] 投影缓存：workingDirectory 与 identity.cwd 一起改')
await check('patchProjection 同步两处', () => {
  const step = patchProjection(SESSION, TARGET, HEADER)
  equal(step.updated, true)
  equal(step.identitySynced, true)
  const doc = JSON.parse(fs.readFileSync(path.join(projcache, `${SESSION}.json`), 'utf8'))
  equal(doc.record.rows.workingDirectory.val, TARGET)
  equal(doc.record.identity.cwd, TARGET, 'identity.cwd 必须与 header 对齐')
  equal(doc.record.rows.title.val.title, '工作区优化/搬家会话', '标题不能被顺手清掉')
})

console.log('\n[4] 整体搬家（走文件兜底）')
await check('moveSession 改目录、改登记、留备份', async () => {
  // 复位成「未搬」的状态
  writeLog(path.join(sessions, encodeCwd(SOURCE), SESSION))
  writeProjection()
  writeTable()
  fs.rmSync(path.join(sessions, encodeCwd(TARGET)), { recursive: true, force: true })

  const ctx = stubCtx([{ id: 'ws-a', path: SOURCE, title: '源' }, { id: 'ws-b', path: TARGET, title: '目标' }])
  const result = await moveSession(ctx, { sessionId: SESSION, target: TARGET })
  equal(result.ok, true)
  equal(result.changed, undefined)
  equal(result.restartRequired, true)

  const movedLog = path.join(sessions, encodeCwd(TARGET), SESSION, 'session.v4.jsonl.zstd')
  ok(fs.existsSync(movedLog), '日志应落在新桶里')
  equal(readLogHeader(movedLog).header.cwd, TARGET)
  ok(!fs.existsSync(path.join(sessions, encodeCwd(SOURCE), SESSION)), '旧桶里不应再留会话目录')

  const doc = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'))
  equal(doc.tables.workspaces['ws-a'].sessionIds.includes(SESSION), false, '源工作区应移除')
  equal(doc.tables.workspaces['ws-b'].sessionIds.includes(SESSION), true, '目标工作区应加入')
  equal(doc.global.workspaceIds.length, 2, '顺序表不能被改坏')

  ok(fs.existsSync(path.join(result.backup, 'session.v4.jsonl.zstd')), '应备份会话目录')
  ok(fs.existsSync(path.join(result.backup, 'workspace.json')), '应备份登记表')
})

await check('dryRun 只看计划不落盘', async () => {
  // 上一轮把日志挪到目标桶了；这里先把目标桶清掉，避免同一会话在两个桶里各留一份。
  fs.rmSync(path.join(sessions, encodeCwd(TARGET)), { recursive: true, force: true })
  writeLog(path.join(sessions, encodeCwd(SOURCE), SESSION))
  writeTable()
  const ctx = stubCtx([{ id: 'ws-a', path: SOURCE, title: '源' }, { id: 'ws-b', path: TARGET, title: '目标' }])
  const result = await moveSession(ctx, { sessionId: SESSION, target: TARGET, dryRun: true })
  equal(result.dryRun, true)
  equal(result.from, SOURCE)
  equal(result.to, TARGET)
  equal(readLogHeader(path.join(sessions, encodeCwd(SOURCE), SESSION, 'session.v4.jsonl.zstd')).header.cwd, SOURCE)
})

await check('已在目标里时直接返回不用搬', async () => {
  const ctx = stubCtx([{ id: 'ws-a', path: SOURCE, title: '源' }, { id: 'ws-b', path: TARGET, title: '目标' }])
  await moveSession(ctx, { sessionId: SESSION, target: TARGET })
  const result = await moveSession(ctx, { sessionId: SESSION, target: TARGET })
  equal(result.changed, false)
  equal(result.reason, '会话已经在这个工作区里')
})

await check('目标工作区不存在时给出可读错误', async () => {
  const ctx = stubCtx([{ id: 'ws-a', path: SOURCE, title: '源' }])
  await assert.rejects(() => moveSession(ctx, { sessionId: SESSION, target: 'D:/nope' }), /找不到目标工作区/u)
})

await check('samePath 容忍分隔符与大小写差异', () => {
  equal(samePath('D:\\dsh-project\\A\\', 'd:/dsh-project/a'), true)
  equal(samePath('', 'D:/a'), false)
})

console.log(`\n结果：${passed} 通过，${failed.length} 失败`)
fs.rmSync(HOME, { recursive: true, force: true })
if (failed.length > 0) {
  for (const item of failed) console.error(`\n${item.title}\n${item.error?.stack ?? item.error}`)
  process.exit(1)
}
