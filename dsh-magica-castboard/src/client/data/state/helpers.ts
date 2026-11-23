/**
 * 状态机用到的纯工具：交互身份、可见性、错误文案。
 *
 * @module dsh-magica-castboard/client/data/state/helpers
 */
import { ApiError, type InteractionView } from '../index.ts'

/** 交互的稳定身份。 */
export function interactionKey(item: InteractionView): string {
  return `${item.kind}:${item.id}:${item.sessionId}`
}

/** 两组交互是否同一集合（顺序无关）。 */
export function sameInteractionSet(a: readonly InteractionView[], b: readonly InteractionView[]): boolean {
  if (a.length !== b.length) return false
  return a.every((item, index) => interactionKey(item) === interactionKey(b[index]!))
}

/** 交互指纹（与 host 的 `interactionRevision` 同一口径）。 */
export function fingerprintOf(list: readonly InteractionView[]): string {
  if (list.length === 0) return ''
  return list.map(item => `${item.kind}:${item.id}@${String(item.createdAt)}`).sort().join(',')
}

/** 页面是否隐藏。 */
export function isHidden(): boolean {
  try {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  } catch {
    return false
  }
}

/** `/state` 的快路径响应。 */
export function isUnchanged(value: unknown): value is { unchanged: true; revision: number; issueRevision: number; linkRevision: number; interactionRevision?: string } {
  return typeof value === 'object' && value !== null && (value as { unchanged?: unknown }).unchanged === true
}

/** 错误 → 可读文案。 */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return error instanceof Error ? error.message : String(error)
}
