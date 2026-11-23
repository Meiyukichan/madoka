/**
 * Normalization for remote payloads: collapses dirty fields returned by the shared library into locally comparable values.
 *
 * The merge rules themselves (how new records are built, how mergeable records are overwritten) live in
 * `issue-store.ts`: that is the only place guaranteeing atomicity for "read current value -> compare -> write back".
 * This module only performs stateless field cleanup, used by the pull side (`sync.ts`) when building `RemoteIssueDraft`.
 *
 * @module dsh-magica-castboard/host/pipeline/merge
 */
import { URGENCIES, type Urgency } from '../model.ts'

/** A single issue returned by the shared library (fields may be missing or dirty; it enters the ledger only after normalization). */
export interface RemoteIssue {
  issueId: string
  title?: string
  detail?: string
  status?: string
  urgency?: string
  source?: string
  assignee?: string
  assigneeInstance?: string
  projectId?: number
  createdAt?: string | number
  updatedAt?: string | number
}

/** Normalize epoch ms, zoned ISO, or zoneless `YYYY-MM-DD HH:mm[:ss]` to epoch ms; unparsable values use `fallback`. */
export function normalizeTimestamp(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  const text = value.trim()
  if (text === '') return fallback
  const numeric = Number(text)
  if (Number.isFinite(numeric) && text.length > 4) return numeric
  // The shared library's local times are interpreted as Beijing time: append +08:00 to zoned-less strings so a different server timezone cannot cause drift.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text) ? text.replace(' ', 'T') : text
  const zoned = /[+-]\d{2}:?\d{2}$|Z$/.test(iso) ? iso : `${iso}+08:00`
  const parsed = Date.parse(zoned)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function normalizeUrgency(value: string | undefined): Urgency {
  return value !== undefined && (URGENCIES as readonly string[]).includes(value) ? (value as Urgency) : 'normal'
}
