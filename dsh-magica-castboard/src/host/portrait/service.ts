/**
 * Project portrait service — writes one portrait per workspace, serially.
 *
 * A batch runs only at **local 3:00 and 13:00** (`PORTRAIT_RUN_HOURS`). Loading the plugin never
 * backfills a run, not even when the ledger is missing: that would dispatch work the moment a fresh
 * machine starts, which users do not expect. A right-now run comes from the settings button
 * ({@link refreshAll}).
 *
 * Writing a portrait is minutes of heavy work sharing **one** long-lived session, so ticks are
 * single-flight — concurrency would only queue the agent behind itself and burn libuv slots.
 *
 * @module dsh-magica-castboard/host/portrait/service
 */
import type { PortraitTarget } from '../context/portrait-context.ts'
import {
  PORTRAIT_MAX_ATTEMPTS,
  consolePortraitLog,
  type PortraitEntry,
  type PortraitLog,
  type PortraitStore,
} from './store.ts'
import {
  preparePortraitTarget,
  runPortraitTurn,
  type PortraitRoundDeps,
  type PortraitSessionFace,
  type PortraitTurnOutcome,
} from './runner.ts'

/** Fixed trigger hours (**local time**, 24-hour clock): 3:00 AM and 1:00 PM. */
export const PORTRAIT_RUN_HOURS: readonly number[] = [3, 13]

/** Stop even if candidates keep appearing; guards against a pathological loop. */
export const MAX_BATCH_STEPS = 200

/** The n-th failure waits n × this. */
export const RETRY_BACKOFF_MS = 120_000

/** Consecutive thrown turns that mean the session is broken. */
export const SESSION_FAULTS_TO_REBUILD = 2

/** Retry interval after failing to create a session. */
export const SESSION_RETRY_BACKOFF_MS = 30_000

/** Startup catch-up waits this long between workspace-registry probes. */
const STARTUP_REGISTRY_RETRY_MS = 10_000

/** Give the host about five minutes to populate the workspace registry. */
const STARTUP_REGISTRY_ATTEMPTS = 30

/**
 * Next trigger strictly after `now`, in local time. Built with `new Date(y, m, d, h)` because 3:00
 * and 13:00 are points in a human day and must follow the machine timezone.
 */
export function nextPortraitRunAt(now: number): number {
  const base = new Date(now)
  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    for (const hour of PORTRAIT_RUN_HOURS) {
      const at = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, 0, 0, 0).getTime()
      if (at > now) return at
    }
  }
  // Never reached: the loops always return. Here only to satisfy the type.
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, PORTRAIT_RUN_HOURS[0] ?? 3, 0, 0, 0).getTime()
}

export interface PortraitWorkspace {
  readonly id: string
  readonly path: string
  readonly title: string
}

export interface PortraitDeps {
  readonly entries: PortraitStore
  readonly now?: () => number
  readonly batchOf: (epochMs: number) => string
  /** Already filtered by the caller: no C drive, top-level drives, the workbench itself, or container dirs. */
  readonly listWorkspaces: () => ReadonlyArray<PortraitWorkspace>
  /** `sessionId` is the stored one; `undefined` means no session has been created yet. */
  readonly openSession: (sessionId: string | undefined, onCompacted?: () => void) => Promise<PortraitSessionFace>
  /** Only the lease holder dispatches work and writes the ledger. */
  readonly isOwner?: () => boolean
  readonly portraitWritten: (workspaceId: string) => Promise<boolean>
  readonly outputFileFor: (workspaceId: string) => string
  readonly indexFile: string
  /**
   * Best-effort: a failure is logged and the local state stays `done` — the portrait is already on
   * disk, so a network problem must not send it back to `pending`.
   */
  readonly publishPortrait?: (target: PortraitTarget) => Promise<void>
  readonly publishIndex?: () => Promise<void>
  readonly setTimer?: (run: () => void | Promise<void>, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  readonly log?: PortraitLog
}

/** One timer plus one session handle. */
export class PortraitService {
  private handle: unknown
  private disposed = false
  private started = false
  // Single-flight: at most one dispatched job at a time.
  private inFlight = false
  // A batch is running; the timer and the settings button can collide.
  private batchRunning = false
  private session: PortraitSessionFace | undefined
  private sessionFaults = 0
  // The context is full; the heap will not shrink by itself, so the session gets replaced.
  private compacted = false
  // In-memory only; `attempts` in the ledger is what survives a restart.
  private readonly cooldown = new Map<string, number>()
  private openBackoffUntil = 0
  private lastSignature = ''
  private readonly logger: PortraitLog
  private readonly deps: PortraitDeps

