/**
 * On-disk primitives: atomic writes plus the JSON text conventions every ledger shares.
 *
 * A write is always same-directory temp file → fsync → rename. A crash can leave a stray
 * `.tmp` behind, but never a half-written JSON document. Ledgers are written with
 * two-space indentation on purpose: these files are meant to be inspected by hand and
 * diffed, and single-line JSON makes both painful. UTF-8 is passed explicitly rather than
 * relying on the platform default.
 *
 * @module dsh-magica-castboard/host/ledger/atomic
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * On Windows a fresh temp file is briefly held open by Defender / Search Indexer, and
 * `MoveFileEx` then fails with `EPERM` (same when any handle has the target open). Those
 * failures are transient; without a retry a write is simply lost at random.
 */
const RENAME_RETRIES = 6

const RENAME_BACKOFF_MS = 10

// "Source or target is briefly held open" — the only failures worth retrying.
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST'])

function isTransient(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code !== undefined && TRANSIENT_RENAME_CODES.has(code)
}

async function pause(ms: number): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, ms) })
}

// Blocks the thread; only the sync write path uses it.
function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Hidden file, so a `*.json` scan cannot mistake it for a detail file.
function temporaryPath(file: string): string {
  return join(dirname(file), `.${Math.random().toString(36).slice(2)}.tmp`)
}

/**
 * `rename` with exponential backoff for transient Windows sharing violations. Real
 * problems (ENOENT, cross-device, …) are thrown immediately instead of being masked.
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (!isTransient(error) || attempt >= RENAME_RETRIES) throw error
      await pause(RENAME_BACKOFF_MS * 2 ** attempt)
    }
  }
}

/**
 * Atomically write one UTF-8 text file. Synchronous on purpose: the callers (lease
 * heartbeat, batch configuration writes) already write on a synchronous cadence, and going
 * async would add another "did the write finish" state to manage.
 */
export function persistAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = temporaryPath(file)
  const fd = openSync(temp, 'w')
  try {
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  let wait = RENAME_BACKOFF_MS
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temp, file)
      return
    } catch (error) {
      if (!isTransient(error) || attempt >= RENAME_RETRIES) {
        // Do not leave the temp file behind; a detail scan would treat it as dirty data.
        rmSync(temp, { force: true })
        throw error
      }
      pauseSync(wait)
      wait *= 2
    }
  }
}

export async function persistAtomicAsync(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = temporaryPath(file)
  const handle = await open(temp, 'w')
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await renameWithRetry(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => { /* already gone */ })
    throw error
  }
}

/**
 * Serialize to the on-disk form: two-space indented JSON without a trailing newline.
 * Every ledger file goes through here; a direct `JSON.stringify` would produce
 * single-line output that no longer matches its siblings.
 */
export function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export function persistJson(file: string, value: unknown): void {
  persistAtomic(file, `${serializeJson(value)}\n`)
}

export async function persistJsonAsync(file: string, value: unknown): Promise<void> {
  await persistAtomicAsync(file, `${serializeJson(value)}\n`)
}

/**
 * Recursively freeze a plain-data value before handing it out. Without this, a subscriber
 * could mutate the snapshot and bypass both the revision counter and the write path.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

/**
 * Deep copy that matches the on-disk shape by dropping keys whose value is `undefined`.
 *
 * JSON never writes those, so keeping `{ workspaceId: undefined }` in memory would mean
 * "field in memory, missing on disk". The dsh tool layer also rejects non-lossless JSON
 * from `execute`, so normalizing at the write entry point keeps memory, disk and tool
 * output in one shape.
 */
export function jsonRoundTrip<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}
