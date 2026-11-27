/**
 * Comment delivery: which session a new comment should wake, and how.
 *
 * Delivery always goes **across**: the side that wrote the comment already has the content; only the other side needs
 * waking. The target session comes from the relation table (`assignerSessionId` / `assigneeSessionId`); if this machine
 * has no target, the other side is on another machine, so skip.
 *
 * Delivery has three tiers:
 *
 * 1. The session lives in this process: push directly using the handle's capabilities. Prefer `push` (the handle
 *    itself chooses `steer` when busy and `followup` when idle); without `push`, fall back to `steer` when `running` or
 *    else `followUp`. Each tier sends exactly **one message**, and the message is the rendered comment XML, so the
 *    first step sees the content -- there is no "trigger line first, body one step later" skew.
 * 2. The session is not in this process but is an execution session owned by this plugin: resume it through the
 *    facade for one turn, still passing the body as the `castboard-issue-comments` named context. A user's own session is
 *    never resumed -- that would start a session the user is not watching on their behalf.
 * 3. Neither works: record a debt on the corresponding side of the relation table (`assignerPendingSince` /
 *    `assigneePendingSince`) and let polling redeliver at the start of each tick. Attempts for the same
 *    `(issue, side)` are at least 30 seconds apart, so a permanently unreachable target does not burn I/O every tick.
 *
 * Two extra gates:
 *
 * - **Merge window**: comments for the same `(issue, side)` arriving within 400ms are injected as one batch. A tool
 *   call writes one comment, and an executor sending "ack + correction" leaves only ten-odd milliseconds between them;
 *   without merging, the session would see two nearly identical contexts.
 * - **Echo guard**: never deliver a comment back to the session that wrote it. The test is the comment's `threadId`,
 *   independent of `role` -- relying on `role` alone would let any write path that gets the role wrong loop back.
 *
 * Ordinary system comments (such as "execution failed" left by settlement) wake no session:
 * they are only a trace. Runtime results (`sys.runtimeCommand`) are the exception: they are
 * the answer to an RPC, so the assigner must be woken to consume them.
 *
 * @module dsh-magica-castboard/host/pipeline/deliver
 */
import { commentsXml, type CommentAttachmentRef } from '../context/comment-context.ts'
import { ISSUE_COMMENTS_SECTION } from '../context/sections.ts'
import { ASSIGNER_WAKE_INSTRUCTION, WAKE_INSTRUCTION } from '../context/comment-instruction.ts'
import type { CommentOrigin, ThreadComment } from '../ledger/comment-store.ts'
import { RUNTIME_COMMENT_PREFIX, RUNTIME_RESULT_SYSTEM_KEY } from '../runtime-contract.ts'
import { isIssueAnchor, type LinkStore } from '../ledger/link-store.ts'
import { isInteractionDeliverable } from './interaction-delivery.ts'
import {
  COMMENT_SIDES,
  oppositeSide,
  pendingFieldOf,
  targetSessionId,
  targetsSide,
  type CommentSide,
  type IssueLinkPatch,
} from '../ledger/link-types.ts'

export { commentsXml }

const LEGACY_RUNTIME_RESULT_SYSTEM_KEY = 'sys.runtimeBash'

/**
 * Runtime results are system traces, but unlike settlement notices they are the
 * answer to an RPC: the assigner must be woken so it can consume the result.
 */
function isRuntimeResultSystemComment(comment: ThreadComment, anchorId: string): boolean {
  if (!isIssueAnchor(anchorId) || comment.role !== 'assignee' || comment.authorType !== 'system') return false
  if (comment.systemKey === RUNTIME_RESULT_SYSTEM_KEY
    || comment.systemKey === LEGACY_RUNTIME_RESULT_SYSTEM_KEY) return true
  // Cloud comments do not carry systemKey; the worker's stable header identifies them.
  return comment.systemKey === undefined && comment.body.startsWith(RUNTIME_COMMENT_PREFIX)
}

/**
 * Narrow gate for system comments. Non-system comments never go through this
 * helper; callers keep the ordinary `authorType !== 'system'` fast path.
 */
function isDeliverableSystemComment(comment: ThreadComment, anchorId: string): boolean {
  return isInteractionDeliverable(comment, anchorId)
    || isRuntimeResultSystemComment(comment, anchorId)
}

