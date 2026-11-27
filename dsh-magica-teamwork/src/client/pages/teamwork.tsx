/**
 * 项目管理面板（四页）：我的项目 / 我的 Issue / 我的设备 / 项目管理。
 *
 * 放在 teamwork 组件库；数据统一走宿主同源 `/api/castboard/*`，浏览器不接触任何 token。
 * 文案全部由宿主通过 `t()` 注入。
 *
 * @module dsh-magica-teamwork/client/pages/teamwork
 */
import { Button, Checkbox, IconChevronDownOutlineRegular, IconCloseOutlineRegular, Input, Menu, Modal, Pill, Tag, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import { Empty } from '../components/index.js'

export type TeamworkPanelPage = 'my-projects' | 'my-issues' | 'my-devices' | 'projects'

export interface TeamworkProject {
  id: number
  name: string
  owner: string | null
  description: string | null
  memberCount: number
  visibility: string
  status: string
  updatedAt: string
}

export interface TeamworkProjectMember {
  id: number
  accountId: string
  displayName: string | null
  role: string
  joinedAt?: string
}

export interface TeamworkDevice {
  id: number
  host: string
  port: number
  os?: string
  status: string
  lastActiveAt?: string
}

export interface TeamworkIssueRow {
  id: string
  title: string
  status: string
  urgency?: string
  assignee?: string
  updatedAt?: number
}

export interface TeamworkIssueDetail extends TeamworkIssueRow {
  detail?: string
  createdAt?: string
  assignerMeta?: unknown
}

export interface TeamworkComment {
  id: string
  body: string
  createdAt: number
  role?: string | null
  authorType?: string
  author?: string
}

export interface TeamworkPanelProps {
  /** 宿主 locale 的翻译函数。 */
  t: (key: string, params?: Record<string, string | number>) => string
  lang?: 'zh' | 'en'
  /** API 前缀，默认与 castboard 客户端一致。 */
  apiBase?: string
  /** 宿主的交互控制评论渲染器与稳定去重键；undefined 时按普通评论显示。 */
  describeComment?: (comment: TeamworkComment) => { key: string; node: ReactNode } | undefined
}

interface PageData {
  projects: TeamworkProject[]
  myProjects: TeamworkProject[]
  issues: TeamworkIssueRow[]
  devices: TeamworkDevice[]
}

const PAGE_KEYS: readonly TeamworkPanelPage[] = ['my-projects', 'my-issues', 'my-devices', 'projects']

const cardStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  padding: 14,
  borderRadius: 'var(--dsw-radius-lg, 12px)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
  cursor: 'pointer',
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  let payload: unknown
  try { payload = text === '' ? undefined : JSON.parse(text) } catch { payload = text }
  if (!response.ok) {
    const failure = payload as { message?: unknown; error?: unknown; code?: unknown } | undefined
    const detail = failure?.message ?? failure?.error
    const text = typeof detail === 'string'
      ? detail
      : detail === undefined
        ? `HTTP ${String(response.status)}`
        : JSON.stringify(detail)
    throw new Error(typeof failure?.code === 'string' ? `${failure.code}: ${text}` : text)
  }
  const envelope = payload as { ok?: boolean; value?: T; reason?: string } | undefined
  if (envelope !== undefined && typeof envelope === 'object' && envelope.ok === false) {
    const reason = (envelope as { reason?: unknown }).reason
    throw new Error(typeof reason === 'string' ? reason : reason === undefined ? '请求失败' : JSON.stringify(reason))
  }
  return (envelope !== undefined && typeof envelope === 'object' && 'value' in envelope ? envelope.value : payload) as T
}

function formatTime(value: string | number | undefined, lang: 'zh' | 'en'): string {
  if (value === undefined || value === '') return '—'
  const ms = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(ms)) return String(value)
  return new Date(ms).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', { hour12: false })
}

function formatIssueWhen(value: string | number | undefined): string {
  if (value === undefined || value === '') return '—'
  const ms = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(ms)) return String(value)
  const date = new Date(ms)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function issueStatusTone(status: string): string {
  if (status === 'success') return 'ok'
  if (status === 'failed') return 'error'
  if (status === 'running') return 'warn'
  if (status === 'accepted') return 'info'
  if (status === 'routing') return 'brand'
  return 'muted'
}

function issueUrgencyTone(urgency: string): string {
  if (urgency === 'urgent') return 'error'
  if (urgency === 'direct') return 'warn'
  if (urgency === 'runtime') return 'brand'
  return 'muted'
}

function mergeComments(
  describe: TeamworkPanelProps['describeComment'],
  ...groups: readonly (readonly TeamworkComment[])[]
): TeamworkComment[] {
  const byKey = new Map<string, TeamworkComment>()
  for (const group of groups) {
    for (const comment of group) {
      const key = describe?.(comment)?.key ?? `id:${comment.id}`
      if (key !== '' && !byKey.has(key)) byKey.set(key, comment)
    }
  }
  return [...byKey.values()].sort((left, right) => left.createdAt - right.createdAt)
}

function commentAuthorLabel(
  comment: TeamworkComment,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (comment.authorType === 'system') return t('teamwork.issue.commentSystem')
  if (comment.authorType === 'agent') {
    if (comment.role === 'assignee') return t('issue.byAssignee')
    if (comment.role === 'assigner') return t('issue.byAssigner')
    return t('teamwork.issue.commentAgent')
  }
  if (comment.author !== undefined && comment.author.trim() !== '') return comment.author
  if (comment.role === 'assignee') return t('issue.byAssignee')
  if (comment.role === 'assigner') return t('issue.byAssigner')
  return t('detail.comments.user')
}

