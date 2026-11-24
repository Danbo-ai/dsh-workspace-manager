/**
 * 工作区目录被删掉之后的收尾：把无家可归的会话交给「父目录」，父目录本身就是一级目录时交给「未分组」。
 *
 * 规则（2026-11-19 16:33 用户要求）：
 * 1. 某个工作区对应的目录已经不在磁盘上 → 它名下的会话要有个去处；
 * 2. 去处是「最近的、目录还在的祖先工作区」；
 * 3. 如果那个祖先自己就是一级工作区（它上面再没有工作区），这批会话就退回「未分组」，
 *    不要一股脑塞进顶层目录；
 * 4. 找不到任何祖先（比如整个盘符都没了）同样退回「未分组」。
 *
 * 只动登记与会话的 cwd，不删任何用户文件；被删掉的目录本来就不存在，登记留着只会变成一行死行。
 */
import { statSync } from 'node:fs'

import { mark } from './mark.js'
import { service } from './service.js'
import { moveSession, readWorkspaceTable } from './move-session.js'

/** 目录是否真的存在且是目录。 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 统一成可比较的形状：反斜杠、去尾分隔符、小写。 */
function canonical(path) {
  return String(path ?? '').replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase()
}

/** child 是否在 parent 之内（不含相等）。 */
function isInside(parent, child) {
  const left = canonical(parent)
  const right = canonical(child)
  return left !== '' && right !== '' && right !== left && right.startsWith(`${left}\\`)
}

/**
 * 找最近的祖先工作区。
 * @param path - 目标路径。
 * @param rows - `{ id, path }[]` 候选工作区。
 * @returns 最近的祖先（没有则 undefined）。
 */
export function nearestAncestor(path, rows) {
  let best
  for (const row of rows) {
    if (!isInside(row.path, path)) continue
    if (best === undefined || canonical(row.path).length > canonical(best.path).length) best = row
  }
  return best
}

/**
 * 规划（不改任何东西）。
 * @param rows - `{ id, path, title, sessionIds }[]`，来自注册表 + workspace.json 的原始 sessionIds。
 * @returns 每个死工作区一条计划。
 */
export function planReconcile(rows) {
  const alive = rows.filter((row) => isDirectory(row.path))
  const plans = []
  for (const row of rows) {
    if (isDirectory(row.path)) continue
    const parent = nearestAncestor(row.path, alive)
    // 父目录本身就是一级目录（它上面没有工作区）→ 未分组。
    const parentIsTop = parent !== undefined && nearestAncestor(parent.path, rows) === undefined
    const adopt = parent !== undefined && !parentIsTop
    plans.push({
      workspaceId: row.id,
      path: row.path,
      title: row.title,
      sessions: Array.isArray(row.sessionIds) ? [...row.sessionIds] : [],
      mode: adopt ? 'adopt' : 'ungroup',
      to: adopt ? parent.path : undefined,
      toWorkspaceId: adopt ? parent.id : undefined,
      reason: adopt
        ? `目录已不在，会话归到父工作区「${parent.title || parent.path}」`
        : parent === undefined
          ? '目录已不在，且没有可用的父工作区，会话归为未分组'
          : `目录已不在，父工作区「${parent.title || parent.path}」是一级目录，会话归为未分组`,
    })
  }
  return plans
}

/**
 * 执行收尾。
 * @param ctx - 插件上下文。
 * @param options - `{ dryRun }`。
 * @returns `{ dryRun, plans, moved, ungrouped, removed, failures }`。
 */
export async function reconcileWorkspaces(ctx, options = {}) {
  const dryRun = options.dryRun === true
  const registry = service(ctx, 'workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') {
    throw new Error('宿主没有就绪：拿不到 workspaceRegistry')
  }
  const doc = readWorkspaceTable()
  const live = registry.list()
  const rows = live.map((entity) => {
    const record = (doc.tables?.workspaces ?? {})[entity.id] ?? {}
    return {
      id: entity.id,
      path: entity.path,
      title: entity.title,
      // 注册表里的 sessionIds 会按目录存在性过滤，目录没了就空了；这里用落盘的原始列表。
      sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds : [],
    }
  })

  const plans = planReconcile(rows)
  const result = { dryRun, plans, moved: [], ungrouped: [], removed: [], failures: [] }
  if (dryRun) return result

  for (const plan of plans) {
    const entity = registry.get(plan.workspaceId)
    for (const sessionId of plan.sessions) {
      try {
        if (plan.mode === 'adopt') {
          const outcome = await moveSession(ctx, { sessionId, target: plan.toWorkspaceId })
          result.moved.push({ sessionId, to: plan.to, changed: outcome?.changed !== false })
        } else if (entity !== undefined && typeof entity.detachSession === 'function') {
          await entity.detachSession(sessionId)
          result.ungrouped.push({ sessionId })
        } else {
          result.failures.push({ sessionId, error: '注册表里找不到这条工作区实体' })
        }
      } catch (error) {
        result.failures.push({ sessionId, error: String(error?.message ?? error) })
      }
    }
    // 先摘登记再删行：目录都不在了，这行留着只会在侧栏变成一条打不开的死行。
    try {
      if (entity !== undefined && typeof registry.delete === 'function') {
        await registry.delete(plan.workspaceId)
        result.removed.push({ workspaceId: plan.workspaceId, path: plan.path })
      }
    } catch (error) {
      result.failures.push({ workspaceId: plan.workspaceId, error: String(error?.message ?? error) })
    }
  }

  const line = `reconcile dryRun=${dryRun} plans=${plans.length} moved=${result.moved.length} ungrouped=${result.ungrouped.length} removed=${result.removed.length} failures=${result.failures.length}`
  mark(line)
  return result
}

/** 一行摘要，给命令与工具回执用。 */
export function describeReconcile(result) {
  if (result.plans.length === 0) return '工作区目录都在，没有需要收尾的对话。'
  const head = result.dryRun ? '将处理' : '已处理'
  const parts = result.plans.map((plan) => {
    const count = plan.sessions.length
    return `· 「${plan.title || plan.path}」${count} 条对话 → ${plan.mode === 'adopt' ? `「${plan.to}」` : '未分组'}`
  })
  const tail = result.failures.length === 0 ? '' : `\n有 ${result.failures.length} 项没做成，详见 state/load.log。`
  return `${head} ${result.plans.length} 个已删除的工作区：\n${parts.join('\n')}${tail}`
}
