/**
 * `/tasks` route group: create, edit, move, comment, execute, and dispatch cards.
 *
 * Every write validates and persists inside a single `mutate`, so the mutator sees the
 * latest ledger and cannot overwrite a concurrent change. Actions that need async
 * services (comments, sessions, the issue ledger) run after the primary write and are
 * best-effort. Response shapes follow `model.ts`; `nextRunAt` is epoch milliseconds.
 *
 * @module dsh-magica-castboard/host/http/routes/tasks
 */
import { taskDispatchInstruction } from '../../context/renders.ts'
import { nextCronRunAtOrUndefined, withNextRunAt } from '../../dispatch/cron.ts'
import { normalizeInlineAcceptanceStrategies, planAcceptance, type AcceptanceStrategy } from '../../exec/acceptance.ts'
import type { ExecutionService } from '../../exec/engine.ts'
import { archiveTaskSessions } from '../../exec/task-sessions.ts'
import type { IssueStore } from '../../ledger/issue-store.ts'
import type { TaskStore } from '../../ledger/task-store.ts'
import { summarize, syncClaim } from '../../ledger/task-derive.ts'
import { attachmentKind } from '../../pipeline/attachments.ts'
import type { IssueQueryFace } from '../../pipeline/sdk-query.ts'
import { anchorOf, type ThreadService } from '../../pipeline/thread.ts'
import {
  isValidId,
  type CancelTaskResponse,
  type ChecklistDraftItem,
  type ChecklistItem,
  type CommentTaskResponse,
  type CronPreviewResponse,
  type DeleteTaskBody,
  type DeleteTaskResponse,
  type DispatchTaskBody,
  type ExecutionConfig,
  type IssueSummary,
  type IssueTargetsResponse,
  type MoveTaskBody,
  type MoveTaskResponse,
  type PermissionMode,
  type RejectTaskBody,
  type RunTaskResponse,
  type TaskDetailResponse,
  type TaskModel,
  type TaskRecord,
  type TaskStatus,
  type TaskSummary,
  type UpdateTaskBody,
} from '../../model.ts'
import {
  asPermission,
  asStatus,
  asUrgency,
  canTransition,
  checklistFromTexts,
  defaultPermissionOf,
  newTaskId,
  normalizeAcceptanceStrategyIds,
  normalizeBody,
  normalizeChecklist,
  normalizeExecution,
  normalizeModel,
  normalizeTitle,
} from '../../rules.ts'
import {
  accepted,
  created,
  fail,
  invalidInput,
  objectBody,
  optionalString,
  queryValue,
  requireString,
  requireTaskId,
  str,
  unavailable,
  type RouteDeps,
} from './shared.ts'
import type { Route } from '../router.ts'
import type { IssueRouteCapabilities } from './issues.ts'
import { eventLog } from '../../shared/event-log.ts'

export type TaskRoutesDeps = RouteDeps & Pick<IssueRouteCapabilities, 'workspaces'>

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type ArchiveFace = { archiveSessions?: (sessionId: string) => Promise<void> }

function optionalBody(context: Parameters<typeof objectBody>[0]): Record<string, unknown> {
  return context.body === undefined || context.body === null ? {} : objectBody(context)
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw fail('invalid_input', `${key} 必须是布尔`, 400)
  return value
}

// Without a registry, skip the existence check and accept the workspace.
function lookupWorkspace(
  deps: TaskRoutesDeps,
  workspaceId: string,
): { exists: boolean; path?: string } {
  const registry = deps.workspaces
  if (registry === undefined) return { exists: true }
  const raw = registry.get(workspaceId)
  if (raw === undefined || raw === null) return { exists: false }
  const path = (raw as { path?: unknown }).path
  return {
    exists: true,
    ...(typeof path === 'string' && path.trim() !== '' ? { path: path.trim() } : {}),
  }
}

function readExecution(raw: unknown): ExecutionConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw fail('invalid_input', 'execution 必须是 { mode, cron } 对象', 400)
  }
  const record = raw as { mode?: unknown; cron?: unknown }
  if (record.mode !== undefined && typeof record.mode !== 'string') {
    throw fail('invalid_input', 'execution.mode 必须是字符串', 400)
  }
  if (record.cron !== undefined && typeof record.cron !== 'string') {
    throw fail('invalid_input', 'execution.cron 必须是字符串', 400)
  }
  try {
    return normalizeExecution({
      ...(record.mode === undefined ? {} : { mode: record.mode }),
      ...(record.cron === undefined ? {} : { cron: record.cron }),
    })
  } catch (error) {
    throw invalidInput(error)
  }
}

function readChecklist(raw: unknown): ChecklistItem[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw fail('invalid_input', 'checklist 必须是字符串数组', 400)
  const texts: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') throw fail('invalid_input', 'checklist 必须是字符串数组', 400)
    texts.push(entry)
  }
  try {
    const items = checklistFromTexts(texts)
    return items.length === 0 ? undefined : items
  } catch (error) {
    throw invalidInput(error)
  }
}