  constructor(deps: PortraitDeps) {
    this.deps = deps
    this.logger = deps.log ?? consolePortraitLog
  }

  start(options: { runOnStart?: boolean } = {}): void {
    if (this.disposed || this.started) return
    this.started = true
    // Arm only by default: every tick loads the ledger itself, so nothing happens at plugin load.
    // Unfinished `in_progress` entries, or the board setting, opt into one immediate batch.
    this.armNextRun()
    void this.recoverAndMaybeRun(options.runOnStart === true)
  }

  private async recoverAndMaybeRun(runOnStart: boolean): Promise<void> {
    let recovered = 0
    try {
      recovered = await this.deps.entries.recoverInProgress()
    } catch (error) {
      this.logger('warn', 'portrait-in-progress-recover-failed', errorText(error))
    }
    if (!runOnStart && recovered === 0) return
    this.logger('info', 'portrait-startup-catchup',
      recovered > 0
        ? `启动恢复：${String(recovered)} 个中断项目已回到队列，等待 workspace 注册表后继续`
        : '启动补跑：等待 workspace 注册表就绪后检查待写肖像')
    try {
      await this.runStartupCatchup()
    } catch (error) {
      this.logger('warn', 'portrait-startup-catchup-failed', errorText(error))
    }
  }

  /**
   * Startup catch-up must not run before the host has populated its workspace registry:
   * an empty list would make `sync` mark every known project as gone. Wait briefly for
   * the registry, then run the normal batch; a genuinely empty registry just means
   * nothing to do.
   */
  private async runStartupCatchup(): Promise<void> {
    for (let attempt = 0; attempt < STARTUP_REGISTRY_ATTEMPTS; attempt += 1) {
      if (this.disposed) return
      if (this.deps.listWorkspaces().length > 0) {
        await this.runBatch('startup')
        return
      }
      await delay(STARTUP_REGISTRY_RETRY_MS)
    }
    this.logger('warn', 'portrait-startup-empty-registry',
      '启动补跑等待 workspace 注册表超时；本轮不执行，避免把已有项目误标为下线')
  }

  dispose(): void {
    // Returns immediately; a turn already in flight is left to finish.
    this.disposed = true
    this.clearTimer()
    const session = this.session
    this.session = undefined
    if (session !== undefined) void session.dispose().catch(() => { /* best-effort */ })
  }

  /**
   * Requeue everything and run a batch in the background — a batch takes minutes, so the HTTP
   * caller must not wait. The batch id, failure counts, and session stay put: only the queue
   * position is rewound (see `PortraitStore.resetAll`).
   */
  async refreshAll(): Promise<{ reset: number }> {
    const reset = await this.deps.entries.resetAll()
    this.logger('info', 'portrait-manual-refresh', `手动触发全量更新（重置 ${String(reset)} 条）`)
    void this.runBatch('manual').catch((error: unknown) => {
      this.logger('warn', 'portrait-manual-refresh-failed', errorText(error))
    })
    return { reset }
  }

  async runBatch(reason: 'scheduled' | 'manual' | 'startup'): Promise<void> {
    if (this.disposed || this.batchRunning) return
    this.batchRunning = true
    try {
      this.logger('info', 'portrait-batch-start', `开始全量检查（${reason}）`)
      for (let step = 0; step < MAX_BATCH_STEPS; step += 1) {
        if (this.disposed) break
        const worked = await this.tick()
        if (!worked) break
      }
    } finally {
      this.batchRunning = false
    }
  }

  async tick(): Promise<boolean> {
    if (this.disposed) return false
    if (this.inFlight) return false
    if (!this.safeOwner()) return false
    if (this.now() < this.openBackoffUntil) return false
    this.inFlight = true
    try {
      await this.deps.entries.load()
      const workspaces = this.deps.listWorkspaces()
      if (workspaces.length === 0 && this.deps.entries.ledger().workspaces.length > 0) {
        this.logger('warn', 'portrait-workspaces-not-ready',
          'workspace 注册表为空但台账已有项目，跳过本轮 sync（避免误标下线）')
        return false
      }
      const sync = await this.deps.entries.sync(workspaces, this.deps.batchOf(this.now()))
      this.noteState(sync.rolled)
      await this.recycleIfCompacted()

      const candidate = this.nextCandidate()
      if (candidate === undefined) return false
      const session = await this.ensureSession()
      if (session === undefined) return false

      const target = await preparePortraitTarget(this.roundDeps(), candidate)
      await this.deps.entries.markInProgress(candidate.id, session.id)
      this.logger('info', 'portrait-dispatch',
        `${candidate.id}（${candidate.path}，${target.portraitExists ? '增量更新' : '新建'}）→ session ${session.id}`)

      const { outcome, written } = await runPortraitTurn(this.roundDeps(), target, session)
      await this.settle(target, outcome, written)
      return true
    } catch (error) {
      this.logger('warn', 'portrait-tick-failed', errorText(error))
      return false
    } finally {
      this.inFlight = false
    }
  }