/** Merge window for the same `(issue, side)` (ms). */
export const MERGE_WINDOW_MS = 400

/** Minimum gap between two redelivery attempts for the same `(issue, side)` (ms). */
export const RETRY_COOLDOWN_MS = 30_000

export interface CommentContextEntry {
  readonly name: string
  readonly text: string
  readonly form?: 'snapshot' | 'instructions' | 'notice'
  readonly summary?: string
}

/**
 * The parts of a live session handle that the deliverer needs.
 *
 * All three methods are optional: handles from different sources expose different capabilities, so delivery
 * degrades tier by tier using whatever is available.
 */
export interface LiveCommentSession {
  readonly running: boolean
  /**
   * Three-tier push: `followup` (start a turn when idle) / `steer` (interject when busy) / `inject` (queue only).
   * Returning `skipped` or `false` means it was not delivered, and the caller keeps degrading.
   */
  readonly push?: (entries: readonly CommentContextEntry[]) => string | false
  /** Queue named context on the next step; does not wake by itself. */
  readonly inject?: (entries: readonly CommentContextEntry[]) => boolean
  readonly steer?: (text: string) => boolean
  /** Append a turn (idle session); a returned promise only gets a rejection handler, so delivery is not blocked. */
  readonly followUp?: (text: string) => unknown
}

export interface CommentDelivererDeps {
  /** Relation table: look up target sessions, record and clear pending debts on both sides. */
  readonly links: LinkStore
  /** Read the full comment stream of one issue (used to rebuild the owed batch on redelivery). Omitted = no redelivery. */
  readonly commentsOf?: (anchorId: string) => Promise<readonly ThreadComment[]>
  /**
   * Download one comment's attachments before its context is injected.
   *
   * Only comments that are actually about to be delivered are synced; local comments
   * already synced at write time, and pending rows are filtered by the task context.
   */
  readonly syncCommentAttachments?: (issueId: string, commentId: string) => Promise<unknown>
  /** Read already-synced comment attachments for the XML body; only `ready` rows should be returned. */
  readonly commentAttachments?: (issueId: string, commentId: string) => readonly CommentAttachmentRef[]
  /** Live sessions in this process; `undefined` means the session was unloaded from memory. */
  readonly liveSession?: (sessionId: string) => LiveCommentSession | undefined
  /**
   * Comment timestamp actually handed to this turn's `<castboard_task-references>` (epoch ms; 0 = none).
   *
   * Comments at or below the watermark already appeared in references this turn, so delivering them again would duplicate
   * the batch. Only comments strictly after it were not covered. Omitted = unknown, deliver everything.
   */
  readonly coveredUntil?: (anchorId: string) => number
  /** Whether this session may be resumed (only execution sessions owned by this plugin may). */
  readonly canResume?: (sessionId: string) => boolean
  readonly resume?: (
    sessionId: string,
    input: { instruction: string; context: readonly CommentContextEntry[] },
  ) => boolean | Promise<boolean>
  readonly now?: () => number
  /** Merge window override; `0` = no merging, deliver immediately (for tests). */
  readonly mergeWindowMs?: number
  readonly retryCooldownMs?: number
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  readonly log?: (level: 'info' | 'warn', event: string, detail?: unknown) => void
}

export interface DeliverOptions {
  /** Session that wrote this comment; when it equals the target, nothing is delivered (explicit echo guard). */
  readonly originSessionId?: string
}

interface BufferedBatch {
  readonly source: CommentOrigin
  readonly anchorId: string
  readonly side: CommentSide
  readonly sessionId: string
  readonly comments: ThreadComment[]
  handle?: unknown
}

/**
 * Comment deliverer.
 *
 * A stateless `deliver` call only enqueues; the real I/O happens when the window fires or on `flushAll`.
 */
export class CommentDeliverer {
  private readonly deps: CommentDelivererDeps
  /** Redelivery cooldown: `side:anchorId` -> last attempt time. */
  private readonly attempts = new Map<string, number>()
  /** Merge buffer: `side:anchorId` -> batch waiting for its window. */
  private readonly buffers = new Map<string, BufferedBatch>()

