/**
 * Foundation of the tool surface: parameter types, parameter validation, error folding, and the
 * rendering contract.
 *
 * Rendering contract: what `output.render` returns **is** what the model sees, so it must carry
 * the id / status / checklist itemId instead of a stray line of JSON.
 * @module dsh-magica-castboard/host/tools/shared
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TaskStore } from '../ledger/task-store.ts'
import type { IssueStore } from '../ledger/issue-store.ts'
import type { CommentStore } from '../ledger/comment-store.ts'
import type { LinkStore } from '../ledger/link-store.ts'
import { HttpFailure } from '../http/router.ts'
import { jsonRoundTrip } from '../ledger/atomic.ts'
import { isValidId } from '../ledger/paths.ts'
import type { TaskLedger, TaskRecord, Urgency } from '../model.ts'
import { URGENCIES } from '../model.ts'
import type {
  AttachmentKind,
  AttachmentRole,
  AttachmentTargetType,
} from '../pipeline/attachments.ts'
import type { IssueQueryFace } from '../pipeline/sdk-query.ts'
import type { ThreadService } from '../pipeline/thread.ts'
import { canTransition, TASK_STATUSES, type TaskStatus } from '../rules.ts'

export type ParamSpec = Record<string, { type: 'string' | 'number' | 'boolean' | 'array' | 'object'; required?: true; description?: string }>

// Let the tool files pull types from a single entry point (they only import './shared.ts')
export type { TaskRecord } from '../model.ts'

/** One attachment row in `castboard_issue_state` (target model + derived kind for the model/UI). */
export interface IssueStateAttachment {
  name: string
  path: string
  targetType: AttachmentTargetType
  targetId: string
  role: AttachmentRole
  kind: AttachmentKind
  state?: 'pending' | 'ready'
  fileId?: string
  size?: number
  description?: string
}

/** Result of synchronizing one attachment target for `castboard_issue_state`. */
export interface IssueStateAttachmentSync {
  attachments: readonly IssueStateAttachment[]
  failed: readonly { fileName?: string; reason: string }[]
  outputDir: string
}

/**
 * The in-repo tool shape (narrower than dsh's `ToolDefinition`).
 *
 * At runtime `parameters` is the JSON Schema that **defineTool compiled**; tests only need to read
 * the keys, so it is declared as a plain record here and the host's internal `ToolRunContext` type
 * never leaks into the tests.
 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: unknown; render: (value: unknown) => unknown }
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

export interface ToolDeps {
  /** Batch create through the SDK; absent leaves issues local. */
  remoteCreate?: { createMany: (inputs: readonly Record<string, unknown>[]) => Promise<{ created: { issueId: string; title: string }[]; skipped: readonly string[] }> }
  resolveWorkspace?: (cwd: string) => Promise<string | undefined>
  links?: LinkStore
  thread?: Pick<ThreadService, 'add'>
  /** This machine's ip:port, quoted back in the dispatch guidance. */
  instance?: () => string
  /** Returns false when the session cannot take injected context; the payload then ships in the result. */
  inject?: (sessionId: string | undefined, entries: readonly { name: string; text: string }[]) => boolean
  /** Dispatch source dictionary: `ensure` registers self/dsh, `isRegistered` never registers. */
  sources?: {
    ensure(): Promise<void>
    isRegistered(code: string): Promise<boolean>
  }
  /** Absent turns the shared-library tools into `degraded` receipts rather than empty results. */
  query?: IssueQueryFace;
  remoteIssue?: (issueId: string) => Promise<Record<string, unknown> | undefined>
  remoteComments?: (issueId: string) => Promise<readonly {
    id?: string
    body: string
    createdAt: number
    role?: string
    authorType?: string
    author?: string
  }[]>
  /** Synchronize the issue target (both roles) into the local store for `castboard_issue_state`. */
  syncIssueAttachments?: (issueId: string) => Promise<IssueStateAttachmentSync>
  /** Synchronize one comment target for `castboard_issue_state`. */
  syncCommentAttachments?: (issueId: string, commentId: string) => Promise<IssueStateAttachmentSync>
  tasks: TaskStore
  issues: IssueStore
  comments: CommentStore
  now: () => number
  /** Session → workspace (project boundary); when unavailable no boundary check is made. */
  workspaceOf?: (exec: unknown) => string | undefined
}

