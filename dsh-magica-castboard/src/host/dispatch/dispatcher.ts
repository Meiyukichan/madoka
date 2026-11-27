/**
 * Todo dispatcher — the `todo` column is the queue.
 *
 * Every trigger is a ledger mutation (create, send back, settle, cap change), so this subscribes to
 * `TaskStore.subscribe` and never polls. Scheduled cards enter the queue only once the scheduler
 * stamps `releasedAt`; manual cards enter unless their last round failed or was cancelled, because
 * an automatic retry would burn tokens on a card that is bound to fail.
 *
 * `im` cards take no concurrency slot and are not blocked by the cap (their volume is gated on
 * the IM side), so they run even when the board is full. Order: urgency, creation time, id.
 *
 * @module dsh-magica-castboard/host/dispatch/dispatcher
 */
import {
  type BoardSettings,
  type RunRequestResult,
  type TaskSummary,
  URGENCIES,
  isImSource,
} from '../model.ts'
import { maxConcurrentOf } from '../rules.ts'
import { eventLog } from '../shared/event-log.ts'

/** Delay before looking again after a rejection. */
export const RETRY_MS = 5_000

/** Rejections to top up before leaving the rest to the next ledger change. */
export const MAX_RETRIES = 3

const URGENCY_RANK: ReadonlyMap<string, number> = new Map(
  URGENCIES.map((urgency, index) => [urgency, index]),
)

export interface DispatchStore {
  load(): Promise<void>
  summaries(): readonly TaskSummary[]
  /** Live board settings; the dispatcher re-reads the limit on every drain. */
  settings(): BoardSettings | undefined
  subscribe(listener: () => void): () => void
}

export interface DispatcherDeps {
  store: DispatchStore
  execution: {
    run: (taskId: string, trigger: 'dispatch' | 'scheduled') => Promise<RunRequestResult>
  }
  /** Fallback when the board setting is absent. */
  maxConcurrent?: number
  setTimer?: (callback: () => void | Promise<void>, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export function needsDispatch(summary: TaskSummary): boolean {
  if (summary.status !== 'todo' || summary.trashed || summary.blocked) return false
  // Settlement hands over to the execution record, so a card can briefly sit on todo while running.
  if (summary.hasRunning || summary.lastExecutionOutcome === 'running') return false
  // Scheduled cards wait for the token; only the scheduler stamps it.
  if (summary.executionMode === 'scheduled') return summary.releasedAt !== undefined
  return summary.lastExecutionOutcome !== 'failed'
    && summary.lastExecutionOutcome !== 'cancelled'
}

export function dispatchOrder(summaries: readonly TaskSummary[]): TaskSummary[] {
  return summaries.filter(needsDispatch).sort((left, right) =>
    ((URGENCY_RANK.get(left.urgency) ?? URGENCIES.length)
      - (URGENCY_RANK.get(right.urgency) ?? URGENCIES.length))
    || (left.createdAt - right.createdAt)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

function unmetered(summary: TaskSummary): boolean {
  return isImSource(summary.source)
}

export class DispatcherService {
  private readonly deps: DispatcherDeps
  private unsubscribe: (() => void) | undefined
  private disposed = false
  // Coalesce: changes that arrive mid-drain only set a flag.
  private requested = false
  private draining = false
  private retryHandle: unknown
  private retries = 0

  constructor(deps: DispatcherDeps) {
    this.deps = deps
  }

  async start(): Promise<void> {
    if (this.disposed || this.unsubscribe !== undefined) return
    await this.deps.store.load()
    if (this.disposed || this.unsubscribe !== undefined) return
    this.unsubscribe = this.deps.store.subscribe(() => { void this.drain() })
    await this.drain()
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.clearRetry()
  }

  // ---------------------------------------------------------------- Draining

  /**
   * Only one drain at a time: `run()` writes the ledger, which re-triggers the subscription, and
   * concurrent drains would pick the same card twice while skipping others.
   */
  private async drain(): Promise<void> {
    if (this.disposed) return
    this.requested = true
    if (this.draining) return
    this.draining = true
    try {
      while (this.requested && !this.disposed) {
        this.requested = false
        await this.drainOnce()
      }
    } catch (error) {
      // Fire-and-forget subscriber: an escaping rejection would be unhandled.
      eventLog('error', 'dispatch-drain-failed', errorText(error))
    } finally {
      this.draining = false
    }
  }

  private async drainOnce(): Promise<void> {
    let rejected = false
    let started = false
    const summaries = this.deps.store.summaries()
    const limit = maxConcurrentOf(this.deps.store.settings(), this.deps.maxConcurrent)

    // Metered count only; im is excluded.
    let running = 0
    for (const summary of summaries) {
      if (!summary.hasRunning || unmetered(summary)) continue
      running += 1
    }

    for (const candidate of dispatchOrder(summaries)) {
      if (this.disposed) return
      // Skip a metered candidate that does not fit rather than breaking: free cards may follow.
      if (limit - running <= 0 && !unmetered(candidate)) continue
      // The ledger may have changed since the ordering (sent back, blocked, trashed, taken).
      const fresh = this.deps.store.summaries().find(summary => summary.id === candidate.id)
      if (fresh === undefined || !needsDispatch(fresh)) continue
      const free = unmetered(fresh)
      // Re-check against the fresh view: an earlier run() may have filled the slots.
      if (!free && limit - running <= 0) continue
      // Claim a slot first; run() still re-checks against the ledger.
      if (!free) running += 1
      const trigger = fresh.executionMode === 'scheduled' ? 'scheduled' : 'dispatch'
      let result: RunRequestResult
      try {
        result = await this.deps.execution.run(fresh.id, trigger)
      } catch (error) {
        // An execution error must neither stall the round nor leak the slot.
        if (!free) running -= 1
        eventLog('error', 'dispatch-run-failed', `${fresh.id}: ${errorText(error)}`)
        continue
      }
      if (result.ok) {
        started = true
        this.retries = 0
        continue
      }
      // Another process started it first: not an error, no retry, but it does hold the slot.
      if (result.error?.includes('already in progress') === true) continue
      if (!free) running -= 1
      // Only a transient concurrency mismatch is worth a retry.
      if (result.error?.includes('concurrency limit') === true) rejected = true
      eventLog('warn', 'dispatch-run-rejected', `${candidate.id}: ${result.error ?? 'unknown'}`)
    }

    if (rejected && !started && !this.disposed) this.scheduleRetry()
    else if (!rejected) this.retries = 0
  }

  private scheduleRetry(): void {
    if (this.retries >= MAX_RETRIES) {
      this.retries = 0
      return
    }
    this.retries += 1
    this.clearRetry()
    const setTimer = this.deps.setTimer ?? defaultSetTimer
    this.retryHandle = setTimer(() => this.drain(), RETRY_MS)
  }

  private clearRetry(): void {
    if (this.retryHandle === undefined) return
    (this.deps.clearTimer ?? defaultClearTimer)(this.retryHandle)
    this.retryHandle = undefined
  }
}

function defaultSetTimer(callback: () => void | Promise<void>, delayMs: number): unknown {
  const timer = setTimeout(() => {
    void Promise.resolve(callback()).catch((error: unknown) => {
      eventLog('error', 'dispatch-retry-failed', errorText(error))
    })
  }, delayMs)
  // Unref: a pending retry must not keep the host open.
  timer.unref?.()
  return timer
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as Parameters<typeof clearTimeout>[0])
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
