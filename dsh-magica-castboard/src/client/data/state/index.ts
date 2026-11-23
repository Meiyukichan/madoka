/**
 * 状态层出口。
 *
 * @module dsh-magica-castboard/client/data/state
 */
export { BoardStore, POLL_MAX_MS, POLL_MS } from './board-store.ts'
export { readLastModel, readLastWorkspace, saveLastModel, saveLastWorkspace } from './persist.ts'
export * from './types.ts'
