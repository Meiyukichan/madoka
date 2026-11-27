/**
 * 线格式类型：**逐字对齐 `src/server` 的 DB 列与响应投影**（camelCase）。
 *
 * 三类约定（与 `docs/design/castboard-sdk-design.zh.md` §8 一致）：
 *  1. 每个枚举都是「联合类型 + 常量数组 + `is*()` 守卫」三件套；取值 = DB 的 CHECK 约束。
 *  2. DB 里没有的字段，这里**不定义**（`dshPatcherVersion` / 成员 `dept` / 成员角色 `creator` 都不收）。
 *  3. 门面与 DB 不一致的地方只有两处：`dependsOn: string[]`↔`TEXT`、`permission: ''`↔`NULL`
 *     ——全部由 `wire.ts` 翻译。附件身份（`targetType + targetId + role`）线上/离线同名，不翻译。
 */

// ────────────────────────────────────────────────────────────────────────────
// 枚举族
// ────────────────────────────────────────────────────────────────────────────

/** Issue 七值状态（DB `ck_tw_issue_*`；服务端**不校验**转移，由使用侧判定） */
export type CastboardIssueStatus =
  | 'pending'
  | 'accepted'
  | 'routing'
  | 'running'
  | 'success'
  | 'failed'
  | 'abandoned'

export const CASTBOARD_ISSUE_STATUSES: readonly CastboardIssueStatus[] = [
  'pending',
  'accepted',
  'routing',
  'running',
  'success',
  'failed',
  'abandoned',
]

/** 终态集（`abandoned` 亦为终态） */
export const CASTBOARD_TERMINAL_ISSUE_STATUSES: readonly CastboardIssueStatus[] = [
  'success',
  'failed',
  'abandoned',
]

export function isCastboardIssueStatus(value: unknown): value is CastboardIssueStatus {
  return typeof value === 'string' && (CASTBOARD_ISSUE_STATUSES as readonly string[]).includes(value)
}

export function isCastboardTerminalStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && (CASTBOARD_TERMINAL_ISSUE_STATUSES as readonly string[]).includes(status)
}

/** 紧急度（DB `ck_tw_issue_urgency`） */
export type CastboardUrgency = 'runtime' | 'direct' | 'urgent' | 'normal' | 'relaxed'

export const CASTBOARD_URGENCIES: readonly CastboardUrgency[] = ['runtime', 'direct', 'urgent', 'normal', 'relaxed']

export const CASTBOARD_DEFAULT_URGENCY: CastboardUrgency = 'normal'

export function isCastboardUrgency(value: unknown): value is CastboardUrgency {
  return typeof value === 'string' && (CASTBOARD_URGENCIES as readonly string[]).includes(value)
}

/** 执行权限（DB `ck_tw_issue_permission`；`null` = 跟随本机默认） */
export type CastboardPermission = 'read-only' | 'workspace-write' | 'danger-full-access'

export const CASTBOARD_PERMISSIONS: readonly CastboardPermission[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
]

export function isCastboardPermission(value: unknown): value is CastboardPermission {
  return typeof value === 'string' && (CASTBOARD_PERMISSIONS as readonly string[]).includes(value)
}

/** 附件目标类型（DB `ck_tw_attachment_target`）：挂在 issue 还是某条评论上 */
export type CastboardAttachmentTargetType = 'issue' | 'comment'

export const CASTBOARD_ATTACHMENT_TARGET_TYPES: readonly CastboardAttachmentTargetType[] = ['issue', 'comment']

export function isCastboardAttachmentTargetType(value: unknown): value is CastboardAttachmentTargetType {
  return value === 'issue' || value === 'comment'
}

/** 附件角色（DB `ck_tw_attachment_role`）：下发方提供 / 执行方交付 */
export type CastboardAttachmentRole = 'assigner' | 'assignee'

export const CASTBOARD_ATTACHMENT_ROLES: readonly CastboardAttachmentRole[] = ['assigner', 'assignee']

export function isCastboardAttachmentRole(value: unknown): value is CastboardAttachmentRole {
  return value === 'assigner' || value === 'assignee'
}

/** 项目生命周期（DB `ck_tw_project_status`） */
export type CastboardProjectStatus = 'active' | 'archived'

export const CASTBOARD_PROJECT_STATUSES: readonly CastboardProjectStatus[] = ['active', 'archived']

