/**
 * Disk layer for issues: one index plus one detail file per issue, tuned for a
 * "collect ideas over time" workload.
 *
 * ```text
 * <dir>/castboard-issue.json          index: revision, router bookkeeping, all summaries
 * <dir>/issues/<id>.json            one issue: body, meta, lineage
 * <dir>/castboard-issue-deleted.json  locally deleted ids → deletion time
 * ```
 *
 * Details are not read during load. The backlog column grows with the years, so reading
 * every detail at startup would turn history length into startup latency. {@link
 * IssueStore.load} only touches the index; details load on {@link IssueStore.get} or on a
 * write path. Only the three planning statuses stay resident; records that already have an
 * outcome are read, returned as a frozen copy, and dropped, because they will not change
 * again and would otherwise make the resident set grow with query history.
 *
 * `issues/<id>.json` is the truth and the index is a derived snapshot for the panel. The
 * write order is always details first, index second; if the index is lost, scanning the
 * details directory restores it. Writing the index first would lose records on failure.
 *
 * Single writes, merges, and title refreshes share one promise chain, so read-compute-write
 * is atomic with respect to other writes. Cross-process exclusion belongs to the caller's
 * lease; this layer asks `canWrite()` once more right before committing.
 *
 * @module dsh-magica-castboard/host/ledger/issue-store
 */