  constructor(deps: CommentDelivererDeps) {
    this.deps = deps
  }

  /**
   * Deliver a batch of comments **for one issue**.
   *
   * @param source - `local` = just written here; `remote` = pulled from the shared library.
   * @param anchorId - Comment anchor (= issue id).
   * @param comments - This batch (usually one direction, in arrival order).
   * @param options - See {@link DeliverOptions}.
   */
  async deliver(
    source: CommentOrigin,
    anchorId: string,
    comments: readonly ThreadComment[],
    options: DeliverOptions = {},
  ): Promise<void> {
    // System messages are traces only, except the narrow gate: interaction control
    // comments and runtime results.
    const deliverable = comments.filter(comment =>
      comment.authorType !== 'system'
      || isDeliverableSystemComment(comment, anchorId))
    if (deliverable.length === 0) return

    const link = this.deps.links.get(anchorId)
    if (link === undefined) {
      this.log('info', 'deliver.skip-cross-machine', { anchorId })
      return
    }

    // A batch comes from one write and has one direction; polling may bucket both ends together for an issue, in which
    // case the direction follows the newest comment (matching the batch semantics the deliverer receives).
    const latest = deliverable[deliverable.length - 1]!
    const side = oppositeSide(latest.role)
    const sessionId = targetSessionId(link, latest.role)
    const since = earliest(deliverable)
    if (sessionId === undefined) {
      // The relation exists but the target column is not written yet (an execution session returns its id only after start()).
      // This batch must not be lost: record the debt and let redelivery send it once that side's session is registered.
      await this.mark(side, anchorId, since)
      this.log('info', 'deliver.pending-no-target', { anchorId, side })
      return
    }

    if (options.originSessionId !== undefined && options.originSessionId === sessionId) {
      this.log('info', 'deliver.echo-skip', { anchorId, originSessionId: sessionId })
      return
    }

    // Echo guard: the session that wrote the comment already has it, so do not deliver it back.
    const foreign = deliverable.filter(comment => comment.threadId !== sessionId)
    if (foreign.length === 0) {
      this.log('info', 'deliver.self-skip', { anchorId, sessionId })
      return
    }

    const windowMs = this.deps.mergeWindowMs ?? MERGE_WINDOW_MS
    if (windowMs <= 0) {
      await this.route(source, anchorId, side, sessionId, foreign)
      return
    }
    this.enqueue(source, anchorId, side, sessionId, foreign, windowMs)
  }

  /**
   * Redeliver comments owed by the relation table (called at the start of every polling tick).
   *
   * Only targets **currently alive** are retried: delivering to a session outside this process would be read by no one,
   * so the debt stays until it comes back. One `(issue, side)` is skipped while cooling down.
   *
   * @returns Number of `(issue, side)` pairs delivered this tick.
   */
  async retryPending(): Promise<number> {
    const read = this.deps.commentsOf
    if (read === undefined) return 0
    let delivered = 0
    for (const anchorId of this.deps.links.issueIds()) {
      const link = this.deps.links.get(anchorId)
      if (link === undefined) continue
      for (const side of COMMENT_SIDES) {
        const since = link[pendingFieldOf(side)]
        if (since === undefined) continue
        const sessionId = side === 'assigner' ? link.assignerSessionId : link.assigneeSessionId
        if (sessionId === undefined) continue
        // Target is not in this process: retry on the tick it comes back, and never clear the debt.
        if (this.liveOf(sessionId) === undefined) continue
        if (this.cooling(anchorId, side)) continue

        let all: readonly ThreadComment[]
        try {
          all = await read(anchorId)
        } catch (error) {
          this.log('warn', 'deliver.retry-read-failed', { anchorId, error: errorText(error) })
          continue
        }
        // Redeliver only comments headed to this side and still inside the owed range; ordinary
        // system messages and echoes are excluded, the narrow system gate is allowed.
        const covered = this.deps.coveredUntil?.(anchorId) ?? 0
        const pending = unique(all.filter(comment => {
          const systemAllowed = isDeliverableSystemComment(comment, anchorId)
          return (comment.authorType !== 'system' || systemAllowed)
            && targetsSide(comment, side)
            && comment.createdAt >= since
            && (covered === 0 || systemAllowed || comment.createdAt > covered)
            && comment.threadId !== sessionId
        }))
        this.noteAttempt(anchorId, side)
        if (pending.length === 0) {
          // Nothing left to redeliver (comments cleaned up / timestamp stale) -> clear the debt instead of spinning every tick.
          await this.clear(side, anchorId)
          continue
        }
        const ok = await this.route('local', anchorId, side, sessionId, pending)
        if (ok) delivered += 1
      }
    }
    return delivered
  }