export function isCastboardProjectStatus(value: unknown): value is CastboardProjectStatus {
  return value === 'active' || value === 'archived'
}

/** 项目可见性（纯标签 + private 成员上限） */
export type CastboardProjectVisibility = 'public' | 'private'

export const CASTBOARD_PROJECT_VISIBILITIES: readonly CastboardProjectVisibility[] = ['public', 'private']

export function isCastboardProjectVisibility(value: unknown): value is CastboardProjectVisibility {
  return value === 'public' || value === 'private'
}

/** 项目内角色（DB `ck_tw_member_role`；`owner` 每项目唯一） */
export type CastboardMemberRole = 'owner' | 'manager' | 'member'

export const CASTBOARD_MEMBER_ROLES: readonly CastboardMemberRole[] = ['owner', 'manager', 'member']

export function isCastboardMemberRole(value: unknown): value is CastboardMemberRole {
  return typeof value === 'string' && (CASTBOARD_MEMBER_ROLES as readonly string[]).includes(value)
}

/** 可授予的成员角色（`owner` 只能走转让） */
export type CastboardAssignableRole = 'manager' | 'member'

/** 设备状态（DB `ck_tw_device_status`） */
export type CastboardDeviceStatus = 'active' | 'inactive'

export function isCastboardDeviceStatus(value: unknown): value is CastboardDeviceStatus {
  return value === 'active' || value === 'inactive'
}

/** 全局角色（DB `ck_tw_account_role`） */
export type CastboardGlobalRole = 'administrator' | 'leader' | 'user'

export const CASTBOARD_GLOBAL_ROLES: readonly CastboardGlobalRole[] = ['administrator', 'leader', 'user']

export function isCastboardGlobalRole(value: unknown): value is CastboardGlobalRole {
  return typeof value === 'string' && (CASTBOARD_GLOBAL_ROLES as readonly string[]).includes(value)
}

/** 账号状态（DB `ck_tw_account_status`） */
export type CastboardAccountStatus = 'active' | 'disabled'

export function isCastboardAccountStatus(value: unknown): value is CastboardAccountStatus {
  return value === 'active' || value === 'disabled'
}

/** 工作区肖像粒度（DB `ck_tw_ws_type`） */
export type CastboardWorkspaceType = 'index' | 'portal'

export function isCastboardWorkspaceType(value: unknown): value is CastboardWorkspaceType {
  return value === 'index' || value === 'portal'
}

/** 评论方向（DB 无 CHECK，自由取值；这两个是最常用的） */
export type CastboardCommentRole = 'assigner' | 'assignee'

export const CASTBOARD_COMMENT_ROLES: readonly CastboardCommentRole[] = ['assigner', 'assignee']

export function isCastboardCommentRole(value: unknown): value is CastboardCommentRole {
  return value === 'assigner' || value === 'assignee'
}

/** 评论作者类型（DB 无 CHECK） */
export type CastboardCommentAuthorType = 'user' | 'agent' | 'system'

export const CASTBOARD_COMMENT_AUTHOR_TYPES: readonly CastboardCommentAuthorType[] = ['user', 'agent', 'system']

export function isCastboardCommentAuthorType(value: unknown): value is CastboardCommentAuthorType {
  return value === 'user' || value === 'agent' || value === 'system'
}

/** 批量状态更新的逐条失败原因（与服务端 `reason` 逐字一致） */
export type CastboardStatusFailureReason =
  | 'issue_id_required'
  | 'invalid_status'
  | 'invalid_expected_status'
  | 'not_found'
  | 'status_conflict'
  | 'update_conflict'

export const CASTBOARD_STATUS_FAILURE_REASONS: readonly CastboardStatusFailureReason[] = [
  'issue_id_required',
  'invalid_status',
  'invalid_expected_status',
  'not_found',
  'status_conflict',
  'update_conflict',
]

/** 本机平台（组合层的本地判据用） */
export type CastboardOs = 'windows' | 'linux'

// ────────────────────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────────────────────

/**
 * `issueId` 的形状：**1..100、不含控制字符**（DB `ck_tw_issue_id_len`）。
 * 不做 UUID 硬约束——`dsh:<host>:<uuid5>` 这类语义键是合法业务键（D7）。
 */
