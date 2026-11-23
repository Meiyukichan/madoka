/**
 * Unified attachment synchronizer.
 *
 * The cloud attachment table is the source of truth, and its rows are identified by
 * `targetType + targetId + role`. The local view derives `input` / `output` / `comment`
 * from that identity; nothing on the wire or in the manifest stores those words.
 *
 * Every consumer (issue-state, claim, task card) uses this service instead of
 * calling the download SDK directly. Files are downloaded serially and an
 * existing local file is never fetched again.
 *
 * @module dsh-magica-castboard/host/pipeline/attachment-sync
 */
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'

import {
  safeFileName,
  type AttachmentRole,
  type AttachmentTargetType,
  type StoredAttachment,
  type TaskAttachmentIndex,
} from './attachments.ts'

export interface RemoteAttachmentMeta {
  readonly fileId: string
  readonly fileName: string
  readonly targetType: AttachmentTargetType
  readonly targetId: string
  readonly role: AttachmentRole
  readonly description?: string
}

export interface AttachmentSyncDeps {
  readonly index: TaskAttachmentIndex
  /**
   * Cloud metadata list. `role` omitted = both roles.
   *
   * Omitted entirely = local-only (offline/tests).
   */
  readonly list?: (
    targetType: AttachmentTargetType,
    targetId: string,
    role?: AttachmentRole,
  ) => Promise<readonly RemoteAttachmentMeta[]>
  /** Download one cloud file; required when `list` is present. */
  readonly download?: (fileId: string) => Promise<Uint8Array>
  readonly log?: (level: 'info' | 'warn', event: string, detail?: unknown) => void
}

