/**
 * 看板的纯函数分组与筛选（组件只调用这些，不在 JSX 里写逻辑）�? *
 * @module dsh-magica-teamwork/client/model/columns
 */
import { COLUMN_LABELS, pick } from './labels.js'
import type { Lang } from './labels.js'

/** 主列（顺序即界面顺序）�?*/
export const MAIN_COLUMNS = ['todo', 'in_progress', 'in_review', 'done'] as const
/** 次要列（默认折叠）�?*/
export const SECONDARY_COLUMNS = ['canceled', 'archived', 'abandoned'] as const

/** 卡片最小形状（与看板协议的 TaskSummary 兼容）�?*/
export interface BoardCard {
  id: string
  title: string
  status: string
  urgency: string
  issueId?: string
  createdAt: number
  updatedAt: number
  trashedAt?: number
  hasRunning?: boolean
  lastExecutionOutcome?: string
  checklist?: readonly { done: boolean }[]
}

/** 一列�?*/
export interface Column<T extends BoardCard> {
  status: string
  label: string
  items: readonly T[]
}

/** 按状态分组（主列在前，次要列在后；未知状态归次要列的"其他"）�?*/
export function groupIntoColumns<T extends BoardCard>(cards: readonly T[], lang: Lang = 'zh'): readonly Column<T>[] {
  const buckets = new Map<string, T[]>()
  for (const card of cards) {
    if (card.trashedAt !== undefined) continue
    const list = buckets.get(card.status) ?? []
    list.push(card)
    buckets.set(card.status, list)
  }
  const order = [...MAIN_COLUMNS, ...SECONDARY_COLUMNS]
  const columns: Column<T>[] = []
  for (const status of order) {
    const items = (buckets.get(status) ?? []).sort(byUrgencyThenAge)
    columns.push({ status, label: pick(COLUMN_LABELS[status], lang, status), items })
    buckets.delete(status)
  }
  for (const [status, items] of buckets) {
    if (status === 'trashed') continue
    columns.push({ status, label: status, items: items.sort(byUrgencyThenAge) })
  }
  return columns
}

/** 紧急度排序权重�?*/
const URGENCY_WEIGHT: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3, relaxed: 4 }

/** 排序：紧急度 �?创建时间（旧的在前）�?*/
export function byUrgencyThenAge(left: BoardCard, right: BoardCard): number {
  const weight = (URGENCY_WEIGHT[left.urgency] ?? 9) - (URGENCY_WEIGHT[right.urgency] ?? 9)
  if (weight !== 0) return weight
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/** 筛选条件�?*/
export interface BoardFilter {
  text?: string
  urgency?: string
  onlyRunning?: boolean
  onlyIssue?: boolean
}

/** 筛选（不改变顺序）�?*/
export function filterCards<T extends BoardCard>(cards: readonly T[], filter: BoardFilter): readonly T[] {
  const needle = filter.text?.trim().toLowerCase() ?? ''
  return cards.filter(card => {
    if (card.trashedAt !== undefined) return false
    if (filter.urgency !== undefined && card.urgency !== filter.urgency) return false
    if (filter.onlyRunning === true && card.hasRunning !== true) return false
    if (filter.onlyIssue === true && card.issueId === undefined) return false
    if (needle !== '' && !`${card.title} ${card.id}`.toLowerCase().includes(needle)) return false
    return true
  })
}

/** 清单完成度�?*/
export function checklistDone(card: BoardCard): { done: number; total: number } {
  const items = card.checklist ?? []
  return { done: items.filter(item => item.done).length, total: items.length }
}

/** 能不能拖（`running` 的卡不允许拖，避免和引擎抢状态）�?*/
export function draggable(card: BoardCard): boolean {
  if (card.hasRunning === true) return false
  if (card.lastExecutionOutcome === 'running') return false
  return card.trashedAt === undefined
}

/** 拖拽数据类型（避免和其它面板互相干扰）�?*/
export const DRAG_TYPE = 'application/x-dsh-castboard-task'
