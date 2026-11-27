/**
 * Comment inbox: pulls comment deltas by an ascending cursor and delivers only the rows newly persisted this tick.
 *
 * ## One request + one cursor
 *
 * The comment table has an auto-increment primary key, so the server can return deltas by key:
 *
 * ```text
 * fetchPage({ sinceId: max(0, cursor - 50), limit: 500 })
 * ```
 *
 * The interest set is filtered locally instead of putting issue ids in the request: `IN` misses the index on a large
 * table, and the request count would grow with the number of watched issues. Each pull starts at `cursor - 50` to cover
 * transactions committing during the last tick; duplicate rows are handled by comment-stream id deduplication.
 *
 * ## Discipline
 *
 * | Rule | Reason |
 * |---|---|
 * | Single flight | Never start a second tick while a tick is still in flight, so a slow network cannot pile up requests |
 * | Advance the cursor only on success | On failure the next tick pulls the same range and id deduplication covers it |
 * | Deliver only rows persisted this tick | The persistence return value is idempotent-deduplicated, so rows persisted in the overlap window are not delivered again |
 * | Retry debts first every tick | Purely local work, so it still runs when the network is down; it answers "is anything owed from last time" |
 * | Disabled channel runs no tick at all | Not a single request; local comments are still written and uploaded |
 * | Read the interval every tick | A settings change takes effect next tick without a restart or re-arm |
 *
 * @module dsh-magica-castboard/host/pipeline/inbox
 */
import {
  THREAD_AUTHOR_TYPES,
  type CommentOrigin,
  type ThreadComment,
  type ThreadCommentAuthorType,
} from '../ledger/comment-store.ts'
import type { CommentSide } from '../ledger/link-types.ts'
import { DEFAULT_COMMENT_POLL_MS, MAX_COMMENT_POLL_MS, MIN_COMMENT_POLL_MS } from '../rules.ts'
import type { CommentDraft } from './thread.ts'

/** How far back each pull starts ("cursor - 50") to cover transactions still committing. */
export const COMMENT_OVERLAP = 50

export const COMMENT_PAGE_LIMIT = 500

export interface RemoteComment {
  readonly commentId: string
  readonly issueId: string
  readonly body: string
  readonly createdAt: number
  /** Cloud role; missing / unknown is treated as `assigner`. */
  readonly role?: string | null
  /** Cloud author type; unknown is treated as `user`. */
  readonly authorType?: string | null
  readonly author?: string
}

export interface CommentPage {
  readonly items: readonly RemoteComment[]
  /** Server start key for the next tick (largest id processed this tick). */
  readonly nextSinceId: number
}

export interface CommentIngestFace {
  ingest(anchorId: string, drafts: readonly CommentDraft[]): Promise<ThreadComment[]>
}

export interface CommentDelivererFace {
  deliver(source: CommentOrigin, anchorId: string, comments: readonly ThreadComment[]): Promise<void>
  retryPending(): Promise<number>
}

export interface CommentCursorFace {
  load(): Promise<void>
  /** Largest processed comment id (0 = never pulled). */
  current(): number
  /** Advance the cursor (forward only). */
  advance(id: number): void
}

export interface IssueCommentInboxDeps {
  /**
   * Interest set: only comments for these issues are collected.
   *
   * Assembled by the wiring layer (relation table + running cards + claimed issues not yet turned into cards), and
   * read every tick because the relation table may gain entries between ticks.
   */
  readonly interest: () => ReadonlySet<string>
  readonly fetchPage: (query: { sinceId: number; limit: number }) => Promise<CommentPage>
  readonly thread: CommentIngestFace
  readonly deliverer: CommentDelivererFace
  readonly cursor: CommentCursorFace
  /**
   * Wake the interaction coordinator after new rows are persisted.
   *
   * Correctness still comes from the coordinator's reconcile pass; this only removes the
   * extra polling delay for a remote `answered` comment.
   */
  readonly onIngested?: (anchorId: string, added: readonly ThreadComment[]) => Promise<void>
  /** Channel switch (board setting `commentsEnabled`); enabled by default. */
  readonly enabled?: () => boolean
  /**
   * Storage-lease gate: only the owner polls, because polling writes the comment stream.
   *
   * Omitted = always allowed (tests); the wiring layer passes `lease.isOwner`.
   */
  readonly canPoll?: () => boolean
  readonly now?: () => number
  /** Fixed polling interval (ms); `intervalOf` wins when provided. */
  readonly intervalMs?: number
  /** Live interval provider (board setting `commentPollMs`); called once per tick. */
  readonly intervalOf?: () => number | undefined
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  readonly log?: (level: 'info' | 'warn', event: string, detail?: unknown) => void
}

export interface InboxTickResult {
  /** How many rows this tick fetched (including those outside the interest set). */
  fetched: number
  /** How many rows were really newly persisted. */
  written: number
  /** How many issues were delivered (one batch counts once). */
  delivered: number
  advanced: boolean
}

