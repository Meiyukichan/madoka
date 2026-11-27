/**
 * Execution engine: the full path of one execution from trigger to settlement.
 *
 * This module imports no session implementation: session capability is injected as
 * `SessionsFace` (in production, the regular / ephemeral session facade wrapped by
 * `spellbook-sessions.ts`), so the execution state machine can be covered exhaustively
 * by unit tests and the constraint "sessions go through spellbook" lives in the
 * interface.
 *
 * Four invariants:
 *
 * 1. **The gate completes within one mutate**: create the execution record, flip
 *    `in_progress`, check the concurrency cap. Two overlapping triggers (double click,
 *    scheduler colliding with manual) let only one through.
 * 2. **`applySettlement` is the only state-landing exit**: it only touches `running`
 *    records and is naturally idempotent.
 * 3. **Session retention follows card status**: keep while in progress / awaiting
 *    review; release only after leaving (see `session-pool.ts`).
 * 4. **Zombie cleanup only judges executions left by another process**: those started
 *    by this process are never killed by mistake.
 *
 * Two more rules tied directly to product semantics:
 *
 * - cards from `im` do not consume a concurrency slot;
 * - failures / cancellations **never** auto-retry; `releasedAt` is consumed when a run
 *   starts, so the scheduler cannot release the same window again.
 *
 * @module dsh-magica-castboard/host/exec/engine
 */
import { eventLog } from '../shared/event-log.ts'
import { randomUUID } from 'node:crypto'

import {
  ACCEPTANCE_ROUND_INSTRUCTION,
  ISSUE_COMMENTS_SECTION,
  TASK_ACCEPTANCE_SECTION,
  TASK_DISPATCH_SECTION,
  buildContexts,
  castboardAcceptanceXml,
  userInstruction,
  type TaskAttachment,
} from '../context/index.ts'
import type { LinkStore } from '../ledger/link-store.ts'
import type { ThreadComment } from '../ledger/comment-store.ts'
import type { TaskStore } from '../ledger/task-store.ts'
import { anchorOf } from '../pipeline/thread.ts'
import { resolveDefaultModel } from '../shared/default-model.ts'
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_PERMISSION,
  isImSource,
  type AcceptanceStrategy,
  type CancelRequestResult,
  type ExecutionRecord,
  type ExecutionReport,
  type PermissionMode,
  type RunRequestResult,
  type TaskRecord,
  type TurnSettlementLike,
} from '../model.ts'
import { newExecutionId } from '../rules.ts'
import { spillExecutionError } from './error-file.ts'
import { SessionPool } from './session-pool.ts'
import {
  applySettlement,
  revertToTodo,
  settlePlan,
  type SystemCommentDraft,
  type SystemCommentSink,
} from './settlement.ts'

export type ContextForm = 'snapshot' | 'instructions' | 'notice'

export interface ContextEntry {
  name: string
  text: string
  /** 内容形态；缺省 snapshot。 */
  form?: ContextForm
  /** `notice` 必填：折叠行的一行说明。 */
  summary?: string
}

