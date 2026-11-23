/**
 * Project an issue summary from the full record. Pure, no I/O.
 *
 * The panel's `/state` payload and the persisted index row in `castboard-issue.json` must
 * have exactly the same shape; a field dropped here shows up as a missing badge. So the
 * summary is written out field by field instead of spreading the record.
 *
 * @module dsh-magica-castboard/host/ledger/issue-derive
 */
import type { IssueRecord, IssueSummary } from '../model.ts'

// Array order is output order. These precede createdAt in IssueSummary, which is also the
// key order of the persisted index.
const OPTIONAL_COLUMNS = ['projectId', 'source', 'assigner', 'assigneeTask', 'routeAttempts', 'routeNextTryAt', 'routeError'] as const

type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number]

// List-driven so adding a column cannot silently drop the field name.
function pickOptionalColumns(
  record: Pick<IssueRecord, OptionalColumn>,
): Pick<IssueSummary, OptionalColumn> {
  const picked: Partial<Record<OptionalColumn, unknown>> = {}
  for (const column of OPTIONAL_COLUMNS) {
    const value = record[column]
    if (value !== undefined) picked[column] = value
  }
  return picked as Pick<IssueSummary, OptionalColumn>
}

/**
 * The 10-field summary.
 *
 * Body, meta, and routing bookkeeping stay in the detail view only.
 */
export function summarizeIssue(issue: IssueRecord): IssueSummary {
  const { id, title, workspaceId, urgency, status, createdAt, updatedAt, ...rest } = issue
  return {
    id,
    title,
    workspaceId,
    urgency,
    status,
    ...pickOptionalColumns(rest),
    createdAt,
    updatedAt,
  }
}
