/**
 * Cron parsing, host side.
 *
 * This layer is deliberately separate from the pure task projections: the browser asks
 * the host for `nextRunAt` instead of bundling a cron parser. The host delegates parsing
 * and date advancement to `cron-schedule`.
 *
 * Exactly five fields (minute hour day month weekday) are accepted; `cron-schedule` also
 * supports six-field expressions with seconds, but the board UI and its validation speak
 * five fields only.
 *
 * @module dsh-magica-castboard/host/dispatch/cron
 */
import { parseCronExpression } from 'cron-schedule'

import type { TaskSummary } from '../model.ts'

// Same expression -> parsed once per process. The ledger only holds a handful of them.
const parsed = new Map<string, ReturnType<typeof parseCronExpression>>()

function cronOf(expression: string): ReturnType<typeof parseCronExpression> {
  const cached = parsed.get(expression)
  if (cached !== undefined) return cached
  const next = parseCronExpression(expression)
  if (parsed.size > 64) parsed.clear()
  parsed.set(expression, next)
  return next
}

/**
 * Next occurrence of a five-field expression.
 *
 * @param cron - Five-field expression.
 * @param from - Starting instant (epoch ms).
 * @returns The next occurrence (epoch ms).
 * @throws On a wrong field count, an invalid expression, or one that never matches
 * (for example 31 April).
 */
export function nextCronRunAt(cron: string, from: number): number {
  const expression = cron.trim()
  const fields = expression.split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`cron must have exactly 5 fields (minute hour day month weekday), got ${fields.length}`)
  }
  try {
    return cronOf(expression).getNextDate(new Date(from)).getTime()
  } catch (error) {
    throw new Error(`cron "${expression}" is not schedulable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Like {@link nextCronRunAt} but returns `undefined` instead of throwing, for projection
 * paths that must survive one hand-edited, broken expression.
 *
 * @param cron - Five-field expression.
 * @param from - Starting instant (epoch ms).
 */
export function nextCronRunAtOrUndefined(cron: string | undefined, from: number): number | undefined {
  if (cron === undefined) return undefined
  try {
    return nextCronRunAt(cron, from)
  } catch {
    return undefined
  }
}

/**
 * Wire projection: add `nextRunAt` for scheduled cards only.
 *
 * It is computed on the outgoing path instead of being persisted with the summary: a
 * timestamp relative to "now" would change on every save and leave a stale value on disk.
 *
 * @param summary - Task summary.
 * @param now - Current instant (epoch ms).
 * @returns The original summary, or a copy carrying `nextRunAt`.
 */
export function withNextRunAt(summary: TaskSummary, now: number): TaskSummary {
  if (summary.cron === undefined) return summary
  const nextRunAt = nextCronRunAtOrUndefined(summary.cron, now)
  return nextRunAt === undefined ? summary : { ...summary, nextRunAt }
}
