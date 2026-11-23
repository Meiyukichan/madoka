/**
 * Execution session pool: the session handles held by this process and the turns they
 * are running.
 *
 * Two tables with different jobs:
 *
 * | table | key | lifetime |
 * |---|---|---|
 * | `runs` | execution record id | turn start → settlement finally |
 * | `sessions` | session id / card id | retained while the card is in progress / awaiting review |
 *
 * **Session retention is decided by card status, not by whether the current turn has
 * finished.** A card awaiting review must keep its session because the acceptance
 * context sits in dsh's `next-step` memory queue and is gone as soon as the session is
 * disposed; a person must also be able to keep asking follow-ups on the same session.
 * The pool therefore never evicts by count and releases at only three moments: the card
 * leaves those two columns, the plugin unloads, or the same card starts another turn
 * (its handle is replaced by a new one).
 *
 * @module dsh-magica-castboard/host/exec/session-pool
 */
import { eventLog } from '../shared/event-log.ts'
import type { SessionHandle } from './engine.ts'

interface RetainedSession {
  taskId: string
  sessionId: string
  handle: SessionHandle
}

/** Never throws: logging failures are swallowed. */
function note(level: 'info' | 'warn' | 'error', event: string, detail: string): void {
  eventLog(level, event, detail)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class SessionPool {
  private readonly runs = new Map<string, SessionHandle>()
  private readonly bySession = new Map<string, RetainedSession>()
  private readonly byTask = new Map<string, RetainedSession>()

  /** Second observation of the concurrency cap. */
  inFlight(): number {
    return this.runs.size
  }

  isRunningHandle(handle: SessionHandle): boolean {
    for (const current of this.runs.values()) {
      if (current === handle) return true
    }
    return false
  }

  isRunningSession(sessionId: string): boolean {
    const retained = this.bySession.get(sessionId)
    return retained === undefined ? false : this.isRunningHandle(retained.handle)
  }

  owns(sessionId: string): boolean {
    return this.bySession.has(sessionId)
  }

  get(sessionId: string): SessionHandle | undefined {
    return this.bySession.get(sessionId)?.handle
  }

  handleOfRun(executionId: string): SessionHandle | undefined {
    return this.runs.get(executionId)
  }

  registerRun(executionId: string, handle: SessionHandle): void {
    this.runs.set(executionId, handle)
  }

  finishRun(executionId: string): void {
    this.runs.delete(executionId)
  }

  /**
   * Replaces and disposes the handle it supersedes when the same card starts another
   * turn: retention is per card, and two sessions for one card would let "Run" reuse a
   * stale one. Re-registering the same handle is idempotent.
   */
  async retain(taskId: string, sessionId: string, handle: SessionHandle): Promise<void> {
    const previous = this.byTask.get(taskId)
    if (previous !== undefined && previous.sessionId !== sessionId) {
      await this.release(previous.sessionId, previous.handle, `卡片又开了一轮，替换会话 ${previous.sessionId}`)
    }
    const existing = this.bySession.get(sessionId)
    if (existing !== undefined && existing.handle !== handle) {
      // The same session now has a new handle (re-registered after resuming from the
      // ledger): drop the one it replaced as well.
      await this.release(sessionId, existing.handle, '同一会话换了新句柄')
    }
    const entry: RetainedSession = { taskId, sessionId, handle }
    this.bySession.set(sessionId, entry)
    this.byTask.set(taskId, entry)
  }

  /**
   * Identity is checked by handle: the same card can settle and immediately start a new
   * handle under the same sessionId, so deleting by id would kill the new handle.
   */
  async release(sessionId: string, handle: SessionHandle, reason: string): Promise<boolean> {
    const current = this.bySession.get(sessionId)
    if (current === undefined || current.handle !== handle) return false
    this.bySession.delete(sessionId)
    if (this.byTask.get(current.taskId) === current) this.byTask.delete(current.taskId)
    note('info', 'session-released', `${sessionId}：${reason}（之后再追问会从台账续跑）`)
    // Must await: if the same session is woken right afterwards, the facade's
    // "must not resume a live session" check would still see it alive (SESSION_LIVE),
    // and that turn would end as "no turn/end observed".
    try {
      await handle.dispose()
    } catch (error) {
      note('warn', 'session-release-failed', `${sessionId}: ${errorText(error)}`)
    }
    return true
  }

  entries(): readonly RetainedSession[] {
    return [...this.bySession.values()]
  }

  /**
   * Unload: reclaim every handle and every running turn.
   *
   * The same handle may appear in both `runs` and `bySession`; de-duplicate before
   * disposing so it is not released twice. Remains synchronous (callers use it as an
   * ordinary disposer); each dispose carries its own catch.
   */
  disposeAll(): void {
    const handles = new Set<SessionHandle>([
      ...this.runs.values(),
      ...[...this.bySession.values()].map(entry => entry.handle),
    ])
    this.runs.clear()
    this.bySession.clear()
    this.byTask.clear()
    for (const handle of handles) {
      try {
        void handle.dispose().catch((error: unknown) => {
          note('error', 'session-dispose-failed', errorText(error))
        })
      } catch (error) {
        note('error', 'session-dispose-failed', errorText(error))
      }
    }
  }
}
