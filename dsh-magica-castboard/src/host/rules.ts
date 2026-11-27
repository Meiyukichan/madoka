/**
 * Host-side rules: what is legal, which values may be persisted, and whether a transition
 * is allowed.
 *
 * Pure computation — no disk, no requests — so the tool layer, routing layer and
 * load/import paths all reuse it. The status value domain and its transition table sit
 * together so adding a state cannot forget its edges, and the dependency on `model.ts`
 * runs one way only: shape → rules.
 *
 * @module dsh-magica-castboard/host/rules
 */
import { acceptanceIdFor } from './exec/acceptance.ts'
import {
  ACCEPTANCE_TYPES,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_PERMISSION,
  EXECUTION_TRIGGERS,
  MAX_ACCEPTANCE_PER_TASK,
  MAX_ACCEPTANCE_TEXT_CHARS,
  MAX_ACCEPTANCE_TITLE_CHARS,
  MAX_CHECKLIST_ITEMS,
  MAX_CHECKLIST_TEXT,
  MAX_MAX_CONCURRENT,
  MAX_TAGS,
  MAX_TAG_TEXT,
  MIN_MAX_CONCURRENT,
  URGENCIES,
  isValidId,
  randomSuffix,
  type AcceptanceStrategy,
  type Actor,
  type BoardSettings,
  type ChecklistItem,
  type ExecutionConfig,
  type ExecutionRecord,
  type ExecutionReport,
  type PermissionMode,
  type TaskModel,
  type TaskRecord,
  type Urgency,
} from './model.ts'
import { nextCronRunAtOrUndefined } from './dispatch/cron.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Text gates
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_TITLE = 200

export const MAX_BODY = 4000

/** Trimmed 1..{@link MAX_TITLE} characters, or throw. */
export function normalizeTitle(raw: string): string {
  const title = raw.trim()
  if (title.length === 0 || title.length > MAX_TITLE) {
    throw new Error(`title must be 1..${MAX_TITLE} characters`)
  }
  return title
}

export function normalizeBody(raw: string): string {
  const body = raw.trim()
  if (body.length === 0 || body.length > MAX_BODY) {
    throw new Error(`comment body must be 1..${MAX_BODY} characters`)
  }
  return body
}

// ─────────────────────────────────────────────────────────────────────────────
// Task state machine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The seven lifecycle states. Main column: `todo → in_progress → in_review → done`;
 * `canceled` / `archived` live on the "other tasks" tab; `abandoned` is in no column.
 *
 * "Pending planning" is not a task state — it is its own issue ledger, and a `backlog` task
 * is migrated out once. `blocked` is not a state either but a flag any non-terminal state
 * may carry.
 */
export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done' | 'canceled' | 'archived' | 'abandoned'

export const TASK_STATUSES: readonly TaskStatus[] = [
  'todo',
  'in_progress',
  'in_review',
  'done',
  'canceled',
  'archived',
  'abandoned',
]

export const MAIN_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done']

export const SECONDARY_STATUSES: readonly TaskStatus[] = ['canceled', 'archived']

/**
 * Set by the card's top-right delete icon: hidden from the board, but not physically
 * deleted, so the record stays traceable and exportable. Unlike `canceled` ("not doing it,
 * but still visible"), this means "out of sight".
 */
export const ABANDONED_STATUS: TaskStatus = 'abandoned'

export const ALL_STATUSES: readonly TaskStatus[] = [...MAIN_STATUSES, ...SECONDARY_STATUSES, ABANDONED_STATUS]

// Stored-only value that may show up in existing ledgers; never a valid status.
export const BACKLOG_STAGE_STATUS = 'backlog'

/**
 * Allowed edges; anything absent is `invalid_transition`. Three deliberately tight rules:
 * `done` only moves to `archived` (a mistake is sent back during review instead), `archived`
 * is terminal, and `abandoned` is terminal and reachable only from a live state.
 */