/**
 * In-process cumulative metrics (reset on restart).
 *
 * They answer only three operational questions: is the channel alive (`ticks` / `lastTickAt`), does it fetch
 * (`fetched` / `written`), and does it deliver (`delivered` / `failures`).
 */
export interface InboxMetrics {
  ticks: number
  failures: number
  fetched: number
  written: number
  delivered: number
  /** Time of the last tick; `undefined` = never completed successfully. */
  lastTickAt?: number
  lastError?: string
}

export class IssueCommentInbox {
  private readonly deps: IssueCommentInboxDeps
  private handle: unknown
  private disposed = false
  /** Single flight: the tick currently in progress. */
  private ticking: Promise<InboxTickResult> | undefined
  private readonly stats: InboxMetrics = { ticks: 0, failures: 0, fetched: 0, written: 0, delivered: 0 }

  constructor(deps: IssueCommentInboxDeps) {
    this.deps = deps
  }

  metrics(): InboxMetrics {
    return { ...this.stats }
  }

  /**
   * Start polling (idempotent).
   *
   * Uses self-rescheduling `setTimeout` rather than `setInterval`: the interval is read every tick, so a settings change
   * applies next tick without a restart or a ledger listener to re-arm.
   */
  start(): void {
    if (this.disposed || this.handle !== undefined) return
    this.schedule()
  }

  stop(): void {
    this.disposed = true
    if (this.handle === undefined) return
    this.cancelTimer(this.handle)
    this.handle = undefined
  }

  /**
   * Run one tick (single flight: returns the same promise while one is in flight).
   *
   * @returns The result of this tick.
   */
  tick(): Promise<InboxTickResult> {
    this.ticking ??= this.runTick().finally(() => { this.ticking = undefined })
    return this.ticking
  }

  private async runTick(): Promise<InboxTickResult> {
    const idle: InboxTickResult = { fetched: 0, written: 0, delivered: 0, advanced: false }
    if (this.disposed) return idle
    // With the comment channel off, send no request at all. Local writes and cloud uploads are unaffected.
    if (!this.channelEnabled()) return idle
    // Only the lease owner may poll: a secondary host writing the same jsonl would interleave lines.
    if (!this.ownerAllowed()) return idle

    // Retry debts first: it is purely local work, so it runs before fetch and still works when the network is down.
    await this.retryPending()
    await this.deps.cursor.load()

    const sinceId = Math.max(0, this.deps.cursor.current() - COMMENT_OVERLAP)
    let page: CommentPage
    try {
      page = await this.deps.fetchPage({ sinceId, limit: COMMENT_PAGE_LIMIT })
    } catch (error) {
      // A failed pull does not advance the cursor: the next tick re-pulls the same range and the stream deduplicates by id.
      this.fail('inbox.fetch-failed', error)
      return idle
    }

    // Read the interest set **after** the fetch: an issue that became interesting while the request
    // was in flight must still be filtered in, not skipped for one more tick.
    let interest: ReadonlySet<string>
    try {
      interest = this.deps.interest()
    } catch (error) {
      this.fail('inbox.interest-failed', error)
      return idle
    }

    // Filter the interest set locally: the server only returns deltas by primary key.
    const fresh = page.items.filter(item => interest.has(item.issueId))
    const ingested = await this.ingestByAnchor(fresh)
    // Any anchor failing to persist means the cursor does not advance; the next tick re-pulls and successful anchors deduplicate by id.
    if (!ingested.failed) this.deps.cursor.advance(page.nextSinceId)
    await this.notifyIngested(ingested.added)
    const delivered = await this.deliverByAnchor(ingested.added)

    const result: InboxTickResult = {
      fetched: page.items.length,
      written: countRows(ingested.added),
      delivered,
      advanced: !ingested.failed && page.nextSinceId > sinceId,
    }
    this.stats.ticks += 1
    this.stats.fetched += result.fetched
    this.stats.written += result.written
    this.stats.delivered += result.delivered
    this.stats.lastTickAt = this.now()
    this.stats.lastError = undefined
    if (result.fetched > 0 || result.written > 0) this.log('info', 'inbox.tick', result)
    return result
  }

  private schedule(): void {
    if (this.disposed) return
    this.handle = this.setTimer(() => {
      this.handle = undefined
      void this.tick()
        .catch((error: unknown) => { this.log('warn', 'inbox.tick-failed', errorText(error)) })
        .finally(() => { this.schedule() })
    }, this.interval())
    unrefTimer(this.handle)
  }

  private interval(): number {
    let configured: number | undefined
    try {
      configured = this.deps.intervalOf?.()
    } catch {
      configured = undefined
    }
    const value = configured ?? this.deps.intervalMs ?? DEFAULT_COMMENT_POLL_MS
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_COMMENT_POLL_MS
    return Math.min(MAX_COMMENT_POLL_MS, Math.max(MIN_COMMENT_POLL_MS, Math.round(value)))
  }

