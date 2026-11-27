/**
 * `/issues` route group: create, read, update, comment, mark read, abandon, and delete
 * pending items, plus the "dispatched by me" list.
 *
 * Validation and persistence share one store write, so a rejected gate leaves neither
 * disk nor memory half-updated; status checks and normalization live inside the mutator.
 * There is no issue-to-task endpoint: the router creates cards and the task side writes
 * `assigneeTask`.
 *
 * @module dsh-magica-castboard/host/http/routes/issues
 */
import { eventLog } from '../../shared/event-log.ts'
import { HttpFailure, type Route, type RouteContext } from '../router.ts'
import { mapLimit } from '../../shared/async.ts'
import {
  type CreateIssueBody,
  type ThreadComment,
} from '../../model.ts'
import {
  asIssueStatus,
  isValidIssueId,
  normalizeIssueTitle,
} from '../../ledger/issue-validate.ts'
import { asPermission, asUrgency, normalizeBody } from '../../rules.ts'
import { objectBody, queryValue, type RouteDeps } from './shared.ts'
import type { SdkIssueSummary } from '../../pipeline/sdk-face.ts'

export interface IssueRouteCapabilities {
  workspaces?: { get: (workspaceId: string) => unknown }
  issueState?: (issueId: string) => Promise<unknown>
  issueBrief?: (issueId: string) => Promise<{ title?: string; status?: string; urgency?: string; assignee?: string } | undefined>
  createRemote?: (draft: CreateIssueBody) => Promise<{ issueId: string; assignee: string }>
  abandonRemote?: (issueIds: readonly string[]) => Promise<void>
  issueList?: (query: {
    pageNum?: number
    pageSize?: number
    status?: string
    projectId?: number
    keyword?: string
  }) => Promise<readonly SdkIssueSummary[]>
  taskExists?: (taskId: string) => boolean
}

export type IssueRouteDeps = RouteDeps & IssueRouteCapabilities

const MAX_DISPATCHED = 50

const BRIEF_CONCURRENCY = 4

function warn(event: string, detail: string): void {
  eventLog('warn', event, detail)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function issueIdOf(context: RouteContext): string {
  const id = context.params.id ?? ''
  if (!isValidIssueId(id)) throw new HttpFailure('invalid_input', '无效的 issue id', 400)
  return id
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new HttpFailure('invalid_input', `${key} 必须是字符串`, 400)
  return value
}

function requiredText(body: Record<string, unknown>, key: string): string {
  const value = stringField(body, key)?.trim() ?? ''
  if (value === '') throw new HttpFailure('invalid_input', `${key} 必填`, 400)
  return value
}

function trimmedField(body: Record<string, unknown>, key: string): string | undefined {
  const value = stringField(body, key)?.trim()
  return value === undefined || value === '' ? undefined : value
}

function attachmentsField(body: Record<string, unknown>): string[] | undefined {
  const value = body.attachments
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new HttpFailure('invalid_input', 'attachments 必须是字符串数组', 400)
  const paths: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const path = item.trim()
    if (path !== '' && !paths.includes(path)) paths.push(path)
  }
  return paths.length === 0 ? undefined : paths
}

function taskAlive(deps: IssueRouteDeps, taskId: string | undefined): boolean {
  if (taskId === undefined || taskId === '') return false
  if (deps.taskExists !== undefined) return deps.taskExists(taskId)
  return deps.tasks.get(taskId) !== undefined
}

/**
 * An issue converted to a task whose card no longer exists. It cannot pass the store's
 * abandon gate (status is `routing`), so it would otherwise stay pending forever.
 */
function isDanglingRouting(deps: IssueRouteDeps, issueId: string): boolean {
  const summary = deps.issues.summary(issueId)
  if (summary === undefined || summary.status !== 'routing') return false
  return !taskAlive(deps, summary.assigneeTask)
}

async function abandonRemoteIfNeeded(deps: IssueRouteDeps, issueId: string): Promise<void> {
  const record = await deps.issues.get(issueId)
  if (record === undefined) return
  const remote = deps.abandonRemote
  if (remote === undefined) throw new HttpFailure('internal', '共享库不可用：不能放弃 issue', 503)
  await remote([issueId])
}