const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ['in_progress', 'canceled', 'abandoned'],
  in_progress: ['in_review', 'todo', 'canceled', 'abandoned'],
  in_review: ['in_progress', 'todo', 'done', 'canceled', 'abandoned'],
  done: ['archived'],
  canceled: ['archived', 'todo', 'abandoned'],
  archived: [],
  abandoned: [],
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * The only transition that hands ownership to the caller's session. The "same project only"
 * boundary is enforced in the tool layer.
 */
export function isClaim(from: TaskStatus, to: TaskStatus): boolean {
  return from === 'todo' && to === 'in_progress'
}

// ─────────────────────────────────────────────────────────────────────────────
// ids: minting and validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `[A-Za-z0-9][A-Za-z0-9_-]{0,99}`, and the only shape accepted from imports. Ids are
 * concatenated into `<tasksDir>/<id>.json`, so a loose character set would turn `../../x`
 * into a delete-any-file primitive.
 */
export function isValidTaskId(id: string): boolean {
  return isValidId(id)
}

export function newTaskId(): string {
  return `t-${Date.now().toString(36)}-${randomSuffix()}`
}

function manualUuid(): string {
  const bytes: number[] = []
  for (let index = 0; index < 16; index += 1) bytes.push(Math.floor(Math.random() * 256))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.map(byte => byte.toString(16).padStart(2, '0'))
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-')
}

/** Prefer the runtime's crypto; fall back to the hand-built v4 shape. */
function randomUuid(): string {
  const web = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof web?.randomUUID === 'function') return web.randomUUID()
  return manualUuid()
}

/**
 * A standard UUID, because the shared store's `commentId` is a standard-UUID idempotency
 * key: reusing the same value means a resend adds no row and needs no mapping table.
 * Non-UUID comments are never uploaded.
 */
export function newCommentId(): string {
  return randomUuid()
}

export function newIssueId(): string {
  return randomUuid()
}

export function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

export function newChecklistItemId(): string {
  return `k-${Date.now().toString(36)}-${randomSuffix()}`
}