// Reject unknown spellings instead of silently falling back to the default.
function readPermission(raw: unknown, fallback: PermissionMode): PermissionMode {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw !== 'string') throw fail('invalid_input', 'permission 必须是字符串', 400)
  try {
    return asPermission(raw)
  } catch (error) {
    throw invalidInput(error)
  }
}

function readModel(raw: unknown): TaskModel {
  try {
    return normalizeModel(raw)
  } catch (error) {
    throw invalidInput(error)
  }
}

function readStrategyIds(raw: unknown): string[] | undefined {
  return normalizeAcceptanceStrategyIds(raw)
}

function readInlineStrategies(raw: unknown): AcceptanceStrategy[] | undefined {
  return normalizeInlineAcceptanceStrategies(raw)
}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

function summaryOf(deps: RouteDeps, task: TaskRecord): TaskSummary {
  return withNextRunAt(summarize(task), deps.now())
}

function archiveFaceOf(deps: TaskRoutesDeps): ((sessionId: string) => Promise<void>) | undefined {
  const face = deps.execution as unknown as ArchiveFace
  const archive = face.archiveSessions
  return typeof archive === 'function' ? id => archive.call(deps.execution, id) : undefined
}

/**
 * Leaving review clears the injected marker; moving back to todo marks the round as
 * failed; entering review again or being taken over starts a clean round.
 */
function applyAcceptanceBookkeeping(task: TaskRecord, to: TaskStatus, nowMs: number): void {
  const hadInjection = task.acceptanceInjectedAt !== undefined
  if (to !== 'in_review') delete task.acceptanceInjectedAt
  if (to === 'todo' && hadInjection) task.acceptanceFailedAt = nowMs
  if (to === 'in_progress' || to === 'in_review') delete task.acceptanceFailedAt
}

function applyTaskUpdate(deps: TaskRoutesDeps, task: TaskRecord, body: UpdateTaskBody & Record<string, unknown>, nowMs: number): void {
  if ('title' in body) task.title = normalizeTitle(requireString(body, 'title', 200))
  if ('detail' in body) {
    const value = body.detail
    if (value === null) task.detail = ''
    else if (typeof value !== 'string') throw fail('invalid_input', 'detail 必须是字符串', 400)
    else task.detail = value
  }
  if ('urgency' in body) {
    task.urgency = asUrgency(requireString(body, 'urgency', 20))
  }
  if ('blocked' in body) {
    const value = body.blocked
    if (typeof value !== 'boolean') throw fail('invalid_input', 'blocked 必须是布尔', 400)
    task.blocked = value
  }
  if ('workspaceId' in body) {
    const workspaceId = trimmed(str(body, 'workspaceId') ?? undefined)
    if (workspaceId === undefined) throw fail('invalid_input', 'workspaceId 必填', 400)
    const workspace = lookupWorkspace(deps, workspaceId)
    if (!workspace.exists) throw fail('not_found', '未知的项目', 404)
    task.workspaceId = workspaceId
    // Reassigning a workspace must also update cwd; the path identifies the workspace across instances.
    if (workspace.path !== undefined) task.cwd = workspace.path
  }
  if ('execution' in body && body.execution !== undefined && body.execution !== null) {
    task.execution = readExecution(body.execution)
  }
  if ('model' in body) {
    if (body.model === null) delete task.model
    else if (body.model === undefined) { /* keep the current value */ }
    else task.model = readModel(body.model)
  }
  if ('presetId' in body) {
    if (body.presetId === null) delete task.presetId
    else if (body.presetId !== undefined) {
      const presetId = trimmed(str(body, 'presetId') ?? undefined)
      if (presetId === undefined) throw fail('invalid_input', 'presetId 不能为空串', 400)
      task.presetId = presetId
    }
  }
  if ('permission' in body) {
    if (body.permission === null) delete task.permission
    else if (body.permission !== undefined) {
      if (typeof body.permission !== 'string') throw fail('invalid_input', 'permission 必须是字符串', 400)
      try {
        task.permission = asPermission(body.permission)
      } catch (error) {
        throw invalidInput(error)
      }
    }
  }
  if ('checklist' in body) {
    if (body.checklist === null) delete task.checklist
    else if (body.checklist !== undefined) {
      try {
        const items = normalizeChecklist(body.checklist)
        if (items.length === 0) delete task.checklist
        else task.checklist = items
      } catch (error) {
        throw invalidInput(error)
      }
    }
  }
  if ('acceptanceStrategyIds' in body) {
    if (body.acceptanceStrategyIds === null) delete task.acceptanceStrategyIds
    else if (body.acceptanceStrategyIds !== undefined) {
      const ids = readStrategyIds(body.acceptanceStrategyIds)
      if (ids === undefined) delete task.acceptanceStrategyIds
      else task.acceptanceStrategyIds = ids
    }
  }
  if ('acceptanceStrategies' in body) {
    if (body.acceptanceStrategies === null) {
      delete task.acceptanceStrategies
    } else if (body.acceptanceStrategies !== undefined) {
      const inline = readInlineStrategies(body.acceptanceStrategies)
      if (inline === undefined) {
        delete task.acceptanceStrategies
        delete task.acceptanceStrategyIds
      } else {
        task.acceptanceStrategies = inline
        // The two shapes are exclusive: an inline list clears the id references.
        delete task.acceptanceStrategyIds
      }
    }
  }
  task.updatedAt = nowMs
  task.updatedBy = { kind: 'user' }
}

