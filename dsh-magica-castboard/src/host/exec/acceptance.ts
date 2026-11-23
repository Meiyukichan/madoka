/**
 * Acceptance: **strategy archive** + **acceptance-round planning**.
 *
 * ## Strategy archive
 *
 * `castboard-strategy.json` stores a set of criteria for "how this round is closed". A
 * strategy consists of a stable id, a title, an action type, and a body; array order is
 * priority.
 *
 * | type | closing action |
 * |---|---|
 * | `issue` | turn this round's conclusion into the next item to be planned |
 * | `close` | judge the work complete; the task moves to `done` |
 *
 * Read/write discipline:
 * - missing file = empty; corrupt JSON = throw (never clear it silently, or the next
 *   save would overwrite a hand-written file);
 * - a malformed entry = drop that entry; missing id = mint a stable id from "title +
 *   type"; duplicate title = keep the first occurrence;
 * - writes go through a temp file in the same directory + rename, never a partial file.
 *
 * ## Acceptance-round planning
 *
 * When a task sits in awaiting review with strategies attached, plan a piece of context
 * for the session to read: list every strategy and explain how far they must be met to
 * close, and which conclusions should be split into new issues. This module only plans;
 * it never changes the ledger.
 *
 * @module dsh-magica-castboard/host/exec/acceptance
 */
import { eventLog } from '../shared/event-log.ts'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  ACCEPTANCE_STRATEGY_SCHEMA_VERSION,
  ACCEPTANCE_TYPES,
  MAX_ACCEPTANCE_PER_TASK,
  MAX_ACCEPTANCE_STRATEGIES,
  MAX_ACCEPTANCE_TEXT_CHARS,
  MAX_ACCEPTANCE_TITLE_CHARS,
  type AcceptanceStrategy,
  type AcceptanceStrategyFile,
  type AcceptanceType,
  type TaskLedger,
  type TaskRecord,
} from '../model.ts'

export {
  ACCEPTANCE_STRATEGY_SCHEMA_VERSION,
  ACCEPTANCE_TYPES,
  MAX_ACCEPTANCE_PER_TASK,
  MAX_ACCEPTANCE_STRATEGIES,
  MAX_ACCEPTANCE_TEXT_CHARS,
  MAX_ACCEPTANCE_TITLE_CHARS,
}
export type { AcceptanceStrategy, AcceptanceStrategyFile, AcceptanceType }

/** Invalid input; the route layer maps it to 400. */
export class AcceptanceStrategyError extends Error {
  readonly code = 'invalid_input'

  constructor(message: string) {
    super(message)
    this.name = 'AcceptanceStrategyError'
  }
}

export function emptyAcceptanceStrategies(): AcceptanceStrategyFile {
  return { schemaVersion: ACCEPTANCE_STRATEGY_SCHEMA_VERSION, strategies: [] }
}

/**
 * The id minted when one is missing: derived from a hash of "type + title", so the same
 * file yields the same ids on every read. The type must be included — the same sentence
 * is two different strategies under "file an issue" and "acceptance complete".
 */
export function acceptanceIdFor(title: string, type: AcceptanceType): string {
  const seed = `${type}\u0000${title}`
  let hash = 5381
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) + hash + seed.charCodeAt(index)) >>> 0
  }
  return `a-${hash.toString(36)}`
}

function clip(raw: string, max: number): string {
  const flattened = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  const trimmed = flattened.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

function titleKey(title: string): string {
  return title.normalize('NFKC').toLowerCase()
}

function isAcceptanceType(raw: unknown): raw is AcceptanceType {
  return typeof raw === 'string' && (ACCEPTANCE_TYPES as readonly string[]).includes(raw)
}

/** Ids allow only letters, digits, and `-_` (safe for file names and keys). */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Accept one strategy; returns `undefined` when the shape is wrong (not an object,
 * missing strings, unknown type, empty title or body). When the id is missing or taken,
 * mint one from title + type and append `x` on collisions.
 */
function acceptStrategy(
  raw: unknown,
  seenIds: Set<string>,
): AcceptanceStrategy | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const entry = raw as Record<string, unknown>
  if (typeof entry.title !== 'string') return undefined
  if (!isAcceptanceType(entry.type)) return undefined
  // The persisted field is `description`; the wire protocol also accepts `text`, so
  // read either one.
  const body = typeof entry.description === 'string'
    ? entry.description
    : typeof entry.text === 'string' ? entry.text : undefined
  if (body === undefined) return undefined
  const title = clip(entry.title, MAX_ACCEPTANCE_TITLE_CHARS)
  const description = clip(body, MAX_ACCEPTANCE_TEXT_CHARS)
  if (title === '' || description === '') return undefined
  const type = entry.type
  const rawId = typeof entry.id === 'string' ? entry.id.trim() : ''
  let id = ID_PATTERN.test(rawId) && !seenIds.has(rawId)
    ? rawId
    : acceptanceIdFor(title, type)
  while (seenIds.has(id)) id = `${id}x`
  seenIds.add(id)
  return { id, title, type, description }
}

