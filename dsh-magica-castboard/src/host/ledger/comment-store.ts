/**
 * Comment log for one anchor, stored as `comments/<anchorId>.jsonl`.
 *
 * The anchor is `task.issueId ?? task.id`. Keeping comments in their own append-only file
 * makes an append O(1) regardless of how large the task or issue ledger grows.
 *
 * Each line is one compact JSON object, and lines are never reordered. Every anchor has one
 * serial channel, so concurrent appends cannot interleave half lines. A line is appended and
 * fsynced before its id is added to the in-memory set, which means a failed write can still
 * be retried. Reads skip malformed and over-long lines and sort by `createdAt`. Duplicate
 * detection uses an in-process `Set<commentId>` built on first access.
 *
 * @module dsh-magica-castboard/host/ledger/comment-store
 */
import { eventLog } from '../shared/event-log.ts'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { isValidId } from './paths.ts'
import { COMMENT_SIDES } from './link-types.ts'
import {
  THREAD_AUTHOR_TYPES,
  type CommentOrigin,
  type CommentSide,
  type ThreadComment,
  type ThreadCommentAuthorType,
} from '../model.ts'

export type { CommentOrigin, ThreadComment, ThreadCommentAuthorType }
export { THREAD_AUTHOR_TYPES }

const AUTHOR_TYPE_SET: ReadonlySet<string> = new Set(THREAD_AUTHOR_TYPES)
const SIDE_SET: ReadonlySet<string> = new Set(COMMENT_SIDES)

const COMMENTS_DIR = 'comments'

export const MAX_COMMENT_BODY = 4000

/** Longer than this and the line is certainly corrupt, not merely a big comment. */
export const MAX_COMMENT_LINE = 64 * 1024

const SYSTEM_PARAMS_KEPT = 20
const SYSTEM_KEY_MAX = 100

export interface CommentStoreOptions {
  dir: string
  /**
   * Read-only hosts must not append: two processes writing the same append-only file would
   * interleave lines.
   */
  canWrite?: () => boolean
}

interface AnchorChannel {
  tail: Promise<unknown>
  known?: Set<string>
}

function warn(event: string, detail: unknown): void {
  eventLog('warn', event, String(detail))
}

