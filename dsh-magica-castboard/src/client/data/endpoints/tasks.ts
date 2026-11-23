/**
 * 任务写面：建卡 / 改卡 / 移卡 / 评论 / 执行 / 分发。
 *
 * @module dsh-magica-castboard/client/data/endpoints/tasks
 */
import type { TaskRecord, TaskStatus, Urgency } from '../../../shared/wire.ts'
import { apiGet, apiPost } from '../api.ts'
import type { TaskAttachmentsResponse, TaskDetailResponse } from '../dto.ts'

type RawTaskDetail = Omit<TaskRecord, 'nextRunAt'> & {
  comments?: TaskDetailResponse['comments']
  issues?: unknown
  nextRunAt?: number
}

export async function apiTask(id: string): Promise<TaskDetailResponse> {
  // The host returns the record flat (task fields + comments + optional nextRunAt);
  // the panel stores the task under `task`. Adapt here so every caller sees one shape.
  const raw = await apiGet<RawTaskDetail | TaskDetailResponse>(`/tasks/${encodeURIComponent(id)}`)
  if ('task' in raw && raw.task !== undefined) return raw as TaskDetailResponse
  const { comments, issues: _issues, nextRunAt, ...task } = raw as RawTaskDetail
  const model = modelTextOf((raw as { model?: unknown }).model)
  const rawChecklist = (raw as { checklist?: readonly Record<string, unknown>[] }).checklist
  const checklist = rawChecklist?.map(item => ({
    ...item,
    done: item.done === true || item.checked === true,
  })) as TaskRecord['checklist']
  return {
    task: {
      ...task,
      ...(checklist === undefined ? {} : { checklist }),
      ...(model === undefined ? {} : { model }),
      ...(typeof nextRunAt === 'number' ? { nextRunAt: new Date(nextRunAt).toISOString() } : {}),
    } as TaskDetailResponse['task'],
    comments: comments ?? [],
  }
}

export function apiTaskAttachments(id: string): Promise<TaskAttachmentsResponse> {
  return apiGet(`/tasks/${encodeURIComponent(id)}/attachments`)
}

export interface CreateTaskInput {
  title: string
  detail?: string
  urgency?: Urgency
  workspaceId?: string
  model?: string
  permission?: string
  cwd?: string
  checklist?: readonly string[]
  execution?: { mode: 'queue' | 'scheduled'; cron?: string }
  tags?: readonly string[]
  acceptanceStrategies?: readonly { id?: string; title: string; type: 'issue' | 'close'; description: string }[]
}

export function modelTextOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const model = value as { provider?: unknown; model?: unknown }
    if (typeof model.provider === 'string' && typeof model.model === 'string') return `${model.provider}/${model.model}`
  }
  return undefined
}

function modelPayload(value: string | null | undefined): { provider: string; model: string } | null | undefined {
  if (value === null) return null
  if (value === undefined || value.trim() === '') return undefined
  const cut = value.indexOf('/')
  if (cut <= 0 || cut === value.length - 1) return undefined
  return { provider: value.slice(0, cut), model: value.slice(cut + 1) }
}

export function apiCreateTask(input: CreateTaskInput): Promise<{ id: string }> {
  const { model, ...rest } = input
  const payload = modelPayload(model)
  return apiPost('/tasks', {
    ...rest,
    ...(payload === undefined ? {} : { model: payload }),
  })
}

export interface UpdateTaskInput {
  title?: string
  detail?: string
  urgency?: Urgency
  workspaceId?: string
  model?: string | null
  permission?: string
  cwd?: string
  tags?: readonly string[]
  blocked?: boolean
  checklist?: readonly { text: string; done: boolean; note?: string }[] | null
  execution?: { mode: 'queue' | 'scheduled'; cron?: string } | null
  acceptanceStrategies?: readonly { id?: string; title: string; type: 'issue' | 'close'; description: string }[] | null
}

export function apiUpdateTask(id: string, input: UpdateTaskInput): Promise<{ affected: number }> {
  const { model, checklist, ...rest } = input
  const payload = modelPayload(model)
  return apiPost(`/tasks/${encodeURIComponent(id)}/update`, {
    ...rest,
    ...(payload === undefined ? {} : { model: payload }),
    ...(checklist === undefined ? {} : {
      checklist: checklist === null ? null : checklist.map(item => ({ ...item, checked: item.done })),
    }),
  })
}

export async function apiMoveTask(id: string, to: TaskStatus): Promise<{ task: TaskRecord }> {
  // The host move endpoint takes `status` and answers with the moved summary flat.
  const raw = await apiPost<TaskRecord>(`/tasks/${encodeURIComponent(id)}/move`, { status: to })
  return { task: raw }
}

export function apiDeleteTask(id: string, purge: boolean): Promise<{ affected: number }> {
  return apiPost(`/tasks/${encodeURIComponent(id)}/delete`, purge ? { purge: true } : {})
}

export function apiRejectTask(id: string, note?: string): Promise<{ task: TaskRecord }> {
  return apiPost(`/tasks/${encodeURIComponent(id)}/reject`, note === undefined ? {} : { body: note })
}

export function apiChecklist(id: string, input: { index: number; checked: boolean } | { items: readonly { text: string; checked: boolean }[] }): Promise<{ taskId: string; checklist: readonly { text: string; done: boolean }[] }> {
  return apiPost(`/tasks/${encodeURIComponent(id)}/checklist`, input)
}

export function apiComment(id: string, body: string): Promise<{ id: string; steered?: boolean }> {
  return apiPost(`/tasks/${encodeURIComponent(id)}/comment`, { body })
}

export function apiRun(id: string): Promise<{ started?: boolean; reason?: string; executionId?: string }> {
  return apiPost(`/tasks/${encodeURIComponent(id)}/run`)
}

export function apiCancel(id: string): Promise<{ cancelled: boolean; reason?: string }> {
  return apiPost(`/tasks/${encodeURIComponent(id)}/cancel`)
}

export function apiMarkRead(id: string): Promise<{ seenAt: number }> {
  return apiPost(`/tasks/${encodeURIComponent(id)}/read`)
}

export function apiStartAcceptance(id: string): Promise<{ taskId: string; reason: string }> {
  return apiPost(`/tasks/${encodeURIComponent(id)}/acceptance`)
}

/** 人点「分发」时提交的目标（与旧版一致：说明 + 项目组 / 责任人 / 实例）。 */
export interface DispatchInput {
  text: string
  projectId: string
  assignee: string
  assigneeInstance?: string
}

export function apiDispatch(id: string, input: DispatchInput): Promise<{ taskId: string; executionId?: string }> {
  return apiPost(`/tasks/${encodeURIComponent(id)}/dispatch`, input)
}

export function apiCronPreview(cron: string): Promise<{ cron: string; nextRunAt?: number }> {
  return apiPost('/cron/preview', { cron })
}

