/**
 * `castboard_issue_task` — the only way a planned issue becomes a task card.
 *
 * Creating the card and writing the issue back have to succeed or fail together: a card without
 * the write-back leaves the issue stuck in `routing`, and a write-back without the card leaves a
 * panel row whose `assigneeTask` points at nothing. {@link convertIssueToTask} owns that order.
 *
 * This tool only makes the model-facing decisions (cwd / urgency / permission / planning notes);
 * the caller has already validated them, so the model-planned and the pass-through paths persist
 * exactly the same data.
 *
 * @module dsh-magica-castboard/host/tools/issue-task
 */
import { eventLog } from '../shared/event-log.ts'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import {
  MAX_CHECKLIST_ITEMS,
  MAX_CHECKLIST_TEXT,
  MAX_TAGS,
  MAX_TAG_TEXT,
  isValidId,
  type AcceptanceStrategy,
  type ChecklistItem,
  type ExecutionConfig,
  type IssueMeta,
  type IssueRecord,
  type PermissionMode,
  type TaskModel,
  type TaskRecord,
  type Urgency,
} from '../model.ts'
import {
  asPermission,
  asUrgency,
  checklistFromTexts,
  newTaskId,
  normalizeAcceptanceStrategies,
  normalizeChecklist,
  normalizeChecklistTexts,
  normalizeExecution,
  normalizeModel,
  normalizeTags,
} from '../rules.ts'
import { normalizeIssueDetail, normalizeIssueTitle } from '../ledger/issue-validate.ts'
import type { IssueStore } from '../ledger/issue-store.ts'
import { patchLinkQuiet, type LinkStore } from '../ledger/link-store.ts'
import type { TaskStore } from '../ledger/task-store.ts'
import type { CommentDraft, ThreadService } from '../pipeline/thread.ts'

export interface IssueTaskToolDeps {
  readonly issues: IssueStore
  readonly store: TaskStore
  readonly now: () => number
  /** `undefined` means the directory does not exist or the registry cannot answer. */
  readonly resolveWorkspace: (cwd: string) => Promise<{ id: string; path: string } | undefined>
  /** Cloud write-back after a conversion; only records that came from the cloud get it. Best effort, never fatal. */
  readonly issueRouted?: (issueId: string, input: RouteRemoteInput) => Promise<void>
  /**
   * Issue-stage comments fetched during conversion and replayed into the new task's stream.
   *
   * Without them the executor only sees title and detail and happily re-asks things the assigner
   * already answered. Not wired = skipped; a failed fetch only logs.
   */
  readonly comments?: (issueId: string) => Promise<readonly UpstreamIssueComment[] | undefined>
  /** Comment stream (not wired = no replay) and link table (not wired = no `assigneeTaskId`). */
  readonly thread?: ThreadService; readonly links?: LinkStore
}

/** One issue comment on the shared library — only the facts needed to replay it locally. */
export interface UpstreamIssueComment {
  /** Cloud comment id; carrying it keeps the replay idempotent. Absent = the comment service mints one. */
  readonly id?: string
  readonly author: string; readonly content: string
  /** Epoch ms, preferred whenever the remote side gives a real timestamp. */
  readonly createdAt?: number
  /** Beijing-time string; unparseable values count as "now". */
  readonly at?: string
  readonly authorType?: string
  readonly role?: string
}

export interface RouteRemoteInput {
  assigneeTask: string; cwd: string
  urgency: string; permission?: string
  assignerMeta: Record<string, unknown>
  /** Epoch ms; the remote layer renders its own format. */
  assignedAt: number
}

export interface IssueTaskInput {
  readonly title: string
  readonly detail: string
  readonly cwd: string
  readonly urgency: Urgency
  readonly permission: PermissionMode
  /** Carried from issue.assignerMeta.model; absent = host default. */
  readonly model?: TaskModel
  readonly reference?: { dag?: string; router?: string }
  readonly checklist?: readonly ChecklistItem[]
  readonly tags?: readonly string[]
  /** When present and non-empty, the card is scheduled; absent/empty = queue. */
  readonly cron?: string
  /** Full snapshots carried onto the card; not ids resolved from the local catalog. */
  readonly acceptanceStrategies?: readonly AcceptanceStrategy[]
}