/**
 * Wire body → strategy array (**strict**): shape, type, duplicate titles, and count
 * limit; any invalid entry throws {@link AcceptanceStrategyError}.
 */
export function normalizeAcceptanceStrategies(raw: unknown): AcceptanceStrategy[] {
  if (!Array.isArray(raw)) {
    throw new AcceptanceStrategyError('strategies 必须是数组')
  }
  if (raw.length > MAX_ACCEPTANCE_STRATEGIES) {
    throw new AcceptanceStrategyError(`strategies 最多 ${MAX_ACCEPTANCE_STRATEGIES} 条`)
  }
  const seenIds = new Set<string>()
  const seenTitles = new Map<string, number>()
  const out: AcceptanceStrategy[] = []
  raw.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new AcceptanceStrategyError(`strategies[${index}] 必须是对象`)
    }
    const fields = entry as Record<string, unknown>
    if (!isAcceptanceType(fields.type)) {
      throw new AcceptanceStrategyError(
        `strategies[${index}].type 只允许 ${ACCEPTANCE_TYPES.join(' / ')}`,
      )
    }
    const body = typeof fields.description === 'string'
      ? fields.description
      : typeof fields.text === 'string' ? fields.text : undefined
    if (body !== undefined && clip(body, MAX_ACCEPTANCE_TEXT_CHARS) === '') {
      throw new AcceptanceStrategyError(`strategies[${index}].description 不能为空`)
    }
    const strategy = acceptStrategy(entry, seenIds)
    if (strategy === undefined) {
      throw new AcceptanceStrategyError(`strategies[${index}].title 必须是非空字符串`)
    }
    const key = titleKey(strategy.title)
    const first = seenTitles.get(key)
    if (first !== undefined) {
      throw new AcceptanceStrategyError(
        `策略标题不能重复：「${strategy.title}」与 strategies[${first}] 重名`,
      )
    }
    seenTitles.set(key, index)
    out.push(strategy)
  })
  return out
}

/** File content → strategy array (**lenient**): skip malformed entries; on duplicate titles keep the first. */
function lenientStrategies(raw: unknown): AcceptanceStrategy[] {
  if (!Array.isArray(raw)) return []
  const seenIds = new Set<string>()
  const seenTitles = new Set<string>()
  const out: AcceptanceStrategy[] = []
  for (const entry of raw) {
    const strategy = acceptStrategy(entry, seenIds)
    if (strategy === undefined) continue
    const key = titleKey(strategy.title)
    if (seenTitles.has(key)) {
      note('warn', 'acceptance-strategy-duplicate-title', `跳过重名策略「${strategy.title}」`)
      continue
    }
    if (out.length >= MAX_ACCEPTANCE_STRATEGIES) break
    seenTitles.add(key)
    out.push(strategy)
  }
  return out
}

/**
 * One-off strategies carried by a create-card request (**lenient**): drop malformed
 * entries; a single bad criterion must not fail card creation. Returns `undefined` when
 * no strategy is valid (no empty array is persisted).
 */
export function normalizeInlineAcceptanceStrategies(raw: unknown): AcceptanceStrategy[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const strategies = lenientStrategies(raw).slice(0, MAX_ACCEPTANCE_PER_TASK)
  return strategies.length > 0 ? strategies : undefined
}

