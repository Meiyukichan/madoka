/**
 * 面板视图状态与视图模型。
 *
 * @module dsh-magica-castboard/client/data/state/types
 */
import type { BoardSettings, IssueSummary } from '../../../shared/wire.ts'
import type {
  AcceptanceEntry,
  DiagnosticsView,
  InteractionView,
  IssueDetail,
  RouterStrategyEntry,
  Snapshot,
  TaskDetailResponse,
  TaskSummaryView,
  TemplateView,
  WorkspaceNoteEntry,
  WorkspaceRow,
} from '../index.ts'

/** 排序方式。 */
export type SortBy = 'default' | 'updated' | 'urgency' | 'created' | 'title'

/** 视图筛选。 */
export interface Filters {
  workspaceId?: string
  urgencies: string[]
}

/** 归档卡时「连同执行会话归档」的结果（逐会话）。 */
export interface SessionArchiveResult {
  archived: readonly string[]
  failed: readonly { sessionId: string; error: string }[]
  unsupported: readonly string[]
}

/** 待确认的删除目标。 */
export interface AbandonTarget {
  kind: 'task' | 'issue'
  id: string
  title: string
}

/** 表单状态。 */
export interface ComposerState {
  open: boolean
  editingId?: string
  prefill?: TemplateView['spec']
}

/** 整个面板的渲染输入。 */
export interface BoardState {
  status: 'loading' | 'ready' | 'offline'
  error?: string
  revision: number
  issueRevision: number
  linkRevision: number
  tasks: readonly TaskSummaryView[]
  issues: readonly IssueSummary[]
  issueLinks?: Snapshot['issueLinks']
  version?: string
  details: ReadonlyMap<string, TaskDetailResponse>
  issueDetails: ReadonlyMap<string, IssueDetail>
  interactions: readonly InteractionView[]
  workspaces: readonly WorkspaceRow[]
  templates: readonly TemplateView[]
  settings?: BoardSettings
  acceptanceStrategies?: readonly AcceptanceEntry[]
  workspaceNotes?: readonly WorkspaceNoteEntry[]
  routerStrategies?: readonly RouterStrategyEntry[]
  filters: Filters
  search: string
  sortBy: SortBy
  selectedId?: string
  composer: ComposerState
  issueComposer: ComposerState
  abandonTarget?: AbandonTarget
  secondaryOpen: boolean
  diagOpen: boolean
  diagnostics?: DiagnosticsView
  tplManagerOpen: boolean
  settingsOpen: boolean
  dispatchTarget?: string
  dispatchedOpen: boolean
  interactionTarget?: string
  interactionInboxOpen: boolean
  archiveSessionsSupported: boolean
  sessionArchive?: { taskId: string; result: SessionArchiveResult }
}
