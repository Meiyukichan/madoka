/**
 * Comment service -- the **only** read/write entry point for comments on this machine.
 *
 * A local comment goes through four beats after persistence, in a fixed order:
 *
 * | Beat | Action | Notes |
 * |---|---|---|
 * | 1 | `append` | Write to the append-only local JSONL; idempotent registration happens in the same step |
 * | 2 | `touch` | Move the relation table's red dot (`lastCommentAt`) forward only |
 * | 3 | `publish` | Ask the publisher to upload asynchronously; failures are covered by its watermark |
 * | 4 | `deliver` | Deliver immediately only when the target session exists locally |
 *
 * 1 and 2 must precede 3 and 4. Uploading first would let polling pull the same comment back before it exists locally
 * and inject it twice; delivering first would lose the message forever if delivery failed (nothing else records it as
 * pending). Funneling all four beats into this service means tools / routing / settlement / scheduling / polling do not repeat them.
 *
 * @module dsh-magica-castboard/host/pipeline/thread
 */
import { eventLog } from '../shared/event-log.ts'
import { randomUUID } from 'node:crypto'

import {
  MAX_COMMENT_BODY,
  type CommentOrigin,
  type CommentStore,
  type ThreadComment,
  type ThreadCommentAuthorType,
} from '../ledger/comment-store.ts'
import { isIssueAnchor, type LinkStore } from '../ledger/link-store.ts'
import type { CommentSide } from '../ledger/link-types.ts'

/** A comment waiting to be written (defaults are filled in by the service). */
export interface CommentDraft {
  /** Explicit id (cloud row / idempotent replay); omitted = mint a standard UUID. */
  id?: string
  origin?: CommentOrigin
  author?: string
  /** Body (the caller validates; this only applies a safety truncation). */
  body: string
  systemKey?: string
  systemParams?: Record<string, string>
  /** Explicit time (system messages need the settlement timestamp); omitted = `deps.now()`. */
  createdAt?: number
  /** Session that wrote the comment (present for agent / system messages, absent for human writes). */
  threadId?: string
  role?: CommentSide | null
  /** Author type; omitted = inferred from `systemKey` / `threadId`. */
  authorType?: ThreadCommentAuthorType
}

export interface ThreadServiceDeps {
  readonly links: LinkStore
  readonly comments: CommentStore
  /** Ask the publisher to upload after persistence (async, best effort, not awaited); absent = no upload. */
  readonly publish?: (anchorId: string) => void
  /** Deliver immediately after persistence (only when a target exists locally); absent = no delivery. */
  readonly deliver?: (source: CommentOrigin, anchorId: string, comments: readonly ThreadComment[]) => Promise<void>
  readonly now: () => number
}

function present(value: string | undefined): value is string {
  return value !== undefined && value !== ''
}

function warn(event: string, detail: string): void {
  eventLog('warn', event, detail)
}

/** Error text (avoids dumping the whole Error object). */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function latestStamp(comments: readonly ThreadComment[]): number {
  return comments.reduce((max, comment) => Math.max(max, comment.createdAt), 0)
}

function clipBody(body: string): string {
  return body.length > MAX_COMMENT_BODY ? body.slice(0, MAX_COMMENT_BODY) : body
}

/**
 * Drop the shared-library echo of a local write (different origin, same body/role,
 * within five seconds). The renderer stays byte-identical to raw host; dedupe happens
 * at the read boundary instead.
 */
function dedupeEchoes(comments: readonly ThreadComment[]): ThreadComment[] {
  const out: ThreadComment[] = []
  for (const comment of comments) {
    const echo = out.some(previous =>
      previous.origin !== comment.origin
      && previous.role === comment.role
      && previous.authorType === comment.authorType
      && previous.body === comment.body
      && Math.abs(previous.createdAt - comment.createdAt) <= 5_000,
    )
    if (!echo) out.push(comment)
  }
  return out
}

/** Author-type inference: system message -> system; carries a session -> agent; otherwise -> user. */
function inferAuthorType(draft: CommentDraft): ThreadCommentAuthorType {
  if (draft.systemKey !== undefined) return 'system'
  return present(draft.threadId) ? 'agent' : 'user'
}

function buildRow(draft: CommentDraft, clock: () => number): ThreadComment {
  const row: ThreadComment = {
    id: draft.id ?? randomUUID(),
    body: clipBody(draft.body),
    createdAt: draft.createdAt ?? clock(),
    role: draft.role ?? null,
    authorType: draft.authorType ?? inferAuthorType(draft),
    origin: draft.origin ?? 'local',
  }
  if (present(draft.threadId)) row.threadId = draft.threadId
  if (present(draft.author)) row.author = draft.author
  if (draft.systemKey !== undefined) row.systemKey = draft.systemKey
  if (draft.systemParams !== undefined) row.systemParams = draft.systemParams
  return row
}

