/**
 * One storage directory has one writer. The ledger is a single file rewritten whole with no
 * cross-process lock, so two dsh web instances sharing a directory would overwrite each
 * other — and a later starter's startup reconciliation would mark the other process's live
 * executions as failed. The lease at `<storage dir>/castboard.pid` makes exactly one process
 * the owner (writes, scheduled releases, dispatch, startup reconciliation, execution
 * control) and leaves the rest read-only; reads keep working everywhere.
 *
 * A missing/corrupt file or a stale heartbeat can be claimed by a synchronous atomic write
 * plus a read-back, so of two simultaneous claimants only the one that reads back its own
 * instanceId wins. The owner re-checks on every heartbeat and demotes immediately once the
 * file is no longer its own. A secondary retries every tick and takes over as soon as the
 * owner shuts down; the caller catches up in `onPromoted`. The file is deleted on dispose
 * only while we still own it.
 *
 * Liveness comes from this heartbeat alone — `process.kill(pid, 0)` is ruled out because
 * pids get reused and behavior is platform-specific. The file is tiny and touched once per
 * heartbeat, so sync I/O keeps the role settled before assembly and serializes heartbeat
 * and claim naturally.
 *
 * @module dsh-magica-castboard/host/ledger/lease
 */
import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { eventLog } from '../shared/event-log.ts'
import { persistJson } from './atomic.ts'

export const LEASE_FILE = 'castboard.pid'

export const DEFAULT_HEARTBEAT_MS = 15_000

/** After this long without an update the holder is considered gone and the lease may be taken. */
export const DEFAULT_STALE_MS = 60_000

// Aliases so callers can use the name that fits their semantics.
export const HEARTBEAT_MS = DEFAULT_HEARTBEAT_MS
export const STALE_MS = DEFAULT_STALE_MS

export interface LeaseHolder {
  /** Diagnostic only; liveness is decided by the heartbeat. */
  pid: number
  instanceId: string
  since: number
  heartbeatAt: number
}

export type LeaseRole = 'owner' | 'secondary'

export interface StorageLeaseDeps {
  /** Storage directory. Mutually exclusive with `file`. */
  dir?: string
  /** Full lease file path. Mutually exclusive with `dir`. */
  file?: string
  instanceId: string
  pid?: number
  now?: () => number
  heartbeatMs?: number
  staleMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /**
   * Called when the role is promoted from secondary to owner. Not called when the first
   * `start()` already acquires the lease — the caller handles that path synchronously.
   */
  onPromoted?: () => void | Promise<void>
  /** Called when the role drops back to secondary; owner-only work must stop immediately. */
  onDemoted?: () => void
}

/** Anything with the wrong shape counts as "no lease" and may therefore be claimed. */
export function parseHolder(raw: string | undefined): LeaseHolder | undefined {
  if (raw === undefined) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<LeaseHolder>
    if (typeof parsed.instanceId !== 'string' || parsed.instanceId.length === 0) return undefined
    if (typeof parsed.pid !== 'number' || !Number.isFinite(parsed.pid)) return undefined
    if (typeof parsed.heartbeatAt !== 'number' || !Number.isFinite(parsed.heartbeatAt)) return undefined
    return {
      pid: parsed.pid,
      instanceId: parsed.instanceId,
      since: typeof parsed.since === 'number' && Number.isFinite(parsed.since) ? parsed.since : parsed.heartbeatAt,
      heartbeatAt: parsed.heartbeatAt,
    }
  } catch {
    return undefined
  }
}

// One shot, unref'd so the heartbeat never keeps the process alive.
function defaultSetTimer(fn: () => void, ms: number): unknown {
  const timer = setTimeout(() => {
    try {
      fn()
    } catch (error) {
      eventLog('warn', 'lease-tick-failed', error instanceof Error ? error.message : String(error))
    }
  }, ms)
  timer.unref?.()
  return timer
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as Parameters<typeof clearTimeout>[0])
}

export class StorageLease {
  private readonly filePath: string
  private readonly instanceId: string
  private readonly pidValue: number
  private readonly deps: StorageLeaseDeps
  private role: LeaseRole = 'secondary'
  private currentHolder: LeaseHolder | undefined
  private handle: unknown
  private disposed = false
  /** Each hook fires once per transition, so heartbeat jitter cannot start work twice. */
  private promoted = false
  private demoted = false
  private started = false

  constructor(deps: StorageLeaseDeps) {
    const file = deps.file ?? (deps.dir === undefined ? undefined : join(deps.dir, LEASE_FILE))
    if (file === undefined) throw new Error('StorageLease requires a dir or a file path')
    this.filePath = file
    this.instanceId = deps.instanceId
    this.pidValue = deps.pid ?? process.pid
    this.deps = deps
  }

  get file(): string {
    return this.filePath
  }

  get pid(): number {
    return this.pidValue
  }

