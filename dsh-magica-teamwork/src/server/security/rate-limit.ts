/**
 * 限流：内存滑窗（固定窗口计数），按「每 IP」与「每账号」两个维度。
 *
 * 重启清零是明确接受的代价（服务是单实例、本机指导性服务）。
 */
export interface RateLimitRule {
  /** 窗口内允许次数 */
  limit: number
  /** 窗口长度（毫秒） */
  windowMs: number
}

export interface RateLimitHit {
  limited: boolean
  retryAfterSeconds: number
}

interface Bucket {
  count: number
  resetAt: number
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private lastSweep = 0

  /** @param rules 每个 key 前缀对应一组规则（如 ip: 10/min、account: 5/min + 30/h） */
  constructor(private readonly rules: Record<string, RateLimitRule[]>) {}

  hit(prefix: string, id: string, now = Date.now()): RateLimitHit {
    this.sweep(now)
    const rules = this.rules[prefix]
    if (!rules || rules.length === 0) return { limited: false, retryAfterSeconds: 0 }

    let worst = 0
    for (const [i, rule] of rules.entries()) {
      const key = `${prefix}:${i}:${id}`
      let b = this.buckets.get(key)
      if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: now + rule.windowMs }
        this.buckets.set(key, b)
      }
      b.count++
      if (b.count > rule.limit) {
        const wait = Math.max(1, Math.ceil((b.resetAt - now) / 1000))
        worst = Math.max(worst, wait)
      }
    }
    return worst > 0 ? { limited: true, retryAfterSeconds: worst } : { limited: false, retryAfterSeconds: 0 }
  }

  /** 每 60s 清一次过期桶，避免长期运行内存增长 */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return
    this.lastSweep = now
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k)
  }

  get size(): number {
    return this.buckets.size
  }
}
