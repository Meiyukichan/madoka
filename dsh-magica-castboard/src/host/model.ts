/**
 * Host-side data shapes and the `/api/castboard` wire contract.
 *
 * Persisted records (task ledger, issue ledger, link table, comment streams), the value
 * domains and caps they share, and the request/response bodies all live here. The
 * browser-side view contract is `src/shared/wire.ts`; because this file only serves the
 * host it may mention ledger details the client bundle should never ship.
 *
 * Two invariants worth repeating at this level: an issue's primary key is `id` (never
 * `issueId` — that name is reserved for a task pointing at its source issue), and every
 * field name, default and limit below is part of the on-disk protocol, so changing one
 * breaks already-persisted data. External session-framework types are never imported;
 * shapes such as settlements are restated as structured subsets.
 *
 * @module dsh-magica-castboard/host/model
 */
import type { TaskStatus } from './rules.ts'

/** Re-exported for modules that only need record shapes; the state machine itself is in `rules.ts`. */
export type { TaskStatus }

// ─────────────────────────────────────────────────────────────────────────────
// Shared vocabulary: urgency, actor, comment, source channel, id character set
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Five levels, tightest first. `runtime` / `direct` are shared-store execution paths;
 * `urgent` / `normal` / `relaxed` are board priorities. Array order is the sort weight.
 */
export type Urgency = 'runtime' | 'direct' | 'urgent' | 'normal' | 'relaxed'

export const URGENCIES: readonly Urgency[] = ['runtime', 'direct', 'urgent', 'normal', 'relaxed']

export type Actor =
  | { kind: 'user' }
  | { kind: 'agent'; sessionId?: string }
  | { kind: 'system' }

/**
 * A progress/report comment, shared by tasks and issues. `systemKey` / `systemParams` are
 * the i18n source for host-generated text; `body` keeps a Chinese fallback for agent tools,
 * CSV export and raw JSON inspection.
 */
export type CommentRecord = {
  id: string
  body: string
  createdAt: number
  threadId?: string
  systemKey?: string
  systemParams?: Record<string, string>
}

export { IM_SOURCE, isImSource } from '../shared/wire.ts'

// Path-safety boundary, not just a format rule: ids are concatenated into `<id>.json`.
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/

export function isValidId(id: string): boolean {
  return ID_SHAPE.test(id)
}

export function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution permissions, board settings and limits
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors the host's three sandbox modes. */
export type PermissionMode = 'workspace-write' | 'read-only' | 'danger-full-access'

export const DEFAULT_PERMISSION: PermissionMode = 'workspace-write'

/**
 * Persisted to `castboard.settings.yaml`. Only explicitly changed fields are present;
 * consumers apply factory defaults to the rest (see the `*Of` / `*Enabled` helpers in
 * `rules.ts`).
 */
export type BoardSettings = {
  defaultPermission?: PermissionMode
  /** Each execution is a whole agent session. */
  maxConcurrent?: number
  autoRoute?: boolean
  /** Run one portrait batch immediately after startup (default false). */
  portraitRunOnStart?: boolean
  /** Turning this off only stops receiving; local comments are still written and uploaded. */
  commentsEnabled?: boolean
  commentPollMs?: number
  /** Report task-session interactions as issue control comments. */
  interactionReportEnabled?: boolean
}

export const MIN_MAX_CONCURRENT = 1

export const MAX_MAX_CONCURRENT = 20

export const DEFAULT_MAX_CONCURRENT = 4

export const MAX_CHECKLIST_ITEMS = 30

export const MAX_CHECKLIST_TEXT = 200

export const MAX_TAGS = 12

export const MAX_TAG_TEXT = 30

export const MAX_ACCEPTANCE_PER_TASK = 10

// ─────────────────────────────────────────────────────────────────────────────
// Acceptance strategies (`castboard-strategy.json`)
// ─────────────────────────────────────────────────────────────────────────────

