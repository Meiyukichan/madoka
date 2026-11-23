/**
 * Publishing comments to the cloud: writes locally produced comments into the shared library one by one, per-anchor watermark.
 *
 * ## The queue is the comment stream
 *
 * Each anchor's comment stream is append-only and ordered, and the watermark (`lastPublished`) records "which comment
 * was sent last". The pending set therefore needs no extra outbox file: rows after the watermark with `origin === 'local'`
 * are the queue. The watermark survives restarts on disk, so comments written earlier are not lost when the process exits.
 *
 * ## Three boundaries
 *
 * | Boundary | Reason |
 * |---|---|
 * | Send only `origin === 'local'` | Re-sending a pulled cloud row would be a loop |
 * | Send only when the cloud has a matching issue | Issues created by the local panel have no cloud row; posting blindly yields 404 |
 * | Advance the watermark only after one is acknowledged | On failure it stays put and the next tick retries the same comment; the comment id is the idempotency key |
 *
 * ## Scheduling
 *
 * `schedule()` is called several times in a row by one batch append. Only one publish chain runs per anchor at a time;
 * requests arriving while it runs just set `dirty` and add one more round at the end; chains are merged by a short debounce,
 * so frequent writes do not produce N identical network requests.
 *
 * @module dsh-magica-castboard/host/pipeline/publish
 */
import type {
  CommentOrigin,
  ThreadComment,
  ThreadCommentAuthorType,
} from '../ledger/comment-store.ts'
import type { PublishCursorStore } from '../ledger/cursors.ts'
import type { CommentSide, IssueLink } from '../ledger/link-types.ts'

/** Default debounce window (ms): merges one batch of writes into a single publish chain. */
export const DEFAULT_PUBLISH_DEBOUNCE_MS = 50

export interface PendingCommentPublish {
  readonly anchorId: string
  /** Idempotency key (cloud `commentId`): re-sending does not add a row. */
  readonly commentId: string
  readonly body: string
  /** Side that wrote it; `null` = unknown (the cloud does not write this column). */
  readonly role: CommentSide | null
  readonly authorType: ThreadCommentAuthorType
  readonly createdAt: number
}

export interface CommentStreamFace {
  list(anchorId: string): Promise<readonly ThreadComment[]>
}

export interface CommentLinkFace {
  get(anchorId: string): IssueLink | undefined
  /** All anchors (for startup catch-up; omitted = only anchors present in the cursor table). */
  issueIds?: () => readonly string[]
}

export interface CommentPublisherDeps {
  /** Remote publishing switch; false keeps local comments local and sends nothing. */
  readonly enabled?: () => boolean
  /**
   * Storage-lease gate: only the owner writes the cloud and the publish watermark.
   *
   * Omitted = always allowed (tests); the wiring layer passes `lease.isOwner`.
   */
  readonly canPublish?: () => boolean
  /** Comment stream (reads rows after the watermark). */
  readonly comments: CommentStreamFace
  readonly links: CommentLinkFace
  readonly cursor: PublishCursorStore
  /** Actually send one comment; a throw means it did not go up and the watermark stays put. */
  readonly publishComment: (pending: PendingCommentPublish) => Promise<void>
  readonly now?: () => number
  /** Debounce window (ms); `0` = do not wait, chain immediately. */
  readonly debounceMs?: number
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  readonly log?: (level: 'info' | 'warn', event: string, detail?: unknown) => void
}

export interface PublishOutcome {
  /** How many were actually attempted. */
  attempted: number
  /** How many the cloud acknowledged. */
  published: number
  /** How many failed (a failure stops the chain and leaves the watermark in place). */
  failed: number
  /** Rows after the watermark skipped because `origin === 'remote'`. */
  skipped: number
}

interface AnchorState {
  /** Publish chain in progress. */
  running?: Promise<PublishOutcome>
  /** New requests arrived while the chain ran: run one more round afterwards. */
  dirty: boolean
  lastAttemptAt?: number
}

function emptyOutcome(): PublishOutcome {
  return { attempted: 0, published: 0, failed: 0, skipped: 0 }
}

function mergeOutcome(total: PublishOutcome, one: PublishOutcome): PublishOutcome {
  return {
    attempted: total.attempted + one.attempted,
    published: total.published + one.published,
    failed: total.failed + one.failed,
    skipped: total.skipped + one.skipped,
  }
}

export class CommentPublisher {
  private readonly deps: CommentPublisherDeps
  private readonly states = new Map<string, AnchorState>()
  /** Anchors the cloud proved it does not have; do not retry every comment/restart. */
  private readonly missingCloud = new Set<string>()
  /** Anchors waiting for the debounce window. */
  private readonly pending = new Set<string>()
  private timer: unknown
  private disposed = false

  constructor(deps: CommentPublisherDeps) {
    this.deps = deps
  }

