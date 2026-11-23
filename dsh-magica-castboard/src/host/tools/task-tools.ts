/**
 * The ten agent tools of the task board.
 *
 * The tool layer does exactly three things: normalize model parameters into ledger fields, guard
 * the state machine and the project boundary inside the serial queue, and render results as text
 * the model can read directly. The business truth lives in `TaskStore` and `ThreadService`; no
 * persistence logic is duplicated here.
 *
 * Write discipline:
 * - Every read-modify-write happens inside a `store.mutate` mutator, so a guard always sees the
 *   newest draft in the queue; reading a clone first and writing afterwards would overwrite
 *   whatever changed while waiting.
 * - "Claim" is the only transition that hands a card to the caller session; every path into
 *   `in_progress` crosses the project boundary, and while the holder has not released it no other
 *   session may take the card over.
 * - `done` / `abandoned` are user decisions; the only programmatic exception is a caller session
 *   running the acceptance round on that very card, judged from the execution records in the
 *   ledger, never forged from parameters.
 *
 * @module dsh-magica-castboard/host/tools/task-tools
 */
import { homedir } from 'node:os'

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'

import { nextCronRunAtOrUndefined } from '../dispatch/cron.ts'
import { archiveTaskSessions } from '../exec/task-sessions.ts'
import { checklistProgress, isClaimedBy, summarize, syncClaim } from '../ledger/task-derive.ts'
import type { TaskStore } from '../ledger/task-store.ts'
import {
MAX_CHECKLIST_ITEMS,
  MAX_TAGS,
  MAX_TAG_TEXT,
  isValidId,
  type AcceptanceStrategy,
  type Actor,
  type ChecklistItem,
  type TaskLedger,
  type TaskModel,
  type TaskRecord,
  type TaskSummary,
} from '../model.ts'
import { anchorOf, type ThreadService } from '../pipeline/thread.ts'
import {
  asPermission,
  asStatus,
  asUrgency,
  canTransition,
  checklistFromTexts,
  isClaim,
  newChecklistItemId,
  newTaskId,
  normalizeAcceptanceStrategies,
  normalizeAcceptanceStrategyIds,
  normalizeBody,
  normalizeChecklist,
  normalizeExecution,
  normalizeExecutionReport,
  normalizeModel,
  normalizeTags,
  normalizeTitle,
} from '../rules.ts'
import { eventLog } from '../shared/event-log.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Stable error codes and tool errors
// ─────────────────────────────────────────────────────────────────────────────

/** Stable error code placed at the front of a tool failure message; the router maps it to an HTTP status. */
export const ERR = {
  notFound: 'not_found',
  workspaceMismatch: 'workspace_mismatch',
  invalidTransition: 'invalid_transition',
  forbidden: 'forbidden',
  requiresAgent: 'unauthorized_actor',
  invalidInput: 'invalid_input',
} as const

/**
 * Tool exception carrying a stable error code.
 *
 * `code` shows up both in the message prefix and as a field: the message is for the model, the
 * field lets upper layers avoid parsing text.
 */
export class ToolError extends Error {
  readonly code: string

