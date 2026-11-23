/**
 * Hand-written guidance per workspace, stored at
 * `$DSH_HOME/storages/castboard/worklabs/workspaces-custom.json`.
 *
 * The generated project index and portrait come from the registry and the code. Ownership,
 * aliases, and which work should not be routed here cannot be inferred, so the user writes
 * them down; this file is the archive.
 *
 * Keys are workspace ids because titles and paths change.
 *
 * ```json
 * { "schemaVersion": 1, "workspaces": { "<workspaceId>": "what this project owns and which work belongs here…" } }
 * ```
 *
 * A missing file means an empty ledger. A file that exists but is not valid JSON is an
 * error, never an empty ledger — silently clearing it would let the next save overwrite the
 * user's writing. A single malformed entry is simply dropped.
 *
 * @module dsh-magica-castboard/host/ledger/workspaces-custom
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const WORKSPACES_CUSTOM_SCHEMA_VERSION = 1

export const MAX_WORKSPACE_NOTES = 200

export const MAX_WORKSPACE_NOTE_CHARS = 2000

export interface WorkspacesCustom {
  schemaVersion: number
  workspaces: Record<string, string>
}

export function emptyWorkspacesCustom(): WorkspacesCustom {
  return { schemaVersion: WORKSPACES_CUSTOM_SCHEMA_VERSION, workspaces: {} }
}

/**
 * Strip control characters, trim, and cap the length.
 *
 * Newlines and tabs are kept: a short responsibility followed by examples reads better as
 * several lines, and this text is for the model, not a file name.
 */
function clipNote(raw: string): string {
  const flattened = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  const trimmed = flattened.trim()
  return trimmed.length > MAX_WORKSPACE_NOTE_CHARS ? trimmed.slice(0, MAX_WORKSPACE_NOTE_CHARS) : trimmed
}

// An empty id or an empty note is not guidance; both are rejected.
function acceptNote(rawId: string, rawText: unknown): { id: string; note: string } | undefined {
  if (typeof rawText !== 'string') return undefined
  const id = rawId.trim()
  const note = clipNote(rawText)
  if (id === '' || note === '') return undefined
  return { id, note }
}

/**
 * Request body → note map, strictly.
 *
 * Settings-page saves replace the whole file: a workspaceId absent from the body is removed.
 */
export function normalizeNotes(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('workspaces 必须是「workspaceId → 说明」的对象')
  }
  const out: Record<string, string> = {}
  for (const [rawId, rawText] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof rawText !== 'string') {
      throw new Error(`workspaces["${rawId}"] 必须是字符串`)
    }
    const note = acceptNote(rawId, rawText)
    if (note === undefined) continue
    if (Object.keys(out).length >= MAX_WORKSPACE_NOTES) {
      throw new Error(`workspaces 最多 ${String(MAX_WORKSPACE_NOTES)} 条`)
    }
    out[note.id] = note.note
  }
  return out
}

// File contents are trusted less than a request: drop bad entries and stop at the cap.
function lenientNotes(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [rawId, rawText] of Object.entries(raw as Record<string, unknown>)) {
    const note = acceptNote(rawId, rawText)
    if (note === undefined) continue
    if (Object.keys(out).length >= MAX_WORKSPACE_NOTES) break
    out[note.id] = note.note
  }
  return out
}

/**
 * The `{ items: [ { workspaceId, name?, path?, description? } ] }` shape is also accepted.
 *
 * Only text from `description` / `name` / `path` can become a note; entries without text
 * are skipped rather than filled with invented words.
 */
function compatNotes(raw: unknown): Record<string, string> {
  if (!Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const rawId = typeof record.workspaceId === 'string'
      ? record.workspaceId
      : typeof record.id === 'string' ? record.id : ''
    const candidate = [record.description, record.name, record.path]
      .find((value): value is string => typeof value === 'string' && value.trim() !== '')
    const note = acceptNote(rawId, candidate)
    if (note === undefined) continue
    if (Object.keys(out).length >= MAX_WORKSPACE_NOTES) break
    out[note.id] = note.note
  }
  return out
}

/**
 * Parse the file text.
 *
 * An empty or all-whitespace file is an empty ledger (clearing it is a normal action). An
 * unknown `schemaVersion` is accepted anyway: there is only one version, and wiping a
 * future file is the worse mistake.
 */
export function parseWorkspacesCustom(text: string): WorkspacesCustom {
  if (text.trim() === '') return emptyWorkspacesCustom()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`workspaces-custom.json 不是合法 JSON：${errorText(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('workspaces-custom.json 顶层必须是一个对象（{ "workspaces": { … } }）')
  }
  const holder = parsed as Record<string, unknown>
  const workspaces = holder.workspaces !== undefined
    ? lenientNotes(holder.workspaces)
    : compatNotes(holder.items)
  return { schemaVersion: WORKSPACES_CUSTOM_SCHEMA_VERSION, workspaces }
}

// Indented and newline-terminated because people read and edit this file too.
export function workspacesCustomText(value: WorkspacesCustom): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * Read the ledger.
 *
 * Anything other than ENOENT is rethrown so the route layer can treat it as an internal
 * failure rather than bad user input.
 */
export async function readWorkspacesCustom(file: string): Promise<WorkspacesCustom> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyWorkspacesCustom()
    throw error
  }
  return parseWorkspacesCustom(text)
}

/**
 * Write atomically: same-directory temp file, then rename. A crash mid-write leaves no
 * half file.
 *
 * The complete ledger is returned so the route can answer without reading it again.
 */
export async function writeWorkspacesCustom(file: string, notes: Record<string, string>): Promise<WorkspacesCustom> {
  const value: WorkspacesCustom = { schemaVersion: WORKSPACES_CUSTOM_SCHEMA_VERSION, workspaces: notes }
  const tmp = `${file}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(tmp, workspacesCustomText(value), 'utf8')
  await rename(tmp, file)
  return value
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
