/**
 * 轮询端点：`/state` 的四游标快照。
 *
 * @module dsh-magica-castboard/client/data/endpoints/live
 */
import { apiGet } from '../api.ts'
import { issueView } from './issues.ts'
import type { InteractionView, Snapshot, TaskSummaryView } from '../dto.ts'
import { modelTextOf } from './tasks.ts'

type RawSummary = TaskSummaryView & {
  trashed?: boolean
  claimOwner?: string
  executionMode?: 'queue' | 'scheduled'
  cron?: string
  checklist?: { done: number; total: number }
  nextRunAt?: number | string
  model?: unknown
}

type RawInteraction =
  | {
    kind: 'approval'
    id: string
    sessionId: string
    since: number
    toolName: string
    reason?: string
    displayReason?: unknown
    args?: string
    callId?: string
  }
  | {
    kind: 'question'
    id: string
    sessionId: string
    since: number
    questions?: readonly {
      header?: string
      question: string
      detail?: string
      options?: readonly { label: string; description?: string }[]
      multiSelect?: boolean
      multi_select?: boolean
    }[]
  }

/** Flatten localized text; the host may pass `{ zh, en }` or nested locale maps. */
function localizedText(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object' || depth > 3) return undefined
  const record = value as Record<string, unknown>
  for (const key of ['zh', 'en'] as const) {
    const text = localizedText(record[key], depth + 1)
    if (text !== undefined && text !== '') return text
  }
  for (const child of Object.values(record)) {
    const text = localizedText(child, depth + 1)
    if (text !== undefined && text !== '') return text
  }
  return undefined
}

function interactionView(raw: RawInteraction): InteractionView {
  if (raw.kind === 'approval') {
    const reason = localizedText(raw.displayReason)
    return {
      id: raw.id,
      kind: 'approval',
      sessionId: raw.sessionId,
      title: raw.toolName,
      body: reason ?? raw.reason ?? '',
      ...(raw.args === undefined ? {} : { args: raw.args }),
      createdAt: raw.since,
    }
  }
  const first = raw.questions?.[0]
  return {
    id: raw.id,
    kind: 'question',
    sessionId: raw.sessionId,
    title: first?.header ?? 'Question',
    body: first === undefined ? '' : `${first.question}${first.detail === undefined ? '' : `\n${first.detail}`}`,
    ...(first?.options === undefined ? {} : {
      options: first.options.map(option => option.label),
      optionDetails: first.options.map(option => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    }),
    ...(first?.multiSelect === true || first?.multi_select === true ? { multiSelect: true } : {}),
    createdAt: raw.since,
  }
}

function summaryView(raw: RawSummary): TaskSummaryView {
  const model = modelTextOf(raw.model)
  const execution = raw.execution ?? (raw.executionMode === undefined
    ? undefined
    : { mode: raw.executionMode, ...(raw.cron === undefined ? {} : { cron: raw.cron }) })
  const nextRunAt = typeof raw.nextRunAt === 'number'
    ? new Date(raw.nextRunAt).toISOString()
    : raw.nextRunAt
  const checklist = raw.checklistProgress ?? raw.checklist
  return {
    ...raw,
    ...(model === undefined ? {} : { model }),
    ...(execution === undefined ? {} : { execution }),
    ...(checklist === undefined ? {} : { checklistProgress: checklist }),
    claimedBy: raw.claimedBy ?? raw.claimOwner,
    trashedAt: raw.trashedAt ?? (raw.trashed === true ? 1 : undefined),
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
    ...(raw.runningTrigger === undefined && (raw.dispatching === true || raw.accepting === true)
      ? { runningTrigger: raw.dispatching === true ? 'dispatch' : 'acceptance' }
      : {}),
  }
}

/** 轮询看板（`since` / `issueSince` / `ixSince` / `linkSince` 都带上才走快路径）。 */
export async function apiState(cursors: { since?: number; issueSince?: number; linkSince?: string; ixSince?: string }): Promise<Snapshot | { unchanged: true; revision: number; issueRevision: number; linkRevision: number; interactionRevision?: string }> {
  const query = new URLSearchParams()
  if (cursors.since !== undefined) query.set('since', String(cursors.since))
  if (cursors.issueSince !== undefined) query.set('issueSince', String(cursors.issueSince))
  if (cursors.linkSince !== undefined) query.set('linkSince', cursors.linkSince)
  if (cursors.ixSince !== undefined) query.set('ixSince', cursors.ixSince)
  const suffix = query.toString()
  const result = await apiGet<
    Snapshot | { unchanged: true; revision: number; issueRevision: number; linkRevision: number; interactionRevision?: string }
  >(`/state${suffix === '' ? '' : `?${suffix}`}`)
  if (!('tasks' in result)) return result
  return {
    ...result,
    issues: (result.issues ?? []).map(issueView),
    tasks: result.tasks.map(task => summaryView(task as RawSummary)),
    ...(result.interactions === undefined
      ? {}
      : {
        interactions: result.interactions.map(item => ('since' in item
          ? interactionView(item as unknown as RawInteraction)
          : item)),
      }),
  }
}