  constructor(code: string, detail: string) {
    super(`Error: ${code}: ${detail}`)
    this.code = code
    this.name = 'ToolError'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace face
// ─────────────────────────────────────────────────────────────────────────────

/** Workspace capabilities the tools need (only the part in use; tests may pass a smaller stand-in). */
export interface WorkspaceFace {
  resolveByPath(path: string): Promise<{ id: string } | undefined>
  get(id: string): { id: string; path: string; title: string } | undefined
  list(): Array<{ id: string; path: string; title: string }>
  archiveSession?(sessionId: string): Promise<void>
}

/**
 * Narrow the host workspace registry down to the minimal face the tools need.
 *
 * Projecting field by field is required: registry entities expose `path` / `title` through
 * prototype getters that `JSON.stringify` cannot see, so passing an entity straight to a tool
 * would make the fields silently vanish.
 *
 * @param registry - The host workspace registry.
 */
export function workspaceFace(registry: WorkspaceRegistry): WorkspaceFace {
  const toFace = (workspace: { id: unknown; path: string; title: string }): { id: string; path: string; title: string } => ({
    id: String(workspace.id),
    path: workspace.path,
    title: workspace.title,
  })
  return {
    resolveByPath: async path => {
      const workspace = await registry.resolveByPath(path)
      return workspace === undefined ? undefined : { id: String(workspace.id) }
    },
    get: id => {
      const workspace = registry.get(id as never)
      return workspace === undefined ? undefined : toFace(workspace)
    },
    list: () => registry.list().map(toFace),
    ...(typeof registry.archiveSession === 'function'
      ? {
          archiveSession: (sessionId: string) =>
            registry.archiveSession(sessionId as Parameters<WorkspaceRegistry['archiveSession']>[0]),
        }
      : {}),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution session face
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The minimum the tools need from the execution engine: release the sessions a card no longer owns.
 *
 * Session handles belong to the execution engine; the tool layer only borrows them and never opens
 * a connection of its own. Comments are **not** a tool-layer concern: `castboard_comment_add` only
 * writes the stream, and delivery (crossed routing + echo guard) belongs to the comment service.
 */
export interface ExecutionFace {
  /** Optional fast path; without it a background cleaner eventually drops the sessions. */
  releaseTaskSessions?(taskId: string): Promise<unknown> | unknown
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool dependencies
// ─────────────────────────────────────────────────────────────────────────────

/** Every dependency of the tool set. */
export interface ToolDeps {
  store: TaskStore
  workspaces: WorkspaceFace
  thread: ThreadService
  /** Session sweeps only; comments are recorded and delivered by ThreadService, never steered here. */
  execution?: ExecutionFace
  /**
   * Artifact uplink after a report is stored (asynchronous, best-effort).
   *
   * Absent = no uplink (offline or test environment).
   */
  artifactUplink?: (
    issueId: string,
    artifacts: readonly string[],
    options: { cwd?: string; description?: string },
  ) => Promise<unknown>
  /** Current epoch ms (injected by tests). */
  now: () => number
  /**
   * Model provider routes the host has registered.
   *
   * Returning `undefined` means the runtime cannot answer, in which case only the shape is
   * validated; returning an array enables the allow-list check.
   */
  modelProviders?: () => string[] | undefined
}
export function checkModel(deps: ToolDeps, raw: unknown): TaskModel {
  const model = normalizeModel(raw)
  const providers = deps.modelProviders?.()
  if (providers !== undefined && !providers.includes(model.provider)) {
    throw new ToolError(
      ERR.invalidInput,
      `model provider "${model.provider}" is not registered (available: ${providers.join(', ')})`,
    )
  }
  return model
}

// ─────────────────────────────────────────────────────────────────────────────
// Caller identity and boundary
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolRunContext {
  agent?: {
    id: string
    session?: { id?: string; header?: { cwd?: string } }
    inject?: (message: unknown) => void
  }
}

function runContext(exec: unknown): ToolRunContext {
  return exec as ToolRunContext
}

/** Rejects scripted calls: every task tool needs a live agent session behind it. */
export function caller(exec: ToolRunContext): { actor: Actor & { kind: 'agent' }; sessionId: string } {
  const agent = exec.agent
  const sessionId = agent?.id ?? agent?.session?.id
  if (agent === undefined || typeof sessionId !== 'string' || sessionId === '') {
    throw new ToolError(ERR.requiresAgent, 'task tools require a calling agent session')
  }
  return { actor: { kind: 'agent', sessionId }, sessionId }
}

/** The project the caller session belongs to; undefined when cwd is empty or cannot be resolved (ownership unprovable). */
export async function callerWorkspace(deps: ToolDeps, exec: ToolRunContext): Promise<string | undefined> {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd === '') return undefined
  try {
    const workspace = await deps.workspaces.resolveByPath(cwd)
    return workspace?.id
  } catch {
    // A resolver failure counts as "ownership unknown": one failed lookup must not reject a legitimate call.
    return undefined
  }
}

/**
 * Project boundary: a write that can change a card's conclusion must come from a session inside
 * the card's project.
 *
 * The rule is "reject only when the crossing is proven": a caller whose project cannot be resolved
 * (cross-project integration scripts, a cwd outside every project) is let through, and only a
 * caller clearly belonging to another project is rejected. Claiming has a stricter rule of its own
 * (it must resolve to the very same project).
 *
 * @param task - The target task.
 * @param callerWsId - The caller's project; `undefined` = ownership unknown.
 * @param action - Action name used in the error text.
 */
export function assertSameProject(task: TaskRecord, callerWsId: string | undefined, action: string): void {
  if (callerWsId === undefined || callerWsId === task.workspaceId) return
  throw new ToolError(ERR.workspaceMismatch, `only a session inside this task's project may ${action}`)
}

/**
 * Look up a card that is still alive inside a mutator.
 *
 * The lookup must run against the draft the queue just handed over: a clone read earlier may have
 * passed the checks and then been changed by another write, and a later blind write would overwrite
 * that change.
 *
 * @param ledger - The draft ledger inside the serial queue.
 * @param id - Task id.
 * @throws `not_found` when it does not exist or already sits in the trash.
 */
export function liveTaskAt(ledger: TaskLedger, id: string): { index: number; task: TaskRecord } {
  const index = ledger.tasks.findIndex(candidate => candidate.id === id)
  if (index < 0) throw new ToolError(ERR.notFound, `no task ${id}`)
  const task = ledger.tasks[index]
  if (task === undefined || task.trashedAt !== undefined) throw new ToolError(ERR.notFound, `no task ${id}`)
  return { index, task }
}

/**
 * Whether this agent may move the card to `done`.
 *
 * Agents never complete cards. The single exception is the host-owned acceptance round: a
 * `trigger: 'acceptance'` execution that is still running and belongs to this session. Both
 * fields are written by the host; neither is a tool parameter, so this cannot be forged.
 */
function canCompleteTask(task: TaskRecord, sessionId: string | undefined): boolean {
  if (sessionId === undefined) return false
  return task.executions.some(execution =>
    execution.outcome === 'running'
    && execution.trigger === 'acceptance'
    && execution.sessionId === sessionId)
}

function fail(error: unknown): never {
  if (error instanceof ToolError) throw error
  if (error instanceof Error && error.name === 'ReadOnlyError') {
    throw new ToolError(ERR.forbidden, error.message)
  }
  const message = error instanceof Error ? error.message : String(error)
  throw new ToolError(ERR.invalidInput, message)
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON exit and secret masking
// ─────────────────────────────────────────────────────────────────────────────

export const JSON_OUT = { type: 'json' } as const

type JsonSafe = string | number | boolean | null | JsonSafe[] | { [key: string]: JsonSafe }

/**
 * Deep-copy a value that only holds JSON-expressible content.
 *
 * A tool's execute return value must be lossless JSON: a leftover `undefined` inside an object is
 * judged an invalid output by the host. One serialization round-trip at the exit point keeps each
 * write tool from having to clean up after itself.
 */
export function json<T>(value: T): JsonSafe {
  return JSON.parse(JSON.stringify(value)) as JsonSafe
}

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}/g, 'gh*_***'],
  [/\bnpm_[A-Za-z0-9]{8,}/g, 'npm_***'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***'],
  // JSON form: keys and values are quoted, so the value is matched on its own to avoid swallowing the fields after it.
  [/("(?:authorization|token|apikey|api_key|password)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"***"'],
  // Command-line / form form: key=value or key: value.
  [/\b(authorization|token|apikey|api_key|password)\b\s*[:=]\s*[^\s,;]+/gi, '$1=***'],
]

/**
 * Produce a piece of text fit for a trace: JSON, masked, truncated.
 *
 * The order matters: mask first, truncate second, otherwise a half-truncated credential slips past
 * the matching rules. It never throws — diagnostic output must not take a tool call down.
 *
 * @param value - Any payload to record.
 * @param limit - Maximum number of characters.
 */
export function tracePayload(value: unknown, limit = 300): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  } catch {
    text = String(value)
  }
  let safe = text
  for (const [pattern, replacement] of SECRET_PATTERNS) safe = safe.replace(pattern, replacement)
  try {
    const home = homedir()
    if (home !== '') {
      // JSON escapes backslashes, so all three common spellings of home are replaced.
      const variants = new Set([home, home.split('\\').join('/'), home.split('\\').join('\\\\')])
      for (const variant of variants) safe = safe.split(variant).join('~')
    }
  } catch {
    /* skip this step when home is unavailable */
  }
  // Strip control characters only, keeping newlines and tabs: a trace still has to be readable.
  safe = safe.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  return safe.slice(0, Math.max(0, limit))
}

// ─────────────────────────────────────────────────────────────────────────────
// Text rendering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One line per card, with id / status / urgency / project first — that is what the model scans for.
 */
function taskLine(task: TaskSummary): string {
  const parts = [
    `- ${task.id} [${task.status}] · ${task.urgency} · 项目 ${task.workspaceId}`,
    `「${task.title}」`,
  ]
  if (task.blocked) parts.push('·受阻')
  if (task.executionMode === 'scheduled') parts.push('·定时')
  if (task.checklist !== undefined && task.checklist.total > 0) {
    parts.push(`·清单${String(task.checklist.done)}/${String(task.checklist.total)}`)
  }
  if (task.lastExecutionOutcome !== undefined) parts.push(`·上次执行${task.lastExecutionOutcome}`)
  if (task.trashed) parts.push('·已删除')
  return parts.join(' ')
}

function commentAuthor(comment: { authorType: string; threadId?: string }): string {
  if (comment.authorType === 'system') return 'system'
  if (comment.threadId !== undefined && comment.threadId !== '') return `agent ${comment.threadId.slice(0, 24)}`
  return 'user'
}

function taskDetail(task: TaskRecord, now: number, comments: readonly { body: string; createdAt: number; authorType: string; threadId?: string; systemKey?: string }[]): string {
  const lines: string[] = [
    `任务 ${task.id} 「${task.title}」`,
    `状态: ${task.status} · 紧急度: ${task.urgency} · 项目: ${task.workspaceId}${task.blocked ? ' · 受阻' : ''}`,
    `执行方式: ${task.execution.mode}${task.execution.cron !== undefined ? ` cron=${task.execution.cron}` : ''}`,
  ]
  const holder = isClaimedBy(task)
  if (holder !== undefined) lines.push(`认领: agent ${holder.slice(0, 24)}（持有期间其他会话不可移动）`)
  if (task.execution.cron !== undefined) {
    const next = nextCronRunAtOrUndefined(task.execution.cron, now)
    if (next !== undefined) lines.push(`下次触发: ${new Date(next).toISOString()}`)
  }
  if (task.model !== undefined) lines.push(`固定模型: ${task.model.provider}/${task.model.model}`)
  if (task.presetId !== undefined) lines.push(`执行 preset: ${task.presetId}`)
  if (task.permission !== undefined) lines.push(`执行权限: ${task.permission}`)
  lines.push(`描述: ${task.detail.length > 0 ? task.detail : '（无）'}`)
  if (task.tags !== undefined && task.tags.length > 0) lines.push(`标签: ${task.tags.join(' / ')}`)
  if (task.checklist !== undefined && task.checklist.length > 0) {
    const progress = checklistProgress(task)
    lines.push(`验收清单 (${String(progress.done)}/${String(progress.total)}):`)
    task.checklist.forEach((item, index) => {
      const mark = item.checked ? '☑' : '☐'
      const who = item.checkedBy === undefined
        ? ''
        : item.checkedBy === 'user' ? ' ·用户勾选' : ` ·agent ${item.checkedBy.slice(0, 24)}勾选`
      const note = item.note !== undefined ? ` ·证据: ${item.note}` : ''
      lines.push(`  ${mark} [${String(index + 1)}] ${item.text}${who}${note} id=${item.id}`)
    })
  }
  if (comments.length > 0) {
    lines.push(`评论 (${String(comments.length)}):`)
    for (const comment of comments) {
      lines.push(`  - [${commentAuthor(comment)} ${new Date(comment.createdAt).toISOString()}] ${comment.body}`)
    }
  } else {
    lines.push('评论: 无')
  }
  if (task.executions.length > 0) {
    lines.push(`执行记录 (${String(task.executions.length)}):`)
    for (const execution of task.executions) {
      const at = execution.startedAt !== undefined ? new Date(execution.startedAt).toISOString() : '?'
      const report = execution.report !== undefined ? ' [已交报告]' : ''
      const error = execution.error !== undefined ? ` 错误: ${execution.error}` : ''
      lines.push(`  - [${execution.trigger} ${at}] ${execution.outcome}${report}${error}`)
    }
  } else {
    lines.push('执行记录: 无')
  }
  const updatedBy = task.updatedBy.kind === 'agent'
    ? `agent ${String(task.updatedBy.sessionId ?? '').slice(0, 24)}`
    : task.updatedBy.kind === 'system' ? 'system' : 'user'
  lines.push(`更新: ${new Date(task.updatedAt).toISOString()} 由 ${updatedBy}`)
  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalizing the checklist and acceptance-strategy arguments
// ─────────────────────────────────────────────────────────────────────────────

function toChecklistRows(items: readonly unknown[]): unknown[] {
  return items.map(item => (typeof item === 'string' ? { text: item } : item))
}

/**
 * Make the ids of one batch of checklist items collision-free.
 *
 * `itemId` is the only handle for checking or unchecking an item, and a duplicate id makes the
 * operation land on the wrong one. Ids supplied with the arguments are kept when possible and are
 * re-minted when they collide with an existing item or a sibling in the same batch.
 */
function uniqueChecklistIds(items: ChecklistItem[], reserved: ReadonlySet<string>): ChecklistItem[] {
  const seen = new Set(reserved)
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id)
      continue
    }
    let id = newChecklistItemId()
    while (seen.has(id)) id = newChecklistItemId()
    item.id = id
    seen.add(id)
  }
  return items
}

/** Derive a stable id from title + type, so a resubmitted inline strategy keeps its identity. */
function inlineStrategies(raw: unknown): AcceptanceStrategy[] | undefined {
  return normalizeAcceptanceStrategies(raw)
}

// ─────────────────────────────────────────────────────────────────────────────
// Releasing sessions after a delete
// ─────────────────────────────────────────────────────────────────────────────

/** Sessions are released after the ledger write, so a failure here is only worth a log line. */
async function releaseSessions(deps: ToolDeps, taskId: string): Promise<void> {
  try {
    await deps.execution?.releaseTaskSessions?.(taskId)
  } catch (error) {
    eventLog('warn', 'session-release-failed', `${taskId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ten tools of this domain (definitions only, no registration).
 *
 * Registration belongs to the assembly layer: the definitions are returned here and the host
 * registers them with `ctx.tools.register`.
 *
 * @param deps - Ledger, workspace face, comment service and execution session face.
 * @returns Registration-ready tool definitions; the order is the order the model sees them.
 */
export function castboardTools(deps: ToolDeps): Array<ReturnType<typeof defineTool>> {
  const tools: Array<ReturnType<typeof defineTool>> = []
  const { store, workspaces } = deps

  // ─────────────────────────────────────────────────────────────────── list
  tools.push(defineTool({
    name: 'castboard_list',
    description:
      'List task-board cards. Filter by project (workspaceId), status, or urgency; soft-deleted '
      + 'cards stay hidden unless includeTrashed is true. Returns compact summaries only — '
      + 'use castboard_get when you need the detail, checklist, comments, or execution history.',
    parameters: {
      workspaceId: { type: 'string', description: 'Filter by project (DSH workspace id).' },
      status: { type: 'string', description: 'Filter by exact status (todo/in_progress/in_review/done/canceled/archived/abandoned).' },
      urgency: { type: 'string', description: 'Filter by urgency (runtime/direct/urgent/normal/relaxed).' },
      includeTrashed: { type: 'boolean', description: 'Include soft-deleted cards (default false).' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => {
        const result = value as unknown as { revision?: number; tasks?: TaskSummary[] }
        const tasks = result.tasks ?? []
        const head = `任务 ${String(tasks.length)} 条（台账版本 ${String(result.revision ?? '?')}）`
        if (tasks.length === 0) return [{ type: 'text', text: `${head}：没有匹配的卡。` }]
        return [{ type: 'text', text: [head, ...tasks.map(taskLine)].join('\n') }]
      },
    },
    async execute(args) {
      try {
        const tasks = store.summaries().filter(task =>
          (args.workspaceId === undefined || task.workspaceId === args.workspaceId)
          && (args.status === undefined || task.status === args.status)
          && (args.urgency === undefined || task.urgency === args.urgency)
          && (args.includeTrashed === true || !task.trashed))
        return json({ revision: store.revision(), tasks })
      } catch (error) { fail(error) }
    },
  }))

  // ──────────────────────────────────────────────────────────────────── get
  tools.push(defineTool({
    name: 'castboard_get',
    description:
      'Read one card in full: fields, acceptance checklist, the latest 20 comments, and the '
      + 'execution history. Read this before claiming or continuing work so the decision is '
      + 'based on the current card rather than an earlier summary.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id from the board.' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => {
        const result = value as unknown as { task?: TaskRecord; comments?: Parameters<typeof taskDetail>[2] }
        if (result.task === undefined) return [{ type: 'text', text: '任务不存在。' }]
        return [{ type: 'text', text: taskDetail(result.task, Date.now(), result.comments ?? []) }]
      },
    },
    async execute(args) {
      try {
        const task = store.get(args.id)
        if (task === undefined || task.trashedAt !== undefined) throw new ToolError(ERR.notFound, `no task ${args.id}`)
        // Comments are read on demand; only the latest 20 are fetched, and the full timeline is left to castboard_comments.
        const comments = await deps.thread.recent(anchorOf(task), 20)
        return json({ task, comments })
      } catch (error) { fail(error) }
    },
  }))

  // ───────────────────────────────────────────────────────────────── create
  tools.push(defineTool({
    name: 'castboard_create',
    description:
      'Create a card on the board. Required: title, workspaceId, urgency. Optional: detail, '
      + 'execution mode (queue | scheduled + cron), pinned model {provider, model}, presetId, '
      + 'permission, checklist texts, tags, and the source issueId. A new card always starts '
      + 'in todo — planned work belongs on the issue side, and in_progress requires a claim.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short imperative title (1..200 chars).' },
      workspaceId: { type: 'string', required: true, description: 'Project (DSH workspace id).' },
      urgency: { type: 'string', required: true, description: 'runtime | direct | urgent | normal | relaxed.' },
      detail: { type: 'string', description: 'Card body; it becomes the instruction sent to the execution session.' },
      status: { type: 'string', description: 'Initial status; only "todo" is accepted.' },
      execution: {
        type: 'object',
        additionalProperties: false,
        description: 'Execution config: { mode: "queue" } (default) or { mode: "scheduled", cron: "m h dom mon dow" }.',
        properties: {
          mode: { type: 'string', description: 'queue | scheduled.' },
          cron: { type: 'string', description: 'Five-field cron expression (scheduled only).' },
        },
      },
      model: {
        type: 'object',
        additionalProperties: false,
        description: 'Pin executions to one registered model: { provider, model }. Omit for the deployment default.',
        properties: {
          provider: { type: 'string', description: 'Provider route id.' },
          model: { type: 'string', description: 'Provider-owned model id.' },
        },
      },
      presetId: { type: 'string', description: 'Agent preset for the execution session; omit for the deployment default.' },
      permission: { type: 'string', description: 'workspace-write | read-only | danger-full-access.' },
      checklist: {
        type: 'array',
        description: `Acceptance checklist item texts (≤${String(MAX_CHECKLIST_ITEMS)} × 200 chars).`,
        items: { type: 'string' },
      },
      tags: {
        type: 'array',
        description: `Classification tags (≤${String(MAX_TAGS)} × ${String(MAX_TAG_TEXT)} chars).`,
        items: { type: 'string' },
      },
      issueId: { type: 'string', description: 'Source issue id when this card comes from the planning column.' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => {
        const result = value as unknown as { task?: { id?: string; status?: string } }
        const task = result.task
        return [{
          type: 'text',
          text: task === undefined
            ? '创建失败。'
            : `任务 ${String(task.id)} 已创建 [${String(task.status)}]；开始处理前先用 castboard_get 读取完整正文。`,
        }]
      },
    },
    async execute(args, exec) {
      try {
        const { actor } = caller(runContext(exec))
        const title = normalizeTitle(args.title)
        const workspace = workspaces.get(args.workspaceId)
        if (workspace === undefined) throw new ToolError(ERR.notFound, `unknown workspaceId ${args.workspaceId}`)
        const urgency = asUrgency(args.urgency)
        const status = args.status === undefined ? ('todo' as const) : asStatus(args.status)
        if (status !== 'todo') {
          throw new ToolError(ERR.invalidTransition, 'a new card must start in todo; in_progress requires claiming')
        }
        const execution = normalizeExecution(args.execution ?? {})
        const model = args.model === undefined ? undefined : checkModel(deps, args.model)
        const presetId = args.presetId?.trim() || undefined
        const permission = args.permission === undefined ? undefined : asPermission(args.permission)
        const checklistTexts = args.checklist?.map(text => text.trim()).filter(text => text.length > 0)
        const checklist = checklistTexts !== undefined && checklistTexts.length > 0
          ? checklistFromTexts(checklistTexts)
          : undefined
        const tags = normalizeTags(args.tags)
        const issueId = args.issueId?.trim()
        if (issueId !== undefined && issueId !== '' && !isValidId(issueId)) {
          throw new ToolError(ERR.invalidInput, `issueId "${issueId}" is not a valid id`)
        }
        const createdAt = deps.now()
        const task: TaskRecord = {
          id: newTaskId(),
          title,
          detail: (args.detail ?? '').trim(),
          workspaceId: workspace.id,
          ...(workspace.path !== '' ? { cwd: workspace.path } : {}),
          urgency,
          status,
          blocked: false,
          ...(issueId !== undefined && issueId !== '' ? { issueId } : {}),
          execution,
          ...(model !== undefined ? { model } : {}),
          ...(presetId !== undefined ? { presetId } : {}),
          ...(permission !== undefined ? { permission } : {}),
          ...(checklist !== undefined ? { checklist } : {}),
          ...(tags !== undefined ? { tags } : {}),
          createdAt,
          updatedAt: createdAt,
          createdBy: actor,
          updatedBy: actor,
          executions: [],
        }
        await store.mutate('task-created', ledger => {
          ledger.tasks.push(task)
          return [task]
        })
        return json({ task: summarize(task) })
      } catch (error) { fail(error) }
    },
  }))

  // ───────────────────────────────────────────────────────────────── update
  tools.push(defineTool({
    name: 'castboard_update',
    description:
      'Edit the editable fields of a card: title, detail, urgency, blocked, workspaceId, execution, '
      + 'model, presetId, permission, checklist, acceptanceStrategyIds, acceptanceStrategies. '
      + 'The status is deliberately not editable here — use castboard_move so the state machine, '
      + 'claim rules, and acceptance bookkeeping stay authoritative.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      title: { type: 'string', description: 'New title (1..200 chars).' },
      detail: { type: 'string', description: 'New body text.' },
      urgency: { type: 'string', description: 'runtime | direct | urgent | normal | relaxed.' },
      blocked: { type: 'boolean', description: 'Whether the card cannot proceed right now.' },
      workspaceId: { type: 'string', description: 'Move the card to another project (DSH workspace id).' },
      execution: {
        type: 'object',
        additionalProperties: false,
        description: 'Replace the execution config: { mode: "queue" } or { mode: "scheduled", cron }.',
        properties: {
          mode: { type: 'string', description: 'queue | scheduled.' },
          cron: { type: 'string', description: 'Five-field cron expression (scheduled only).' },
        },
      },
      model: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            description: 'Pin executions to one registered model.',
            properties: {
              provider: { type: 'string', description: 'Provider route id.' },
              model: { type: 'string', description: 'Provider-owned model id.' },
            },
          },
          { type: 'null', description: 'Clear the pinned model.' },
        ],
      },
      presetId: {
        oneOf: [
          { type: 'string', description: 'New agent preset id.' },
          { type: 'null', description: 'Clear the preset and use the deployment default.' },
        ],
      },
      permission: {
        oneOf: [
          { type: 'string', description: 'workspace-write | read-only | danger-full-access.' },
          { type: 'null', description: 'Clear the override.' },
        ],
      },
      checklist: {
        oneOf: [
          {
            type: 'array',
            description: 'Replace the whole acceptance checklist (≤30 items).',
            items: {
              oneOf: [
                { type: 'string', description: 'Item text.' },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', description: 'Keep an existing item id.' },
                    text: { type: 'string', description: 'What must hold for this item.' },
                    checked: { type: 'boolean', description: 'Whether it is already checked.' },
                    checkedBy: { type: 'string', description: 'Session id or "user".' },
                    checkedAt: { type: 'number', description: 'Epoch ms of the check.' },
                    note: { type: 'string', description: 'Evidence recorded with the check (≤400 chars).' },
                  },
                },
              ],
            },
          },
          { type: 'null', description: 'Remove the whole checklist.' },
        ],
      },
      acceptanceStrategyIds: {
        oneOf: [
          {
            type: 'array',
            description: 'Replace the referenced strategy ids (≤10).',
            items: { type: 'string' },
          },
          { type: 'null', description: 'Clear all strategy references.' },
        ],
      },
      acceptanceStrategies: {
        oneOf: [
          {
            type: 'array',
            description: 'Replace the inline one-off acceptance strategies (≤10).',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', description: 'Stable strategy id; omitted means derive one from title + type.' },
                title: { type: 'string', description: 'Strategy title (≤80 chars).' },
                type: { type: 'string', description: 'issue | close.' },
                description: { type: 'string', description: 'Decision criteria (≤4000 chars).' },
              },
            },
          },
          { type: 'null', description: 'Clear all inline strategies.' },
        ],
      },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => {
        const result = value as unknown as { task?: { id?: string; status?: string } }
        const task = result.task
        return [{
          type: 'text',
          text: task === undefined
            ? '更新失败。'
            : `任务 ${String(task.id)} 已更新，当前 [${String(task.status)}]。`,
        }]
      },
    },
    async execute(args, exec) {
      try {
        const { actor } = caller(runContext(exec))
        const extra = args as unknown as Record<string, unknown>
        if (extra.status !== undefined) {
          throw new ToolError(ERR.invalidInput, 'status is not editable here; use castboard_move so the state machine applies')
        }
        const callerWsId = await callerWorkspace(deps, runContext(exec))
        await store.mutate('task-updated', ledger => {
          const { index, task } = liveTaskAt(ledger, args.id)
          assertSameProject(task, callerWsId, 'edit it')
          if (task.status === 'archived') {
            throw new ToolError(ERR.invalidTransition, 'archived cards are terminal and cannot be edited')
          }
          const next = structuredClone(task)
          if (args.title !== undefined) next.title = normalizeTitle(args.title)
          if (args.detail !== undefined) next.detail = args.detail.trim()
          if (args.urgency !== undefined) next.urgency = asUrgency(args.urgency)
          if (args.blocked !== undefined) next.blocked = args.blocked
          if (args.workspaceId !== undefined) {
            const workspace = workspaces.get(args.workspaceId)
            if (workspace === undefined) throw new ToolError(ERR.notFound, `unknown workspaceId ${args.workspaceId}`)
            next.workspaceId = workspace.id
            if (workspace.path !== '') next.cwd = workspace.path
          }
          if (args.execution !== undefined) next.execution = normalizeExecution(args.execution)
          if (args.model !== undefined) {
            if (args.model === null) delete next.model
            else next.model = checkModel(deps, args.model)
          }
          if (args.presetId !== undefined) {
            if (args.presetId === null) delete next.presetId
            else {
              const presetId = args.presetId.trim()
              if (presetId === '') delete next.presetId
              else next.presetId = presetId
            }
          }
          if (args.permission !== undefined) {
            if (args.permission === null) delete next.permission
            else next.permission = asPermission(args.permission)
          }
          if (args.checklist !== undefined) {
            if (args.checklist === null) delete next.checklist
            else {
              const checklist = normalizeChecklist(toChecklistRows(args.checklist))
              if (checklist.length === 0) delete next.checklist
              else next.checklist = checklist
            }
          }
          if (args.acceptanceStrategyIds !== undefined) {
            const ids = normalizeAcceptanceStrategyIds(args.acceptanceStrategyIds)
            if (ids === undefined) delete next.acceptanceStrategyIds
            else next.acceptanceStrategyIds = ids
          }
          if (args.acceptanceStrategies !== undefined) {
            const strategies = inlineStrategies(args.acceptanceStrategies)
            if (strategies === undefined) delete next.acceptanceStrategies
            else next.acceptanceStrategies = strategies
          }
          next.updatedAt = deps.now()
          next.updatedBy = actor
          ledger.tasks[index] = next
          return [next]
        })
        const updated = store.get(args.id)
        if (updated === undefined) throw new ToolError(ERR.notFound, `no task ${args.id}`)
        return json({ task: summarize(updated) })
      } catch (error) { fail(error) }
    },
  }))

  // ─────────────────────────────────────────────────────────────────── move
  tools.push(defineTool({
    name: 'castboard_move',
    description:
      'Move a card through the state machine. Claiming is todo→in_progress and requires a session '
      + 'inside the card\'s project; a card held by another session can never be taken over. '
      + 'After implementing and self-verifying, comment and then move in_progress→in_review. '
      + 'Agents can never move a card to done (the user confirms that, or the running acceptance '
      + 'round closes it) and can never abandon one.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      status: { type: 'string', required: true, description: 'Target status.' },
      archiveSessions: { type: 'boolean', description: 'When moving to archived, also archive the associated execution sessions. Default false.' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => {
        const result = value as unknown as {
          task?: { id?: string; status?: string }
          sessionArchive?: unknown
        }
        const task = result.task
        if (task === undefined) return [{ type: 'text', text: '移动失败。' }]
        const archive = result.sessionArchive === undefined
          ? ''
          : ` 会话归档结果：${JSON.stringify(result.sessionArchive)}`
        return [{ type: 'text', text: `任务 ${String(task.id)} 已移到 ${String(task.status)}。${archive}` }]
      },
    },
    async execute(args, exec) {
      try {
        const { actor } = caller(runContext(exec))
        const to = asStatus(args.status)
        // Claiming requires "resolves to the same project", so resolve asynchronously first and then enter the serial queue.
        const callerWsId = await callerWorkspace(deps, runContext(exec))
        let before: TaskRecord | undefined
        await store.mutate('task-moved', ledger => {
          const { index, task } = liveTaskAt(ledger, args.id)

          if (to === 'done' && !canCompleteTask(task, actor.sessionId)) {
            throw new ToolError(ERR.forbidden, 'moving a card to done requires the user (or a running acceptance round)')
          }
          if (to === 'abandoned') {
            throw new ToolError(ERR.forbidden, 'abandoning a card is a user action; agents cannot do it')
          }
          if (!canTransition(task.status, to)) {
            throw new ToolError(ERR.invalidTransition, `illegal transition ${task.status} → ${to}`)
          }
          // A held card accepts no move from another session — that would be a takeover.
          if (task.status === 'in_progress' && task.claimedBy !== undefined && task.claimedBy !== actor.sessionId) {
            throw new ToolError(ERR.forbidden, `task is held by session ${task.claimedBy}; never take over another session's claim`)
          }
          // Claiming must be strictly same-project; the other paths into in_progress use the "reject only when the crossing is proven" rule.
          if (isClaim(task.status, to) && callerWsId !== task.workspaceId) {
            throw new ToolError(ERR.workspaceMismatch, "only a session inside this task's project may claim it")
          }
          if (to === 'in_progress' && !isClaim(task.status, to)) {
            assertSameProject(task, callerWsId, 'take it')
          }

          const next = structuredClone(task)
          const stamp = deps.now()
          next.status = to
          next.updatedAt = stamp
          next.updatedBy = actor
          if (isClaim(task.status, to)) next.blocked = false
          syncClaim(next, to, stamp, isClaim(task.status, to) ? actor.sessionId : undefined)
          // Acceptance bookkeeping: leaving review voids the injection marker; going back from review
          // to todo counts as one failed round; re-entering review or taking the card over opens a new
          // round and clears the failure marker.
          if (to !== 'in_review') delete next.acceptanceInjectedAt
          if (to === 'todo' && task.acceptanceInjectedAt !== undefined) next.acceptanceFailedAt = stamp
          if (to === 'in_progress' || to === 'in_review') delete next.acceptanceFailedAt

          before = task
          ledger.tasks[index] = next
          return [next]
        })
        const updated = store.get(args.id)
        if (updated === undefined) throw new ToolError(ERR.notFound, `no task ${args.id}`)
        const sessionArchive = to === 'archived' && args.archiveSessions === true
          ? await archiveTaskSessions(before ?? updated, workspaces.archiveSession)
          : undefined
        return json({
          task: summarize(updated),
          ...(sessionArchive !== undefined ? { sessionArchive } : {}),
        })
      } catch (error) { fail(error) }
    },
  }))

  // ──────────────────────────────────────────────────────────── comment_add
  tools.push(defineTool({
    name: 'castboard_comment_add',
    description:
      'Append a progress or handoff comment to your own card. At handoff include what changed, '
      + 'how it was verified, the outcome, and remaining risks. This tool is for the EXECUTING side '
      + 'writing on its own card; if you are the assigner (the side that dispatched the issue), use '
      + 'castboard_issue_comment_add { commentRole: "assigner" } instead — a card comment is routed '
      + 'as role=assignee and your verdict would go back to yourself.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      body: { type: 'string', required: true, description: 'Comment text (1..4000 chars).' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => {
        const result = value as unknown as { id?: string; task?: { id?: string; status?: string } }
        if (result.id === undefined || result.task === undefined) return [{ type: 'text', text: '评论写入失败。' }]
        // Echo the status so the agent can chain the next write without re-reading.
        return [{ type: 'text', text: `评论 ${result.id} 已添加；任务 ${result.task.id} 当前 [${result.task.status}]。` }]
      },
    },
    async execute(args, exec) {
      try {
        const { sessionId } = caller(runContext(exec))
        const task = store.get(args.id)
        if (task === undefined || task.trashedAt !== undefined) throw new ToolError(ERR.notFound, `no task ${args.id}`)
        if (task.status === 'archived') {
          throw new ToolError(ERR.invalidTransition, 'archived cards are terminal and their comment stream is frozen')
        }
        const body = normalizeBody(args.body)
        // Raw `castboard_comment_add`: persist only. Delivery is the comment service's business
        // (crossed routing to the assigner, with the threadId echo guard); the tool must never
        // steer/followup the live execution session — that session is the writer, and the comment
        // would come back as a user message.
        const comment = await deps.thread.add(anchorOf(task), {
          body,
          role: 'assignee',
          authorType: 'agent',
          threadId: sessionId,
        })
        if (comment === undefined) throw new ToolError(ERR.invalidInput, 'comment was not written (duplicate id)')
        return json({ id: comment.id, body: comment.body, createdAt: comment.createdAt, task: { id: task.id, status: task.status } })
      } catch (error) { fail(error) }
    },
  }))

  // ──────────────────────────────────────────────────────────────── comments
  tools.push(defineTool({
    name: 'castboard_comments',
    description:
      'Read a card\'s recent comments, oldest first. Read them before starting or resuming work; '
      + 'use limit to keep the window small when a long thread would flood the context.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      limit: { type: 'integer', description: 'How many of the latest comments to return (1..200, default 50).' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => {
        const result = value as unknown as { comments?: Array<{ body: string; createdAt: number; authorType: string; threadId?: string }> }
        const comments = result.comments ?? []
        if (comments.length === 0) return [{ type: 'text', text: '无评论。' }]
        const lines = comments.map(comment =>
          `- [${commentAuthor(comment)} ${new Date(comment.createdAt).toISOString()}] ${comment.body}`)
        return [{ type: 'text', text: `评论 ${String(comments.length)} 条：\n${lines.join('\n')}` }]
      },
    },
    async execute(args) {
      try {
        const task = store.get(args.id)
        if (task === undefined || task.trashedAt !== undefined) throw new ToolError(ERR.notFound, `no task ${args.id}`)
        const limit = Math.min(200, Math.max(1, Math.floor(args.limit ?? 50)))
        return json({ comments: await deps.thread.recent(anchorOf(task), limit) })
      } catch (error) { fail(error) }
    },
  }))

  // ───────────────────────────────────────────────────────────────── delete
  tools.push(defineTool({
    name: 'castboard_delete',
    description:
      'Soft-delete a card by stamping trashedAt; the user decides in the GUI whether to purge it. '
      + 'Pass purge=true only for a card that is already in the trash to erase its record. '
      + 'Prefer canceled/archived over deleting a card that was real work. Deleting releases the '
      + 'card\'s claim and execution sessions.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      purge: { type: 'boolean', description: 'Permanently erase a card that is already soft-deleted (default false).' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => {
        const result = value as unknown as { trashed?: boolean; purged?: boolean }
        if (result.purged === true) return [{ type: 'text', text: '任务已永久删除。' }]
        if (result.trashed === true) return [{ type: 'text', text: '任务已移入回收站，等待用户在面板确认清除。' }]
        return [{ type: 'text', text: '删除失败。' }]
      },
    },
    async execute(args, exec) {
      try {
        const { actor } = caller(runContext(exec))
        const callerWsId = await callerWorkspace(deps, runContext(exec))
        if (args.purge === true) {
          await store.mutate('task-deleted', ledger => {
            const index = ledger.tasks.findIndex(candidate => candidate.id === args.id)
            const task = index < 0 ? undefined : ledger.tasks[index]
            if (task === undefined) throw new ToolError(ERR.notFound, `no task ${args.id}`)
            if (task.trashedAt === undefined) {
              throw new ToolError(ERR.invalidInput, 'purge is only allowed for a card that is already in the trash')
            }
            assertSameProject(task, callerWsId, 'purge it')
            ledger.tasks.splice(index, 1)
            return []
          })
          await releaseSessions(deps, args.id)
          return json({ purged: true })
        }
        await store.mutate('task-deleted', ledger => {
          const { index, task } = liveTaskAt(ledger, args.id)
          assertSameProject(task, callerWsId, 'delete it')
          if (task.status === 'archived') {
            throw new ToolError(ERR.invalidTransition, 'archived cards are terminal; leave them to the user')
          }
          if (task.status === 'done') {
            throw new ToolError(ERR.forbidden, 'done cards are the user\'s record; only the user may delete one')
          }
          if (task.status === 'in_progress') {
            throw new ToolError(ERR.invalidTransition, 'move the card out of in_progress before deleting it')
          }
          if (task.executions.some(execution => execution.outcome === 'running')) {
            throw new ToolError(ERR.invalidInput, 'the card still has a running execution; cancel it or wait for it to settle')
          }
          const next = structuredClone(task)
          const stamp = deps.now()
          next.trashedAt = stamp
          next.updatedAt = stamp
          next.updatedBy = actor
          delete next.claimedBy
          delete next.claimedAt
          next.blocked = false
          ledger.tasks[index] = next
          return [next]
        })
        await releaseSessions(deps, args.id)
        return json({ trashed: true })
      } catch (error) { fail(error) }
    },
  }))

  // ────────────────────────────────────────────────────────────── checklist
  tools.push(defineTool({
    name: 'castboard_checklist',
    description:
      'Manage a card\'s acceptance checklist (Definition of Done). Actions: add/append item texts '
      + '(≤10 per call), replace the whole list, check an item by itemId with an optional evidence '
      + 'note, or uncheck it. Checking items never completes the card — done stays a user action.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      action: {
        type: 'string',
        required: true,
        enum: ['add', 'append', 'replace', 'check', 'uncheck'],
        description: 'add | append | replace | check | uncheck.',
      },
      items: {
        type: 'array',
        description: 'Item texts (add/append/replace).',
        items: {
          oneOf: [
            { type: 'string', description: 'Item text.' },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', description: 'Existing item id to keep.' },
                text: { type: 'string', description: 'What must hold for this item.' },
                checked: { type: 'boolean', description: 'Whether it is already checked.' },
                note: { type: 'string', description: 'Evidence recorded with the check (≤400 chars).' },
              },
            },
          ],
        },
      },
      itemId: { type: 'string', description: 'Checklist item id for check/uncheck.' },
      note: { type: 'string', description: 'Evidence note recorded with the check (≤400 chars).' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => {
        const result = value as unknown as {
          task?: { id?: string }
          checklist?: ChecklistItem[]
          done?: number
          total?: number
        }
        if (result.task === undefined || result.checklist === undefined) {
          return [{ type: 'text', text: '清单操作失败。' }]
        }
        const lines = result.checklist.map((item, index) => {
          const mark = item.checked ? '☑' : '☐'
          const note = item.note !== undefined ? `（证据: ${item.note}）` : ''
          return `${mark} [${String(index + 1)}] ${item.text}${note} id=${item.id}`
        })
        return [{
          type: 'text',
          text: `任务 ${String(result.task.id)} 验收清单 ${String(result.done ?? 0)}/${String(result.total ?? 0)}：\n${lines.join('\n')}`,
        }]
      },
    },
    async execute(args, exec) {
      try {
        const { actor } = caller(runContext(exec))
        const callerWsId = await callerWorkspace(deps, runContext(exec))
        let next: TaskRecord | undefined
        await store.mutate('task-updated', ledger => {
          const located = liveTaskAt(ledger, args.id)
          const task = located.task
          assertSameProject(task, callerWsId, 'edit its acceptance checklist')
          if (task.status === 'archived') {
            throw new ToolError(ERR.invalidTransition, 'archived cards are terminal')
          }
          const updated = structuredClone(task)
          const checklist: ChecklistItem[] = task.checklist === undefined ? [] : structuredClone(task.checklist)

          if (args.action === 'add' || args.action === 'append') {
            const items = args.items ?? []
            if (items.length === 0 || items.length > 10) {
              throw new ToolError(ERR.invalidInput, 'items must carry 1..10 entries per add call')
            }
            const additions = uniqueChecklistIds(
              normalizeChecklist(toChecklistRows(items)),
              new Set(checklist.map(item => item.id)),
            )
            if (checklist.length + additions.length > MAX_CHECKLIST_ITEMS) {
              throw new ToolError(
                ERR.invalidInput,
                `checklist may hold at most ${String(MAX_CHECKLIST_ITEMS)} items (currently ${String(checklist.length)})`,
              )
            }
            checklist.push(...additions)
          } else if (args.action === 'replace') {
            const items = args.items ?? []
            const replacement = uniqueChecklistIds(normalizeChecklist(toChecklistRows(items)), new Set())
            checklist.splice(0, checklist.length, ...replacement)
          } else if (args.action === 'check' || args.action === 'uncheck') {
            if (args.itemId === undefined) {
              throw new ToolError(ERR.invalidInput, `itemId is required for ${args.action}`)
            }
            const item = checklist.find(candidate => candidate.id === args.itemId)
            if (item === undefined) {
              throw new ToolError(ERR.notFound, `no checklist item ${args.itemId} (task ${args.id})`)
            }
            if (args.action === 'check') {
              item.checked = true
              item.checkedBy = actor.sessionId
              item.checkedAt = deps.now()
              const note = args.note?.trim()
              if (note !== undefined && note !== '') item.note = note.slice(0, 400)
            } else {
              item.checked = false
              delete item.checkedBy
              delete item.checkedAt
              delete item.note
            }
          } else {
            throw new ToolError(ERR.invalidInput, `unknown checklist action "${String(args.action)}"`)
          }

          if (checklist.length > 0) updated.checklist = checklist
          else delete updated.checklist
          updated.updatedAt = deps.now()
          updated.updatedBy = actor
          ledger.tasks[located.index] = updated
          next = updated
          return [updated]
        })
        const stored = next ?? store.get(args.id)
        if (stored === undefined) throw new ToolError(ERR.notFound, `no task ${args.id}`)
        const progress = stored.checklist === undefined
          ? { done: 0, total: 0 }
          : checklistProgress(stored)
        return json({
          task: { id: stored.id },
          checklist: stored.checklist ?? [],
          ...progress,
        })
      } catch (error) { fail(error) }
    },
  }))

  // ─────────────────────────────────────────────────────── execution report
  tools.push(defineTool({
    name: 'castboard_execution_report',
    description:
      'Submit the structured execution report for the card you are executing: summary, changed '
      + 'files, checks, artifacts, and remaining risk. Submit it BEFORE moving the card to '
      + 'in_review; a later submission overwrites the earlier one. If your run already settled, '
      + 'the report is back-filled onto your latest succeeded execution. This report is the '
      + 'reviewer\'s only record of the work. ARTIFACTS are deliverables a human would open '
      + '(build outputs, screenshots, generated documents); changed source files belong in '
      + 'changedFiles, so a pure code change leaves artifacts empty.',
    parameters: {
      summary: { type: 'string', required: true, description: 'What was done (1..2000 chars).' },
      changedFiles: {
        type: 'array',
        description: 'Files you changed (paths, ≤50 × 300 chars).',
        items: { type: 'string' },
      },
      checks: {
        type: 'array',
        description: 'How the work was verified (test commands + outcomes, ≤50 entries).',
        items: { type: 'string' },
      },
      artifacts: {
        type: 'array',
        description: 'Deliverables worth reviewing (build outputs, screenshots, docs, ≤30 entries).',
        items: { type: 'string' },
      },
      risk: { type: 'string', description: 'Known remaining risks or follow-ups (≤2000 chars).' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => {
        const result = value as unknown as {
          taskId?: string
          executionId?: string
          report?: { summary?: string }
        }
        if (result.taskId === undefined || result.report === undefined) {
          return [{ type: 'text', text: '报告提交失败。' }]
        }
        return [{
          type: 'text',
          text: `执行报告已写入任务 ${result.taskId}（执行 ${String(result.executionId)}）：`
            + `${result.report.summary?.slice(0, 120) ?? ''}\n`
            + '接下来：用 castboard_comment_add 留交接评论，再用 castboard_move 移到 in_review。',
        }]
      },
    },
    async execute(args, exec) {
      try {
        const { actor, sessionId } = caller(runContext(exec))
        const report = normalizeExecutionReport(args)
        let taskId: string | undefined
        let executionId: string | undefined
        await store.mutate('execution-recorded', ledger => {
          // ① Prefer attaching to the execution this session is currently running.
          for (const task of ledger.tasks) {
            if (task.trashedAt !== undefined) continue
            const running = task.executions.find(execution =>
              execution.sessionId === sessionId && execution.outcome === 'running')
            if (running === undefined) continue
            running.report = report
            task.updatedAt = deps.now()
            task.updatedBy = actor
            taskId = task.id
            executionId = running.id
            return [task]
          }
          // ② With no running execution, back-fill the latest succeeded execution of this session (newest by end/start time).
          let target: { task: TaskRecord; execution: TaskRecord['executions'][number]; at: number } | undefined
          for (const task of ledger.tasks) {
            if (task.trashedAt !== undefined || task.status === 'archived') continue
            for (const execution of task.executions) {
              if (execution.sessionId !== sessionId || execution.outcome !== 'succeeded') continue
              const at = execution.endedAt ?? execution.startedAt ?? 0
              if (target === undefined || at >= target.at) target = { task, execution, at }
            }
          }
          if (target === undefined) return undefined
          target.execution.report = report
          target.task.updatedAt = deps.now()
          target.task.updatedBy = actor
          taskId = target.task.id
          executionId = target.execution.id
          return [target.task]
        })
        if (taskId === undefined || executionId === undefined) {
          throw new ToolError(
            ERR.forbidden,
            'no running execution owned by this session and no succeeded execution to back-fill onto',
          )
        }
        // The artifact uplink is an extra action: the report is already stored, so it is not awaited and a failure cannot affect the tool result.
        const stored = store.get(taskId)
        if (deps.artifactUplink !== undefined && stored?.issueId !== undefined && stored.issueId !== '') {
          try {
            void deps.artifactUplink(stored.issueId, report.artifacts, {
              ...(stored.cwd !== undefined ? { cwd: stored.cwd } : {}),
              description: report.summary,
            }).catch(() => { /* the uplink records its own failures */ })
          } catch {
            /* a synchronous throw must not affect the already stored report either */
          }
        }
        return json({ taskId, executionId, report })
      } catch (error) { fail(error) }
    },
  }))

  return tools
}