async function commentsOf(deps: IssueRouteDeps, issueId: string): Promise<ThreadComment[]> {
  try {
    return await deps.thread.list(issueId)
  } catch (error) {
    warn('issue-comments-read-failed', `${issueId}: ${errorText(error)}`)
    return []
  }
}

async function listDispatched(deps: IssueRouteDeps): Promise<{
  issues: Array<Record<string, unknown>>
  truncated: boolean
}> {
  await deps.links.load()
  const recency = (issueId: string): number => {
    const link = deps.links.get(issueId)
    return Math.max(link?.lastCommentAt ?? 0, link?.lastSeenAt ?? 0)
  }
  const mine = deps.links
    .issueIds()
    .filter(issueId => deps.links.get(issueId)?.assignerSessionId !== undefined)
    .sort((left, right) => recency(right) - recency(left))
  const capped = mine.slice(0, MAX_DISPATCHED)

  const rows = await mapLimit(capped, BRIEF_CONCURRENCY, async (issueId) => {
    const link = deps.links.get(issueId)
    const lastCommentAt = link?.lastCommentAt
    const base: Record<string, unknown> = {
      issueId,
      hasUnread: lastCommentAt !== undefined && lastCommentAt > (link?.lastSeenAt ?? 0),
      ...(lastCommentAt === undefined ? {} : { lastCommentAt }),
      ...(link?.assigneeTaskId === undefined ? {} : { assigneeTaskId: link.assigneeTaskId }),
    }
    if (deps.issueBrief === undefined) return base
    try {
      const brief = await deps.issueBrief(issueId)
      if (brief === undefined) return base
      return {
        ...base,
        ...(brief.title === undefined ? {} : { title: brief.title }),
        ...(brief.status === undefined ? {} : { status: brief.status }),
        ...(brief.urgency === undefined ? {} : { urgency: brief.urgency }),
        ...(brief.assignee === undefined ? {} : { assignee: brief.assignee }),
      }
    } catch {
      // Offline or the issue was erased: return the id and unread state without failing the batch.
      return base
    }
  })
  return { issues: rows, truncated: mine.length > capped.length }
}