export interface SessionModel {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface SessionStateLike {
  running?: boolean
  disposed?: boolean
  errorCode?: string
  error?: string | null
  pendingApprovals?: readonly unknown[]
  pendingQuestions?: readonly unknown[]
}

export interface SessionHandle {
  id: string
  firstTurn: Promise<TurnSettlementLike>
  followUp: (text: string) => Promise<TurnSettlementLike>
  /** Wake one turn with named plugin contexts only; resolves with that turn's settlement. */
  followupNamedContext: (entries: readonly ContextEntry[]) => Promise<TurnSettlementLike>
  /** Queued in `next-step`; only picked up when a turn is woken. */
  injectContext?: (entries: readonly ContextEntry[]) => boolean
  steer?: (text: string) => boolean
  pushNamedContext?: (entries: readonly ContextEntry[], options?: { wake?: 'idle' | 'always' }) => string
  resumed?: boolean
  /** Distinguishes the real causes behind "no turn/end observed". */
  getState?: () => SessionStateLike
  cancel: (cause?: unknown) => void
  dispose: () => Promise<void>
}

export interface StartSessionOptions {
  task: TaskRecord
  /** First user turn. Omit only for a named-context wake (resume with `context` only). */
  prompt?: string
  model?: SessionModel
  permission?: PermissionMode
  /** First-turn rules + references, or the named context that wakes a resumed session. */
  context?: readonly ContextEntry[]
  /** Agent-scoped system prompt sections, kept across compression. */
  sections?: readonly (ContextEntry & { order?: number })[]
}

export interface ResumeSessionOptions extends StartSessionOptions {
  sessionId: string
}

export interface SessionsFace {
  /** Card-less one-shot: run a turn, take the text, discard (router / profiling). */
  startDetached?: (options: {
    prompt: string
    title?: string
    cwd?: string
    sandbox?: string
    context?: readonly ContextEntry[]
    sections?: readonly (ContextEntry & { order?: number })[]
  }) => Promise<{ texts: readonly string[]; kind: string }>
  start: (options: StartSessionOptions) => Promise<SessionHandle>
  resume?: (options: ResumeSessionOptions) => Promise<SessionHandle>
}

export interface ThreadFace {
  list(anchorId: string): Promise<readonly ThreadComment[]>
  addSystem(anchorId: string, draft: SystemCommentDraft): Promise<unknown> | unknown
}

export interface WorkspaceFace {
  get(id: string): { path?: string } | undefined
}

export interface ExecutionDeps {
  ctx?: unknown
  tasks: TaskStore
  thread?: ThreadFace
  /** Delivery routing reads only the link table; a failed write must not fail the turn. */
  links?: Pick<LinkStore, 'patch'>
  /** Omitted = ledger only; no sessions can start. */
  sessions?: SessionsFace
  workspaces?: WorkspaceFace
  /** Omitted = the runtime cannot archive sessions. */
  archiveSession?: (sessionId: string) => Promise<void>
  attachmentsFor?: (issueId: string) => Promise<readonly TaskAttachment[]>
  /** Download one comment's attachments before the task context is built. */
  syncCommentAttachments?: (issueId: string, commentId: string) => Promise<unknown>
  /** `<storage>/.cache`; over-long execution errors are spilled here. */
  cacheDir?: string
  /** Live read, so a settings change applies to the next card. */
  acceptanceStrategies?: () => Promise<readonly AcceptanceStrategy[]>
  resolveDefaultModel?: () => SessionModel | undefined
  onIssueRunning?: (issueId: string) => void
  onSettled?: (input: { task: TaskRecord; record: ExecutionRecord; sessionId?: string }) => Promise<void> | void
  now: () => number
  /** Tells "still running here" from zombies left by another process; hot reload keeps it stable. */
  hostInstanceId: string
  hostPid?: number
  maxConcurrent?: number | (() => number)
}

export interface LiveAgentFace {
  readonly running: boolean
  readonly push: (entry: ContextEntry) => { ok: true } | { ok: false; error: string }
  /** Queue named context without waking; paired with `followUp` as the fallback tier. */
  readonly inject: (entries: readonly ContextEntry[]) => boolean
  /** Plain wake-up text, used only when named-context wake is unavailable. */
  readonly followUp: (text: string) => unknown
}

interface SteerableAgent {
  status?: string
  steer?: (message: unknown) => void
  inject?: (message: unknown) => void
  followup?: (message: unknown) => void
}

interface AgentRegistryFace {
  get?: (id: string) => SteerableAgent | undefined
}

/** In progress and awaiting review both keep their session. */
export function keepsSession(status: string): boolean {
  return status === 'in_progress' || status === 'in_review'
}

/** Most recent execution record that actually has a session; scans full records, not summaries. */
function lastSessionIdOf(task: { executions: readonly { sessionId?: string }[] }): string | undefined {
  for (let index = task.executions.length - 1; index >= 0; index -= 1) {
    const sessionId = task.executions[index]?.sessionId
    if (sessionId !== undefined) return sessionId
  }
  return undefined
}

/** Never throws. */
function note(level: 'info' | 'warn' | 'error', event: string, detail: string): void {
  eventLog(level, event, detail)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function userMessage(text: string): unknown {
  return {
    id: `msg-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * The 0.2 format needs a producer-owned `source.kind` plus a form; the GUI reads
 * `snapshot.sections` and `notice.summary`. The V4 source omits the retired
 * `plugin` field entirely.
 */
export function buildContextMessage(
  section: string,
  text: string,
  form: ContextForm = 'snapshot',
  summary?: string,
): unknown {
  const kind = section === '' ? 'castboard-context' : section
  if (kind === 'plugin') {
    throw new Error("context section must not be 'plugin': dsh session format v4 rejects it")
  }
  let source: Record<string, unknown>
  if (form === 'notice') {
    if (summary === undefined || summary.trim() === '') {
      throw new Error(`context '${kind}' uses form 'notice' but has no summary`)
    }
    source = { kind, form, summary }
  } else if (form === 'instructions') {
    source = { kind, form }
  } else {
    source = { kind, form: 'snapshot', sections: [{ name: kind, text }] }
  }
  return {
    id: `msg-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }
}

/**
 * Handles expose only followup / cancel / dispose; `steer`, `inject`, and live `status`
 * live on the Agent, so direct pushes reach it through `ctx.get('agents')`.
 */
function liveSteerableAgent(ctx: unknown, sessionId: string): SteerableAgent | undefined {
  if (ctx === null || ctx === undefined) return undefined
  const face = ctx as { get?: (name: string) => unknown }
  if (typeof face.get !== 'function') return undefined
  let registry: AgentRegistryFace | null | undefined
  try {
    registry = face.get('agents') as AgentRegistryFace | null | undefined
  } catch {
    return undefined
  }
  if (registry === null || registry === undefined || typeof registry.get !== 'function') return undefined
  try {
    return registry.get(sessionId) ?? undefined
  } catch {
    return undefined
  }
}

export class ExecutionService {
  private readonly deps: ExecutionDeps
  private readonly pool = new SessionPool()
  /** Comments already delivered in references (anchor → max createdAt; 0 = none). */
  private readonly seededUntil = new Map<string, number>()
  /** At most one retry per task for a transient turn that never started. */
  private readonly transientRetries = new Map<string, number>()
  private readonly pendingTurns = new Set<Promise<unknown>>()
  private disposed = false

  constructor(deps: ExecutionDeps) {
    this.deps = deps
  }

  /**
   * Synchronous by contract (used as an ordinary disposer). Each dispose is
   * fire-and-forget with its own catch; the pool is cleared regardless.
   */
  dispose(): void {
    this.disposed = true
    this.pool.disposeAll()
    this.transientRetries.clear()
    this.seededUntil.clear()
  }

  inFlight(): number {
    return this.pool.inFlight()
  }

  async waitForIdle(): Promise<void> {
    while (this.pendingTurns.size > 0) {
      await Promise.allSettled([...this.pendingTurns])
    }
  }

  private noteCommentsSeeded(anchorId: string, comments: readonly ThreadComment[]): void {
    const newest = comments.reduce((max, comment) => Math.max(max, comment.createdAt), 0)
    this.seededUntil.set(anchorId, newest)
  }

  /** How far this turn's references delivered comments (0 = none). */
  commentsSeededUntil(anchorId: string): number {
    return this.seededUntil.get(anchorId) ?? 0
  }

  private settlementSink(): SystemCommentSink | undefined {
    const thread = this.deps.thread
    if (thread === undefined) return undefined
    return {
      addSystem: (anchorId, draft) => thread.addSystem(anchorId, draft),
      hasFrom: async (anchorId, sessionId) =>
        (await thread.list(anchorId)).some(comment => comment.threadId === sessionId),
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Comment direct push / new-comment wake-up
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * `running` must come from dsh's `Agent.status`: our pool only knows sessions castboard
   * started, while a session opened in the GUI is never in it. A followup sent to a
   * running session is silently dropped by the driver.
   */
  liveAgentOf(sessionId: string): LiveAgentFace | undefined {
    const handle = this.pool.get(sessionId)
    const agent = liveSteerableAgent(this.deps.ctx, sessionId)
    if (handle === undefined && agent === undefined) return undefined
    return {
      running: agent?.status === 'running' || this.isRunningSession(sessionId),
      push: entry => this.pushContextTo(sessionId, handle, agent, entry),
      inject: entries => {
        try {
          return handle?.injectContext?.(entries) ?? false
        } catch {
          return false
        }
      },
      followUp: text => {
        try {
          return agent?.followup?.(text)
        } catch {
          return undefined
        }
      },
    }
  }

  // idle → followup (start a turn; the queue is otherwise unread). running → steer at
  // the next step boundary, which also avoids the driver retiring between status and
  // send. Otherwise → inject and wait for a wake-up. Send only the context message
  // itself; an extra "see below" stacks up or wastes a step.
  private pushContextTo(
    sessionId: string,
    handle: SessionHandle | undefined,
    agent: SteerableAgent | undefined,
    entry: ContextEntry,
  ): { ok: true } | { ok: false; error: string } {
    if (agent !== undefined) {
      const message = buildContextMessage(entry.name, entry.text, entry.form, entry.summary)
      try {
        if (agent.status === 'idle' && agent.followup !== undefined) {
          // Use the same producer-owned source as the running/steer branch so the
          // GUI title stays "task message", not the generic "execution request".
          agent.followup(message)
          return { ok: true }
        }
        if (agent.status === 'running') {
          // Running turns only see injected context at the next step boundary; use
          // steer so the named context interrupts this turn immediately.
          if (agent.steer !== undefined) {
            agent.steer(message)
            return { ok: true }
          }
          if (handle !== undefined && typeof handle.injectContext === 'function') {
            return handle.injectContext([entry])
              ? { ok: true }
              : { ok: false, error: 'context injection returned false' }
          }
        }
        if (agent.inject !== undefined) {
          agent.inject(message)
          note('warn', 'comment-push-fallback', `${sessionId}: status=${agent.status ?? 'unknown'}，退回 inject`)
          return { ok: true }
        }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    }
    if (handle !== undefined && typeof handle.injectContext === 'function') {
      try {
        return handle.injectContext([entry]) ? { ok: true } : { ok: false, error: 'context injection returned false' }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    }
    return { ok: false, error: 'session is alive but exposes no followup / steer / inject' }
  }

  /**
   * Wake a disposed session because new comments arrived on the source issue.
   *
   * It runs as an auxiliary, transient turn: card status is untouched (terminal cards
   * still accept delivery) and the handle is disposed afterwards, never retained —
   * otherwise the next comment would be captured by the retention rule forever.
   */
  async wakeForComment(
    taskId: string,
    commentsXml?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const context = commentsXml === undefined || commentsXml === ''
        ? undefined
        : [{
            name: ISSUE_COMMENTS_SECTION,
            text: commentsXml,
            form: 'notice' as const,
            summary: 'New comments on the source issue',
          }]
      // A live retained session wakes with the comments as its single named-context
      // message. If the session has to be resumed, omit the user prompt and pass the
      // same context: spellbook then calls agent.followup(pluginMessage), so the GUI
      // shows the injected context instead of an old "see below" follow-up bubble.
      const result = await this.start(
        taskId,
        'issue-comment',
        undefined,
        true,
        true,
        context,
        context,
      )
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  }

  /**
   * Interject into the turn that is currently running. This is not a new execution:
   * no execution record, no card status change.
   */
  async steer(taskId: string, text: string): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    const task = this.deps.tasks.get(taskId)
    if (task === undefined || task.trashedAt !== undefined) return { ok: false, error: `no task ${taskId}` }
    // Prefer the one that is running; otherwise fall back to the most recent execution
    // with a session.
    const running = [...task.executions].reverse().find(execution => execution.outcome === 'running')
    const sessionId = running?.sessionId ?? lastSessionIdOf(task)
    if (sessionId === undefined) return { ok: false, error: 'this task has no session to steer' }
    const agent = liveSteerableAgent(this.deps.ctx, sessionId)
    if (agent === undefined || typeof agent.steer !== 'function') {
      return { ok: false, error: `session ${sessionId} is not live in this host` }
    }
    try {
      agent.steer(userMessage(text))
      return { ok: true, sessionId }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  }

  /** The pool's `runs` table is the only proof that this process is driving the handle. */
  isRunningSession(sessionId: string): boolean {
    return this.pool.isRunningSession(sessionId)
  }

  /**
   * An orphan session (opened in the GUI) cannot be resumed through the facade — that
   * hits `SESSION_LIVE` — so it can only be injected.
   */
  ownsSession(sessionId: string): boolean {
    return this.pool.owns(sessionId)
  }

  private async releaseSession(sessionId: string, handle: SessionHandle, reason: string): Promise<boolean> {
    return await this.pool.release(sessionId, handle, reason)
  }

  /**
   * Releases once a card leaves in progress / awaiting review. A running turn is left
   * alone; review keeps the session because its acceptance context lives in memory.
   */
  watchReleases(): () => void {
    return this.deps.tasks.subscribe((change) => {
      if (change.kind !== 'task-moved' && change.kind !== 'task-updated' && change.kind !== 'task-deleted') return
      for (const task of change.tasks) {
        if (keepsSession(task.status)) continue
        const sessionId = lastSessionIdOf(task)
        if (sessionId === undefined) continue
        const handle = this.pool.get(sessionId)
        if (handle === undefined) continue
        if (this.pool.isRunningHandle(handle)) continue
        // The subscription callback is synchronous: it can only fire here; inside,
        // dispose is awaited to preserve ordering.
        void this.releaseSession(sessionId, handle, `卡片已进入 ${task.status}`)
      }
    })
  }

  async archiveSessions(sessionId: string): Promise<void> {
    if (this.deps.archiveSession === undefined) throw new Error('当前宿主没有会话归档能力')
    await this.deps.archiveSession(sessionId)
  }

  /**
   * Backs up {@link watchReleases}: a restart can miss subscription events, while a
   * periodic sweep collects leftover handles. Running handles are skipped.
   */
  async sweepSessions(): Promise<number> {
    let released = 0
    for (const entry of this.pool.entries()) {
      if (this.pool.isRunningHandle(entry.handle)) continue
      const task = this.deps.tasks.get(entry.taskId)
      const finished = task === undefined
        || task.trashedAt !== undefined
        || !keepsSession(task.status)
      if (!finished) continue
      const reason = task === undefined
        ? '任务已不存在'
        : task.trashedAt !== undefined ? '任务已删除' : `卡片已进入 ${task.status}`
      if (await this.releaseSession(entry.sessionId, entry.handle, reason)) released += 1
    }
    return released
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public entry points
  // ───────────────────────────────────────────────────────────────────────────

  /** Manual button, drag into progress, scheduler tick, or dispatcher. */
  async run(taskId: string, trigger: ExecutionRecord['trigger'] = 'manual'): Promise<RunRequestResult> {
    return await this.start(taskId, trigger)
  }

  /**
   * Append a turn on the same session. Live handle → followup; gone → resume from the
   * ledger's sessionId; neither → a fresh execution. Settlement is the same as `run()`.
   */
  async followUp(taskId: string, text: string): Promise<RunRequestResult> {
    return await this.start(taskId, 'followup', text)
  }

  /**
   * Append an auxiliary turn that splits new issues out. Unlike {@link followUp}, this
   * is not another execution of the task, so the card stays in review.
   */
  async dispatch(taskId: string, text: string): Promise<RunRequestResult> {
    const task = this.deps.tasks.get(taskId)
    if (task === undefined || task.trashedAt !== undefined) return { ok: false, error: `no task ${taskId}` }
    const lastSessionId = lastSessionIdOf(task)
    if (lastSessionId === undefined) return { ok: false, error: 'no retained session for issue dispatch' }
    if (this.pool.get(lastSessionId) === undefined && this.deps.sessions?.resume === undefined) {
      return { ok: false, error: 'no retained session for issue dispatch' }
    }
    const context = [{
      name: TASK_DISPATCH_SECTION,
      text,
      form: 'notice' as const,
      summary: 'Task dispatch request',
    }]
    return await this.start(taskId, 'issue-dispatch', undefined, true, false, context, context)
  }

  /**
   * Injects first, then opens an auxiliary turn so the context is actually read;
   * injecting alone would leave it in the `next-step` queue forever. No claim, no card
   * status, and `acceptanceInjectedAt` stops it from looping.
   */
  async startAcceptanceRound(
    taskId: string,
    options: { inject?: boolean } = {},
  ): Promise<RunRequestResult> {
    try {
      // Automatic rounds are idempotent: the marker means this stay in review already ran
      // (or is running) one acceptance round. A manual round may be forced again.
      const task = this.deps.tasks.get(taskId)
      if (task === undefined || task.trashedAt !== undefined) return { ok: false, error: `no task ${taskId}` }
      // No-op success: the caller ignores the ids (nothing was started).
      if (options.inject !== true && task.acceptanceInjectedAt !== undefined) {
        return { ok: true, executionId: '', sessionId: '' }
      }

      const xml = await this.acceptanceXmlFor(taskId)
      if (xml === undefined) return { ok: true, executionId: '', sessionId: '' }

      // Automatic acceptance only makes sense on the retained session: its whole point is to
      // wake that session with the named context. A missing session is not silently replaced by
      // a user-instruction fallback; a manual trigger may still open one explicitly.
      const liveSessionId = lastSessionIdOf(task)
      const live = liveSessionId === undefined ? undefined : this.pool.get(liveSessionId)
      if (live === undefined && options.inject !== true) {
        note('warn', 'acceptance-round-no-session', `${taskId}: 保留会话已不在本进程，自动验收跳过（可手动触发）`)
        return { ok: false, error: 'no retained session for the automatic acceptance round' }
      }

      const context = [{
        name: TASK_ACCEPTANCE_SECTION,
        text: xml,
        form: 'notice' as const,
        summary: 'Acceptance round requested',
      }]
      // On a retained session this wakes the turn with the named context only (no user
      // message). Without a live session, `start` falls back to the instruction + context.
      const result = await this.start(
        taskId,
        'acceptance',
        ACCEPTANCE_ROUND_INSTRUCTION,
        true,
        false,
        context,
        context,
      )
      if (result.ok) await this.markAcceptanceInjected(taskId)
      else note('warn', 'acceptance-round-not-started', `${taskId}: ${result.error}`)
      return result
    } catch (error) {
      const message = errorText(error)
      note('warn', 'acceptance-round-failed', `${taskId}: ${message}`)
      return { ok: false, error: message }
    }
  }

  /** True when a settled card entered review and still needs its one acceptance round. */
  private needsAcceptanceRound(taskId: string): boolean {
    const task = this.deps.tasks.get(taskId)
    return task !== undefined
      && task.trashedAt === undefined
      && task.status === 'in_review'
      && task.acceptanceInjectedAt === undefined
      && (task.acceptanceStrategyIds?.length ?? 0) + (task.acceptanceStrategies?.length ?? 0) > 0
  }

  /** Acceptance XML to inject for this card; `undefined` unless it is in review with strategies attached. */
  private async acceptanceXmlFor(taskId: string): Promise<string | undefined> {
    const task = this.deps.tasks.get(taskId)
    if (task === undefined || task.trashedAt !== undefined || task.status !== 'in_review') return undefined
    const ids = task.acceptanceStrategyIds ?? []
    const inline = task.acceptanceStrategies ?? []
    if (ids.length === 0 && inline.length === 0) return undefined
    let all: readonly AcceptanceStrategy[] = []
    if (ids.length > 0 && this.deps.acceptanceStrategies !== undefined) {
      try {
        all = await this.deps.acceptanceStrategies()
      } catch (error) {
        note('warn', 'acceptance-strategies-unreadable', `${taskId}: ${errorText(error)}`)
        all = []
      }
    }
    const chosen: AcceptanceStrategy[] = [
      ...ids
        .map(id => all.find(strategy => strategy.id === id))
        .filter((strategy): strategy is AcceptanceStrategy => strategy !== undefined),
      ...inline,
    ]
    if (chosen.length === 0) return undefined
    return castboardAcceptanceXml(task, chosen)
  }

  private async markAcceptanceInjected(taskId: string): Promise<void> {
    const now = this.deps.now()
    await this.deps.tasks.mutate('task-updated', (ledger) => {
      const target = ledger.tasks.find(record => record.id === taskId)
      if (target === undefined || target.acceptanceInjectedAt !== undefined) return undefined
      target.acceptanceInjectedAt = now
      target.updatedAt = now
      target.updatedBy = { kind: 'system' }
      return [target]
    }).catch((error: unknown) => {
      note('warn', 'acceptance-marker-failed', `${taskId}: ${errorText(error)}`)
    })
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Main flow
  // ───────────────────────────────────────────────────────────────────────────

  private workspacePathOf(task: TaskRecord): { ok: true; path: string } | { ok: false; error: string } {
    if (this.deps.workspaces === undefined) {
      return { ok: true, path: task.cwd ?? task.workspaceId }
    }
    const workspace = this.deps.workspaces.get(task.workspaceId)
    if (workspace === undefined) {
      return { ok: false, error: `unknown workspace ${task.workspaceId}` }
    }
    return { ok: true, path: workspace.path ?? task.cwd ?? task.workspaceId }
  }

  private concurrencyFallback(): number | undefined {
    const configured = this.deps.maxConcurrent
    if (typeof configured === 'function') {
      try {
        return configured()
      } catch {
        return undefined
      }
    }
    return configured
  }

  /** Task-pinned model wins over the default. */
  private modelOf(task: TaskRecord): SessionModel | undefined {
    if (task.model !== undefined) return { provider: task.model.provider, model: task.model.model }
    if (this.deps.resolveDefaultModel !== undefined) {
      try {
        return this.deps.resolveDefaultModel() ?? undefined
      } catch {
        return undefined
      }
    }
    return resolveDefaultModel(this.deps.ctx)
  }

  /** Read the card's comment stream; failures are logged and read as empty. */
  private async commentsOf(task: TaskRecord): Promise<readonly ThreadComment[]> {
    if (this.deps.thread === undefined) return []
    try {
      return await this.deps.thread.list(anchorOf(task))
    } catch (error) {
      note('warn', 'comments-read-failed', `${task.id}: ${errorText(error)}`)
      return []
    }
  }

  /** Attachments are material; an unreadable list must not block execution. */
  private async attachmentsOf(issueId: string): Promise<readonly TaskAttachment[]> {
    if (this.deps.attachmentsFor === undefined) return []
    try {
      return await this.deps.attachmentsFor(issueId)
    } catch (error) {
      note('warn', 'execution-attachments-failed', `${issueId}: ${errorText(error)}`)
      return []
    }
  }

  /** Comment attachments are part of the task context; sync before building it. */
  private async syncCommentAttachmentsOf(issueId: string | undefined, comments: readonly ThreadComment[]): Promise<void> {
    if (issueId === undefined || issueId === '' || this.deps.syncCommentAttachments === undefined) return
    for (const comment of comments) {
      if (comment.origin === 'local') continue
      try {
        await this.deps.syncCommentAttachments(issueId, comment.id)
      } catch (error) {
        note('warn', 'execution-comment-attachments-failed', `${issueId}/${comment.id}: ${errorText(error)}`)
      }
    }
  }

  private async notifySettled(taskId: string, executionId: string, sessionId: string): Promise<void> {
    if (this.deps.onSettled === undefined) return
    const task = this.deps.tasks.get(taskId)
    const record = task?.executions.find(entry => entry.id === executionId)
    if (task === undefined || record === undefined) return
    try {
      await this.deps.onSettled({ task, record, sessionId })
    } catch (error) {
      note('warn', 'settlement-side-effect-failed', `${taskId}: ${errorText(error)}`)
    }
  }

  /**
   * Shared implementation of `run()`, `followUp()`, and the auxiliary rounds.
   *
   * @param followUpText - user message for an appended turn; omitted = new session.
   * @param assist - auxiliary turn; leaves card status alone.
   * @param transient - dispose after the turn; never retained.
   * @param extraContext - extra named context for this turn (also delivered on resume).
   */
  private async start(
    taskId: string,
    trigger: ExecutionRecord['trigger'],
    followUpText?: string,
    assist = false,
    transient = false,
    extraContext?: readonly ContextEntry[],
    /** Wake the retained session with these named contexts instead of a user message. */
    namedContext?: readonly ContextEntry[],
  ): Promise<RunRequestResult> {
    if (this.disposed) return { ok: false, error: 'execution service is disposed' }
    const task = this.deps.tasks.get(taskId)
    if (task === undefined || task.trashedAt !== undefined) return { ok: false, error: `no task ${taskId}` }
    const workspace = this.workspacePathOf(task)
    if (!workspace.ok) return { ok: false, error: workspace.error }

    const executionId = newExecutionId()
    const now = this.deps.now()

    // ① Gate: capacity, reservation, and the status flip in one mutate. The reservation
    // condition is a running execution on this card (status is only its projection, so a
    // card dragged into progress by hand can still start).
    let gate: string | undefined
    try {
      await this.deps.tasks.mutate('execution-recorded', (ledger) => {
        const target = ledger.tasks.find(record => record.id === taskId)
        if (target === undefined || target.trashedAt !== undefined) {
          gate = `no task ${taskId}`
          return undefined
        }
        // Abandoned cards must not be revived by any path: they are gone from the board
        // and the scheduler has dropped them from the armed set; this closes the narrow
        // window where a stale page snapshot clicks Run.
        if (target.status === 'abandoned') {
          gate = `task ${taskId} was abandoned`
          return undefined
        }
        if (target.executions.some(execution => execution.outcome === 'running')) {
          gate = 'task is already in progress'
          return undefined
        }
        // Check the cap here against the fresh ledger; a pre-check using pool size would
        // lag behind. Cards from im neither take a slot nor get blocked. The limit is
        // resolved from the settings file by the caller (`maxConcurrent` is a live getter).
        if (!isImSource(target.source)) {
          const limit = this.concurrencyFallback() ?? DEFAULT_MAX_CONCURRENT
          let running = 0
          for (const other of ledger.tasks) {
            if (isImSource(other.source)) continue
            for (const execution of other.executions) {
              if (execution.outcome === 'running') running += 1
            }
          }
          if (running >= limit) {
            gate = `execution concurrency limit reached (${String(running)}/${String(limit)} running)`
            return undefined
          }
        }
        target.executions.push({
          id: executionId,
          trigger,
          startedAt: this.deps.now(),
          outcome: 'running',
          hostInstanceId: this.deps.hostInstanceId,
          ...(this.deps.hostPid !== undefined ? { hostPid: this.deps.hostPid } : {}),
          ...(assist ? { assist: true } : {}),
          ...(transient ? { transient: true } : {}),
        })
        if (!assist) {
          target.status = 'in_progress'
          // The release token is consumed once: leaving it behind would make the
          // scheduler treat a failed card returned to todo as another release window,
          // bypassing "failures do not retry automatically".
          delete target.releasedAt
          // Leaving review invalidates the injected marker; the next stay must inject again.
          delete target.acceptanceInjectedAt
        }
        target.updatedAt = this.deps.now()
        target.updatedBy = { kind: 'system' }
        return [target]
      })
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
    if (gate !== undefined) return { ok: false, error: gate }

    // The source issue follows into running, but only the attempt that won the gate
    // notifies it.
    const issueId = this.deps.tasks.get(taskId)?.issueId
    if (issueId !== undefined && issueId !== '') {
      try {
        this.deps.onIssueRunning?.(issueId)
      } catch (error) {
        note('warn', 'issue-running-failed', `${issueId}: ${errorText(error)}`)
      }
    }
    // Wake on a retained session when either a user turn or named context was supplied.
    const wakesExisting = followUpText !== undefined || namedContext !== undefined
    const resumesExisting = wakesExisting && lastSessionIdOf(task) !== undefined
    const seedComments = resumesExisting ? [] : await this.commentsOf(task)
    // Record which comments this turn's references delivered; the deliverer uses it to de-duplicate.
    this.noteCommentsSeeded(anchorOf(task), seedComments)
    if (!resumesExisting) await this.syncCommentAttachmentsOf(issueId, seedComments)
    const attachments = issueId === undefined || issueId === '' ? [] : await this.attachmentsOf(issueId)

    const sessions = this.deps.sessions
    if (sessions === undefined) {
      await applySettlement(
        this.deps.tasks,
        executionId,
        undefined,
        { outcome: 'failed', to: 'todo', error: 'no session facade configured' },
        now,
        assist,
        this.settlementSink(),
      ).catch(() => { /* best effort */ })
      return { ok: false, error: 'no session facade configured' }
    }

    let handle: SessionHandle
    let turn: Promise<TurnSettlementLike>
    const lastSessionId = lastSessionIdOf(task)
    const live = lastSessionId === undefined ? undefined : this.pool.get(lastSessionId)
    const resumeId = wakesExisting ? lastSessionId : undefined
    const model = this.modelOf(task)
    const permission = task.permission ?? DEFAULT_PERMISSION

    try {
      if (live !== undefined) {
        // A session still alive in this process must be reused: resuming a live
        // sessionId through the facade hits the "must not resume a live session" check
        // and errors out immediately.
        handle = live
        if (namedContext !== undefined) {
          // Context-only wake: the named context is the turn's initiating message, so there is
          // no user bubble and no need to inject the same context a second time.
          turn = handle.followupNamedContext(namedContext)
        } else {
          turn = handle.followUp(followUpText ?? userInstruction(task))
          // followup first, then inject: injection targets the `next-step` queue, so the
          // new turn has to exist first.
          if (extraContext !== undefined && extraContext.length > 0 && typeof handle.injectContext === 'function') {
            try {
              handle.injectContext(extraContext)
            } catch (error) {
              note('warn', 'comment-inject-failed', `${taskId}: ${errorText(error)}`)
            }
          }
        }
      } else {
        const canResume = resumeId !== undefined && sessions.resume !== undefined
        // Resume only delivers context when the caller passed extraContext; otherwise
        // the session log already holds the first-turn context and re-delivery would
        // duplicate it. A fresh session gets rules + references.
        const context = extraContext !== undefined && extraContext.length > 0
          ? extraContext
          : canResume
            ? undefined
            : buildContexts(
                await spillExecutionError(task, {
                  ...(this.deps.cacheDir === undefined ? {} : { cacheDir: this.deps.cacheDir }),
                  ...(issueId === undefined ? {} : { ownerId: issueId }),
                  log: (level, event, detail) => note(level, event, detail),
                }),
                workspace.path,
                attachments,
                seedComments,
              )
        // A named-context wake has no user turn: omit prompt and let spellbook call
        // agent.followup(pluginMessage) for each context entry.
        const prompt = followUpText
          ?? (canResume && namedContext !== undefined ? undefined : userInstruction(task))
        const base: StartSessionOptions = {
          task,
          permission,
          ...(prompt !== undefined ? { prompt } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(context !== undefined ? { context } : {}),
        }
        if (canResume) {
          handle = await sessions.resume!({ ...base, sessionId: resumeId })
        } else {
          handle = await sessions.start({ ...base, prompt: prompt ?? userInstruction(task) })
        }
        turn = handle.firstTurn
      }
    } catch (error) {
      const message = errorText(error)
      await applySettlement(
        this.deps.tasks,
        executionId,
        undefined,
        { outcome: 'failed', to: 'todo', error: message.slice(0, 500) },
        this.deps.now(),
        assist,
        this.settlementSink(),
      ).catch(() => { /* best effort */ })
      return { ok: false, error: message }
    }

    const sessionId = handle.id
    /**
     * Cancelled inside the startup window: tear down this attempt, but do not kill a
     * session that was already alive — an appended turn may be a session the user is using.
     */
    const releaseStarted = async (): Promise<void> => {
      // The turn's promise is no longer awaited; attach a handler to its rejection.
      void turn.catch(() => { /* abandoned */ })
      if (live !== undefined) {
        try {
          handle.cancel({ kind: 'hook', reason: 'castboard:startup-cancelled' })
        } catch {
          /* best effort */
        }
        return
      }
      try {
        await handle.dispose()
      } catch {
        /* best effort */
      }
    }

    // ② Recheck before registering: a cancel inside the startup window has already
    // settled the record, and a cancelled card must not get a live session — otherwise
    // the card sits in todo while the session burns tokens.
    let stillRunning = false
    try {
      stillRunning = await this.deps.tasks.read(ledger =>
        ledger.tasks.some(record => record.executions.some(
          execution => execution.id === executionId && execution.outcome === 'running',
        )))
    } catch (error) {
      await releaseStarted()
      const message = errorText(error)
      note('warn', 'execution-recheck-failed', `${taskId}: ${message}`)
      // The record still says running when the recheck fails; settle it or the
      // concurrency slot stays occupied forever.
      await applySettlement(
        this.deps.tasks,
        executionId,
        sessionId,
        { outcome: 'failed', to: 'todo', error: message.slice(0, 500) },
        this.deps.now(),
        assist,
        this.settlementSink(),
      ).catch(() => { /* best effort */ })
      return { ok: false, error: message }
    }
    if (!stillRunning) {
      await releaseStarted()
      return { ok: false, error: 'cancelled during startup' }
    }

    // ③ One mutate records the sessionId and the claimer. It may write nothing (a
    // cancel arrived after the recheck); the session must not be registered then, or the
    // card sits in todo while the session runs.
    let registered = false
    try {
      const written = await this.deps.tasks.mutate('execution-recorded', (ledger) => {
        const target = ledger.tasks.find(record => record.id === taskId)
        if (target === undefined) return undefined
        const execution = target.executions.find(entry => entry.id === executionId)
        if (execution === undefined || execution.outcome !== 'running') return undefined
        // Regular turns require in_progress (the gate just flipped it); auxiliary turns
        // stay in in_review, so allow them or every dispatch ends as "cancelled during
        // startup".
        if (execution.assist !== true && target.status !== 'in_progress') return undefined
        execution.sessionId = sessionId
        // Auxiliary turns do not claim: they did not flip the card, and writing a claimer
        // would display the wrong status.
        if (execution.assist !== true) {
          target.claimedBy = sessionId
          target.claimedAt = this.deps.now()
        }
        target.updatedAt = this.deps.now()
        return [target]
      })
      registered = written.changed.length > 0
    } catch (error) {
      await releaseStarted()
      const message = errorText(error)
      note('error', 'execution-register-failed', `${taskId}: ${message}`)
      await applySettlement(
        this.deps.tasks,
        executionId,
        sessionId,
        { outcome: 'failed', to: 'todo', error: message.slice(0, 500) },
        this.deps.now(),
        assist,
        this.settlementSink(),
      ).catch(() => { /* best effort */ })
      return { ok: false, error: message }
    }
    if (!registered) {
      await releaseStarted()
      return { ok: false, error: 'cancelled during startup' }
    }

    // ④ Relationship table: the authoritative write for `assigneeSessionId`. A failed
    // write is only logged; startup reconciliation and fallback recomputation still
    // cover delivery, so it must not fail the turn.
    if (this.deps.links !== undefined) {
      const linkIssueId = this.deps.tasks.get(taskId)?.issueId
      if (linkIssueId !== undefined && linkIssueId !== '') {
        try {
          await this.deps.links.patch(linkIssueId, { assigneeTaskId: taskId, assigneeSessionId: sessionId })
        } catch (error) {
          note('warn', 'execution-link-failed', `${linkIssueId}: ${errorText(error)}`)
        }
      }
    }

    // ⑤ Settlement observation: `kind` is the only truth about the outcome (see `settlePlan`).
    this.pool.registerRun(executionId, handle)
    if (!transient) {
      try {
        await this.pool.retain(taskId, sessionId, handle)
      } catch (error) {
        note('warn', 'session-retain-failed', `${sessionId}: ${errorText(error)}`)
      }
    }
    /** Machine-readable reason when the turn did not start (`SESSION_LIVE`, etc.). */
    let settlementErrorCode: string | undefined
    /** Whether this settlement left the card in review and needing its acceptance round. */
    let acceptancePending = false

    const settled = turn
      .then(async (settlement) => {
        if (settlement.kind === undefined) {
          const state = handle.getState?.()
          settlementErrorCode = state?.errorCode
          note(
            'warn',
            'settlement-no-turn-end',
            `${taskId}（${trigger}${transient ? '/瞬态' : ''}）: errorCode=${state?.errorCode ?? '-'} error=${state?.error ?? '-'}`,
          )
        }
        const landed = await applySettlement(
          this.deps.tasks,
          executionId,
          sessionId,
          settlePlan(settlement),
          this.deps.now(),
          assist,
          this.settlementSink(),
        )
        if (landed) await this.notifySettled(taskId, executionId, sessionId)
        // The card entered review: the acceptance round is a first-class auxiliary execution,
        // started below after this run releases its slot.
        acceptancePending = this.needsAcceptanceRound(taskId)
      })
      .catch(async (error: unknown) => {
        note('error', 'settlement-threw', `${taskId}: ${errorText(error)}`)
        await applySettlement(
          this.deps.tasks,
          executionId,
          sessionId,
          { outcome: 'failed', to: 'todo', error: '结算过程异常' },
          this.deps.now(),
          assist,
          this.settlementSink(),
        ).catch((fallbackError: unknown) => {
          note('error', 'settlement-fallback-failed', `${taskId}: ${errorText(fallbackError)}`)
        })
      })
      .finally(async () => {
        try {
          this.pool.finishRun(executionId)
          if (transient) {
            // The acceptance context lives in the memory `next-step` queue and dies with
            // the session, while the persisted `acceptanceInjectedAt` would block
            // re-injection — clear the marker before disposing.
            await this.dropStaleAcceptanceMarker(taskId).catch((error: unknown) => {
              note('warn', 'acceptance-marker-reset-failed', `${taskId}: ${errorText(error)}`)
            })
            if (live === undefined) {
              note('info', 'session-released', `${sessionId}：瞬态轮结束（未进常驻池）`)
              await handle.dispose().catch((error: unknown) => {
                note('warn', 'session-release-failed', `${sessionId}: ${errorText(error)}`)
              })
            } else {
              // Reused a handle from the pool: its retention is governed by card status,
              // not by this turn.
              note('info', 'comment-turn-kept-session', `${sessionId}：复用池内句柄，本轮结束不释放`)
            }
            await this.retryTransientIfUnread(
              taskId,
              executionId,
              () => this.start(taskId, trigger, followUpText, assist, transient, extraContext, namedContext),
              settlementErrorCode,
            )
            return
          }
          const settledTask = this.deps.tasks.get(taskId)
          if (settledTask === undefined || settledTask.trashedAt !== undefined) {
            await this.releaseSession(sessionId, handle, settledTask === undefined ? '任务已不存在' : '任务已删除')
            return
          }
          if (!keepsSession(settledTask.status)) {
            await this.releaseSession(sessionId, handle, `卡片已进入 ${settledTask.status}`)
            return
          }
          // Card stayed in review: run the acceptance round as a normal auxiliary execution
          // (own record, own settlement); it wakes the retained session with the named context.
          if (acceptancePending) void this.startAcceptanceRound(taskId)
        } catch (error) {
          note('warn', 'settlement-cleanup-failed', `${taskId}: ${errorText(error)}`)
        }
      })

    this.pendingTurns.add(settled)
    void settled.finally(() => { this.pendingTurns.delete(settled) })
    return { ok: true, executionId, sessionId }
  }

  /**
   * Clear an injected acceptance marker whose context went away with the session.
   *
   * It qualifies when `acceptanceInjectedAt` is set but no acceptance round ever
   * succeeded — the context vanished before it was read, so the next settlement must
   * inject it again.
   */
  private async dropStaleAcceptanceMarker(taskId: string): Promise<void> {
    await this.deps.tasks.mutate('task-updated', (ledger) => {
      const task = ledger.tasks.find(record => record.id === taskId)
      if (task === undefined || task.acceptanceInjectedAt === undefined) return undefined
      const ran = task.executions.some(execution => execution.trigger === 'acceptance' && execution.outcome === 'succeeded')
      if (ran) return undefined
      delete task.acceptanceInjectedAt
      task.updatedAt = this.deps.now()
      task.updatedBy = { kind: 'system' }
      note('info', 'acceptance-marker-reset', `${taskId}: 瞬态轮收掉了会话，标记清掉等下次结算重投`)
      return [task]
    })
  }

  /**
   * Retry once when a transient turn failed to start (the comment is still in the stream).
   *
   * Only "no turn/end observed" qualifies: the resume did not drive, which says nothing
   * about the content, so a retry is meaningful. One retry per task avoids a hot loop
   * while the session stays unavailable; `SESSION_LIVE` means resume would hit the same
   * wall, so give up at once.
   */
  private async retryTransientIfUnread(
    taskId: string,
    executionId: string,
    retry: () => Promise<unknown>,
    errorCode?: string,
  ): Promise<void> {
    const settled = this.deps.tasks.get(taskId)?.executions.find(entry => entry.id === executionId)
    const noTurnEnd = settled?.outcome === 'failed' && (settled.error ?? '').includes('turn/end')
    if (!noTurnEnd) {
      this.transientRetries.delete(taskId)
      return
    }
    if (errorCode === 'SESSION_LIVE') {
      this.transientRetries.delete(taskId)
      note('warn', 'transient-wake-session-live', `${taskId}: 会话仍活着（SESSION_LIVE），不重试`)
      return
    }
    const used = this.transientRetries.get(taskId) ?? 0
    if (used >= 1) {
      this.transientRetries.delete(taskId)
      note('warn', 'transient-wake-gave-up', `${taskId}: 重试后仍未跑起来，放弃（评论仍在 JSONL 里）`)
      return
    }
    this.transientRetries.set(taskId, used + 1)
    note('warn', 'transient-wake-retry', `${taskId}: 上一轮没观察到 turn/end，重试一次`)
    await retry()
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Cancel, reconcile, report
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Cancel the execution currently running on a card.
   *
   * Uses `cancel()` (aborts only the current turn, keeps the inbox) rather than dispose,
   * so the turn goes through normal settlement (`aborted` → `applySettlement`), the
   * single landing exit. The session survives in dsh and the card's session entry still
   * opens.
   */
  async cancel(taskId: string): Promise<CancelRequestResult> {
    const task = this.deps.tasks.get(taskId)
    if (task === undefined) return { ok: false, error: `no task ${taskId}` }
    const running = [...task.executions].reverse().find(execution => execution.outcome === 'running')
    if (running === undefined) return { ok: false, error: 'no running execution' }

    const handle = this.pool.handleOfRun(running.id)
    if (handle !== undefined) {
      try {
        handle.cancel({ kind: 'hook', reason: 'castboard:cancel' })
      } catch {
        /* best effort; the settlement observer still lands it */
      }
      return { ok: true, executionId: running.id }
    }

    // Inside the startup window (session created, not yet pooled): settle as cancelled;
    // start's recheck will see it and destroy the new session.
    await applySettlement(
      this.deps.tasks,
      running.id,
      undefined,
      { outcome: 'cancelled', to: 'todo', error: '用户在启动阶段取消' },
      this.deps.now(),
      running.assist === true,
      this.settlementSink(),
    ).catch((error: unknown) => {
      note('warn', 'startup-cancel-settle-failed', `${taskId}: ${errorText(error)}`)
    })
    return { ok: true, executionId: running.id }
  }

  /**
   * Startup reconciliation: a `running` execution left by another host process can never
   * settle (its observer died with that process), so mark it failed and return the card
   * to todo.
   *
   * Candidates come from the index's `hasRunning` flag, then go through the unified
   * write one at a time. `hostInstanceId` prevents false kills: a hot reload keeps the
   * same process id, so executions still running here are skipped.
   */
  async reconcile(): Promise<number> {
    // Load first: summaries do not trigger lazy loading, so a cold start would read an
    // empty index and never clear zombie runs, which would fill the concurrency slots.
    await this.deps.tasks.load()
    const now = this.deps.now()
    let repaired = 0
    const candidates = this.deps.tasks.summaries().filter(summary => summary.hasRunning)
    for (const summary of candidates) {
      const written = await this.deps.tasks.mutate('execution-recorded', (ledger) => {
        const task = ledger.tasks.find(record => record.id === summary.id)
        if (task === undefined) return undefined
        let dirty = 0
        for (const execution of task.executions) {
          if (execution.outcome !== 'running') continue
          if (execution.hostInstanceId === this.deps.hostInstanceId) continue
          execution.outcome = 'failed'
          execution.error = 'interrupted by host restart'
          execution.endedAt = now
          dirty += 1
        }
        if (dirty === 0) return undefined
        revertToTodo(task, now)
        // revertToTodo only bumps the timestamp while still in_progress; the execution
        // record already changed to failed here, so bump it unconditionally.
        task.updatedAt = now
        return [task]
      })
      repaired += written.changed.length > 0 ? 1 : 0
    }
    return repaired
  }

  /**
   * Write path for execution reports (the storage face of `castboard_execution_report`).
   *
   * Prefer the execution this session is currently running; a finished session still
   * holding the card may backfill its most recent successful execution. Bumping
   * `updatedAt` is required or the detail panel will not refetch.
   *
   * @returns the task and execution id attached; `undefined` when no owner is found.
   */
  async recordExecutionReport(
    sessionId: string,
    report: ExecutionReport,
  ): Promise<{ taskId: string; executionId: string } | undefined> {
    if (sessionId === '') return undefined
    const now = this.deps.now()
    const found: { value?: { taskId: string; executionId: string } } = {}
    await this.deps.tasks.mutate('execution-recorded', (ledger) => {
      for (const task of ledger.tasks) {
        if (task.trashedAt !== undefined) continue
        const execution = [...task.executions].reverse().find(entry =>
          entry.sessionId === sessionId && entry.outcome === 'running')
        if (execution === undefined) continue
        execution.report = report
        task.updatedAt = now
        task.updatedBy = { kind: 'agent', sessionId }
        found.value = { taskId: task.id, executionId: execution.id }
        return [task]
      }
      return undefined
    })
    if (found.value !== undefined) return found.value

    await this.deps.tasks.mutate('execution-recorded', (ledger) => {
      for (const task of ledger.tasks) {
        if (task.trashedAt !== undefined || task.status === 'archived') continue
        const last = task.executions[task.executions.length - 1]
        if (last === undefined || last.sessionId !== sessionId) continue
        const owns = last.outcome === 'succeeded'
        const holds = task.claimedBy === sessionId
        if (!owns && !holds) continue
        last.report = report
        task.updatedAt = now
        task.updatedBy = { kind: 'agent', sessionId }
        found.value = { taskId: task.id, executionId: last.id }
        return [task]
      }
      return undefined
    })
    return found.value
  }
}