export interface IssueTaskConversion {
  readonly task: TaskRecord
  readonly issue: IssueRecord
}

/** What the card is built from (already validated). */
interface TaskSeed {
  readonly issueId: string
  readonly workspaceId: string
  readonly title: string
  readonly detail: string
  readonly cwd: string
  readonly urgency: Urgency
  readonly permission: PermissionMode
  readonly model?: TaskModel
  readonly execution?: ExecutionConfig
  readonly reference?: { dag?: string; router?: string }
  readonly checklist?: readonly ChecklistItem[]
  readonly acceptanceStrategies?: readonly AcceptanceStrategy[]
  readonly tags?: readonly string[]
  readonly source?: string
}

/** Bookkeeping only: a failure writes one line and lets the main flow continue. */
function warn(event: string, detail: string): void {
  eventLog('warn', event, detail)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mustText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) throw new Error(`${field} 必填（非空字符串）`)
  return text
}

function assertIssueId(issueId: string): void {
  if (!isValidId(issueId)) throw new Error(`issueId 不是合法 id：${issueId}`)
}

function assertAbsolutePath(path: string): void {
  if (!/^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(path)) {
    throw new Error(`cwd 必须是绝对路径：${path}`)
  }
}

/** Only `routing` issues are convertible; planning or settled ones must not be converted a second time. */
function convertible(status: IssueRecord['status']): boolean {
  return status === 'routing'
}

function noteOf(source: Record<string, unknown>, key: 'dag' | 'router'): string | undefined {
  const value = source[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`reference.${key} 必须是字符串`)
  const text = value.trim()
  return text.length === 0 ? undefined : text
}

/**
 * Normalize `reference` to `{ dag?, router? }`; both empty yields `undefined` so no empty object
 * lands on the task record.
 */
function readReference(raw: unknown): { dag?: string; router?: string } | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('reference 必须是 { dag?, router? }')
  }
  const source = raw as Record<string, unknown>
  const dag = noteOf(source, 'dag')
  const router = noteOf(source, 'router')
  if (dag === undefined && router === undefined) return undefined
  const reference: { dag?: string; router?: string } = {}
  if (dag !== undefined) reference.dag = dag
  if (router !== undefined) reference.router = router
  return reference
}

function readChecklist(raw: unknown): ChecklistItem[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) {
    throw new Error('checklist 必须是字符串数组，或 { id?, text, checked? } 的数组')
  }
  if (raw.every(item => typeof item === 'string')) {
    return checklistFromTexts(raw as string[])
  }
  return normalizeChecklist(raw)
}

interface IssuePlanning {
  cron?: string
  checklist?: ChecklistItem[]
  acceptanceStrategies?: AcceptanceStrategy[]
  model?: TaskModel
}

/**
 * Tolerant parser for planning metadata that may have been written by an
 * older client, another instance, or hand-edited. Each field is independent:
 * one malformed field is dropped, never the whole conversion.
 */