function applyChecklistUpdate(task: TaskRecord, body: Record<string, unknown>, nowMs: number): ChecklistItem[] {
  if (Array.isArray(body.items)) {
    try {
      const items = normalizeChecklist(body.items as ChecklistDraftItem[])
      // In a whole-list submit, an item checked without a checker was checked by the user.
      return items.map(item => item.checked && item.checkedBy === undefined
        ? { ...item, checkedBy: 'user', checkedAt: nowMs }
        : item)
    } catch (error) {
      throw invalidInput(error)
    }
  }
  const checked = optionalBoolean(body, 'checked')
  if (checked === undefined) throw fail('invalid_input', '缺少 items 或 checked', 400)
  const items = [...(task.checklist ?? [])]
  let index = -1
  const itemId = trimmed(str(body, 'itemId') ?? undefined) ?? trimmed(str(body, 'id') ?? undefined)
  if (itemId !== undefined) index = items.findIndex(item => item.id === itemId)
  else {
    const rawIndex = body.index
    if (typeof rawIndex === 'number' && Number.isInteger(rawIndex)) index = rawIndex
  }
  const item = index >= 0 ? items[index] : undefined
  if (item === undefined) throw fail('invalid_input', '清单条目不存在', 404)
  if (checked) {
    const note = trimmed(optionalString(body, 'note', 400))
    item.checked = true
    item.checkedBy = 'user'
    item.checkedAt = nowMs
    if (note === undefined) delete item.note
    else item.note = note
  } else {
    item.checked = false
    delete item.checkedBy
    delete item.checkedAt
    delete item.note
  }
  return items
}

// After a card is purged, release its source issue instead of leaving it in routing.
async function detachSourceIssue(deps: TaskRoutesDeps, task: TaskRecord): Promise<void> {
  const issueId = task.issueId
  if (issueId === undefined || issueId === '') return
  try {
    const issue = await deps.issues.get(issueId)
    // Only records still in `routing` need releasing: the card is gone, so it can never
    // receive an `assigneeTask`. Records with a final outcome are history.
    if (issue !== undefined && issue.assigneeTask === task.id && issue.status === 'routing') {
      await deps.issues.update(issueId, (draft) => {
        if (draft.assigneeTask !== task.id) return false
        draft.status = 'abandoned'
      }, 'issue-abandoned')
    }
    await deps.links.remove(issueId)
  } catch (error) {
    eventLog('warn', 'purge-issue-cleanup-failed', `${issueId}: ${errorText(error)}`)
  }
}

function derivedIssuesOf(deps: TaskRoutesDeps, task: TaskRecord): NonNullable<TaskDetailResponse['issues']> {
  const ids = task.derivedIssues ?? []
  return ids.map((id) => {
    const summary: IssueSummary | undefined = deps.issues.summary(id)
    return summary === undefined
      ? { id }
      : {
          id: summary.id,
          title: summary.title,
          status: summary.status,
          urgency: summary.urgency,
          createdAt: summary.createdAt,
        }
  })
}

async function strategiesOf(deps: TaskRoutesDeps, task: TaskRecord): Promise<AcceptanceStrategy[]> {
  const inline = task.acceptanceStrategies ?? []
  const ids = task.acceptanceStrategyIds ?? []
  if (ids.length === 0) return [...inline]
  let catalog: readonly AcceptanceStrategy[] = []
  try {
    catalog = await deps.acceptanceStrategies.list()
  } catch (error) {
    eventLog('warn', 'acceptance-strategies-unreadable', errorText(error))
  }
  const resolved = ids
    .map(id => catalog.find(strategy => strategy.id === id))
    .filter((strategy): strategy is AcceptanceStrategy => strategy !== undefined)
  return [...resolved, ...inline]
}

function runFailure(_taskId: string, error: string): never {
  if (error.startsWith('no task') || error.startsWith('unknown workspace')) {
    throw fail('not_found', error, 404)
  }
  if (error.includes('abandoned')) throw fail('invalid_transition', error, 400)
  if (error.includes('no session facade') || error.includes('execution service is disposed')) {
    throw unavailable(`执行服务不可用：${error}`)
  }
  throw fail('conflict', `执行未启动：${error}`, 409)
}