  /**
   * Flush every comment currently in a merge window (for unload / tests).
   *
   * Without flushing, comments still inside a window at unload would disappear with the process.
   *
   * @returns How many buffers were flushed.
   */
  async flushAll(): Promise<number> {
    const keys = [...this.buffers.keys()]
    for (const key of keys) await this.flushBuffer(key)
    return keys.length
  }

  async dispose(): Promise<void> {
    await this.flushAll()
  }

  /**
   * Add a batch of comments to the merge buffer.
   *
   * Three exceptions:
   * 1. Deduplicate by id -- a local write and a cloud pull may hit the same comment;
   * 2. Flush the buffered batch as soon as the target session changes -- mixing sessions would deliver to the wrong place;
   * 3. Arm the window timer only when the first batch arrives -- the window starts at the first comment, so later
   *    comments never extend it, and frequent writes never postpone injection indefinitely.
   */
  private enqueue(
    source: CommentOrigin,
    anchorId: string,
    side: CommentSide,
    sessionId: string,
    comments: readonly ThreadComment[],
    windowMs: number,
  ): void {
    const key = bufferKey(side, anchorId)
    const existing = this.buffers.get(key)
    if (existing !== undefined && existing.sessionId === sessionId) {
      pushUnique(existing.comments, comments)
      return
    }
    if (existing !== undefined) void this.flushBuffer(key)

    const entry: BufferedBatch = { source, anchorId, side, sessionId, comments: [] }
    pushUnique(entry.comments, comments)
    this.buffers.set(key, entry)
    entry.handle = this.setTimer(() => { void this.flushBuffer(key) }, windowMs)
    unrefTimer(entry.handle)
  }

  /** Flush one buffer key: the whole batch goes through one {@link route} (= one push). */
  private async flushBuffer(key: string): Promise<boolean> {
    const entry = this.buffers.get(key)
    if (entry === undefined) return false
    this.buffers.delete(key)
    if (entry.handle !== undefined) {
      this.clearTimer(entry.handle)
      entry.handle = undefined
    }
    const batch = [...entry.comments].sort((left, right) => left.createdAt - right.createdAt)
    try {
      return await this.route(entry.source, entry.anchorId, entry.side, entry.sessionId, batch)
    } catch (error) {
      this.log('warn', 'deliver.flush-failed', { anchorId: entry.anchorId, error: errorText(error) })
      return false
    }
  }

  /**
   * Download attachments for the comments that are about to be injected.
   *
   * Local comments were synced when written; comment attachments are stored under
   * `<issue>/comments/<commentId>/`, so the issue anchor is all the path resolution needs.
   */
  private async ensureCommentAttachments(anchorId: string, comments: readonly ThreadComment[]): Promise<void> {
    const sync = this.deps.syncCommentAttachments
    if (sync === undefined || !isIssueAnchor(anchorId)) return
    for (const comment of comments) {
      if (comment.origin === 'local') continue
      try {
        await sync(anchorId, comment.id)
      } catch (error) {
        // The comment itself is already persisted; do not lose it because one file failed.
        this.log('warn', 'deliver.comment-attachments-failed', { anchorId, commentId: comment.id, error: errorText(error) })
      }
    }
  }

