/**
 * 待规划与分发目标：issue 读写、已派发列表、子 issue 状态。
 *
 * @module dsh-magica-castboard/client/data/endpoints/issues
 */
import type { IssueTargets, TaskSummaryView } from '../dto.ts'
import type { IssueSummary, ThreadComment } from '../../../shared/wire.ts'
import { apiGet, apiPost } from '../api.ts'
import type { Urgency } from '../../../shared/wire.ts'

export async function apiTargets(projectId?: string, userId?: string): Promise<IssueTargets> {
  const query = new URLSearchParams()
  if (projectId !== undefined && projectId !== '') query.set('projectId', projectId)
  if (userId !== undefined && userId !== '') query.set('userId', userId)
  const suffix = query.toString()
  const raw = await apiGet<{
    online?: boolean
    projects?: readonly { id: string; name: string }[]
    members?: readonly { account: string; name?: string }[]
    instances?: readonly { instance: string; label?: string }[]
    selfAccount?: string
    localInstance?: string
  }>(`/issue-targets${suffix === '' ? '' : `?${suffix}`}`)
  return {
    online: raw.online,
    ...(raw.selfAccount === undefined || raw.selfAccount === '' ? {} : { selfAccount: raw.selfAccount }),
    ...(raw.localInstance === undefined || raw.localInstance === '' ? {} : { localInstance: raw.localInstance }),
    onlineFlag: raw.online,
    ...(raw.online === false ? { degraded: true } : {}),
    projects: (raw.projects ?? []).map(project => ({ id: project.id, label: project.name })),
    members: (raw.members ?? []).map(member => ({ id: member.account, label: member.name ?? member.account })),
    instances: (raw.instances ?? []).map(instance => ({ id: instance.instance, label: instance.label ?? instance.instance })),
  }
}


export interface IssueListResponse {
  revision: number
  items: readonly IssueSummary[]
}

type RawIssue = Partial<IssueSummary> & {
  id?: string
  comments?: readonly ThreadComment[]
  link?: IssueDetail['link']
}

export function issueView(raw: RawIssue): IssueSummary {
  return {
    ...raw,
    issueId: String(raw.issueId ?? raw.id ?? ''),
  } as IssueSummary
}

export async function apiIssues(): Promise<IssueListResponse> {
  const result = await apiGet<{ revision: number; items: readonly RawIssue[] }>('/issues')
  return { revision: result.revision, items: result.items.map(issueView) }
}

export interface IssueDetail {
  issue: IssueSummary
  comments: readonly ThreadComment[]
  link: { assigneeTaskId?: string; lastCommentAt?: number } | null
}

export async function apiIssue(id: string): Promise<IssueDetail> {
  const raw = await apiGet<RawIssue>(`/issues/${encodeURIComponent(id)}`)
  return {
    issue: issueView(raw),
    comments: raw.comments ?? [],
    link: raw.link ?? null,
  }
}

/** 创建 issue：直接写共享库。 */
export interface CreateIssueInput {
  projectId?: number
  title: string
  detail?: string
  assignee: string
  assigneeInstance?: string
  cwd?: string
  urgency?: Urgency
  permission?: 'read-only' | 'workspace-write' | 'danger-full-access'
  assignerMeta?: Record<string, unknown>
  /** 本机绝对路径；host 负责读盘上传。 */
  attachments?: readonly string[]
}

export function apiCreateIssue(input: CreateIssueInput): Promise<{ issueId: string; assignee: string }> {
  return apiPost('/issues', input)
}

export function apiAbandonIssue(id: string): Promise<{ affected: number }> {
  return apiPost(`/issues/${encodeURIComponent(id)}/abandon`)
}

export function apiIssueThread(id: string): Promise<{ comments: readonly ThreadComment[] }> {
  return apiGet(`/issues/${encodeURIComponent(id)}/thread`)
}

export function apiCommentIssue(id: string, body: string): Promise<{ id: string }> {
  return apiPost(`/issues/${encodeURIComponent(id)}/comment`, { body })
}

export async function apiIssueState(id: string): Promise<IssueDetail & { source?: 'mirror' | 'cloud' }> {
  const raw = await apiGet<{
    source?: 'mirror' | 'cloud'
    issue?: RawIssue
    comments?: readonly ThreadComment[]
  }>(`/issues/${encodeURIComponent(id)}/state`)
  return {
    ...(raw.source === undefined ? {} : { source: raw.source }),
    issue: issueView(raw.issue ?? {}),
    comments: raw.comments ?? [],
    link: null,
  }
}

/** 标记这条 issue 已读（`/issues/:id/mark-read`；`/tasks/:id/read` 是任务侧的另一个端点）。 */
export function apiMarkIssueRead(id: string): Promise<{ seenAt: number }> {
  return apiPost(`/issues/${encodeURIComponent(id)}/mark-read`)
}


export interface DispatchedRow extends TaskSummaryView {
  title: string
}

export async function apiDispatchedIssues(): Promise<{ items: readonly DispatchedRow[]; truncated: boolean }> {
  const raw = await apiGet<{
    issues?: readonly Record<string, unknown>[]
    truncated?: boolean
  }>('/issues/dispatched')
  const items = (raw.issues ?? []).map(row => {
    const issueId = String(row.issueId ?? '')
    return {
      id: issueId,
      issueId,
      title: typeof row.title === 'string' ? row.title : '',
      status: typeof row.status === 'string' ? row.status : 'pending',
      urgency: typeof row.urgency === 'string' ? row.urgency : 'relaxed',
      createdAt: 0,
      updatedAt: 0,
      ...(typeof row.assignee === 'string' ? { claimedBy: row.assignee } : {}),
    } as DispatchedRow
  })
  return { items, truncated: raw.truncated === true }
}

