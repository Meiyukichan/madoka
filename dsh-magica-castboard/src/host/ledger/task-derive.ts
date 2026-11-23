/**
 * Task projections: pure functions that turn a full task record into the shapes used by
 * agents, the panel, and routing, plus the one function that maintains claim fields.
 *
 * cron handling is elsewhere. Its parser is only needed by scheduling callers, and these
 * projections are reused by lightweight paths that should not pay for it in bundle size.
 *
 * @module dsh-magica-castboard/host/ledger/task-derive
 */
import type { TaskRecord, TaskSummary } from '../model.ts'
import type { TaskStatus } from '../rules.ts'

type ExecutionRow = TaskRecord['executions'][number]

/**
 * Scan backwards for the first match.
 *
 * The execution history can be long and only the latest match matters, so this neither
 * copies nor reverses the array.
 */
function lastMatching<T>(rows: readonly T[], match: (row: T) => boolean): T | undefined {
  for (let cursor = rows.length - 1; cursor > -1; cursor -= 1) {
    const row = rows[cursor]
    if (row !== undefined && match(row)) return row
  }
  return undefined
}

function countAcceptanceStrategies(task: TaskRecord): number {
  return (task.acceptanceStrategyIds?.length ?? 0) + (task.acceptanceStrategies?.length ?? 0)
}

/**
 * "Accepting automatically" means in review, with strategies, and with the acceptance
 * context already injected.
 *
 * Execution records are deliberately ignored: auto-acceptance does not open a followup turn,
 * so there is never a running trigger to find.
 */
function isAccepting(task: TaskRecord, strategyCount: number): boolean {
  if (strategyCount === 0) return false
  if (task.status !== 'in_review') return false
  return task.acceptanceInjectedAt !== undefined
}

/**
 * Conditional summary fields, appended in the display order of `TaskSummary`.
 *
 * Keeping them separate leaves {@link summarize} responsible only for derived values and
 * required fields; with this many conditional keys inline, a missing one is hard to spot.
 */
function collectOptionalFields(
  task: TaskRecord,
  derived: {
    claimOwner: string | undefined
    latest: ExecutionRow | undefined
    latestSessionId: string | undefined
    strategyCount: number
    dispatching: boolean
  },
): Partial<TaskSummary> {
  const extras: Partial<TaskSummary> = {}

  if (task.cwd !== undefined) extras.cwd = task.cwd
  if (task.execution.cron !== undefined) extras.cron = task.execution.cron
  if (task.issueId !== undefined) extras.issueId = task.issueId
  // The dispatcher and execution gate rely on this to decide concurrency slots.
  if (task.source !== undefined) extras.source = task.source
  if (task.model !== undefined) extras.model = task.model
  if (task.permission !== undefined) extras.permission = task.permission

  if (derived.claimOwner !== undefined) {
    extras.claimOwner = derived.claimOwner
    // claimedAt without a holder would be dirty state.
    if (task.claimedAt !== undefined) extras.claimedAt = task.claimedAt
  }

  if (derived.latest?.outcome !== undefined) extras.lastExecutionOutcome = derived.latest.outcome
  if (task.releasedAt !== undefined) extras.releasedAt = task.releasedAt
  if (derived.latestSessionId !== undefined) extras.lastSessionId = derived.latestSessionId

  if (task.checklist !== undefined && task.checklist.length > 0) {
    extras.checklist = checklistProgress(task)
  }

  // The auto-acceptance round owns dispatch for these cards, so the card hides its manual
  // dispatch action.
  if (derived.strategyCount > 0) extras.acceptanceStrategyCount = derived.strategyCount
  if (task.acceptanceFailedAt !== undefined) extras.acceptanceFailed = true
  if (derived.dispatching) extras.dispatching = true
  if (isAccepting(task, derived.strategyCount)) extras.accepting = true

  const derivedIssues = task.derivedIssues
  if (derivedIssues !== undefined && derivedIssues.length > 0) {
    extras.dispatchedIssueCount = derivedIssues.length
  }

  return extras
}

/**
 * The instruction body for the task, without the title.
 *
 * The title is already rendered with the task reference; repeating it would make the model
 * treat the name and the requirement as separate things. An empty body, or a record with no
 * `detail`, falls back to the title so an empty message never goes out and one bad record
 * does not block dispatch.
 *
 * This value is also what gets delivered to the execution session, so tools see exactly
 * what the session receives.
 */
export function effectivePrompt(task: TaskRecord): string {
  const body = typeof task.detail === 'string' ? task.detail.trim() : ''
  return body === '' ? task.title : body
}

/**
 * The session holding the card, based only on explicit claim fields.
 *
 * Not to be confused with `hasRunning`, which reflects whether an execution is running:
 * `claimOwner` has a value only for an `in_progress` card with `claimedBy` set.
 *
 * Claiming is bookkeeping, not dispatch; a session claims only when the user names a card.
 */
export function isClaimedBy(task: TaskRecord): string | undefined {
  if (task.status !== 'in_progress') return undefined
  return task.claimedBy
}

export function checklistProgress(task: Pick<TaskRecord, 'checklist'>): { done: number; total: number } {
  const rows = task.checklist ?? []
  let done = 0
  for (const row of rows) if (row.checked) done += 1
  return { done, total: rows.length }
}

/**
 * The compact summary used by agent lists and `/state`.
 *
 * `lastExecutionOutcome` comes from the latest non-transient execution. Transient rounds are
 * a side effect of comment delivery and are disposed once finished, so they say nothing
 * about the card itself; reading the literal last entry would mark a completed card as
 * failed when its last wake-up did not start.
 *
 * Every `TaskSummary` field has to be filled in here: `/state` sends only summaries, and a
 * missing field is a missing badge.
 */
export function summarize(task: TaskRecord): TaskSummary {
  const executions = task.executions
  const latest = lastMatching(executions, row => row.transient !== true)
    ?? executions[executions.length - 1]
  const latestSession = lastMatching(executions, row => row.sessionId !== undefined)
  const strategyCount = countAcceptanceStrategies(task)

  const core: TaskSummary = {
    id: task.id,
    title: task.title,
    workspaceId: task.workspaceId,
    urgency: task.urgency,
    status: task.status,
    blocked: task.blocked,
    executionMode: task.execution.mode,
    executionCount: executions.length,
    hasRunning: executions.some(row => row.outcome === 'running'),
    trashed: task.trashedAt !== undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }

  const extras = collectOptionalFields(task, {
    claimOwner: isClaimedBy(task),
    latest,
    latestSessionId: latestSession?.sessionId,
    strategyCount,
    dispatching: executions.some(row => row.outcome === 'running' && row.trigger === 'issue-dispatch'),
  })

  return { ...core, ...extras }
}

/**
 * Clear explicit claim fields around a status change.
 *
 * Both a transition out of `in_progress` (handoff, return to todo, cancel) and a manual
 * move into `in_progress` without a holder must clear them. The second case matters because
 * a stale holder would make the UI show a session that no longer exists.
 *
 * Only an actual session claim writes `claimedBy` / `claimedAt`.
 */
export function syncClaim(task: TaskRecord, to: TaskStatus, now: number, holder?: string): void {
  if (to === 'in_progress' && holder !== undefined) {
    task.claimedBy = holder
    task.claimedAt = now
    return
  }
  delete task.claimedBy
  delete task.claimedAt
}
