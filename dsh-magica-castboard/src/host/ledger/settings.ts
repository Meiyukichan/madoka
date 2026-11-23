/**
 * Board settings, persisted to `castboard.settings.yaml` next to the task ledger.
 *
 * Settings deliberately do **not** live inside `castboard-task.json` any more:
 *
 * - the file is meant to be hand-edited (that is why it is YAML with a comment header),
 *   and a hand edit must not have to race — or rewrite — the task index;
 * - a save touches one small file instead of rewriting the whole ledger (and bumping its
 *   revision, which wakes every open panel and the dispatcher).
 *
 * Two semantics survive from the in-ledger era:
 * - A save replaces the whole object: fields missing from the request go back to factory
 *   defaults instead of keeping their current values;
 * - Changes apply only to cards created afterwards; existing cards keep their own
 *   permission and model.
 *
 * Only explicitly set fields are stored. {@link SettingsStore.get} layers the defaults back
 * on read, so both the file and the effective value stay small.
 *
 * The file is read fresh on every `read()`: an edit made in an editor shows up on the next
 * poll without a restart. `get()` is the synchronous view for the execution gate, and it is
 * refreshed by that same read.
 *
 * @module dsh-magica-castboard/host/ledger/settings
 */
import { readFile } from 'node:fs/promises'

import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_PERMISSION,
  type BoardSettings,
} from '../model.ts'
import { DEFAULT_COMMENT_POLL_MS, asBoardSettings } from '../rules.ts'
import { eventLog } from '../shared/event-log.ts'
import { persistAtomicAsync } from './atomic.ts'
import { parseSettingsYaml, serializeSettingsYaml } from './settings-yaml.ts'
import { ReadOnlyError } from './task-store.ts'

/**
 * The complete fallback value, shared by UI display and execution.
 *
 * Environment overrides (concurrency, poll interval) are runtime policy handled by the
 * `*Of` helpers and deliberately do not live here.
 */
export function factorySettings(): BoardSettings {
  return {
    defaultPermission: DEFAULT_PERMISSION,
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    autoRoute: true,
    portraitRunOnStart: false,
    commentsEnabled: true,
    commentPollMs: DEFAULT_COMMENT_POLL_MS,
  }
}

export interface SettingsStoreOptions {
  /** Absolute path of `castboard.settings.yaml`. */
  file: string
  /** Owner gate; a read-only window must never write settings. */
  canWrite?: () => boolean
  /**
   * Previous location (`castboard-task.json`'s `settings` key). Consulted once, only when
   * the YAML file does not exist yet, and then written out as the new file.
   */
  legacy?: () => Promise<BoardSettings | undefined>
}

export class SettingsStore {
  private readonly file: string
  private readonly canWrite: () => boolean
  private readonly legacy: (() => Promise<BoardSettings | undefined>) | undefined
  /** Only the fields that are actually set. */
  private storedValue: BoardSettings = {}
  /** Writes are serialized so two saves cannot interleave a temp file and a rename. */
  private queue: Promise<unknown> = Promise.resolve()
  /**
   * Bumped after each successful save. A read that started before a save must not install
   * the older snapshot over it — with a 5 s poll and a save button, that race is reachable.
   */
  private writes = 0

  constructor(options: SettingsStoreOptions | string) {
    const resolved = typeof options === 'string' ? { file: options } : options
    this.file = resolved.file
    this.canWrite = resolved.canWrite ?? (() => true)
    this.legacy = resolved.legacy
  }

  get path(): string {
    return this.file
  }

  /** Effective value, defaults applied. Synchronous: the execution gate must not await I/O. */
  get(): BoardSettings {
    return { ...factorySettings(), ...this.storedValue }
  }

  /** Only the fields that were actually written; used by export and the "configured?" check. */
  stored(): BoardSettings {
    return { ...this.storedValue }
  }

  /** Ensure the file has been read at least once (and migrate the old location if needed). */
  async load(): Promise<BoardSettings> {
    await this.refresh()
    return this.get()
  }

  async read(): Promise<BoardSettings> {
    return await this.load()
  }

  /**
   * Whole-object replacement, one atomic write.
   *
   * An empty object means "everything back to defaults": the file keeps its header and
   * drops every key.
   */
  async write(input: unknown): Promise<BoardSettings> {
    const value = asBoardSettings(input)
    if (!this.writable()) throw new ReadOnlyError()
    await this.enqueue(async () => {
      await persistAtomicAsync(this.file, serializeSettingsYaml(value))
      this.writes += 1
      this.storedValue = { ...value }
    })
    return this.get()
  }

  private writable(): boolean {
    try {
      return this.canWrite()
    } catch {
      return false
    }
  }

  private async refresh(): Promise<void> {
    const stamp = this.writes
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A save may have created the file while the read was in flight.
        if (this.writes !== stamp) return
        await this.migrateLegacy()
        return
      }
      // An unreadable file degrades to factory defaults instead of failing the whole plugin.
      note('warn', 'settings-file-unreadable', `${this.file}: ${errorText(error)}`)
      if (this.writes === stamp) this.storedValue = {}
      return
    }
    let parsed: BoardSettings
    try {
      parsed = asBoardSettings(parseSettingsYaml(text))
    } catch (error) {
      // Keep the file untouched so the user can fix it; the panel shows the defaults.
      note('warn', 'settings-file-invalid', `${this.file}: ${errorText(error)}`)
      if (this.writes === stamp) this.storedValue = {}
      return
    }
    // The freshly saved value wins over a snapshot read before that save.
    if (this.writes === stamp) this.storedValue = parsed
  }

  /**
   * Import the pre-YAML location (the ledger's `settings` key).
   *
   * A read-only window adopts the values in memory but must not write; the owner performs
   * the one-time migration. After it, the key disappears from the ledger on its next write.
   */
  private async migrateLegacy(): Promise<void> {
    const legacy = await this.legacyValue()
    if (legacy === undefined || Object.keys(legacy).length === 0) {
      this.storedValue = {}
      return
    }
    this.storedValue = { ...legacy }
    if (!this.writable()) return
    try {
      await this.enqueue(async () => {
        await persistAtomicAsync(this.file, serializeSettingsYaml(legacy))
      })
      note('info', 'settings-migrated', `板设置已从台账迁到 ${this.file}`)
    } catch (error) {
      note('warn', 'settings-migrate-failed', errorText(error))
    }
  }

  private async legacyValue(): Promise<BoardSettings | undefined> {
    if (this.legacy === undefined) return undefined
    try {
      return await this.legacy()
    } catch (error) {
      note('warn', 'settings-legacy-unreadable', errorText(error))
      return undefined
    }
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }
}

function note(level: 'info' | 'warn' | 'error', event: string, detail: string): void {
  eventLog(level, event, detail)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
