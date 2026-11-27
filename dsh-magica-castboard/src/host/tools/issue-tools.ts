/**
 * The issue-dispatch tool set: turns "work to hand to someone else" into issue records.
 *
 * The model supplies `projectId`, `title`, `detail`, `assignee` and `assigneeInstance`;
 * optional `assignerMeta` carries acceptance/reference metadata. Legacy nested
 * `assignerMeta.title/detail` is still accepted when top-level fields are absent.
 * `issueId` (a fresh UUID that doubles as the idempotency key), `source`, `sourceInstance` and
 * `assignerTask` are derived locally.
 *
 * Issues in one batch may depend on each other: the depended-on entry gets a `ref`, the dependent
 * one lists it in `dependsOn`, and the refs are translated into real issueIds before submission.
 * Cycles, dangling refs and more than {@link MAX_DEPENDS_ON} entries are rejected at creation —
 * such data never heals itself, it only parks the issues in the planning column.
 *
 * The shared library is the only place an issue is created; a failed create is an error,
 * never a local fallback record.
 *
 * @module dsh-magica-castboard/host/tools/issue-tools
 */
import { eventLog } from '../shared/event-log.ts'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { castboardIssueDelegation } from '../context/delegation-context.ts'
import { ISSUE_DELEGATION_SECTION } from '../context/sections.ts'
import type { ThreadComment } from '../ledger/comment-store.ts'
import type { IssueDraft, IssueRecord } from '../ledger/issue-store.ts'
import { patchLinkQuiet, type LinkStore } from '../ledger/link-store.ts'
import { isValidId } from '../ledger/paths.ts'
import {
  MAX_DEPENDS_ON,
  type IssueLink,
  type IssueMeta,
  type PermissionMode,
  type Urgency,
} from '../model.ts'
import { queryOrDegrade } from '../pipeline/sdk-query.ts'
import { ISSUE_SOURCE_DSH, normalizeIssueSource } from '../../shared/wire.ts'
import {
  asPermission,
  asUrgency,
  isUuid,
  newIssueId,
  normalizeAcceptanceStrategies,
  normalizeChecklistTexts,
  normalizeExecution,
} from '../rules.ts'
import type { IssueStateAttachment, ToolDeps } from './shared.ts'
import { ERR, JSON_OUT, ToolError, json, type ToolRunContext } from './task-tools.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Constants and vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/** `source` default for issues created by this tool. */

/** How many issues one call may create (a bigger batch is a bulk import, not "splitting work"). */
const MAX_ISSUES_PER_CALL = 20

const MAX_CWD_CHARS = 500

const REQUIRED_FIELDS = ['projectId', 'title', 'detail', 'assignee', 'assigneeInstance'] as const

const OPTIONAL_FIELDS = ['assignerMeta', 'cwd', 'urgency', 'permission', 'source', 'attachments', 'ref', 'dependsOn'] as const

type Side = 'assigner' | 'assignee' | 'both' | 'observer'

type RenderBlock = { type: 'text'; text: string }

interface Rejection {
  index: number
  reason: string
}

/** An issue that passed validation and is waiting to be submitted. */
interface Candidate {
  readonly index: number
  readonly where: string
  /** Also the idempotency key when the issue is created remotely. */
  readonly issueId: string
  /** Short alias other entries in the batch refer to from `dependsOn`. */
  readonly ref?: string
  readonly projectId: number
  readonly meta: IssueMeta
  readonly title: string
  readonly detail: string
  readonly assignee: string
  readonly assigneeInstance: string
  readonly cwd?: string
  readonly urgency: Urgency
  readonly permission: PermissionMode
  readonly attachments?: readonly string[]
  /** A ref of this batch or an external UUID — not resolved yet. */
  readonly dependsOnRefs: readonly string[]
  /** Explicit source from the caller; must already exist in the source dictionary. */
  readonly requestedSource?: string
  /** Source actually written to the shared library; `self` folds to `dsh`. */
  source: string
  dependsOn?: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Dispatching runs in the background; a failure here must not take the caller's turn down. */
function warn(event: string, detail: string): void {
  eventLog('warn', event, detail)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Fold an arbitrary exception into a tool error with a stable code.
 *
 * Validation errors are rethrown as they are (the host renders them to the model); a read-only
 * ledger maps to `forbidden`, and any other unknown exception maps to `invalid_input` — what the
 * model needs is a reason it can act on.
 */
function fail(error: unknown): never {
  if (error instanceof ToolError) throw error
  if (error instanceof Error && error.name === 'ReadOnlyError') {
    throw new ToolError(ERR.forbidden, error.message)
  }
  throw new ToolError(ERR.invalidInput, messageOf(error))
}

/** Says why there is no data instead of returning an empty list that looks like "nothing exists". */
function degraded(error: string): { ok: false; degraded: true; error: string } {
  return { ok: false, degraded: true, error }
}

/**
 * This machine's instance `ip:port`.
 *
 * Both `source` and `sourceInstance` depend on it, so an unresolvable value is rejected outright:
 * quietly writing an empty string would remove the basis for telling "hand back to this machine"
 * from "dispatch across instances".
 */
function localInstance(deps: ToolDeps): string {
  const instance = (deps.instance?.() ?? '').trim()
  if (instance === '') throw new Error('本机实例（ip:port）解析不出来，无法填写 sourceInstance')
  return instance
}

/**
 * The caller session id.
 *
 * The host exposes session identity at `exec.agent.session.id`; calls without an agent (scripts,
 * tests) return an empty string, and the caller treats that as "no session" instead of inventing
 * an id.
 */
function callerSession(exec: ToolRunContext | undefined): string {
  const agent = exec?.agent
  const id = agent?.id ?? agent?.session?.id
  return typeof id === 'string' ? id : ''
}

/** Link-table handle (`ToolDeps.links` is an opaque value from the assembly layer, narrowed here by method name). */
function linkStoreOf(deps: ToolDeps): LinkStore | undefined {
  return deps.links === undefined ? undefined : deps.links as LinkStore
}

function requiredText(raw: unknown, where: string): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') throw new Error(`${where} 必填（非空字符串）`)
  return text
}

function optionalText(raw: unknown, where: string): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new Error(`${where} 必须是字符串`)
  const text = raw.trim()
  return text === '' ? undefined : text
}

