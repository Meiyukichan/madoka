/**
 * 枚举 → 文案键、时间格式化与小标签。
 *
 * @module dsh-magica-castboard/client/data/derive/format
 */
import type { TaskStatus, Urgency } from '../../../shared/wire.ts'
import type { BoardState } from '../state/types.ts'

/** 列标题。 */
export const COLUMN_LABEL: Record<TaskStatus, string> = {
  todo: 'status.column.todo',
  in_progress: 'status.column.in_progress',
  in_review: 'status.column.in_review',
  done: 'status.column.done',
  canceled: 'status.column.canceled',
  archived: 'status.column.archived',
  abandoned: 'status.column.abandoned',
}

/** 详情头部状态胶囊。 */
export const PILL_LABEL: Record<TaskStatus, string> = {
  todo: 'status.pill.todo',
  in_progress: 'status.pill.in_progress',
  in_review: 'status.pill.in_review',
  done: 'status.pill.done',
  canceled: 'status.pill.canceled',
  archived: 'status.pill.archived',
  abandoned: 'status.pill.abandoned',
}

/** 移动按钮动词。 */
export const MOVE_LABEL: Record<TaskStatus, string> = {
  todo: 'status.move.todo',
  in_progress: 'status.move.in_progress',
  in_review: 'status.move.in_review',
  done: 'status.move.done',
  canceled: 'status.move.canceled',
  archived: 'status.move.archived',
  abandoned: 'status.move.abandoned',
}

/** 紧急度。 */
export const URGENCY_LABEL: Record<Urgency, string> = {
  runtime: 'urgency.runtime',
  direct: 'urgency.direct',
  urgent: 'urgency.urgent',
  normal: 'urgency.normal',
  relaxed: 'urgency.relaxed',
}

/** 执行结局。 */
export const OUTCOME_LABEL: Record<string, string> = {
  running: 'outcome.running',
  succeeded: 'outcome.succeeded',
  failed: 'outcome.failed',
  cancelled: 'outcome.cancelled',
}

/** 执行触发方式。 */
export const TRIGGER_LABEL: Record<string, string> = {
  user: 'trigger.user',
  manual: 'trigger.user',
  dispatch: 'trigger.dispatch',
  scheduled: 'trigger.scheduled',
  comment: 'trigger.comment',
  followup: 'trigger.comment',
  'issue-comment': 'trigger.comment',
  'issue-dispatch': 'trigger.dispatch',
  acceptance: 'trigger.acceptance',
}

/** 主列（看板主体）。 */
export const MAIN_LANES: readonly TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done']

/** 次页签分组。 */
export const SECONDARY_LANES: readonly TaskStatus[] = ['canceled', 'archived']

/** 紧急度权重（越小越急）。 */
export const URGENCY_WEIGHT: Record<Urgency, number> = { runtime: 0, direct: 1, urgent: 2, normal: 3, relaxed: 4 }

/** 本地时间 `MM-DD HH:mm`。 */
export function stampTime(ms: number | undefined): string {
  if (ms === undefined) return ''
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 执行时长（`1m20s` / `2h5m`）。 */
export function durationText(startedAt?: number, endedAt?: number): string {
  if (startedAt === undefined || endedAt === undefined) return ''
  const seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m${String(seconds % 60)}s`
  return `${String(Math.floor(seconds / 3600))}h${String(Math.floor((seconds % 3600) / 60))}m`
}

/** 会话 id 的紧凑显示（去掉公共前缀，留 8 位）。 */
export function shortSession(id: string | undefined): string {
  if (id === undefined) return ''
  // 新会话是标准 dsh UUID；旧会话是 `session-<uuid>` / `magica-...`。只留前 8 位做 chip。
  return id.replace(/^(session-)?(castboard-)?(magica-(ws-)?)?/, '').slice(0, 8)
}

/** 判断一个值是不是 dsh 会话 id（UUID / `session-` / 旧 `magica-`）。 */
export function isSessionId(value: string | undefined): boolean {
  if (value === undefined || value === '') return false
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true
  return value.startsWith('session-') || value.startsWith('magica-')
}

/**
 * 一张卡关联的执行会话（去重，按出现顺序）。
 *
 * 归档卡时「连同会话归档」用的就是这份列表：执行史里每个带会话的轮次，加上
 * 当前持有者（`claimedBy` 只在它是会话 id 时算）。执行史为空的卡返回空数组。
 */
export function taskSessionIds(task: {
  executions?: readonly { sessionId?: string }[]
  claimedBy?: string
}): string[] {
  const out: string[] = []
  const push = (id: string | undefined): void => {
    if (!isSessionId(id) || out.includes(id as string)) return
    out.push(id as string)
  }
  for (const execution of task.executions ?? []) push(execution.sessionId)
  push(task.claimedBy)
  return out
}

/** 等多久（交互总览用）。 */
export function waitedText(t: (key: string, params?: Record<string, string | number>) => string, since: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000))
  if (seconds < 60) return t('time.seconds', { n: String(seconds) })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('time.minutes', { n: String(minutes) })
  return t('time.hours', { n: String(Math.round(minutes / 60)) })
}

/** 清单完成度。 */
export function checklistDone(task: { checklist?: readonly { done: boolean }[] }): number {
  return (task.checklist ?? []).filter(item => item.done).length
}

/** 侧栏入口读数（与 0.1.2 的四格同口径，trashed 不计）。 */
export interface EntryStats {
  issue: number
  todo: number
  doing: number
  review: number
  pending: number
}

/** 从面板快照算入口读数。 */
export function entryStats(state: BoardState): EntryStats {
  const live = state.tasks.filter(task => task.trashedAt === undefined)
  return {
    issue: state.issues.length,
    todo: live.filter(task => task.status === 'todo').length,
    doing: live.filter(task => task.status === 'in_progress').length,
    review: live.filter(task => task.status === 'in_review').length,
    pending: state.interactions.length,
  }
}

/** 一行模板的本地化名字。 */
export function templateName(template: { name: { zh: string; en: string } }, lang: 'zh' | 'en'): string {
  return template.name[lang] ?? template.name.zh
}