export function newExecutionId(): string {
  return `e-${Date.now().toString(36)}-${randomSuffix()}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution permissions and board settings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Non-strings fall back to the factory default; known alternate spellings (`readOnly`,
 * `workspaceWrite`, `fullAccess`) are canonicalized. An unrecognized string throws instead
 * of degrading — silently defaulting a typo would hand out write access.
 */
export function asPermission(raw: unknown): PermissionMode {
  if (typeof raw !== 'string') return DEFAULT_PERMISSION
  const text = raw.trim()
  if (text === 'workspace-write' || text === 'workspaceWrite') return 'workspace-write'
  if (text === 'read-only' || text === 'readOnly') return 'read-only'
  if (text === 'danger-full-access' || text === 'fullAccess') return 'danger-full-access'
  throw new Error("permission must be 'workspace-write', 'read-only', or 'danger-full-access'")
}

export const MIN_COMMENT_POLL_MS = 1_000

export const MAX_COMMENT_POLL_MS = 60 * 60 * 1_000

export const DEFAULT_COMMENT_POLL_MS = 5_000

/** Keep only known fields; throw on a malformed one. */
export function asBoardSettings(raw: unknown): BoardSettings {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('board settings must be an object')
  }
  const source = raw as Record<string, unknown>
  const settings: BoardSettings = {}
  if (source.defaultPermission !== undefined) {
    settings.defaultPermission = asPermission(source.defaultPermission)
  }
  if (source.maxConcurrent !== undefined) {
    const value = source.maxConcurrent
    if (
      typeof value !== 'number'
      || !Number.isInteger(value)
      || value < MIN_MAX_CONCURRENT
      || value > MAX_MAX_CONCURRENT
    ) {
      throw new Error(`maxConcurrent must be an integer ${MIN_MAX_CONCURRENT}..${MAX_MAX_CONCURRENT}`)
    }
    settings.maxConcurrent = value
  }
  if (source.autoRoute !== undefined) {
    if (typeof source.autoRoute !== 'boolean') throw new Error('autoRoute must be a boolean')
    settings.autoRoute = source.autoRoute
  }
  if (source.portraitRunOnStart !== undefined) {
    if (typeof source.portraitRunOnStart !== 'boolean') throw new Error('portraitRunOnStart must be a boolean')
    settings.portraitRunOnStart = source.portraitRunOnStart
  }
  if (source.commentsEnabled !== undefined) {
    if (typeof source.commentsEnabled !== 'boolean') throw new Error('commentsEnabled must be a boolean')
    settings.commentsEnabled = source.commentsEnabled
  }
  if (source.interactionReportEnabled !== undefined) {
    if (typeof source.interactionReportEnabled !== 'boolean') {
      throw new Error('interactionReportEnabled must be a boolean')
    }
    settings.interactionReportEnabled = source.interactionReportEnabled
  }
  if (source.commentPollMs !== undefined) {
    const value = source.commentPollMs
    if (
      typeof value !== 'number'
      || !Number.isFinite(value)
      || value < MIN_COMMENT_POLL_MS
      || value > MAX_COMMENT_POLL_MS
    ) {
      throw new Error(`commentPollMs must be a number ${MIN_COMMENT_POLL_MS}..${MAX_COMMENT_POLL_MS}`)
    }
    settings.commentPollMs = Math.round(value)
  }
  return settings
}

/** `undefined` counts as on. Re-read every tick, so changes apply without a restart. */
export function commentsEnabled(settings?: BoardSettings): boolean {
  return settings?.commentsEnabled !== false
}

export function commentPollMsOf(settings: BoardSettings | undefined, fallback: number): number {
  const value = settings?.commentPollMs
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(MAX_COMMENT_POLL_MS, Math.max(MIN_COMMENT_POLL_MS, Math.round(value)))
}

export function autoRouteEnabled(settings?: BoardSettings): boolean {
  return settings?.autoRoute ?? true
}

export function defaultPermissionOf(settings?: BoardSettings): PermissionMode {
  return settings?.defaultPermission ?? DEFAULT_PERMISSION
}

/** Read fresh on every `run()`, so a settings change applies immediately. */
export function maxConcurrentOf(settings: BoardSettings | undefined, fallback?: number): number {
  return settings?.maxConcurrent ?? fallback ?? DEFAULT_MAX_CONCURRENT
}

// ─────────────────────────────────────────────────────────────────────────────
// Base field normalization
// ─────────────────────────────────────────────────────────────────────────────

export function asUrgency(raw: string): Urgency {
  if (!URGENCIES.includes(raw as Urgency)) {
    throw new Error(`urgency must be one of: ${URGENCIES.join(', ')}`)
  }
  return raw as Urgency
}

export function asStatus(raw: string): TaskStatus {
  if (!ALL_STATUSES.includes(raw as TaskStatus)) {
    throw new Error(`status must be one of: ${ALL_STATUSES.join(', ')}`)
  }
  return raw as TaskStatus
}

// ── Private: cron schedulability ─────────────────────────────────────────────
//
// Normalizing an execution config has to answer "can this ever fire" (April 31st never
// does). These helpers keep that reasoning in the rules layer; the dispatcher still owns
// "the next fire time", under the same five-field semantics.

const CRON_SEGMENTS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const

const CRON_CYCLE_DAYS = 146_097

function cronSegment(field: string, index: number): Set<number> {
  const bounds = CRON_SEGMENTS[index]
  if (bounds === undefined) throw new Error(`cron segment ${String(index)} out of range`)
  const [lowest, highest] = bounds
  const min: number = lowest
  const max: number = highest
  const values = new Set<number>()
  for (const chunk of field.split(',')) {
    const pieces = chunk.split('/')
    const spec = pieces[0] ?? ''
    const stepText = pieces[1]
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${field}"`)
    let from = min
    let to = max
    if (spec !== '*') {
      const edges = spec.split('-')
      const first = edges[0] ?? ''
      const last = edges[1]
      if (!/^\d+$/.test(first) || (last !== undefined && !/^\d+$/.test(last))) {
        throw new Error(`bad value in "${field}"`)
      }
      from = Number(first)
      to = last === undefined ? from : Number(last)
      if (last === undefined && stepText !== undefined) to = max
    }
    if (from < min || to > max || from > to) throw new Error(`value out of range in "${field}"`)
    for (let value = from; value <= to; value += step) {
      // Weekday 7 and 0 both mean Sunday; fold before the schedulability check.
      values.add(index === 4 && value === 7 ? 0 : value)
    }
  }
  if (values.size === 0) throw new Error(`empty segment "${field}"`)
  return values
}