function assignerMetaOf(raw: unknown, where: string): IssueMeta {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where}.assignerMeta 必须是对象`)
  }
  return { ...(raw as Record<string, unknown>) } as IssueMeta
}

/**
 * Validate the optional planning keys carried by `assignerMeta`.
 *
 * `cron` means "this issue should become a scheduled card"; omission is queue.
 * `checklist` is plain text on the issue side and becomes `{id,text,checked:false}`
 * only when the issue is converted. `acceptanceStrategies` uses the same full
 * snapshot shape as a task so a card can consume it without resolving local ids.
 */
function planningMetaOf(meta: IssueMeta, where: string): IssueMeta {
  const out: IssueMeta = { ...meta }
  if ('cron' in out) {
    const raw = out.cron
    if (raw === undefined || raw === null || raw === '') {
      delete out.cron
    } else if (typeof raw !== 'string') {
      throw new Error(`${where}.assignerMeta.cron 必须是字符串`)
    } else {
      const cron = raw.trim()
      if (cron === '') delete out.cron
      else out.cron = normalizeExecution({ mode: 'scheduled', cron }).cron
    }
  }
  if ('checklist' in out) {
    const checklist = normalizeChecklistTexts(out.checklist)
    if (checklist === undefined || checklist.length === 0) delete out.checklist
    else out.checklist = checklist
  }
  if ('acceptanceStrategies' in out) {
    const raw = out.acceptanceStrategies
    if (raw === undefined || raw === null) {
      delete out.acceptanceStrategies
    } else if (!Array.isArray(raw)) {
      throw new Error(`${where}.assignerMeta.acceptanceStrategies 必须是数组`)
    } else {
      const strategies = normalizeAcceptanceStrategies(raw)
      if (strategies === undefined) {
        if (raw.length > 0) throw new Error(`${where}.assignerMeta.acceptanceStrategies 没有有效项`)
        delete out.acceptanceStrategies
      } else {
        out.acceptanceStrategies = strategies
      }
    }
  }
  return out
}

function projectIdOf(raw: unknown, where: string): number {
  const value = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${where}.projectId 必填（正整数，来自 castboard_issue_groups 的 id）`)
  }
  return value
}

function attachmentsOf(raw: unknown, where: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new Error(`${where}.attachments 必须是文件路径数组`)
  const paths: string[] = []
  raw.forEach((item, index) => {
    const path = typeof item === 'string' ? item.trim() : ''
    if (path === '') throw new Error(`${where}.attachments[${index}] 必须是非空文件路径`)
    paths.push(path)
  })
  return paths.length === 0 ? undefined : paths
}

function refOf(raw: unknown, where: string): string | undefined {
  const ref = optionalText(raw, `${where}.ref`)
  if (ref === undefined) return undefined
  if (/\s/.test(ref)) throw new Error(`${where}.ref 不能含空白（收到 "${ref}"）`)
  return ref
}

function dependsOnRefsOf(raw: unknown, where: string): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error(`${where}.dependsOn 必须是字符串数组`)
  const refs: string[] = []
  raw.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`${where}.dependsOn[${index}] 必须是非空字符串`)
    }
    const ref = item.trim()
    if (!refs.includes(ref)) refs.push(ref)
  })
  return refs
}

/**
 * Normalize a project key: a number (the type `castboard_issue_groups` returns for `id`) or its string form.
 *
 * Shared-library project keys are positive integers; a pure digit string folds into a number here,
 * and any other string is passed downstream unchanged for it to judge.
 */
function projectKeyOf(primary: unknown, alias: unknown): number | string {
  const raw = primary === undefined || primary === null || primary === '' ? alias : primary
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) throw new Error(`projectId 必须是正整数（收到 ${String(raw)}）`)
    return Math.trunc(raw)
  }
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') throw new Error('projectId 必填 —— 传 castboard_issue_groups 返回的数字 id')
  return /^\d+$/.test(text) ? Number(text) : text
}

/**
 * The card the caller session is executing.
 *
 * Session ownership is authoritative (the execution service records it into the execution history
 * when it starts a session); only when that yields nothing is the model-supplied `taskId` used.
 * With neither, the field stays empty — calling this tool from a plain chat has no task lineage.
 */
function owningTaskId(deps: ToolDeps, sessionId: string, explicit: string | undefined): string | undefined {
  if (sessionId !== '') {
    const fromSession = deps.tasks.taskIdOfSession(sessionId)
    if (fromSession !== undefined) return fromSession
  }
  return explicit
}

/**
 * Record a new issue on that card's `derivedIssues` (back-reference).
 *
 * Failing to write (card gone / soft-deleted / read-only ledger) only warns: the issue already
 * exists, and this field is merely an acceleration structure.
 *
 * @returns The full list after appending (an empty array when nothing was written).
 */
async function recordDerivedIssues(
  deps: ToolDeps,
  taskId: string,
  issueIds: readonly string[],
): Promise<string[]> {
  if (issueIds.length === 0) return []
  let recorded: string[] = []
  try {
    await deps.tasks.mutate('task-updated', ledger => {
      const task = ledger.tasks.find(item => item.id === taskId && item.trashedAt === undefined)
      if (task === undefined) return undefined
      const merged = [...(task.derivedIssues ?? [])]
      for (const id of issueIds) if (!merged.includes(id)) merged.push(id)
      task.derivedIssues = merged
      task.updatedAt = deps.now()
      task.updatedBy = { kind: 'agent' }
      recorded = merged
      return [task]
    })
  } catch (error) {
    warn('issue-dispatch-derived-failed', `${taskId}: ${messageOf(error)}`)
    return []
  }
  return recorded
}

/**
 * Register in the link table that "these issues were created by this call".
 *
 * Only the creation site knows who created them — `IssueRecord` holds an account, not a session.
 * Once registered, comment delivery can find the assigner session, and comment routing has a basis
 * for deciding whether a comment may go to the cloud (`cloud`).
 *
 * A write failure only warns: the link table is a best-effort acceleration structure, and the
 * comments themselves live in the comment stream.
 */
async function rememberIssueLinks(
  links: LinkStore | undefined,
  issues: readonly { issueId: string }[],
  sessionId: string,
  what: string,
): Promise<void> {
  if (links === undefined) return
  for (const issue of issues) {
    await patchLinkQuiet(links, issue.issueId, {
      ...(sessionId !== '' ? { assignerSessionId: sessionId } : {}),
    }, what)
  }
}

/**
 * Which side the caller is on for this issue.
 *
 * The two session columns of the link table come first; when the table has not caught up with the
 * execution session yet, the `assigneeTaskId` card is consulted in the ledger (one card only, never
 * a full scan).
 */
function sideOf(link: IssueLink | undefined, deps: ToolDeps, sessionId: string): Side {
  if (link === undefined || sessionId === '') return 'observer'
  const isAssigner = link.assignerSessionId === sessionId
  const isAssignee = link.assigneeSessionId === sessionId
  if (isAssigner && isAssignee) return 'both'
  if (isAssigner) return 'assigner'
  if (isAssignee) return 'assignee'
  const taskId = link.assigneeTaskId
  if (taskId !== undefined && taskId !== '') {
    const task = deps.tasks.get(taskId)
    if (task !== undefined && task.executions.some(record => record.sessionId === sessionId)) return 'assignee'
  }
  return 'observer'
}