export function TeamworkPanel(props: TeamworkPanelProps): ReactNode {
  const lang = props.lang ?? 'zh'
  const base = props.apiBase ?? '/api/castboard'
  const [page, setPage] = useState<TeamworkPanelPage>('my-projects')
  const [data, setData] = useState<PageData>({ projects: [], myProjects: [], issues: [], devices: [] })
  const [loading, setLoading] = useState(false)
  const [toastText, setToastText] = useState<{ id: number; text: string } | undefined>(undefined)
  const [duplicateTarget, setDuplicateTarget] = useState<TeamworkProjectMember | undefined>(undefined)
  const [removeTarget, setRemoveTarget] = useState<TeamworkProjectMember | undefined>(undefined)
  const [removeDeviceTarget, setRemoveDeviceTarget] = useState<TeamworkDevice | undefined>(undefined)
  const [keyword, setKeyword] = useState('')
  const [projectSort, setProjectSort] = useState<'updated' | 'name'>('updated')
  const [sortOpen, setSortOpen] = useState(false)
  const [issueStatus, setIssueStatus] = useState('')
  const [issueStatusOpen, setIssueStatusOpen] = useState(false)
  const [deviceStatus, setDeviceStatus] = useState('')
  const [deviceStatusOpen, setDeviceStatusOpen] = useState(false)
  const [detail, setDetail] = useState<TeamworkProject | undefined>(undefined)
  const [members, setMembers] = useState<TeamworkProjectMember[]>([])
  const [memberDraft, setMemberDraft] = useState('')
  const [memberQuery, setMemberQuery] = useState('')
  const [memberResults, setMemberResults] = useState<readonly { accountId: string; displayName: string | null; globalRole: string }[]>([])
  const [memberSearching, setMemberSearching] = useState(false)
  const [memberSearchError, setMemberSearchError] = useState<string | undefined>(undefined)
  const [memberPicked, setMemberPicked] = useState<{ accountId: string; displayName: string | null } | undefined>(undefined)
  const [memberRole, setMemberRole] = useState<'member' | 'manager'>('member')
  const [memberRoleOpen, setMemberRoleOpen] = useState(false)
  const [memberRoleMenuFor, setMemberRoleMenuFor] = useState<string | undefined>(undefined)
  const [accountId, setAccountId] = useState<string | undefined>(undefined)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editError, setEditError] = useState<string | undefined>(undefined)
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createError, setCreateError] = useState<string | undefined>(undefined)
  const [createPrivate, setCreatePrivate] = useState(false)
  const [createPrivateLocked, setCreatePrivateLocked] = useState(false)
  const [deviceOpen, setDeviceOpen] = useState(false)
  const [deviceHost, setDeviceHost] = useState('')
  const [devicePort, setDevicePort] = useState('')
  const [deviceOs, setDeviceOs] = useState('')
  const [deviceError, setDeviceError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [role, setRole] = useState<string | undefined>(undefined)
  const [issueDetail, setIssueDetail] = useState<TeamworkIssueDetail | undefined>(undefined)
  const [issueComments, setIssueComments] = useState<TeamworkComment[]>([])
  const [issueCommentDraft, setIssueCommentDraft] = useState('')
  const [issueCommentBusy, setIssueCommentBusy] = useState(false)

  const notify = (text: string): void => { setToastText({ id: Date.now(), text }) }

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [myProjects, projects, issues, devices, auth] = await Promise.all([
        request<TeamworkProject[]>(base, '/projects/mine').catch(() => []),
        request<{ items?: TeamworkProject[] }>(base, '/projects?pageNum=1&pageSize=100').catch(() => ({ items: [] })),
        request<{ items?: TeamworkIssueRow[] }>(base, '/issues/mine').catch(() => ({ items: [] })),
        request<{ items?: TeamworkDevice[] }>(base, '/devices/mine').catch(() => ({ items: [] })),
        request<{ globalRole?: string; accountId?: string }>(base, '/auth').catch(() => undefined),
      ])
      setRole(auth?.globalRole)
      setAccountId(auth?.accountId)
      setData({
        myProjects: Array.isArray(myProjects) ? myProjects : [],
        projects: Array.isArray(projects.items) ? projects.items : [],
        issues: Array.isArray(issues.items) ? issues.items : [],
        devices: Array.isArray(devices.items) ? devices.items : [],
      })
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [base])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (detail === undefined || page !== 'projects') return
    const q = memberQuery.trim()
    if (q === '' || memberPicked !== undefined) {
      setMemberResults([])
      setMemberSearching(false)
      setMemberSearchError(undefined)
      return
    }
    setMemberSearching(true)
    setMemberSearchError(undefined)
    const timer = setTimeout(() => {
      void request<readonly { accountId: string; displayName: string | null; globalRole: string }[]>(
        base,
        `/projects/${String(detail.id)}/accounts?q=${encodeURIComponent(q)}`,
      ).then(rows => {
        setMemberResults(rows)
        setMemberSearching(false)
      }).catch((cause: unknown) => {
        setMemberResults([])
        setMemberSearching(false)
        setMemberSearchError(cause instanceof Error ? cause.message : String(cause))
      })
    }, 250)
    return () => { clearTimeout(timer) }
  }, [base, detail, memberPicked, memberQuery, page])

  useEffect(() => {
    if (detail === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDetail(undefined)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [detail])

  const openDetail = async (project: TeamworkProject): Promise<void> => {
    setDetail(project)
    setMembers([])
    setMemberDraft('')
    setMemberQuery('')
    setMemberResults([])
    setMemberPicked(undefined)
    setMemberRole('member')
    setEditName(project.name)
    setEditDescription(project.description ?? '')
    setEditError(undefined)
    try {
      setMembers(await request<TeamworkProjectMember[]>(base, `/projects/${String(project.id)}/members`))
    } catch { /* detail still usable */ }
  }

  const canChoosePrivate = role === 'administrator' || role === 'leader'

  const openCreate = (): void => {
    const forcedPrivate = !canChoosePrivate
    setCreateError(undefined)
    setCreatePrivate(forcedPrivate)
    setCreatePrivateLocked(forcedPrivate)
    setCreateOpen(true)
  }

  const createProject = async (): Promise<void> => {
    if (createName.trim() === '') {
      setCreateError(props.t('teamwork.project.nameRequired'))
      return
    }
    setCreateError(undefined)
    setBusy(true)
    try {
      await request(base, '/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: createName.trim(),
          ...(createDescription.trim() === '' ? {} : { description: createDescription.trim() }),
          ...(createPrivate ? { visibility: 'private' } : {}),
        }),
      })
      setCreateOpen(false)
      setCreateName('')
      setCreateDescription('')
      setCreatePrivate(false)
      setCreateError(undefined)
      await load()
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const removeProject = async (project: TeamworkProject): Promise<void> => {
    if (!window.confirm(props.t('teamwork.project.deleteConfirm', { name: project.name }))) return
    setBusy(true)
    try {
      await request(base, `/projects/${String(project.id)}`, { method: 'DELETE' })
      setDetail(undefined)
      await load()
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const upsertMember = async (target: string, nextRole: 'member' | 'manager'): Promise<void> => {
    if (detail === undefined) return
    setBusy(true)
    try {
      await request(base, `/projects/${String(detail.id)}/members`, {
        method: 'POST',
        body: JSON.stringify({ accountId: target, role: nextRole }),
      })
      setMembers(await request<TeamworkProjectMember[]>(base, `/projects/${String(detail.id)}/members`))
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const addMember = async (): Promise<void> => {
    if (memberPicked === undefined) return
    const existing = members.find(member => member.accountId === memberPicked.accountId)
    if (existing !== undefined) {
      if (existing.role === 'owner') {
        notify(props.t('teamwork.member.ownerImmutable'))
        return
      }
      setDuplicateTarget(existing)
      return
    }
    await upsertMember(memberPicked.accountId, memberRole)
    setMemberDraft('')
    setMemberQuery('')
    setMemberPicked(undefined)
    setMemberRole('member')
  }

  const transferOwner = async (target: TeamworkProjectMember): Promise<void> => {
    if (detail === undefined) return
    if (!window.confirm(props.t('teamwork.member.transferConfirm', { name: target.displayName ?? target.accountId }))) return
    setBusy(true)
    try {
      await request(base, `/projects/${String(detail.id)}/owner`, {
        method: 'PUT',
        body: JSON.stringify({ accountId: target.accountId }),
      })
      const [updated, nextMembers] = await Promise.all([
        request<TeamworkProject>(base, `/projects/${String(detail.id)}`),
        request<TeamworkProjectMember[]>(base, `/projects/${String(detail.id)}/members`),
      ])
      setDetail(updated)
      setMembers(nextMembers)
      await load()
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const saveProject = async (): Promise<void> => {
    if (detail === undefined) return
    if (editName.trim() === '') {
      setEditError(props.t('teamwork.project.nameRequired'))
      return
    }
    setBusy(true)
    setEditError(undefined)
    try {
      const updated = await request<TeamworkProject>(base, `/projects/${String(detail.id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editName.trim(),
          description: editDescription.trim() === '' ? null : editDescription.trim(),
        }),
      })
      setDetail(updated)
      await load()
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const removeMember = async (member: TeamworkProjectMember): Promise<void> => {
    if (detail === undefined) return
    setBusy(true)
    try {
      await request(base, `/projects/${String(detail.id)}/members/${encodeURIComponent(member.accountId)}`, { method: 'DELETE' })
      setMembers(await request<TeamworkProjectMember[]>(base, `/projects/${String(detail.id)}/members`))
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const openIssue = async (issue: TeamworkIssueRow): Promise<void> => {
    setIssueDetail(issue)
    setIssueComments([])
    setIssueCommentDraft('')
    try {
      const [state, cloud] = await Promise.all([
        request<{ issue?: Record<string, unknown>; comments?: TeamworkComment[] }>(
          base,
          `/issues/${encodeURIComponent(issue.id)}/state`,
        ),
        request<{ comments?: TeamworkComment[] }>(
          base,
          `/issues/${encodeURIComponent(issue.id)}/cloud-comments`,
        ).catch(() => ({ comments: [] })),
      ])
      const detail = state.issue ?? {}
      const meta = typeof detail['assignerMeta'] === 'string'
        ? (() => { try { return JSON.parse(detail['assignerMeta']) as Record<string, unknown> } catch { return undefined } })()
        : undefined
      setIssueDetail({
        ...issue,
        ...(typeof detail['title'] === 'string' ? { title: detail['title'] } : {}),
        ...(typeof detail['status'] === 'string' ? { status: detail['status'] } : {}),
        ...(typeof detail['urgency'] === 'string' ? { urgency: detail['urgency'] } : {}),
        ...(typeof detail['assignee'] === 'string' ? { assignee: detail['assignee'] } : {}),
        ...(typeof detail['detail'] === 'string' ? { detail: detail['detail'] } : {}),
        ...(typeof detail['createdAt'] === 'string' ? { createdAt: detail['createdAt'] } : {}),
        ...(meta === undefined ? {} : { assignerMeta: meta }),
      })
      setIssueComments(mergeComments(props.describeComment, state.comments ?? [], cloud.comments ?? []))
    } catch { /* row snapshot is enough */ }
  }

  const sendIssueComment = async (): Promise<void> => {
    const target = issueDetail
    const body = issueCommentDraft.trim()
    if (target === undefined || body === '' || issueCommentBusy) return
    setIssueCommentBusy(true)
    try {
      const added = await request<TeamworkComment>(
        base,
        `/issues/${encodeURIComponent(target.id)}/comment`,
        { method: 'POST', body: JSON.stringify({ body }) },
      )
      setIssueComments(current => mergeComments(props.describeComment, current, [added]))
      setIssueCommentDraft('')
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setIssueCommentBusy(false)
    }
  }

  const createDevice = async (): Promise<void> => {
    const host = deviceHost.trim()
    const port = Number(devicePort.trim())
    if (host === '') {
      setDeviceError(props.t('teamwork.device.hostRequired'))
      return
    }
    if (devicePort.trim() === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
      setDeviceError(props.t('teamwork.device.portInvalid'))
      return
    }
    setDeviceError(undefined)
    setBusy(true)
    try {
      await request(base, '/devices', {
        method: 'POST',
        body: JSON.stringify({
          host,
          port,
          ...(deviceOs.trim() === '' ? {} : { os: deviceOs.trim() }),
        }),
      })
      setDeviceOpen(false)
      setDeviceHost('')
      setDevicePort('')
      setDeviceOs('')
      await load()
    } catch (cause) {
      setDeviceError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const removeDevice = async (device: TeamworkDevice): Promise<void> => {
    setBusy(true)
    try {
      await request(base, `/devices/${String(device.id)}`, { method: 'DELETE' })
      await load()
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const statusLabel = (status: string): string => props.t(`teamwork.status.${status}`)

  const projectItems = useMemo(() => {
    const search = keyword.trim().toLowerCase()
    const items = (page === 'my-projects' ? data.myProjects : data.projects)
      .filter(item => search === '' || item.name.toLowerCase().includes(search))
    return [...items].sort((left, right) => projectSort === 'name'
      ? left.name.localeCompare(right.name)
      : right.updatedAt.localeCompare(left.updatedAt))
  }, [page, data.myProjects, data.projects, keyword, projectSort])

  const issueItems = useMemo(() => data.issues.filter(item => {
    const search = keyword.trim().toLowerCase()
    const matchesSearch = search === '' || (item.title ?? '').toLowerCase().includes(search)
    return matchesSearch && (issueStatus === '' || item.status === issueStatus)
  }), [data.issues, keyword, issueStatus])

  const deviceItems = useMemo(() => data.devices.filter(item => {
    const search = keyword.trim().toLowerCase()
    const matchesSearch = search === '' || `${item.host}:${String(item.port)}`.toLowerCase().includes(search)
    return matchesSearch && (deviceStatus === '' || item.status === deviceStatus)
  }), [data.devices, keyword, deviceStatus])

  const privateMemberCapReached = detail !== undefined
    && detail.visibility === 'private'
    && Math.max(members.length, detail.memberCount) >= 5
  const selfMember = detail === undefined || accountId === undefined
    ? undefined
    : members.find(member => member.accountId === accountId)
  const canManageMembers = page === 'projects' && detail !== undefined && (
    role === 'administrator'
    || role === 'leader'
    || detail.owner === accountId
    || selfMember?.role === 'owner'
    || selfMember?.role === 'manager'
  )
  const canEditProject = page === 'projects' && detail !== undefined && (
    role === 'administrator'
    || detail.owner === accountId
  )
  const canGrantManager = page === 'projects' && (
    role === 'administrator'
    || role === 'leader'
    || detail?.owner === accountId
    || selfMember?.role === 'owner'
  )
  const canTransferOwner = page === 'projects' && detail !== undefined && (
    role === 'administrator' || detail.owner === accountId
  )

  return (
    <div className="dsh-atw-root dsh-atw-page" style={{ minHeight: 0 }}>
      <div className="dsh-atw-bar">
        <div className="dsh-atw-title-group">
          <h2 className="dsh-atw-page-title">{props.t('teamwork.title')}</h2>
          <Tag tone="neutral">{props.t(`teamwork.role.${role ?? 'unknown'}`)}</Tag>
        </div>
        <span style={{ flex: 1 }} />
      </div>

      <div className="dsh-atw-tabsbar" role="tablist" aria-label={props.t('teamwork.title')}>
        {PAGE_KEYS.map(key => (
          <Pill
            key={key}
            active={page === key}
            role="tab"
            id={`teamwork-tab-${key}`}
            aria-selected={page === key}
            aria-controls={`teamwork-panel-${key}`}
            onClick={() => { setPage(key); setKeyword('') }}
          >
            {props.t(`teamwork.page.${key}`)}
          </Pill>
        ))}
      </div>

      <div className="dsh-atw-content">
      {page === 'my-projects' || page === 'projects' ? (
        <>
          <div className="dsh-atw-filterrow">
            <Menu
              open={sortOpen}
              onClose={() => { setSortOpen(false) }}
              selectedId={projectSort}
              onSelect={id => { setProjectSort(id as 'updated' | 'name'); setSortOpen(false) }}
              items={[
                { id: 'updated', label: props.t('teamwork.sort.updated') },
                { id: 'name', label: props.t('teamwork.sort.name') },
              ]}
              anchor={(
                <Button variant="outline" size="sm" onClick={() => { setSortOpen(prev => !prev) }} aria-haspopup="menu">
                  {projectSort === 'name' ? props.t('teamwork.sort.name') : props.t('teamwork.sort.updated')}
                  <IconChevronDownOutlineRegular size={14} />
                </Button>
              )}
            />
            <Input
              value={keyword}
              placeholder={props.t('teamwork.search.projects')}
              onChange={event => { setKeyword(event.target.value) }}
              className="dsh-atw-compact-input"
              style={{ width: 200, flex: 'none' }}
            />
            {page === 'projects' ? (
              <Button variant="primary" size="sm" onClick={openCreate}>{props.t('teamwork.project.create')}</Button>
            ) : null}
          </div>
          {page === 'projects' ? (
            <div className="dsh-atw-card" style={{ cursor: 'default' }}>{props.t('teamwork.projects.hint')}</div>
          ) : null}
          {projectItems.length === 0 ? (
            <Empty text={props.t('teamwork.projects.empty')} />
          ) : (
            <div className="dsh-atw-project-grid">
              {projectItems.map(project => (
                <div
                  key={project.id}
                  className="dsh-atw-project-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => { void openDetail(project) }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      void openDetail(project)
                    }
                  }}
                >
                  <div className="dsh-atw-project-card-head">
                    <strong className="dsh-atw-project-card-title">{project.name}</strong>
                    <Pill className="dsh-atw-role-pill">
                      {project.visibility === 'private' ? props.t('teamwork.project.private') : props.t('teamwork.project.public')}
                    </Pill>
                  </div>
                  <div className="dsh-atw-project-card-desc">{project.description ?? props.t('teamwork.project.noDescription')}</div>
                  <div className="dsh-atw-project-card-meta">
                    <div><span>{props.t('teamwork.project.owner')}</span><b>{project.owner ?? '—'}</b></div>
                    <div><span>{props.t('teamwork.project.membersTitle')}</span><b>{props.t('teamwork.project.members', { count: project.memberCount })}</b></div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}

      {page === 'my-issues' ? (
        <>
          <div className="dsh-atw-filterrow">
            <Menu
              open={issueStatusOpen}
              onClose={() => { setIssueStatusOpen(false) }}
              selectedId={issueStatus === '' ? 'all' : issueStatus}
              onSelect={id => { setIssueStatus(id === 'all' ? '' : id); setIssueStatusOpen(false) }}
              items={[
                { id: 'all', label: props.t('teamwork.filter.all') },
                ...['pending', 'accepted', 'routing', 'running', 'success', 'failed', 'abandoned'].map(status => ({ id: status, label: statusLabel(status) })),
              ]}
              anchor={(
                <Button variant="outline" size="sm" onClick={() => { setIssueStatusOpen(prev => !prev) }} aria-haspopup="menu">
                  {issueStatus === '' ? props.t('teamwork.filter.all') : statusLabel(issueStatus)}
                  <IconChevronDownOutlineRegular size={14} />
                </Button>
              )}
            />
            <Input
              value={keyword}
              placeholder={props.t('teamwork.search.issues')}
              onChange={event => { setKeyword(event.target.value) }}
              className="dsh-atw-compact-input"
              style={{ width: 200, flex: 'none' }}
            />
          </div>
          {issueItems.length === 0 ? <Empty text={props.t('teamwork.issues.empty')} /> : (
            <div className="dsh-atw-issue-list">
              {issueItems.map(issue => (
                <div
                  className="dsh-atw-issue-row"
                  key={issue.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => { void openIssue(issue) }}
                  onKeyDown={event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    void openIssue(issue)
                  }}
                >
                  <div className="dsh-atw-issue-main">
                    <div className="dsh-atw-issue-title">{issue.title ?? issue.id.slice(0, 8)}</div>
                    <div className="dsh-atw-issue-meta">
                      <span>{issue.id.slice(0, 8)}</span>
                      <span>·</span>
                      <span>{formatIssueWhen(issue.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="dsh-atw-issue-chips">
                    {issue.urgency === undefined ? null : (
                      <span className="dsh-atw-issue-chip" data-tone={issueUrgencyTone(issue.urgency)}>
                        {props.t(`urgency.${issue.urgency}`)}
                      </span>
                    )}
                    <span className="dsh-atw-issue-chip" data-tone={issueStatusTone(issue.status)}>
                      {statusLabel(issue.status)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}

      {page === 'my-devices' ? (
        <>
          <div className="dsh-atw-filterrow">
            <Menu
              open={deviceStatusOpen}
              onClose={() => { setDeviceStatusOpen(false) }}
              selectedId={deviceStatus === '' ? 'all' : deviceStatus}
              onSelect={id => { setDeviceStatus(id === 'all' ? '' : id); setDeviceStatusOpen(false) }}
              items={[
                { id: 'all', label: props.t('teamwork.filter.all') },
                { id: 'active', label: statusLabel('active') },
                { id: 'inactive', label: statusLabel('inactive') },
              ]}
              anchor={(
                <Button variant="outline" size="sm" onClick={() => { setDeviceStatusOpen(prev => !prev) }} aria-haspopup="menu">
                  {deviceStatus === '' ? props.t('teamwork.filter.all') : statusLabel(deviceStatus)}
                  <IconChevronDownOutlineRegular size={14} />
                </Button>
              )}
            />
            <Input
              value={keyword}
              placeholder={props.t('teamwork.search.devices')}
              onChange={event => { setKeyword(event.target.value) }}
              className="dsh-atw-compact-input"
              style={{ width: 200, flex: 'none' }}
            />
            <Button variant="primary" size="sm" onClick={() => { setDeviceError(undefined); setDeviceOpen(true) }}>{props.t('teamwork.device.create')}</Button>
          </div>
          {deviceItems.length === 0 ? <Empty text={props.t('teamwork.devices.empty')} /> : (
            <div className="dsh-atw-device-table-wrap">
              <table className="dsh-atw-device-table">
                <thead><tr><th>{props.t('teamwork.device.name')}</th><th>{props.t('teamwork.device.os')}</th><th>{props.t('teamwork.device.status')}</th><th>{props.t('teamwork.device.lastActive')}</th><th>{props.t('teamwork.device.actions')}</th></tr></thead>
                <tbody>
                  {deviceItems.map(device => (
                    <tr key={device.id}>
                      <td className="dsh-atw-device-host">{device.host}:{device.port}</td>
                      <td>{device.os ?? '—'}</td>
                      <td>{statusLabel(device.status)}</td>
                      <td>{formatTime(device.lastActiveAt, lang)}</td>
                      <td className="dsh-atw-device-actions">
                        <Button variant="outline" size="sm" style={{ height: 24 }} disabled={busy} onClick={() => { setRemoveDeviceTarget(device) }}>
                          {props.t('teamwork.device.remove')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      {detail !== undefined ? (
        <div className="dsh-atw-drawer-backdrop" onClick={() => { setDetail(undefined) }} />
      ) : null}
      {detail !== undefined ? (
        <aside
          className="dsh-atw-drawer"
          role="dialog"
          aria-modal="true"
          aria-label={detail.name}
        >
            <header className="dsh-atw-drawer-head">
              <div className="dsh-atw-drawer-title">
                <h2>{detail.name}</h2>
                <Pill className="dsh-atw-role-pill">
                  {detail.visibility === 'private' ? props.t('teamwork.project.private') : props.t('teamwork.project.public')}
                </Pill>
              </div>
              {canEditProject ? (
                <Button variant="primary" size="sm" style={{ height: 28 }} disabled={busy} onClick={() => { void saveProject() }}>{props.t('teamwork.project.save')}</Button>
              ) : null}
              {page === 'projects' && canEditProject ? (
                <Button variant="outline" size="sm" style={{ height: 28 }} disabled={busy} onClick={() => { void removeProject(detail) }}>{props.t('teamwork.project.delete')}</Button>
              ) : null}
              <Button variant="ghost" size="sm" aria-label={props.t('common.close')} onClick={() => { setDetail(undefined) }}>
                <IconCloseOutlineRegular size={16} />
              </Button>
            </header>

            <div className="dsh-atw-drawer-body">
              <section className="dsh-atw-drawer-section">
                <h3>{props.t('teamwork.project.overview')}</h3>
                <div className="dsh-atw-kv"><span>{props.t('teamwork.project.owner')}</span><b>{detail.owner ?? '—'}</b></div>
                <div className="dsh-atw-kv"><span>{props.t('teamwork.project.visibility')}</span><b>{detail.visibility === 'private' ? props.t('teamwork.project.private') : props.t('teamwork.project.public')}</b></div>
                <div className="dsh-atw-kv"><span>{props.t('teamwork.project.membersTitle')}</span><b>{props.t('teamwork.project.members', { count: detail.memberCount })}</b></div>
                <div className="dsh-atw-kv"><span>{props.t('teamwork.issue.updated')}</span><b>{formatTime(detail.updatedAt, lang)}</b></div>
              </section>

              <section className="dsh-atw-drawer-section">
                <h3>{canEditProject ? props.t('teamwork.project.editInfo') : props.t('teamwork.project.description')}</h3>
                {canEditProject ? (
                  <div className="dsh-atw-edit-form">
                    <label>
                      <span>{props.t('teamwork.project.name')} <span aria-hidden="true" className="dsh-atw-required">*</span></span>
                      <Input value={editName} aria-required="true" onChange={event => { setEditName(event.target.value) }} />
                    </label>
                    <label>
                      {props.t('teamwork.project.description')}
                      <Input value={editDescription} onChange={event => { setEditDescription(event.target.value) }} />
                    </label>
                    {editError === undefined ? null : <div role="alert" className="dsh-atw-form-error">{editError}</div>}
                  </div>
                ) : (
                  <p className="dsh-atw-drawer-text">{detail.description ?? props.t('teamwork.project.noDescription')}</p>
                )}
              </section>

              <section className="dsh-atw-drawer-section">
                <h3 className="dsh-atw-members-title">
                  {props.t('teamwork.project.membersTitle')}
                  <span>{props.t('teamwork.project.members', { count: members.length })}</span>
                </h3>
                <div className="dsh-atw-member-table-wrap">
                  <table className="dsh-atw-member-table">
                    <thead>
                      <tr>
                        <th>{props.t('teamwork.member.accountId')}</th>
                        <th>{props.t('teamwork.member.displayName')}</th>
                        <th>{props.t('teamwork.member.role')}</th>
                        <th>{props.t('teamwork.member.joined')}</th>
                        <th>{props.t('teamwork.member.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.map(member => (
                        <tr key={member.id}>
                          <td className="dsh-atw-member-id">{member.accountId}</td>
                          <td>{member.displayName ?? '—'}</td>
                          <td>
                            {canGrantManager && member.role !== 'owner' ? (
                              <Menu
                                open={memberRoleMenuFor === member.accountId}
                                onClose={() => { setMemberRoleMenuFor(undefined) }}
                                selectedId={member.role}
                                portal
                                onSelect={role => {
                                  setMemberRoleMenuFor(undefined)
                                  if (role === 'owner') void transferOwner(member)
                                  else if (role === 'member' || role === 'manager') void upsertMember(member.accountId, role)
                                }}
                                items={[
                                  ...(canTransferOwner ? [{ id: 'owner', label: props.t('teamwork.member.roleOwner') }] : []),
                                  { id: 'manager', label: props.t('teamwork.member.roleManager') },
                                  { id: 'member', label: props.t('teamwork.member.roleMember') },
                                ]}
                                anchor={(
                                  <Pill
                                    className="dsh-atw-role-pill"
                                    aria-haspopup="menu"
                                    onClick={() => { setMemberRoleMenuFor(member.accountId) }}
                                  >
                                    {member.role === 'manager' ? props.t('teamwork.member.roleManager') : props.t('teamwork.member.roleMember')}
                                    <IconChevronDownOutlineRegular size={12} />
                                  </Pill>
                                )}
                              />
                            ) : <Pill className="dsh-atw-role-pill">{member.role === 'owner' ? props.t('teamwork.member.roleOwner') : member.role}</Pill>}
                          </td>
                          <td>{formatTime(member.joinedAt, lang)}</td>
                          <td>
                            {canManageMembers && member.role !== 'owner' ? (
                              <Button variant="outline" size="sm" style={{ height: 24 }} disabled={busy} onClick={() => { setRemoveTarget(member) }}>
                                {props.t('teamwork.member.delete')}
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {page === 'projects' && canManageMembers ? (
                  <div className="dsh-atw-member-add">
                    {memberPicked === undefined ? (
                      <div className="dsh-atw-combo">
                        <Input
                          value={memberQuery}
                          placeholder={props.t('teamwork.member.search')}
                          disabled={privateMemberCapReached}
                          className="dsh-atw-compact-input"
                          onChange={event => {
                            setMemberQuery(event.target.value)
                            setMemberPicked(undefined)
                          }}
                          style={{ width: '100%' }}
                        />
                        {memberQuery.trim() !== '' ? (
                          <div className="dsh-atw-combo-list" role="listbox">
                            {memberSearching ? (
                              <div className="dsh-atw-combo-empty">{props.t('teamwork.member.searching')}</div>
                            ) : null}
                            {memberSearchError === undefined ? null : (
                              <div className="dsh-atw-combo-empty dsh-atw-combo-error">{memberSearchError}</div>
                            )}
                            {!memberSearching && memberSearchError === undefined && memberResults.length === 0 ? (
                              <div className="dsh-atw-combo-empty">{props.t('teamwork.member.noResults')}</div>
                            ) : null}
                            {memberResults.map(option => (
                              <button
                                key={option.accountId}
                                type="button"
                                className="dsh-atw-combo-option"
                                role="option"
                                onClick={() => {
                                  setMemberPicked({ accountId: option.accountId, displayName: option.displayName })
                                  setMemberQuery('')
                                  setMemberResults([])
                                }}
                              >
                                <span>{option.displayName ?? option.accountId}</span>
                                <span className="dsh-atw-combo-id">{option.accountId}</span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="dsh-atw-picked">
                        <span>{memberPicked.displayName ?? memberPicked.accountId}</span>
                        <Button variant="ghost" size="sm" aria-label={props.t('common.cancel')} onClick={() => { setMemberPicked(undefined) }}>
                          <IconCloseOutlineRegular size={14} />
                        </Button>
                      </div>
                    )}
                    {canGrantManager ? (
                      <Menu
                        open={memberRoleOpen}
                        onClose={() => { setMemberRoleOpen(false) }}
                        selectedId={memberRole}
                        portal
                        onSelect={role => {
                          setMemberRoleOpen(false)
                          if (role === 'member' || role === 'manager') setMemberRole(role)
                        }}
                        items={[
                          { id: 'member', label: props.t('teamwork.member.roleMember') },
                          { id: 'manager', label: props.t('teamwork.member.roleManager') },
                        ]}
                        anchor={(
                          <Button variant="outline" size="sm" style={{ height: 28 }} onClick={() => { setMemberRoleOpen(true) }}>
                            {memberRole === 'manager' ? props.t('teamwork.member.roleManager') : props.t('teamwork.member.roleMember')}
                            <IconChevronDownOutlineRegular size={14} />
                          </Button>
                        )}
                      />
                    ) : null}
                    <Button variant="outline" size="sm" style={{ height: 28 }} disabled={busy || privateMemberCapReached || memberPicked === undefined} onClick={() => { void addMember() }}>{props.t('teamwork.member.add')}</Button>
                  </div>
                ) : null}
                {privateMemberCapReached ? (
                  <div className="dsh-atw-hint">{props.t('teamwork.member.limit')}</div>
                ) : null}
              </section>
            </div>
        </aside>
      ) : null}
      </div>

      <Modal
        open={removeDeviceTarget !== undefined}
        onClose={() => { setRemoveDeviceTarget(undefined) }}
        title={props.t('teamwork.device.deleteTitle')}
        closeLabel={props.t('common.close')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setRemoveDeviceTarget(undefined) }}>{props.t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                const target = removeDeviceTarget
                setRemoveDeviceTarget(undefined)
                if (target !== undefined) void removeDevice(target)
              }}
            >{props.t('teamwork.device.remove')}</Button>
          </>
        )}
      >
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' }}>
          {props.t('teamwork.device.deleteConfirm')}
        </div>
      </Modal>

      <Modal
        open={removeTarget !== undefined}
        onClose={() => { setRemoveTarget(undefined) }}
        title={props.t('teamwork.member.deleteTitle')}
        closeLabel={props.t('common.close')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setRemoveTarget(undefined) }}>{props.t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                const target = removeTarget
                setRemoveTarget(undefined)
                if (target !== undefined) void removeMember(target)
              }}
            >{props.t('teamwork.member.delete')}</Button>
          </>
        )}
      >
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' }}>
          {props.t('teamwork.member.deleteConfirm', {
            name: removeTarget?.displayName ?? removeTarget?.accountId ?? '',
          })}
        </div>
      </Modal>

      <Modal
        open={duplicateTarget !== undefined}
        onClose={() => { setDuplicateTarget(undefined) }}
        title={props.t('teamwork.member.alreadyExistsTitle')}
        closeLabel={props.t('common.close')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setDuplicateTarget(undefined) }}>{props.t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                const target = duplicateTarget
                setDuplicateTarget(undefined)
                if (target !== undefined) {
                  void upsertMember(target.accountId, memberRole).then(() => {
                    setMemberPicked(undefined)
                    setMemberQuery('')
                    setMemberRole('member')
                  })
                }
              }}
            >{props.t('teamwork.member.updateRole')}</Button>
          </>
        )}
      >
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' }}>
          {props.t('teamwork.member.alreadyExists', {
            name: duplicateTarget?.displayName ?? duplicateTarget?.accountId ?? '',
            role: memberRole === 'manager' ? props.t('teamwork.member.roleManager') : props.t('teamwork.member.roleMember'),
          })}
        </div>
      </Modal>

      {issueDetail !== undefined ? (
        <div className="dsh-atw-drawer-backdrop" onClick={() => { setIssueDetail(undefined) }} />
      ) : null}
      {issueDetail !== undefined ? (
        <aside
          className="dsh-atw-drawer dsh-atw-issue-drawer"
          role="dialog"
          aria-modal="true"
          aria-label={issueDetail.title ?? issueDetail.id}
        >
          <header className="dsh-atw-drawer-head">
            <div className="dsh-atw-drawer-title">
              <h2>{issueDetail.title ?? issueDetail.id}</h2>
            </div>
            <Button variant="ghost" size="sm" aria-label={props.t('common.close')} onClick={() => { setIssueDetail(undefined) }}>
              <IconCloseOutlineRegular size={16} />
            </Button>
          </header>

          <div className="dsh-atw-drawer-body">
            <section className="dsh-atw-drawer-section">
              <div className="dsh-atw-issue-drawer-chips">
                <span className="dsh-atw-issue-chip" data-tone={issueStatusTone(issueDetail.status)}>
                  {statusLabel(issueDetail.status)}
                </span>
                {issueDetail.urgency === undefined ? null : (
                  <span className="dsh-atw-issue-chip" data-tone={issueUrgencyTone(issueDetail.urgency)}>
                    {props.t(`urgency.${issueDetail.urgency}`)}
                  </span>
                )}
                <span className="dsh-atw-issue-chip" data-tone="muted">{issueDetail.id.slice(0, 8)}</span>
              </div>
              <div className="dsh-atw-kv"><span>{props.t('teamwork.issue.assignee')}</span><b>{issueDetail.assignee ?? '—'}</b></div>
              <div className="dsh-atw-kv"><span>{props.t('teamwork.issue.updated')}</span><b>{formatTime(issueDetail.updatedAt, lang)}</b></div>
              {issueDetail.createdAt === undefined ? null : (
                <div className="dsh-atw-kv"><span>{props.t('teamwork.issue.created')}</span><b>{formatTime(issueDetail.createdAt, lang)}</b></div>
              )}
            </section>

            <section className="dsh-atw-drawer-section">
              <h3>{props.t('teamwork.issue.detail')}</h3>
              <p className="dsh-atw-issue-drawer-text">
                {issueDetail.detail === undefined || issueDetail.detail === ''
                  ? props.t('teamwork.issue.noDetail')
                  : issueDetail.detail}
              </p>
            </section>

            <section className="dsh-atw-drawer-section">
              <h3 className="dsh-atw-members-title">
                {props.t('teamwork.issue.comments')}
                <span>{issueComments.length}</span>
              </h3>
              {issueComments.length === 0 ? (
                <div className="dsh-atw-drawer-text">{props.t('teamwork.issue.commentsEmpty')}</div>
              ) : (
                <div className="dsh-atw-issue-comments">
                  {issueComments.map(comment => {
                    const described = props.describeComment?.(comment)
                    const author = commentAuthorLabel(comment, props.t)
                    return (
                      <div className="dsh-atw-issue-comment" data-system={described === undefined ? undefined : '1'} key={comment.id}>
                        <div className="dsh-atw-issue-comment-meta">
                          <b>{author}</b>
                          <span>{formatTime(comment.createdAt, lang)}</span>
                        </div>
                        {described === undefined
                          ? <div className="dsh-atw-issue-comment-body">{comment.body}</div>
                          : <div className="dsh-atw-issue-comment-control">{described.node}</div>}
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="dsh-atw-issue-comment-box">
                <textarea
                  className="dsh-atw-issue-comment-input"
                  value={issueCommentDraft}
                  placeholder={props.t('teamwork.issue.commentPlaceholder')}
                  aria-label={props.t('teamwork.issue.commentPlaceholder')}
                  onChange={event => { setIssueCommentDraft(event.target.value) }}
                  onKeyDown={event => {
                    if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter') return
                    event.preventDefault()
                    void sendIssueComment()
                  }}
                />
                <Button
                  variant="primary"
                  size="sm"
                  disabled={issueCommentBusy || issueCommentDraft.trim() === ''}
                  onClick={() => { void sendIssueComment() }}
                >
                  {props.t('teamwork.issue.commentSend')}
                </Button>
              </div>
            </section>
          </div>
        </aside>
      ) : null}

      <Modal
        open={deviceOpen}
        onClose={() => { setDeviceOpen(false) }}
        title={props.t('teamwork.device.create')}
        closeLabel={props.t('common.close')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setDeviceOpen(false) }}>{props.t('common.cancel')}</Button>
            <Button variant="primary" onClick={() => { void createDevice() }} disabled={busy}>{props.t('teamwork.device.createSubmit')}</Button>
          </>
        )}
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <label style={{ display: 'grid', gap: 5, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
            <span>{props.t('teamwork.device.host')} <span aria-hidden="true" style={{ color: 'var(--dsw-alias-state-error-primary)' }}>*</span></span>
            <Input value={deviceHost} placeholder="127.0.0.1" aria-required="true" onChange={event => { setDeviceHost(event.target.value) }} />
          </label>
          <label style={{ display: 'grid', gap: 5, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
            <span>{props.t('teamwork.device.port')} <span aria-hidden="true" style={{ color: 'var(--dsw-alias-state-error-primary)' }}>*</span></span>
            <Input value={devicePort} placeholder="3080" aria-required="true" onChange={event => { setDevicePort(event.target.value) }} />
          </label>
          <label style={{ display: 'grid', gap: 5, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
            {props.t('teamwork.device.os')}
            <Input value={deviceOs} placeholder="windows / darwin / linux" onChange={event => { setDeviceOs(event.target.value) }} />
          </label>
          {deviceError === undefined ? null : (
            <div role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>{deviceError}</div>
          )}
        </div>
      </Modal>

      <Modal
        open={createOpen}
        onClose={() => { setCreateOpen(false) }}
        title={props.t('teamwork.project.create')}
        closeLabel={props.t('common.close')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setCreateOpen(false) }}>{props.t('common.cancel')}</Button>
            <Button variant="primary" onClick={() => { void createProject() }} disabled={busy}>{props.t('teamwork.project.createSubmit')}</Button>
          </>
        )}
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <label style={{ display: 'grid', gap: 5, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
            <span>{props.t('teamwork.project.name')} <span aria-hidden="true" style={{ color: 'var(--dsw-alias-state-error-primary)' }}>*</span></span>
            <Input value={createName} aria-required="true" onChange={event => { setCreateName(event.target.value) }} />
          </label>
          <label style={{ display: 'grid', gap: 5, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
            {props.t('teamwork.project.description')}
            <Input value={createDescription} onChange={event => { setCreateDescription(event.target.value) }} />
          </label>
          <Checkbox
            checked={createPrivate}
            onChange={setCreatePrivate}
            label={props.t('teamwork.project.private')}
            disabled={createPrivateLocked}
          />
          {createPrivateLocked ? (
            <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>{props.t('teamwork.project.privateLocked')}</div>
          ) : null}
          {createError === undefined ? null : (
            <div role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>{createError}</div>
          )}
        </div>
      </Modal>

      {toastText === undefined ? null : (
        <Toast
          key={toastText.id}
          text={toastText.text}
          holdMs={Math.min(6000, 2600 + toastText.text.length * 60)}
          onDone={() => { setToastText(undefined) }}
        />
      )}
    </div>
  )
}