// Literal paths must come before `:id`, or the id segment swallows them.
export function issuesRoutes(deps: IssueRouteDeps): readonly Route[] {
  const now = (): number => deps.now()

  return [
    {
      method: 'GET',
      path: '/issues/dispatched',
      handler: () => listDispatched(deps),
    },

    {
      method: 'GET',
      path: '/issues/mine',
      handler: async () => {
        const local = (): { items: Array<Record<string, unknown>> } => ({
          items: deps.issues.pending().map(item => ({
            id: item.id,
            title: item.title,
            status: item.status,
            urgency: item.urgency,
            updatedAt: item.updatedAt,
          })),
        })
        if (deps.issueList === undefined) return local()
        let rows: readonly SdkIssueSummary[]
        try {
          rows = await deps.issueList({ pageNum: 1, pageSize: 200 })
        } catch (error) {
          warn('issue-mine-list-failed', errorText(error))
          return local()
        }
        const accountId = deps.auth?.status().accountId
        return {
          items: rows
            .filter(row => accountId === undefined || row.assigner === accountId || row.assignee === accountId)
            .map(row => ({
              id: row.issueId,
              title: row.title,
              status: row.status,
              ...(row.urgency === undefined ? {} : { urgency: row.urgency }),
              ...(row.assignee === undefined ? {} : { assignee: row.assignee }),
              ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
            })),
        }
      },
    },

    {
      method: 'GET',
      path: '/issues',
      handler: (context) => {
        const status = queryValue(context, 'status')
        const items = status === undefined
          ? deps.issues.pending()
          : deps.issues.summaries().filter(summary => summary.status === asIssueStatus(status))
        return { revision: deps.issues.revision(), items }
      },
    },

    {
      method: 'GET',
      path: '/issues/:id',
      handler: async (context) => {
        const issue = await deps.issues.get(issueIdOf(context))
        if (issue === undefined) throw new HttpFailure('not_found', 'issue 不存在', 404)
        return issue
      },
    },

    {
      method: 'GET',
      path: '/issues/:id/state',
      handler: async (context) => {
        const issueId = issueIdOf(context)
        const comments = await commentsOf(deps, issueId)
        const local = await deps.issues.get(issueId)
        if (local !== undefined) return { source: 'mirror', issue: local, comments }
        // No local mirror: read the authoritative cloud row; offline is an honest 404.
        if (deps.issueState === undefined) {
          throw new HttpFailure('not_found', '本机没有这条 issue 的镜像，共享库不可用', 404)
        }
        let remote: unknown
        try {
          remote = await deps.issueState(issueId)
        } catch (error) {
          warn('issue-state-remote-failed', `${issueId}: ${errorText(error)}`)
          throw new HttpFailure('internal', '共享库读取 issue 失败', 502)
        }
        if (remote === undefined || remote === null) throw new HttpFailure('not_found', 'issue 不存在', 404)
        return { source: 'cloud', issue: remote as Record<string, unknown>, comments }
      },
    },

    {
      method: 'GET',
      path: '/issues/:id/thread',
      handler: async (context) => {
        const issueId = issueIdOf(context)
        return { issueId, comments: await deps.thread.list(issueId) }
      },
    },

    {
      method: 'POST',
      path: '/issues',
      handler: async (context) => {
        const createRemote = deps.createRemote
        if (createRemote === undefined) {

          throw new HttpFailure('invalid_input', '共享库不可用：当前宿主不能创建在线 issue', 400)
        }
        const body = objectBody(context)
        const rawProject = body.projectId
        let projectId: number | undefined
        if (rawProject !== undefined && rawProject !== null && rawProject !== '') {
          const parsed = typeof rawProject === 'number' ? rawProject : Number(rawProject)
          if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new HttpFailure('invalid_input', 'projectId 必须是正整数', 400)
          }
          projectId = parsed
        }
        const title = normalizeIssueTitle(stringField(body, 'title') ?? '')
        const assignee = requiredText(body, 'assignee')
        const detail = stringField(body, 'detail')?.trim() ?? ''
        const assigneeInstance = trimmedField(body, 'assigneeInstance')
        const cwd = trimmedField(body, 'cwd')
        const urgency = trimmedField(body, 'urgency')
        const permissionRaw = trimmedField(body, 'permission')
        const permission = permissionRaw === undefined ? undefined : asPermission(permissionRaw)
        const metaRaw = body.assignerMeta
        if (metaRaw !== undefined && (metaRaw === null || typeof metaRaw !== 'object' || Array.isArray(metaRaw))) {
          throw new HttpFailure('invalid_input', 'assignerMeta 必须是对象', 400)
        }
        const assignerMeta = metaRaw === undefined || metaRaw === null
          ? undefined
          : metaRaw as Record<string, unknown>
        const attachments = attachmentsField(body)
        const draft: CreateIssueBody = {
          title,
          assignee,
          ...(projectId === undefined ? {} : { projectId }),
          ...optionalField('detail', detail === '' ? undefined : detail),
          ...optionalField('assigneeInstance', assigneeInstance),
          ...optionalField('cwd', cwd),
          ...optionalField('urgency', urgency === undefined ? undefined : asUrgency(urgency)),
          ...optionalField('permission', permission),
          ...optionalField('assignerMeta', assignerMeta),
          ...optionalField('attachments', attachments),
        }
        let created: { issueId: string; assignee: string }
        try {
          created = await createRemote(draft)
        } catch (error) {
          warn('issue-online-create-failed', `${title}: ${errorText(error)}`)
          throw new HttpFailure('internal', '共享库建 issue 失败', 502)
        }
        if (!isValidIssueId(created.issueId)) {
          throw new HttpFailure('internal', '共享库返回了非法的 issue id', 502)
        }
        // Cloud is authoritative. Do not materialize or claim it here: the normal
        // sync poll owns pending -> accepted and the router then converts it.
        return { status: 201, value: { issueId: created.issueId, assignee: created.assignee } }
      },
    },

    {
      method: 'POST',
      path: '/issues/:id/abandon',
      handler: async (context) => {
        const issueId = issueIdOf(context)
        await abandonRemoteIfNeeded(deps, issueId)
        if (isDanglingRouting(deps, issueId)) {
          const next = await deps.issues.update(issueId, (draft) => {
            if (draft.status !== 'routing') return false
            draft.status = 'abandoned'
            delete draft.assigneeTask
          })
          if (next === undefined) throw new HttpFailure('not_found', 'issue 不存在', 404)
          warn('issue-abandon-dangling', `${issueId}: assigneeTask 已不存在，按放弃处理`)
          return next
        }
        const next = await deps.issues.abandon(issueId)
        if (next === undefined) {
          const summary = deps.issues.summary(issueId)
          if (summary === undefined) throw new HttpFailure('not_found', 'issue 不存在', 404)
          throw new HttpFailure('invalid_transition', `issue 已经是 ${summary.status}`, 400)
        }
        return next
      },
    },

    {
      method: 'DELETE',
      path: '/issues/:id',
      handler: (context) => deleteIssue(context),
    },

    {

      method: 'POST',
      path: '/issues/:id/delete',
      handler: (context) => deleteIssue(context),
    },

    {
      method: 'POST',
      path: '/issues/:id/mark-read',
      handler: async (context) => {
        const issueId = issueIdOf(context)
        return { issueId, lastSeenAt: await markRead(issueId) }
      },
    },

    {
      method: 'POST',
      path: '/issues/:id/read',
      handler: async (context) => {
        const issueId = issueIdOf(context)
        return { issueId, lastSeenAt: await markRead(issueId) }
      },
    },

    {
      method: 'POST',
      path: '/issues/:id/comment',
      handler: async (context) => {
        const issueId = issueIdOf(context)
        const body = objectBody(context)
        const text = normalizeBody(stringField(body, 'body') ?? '')
        // Human-authored comments carry no side: the cloud stores `NULL`, and delivery routes
        // unknown to the executor. Letting the caller pass `role` would let a typo misroute it.
        const added = await deps.thread.add(issueId, { body: text, role: null, authorType: 'user' })
        if (added === undefined) throw new HttpFailure('conflict', '这条评论已经存在', 409)
        return { status: 201, value: added }
      },
    },
  ]

  /**
   * Converted issues cannot be deleted while the task still points at them; once the card
   * is purged, deletion is allowed so the record does not become immortal.
   */
  async function deleteIssue(context: RouteContext): Promise<{ deleted: true }> {
    const issueId = issueIdOf(context)
    const summary = deps.issues.summary(issueId)
    if (summary !== undefined && summary.status === 'routing') {
      if (taskAlive(deps, summary.assigneeTask)) {
        throw new HttpFailure('invalid_transition', 'issue 已转成任务，请删除那张卡', 400)
      }
      warn('issue-delete-dangling', `${issueId}: assigneeTask 已不存在，允许直接删除`)
    }

    const record = await deps.issues.get(issueId)
    if (record === undefined) throw new HttpFailure('not_found', 'issue 不存在', 404)
    await abandonRemoteIfNeeded(deps, issueId)
    const removed = await deps.issues.remove(issueId)
    if (!removed) throw new HttpFailure('not_found', 'issue 不存在', 404)
    return { deleted: true }
  }

  /**
   * Uses `max(now, lastCommentAt)` when advancing `lastSeenAt` to absorb clock skew
   * between machines, which would otherwise leave the unread dot stuck on.
   */
  async function markRead(issueId: string): Promise<number> {
    try {
      return await deps.thread.markRead(issueId)
    } catch (error) {
      warn('issue-mark-read-failed', `${issueId}: ${errorText(error)}`)
      return now()
    }
  }
}

function optionalField<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>)
}
