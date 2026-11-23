/**
 * Attachments: keep every issue's files under one root and maintain a typed manifest.
 *
 * ## Disk layout
 *
 * ```text
 * <dir>/attachments/<issueId>/input/<name>                    <- issue target, role assigner (executor material)
 * <dir>/attachments/<issueId>/output/<name>                   <- issue target, role assignee (deliverables)
 * <dir>/attachments/<issueId>/comments/<commentId>/<name>     <- comment target
 * <dir>/task-attachments.json                                 <- manifest: issueId -> { dir, updatedAt, files[] }
 * ```
 *
 * An attachment's identity is `targetType + targetId + role`. `input` / `output` / `comment`
 * are **derived** kinds ({@link attachmentKind}), never stored: the cloud/SDK only knows the
 * target model, and the local manifest follows it so no row needs a translation table.
 *
 * The manifest records only "the last successful persist result"; it neither caches directory contents nor predicts whether
 * a file exists. If a file is deleted externally, the session reading it reports the error; no `stat` is needed per read.
 *
 * ## Write rules
 *
 * - Only the process holding the storage lease may write (`canWrite`); otherwise `add` / `remove` throw.
 * - The manifest is written atomically (temp file -> fsync -> rename), so a half-written JSON file cannot remain.
 * - Each attachment is also written to a temp file and renamed, so an interrupted download leaves no partial file.
 * - A failed download never enters the manifest and never occupies a file name; a successful entry with the same target+name stays untouched.
 * - File names go through a whitelist and the final path is checked to remain inside the issue directory (path safety boundary).
 *
 * @module dsh-magica-castboard/host/pipeline/attachments
 */
