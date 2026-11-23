/**
 * cron scheduler — one pending timer for the whole process.
 *
 * "When does it run next" is always recomputed from `cron`; no next time is stored, so windows
 * missed while the process was down are not replayed and a restart just schedules the next one.
 *
 * Any ledger change re-arms: sleep to the nearest next trigger (capped at one hour, recomputing on
 * wake, which also absorbs system sleep and clock jumps). At the deadline it only stamps
 * `releasedAt` and moves the card to `todo`; starting the session is the dispatcher's job, because
 * only it knows the concurrency cap.
 *
 * A cron that cannot produce a next time can only come from a hand-edited ledger: disable it and
 * leave a system comment, otherwise the user just sees the schedule silently disappear.
 *
 * @module dsh-magica-castboard/host/dispatch/scheduler
 */
import {
  type TaskLedger,
  type TaskRecord,
  type TaskStatus,
  type TaskSummary,
} from '../model.ts'
import { MAX_BODY, normalizeBody } from '../rules.ts'
import { eventLog } from '../shared/event-log.ts'
import { nextCronRunAtOrUndefined } from './cron.ts'

/** Longest a single arm may sleep. */
export const MAX_SLEEP_MS = 60 * 60_000

/** Waking up later than this means the window is forfeited (system sleep, long block); just re-arm. */
export const STALE_WINDOW_MS = 5 * 60_000

/** Still scheduled: todo waits for its window; in_review is unhandled work, so its timer must not die. */
const RUNNABLE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['todo', 'in_review'])

export interface SchedulerStore {
  load(): Promise<void>
  summaries(): readonly TaskSummary[]
  subscribe(listener: () => void): () => void
  mutate(
    kind: string,
    mutator: (ledger: TaskLedger) => TaskRecord[] | undefined,
  ): Promise<unknown>
}

export interface SystemCommentInput {
  body: string
  systemKey: string
  systemParams?: Record<string, string>
  createdAt: number
}

export interface SystemCommentFace {
  addSystem(anchorId: string, input: SystemCommentInput): Promise<unknown>
}

