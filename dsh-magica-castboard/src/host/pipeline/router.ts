/**
 * Pending-issue converter: hands issues that are not settled yet (`accepted` / `pending`) to one resident session,
 * which turns them into task cards.
 *
 * ## Single flight
 *
 * The resident session is serial: while one turn runs, the next can only queue. Queueing pushes concurrency
 * problems into the session, so exactly one issue is dispatched at a time -- if a turn is still running, this tick is skipped and the next issue is taken after settlement.
 *
 * ## One tick
 *
 * ```
 * tick()
 *  ├─ not lease owner / auto-routing off / a turn in flight / session-open backoff -> reschedule next tick
 *  ├─ load ledger; reset "stuck in routing with no task" orphans to pending
 *  ├─ session compacted -> replace it
 *  ├─ pick candidate: accepted first -> pending; within a group URGENCIES order -> createdAt ascending (skip backoff)
 *  ├─ urgency=direct and the wiring layer provided a direct entry -> convert without creating or waking a session
 *  ├─ dependency gate: every dependsOn must be success to continue (see blockingDependency)
 *  ├─ local markRouting + (cloud-originated only) remote issueRouting
 *  ├─ record routerSessionId on the issue details, lastIssueId in the index's router block
 *  ├─ prepare live material -> renderReferences (fall back to local ledger rendering on failure)
 *  ├─ session.run(routerInstruction(id), references)
 *  └─ settle: converted -> reset failure count; not converted -> back to pending with backoff (abandoned at the limit)
 * ```
 *
 * ## "Converted" criterion
 *
 * The issue details have a non-empty `assigneeTask`. The session only fills in data and calls the conversion tool,
 * and the tool writes both the task ledger and this field; the service trusts that fact and never parses what the model said.
 *
 * ## Session faults
 *
 * A failed resume, an empty `saved`, or two consecutive turn faults all drop the in-memory handle and rebuild it next
 * tick; after a real dispose the index's `sessionId` is cleared to an empty string, and a new session assembles static
 * guidance and per-turn material from scratch. Context compaction also replaces the session -- history has hit its cap, and reuse only gets more expensive.
 *
 * @module dsh-magica-castboard/host/pipeline/router
 */
import {
  MAX_DEPENDS_ON,
  URGENCIES,
  type IssueRecord,
  type IssueSummary,
  type Urgency,
} from '../model.ts'
import type { IssueStore } from '../ledger/issue-store.ts'
import { castboardIssueReferences, routerInstruction, routerReminder } from '../context/renders.ts'
import { eventLog } from '../shared/event-log.ts'

/** Default polling interval (ms): the same cadence as shared-library delta sync. */
export const DEFAULT_ROUTER_INTERVAL_MS = 3_000

/** Default max attempts: stop auto-dispatch at the third failure and mark `abandoned`. */
export const DEFAULT_MAX_ATTEMPTS = 3

/** Backoff base after a failure: the n-th failure waits n x this value. */
const RETRY_STEP_MS = 60_000

/**
 * A normal turn may finish while its sub-agent is still running the conversion.
 * Retrying at the ordinary 60s backoff would inject a second follow-up before the
 * first sub-agent can call `castboard_issue_task`; give it a grace window first.
 */
const CONVERSION_GRACE_MS = 120_000

/** Consecutive "the turn itself faulted" rounds before the session is considered broken and rebuilt. */
const FAULT_LIMIT = 2

/** Retry interval after a failed session open: failures usually come from config, so no rebuild every 3 seconds. */
const OPEN_RETRY_MS = 30_000

/** Re-check interval after being blocked by a dependency (backoff, not a cache). */
const DEPENDENCY_HOLD_MS = 30_000

/** Safety cap when a tick skips blocked candidates; each skip also sets a cooldown. */
const MAX_CANDIDATES_PER_TICK = 10

export type RouterTurnResult = { ok: true } | { ok: false; error: string }

/**
 * Current state of one dependency.
 *
 * `found: false` = not found (missing / cleaned up / owned by someone else) -- treated as "ignore", never blocking.
 */
export interface DependencyProbe {
  issueId: string
  /** Whether it was found online. */
  found: boolean
  /** Online status (only when `found`; may be dirty data, so typed as `string`). */
  status?: string
}

/**
 * Narrow interface to the resident session -- implemented by the wiring layer with the host session facade.
 *
 * Only the four things this service actually uses: id, whether resume succeeded, run one turn, dispose.
 */