function parseIssuePlanning(meta: IssueMeta | undefined, issueId: string): IssuePlanning {
  const raw = meta as {
    cron?: unknown
    checklist?: unknown
    acceptanceStrategies?: unknown
    model?: unknown
  } | undefined
  const dropped = (field: string, reason: string): void => {
    warn('issue-plan-field-dropped', `${issueId}: ${field}: ${reason}`)
  }

  let cron: string | undefined
  if (raw?.cron !== undefined && raw.cron !== null) {
    if (typeof raw.cron !== 'string') {
      dropped('cron', 'not a string')
    } else if (raw.cron.trim() !== '') {
      try {
        cron = normalizeExecution({ mode: 'scheduled', cron: raw.cron }).cron
      } catch (error) {
        dropped('cron', errorText(error))
      }
    }
  }

  let checklist: ChecklistItem[] | undefined
  if (raw?.checklist !== undefined && raw.checklist !== null) {
    if (!Array.isArray(raw.checklist) || !raw.checklist.every(item => typeof item === 'string')) {
      dropped('checklist', 'not an array of strings')
    } else {
      try {
        const texts = normalizeChecklistTexts(raw.checklist)
        checklist = texts === undefined ? undefined : checklistFromTexts(texts)
      } catch (error) {
        dropped('checklist', errorText(error))
      }
    }
  }

  let acceptanceStrategies: AcceptanceStrategy[] | undefined
  if (raw?.acceptanceStrategies !== undefined && raw.acceptanceStrategies !== null) {
    if (!Array.isArray(raw.acceptanceStrategies)) {
      dropped('acceptanceStrategies', 'not an array')
    } else {
      acceptanceStrategies = normalizeAcceptanceStrategies(raw.acceptanceStrategies)
      if (acceptanceStrategies === undefined && raw.acceptanceStrategies.length > 0) {
        dropped('acceptanceStrategies', 'no valid strategy')
      }
    }
  }

  let model: TaskModel | undefined
  if (raw?.model !== undefined && raw.model !== null) {
    try {
      model = normalizeModel(raw.model)
    } catch (error) {
      dropped('model', errorText(error))
    }
  }

  return {
    ...(cron === undefined ? {} : { cron }),
    ...(checklist === undefined ? {} : { checklist }),
    ...(acceptanceStrategies === undefined ? {} : { acceptanceStrategies }),
    ...(model === undefined ? {} : { model }),
  }
}

/**
 * Parse the shared library's Beijing-time strings (`2026-11-06 17:10:44`, or ISO).
 *
 * Those columns carry no zone, so `+08:00` is appended explicitly rather than letting `Date.parse`
 * guess from the host's local zone.
 */
export function parseBeijingTime(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const isoish = trimmed.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T')
  const stamped = /(?:Z|[+-]\d{2}:?\d{2})$/.test(isoish) ? isoish : `${isoish}+08:00`
  const milliseconds = Date.parse(stamped)
  return Number.isFinite(milliseconds) ? milliseconds : undefined
}

/**
 * Turn issue-stage comments into pending rows of the comment stream.
 *
 * The body keeps a source line in front (author + time) so the executor can tell what the assigner
 * said at the issue stage from what anyone said while the task was running. The id rides along to
 * stay idempotent with the inbox, the direction is always `assigner`, and the timestamp prefers the
 * epoch `createdAt`, then `at`, then "now" — new comments must sort after the replayed ones.
 */
function toCommentDrafts(source: readonly UpstreamIssueComment[] | undefined, now: number): CommentDraft[] {
  const drafts: CommentDraft[] = []
  for (const comment of source ?? []) {
    const body = comment.content.trim()
    if (body.length === 0) continue
    const signed = comment.author.trim()
    const author = signed === '' ? '（未署名）' : signed
    const createdAt = comment.createdAt !== undefined
      && Number.isFinite(comment.createdAt)
      && comment.createdAt > 0
      ? comment.createdAt
      : parseBeijingTime(comment.at) ?? now
    drafts.push({
      ...(comment.id === undefined || comment.id === '' ? {} : { id: comment.id }),
      author,
      authorType: 'user',
      role: 'assigner',
      createdAt,
      body: `〔issue 评论 · ${author} @ ${new Date(createdAt).toISOString()}〕\n${body}`,
    })
  }
  return drafts
}

async function upstreamComments(
  deps: IssueTaskToolDeps,
  issueId: string,
  now: number,
): Promise<CommentDraft[]> {
  const fetch = deps.comments
  if (fetch === undefined) return []
  try {
    return toCommentDrafts(await fetch(issueId), now)
  } catch (error) {
    warn('issue-task-comments-failed', `${issueId}: ${errorText(error)}`)
    return []
  }
}