  /**
   * Real delivery: pick a tier based on session state, each guaranteeing "the comment is read + the session keeps running".
   *
   * @returns Whether this batch was actually sent.
   */
  private async route(
    source: CommentOrigin,
    anchorId: string,
    side: CommentSide,
    sessionId: string,
    comments: readonly ThreadComment[],
  ): Promise<boolean> {
    const uniqueBatch = unique(comments.filter(comment =>
      (comment.authorType !== 'system' || isDeliverableSystemComment(comment, anchorId))
      && comment.threadId !== sessionId))
    const covered = this.deps.coveredUntil?.(anchorId) ?? 0
    const batch = covered > 0
      ? uniqueBatch.filter(comment =>
        isDeliverableSystemComment(comment, anchorId) || comment.createdAt > covered)
      : uniqueBatch
    if (batch.length === 0) {
      if (uniqueBatch.length > 0) {
        this.log('info', 'deliver.already-in-references', { anchorId, covered })
      }
      return false
    }

    // Bounded to the comments that are actually about to be injected. The cursor has
    // already advanced (or the debt is being retried), so a failed download must not
    // block the comment body; pending attachment rows stay out of the task context.
    await this.ensureCommentAttachments(anchorId, batch)

    const entry: CommentContextEntry = {
      name: ISSUE_COMMENTS_SECTION,
      text: commentsXml(
        anchorId,
        batch,
        side,
        this.deps.commentAttachments === undefined
          ? undefined
          : commentId => this.deps.commentAttachments!(anchorId, commentId),
      ),
      form: 'notice',
      summary: 'New comments on the issue',
    }
    const since = earliest(batch)
    const live = this.liveOf(sessionId)

    if (live !== undefined) {
      const mode = dispatchToSession(live, entry)
      if (mode !== false) {
        await this.clear(side, anchorId)
        this.log('info', 'deliver.pushed', { source, anchorId, side, sessionId, mode, count: batch.length })
        return true
      }
      await this.mark(side, anchorId, since)
      this.log('warn', 'deliver.push-failed', { source, anchorId, side, sessionId })
      return false
    }

    // The session was unloaded from memory: only execution sessions owned by this plugin can be resumed. A user session
    // cannot be resumed by anyone; forcing it would start a session the user is not watching, so record the debt and wait.
    if (this.resumable(sessionId)) {
      const instruction = side === 'assignee' ? WAKE_INSTRUCTION : ASSIGNER_WAKE_INSTRUCTION
      const resumed = await this.tryResume(sessionId, { instruction, context: [entry] })
      if (resumed) {
        await this.clear(side, anchorId)
        this.log('info', 'deliver.resumed', { source, anchorId, side, sessionId })
        return true
      }
    }

    await this.mark(side, anchorId, since)
    this.log('info', 'deliver.pending', { source, anchorId, side, sessionId, since })
    return false
  }

  private liveOf(sessionId: string): LiveCommentSession | undefined {
    try {
      return this.deps.liveSession?.(sessionId)
    } catch (error) {
      this.log('warn', 'deliver.session-probe-failed', { sessionId, error: errorText(error) })
      return undefined
    }
  }

  private resumable(sessionId: string): boolean {
    try {
      return this.deps.resume !== undefined && this.deps.canResume?.(sessionId) === true
    } catch (error) {
      this.log('warn', 'deliver.resume-probe-failed', { sessionId, error: errorText(error) })
      return false
    }
  }

  private async tryResume(
    sessionId: string,
    input: { instruction: string; context: readonly CommentContextEntry[] },
  ): Promise<boolean> {
    const resume = this.deps.resume
    if (resume === undefined) return false
    try {
      return (await resume(sessionId, input)) === true
    } catch (error) {
      this.log('warn', 'deliver.resume-failed', { sessionId, error: errorText(error) })
      return false
    }
  }

  /**
   * Record a debt: move forward only. If an earlier time is already recorded, keep the earlier one -- redelivery must
   * cover content from the earliest comment, and overwriting with a later time would lose comments.
   */
  private async mark(side: CommentSide, anchorId: string, since: number): Promise<void> {
    if (!isIssueAnchor(anchorId)) return
    const previous = this.deps.links.get(anchorId)?.[pendingFieldOf(side)]
    if (previous !== undefined && previous <= since) return
    try {
      await this.deps.links.patch(anchorId, pendingPatch(side, since))
    } catch (error) {
      this.log('warn', 'deliver.pending-write-failed', { anchorId, side, error: errorText(error) })
    }
  }

  private async clear(side: CommentSide, anchorId: string): Promise<void> {
    if (!isIssueAnchor(anchorId)) return
    if (this.deps.links.get(anchorId)?.[pendingFieldOf(side)] === undefined) return
    try {
      await this.deps.links.patch(anchorId, pendingPatch(side, null))
    } catch (error) {
      this.log('warn', 'deliver.pending-clear-failed', { anchorId, side, error: errorText(error) })
    }
  }