export class ThreadService {
  private readonly deps: ThreadServiceDeps
  /**
   * References coverage watermark: anchor -> the largest `createdAt` actually handed out by this turn's
   * `<castboard_task_references>` (0 = none handed out).
   *
   * Records facts only and lives in memory only: it describes what this turn's session has seen, which has no meaning across restarts.
   */
  private readonly coverage = new Map<string, number>()

  constructor(deps: ThreadServiceDeps) {
    this.deps = deps
  }

  /**
   * Which comment references have reached (`createdAt`; 0 = none handed out).
   *
   * The deliverer uses this to avoid double injection with `<castboard_task_references>`: only comments strictly after the watermark are sent.
   *
   * @param anchorId - Anchor.
   */
  coveredUntil(anchorId: string): number {
    return this.coverage.get(anchorId) ?? 0
  }

  /**
   * Record the comments references **actually handed out** this turn (facts only, no guessing about ordering).
   *
   * @param anchorId - Anchor.
   * @param comments - Comments already handed out with references.
   * @returns The updated coverage watermark.
   */
  markCovered(anchorId: string, comments: readonly ThreadComment[]): number {
    const reached = latestStamp(comments)
    const floor = this.coverage.get(anchorId) ?? 0
    if (reached <= floor) return floor
    this.coverage.set(anchorId, reached)
    return reached
  }

  /**
   * Read the latest N (detail panel / tool receipt; avoids stuffing hundreds into the prompt).
   *
   * @param anchorId - Anchor.
   * @param limit - Maximum rows returned (the last ones).
   */
  async recent(anchorId: string, limit: number): Promise<ThreadComment[]> {
    const all = dedupeEchoes(await this.deps.comments.list(anchorId))
    const keep = Math.max(0, Math.floor(limit))
    return keep >= all.length ? all : all.slice(all.length - keep)
  }

  async list(anchorId: string): Promise<ThreadComment[]> {
    return dedupeEchoes(await this.deps.comments.list(anchorId))
  }

  async count(anchorId: string): Promise<number> {
    const rows = await this.list(anchorId)
    return rows.length
  }

  /**
   * Append one local comment (see the module comment for the four beats).
   *
   * @param anchorId - Anchor ({@link anchorOf}).
   * @param draft - Comment content.
   * @param options - `deliver: false` skips delivery (the caller handles it).
   * @returns The persisted row; `undefined` when the id already exists (idempotent replay).
   * @throws When persistence fails or this process lacks write permission.
   */
  async add(
    anchorId: string,
    draft: CommentDraft,
    options: { deliver?: boolean } = {},
  ): Promise<ThreadComment | undefined> {
    const [only] = await this.addMany(anchorId, [draft], options)
    return only
  }

  async addMany(
    anchorId: string,
    drafts: readonly CommentDraft[],
    options: { deliver?: boolean } = {},
  ): Promise<ThreadComment[]> {
    const rows = drafts.map(draft => this.materialize(draft))
    const persisted = await this.appendRows(anchorId, rows)
    if (persisted.length === 0) return []
    await this.afterAppend(anchorId, persisted, options)
    return persisted
  }

  /**
   * Record a system message ("execution failed", "auto-moved to acceptance", etc. from settlement / the scheduler).
   *
   * The only difference from {@link add} is the fixed `role` / `authorType`; the deliverer skips waking sessions by
   * `authorType === 'system'`. Failures are only logged: a system message is a trace and must not make settlement or
   * scheduling fail because a comment could not be written.
   *
   * @param anchorId - Anchor.
   * @param draft - Content (`role` / `authorType` are fixed by this method).
   * @returns The persisted row; `undefined` on failure.
   */
  async addSystem(
    anchorId: string,
    draft: Omit<CommentDraft, 'role' | 'authorType'>,
  ): Promise<ThreadComment | undefined> {
    const forced: CommentDraft = { ...draft, role: 'assignee', authorType: 'system' }
    try {
      return await this.add(anchorId, forced)
    } catch (error) {
      warn('system-comment-failed', `${anchorId}: ${reasonOf(error)}`)
      return undefined
    }
  }

