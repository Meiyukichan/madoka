/**
 * Project portrait ledger — `$DSH_HOME/storages/castboard/worklabs/workspaces.json`.
 *
 * One file holds the batch id (one batch per day), the long-lived portrait session, and per-project
 * progress. The batch id expires yesterday's results at the day boundary while a single batch never
 * rewrites a portrait twice; the session block lets a restart or hot reload resume the same agent.
 *
 * Only the lease holder writes; other `dsh web` processes read, otherwise the two would overwrite
 * each other's progress.
 *
 * Persisted `status` is only `pending` / `in_progress` / `done`. "Running" and "failed" are derived:
 * running is `in_progress` with `startedAt`; failed is `pending` with `attempts` / `error`, and
 * `disabled` once the cap is hit.
 *
 * @module dsh-magica-castboard/host/portrait/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { eventLog } from '../shared/event-log.ts'

export type PortraitLog = (level: 'info' | 'warn', event: string, detail?: string) => void

// Same `[castboard]` prefix as the rest of the host, so one grep gives one timeline.
export const consolePortraitLog: PortraitLog = (level, event, detail) => {
  eventLog(level, event, detail ?? '')
}

export type PortraitStatus = 'pending' | 'in_progress' | 'done'

export interface PortraitEntry {
  id: string
  path: string
  title: string
  status: PortraitStatus
  /**
   * No longer scanned: gone from the registry, or failed up to the cap.
   *
   * The record is kept, not deleted: when the project returns it is recognized (flag cleared,
   * progress preserved), so an already written portrait is not rewritten.
   */
  disabled?: boolean
  // Failure count in this batch; the cap disables the entry.
  attempts?: number
  error?: string
  startedAt?: number
  doneAt?: number
}

export interface PortraitSessionInfo {
  /** Empty string = discarded on purpose; create a new session on the next tick. */
  sessionId?: string
  createdAt?: number
  lastWorkspaceId?: string
  failures?: number
  lastError?: string
}

export interface PortraitLedger {
  batch: string
  session?: PortraitSessionInfo
  workspaces: PortraitEntry[]
}

/** Consecutive failures reaching this count → leave the project alone for the rest of the batch. */
export const PORTRAIT_MAX_ATTEMPTS = 3