  private cooling(anchorId: string, side: CommentSide): boolean {
    const at = this.attempts.get(bufferKey(side, anchorId))
    if (at === undefined) return false
    const cooldown = this.deps.retryCooldownMs ?? RETRY_COOLDOWN_MS
    return (this.now() - at) < cooldown
  }

  /** Record one redelivery attempt; when the map grows large, drop entries that no longer owe anything. */
  private noteAttempt(anchorId: string, side: CommentSide): void {
    this.attempts.set(bufferKey(side, anchorId), this.now())
    if (this.attempts.size <= 512) return
    for (const key of [...this.attempts.keys()]) {
      const separator = key.indexOf(':')
      const keySide = key.slice(0, separator) as CommentSide
      const keyAnchor = key.slice(separator + 1)
      if (this.deps.links.get(keyAnchor)?.[pendingFieldOf(keySide)] === undefined) this.attempts.delete(key)
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
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

  private log(level: 'info' | 'warn', event: string, detail?: unknown): void {
    this.deps.log?.(level, event, detail)
  }
}

/**
 * Send one named context according to handle capabilities, returning the tier used or `false`.
 *
 * Order: `push` (the handle picks followup / steer / inject from its status) -> `steer` (busy) -> `followUp` (idle, or the
 * only remaining content-carrying channel when busy without steer). A `skipped` from `push` also degrades instead of
 * dropping the comment.
 */
function dispatchToSession(session: LiveCommentSession, entry: CommentContextEntry): string | false {
  if (session.push !== undefined) {
    try {
      const mode = session.push([entry])
      if (typeof mode === 'string' && mode !== '' && mode !== 'skipped') return mode
    } catch {
      // The handle lacks the capability for this delivery; keep going down the fallback path.
    }
  }

  // Fallback for sessions without named-context wake: queue the XML as named context,
  // then wake with a short instruction. This is still context injection, not sending
  // the raw XML as a user message.
  if (!session.running && session.inject !== undefined && session.followUp !== undefined) {
    try {
      if (session.inject([entry])) {
        const result = session.followUp(WAKE_INSTRUCTION)
        if (result !== false) {
          if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
            void (result as Promise<unknown>).catch(() => undefined)
          }
          return 'followup+inject'
        }
      }
    } catch {
      // Fall through to the plain follow-up tier.
    }
  }

  if (session.running && session.steer !== undefined) {
    try {
      if (session.steer(entry.text)) return 'steer'
    } catch {
      // If steering fails, followup is still available as the last channel.
    }
  }

  if (session.followUp !== undefined) {
    try {
      const result = session.followUp(entry.text)
      if (result === false) return false
      // The handle usually returns a promise; attach only a rejection handler, since delivery does not wait for the turn.
      if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
        void (result as Promise<unknown>).catch(() => undefined)
      }
      return 'followup'
    } catch {
      return false
    }
  }

  return false
}

function bufferKey(side: CommentSide, anchorId: string): string {
  return `${side}:${anchorId}`
}

function earliest(comments: readonly ThreadComment[]): number {
  return comments.reduce(
    (min, comment) => Math.min(min, comment.createdAt),
    comments[0]?.createdAt ?? 0,
  )
}

function unique(comments: readonly ThreadComment[]): ThreadComment[] {
  const seen = new Set<string>()
  const out: ThreadComment[] = []
  for (const comment of comments) {
    if (seen.has(comment.id)) continue
    seen.add(comment.id)
    out.push(comment)
  }
  return out
}

function pushUnique(target: ThreadComment[], comments: readonly ThreadComment[]): void {
  for (const comment of comments) {
    if (!target.some(item => item.id === comment.id)) target.push(comment)
  }
}

function pendingPatch(side: CommentSide, value: number | null): IssueLinkPatch {
  return pendingFieldOf(side) === 'assignerPendingSince'
    ? { assignerPendingSince: value }
    : { assigneePendingSince: value }
}

function unrefTimer(handle: unknown): void {
  ;(handle as { unref?: () => void } | undefined)?.unref?.()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
