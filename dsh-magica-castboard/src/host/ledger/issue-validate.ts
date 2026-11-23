/**
 * Input validation for the issue side: allowed statuses, title/body normalization, id
 * minting, and the structural checks applied when records are read back from disk.
 *
 * Ids double as detail file names (`issues/<id>.json`) and as the merge key with the
 * shared issue library, so they have to stay path-safe. The title and body also live in
 * same-named keys on `assignerMeta`; that mirror is updated only in {@link projectMeta}.
 *
 * @module dsh-magica-castboard/host/ledger/issue-validate
 */
import { randomUUID } from 'node:crypto'

import {
  ISSUE_STATUSES,
  isValidId,
  type IssueMeta,
  type IssueRecord,
  type IssueStatus,
  type IssueSummary,
} from '../model.ts'
import { normalizeTitle } from '../rules.ts'

/** Re-exported so callers validating issue input use the same urgency vocabulary as the task side. */
export { asUrgency } from '../rules.ts'

/** Must be usable in a file path and match the shared library's `issue_id` shape. */
export function isValidIssueId(id: string): boolean {
  return isValidId(id)
}

export function newIssueId(): string {
  return randomUUID()
}

export function asIssueStatus(raw: string): IssueStatus {
  if (!(ISSUE_STATUSES as readonly string[]).includes(raw)) {
    throw new Error(`issue status must be one of: ${ISSUE_STATUSES.join(', ')}`)
  }
  return raw as IssueStatus
}

/** Task titles and issue titles share one trim + length gate. */
export function normalizeIssueTitle(raw: string): string {
  return normalizeTitle(raw)
}

/** Trim only. An empty body is valid and there is no length cap. */
export function normalizeIssueDetail(raw: string | undefined): string {
  return (raw ?? '').trim()
}

/**
 * Project title/body into `assignerMeta` without mutating the input.
 *
 * This is the single place where the projection columns and `assignerMeta` converge; a
 * second copy elsewhere would drift.
 */
export function projectMeta(meta: IssueMeta | undefined, title: string, detail: string): IssueMeta {
  return { ...meta, title, detail }
}

// An empty workspaceId is accepted and optional columns may be missing; the record only
// has to be strong enough to render a card later.
export function isPlausibleIssueRecord(raw: unknown): raw is IssueRecord {
  if (typeof raw !== 'object' || raw === null) return false
  const issue = raw as Record<string, unknown>
  return typeof issue.id === 'string'
    && isValidIssueId(issue.id)
    && typeof issue.title === 'string'
    && issue.title.length > 0
    && typeof issue.detail === 'string'
    && typeof issue.workspaceId === 'string'
    && (ISSUE_STATUSES as readonly string[]).includes(issue.status as string)
    && (issue.assignerMeta === undefined || (typeof issue.assignerMeta === 'object' && issue.assignerMeta !== null))
}

export function isPlausibleIssueSummary(raw: unknown): raw is IssueSummary {
  if (typeof raw !== 'object' || raw === null) return false
  const summary = raw as Record<string, unknown>
  return typeof summary.id === 'string'
    && isValidIssueId(summary.id)
    && typeof summary.title === 'string'
    && summary.title.length > 0
    && typeof summary.workspaceId === 'string'
    && (ISSUE_STATUSES as readonly string[]).includes(summary.status as string)
}