import { eventLog } from '../shared/event-log.ts'
import { readFile, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { jsonRoundTrip, persistJsonAsync } from './atomic.ts'
import { summarizeIssue } from './issue-derive.ts'
import {
  ISSUE_SCHEMA_VERSION,
  MERGEABLE_ISSUE_STATUSES,
  PLANNING_ISSUE_STATUSES,
} from '../model.ts'
import type {
  IssueDraft,
  IssueIndexFile,
  IssueMeta,
  IssueRecord,
  IssueRouterState,
  IssueStatus,
  IssueSummary,
  RemoteIssueDraft,
  RemoteMergeReport,
} from '../model.ts'
import {
  isPlausibleIssueRecord,
  isPlausibleIssueSummary,
  isValidIssueId,
  newIssueId,
  projectMeta,
} from './issue-validate.ts'

export type {
  IssueDraft,
  IssueIndexFile,
  IssueMeta,
  IssueRecord,
  IssueRouterState,
  IssueStatus,
  IssueSummary,
  PermissionMode,
  RemoteIssueDraft,
  RemoteMergeReport,
  Urgency,
} from '../model.ts'

const INDEX_FILE = 'castboard-issue.json'
const DETAILS_DIR = 'issues'
const TOMBSTONE_FILE = 'castboard-issue-deleted.json'

// Detail batches stay small enough to leave libuv thread-pool slots for HTTP work.
const IO_CONCURRENCY = 4

interface IssueIndexOnDisk extends IssueIndexFile {
  router: IssueRouterState
}

export interface IssueChange {
  revision: number
  kind: 'issue-created' | 'issue-updated' | 'issue-deleted' | 'issue-transferred' | 'issue-abandoned'
  issue?: IssueRecord
}

type IssueMutator = (incoming: IssueRecord, now: number) => boolean | void

export interface IssueStoreOptions {
  dir: string
  /**
   * Lease predicate. The check lives at the commit point because the lease can be lost
   * between the caller's check and the write.
   */
  canWrite?: () => boolean
  now?: () => number
}

export interface CreateIssueOptions {
  createdAt?: number
}

function isPlanning(status: IssueStatus): boolean {
  return (PLANNING_ISSUE_STATUSES as readonly string[]).includes(status)
}

function isMergeable(status: IssueStatus): boolean {
  return (MERGEABLE_ISSUE_STATUSES as readonly string[]).includes(status)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// The issue side has no log service of its own, so warnings go to the host console.
function warn(event: string, detail: string): void {
  eventLog('warn', event, detail)
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const item of Object.values(value as Record<string, unknown>)) freezeDeep(item)
  return Object.freeze(value) as T
}

/**
 * Run work in fixed-size batches so a huge directory cannot occupy every thread-pool slot
 * at once.
 */
async function mapChunked<T, R>(
  items: readonly T[],
  width: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  for (let start = 0; start < items.length; start += width) {
    const slice = items.slice(start, start + width)
    results.push(...await Promise.all(slice.map(run)))
  }
  return results
}

const DRAFT_COLUMNS = [
  'projectId', 'assigner', 'assignerTask', 'cwd', 'permission',
  'assignee', 'assigneeTask', 'assigneeInstance', 'assigneeMeta',
  'source', 'sourceInstance', 'assignedAt',
] as const

function recordFromDraft(incoming: IssueDraft, now: number, seedCreatedAt?: number): IssueRecord {
  const record: IssueRecord = {
    id: newIssueId(),
    status: 'pending',
    title: incoming.title,
    detail: incoming.detail,
    urgency: incoming.urgency,
    workspaceId: incoming.workspaceId,
    assignerMeta: projectMeta(incoming.assignerMeta, incoming.title, incoming.detail),
    createdAt: incoming.createdAt ?? seedCreatedAt ?? now,
    updatedAt: now,
  }
  const cells = record as unknown as Record<string, unknown>
  for (const column of DRAFT_COLUMNS) {
    const value = incoming[column]
    if (value !== undefined) cells[column] = value
  }
  replaceDependencies(record, incoming.dependsOn)
  return record
}

export class IssueStore {
  private readonly indexFile: string
  private readonly detailsDir: string
  private readonly tombstoneFile: string
  private readonly canWrite: () => boolean
  private readonly clock: () => number

  /** Read-only snapshot of the index; replaced as a whole. */
  private allIssues: readonly IssueSummary[] = Object.freeze([])
  /** Planning-status subset, served as the panel's backlog column. */
  private planningIndex: readonly IssueSummary[] = Object.freeze([])
  private revisionCounter = 0
  /** Resident details: planning statuses only. */
  private readonly details = new Map<string, IssueRecord>()
  private routerState: IssueRouterState = {}
  private readonly tombstones = new Map<string, number>()
  private tombstonesLoaded = false

  // A rejected job still chains, so a failure cannot poison later writes.
  private queue: Promise<unknown> = Promise.resolve()
  private loading: Promise<void> | undefined
  private loaded = false
  private readonly listeners = new Set<(change: IssueChange) => void>()

  constructor(options: IssueStoreOptions) {
    this.indexFile = join(options.dir, INDEX_FILE)
    this.detailsDir = join(options.dir, DETAILS_DIR)
    this.tombstoneFile = join(options.dir, TOMBSTONE_FILE)
    this.canWrite = options.canWrite ?? (() => true)
    this.clock = options.now ?? (() => Date.now())
  }

  /**
   * Load the index once, with concurrent callers sharing one promise.
   *
   * Only the index is read; `issues/` is scanned only when the index is missing or corrupt.
   * This never throws, because a damaged ledger should not take startup down with it.
   */
  async load(): Promise<void> {
    if (this.loaded) return
    let inflight = this.loading
    if (inflight === undefined) {
      inflight = this.bootstrap().finally(() => {
        this.loading = undefined
      })
      this.loading = inflight
    }
    await inflight
  }

  private async bootstrap(): Promise<void> {
    if (this.loaded) return
    let indexText: string | undefined
    let broken = false
    try {
      indexText = await readFile(this.indexFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Unreadable: quarantine it and rebuild from details. A read-only host only rebuilds
        // in memory, since renaming is itself a write and belongs to the owner.
        broken = true
        if (this.writable()) await this.quarantineIndex()
        warn('issue-index-rebuild', `${this.indexFile} 不可读，改为从 issues/ 重建`)
      }
    }

    let summaries: IssueSummary[] | undefined
    if (indexText !== undefined) {
      summaries = this.takeIndex(indexText)
      if (summaries === undefined) broken = true
    }

    if (broken || summaries === undefined) {
      summaries = await this.reindexFromDetails()
      // Only the owner writes the rebuild; a read-only host must not overwrite the owner's
      // index.
      if (summaries.length > 0 && this.writable()) await this.persistRebuiltIndex(summaries)
    }

    this.swapIndex(summaries ?? [])
    this.loaded = true
  }

  private async quarantineIndex(): Promise<void> {
    try {
      await rename(this.indexFile, `${this.indexFile}.corrupt-${String(Date.now())}`)
    } catch { /* best effort */ }
  }

  private takeIndex(text: string): IssueSummary[] | undefined {
    try {
      const parsed = JSON.parse(text) as Partial<IssueIndexFile>
      this.adoptHeader(parsed)
      const rows = parsed.issues
      if (!Array.isArray(rows)) return undefined
      const accepted = rows.filter(isPlausibleIssueSummary)
      const dropped = rows.length - accepted.length
      if (dropped > 0) {
        warn('issue-index-partial', `丢弃 ${String(dropped)} 条不合形状的摘要`)
      }
      return accepted
    } catch {
      warn('issue-index-corrupt', `${this.indexFile} 不是合法 JSON，改为从 issues/ 重建`)
      return undefined
    }
  }

  private adoptHeader(parsed: Partial<IssueIndexFile>): void {
    const revision = parsed.revision
    if (typeof revision === 'number' && Number.isFinite(revision)) this.revisionCounter = revision
    const router = parsed.router
    if (typeof router === 'object' && router !== null) this.routerState = { ...router }
  }

  private async persistRebuiltIndex(summaries: IssueSummary[]): Promise<void> {
    try {
      await this.persistIndexFile(summaries, this.revisionCounter)
    } catch (error) {
      warn('issue-index-rebuild-failed', errorText(error))
    }
  }

  /** Cold path: bad detail files are reported and skipped; the rebuild is best effort. */
  private async reindexFromDetails(): Promise<IssueSummary[]> {
    let files: string[] = []
    try {
      files = (await readdir(this.detailsDir)).filter(name => name.endsWith('.json'))
    } catch { /* No directory means an empty ledger */ }
    const loaded = await mapChunked(files, IO_CONCURRENCY, name => this.summarizeDetailFile(name))
    const summaries = loaded.filter((item): item is IssueSummary => item !== undefined)
    if (summaries.length > 0) {
      eventLog('info', 'issue-index-rebuilt', `从 issues/ 恢复 ${String(summaries.length)} 条`)
    }
    return summaries
  }

  private async summarizeDetailFile(name: string): Promise<IssueSummary | undefined> {
    try {
      const parsed = JSON.parse(await readFile(join(this.detailsDir, name), 'utf8')) as unknown
      if (!isPlausibleIssueRecord(parsed)) {
        warn('issue-detail-implausible', name)
        return undefined
      }
      return summarizeIssue(parsed)
    } catch {
      warn('issue-detail-unreadable', name)
      return undefined
    }
  }

  // Both views must move together or a poll could see mismatched data.
  private swapIndex(issues: IssueSummary[]): void {
    this.allIssues = Object.freeze(issues) as readonly IssueSummary[]
    this.planningIndex = Object.freeze(
      issues.filter(summary => isPlanning(summary.status)),
    ) as readonly IssueSummary[]
  }

  router(): IssueRouterState {
    return { ...this.routerState }
  }

  /** Merges with the index write, so bookkeeping and summaries share one revision. */
  async saveRouter(patch: IssueRouterState): Promise<void> {
    const merged: Record<string, unknown> = { ...this.routerState }
    for (const key of Object.keys(patch) as Array<keyof IssueRouterState>) {
      const value = patch[key]
      if (value !== undefined) merged[key] = value
    }
    merged.updatedAt = this.clock()
    await this.exclusive(async () => {
      await this.load()
      if (!this.writable()) return
      this.routerState = merged as IssueRouterState
      await this.persistIndexFile(this.allIssues, this.revisionCounter + 1)
      this.revisionCounter += 1
    })
  }

  writable(): boolean {
    try {
      return this.canWrite() === true
    } catch {
      return false
    }
  }

  revision(): number {
    return this.revisionCounter
  }

  subscribe(listener: (change: IssueChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Reload only when disk is ahead of memory, then drop the detail cache. */
  async reloadIfChanged(): Promise<boolean> {
    await this.load()
    const onDisk = await this.readDiskRevision()
    if (onDisk === undefined || onDisk <= this.revisionCounter) return false
    await this.reloadFromDisk()
    eventLog('info', 'issue-readonly-reloaded', `追上磁盘 revision ${String(onDisk)}`)
    return true
  }

  /**
   * Used when a secondary becomes owner: memory may lag disk, and writing a stale snapshot
   * would erase changes made by the process that held the lease.
   */
  async reloadFromDisk(): Promise<void> {
    await this.load()
    this.forgetMemory()
    await this.load()
  }

  private forgetMemory(): void {
    this.loaded = false
    this.loading = undefined
    this.details.clear()
  }

  private async readDiskRevision(): Promise<number | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.indexFile, 'utf8')) as { revision?: unknown }
      const revision = parsed.revision
      return typeof revision === 'number' && Number.isFinite(revision) ? revision : undefined
    } catch {
      return undefined
    }
  }

  summaries(): readonly IssueSummary[] {
    return this.allIssues
  }

  /** Planning statuses only, ordered by status weight for the backlog column. */
  pending(): readonly IssueSummary[] {
    return this.planningIndex
  }

  summary(id: string): IssueSummary | undefined {
    let hit: IssueSummary | undefined
    for (const item of this.allIssues) {
      if (item.id !== id) continue
      hit = item
      break
    }
    return hit
  }

  /**
   * A cached planning record is returned directly; anything else comes from disk and is
   * discarded again right away. A frozen copy is always returned, and a missing or malformed
   * detail yields undefined.
   */
  async get(id: string): Promise<IssueRecord | undefined> {
    await this.load()
    if (!isValidIssueId(id)) return undefined
    const cached = this.details.get(id)
    if (cached !== undefined) return this.snapshot(cached)
    const record = await this.readRecord(id)
    if (record === undefined) return undefined
    this.cacheHot(record)
    return this.snapshot(record)
  }

  private snapshot(record: IssueRecord): IssueRecord {
    return freezeDeep(structuredClone(record))
  }

  /** Creates locally, always in `pending`; title and detail are mirrored into `assignerMeta`. */
  async create(draft: IssueDraft, options?: CreateIssueOptions): Promise<IssueRecord> {
    const now = this.clock()
    const record = recordFromDraft(draft, now, options?.createdAt)
    const committed = await this.mutateQueue('issue-created', record.id, () => record)
    if (committed === undefined) throw new Error('issue write produced no record')
    return committed
  }

  async update(
    id: string,
    mutator: IssueMutator,
    kind: IssueChange['kind'] = 'issue-updated',
  ): Promise<IssueRecord | undefined> {
    return this.mutateQueue(kind, id, (current, now) => {
      if (current === undefined) return undefined
      if (mutator(current, now) === false) return undefined
      // Title or body may have moved; re-project so the mirrored meta cannot drift.
      current.assignerMeta = projectMeta(current.assignerMeta, current.title, current.detail)
      current.updatedAt = now
      return current
    })
  }

  /**
   * "Turned into a task" is local-only: the shared library has no such status, so this sets
   * `routing` and records the resulting task as downstream lineage in `assigneeTask`.
   */
  async transfer(id: string, taskId: string): Promise<IssueRecord | undefined> {
    return this.mutateQueue('issue-transferred', id, (incoming, now) => {
      if (incoming === undefined || !isMergeable(incoming.status)) return undefined
      incoming.status = 'routing'
      incoming.assigneeTask = taskId
      incoming.assignedAt = now
      incoming.assignerMeta = projectMeta(incoming.assignerMeta, incoming.title, incoming.detail)
      incoming.updatedAt = now
      return incoming
    })
  }

  async markRouting(id: string): Promise<IssueRecord | undefined> {
    return this.update(id, (incoming) => {
      if (!isMergeable(incoming.status)) return false
      incoming.status = 'routing'
    })
  }

  /** Only a `routing` issue may take a task id; anything else would break lineage. */
  async attachTask(id: string, taskId: string): Promise<IssueRecord | undefined> {
    return this.mutateQueue('issue-transferred', id, (incoming, now) => {
      if (incoming === undefined) return undefined
      if (incoming.status !== 'routing') return undefined
      incoming.assigneeTask = taskId
      incoming.assignedAt = now
      incoming.assignerMeta = projectMeta(incoming.assignerMeta, incoming.title, incoming.detail)
      incoming.updatedAt = now
      return incoming
    })
  }

  /** Abandoning keeps the record for traceability; the panel just stops listing it. */
  async abandon(
    id: string,
    assigneeMeta?: Record<string, unknown>,
  ): Promise<IssueRecord | undefined> {
    return this.update(id, (incoming) => {
      if (!isMergeable(incoming.status)) return false
      incoming.status = 'abandoned'
      if (assigneeMeta !== undefined) {
        incoming.assigneeMeta = { ...(incoming.assigneeMeta ?? {}), ...assigneeMeta }
      }
    }, 'issue-abandoned')
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.mutateQueue('issue-deleted', id, () => 'delete' as const)
    if (removed === undefined) return false
    // Tombstone after the delete succeeds; the reverse would permanently lose the issue if
    // the unlink failed.
    await this.recordTombstone(id)
    return true
  }

  /** A failed tombstone write only risks one issue reappearing in a later sync round. */
  private async recordTombstone(id: string): Promise<void> {
    await this.loadTombstones()
    this.tombstones.set(id, this.clock())
    const ids = Object.fromEntries(this.tombstones)
    try {
      await persistJsonAsync(this.tombstoneFile, { schemaVersion: ISSUE_SCHEMA_VERSION, ids })
    } catch (error) {
      warn('issue-tombstone-failed', `${id}: ${errorText(error)}`)
    }
  }

  /**
   * Load once per process. Unreadable is treated as no tombstones, which at worst resurrects
   * one issue.
   *
   * The `{ ids: string[] }` form is also accepted, with an unknown deletion time of 0.
   */
  private async loadTombstones(): Promise<void> {
    if (this.tombstonesLoaded) return
    this.tombstonesLoaded = true
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.tombstoneFile, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn('issue-tombstone-unreadable', errorText(error))
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const ids = (parsed as { ids?: unknown }).ids
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === 'string' && isValidIssueId(id)) this.tombstones.set(id, 0)
      }
      return
    }
    if (typeof ids !== 'object' || ids === null) return
    for (const [id, at] of Object.entries(ids as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at) && isValidIssueId(id)) this.tombstones.set(id, at)
    }
  }

  /**
   * The single commit path: read the current detail, compute the next record, write the detail,
   * write the index, then swap memory.
   */
  private async mutateQueue(
    kind: IssueChange['kind'],
    id: string,
    plan: (saved: IssueRecord | undefined, now: number) => IssueRecord | 'delete' | undefined,
  ): Promise<IssueRecord | undefined> {
    return this.exclusive(async () => {
      await this.load()
      // A full index rewrite from a read-only host would overwrite the owner's ledger.
      if (!this.writable()) {
        throw new Error('issue ledger is read-only in this host (another dsh web owns the storage lease)')
      }
      const now = this.clock()
      const saved = await this.readRecord(id)
      const planned = plan(saved, now)
      if (planned === undefined) return undefined
      return planned === 'delete'
        ? this.commitDelete(kind, id, saved)
        : this.commitWrite(kind, id, planned)
    })
  }

  private async commitDelete(
    kind: IssueChange['kind'],
    id: string,
    saved: IssueRecord | undefined,
  ): Promise<IssueRecord | undefined> {
    if (saved === undefined) return undefined
    await unlink(this.detailPath(id)).catch(() => { /* already gone */ })
    const remaining = this.allIssues.filter(entry => entry.id !== id)
    await this.persistIndexFile(remaining, this.revisionCounter + 1)
    this.revisionCounter += 1
    this.swapIndex(remaining)
    this.details.delete(id)
    const committed = this.snapshot(saved)
    this.emit({ revision: this.revisionCounter, kind, issue: committed })
    return committed
  }

  private async commitWrite(
    kind: IssueChange['kind'],
    id: string,
    planned: IssueRecord,
  ): Promise<IssueRecord> {
    // Round-trip to match the on-disk shape, since the tool layer expects lossless JSON.
    const record = jsonRoundTrip(planned)
    await persistJsonAsync(this.detailPath(id), record)
    const next = this.withSummary(summarizeIssue(record))
    // If this write fails the index is merely stale and can be rebuilt; the detail is
    // already safe.
    await this.persistIndexFile(next, this.revisionCounter + 1)
    // Memory and revision change in one tick so no poll can see a new summary with a stale
    // revision.
    this.revisionCounter += 1
    this.swapIndex(next)
    this.cacheHot(record)
    const committed = this.snapshot(record)
    this.emit({ revision: this.revisionCounter, kind, issue: committed })
    return committed
  }

  private withSummary(summary: IssueSummary): IssueSummary[] {
    const at = this.allIssues.findIndex(entry => entry.id === summary.id)
    if (at < 0) return [...this.allIssues, summary]
    const next = [...this.allIssues]
    next[at] = summary
    return next
  }

  /**
   * Single writes and batch writes share this chain.
   *
   * A batch that bypassed it could land between a read and a write of a single edit and
   * overwrite the user's change.
   */
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const chained = this.queue.then(run, run)
    this.queue = chained
    return chained as Promise<T>
  }

  private emit(change: IssueChange): void {
    const audience = [...this.listeners]
    for (const listener of audience) {
      try {
        listener(change)
      } catch (error) {
        warn('issue-change-listener-failed', errorText(error))
      }
    }
  }

  /**
   * Ids that would actually be stored locally, and therefore are worth claiming online.
   *
   * Pulling, claiming, and merging happen in that order. Claiming an id that the merge would
   * skip marks it `accepted` online for no reason, so tombstones, invalid ids, and decided
   * statuses are filtered out first. Only when the summary says mergeable is the detail
   * re-read, since the index can lag.
   */
  async claimable(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return []
    await this.load()
    await this.loadTombstones()
    const accepted: string[] = []
    for (const id of ids) {
      if (await this.worthClaiming(id)) accepted.push(id)
    }
    return accepted
  }

  private async worthClaiming(id: string): Promise<boolean> {
    if (!isValidIssueId(id)) return false
    if (this.tombstones.has(id)) return false
    const summary = this.summary(id)
    // Nothing local: the merge will insert it, so claiming is right.
    if (summary === undefined) return true
    if (!isMergeable(summary.status)) return false
    // The detail is authoritative when the index lags.
    const detail = await this.readRecord(id)
    if (detail === undefined) return true
    return isMergeable(detail.status)
  }

  /**
   * Merge a pull round, with local state winning.
   *
   * A new id is inserted; a mergeable record gets its mirror fields overwritten; a record with
   * a local decision is skipped; a record whose fields already match is left untouched. The
   * whole round writes the index once and bumps the revision once, and tombstones and invalid
   * ids are tallied as skipped or rejected.
   */
  async mergeRemote(drafts: readonly RemoteIssueDraft[], now: number): Promise<RemoteMergeReport> {
    const tally: RemoteMergeReport = { inserted: [], updated: [], skipped: [], unchanged: [], rejected: [] }
    if (drafts.length === 0) return tally

    return this.exclusive(async () => {
      await this.load()
      await this.loadTombstones()
      // A read-only host skips the round; it will run once this process becomes owner.
      if (!this.writable()) return tally
      const pendingWrites = new Map<string, IssueRecord>()
      for (const incoming of drafts) await this.mergeOne(incoming, now, pendingWrites, tally)
      if (pendingWrites.size === 0) return tally
      await this.flushDetails(pendingWrites)
      eventLog('info', 'issue-remote-merged', `+${String(tally.inserted.length)} ~${String(tally.updated.length)} skip=${String(tally.skipped.length)} rev=${String(this.revisionCounter)}`)
      return tally
    })
  }

  private async mergeOne(
    incoming: RemoteIssueDraft,
    now: number,
    pendingWrites: Map<string, IssueRecord>,
    tally: RemoteMergeReport,
  ): Promise<void> {
    // The id becomes part of the detail path, so unsafe characters are rejected outright.
    if (!isValidIssueId(incoming.id)) {
      tally.rejected.push(incoming.id)
      return
    }
    if (this.tombstones.has(incoming.id)) {
      tally.skipped.push(incoming.id)
      return
    }
    const known = this.summary(incoming.id)
    if (known !== undefined && !isMergeable(known.status)) {
      tally.skipped.push(incoming.id)
      return
    }
    const saved = await this.readRecord(incoming.id)
    if (saved === undefined) {
      const record = remoteRecord(incoming, now)
      await persistJsonAsync(this.detailPath(record.id), record)
      pendingWrites.set(record.id, record)
      tally.inserted.push(record.id)
      return
    }
    // The detail wins over a stale index.
    if (!isMergeable(saved.status)) {
      tally.skipped.push(saved.id)
      return
    }
    const merged = mergeRemoteRecord(saved, incoming, now)
    if (merged === undefined) {
      tally.unchanged.push(saved.id)
      return
    }
    await persistJsonAsync(this.detailPath(saved.id), merged)
    pendingWrites.set(saved.id, merged)
    tally.updated.push(saved.id)
  }

  /**
   * Refresh only the title of existing records.
   *
   * `mergeRemote` handles only mergeable statuses, but the dispatcher may rename a `routing`
   * or `running` issue while it works (for example, when a group name is completed). This
   * channel updates display text only: no new records, no body or meta changes.
   *
   * @returns How many records were rewritten.
   */
  async refreshTitles(
    entries: readonly { id: string; title: string }[],
    now: number,
  ): Promise<number> {
    if (entries.length === 0) return 0
    return this.exclusive(async () => {
      await this.load()
      await this.loadTombstones()
      if (!this.writable()) return 0
      const pendingWrites = new Map<string, IssueRecord>()
      for (const entry of entries) await this.collectTitleRefresh(entry, now, pendingWrites)
      if (pendingWrites.size === 0) return 0
      await this.flushDetails(pendingWrites)
      eventLog('info', 'issue-titles-refreshed', `${String(pendingWrites.size)} 条标题按云端刷新（rev=${String(this.revisionCounter)}）`)
      return pendingWrites.size
    })
  }

  private async collectTitleRefresh(
    entry: { id: string; title: string },
    now: number,
    pendingWrites: Map<string, IssueRecord>,
  ): Promise<void> {
    if (entry.title.length === 0) return
    if (!isValidIssueId(entry.id)) return
    if (this.tombstones.has(entry.id)) return
    const known = this.summary(entry.id)
    if (known === undefined || known.title === entry.title) return
    const saved = await this.readRecord(entry.id)
    if (saved === undefined || saved.title === entry.title) return
    const next: IssueRecord = { ...structuredClone(saved), title: entry.title, updatedAt: now }
    await persistJsonAsync(this.detailPath(next.id), next)
    pendingWrites.set(next.id, next)
  }

  /** Batch finishing step: details are already on disk; index, memory, and cache follow. */
  private async flushDetails(pendingWrites: Map<string, IssueRecord>): Promise<void> {
    const merged = this.allIssues.map(entry => {
      const fresh = pendingWrites.get(entry.id)
      return fresh === undefined ? entry : summarizeIssue(fresh)
    })
    const known = new Set(this.allIssues.map(entry => entry.id))
    for (const [id, record] of pendingWrites) {
      if (!known.has(id)) merged.push(summarizeIssue(record))
    }
    await this.persistIndexFile(merged, this.revisionCounter + 1)
    this.revisionCounter += 1
    this.swapIndex(merged)
    for (const record of pendingWrites.values()) this.cacheHot(record)
  }

  private async persistIndexFile(issues: readonly IssueSummary[], revision: number): Promise<void> {
    const body: IssueIndexOnDisk = {
      schemaVersion: ISSUE_SCHEMA_VERSION,
      revision,
      router: { ...this.routerState },
      issues,
    }
    await persistJsonAsync(this.indexFile, body)
  }

  private async readRecord(id: string): Promise<IssueRecord | undefined> {
    if (!isValidIssueId(id)) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.detailPath(id), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn('issue-detail-unreadable', id)
      return undefined
    }
    if (!isPlausibleIssueRecord(parsed)) {
      warn('issue-detail-implausible', id)
      return undefined
    }
    return parsed
  }

  /**
   * Only planning records stay resident. A record leaves the cache the moment it reaches a
   * terminal state, so no sweep or capacity limit is needed.
   */
  private cacheHot(record: IssueRecord): void {
    if (isPlanning(record.status)) {
      this.details.set(record.id, record)
      return
    }
    this.details.delete(record.id)
  }

  private detailPath(id: string): string {
    return join(this.detailsDir, `${id}.json`)
  }
}

