/**
 * Two cursors with different durability requirements.
 *
 * `comment-cursor.json` tracks the last pulled comment id. It can be flushed lazily (every
 * 30s or on exit): after a restart the poller re-pulls one window and deduplicates by
 * comment id, so pulling a little extra costs one request.
 *
 * `comment-publish-cursor.json` tracks per-anchor publish watermarks and uploaded files. It
 * must be written immediately: it is the only record that "this already reached the cloud",
 * and losing it would send the same comment twice.
 *
 * @module dsh-magica-castboard/host/ledger/cursors
 */
import { eventLog } from '../shared/event-log.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { persistJson } from './atomic.ts'

const PULL_CURSOR_FILE = 'comment-cursor.json'
const PUBLISH_CURSOR_FILE = 'comment-publish-cursor.json'

export const PULL_FLUSH_INTERVAL_MS = 30_000

function warn(event: string, detail: unknown): void {
  eventLog('warn', event, String(detail))
}

function explain(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A cursor file is disposable state, so unreadable or missing files are not errors.
async function readJsonQuiet(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn('cursor-unreadable', `${file}: ${explain(error)}`)
    }
    return undefined
  }
}

/**
 * Pull position: how far the comment table has been consumed on this machine.
 *
 * It only moves forward; on failure the caller leaves it alone and the next tick re-pulls
 * the same range, with jsonl id deduplication handling the overlap.
 */
export class PullCursorStore {
  private readonly path: string
  private position = 0
  private pendingWrite = false
  private ready = false
  private hydrating: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private writing: Promise<void> | undefined

  constructor(dir: string) {
    this.path = join(dir, PULL_CURSOR_FILE)
  }

  async load(): Promise<void> {
    if (this.ready) return
    this.hydrating ??= this.hydrate().finally(() => { this.hydrating = undefined })
    await this.hydrating
  }

  /** 0 means nothing has been pulled yet. */
  current(): number {
    return this.position
  }

  advance(id: number): void {
    if (!Number.isFinite(id) || id <= this.position) return
    this.position = id
    this.pendingWrite = true
    this.armTimer()
  }

  /**
   * Failures are logged and the dirty flag stays set, so the next flush retries. A single
   * failed write must not pin the cursor at a stale value and force a large re-pull every
   * tick.
   */
  async flush(): Promise<void> {
    this.disarmTimer()
    if (!this.pendingWrite) return
    // Share an in-flight write instead of letting two persists interleave.
    if (this.writing !== undefined) return this.writing
    const snapshot = this.position
    const task = this.persistPosition(snapshot).finally(() => { this.writing = undefined })
    this.writing = task
    return task
  }

  async dispose(): Promise<void> {
    await this.flush()
  }

  private async hydrate(): Promise<void> {
    const stored = await readJsonQuiet(this.path)
    const raw = isPlainObject(stored) ? stored.lastCommentId : undefined
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) this.position = raw
    this.ready = true
  }

  private armTimer(): void {
    if (this.timer !== undefined) return
    const timer = setTimeout(() => { void this.flush() }, PULL_FLUSH_INTERVAL_MS)
    timer.unref?.() // never keep the process alive just for a cursor flush
    this.timer = timer
  }

  private disarmTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private async persistPosition(snapshot: number): Promise<void> {
    try {
      await persistJson(this.path, { lastCommentId: snapshot })
      // Advanced during the flush: stay dirty so the next pass writes the newer value.
      if (this.position === snapshot) this.pendingWrite = false
    } catch (error) {
      warn('cursor-flush-failed', `${this.path}: ${explain(error)}`)
    }
  }
}

export interface PublishCursorFile {
  byAnchor: Record<string, string>
  uploadedFiles: Record<string, string>
}

/**
 * Publish position per anchor. The ordered comment log is the queue: `origin === 'local'`
 * comments after the watermark still need to go out.
 */
export class PublishCursorStore {
  private readonly path: string
  private watermarks: PublishCursorFile = { byAnchor: {}, uploadedFiles: {} }
  private ready = false
  private hydrating: Promise<void> | undefined
  // Serial writes keep concurrent `set*` calls from overwriting each other.
  private tail: Promise<unknown> = Promise.resolve()

  constructor(dir: string) {
    this.path = join(dir, PUBLISH_CURSOR_FILE)
  }

  async load(): Promise<void> {
    if (this.ready) return
    this.hydrating ??= this.hydrate().finally(() => { this.hydrating = undefined })
    await this.hydrating
  }

  lastPublished(anchorId: string): string | undefined {
    return this.watermarks.byAnchor[anchorId]
  }

  uploadedFileId(path: string): string | undefined {
    return this.watermarks.uploadedFiles[path]
  }

  snapshot(): PublishCursorFile {
    return {
      byAnchor: { ...this.watermarks.byAnchor },
      uploadedFiles: { ...this.watermarks.uploadedFiles },
    }
  }

  /**
   * Must be called only after the cloud acknowledged the comment; recording first would
   * count a failed send as delivered.
   */
  async setPublished(anchorId: string, commentId: string): Promise<void> {
    await this.enqueueWrite(state => { state.byAnchor[anchorId] = commentId })
  }

  async setUploadedFile(path: string, fileId: string): Promise<void> {
    await this.enqueueWrite(state => { state.uploadedFiles[path] = fileId })
  }

  private async hydrate(): Promise<void> {
    const stored = await readJsonQuiet(this.path)
    if (isPlainObject(stored)) {
      this.watermarks = {
        byAnchor: readStringMap(stored.byAnchor),
        uploadedFiles: readStringMap(stored.uploadedFiles),
      }
    }
    this.ready = true
  }

  /**
   * A failed write only loses a watermark, and at worst that re-sends one round; the cloud
   * deduplicates by `commentId`. A disk hiccup should not abort publishing.
   */
  private enqueueWrite(apply: (state: PublishCursorFile) => void): Promise<void> {
    const job = async (): Promise<void> => {
      await this.load()
      apply(this.watermarks)
      try {
        await persistJson(this.path, this.watermarks)
      } catch (error) {
        warn('publish-cursor-write-failed', `${this.path}: ${explain(error)}`)
      }
    }
    const scheduled = this.tail.then(job, job)
    // The tail only tracks queue position; job() already swallows write errors.
    this.tail = scheduled.catch(() => undefined)
    return scheduled
  }
}

// Files on disk may have been hand-edited, so keep only usable string pairs.
function readStringMap(raw: unknown): Record<string, string> {
  if (!isPlainObject(raw)) return {}
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === '') continue
    if (typeof value === 'string' && value !== '') kept[key] = value
  }
  return kept
}
