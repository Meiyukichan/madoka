/**
 * 归属判定：这个 `sessionId` 是不是 spellbook 门面创建的？
 *
 * 唯一凭证是会话台账；负缓存只省一次读盘，丢了不影响正确性。
 * 额外的**进程内白名单**用于"台账写失败"这一种放大风险：写不进去也不能让待决项永不可见。
 *
 * @module dsh-magica-spellbook/interactions/ownership
 */

import { getSessionRecord, getSessionStore } from '../sessions/store.ts'

/** 宿主面：只要 `get`（刻意不用 cordis 的 Context —— 跨包实例可能不兼容）。 */
export interface InteractionHostFace {
  get?(name: string): unknown
}

/** 已知「不是 spellbook 创建」的会话（负缓存）。 */
const foreign = new Set<string>()

/** 已知「是 spellbook 创建」的会话（进程内白名单，台账写失败时的兜底）。 */
const known = new Set<string>()

const FOREIGN_CACHE_MAX = 1024
/** 进程内白名单上限（防止长时间运行的宿主无限增长）。 */
const KNOWN_MAX = 4096

function foreignKey(sessionId: string, storeDir?: string): string {
  return `${storeDir ?? ''}\u0000${sessionId}`
}

/**
 * 判定归属：白名单 → 负缓存 → 台账单文件直读。
 *
 * **正结果不缓存**（D-054 / E-018）：台账可能被删/被清理，缓存了就会一直认一个已经不存在的会话。
 * 只有门面自己写台账时（{@link noteMagicaSession}）才进白名单——那是"本进程造的"，可长期信任。
 *
 * @param host - 宿主面。
 * @param sessionId - 候选会话。
 * @param storeDir - 台账目录覆盖（必须与门面一致）。
 */
export function isMagicaSession(host: InteractionHostFace, sessionId: string, storeDir?: string): boolean {
  const key = foreignKey(sessionId, storeDir)
  if (known.has(key)) return true
  if (foreign.has(key)) return false
  const record = getSessionRecord(host as never, sessionId, storeDir)
  if (record !== null) return true
  if (foreign.size >= FOREIGN_CACHE_MAX) foreign.clear()
  foreign.add(key)
  return false
}

/** 门面写完台账后调用（抹掉负缓存、补进白名单）。 */
export function noteMagicaSession(sessionId: string, storeDir?: string): void {
  const key = foreignKey(sessionId, storeDir)
  if (known.size >= KNOWN_MAX) known.clear()
  known.add(key)
  foreign.delete(key)
}

/** 台账写失败时调用：即使磁盘上没有记录，本进程也认这个会话。 */
export function noteMagicaSessionInMemory(sessionId: string, storeDir?: string): void {
  noteMagicaSession(sessionId, storeDir)
}

/** 清空两张缓存（测试 / 诊断用）。 */
export function resetMagicaSessionCache(): void {
  foreign.clear()
  known.clear()
}

/** 台账是否可用（诊断：`false` 时所有归属判定都会落到"不是我们的"）。 */
export function sessionStoreAvailable(host: InteractionHostFace, storeDir?: string): boolean {
  return getSessionStore(host as never, storeDir) !== null
}