/**
 * Whether any calendar day satisfies both restricted fields. Cron semantics are "either
 * matches"; a 400-year scan (one full Gregorian cycle) gives a definite answer cheaply.
 */
function cronCanFire(
  days: Set<number>,
  months: Set<number>,
  weekdays: Set<number>,
  dayRestricted: boolean,
  weekdayRestricted: boolean,
): boolean {
  if (!dayRestricted && !weekdayRestricted) return true
  const cursor = new Date(Date.UTC(2000, 0, 1))
  for (let index = 0; index < CRON_CYCLE_DAYS; index += 1) {
    if (months.has(cursor.getUTCMonth() + 1)) {
      const dayHit = days.has(cursor.getUTCDate())
      const weekdayHit = weekdays.has(cursor.getUTCDay())
      const hit = dayRestricted
        ? weekdayRestricted ? dayHit || weekdayHit : dayHit
        : weekdayHit
      if (hit) return true
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return false
}

function assureSchedulableCron(expression: string): void {
  const trimmed = expression.trim()
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`cron must have exactly 5 fields (minute hour day month weekday), got ${parts.length}`)
  }
  if (nextCronRunAtOrUndefined(trimmed, Date.now()) === undefined) {
    throw new Error(`cron "${trimmed}" is not schedulable`)
  }
}

/**
 * `queue` passes through; `scheduled` needs a cron that can actually fire. The next fire
 * time is never computed or stored (it is derived), and a `claim` value folds into `queue`
 * so existing cards need no migration.
 */
export function normalizeExecution(raw: { mode?: string; cron?: string }): ExecutionConfig {
  const requested = raw.mode === 'claim' ? 'queue' : raw.mode
  const mode = requested ?? 'queue'
  if (mode !== 'queue' && mode !== 'scheduled') {
    throw new Error("execution.mode must be 'queue' or 'scheduled'")
  }
  if (mode === 'queue') return { mode }
  const cron = (raw.cron ?? '').trim()
  assureSchedulableCron(cron)
  return { mode, cron }
}

/** Both halves must be non-empty after trimming; extra keys are dropped. */
export function normalizeModel(raw: unknown): TaskModel {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('model must be { provider: string, model: string }')
  }
  const { provider, model } = raw as { provider?: unknown; model?: unknown }
  if (typeof provider !== 'string' || typeof model !== 'string') {
    throw new Error('model must be { provider: string, model: string }')
  }
  const providerText = provider.trim()
  const modelText = model.trim()
  if (providerText.length === 0 || modelText.length === 0) {
    throw new Error('model.provider and model.model must be non-empty strings')
  }
  return { provider: providerText, model: modelText }
}

/**
 * Trim, drop empties, dedupe, cut to {@link MAX_TAG_TEXT} characters and {@link MAX_TAGS}
 * entries; returns `undefined` rather than an empty array. Control characters would break
 * the injected XML, and external meta sometimes sends comma-separated input.
 */
export function normalizeTags(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  const candidates = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' ? raw.split(',') : undefined
  if (candidates === undefined) return undefined
  const seen = new Set<string>()
  const tags: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const cleaned = candidate.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
    if (cleaned.length === 0) continue
    const tag = cleaned.length > MAX_TAG_TEXT ? cleaned.slice(0, MAX_TAG_TEXT) : cleaned
    if (seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
    if (tags.length >= MAX_TAGS) break
  }
  return tags.length > 0 ? tags : undefined
}

/**
 * Validates shape only, never existence: strategies live in user files that may be broken
 * for unrelated reasons, and "reject what cannot be found" would fail the whole edit. The
 * UI shows a missing strategy as missing.
 */
export function normalizeAcceptanceStrategyIds(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const ids: string[] = []
  for (const candidate of raw) {
    if (typeof candidate !== 'string') continue
    const id = candidate.trim()
    if (id === '' || !isValidId(id) || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= MAX_ACCEPTANCE_PER_TASK) break
  }
  return ids.length > 0 ? ids : undefined
}

