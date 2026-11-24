#!/usr/bin/env node
/**
 * 工作区索引自检 / 修复。
 *
 * 宿主启动时会校验 ~/.dsh/storages/workspace.json 的「展示顺序表(global.workspaceIds)」
 * 与「工作区行(tables.workspaces)」是否双向一致；对不上就整块起不来（侧栏空、
 * 建不了工作区）。这个脚本在改动该文件前后各跑一次。
 *
 * 用法：
 *   node tools/check-workspace-index.mjs            # 只检查
 *   node tools/check-workspace-index.mjs --repair   # 备份后修复
 *   node tools/check-workspace-index.mjs --file <path> --dsh-home <dir>
 *
 * 修复范围只包含「顺序表与表行不对齐」与「默认工作区指向不存在的行」，
 * 不动任何 path/title/sessionIds。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}

const dshHome = resolve(argOf('--dsh-home', process.env.DSH_HOME ?? join(homedir(), '.dsh')))
const file = resolve(argOf('--file', join(dshHome, 'storages', 'workspace.json')))
const repair = process.argv.includes('--repair')

const stamp = () => new Date().toISOString().replace(/[:.]/gu, '-')

const fail = (message) => {
  console.error(`✗ ${message}`)
  process.exit(1)
}

if (!existsSync(file)) fail(`找不到工作区注册表：${file}`)

let state
try {
  state = JSON.parse(readFileSync(file, 'utf8'))
} catch (error) {
  fail(`解析失败（文件可能被写坏）：${error?.message ?? error}`)
}

const unit = state?.unit
if (unit?.name !== 'workspace') fail(`unit.name 应为 'workspace'，实际是 ${JSON.stringify(unit?.name)}`)

const global = state.global ?? {}
const table = state.tables?.workspaces ?? {}
const order = Array.isArray(global.workspaceIds) ? global.workspaceIds : null
if (order === null) fail('global.workspaceIds 不是数组')

const rowIds = Object.keys(table)
const problems = []

const seen = new Set()
for (const id of order) {
  if (seen.has(id)) problems.push({ kind: 'duplicate-order', id, detail: '顺序表里重复出现' })
  seen.add(id)
  if (table[id] === undefined) problems.push({ kind: 'order-without-row', id, detail: '顺序表里有，表里没有（会让启动校验抛错）' })
}
for (const id of rowIds) {
  if (!seen.has(id)) problems.push({ kind: 'row-without-order', id, detail: '表里有，顺序表里没有（会让启动校验抛错）' })
}

const pending = global.pendingMutation
if (pending !== undefined && pending !== null) {
  problems.push({ kind: 'pending-mutation', id: pending.workspaceId, detail: `上次的 ${pending.operation} 没写完，宿主启动会尝试回滚` })
}

const defaultId = global.defaultWorkspaceId
if (defaultId !== undefined && defaultId !== null && table[defaultId] === undefined) {
  problems.push({ kind: 'default-missing', id: defaultId, detail: '默认工作区指向不存在的行' })
}

const summary = () => `版本 ${unit?.version ?? '?'}；顺序表 ${order.length} 条；表 ${rowIds.length} 行；默认 ${defaultId ?? '（空）'}`

if (problems.length === 0) {
  console.log(`✓ 工作区索引一致。${summary()}`)
  process.exit(0)
}

console.error(`✗ 工作区索引不一致（${problems.length} 处）。${summary()}`)
for (const item of problems) console.error(`  - [${item.kind}] ${item.id}: ${item.detail}`)

if (!repair) {
  console.error('\n未做修改。加 --repair 可备份后自动修（只修顺序表/默认值，不动 path、title、sessionIds）。')
  process.exit(1)
}

// —— 备份 ——
const backupDir = join(dirname(file), 'workspace-index-backups')
mkdirSync(backupDir, { recursive: true })
const backup = join(backupDir, `workspace.json.${stamp()}.bak`)
writeFileSync(backup, readFileSync(file))

// —— 修复 ——
const kept = []
const keptSeen = new Set()
for (const id of order) {
  if (table[id] === undefined) continue
  if (keptSeen.has(id)) continue
  keptSeen.add(id)
  kept.push(id)
}
const orphans = rowIds.filter((id) => !keptSeen.has(id))
// 孤儿行按 createdAt 追加到末尾，尽量少改变顺序观感。
orphans.sort((a, b) => String(table[a]?.createdAt ?? '').localeCompare(String(table[b]?.createdAt ?? '')))
const nextOrder = [...kept, ...orphans]

const nextGlobal = { ...global, workspaceIds: nextOrder }
if (pending !== undefined && pending !== null) {
  if (nextOrder.includes(pending.workspaceId)) delete table[pending.workspaceId]
  delete nextGlobal.pendingMutation
}
if (nextGlobal.defaultWorkspaceId === undefined || table[nextGlobal.defaultWorkspaceId] === undefined) {
  const fallback = nextOrder[0] ?? null
  if (fallback === null) nextGlobal.defaultWorkspaceId = null
  else nextGlobal.defaultWorkspaceId = fallback
}

const nextState = { ...state, global: nextGlobal }
const temp = `${file}.tmp-${process.pid}`
writeFileSync(temp, JSON.stringify(nextState, null, 2))
renameSync(temp, file)

console.log(`✓ 已修复并写回：${file}`)
console.log(`  备份：${backup}`)
console.log(`  顺序表 ${order.length} → ${nextOrder.length} 条；补齐孤儿 ${orphans.length} 行；默认工作区 ${defaultId ?? '（空）'} → ${nextGlobal.defaultWorkspaceId ?? '（空）'}`)