  /**
   * Ask the publisher to handle one anchor (does not await; safe to call frequently).
   */
  schedule(anchorId: string): void {
    if (this.disposed || anchorId.length === 0) return
    if (this.deps.enabled?.() === false) return
    if (!this.canPublish()) return
    this.pending.add(anchorId)
    if ((this.deps.debounceMs ?? DEFAULT_PUBLISH_DEBOUNCE_MS) <= 0) {
      void this.flushAll().catch((error: unknown) => {
        this.log('warn', 'comment-publish-flush-failed', { anchorId, error: errorText(error) })
      })
      return
    }
    this.armTimer()
  }

  /**
   * Publish local comments after one anchor's watermark, one by one (single flight).
   *
   * If it is already running, only mark "one more round at the end"; do not queue a second copy.
   *
   * @param anchorId - Anchor.
   */
  publishAnchor(anchorId: string): Promise<PublishOutcome> {
    if (anchorId.length === 0 || this.deps.enabled?.() === false) return Promise.resolve(emptyOutcome())
    const state = this.stateOf(anchorId)
    if (state.running !== undefined) {
      state.dirty = true
      return state.running
    }

    const run = this.drain(anchorId, state)
    state.running = run
    void run.then(
      () => {
        if (state.running === run) state.running = undefined
        if (!state.dirty && this.states.get(anchorId) === state) this.states.delete(anchorId)
      },
      () => {
        if (state.running === run) state.running = undefined
      },
    )
    return run
  }

  /**
   * Flush every anchor in the debounce window now (unload, tests, manual retry).
   */
  async flushAll(): Promise<PublishOutcome> {
    this.clearTimer()
    const anchors = [...this.pending]
    this.pending.clear()
    let total = emptyOutcome()
    for (const anchorId of anchors) {
      try {
        total = mergeOutcome(total, await this.publishAnchor(anchorId))
      } catch (error) {
        this.log('warn', 'comment-publish-anchor-failed', { anchorId, error: errorText(error) })
        total.failed += 1
      }
    }
    return total
  }

  /**
   * Startup catch-up: scan the given anchors (default = all anchors from the relation table + cursor table).
   *
   * Content before the watermark is not re-sent after a restart; anything after it that failed is caught up here.
   *
   * @param anchorIds - Anchors to catch up; omitted = enumerate automatically.
   */
  async recover(anchorIds?: readonly string[]): Promise<PublishOutcome> {
    const targets = anchorIds ?? this.knownAnchors()
    let total = emptyOutcome()
    for (const anchorId of targets) {
      if (anchorId.length === 0) continue
      try {
        total = mergeOutcome(total, await this.publishAnchor(anchorId))
      } catch (error) {
        this.log('warn', 'comment-publish-recover-failed', { anchorId, error: errorText(error) })
        total.failed += 1
      }
    }
    return total
  }