export interface SchedulerDeps {
  store: SchedulerStore
  thread?: SystemCommentFace
  now: () => number
  /** Tests drive this directly for determinism; a returned promise is awaited by the scheduler. */
  setTimer?: (callback: () => void | Promise<void>, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class SchedulerService {
  private readonly deps: SchedulerDeps
  private handle: unknown
  private armedFor: number | undefined
  // Cards whose next trigger is exactly `armedFor`, captured at arm time.
  private armedDue = new Set<string>()
  private unsubscribe: (() => void) | undefined
  private disposed = false
  // Reentrancy guard: two concurrent rounds would release the same card twice.
  private draining = false

  constructor(deps: SchedulerDeps) {
    this.deps = deps
  }

  async start(): Promise<void> {
    if (this.disposed || this.unsubscribe !== undefined) return
    // Read the ledger before arming; callers `void` this and catch the rejection.
    await this.deps.store.load()
    if (this.disposed || this.unsubscribe !== undefined) return
    this.unsubscribe = this.deps.store.subscribe(() => { this.rearm() })
    this.rearm()
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.clearTimer()
  }

  // ---------------------------------------------------------------- Arming

  /**
   * Sleep to the nearest next trigger. Everything is computed from `now` — there is nothing
   * persisted to read.
   */
  private rearm(): void {
    if (this.disposed) return
    const now = this.deps.now()
    const summaries = this.deps.store.summaries()

    let earliest: number | undefined
    const due: string[] = []
    for (const summary of summaries) {
      if (!isRunnable(summary)) continue
      const cron = summary.cron
      if (cron === undefined) continue
      const at = nextRunAt(cron, now)
      if (at === undefined) {
        // Hand-edited ledger: disable it and leave a trace instead of never firing silently.
        void this.disableDeadCron(summary.id, cron).catch((error: unknown) => {
          eventLog('error', 'cron-disable-failed', `${summary.id}: ${errorText(error)}`)
        })
        continue
      }
      if (earliest === undefined || at < earliest) {
        earliest = at
        due.length = 0
      }
      if (at === earliest) due.push(summary.id)
    }

    if (earliest === undefined) {
      this.clearTimer()
      return
    }
    if (this.handle !== undefined && this.armedFor === earliest) {
      // Sync `armedDue` before the early return: newly due cards at the same instant would
      // otherwise be lost for this window.
      this.armedDue = new Set(due)
      return
    }
    this.clearTimer()
    // Cron times are in the future, so sleep exactly to the deadline. A clock rollback that lands
    // it in the past gets the stale window as a fallback so this does not busy-loop.
    const delay = earliest > now ? Math.min(earliest - now, MAX_SLEEP_MS) : STALE_WINDOW_MS
    this.armedFor = earliest
    this.armedDue = new Set(due)
    this.handle = (this.deps.setTimer ?? defaultSetTimer)(() => this.onDue(), delay)
  }

  private clearTimer(): void {
    if (this.handle !== undefined) {
      (this.deps.clearTimer ?? defaultClearTimer)(this.handle)
      this.handle = undefined
    }
    this.armedFor = undefined
    this.armedDue = new Set()
  }

  // ---------------------------------------------------------------- Triggering

  /**
   * Woke up: release the cards captured at arm time, then re-arm. "Due" is not recomputed here
   * because `nextCronRunAt(cron, now)` always returns a time after now.
   */
  private async onDue(): Promise<void> {
    // The guard comes before touching state: a wake-up arriving mid-drain has not handled its own
    // dueIds, and clearing the arm first would drop that window.
    if (this.draining) return
    const firedFor = this.armedFor
    const dueIds = [...this.armedDue]
    this.handle = undefined
    this.armedFor = undefined
    this.armedDue = new Set()
    // Only rearm() arms the timer, and it always writes armedFor before setTimer.
    if (this.disposed || firedFor === undefined) return
    this.draining = true
    try {
      const now = this.deps.now()
      // The one-hour cap can wake us early with the real trigger hours away: that is a recompute,
      // not a deadline, so let finally re-arm.
      if (now < firedFor) return
      if (now - firedFor > STALE_WINDOW_MS) {
        eventLog('warn', 'woke-late', `scheduler woke ${Math.round((now - firedFor) / 1000)}s late; skipping this window`)
        return
      }
      for (const taskId of dueIds) {
        // One bad card must not stop the rest from being released.
        try {
          await this.fire(taskId, firedFor)
        } catch (error) {
          eventLog('error', 'scheduled-release-failed', `${taskId}: ${errorText(error)}`)
        }
      }
    } finally {
      this.draining = false
      this.rearm()
    }
  }

  /**
   * Release one card, re-checking that it is still scheduled the same way — the ledger may have
   * trashed it, moved it out of a runnable status, or started it after arming.
   */
  private async fire(taskId: string, windowAt: number): Promise<void> {
    const summary = this.deps.store.summaries().find(item => item.id === taskId)
    if (summary === undefined || !isRunnable(summary)) return
    const cron = summary.cron
    if (cron === undefined) return
    // The cron was edited at fire time: this window belongs to the expression that is gone.
    if (nextRunAt(cron, windowAt - 1) !== windowAt) return

    await this.deps.store.mutate('task-moved', ledger => {
      const index = ledger.tasks.findIndex(task => task.id === taskId)
      if (index < 0) return undefined
      const task = ledger.tasks[index]
      if (task === undefined) return undefined
      // A write may have landed since the pre-check, so all of this is re-tested (idempotent).
      if (task.trashedAt !== undefined) return undefined
      if (task.execution.mode !== 'scheduled' || task.execution.cron === undefined) return undefined
      if (!RUNNABLE_STATUSES.has(task.status)) return undefined
      // Still running: do not move it, wait for it to land in in_review.
      if (task.executions.some(execution => execution.outcome === 'running')) return undefined

      const now = this.deps.now()
      task.releasedAt = windowAt
      if (task.status !== 'todo') {
        task.status = 'todo'
        // Leaving in_progress / in_review ends this round, so the claim fields go with it.
        releaseClaim(task)
      }
      task.updatedAt = now
      task.updatedBy = { kind: 'system' }
      return [task]
    })
  }

  /**
   * Disable a cron with no computable next time and leave a system comment — silence would look
   * like the schedule simply vanished.
   */
  private async disableDeadCron(taskId: string, cron: string): Promise<void> {
    let anchor: string | undefined
    await this.deps.store.mutate('task-updated', ledger => {
      const task = ledger.tasks.find(item => item.id === taskId)
      if (task === undefined || task.execution.cron !== cron) return undefined
      task.execution.cron = undefined
      // The cron is detail content, so clients need a fresh updatedAt.
      task.updatedAt = this.deps.now()
      anchor = task.issueId ?? task.id
      return [task]
    }).catch((error: unknown) => {
      eventLog('error', 'cron-disable-failed', `${taskId}: ${errorText(error)}`)
    })
    if (anchor === undefined) return
    const body = `[系统] 定时表达式 ${cron} 无法调度，已停用定时；请修正 cron 后重新开启。`
    await this.deps.thread?.addSystem(anchor, {
      body: normalizeBody(body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body),
      systemKey: 'sys.cronDead',
      systemParams: { cron },
      createdAt: this.deps.now(),
    }).catch((error: unknown) => {
      eventLog('error', 'cron-disable-comment-failed', `${taskId}: ${errorText(error)}`)
    })
  }
}

function isRunnable(summary: TaskSummary): boolean {
  return summary.executionMode === 'scheduled'
    && summary.cron !== undefined
    && !summary.trashed
    && RUNNABLE_STATUSES.has(summary.status)
}

function releaseClaim(task: TaskRecord): void {
  delete task.claimedBy
  delete task.claimedAt
}

function nextRunAt(cron: string, from: number): number | undefined {
  return nextCronRunAtOrUndefined(cron, from)
}

function defaultSetTimer(callback: () => void | Promise<void>, delayMs: number): unknown {
  const timer = setTimeout(() => {
    void Promise.resolve(callback()).catch((error: unknown) => {
      eventLog('error', 'wake-up-failed', errorText(error))
    })
  }, delayMs)
  // Unref: a sleeping scheduler must not hold the host open; after a restart cron is recomputed.
  timer.unref?.()
  return timer
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as Parameters<typeof clearTimeout>[0])
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
