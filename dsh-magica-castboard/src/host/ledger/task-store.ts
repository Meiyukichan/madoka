/**
 * Persistence for the task ledger, split into an index and per-task details.
 *
 * ```
 * <dir>/castboard-task.json   index: revision + every task summary
 * <dir>/castboard.settings.yaml   board settings (owned by `SettingsStore`, see settings.ts)
 * <dir>/tasks/<id>.json     full state of one task: definition, execution history, checklist
 * ```
 *
 * Without the split, one mutate would rewrite every execution history and checklist, and
 * `GET /state` would ship all of it to the browser. Now a card change writes one small file
 * plus the index, polling carries only summaries, and the response size stays bounded.
 *
 * `tasks/<id>.json` is the truth; the index is derived. The write order is fixed: details
 * first, then delete the details that vanished, then the index. A failed index write only
 * leaves it stale and `tasks/` can rebuild it; the opposite order would lose records.
 *
 * Memory still holds the full ledger. `mutate(ledger => …)` sees every task and readers get
 * frozen copies. Writes are serialized, and only the storage-lease owner may write.
 *
 * @module dsh-magica-castboard/host/ledger/task-store
 */
import { eventLog } from '../shared/event-log.ts'
import { readFile, readdir, rename, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { deepFreeze, persistJsonAsync } from './atomic.ts'
import { mapLimit } from '../shared/async.ts'
import { summarize } from './task-derive.ts'
import type { CastboardPaths } from './paths.ts'
import {
  LEDGER_SCHEMA_VERSION,
  emptyLedger,
  pruneExecutions,
  type BoardSettings,
  type TaskLedger,
  type TaskRecord,
  type TaskSummary,
} from '../model.ts'
import { asBoardSettings, isBacklogStageTask, isPlausibleTaskRecord } from '../rules.ts'

export interface LedgerChange {
  revision: number
  tasks: readonly TaskRecord[]
  kind:
    | 'task-created'
    | 'task-updated'
    | 'task-moved'
    | 'task-deleted'
    | 'comment-added'
    | 'execution-recorded'
    | 'settings-updated'
    | 'ledger-replaced'
}

export interface TaskStoreOptions {
  /** Storage directory; the index and `tasks/` live under it. */
  dir?: string
  /** Alternative to `dir`; its `root` is used. */
  paths?: CastboardPaths
  /**
   * A single-file ledger to import once, when neither the index nor `tasks/` exists.
   * Omitted means no import.
   */
  previousLedgerFile?: string
  /**
   * Write permission for this process, defaulting to always.
   *
   * With several processes on one storage directory only the lease owner may write. This
   * gate also covers the self-repair writes during load; without it a read-only process
   * could rewrite the full index and erase the owner's changes.
   */
  canWrite?: () => boolean
  /** Clock injection for backup names and tests. */
  now?: () => number
}

const INDEX_FILE = 'castboard-task.json'

/** Index name used by the alternate single-file layout; reading it triggers a rename. */
const PREVIOUS_INDEX_FILE = 'taskboard.json'

// Four in flight leaves room in libuv's small thread pool.
const WRITE_CONCURRENCY = 4
const READ_CONCURRENCY = 4

/** Recognizable by name so the route layer can answer with a read-only error. */
export class ReadOnlyError extends Error {
  constructor() {
    super('castboard ledger is read-only in this host (another dsh web owns the storage lease)')
    this.name = 'ReadOnlyError'
  }
}

interface DetailMigration {
  filled: number
  cleaned: number
  skipped: number
  touched: TaskRecord[]
}

function note(level: 'info' | 'warn' | 'error', event: string, detail: string): void {
  eventLog(level, event, detail)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Move body text from `description` / `prompt` into `detail`.
 *
 * Records may carry either field while only `detail` is current; without this the derive
 * layer would fall back to the title and the card would look as if it lost its body. The
 * migration is idempotent, since the redundant keys are removed once the value is copied.
 */
function normalizeDetailFields(tasks: readonly TaskRecord[]): DetailMigration {
  const touched: TaskRecord[] = []
  let filled = 0
  let cleaned = 0
  let skipped = 0

  for (const task of tasks) {
    const record = task as unknown as Record<string, unknown>
    let changed = false

    if (typeof record.detail !== 'string' || record.detail.trim() === '') {
      const description = typeof record.description === 'string' ? record.description.trim() : ''
      const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
      const text = description !== '' ? description : prompt
      if (text !== '') {
        record.detail = text
        filled += 1
        changed = true
      } else if (record.detail === undefined) {
        record.detail = ''
        changed = true
      } else {
        skipped += 1
      }
    }

    if ('description' in record) {
      delete record.description
      cleaned += 1
      changed = true
    }
    if ('prompt' in record) {
      delete record.prompt
      cleaned += 1
      changed = true
    }
    if (changed) touched.push(task)
  }

  return { filled, cleaned, skipped, touched }
}

/** Every write goes through {@link mutate}: serial queue, atomic persistence, frozen copies. */
export class TaskStore {
  private readonly root: string
  private readonly indexFile: string
  private readonly previousIndexFile: string
  private readonly tasksDir: string
  private readonly previousLedgerFile: string | undefined
  private readonly canWrite: () => boolean
  private readonly now: () => number
  private ledger: TaskLedger = emptyLedger()
  /** Mirrors `tasks` in the index file and is updated incrementally. */
  private index: TaskSummary[] = []
  /**
   * Backlog records found during load, excluded from the ledger and index.
   *
   * The issue migration reads them, then calls {@link dropArchivedDetails}.
   */
  private archivedBacklog: TaskRecord[] = []
  private readonly subscribers = new Set<(change: LedgerChange) => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private loading: Promise<void> | undefined
  private loaded = false

  constructor(options: TaskStoreOptions) {
    const dir = options.dir ?? options.paths?.root
    if (dir === undefined) throw new Error('TaskStore requires a dir or a paths object')
    this.root = dir
    this.indexFile = join(dir, INDEX_FILE)
    this.previousIndexFile = join(dir, PREVIOUS_INDEX_FILE)
    this.tasksDir = join(dir, 'tasks')
    this.previousLedgerFile = options.previousLedgerFile
    this.canWrite = options.canWrite ?? (() => true)
    this.now = options.now ?? (() => Date.now())
  }

  writable(): boolean {
    try {
      return this.canWrite()
    } catch {
      // If the predicate itself fails, refuse the write; overwriting the owner's ledger is
      // worse than rejecting one operation.
      return false
    }
  }

  /**
   * Load once, deduplicating concurrent callers.
   *
   * Preload, `/state`, export, backup, and the first `mutate` can all race here. Without
   * deduplication two loads would each build a ledger and overwrite `this.ledger`; the
   * slower one could install a snapshot from before a committed mutate, and the next write
   * would put that stale state back on disk.
   */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loading ??= this.doLoad().finally(() => { this.loading = undefined })
    await this.loading
  }

  /**
   * Read-only hosts use this to notice the owner's writes.
   *
   * The signal is the on-disk index revision. Equal to memory, or unreadable, means nothing
   * to do. Newer than memory triggers a reload. The owner returns false because its memory
   * is authoritative.
   */
  async reloadIfChanged(): Promise<boolean> {
    if (this.writable()) return false
    await this.load()
    const onDisk = await this.peekRevision()
    if (onDisk === undefined || onDisk <= this.ledger.revision) return false
    await this.reloadFromDisk()
    note('info', 'readonly-ledger-reloaded', `picked up ledger revision ${String(onDisk)} from disk`)
    return true
  }

  /**
   * Unconditional reload, used when a secondary becomes owner.
   *
   * Memory may be arbitrarily stale at that point, and mutating from it would overwrite
   * another process's changes with a stale ledger.
   */
  async reloadFromDisk(): Promise<void> {
    await this.load()
    this.loaded = false
    this.loading = undefined
    await this.load()
  }

  private async peekRevision(): Promise<number | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.indexFile, 'utf8')) as { revision?: unknown }
      return typeof parsed.revision === 'number' && Number.isFinite(parsed.revision) ? parsed.revision : undefined
    } catch {
      return undefined
    }
  }

  /** A damaged ledger must not prevent host startup; the worst case is an empty ledger. */
  private async doLoad(): Promise<void> {
    if (this.loaded) return
    try {
      await this.readLedger()
    } catch (error) {
      note('error', 'task-ledger-load-failed', errorText(error))
      this.loaded = true
    }
  }

  /**
   * Read the index, then each detail under `tasks/`.
   *
   * Missing index or directory means an empty ledger, with a possible import from a
   * single-file ledger. A damaged index is quarantined and the index is rebuilt from
   * `tasks/`.
   */
  private async readLedger(): Promise<void> {
    const tasks: TaskRecord[] = []
    /** Backlog records are not loaded into the ledger; the issue migration consumes them. */
    const archived: TaskRecord[] = []
    let revision = 0
    let indexWasBad = false
    /** Whether this batch came from a single-file import, which requires writing details. */
    let migrated = false
    /** Whether the index came from the alternate file name and must be renamed. */
    let indexFromPreviousFile = false
    let settings: BoardSettings | undefined

    // Index provides revision and settings.
    let indexText: string | undefined
    let indexSource: string | undefined
    for (const file of [this.indexFile, this.previousIndexFile]) {
      try {
        indexText = await readFile(file, 'utf8')
        indexSource = file
        if (file === this.previousIndexFile) indexFromPreviousFile = true
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          await this.quarantine(file)
          note('warn', 'index-rebuild', `${file} unreadable; rebuilding from tasks/`)
          indexWasBad = true
        }
      }
    }
    if (indexText !== undefined) {
      try {
        const parsed = JSON.parse(indexText) as { revision?: unknown; settings?: unknown }
        if (typeof parsed.revision === 'number' && Number.isFinite(parsed.revision)) revision = parsed.revision
        if (parsed.settings !== undefined) {
          try {
            settings = asBoardSettings(parsed.settings)
          } catch {
            note('warn', 'settings-dropped', 'invalid board settings on load')
          }
        }
      } catch {
        // The file exists but is not JSON: quarantine it and rebuild from tasks/.
        if (indexSource !== undefined) await this.quarantine(indexSource)
        note('warn', 'index-rebuild', `${indexSource ?? INDEX_FILE} unreadable; rebuilding from tasks/`)
        indexWasBad = true
      }
    }

    // The details are the truth.
    let names: string[] = []
    try {
      names = (await readdir(this.tasksDir)).filter(name => name.endsWith('.json'))
    } catch {
      /* Missing directory means an empty ledger */
    }

    const entries = await mapLimit(names, READ_CONCURRENCY, async (name) => {
      try {
        const parsed = JSON.parse(await readFile(join(this.tasksDir, name), 'utf8')) as unknown
        if (isPlausibleTaskRecord(parsed)) return { kind: 'task' as const, record: parsed as unknown as TaskRecord }
        // A backlog record is data waiting to migrate, not corruption; it goes to the issue
        // ledger instead.
        if (isBacklogStageTask(parsed)) return { kind: 'archived' as const, record: parsed as unknown as TaskRecord }
        note('warn', 'detail-implausible', name)
        return undefined
      } catch {
        note('warn', 'detail-unreadable', name)
        return undefined
      }
    })
    for (const entry of entries) {
      if (entry === undefined) continue
      if (entry.kind === 'task') tasks.push(entry.record)
      else archived.push(entry.record)
    }

    // No index and no details, but a single-file ledger is still around: import it.
    if (tasks.length === 0 && revision === 0 && this.previousLedgerFile !== undefined) {
      const previousRevision = await this.readSingleFileLedger(tasks, archived)
      if (tasks.length > 0) {
        // Keep the original revision; a layout change must not move it backwards.
        revision = previousRevision
        indexWasBad = true
        migrated = true
        note('info', 'single-file-ledger-imported', `imported ${String(tasks.length)} task(s)`)
      }
    }

    // An agent-held in_progress card records its holder in `updatedBy`. Making that an
    // explicit claim keeps a later user edit from erasing the holder, since `updatedBy` is
    // audit information only.
    for (const task of tasks) {
      if (task.status === 'in_progress' && task.claimedBy === undefined
        && task.updatedBy?.kind === 'agent' && typeof task.updatedBy.sessionId === 'string') {
        task.claimedBy = task.updatedBy.sessionId
        task.claimedAt = task.updatedAt
      }
    }

    // Comments now live in their own jsonl files; any embedded array is obsolete.
    let stripped = 0
    for (const task of tasks) {
      const record = task as unknown as Record<string, unknown>
      if ('comments' in record) {
        delete record.comments
        stripped += 1
      }
    }
    if (stripped > 0) note('info', 'comments-field-dropped', `dropped comments[] from ${String(stripped)} task(s)`)

    const detailMigration = normalizeDetailFields(tasks)
    normalizeDetailFields(archived)

    this.ledger = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      revision,
      tasks,
      ...(settings !== undefined ? { settings } : {}),
    }
    this.index = Object.freeze(tasks.map(summarize)) as TaskSummary[]
    this.archivedBacklog = archived
    this.loaded = true

    if (detailMigration.filled > 0 || detailMigration.cleaned > 0 || detailMigration.skipped > 0) {
      note(
        'info',
        'detail-fields-normalized',
        `filled ${String(detailMigration.filled)}, cleaned ${String(detailMigration.cleaned)}, skipped ${String(detailMigration.skipped)}`,
      )
    }

    // Persist the normalized details now. Leaving them only in memory would redo this on
    // every start, and a read-only host must not rewrite files that belong to the owner.
    if (detailMigration.touched.length > 0 && this.writable()) {
      try {
        await this.writeDetails(detailMigration.touched, [])
        note('info', 'detail-fields-persisted', `rewrote ${String(detailMigration.touched.length)} detail file(s)`)
      } catch (error) {
        // Memory already has the new shape, so this run is unaffected; retry next start.
        note('warn', 'detail-fields-persist-failed', errorText(error))
      }
    }

    // Rebuild a damaged or newly imported index so disk never lacks one.
    if (indexWasBad && this.index.length > 0 && this.writable()) {
      try {
        // Imported tasks exist only in memory. An index-only write would leave summaries on
        // disk with no corresponding details, and every task would disappear on restart.
        if (migrated) await this.writeDetails(this.ledger.tasks, [])
        await this.persistIndex(this.ledger)
      } catch (error) {
        note('error', 'index-rebuild-failed', errorText(error))
      }
    }

    // The index was read from the alternate name, so write it under the current one and
    // remove the extra file rather than leaving both behind.
    if (indexFromPreviousFile) {
      if (!this.writable()) {
        note('warn', 'index-rename-deferred', `${PREVIOUS_INDEX_FILE} → ${INDEX_FILE} deferred (read-only host)`)
      } else {
        try {
          await this.persistIndex(this.ledger)
          await unlink(this.previousIndexFile).catch(() => { /* already gone */ })
          note('info', 'index-renamed', `${PREVIOUS_INDEX_FILE} → ${INDEX_FILE}`)
        } catch (error) {
          note('error', 'index-rename-failed', errorText(error))
        }
      }
    }

    try {
      await this.cleanupArchivedArtifacts(migrated)
    } catch (error) {
      note('warn', 'archived-cleanup-failed', errorText(error))
    }
  }

  /**
   * Remove leftovers from the single-file layout.
   *
   * The single-file ledger is deleted only after a successful import, since it may otherwise
   * be the only copy. The alternate index, quarantine copies, and pre-import backups are all
   * derived and safe to drop. Read-only hosts skip this entirely, and an unlink that fails
   * is ignored.
   *
   * @param migratedLedger - Whether the single-file records reached `tasks/`.
   */
  private async cleanupArchivedArtifacts(migratedLedger: boolean): Promise<void> {
    if (!this.writable()) return
    const removed: string[] = []
    const remove = async (file: string): Promise<void> => {
      try {
        await unlink(file)
        removed.push(file)
      } catch {
        /* Gone, locked, or not ours: leave it */
      }
    }
    if (migratedLedger && this.previousLedgerFile !== undefined) await remove(this.previousLedgerFile)
    await remove(this.previousIndexFile)
    let names: string[] = []
    try {
      names = await readdir(this.root)
    } catch {
      return
    }
    const prefixes = [
      `${INDEX_FILE}.corrupt-`,
      `${INDEX_FILE}.backup-`,
      `${PREVIOUS_INDEX_FILE}.corrupt-`,
      `${PREVIOUS_INDEX_FILE}.backup-`,
    ]
    for (const name of names) {
      if (!prefixes.some(prefix => name.startsWith(prefix))) continue
      await remove(join(this.root, name))
    }
    if (removed.length > 0) {
      note(
        'info',
        'archived-artifacts-removed',
        `removed ${String(removed.length)} stale file(s): ${removed.map(file => basename(file)).join(', ')}`,
      )
    }
  }

  /** Import one single-file ledger, returning its revision to keep revision monotonic. */
  private async readSingleFileLedger(tasks: TaskRecord[], archived: TaskRecord[]): Promise<number> {
    if (this.previousLedgerFile === undefined) return 1
    try {
      const parsed = JSON.parse(await readFile(this.previousLedgerFile, 'utf8')) as { revision?: unknown; tasks?: unknown }
      if (!Array.isArray(parsed.tasks)) return 1
      for (const entry of parsed.tasks) {
        if (isPlausibleTaskRecord(entry)) tasks.push(entry as unknown as TaskRecord)
        else if (isBacklogStageTask(entry)) archived.push(entry as unknown as TaskRecord)
      }
      return typeof parsed.revision === 'number' && Number.isFinite(parsed.revision) ? parsed.revision : 1
    } catch {
      return 1
    }
  }

  /** Keep the bad file for inspection and rebuild from details afterwards. */
  private async quarantine(file: string): Promise<void> {
    try {
      await rename(file, `${file}.corrupt-${String(Date.now())}`)
    } catch {
      /* best effort */
    }
  }

  /**
   * Backlog records collected during load.
   *
   * The issue migration only reads them, so the copy is deep-frozen; afterwards it calls
   * {@link dropArchivedDetails} and {@link flushIndex}.
   */
  archivedBacklogRecords(): readonly TaskRecord[] {
    return deepFreeze(structuredClone(this.archivedBacklog))
  }

  /**
   * Delete detail files for ids that are not in the ledger.
   *
   * These ids never belonged to `this.ledger`, so the difference computation in
   * {@link mutate} cannot find them; they have to be listed explicitly.
   */
  async dropArchivedDetails(ids: readonly string[]): Promise<void> {
    await mapLimit(ids, WRITE_CONCURRENCY, id =>
      unlink(this.taskFile(id)).catch(() => { /* already gone */ }))
    const dropped = new Set(ids)
    this.archivedBacklog = this.archivedBacklog.filter(task => !dropped.has(task.id))
  }

  /**
   * Rewrite the index from memory without changing the revision or the ledger.
   *
   * Loading can drop records; without this the index would keep serving their summaries
   * until the next real write.
   */
  async flushIndex(): Promise<void> {
    await this.load()
    try {
      await this.persistIndex(this.ledger)
    } catch (error) {
      note('error', 'index-flush-failed', errorText(error))
    }
  }

  revision(): number {
    return this.ledger.revision
  }

  /** Frozen, read-only summaries; `GET /state` sends these instead of details. */
  summaries(): readonly TaskSummary[] {
    return this.index
  }

  /**
   * Legacy `settings` key from `castboard-task.json`.
   *
   * Only `SettingsStore`'s one-time migration reads this; the live value is
   * `castboard.settings.yaml`. Not written back, so it disappears on the next task write.
   */
  settings(): TaskLedger['settings'] {
    return this.ledger.settings
  }

  /**
   * A deep-frozen clone. Mutating it throws in strict mode instead of silently bypassing
   * revision bookkeeping and persistence.
   */
  snapshot(): TaskLedger {
    return deepFreeze(structuredClone(this.ledger))
  }

  get(id: string): TaskRecord | undefined {
    const task = this.ledger.tasks.find(candidate => candidate.id === id)
    return task === undefined ? undefined : deepFreeze(structuredClone(task))
  }

  /**
   * Which card owns this execution session.
   *
   * The wake-up rule allows only castboard-owned sessions to be woken. Reading just the two
   * relevant fields avoids cloning the whole ledger on this path.
   */
  taskIdOfSession(sessionId: string): string | undefined {
    if (sessionId === '') return undefined
    for (const task of this.ledger.tasks) {
      if (task.trashedAt !== undefined) continue
      if (task.claimedBy === sessionId) return task.id
      for (let index = task.executions.length - 1; index >= 0; index -= 1) {
        if (task.executions[index]?.sessionId === sessionId) return task.id
      }
    }
    return undefined
  }

  subscribe(fn: (change: LedgerChange) => void): () => void {
    this.subscribers.add(fn)
    return () => { this.subscribers.delete(fn) }
  }

  /** A timestamped full copy next to the index, used as a safety net before an import. */
  async backup(): Promise<string> {
    await this.load()
    const target = `${this.indexFile}.backup-${String(this.now())}`
    await persistJsonAsync(target, this.ledger)
    return target
  }

  /**
   * Run one change on the serial queue.
   *
   * The mutator works on a structural clone and returning `undefined` abandons the write:
   * nothing is persisted and the revision stays put.
   *
   * Order, which must not be inverted:
   * 1. write details for changed tasks;
   * 2. delete details for tasks that disappeared;
   * 3. rewrite the index;
   * 4. swap memory and notify subscribers.
   */
  async mutate(
    kind: LedgerChange['kind'],
    mutator: (ledger: TaskLedger) => TaskRecord[] | undefined,
  ): Promise<{ ledger: TaskLedger; changed: readonly TaskRecord[] }> {
    const run = async (): Promise<{ ledger: TaskLedger; changed: readonly TaskRecord[] }> => {
      await this.load()
      if (!this.writable()) throw new ReadOnlyError()

      const draft: TaskLedger = structuredClone(this.ledger)
      const changed = mutator(draft)
      if (changed === undefined) {
        // Even an abandoned write returns a frozen clone; events never expose internals.
        return { ledger: deepFreeze(structuredClone(this.ledger)), changed: [] }
      }

      // Re-apply the retention cap on every commit so execution history stays bounded.
      for (const task of changed) pruneExecutions(task)
      draft.revision += 1

      const before = new Set(this.ledger.tasks.map(task => task.id))
      const after = new Set(draft.tasks.map(task => task.id))
      const removed = [...before].filter(id => !after.has(id))
      const full = kind === 'ledger-replaced'

      await this.writeDetails(full ? draft.tasks : changed, removed)
      const nextIndex = await this.writeIndex(draft, changed, removed, full)

      // The ledger and the index swap in one synchronous block. With a resume point
      // between them, polling could observe new summaries with a stale revision and keep
      // reporting "unchanged".
      this.ledger = draft
      this.index = Object.freeze(nextIndex) as TaskSummary[]

      const frozenChanged = changed.map(task => deepFreeze(structuredClone(task)))
      const change: LedgerChange = { revision: draft.revision, tasks: frozenChanged, kind }
      for (const fn of this.subscribers) {
        try {
          fn(change)
        } catch {
          /* A failing subscriber must not fail the write */
        }
      }
      return { ledger: deepFreeze(structuredClone(draft)), changed: frozenChanged }
    }
    const result = (this.queue = this.queue.then(run, run)) as ReturnType<typeof run>
    return result
  }

  /** Read after all queued changes, without mutating anything. */
  async read<T>(fn: (ledger: TaskLedger) => T): Promise<T> {
    const run = async (): Promise<T> => {
      await this.load()
      return fn(deepFreeze(structuredClone(this.ledger)))
    }
    const result = (this.queue = this.queue.then(run, run)) as Promise<T>
    return result
  }

  /**
   * Write changed details and delete vanishing ones.
   *
   * The concurrency cap matters for bulk imports, where serial fsync per task is far too
   * slow.
   */
  private async writeDetails(tasks: readonly TaskRecord[], removed: readonly string[]): Promise<void> {
    await mapLimit(tasks, WRITE_CONCURRENCY, task => persistJsonAsync(this.taskFile(task.id), task))
    await mapLimit(removed, WRITE_CONCURRENCY, id =>
      unlink(this.taskFile(id)).catch(() => { /* already gone */ }))
  }

  /**
   * Rebuild the affected summaries and rewrite the index.
   *
   * The in-memory index is replaced only after the write succeeds; replacing it first would
   * leave memory, the ledger, and disk inconsistent if the write failed. The new index is
   * returned so {@link mutate} can install it together with the ledger.
   */
  private async writeIndex(
    draft: TaskLedger,
    changed: readonly TaskRecord[],
    removed: readonly string[],
    full: boolean,
  ): Promise<TaskSummary[]> {
    let next: TaskSummary[]
    if (full) {
      next = draft.tasks.map(summarize)
    } else {
      const removedSet = new Set(removed)
      const touched = new Map(changed.map(task => [task.id, task]))
      next = []
      for (const summary of this.index) {
        if (removedSet.has(summary.id)) continue
        const replacement = touched.get(summary.id)
        next.push(replacement === undefined ? summary : summarize(replacement))
      }
      const known = new Set(this.index.map(summary => summary.id))
      for (const task of changed) {
        if (!known.has(task.id) && !removedSet.has(task.id)) next.push(summarize(task))
      }
    }
    await this.persistIndex(draft, next)
    return next
  }

  private async persistIndex(draft: TaskLedger, tasks: readonly TaskSummary[] = this.index): Promise<void> {
    // `settings` is deliberately not written: it moved to `castboard.settings.yaml`, and a
    // stale copy here would resurrect old values after a downgrade. A legacy key read at
    // load time therefore disappears on the next task write.
    await persistJsonAsync(this.indexFile, {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      revision: draft.revision,
      tasks,
    })
  }

  private taskFile(id: string): string {
    return join(this.tasksDir, `${id}.json`)
  }
}