/**
 * The issue's own project wins when it has one (a mismatch only logs); otherwise `cwd` must resolve.
 */
async function bindWorkspace(
  deps: IssueTaskToolDeps,
  issue: IssueRecord,
  cwd: string,
): Promise<string> {
  const resolved = await deps.resolveWorkspace(cwd)
  if (issue.workspaceId !== '') {
    if (resolved !== undefined && resolved.id !== issue.workspaceId) {
      warn(
        'issue-task-workspace-mismatch',
        `issue ${issue.id} 已有 workspaceId=${issue.workspaceId}，但 cwd=${cwd} 解析成 ${resolved.id}；以 issue 为准`,
      )
    }
    return issue.workspaceId
  }
  if (resolved === undefined) {
    throw new Error(`cwd "${cwd}" 不是本机存在的目录（或项目注册面不可用），无法绑定项目`)
  }
  return resolved.id
}

/**
 * Build the todo card before the single transactional write. The source channel is copied off the
 * issue here: the scheduling hot path reads only the task ledger and never looks the issue up again.
 */
function buildTaskCard(seed: TaskSeed, stamp: number): TaskRecord {
  const task: TaskRecord = {
    id: newTaskId(),
    title: seed.title,
    detail: seed.detail,
    workspaceId: seed.workspaceId,
    cwd: seed.cwd,
    urgency: seed.urgency,
    status: 'todo',
    blocked: false,
    issueId: seed.issueId,
    execution: seed.execution ?? { mode: 'queue' },
    permission: seed.permission,
    ...(seed.model === undefined ? {} : { model: seed.model }),
    createdAt: stamp,
    updatedAt: stamp,
    createdBy: { kind: 'agent' },
    updatedBy: { kind: 'agent' },
    executions: [],
  }
  if (seed.source !== undefined && seed.source !== '') task.source = seed.source
  if (seed.reference !== undefined) task.reference = seed.reference
  if (seed.tags !== undefined) task.tags = [...seed.tags]
  if (seed.checklist !== undefined && seed.checklist.length > 0) task.checklist = [...seed.checklist]
  if (seed.acceptanceStrategies !== undefined && seed.acceptanceStrategies.length > 0) {
    task.acceptanceStrategies = [...seed.acceptanceStrategies]
  }
  return task
}

function convertedMeta(
  base: IssueMeta | undefined,
  title: string,
  detail: string,
  reference: { dag?: string; router?: string } | undefined,
  checklistTexts: readonly string[] | undefined,
  cron: string | undefined,
  acceptanceStrategies: readonly AcceptanceStrategy[] | undefined,
): IssueMeta {
  const meta: IssueMeta = { ...(base ?? {}), title, detail }
  if (reference !== undefined) meta.reference = reference
  if (checklistTexts !== undefined && checklistTexts.length > 0) meta.checklist = [...checklistTexts]
  else delete meta.checklist
  if (cron !== undefined) meta.cron = cron
  else delete meta.cron
  if (acceptanceStrategies !== undefined && acceptanceStrategies.length > 0) {
    meta.acceptanceStrategies = [...acceptanceStrategies]
  } else {
    delete meta.acceptanceStrategies
  }
  return meta
}

/** Only cloud records have a row to update; a failure only logs. */
async function pushOnline(
  deps: IssueTaskToolDeps,
  issue: IssueRecord,
  task: TaskRecord,
  cwd: string,
  urgency: Urgency,
  permission: PermissionMode,
  meta: IssueMeta,
  stamp: number,
): Promise<void> {
  const send = deps.issueRouted
  if (send === undefined) throw new Error('共享库不可用：不能把 routing 结果写回 issue')
  await send(issue.id, {
    assigneeTask: task.id,
    cwd,
    urgency,
    permission,
    assignerMeta: meta,
    assignedAt: stamp,
  })
}