export function batchDateOf(epochMs: number): string {
  const at = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

export interface PortraitSyncResult {
  readonly rolled: boolean
  readonly added: number
  readonly disabled: number
  readonly total: number
  readonly changed: boolean
}

export interface PortraitStoreDeps {
  readonly file: string
  readonly now: () => number
  readonly canWrite: () => boolean
  readonly log?: PortraitLog
}

export class PortraitStore {
  private current: PortraitLedger = { batch: '', workspaces: [] }
  private loaded = false
  private readonly file: string
  private readonly now: () => number
  private readonly canWrite: () => boolean
  private readonly log: PortraitLog

  constructor(deps: PortraitStoreDeps) {
    this.file = deps.file
    this.now = deps.now
    this.canWrite = deps.canWrite
    this.log = deps.log ?? consolePortraitLog
  }

  get path(): string {
    return this.file
  }

  /**
   * Missing, empty, and corrupt all read as an empty ledger. An empty file is a placeholder someone
   * created by hand, so it is not worth a warning.
   */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const text = await readFile(this.file, 'utf8')
      this.current = text.trim() === '' ? { batch: '', workspaces: [] } : parseLedger(text)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log('warn', 'portrait-ledger-unreadable', `${this.file}：${errorText(error)}`)
      }
      this.current = { batch: '', workspaces: [] }
    }
  }

  ledger(): PortraitLedger {
    return this.current
  }

  /**
   * Reconcile against the latest registry.
   *
   * A new batch requeues everything (status, `disabled`, timestamps) but keeps the session. Within
   * the same batch, new projects join as `pending`, missing ones become `disabled`, and returning
   * ones keep their progress — a `done` portrait is not rewritten.
   */
  async sync(list: ReadonlyArray<{ id: string; path: string; title: string }>, batch: string): Promise<PortraitSyncResult> {
    await this.load()
    const previousBatch = this.current.batch
    const before = JSON.stringify(this.current)
    const rolled = previousBatch !== batch
    let added = 0
    let disabled = 0

    if (rolled) {
      const known = new Set(this.current.workspaces.map(entry => entry.id))
      this.current = {
        batch,
        // The session survives the rollover: the same agent is reused all day.
        ...(this.current.session === undefined ? {} : { session: this.current.session }),
        workspaces: list.map(item => ({
          id: item.id,
          path: item.path,
          title: item.title,
          status: 'pending' as const,
        })),
      }
      added = list.filter(item => !known.has(item.id)).length
      if (this.current.workspaces.length > 0) {
        this.log('info', 'portrait-batch-rolled',
          `${previousBatch === '' ? '（初建）' : `${previousBatch} → ${batch}`}，`
          + `${String(list.length)} 个项目全部重排为 pending`)
      }
    } else {
      const incoming = new Map(list.map(item => [item.id, item]))
      const next: PortraitEntry[] = []
      for (const item of list) {
        const previous = this.current.workspaces.find(entry => entry.id === item.id)
        if (previous === undefined) {
          added += 1
          next.push({ id: item.id, path: item.path, title: item.title, status: 'pending' })
          continue
        }
        // `disabled` has two sources and they must be handled separately: "gone from the registry"
        // is cleared when the project returns (progress preserved), while "failed up to the cap in
        // this batch" must stay — clearing it would allow another retry. Only the manual refresh
        // clears that one explicitly.
        const updated: PortraitEntry = { ...previous, path: item.path, title: item.title }
        if (updated.disabled === true && (updated.attempts ?? 0) < PORTRAIT_MAX_ATTEMPTS) delete updated.disabled
        next.push(updated)
      }
      for (const gone of this.current.workspaces) {
        if (incoming.has(gone.id)) continue
        if (gone.disabled !== true) disabled += 1
        next.push({ ...gone, disabled: true })
      }
      if (added > 0 || disabled > 0) {
        this.log('info', 'portrait-ledger-synced',
          `新增 ${String(added)} 个、下线 ${String(disabled)} 个（不扫描），共 ${String(next.length)} 个`)
      }
      this.current = { ...this.current, workspaces: next }
    }

    const changed = JSON.stringify(this.current) !== before
    if (changed) await this.save()
    return { rolled, added, disabled, total: this.current.workspaces.length, changed }
  }

  async markInProgress(id: string, sessionId: string): Promise<void> {
    const entry = this.find(id)
    if (entry === undefined) return
    entry.status = 'in_progress'
    entry.startedAt = this.now()
    delete entry.error
    this.current.session = { ...(this.current.session ?? {}), sessionId, lastWorkspaceId: id }
    await this.save()
  }

  async markDone(id: string): Promise<void> {
    const entry = this.find(id)
    if (entry === undefined) return
    entry.status = 'done'
    entry.doneAt = this.now()
    delete entry.error
    entry.attempts = 0
    await this.save()
  }

  /**
   * Back to `pending` with one more failure. The count is capped so repeated manual refreshes do
   * not turn "attempt n/3" in the log into nonsense.
   */
  async markFailed(id: string, reason: string): Promise<void> {
    const entry = this.find(id)
    if (entry === undefined) return
    entry.attempts = Math.min((entry.attempts ?? 0) + 1, PORTRAIT_MAX_ATTEMPTS)
    entry.error = reason
    entry.status = 'pending'
    if (entry.attempts >= PORTRAIT_MAX_ATTEMPTS) entry.disabled = true
    await this.save()
  }

  async saveSession(patch: Partial<PortraitSessionInfo>): Promise<void> {
    this.current.session = { ...(this.current.session ?? {}), ...patch }
    await this.save()
  }

  /**
   * A turn marked `in_progress` cannot survive a process restart. Put those entries
   * back in the queue so the next batch can resume them instead of leaving an
   * unreachable row forever.
   *
   * @returns number of recovered entries.
   */
  async recoverInProgress(): Promise<number> {
    await this.load()
    const recovered = this.current.workspaces.filter(entry => entry.status === 'in_progress')
    if (recovered.length === 0) return 0
    for (const entry of recovered) entry.status = 'pending'
    this.log('warn', 'portrait-in-progress-recovered',
      `${String(recovered.length)} 个项目上次在 in_progress 中断，已复位为 pending`)
    await this.save()
    return recovered.length
  }

  /**
   * Manual refresh: requeue everything but keep the batch id, failure counts, and session — it is an
   * immediate rerun, not a fake new day.
   */
  async resetAll(): Promise<number> {
    await this.load()
    const count = this.current.workspaces.length
    if (count === 0) return 0
    for (const entry of this.current.workspaces) {
      entry.status = 'pending'
      entry.attempts = 0
      delete entry.disabled
      delete entry.error
      delete entry.startedAt
      delete entry.doneAt
    }
    this.log('info', 'portrait-ledger-reset', `${String(count)} 个项目已重置为 pending（手动全量更新）`)
    await this.save()
    return count
  }

  async save(): Promise<void> {
    // Lease holder only; tmp + rename in the same directory so a crash never leaves half a file.
    if (!this.canWrite()) {
      this.log('warn', 'portrait-ledger-readonly', `${this.file}：本进程不是租约主人，跳过写入`)
      return
    }
    const text = `${JSON.stringify(this.current, null, 2)}\n`
    const tmp = `${this.file}.tmp`
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, this.file)
    } catch (error) {
      this.log('warn', 'portrait-ledger-write-failed', `${this.file}：${errorText(error)}`)
    }
  }

  private find(id: string): PortraitEntry | undefined {
    return this.current.workspaces.find(entry => entry.id === id)
  }
}

// A malformed record is dropped; the rest of the file still loads.
function parseLedger(text: string): PortraitLedger {
  const raw = JSON.parse(text) as unknown
  if (raw === null || typeof raw !== 'object') return { batch: '', workspaces: [] }
  const source = raw as { batch?: unknown; session?: unknown; workspaces?: unknown }
  const batch = typeof source.batch === 'string' ? source.batch : ''
  const session = source.session !== null && typeof source.session === 'object'
    ? source.session as PortraitSessionInfo
    : undefined
  const workspaces: PortraitEntry[] = []
  if (Array.isArray(source.workspaces)) {
    for (const item of source.workspaces) {
      const entry = toEntry(item)
      if (entry !== undefined) workspaces.push(entry)
    }
  }
  return { batch, ...(session === undefined ? {} : { session }), workspaces }
}

function toEntry(value: unknown): PortraitEntry | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id === '') return undefined
  const status: PortraitStatus = raw.status === 'done' || raw.status === 'in_progress' ? raw.status : 'pending'
  return {
    id: raw.id,
    path: typeof raw.path === 'string' ? raw.path : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    status,
    ...(raw.disabled === true ? { disabled: true } : {}),
    ...(typeof raw.attempts === 'number' && Number.isFinite(raw.attempts) ? { attempts: raw.attempts } : {}),
    ...(typeof raw.error === 'string' && raw.error !== '' ? { error: raw.error } : {}),
    ...(typeof raw.startedAt === 'number' ? { startedAt: raw.startedAt } : {}),
    ...(typeof raw.doneAt === 'number' ? { doneAt: raw.doneAt } : {}),
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
