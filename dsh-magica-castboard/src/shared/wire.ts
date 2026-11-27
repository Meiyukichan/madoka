/**
 * 线格式：`/castboard` 的请求/响应类型与结果信封。
 *
 * 只放**类型**与**纯常量**，不含运行时依赖——client 与 host 两侧都从这里取形状。
 * @module dsh-magica-castboard/shared/wire
 */

/** 协议版本（`/version` 与 `/state` 都会带）。 */
export const CASTBOARD_SCHEMA_VERSION = 1

/** 所有 host 路由共用的前缀；client 与 host 必须取同一个值。 */
export const ROUTE_PREFIX = '/api/castboard'

/** 本插件创建 issue 的唯一来源标记。 */
export const ISSUE_SOURCE_DSH = 'dsh'

/** IM 来源：卡片不占执行并发名额，也不进入任务面板的常规列表。 */
export const IM_SOURCE = 'im'

export function isImSource(source: string | undefined): boolean {
  return typeof source === 'string' && source.trim().toLowerCase() === IM_SOURCE
}

/** `self` 是旧版遗留值；读取时统一折叠成 `dsh`。 */
export function normalizeIssueSource(source: string | undefined): string {
  const value = (source ?? '').trim()
  return value === '' || value === 'self' ? ISSUE_SOURCE_DSH : value
}

/** 结果信封：成功。 */
export interface Ok<T> {
  ok: true
  value: T
}

/** 结果信封：失败。 */
export interface Fail {
  ok: false
  error: { code: CastboardErrorCode; message: string; details?: unknown }
}

/** 对外结果。 */
export type Result<T> = Ok<T> | Fail

/** 稳定错误码（客户端按它分流，不解析 message）。 */
export type CastboardErrorCode =
  | 'invalid_input'
  | 'invalid_transition'
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'internal'

/** 任务状态（7 值；`trashedAt` 不是状态）。 */
export const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'canceled', 'archived', 'abandoned'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** 主要列（看板主区）。 */
export const MAIN_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done']

/** 次要列（「其他任务」）。 */
export const SECONDARY_STATUSES: readonly TaskStatus[] = ['canceled', 'archived']

/** 状态转移表（唯一权威；未列出的迁移一律 `invalid_transition`）。 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ['in_progress', 'canceled', 'abandoned'],
  in_progress: ['todo', 'in_review', 'canceled', 'abandoned'],
  in_review: ['todo', 'in_progress', 'done', 'canceled', 'abandoned'],
  done: ['archived'],
  canceled: ['todo', 'archived', 'abandoned'],
  archived: [],
  abandoned: [],
}

/** 紧急度（权重见 `URGENCY_RANK`）。 */
export const URGENCIES = ['runtime', 'direct', 'urgent', 'normal', 'relaxed'] as const
export type Urgency = (typeof URGENCIES)[number]

/** 派发/排序权重：越小越先。 */
export const URGENCY_RANK: Readonly<Record<Urgency, number>> = {
  runtime: 0,
  direct: 1,
  urgent: 2,
  normal: 3,
  relaxed: 4,
}

/** 权限预设（dsh 的三个真实预设）。 */
export const PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type Permission = (typeof PERMISSIONS)[number]

/** issue 状态（7 值）。 */
export const ISSUE_STATUSES = ['pending', 'accepted', 'routing', 'running', 'success', 'failed', 'abandoned'] as const
export type IssueStatus = (typeof ISSUE_STATUSES)[number]

/** 规划中（看板「待规划」列）。 */
export const PLANNING_ISSUE_STATUSES: readonly IssueStatus[] = ['pending', 'accepted', 'routing']

/** 可被远端覆盖 / 可转卡的状态。 */
export const MERGEABLE_ISSUE_STATUSES: readonly IssueStatus[] = ['pending', 'accepted']

/** 执行记录结局。 */
export type ExecutionOutcome = 'running' | 'succeeded' | 'failed' | 'cancelled'

/** 任务摘要（落索引、发 `/state`）。 */
export interface TaskSummary {
  id: string
  title: string
  status: TaskStatus
  urgency: Urgency
  workspaceId?: string
  projectId?: number
  model?: string
  permission?: Permission
  blocked?: boolean
  issueId?: string
  createdAt: number
  updatedAt: number
  claimedBy?: string
  claimedAt?: number
  releasedAt?: number
  trashedAt?: number
  execution?: { mode: 'queue' | 'scheduled'; cron?: string }
  lastExecutionOutcome?: ExecutionOutcome
  dispatchedIssueCount?: number
  /** 来源通道（本插件统一写 `dsh`；`self` 仅为旧数据兼容）。 */
  source?: string
  /** 创建/更新者（审计；D-19）。 */
  createdBy?: TaskActor
  updatedBy?: TaskActor
  /** 派生值：是否有在跑的执行（不落盘，raw k §4.6）。 */
  hasRunning?: boolean
  /** 派生值：清单完成度（不落盘；卡片徽标用）。 */
  checklistProgress?: { done: number; total: number }
  /** 派生值：最近一次带会话的执行（卡片上的会话 chip 用）。 */
  lastSessionId?: string
  /** 派生值：正在跑的那一轮的触发方式（卡片上的「分发/验收中」胶囊用）。 */
  runningTrigger?: ExecutionRecord['trigger']
  /** 派生值：定时卡的下次触发（只进响应，不落盘）。 */
  nextRunAt?: string
  /** 派生值：执行历史条数（CSV 导出用）。 */
  executionCount?: number
}

/** 审计主体（人 / agent 会话 / 系统）。 */
export interface TaskActor {
  kind: 'user' | 'agent' | 'system'
  /** agent 动作时带会话 id（用户/系统可缺省）。 */
  sessionId?: string
}