import { mkdir, open, readFile, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { persistJsonAsync, renameWithRetry } from '../ledger/atomic.ts'
import { isValidId } from '../ledger/paths.ts'

export const ATTACHMENTS_DIR = 'attachments'

export const TASK_ATTACHMENTS_FILE = 'task-attachments.json'

/** Maximum number of attachments kept per issue. */
export const MAX_ATTACHMENTS_PER_ISSUE = 20

/** Maximum size of one attachment (bytes): 50MB. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

/** Maximum total size of all attachments for one issue (bytes): 200MB. */
export const MAX_ATTACHMENTS_TOTAL_BYTES = 200 * 1024 * 1024

const MAX_FILE_NAME = 160

/**
 * What an attachment hangs off.
 *
 * `issue` rows belong to the issue itself; `comment` rows belong to one comment of that issue.
 * `targetId` is the issue id for `issue` and the comment id for `comment`.
 */
export type AttachmentTargetType = 'issue' | 'comment'

export const ATTACHMENT_TARGET_TYPES: readonly AttachmentTargetType[] = ['issue', 'comment']

/** Which side of the hand-off produced the attachment (`assigner` = input, `assignee` = output). */
export type AttachmentRole = 'assigner' | 'assignee'

export const ATTACHMENT_ROLES: readonly AttachmentRole[] = ['assigner', 'assignee']

/** Local view of an attachment. Derived from the target model, never stored on the cloud. */
export type AttachmentKind = 'input' | 'output' | 'comment'

export const ATTACHMENT_KINDS: readonly AttachmentKind[] = ['input', 'output', 'comment']

/**
 * Derive the panel's `input` / `output` / `comment` view from the stored target model.
 *
 * This is the single place that maps the cloud's `(targetType, targetId, role)` identity to
 * the local vocabulary; no manifest row or DB column carries `input` / `output` / `comment`.
 *
 * @param attachment - Any object carrying the target identity.
 * @returns `comment` for comment targets, otherwise `input` for the assigner and `output` for the assignee.
 */
export function attachmentKind(
  attachment: { readonly targetType: AttachmentTargetType; readonly role: AttachmentRole },
): AttachmentKind {
  return attachment.targetType === 'comment' ? 'comment' : attachment.role === 'assigner' ? 'input' : 'output'
}

export interface StoredAttachment {
  /** Display name (also the on-disk file name). */
  readonly name: string
  /** Absolute on-disk path (the model reads content from it). */
  readonly path: string
  /** Target model: what the attachment hangs off. */
  readonly targetType: AttachmentTargetType
  /** Issue id (`targetType: 'issue'`) or comment id (`targetType: 'comment'`). */
  readonly targetId: string
  /** Which side produced the attachment. */
  readonly role: AttachmentRole
  /** Cloud attachment id; absent on legacy rows. */
  readonly fileId?: string
  /** `pending` = cloud row known, path reserved, file not downloaded yet. */
  readonly state?: 'pending' | 'ready'
  readonly description?: string
  readonly size?: number
}

export interface IssueAttachmentEntry {
  readonly issueId: string
  readonly dir: string
  readonly updatedAt: number
  /** File list (empty array = this issue has no attachments). */
  readonly files: readonly StoredAttachment[]
}

export interface TaskAttachmentLedger {
  attachments: readonly IssueAttachmentEntry[]
}

export interface AttachmentInput {
  /** Desired display name; when empty, derive it from the source path. */
  readonly name: string
  /** Target model; omitted = this issue / assigner (worklab input). */
  readonly targetType?: AttachmentTargetType
  /** Issue id (issue target) or comment id (comment target); omitted = the issue id. */
  readonly targetId?: string
  /** Role; omitted = assigner. */
  readonly role?: AttachmentRole
  /** Cloud attachment id (metadata only; downloads go through AttachmentSync). */
  readonly fileId?: string
  readonly description?: string
  /** Size claimed by the cloud (only for early limit checks). */
  readonly size?: number
  /** Local source file to copy into the issue directory. */
  readonly path?: string
}

export interface AttachmentAddResult {
  readonly issueId: string
  readonly dir: string
  /** Complete file list for this issue after processing. */
  readonly files: readonly StoredAttachment[]
  readonly added: StoredAttachment[]
  /** Files left untouched because of duplicates / limits / empty content. */
  readonly skipped: Array<{ readonly name: string; reason: string }>
  /** Files that failed to download or persist (they never enter the manifest). */
  readonly failed: Array<{ readonly name: string; reason: string }>
}

export interface TaskAttachmentIndexDeps {
  /** Storage root (`$DSH_HOME/storages/castboard`). */
  readonly dir: string
  readonly now?: () => number
  /** Whether this process may write (defaults to true). */
  readonly canWrite?: () => boolean
  readonly maxFiles?: number
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
  readonly log?: (level: 'info' | 'warn', event: string, detail?: unknown) => void
}

/**
 * File name normalization: keep only a safe base name.
 *
 * Issue ids and file names are both joined into paths, so this does three things at once: strip the directory part, replace
 * filesystem-reserved characters, and replace `.` / `..` with a fixed placeholder name.
 *
 */
export function safeFileName(raw: string): string {
  const flattened = raw.replace(/\\/g, '/')
  const base = basename(flattened)
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .trim()
  const name = base === '' || base === '.' || base === '..' ? 'attachment' : base
  return name.length > MAX_FILE_NAME ? name.slice(0, MAX_FILE_NAME) : name
}

function isTargetType(value: unknown): value is AttachmentTargetType {
  return value === 'issue' || value === 'comment'
}

function isRole(value: unknown): value is AttachmentRole {
  return value === 'assigner' || value === 'assignee'
}

function emptyAddResult(issueId: string, dir: string, files: readonly StoredAttachment[]): AttachmentAddResult {
  return { issueId, dir, files, added: [], skipped: [], failed: [] }
}

async function writeAtomicFile(file: string, data: Uint8Array): Promise<void> {
  const temp = `${file}.${Math.random().toString(36).slice(2)}.tmp`
  const handle = await open(temp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await renameWithRetry(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => { /* the temporary file may already be gone */ })
    throw error
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function targetKey(targetType: AttachmentTargetType, targetId: string): string {
  return `${targetType}\u0000${targetId}`
}

export class TaskAttachmentIndex {
  private readonly dir: string
  private readonly file: string
  private readonly attachmentsRoot: string
  private readonly clock: () => number
  private readonly canWrite: () => boolean
  private readonly logFn?: TaskAttachmentIndexDeps['log']
  private readonly maxFiles: number
  private readonly maxFileBytes: number
  private readonly maxTotalBytes: number
  private entries: IssueAttachmentEntry[] = []
  private loaded = false
  private loading: Promise<void> | undefined

  constructor(deps: TaskAttachmentIndexDeps) {
    this.dir = deps.dir
    this.file = join(deps.dir, TASK_ATTACHMENTS_FILE)
    this.attachmentsRoot = join(deps.dir, ATTACHMENTS_DIR)
    this.clock = deps.now ?? (() => Date.now())
    this.canWrite = deps.canWrite ?? (() => true)
    this.logFn = deps.log
    this.maxFiles = positiveInteger(deps.maxFiles, MAX_ATTACHMENTS_PER_ISSUE)
    this.maxFileBytes = positiveInteger(deps.maxFileBytes, MAX_ATTACHMENT_BYTES)
    this.maxTotalBytes = positiveInteger(deps.maxTotalBytes, MAX_ATTACHMENTS_TOTAL_BYTES)
  }

  get path(): string {
    return this.file
  }

  /** Load the manifest once (idempotent; missing file / empty content / bad JSON all become an empty manifest). */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loading ??= this.doLoad().finally(() => { this.loading = undefined })
    await this.loading
  }

  /**
   * Attachment list for one issue (reads memory synchronously; `await load()` or use `read` first to hit disk).
   *
   * @param issueId - Issue whose attachments are listed.
   * @param kind - Derived kind filter (`input` / `output` / `comment`); omitted = every target.
   */
  list(issueId: string, kind?: AttachmentKind): readonly StoredAttachment[] {
    const files = this.entryOf(issueId)?.files ?? []
    return kind === undefined ? files : files.filter(file => attachmentKind(file) === kind)
  }

  /**
   * Replace the rows of every target key present in `files`, preserving all other targets.
   *
   * This is the worklab/input path: batches are keyed by `targetType + targetId`, so a refresh
   * of the issue's input files never drops comment rows or output files. An empty batch means
   * "the default target (this issue, assigner) now has no files" — the historical worklab
   * behaviour that lets an empty re-sync clear the input list.
   *
   * @param issueId - Issue the files belong to.
   * @param _dir - Kept for call-site compatibility (the directory is derived from the issue).
   * @param files - Rows of one or more targets; each target present is replaced as a whole.
   */
  async put(
    issueId: string,
    _dir: string,
    files: readonly StoredAttachment[],
  ): Promise<void> {
    this.assertIssueId(issueId)
    if (!this.writable()) throw new Error('attachment index is read-only in this host (another dsh web owns the storage lease)')
    await this.load()

    const groups = new Map<string, { targetType: AttachmentTargetType; targetId: string; rows: StoredAttachment[] }>()
    for (const file of files) {
      const targetType: AttachmentTargetType = isTargetType(file.targetType) ? file.targetType : 'issue'
      const targetId = this.resolveTargetId(issueId, targetType, file.targetId)
      if (targetId === undefined) continue
      const key = targetKey(targetType, targetId)
      const group = groups.get(key) ?? { targetType, targetId, rows: [] }
      const row = this.normalizeRow(issueId, file, targetType, targetId)
      if (row !== undefined) group.rows.push(row)
      groups.set(key, group)
    }
    if (groups.size === 0) {
      // Default behaviour for the worklab record path: an empty batch clears this issue's input rows.
      groups.set(targetKey('issue', issueId), { targetType: 'issue', targetId: issueId, rows: [] })
    }

    for (const group of groups.values()) {
      this.replaceRows(issueId, group.targetType, group.targetId, group.rows)
    }
    // raw/host/2: a failed manifest write is logged and the in-memory entry still stands;
    // downloaded files remain usable, and the next successful put rewrites the manifest.
    try {
      await this.persist()
    } catch {
      /* persist already logged the failure */
    }
  }

  /**
   * Replace one target's rows with the result of the latest successful download.
   *
   * Unlike {@link put}, the target is explicit even for an empty batch, so a sync of a target
   * that no longer has cloud rows can clear exactly that target and nothing else.
   *
   * @param issueId - Issue that owns the target.
   * @param targetType - `issue` or `comment`.
   * @param targetId - Issue id or comment id.
   * @param files - Complete row list of that target.
   */
  async putTarget(
    issueId: string,
    targetType: AttachmentTargetType,
    targetId: string,
    files: readonly StoredAttachment[],
  ): Promise<void> {
    this.assertIssueId(issueId)
    if (!this.writable()) throw new Error('attachment index is read-only in this host (another dsh web owns the storage lease)')
    await this.load()
    const resolved = this.resolveTargetId(issueId, targetType, targetId)
    if (resolved === undefined) throw new Error(`invalid attachment target: ${targetType}/${targetId}`)
    const rows: StoredAttachment[] = []
    for (const file of files) {
      const row = this.normalizeRow(issueId, file, targetType, resolved)
      if (row !== undefined) rows.push(row)
    }
    this.replaceRows(issueId, targetType, resolved, rows)
    try {
      await this.persist()
    } catch {
      /* persist already logged the failure */
    }
  }

  /**
   * Write bytes to a target's attachment path (used by {@link AttachmentSync}).
   *
   * The manifest is not touched here; the caller updates it after the batch.
   */
  async writeContent(
    issueId: string,
    targetType: AttachmentTargetType,
    targetId: string,
    role: AttachmentRole,
    name: string,
    data: Uint8Array,
  ): Promise<{ path: string; size: number }> {
    this.assertIssueId(issueId)
    if (!this.writable()) throw new Error('attachment index is read-only in this host (another dsh web owns the storage lease)')
    const target = this.filePathOf(issueId, targetType, targetId, role, name)
    await mkdir(dirname(target), { recursive: true })
    await writeAtomicFile(target, data)
    return { path: target, size: data.byteLength }
  }

  async read(issueId: string): Promise<IssueAttachmentEntry | undefined> {
    await this.load()
    const entry = this.entryOf(issueId)
    if (entry === undefined) return undefined
    return { ...entry, files: entry.files.map(file => ({ ...file })) }
  }

  /** Execution input: only downloaded issue-target assigner rows (kind = input). */
  async listForTask(task: { id: string; issueId?: string }): Promise<readonly StoredAttachment[]> {
    if (task.issueId === undefined || task.issueId === '') return []
    return this.list(task.issueId)
      .filter(file => file.targetType === 'issue' && file.role === 'assigner' && file.state !== 'pending')
  }

  /**
   * Directory for one issue (absolute).
   *
   */
  dirOf(issueId: string): string {
    this.assertIssueId(issueId)
    return join(this.attachmentsRoot, issueId)
  }

  /**
   * Absolute directory for one attachment target.
   *
   * - issue + assigner -> `<issue>/input`
   * - issue + assignee -> `<issue>/output`
   * - comment -> `<issue>/comments/<commentId>`
   */
  targetDirOf(
    issueId: string,
    targetType: AttachmentTargetType,
    targetId: string,
    role: AttachmentRole,
  ): string {
    const resolved = this.resolveTargetId(issueId, targetType, targetId)
    if (resolved === undefined) throw new Error(`invalid attachment target: ${targetType}/${targetId}`)
    if (targetType === 'issue') {
      return join(this.dirOf(issueId), role === 'assigner' ? 'input' : 'output')
    }
    return join(this.dirOf(issueId), 'comments', resolved)
  }

  /**
   * Absolute path of one attachment file, checked to stay inside the **issue** root.
   *
   * The boundary is the issue root (not the target directory) so legacy rows written before
   * the target model (e.g. a bare `<issue>/foo.txt`) remain readable/parsable.
   */
  filePathOf(
    issueId: string,
    targetType: AttachmentTargetType,
    targetId: string,
    role: AttachmentRole,
    name: string,
  ): string {
    const dir = this.targetDirOf(issueId, targetType, targetId, role)
    const target = resolve(dir, safeFileName(name))
    const root = resolve(this.dirOf(issueId))
    const rel = relative(root, target)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`attachment name escapes issue dir: ${name}`)
    }
    return target
  }

  /**
   * Persist a batch of attachments and register them in the manifest.
   *
   * Each file is independent: a failed download or write only goes into `failed` and does not affect the rest of the batch;
   * failed files never enter the manifest, and the manifest is rewritten only when at least one succeeded.
   *
   */
  async add(issueId: string, files: readonly AttachmentInput[]): Promise<AttachmentAddResult> {
    this.assertIssueId(issueId)
    if (!this.writable()) {
      throw new Error('attachment index is read-only in this host (another dsh web owns the storage lease)')
    }
    await this.load()

    const dir = this.dirOf(issueId)
    const existing = this.entryOf(issueId)
    const current = existing === undefined ? [] : existing.files.map(file => ({ ...file }))
    const byName = new Map(current.map(file => [`${targetKey(file.targetType, file.targetId)}\u0000${file.role}\u0000${file.name}`, file]))
    const result: AttachmentAddResult = {
      ...emptyAddResult(issueId, dir, current),
      skipped: [],
      failed: [],
      added: [],
    }
    if (files.length === 0) return { ...result, files: current }

    let totalBytes = current.reduce((sum, file) => sum + (file.size ?? 0), 0)

    for (const input of files) {
      const targetType: AttachmentTargetType = isTargetType(input.targetType) ? input.targetType : 'issue'
      const role: AttachmentRole = isRole(input.role) ? input.role : 'assigner'
      const targetId = this.resolveTargetId(issueId, targetType, input.targetId)
      if (targetId === undefined) {
        result.skipped.push({ name: input.name, reason: '附件目标非法（targetType/targetId）' })
        continue
      }
      const hint = typeof input.name === 'string' && input.name.trim() !== ''
        ? input.name
        : (typeof input.path === 'string' ? input.path : 'attachment')
      const name = safeFileName(hint)
      const key = `${targetKey(targetType, targetId)}\u0000${role}\u0000${name}`
      if (byName.has(key)) {
        result.skipped.push({ name, reason: '同名附件已在清单里' })
        continue
      }
      if (current.length >= this.maxFiles) {
        result.skipped.push({ name, reason: `单条 issue 最多 ${String(this.maxFiles)} 个附件` })
        continue
      }
      if (typeof input.size === 'number' && input.size > this.maxFileBytes) {
        result.skipped.push({
          name,
          reason: `超过单文件上限 ${String(Math.round(this.maxFileBytes / 1024 / 1024))}MB`,
        })
        continue
      }

      const typeDir = this.targetDirOf(issueId, targetType, targetId, role)
      await mkdir(typeDir, { recursive: true })
      const target = this.filePathOf(issueId, targetType, targetId, role, name)
      let size: number
      try {
        size = await this.materialize(target, input)
      } catch (error) {
        // Download / read / write failed: do not register this file, so it can be retried next time.
        result.failed.push({ name, reason: errorText(error) })
        this.log('warn', 'attachment-store-failed', { issueId, name, error: errorText(error) })
        continue
      }

      if (size > this.maxFileBytes) {
        await unlink(target).catch(() => { /* fine if it was never written */ })
        result.skipped.push({
          name,
          reason: `超过单文件上限 ${String(Math.round(this.maxFileBytes / 1024 / 1024))}MB`,
        })
        continue
      }
      if (totalBytes + size > this.maxTotalBytes) {
        await unlink(target).catch(() => { /* fine if it was never written */ })
        result.skipped.push({ name, reason: '超过单条 issue 的总大小上限' })
        continue
      }

      const stored: StoredAttachment = {
        name,
        path: target,
        targetType,
        targetId,
        role,
        ...(input.fileId === undefined || input.fileId === '' ? {} : { fileId: input.fileId }),
        state: 'ready',
        ...(input.description === undefined || input.description === '' ? {} : { description: input.description }),
        size,
      }
      current.push(stored)
      byName.set(key, stored)
      result.added.push(stored)
      totalBytes += size
    }

    if (result.added.length > 0) {
      const entry: IssueAttachmentEntry = {
        issueId,
        dir,
        updatedAt: this.clock(),
        files: current,
      }
      const previous = this.entries
      this.entries = this.entries.some(item => item.issueId === issueId)
        ? this.entries.map(item => (item.issueId === issueId ? entry : item))
        : [...this.entries, entry]
      try {
        await this.persist()
      } catch (error) {
        // If the manifest write failed, do not let memory run ahead of disk: the next add re-registers.
        this.entries = previous
        throw error
      }
    }

    return { ...result, files: current }
  }

  /**
   * Remove one issue's attachment directory and manifest entry.
   *
   */
  async remove(issueId: string): Promise<boolean> {
    this.assertIssueId(issueId)
    if (!this.writable()) {
      throw new Error('attachment index is read-only in this host (another dsh web owns the storage lease)')
    }
    await this.load()

    const existed = this.entries.some(entry => entry.issueId === issueId)
    if (existed) {
      const previous = this.entries
      this.entries = this.entries.filter(entry => entry.issueId !== issueId)
      try {
        await this.persist()
      } catch (error) {
        this.entries = previous
        throw error
      }
    }

    try {
      await rm(this.dirOf(issueId), { recursive: true, force: true })
    } catch (error) {
      // The manifest entry is already gone; leftover directory contents are only orphans and do not affect manifest correctness.
      this.log('warn', 'attachment-remove-failed', { issueId, error: errorText(error) })
    }
    return existed
  }

  private async doLoad(): Promise<void> {
    try {
      const text = await readFile(this.file, 'utf8')
      this.entries = this.parse(text)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log('warn', 'attachment-ledger-unreadable', {
          file: this.file,
          error: errorText(error),
        })
      }
      this.entries = []
    } finally {
      this.loaded = true
    }
  }

  /**
   * Lenient parse: a bad entry is dropped without invalidating the whole file; entries with out-of-bounds paths are dropped too.
   *
   */
  private parse(text: string): IssueAttachmentEntry[] {
    if (text.trim() === '') return []
    let raw: unknown
    try {
      raw = JSON.parse(text) as unknown
    } catch (error) {
      this.log('warn', 'attachment-ledger-corrupt', { file: this.file, error: errorText(error) })
      return []
    }
    if (raw === null || typeof raw !== 'object') return []
    const list = (raw as { attachments?: unknown }).attachments
    if (!Array.isArray(list)) return []

    const entries = new Map<string, IssueAttachmentEntry>()
    for (const item of list) {
      const entry = this.parseEntry(item)
      if (entry !== undefined) entries.set(entry.issueId, entry)
    }
    return [...entries.values()]
  }

  private parseEntry(value: unknown): IssueAttachmentEntry | undefined {
    if (value === null || typeof value !== 'object') return undefined
    const raw = value as Record<string, unknown>
    if (typeof raw.issueId !== 'string' || !isValidId(raw.issueId)) return undefined
    const issueId = raw.issueId
    const dir = this.dirOf(issueId)
    if (typeof raw.dir === 'string' && raw.dir !== '' && resolve(raw.dir) !== resolve(dir)) {
      // The manifest's directory must equal the one derived from issueId; otherwise drop the entry (do not trust external paths).
      this.log('warn', 'attachment-ledger-dir-mismatch', { issueId })
      return undefined
    }

    const files: StoredAttachment[] = []
    if (Array.isArray(raw.files)) {
      for (const item of raw.files) {
        const file = this.parseFile(item, issueId)
        if (file !== undefined) files.push(file)
      }
    }
    return {
      issueId,
      dir,
      updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
      files,
    }
  }

  /**
   * Parse one stored row.
   *
   * New rows carry `targetType` / `targetId` / `role`; a legacy row without them is read as
   * `issue` / this issue / `assigner`. Path safety is checked against the issue root, because
   * legacy rows may live directly under `<issue>/` instead of a target directory.
   */
  private parseFile(value: unknown, issueId: string): StoredAttachment | undefined {
    if (value === null || typeof value !== 'object') return undefined
    const raw = value as Record<string, unknown>
    if (typeof raw.path !== 'string' || raw.path === '') return undefined
    const root = resolve(this.dirOf(issueId))
    const absolute = resolve(raw.path)
    const rel = relative(root, absolute)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      this.log('warn', 'attachment-ledger-path-outside', { path: raw.path })
      return undefined
    }
    const name = safeFileName(typeof raw.name === 'string' && raw.name !== '' ? raw.name : basename(absolute))
    const targetType: AttachmentTargetType = isTargetType(raw.targetType) ? raw.targetType : 'issue'
    const role: AttachmentRole = isRole(raw.role) ? raw.role : 'assigner'
    const targetId = this.resolveTargetId(
      issueId,
      targetType,
      typeof raw.targetId === 'string' ? raw.targetId : undefined,
    )
    if (targetId === undefined) {
      this.log('warn', 'attachment-ledger-target-invalid', { issueId, targetType, targetId: raw.targetId })
      return undefined
    }
    return {
      name,
      path: absolute,
      targetType,
      targetId,
      role,
      ...(typeof raw.fileId === 'string' && raw.fileId !== '' ? { fileId: raw.fileId } : {}),
      state: raw.state === 'pending' ? 'pending' : 'ready',
      ...(typeof raw.description === 'string' && raw.description !== ''
        ? { description: raw.description }
        : {}),
      ...(typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size >= 0
        ? { size: raw.size }
        : {}),
    }
  }

  /**
   * Turn one input into a real file at the target path, returning its byte size.
   *
   * - Input with `path`: validate the size, then copy to the target (register in place when it is already there).
   * Downloads themselves belong to AttachmentSync; this only stores a local source.
   */
  private async materialize(
    target: string,
    input: AttachmentInput,
  ): Promise<number> {
    if (input.path !== undefined && input.path !== '') {
      const source = resolve(input.path)
      const info = await stat(source)
      if (!info.isFile()) throw new Error('源路径不是普通文件')
      if (info.size > this.maxFileBytes) throw new Error('文件超过单文件大小上限')
      if (source === target) return info.size
      const data = await readFile(source)
      await writeAtomicFile(target, data)
      return data.byteLength
    }
    throw new Error('缺少本地源文件路径（下载统一由 AttachmentSync 负责）')
  }

  /** Normalize one row into its canonical on-disk path for the given target. */
  private normalizeRow(
    issueId: string,
    file: StoredAttachment,
    targetType: AttachmentTargetType,
    targetId: string,
  ): StoredAttachment | undefined {
    const role: AttachmentRole = isRole(file.role) ? file.role : 'assigner'
    const name = safeFileName(typeof file.name === 'string' && file.name !== '' ? file.name : 'attachment')
    let target: string
    try {
      target = this.filePathOf(issueId, targetType, targetId, role, name)
    } catch (error) {
      this.log('warn', 'attachment-path-invalid', { issueId, name, error: errorText(error) })
      return undefined
    }
    return {
      name,
      path: target,
      targetType,
      targetId,
      role,
      ...(file.fileId === undefined || file.fileId === '' ? {} : { fileId: file.fileId }),
      state: file.state === 'pending' ? 'pending' : 'ready',
      ...(file.description === undefined || file.description === '' ? {} : { description: file.description }),
      ...(file.size === undefined ? {} : { size: file.size }),
    }
  }

  /**
   * Resolve/validate a target id.
   *
   * - `issue` target: must equal the issue id (defaults to it).
   * - `comment` target: a non-empty id safe to join into a directory.
   */
  private resolveTargetId(
    issueId: string,
    targetType: AttachmentTargetType,
    targetId: unknown,
  ): string | undefined {
    if (targetType === 'issue') return issueId
    if (typeof targetId !== 'string' || !isValidId(targetId)) return undefined
    return targetId
  }

  /** Replace one target's in-memory rows (no persist). */
  private replaceRows(
    issueId: string,
    targetType: AttachmentTargetType,
    targetId: string,
    rows: readonly StoredAttachment[],
  ): void {
    const entry = this.entryOf(issueId)
    const key = targetKey(targetType, targetId)
    const kept = entry?.files.filter(file => targetKey(file.targetType, file.targetId) !== key) ?? []
    const next: IssueAttachmentEntry = {
      issueId,
      dir: this.dirOf(issueId),
      updatedAt: this.clock(),
      files: [...kept, ...rows],
    }
    const index = this.entries.findIndex(item => item.issueId === issueId)
    if (index === -1) this.entries.push(next)
    else this.entries[index] = next
  }

  private async persist(): Promise<void> {
    try {
      await persistJsonAsync(this.file, { attachments: this.entries } satisfies TaskAttachmentLedger)
    } catch (error) {
      this.log('warn', 'attachment-ledger-write-failed', {
        file: this.file,
        error: errorText(error),
      })
      throw error
    }
  }

  private entryOf(issueId: string): IssueAttachmentEntry | undefined {
    return this.entries.find(entry => entry.issueId === issueId)
  }

  /** Issue ids are joined into directory names, so validate against the whitelist first. */
  private assertIssueId(issueId: string): void {
    if (!isValidId(issueId)) throw new Error(`invalid issue id for attachments: ${issueId}`)
  }

  private writable(): boolean {
    try {
      return this.canWrite()
    } catch {
      return false
    }
  }

  private log(level: 'info' | 'warn', event: string, detail?: unknown): void {
    this.logFn?.(level, event, detail)
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}