  /** Whether the channel is enabled (a settings read failure counts as disabled: better no requests than stray ones). */
  private channelEnabled(): boolean {
    if (this.deps.enabled === undefined) return true
    try {
      return this.deps.enabled() !== false
    } catch (error) {
      this.fail('inbox.settings-failed', error)
      return false
    }
  }

  /** Whether this process holds the storage lease (a throwing predicate counts as "no"). */
  private ownerAllowed(): boolean {
    if (this.deps.canPoll === undefined) return true
    try {
      return this.deps.canPoll() !== false
    } catch (error) {
      this.fail('inbox.lease-failed', error)
      return false
    }
  }

  /** Redelivery at the start of each tick; failures only log and do not block the tick. */
  private async retryPending(): Promise<void> {
    try {
      await this.deps.deliverer.retryPending()
    } catch (error) {
      this.log('warn', 'inbox.retry-failed', errorText(error))
    }
  }

  /**
   * Persist per issue bucket (one append per issue's batch).
   *
   * @returns The rows really newly written per issue, and whether any persistence failed.
   */
  private async ingestByAnchor(
    items: readonly RemoteComment[],
  ): Promise<{ added: Map<string, ThreadComment[]>; failed: boolean }> {
    const added = new Map<string, ThreadComment[]>()
    let failed = false
    for (const [anchorId, group] of groupBy(items, item => item.issueId)) {
      try {
        const rows = await this.deps.thread.ingest(anchorId, group.map(toDraft))
        if (rows.length > 0) added.set(anchorId, rows)
      } catch (error) {
        // One issue failing to persist must not void the whole tick, but the cursor still must not advance; the next tick re-pulls.
        failed = true
        this.log('warn', 'inbox.ingest-failed', { anchorId, error: errorText(error) })
      }
    }
    return { added, failed }
  }

  /**
   * Deliver comments newly persisted this tick (one delivery per issue).
   *
   * Delivery failure does not affect the cursor: the comments are already in the jsonl, and the deliverer catches up via debts.
   */
  private async deliverByAnchor(added: ReadonlyMap<string, ThreadComment[]>): Promise<number> {
    let delivered = 0
    for (const [anchorId, rows] of added) {
      if (rows.length === 0) continue
      try {
        await this.deps.deliverer.deliver('remote', anchorId, rows)
        delivered += 1
      } catch (error) {
        this.log('warn', 'inbox.deliver-failed', { anchorId, error: errorText(error) })
      }
    }
    return delivered
  }

  /**
   * Notify the coordinator after persistence, before delivery.
   *
   * Failures only log: the comments are already stored, and the coordinator's safety tick
   * still reconciles them.
   */
  private async notifyIngested(added: ReadonlyMap<string, ThreadComment[]>): Promise<void> {
    const hook = this.deps.onIngested
    if (hook === undefined) return
    for (const [anchorId, rows] of added) {
      if (rows.length === 0) continue
      try {
        await hook(anchorId, rows)
      } catch (error) {
        this.log('warn', 'inbox.on-ingested-failed', { anchorId, error: errorText(error) })
      }
    }
  }

  private fail(event: string, error: unknown): void {
    this.stats.failures += 1
    this.stats.lastError = errorText(error)
    this.log('warn', event, this.stats.lastError)
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

  private cancelTimer(handle: unknown): void {
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

function toDraft(item: RemoteComment): CommentDraft {
  return {
    id: item.commentId,
    body: item.body,
    createdAt: item.createdAt,
    // Unknown direction (web write / history) stays `null`, not `assigner`: delivery routes
    // `null` to the executor anyway, but the stored row must keep the cloud's fact.
    role: asSide(item.role),
    authorType: asAuthorType(item.authorType),
    ...(item.author === undefined || item.author === '' ? {} : { author: item.author }),
  }
}

/**
 * Normalize the cloud role: only an explicit value counts; everything else (missing,
 * hand-written on the web) stays unknown.
 */
function asSide(role: string | null | undefined): CommentSide | null {
  return role === 'assignee' || role === 'assigner' ? role : null
}

/** Normalize the cloud author type (unknown -> `user`). */
function asAuthorType(value: string | null | undefined): ThreadCommentAuthorType {
  if (typeof value === 'string' && (THREAD_AUTHOR_TYPES as readonly string[]).includes(value)) {
    return value as ThreadCommentAuthorType
  }
  return 'user'
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const bucket = out.get(key)
    if (bucket === undefined) out.set(key, [item])
    else bucket.push(item)
  }
  return out
}

function countRows(added: ReadonlyMap<string, ThreadComment[]>): number {
  let total = 0
  for (const rows of added.values()) total += rows.length
  return total
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unrefTimer(handle: unknown): void {
  ;(handle as { unref?: () => void } | undefined)?.unref?.()
}
