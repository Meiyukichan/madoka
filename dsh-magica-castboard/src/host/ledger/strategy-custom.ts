/**
 * User-written strategies for how the router dispatches work, stored at
 * `$DSH_HOME/storages/castboard/worklabs/strategy-custom.json`.
 *
 * Ideas like "which kind of work goes first", "what must never be dispatched automatically"
 * or "when to stop and ask a human" do not belong to a single project. They are organized by
 * strategy: title plus body, with array order acting as priority.
 *
 * ```json
 * { "schemaVersion": 1, "strategies": [ { "id": "s-lx3k9f2a", "title": "priority", "description": "…" } ] }
 * ```
 *
 * Three rules hold:
 * - Every entry has an id, because titles are edited casually and the id is what identifies
 *   "the same strategy";
 * - Titles are unique, otherwise the router cannot choose between two entries;
 * - File order is priority order and must never be re-sorted alphabetically.
 *
 * Error handling matches the workspace notes: missing file → empty; invalid JSON → error;
 * a malformed entry is dropped; a missing id gets a stable one derived from the title;
 * duplicate titles keep the first occurrence.
 *
 * @module dsh-magica-castboard/host/ledger/strategy-custom
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const STRATEGY_CUSTOM_SCHEMA_VERSION = 1

export const MAX_STRATEGIES = 100

export const MAX_STRATEGY_TITLE_CHARS = 80

export const MAX_STRATEGY_DESC_CHARS = 4000

export interface RouterStrategy {
  id: string
  title: string
  description: string
}

export interface StrategyCustom {
  schemaVersion: number
  strategies: RouterStrategy[]
}

export function emptyStrategyCustom(): StrategyCustom {
  return { schemaVersion: STRATEGY_CUSTOM_SCHEMA_VERSION, strategies: [] }
}

/**
 * Derived from the title, so repeated reads of the same file produce the same id.
 *
 * @param title - The already normalized title.
 */
export function strategyIdFor(title: string): string {
  let hash = 5381
  for (let index = 0; index < title.length; index += 1) {
    hash = ((hash << 5) + hash + title.charCodeAt(index)) >>> 0
  }
  return `s-${hash.toString(36)}`
}

function clip(raw: string, max: number): string {
  const flattened = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  const trimmed = flattened.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

// Full-width/half-width and case differences do not make two titles distinct.
function titleKey(title: string): string {
  return title.normalize('NFKC').toLowerCase()
}

// Alphanumerics plus `-_`; safe both as a file key and as a URL segment.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function compatTitle(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? text
  return clip(first, MAX_STRATEGY_TITLE_CHARS)
}

/**
 * Accept one strategy in any of three shapes: `{ id?, title, description }`, the compatible
 * `{ id?, name, text, description? }`, or a plain string whose first line is the title.
 *
 * Returns `undefined` for a malformed entry. A missing or already-taken id is replaced by
 * the title-derived one, so every strategy ends up with one stable id.
 */
function acceptStrategy(raw: unknown, seenIds: Set<string>): RouterStrategy | undefined {
  let title = ''
  let description = ''
  let rawId = ''
  if (typeof raw === 'string') {
    description = clip(raw, MAX_STRATEGY_DESC_CHARS)
    title = compatTitle(raw)
  } else {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const entry = raw as Record<string, unknown>
    const rawTitle = typeof entry.title === 'string' ? entry.title : entry.name
    const rawBody = typeof entry.description === 'string'
      ? entry.description
      : typeof entry.text === 'string' ? entry.text : undefined
    if (typeof rawTitle !== 'string' || rawBody === undefined) return undefined
    title = clip(rawTitle, MAX_STRATEGY_TITLE_CHARS)
    description = clip(rawBody, MAX_STRATEGY_DESC_CHARS)
    rawId = typeof entry.id === 'string' ? entry.id.trim() : ''
  }
  if (title === '' || description === '') return undefined
  let id = ID_PATTERN.test(rawId) && !seenIds.has(rawId) ? rawId : strategyIdFor(title)
  while (seenIds.has(id)) id = `${id}x`
  seenIds.add(id)
  return { id, title, description }
}

/**
 * Request body → strategy list, strictly.
 *
 * Settings-page saves replace the whole file; entries absent from the body disappear.
 */
export function normalizeStrategies(raw: unknown): RouterStrategy[] {
  if (!Array.isArray(raw)) {
    throw new Error('strategies 必须是数组')
  }
  if (raw.length > MAX_STRATEGIES) {
    throw new Error(`strategies 最多 ${String(MAX_STRATEGIES)} 条`)
  }
  const seenIds = new Set<string>()
  const seenTitles = new Map<string, number>()
  const out: RouterStrategy[] = []
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string' && (typeof entry !== 'object' || entry === null || Array.isArray(entry))) {
      throw new Error(`strategies[${String(index)}] 必须是对象或字符串`)
    }
    const fields = entry as Record<string, unknown>
    if (typeof fields.description === 'string' && clip(fields.description, MAX_STRATEGY_DESC_CHARS) === '') {
      // Empty body means the editor is mid-edit; it should never reach the store.
      throw new Error(`strategies[${String(index)}].description 不能为空`)
    }
    const strategy = acceptStrategy(entry, seenIds)
    if (strategy === undefined) {
      throw new Error(`strategies[${String(index)}] 需要非空的标题与正文`)
    }
    const key = titleKey(strategy.title)
    const first = seenTitles.get(key)
    if (first !== undefined) {
      throw new Error(`策略标题不能重复：「${strategy.title}」与 strategies[${String(first)}] 重名（策略靠标题区分）`)
    }
    seenTitles.set(key, index)
    out.push(strategy)
  })
  return out
}

// Lenient read used for the file itself: bad entries and lower-priority duplicates vanish.
function lenientStrategies(raw: unknown): RouterStrategy[] {
  if (!Array.isArray(raw)) return []
  const seenIds = new Set<string>()
  const seenTitles = new Set<string>()
  const out: RouterStrategy[] = []
  for (const entry of raw) {
    const strategy = acceptStrategy(entry, seenIds)
    if (strategy === undefined) continue
    const key = titleKey(strategy.title)
    if (seenTitles.has(key)) continue
    if (out.length >= MAX_STRATEGIES) break
    seenTitles.add(key)
    out.push(strategy)
  }
  return out
}

/**
 * Parse the file text. If `strategies` is absent, the compatible `items` array is used.
 */
export function parseStrategyCustom(text: string): StrategyCustom {
  if (text.trim() === '') return emptyStrategyCustom()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`strategy-custom.json 不是合法 JSON：${errorText(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('strategy-custom.json 顶层必须是一个对象（{ "strategies": [ … ] }）')
  }
  const holder = parsed as Record<string, unknown>
  return {
    schemaVersion: STRATEGY_CUSTOM_SCHEMA_VERSION,
    strategies: lenientStrategies(holder.strategies !== undefined ? holder.strategies : holder.items),
  }
}

export function strategyCustomText(value: StrategyCustom): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Non-ENOENT failures are rethrown so they are not mistaken for user input errors. */
export async function readStrategyCustom(file: string): Promise<StrategyCustom> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStrategyCustom()
    throw error
  }
  return parseStrategyCustom(text)
}

/** Same-directory temp file plus rename: no torn file on a crash. */
export async function writeStrategyCustom(file: string, strategies: RouterStrategy[]): Promise<StrategyCustom> {
  const value: StrategyCustom = { schemaVersion: STRATEGY_CUSTOM_SCHEMA_VERSION, strategies }
  const tmp = `${file}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(tmp, strategyCustomText(value), 'utf8')
  await rename(tmp, file)
  return value
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