export const CASTBOARD_ISSUE_ID_PATTERN = /^(?=[\s\S]{1,100}$)[^\u0000-\u001f\u007f]+$/

/** `issueId` 守卫（不 trim，调用方自己 trim；空串/纯空白不合法） */
export function isCastboardIssueId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && CASTBOARD_ISSUE_ID_PATTERN.test(value)
}

/** 预置来源通道（`source` 是开放取值；`self` 仅为旧数据兼容） */
export const CASTBOARD_PRESET_SOURCES: readonly string[] = ['dsh', 'im']

export const CASTBOARD_DEFAULT_SOURCE = 'dsh'

/** 分页默认值（`api-design` §0.5） */
export const CASTBOARD_TEAMWORK_DEFAULT_PAGE_NUM = 1
export const CASTBOARD_TEAMWORK_DEFAULT_PAGE_SIZE = 20
export const CASTBOARD_MAX_PAGE_SIZE = 200

// ────────────────────────────────────────────────────────────────────────────
// 实体（DB 列的 camelCase 投影）
// ────────────────────────────────────────────────────────────────────────────

/** `*Meta` 入参：已是 JSON 文本就原样透传，对象/数组则序列化 */
export type CastboardMetaInput = string | Record<string, unknown> | unknown[]

/** Issue（22 字段）；`dependsOn` 读回时已归一成 `string[]` */
export interface CastboardIssue {
  id: number
  issueId: string
  projectId: number | null
  title: string
  detail: string | null
  assigner: string
  assignerTask: string | null
  assignerMeta: string | null
  cwd: string | null
  urgency: CastboardUrgency | (string & {})
  permission: CastboardPermission | '' | null
  assignee: string
  assigneeTask: string | null
  assigneeInstance: string | null
  assigneeMeta: string | null
  status: CastboardIssueStatus
  source: string
  sourceInstance: string | null
  dependsOn: string[]
  createdAt: string
  assignedAt: string | null
  updatedAt: string
}

/** 可写字段（`assigner`/`id`/`createdAt`/`updatedAt` 不在内：身份来自 token） */
export interface CastboardIssueInput {
  issueId?: string
  projectId?: number | null
  title?: string
  detail?: string | null
  assignerTask?: string | null
  assignerMeta?: CastboardMetaInput | null
  cwd?: string | null
  urgency?: CastboardUrgency
  permission?: CastboardPermission | '' | null
  assignee?: string
  assigneeTask?: string | null
  assigneeInstance?: string | null
  assigneeMeta?: CastboardMetaInput | null
  status?: CastboardIssueStatus
  source?: string
  sourceInstance?: string | null
  dependsOn?: readonly string[] | null
  assignedAt?: string | null
}

export interface CastboardIssueQuery {
  status?: CastboardIssueStatus
  source?: string
  projectId?: number
  keyword?: string
  /** raw 的写法（等价 `pageNum`） */
  page?: number
  pageNum?: number
  pageSize?: number
}

/** Issue 分页信封；`page` 与 `pageNum` 恒等（D11） */
export interface CastboardIssuePage {
  total: number
  page: number
  pageNum: number
  pageSize: number
  items: CastboardIssue[]
}

export interface CastboardStatusUpdate {
  issueId: string
  status: CastboardIssueStatus
  expectedStatus?: CastboardIssueStatus
  assigneeTask?: string
  assigneeInstance?: string
  assigneeMeta?: CastboardMetaInput
  assignedAt?: string
}

export interface CastboardStatusFailure {
  issueId: string
  reason: CastboardStatusFailureReason | (string & {})
}

export interface CastboardStatusBatchResult {
  success: number
  failed: CastboardStatusFailure[]
}

export interface CastboardAttachment {
  id: number
  targetType: CastboardAttachmentTargetType
  targetId: string
  fileId: string
  fileName: string | null
  role: CastboardAttachmentRole
  description: string | null
  createdAt: string
  updatedAt: string
}

export interface CastboardAttachmentInput {
  targetType: CastboardAttachmentTargetType
  targetId: string
  fileId: string
  role: CastboardAttachmentRole
  fileName?: string
  description?: string
}

export interface CastboardComment {
  id: number
  commentId: string
  issueId: string
  author: string | null
  content: string
  commentRole: CastboardCommentRole | (string & {}) | null
  commentAuthorType: CastboardCommentAuthorType | (string & {}) | null
  commentAt: string
  createdAt: string
  updatedAt: string
}