function explain(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function stampOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function decodeParams(raw: unknown): Record<string, string> | undefined {
  if (!isPlainObject(raw)) return undefined
  const kept = Object.entries(raw)
    .filter(([key, value]) => key.length <= SYSTEM_KEY_MAX && typeof value === 'string')
    .slice(0, SYSTEM_PARAMS_KEPT)
  return Object.fromEntries(kept) as Record<string, string>
}

function decodeExtras(source: Record<string, unknown>): Partial<ThreadComment> {
  const extras: Partial<ThreadComment> = {}
  const threadId = textOf(source.threadId)
  const author = textOf(source.author)
  const systemKey = textOf(source.systemKey)
  if (threadId !== undefined) extras.threadId = threadId
  if (author !== undefined) extras.author = author
  if (systemKey !== undefined) extras.systemKey = systemKey
  return extras
}

/**
 * A line that does not decode is reported as `undefined`; the reader counts and skips it.
 */
function decodeComment(raw: unknown): ThreadComment | undefined {
  const source = isPlainObject(raw) ? raw : undefined
  if (source === undefined) return undefined
  const id = textOf(source.id)
  const body = textOf(source.body)
  const createdAt = stampOf(source.createdAt)
  if (id === undefined || body === undefined || createdAt === undefined) return undefined

  const params = decodeParams(source.systemParams)
  const clipped = body.length > MAX_COMMENT_BODY ? body.slice(0, MAX_COMMENT_BODY) : body
  return {
    id,
    body: clipped,
    createdAt,
    role: typeof source.role === 'string' && SIDE_SET.has(source.role) ? source.role as CommentSide : null,
    authorType: typeof source.authorType === 'string' && AUTHOR_TYPE_SET.has(source.authorType)
      ? source.authorType as ThreadCommentAuthorType
      : 'user',
    // Missing origin defaults to remote: resending is worse than not sending. Normal writes
    // always set it explicitly.
    origin: source.origin === 'local' ? 'local' : 'remote',
    ...decodeExtras(source),
    ...(params === undefined ? {} : { systemParams: params }),
  }
}

export class CommentStore {
  private readonly directory: string
  private readonly lease: () => boolean
  private readonly channels = new Map<string, AnchorChannel>()

  constructor(options: CommentStoreOptions) {
    this.directory = join(options.dir, COMMENTS_DIR)
    this.lease = options.canWrite ?? (() => true)
  }

  writable(): boolean {
    return gateOpen(this.lease)
  }

  /**
   * Append comments, skipping ids that are already on disk.
   *
   * Deduplication belongs here because overlapping poll windows and concurrent tool calls
   * both submit the same comment.
   *
   * @returns Only the comments actually written, which is what the caller should deliver.
   */
  async append(anchorId: string, comments: readonly ThreadComment[]): Promise<ThreadComment[]> {
    this.assertAnchor(anchorId)
    if (comments.length === 0) return []
    return this.schedule(anchorId, async () => {
      this.assertWritable()
      const known = await this.knownIds(anchorId)
      const fresh = comments.filter(comment => !known.has(comment.id))
      if (fresh.length === 0) return []
      await this.writeLines(anchorId, fresh)
      // Register ids only after the write lands; otherwise one failure would mark these
      // comments as processed forever.
      for (const comment of fresh) known.add(comment.id)
      return fresh
    })
  }

  /** Ascending `createdAt`; same-millisecond rows keep their append order. */
  async list(anchorId: string): Promise<ThreadComment[]> {
    this.assertAnchor(anchorId)
    return this.schedule(anchorId, () => this.readAll(anchorId))
  }

  async seenIds(anchorId: string): Promise<ReadonlySet<string>> {
    this.assertAnchor(anchorId)
    return this.schedule(anchorId, () => this.knownIds(anchorId))
  }

  async has(anchorId: string, commentId: string): Promise<boolean> {
    this.assertAnchor(anchorId)
    return this.schedule(anchorId, async () => (await this.knownIds(anchorId)).has(commentId))
  }

  /** Delete the whole log, used when a card is purged. */
  async remove(anchorId: string): Promise<boolean> {
    this.assertAnchor(anchorId)
    return this.schedule(anchorId, async () => {
      this.channelOf(anchorId).known = undefined
      const target = this.fileOf(anchorId)
      let missing = false
      try {
        await unlink(target)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') throw error
        missing = true
      }
      return !missing
    })
  }

  private async readAll(anchorId: string): Promise<ThreadComment[]> {
    const text = await this.readText(anchorId)
    if (text === undefined) return []
    const rows: ThreadComment[] = []
    let skipped = 0
    for (const line of text.split('\n')) {
      if (line === '') continue
      if (line.length > MAX_COMMENT_LINE) {
        skipped += 1
        continue
      }
      const comment = decodeLine(line)
      if (comment === undefined) {
        skipped += 1
        continue
      }
      rows.push(comment)
    }
    if (skipped > 0) warn('comments-partial', `${anchorId}: 跳过 ${String(skipped)} 行不可读内容`)
    // V8's sort is stable, so the same millisecond keeps append order.
    return rows.sort((left, right) => left.createdAt - right.createdAt)
  }

  private async readText(anchorId: string): Promise<string | undefined> {
    try {
      return await readFile(this.fileOf(anchorId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        warn('comments-unreadable', `${anchorId}: ${explain(error)}`)
      }
      return undefined
    }
  }

  private async writeLines(anchorId: string, comments: readonly ThreadComment[]): Promise<void> {
    const target = this.fileOf(anchorId)
    await mkdir(dirname(target), { recursive: true })
    const payload = comments.map(comment => `${JSON.stringify(comment)}\n`).join('')
    const handle = await open(target, 'a')
    try {
      await handle.appendFile(payload, 'utf8')
      // Persisted-before-delivered depends on this fsync: losing the line on a power cut
      // means the comment is neither shown nor sent.
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  // Must stay inside the serial channel; otherwise concurrent appends each build their own
  // copy of the id set.
  private async knownIds(anchorId: string): Promise<Set<string>> {
    const channel = this.channelOf(anchorId)
    if (channel.known !== undefined) return channel.known
    const loaded = new Set<string>()
    for (const comment of await this.readAll(anchorId)) loaded.add(comment.id)
    channel.known = loaded
    return loaded
  }

  // The anchor becomes part of a file name, so the whitelist comes first; otherwise `../x`
  // would be a delete-any-file primitive.
  private assertAnchor(anchorId: string): void {
    if (!isValidId(anchorId)) throw new Error(`invalid comment anchor id: ${anchorId}`)
  }

  private assertWritable(): void {
    if (this.writable()) return
    throw new Error('comment store is read-only in this host (another dsh web owns the storage lease)')
  }

  private fileOf(anchorId: string): string {
    return join(this.directory, `${anchorId}.jsonl`)
  }

  private channelOf(anchorId: string): AnchorChannel {
    const existing = this.channels.get(anchorId)
    if (existing !== undefined) return existing
    const created: AnchorChannel = { tail: Promise.resolve() }
    this.channels.set(anchorId, created)
    return created
  }

  /**
   * Queue work on the anchor's channel.
   *
   * A channel that only served reads and never built an id set is removed when idle, so
   * anchors do not accumulate forever.
   */
  private schedule<T>(anchorId: string, job: () => Promise<T>): Promise<T> {
    const channel = this.channelOf(anchorId)
    const outcome = channel.tail.then(job, job)
    const idle = outcome.then(() => undefined, () => undefined)
    channel.tail = idle
    void idle.then(() => {
      if (channel.tail !== idle) return
      if (channel.known !== undefined) return
      if (this.channels.get(anchorId) === channel) this.channels.delete(anchorId)
    })
    return outcome
  }
}

function decodeLine(line: string): ThreadComment | undefined {
  try {
    return decodeComment(JSON.parse(line))
  } catch {
    // Half a line after a power cut, or a bad hand edit: skip it rather than make the whole
    // log unreadable.
    return undefined
  }
}

function gateOpen(check: () => boolean): boolean {
  let open = false
  try {
    open = check()
  } catch {
    /* A throwing predicate = not writable */
  }
  return open
}

/**
 * Failure-tolerant `append` for delivery and upload paths.
 *
 * The comment already exists on disk, so a failed write only weakens resend idempotency and
 * should not break the caller. First-write paths call `append` and handle the error.
 */
export async function appendCommentsQuiet(
  store: CommentStore,
  anchorId: string,
  comments: readonly ThreadComment[],
  what: string,
): Promise<ThreadComment[]> {
  return store.append(anchorId, comments).catch((error: unknown) => {
    warn('comments-append-failed', `${what} ${anchorId}: ${explain(error)}`)
    return []
  })
}