export interface RouterSessionFace {
  /** Session id (minted by the host on creation, possibly different from the one passed in). */
  readonly id: string
  readonly resumed: boolean
  /**
   * Run one turn: inject `references` as this turn's material, then send the instruction and await settlement.
   *
   * @param instruction - This turn's user instruction (contains this issueId).
   * @param references - The issue's `<castboard_issue_references>` text.
   */
  run(instruction: string, references: string): Promise<RouterTurnResult>
  dispose(): Promise<void>
}

export type RouterLog = (level: 'info' | 'warn', event: string, detail?: string) => void

export interface RouterTimers {
  set: (run: () => void | Promise<void>, delayMs: number) => unknown
  clear: (handle: unknown) => void
}

export interface IssueRouterDeps {
  readonly issues: IssueStore
  /**
   * Open or resume the resident session.
   *
   * @param sessionId - Session id recorded in the index; `undefined` = never created.
   * @param onCompacted - Fired when this session compacts its context (the service swaps in a new session next tick).
   */
  readonly openSession: (sessionId: string | undefined, onCompacted?: () => void) => Promise<RouterSessionFace>
  /** Advance the remote side to `routing` (called only for cloud-originated issues). */
  readonly issueRouting?: (issueIds: readonly string[]) => Promise<void>
  /**
   * Remote abandon: after the attempt limit is reached without conversion, this issue is no longer auto-dispatched.
   *
   * The reason is recorded only locally in `routeError`; that remote entry point changes status only and accepts no meta.
   */
  readonly issueAbandoned?: (issueId: string, reason: string) => Promise<void>
  readonly isOwner?: () => boolean
  /**
   * Auto-routing switch (board setting `autoRoute`, read live by the wiring layer).
   *
   * Returning `false` skips dispatch for this tick and leaves issues queued for a human -- same as "no candidate",
   * except it logs a pause once (only when the switch changes, not every tick). Omitted = always on.
   */
  readonly enabled?: () => boolean
  /**
   * Direct path (`urgency: 'direct'`): skip planning and turn issue fields into a task directly.
   *
   * Omitted = direct does not apply, and these issues go through normal planning.
   */
  readonly directRoute?: (issueId: string) => Promise<{ readonly kind: string }>
  /**
   * Write "why it is stuck on dependencies" into an issue comment (optional).
   *
   * Called once per change of blocking reason, never every tick. Omitted = log only.
   */
  readonly commentBlocked?: (issueId: string, body: string) => Promise<void>
  /**
   * Look up the current state of a batch of dependency issues (for the dependency gate).
   *
   * The wiring layer queries the shared library directly by issueId: another owner's issue returns 404, so "not found"
   * must be expressed as `{ found: false }` and must not throw. Omitted = no dependency gate (offline / tests).
   */
  readonly dependsOnStatuses?: (issueIds: readonly string[]) => Promise<readonly DependencyProbe[]>
  /**
   * Synchronize the issue target's two roles before claim (assigner/input ready for
   * execution, assignee/output cached for viewing). Omitted = no cloud attachment sync.
   */
  readonly syncAttachments?: (issueId: string) => Promise<void>
  /**
   * Render this issue's `<castboard_issue_references>` text.
   *
   * A separate dependency because live material must be prepared before dispatch (download input artifacts, query
   * online comments, refresh the project catalog) -- that is async I/O and network and does not belong in this
   * service's decision logic. Omitted = render from local ledger fields only.
   */
  readonly renderReferences?: (issue: IssueRecord) => Promise<string>
  readonly now?: () => number
  readonly intervalMs?: number
  /** Max attempts (default {@link DEFAULT_MAX_ATTEMPTS}). */
  readonly maxAttempts?: number
  readonly timers?: RouterTimers
  readonly log?: RouterLog
}