export interface CastboardCommentInput {
  content: string
  commentId?: string
  commentAt?: string
  commentRole?: CastboardCommentRole | (string & {})
  commentAuthorType?: CastboardCommentAuthorType | (string & {})
}

export interface CastboardCommentIncrementQuery {
  sinceId?: number
  limit?: number
}

export interface CastboardCommentIncrement {
  items: CastboardComment[]
  nextSinceId: number
  hasMore: boolean
}

export interface CastboardSource {
  id: number
  code: string
  description: string | null
  pluginName: string | null
  createdAt: string
  updatedAt: string
}

export interface CastboardSourceInput {
  code: string
  description?: string
  pluginName?: string
}

export interface CastboardDeviceWorkspace {
  id: number
  accountId: string
  instance: string
  workspaceId: string | null
  cwd: string | null
  type: CastboardWorkspaceType
  detail: string
  createdAt: string
  updatedAt: string
}

export interface CastboardDeviceWorkspaceInput {
  instance: string
  type: CastboardWorkspaceType
  detail: string
  workspaceId?: string | null
  cwd?: string | null
}

export interface CastboardDeviceWorkspaceQuery {
  accountId?: string
  instance?: string
  workspaceId?: string
  cwd?: string
  cwdPrefix?: string
  type?: CastboardWorkspaceType
}

export interface CastboardDevice {
  id: number
  accountId: string
  host: string
  port: number
  os: string | null
  status: CastboardDeviceStatus | (string & {})
  lastActiveAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CastboardDeviceInput {
  host: string
  port?: number
  os?: string
}

export interface CastboardProject {
  id: number
  name: string
  owner: string | null
  createdBy: string | null
  status: CastboardProjectStatus | (string & {})
  visibility: CastboardProjectVisibility | (string & {})
  description: string | null
  memberCount: number
  createdAt: string
  updatedAt: string
}

export interface CastboardProjectMember {
  id: number
  projectId: number
  accountId: string
  displayName: string | null
  role: CastboardMemberRole | (string & {})
  joinedAt: string
  updatedAt: string
}

export interface CastboardProjectDetail extends CastboardProject {
  members: CastboardProjectMember[]
}

/** 成员选择器用的账号摘要。 */
export interface CastboardAccountOption {
  accountId: string
  displayName: string | null
  globalRole: string
}

/** teamwork 分页信封（`pageNum` 命名；本协议所有分页端点都用它） */
export interface CastboardTeamworkPage<T> {
  total: number
  pageNum: number
  pageSize: number
  items: T[]
}

/** teamwork 项目项 = 项目（本协议两个项目端点同形，不再分两套） */
export type CastboardTeamworkProject = CastboardProject

export interface CastboardProjectPageQuery {
  pageNum?: number
  pageSize?: number
  keyword?: string
  includeArchived?: boolean
}

export interface CastboardDevicePageQuery {
  pageNum?: number
  pageSize?: number
}

export interface CastboardProjectCreateInput {
  name: string
  visibility?: CastboardProjectVisibility
  description?: string
}

export interface CastboardProjectUpdateInput {
  name?: string
  description?: string | null
  visibility?: CastboardProjectVisibility
  status?: CastboardProjectStatus
}

export interface CastboardProjectMemberInput {
  accountId: string
  role?: CastboardAssignableRole
}

/** F1 上传结果（服务端不落元数据表，只在响应里回） */
export interface CastboardFileInfo {
  fileId: string
  fileName: string
  size: number
  sha256: string
  createdAt: string
}

export interface CastboardAccount {
  accountId: string
  displayName: string | null
  globalRole: CastboardGlobalRole
  status: CastboardAccountStatus
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CastboardAuthSession {
  account: CastboardAccount
  accountToken: string
  ttlSeconds: number
}

export interface CastboardHealth {
  ok: boolean
  version: string
  pid: number
  uptimeMs: number
  startedAt: string
  serverTime: string
  db: { path: string; userVersion: number; journalMode: string }
  authCache: { size: number; hits: number; misses: number; ttlMs: number }
}

export interface CastboardVersion {
  protocol: string
  name: string
  version: string
  dshEngine?: string
  node?: string
  endpoints: string[]
}
