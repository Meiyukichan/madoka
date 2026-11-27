/**
 * InteractionCoordinator: one scheduler for interaction reporting and answer bridging.
 *
 * The normal path is **event-driven**:
 *
 * - spellbook emits `magica/interaction-changed` when a pending appears/disappears;
 * - inbox `onIngested` wakes it when a remote comment arrives;
 * - `wake()` debounces bursts and runs one `tick`.
 *
 * A slow safety tick (default 30s) is only a fallback for a missed event, a restart, or a
 * projection change. It must not become the primary polling path.
 *
 * @module dsh-magica-castboard/host/exec/interaction-coordinator
 */

/** Default debounce for `wake()`: added/removed bursts collapse into one tick. */
export const DEFAULT_WAKE_DEBOUNCE_MS = 50

/** Default safety tick: a fallback, not the normal path. */
export const DEFAULT_SAFETY_MS = 30_000

export interface InteractionCoordinatorDeps {
  /** One idempotent pass: refresh -> reconcile -> report. Must not throw for expected failures. */
  readonly run: () => Promise<void>
  /** Safety interval (ms); default {@link DEFAULT_SAFETY_MS}. */
  readonly safetyMs?: number
  /** Wake debounce (ms); default {@link DEFAULT_WAKE_DEBOUNCE_MS}. */
  readonly debounceMs?: number
  /** Timer injection for tests. */
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  readonly log?: (event: string, error: unknown) => void
}

function unrefTimer(handle: unknown): void {
  ;(handle as { unref?: () => void } | undefined)?.unref?.()
}

export class InteractionCoordinator {
  private readonly deps: InteractionCoordinatorDeps
  private started = false
  private wakeHandle: unknown
  private safetyHandle: unknown
  private running: Promise<void> | undefined
  /** A wake arrived while a tick was running: run one more pass. */
  private dirty = false

  constructor(deps: InteractionCoordinatorDeps) {
    this.deps = deps
  }

  /** Start the safety timer and run one initial pass. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    this.scheduleSafety()
    this.wake('start')
  }

  /** Stop timers and prevent later passes. Idempotent. */
  stop(): void {
    this.started = false
    this.dirty = false
    if (this.wakeHandle !== undefined) {
      this.clearTimer(this.wakeHandle)
      this.wakeHandle = undefined
    }
    if (this.safetyHandle !== undefined) {
      this.clearTimer(this.safetyHandle)
      this.safetyHandle = undefined
    }
  }

  /**
   * Ask for a tick soon. Bursts within the debounce window collapse into one pass.
   *
   * @param _reason - Diagnostic label only; not used for scheduling.
   */
  wake(_reason?: string): void {
    if (!this.started || this.wakeHandle !== undefined) return
    this.wakeHandle = this.setTimer(() => {
      this.wakeHandle = undefined
      void this.runOnce()
    }, Math.max(0, Math.round(this.deps.debounceMs ?? DEFAULT_WAKE_DEBOUNCE_MS)))
    unrefTimer(this.wakeHandle)
  }

  /** Run one pass now (single-flight; a concurrent wake is coalesced into one extra pass). */
  async tick(): Promise<void> {
    if (!this.started) return
    await this.runOnce()
  }

  private async runOnce(): Promise<void> {
    if (!this.started) return
    if (this.running !== undefined) {
      this.dirty = true
      return
    }
    const task = this.drain()
    this.running = task
    try {
      await task
    } finally {
      if (this.running === task) this.running = undefined
    }
  }

  private async drain(): Promise<void> {
    do {
      this.dirty = false
      try {
        await this.deps.run()
      } catch (error) {
        this.deps.log?.('interaction-coordinator-tick-failed', error)
      }
    } while (this.dirty && this.started)
  }

  private scheduleSafety(): void {
    if (!this.started) return
    const delay = Math.max(1, Math.round(this.deps.safetyMs ?? DEFAULT_SAFETY_MS))
    this.safetyHandle = this.setTimer(() => {
      this.safetyHandle = undefined
      if (!this.started) return
      this.wake('safety')
      this.scheduleSafety()
    }, delay)
    unrefTimer(this.safetyHandle)
  }

  private setTimer(callback: () => void, delayMs: number): unknown {
    if (this.deps.setTimer !== undefined) return this.deps.setTimer(callback, delayMs)
    const handle = setTimeout(callback, delayMs)
    handle.unref?.()
    return handle
  }

  private clearTimer(handle: unknown): void {
    if (this.deps.clearTimer !== undefined) {
      this.deps.clearTimer(handle)
      return
    }
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}
