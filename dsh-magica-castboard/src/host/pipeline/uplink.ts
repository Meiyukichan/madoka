/**
 * Artifact uplink: upload artifacts from executor reports to the shared library and attach them to the issue.
 *
 * ## Two channels share one idempotency table
 *
 * Artifacts may be uploaded when a report is submitted mid-run, or included with the result at settlement; both channels
 * write `uploadedFiles` (local absolute path -> cloud fileId), so the same file never appears twice on an issue and a
 * rejected upload is not retried on every settlement.
 *
 * ## Discipline
 *
 * | Rule | Reason |
 * |---|---|
 * | At most 10 per call | Concurrent uploads would fill the libuv thread pool and queue HTTP for every other plugin |
 * | At most 50MB per file | A large file stalls the whole chain for minutes, and deliverables are rarely disk images |
 * | Skip empty files | Object storage rejects empty objects; posting one only yields 400 |
 * | Upload serially | Artifacts are infrequent; serial is enough and keeps failures readable in order |
 * | Record idempotency only after attaching | Recording early means "thinks it uploaded, but the issue has nothing", silently losing artifacts |
 * | Record failures one by one | Artifacts are supplementary; one file failing must not abort the batch |
 *
 * ## Paths that are never uploaded
 *
 * `node_modules/`, `.git/`, logs, temporary files and sourcemaps are not deliverables; uploading them only turns the shared
 * library into a backup disk. The test lives in {@link shouldSkipPath}.
 *
 * @module dsh-magica-castboard/host/pipeline/uplink
 */
import { stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'

import type { PublishCursorStore } from '../ledger/cursors.ts'

export const MAX_UPLOAD_FILES = 10

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/** Maximum description length (server column width). */
export const MAX_UPLOAD_DESCRIPTION = 500

export const SKIP_SEGMENTS: readonly string[] = [
  '/node_modules/',
  '\\node_modules\\',
  '/.git/',
  '\\.git\\',
]

export const SKIP_EXTENSIONS: readonly string[] = ['.log', '.tmp']

export const SKIP_SUFFIXES: readonly string[] = ['.map']

export interface ArtifactAttachmentSpec {
  readonly fileId: string
  readonly fileName: string
  /** Artifact role: who produced it. */
  readonly role: 'assigner' | 'assignee'
  readonly description?: string
}

export interface ArtifactUplinkDeps {
  /** Publish cursor (`uploadedFiles` is the artifact-upload idempotency table). */
  readonly cursors: PublishCursorStore
  readonly upload: (path: string, fileName: string) => Promise<string>
  readonly attach: (issueId: string, spec: ArtifactAttachmentSpec) => Promise<void>
  /** Whether this process may upload (multi-process lease; defaults to true). */
  readonly isWritable?: () => boolean
  readonly log?: (level: 'info' | 'warn', event: string, detail?: unknown) => void
}

export interface UplinkFileResult {
  readonly path: string
  readonly fileId?: string
}

export interface UplinkSkip {
  readonly path: string
  readonly reason: string
}

export interface UplinkFailure {
  readonly path: string
  readonly reason: string
}

export interface UplinkResult {
  readonly uploaded: UplinkFileResult[]
  readonly skipped: UplinkSkip[]
  readonly failed: UplinkFailure[]
}

export interface UplinkOptions {
  /** Base directory for relative paths (the task's cwd). */
  readonly cwd?: string
  /** Description (usually the execution report summary). */
  readonly description?: string
}

interface ScheduledBatch {
  readonly paths: string[]
  options: UplinkOptions
}

function emptyResult(): UplinkResult {
  return { uploaded: [], skipped: [], failed: [] }
}

/**
 * Whether this path should be skipped, and why; `undefined` when it should be uploaded.
 *
 * @param filePath - File path (may contain platform separators).
 */
export function shouldSkipPath(filePath: string): string | undefined {
  for (const segment of SKIP_SEGMENTS) {
    if (filePath.includes(segment)) return `路径片段 ${segment.trim()}`
  }
  const lower = filePath.toLowerCase()
  for (const extension of SKIP_EXTENSIONS) {
    if (lower.endsWith(extension)) return `扩展名 ${extension}`
  }
  for (const suffix of SKIP_SUFFIXES) {
    if (lower.endsWith(suffix)) return `后缀 ${suffix}`
  }
  return undefined
}

export class ArtifactUplink {
  private readonly deps: ArtifactUplinkDeps

  constructor(deps: ArtifactUplinkDeps) {
    this.deps = deps
  }

  /**
   * Upload a batch of artifacts and attach them to the issue (never throws).
   *
   * @param issueId - Issue to attach to (do not call for locally created issues: the cloud has no such row).
   * @param artifacts - Artifact paths (relative paths resolve against `options.cwd`).
   * @param options - Base directory for relative paths and the description.
   */
  async uplink(
    issueId: string,
    artifacts: readonly string[],
    options: UplinkOptions = {},
  ): Promise<UplinkResult> {
    const result = emptyResult()
    if (!this.writable()) {
      for (const artifact of artifacts) {
        result.skipped.push({ path: artifact, reason: '本进程只读' })
      }
      return result
    }
    if (issueId.length === 0) {
      for (const artifact of artifacts) {
        result.skipped.push({ path: artifact, reason: '缺少 issue id' })
      }
      return result
    }

    try {
      await this.deps.cursors.load()
    } catch (error) {
      this.log('warn', 'artifact-uplink-cursor-failed', errorText(error))
    }

    const accepted = artifacts.slice(0, MAX_UPLOAD_FILES)
    for (const extra of artifacts.slice(MAX_UPLOAD_FILES)) {
      // Paths beyond the batch limit are not dropped silently: the receipt states why, so the caller knows something was not uploaded.
      result.skipped.push({ path: extra, reason: `单次最多 ${MAX_UPLOAD_FILES} 个` })
    }
    if (artifacts.length > accepted.length) {
      this.log('warn', 'artifact-uplink-truncated', {
        issueId,
        total: artifacts.length,
        limit: MAX_UPLOAD_FILES,
      })
    }

    const description = (options.description ?? '').trim().slice(0, MAX_UPLOAD_DESCRIPTION)
    const seen = new Set<string>()

    for (const raw of accepted) {
      const absolute = this.resolvePath(raw, options.cwd)
      if (absolute === undefined) {
        result.skipped.push({ path: raw, reason: '无法解析成绝对路径' })
        continue
      }
      if (seen.has(absolute)) {
        result.skipped.push({ path: absolute, reason: '本批重复' })
        continue
      }
      seen.add(absolute)

      const skipReason = shouldSkipPath(absolute)
      if (skipReason !== undefined) {
        result.skipped.push({ path: absolute, reason: skipReason })
        continue
      }
      if (this.deps.cursors.uploadedFileId(absolute) !== undefined) {
        result.skipped.push({ path: absolute, reason: '已上传过' })
        continue
      }

      const size = await this.sizeOf(absolute)
      if (size === undefined) {
        result.skipped.push({ path: absolute, reason: '不是可读的普通文件' })
        continue
      }
      if (size === 0) {
        // Object storage rejects empty objects; posting one only yields 400.
        this.log('warn', 'artifact-uplink-empty', { issueId, path: absolute })
        result.skipped.push({ path: absolute, reason: '空文件' })
        continue
      }
      if (size > MAX_UPLOAD_BYTES) {
        this.log('warn', 'artifact-uplink-too-big', {
          issueId,
          path: absolute,
          megabytes: Math.round(size / 1024 / 1024),
        })
        result.skipped.push({
          path: absolute,
          reason: `超过 ${String(Math.round(MAX_UPLOAD_BYTES / 1024 / 1024))}MB`,
        })
        continue
      }

      const fileName = basename(absolute)
      try {
        const fileId = await this.deps.upload(absolute, fileName)
        if (typeof fileId !== 'string' || fileId === '') {
          throw new Error('上传端没有返回 fileId')
        }
        await this.deps.attach(issueId, {
          fileId,
          fileName,
          role: 'assignee',
          ...(description.length > 0 ? { description } : {}),
        })
        // Record the idempotency table only after attaching: if the upload succeeds but attaching fails, the next run retries,
        // which is safer than recording it as uploaded while the issue has nothing.
        await this.deps.cursors.setUploadedFile(absolute, fileId)
        result.uploaded.push({ path: absolute, fileId })
      } catch (error) {
        result.failed.push({ path: absolute, reason: errorText(error) })
        this.log('warn', 'artifact-uplink-failed', {
          issueId,
          path: absolute,
          error: errorText(error),
        })
      }
    }

    if (result.uploaded.length > 0) {
      this.log('info', 'artifact-uplinked', {
        issueId,
        uploaded: result.uploaded.length,
        skipped: result.skipped.length,
        failed: result.failed.length,
      })
    }
    return result
  }

  upload(
    issueId: string,
    artifacts: readonly string[],
    options: UplinkOptions = {},
  ): Promise<UplinkResult> {
    return this.uplink(issueId, artifacts, options)
  }

  private resolvePath(raw: string, cwd: string | undefined): string | undefined {
    const trimmed = raw.trim()
    if (trimmed.length === 0) return undefined
    if (isAbsolute(trimmed)) return resolve(trimmed)
    if (cwd === undefined || cwd === '') {
      this.log('warn', 'artifact-uplink-no-cwd', { path: trimmed })
      return undefined
    }
    return resolve(cwd, trimmed)
  }

  private async sizeOf(absolute: string): Promise<number | undefined> {
    try {
      const info = await stat(absolute)
      return info.isFile() ? info.size : undefined
    } catch (error) {
      this.log('warn', 'artifact-uplink-missing', {
        path: absolute,
        error: errorText(error),
      })
      return undefined
    }
  }

  private writable(): boolean {
    if (this.deps.isWritable === undefined) return true
    try {
      return this.deps.isWritable() !== false
    } catch {
      return false
    }
  }

  private log(level: 'info' | 'warn', event: string, detail?: unknown): void {
    this.deps.log?.(level, event, detail)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