/**
 * Convert one issue with **already validated fields** into a task.
 *
 * The write order matters:
 *
 * 1. Resolve `cwd → project` and throw before anything is written;
 * 2. create the card (`mutate`, atomic);
 * 3. link-table `assigneeTaskId` and the issue-stage comment replay — best effort;
 * 4. write the issue back (`routing` + `assigneeTask` + normalized fields and meta);
 * 5. cloud records get one more write-back, which never fails the conversion.
 *
 * Only step 1 can actually block; everything after step 2 touches side information, so the
 * "issue converted, task missing" half-state cannot happen.
 *
 * @param deps - Dependency face.
 * @param issue - Source issue; the caller has already validated its status.
 * @param input - Validated fields.
 */
export async function convertIssueToTask(
  deps: IssueTaskToolDeps,
  issue: IssueRecord,
  input: IssueTaskInput,
): Promise<IssueTaskConversion> {
  const issueId = issue.id
  const title = normalizeIssueTitle(input.title)
  const detail = normalizeIssueDetail(input.detail)
  const cwd = input.cwd.trim()
  const { urgency, permission, reference, tags } = input
  const planning = parseIssuePlanning(issue.assignerMeta, issueId)
  const checklist = input.checklist ?? planning.checklist
  const cron = input.cron === undefined
    ? planning.cron
    : input.cron.trim() === '' ? undefined : input.cron
  const acceptanceStrategies = input.acceptanceStrategies ?? planning.acceptanceStrategies
  const model = input.model ?? planning.model
  const execution: ExecutionConfig = cron === undefined
    ? { mode: 'queue' }
    : { mode: 'scheduled', cron }

  // Taken first because the replay is supporting material: failing to fetch it must not block the conversion.
  const seededComments = await upstreamComments(deps, issueId, deps.now())
  const workspaceId = await bindWorkspace(deps, issue, cwd)

  // ── One transaction for the card
  const stamp = deps.now()
  const card = buildTaskCard({
    issueId,
    workspaceId,
    title,
    detail,
    cwd,
    urgency,
    permission,
    model,
    execution,
    reference,
    checklist,
    acceptanceStrategies,
    tags,
    source: issue.source,
  }, stamp)

  const mergedMeta = convertedMeta(
    issue.assignerMeta,
    title,
    detail,
    reference,
    checklist?.map(item => item.text),
    cron,
    acceptanceStrategies,
  )

  // Cloud first: if the shared library cannot store the routing result, nothing local
  // is written and the caller gets an error to retry.
  await pushOnline(deps, issue, card, cwd, urgency, permission, mergedMeta, stamp)

  await deps.store.mutate('task-created', ledger => {
    ledger.tasks.push(card)
    return [card]
  })

  // Link table: this card has taken the issue on. A failed write only costs a routing cache entry.
  if (deps.links !== undefined) {
    await patchLinkQuiet(deps.links, issueId, { assigneeTaskId: card.id }, 'issue-task')
  }

  // The issue-stage discussion joins the comment stream, anchored on the issueId.
  if (deps.thread !== undefined && seededComments.length > 0) {
    try {
      await deps.thread.ingest(issueId, seededComments)
    } catch (error) {
      warn('issue-task-comment-seed-failed', `${issueId}: ${errorText(error)}`)
    }
  }

  // Write the issue back: normalized fields, projected meta, and both-way binding.
  const attached = await deps.issues.update(issueId, draft => {
    // A concurrent caller may already have advanced it (abandoned, settled) — keep that verdict.
    if (draft.status !== 'pending' && draft.status !== 'accepted' && draft.status !== 'routing') return false
    Object.assign(draft, {
      cwd,
      urgency,
      permission,
      detail,
      title,
      assignerMeta: mergedMeta,
      assigneeTask: card.id,
      status: 'routing' as const,
      assignedAt: stamp,
      workspaceId: draft.workspaceId === '' ? workspaceId : draft.workspaceId,
    })
  }, 'issue-transferred')
  if (attached === undefined) {
    throw new Error(`issue ${issueId} 的本地镜像更新失败；云端已标记 routing`)
  }

  return {
    task: card,
    issue: attached,
  }
}

