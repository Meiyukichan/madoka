/**
 * 看板筛选与排序（纯函数）。
 *
 * @module dsh-magica-castboard/client/data/derive/filters
 */
import { PLANNING_ISSUE_STATUSES, type IssueSummary } from '../../../shared/wire.ts'
import type { TaskSummaryView } from '../dto.ts'
import type { BoardState } from '../state/types.ts'
import { URGENCY_WEIGHT } from './format.ts'

/** 当前视图里可见的任务（搜索 + 项目 + 紧急度 + 排序）。 */
export function visibleTasks(state: BoardState, tasks: readonly TaskSummaryView[]): TaskSummaryView[] {
  const query = state.search.trim().toLowerCase()
  const list = tasks.filter(task =>
    (state.filters.workspaceId === undefined || task.workspaceId === state.filters.workspaceId)
    && (state.filters.urgencies.length === 0 || state.filters.urgencies.includes(task.urgency))
    && (query === '' || task.title.toLowerCase().includes(query) || task.id.toLowerCase().includes(query)))
  if (state.sortBy === 'default') return list
  const copy = [...list]
  if (state.sortBy === 'updated') copy.sort((a, b) => b.updatedAt - a.updatedAt)
  else if (state.sortBy === 'created') copy.sort((a, b) => b.createdAt - a.createdAt)
  else if (state.sortBy === 'urgency') copy.sort((a, b) => URGENCY_WEIGHT[a.urgency] - URGENCY_WEIGHT[b.urgency] || b.updatedAt - a.updatedAt)
  else copy.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
  return copy
}

const ISSUE_RANK: Record<string, number> = { routing: 0, accepted: 1, pending: 2 }

/** 待规划列：固定按「状态 → 紧急度 → 创建时间」排序（不受顶部排序器影响）。
 *
 * 只画还没转卡的 issue（pending / accepted / routing）；一旦已有挂它的 task，
 * 说明 router 已经转换完成，就从待规划列消失，只留在任务列里。
 */
export function visibleIssues(state: BoardState, issues: readonly IssueSummary[]): IssueSummary[] {
  const query = state.search.trim().toLowerCase()
  const converted = new Set(state.tasks.filter(task => task.issueId !== undefined).map(task => task.issueId))
  return issues
    .filter(issue =>
      PLANNING_ISSUE_STATUSES.includes(issue.status)
      && !converted.has(issue.issueId)
      && (state.filters.workspaceId === undefined || issue.workspaceId === state.filters.workspaceId)
      && (state.filters.urgencies.length === 0 || state.filters.urgencies.includes(issue.urgency))
      && (query === '' || issue.title.toLowerCase().includes(query) || issue.issueId.toLowerCase().includes(query)))
    .sort((a, b) =>
      (ISSUE_RANK[a.status] ?? 9) - (ISSUE_RANK[b.status] ?? 9)
      || URGENCY_WEIGHT[a.urgency] - URGENCY_WEIGHT[b.urgency]
      || a.createdAt - b.createdAt)
}