/** Throws on invalid JSON or a non-object top level; the route layer returns 400. */
export function parseAcceptanceStrategies(text: string): AcceptanceStrategyFile {
  if (text.trim() === '') return emptyAcceptanceStrategies()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`castboard-strategy.json 不是合法 JSON：${errorText(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('castboard-strategy.json 顶层必须是对象（{ "strategies": [ … ] }）')
  }
  return {
    schemaVersion: ACCEPTANCE_STRATEGY_SCHEMA_VERSION,
    strategies: lenientStrategies((parsed as Record<string, unknown>).strategies),
  }
}

export function acceptanceStrategyText(value: AcceptanceStrategyFile): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Missing file = empty; other read failures are rethrown. */
export async function readAcceptanceStrategies(file: string): Promise<AcceptanceStrategyFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyAcceptanceStrategies()
    note('warn', 'acceptance-strategy-read-failed', `${file}: ${errorText(error)}`)
    throw error
  }
  return parseAcceptanceStrategies(text)
}

/**
 * Temp file in the same directory, then rename: readers never see a partial file.
 * `strategies` order is priority.
 */
export async function writeAcceptanceStrategies(
  file: string,
  strategies: AcceptanceStrategy[],
): Promise<AcceptanceStrategyFile> {
  const value: AcceptanceStrategyFile = {
    schemaVersion: ACCEPTANCE_STRATEGY_SCHEMA_VERSION,
    strategies,
  }
  const temp = `${file}.tmp`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temp, acceptanceStrategyText(value), 'utf8')
    await rename(temp, file)
  } catch (error) {
    note('warn', 'acceptance-strategy-write-failed', `${file}: ${errorText(error)}`)
    throw error
  }
  note('info', 'acceptance-strategy-updated', `${file}: ${strategies.length} 条`)
  return value
}

// ─────────────────────────────────────────────────────────────────────────────
// Acceptance-round planning (pure functions; no ledger access)
// ─────────────────────────────────────────────────────────────────────────────

export type AcceptanceTaskLike = Pick<
  TaskRecord,
  'status' | 'title' | 'acceptanceInjectedAt' | 'checklist'
>

export interface AcceptancePlan {
  shouldRun: boolean
  /** Text injected as the `castboard-task-acceptance` context. */
  injectText: string
  closeStrategies: AcceptanceStrategy[]
  issueStrategies: AcceptanceStrategy[]
  reason?: string
}

export function checklistProgress(task: Pick<AcceptanceTaskLike, 'checklist'>): { done: number; total: number } {
  const items = task.checklist ?? []
  return { done: items.filter(item => item.checked).length, total: items.length }
}

/** No second round once injection has happened. */
export function planAcceptance(input: {
  task: AcceptanceTaskLike
  strategies: readonly AcceptanceStrategy[]
}): AcceptancePlan {
  const empty: AcceptancePlan = {
    shouldRun: false,
    injectText: '',
    closeStrategies: [],
    issueStrategies: [],
    reason: '',
  }
  const task = input.task
  if (task.status !== 'in_review') return { ...empty, reason: 'not in review' }
  if (task.acceptanceInjectedAt !== undefined) return { ...empty, reason: 'already injected' }
  if (input.strategies.length === 0) return { ...empty, reason: 'no strategy' }

  const closeStrategies = input.strategies.filter(strategy => strategy.type === 'close')
  const issueStrategies = input.strategies.filter(strategy => strategy.type === 'issue')
  const progress = checklistProgress(task)
  const lines = [
    '验收轮：请逐条核对下面的验收策略，并在清单里勾选通过项。',
    `卡片：${task.title}`,
    `清单完成度：${progress.done}/${progress.total}`,
    '',
    ...input.strategies.map((strategy, index) =>
      `${index + 1}. [${strategy.type}] ${strategy.title}\n   ${strategy.description}`),
    '',
    closeStrategies.length > 0 ? 'close 类：全部满足后这张卡才可以收（done）。' : '',
    issueStrategies.length > 0 ? 'issue 类：未满足的结论请拆成新的待规划 issue。' : '',
  ].filter(line => line !== '')

  return {
    shouldRun: true,
    injectText: lines.join('\n'),
    closeStrategies,
    issueStrategies,
  }
}

export type AcceptanceOutcome = 'done' | 'back-to-todo' | 'spawn-issues'

/** Pure: landing the state is the caller's job. */
export function settleAcceptance(input: {
  plan: AcceptancePlan
  checklist: { done: number; total: number }
  spawnedIssues: number
}): AcceptanceOutcome {
  if (input.plan.issueStrategies.length > 0 && input.spawnedIssues > 0) return 'spawn-issues'
  if (input.plan.closeStrategies.length === 0) return 'back-to-todo'
  const complete = input.checklist.total > 0 && input.checklist.done === input.checklist.total
  return complete ? 'done' : 'back-to-todo'
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

function note(level: 'info' | 'warn', event: string, detail: string): void {
  eventLog(level, event, detail)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