export function isConverted(issue: IssueRecord): boolean {
  return issue.assigneeTask !== undefined && issue.assigneeTask !== ''
}

async function convertibleIssue(issues: IssueStore, issueId: string): Promise<IssueRecord> {
  const issue = await issues.get(issueId)
  if (issue === undefined) throw new Error(`issue 不存在：${issueId}`)
  if (!convertible(issue.status)) {
    throw new Error(`issue ${issueId} 处于 ${issue.status}，只有 accepted / routing 能转卡`)
  }
  return issue
}

function receiptText(value: unknown): string {
  const receipt = value as {
    task?: { id?: string; title?: string; workspaceId?: string; cwd?: string }
    issue?: { id?: string; assigneeTask?: string }
  }
  const task = receipt.task ?? {}
  const issue = receipt.issue ?? {}
  const project = `${task.workspaceId ?? '?'}${task.cwd !== undefined ? `（${task.cwd}）` : ''}`
  return [
    `已把 issue ${issue.id ?? '?'} 转成任务 ${task.id ?? '?'}「${task.title ?? ''}」`,
    `- issue → assigneeTask: ${issue.assigneeTask ?? '(未写入)'}`,
    `- 项目: ${project}`,
    '这条 issue 已经离开待处理队列；不要为它再建第二张卡。',
  ].join('\n')
}

/**
 * The `castboard_issue_task` tool set.
 *
 * @param deps - Both ledgers, project resolution, and the remote write-back.
 */