  /**
   * Stop publishing (idempotent): flush anchors in the debounce window first, then block later `schedule` calls.
   *
   * In-flight chains run to completion; network requests already sent are not aborted.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      this.clearTimer()
      return
    }
    try {
      await this.flushAll()
    } catch (error) {
      this.log('warn', 'comment-publish-dispose-flush-failed', errorText(error))
    }
    this.disposed = true
    this.clearTimer()
    this.pending.clear()
    const running: Promise<PublishOutcome>[] = []
    for (const state of this.states.values()) {
      if (state.running !== undefined) running.push(state.running)
    }
    await Promise.allSettled(running)
  }

  private async drain(anchorId: string, state: AnchorState): Promise<PublishOutcome> {
    let total = emptyOutcome()
    do {
      state.dirty = false
      const one = await this.publishPending(anchorId)
      total = mergeOutcome(total, one)
      state.lastAttemptAt = this.now()
    } while (state.dirty && !this.disposed)
    return total
  }

  private async publishPending(anchorId: string): Promise<PublishOutcome> {
    const outcome = emptyOutcome()
    if (this.disposed) return outcome
    // A promoted-then-demoted owner must stop before the network call, not after it.
    if (!this.canPublish()) return outcome

    await this.deps.cursor.load()
    if (this.missingCloud.has(anchorId)) {
      this.log('info', 'comment-publish-skip-missing', { anchorId })
      return outcome
    }

    let all: readonly ThreadComment[]
    try {
      all = await this.deps.comments.list(anchorId)
    } catch (error) {
      outcome.failed += 1
      this.log('warn', 'comment-publish-read-failed', { anchorId, error: errorText(error) })
      return outcome
    }
    if (all.length === 0) return outcome

    // The watermark is a **position** in the stream, not an id comparison: local ids are UUIDs, whose string order
    // is unrelated to write order. The watermark comment was already sent, so start after it.
    const watermark = this.deps.cursor.lastPublished(anchorId)
    const start = watermark === undefined ? 0 : all.findIndex(comment => comment.id === watermark) + 1

    for (let index = start; index < all.length; index += 1) {
      const comment = all[index]
      if (comment === undefined) continue
      if (comment.origin !== 'local') {
        outcome.skipped += 1
        continue
      }
      if (this.disposed) return outcome

      outcome.attempted += 1
      try {
        await this.deps.publishComment({
          anchorId,
          commentId: comment.id,
          body: comment.body,
          role: comment.role,
          authorType: comment.authorType,
          createdAt: comment.createdAt,
        })
      } catch (error) {
        if (isMissingCloudAnchor(error)) {
          // The anchor has no cloud row (local issue / wrong id). That is permanent,
          // unlike a network error: cache it and advance the watermark so the queue
          // does not pin every later comment on the same 404.
          this.missingCloud.add(anchorId)
          outcome.skipped += 1
          await this.deps.cursor.setPublished(anchorId, comment.id)
          this.log('info', 'comment-publish-skip-missing', {
            anchorId,
            commentId: comment.id,
            error: errorText(error),
          })
          return outcome
        }
        // Stop here: the watermark does not move, and the next comment or startup catch-up resumes from the same one.
        outcome.failed += 1
        this.log('warn', 'comment-publish-failed', {
          anchorId,
          commentId: comment.id,
          error: errorText(error),
        })
        return outcome
      }

      // Advance the watermark only after the cloud acknowledges. A disk-write failure is logged by the cursor, which keeps its in-memory value, so publishing is not blocked.
      await this.deps.cursor.setPublished(anchorId, comment.id)
      outcome.published += 1
      this.log('info', 'comment-published', { anchorId, commentId: comment.id })
    }
    return outcome
  }

  /** Enumerate catch-up anchors automatically: every issue in the relation table + every anchor in the cursor table. */
  private knownAnchors(): string[] {
    const ids = new Set<string>()
    try {
      for (const anchorId of this.deps.links.issueIds?.() ?? []) ids.add(anchorId)
    } catch (error) {
      this.log('warn', 'comment-publish-enumerate-failed', errorText(error))
    }
    for (const anchorId of Object.keys(this.cursorSnapshot().byAnchor)) ids.add(anchorId)
    return [...ids]
  }

  /** Cursor-table snapshot; on a read failure treat it as empty (catch-up can still enumerate from the relation table). */
  private cursorSnapshot(): { byAnchor: Record<string, string> } {
    try {
      return this.deps.cursor.snapshot()
    } catch (error) {
      this.log('warn', 'comment-publish-cursor-snapshot-failed', errorText(error))
      return { byAnchor: {} }
    }
  }

  private canPublish(): boolean {
    if (this.deps.canPublish === undefined) return true
    try {
      return this.deps.canPublish() !== false
    } catch (error) {
      this.log('warn', 'comment-publish-lease-failed', errorText(error))
      return false
    }
  }

  private stateOf(anchorId: string): AnchorState {
    const existing = this.states.get(anchorId)
    if (existing !== undefined) return existing
    const created: AnchorState = { dirty: false }
    this.states.set(anchorId, created)
    return created
  }

  private armTimer(): void {
    if (this.timer !== undefined) return
    const delay = Math.max(1, Math.round(this.deps.debounceMs ?? DEFAULT_PUBLISH_DEBOUNCE_MS))
    this.timer = this.setTimer(() => {
      this.timer = undefined
      void this.flushAll().catch((error: unknown) => {
        this.log('warn', 'comment-publish-debounce-failed', errorText(error))
      })
    }, delay)
    unrefTimer(this.timer)
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    this.clearTimerHandle(this.timer)
    this.timer = undefined
  }

  private setTimer(callback: () => void, delayMs: number): unknown {
    if (this.deps.setTimer !== undefined) return this.deps.setTimer(callback, delayMs)
    const handle = setTimeout(callback, delayMs)
    handle.unref?.()
    return handle
  }

  private clearTimerHandle(handle: unknown): void {
    if (this.deps.clearTimer !== undefined) {
      this.deps.clearTimer(handle)
      return
    }
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private log(level: 'info' | 'warn', event: string, detail?: unknown): void {
    this.deps.log?.(level, event, detail)
  }
}

function unrefTimer(handle: unknown): void {
  ;(handle as { unref?: () => void } | undefined)?.unref?.()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A cloud answer that proves the issue row does not exist (not a transient network failure). */
function isMissingCloudAnchor(error: unknown): boolean {
  const text = errorText(error)
  return /\b(404|500)\b/.test(text)
    || /not[_ -]?found|not exist|不存在|unknown (?:issue|anchor)/i.test(text)
}

export type { CommentOrigin, ThreadComment }