// Remote draft → local record. These are pure; persistence and queueing stay in IssueStore.

const MIRROR_COLUMNS = [
  'projectId', 'assigner', 'assignerTask', 'cwd', 'permission',
  'assignee', 'assigneeInstance', 'assigneeMeta', 'source', 'sourceInstance',
] as const

// The remote side means "absent = clear", so a missing value deletes the local column.
function copyMirrorColumns(target: IssueRecord, incoming: RemoteIssueDraft): void {
  const cells = target as unknown as Record<string, unknown>
  for (const column of MIRROR_COLUMNS) {
    const value = incoming[column]
    if (value === undefined) Reflect.deleteProperty(cells, column)
    else cells[column] = value
  }
}

// An empty dependency list and no list mean the same thing.
function replaceDependencies(record: IssueRecord, dependsOn: readonly string[] | undefined): void {
  if (dependsOn === undefined || dependsOn.length === 0) {
    Reflect.deleteProperty(record, 'dependsOn')
    return
  }
  record.dependsOn = [...dependsOn]
}

/**
 * An online issue with no local counterpart becomes a full record.
 *
 * `createdAt` uses the online value because the issue existed long before it was pulled;
 * `updatedAt` records this sync round, which is all the ledger can honestly say.
 */
function remoteRecord(incoming: RemoteIssueDraft, now: number): IssueRecord {
  const record: IssueRecord = {
    id: incoming.id,
    ...(incoming.projectId === undefined ? {} : { projectId: incoming.projectId }),
    title: incoming.title,
    detail: incoming.detail,
    urgency: incoming.urgency,
    status: incoming.status ?? 'pending',
    assignerMeta: projectMeta(incoming.assignerMeta, incoming.title, incoming.detail),
    workspaceId: incoming.workspaceId,
    createdAt: incoming.createdAt ?? now,
    updatedAt: now,
  }
  copyMirrorColumns(record, incoming)
  replaceDependencies(record, incoming.dependsOn)
  return record
}