export function tasksRoutes(deps: TaskRoutesDeps): readonly Route[] {
  const now = (): number => deps.now()

  return [
    {
      method: 'GET',
      path: '/issue-targets',
      handler: async (context): Promise<IssueTargetsResponse> => {
        const face: IssueQueryFace | undefined = deps.query
        if (face === undefined) {
          return { online: false, projects: [], members: [], instances: [] }
        }
        try {
          const projectId = queryValue(context, 'projectId')
          const userId = queryValue(context, 'userId')
          const groups = await face.groups()
          const projects = groups.map(group => ({ id: group.id, name: group.label }))
          const selected = projectId === undefined ? groups : groups.filter(group => group.id === projectId)
          const members: Array<{ account: string; name?: string }> = []
          if (projectId !== undefined) {
            for (const group of selected) {
              for (const member of await face.groupMembers(group.id)) {
                members.push({ account: member.id, ...(member.label === '' ? {} : { name: member.label }) })
              }
            }
          }
          const seen = new Set<string>()
          const instances: Array<{ instance: string; label?: string }> = []
          let selfAccount: string | undefined
          for (const device of await face.devices(userId ?? '')) {
            if (instances.length >= 60) break
            if (selfAccount === undefined && device.detail !== undefined && device.detail !== '') {
              selfAccount = device.detail
            }
            if (seen.has(device.id)) continue
            seen.add(device.id)
            instances.push({ instance: device.id, ...(device.label === '' ? {} : { label: device.label }) })
          }
          const localInstance = deps.deviceInstance?.() ?? deps.instance()
          if (!seen.has(localInstance)) {
            instances.unshift({ instance: localInstance, label: localInstance })
          }
          return {
            online: true,
            projects,
            members,
            instances,
            ...(selfAccount === undefined ? {} : { selfAccount }),
            localInstance,
          }
        } catch {
          // Report offline with empty lists rather than passing empty lists off as "no options".
          return { online: false, projects: [], members: [], instances: [] }
        }
      },
    },
    {
      method: 'POST',
      path: '/cron/preview',
      handler: (context): CronPreviewResponse => {
        const body = objectBody(context)
        const cron = requireString(body, 'cron', 120).trim()
        const nextRunAt = nextCronRunAtOrUndefined(cron, now())
        // An unschedulable cron returns the default; that is normal while the form is typed.
        return nextRunAt === undefined ? { cron } : { cron, nextRunAt }
      },
    },
    {
      method: 'GET',
      path: '/tasks',
      handler: async (context) => {
        await deps.tasks.load()
        const status = queryValue(context, 'status')
        const urgency = queryValue(context, 'urgency')
        const workspaceId = queryValue(context, 'workspaceId')
        const trashed = queryValue(context, 'trashed')
        const includeTrashed = trashed === '1' || trashed === 'true'
        const items = deps.tasks.summaries()
          .filter((task) => {
            if (!includeTrashed && task.trashed) return false
            if (status !== undefined && task.status !== status) return false
            if (urgency !== undefined && task.urgency !== urgency) return false
            if (workspaceId !== undefined && task.workspaceId !== workspaceId) return false
            return true
          })
          .map(task => withNextRunAt(task, now()))
        return { revision: deps.tasks.revision(), items }
      },
    },
    {
      method: 'POST',
      path: '/tasks',
      handler: async (context) => {
        const body = objectBody(context)
        await deps.tasks.load()
        const title = normalizeTitle(requireString(body, 'title', 200))
        const workspaceId = trimmed(requireString(body, 'workspaceId', 500))
        if (workspaceId === undefined) throw fail('invalid_input', 'workspaceId 必填', 400)
        const workspace = lookupWorkspace(deps, workspaceId)
        if (!workspace.exists) throw fail('not_found', '未知的项目', 404)
        const urgency = asUrgency(requireString(body, 'urgency', 20))
        const detail = optionalString(body, 'detail', 20_000) ?? ''
        const execution = body.execution === undefined || body.execution === null
          ? { mode: 'queue' as const }
          : readExecution(body.execution)
        const model = body.model === undefined || body.model === null ? undefined : readModel(body.model)
        const presetId = trimmed(optionalString(body, 'presetId', 200))
        const checklist = readChecklist(body.checklist)
        const strategyIds = readStrategyIds(body.acceptanceStrategyIds)
        const inlineStrategies = readInlineStrategies(body.acceptanceStrategies)
        const permission = readPermission(body.permission, defaultPermissionOf(await deps.settings.read()))
        if (body.status !== undefined && body.status !== 'todo') {
          throw fail('invalid_transition', '新建任务只能落在待办', 400)
        }
        const issueId = trimmed(optionalString(body, 'issueId', 100))
        if (issueId !== undefined && !isValidId(issueId)) {
          throw fail('invalid_input', '无效的 issueId', 400)
        }
        let source: string | undefined
        if (issueId !== undefined) {
          const issue = await deps.issues.get(issueId)
          if (issue === undefined) throw fail('not_found', '来源 issue 不存在', 404)
          if (issue.status !== 'pending') {
            throw fail('invalid_transition', `来源 issue 当前状态是 ${issue.status}，不能转成任务`, 400)
          }
          source = issue.source
        }
        const cwd = trimmed(optionalString(body, 'cwd', 2_000)) ?? workspace.path
        const stamp = now()
        const task: TaskRecord = {
          id: newTaskId(),
          title,
          detail,
          workspaceId,
          ...(cwd === undefined ? {} : { cwd }),
          urgency,
          status: 'todo',
          blocked: false,
          ...(issueId === undefined ? {} : { issueId }),
          ...(source === undefined ? {} : { source }),
          execution,
          ...(model === undefined ? {} : { model }),
          ...(presetId === undefined ? {} : { presetId }),
          permission,
          ...(checklist === undefined ? {} : { checklist }),
          ...(strategyIds === undefined ? {} : { acceptanceStrategyIds: strategyIds }),
          ...(inlineStrategies === undefined ? {} : { acceptanceStrategies: inlineStrategies }),
          createdAt: stamp,
          updatedAt: stamp,
          createdBy: { kind: 'user' },
          updatedBy: { kind: 'user' },
          executions: [],
        }
        const written = await deps.tasks.mutate('task-created', (ledger) => {
          ledger.tasks.push(task)
          return [task]
        })
        const stored = written.changed[0]
        if (stored === undefined) throw fail('internal', '任务没有落盘', 500)
        if (issueId !== undefined) {
          const transferred = await deps.issues.transfer(issueId, stored.id).catch(() => undefined)
          if (transferred === undefined) {
            // The source issue changed between read and write; remove the new card instead of leaving an orphan.
            await deps.tasks.mutate('task-deleted', (ledger) => {
              const index = ledger.tasks.findIndex(candidate => candidate.id === stored.id)
              if (index < 0) return undefined
              const [removed] = ledger.tasks.splice(index, 1)
              return removed === undefined ? undefined : [removed]
            }).catch(() => {})
            throw fail('invalid_transition', '来源 issue 状态已变化，任务已撤销', 409)
          }
          await deps.links.patch(issueId, { assigneeTaskId: stored.id }).catch((error: unknown) => {
            eventLog('warn', 'issue-task-link-failed', `${issueId}: ${errorText(error)}`)
          })
        }
        return created(summaryOf(deps, stored))
      },
    },
    {
      method: 'GET',
      path: '/tasks/:id',
      handler: async (context): Promise<TaskDetailResponse> => {
        const id = requireTaskId(context)
        await deps.tasks.load()
        const task = deps.tasks.get(id)
        if (task === undefined) throw fail('not_found', '任务不存在', 404)
        await deps.issues.load()
        let comments: TaskDetailResponse['comments']
        try {
          comments = await deps.thread.list(anchorOf(task))
        } catch (error) {
          // An unreadable comment stream must not fail the detail; the timeline can be partial.
          eventLog('warn', 'task-comments-read-failed', `${id}: ${errorText(error)}`)
          comments = []
        }
        const derived = derivedIssuesOf(deps, task)
        const nextRunAt = task.execution.mode === 'scheduled'
          ? nextCronRunAtOrUndefined(task.execution.cron, now())
          : undefined
        return {
          ...task,
          ...(comments === undefined ? {} : { comments }),
          ...(derived.length === 0 ? {} : { issues: derived }),
          ...(nextRunAt === undefined ? {} : { nextRunAt }),
        }
      },
    },
    {
      method: 'GET',
      path: '/tasks/:id/attachments',
      handler: async (context) => {
        const id = requireTaskId(context)
        await deps.tasks.load()
        const task = deps.tasks.get(id)
        if (task === undefined) throw fail('not_found', '任务不存在', 404)
        const issueId = task.issueId
        if (issueId === undefined || issueId === '' || deps.attachmentSync === undefined) {
          return { taskId: id, ...(issueId === undefined || issueId === '' ? {} : { issueId }), items: [] }
        }
        let items: Awaited<ReturnType<NonNullable<typeof deps.attachmentSync>['listIssue']>> = []
        try {
          items = await deps.attachmentSync.listIssue(issueId)
        } catch (error) {
          eventLog('warn', 'task-attachments-list-failed', `${id}: ${errorText(error)}`)
          return { taskId: id, issueId, items: [] }
        }
        if (items.some(item => item.state === 'pending')) {
          // Opening the card starts one background sync of the issue target; comment targets are
          // out of scope here and there is no polling.
          void deps.attachmentSync.syncIssue(issueId, { wait: false }).catch((error: unknown) => {
            eventLog('warn', 'task-attachments-sync-failed', `${id}: ${errorText(error)}`)
          })
        }
        return {
          taskId: id,
          issueId,
          items: items.map(item => ({
            name: item.name,
            path: item.path,
            targetType: item.targetType,
            targetId: item.targetId,
            role: item.role,
            kind: attachmentKind(item),
            state: item.state ?? 'ready',
            ...(item.fileId === undefined ? {} : { fileId: item.fileId }),
            ...(item.size === undefined ? {} : { size: item.size }),
            ...(item.description === undefined ? {} : { description: item.description }),
          })),
        }
      },
    },
    {
      method: 'POST',
      path: '/tasks/:id/update',
      handler: async (context): Promise<TaskSummary> => {
        const id = requireTaskId(context)
        const body = objectBody(context) as UpdateTaskBody & Record<string, unknown>
        if ('status' in body) {
          throw fail('invalid_input', '状态只能通过 /move 修改', 400)
        }
        await deps.tasks.load()
        const written = await deps.tasks.mutate('task-updated', (ledger) => {
          const task = ledger.tasks.find(candidate => candidate.id === id)
          if (task === undefined || task.trashedAt !== undefined) throw fail('not_found', '任务不存在', 404)
          if (task.status === 'archived') {
            throw fail('invalid_transition', '已归档的任务不可修改', 400)
          }
          applyTaskUpdate(deps, task, body, now())
          return [task]
        })
        const updated = written.changed[0]
        if (updated === undefined) throw fail('not_found', '任务不存在', 404)
        return summaryOf(deps, updated)
      },
    },
    {
      method: 'POST',
      path: '/tasks/:id/checklist',
      handler: async (context) => {
        const id = requireTaskId(context)
        const body = objectBody(context)
        await deps.tasks.load()
        const written = await deps.tasks.mutate('task-updated', (ledger) => {
          const task = ledger.tasks.find(candidate => candidate.id === id)
          if (task === undefined || task.trashedAt !== undefined) throw fail('not_found', '任务不存在', 404)
          if (task.status === 'archived') {
            throw fail('invalid_transition', '已归档的任务不可修改', 400)
          }
          task.checklist = applyChecklistUpdate(task, body, now())
          task.updatedAt = now()
          task.updatedBy = { kind: 'user' }
          return [task]
        })
        const updated = written.changed[0]
        if (updated === undefined) throw fail('not_found', '任务不存在', 404)
        return { taskId: id, checklist: updated.checklist ?? [] }
      },
    },
    {
      method: 'POST',
      path: '/tasks/:id/move',
      handler: async (context): Promise<MoveTaskResponse> => {
        const id = requireTaskId(context)
        const body = objectBody(context) as MoveTaskBody & Record<string, unknown>
        const to = asStatus(requireString(body, 'status', 20))
        const archiveSessions = optionalBoolean(body, 'archiveSessions') === true
        await deps.tasks.load()
        // Snapshot before the move, so the card can be restored exactly if execution cannot start.
        let before: TaskRecord | undefined
        const written = await deps.tasks.mutate('task-moved', (ledger) => {
          const task = ledger.tasks.find(candidate => candidate.id === id)
          if (task === undefined || task.trashedAt !== undefined) throw fail('not_found', '任务不存在', 404)
          if (!canTransition(task.status, to)) {
            throw fail('invalid_transition', `不能从 ${task.status} 移到 ${to}`, 400)
          }
          before = structuredClone(task)
          applyAcceptanceBookkeeping(task, to, now())
          // A manual move has no session to claim with, so entering in-progress clears any lingering claim.
          syncClaim(task, to, now())
          task.status = to
          task.updatedAt = now()
          task.updatedBy = { kind: 'user' }
          return [task]
        })
        const moved = written.changed[0]
        if (moved === undefined) throw fail('not_found', '任务不存在', 404)

        // Entering in-progress means claim and start now; if that fails, move the card back.
        if (to === 'in_progress' && before?.status !== 'in_progress') {
          const started = await deps.execution.run(id, 'manual')
          if (!started.ok && !started.error.includes('already in progress')) {
            await deps.tasks.mutate('task-moved', (ledger) => {
              const task = ledger.tasks.find(candidate => candidate.id === id)
              if (task === undefined || before === undefined) return undefined
              task.status = before.status
              if (before.claimedBy === undefined) delete task.claimedBy
              else task.claimedBy = before.claimedBy
              if (before.claimedAt === undefined) delete task.claimedAt
              else task.claimedAt = before.claimedAt
              if (before.acceptanceInjectedAt === undefined) delete task.acceptanceInjectedAt
              else task.acceptanceInjectedAt = before.acceptanceInjectedAt
              if (before.acceptanceFailedAt === undefined) delete task.acceptanceFailedAt
              else task.acceptanceFailedAt = before.acceptanceFailedAt
              task.updatedAt = now()
              task.updatedBy = { kind: 'user' }
              return [task]
            }).catch(() => {})
            runFailure(id, started.error)
          }
        } else if (before?.status === 'in_progress' && (to === 'todo' || to === 'canceled' || to === 'abandoned')) {
          // This target means stop working; a failed cancel does not roll back the move.
          await deps.execution.cancel(id).catch(() => {})
        }

        const latest = deps.tasks.get(id) ?? moved
        const sessionArchive = to === 'archived' && archiveSessions
          ? await archiveTaskSessions(moved, archiveFaceOf(deps))
          : undefined
        return {
          ...summaryOf(deps, latest),
          ...(sessionArchive === undefined ? {} : { sessionArchive }),
        }
      },
    },
    {
      method: 'POST',
      path: '/tasks/:id/archive-sessions',
      handler: async (context) => {
        const id = requireTaskId(context)
        const archive = archiveFaceOf(deps)
        if (archive === undefined) throw unavailable('会话归档能力未接入')
        await deps.tasks.load()
        const task = deps.tasks.get(id)
        if (task === undefined || task.trashedAt !== undefined) throw fail('not_found', '任务不存在', 404)
        if (task.status !== 'archived') {
          throw fail('invalid_transition', '只有已归档的任务能重试归档会话', 400)
        }
        return await archiveTaskSessions(task, archive)
      },
    },
    {
      method: 'POST',
      path: '/tasks/:id/delete',
      handler: async (context): Promise<DeleteTaskResponse> => {
        const id = requireTaskId(context)
        const body = optionalBody(context) as DeleteTaskBody & Record<string, unknown>
        const purge = optionalBoolean(body, 'purge') === true
        await deps.tasks.load()
        const task = deps.tasks.get(id)
        if (task === undefined) throw fail('not_found', '任务不存在', 404)
        if (task.executions.some(execution => execution.outcome === 'running')) {
          throw fail('invalid_input', '任务正在执行，不能删除', 400)
        }
        if (purge) {
          if (task.trashedAt === undefined) {
            throw fail('invalid_input', '先移入回收站，再彻底删除', 400)
          }
          await deps.tasks.mutate('task-deleted', (ledger) => {
            const current = ledger.tasks.find(candidate => candidate.id === id)
            if (current === undefined) return undefined
            // Preconditions and deletion must share one commit; an execution can start after the pre-read.
            if (current.executions.some(execution => execution.outcome === 'running')) {
              throw fail('invalid_input', '任务正在执行，不能删除', 400)
            }
            if (current.trashedAt === undefined) {
              throw fail('invalid_input', '先移入回收站，再彻底删除', 400)
            }
            ledger.tasks = ledger.tasks.filter(candidate => candidate.id !== id)
            return [current]
          })
          await detachSourceIssue(deps, task)
          return { purged: true }
        }
        if (task.trashedAt !== undefined) return { trashed: true }
        await deps.tasks.mutate('task-deleted', (ledger) => {
          const current = ledger.tasks.find(candidate => candidate.id === id)
          if (current === undefined) return undefined
          if (current.executions.some(execution => execution.outcome === 'running')) {
            throw fail('invalid_input', '任务正在执行，不能删除', 400)
          }
          current.trashedAt = now()
          delete current.claimedBy
          delete current.claimedAt
          current.blocked = false
          current.updatedAt = now()
          current.updatedBy = { kind: 'user' }
          return [current]
        })
        return { trashed: true }
      },
    },
    {
      method: 'POST',
      path: '/tasks/:id/comment',
      handler: async (context) => {
        const id = requireTaskId(context)
        const body = objectBody(context)
        const text = normalizeBody(requireString(body, 'body', 4_000))
        await deps.tasks.load()
        const task = deps.tasks.get(id)
        if (task === undefined || task.trashedAt !== undefined) throw fail('not_found', '任务不存在', 404)
        const anchor = anchorOf(task)
        // Delivery is handled by the status branch below, so persisting here must not also deliver.
        const added = await deps.thread.add(anchor, {
          body: text,
          role: null,
          authorType: 'user',
        }, { deliver: false })
        if (added === undefined) throw fail('conflict', '评论已存在', 409)

        let steered = false
        if (task.status === 'in_review') {
          // Commenting on an in-review card lets its session continue; the execution gate flips the card back.
          const result = await deps.execution.followUp(id, text)
          steered = result.ok
        } else if (task.status === 'in_progress') {
          const result = await deps.execution.steer(id, text)
          steered = result.ok
        }
        // Comments do not live in the ledger, but they change the detail timeline; bump the revision.
        await deps.tasks.mutate('comment-added', (ledger) => {
          const current = ledger.tasks.find(candidate => candidate.id === id)
          if (current === undefined) return undefined
          current.updatedAt = now()
          current.updatedBy = { kind: 'user' }
          return [current]
        }).catch((error: unknown) => {
          eventLog('warn', 'comment-ledger-touch-failed', `${id}: ${errorText(error)}`)
        })
        const response: CommentTaskResponse = {
          id: added.id,
          body: added.body,
          createdAt: added.createdAt,
          steered,
        }
        return created(response)
      },
    },
    {
      method: 'POST',
      path: '/tasks/:id/run',
      handler: async (context): Promise<{ status: number; value: RunTaskResponse }> => {
        const id = requireTaskId(context)
        await deps.tasks.load()
        const result = await deps.execution.run(id, 'manual')
        if (result.ok) {
          return accepted({ executionId: result.executionId, sessionId: result.sessionId })
        }
        // "Already running" is an idempotent success; return the running execution and session.
        if (result.error.includes('already in progress')) {
          const running = [...(deps.tasks.get(id)?.executions ?? [])]
            .reverse()
            .find(execution => execution.outcome === 'running')
          if (running !== undefined) {
            return accepted({
              executionId: running.id,
              sessionId: running.sessionId ?? '',
              started: false,
            })
          }
        }
        runFailure(id, result.error)
      },
    },
    {
      method: 'POST',
      path: '/tasks/:id/cancel',
      handler: async (context): Promise<{ status: number; value: CancelTaskResponse }> => {
        const id = requireTaskId(context)
        await deps.tasks.load()
        const result = await deps.execution.cancel(id)
        if (result.ok) {
          return accepted({ cancelled: true, executionId: result.executionId })
        }
        if (result.error.startsWith('no task')) throw fail('not_found', result.error, 404)
        throw fail('conflict', result.error, 409)
      },
    },
    {
      method: 'POST',
      path: '/tasks/:id/read',
      handler: async (context) => {
        const id = requireTaskId(context)
        await deps.tasks.load()
        const task = deps.tasks.get(id)
        if (task === undefined) throw fail('not_found', '任务不存在', 404)
        const seenAt = await deps.thread.markRead(anchorOf(task))
        return { seenAt }
      },
    },
    {
      method: 'POST',
      path: '/tasks/:id/dispatch',
      handler: async (context): Promise<{ status: number; value: RunTaskResponse }> => {
        const id = requireTaskId(context)
        const body = objectBody(context) as DispatchTaskBody & Record<string, unknown>
        const text = requireString(body, 'text', 4_000)
        const projectId = optionalString(body, 'projectId', 100)
        const assignee = optionalString(body, 'assignee', 200)
        const assigneeInstance = optionalString(body, 'assigneeInstance', 200)
        await deps.tasks.load()
        const task = deps.tasks.get(id)
        if (task === undefined || task.trashedAt !== undefined) throw fail('not_found', '任务不存在', 404)
        if (task.status !== 'in_review') {
          throw fail('invalid_transition', '只有待验收的任务可以分发', 400)
        }
        const prompt = taskDispatchInstruction(task, {
          text,
          projectId: projectId ?? '',
          assignee: assignee ?? '',
          ...(assigneeInstance === undefined ? {} : { assigneeInstance }),
        })
        // Dispatch adds one more round on the same session and leaves the card in review.
        const result = await deps.execution.dispatch(id, prompt)
        if (!result.ok) runFailure(id, result.error)
        return accepted({ executionId: result.executionId, sessionId: result.sessionId })
      },
    },
    {
      method: 'POST',
      path: '/tasks/:id/reject',
      handler: async (context): Promise<TaskSummary> => {
        const id = requireTaskId(context)
        const body = optionalBody(context) as RejectTaskBody & Record<string, unknown>
        let note: string | undefined
        if (body.body !== undefined && body.body !== null) {
          if (typeof body.body !== 'string') throw fail('invalid_input', 'body 必须是字符串', 400)
          note = normalizeBody(body.body)
        }
        await deps.tasks.load()
        const written = await deps.tasks.mutate('task-moved', (ledger) => {
          const task = ledger.tasks.find(candidate => candidate.id === id)
          if (task === undefined || task.trashedAt !== undefined) throw fail('not_found', '任务不存在', 404)
          if (task.status !== 'in_review') {
            throw fail('invalid_transition', '只有待验收的任务可以退回', 400)
          }
          applyAcceptanceBookkeeping(task, 'todo', now())
          syncClaim(task, 'todo', now())
          task.status = 'todo'
          task.updatedAt = now()
          task.updatedBy = { kind: 'user' }
          return [task]
        })
        const rejected = written.changed[0]
        if (rejected === undefined) throw fail('not_found', '任务不存在', 404)
        if (note !== undefined) {
          // The status already moved back; a failed note is only logged and must not roll it back.
          // Delivery stays enabled: the note is the feedback the executor needs to continue.
          await deps.thread.add(anchorOf(rejected), {
            body: note,
            role: null,
            authorType: 'user',
          }).catch((error: unknown) => {
            eventLog('warn', 'reject-note-failed', `${id}: ${errorText(error)}`)
          })
        }
        return summaryOf(deps, rejected)
      },
    },
    {
      method: 'POST',
      path: '/tasks/:id/acceptance',
      handler: async (context) => {
        const id = requireTaskId(context)
        await deps.tasks.load()
        const task = deps.tasks.get(id)
        if (task === undefined || task.trashedAt !== undefined) throw fail('not_found', '任务不存在', 404)
        if (task.status !== 'in_review') {
          throw fail('invalid_transition', '只有待验收的任务能启动验收轮', 400)
        }
        const strategies = await strategiesOf(deps, task)
        if (strategies.length === 0) {
          throw fail('invalid_transition', '任务没有挂验收策略，无法进入验收轮', 409)
        }
        // Planning only decides whether strategies are injected again; execution injects them at settlement.
        const plan = planAcceptance({ task, strategies })
        // Manual round: carry the acceptance XML itself; the queued copy may already be consumed.
        const result = await deps.acceptance.run(id, { inject: true })
        if (!result.started) {
          throw fail('invalid_transition', `验收轮未启动：${result.reason}`, 409)
        }
        return accepted({
          taskId: id,
          started: true,
          reason: result.reason,
          planned: plan.shouldRun,
        })
      },
    },
  ]
}