/**
 * Comment ids that can be used as attachment targets.
 *
 * Local rows use the comment's own id (the publish key) and remote rows carry the cloud
 * `commentId`, so both are valid `targetId`s. Old rows without an id are skipped rather
 * than querying an empty target.
 */
function commentIdsOf(comments: readonly unknown[]): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of comments) {
    if (item === null || typeof item !== 'object') continue
    const id = (item as { id?: unknown }).id
    if (typeof id !== 'string' || id === '' || !isValidId(id) || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/**
 * Rendering helpers.
 */

/** Full JSON rendering: the whole value of these tools is the ids and fields in the receipt; a summary only forces the model to query again. */
function fullJson(_args: unknown, value: unknown): RenderBlock[] {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2) }]
}

function renderLinkTable(_args: unknown, value: unknown): RenderBlock[] {
  const receipt = value as {
    ok?: boolean
    error?: string
    mySide?: string
    links?: Array<{
      issueId: string
      assignerSessionId?: string
      assigneeTaskId?: string
      assigneeSessionId?: string
      hasUnread?: boolean
      assignerPendingSince?: number
      assigneePendingSince?: number
    }>
  }
  if (receipt.ok !== true) return [{ type: 'text', text: `查询关系失败：${receipt.error ?? '未知错误'}` }]
  const list = receipt.links ?? []
  if (list.length === 0) return [{ type: 'text', text: '没有命中任何关系记录。' }]
  const lines = list.map(link => {
    const parts = [`issue ${link.issueId}`]
    if (link.assignerSessionId !== undefined) parts.push(`下发会话 ${link.assignerSessionId}`)
    if (link.assigneeTaskId !== undefined) parts.push(`执行卡 ${link.assigneeTaskId}`)
    if (link.assigneeSessionId !== undefined) parts.push(`执行会话 ${link.assigneeSessionId}`)
    if (link.hasUnread === true) parts.push('有未读评论')
    if (link.assignerPendingSince !== undefined) parts.push('下发方有未投递评论')
    if (link.assigneePendingSince !== undefined) parts.push('执行方有未投递评论')
    return `- ${parts.join(' · ')}`
  })
  return [{ type: 'text', text: `关系记录 ${String(list.length)} 条（你是 ${receipt.mySide ?? 'observer'}）：\n${lines.join('\n')}` }]
}

// ─────────────────────────────────────────────────────────────────────────────
// Creating issues: argument normalization and validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize one issue's arguments.
 *
 * Only the field shapes are checked; dependency resolution and cycle detection wait until the whole
 * batch has been read once (they need the alias table).
 * @throws When any item is invalid (the caller records it in `rejected` and keeps the batch going).
 */