/**
 * Overwrite mirror fields on a mergeable record.
 *
 * Returns `undefined` when nothing changed, so the caller can skip the write. Local-only
 * fields (`status`, `assigneeTask`, `assignedAt`, router bookkeeping) are never touched, and
 * absent nullable columns are cleared.
 */
function mergeRemoteRecord(
  saved: IssueRecord,
  incoming: RemoteIssueDraft,
  now: number,
): IssueRecord | undefined {
  const meta = projectMeta(incoming.assignerMeta, incoming.title, incoming.detail)
  const mirrorDirty = MIRROR_COLUMNS.some(column => column === 'assigneeMeta'
    // Each normalization creates a fresh object, so a reference comparison would rewrite on
    // every tick.
    ? !metaEquals(saved.assigneeMeta, incoming.assigneeMeta)
    : saved[column] !== incoming[column])
  const coreDirty = saved.title !== incoming.title
    || saved.detail !== incoming.detail
    || saved.workspaceId !== incoming.workspaceId
    || saved.urgency !== incoming.urgency
    || !metaEquals(saved.assignerMeta, meta)
    || !sameDependencies(saved.dependsOn, incoming.dependsOn)
  if (!coreDirty && !mirrorDirty) return undefined

  const next: IssueRecord = {
    ...structuredClone(saved),
    title: incoming.title,
    detail: incoming.detail,
    workspaceId: incoming.workspaceId,
    urgency: incoming.urgency,
    assignerMeta: meta,
    updatedAt: now,
  }
  copyMirrorColumns(next, incoming)
  replaceDependencies(next, incoming.dependsOn)
  return next
}

// Arrays compare by element; their references are always different.
function sameDependencies(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

// Meta objects are tiny, so JSON comparison is cheaper than a hand-written deep compare.
function metaEquals(a: IssueMeta | undefined, b: IssueMeta | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}
