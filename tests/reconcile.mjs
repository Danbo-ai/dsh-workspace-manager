/**
 * 目录被删之后的收尾规则测试（planReconcile 是纯函数，不需要宿主）。
 *
 * 规则：死工作区的会话交给最近的、目录还在的祖先工作区；
 * 若那个祖先本身是一级工作区（上面再没有工作区），则退回未分组。
 */
import './env.mjs'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planReconcile, nearestAncestor, describeReconcile } from '../lib/reconcile.js'

const checks = []
const check = (label, run) => {
  try {
    run()
    checks.push({ label, ok: true })
  } catch (error) {
    checks.push({ label, ok: false, error: error?.message ?? String(error) })
  }
}

// 造一棵真实目录：root/alpha/beta（beta 待删）
const base = mkdtempSync(join(tmpdir(), 'wsm-reconcile-'))
const root = join(base, 'proj')
const alpha = join(root, 'alpha')
const beta = join(alpha, 'beta')
mkdirSync(beta, { recursive: true })
writeFileSync(join(base, '.keep'), '')

const rows = [
  { id: 'ws-root', path: root, title: 'proj', sessionIds: [] },
  { id: 'ws-alpha', path: alpha, title: 'alpha', sessionIds: [] },
  { id: 'ws-beta', path: beta, title: 'beta', sessionIds: ['session-1', 'session-2'] },
]

check('目录都在时不产生任何计划', () => {
  assert.equal(planReconcile(rows).length, 0)
})

check('nearestAncestor 选最近的祖先', () => {
  const found = nearestAncestor(beta, rows)
  assert.equal(found?.id, 'ws-alpha')
})

// 删掉 beta，模拟用户直接删目录
import { rmSync } from 'node:fs'
rmSync(beta, { recursive: true, force: true })

check('死工作区的会话交给父工作区', () => {
  const plans = planReconcile(rows)
  assert.equal(plans.length, 1)
  assert.equal(plans[0].mode, 'adopt')
  assert.equal(plans[0].to, alpha)
  assert.equal(plans[0].toWorkspaceId, 'ws-alpha')
  assert.deepEqual(plans[0].sessions, ['session-1', 'session-2'])
})

check('父工作区是一级目录时退回未分组', () => {
  const plans = planReconcile([
    { id: 'ws-root', path: root, title: 'proj', sessionIds: [] },
    { id: 'ws-gone', path: join(root, 'gone'), title: 'gone', sessionIds: ['session-3'] },
  ])
  assert.equal(plans[0].mode, 'ungroup')
  assert.equal(plans[0].to, undefined)
})

check('没有父工作区时退回未分组', () => {
  const plans = planReconcile([
    { id: 'ws-x', path: join(base, 'nowhere', 'deep'), title: 'deep', sessionIds: ['session-4'] },
  ])
  assert.equal(plans[0].mode, 'ungroup')
})

check('三层的中间层被删，归到最近活着的祖先', () => {
  const three = [
    { id: 'ws-root', path: root, title: 'proj', sessionIds: [] },
    { id: 'ws-alpha', path: alpha, title: 'alpha', sessionIds: [] },
    { id: 'ws-mid', path: join(alpha, 'mid'), title: 'mid', sessionIds: ['session-5'] },
  ]
  const plans = planReconcile(three)
  assert.equal(plans.length, 1)
  assert.equal(plans[0].toWorkspaceId, 'ws-alpha')
})

check('摘要能读：说清有几条对话去哪了', () => {
  const text = describeReconcile({ dryRun: false, plans: planReconcile(rows), moved: [], ungrouped: [], removed: [], failures: [] })
  assert.match(text, /已处理 1 个已删除的工作区/)
  assert.match(text, /2 条对话/)
})

let failed = 0
for (const item of checks) {
  if (item.ok) {
    console.log(`  ✓ ${item.label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${item.label}\n    ${item.error}`)
  }
}
console.log(`\n结果：${checks.length - failed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