/**
 * Normalize one-off acceptance strategies carried by an issue or a card.
 *
 * The caller never supplies an id: ids are always derived from `type + title` by the
 * same `acceptanceIdFor` used by the strategy archive. A bad entry is dropped rather
 * than failing the whole create/edit; duplicate titles keep the first occurrence
 * because array order is priority.
 */
export function normalizeAcceptanceStrategies(raw: unknown): AcceptanceStrategy[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seenIds = new Set<string>()
  const seenTitles = new Set<string>()
  const out: AcceptanceStrategy[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const fields = entry as Record<string, unknown>
    const type = fields.type
    if (typeof type !== 'string' || !(ACCEPTANCE_TYPES as readonly string[]).includes(type)) continue
    const title = typeof fields.title === 'string' ? fields.title.trim().slice(0, MAX_ACCEPTANCE_TITLE_CHARS) : ''
    const description = typeof fields.description === 'string'
      ? fields.description.trim().slice(0, MAX_ACCEPTANCE_TEXT_CHARS)
      : ''
    if (title === '' || description === '') continue
    const titleKey = title.normalize('NFKC').toLowerCase()
    if (seenTitles.has(titleKey)) continue
    seenTitles.add(titleKey)
    let id = acceptanceIdFor(title, type as AcceptanceStrategy['type'])
    while (seenIds.has(id)) id = `${id}x`
    seenIds.add(id)
    out.push({ id, title, type: type as AcceptanceStrategy['type'], description })
    if (out.length >= MAX_ACCEPTANCE_PER_TASK) break
  }
  return out.length > 0 ? out : undefined
}

export function normalizeChecklistText(raw: string): string {
  const text = raw.trim()
  if (text.length === 0 || text.length > MAX_CHECKLIST_TEXT) {
    throw new Error(`checklist item text must be 1..${MAX_CHECKLIST_TEXT} characters`)
  }
  return text
}

export function checklistFromTexts(texts: readonly string[]): ChecklistItem[] {
  const items = texts.map(text => ({
    id: newChecklistItemId(),
    text: normalizeChecklistText(text),
    checked: false,
  }))
  if (items.length > MAX_CHECKLIST_ITEMS) {
    throw new Error(`checklist may hold at most ${MAX_CHECKLIST_ITEMS} items`)
  }
  return items
}

/** Validate the issue-side plain-text checklist before converting it to task items. */
export function normalizeChecklistTexts(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new Error('checklist must be an array of strings')
  if (raw.length > MAX_CHECKLIST_ITEMS) {
    throw new Error(`checklist may hold at most ${MAX_CHECKLIST_ITEMS} items`)
  }
  return raw.map((entry) => {
    if (typeof entry !== 'string') throw new Error('checklist must be an array of strings')
    return normalizeChecklistText(entry)
  })
}

/** Mint missing ids; only checked items keep `checkedBy` / `checkedAt` / `note`. */
export function normalizeChecklist(raw: unknown): ChecklistItem[] {
  if (!Array.isArray(raw)) throw new Error('checklist must be an array')
  if (raw.length > MAX_CHECKLIST_ITEMS) {
    throw new Error(`checklist may hold at most ${MAX_CHECKLIST_ITEMS} items`)
  }
  return raw.map((entry): ChecklistItem => {
    if (typeof entry !== 'object' || entry === null) throw new Error('checklist item must be an object')
    const row = entry as Record<string, unknown>
    const text = normalizeChecklistText(typeof row.text === 'string' ? row.text : '')
    const id = typeof row.id === 'string' && row.id.trim().length > 0 ? row.id.trim() : newChecklistItemId()
    const checked = row.checked === true
    const checkedBy = typeof row.checkedBy === 'string' ? row.checkedBy.trim().slice(0, 100) : undefined
    const checkedAt = typeof row.checkedAt === 'number' && Number.isFinite(row.checkedAt) ? row.checkedAt : undefined
    const note = typeof row.note === 'string' && row.note.trim().length > 0 ? row.note.trim().slice(0, 400) : undefined
    if (!checked) return { id, text, checked: false }
    return {
      id,
      text,
      checked: true,
      ...(checkedBy !== undefined && checkedBy.length > 0 ? { checkedBy } : {}),
      ...(checkedAt !== undefined ? { checkedAt } : {}),
      ...(note !== undefined ? { note } : {}),
    }
  })
}

