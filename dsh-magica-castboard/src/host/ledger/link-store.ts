/**
 * Disk layer for `castboard-link.json`, the lightweight issue ⇄ task ⇄ session index.
 *
 * The file is `{ schemaVersion, revision, links: { <issueId>: IssueLink } }`. Only links
 * that are actively collaborating live here, each a few dozen bytes, and writes are
 * comment-driven and rare. The whole file is rewritten instead of appending a log, which
 * keeps a single file as the complete truth.
 *
 * All writes share one serial gate, so commit order equals call order. The lease is checked
 * again at the commit point, not just at the call site, so two hosts cannot rewrite the
 * file at once. Persistence is atomic (temp file + fsync + rename). Loading never throws: a
 * corrupt file is quarantined and the table starts empty, and bad entries are skipped.
 * Records handed to callers are frozen, and `revision` lets read-only processes detect
 * changes made by the owner.
 *
 * @module dsh-magica-castboard/host/ledger/link-store
 */
import { eventLog } from '../shared/event-log.ts'
import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

import { deepFreeze, persistJson } from './atomic.ts'
import {
  isEmptyLink,
  mergeLink,
  LINK_SCHEMA_VERSION,
  type IssueLinkPatch,
  type LinkIndexFile,
  type IssueLink,
} from './link-types.ts'

const LINK_FILE = 'castboard-link.json'

const ISSUE_ANCHOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The relationship table is keyed by issue ids only; task ids are card anchors, not peers. */
export function isIssueAnchor(id: string): boolean {
  return ISSUE_ANCHOR.test(id)
}

const TEXT_COLUMNS = ['assignerSessionId', 'assigneeTaskId', 'assigneeSessionId'] as const

const TIME_COLUMNS = ['lastSeenAt', 'lastCommentAt', 'assignerPendingSince', 'assigneePendingSince'] as const

export interface LinkChange {
  kind: 'link-updated' | 'link-removed'
  revision: number
  issueId: string
  link?: IssueLink
}

export interface LinkStoreOptions {
  dir: string
  /**
   * Lease predicate. It is consulted at commit time, because the lease can be lost between
   * the caller's check and the write.
   */
  canWrite?: () => boolean
}

interface TableState {
  records: Map<string, IssueLink>
  generation: number
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

/**
 * Best-effort decode: unusable fields and empty records are dropped.
 *
 * A damaged link table only loses routing targets for a while; the comments are still in
 * jsonl, and the next write restores the record.
 */
function decodeLink(raw: unknown): IssueLink | undefined {
  if (!isPlainObject(raw)) return undefined
  const link: IssueLink = {}
  for (const column of TEXT_COLUMNS) {
    const value = raw[column]
    if (typeof value === 'string' && value.length > 0) link[column] = value
  }
  for (const column of TIME_COLUMNS) {
    const value = raw[column]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) link[column] = value
  }
  return isEmptyLink(link) ? undefined : link
}

// Chaining even after a rejection makes each job observe everything committed before it.
class WriteGate {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(job: () => Promise<T>): Promise<T> {
    const settled = this.tail.then(job, job)
    this.tail = settled.catch(() => undefined)
    return settled
  }
}

export class LinkStore {
  private readonly path: string
  private readonly lease: () => boolean
  private table: TableState = { records: new Map(), generation: 0 }
  private ready = false
  private hydrating: Promise<void> | undefined
  private readonly gate = new WriteGate()

  constructor(options: LinkStoreOptions) {
    this.path = join(options.dir, LINK_FILE)
    this.lease = options.canWrite ?? (() => true)
  }

  async load(): Promise<void> {
    if (this.ready) return
    this.hydrating ??= this.hydrate().finally(() => { this.hydrating = undefined })
    await this.hydrating
  }

  writable(): boolean {
    return gateOpen(this.lease)
  }

  /** Independent of the task and issue ledger revisions. */
  revision(): number {
    return this.table.generation
  }

  /** Frozen and zero-copy; do not mutate it or hold the reference long-term. */
  get(issueId: string): IssueLink | undefined {
    return this.table.records.get(issueId)
  }

  issueIds(): string[] {
    return Array.from(this.table.records.keys())
  }

  size(): number {
    return this.table.records.size
  }

  snapshot(): Record<string, IssueLink> {
    return Object.fromEntries(this.table.records)
  }

