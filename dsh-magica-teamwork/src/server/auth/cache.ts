/**
 * 鉴权结果缓存（api-design / server-design §4.6）。
 *
 * - key = `sha256(token)`（不把原始 token 当 map key，避免堆转储泄露）
 * - 命中条件：未超过 cachedUntil、未超过 token 自身 exp、accountId 一致
 * - 上界 4096 条，按插入顺序淘汰最旧的（近似 LRU）
 * - 任何影响鉴权的写操作（改密码/改角色/禁用）都应调用 `clear()`
 */
import { createHash } from 'node:crypto'
import type { CurrentUser } from './guard.js'

interface Entry {
  accountId: string
  user: CurrentUser
  exp: number
  cachedUntil: number
}

const MAX_ENTRIES = 4096

function fingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export class AuthCache {
  private readonly map = new Map<string, Entry>()
  private hits = 0
  private misses = 0

  constructor(private readonly ttlMs: number) {}

  get enabled(): boolean {
    return this.ttlMs > 0
  }

  get(token: string, accountId: string, now = Date.now()): CurrentUser | undefined {
    if (!this.enabled) return undefined
    const key = fingerprint(token)
    const e = this.map.get(key)
    if (!e || e.accountId !== accountId || e.exp <= now || e.cachedUntil <= now) {
      this.misses++
      return undefined
    }
    this.hits++
    // 命中后移到末尾（近似 LRU）
    this.map.delete(key)
    this.map.set(key, e)
    return e.user
  }

  set(token: string, user: CurrentUser, exp: number, now = Date.now()): void {
    if (!this.enabled) return
    const key = fingerprint(token)
    this.map.delete(key)
    this.map.set(key, {
      accountId: user.accountId,
      user,
      exp,
      cachedUntil: Math.min(exp, now + this.ttlMs),
    })
    while (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }

  /** 单个 token 失效（logout） */
  invalidateToken(token: string): void {
    this.map.delete(fingerprint(token))
  }

  /** 账号级失效：清掉该账号的所有缓存项 */
  invalidateAccount(accountId: string): number {
    let n = 0
    for (const [k, e] of this.map) {
      if (e.accountId === accountId) {
        this.map.delete(k)
        n++
      }
    }
    return n
  }

  clear(): void {
    this.map.clear()
  }

  stats(): { size: number; hits: number; misses: number; ttlMs: number } {
    return { size: this.map.size, hits: this.hits, misses: this.misses, ttlMs: this.ttlMs }
  }
}