const REPORT_LIST_CAPS = { changedFiles: 50, checks: 50, artifacts: 30 } as const

const REPORT_ENTRY_MAX = 300

function normalizeReportList(raw: unknown, field: keyof typeof REPORT_LIST_CAPS): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error(`report.${field} must be an array of strings`)
  const out = raw.map(entry => {
    if (typeof entry !== 'string') throw new Error(`report.${field} must be an array of strings`)
    const text = entry.trim()
    if (text.length === 0 || text.length > REPORT_ENTRY_MAX) {
      throw new Error(`report.${field} entries must be 1..${REPORT_ENTRY_MAX} characters`)
    }
    return text
  })
  if (out.length > REPORT_LIST_CAPS[field]) {
    throw new Error(`report.${field} may hold at most ${REPORT_LIST_CAPS[field]} entries`)
  }
  return out
}

export function normalizeExecutionReport(raw: unknown): ExecutionReport {
  if (typeof raw !== 'object' || raw === null) throw new Error('report must be an object')
  const source = raw as Record<string, unknown>
  const summary = typeof source.summary === 'string' ? source.summary.trim() : ''
  if (summary.length === 0 || summary.length > 2000) {
    throw new Error('report.summary must be 1..2000 characters')
  }
  const risk = typeof source.risk === 'string' ? source.risk.trim().slice(0, 2000) : ''
  return {
    summary,
    changedFiles: normalizeReportList(source.changedFiles, 'changedFiles'),
    checks: normalizeReportList(source.checks, 'checks'),
    artifacts: normalizeReportList(source.artifacts, 'artifacts'),
    risk,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON import validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Skeleton check for a record apart from `status`. Nothing is rebuilt here; only shapes that
 * would break downstream are rejected, because ids, cron and timestamps must survive a
 * reload unchanged.
 *
 * `comments` is deliberately not checked: records may still carry a comments array, and
 * checking it would judge the whole ledger corrupt on load.
 */
function looksLikeTaskRecord(raw: unknown): raw is Record<string, unknown> & { status: string } {
  if (typeof raw !== 'object' || raw === null) return false
  const task = raw as Record<string, unknown>
  if (typeof task.id !== 'string' || !isValidTaskId(task.id)) return false
  if (typeof task.title !== 'string' || task.title.length === 0) return false
  if (typeof task.workspaceId !== 'string' || task.workspaceId.length === 0) return false
  if (typeof task.status !== 'string') return false
  if (!Array.isArray(task.executions)) return false
  if (typeof task.execution !== 'object' || task.execution === null) return false
  return (task.execution as { mode?: unknown }).mode !== undefined
}

export function isPlausibleTaskRecord(raw: unknown): boolean {
  return looksLikeTaskRecord(raw) && ALL_STATUSES.includes(raw.status as TaskStatus)
}

/**
 * Loading/migration only: such records are set aside and moved into issues. Nothing else may
 * accept them, since pending planning is already an issue in the data model.
 */
export function isBacklogStageTask(raw: unknown): boolean {
  return looksLikeTaskRecord(raw) && raw.status === BACKLOG_STAGE_STATUS
}

/**
 * Skeleton check for a record apart from `status`. Nothing is rebuilt here; only shapes that
 * would break downstream are rejected, because ids, cron and timestamps must survive a
 * reload unchanged.
 *
 * `comments` is deliberately not checked: records may still carry a comments array, and
 * checking it would judge the whole ledger corrupt on load.
 */

function strOr(raw: Record<string, unknown>, key: string, fallback: string): string {
  const value = raw[key]
  return typeof value === 'string' ? value : fallback
}

function numOr(raw: Record<string, unknown>, key: string, fallback: number): number {
  const value = raw[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