  // ─── Candidates ──────────────────────────────────────────────────────────

  /**
   * `in_progress` first, then `pending`; path order keeps results stable when the registry reorders.
   *
   * `attempts` is a failure record, not a gate — "stop trying this batch" is `disabled`, which
   * `markFailed` sets at the cap. A manual refresh clears `disabled` but keeps `attempts`, so a
   * failed project can be requeued without losing its count.
   */
  private nextCandidate(): PortraitEntry | undefined {
    const now = this.now()
    const pool = this.deps.entries.ledger().workspaces.filter(entry => {
      if (entry.disabled === true) return false
      if ((entry.attempts ?? 0) >= PORTRAIT_MAX_ATTEMPTS) return false
      if (entry.status === 'done') return false
      const until = this.cooldown.get(entry.id)
      return until === undefined || until <= now
    })
    if (pool.length === 0) return undefined
    const rank = (entry: PortraitEntry): number => (entry.status === 'in_progress' ? 0 : 1)
    return [...pool].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))[0]
  }

  private noteState(rolled: boolean): void {
    const counts = new Map<string, number>()
    for (const entry of this.deps.entries.ledger().workspaces) {
      const key = entry.disabled === true ? 'disabled' : entry.status
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const signature = [...counts.entries()].sort().map(([key, value]) => `${key}=${String(value)}`).join(' ')
    if (signature === this.lastSignature && !rolled) return
    this.lastSignature = signature
    this.logger('info', 'portrait-state', `${signature || '（空台账）'}；批次=${this.deps.entries.ledger().batch}`)
  }

  private roundDeps(): PortraitRoundDeps {
    return {
      portraitWritten: this.deps.portraitWritten,
      outputFileFor: this.deps.outputFileFor,
      indexFile: this.deps.indexFile,
      log: this.logger,
    }
  }

  // ─── Sessions ────────────────────────────────────────────────────────────

  private async ensureSession(): Promise<PortraitSessionFace | undefined> {
    if (this.session !== undefined) return this.session
    const stored = this.deps.entries.ledger().session?.sessionId
    // Empty string means the last tick discarded the session; create a new one so static guidance
    // and this round's context are assembled from scratch.
    const saved = stored === undefined || stored === '' ? undefined : stored
    try {
      const session = await this.deps.openSession(saved, () => {
        if (this.compacted) return
        this.compacted = true
        this.logger('info', 'portrait-session-compacted',
          '当前会话发生了上下文压缩，下一拍换一个新会话（历史已撑满，堆不会自己降）')
      })
      if (saved !== undefined && !session.resumed) {
        this.logger('warn', 'portrait-session-replaced', `台账里的会话 ${saved} 已不可续跑，改用新会话 ${session.id}`)
        await this.deps.entries.saveSession({ sessionId: session.id })
      } else if (saved === undefined) {
        await this.deps.entries.saveSession({ sessionId: session.id, createdAt: this.now() })
      }
      this.session = session
      this.sessionFaults = 0
      this.compacted = false
      this.logger('info', 'portrait-session', `${session.id}（${session.resumed ? '续跑' : '新建'}）`)
      return session
    } catch (error) {
      this.logger('warn', 'portrait-session-failed', errorText(error))
      this.openBackoffUntil = this.now() + SESSION_RETRY_BACKOFF_MS
      if (saved !== undefined) {
        // The saved session is unusable (usually still live in another instance).
        // Clear it and immediately try one fresh session; stopping the whole batch
        // here would leave unfinished `in_progress` work until the next day.
        await this.deps.entries.saveSession({ sessionId: '' }).catch(() => { /* best-effort */ })
        this.logger('warn', 'portrait-session-replaced', `台账里的会话 ${saved} 已不可用，立即新建一次`)
        return await this.ensureSession()
      }
      return undefined
    }
  }

  /**
   * Dropping the reference is not enough: the agent (tools, prompt, full history) hangs off the
   * handle, so without a real dispose the heap keeps growing. Clearing the stored id sends the next
   * tick down the create branch.
   */
  private async dropSession(reason: string): Promise<void> {
    const session = this.session
    this.session = undefined
    this.sessionFaults = 0
    this.compacted = false
    this.logger('warn', 'portrait-session-dropped', `${reason}；下一拍新建会话，静态指导与每轮上下文从头组装`)
    if (session !== undefined) await session.dispose().catch(() => { /* best-effort */ })
    await this.deps.entries.saveSession({ sessionId: '' }).catch(() => { /* best-effort */ })
  }

  private async recycleIfCompacted(): Promise<void> {
    if (!this.compacted || this.session === undefined) return
    this.compacted = false
    await this.dropSession('会话发生了上下文压缩，换一个新会话（历史已撑满，堆不会自己降）')
  }

  // ─── Settlement ──────────────────────────────────────────────────────────

  /**
   * The file decides, not the model's self-report. Publishing happens after the local state is
   * settled; a publish failure is logged but never undoes `done`.
   */
  private async settle(target: PortraitTarget, outcome: PortraitTurnOutcome, written: boolean): Promise<void> {
    if (!outcome.ok) {
      this.sessionFaults += 1
      if (this.sessionFaults >= SESSION_FAULTS_TO_REBUILD) {
        await this.dropSession(`连续 ${String(this.sessionFaults)} 轮 turn 异常，重建会话（最近一次：${outcome.error}）`)
      }
    }
    if (outcome.ok && written) {
      await this.deps.entries.markDone(target.id)
      this.logger('info', 'portrait-done', `${target.id} → ${target.outputFile}（索引 ${target.indexFile} 由会话同步更新）`)
      await this.deps.entries.saveSession({ failures: 0 })
      // Portrait first, then this instance's project index; both best-effort.
      if (this.deps.publishPortrait !== undefined) {
        try {
          await this.deps.publishPortrait(target)
        } catch (error) {
          this.logger('warn', 'portrait-publish-failed', `${target.id}：上报共享库失败（本机肖像已生成）：${errorText(error)}`)
        }
      }
      if (this.deps.publishIndex !== undefined) {
        try {
          await this.deps.publishIndex()
        } catch (error) {
          this.logger('warn', 'index-publish-failed', `上报项目索引失败（本机不受影响）：${errorText(error)}`)
        }
      }
      return
    }

    const reason = outcome.ok
      ? '这一轮正常结束了，但肖像文件没有落地（文件不存在或大小为 0）'
      : outcome.error
    await this.deps.entries.markFailed(target.id, reason)
    const entry = this.deps.entries.ledger().workspaces.find(item => item.id === target.id)
    const attempts = entry?.attempts ?? 1
    this.cooldown.set(target.id, this.now() + RETRY_BACKOFF_MS * attempts)
    this.logger('warn', 'portrait-failed',
      `${target.id} 第 ${String(attempts)}/${String(PORTRAIT_MAX_ATTEMPTS)} 次失败：${reason}`
      + (attempts >= PORTRAIT_MAX_ATTEMPTS ? '（本批次不再试它）' : ''))
    await this.deps.entries.saveSession({ failures: this.sessionFaults, lastError: reason }).catch(() => { /* best-effort */ })
  }

  // ─── Timer / gates ───────────────────────────────────────────────────────

  private safeOwner(): boolean {
    // A lease read can throw; that counts as "not the owner".
    if (this.deps.isOwner === undefined) return true
    try {
      return this.deps.isOwner() !== false
    } catch {
      return false
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private armNextRun(): void {
    if (this.disposed) return
    const now = this.now()
    const at = nextPortraitRunAt(now)
    const minutes = Math.max(0, Math.round((at - now) / 60_000))
    this.logger('info', 'portrait-scheduled', `下一次全量检查 ${new Date(at).toLocaleString()}（约 ${String(minutes)} 分钟后）`)
    this.schedule(at - now, () => {
      void this.runBatch('scheduled')
        .catch((error: unknown) => { this.logger('warn', 'portrait-batch-failed', errorText(error)) })
        .finally(() => { this.armNextRun() })
    })
  }

  private schedule(delayMs: number, run: () => void | Promise<void>): void {
    if (this.disposed) return
    this.clearTimer()
    this.handle = (this.deps.setTimer ?? defaultSetTimer)(run, delayMs)
  }

  private clearTimer(): void {
    if (this.handle === undefined) return
    ;(this.deps.clearTimer ?? defaultClearTimer)(this.handle)
    this.handle = undefined
  }
}

function defaultSetTimer(run: () => void | Promise<void>, ms: number): unknown {
  const timer = setTimeout(() => {
    void Promise.resolve(run()).catch((error: unknown) => {
      consolePortraitLog('warn', 'portrait-tick-threw', errorText(error))
    })
  }, ms)
  // Unref: a sleeping portrait service must never hold the host open.
  timer.unref?.()
  return timer
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as Parameters<typeof clearTimeout>[0])
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Unref'd delay: waiting for startup readiness must not hold the host open. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