export function renderJson(value: unknown): unknown {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

/**
 * The model reads this directly, so one line per card: `id · status · urgency · title`.
 */
export function renderTaskList(value: unknown): unknown {
  const tasks = (value as { tasks?: readonly Record<string, unknown>[] } | null)?.tasks ?? []
  if (tasks.length === 0) return [{ type: 'text', text: '(没有卡)' }]
  const lines = tasks.map(task => {
    const checklist = task.checklist as readonly { done: boolean }[] | undefined
    const progress = checklist === undefined || checklist.length === 0
      ? ''
      : ` 清单 ${String(checklist.filter(item => item.done).length)}/${String(checklist.length)}`
    return `${String(task.id)} · ${String(task.status)} · ${String(task.urgency)} · ${String(task.title)}${progress}`
  })
  return [{ type: 'text', text: lines.join('\n') }]
}

export function renderTaskDetail(value: unknown): unknown {
  const input = value as {
    task?: Record<string, unknown>
    comments?: readonly { role?: string; authorType?: string; body?: string }[]
    executions?: readonly Record<string, unknown>[]
  } | null
  const task = input?.task
  if (task === undefined) return [{ type: 'text', text: '(任务不存在)' }]
  const lines: string[] = [
    `# ${String(task.id)} · ${String(task.title)}`,
    `状态 ${String(task.status)} · 紧急度 ${String(task.urgency)} · 权限 ${String(task.permission ?? '—')}`,
  ]
  if (task.detail !== undefined && task.detail !== '') lines.push('', String(task.detail))
  const checklist = task.checklist as readonly { text: string; done: boolean; note?: string }[] | undefined
  if (checklist !== undefined && checklist.length > 0) {
    lines.push('', `验收清单 ${String(checklist.filter(item => item.done).length)}/${String(checklist.length)}`)
    for (const item of checklist) {
      lines.push(`- [${item.done ? 'x' : ' '}] ${item.text}${item.note === undefined ? '' : `（${item.note}）`}`)
    }
  }
  const comments = input?.comments ?? []
  if (comments.length > 0) {
    lines.push('', `最近评论 ${String(comments.length)} 条`)
    for (const comment of comments) {
      lines.push(`- [${comment.role ?? '?'}/${comment.authorType ?? '?'}] ${(comment.body ?? '').slice(0, 500)}`)
    }
  }
  const executions = input?.executions ?? []
  if (executions.length > 0) {
    lines.push('', '执行史')
    for (const execution of executions) {
      lines.push(`- ${String(execution.outcome)} · ${String(execution.trigger)}${execution.error === undefined ? '' : ` · ${String(execution.error)}`}`)
    }
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

export function renderHuman(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  const record = value as Record<string, unknown>
  if (record.degraded === true) return `共享库不可用：${String(record.reason ?? '未接入')}`
  if (Array.isArray(record.items)) {
    const items = record.items as readonly Record<string, unknown>[]
    if (items.length === 0) return '（空）'
    return items.map(item => `- ${String(item.label ?? item.name ?? item.id ?? '')}（${String(item.id ?? '')}）${item.detail === undefined ? '' : ' — ' + String(item.detail)}`).join('\n')
  }
  if (Array.isArray(record.issueIds)) {
    return `已建 ${String((record.issueIds as unknown[]).length)} 条：${(record.issueIds as unknown[]).map(String).join(', ')}`
  }
  const lines: string[] = []
  if (record.task !== undefined) {
    const task = record.task as Record<string, unknown>
    lines.push(`任务 ${String(task.id ?? '')} · ${String(task.title ?? '')} · ${String(task.status ?? '')}`)
  }
  if (record.issue !== undefined) {
    const issue = record.issue as Record<string, unknown>
    lines.push(`issue ${String(issue.issueId ?? '')} · ${String(issue.title ?? '')} · ${String(issue.status ?? '')}`)
  }
  if (record.link !== undefined && record.link !== null) {
    const link = record.link as Record<string, unknown>
    const fields = ['assignerSessionId', 'assigneeSessionId', 'assigneeTaskId'].filter(key => typeof link[key] === 'string')
    if (fields.length > 0) lines.push('关系：' + fields.map(key => `${key}=${String(link[key])}`).join(' '))
  }
  if (Array.isArray(record.comments)) lines.push(`评论 ${String((record.comments as unknown[]).length)} 条`)
  return lines.length > 0 ? lines.join('\n') : JSON.stringify(value)
}

/**
 * Wrap human-readable text into the **content block array** the host requires.
 *
 * `ToolDefinition.output.render` has the contract `(args, value) => ContentBlock[]` (dsh-tools
 * `lib/types/index.d.ts`). Returning a bare string makes the host throw
 * `content.some is not a function` while committing the result: the side effects are already
 * persisted, yet the tool reports an error and the caller (router or execution session) treats it
 * as a failure and retries.
 */
export function withHumanRender(definition: ToolDefinition): ToolDefinition {
  return {
    ...definition,
    output: {
      schema: definition.output.schema,
      render: value => [{ type: 'text', text: renderHuman(value) }],
    },
  }
}

export function tool(
  name: string,
  description: string,
  parameters: ParamSpec,
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>,
  render: (value: unknown) => unknown = renderJson,
): ToolDefinition {
  // Must go through defineTool: it compiles the **authoring-form parameter table** into a valid JSON
  // Schema and validates the input against it. Registering the bare table would hand the model a
  // `{title:{type,required,description}}` shape, and the call then fails with
  // "Invalid schema for function ... is not of type string".
  return defineTool({
    name,
    description,
    parameters: parameters as never,
    output: {
      schema: { type: 'json' },
      render: value => render(value) as never,
    },
    // The host accepts only **lossless JSON** as the execute return value: an `undefined` inside an
    // object (`{ workspaceId: undefined }`, `{ ref: undefined }`) is rejected with
    // `value is not lossless JSON`. Normalize once at the single exit point so no write tool has to
    // guard against it on its own.
    execute: async (args, exec) => jsonRoundTrip(await execute(args as Record<string, unknown>, exec as unknown)) as Promise<never>,
  }) as unknown as ToolDefinition
}

/**
 * Session id of the current tool call.
 *
 * The host's `ToolExecution` carries **no** `sessionId` field: the identity lives on
 * `exec.agent.session.id` (`ToolExecutionInput.agent`, dsh-tools `lib/types/index.d.ts`). Reading
 * `exec.sessionId` alone keeps `castboard_execution_report` failing with `unauthorized_actor` and
 * silently drops `createdBy` / `updatedBy` / `originSessionId` / `assignerSessionId`.
 */
export function sessionIdOf(exec: unknown): string | undefined {
  const directSessionId = (exec as { sessionId?: unknown } | undefined)?.sessionId
  if (typeof directSessionId === 'string' && directSessionId !== '') return directSessionId
  const agent = (exec as { agent?: { session?: { id?: unknown } } } | undefined)?.agent
  const id = agent?.session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

export function str(args: Record<string, unknown>, key: string, max = 200): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} 必填`)
  if (value.length > max) throw new Error(`${key} 超长（最大 ${max}）`)
  return value
}

export function optStr(args: Record<string, unknown>, key: string, max = 20000): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`)
  if (value.length > max) throw new Error(`${key} 超长（最大 ${max}）`)
  return value
}

export function enumArg<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[], fallback?: T): T {
  const value = args[key]
  if (value === undefined) {
    if (fallback !== undefined) return fallback
    throw new Error(`${key} 必填`)
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${key} 只允许 ${allowed.join(' / ')}`)
  return value as T
}

export function boolArg(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔`)
  return value
}

export function taskIdArg(args: Record<string, unknown>): string {
  const id = args.taskId
  if (typeof id !== 'string' || !isValidId(id)) throw new Error('taskId 非法')
  return id
}

export function draftTask(draft: TaskLedger, id: string): TaskRecord {
  const task = draft.tasks.find(candidate => candidate.id === id)
  if (task === undefined) throw new HttpFailure('not_found', '任务不存在', 404)
  if (task.trashedAt !== undefined) throw new HttpFailure('conflict', '任务在回收站', 409)
  return task
}

