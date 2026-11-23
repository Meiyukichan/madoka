/**
 * 面板使用的视图模型（DTO）。只放类型，不放请求。
 *
 * @module dsh-magica-castboard/client/data/dto
 */
import type {
  BoardSettings,
  IssueSummary,
  TaskRecord,
  TaskStatus,
  ThreadComment,
  Urgency,
} from '../../shared/wire.ts'

/** 一次 `/state` 完整快照。 */
export interface Snapshot {
  schemaVersion?: number
  revision: number
  issueRevision: number
  linkRevision: number
  tasks: TaskSummaryView[]
  issues: IssueSummary[]
  issueLinks?: Record<string, { hasUnread: boolean; lastCommentAt?: number }>
  settings?: BoardSettings
  version?: string
  interactions?: InteractionView[]
}

/** 任务摘要（host 已在 `shared/wire.ts` 声明；这里只补客户端派生视角）。 */
export type TaskSummaryView = import('../../shared/wire.ts').TaskSummary & {
  nextRunAt?: string
  checklistProgress?: { done: number; total: number }
  lastSessionId?: string
  acceptanceStrategyCount?: number
  acceptanceFailed?: boolean
  dispatching?: boolean
  accepting?: boolean
  acceptanceKind?: 'close' | 'issue'
  trashed?: boolean
}

/** 一条待决交互（`/state` 搭车与 `/magica/interactions` 同形）。 */
export interface InteractionView {
  id: string
  kind: 'approval' | 'question'
  sessionId: string
  taskId?: string
  title: string
  body: string
  options?: readonly string[]
  optionDetails?: readonly { label: string; description?: string }[]
  multiSelect?: boolean
  /** Approval requests: raw tool arguments as JSON text. */
  args?: string
  createdAt: number
}

/** 任务详情响应。 */
export interface TaskDetailResponse {
  task: TaskRecord & { nextRunAt?: string }
  comments: readonly ThreadComment[]
}

/** One attachment of the issue behind a task card (target model + derived kind). */
export interface TaskAttachmentView {
  name: string
  path: string
  targetType: 'issue' | 'comment'
  targetId: string
  role: 'assigner' | 'assignee'
  kind: 'input' | 'output' | 'comment'
  state: 'pending' | 'ready'
  fileId?: string
  size?: number
  description?: string
}

export interface TaskAttachmentsResponse {
  taskId: string
  issueId?: string
  items: readonly TaskAttachmentView[]
}

/** 项目行（dsh `workspaces` 快照的投影）。 */
export interface WorkspaceRow {
  id: string
  path: string
  title: string
  sessionCount: number
}

/** 模板（host `TemplateStore` 的形状）。 */
export interface TemplateView {
  id: string
  name: { zh: string; en: string }
  description?: { zh: string; en: string }
  spec: {
    title?: string
    detail?: string
    urgency?: Urgency
    workspaceId?: string
    model?: string
    permission?: string
    checklist?: string[]
    execution?: { mode: 'queue' | 'scheduled'; cron?: string }
  }
  builtin?: boolean
}

/** 分发目标（shared library 视角）。 */
export interface IssueTargets {
  online?: boolean
  onlineFlag?: boolean
  projects: readonly { id: string; label: string; detail?: string }[]
  members: readonly { id: string; label: string; detail?: string; groupId?: string }[]
  instances: readonly { id: string; label: string; detail?: string }[]
  selfAccount?: string
  localInstance?: string
  degraded?: boolean
  reason?: string
}

/** 健康诊断。 */
export interface DiagnosticsView {
  revision?: number
  issueRevision?: number
  linkRevision?: number
  tasks?: number
  issues?: number
  writable?: boolean
  instance?: string
  sdkMissing?: readonly string[]
}

/** 自定义工作区条目。 */
export interface WorkspaceNoteEntry {
  workspaceId: string
  name?: string
  path?: string
  description?: string
}

/** 自定义 Router 策略条目。 */
export interface RouterStrategyEntry {
  id?: string
  name: string
  text: string
  description?: string
}

/** 验收策略条目。 */
export interface AcceptanceEntry {
  id: string
  type: 'issue' | 'close'
  title: string
  /** 判断依据正文（宿主落盘字段叫 `description`）。 */
  description: string
}

/** One selectable model from DSH's own catalog. */
export interface ModelCatalogRow {
  provider: string
  model: string
  name: string
  groupName: string
}

/** Catalog snapshot: selectable rows, host default, and provider failures. */
export interface ModelCatalogView {
  models: readonly ModelCatalogRow[]
  defaultModel?: { provider: string; model: string }
  failures?: readonly { name: string; message: string }[]
}

/** One slash completion candidate. */
export interface PromptCompletionItem {
  name: string
  kind: 'command' | 'skill'
  description?: string
  hint?: string
}

/** Slash candidates grouped by source. */
export interface PromptCompletions {
  commands: readonly PromptCompletionItem[]
  skills: readonly PromptCompletionItem[]
}