  /**
   * Persist comments pulled from the cloud (`origin: 'remote'`, existing comments are not replayed).
   *
   * Unlike {@link addMany}: no `publish` (re-sending remote rows would loop) and no delivery (history must not be
   * replayed; only comments that newly arrived are delivered, and the poller handles that from the return value).
   *
   * @param anchorId - Anchor.
   * @param drafts - Rows from the cloud (`id` must be the cloud `commentId`).
   * @returns The rows really newly persisted (after idempotent deduplication).
   */
  async ingest(anchorId: string, drafts: readonly CommentDraft[]): Promise<ThreadComment[]> {
    const existing = await this.deps.comments.list(anchorId)
    const now = this.deps.now()
    // A locally written comment is published and then comes back from the shared library
    // with a different id. Do not persist (or re-deliver) that echo as a second comment.
    const fresh = drafts.filter(draft => !existing.some(row =>
      row.origin === 'local'
      && row.role === (draft.role ?? null)
      && row.body === draft.body
      && Math.abs(row.createdAt - (draft.createdAt ?? now)) <= 5_000,
    ))
    if (fresh.length === 0) return []
    const incoming = fresh.map(draft => this.materialize({ ...draft, origin: 'remote' }))
    const added = await this.appendRows(anchorId, incoming)
    if (added.length === 0) return []
    await this.advanceRedDot(anchorId, added)
    return added
  }

  /**
   * A person viewed this issue: push `lastSeenAt` to `max(now, lastCommentAt)`.
   *
   * Write only when there are unread comments (writing `lastSeenAt` for an issue without comments would bump revision for nothing).
   * `max` offsets cross-machine clock skew: `lastCommentAt` may come from another machine.
   *
   * @param anchorId - Anchor.
   * @returns The semantic read timestamp.
   */
  async markRead(anchorId: string): Promise<number> {
    if (!isIssueAnchor(anchorId)) return this.deps.now()
    const link = this.deps.links.get(anchorId)
    if (link === undefined) return this.deps.now()
    const commentedAt = link.lastCommentAt ?? 0
    const seenAt = Math.max(this.deps.now(), commentedAt)
    if (commentedAt > (link.lastSeenAt ?? 0)) {
      await this.deps.links.patch(anchorId, { lastSeenAt: seenAt })
    }
    return seenAt
  }

  private async appendRows(anchorId: string, rows: readonly ThreadComment[]): Promise<ThreadComment[]> {
    if (rows.length === 0) return []
    return this.deps.comments.append(anchorId, rows)
  }

  /** The three beats after persistence: red dot -> upload -> (optional) delivery. */
  private async afterAppend(
    anchorId: string,
    comments: readonly ThreadComment[],
    options: { deliver?: boolean },
  ): Promise<void> {
    await this.advanceRedDot(anchorId, comments)
    this.requestPublish(anchorId)
    if (options.deliver === false) return
    await this.deliverComments('local', anchorId, comments)
  }

  /**
   * Update the relation table's `lastCommentAt` (red dot).
   *
   * Forward only: the polling overlap window re-delivers earlier comments, and `max` keeps the red dot from being erased by them.
   *
   * @param anchorId - Anchor.
   * @param comments - Comments actually persisted this time.
   */
  private async advanceRedDot(anchorId: string, comments: readonly ThreadComment[]): Promise<void> {
    if (!isIssueAnchor(anchorId)) return
    const newest = latestStamp(comments)
    if (newest <= (this.deps.links.get(anchorId)?.lastCommentAt ?? 0)) return
    try {
      await this.deps.links.patch(anchorId, { lastCommentAt: newest })
    } catch (error) {
      // A failed relation-table write only affects the red dot; it must not fail the comment write (the comment is already in the jsonl).
      warn('link-touch-failed', `${anchorId}: ${reasonOf(error)}`)
    }
  }

  /** Ask the publisher to upload (not awaited, never throws). */
  private requestPublish(anchorId: string): void {
    const publish = this.deps.publish
    if (publish === undefined) return
    try {
      publish(anchorId)
    } catch (error) {
      warn('publish-schedule-failed', `${anchorId}: ${reasonOf(error)}`)
    }
  }

  /** Deliver immediately (never throws: the comment is persisted, and the deliverer records its own debt on failure). */
  private async deliverComments(
    source: CommentOrigin,
    anchorId: string,
    comments: readonly ThreadComment[],
  ): Promise<void> {
    const deliver = this.deps.deliver
    if (deliver === undefined) return
    try {
      await deliver(source, anchorId, comments)
    } catch (error) {
      warn('deliver-failed', `${anchorId}: ${reasonOf(error)}`)
    }
  }

  private materialize(draft: CommentDraft): ThreadComment {
    return buildRow(draft, this.deps.now)
  }
}

/**
 * Anchor: use the issue when present, otherwise the manual card's own id.
 *
 * The two id spaces do not collide (issues are UUIDs, tasks are `t-xxx-yyy`), so they can share one comment table.
 *
 * @param task - Any record carrying an `id` / `issueId`.
 */
export function anchorOf(task: { id: string; issueId?: string }): string {
  return present(task.issueId) ? task.issueId : task.id
}