const consoleRouterLog: RouterLog = (level, event, detail) => {
  eventLog(level, event, detail ?? '')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function blank(value: string | undefined): boolean {
  return value === undefined || value === ''
}

/** Candidate urgency weight: array order is the weight; dirty values outside the domain sort last. */
function urgencyWeight(urgency: Urgency): number {
  const position = (URGENCIES as readonly string[]).indexOf(urgency)
  return position === -1 ? URGENCIES.length : position
}

function statusWeight(status: IssueSummary['status']): number {
  return status === 'accepted' ? 0 : 1
}

function tooManyDependencies(count: number): string {
  return `依赖数量 ${String(count)} 超过上限 ${String(MAX_DEPENDS_ON)}（疑似滥用），不进入规划；`
    + '确实需要这么多前置任务时，请拆成多条 issue 串成短链'
}

/**
 * Fold dependency probes into a blocking reason; `undefined` when all are satisfied (or all not found).
 *
 * Dependencies that cannot be found are ignored: not reported yet / cleaned up / another owner's 404 must not block forever.
 */
function unmetDependency(probes: readonly DependencyProbe[]): string | undefined {
  const unresolved = probes.filter(entry => entry.found && entry.status !== 'success')
  if (unresolved.length === 0) return undefined
  const listed = unresolved.map(entry => `${entry.issueId}（${entry.status ?? '状态未知'}）`).join('、')
  const missing = probes.filter(entry => !entry.found).map(entry => entry.issueId)
  if (missing.length === 0) return `依赖尚未全部 success：${listed}`
  return `依赖尚未全部 success：${listed}；另有 ${String(missing.length)} 个依赖查不到（已忽略）：${missing.join('、')}`
}

function blockedComment(reason: string): string {
  return `【依赖未满足，暂不进入规划】${reason}\n\n`
    + '本条 issue 保持原状态（未被标记失败/退回）。依赖全部 success 后会自动重新进入规划，无需人工干预；'
    + '若依赖已被撤销，请更新本条 issue 的 dependsOn。'
}

/**
 * Resident router: one timer + one in-memory session handle.
 */
export class IssueRouterService {
  private disposed = false
  private started = false
  private inFlight = false
  private handle: unknown
  /** In-memory session (lazily opened; set to undefined when broken and rebuilt next tick). */
  private session: RouterSessionFace | undefined
  /** Consecutive turn-fault count (rebuild the session at the threshold). */
  private turnFaults = 0
  /** Failure backoff: issue id -> time it may be retried (in memory; cleared on restart, which is acceptable). */
  private readonly cooldowns = new Map<string, number>()
  /**
   * Issue ids whose full routing context was successfully delivered to a session.
   *
   * Only a retry on the same session may drop the references and wake with the
   * issue-id reminder. A newly opened session (including after a warm-up failure)
   * must get the full context again.
   */
  private readonly injectedSessions = new Map<string, string>()
  /** Backoff deadline after a failed session open (avoids a rebuild every 3 seconds flooding the log). */
  private openRetryAt = 0
  /** Last tick's status signature -- log only on change, avoiding a line every 3 seconds. */
  private lastSnapshot = ''
  /** Whether auto-routing is currently off (only to log the switch once). */
  private paused = false
  /** Whether the current session compacted (replace it next tick). */
  private compacted = false
  /**
   * Last blocking reason per issue -- log / comment only when it changes.
   *
   * Blocked candidates stay in the pool (only backed off), so without this table the same comment would be poured
   * into the issue every 30 seconds. Cleared when unblocked, so a later block can be explained again.
   */
  private readonly blockedNotes = new Map<string, string>()
  private readonly deps: IssueRouterDeps
  private readonly logger: RouterLog

  constructor(deps: IssueRouterDeps) {
    this.deps = deps
    this.logger = deps.log ?? consoleRouterLog
  }

  private get intervalMs(): number {
    const value = this.deps.intervalMs
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : DEFAULT_ROUTER_INTERVAL_MS
  }

  private get maxAttempts(): number {
    const value = this.deps.maxAttempts
    return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_MAX_ATTEMPTS
  }

  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    this.armTimer(0)
  }

  /** Stop the timer and release the session (an in-flight turn finishes on its own). */
  dispose(): void {
    this.disposed = true
    this.stopTimer()
    const live = this.session
    this.session = undefined
    if (live !== undefined) void live.dispose().catch(() => { /* best effort */ })
  }

  async tick(): Promise<void> {
    if (this.disposed) return
    if (!this.ownerEligible()) {
      this.armTimer(this.intervalMs)
      return
    }
    // Auto-routing is off: dispatch nothing this tick. Issues stay queued and continue on the next tick after it is re-enabled.
    if (!this.autoRouteEnabled()) {
      this.reportPaused()
      this.armTimer(this.intervalMs)
      return
    }
    this.reportResumed()
    if (this.inFlight) {
      this.armTimer(this.intervalMs)
      return
    }
    // Back off while session opens keep failing; otherwise a rebuild every 3 seconds floods the log with no benefit.
    if (this.now() < this.openRetryAt) {
      this.armTimer(this.intervalMs)
      return
    }
    this.stopTimer()
    this.inFlight = true
    try {
      await this.runTick()
    } catch (error) {
      this.logger('warn', 'router-tick-failed', errorText(error))
    } finally {
      this.inFlight = false
      this.armTimer(this.intervalMs)
    }
  }

  private async runTick(): Promise<void> {
    await this.deps.issues.load()
    await this.healStranded()
    this.reportSnapshot()
    // The session compacted -> swap in a new one.
    await this.replaceCompactedSession()
    const next = this.pickNext()
    if (next === undefined) return
    // A dependency-blocked candidate gets a cooldown; try the next eligible candidate
    // in the same tick instead of starving the whole queue behind it.
    for (let attempt = 0; attempt < MAX_CANDIDATES_PER_TICK; attempt += 1) {
      const candidate = attempt === 0 ? next : this.pickNext()
      if (candidate === undefined) return
      if (await this.dispatch(candidate) === 'dispatched') return
    }
  }

  private async dispatch(candidate: IssueSummary): Promise<'dispatched' | 'blocked'> {
    // Dependency gate before both paths: a blocked issue must never hold the head of
    // the queue, and direct cards must not bypass the same rule.
    const blocked = await this.blockingDependency(candidate.id)
    if (blocked !== undefined) {
      await this.holdForDependencies(candidate.id, blocked)
      return 'blocked'
    }

    // Claim means "this issue's local material is about to be used": synchronize
    // both directions once, so state/claim/card never download the same file twice.
    await this.deps.syncAttachments?.(candidate.id).catch((error: unknown) => {
      this.logger('warn', 'router-attachments-sync-failed', `${candidate.id}: ${errorText(error)}`)
    })

    // Direct runs after the dependency gate and before the session: it needs no
    // planning session, but it still needs the same live material (input artifacts,
    // online comments, workspace catalog) as the normal path.
    const direct = this.deps.directRoute
    if (candidate.status !== 'routing' && candidate.urgency === 'direct' && direct !== undefined) {
      const issue = await this.deps.issues.get(candidate.id)
      if (issue !== undefined) await this.buildReferences(issue)
      const outcome = await direct(candidate.id)
      this.logger('info', 'router-direct', `${candidate.id}: ${outcome.kind}`)
      const reason = 'reason' in outcome && typeof outcome.reason === 'string' ? outcome.reason : ''
      if (outcome.kind === 'skipped' && reason.startsWith('dependencies not satisfied')) {
        await this.holdForDependencies(candidate.id, reason)
        return 'blocked'
      }
      return 'dispatched'
    }
    const session = await this.acquireSession()
    if (session === undefined) return 'dispatched'
    await this.dispatchWithSession(candidate, session)
    return 'dispatched'
  }

  private async dispatchWithSession(candidate: IssueSummary, session: RouterSessionFace): Promise<void> {
    const issueId = candidate.id
    const retry = candidate.status === 'routing'
    // Cloud first: a failed cloud write leaves the local issue pending and the next tick
    // retries it; never mark routing only locally.
    if (!retry) await this.announceRouting(issueId)
    const marked = retry
      ? await this.deps.issues.get(issueId)
      : await this.deps.issues.markRouting(issueId)
    if (marked === undefined || (!retry && marked.status !== 'routing')) {
      this.logger('warn', 'router-mark-skipped', `issue ${issueId} 状态已变（可能是人手动改的），跳过这一条`)
      return
    }
    await this.deps.issues.update(issueId, draft => {
      draft.routerSessionId = session.id
      draft.routeNextTryAt = undefined
    })
    await this.deps.issues.saveRouter({ sessionId: session.id, lastIssueId: issueId, failures: 0 })
    this.logger('info', 'router-dispatch', `${issueId}（${marked.status}/${marked.urgency}）→ session ${session.id}`)

    const retryWake = this.injectedSessions.get(issueId) === session.id
    const references = retryWake ? '' : await this.buildReferences(marked)
    const turn = await this.runTurn(
      session,
      marked.id,
      references,
      retryWake ? routerReminder(marked.id) : routerInstruction(marked.id),
    )
    if (turn.injected) this.injectedSessions.set(issueId, session.id)
    await this.finishTurn(issueId, turn.outcome, turn.injected)
  }

  private async announceRouting(issueId: string): Promise<void> {
    const routing = this.deps.issueRouting
    if (routing === undefined) throw new Error('共享库不可用：不能把 issue 标记为 routing')
    await routing([issueId])
  }

  /**
   * Run this turn. A throw from `run()` must also fold into a failed outcome -- if it bubbled to the tick's catch,
   * settlement would be skipped and the issue would stay in routing forever (routing is not in the candidate pool).
   */
  private async runTurn(
    session: RouterSessionFace,
    issueId: string,
    references: string,
    instruction = routerInstruction(issueId),
  ): Promise<{ outcome: RouterTurnResult; injected: boolean }> {
    try {
      const outcome = await session.run(instruction, references)
      return { outcome, injected: true }
    } catch (error) {
      return { outcome: { ok: false, error: `会话这一轮直接抛错：${errorText(error)}` }, injected: false }
    }
  }

  /**
   * Replace the session after context compaction.
   *
   * Do not rotate by turn count / time (that would interrupt long work): rotate only after real compaction -- at that
   * point history is at its cap, reuse only gets more expensive, and the host heap does not shrink on compaction.
   * Progress lives in the ledger, so swapping loses no state.
   */
  private async replaceCompactedSession(): Promise<void> {
    if (!this.compacted || this.session === undefined) return
    this.compacted = false
    await this.discardSession('会话发生了上下文压缩，换一个新会话（历史已撑满，堆不会自己降）')
  }

  /**
   * Self-heal: reset orphan issues "stuck in routing without assigneeTask" back to `pending`.
   *
   * Such records are left by a dispatch that did not finish (process killed, session cannot open, turn threw) --
   * they are not in the candidate pool (routing is not a candidate) and never return to pending by themselves, so
   * they would stay stuck forever. Scanning summaries every tick is cheap.
   */
  private async healStranded(): Promise<void> {
    const stranded = this.deps.issues.summaries().flatMap(row =>
      row.status === 'routing'
      && blank(row.assigneeTask)
      && row.routeNextTryAt === undefined
        ? [row.id]
        : [])
    for (const id of stranded) {
      await this.deps.issues.update(id, draft => {
        draft.status = 'pending'
        draft.routeNextTryAt = undefined
      })
      this.logger('warn', 'router-recovered-orphan', `${id} 停在 routing 但没有任务，已复位为 pending 重新排队`)
    }
  }

  /**
   * Log one "what this tick sees" diagnostic line -- only when the status distribution changes, to avoid spam.
   *
   * When debugging "why did planning not start", this line pinpoints it: no candidate, blocked by backoff, or the
   * session cannot open at all (the latter also logs router-session-failed).
   */
  private reportSnapshot(): void {
    const tally = new Map<string, number>()
    for (const row of this.deps.issues.summaries()) {
      tally.set(row.status, (tally.get(row.status) ?? 0) + 1)
    }
    const waiting = [...this.cooldowns.values()].filter(until => until > this.now()).length
    const distribution = [...tally.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => `${status}=${String(count)}`)
      .join(' ')
    const snapshot = `${distribution}|waiting=${String(waiting)}`
    if (snapshot === this.lastSnapshot) return
    this.lastSnapshot = snapshot
    this.logger('info', 'router-state', `${snapshot || '（空台账）'}；候选=${this.candidateSummary(tally)}`)
  }

  private candidateSummary(counts: Map<string, number>): string {
    const accepted = counts.get('accepted') ?? 0
    const pending = counts.get('pending') ?? 0
    if (accepted === 0 && pending === 0) return '无（没有 accepted/pending 的 issue）'
    return `accepted=${String(accepted)} pending=${String(pending)}`
  }


  /**
   * Next issue to convert: `accepted` before `pending`, then urgency -> createdAt ascending within a group;
   * candidates in backoff are skipped.
   */
  private pickNext(): IssueSummary | undefined {
    const at = this.now()
    const eligible = this.deps.issues.summaries().filter(row => this.isRoutable(row, at))
    if (eligible.length === 0) return undefined
    eligible.sort((left, right) => statusWeight(left.status) - statusWeight(right.status)
      || urgencyWeight(left.urgency) - urgencyWeight(right.urgency)
      || left.createdAt - right.createdAt)
    return eligible[0]
  }

  private isRoutable(row: IssueSummary, at: number): boolean {
    if (row.status === 'routing') {
      return blank(row.assigneeTask) && (row.routeNextTryAt ?? 0) <= at
    }
    if (row.status !== 'accepted' && row.status !== 'pending') return false
    const until = this.cooldowns.get(row.id)
    return until === undefined || until <= at
  }


  /**
   * Dependency check before planning: every issue in `dependsOn` must be `success`.
   *
   * The order itself is semantics:
   *
   * 1. no dependency probe configured -> no gate (offline / tests);
   * 2. this issue has no dependencies -> pass immediately, not a single request (the vast majority);
   * 3. dependency count over the limit -> block + warn (the count is static, cannot self-heal, only a manual fix);
   * 4. query once -- one entry into the flow queries once, never repeatedly on a hot path;
   * 5. dependency not found -> ignore (not reported / cleaned up / another owner's 404), must not block forever;
   * 6. found but not `success` -> block, returning a human-readable reason.
   *
   * This method caches nothing; backoff controls re-query frequency: once dependencies finish, it naturally passes.
   *
   * @param issueId - This tick's candidate.
   * @returns Blocking reason; `undefined` = pass.
   */
  private async blockingDependency(issueId: string): Promise<string | undefined> {
    const probe = this.deps.dependsOnStatuses
    if (probe === undefined) return undefined
    const dependsOn = (await this.deps.issues.get(issueId))?.dependsOn ?? []
    if (dependsOn.length === 0) {
      this.blockedNotes.delete(issueId)
      return undefined
    }
    if (dependsOn.length > MAX_DEPENDS_ON) return tooManyDependencies(dependsOn.length)

    let probes: readonly DependencyProbe[]
    try {
      probes = await probe(dependsOn)
    } catch (error) {
      // If the probe fails, pass: the dependency gate is extra protection, and an infrastructure failure must not stall the whole queue forever.
      this.logger('warn', 'router-depends-on-probe-failed',
        `${issueId}: 查依赖状态失败，本轮按无阻塞处理（${errorText(error)}）`)
      return undefined
    }
    const unmet = unmetDependency(probes)
    if (unmet === undefined) {
      this.blockedNotes.delete(issueId)
      return undefined
    }
    return unmet
  }

  /**
   * Record one "blocked by dependency": write backoff + log, and comment on the issue when the reason changes.
   *
   * Three rules:
   *
   * - Do not change issue status (`status` / `routeAttempts` untouched) -- this is not failure, just not this issue's
   *   turn yet; changing status would misreport "dependencies unfinished" as "execution failed";
   * - Write backoff, otherwise a blocked candidate is re-judged every 3 seconds;
   * - Comment only when the reason changes, no spam.
   */
  private async holdForDependencies(issueId: string, reason: string): Promise<void> {
    this.cooldowns.set(issueId, this.now() + DEPENDENCY_HOLD_MS)
    if (this.blockedNotes.get(issueId) === reason) return
    this.blockedNotes.set(issueId, reason)
    this.logger('warn', 'router-depends-on-blocked',
      `${issueId} 停在 ${this.currentStatusText(issueId)}，依赖未满足不进入规划：${reason}`)
    const comment = this.deps.commentBlocked
    if (comment === undefined) return
    await comment(issueId, blockedComment(reason))
      .catch((error: unknown) => {
        this.logger('warn', 'router-depends-on-comment-failed', `${issueId}: ${errorText(error)}`)
      })
  }

  private currentStatusText(issueId: string): string {
    return this.deps.issues.summaries().find(row => row.id === issueId)?.status ?? '未知状态'
  }


  /**
   * Render this issue's references -- prefer the wiring layer's live-material entry, falling back to local
   * ledger rendering on failure.
   *
   * The fallback matters: references are only material for the model, and their absence must not prevent dispatch.
   */
  private async buildReferences(issue: IssueRecord): Promise<string> {
    const render = this.deps.renderReferences
    if (render === undefined) return castboardIssueReferences(issue)
    let text: string
    try {
      text = await render(issue)
    } catch (error) {
      this.logger('warn', 'router-references-fallback',
        `${issue.id}: 现场材料准备失败，退回台账字段渲染（${errorText(error)}）`)
      return castboardIssueReferences(issue)
    }
    return text
  }


  private async acquireSession(): Promise<RouterSessionFace | undefined> {
    if (this.session !== undefined) return this.session
    const saved = this.rememberedSessionId()
    try {
      const opened = await this.openSession(saved)
      this.session = opened
      this.turnFaults = 0
      this.compacted = false
      this.logger('info', 'router-session', `${opened.id}（${opened.resumed ? '续跑' : '新建'}）`)
      return opened
    } catch (error) {
      const reason = errorText(error)
      const live = (error as { code?: unknown }).code === 'SESSION_LIVE'
        || /SESSION_LIVE|still live/i.test(reason)
      this.logger('warn', 'router-session-failed', reason)
      // A live session cannot be taken over by this process: drop the saved id
      // and create a fresh one. Retry immediately on the next tick; other open
      // failures usually come from config, so back off.
      if (!live) this.openRetryAt = this.now() + OPEN_RETRY_MS
      if (saved !== undefined) {
        await this.deps.issues.saveRouter({ sessionId: '' }).catch(() => { /* best-effort */ })
      }
      return undefined
    }
  }

  private rememberedSessionId(): string | undefined {
    const stored = this.deps.issues.router().sessionId
    return stored === undefined || stored === '' ? undefined : stored
  }

  private async openSession(saved: string | undefined): Promise<RouterSessionFace> {
    const opened = await this.deps.openSession(saved, () => this.noteCompaction())
    // Resume did not succeed (session ledger gone): write the new id back so the next tick does not retry the original id.
    if (saved !== undefined && !opened.resumed) {
      this.logger('warn', 'router-session-replaced', `索引里的会话 ${saved} 已不可续跑，改用新会话 ${opened.id}`)
      await this.deps.issues.saveRouter({ sessionId: opened.id })
    } else if (saved === undefined) {
      await this.deps.issues.saveRouter({ sessionId: opened.id, createdAt: this.now() })
    }
    return opened
  }

  /** Compaction landed -> mark it; swap sessions next tick (do not interrupt the running turn). */
  private noteCompaction(): void {
    if (this.compacted) return
    this.compacted = true
    this.logger('info', 'router-session-compacted',
      '当前会话发生了上下文压缩，下一拍换一个新会话（历史已撑满，堆不会自己降）')
  }

  /**
   * Drop the current session (rebuild next tick).
   *
   * It must really be disposed, not just dereferenced: the agent (tool table + prompt + full history) hangs off the
   * handle, and dropping the reference only leaves unmanaged garbage while the heap still grows. After dispose, the
   * index's `sessionId` is cleared and the next tick takes the create branch, assembling guidance and references from scratch.
   */
  private async discardSession(reason: string): Promise<void> {
    const stale = this.session
    this.session = undefined
    this.turnFaults = 0
    this.compacted = false
    this.logger('warn', 'router-session-dropped', `${reason}；下一拍新建会话，静态指导与每轮材料从头组装`)
    if (stale !== undefined) {
      for (const [issueId, sessionId] of this.injectedSessions) {
        if (sessionId === stale.id) this.injectedSessions.delete(issueId)
      }
      await stale.dispose().catch(() => { /* best-effort */ })
    }
    await this.deps.issues.saveRouter({ sessionId: '' }).catch(() => { /* best-effort */ })
  }


  /**
   * Settle this issue after one turn.
   *
   * - Converted (`assigneeTask` present) -> reset the failure count, nothing to write back (the tool already did);
   * - Not converted -> record a failure, return to `pending` with backoff; at the limit mark `abandoned` + remote finalize.
   */
  private async finishTurn(issueId: string, outcome: RouterTurnResult, injected: boolean): Promise<void> {
    const issue = await this.deps.issues.get(issueId)
    if (issue === undefined) return
    if (this.converted(issue, outcome)) {
      await this.deps.issues.saveRouter({ failures: 0 }).catch(() => { /* best-effort */ })
      return
    }
    const reason = this.failureReason(outcome)
    // The context never reached the session (warm-up failed, no agent handle, send threw).
    // This is an infrastructure failure, not an issue failure: dispose the broken session,
    // give the issue a clean full-context retry on a brand-new session.
    if (!injected) {
      await this.discardSession('router 上下文没有成功注入（warm-up / agent handle 失败），重建会话')
      await this.deps.issues.update(issueId, draft => {
        draft.status = 'pending'
        draft.routeAttempts = 0
        draft.routeNextTryAt = undefined
        draft.routeError = reason
      })
      return
    }
    // A blocked turn is what an archived session returns on every resume. Drop it
    // immediately so the next tick opens a fresh, visible router session.
    if (!outcome.ok && outcome.error.includes('blocked')) {
      await this.discardSession('router 会话被归档或 blocked，无法继续接管；下一拍新建会话')
      // This is not an issue failure: no attempt was made. Put it straight back in
      // the queue so the next tick uses a fresh, visible router session.
      await this.deps.issues.update(issueId, draft => {
        draft.status = 'pending'
        draft.routeNextTryAt = undefined
        draft.routeError = reason
      })
      return
    }
    await this.trackSessionHealth(outcome, reason)
    // A normal turn that spawned a conversion sub-agent has not failed yet.
    // Wait for that sub-agent before re-dispatching the issue.
    await this.recordFailure(issueId, issue, reason, outcome.ok ? CONVERSION_GRACE_MS : undefined, outcome.ok)
  }

  private converted(issue: IssueRecord, outcome: RouterTurnResult): boolean {
    return outcome.ok && !blank(issue.assigneeTask)
  }

  private failureReason(outcome: RouterTurnResult): string {
    return outcome.ok
      ? '这一轮结束了，但没有调用 castboard_issue_task（或调用被拒）——issue 还没转成 task'
      : outcome.error
  }

  /**
   * Maintain the "consecutive turn faults" count: reset on a normal finish; at the threshold declare the session broken and rebuild.
   */
  private async trackSessionHealth(outcome: RouterTurnResult, reason: string): Promise<void> {
    if (outcome.ok) {
      this.turnFaults = 0
      return
    }
    this.turnFaults += 1
    if (this.turnFaults < FAULT_LIMIT) return
    await this.discardSession(`连续 ${String(this.turnFaults)} 轮 turn 异常，重建会话（最近一次：${reason}）`)
  }

  /**
   * Record one failure: below the limit, return to `pending` + backoff; at the limit mark `abandoned` and write back remotely.
   *
   * The limit marks `abandoned` rather than `failed`: this service never actually executed the issue, so "execution failed"
   * is inaccurate; `abandoned` means "we will not auto-process this one anymore".
   */
  private async recordFailure(issueId: string, issue: IssueRecord, reason: string, delayMs?: number, keepRouting = false): Promise<void> {
    const attempt = (issue.routeAttempts ?? 0) + 1
    const gaveUp = attempt >= this.maxAttempts
    const retryAt = this.now() + (delayMs ?? RETRY_STEP_MS * attempt)
    if (gaveUp) await this.abandonRemote(issueId, attempt, reason)
    await this.deps.issues.update(issueId, draft => {
      draft.routeAttempts = attempt
      draft.routeError = reason
      draft.routeNextTryAt = gaveUp ? undefined : retryAt
      // A normal no-task turn still owns the routing slot; only a real turn error
      // returns the issue to the pending queue.
      draft.status = gaveUp ? 'abandoned' : (keepRouting ? 'routing' : 'pending')
    })
    if (!gaveUp) this.cooldowns.set(issueId, retryAt)
    this.logger('warn', gaveUp ? 'router-give-up' : 'router-retry',
      `${issueId} 第 ${String(attempt)}/${String(this.maxAttempts)} 次失败：${reason}`)
    await this.deps.issues.saveRouter({ failures: this.turnFaults, lastError: reason }).catch(() => { /* best-effort */ })
  }

  private async abandonRemote(
    issueId: string,
    attempt: number,
    reason: string,
  ): Promise<void> {
    const abandon = this.deps.issueAbandoned
    if (abandon === undefined) throw new Error('共享库不可用：不能放弃 issue')
    await abandon(issueId, `router 连续 ${String(attempt)} 次未能把这条 issue 转成 task：${reason}`)
  }


  /** Lease-owner gate: `isOwner` may throw (failed lease-file read); fold that to false. */
  private ownerEligible(): boolean {
    const gate = this.deps.isOwner
    if (gate === undefined) return true
    try {
      return gate() !== false
    } catch {
      return false
    }
  }

  /** Auto-routing gate: `enabled` may throw (settings read failure); fold that to "on" -- a settings error must not stop work. */
  private autoRouteEnabled(): boolean {
    const gate = this.deps.enabled
    if (gate === undefined) return true
    try {
      return gate() !== false
    } catch {
      return true
    }
  }

  private reportPaused(): void {
    if (this.paused) return
    this.paused = true
    this.logger('info', 'router-paused', '自动规划已关闭（看板设置 autoRoute=false），这一拍不派活；队列保持不变')
  }

  private reportResumed(): void {
    if (!this.paused) return
    this.paused = false
    this.logger('info', 'router-resumed', '自动规划已打开，继续按队列派活')
  }

  private now(): number {
    const clock = this.deps.now
    return clock === undefined ? Date.now() : clock()
  }

  private armTimer(delayMs: number): void {
    if (this.disposed) return
    this.stopTimer()
    const set = this.deps.timers?.set ?? armDefaultTimer
    this.handle = set(() => this.tick(), delayMs)
  }

  private stopTimer(): void {
    if (this.handle === undefined) return
    const clear = this.deps.timers?.clear ?? disarmDefaultTimer
    clear(this.handle)
    this.handle = undefined
  }
}

/** Default timer (unref'd so it does not hold the host open on exit). */
function armDefaultTimer(run: () => void | Promise<void>, delayMs: number): unknown {
  const timer = setTimeout(async () => {
    try {
      await run()
    } catch (error) {
      consoleRouterLog('warn', 'router-tick-threw', errorText(error))
    }
  }, delayMs)
  timer.unref?.()
  return timer
}

function disarmDefaultTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>)
}