/** 单次执行记录。 */
export interface ExecutionRecord {
  id: string
  trigger: 'user' | 'dispatch' | 'scheduled' | 'comment' | 'acceptance'
  startedAt: number
  endedAt?: number
  outcome: ExecutionOutcome
  sessionId?: string
  hostInstanceId?: string
  assist?: boolean
  /** 瞬态轮（评论唤醒等）：不写 lastExecutionOutcome、不改卡状态（D-4）。 */
  transient?: boolean
  /** 结构化执行报告（`castboard_execution_report` 写入；finalize 的 assigneeMeta 来源）。 */
  report?: {
    summary?: string
    changedFiles?: readonly string[]
    checks?: readonly string[]
    artifacts?: readonly string[]
    risk?: string
    reportedAt?: number
  }
  error?: string
}

/** 任务详情（`tasks/<id>.json` 的真相）。 */
export interface TaskRecord extends TaskSummary {
  executions: readonly ExecutionRecord[]
  /** 正文（只进详情，不进摘要；C-25）。 */
  detail?: string
  /** 本卡启用的验收策略 id（只进详情）。 */
  acceptanceStrategies?: readonly string[]
  acceptanceInjectedAt?: number
  /** 标签（≤12×30） */
  tags?: readonly string[]
  /** 验收清单 */
  checklist?: readonly {
    id?: string
    text: string
    done: boolean
    checkedBy?: string
    checkedAt?: number
    note?: string
  }[]
  /** 执行目录（跨机只认路径；不是 workspaceId）。 */
  cwd?: string
  /** agent preset（缺省用全局）。 */
  presetId?: string
  /** router 留下的参考方案（dag / proposal）。 */
  reference?: { dag?: string; proposal?: string }
  /** 派生出的 issue（血缘）。 */
  derivedIssues?: readonly string[]
}

/** 看板设置。 */
export interface BoardSettings {
  defaultPermission: Permission
  maxConcurrent: number
  autoRoute: boolean
  portraitRunOnStart: boolean
  commentsEnabled: boolean
  commentPollMs: number
  interactionReportEnabled: boolean
}

/** 设置默认值（空设置对象 = 出厂默认）。 */
export const DEFAULT_SETTINGS: BoardSettings = {
  defaultPermission: 'workspace-write',
  maxConcurrent: 4,
  autoRoute: true,
  portraitRunOnStart: false,
  commentsEnabled: true,
  commentPollMs: 5000,
  interactionReportEnabled: true,
}

/** 设置取值范围（越界 400，不钳制）。 */
export const SETTINGS_RANGES = {
  maxConcurrent: { min: 1, max: 20 },
  commentPollMs: { min: 1000, max: 3600000 },
} as const

/** 任务摘要的 10 个 issue 侧字段（`castboard-issue.json` 里的 IssueSummary）。 */
export interface IssueSummary {
  /** 建议执行目录（router 定 cwd 的输入之一）。 */
  cwd?: string;
  /** 期望权限（缺省由执行侧回落 workspace-write）。 */
  permission?: Permission;
  /** 标签（router 输出、references 渲染用）。 */
  tags?: readonly string[];
  /** 共享库侧的 workspaceId。 */
  workspaceId?: string;
  /** 下发方元数据（title/detail 之外的其余字段进 references）。 */
  assignerMeta?: Record<string, unknown>;
  /** 下发方的卡（上游血缘）。 */
  assignerTask?: string;
  /** 依赖（全部 success 才进规划；C-4 正式字段）。 */
  dependsOn?: readonly string[];
  issueId: string
  title: string
  detail?: string
  status: IssueStatus
  urgency: Urgency
  source: string
  assignee?: string
  assigneeInstance?: string
  projectId?: number
  createdAt: number
  updatedAt: number
}

/** 关系表条目：只存别处没有的东西。 */
export interface IssueLink {
  issueId: string
  assigneeTaskId?: string
  assignerSessionId?: string
  assigneeSessionId?: string
  lastSeenAt?: number
  lastCommentAt?: number
  commentsPendingSince?: number
}

/** 评论角色。 */
export type CommentRole = 'assigner' | 'assignee' | 'user' | 'system'

/** 评论（jsonl 一行一条）。 */
export interface ThreadComment {
  /** 写这条评论的会话（references/commentsXml 的 thread 属性）。 */
  sessionId?: string;
  id: string
  body: string
  createdAt: number
  role: CommentRole
  authorType: 'human' | 'agent' | 'system'
  threadId: string
}

/** `/state` 的增量快路径响应。 */
export interface StateUnchanged {
  unchanged: true
  revision: number
  issueRevision: number
  linkRevision: number
  /** 待决交互集合的指纹（`kind:id@createdAt` 排序拼接；空集是 `''`）。 */
  interactionRevision?: string
}

/** `/state` 的完整快照。 */
export interface StateSnapshot {
  /** 待决交互（搭车完整快照；unchanged 小包不带）。 */
  interactions?: readonly unknown[]
  schemaVersion: number
  revision: number
  issueRevision: number
  linkRevision: number
  tasks: readonly TaskSummary[]
  issues: readonly IssueSummary[]
  issueLinks: Readonly<Record<string, { hasUnread: boolean; lastCommentAt?: number }>>
  settings?: BoardSettings
  /** 插件版本（面板标题旁的灰色小字；host 从 package.json 读）。 */
  version?: string
}

/** `/state` 的响应。 */
export type StateResponse = StateSnapshot | StateUnchanged

/** 状态迁移是否合法。 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to)
}