export interface SyncAttachmentsOptions {
  /** Resolve after downloads (default true); false reserves paths and downloads in background. */
  readonly wait?: boolean
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Keep a stable suffix so a duplicate cloud name maps to a distinct path. */
function withFileIdSuffix(name: string, fileId: string): string {
  const safe = safeFileName(name)
  const suffix = fileId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'file'
  const dot = extname(safe)
  if (dot === '') return `${safe}.${suffix}`
  return `${safe.slice(0, -dot.length)}.${suffix}${dot}`
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function sameTarget(
  row: { targetType: AttachmentTargetType; targetId: string },
  targetType: AttachmentTargetType,
  targetId: string,
): boolean {
  return row.targetType === targetType && row.targetId === targetId
}

export class AttachmentSync {
  private readonly deps: AttachmentSyncDeps
  private chain: Promise<void> = Promise.resolve()

  constructor(deps: AttachmentSyncDeps) {
    this.deps = deps
  }

  /**
   * Issue-target rows (both roles) with remote metadata merged in, without downloading.
   *
   * Comment-target rows are never included: the task card shows the issue's own files only.
   * Local rows are included even when the cloud is unavailable, so the panel can still
   * show a cached file.
   */
  async listIssue(issueId: string): Promise<readonly StoredAttachment[]> {
    const local = this.deps.index.list(issueId).filter(row => sameTarget(row, 'issue', issueId))
    if (this.deps.list === undefined) return local
    try {
      const remote = this.filterRemote(await this.deps.list('issue', issueId), 'issue', issueId)
      return await this.mergeRows(issueId, 'issue', issueId, remote, local)
    } catch (error) {
      this.log('warn', 'attachment-sync-list-failed', { issueId, targetType: 'issue', error: errorText(error) })
      return local
    }
  }

  /**
   * Synchronize the issue target (both roles).
   *
   * Comment-target rows and their files are left untouched: they belong to comments and are
   * synchronized by {@link syncComment}.
   */
  syncIssue(issueId: string, options: SyncAttachmentsOptions = {}): Promise<readonly StoredAttachment[]> {
    return this.enqueue(() => this.syncTarget(issueId, 'issue', issueId, options.wait !== false))
  }

  /** Synchronize one comment target (`targetType: 'comment'`, `targetId: commentId`). */
  syncComment(
    issueId: string,
    commentId: string,
    options: SyncAttachmentsOptions = {},
  ): Promise<readonly StoredAttachment[]> {
    return this.enqueue(() => this.syncTarget(issueId, 'comment', commentId, options.wait !== false))
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  private async syncTarget(
    issueId: string,
    targetType: AttachmentTargetType,
    targetId: string,
    wait: boolean,
  ): Promise<readonly StoredAttachment[]> {
    const local = this.deps.index.list(issueId).filter(row => sameTarget(row, targetType, targetId))
    if (this.deps.list === undefined) return local

    let remote: readonly RemoteAttachmentMeta[]
    try {
      remote = this.filterRemote(await this.deps.list(targetType, targetId), targetType, targetId)
    } catch (error) {
      this.log('warn', 'attachment-sync-list-failed', { issueId, targetType, targetId, error: errorText(error) })
      return local
    }

    const rows = await this.mergeRows(issueId, targetType, targetId, remote, local)
    await this.deps.index.putTarget(issueId, targetType, targetId, rows)

    const pending = rows.filter(row => row.state === 'pending')
    if (pending.length === 0 || this.deps.download === undefined) return rows

    const download = this.deps.download
    const work = (async (): Promise<void> => {
      for (const row of pending) {
        if (row.fileId === undefined || row.fileId === '') continue
        try {
          const data = await download(row.fileId)
          const written = await this.deps.index.writeContent(
            issueId,
            targetType,
            targetId,
            row.role,
            row.name,
            data,
          )
          const current = rows.find(candidate => candidate.fileId === row.fileId && candidate.role === row.role)
          if (current !== undefined) {
            const index = rows.indexOf(current)
            rows[index] = { ...current, path: written.path, size: written.size, state: 'ready' }
          }
          this.log('info', 'attachment-sync-downloaded', {
            issueId,
            targetType,
            targetId,
            fileId: row.fileId,
            path: written.path,
          })
        } catch (error) {
          this.log('warn', 'attachment-sync-download-failed', {
            issueId,
            targetType,
            targetId,
            fileId: row.fileId,
            error: errorText(error),
          })
        }
      }
      // Persist ready states once, not after every file.
      await this.deps.index.putTarget(issueId, targetType, targetId, rows)
    })()

    if (!wait) {
      void work.catch(error => {
        this.log('warn', 'attachment-sync-background-failed', { issueId, targetType, targetId, error: errorText(error) })
      })
      return rows
    }
    await work
    return rows
  }

  /**
   * Merge cloud rows into the target's local rows:
   * - same fileId keeps its existing path;
   * - same name without a fileId (legacy row) is adopted;
   * - otherwise the path is deterministic, with a fileId suffix on collision.
   */
  private async mergeRows(
    issueId: string,
    targetType: AttachmentTargetType,
    targetId: string,
    remote: readonly RemoteAttachmentMeta[],
    local: readonly StoredAttachment[],
  ): Promise<StoredAttachment[]> {
    const rows: StoredAttachment[] = []
    const used = new Set<string>()

    for (const row of local) {
      const ready = await exists(row.path)
      rows.push({ ...row, targetType, targetId, state: ready ? 'ready' : 'pending' })
      used.add(`${row.role}\u0000${row.name}`)
    }

    for (const meta of remote) {
      const claimed = rows.find(row =>
        row.role === meta.role
        && (row.fileId === meta.fileId
          || (row.fileId === undefined && row.name === safeFileName(meta.fileName))),
      )
      if (claimed !== undefined) {
        // Adopt a legacy row and keep the cloud id/description.
        const ready = await exists(claimed.path)
        const index = rows.indexOf(claimed)
        rows[index] = {
          ...claimed,
          targetType,
          targetId,
          role: meta.role,
          fileId: meta.fileId,
          state: ready ? 'ready' : 'pending',
          ...(meta.description === undefined ? {} : { description: meta.description }),
        }
        used.add(`${meta.role}\u0000${claimed.name}`)
        continue
      }

      const base = safeFileName(meta.fileName)
      const key = `${meta.role}\u0000${base}`
      const name = used.has(key) ? withFileIdSuffix(base, meta.fileId) : base
      used.add(`${meta.role}\u0000${name}`)
      const path = this.deps.index.filePathOf(issueId, targetType, targetId, meta.role, name)
      const ready = await exists(path)
      rows.push({
        name,
        path,
        targetType,
        targetId,
        role: meta.role,
        fileId: meta.fileId,
        state: ready ? 'ready' : 'pending',
        ...(meta.description === undefined ? {} : { description: meta.description }),
      })
    }

    return rows
  }

  /** Trust only rows that really belong to the requested target (the SDK may ignore the filter). */
  private filterRemote(
    rows: readonly RemoteAttachmentMeta[],
    targetType: AttachmentTargetType,
    targetId: string,
  ): readonly RemoteAttachmentMeta[] {
    return rows.filter(row =>
      row.targetType === targetType
      && row.targetId === targetId
      && (row.role === 'assigner' || row.role === 'assignee')
      && typeof row.fileId === 'string'
      && row.fileId !== '',
    )
  }

  private log(level: 'info' | 'warn', event: string, detail?: unknown): void {
    this.deps.log?.(level, event, detail)
  }
}