  get currentRole(): LeaseRole {
    return this.role
  }

  isOwner(): boolean {
    return this.role === 'owner'
  }

  holder(): LeaseHolder | undefined {
    return this.currentHolder
  }

  /**
   * Settle the role synchronously, then arm the heartbeat. Synchronous on purpose: the
   * caller assembles the remaining components by role immediately afterwards.
   */
  start(): LeaseRole {
    if (this.disposed) return 'secondary'
    try {
      this.applyHolder(parseHolder(this.readRaw()))
    } catch (error) {
      eventLog('warn', 'lease-start-failed', error instanceof Error ? error.message : String(error))
    }
    this.arm()
    this.started = true
    return this.role
  }

  /** Stop the heartbeat and delete the file only if the lease is still ours. */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
    if (this.role !== 'owner') return
    this.role = 'secondary'
    try {
      const holder = parseHolder(this.readRaw())
      if (holder?.instanceId !== this.instanceId) return
      unlinkSync(this.filePath)
    } catch {
      /* already gone, or lost the race */
    }
  }

  // ---------------------------------------------------------------- internals

  private get heartbeatMs(): number {
    return this.deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  }

  private get staleMs(): number {
    return this.deps.staleMs ?? DEFAULT_STALE_MS
  }

  private arm(): void {
    if (this.disposed) return
    this.handle = (this.deps.setTimer ?? defaultSetTimer)(() => { this.tick() }, this.heartbeatMs)
  }

  private tick(): void {
    this.handle = undefined
    if (this.disposed) return
    try {
      this.applyHolder(parseHolder(this.readRaw()))
    } catch (error) {
      eventLog('warn', 'lease-tick-failed', error instanceof Error ? error.message : String(error))
    } finally {
      this.arm()
    }
  }

  private applyHolder(holder: LeaseHolder | undefined): void {
    const now = this.deps.now?.() ?? Date.now()
    const mine = holder !== undefined && holder.instanceId === this.instanceId

    if (this.role === 'owner') {
      if (mine && holder !== undefined) {
        this.currentHolder = holder
        this.write({ ...holder, heartbeatAt: now })
        return
      }
      // The heartbeat stalled long enough that the lease went to someone else — stop writing now.
      this.role = 'secondary'
      this.currentHolder = holder
      eventLog('warn', 'lease-lost', `pid ${holder?.pid ?? '?'}; this host is now read-only`)
      // A future promotion must be able to notify again.
      this.promoted = false
      if (!this.demoted) {
        this.demoted = true
        try {
          this.deps.onDemoted?.()
        } catch (error) {
          eventLog('warn', 'lease-demote-hook-failed', error instanceof Error ? error.message : String(error))
        }
      }
      return
    }

    if (mine && holder !== undefined) {
      // Another module instance in this process left the file behind: keep ownership.
      this.role = 'owner'
      this.currentHolder = holder
      this.write({ ...holder, heartbeatAt: now })
      return
    }

    if (holder === undefined || now - holder.heartbeatAt >= this.staleMs) {
      this.claim(now)
      return
    }

    this.role = 'secondary'
    this.currentHolder = holder
  }

  /** Atomic replace plus read-back: of concurrent claimants only one reads back its own id. */
  private claim(now: number): void {
    try {
      this.write({
        pid: this.pidValue,
        instanceId: this.instanceId,
        since: now,
        heartbeatAt: now,
      })
    } catch (error) {
      eventLog('warn', 'lease-claim-failed', error instanceof Error ? error.message : String(error))
      this.role = 'secondary'
      return
    }
    const after = parseHolder(this.readRaw())
    if (after?.instanceId === this.instanceId) {
      const promoted = this.role === 'secondary'
      this.role = 'owner'
      this.currentHolder = after
      // Owner again: a later loss may notify once more.
      this.demoted = false
      // Acquisition during the first `start()` is not a promotion; the caller starts that work itself.
      if (promoted && this.started) this.notifyPromoted()
      return
    }
    this.role = 'secondary'
    this.currentHolder = after
  }

  private notifyPromoted(): void {
    const hook = this.deps.onPromoted
    if (this.promoted || hook === undefined) return
    this.promoted = true
    void Promise.resolve()
      .then(() => hook())
      .catch((error: unknown) => {
        eventLog('warn', 'lease-promote-hook-failed', error instanceof Error ? error.message : String(error))
      })
  }

  private write(holder: LeaseHolder): void {
    persistJson(this.filePath, holder)
  }

  // A failed read means "no lease", never an exception.
  private readRaw(): string | undefined {
    try {
      return readFileSync(this.filePath, 'utf8')
    } catch {
      return undefined
    }
  }

  private clearTimer(): void {
    if (this.handle === undefined) return
    ;(this.deps.clearTimer ?? defaultClearTimer)(this.handle)
    this.handle = undefined
  }
}