  /**
   * The only write entry point: revision bump and atomic persistence happen here.
   *
   * `undefined` fields are left alone, `null` deletes them.
   */
  async patch(issueId: string, patch: IssueLinkPatch): Promise<IssueLink> {
    if (!isIssueAnchor(issueId)) throw new Error(`link patch needs an issue id: ${issueId}`)
    return this.gate.run(async () => {
      await this.load()
      this.assertWritable()
      const record = deepFreeze(mergeLink(this.table.records.get(issueId), patch))
      const records = new Map(this.table.records)
      records.set(issueId, record)
      await this.swapIn(records)
      return record
    })
  }

  async remove(issueId: string): Promise<boolean> {
    return this.gate.run(async () => {
      await this.load()
      if (!this.table.records.has(issueId)) return false
      this.assertWritable()
      const records = new Map(this.table.records)
      records.delete(issueId)
      await this.swapIn(records)
      return true
    })
  }

  /**
   * Read-only processes catch up only when disk is ahead of memory.
   *
   * @returns true when a reload actually happened.
   */
  async reloadIfChanged(): Promise<boolean> {
    await this.load()
    const disk = await this.readDiskGeneration()
    if (disk === undefined || disk <= this.table.generation) return false
    await this.reloadFromDisk()
    warn('link-readonly-reloaded', `从磁盘追上关系表 revision ${String(disk)}`)
    return true
  }

  /**
   * Required before a secondary becomes owner: writing from a stale snapshot would erase
   * changes made by the process that held the lease.
   */
  async reloadFromDisk(): Promise<void> {
    this.ready = false
    this.hydrating = undefined
    await this.load()
  }

  private async swapIn(records: Map<string, IssueLink>): Promise<void> {
    const generation = this.table.generation + 1
    await persistJson(this.path, {
      schemaVersion: LINK_SCHEMA_VERSION,
      revision: generation,
      links: Object.fromEntries(records),
    } satisfies LinkIndexFile)
    // Memory and revision must be replaced in one synchronous block; an await in between
    // would let a reader observe new records with a stale revision.
    this.table = { records, generation }
  }

  private async hydrate(): Promise<void> {
    const text = await this.readSource()
    if (text === undefined) {
      this.table = emptyTable()
    } else {
      try {
        this.table = this.decode(text)
      } catch {
        warn('link-corrupt', `${this.path} 不是合法 JSON，关系表从空表重建`)
        this.table = emptyTable()
      }
    }
    this.ready = true
  }

  private async readSource(): Promise<string | undefined> {
    try {
      return await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      try {
        await rename(this.path, `${this.path}.corrupt-${Date.now()}`)
      } catch {
        /* Quarantine is best effort; rebuilding from empty is still the fallback */
      }
      warn('link-rebuild', `${this.path} 不可读，关系表从空表重建`)
      return undefined
    }
  }

  /** Bad JSON is expected here and handled by the caller. */
  private decode(text: string): TableState {
    const parsed = JSON.parse(text) as Partial<LinkIndexFile>
    const generation = typeof parsed.revision === 'number' && Number.isFinite(parsed.revision)
      ? parsed.revision
      : 0
    const records = new Map<string, IssueLink>()
    let rejected = 0
    const stored = isPlainObject(parsed.links) ? parsed.links : {}
    for (const issueId of Object.keys(stored)) {
      if (!isIssueAnchor(issueId)) {
        rejected += 1
        continue
      }
      const link = decodeLink(stored[issueId])
      if (link === undefined) {
        rejected += 1
        continue
      }
      records.set(issueId, deepFreeze(link))
    }
    if (rejected > 0) warn('link-partial', `丢弃 ${String(rejected)} 条不可信的关系记录`)
    return { records, generation }
  }

  private async readDiskGeneration(): Promise<number | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as { revision?: unknown }
      return typeof parsed.revision === 'number' && Number.isFinite(parsed.revision)
        ? parsed.revision
        : undefined
    } catch {
      return undefined
    }
  }

  private assertWritable(): void {
    if (this.writable()) return
    throw new Error('link table is read-only in this host (another dsh web owns the storage lease)')
  }
}

function emptyTable(): TableState {
  return { records: new Map(), generation: 0 }
}

// A predicate that throws cannot prove writability, so it counts as closed.
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
 * Failure-tolerant `patch` for background paths.
 *
 * The link table only accelerates routing, so a write that cannot land should not abort an
 * execution round. Startup reconciliation, which must know about failures, calls `patch`
 * directly.
 */
export async function patchLinkQuiet(
  store: LinkStore,
  issueId: string,
  patch: IssueLinkPatch,
  what: string,
): Promise<IssueLink | undefined> {
  return store.patch(issueId, patch).catch((error: unknown) => {
    warn('link-write-failed', `${what} ${issueId}: ${explain(error)}`)
    return undefined
  })
}