export function issueTaskTools(deps: IssueTaskToolDeps): ToolDefinition[] {
  return [
    defineTool({
      name: 'castboard_issue_task',
      description:
        'Convert ONE planned issue into a board task (router tool). '
        + 'Required: issueId (must exist and be accepted or routing), title, detail, cwd. '
        + 'The task is created with status=todo and execution.mode=queue, bound to the issue both ways, '
        + 'and the issue gets its cwd / urgency / permission / meta / assigneeTask written back. '
        + 'If the issue came from the shared library, the conversion is synced online too. '
        + 'It inherits planning fields from issue.assignerMeta: cron (makes the card scheduled), '
        + 'checklist (string[] converted to task items), and acceptanceStrategies (full snapshots). '
        + 'Explicit arguments override the issue values; omitted values are inherited. '
        + 'Convert exactly one issue per call; never create a second task for the same issue.',
      parameters: {
        issueId: { type: 'string', required: true, description: 'Issue id to convert (standard UUID).' },
        title: { type: 'string', required: true, description: 'Task title — keep it identical to the issue title.' },
        detail: { type: 'string', required: true, description: 'Task body — keep it identical to the issue detail.' },
        cwd: { type: 'string', required: true, description: 'Absolute project path the task should run in.' },
        urgency: { type: 'string', description: 'urgent | normal (default) | relaxed | direct | runtime.' },
        permission: { type: 'string', description: 'read-only | workspace-write (default) | danger-full-access.' },
        reference: {
          type: 'object',
          description: 'Notes for the executor: { dag?: string, router?: string } (both optional).',
          additionalProperties: false,
          properties: {
            router: { type: 'string', description: 'Recommended plan, extra context, and caveats.' },
            dag: { type: 'string', description: 'Execution DAG code — omit for simple work.' },
          },
        },
        checklist: {
          type: 'array',
          items: {
            oneOf: [
              {
                type: 'string',
                description: `Checklist text (1..${MAX_CHECKLIST_TEXT} chars).`,
              },
              {
                additionalProperties: false,
                type: 'object',
                properties: {
                  checked: {
                    type: 'boolean',
                    description: 'Usually omitted (false).',
                  },
                  id: {
                    type: 'string',
                    description: 'Optional item id (minted when omitted).',
                  },
                  text: {
                    type: 'string',
                    description: `What counts as accepted (1..${MAX_CHECKLIST_TEXT} chars).`,
                  },
                },
              },
            ],
          },
          description:
            `Acceptance checklist (optional, at most ${MAX_CHECKLIST_ITEMS}). `
            + 'Strings are preferred; omitted = inherit issue.assignerMeta.checklist; [] clears it.',
        },
        cron: {
          type: 'string',
          description:
            'Five-field cron. Omit to inherit issue.assignerMeta.cron; empty string forces queue. '
            + 'Only scheduled cards should carry a cron.',
        },
        acceptanceStrategies: {
          type: 'array',
          items: {
            additionalProperties: false,
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable strategy id; omitted means derive one.' },
              title: { type: 'string', description: 'Strategy title.' },
              type: { type: 'string', description: 'issue | close.' },
              description: { type: 'string', description: 'Decision criteria.' },
            },
          },
          description:
            'Full acceptance-strategy snapshots. Omit to inherit issue.assignerMeta.acceptanceStrategies; '
            + '[] clears them. Use only when this card needs automatic acceptance.',
        },
        tags: {
          type: 'array',
          description:
            'Classification tags for the executor (e.g. auth / ci / perf). '
            + "Optional: omit to inherit the issue's assignerMeta.tags. "
            + `Injected into the executor's task context (max ${MAX_TAGS}, ${MAX_TAG_TEXT} chars each).`,
          items: { type: 'string' },
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: receiptText(value) }],
      },
      async execute(args) {
        // Validation only — nothing is written until every field checks out.
        const issueId = mustText(args.issueId, 'issueId')
        assertIssueId(issueId)
        const title = normalizeIssueTitle(mustText(args.title, 'title'))
        const detail = normalizeIssueDetail(mustText(args.detail, 'detail'))
        const cwd = mustText(args.cwd, 'cwd')
        assertAbsolutePath(cwd)
        const urgency = args.urgency === undefined ? 'normal' : asUrgency(args.urgency)
        const permission = args.permission === undefined ? 'workspace-write' : asPermission(args.permission)
        const reference = readReference(args.reference)
        const explicitChecklist = readChecklist(args.checklist)
        const tagsFromArgs = normalizeTags(args.tags)
        if (args.cron !== undefined && typeof args.cron !== 'string') {
          throw new Error('cron 必须是五段式字符串')
        }
        if (args.acceptanceStrategies !== undefined && !Array.isArray(args.acceptanceStrategies)) {
          throw new Error('acceptanceStrategies 必须是数组')
        }
        const explicitCron = args.cron === undefined
          ? undefined
          : args.cron.trim() === '' ? '' : normalizeExecution({ mode: 'scheduled', cron: args.cron }).cron
        const explicitStrategies = args.acceptanceStrategies === undefined
          ? undefined
          : (() => {
            const normalized = normalizeAcceptanceStrategies(args.acceptanceStrategies)
            if (normalized === undefined && args.acceptanceStrategies.length > 0) {
              throw new Error('acceptanceStrategies 没有有效项')
            }
            return normalized ?? []
          })()

        // The issue must still exist and must not have been advanced elsewhere.
        const issue = await convertibleIssue(deps.issues, issueId)

        // Explicit tags win; otherwise inherit whatever the assigner put into meta.
        const inheritedTags = normalizeTags(issue.assignerMeta?.tags)
        const tags = tagsFromArgs ?? inheritedTags
        const checklist = explicitChecklist
        const cron = explicitCron
        const acceptanceStrategies = explicitStrategies

        const input: IssueTaskInput = {
          ...{ title, detail, cwd, urgency, permission },
          ...(reference === undefined ? {} : { reference }),
          ...(checklist === undefined ? {} : { checklist }),
          ...(tags === undefined ? {} : { tags }),
          ...(cron === undefined ? {} : { cron }),
          ...(acceptanceStrategies === undefined ? {} : { acceptanceStrategies }),
        }
        const receipt = await convertIssueToTask(deps, issue, input)
        return receipt as never
      },
    }),
  ]
}