function candidateOf(raw: unknown, index: number, instance: string): Candidate {
  const where = `issues[${index}]`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} 必须是对象`)
  }
  const entry = raw as Record<string, unknown>
  const meta = planningMetaOf(assignerMetaOf(entry.assignerMeta, where), where)
  const projectId = projectIdOf(entry.projectId, where)
  const title = optionalText(entry.title, `${where}.title`) ?? requiredText(meta.title, `${where}.title`)
  const detail = optionalText(entry.detail, `${where}.detail`) ?? requiredText(meta.detail, `${where}.detail`)
  const normalizedMeta: IssueMeta = { ...meta, title, detail }
  const assignee = requiredText(entry.assignee, `${where}.assignee`)
  const assigneeInstance = requiredText(entry.assigneeInstance, `${where}.assigneeInstance`)
  const cwd = optionalText(entry.cwd, `${where}.cwd`)
  if (cwd !== undefined && cwd.length > MAX_CWD_CHARS) {
    throw new Error(`${where}.cwd 最多 ${String(MAX_CWD_CHARS)} 个字符`)
  }
  const urgency = entry.urgency === undefined ? 'normal' : asUrgency(String(entry.urgency))
  const permission = entry.permission === undefined ? 'workspace-write' : asPermission(entry.permission)
  const ref = refOf(entry.ref, where)
  const attachments = attachmentsOf(entry.attachments, where)
  const dependsOnRefs = dependsOnRefsOf(entry.dependsOn, where)
  const explicitSource = optionalText(entry.source, `${where}.source`)
  return {
    index,
    where,
    issueId: newIssueId(),
    ...(ref !== undefined ? { ref } : {}),
    projectId,
    meta: normalizedMeta,
    title,
    detail,
    assignee,
    assigneeInstance,
    ...(cwd !== undefined ? { cwd } : {}),
    urgency,
    permission,
    ...(attachments !== undefined ? { attachments } : {}),
    dependsOnRefs,
    ...(explicitSource === undefined ? {} : { requestedSource: explicitSource }),
    source: ISSUE_SOURCE_DSH,
  }
}

/**
 * Translate one entry's dependency refs into real issueIds.
 *
 * Each item is either a `ref` of some entry in this batch or a standard UUID (pointing at an issue
 * already in the library). An unresolvable ref is rejected outright: a dependency that cannot be
 * looked up once stored is a promise that this issue waits forever.
 *
 * @param candidate - An entry that already passed field validation.
 * @param alias - This batch's `ref → entry` map.
 * @throws When a ref cannot be resolved, points at itself, or exceeds the count limit.
 */
function resolveDependencies(
  candidate: Candidate,
  alias: ReadonlyMap<string, Candidate>,
): string[] | undefined {
  if (candidate.dependsOnRefs.length === 0) return undefined
  const ids: string[] = []
  for (const ref of candidate.dependsOnRefs) {
    const target = alias.get(ref)
    const id = target?.issueId ?? (isUuid(ref) ? ref : undefined)
    if (id === undefined) {
      throw new Error(
        `${candidate.where}.dependsOn 里的 "${ref}" 既不是本批某条 issue 的 ref，也不是标准 UUID；`
        + `本批可用的 ref：${[...alias.keys()].join(', ') || '(无)'}`,
      )
    }
    if (id === candidate.issueId) {
      throw new Error(`${candidate.where}.dependsOn 里的 "${ref}" 指向这条 issue 自己；自依赖永远等不到自己的 success`)
    }
    if (!ids.includes(id)) ids.push(id)
  }
  if (ids.length > MAX_DEPENDS_ON) {
    throw new Error(
      `${candidate.where}.dependsOn 有 ${String(ids.length)} 项，超过上限 ${String(MAX_DEPENDS_ON)}；`
      + '超过上限的 issue 会被规划侧当作滥用而阻塞，真需要这么多前置就拆成多条短链',
    )
  }
  return ids.length === 0 ? undefined : ids
}

/**
 * Cycle detection inside the batch (only edges internal to the batch; external UUIDs are leaves).
 *
 * The approach is to repeatedly peel off nodes with no in-batch dependency: whatever cannot be
 * peeled either forms a cycle or depends on one. Such issues wait for each other, none of them ever
 * reaches planning, and their status is never marked failed — the only recovery is manual work on
 * every one of them. Hence they are rejected at creation time with an actionable error.
 *
 * @param staged - Entries whose dependencies are already resolved.
 * @returns The entries that form a cycle (or depend on one).
 */
function cyclicCandidates(staged: readonly Candidate[]): Candidate[] {
  const byId = new Map(staged.map(candidate => [candidate.issueId, candidate]))
  const pending = new Map<string, ReadonlySet<string>>()
  for (const candidate of staged) {
    pending.set(candidate.issueId, new Set((candidate.dependsOn ?? []).filter(id => byId.has(id))))
  }
  let peeled = true
  while (peeled) {
    peeled = false
    for (const [id, deps] of [...pending.entries()]) {
      if ([...deps].some(dep => pending.has(dep))) continue
      pending.delete(id)
      peeled = true
    }
  }
  return [...pending.keys()].flatMap(id => {
    const candidate = byId.get(id)
    return candidate === undefined ? [] : [candidate]
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Creating issues: cloud only
// ─────────────────────────────────────────────────────────────────────────────

function remoteInputOf(
  candidate: Candidate,
  instance: string,
  assignerTask: string | undefined,
): Record<string, unknown> {
  return {
    issueId: candidate.issueId,
    projectId: candidate.projectId,
    title: candidate.title,
    detail: candidate.detail,
    assignerMeta: candidate.meta,
    assignee: candidate.assignee,
    assigneeInstance: candidate.assigneeInstance,
    urgency: candidate.urgency,
    permission: candidate.permission,
    source: candidate.source,
    sourceInstance: instance,
    ...(candidate.cwd !== undefined ? { cwd: candidate.cwd } : {}),
    ...(assignerTask !== undefined ? { assignerTask } : {}),
    ...(candidate.attachments !== undefined ? { attachments: [...candidate.attachments] } : {}),
    ...(candidate.dependsOn !== undefined ? { dependsOn: candidate.dependsOn } : {}),
  }
}

/**
 * Accept only the issues the cloud receipt confirms. A missing confirmation is a failed
 * creation: there is no local fallback any more.
 */
function confirmedRemotely(
  result: { created: readonly { issueId: string; title: string }[]; skipped: readonly string[] },
  staged: readonly Candidate[],
): Map<number, string> {
  const confirmed = new Map<number, string>()
  if (result.created.length === staged.length) {
    staged.forEach((candidate, index) => {
      if (result.created[index] !== undefined) confirmed.set(candidate.index, candidate.issueId)
    })
    return confirmed
  }
  const echoed = new Set(result.created.map(item => item.issueId).filter(id => id !== ''))
  const skipped = new Set(result.skipped)
  for (const candidate of staged) {
    if (echoed.has(candidate.issueId) || skipped.has(candidate.issueId)) {
      confirmed.set(candidate.index, candidate.issueId)
    }
  }
  return confirmed
}

/** Submit the valid issues of the batch; every one must be acknowledged by the cloud. */
async function submitCandidates(
  deps: ToolDeps,
  staged: readonly Candidate[],
  instance: string,
  assignerTask: string | undefined,
  rejected: Rejection[],
): Promise<Array<{ candidate: Candidate; issueId: string }>> {
  const remote = deps.remoteCreate
  if (remote === undefined) {
    throw new Error('共享库不可用：当前宿主不能创建 issue，请先连接在线服务')
  }
  if (staged.length === 0) return []
  let confirmed: Map<number, string>
  try {
    const result = await remote.createMany(staged.map(candidate => remoteInputOf(candidate, instance, assignerTask)))
    confirmed = confirmedRemotely(result, staged)
  } catch (error) {
    throw new Error(`共享库建 issue 失败：${messageOf(error)}`)
  }
  for (const candidate of staged) {
    if (!confirmed.has(candidate.index)) {
      rejected.push({ index: candidate.index, reason: '共享库未确认创建结果' })
    }
  }
  return staged.flatMap(candidate => {
    const issueId = confirmed.get(candidate.index)
    return issueId === undefined ? [] : [{ candidate, issueId }]
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool set
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the eight issue-dispatch tools (definitions only, no registration).
 *
 * @param deps - Ledger / query face / remote creation / this machine's instance / session injection.
 * @returns The tool definitions in the order the model sees them (help comes first).
 */
export function buildIssueDispatchTools(deps: ToolDeps): Array<ReturnType<typeof defineTool>> {
  return [
    // ── ① Guidance injected on demand ─────────────────────────────────────
    defineTool({
      name: 'castboard_issues_help',
      description:
        'Read the guidance for dispatching issues to other people / other dsh instances. '
        + '**Call this FIRST, before castboard_issues_create** — it injects the '
        + `"${ISSUE_DELEGATION_SECTION}" named context (field schema, tool order, the 5 steps, hard rules) `
        + 'into this session so you can read it on your next step. The return value only repeats the compact '
        + 'field list; the full steps arrive through the injected context. If nothing can be injected the '
        + 'whole guidance text is returned under `guidance` instead.',
      parameters: {},
      output: { schema: JSON_OUT, render: fullJson },
      async execute(_args, exec) {
        try {
          const instance = localInstance(deps)
          const guidance = castboardIssueDelegation({ instance })
          const sessionId = callerSession(exec as ToolRunContext)
          let injected = false
          if (deps.inject !== undefined && sessionId !== '') {
            try {
              injected = deps.inject(sessionId, [{
                name: ISSUE_DELEGATION_SECTION,
                text: guidance,
                form: 'notice',
                summary: 'Issue delegation guidance',
              }]) === true
            } catch (error) {
              warn('issue-dispatch-help-inject-failed', messageOf(error))
            }
          }
          if (!injected) {
            warn('issue-dispatch-help', '调用方不是可注入的 agent 会话，指导改为随返回值下发')
          }
          return json({
            ok: true,
            injected,
            local: { instance },
            requiredFields: [...REQUIRED_FIELDS],
            optionalFields: [...OPTIONAL_FIELDS],
            note: injected
              ? `指导已注入上下文 "${ISSUE_DELEGATION_SECTION}"（下一步生效）。按它的 5 步走`
                + '（项目组 → 项目成员 → 成员实例 → 该实例 Index → cwd）；**必填 5 个**'
                + '（requiredFields：projectId / title / detail / assignee / assigneeInstance），其余可选 ——'
                + ' cwd 不传就是「让对方自己判断在哪个目录做」，不要为了凑字段编一个目录。'
                + '多条 issue 一起建时先判断依赖：给被依赖方起一个 ref，把 ref 填进依赖方的 dependsOn；'
                + '不要自己写 issueId（它不是你能传的字段，传了整批会被参数校验拒掉）。'
              : '没能把指导注入具名上下文（调用方不是 agent 会话，或宿主没有注入面），正文随本回执的 '
                + 'guidance 字段下发。**必填 5 个**（requiredFields），其余可选'
                + '（cwd 不传 = 让对方自己判断目录）；多条 issue 有先后依赖时用 ref + dependsOn 串起来。',
            ...(injected ? {} : { guidance }),
          })
        } catch (error) {
          fail(error)
        }
      },
    }),

    // ── ② Project groups I belong to ──────────────────────────────────────
    defineTool({
      name: 'castboard_issue_groups',
      description:
        'List the projects / groups the current user belongs to (no arguments). '
        + 'Step 1 of the issue-dispatch guidance: use it to pick the target project, and ask the user '
        + 'with ask_user_question when there is more than one. When the shared library is not wired in, '
        + 'the result says so instead of pretending the list is empty.',
      parameters: {},
      output: { schema: JSON_OUT, render: fullJson },
      async execute() {
        try {
          const query = deps.query
          const result = await queryOrDegrade(query === undefined ? undefined : () => query.groups())
          if (result.degraded) return json(degraded(result.reason))
          return json({ ok: true, projects: result.value })
        } catch (error) {
          fail(error)
        }
      },
    }),

    // ── ③ Project members (filtered by dispatch permission) ───────────────
    defineTool({
      name: 'castboard_issue_group_members',
      description:
        'List the members of one project (argument projectId). Step 2 of the issue-dispatch guidance: '
        + 'each returned account is a candidate assignee — one issue gets exactly one person, and the '
        + 'user picks per issue with ask_user_question. The list is **permission-filtered**: when you are '
        + 'not owner / creator / manager of the project it contains only yourself, so an issue can only '
        + 'be dispatched to your own instances.',
      parameters: {
        projectId: {
          description: 'Numeric project id — the `id` field returned by castboard_issue_groups '
            + '(its string form is also accepted).',
          oneOf: [{ type: 'integer' }, { type: 'string' }],
        },
        groupId: { type: 'string', description: 'Compatibility alias for projectId.' },
      },
      output: { schema: JSON_OUT, render: fullJson },
      async execute(args) {
        try {
          const raw = args as { projectId?: unknown; groupId?: unknown }
          const projectId = projectKeyOf(raw.projectId, raw.groupId)
          const query = deps.query
          if (query === undefined) return json(degraded('共享库未接入（缺 SDK 查询面）'))
          const result = await queryOrDegrade(() => query.groupMembers(String(projectId)))
          if (result.degraded) return json(degraded(result.reason))
          // The shared library trims by permission: when only yourself comes back, `restricted` tells the model it cannot pick anyone else.
          const restricted = result.value.length === 1 && result.value[0]?.restricted === true
          return json({ ok: true, projectId, restricted, members: result.value })
        } catch (error) {
          fail(error)
        }
      },
    }),

    // ── ④ Online devices of one account (= dispatchable instances) ────────
    defineTool({
      name: 'castboard_issue_devices',
      description:
        'List one account\'s online dsh devices — these ARE the instances an issue can be dispatched to '
        + '(each row carries host + port; the instance id is `host:port`). '
        + 'Step 3 of the issue-dispatch guidance: use it to discover which instances the assignee has, '
        + 'then ask the user which one gets the issue. Only `status=active` devices are returned. '
        + 'Do not use the workspace index as a substitute: it only covers machines that happened to '
        + 'report an index.',
      parameters: {
        userId: { type: 'string', description: 'Account (账号) whose devices to list — usually the assignee picked in step 2.' },
        account: { type: 'string', description: 'Compatibility alias for userId.' },
      },
      output: { schema: JSON_OUT, render: fullJson },
      async execute(args) {
        try {
          const raw = args as { userId?: unknown; account?: unknown }
          const userId = optionalText(raw.userId, 'userId') ?? optionalText(raw.account, 'account')
          if (userId === undefined) throw new Error('userId 必填（或传兼容别名 account）')
          const query = deps.query
          if (query === undefined) return json(degraded('共享库未接入（缺 SDK 查询面）'))
          const result = await queryOrDegrade(() => query.devices(userId))
          if (result.degraded) return json(degraded(result.reason))
          return json({
            ok: true,
            userId,
            localInstance: localInstance(deps),
            instances: result.value,
          })
        } catch (error) {
          fail(error)
        }
      },
    }),

    // ── ⑤ Workspaces (one endpoint, two views: type=index / type=portal) ──
    defineTool({
      name: 'castboard_issue_workspaces',
      description:
        'Read device workspaces from the shared library (one endpoint, two views selected by `type`). '
        + '**type="index"** — that account\'s project indexes (one row per instance, `index.md` markdown): '
        + 'pass userId + instance to read **one specific machine\'s** index, which is what you pick cwd from. '
        + 'Passing no instance gives every machine of that account mixed together — not usable for picking cwd. '
        + '**type="portal"** — one workspace portrait (needs instance + workspaceId), only when the index '
        + 'does not make the target directory obvious.',
      parameters: {
        type: {
          type: 'string',
          description: 'index (default) = project indexes of an account; '
            + 'portal = one workspace portrait (requires instance + workspaceId).',
        },
        kind: { type: 'string', description: 'Compatibility alias for type.' },
        userId: { type: 'string', description: 'index view: account (账号); defaults to the local user when the SDK knows it.' },
        instance: {
          type: 'string',
          description: 'index view: optional ip:port filter (pass it to read one machine). '
            + 'portal view: required — which machine the workspace lives on.',
        },
        workspaceId: { type: 'string', description: 'portal view: workspace id from that instance\'s index (required for type="portal").' },
      },
      output: { schema: JSON_OUT, render: fullJson },
      async execute(args) {
        try {
          const raw = args as { type?: unknown; kind?: unknown; userId?: unknown; instance?: unknown; workspaceId?: unknown }
          const kind = optionalText(raw.type, 'type') ?? optionalText(raw.kind, 'kind') ?? 'index'
          if (kind !== 'index' && kind !== 'portal') {
            throw new Error(`type 只能是 "index" 或 "portal"（收到 "${kind}"）：index 查项目索引，portal 查工作区肖像`)
          }
          const instance = optionalText(raw.instance, 'instance')
          const workspaceId = optionalText(raw.workspaceId, 'workspaceId')
          const userId = optionalText(raw.userId, 'userId')
          const query = deps.query
          if (query === undefined) return json(degraded('共享库未接入（缺 SDK 查询面）'))
          if (kind === 'portal') {
            if (instance === undefined) throw new Error('type="portal" 必须给 instance（ip:port）')
            if (workspaceId === undefined) throw new Error('type="portal" 必须给 workspaceId')
            const result = await queryOrDegrade(() => query.workspaces({ type: 'portal', instance, workspaceId }))
            if (result.degraded) return json(degraded(result.reason))
            return json({
              ok: true,
              type: 'portal',
              instance,
              workspaceId,
              ...(userId !== undefined ? { userId } : {}),
              localInstance: localInstance(deps),
              portal: result.value,
            })
          }
          const result = await queryOrDegrade(() => query.workspaces({
            type: 'index',
            ...(userId !== undefined ? { userId } : {}),
            ...(instance !== undefined ? { instance } : {}),
          }))
          if (result.degraded) return json(degraded(result.reason))
          return json({
            ok: true,
            type: 'index',
            ...(userId !== undefined ? { userId } : {}),
            ...(instance !== undefined ? { instance } : {}),
            localInstance: localInstance(deps),
            indexes: result.value,
          })
        } catch (error) {
          fail(error)
        }
      },
    }),

    // ── ⑥ Current state of one issue (record + comments + delivered artifacts) ─
    defineTool({
      name: 'castboard_issue_state',
      description:
        'Read one issue\'s current state from this host: the issue record, its comment stream, and its '
        + '**issue and comment attachments** (target model: targetType / targetId / role, with a derived '
        + 'kind), synchronized into the typed local attachment store and returned as a path list. When '
        + 'the issue has no local record or no attachment, '
        + '`found` is false / `attachments` is empty and `note` says why, instead of inventing data. Use it '
        + 'to check where a dispatched issue stands or to pick up what the other side produced.',
      parameters: {
        issueId: { type: 'string', required: true, description: 'Issue id (standard UUID).' },
      },
      output: { schema: JSON_OUT, render: fullJson },
      async execute(args, exec) {
        try {
          const issueId = requiredText((args as { issueId?: unknown }).issueId, 'issueId')
          if (!isUuid(issueId)) throw new Error(`issueId 必须是标准 UUID：${issueId}`)
          let record: IssueRecord | undefined
          try {
            record = await deps.issues.get(issueId)
          } catch (error) {
            warn('issue-state-record-failed', `${issueId}: ${messageOf(error)}`)
          }
          let remote: Record<string, unknown> | undefined
          if (record === undefined && deps.remoteIssue !== undefined) {
            try {
              remote = await deps.remoteIssue(issueId)
            } catch (error) {
              warn('issue-state-remote-failed', `${issueId}: ${messageOf(error)}`)
            }
          }
          let comments: readonly unknown[] = []
          let commentsSource: 'local' | 'remote' = 'local'
          try {
            if (record !== undefined) comments = await deps.comments.list(issueId)
            // Local empty means this issue never entered the interest set: fall back to the cloud copy.
            if (comments.length === 0 && deps.remoteComments !== undefined) {
              comments = await deps.remoteComments(issueId)
              commentsSource = 'remote'
            }
          } catch (error) {
            warn('issue-state-comments-failed', `${issueId}: ${messageOf(error)}`)
          }
          const link = deps.links?.get(issueId)
          const mySide = deps.links === undefined
            ? 'observer'
            : sideOf(link, deps, callerSession(exec as ToolRunContext))
          const issueValue = record ?? remote
          // Attachments are synchronized here (raw/host/9): the model needs local paths to read.
          // The issue target comes first (both roles), then every known comment target. A failure
          // only loses that section — the record and comments already succeeded.
          const attachments: IssueStateAttachment[] = []
          const failed: { fileName?: string; reason: string }[] = []
          let downloadedTo: string | undefined
          let downloadError: string | undefined
          const seenAttachments = new Set<string>()
          const mergeAttachments = (rows: readonly IssueStateAttachment[]): void => {
            for (const row of rows) {
              const key = `${row.targetType}\u0000${row.targetId}\u0000${row.role}\u0000${row.fileId ?? row.path}`
              if (seenAttachments.has(key)) continue
              seenAttachments.add(key)
              attachments.push(row)
            }
          }
          if (deps.syncIssueAttachments !== undefined) {
            try {
              const sync = await deps.syncIssueAttachments(issueId)
              mergeAttachments(sync.attachments)
              failed.push(...sync.failed)
              downloadedTo = sync.outputDir
            } catch (error) {
              downloadError = messageOf(error)
            }
          }
          if (deps.syncCommentAttachments !== undefined) {
            for (const commentId of commentIdsOf(comments)) {
              try {
                const sync = await deps.syncCommentAttachments(issueId, commentId)
                mergeAttachments(sync.attachments)
                failed.push(...sync.failed)
                downloadedTo ??= sync.outputDir
              } catch (error) {
                // One broken comment target must not lose the others or the issue record.
                warn('issue-state-comment-attachments-failed', `${issueId}/${commentId}: ${messageOf(error)}`)
              }
            }
          }
          const note = issueValue === undefined
            ? '本机台账与共享库都读不到这条 issue。'
            : downloadError !== undefined
              ? `附件同步失败（${downloadError}），只返回记录与评论。`
              : attachments.length === 0
                ? '这条 issue 当前没有附件。'
                : '附件已同步到本地，路径见 attachments。'
          return json({
            ok: true,
            issueId,
            found: issueValue !== undefined,
            ...(issueValue === undefined ? {} : { issue: issueValue }),
            comments,
            commentsSource,
            ...(link === undefined ? {} : { link }),
            mySide,
            attachments,
            ...(downloadedTo === undefined ? {} : { downloadedTo }),
            ...(downloadError === undefined ? {} : { downloadError }),
            ...(failed.length > 0 ? { failed } : {}),
            note,
          })
        } catch (error) {
          fail(error)
        }
      },
    }),

    // ── ⑦ Link table (issue ⇄ task ⇄ session ⇄ unread / outstanding) ───────
    defineTool({
      name: 'castboard_issue_links',
      description:
        'Look up the local issue ⇄ task ⇄ session link table (read-only). '
        + 'Answers "which session created this issue, which task does it run as, which session is executing '
        + 'it, is there an unread comment, and is either side still owing an undelivered comment". '
        + 'Pass at least one of issueId / taskId / sessionId. `mySide` says whether the calling session is '
        + 'the assigner, the assignee, both (self-dispatch), or just an observer.',
      parameters: {
        issueId: { type: 'string', description: 'Issue id.' },
        taskId: { type: 'string', description: 'Task id (resolved through the task\'s issueId).' },
        sessionId: { type: 'string', description: 'Session id (scans both session columns).' },
      },
      output: { schema: JSON_OUT, render: renderLinkTable },
      async execute(args, exec) {
        try {
          const raw = args as { issueId?: unknown; taskId?: unknown; sessionId?: unknown }
          const issueId = optionalText(raw.issueId, 'issueId')
          const taskId = optionalText(raw.taskId, 'taskId')
          const sessionId = optionalText(raw.sessionId, 'sessionId')
          if (issueId === undefined && taskId === undefined && sessionId === undefined) {
            throw new Error('至少给一个 issueId / taskId / sessionId')
          }
          if (issueId !== undefined && !isValidId(issueId)) throw new Error(`issueId 非法：${issueId}`)
          if (taskId !== undefined && !isValidId(taskId)) throw new Error(`taskId 非法：${taskId}`)
          const links = linkStoreOf(deps)
          if (links === undefined) return json({ ok: false, error: '关系表没有接入本机宿主' })
          await links.load()

          // The three optional arguments each narrow down to a candidate id set; answered from memory, no reverse index.
          const wanted = new Set<string>()
          if (issueId !== undefined) wanted.add(issueId)
          if (taskId !== undefined) {
            const viaTask = deps.tasks.get(taskId)?.issueId
            if (viaTask !== undefined && viaTask !== '') wanted.add(viaTask)
          }
          if (sessionId !== undefined) {
            for (const id of links.issueIds()) {
              const link = links.get(id)
              if (link?.assignerSessionId === sessionId || link?.assigneeSessionId === sessionId) wanted.add(id)
            }
          }

          const records = [...wanted].flatMap(id => {
            const link = links.get(id)
            if (link === undefined) return []
            return [{
              issueId: id,
              ...link,
              // Unread = the newest comment is newer than the last human look; the outstanding fields pass through as-is.
              hasUnread: (link.lastCommentAt ?? 0) > (link.lastSeenAt ?? 0),
            }]
          })
          const caller = callerSession(exec as ToolRunContext)
          const sole = wanted.size === 1 ? [...wanted][0] : undefined
          const mySide: Side = sole === undefined
            ? 'observer'
            : sideOf(links.get(sole), deps, caller)
          return json({ ok: true, links: records, mySide })
        } catch (error) {
          fail(error)
        }
      },
    }),

    // ── ⑧ Create issues (one whole batch per call) ─────────────────────────
    defineTool({
      name: 'castboard_issues_create',
      description:
        'Create issues in the shared library (issueCreateMany) so other people / other dsh instances pick '
        + `them up. **Call castboard_issues_help FIRST** — it injects the "${ISSUE_DELEGATION_SECTION}" `
        + 'guidance (field schema + the steps). '
        + 'Each item needs 5 required fields: projectId (from castboard_issue_groups), title, detail, '
        + 'assignee and assigneeInstance. Optional: assignerMeta (acceptance / reference), cwd '
        + '(omit = let the assignee pick the directory), urgency '
        + '(default normal), permission (default workspace-write), source (default `dsh`; external channels '
        + 'such as `im` must already exist in the source dictionary; `self` is normalized to `dsh`), '
        + 'attachments (input files the user picked), ref and dependsOn. '
        + 'The tool fills the rest itself: issueId (fresh UUID), sourceInstance (current device instance) '
        + 'and assignerTask (the board task you are executing, resolved from your session). '
        + '**When creating several issues at once, decide whether they depend on each other**: if B may only '
        + 'start after A is done, give A a short `ref` and put that ref into B\'s dependsOn; the tool '
        + 'translates refs into the real issueIds. Every issue listed in dependsOn must reach status=success '
        + 'before the dependent issue may enter planning. Batch-internal cycles are rejected. '
        + 'The new ids are appended to that task\'s derivedIssues. One issue = one assignee; prefer doing '
        + 'the work locally instead of dispatching it. Items that fail validation are listed in `rejected` '
        + 'while the rest of the batch is still created.',
      parameters: {
        issues: {
          type: 'array',
          required: true,
          description: `Issues to create (1..${String(MAX_ISSUES_PER_CALL)} per call). Each item needs `
            + 'projectId / title / detail / assignee / assigneeInstance; assignerMeta / cwd / urgency / '
            + 'permission / source / attachments / ref / dependsOn are optional. Unknown keys are rejected.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              projectId: {
                type: 'integer',
                required: true,
                description: 'Project id from castboard_issue_groups (positive integer).',
              },
              title: { type: 'string', required: true, description: 'Issue title (required, 1..200 chars).' },
              detail: {
                type: 'string',
                required: true,
                description: 'Full requirement: what to do and how it is accepted (required).',
              },
              assignerMeta: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  acceptanceStrategies: {
                    type: 'array',
                    description: 'Full inline acceptance strategies; the host mints each id from type + title.',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        title: { type: 'string', description: 'Strategy title.' },
                        type: { type: 'string', description: 'issue | close.' },
                        description: { type: 'string', description: 'Decision criteria.' },
                      },
                    },
                  },
                },
                description: 'Optional requester metadata. '
                  + 'Planning keys cron / checklist / acceptanceStrategies are documented in '
                  + 'castboard_issue_delegation — call castboard_issues_help first. '
                  + 'Legacy assignerMeta.title/detail is still accepted when top-level title/detail are absent.',
              },
              assignee: { type: 'string', required: true, description: 'Responsible account — exactly one person per issue.' },
              assigneeInstance: {
                type: 'string',
                required: true,
                description: 'Target instance ip:port (from castboard_issue_devices / castboard_issue_workspaces).',
              },
              cwd: {
                type: 'string',
                description: `**Optional.** Absolute project path on the target machine (≤${String(MAX_CWD_CHARS)} chars). `
                  + 'Omit it when the assignee should decide the directory itself. Never invent one: only pass '
                  + 'a path that came from castboard_issue_workspaces or from the user.',
              },
              urgency: { type: 'string', description: 'runtime | direct | urgent | normal (default) | relaxed.' },
              permission: { type: 'string', description: 'read-only | workspace-write (default) | danger-full-access.' },
              source: {
                type: 'string',
                description: '**Optional.** Defaults to `dsh`. External channels (for example `im`) must '
                  + 'already exist in `dsh_teamwork_issue_source`; `self` is normalized to `dsh`.',
              },
              attachments: {
                type: 'array',
                description: 'Input files handed to the assignee (absolute paths the user picked). '
                  + 'Omit when there is no material.',
                items: { type: 'string' },
              },
              ref: {
                type: 'string',
                description: 'Optional short alias for THIS issue inside this batch (e.g. "evt-b"). '
                  + 'Other items reference it from their dependsOn; the tool replaces it with the real minted issueId.',
              },
              dependsOn: {
                type: 'array',
                description: 'Optional. References this issue waits for: a `ref` of another item in the same '
                  + 'batch, or a real issueId (UUID) of an existing issue. **All of them must reach '
                  + 'status=success before this issue may enter planning.** Omit when there is no dependency.',
                items: { type: 'string' },
              },
            },
          },
        },
        taskId: {
          type: 'string',
          description: 'Optional: the board task these issues are derived from (= assignerTask). Usually '
            + 'unnecessary — inside a task session the tool resolves it from the caller session automatically.',
        },
      },
      output: { schema: JSON_OUT, render: fullJson },
      async execute(args, exec) {
        try {
          const instance = localInstance(deps)
          const raw = args as { issues?: unknown; taskId?: unknown }
          const rawList = raw.issues
          if (!Array.isArray(rawList) || rawList.length === 0) throw new Error('issues 必须是非空数组')
          if (rawList.length > MAX_ISSUES_PER_CALL) {
            throw new Error(`一次最多建 ${String(MAX_ISSUES_PER_CALL)} 条 issue（收到 ${String(rawList.length)} 条）`)
          }
          const explicitTask = optionalText(raw.taskId, 'taskId')
          if (explicitTask !== undefined && !isValidId(explicitTask)) throw new Error(`taskId 非法：${explicitTask}`)
          const caller = callerSession(exec as ToolRunContext)
          const assignerTask = owningTaskId(deps, caller, explicitTask)

          // Batch pipeline: shape-check every entry, resolve refs into issueIds, then submit.
          // Rejections accumulate rather than abort, so one bad entry never sinks the whole batch.
          const rejected: Rejection[] = []
          const candidates: Candidate[] = []
          rawList.forEach((item, index) => {
            try {
              candidates.push(candidateOf(item, index, instance))
            } catch (error) {
              rejected.push({ index, reason: messageOf(error) })
            }
          })

          // A duplicated ref makes dependsOn ambiguous, so those entries are rejected outright.
          const refCounts = new Map<string, number>()
          for (const candidate of candidates) {
            if (candidate.ref !== undefined) refCounts.set(candidate.ref, (refCounts.get(candidate.ref) ?? 0) + 1)
          }
          const duplicateRefs = new Set([...refCounts.entries()].filter(([, count]) => count > 1).map(([ref]) => ref))
          const alive = candidates.filter(candidate => {
            if (candidate.ref === undefined || !duplicateRefs.has(candidate.ref)) return true
            rejected.push({ index: candidate.index, reason: `ref "${candidate.ref}" 在本批里重复了（dependsOn 靠它引用，必须唯一）` })
            return false
          })

          const alias = new Map<string, Candidate>()
          for (const candidate of alive) {
            if (candidate.ref !== undefined) alias.set(candidate.ref, candidate)
          }
          const minted = new Set(alive.map(candidate => candidate.issueId))
          const byId = new Map<string, Candidate>()
          for (const candidate of alive) {
            try {
              candidate.dependsOn = resolveDependencies(candidate, alias)
              byId.set(candidate.issueId, candidate)
            } catch (error) {
              rejected.push({ index: candidate.index, reason: messageOf(error) })
            }
          }

          // Cascade: an entry whose dependency was rejected itself can never be created.
          const aliveIds = new Set(byId.keys())
          let shrank = true
          while (shrank) {
            shrank = false
            for (const candidate of [...byId.values()]) {
              const dangling = (candidate.dependsOn ?? []).find(id => minted.has(id) && !aliveIds.has(id))
              if (dangling === undefined) continue
              rejected.push({ index: candidate.index, reason: `依赖的 issue 本批没有建成（${dangling}）` })
              byId.delete(candidate.issueId)
              aliveIds.delete(candidate.issueId)
              shrank = true
            }
          }

          const staged = [...byId.values()]
          for (const candidate of cyclicCandidates(staged)) {
            rejected.push({ index: candidate.index, reason: '依赖成环（本批内互相等待，谁都进不了规划）' })
            byId.delete(candidate.issueId)
          }

          const ordered = [...byId.values()].sort((left, right) => left.index - right.index)

          // Explicit sources are validated against the dictionary; `self` folds to `dsh`.
          const requested = new Set(ordered.flatMap(candidate =>
            candidate.requestedSource === undefined ? [] : [candidate.requestedSource]))
          if (requested.size > 0) {
            if (deps.sources === undefined) {
              throw new ToolError(ERR.invalidInput, '显式 source 需要共享库来源字典，当前没有接入')
            }
            for (const code of requested) {
              if (!await deps.sources.isRegistered(code)) {
                throw new ToolError(ERR.invalidInput, `source "${code}" 不在 dsh_teamwork_issue_source 字典里`)
              }
            }
            for (const candidate of ordered) {
              if (candidate.requestedSource !== undefined) {
                candidate.source = normalizeIssueSource(candidate.requestedSource)
              }
            }
          }

          // The one source code this plugin writes must exist before issueCreateMany validates it.
          if (deps.sources !== undefined) {
            try {
              await deps.sources.ensure()
            } catch (error) {
              warn('issue-dispatch-sources-failed', `issue_sources 自愈失败（继续建 issue）：${messageOf(error)}`)
            }
          }

          const created = await submitCandidates(deps, ordered, instance, assignerTask, rejected)
          if (created.length === 0) {
            const detail = rejected.map(item => `issues[${item.index}] ${item.reason}`).join('；')
            throw new Error(`没有一条 issue 能创建：${detail || '没有可创建的条目'}`)
          }

          let derivedIssues: string[] = []
          if (assignerTask !== undefined) {
            derivedIssues = await recordDerivedIssues(deps, assignerTask, created.map(item => item.issueId))
          }

          await rememberIssueLinks(
            linkStoreOf(deps),
            created.map(item => ({ issueId: item.issueId })),
            caller,
            'issue-create',
          )
          eventLog('info', 'issue-dispatch-created', `${String(created.length)} 条（source=${created.map(item => item.candidate.source).join('/')}）`)

          return json({
            ok: true,
            created: created.map(item => ({
              index: item.candidate.index,
              issueId: item.issueId,
              assignee: item.candidate.assignee,
              assigneeInstance: item.candidate.assigneeInstance,
              ...(item.candidate.cwd !== undefined ? { cwd: item.candidate.cwd } : {}),
              source: item.candidate.source,
              urgency: item.candidate.urgency,
              permission: item.candidate.permission,
              ...(item.candidate.dependsOn !== undefined ? { dependsOn: item.candidate.dependsOn } : {}),
              ...(item.candidate.attachments !== undefined ? { attachmentCount: item.candidate.attachments.length } : {}),
            })),
            ...(rejected.length > 0 ? { rejected } : {}),
            ...(assignerTask !== undefined ? { assignerTask, derivedIssues } : {}),
          })
        } catch (error) {
          fail(error)
        }
      },
    }),
  ]
}