export const ACCEPTANCE_STRATEGY_SCHEMA_VERSION = 1

export const MAX_ACCEPTANCE_STRATEGIES = 100

export const MAX_ACCEPTANCE_TITLE_CHARS = 80

export const MAX_ACCEPTANCE_TEXT_CHARS = 4000

/**
 * What a strategy does with its verdict: `issue` distributes a follow-up issue, `close`
 * moves the card from review straight to done.
 */
export const ACCEPTANCE_TYPES = ['issue', 'close'] as const

export type AcceptanceType = (typeof ACCEPTANCE_TYPES)[number]

export interface AcceptanceStrategy {
  id: string
  title: string
  type: AcceptanceType
  description: string
}

/** Array order is the priority. */
export interface AcceptanceStrategyFile {
  schemaVersion: number
  strategies: AcceptanceStrategy[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Task records
// ─────────────────────────────────────────────────────────────────────────────

export type ExecutionMode = 'queue' | 'scheduled'

/**
 * Only `mode` and `cron` are stored. "Next run" is derived by cron at arm time, so a
 * persisted copy would only go stale — and because the scheduler recomputes from the
 * current time, windows missed while the host was down are not replayed.
 */
export interface ExecutionConfig {
  mode: ExecutionMode
  /** Five fields (minute hour day month weekday); required for `scheduled`. */
  cron?: string
}

/**
 * The structured report an agent submits at handoff. It is the only change record a
 * reviewer sees (the host collects no git evidence itself), so the executor has to fill in
 * the lists below carefully.
 */
export type ExecutionReport = {
  summary: string
  /** ≤50 entries × 300 characters. */
  changedFiles: string[]
  /** ≤50 entries × 300 characters. */
  checks: string[]
  /** ≤30 entries × 300 characters. */
  artifacts: string[]
  /** ≤2000 characters; may be an empty string. */
  risk: string
}

/** One acceptance-checklist item (DoD). */
export type ChecklistItem = {
  id: string
  /** 1..200 characters. */
  text: string
  checked: boolean
  /** The execution session id, or `'user'` when checked by hand in the GUI. */
  checkedBy?: string
  checkedAt?: number
  /** Evidence note added when checking (≤400 characters). */
  note?: string
}

/**
 * One attempt. `assist` marks a round that only keeps the session working (dispatch,
 * automatic acceptance, comment wake-ups) and never moves the card state; `transient`
 * marks a round disposed on finish that never enters the resident session pool.
 */
export type ExecutionRecord = {
  id: string
  sessionId?: string
  trigger: 'manual' | 'scheduled' | 'dispatch' | 'followup' | 'issue-dispatch' | 'acceptance' | 'issue-comment'
  assist?: boolean
  transient?: boolean
  startedAt?: number
  endedAt?: number
  outcome: 'running' | 'succeeded' | 'failed' | 'cancelled'
  error?: string
  report?: ExecutionReport
  hostInstanceId?: string
  hostPid?: number
}

export const EXECUTION_TRIGGERS: readonly ExecutionRecord['trigger'][] = [
  'manual',
  'scheduled',
  'dispatch',
  'followup',
  'issue-dispatch',
  'acceptance',
  'issue-comment',
]

export type TaskModel = {
  provider: string
  model: string
}

/**
 * A full card record. Comments are deliberately absent: they belong to the issue (or a
 * manual card's anchor) and live in `comments/<anchorId>.jsonl`. Copying them onto every
 * card would make each `mutate` cost a ledger-sized copy and let two cards on one issue
 * drift apart.
 */
export type TaskRecord = {
  id: string
  title: string
  detail: string
  workspaceId: string
  /** Only the path identifies a project across instances; `workspaceId` is local. */
  cwd?: string
  urgency: Urgency
  status: TaskStatus
  /** Horizontal flag: stuck, but valid on any non-terminal state. */
  blocked: boolean
  /** Cross-references the issue's `assigneeTask`. */
  issueId?: string
  /** Copied from the issue so the scheduling hot path never reads the issue ledger. */
  source?: string
  derivedIssues?: string[]
  execution: ExecutionConfig
  reference?: { dag?: string; proposal?: string }
  /** Shown to the executor only; never consulted by transitions. */
  tags?: string[]
  model?: TaskModel
  presetId?: string
  permission?: PermissionMode
  checklist?: ChecklistItem[]
  /** Object form; array order is priority. */
  acceptanceStrategies?: AcceptanceStrategy[]
  /** Read-only compatibility with the id-only form; new writes store full objects. */
  acceptanceStrategyIds?: string[]
  acceptanceInjectedAt?: number
  acceptanceFailedAt?: number
  /** Only present while `in_progress`. */
  claimedBy?: string
  claimedAt?: number
  /** Set by cron when the card enters the backlog; consumed when it starts. */
  releasedAt?: number
  createdAt: number
  updatedAt: number
  createdBy: Actor
  updatedBy: Actor
  executions: ExecutionRecord[]
  /** Older records dropped by the retention cap. */
  executionsPruned?: number
  trashedAt?: number
}

export const MAX_EXECUTIONS = 20

export function pruneExecutions(task: TaskRecord): void {
  if (task.executions.length <= MAX_EXECUTIONS) return
  const dropped = task.executions.length - MAX_EXECUTIONS
  task.executions = task.executions.slice(-MAX_EXECUTIONS)
  task.executionsPruned = (task.executionsPruned ?? 0) + dropped
}

export type TaskLedger = {
  schemaVersion: number
  /** Monotonic; bumped on every change. */
  revision: number
  tasks: TaskRecord[]
  /**
   * @deprecated Legacy location of the board settings, read only to migrate into
   * `castboard.settings.yaml`; never written back. Import files may still carry it.
   */
  settings?: BoardSettings
}

export const LEDGER_SCHEMA_VERSION = 1

export function emptyLedger(): TaskLedger {
  return { schemaVersion: LEDGER_SCHEMA_VERSION, revision: 0, tasks: [] }
}

/**
 * What a card can render, and the line persisted in `castboard-task.json`. Full details are
 * fetched only when a card opens; the summary is recomputed on every `mutate` and shipped
 * whole on every 5-second poll, so a new field has to be something the card really shows.
 */
export type TaskSummary = {
  id: string
  title: string
  workspaceId: string
  cwd?: string
  urgency: Urgency
  status: TaskStatus
  blocked: boolean
  issueId?: string
  /** Read by the dispatcher and the execution gate to decide concurrency. */
  source?: string
  executionMode: ExecutionMode
  /** Only for `scheduled`; the next fire time is derived, not stored. */
  cron?: string
  model?: TaskModel
  permission?: PermissionMode
  claimOwner?: string
  claimedAt?: number
  releasedAt?: number
  /** Derived by `/state` from the link table; never persisted. */
  hasUnreadComments?: boolean
  /** Used by CSV export. */
  executionCount: number
  lastExecutionOutcome?: ExecutionRecord['outcome']
  /** Lets the card jump to the session. */
  lastSessionId?: string
  checklist?: { done: number; total: number }
  acceptanceStrategyCount?: number
  acceptanceFailed?: boolean
  dispatching?: boolean
  accepting?: boolean
  acceptanceKind?: 'close' | 'issue'
  dispatchedIssueCount?: number
  /** Computed per response; never persisted. */
  nextRunAt?: number
  trashed: boolean
  /** Used by startup reconciliation. */
  hasRunning: boolean
  createdAt: number
  updatedAt: number
}

/**
 * Session settlement — the structured subset this plugin uses (without depending on
 * the external session framework's package)
 */

export type TurnEndKind = 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted' | 'forked'

export type TurnEndReasonLike = { kind: TurnEndKind } & Record<string, unknown>

export type TurnSettlementLike = {
  reason?: TurnEndReasonLike
  kind?: TurnEndKind
  completed: boolean
  texts: string[]
  externallyDisposed: boolean
  timedOut?: boolean
}

export type RunRequestResult =
  | { ok: true; executionId: string; sessionId: string }
  | { ok: false; error: string }

export type CancelRequestResult =
  | { ok: true; executionId: string }
  | { ok: false; error: string }

export interface SettlePlan {
  outcome: 'succeeded' | 'failed' | 'cancelled'
  /** `undefined` means leave the status alone (handoff was followed and the run succeeded). */
  to?: 'todo'
  error?: string
}

export type SessionArchiveResult = {
  archived: string[]
  failed: Array<{ sessionId: string; error: string }>
  unsupported: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Task templates
// ─────────────────────────────────────────────────────────────────────────────

/** Initial values for the new-task form, not a persisted record. */
export type TaskTemplateSpec = {
  title?: string
  detail?: string
  urgency?: string
  execution?: { mode?: string; cron?: string }
  model?: TaskModel
  presetId?: string
  permission?: string
  checklist?: string[]
}

export type TemplateLocales = {
  readonly zh: { name: string; task: TaskTemplateSpec }
  readonly en: { name: string; task: TaskTemplateSpec }
}

export type TaskTemplate = {
  id: string
  name: string
  task: TaskTemplateSpec
  /** Built-ins are read-only; a user template with the same id shadows one. */
  builtin?: boolean
  locales?: TemplateLocales
  createdAt?: number
  updatedAt?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue ledger (pending planning)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The shared store's seven values. "Converted" is not a status of its own: it is `routing`
 * plus a value in `assigneeTask`. Deletion uses `abandoned`, which keeps the record
 * traceable.
 */
export type IssueStatus = 'pending' | 'accepted' | 'routing' | 'running' | 'success' | 'failed' | 'abandoned'

export const ISSUE_STATUSES: readonly IssueStatus[] = [
  'pending',
  'accepted',
  'routing',
  'running',
  'success',
  'failed',
  'abandoned',
]

/**
 * The three states of the "pending planning" column, in sort order within the column:
 * routing (converted, kept as a marker) → accepted (claimed here) → pending (new).
 */
export const PLANNING_ISSUE_STATUSES: readonly IssueStatus[] = ['routing', 'accepted', 'pending']

/**
 * The only statuses a remote sync may overwrite. Everything else (routing, abandoned, the
 * three remote execution states) is a decision this host already made; overwriting it
 * would undo work.
 */
export const MERGEABLE_ISSUE_STATUSES: readonly IssueStatus[] = ['pending', 'accepted']

/** Beyond this an issue never enters planning; creation rejects the whole batch. */
export const MAX_DEPENDS_ON = 50

export type IssueMeta = Record<string, unknown>

/**
 * The full issue record (`issues/<id>.json`), field-for-field with the shared store's issue
 * table in camelCase. The one rename is `issue_id` → `id`, which is both the local record
 * id and the merge key; `title` / `detail` are duplicated projections of `assignerMeta` so
 * the board can render without parsing. `workspaceId` is local and may legitimately be
 * empty when a pulled issue matches no local project.
 */
export interface IssueRecord {
  id: string
  projectId?: number
  title: string
  detail: string
  assigner?: string
  /** The task this was split from. */
  assignerTask?: string
  assignerMeta?: IssueMeta
  /** The only cross-instance project key. */
  cwd?: string
  urgency: Urgency
  /** Falls back to the board default when absent. */
  permission?: PermissionMode
  assignee?: string
  /** The task it became (present while `routing`). */
  assigneeTask?: string
  assigneeInstance?: string
  assigneeMeta?: IssueMeta
  status: IssueStatus
  source?: string
  sourceInstance?: string
  /**
   * This issue enters planning only after all of these are `success`. The server stores
   * the list but does not judge it; the gate lives in the router. `undefined` = none.
   */
  dependsOn?: string[]
  createdAt: number
  assignedAt?: number
  updatedAt: number
  routerSessionId?: string
  routeAttempts?: number
  /** Not cleared after a successful conversion, for later diagnosis. */
  routeError?: string
  routeNextTryAt?: number
  workspaceId: string
}

/** Display fields only: this is the panel's in-memory index, so it carries nothing else. */
export interface IssueSummary {
  id: string
  projectId?: number
  title: string
  workspaceId: string
  urgency: Urgency
  status: IssueStatus
  source?: string
  assigner?: string
  assigneeTask?: string
  routeAttempts?: number
  routeNextTryAt?: number
  routeError?: string
  createdAt: number
  updatedAt: number
}

export const ISSUE_SCHEMA_VERSION = 1

export const WORKSPACES_CUSTOM_SCHEMA_VERSION = 1

export const MAX_WORKSPACE_NOTES = 200

export const MAX_WORKSPACE_NOTE_CHARS = 2000

/** Keyed by workspace id, not title or path: projects get renamed and moved, ids do not. */
export interface WorkspacesCustom {
  schemaVersion: number
  workspaces: Record<string, string>
}

export const STRATEGY_CUSTOM_SCHEMA_VERSION = 1

export const MAX_STRATEGIES = 100

export const MAX_STRATEGY_TITLE_CHARS = 80

export const MAX_STRATEGY_DESC_CHARS = 4000

export interface RouterStrategy {
  id: string
  title: string
  description: string
}

/** Array order is priority. */
export interface StrategyCustom {
  schemaVersion: number
  strategies: RouterStrategy[]
}

/**
 * Process-level bookkeeping for the resident router session: which temp session is doing
 * conversions. After a restart it is recovered by `sessionId`; if that fails the id is
 * dropped and the session rebuilt.
 */
export interface IssueRouterState {
  sessionId?: string
  createdAt?: number
  updatedAt?: number
  lastIssueId?: string
  /** Reset on a successful conversion; the session is rebuilt at the threshold. */
  failures?: number
  lastError?: string
}

export interface IssueIndexFile {
  schemaVersion: number
  revision: number
  router?: IssueRouterState
  issues: readonly IssueSummary[]
}

export interface IssueDraft {
  projectId?: number
  title: string
  detail: string
  workspaceId: string
  urgency: Urgency
  assigner?: string
  assignerTask?: string
  assignerMeta?: IssueMeta
  cwd?: string
  permission?: PermissionMode
  assignee?: string
  assigneeTask?: string
  assigneeInstance?: string
  assigneeMeta?: IssueMeta
  source?: string
  sourceInstance?: string
  dependsOn?: string[]
  createdAt?: number
  assignedAt?: number
}

/**
 * An already-normalized issue pulled from the server. Normalization (meta, epoch ms, cwd
 * matching) happens in the sync layer; this type only feeds the field-by-field merge, and
 * its fields use the same names and meanings as {@link IssueRecord}.
 */
export interface RemoteIssueDraft {
  id: string
  projectId?: number
  title: string
  detail: string
  assigner?: string
  assignerTask?: string
  assignerMeta?: IssueMeta
  cwd?: string
  urgency: Urgency
  permission?: PermissionMode
  assignee?: string
  assigneeTask?: string
  assigneeInstance?: string
  assigneeMeta?: IssueMeta
  source?: string
  sourceInstance?: string
  dependsOn?: string[]
  /** Defaults to `pending`; claimed rows become `accepted`. */
  status?: IssueStatus
  /** Matched project id, or the empty string. */
  workspaceId: string
  createdAt?: number
}

/**
 * Five mutually exclusive buckets; only `inserted` and `updated` are written.
 */
export interface RemoteMergeReport {
  inserted: string[]
  updated: string[]
  /** Local state is no longer mergeable, so the server copy was ignored. */
  skipped: string[]
  /** Same fields, nothing written. */
  unchanged: string[]
  /** Unsafe ids that cannot become filenames. */
  rejected: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Link table (`castboard-link.json`) and comment streams
// ─────────────────────────────────────────────────────────────────────────────

export type CommentSide = 'assigner' | 'assignee'

export const COMMENT_SIDES: readonly CommentSide[] = ['assigner', 'assignee']

/**
 * Ids and timestamps only. The table exists to hold columns found nowhere else (the two
 * session ids, unread/pending markers, server existence); copies of title or status would
 * only drift.
 */
export type IssueLink = {
  assignerSessionId?: string
  assigneeTaskId?: string
  /** Authoritative at delivery time, not a cache. */
  assigneeSessionId?: string
  lastSeenAt?: number
  /** `lastCommentAt > lastSeenAt` means unread. */
  lastCommentAt?: number
  /** Cleared once the comment is delivered. */
  assignerPendingSince?: number
  assigneePendingSince?: number
}

export type LinkIndexFile = {
  schemaVersion: number
  revision: number
  links: Record<string, IssueLink>
}

export const LINK_SCHEMA_VERSION = 1

/**
 * Write patch: `undefined` skips a key, `null` deletes it. Only the pending markers need
 * deletion (after a successful delivery); everything else is simply overwritten.
 */
export type IssueLinkPatch = { [K in keyof IssueLink]?: IssueLink[K] | null }

/**
 * A comment goes to the side opposite the one that wrote it: `assignee` writes reach
 * `assignerSessionId`, everything else (including unknown) reaches `assigneeSessionId`.
 *
 * Mind the naming: `assigneeSessionId` means "the assignee's session", not "the target on
 * the assignee side".
 */
export function oppositeSide(role: string | null | undefined): CommentSide {
  return role === 'assignee' ? 'assigner' : 'assignee'
}

/** `undefined` means no target on this host (cross-machine), which is normally skipped. */
export function targetSessionId(link: IssueLink | undefined, role: string | null | undefined): string | undefined {
  if (link === undefined) return undefined
  return oppositeSide(role) === 'assigner' ? link.assignerSessionId : link.assigneeSessionId
}

export function mergeLink(base: IssueLink | undefined, patch: IssueLinkPatch): IssueLink {
  const next: Record<string, unknown> = { ...base }
  for (const key of Object.keys(patch) as Array<keyof IssueLink>) {
    const value = patch[key]
    if (value === null) delete next[key]
    else if (value !== undefined) next[key] = value
  }
  return next as IssueLink
}

/** One source of truth for the field names; do not hand-write them at call sites. */
export function pendingFieldOf(side: CommentSide): 'assignerPendingSince' | 'assigneePendingSince' {
  return side === 'assigner' ? 'assignerPendingSince' : 'assigneePendingSince'
}

export function targetsSide(comment: { readonly role: string | null }, side: CommentSide): boolean {
  return oppositeSide(comment.role) === side
}

export function isEmptyLink(link: IssueLink): boolean {
  return Object.values(link).every(value => value === undefined)
}

export type CommentOrigin = 'local' | 'remote'

export type ThreadCommentAuthorType = 'user' | 'agent' | 'system'

export const THREAD_AUTHOR_TYPES: readonly ThreadCommentAuthorType[] = ['user', 'agent', 'system']

/**
 * One JSONL line. The file is append-only, so a comment costs one line regardless of
 * ledger size. Local lines mint a standard UUID; remote lines use the server's
 * `commentId`, which doubles as the idempotency and dedup key.
 */
export type ThreadComment = {
  id: string
  body: string
  createdAt: number
  /** `null` = unknown, or written from the web UI. */
  role: CommentSide | null
  authorType: ThreadCommentAuthorType
  /** `local` still needs uploading; `remote` never is. */
  origin: CommentOrigin
  threadId?: string
  author?: string
  systemKey?: string
  systemParams?: Record<string, string>
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire protocol: request and response bodies of `/api/castboard`
// ─────────────────────────────────────────────────────────────────────────────

/** Same as a stored strategy except `id` is optional; the host mints one from title and type. */
export type AcceptanceStrategyInput = {
  id?: string
  title: string
  type: AcceptanceType
  description: string
}

export type ApiErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'invalid_transition'
  | 'forbidden'
  | 'internal'

export type ApiOk<T> = { ok: true; value: T }

export type ApiFail = { ok: false; error: { code: ApiErrorCode; message: string } }

export type ApiResult<T> = ApiOk<T> | ApiFail

export interface PendingQuestionLike {
  id: string
  question: string
  detail?: string
  header?: string
  options?: ReadonlyArray<{ label: string; description?: string }>
  multiSelect?: boolean
  /** Raw dsh tool spelling; accepted alongside `multiSelect`. */
  multi_select?: boolean
  waitCallId?: string
  waitTimed?: boolean
}

/** Borrowed record shape; the session framework's interaction endpoint owns the data. */
export type PendingInteractionRecord =
  | {
      kind: 'question'
      id: string
      sessionId: string
      since: number
      questions: PendingQuestionLike[]
    }
  | {
      kind: 'approval'
      id: string
      sessionId: string
      since: number
      args?: string
      callId?: string
      toolName: string
      reason?: string
      displayReason?: Record<string, string>
    }

/**
 * The full `GET /state` snapshot. The board polls and never opens a server stream; a
 * request carrying a matching `?since=` gets {@link StateUnchanged} instead.
 */
export type StateResponse = {
  schemaVersion: number
  revision: number
  tasks: TaskSummary[]
  /** Only `pending`; converted issues stay off the polling path. */
  issues: IssueSummary[]
  issueRevision: number
  /** Sent only in a full snapshot. */
  interactions?: PendingInteractionRecord[]
  /** `kind:id@since`, sorted; the empty set is the empty string. */
  interactionRevision?: string
  /** A comment arriving bumps only this. */
  linkRevision?: string
  /** Links that carry comments, for the unread badges. */
  issueLinks?: Record<string, { lastCommentAt: number; lastSeenAt?: number; hasUnread: boolean }>
  version?: string
  capabilities?: { archiveSessions: boolean }
}

export type StateUnchanged = {
  unchanged: true
  revision: number
  issueRevision: number
  interactionRevision?: string
  linkRevision?: string
}

export type StatePollResponse = StateResponse | StateUnchanged

export type CreateTaskBody = {
  title: string
  workspaceId: string
  /** Omitted means the host derives it from `workspaceId`; issue-converted cards carry the issue's cwd. */
  cwd?: string
  urgency: Urgency
  detail?: string
  /** `scheduled` requires a schedulable `cron`. */
  execution?: { mode?: string; cron?: string }
  model?: TaskModel
  presetId?: string
  permission?: PermissionMode
  /** Texts only; the host mints ids, all unchecked. */
  checklist?: string[]
  acceptanceStrategyIds?: string[]
  /** One-off strategies carried by this card; never written to the strategy file. */
  acceptanceStrategies?: AcceptanceStrategyInput[]
  status?: 'todo'
  issueId?: string
}

export type DeleteIssueResponse = { deleted: true }

export type CreateIssueBody = {
  projectId?: number
  title: string
  detail?: string
  assignee: string
  assigneeInstance?: string
  cwd?: string
  urgency?: Urgency
  permission?: PermissionMode
  assignerMeta?: Record<string, unknown>
  /** Absolute local paths. */
  attachments?: string[]
}

export type CreateIssueResponse = { issueId: string; assignee: string }

export type PortraitRefreshResponse = { reset: number }

export type IssueDetailResponse = IssueRecord

export interface IssueStateResponse {
  /** `cloud` means the local mirror has no record and the shared store answered. */
  source: 'mirror' | 'cloud'
  /** Wide shape: remote and local records differ, so the UI reads only the fields it knows. */
  issue: Record<string, unknown> & {
    id?: string
    title?: string
    detail?: string
    status?: string
    urgency?: string
    comments?: Array<Record<string, unknown>>
  }
  comments?: ThreadComment[]
}

export interface IssueThreadResponse {
  issueId: string
  comments: ThreadComment[]
}

export type IssueCommentResponse = ThreadComment

export interface DispatchedIssuesResponse {
  issues: Array<{
    issueId: string
    title?: string
    status?: string
    urgency?: string
    assignee?: string
    hasUnread: boolean
    lastCommentAt?: number
    assigneeTaskId?: string
  }>
  /** Beyond 50 entries, newest activity first. */
  truncated: boolean
}

/** `id` is optional and minted by normalization when missing. */
export type ChecklistDraftItem = Omit<ChecklistItem, 'id'> & { id?: string }

/**
 * Omitted fields stay unchanged; `null` clears a field (model, preset, permission,
 * checklist, strategy lists).
 */
export type UpdateTaskBody = {
  title?: string
  detail?: string
  urgency?: Urgency
  blocked?: boolean
  workspaceId?: string
  execution?: { mode?: string; cron?: string }
  model?: TaskModel | null
  presetId?: string | null
  permission?: PermissionMode | null
  checklist?: ChecklistDraftItem[] | null
  acceptanceStrategyIds?: string[] | null
  acceptanceStrategies?: AcceptanceStrategyInput[] | null
}

export type MoveTaskBody = { status: TaskStatus; archiveSessions?: boolean }

export type MoveTaskResponse = TaskSummary & { sessionArchive?: SessionArchiveResult }

/**
 * Comments are read from the jsonl and appended, so the detail is one complete timeline;
 * the summary does not carry them.
 */
export type TaskDetailResponse = TaskRecord & {
  comments?: ThreadComment[]
  issues?: Array<{ id: string; title?: string; status?: string; urgency?: string; createdAt?: number }>
  nextRunAt?: number
}

export type DispatchTaskBody = {
  text: string
  /** String form of the numeric group id. */
  projectId?: string
  assignee?: string
  assigneeInstance?: string
}

export type IssueTargetsResponse = {
  online: boolean
  projects: Array<{ id: string; name: string }>
  members: Array<{ account: string; name?: string }>
  instances: Array<{ instance: string; label?: string }>
  selfAccount?: string
  localInstance?: string
}

/** A missing `nextRunAt` means "cannot be scheduled", not an error. */
export type CronPreviewResponse = { cron: string; nextRunAt?: number }

export type RejectTaskBody = { body?: string }

/** `steered` says whether the text actually reached a running session. */
export type CommentTaskResponse = { id: string; body: string; createdAt: number; steered: boolean }

/** `purge` erases physically. */
export type DeleteTaskBody = { purge?: boolean }

export type DeleteTaskResponse = { trashed?: boolean; purged?: boolean }

/** 202: the session this run opened. */
export type RunTaskResponse = { executionId: string; sessionId: string; started?: boolean }

export type CancelTaskResponse = { cancelled: true; executionId: string }

export type DiagnosticsResponse = {
  revision: number
  tasks: number
  /** Executions still marked `running`. */
  staleRunning: number
}

export type TemplatesResponse = { templates: TaskTemplate[] }

export type SettingsResponse = BoardSettings

export type WorkspacesCustomResponse = WorkspacesCustom

export type StrategyCustomResponse = StrategyCustom

export type AcceptanceStrategyResponse = AcceptanceStrategyFile

export type UpdateSettingsBody = {
  defaultPermission?: PermissionMode
  /** 1..20; omitted = environment variable / factory default. */
  maxConcurrent?: number
  autoRoute?: boolean
  portraitRunOnStart?: boolean
  commentsEnabled?: boolean
  /** 1000..3600000 ms; omitted = environment variable / 5 seconds. */
  commentPollMs?: number
}
