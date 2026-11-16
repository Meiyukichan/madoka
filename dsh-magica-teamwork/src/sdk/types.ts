/**
 * 线格式类型：**逐字对齐 `src/server` 的 DB 列与响应投影**（camelCase）。
 *
 * 三类约定（与 `docs/design/lattice-sdk-design.zh.md` §8 一致）：
 *  1. 每个枚举都是「联合类型 + 常量数组 + `is*()` 守卫」三件套；取值 = DB 的 CHECK 约束。
 *  2. DB 里没有的字段，这里**不定义**（`dshPatcherVersion` / 成员 `dept` / 成员角色 `creator` 都不收）。
 *  3. 门面与 DB 不一致的地方只有三处：附件 `input|output`↔`assigner|assignee`、
 *     `dependsOn: string[]`↔`TEXT`、`permission: ''`↔`NULL`——全部由 `wire.ts` 翻译。
 */

// ────────────────────────────────────────────────────────────────────────────
// 枚举族
// ────────────────────────────────────────────────────────────────────────────

/** Issue 七值状态（DB `ck_tw_issue_*`；服务端**不校验**转移，由使用侧判定） */
export type LatticeIssueStatus =
  | 'pending'
  | 'accepted'
  | 'routing'
  | 'running'
  | 'success'
  | 'failed'
  | 'abandoned'

export const LATTICE_ISSUE_STATUSES: readonly LatticeIssueStatus[] = [
  'pending',
  'accepted',
  'routing',
  'running',
  'success',
  'failed',
  'abandoned',
]

/** 终态集（`abandoned` 亦为终态） */
export const LATTICE_TERMINAL_ISSUE_STATUSES: readonly LatticeIssueStatus[] = [
  'success',
  'failed',
  'abandoned',
]

export function isLatticeIssueStatus(value: unknown): value is LatticeIssueStatus {
  return typeof value === 'string' && (LATTICE_ISSUE_STATUSES as readonly string[]).includes(value)
}

export function isLatticeTerminalStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && (LATTICE_TERMINAL_ISSUE_STATUSES as readonly string[]).includes(status)
}

/** 紧急度（DB `ck_tw_issue_urgency`） */
export type LatticeUrgency = 'runtime' | 'direct' | 'urgent' | 'normal' | 'relaxed'

export const LATTICE_URGENCIES: readonly LatticeUrgency[] = ['runtime', 'direct', 'urgent', 'normal', 'relaxed']

export const LATTICE_DEFAULT_URGENCY: LatticeUrgency = 'normal'

export function isLatticeUrgency(value: unknown): value is LatticeUrgency {
  return typeof value === 'string' && (LATTICE_URGENCIES as readonly string[]).includes(value)
}

/** 执行权限（DB `ck_tw_issue_permission`；`null` = 跟随本机默认） */
export type LatticePermission = 'read-only' | 'workspace-write' | 'danger-full-access'

export const LATTICE_PERMISSIONS: readonly LatticePermission[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
]

export function isLatticePermission(value: unknown): value is LatticePermission {
  return typeof value === 'string' && (LATTICE_PERMISSIONS as readonly string[]).includes(value)
}

/** 附件方向门面值（线上是 `assigner`/`assignee`，见 `wire.toWireAttachmentType`） */
export type LatticeAttachmentType = 'input' | 'output'

export const LATTICE_ATTACHMENT_TYPES: readonly LatticeAttachmentType[] = ['input', 'output']

export function isLatticeAttachmentType(value: unknown): value is LatticeAttachmentType {
  return value === 'input' || value === 'output'
}

/** 线上附件方向（DB CHECK 的两值） */
export type LatticeWireAttachmentType = 'assigner' | 'assignee'

export const LATTICE_WIRE_ATTACHMENT_TYPES: readonly LatticeWireAttachmentType[] = ['assigner', 'assignee']

export function isLatticeWireAttachmentType(value: unknown): value is LatticeWireAttachmentType {
  return value === 'assigner' || value === 'assignee'
}

/** 项目生命周期（DB `ck_tw_project_status`） */
export type LatticeProjectStatus = 'active' | 'archived'

export const LATTICE_PROJECT_STATUSES: readonly LatticeProjectStatus[] = ['active', 'archived']

export function isLatticeProjectStatus(value: unknown): value is LatticeProjectStatus {
  return value === 'active' || value === 'archived'
}

/** 项目可见性（纯标签 + private 成员上限） */
export type LatticeProjectVisibility = 'public' | 'private'

export const LATTICE_PROJECT_VISIBILITIES: readonly LatticeProjectVisibility[] = ['public', 'private']

export function isLatticeProjectVisibility(value: unknown): value is LatticeProjectVisibility {
  return value === 'public' || value === 'private'
}

/** 项目内角色（DB `ck_tw_member_role`；`owner` 每项目唯一） */
export type LatticeMemberRole = 'owner' | 'manager' | 'member'

export const LATTICE_MEMBER_ROLES: readonly LatticeMemberRole[] = ['owner', 'manager', 'member']

export function isLatticeMemberRole(value: unknown): value is LatticeMemberRole {
  return typeof value === 'string' && (LATTICE_MEMBER_ROLES as readonly string[]).includes(value)
}

/** 可授予的成员角色（`owner` 只能走转让） */
export type LatticeAssignableRole = 'manager' | 'member'

/** 设备状态（DB `ck_tw_device_status`） */
export type LatticeDeviceStatus = 'active' | 'inactive'

export function isLatticeDeviceStatus(value: unknown): value is LatticeDeviceStatus {
  return value === 'active' || value === 'inactive'
}

/** 全局角色（DB `ck_tw_account_role`） */
export type LatticeGlobalRole = 'administrator' | 'leader' | 'user'

export const LATTICE_GLOBAL_ROLES: readonly LatticeGlobalRole[] = ['administrator', 'leader', 'user']

export function isLatticeGlobalRole(value: unknown): value is LatticeGlobalRole {
  return typeof value === 'string' && (LATTICE_GLOBAL_ROLES as readonly string[]).includes(value)
}

/** 账号状态（DB `ck_tw_account_status`） */
export type LatticeAccountStatus = 'active' | 'disabled'

export function isLatticeAccountStatus(value: unknown): value is LatticeAccountStatus {
  return value === 'active' || value === 'disabled'
}

/** 工作区肖像粒度（DB `ck_tw_ws_type`） */
export type LatticeWorkspaceType = 'index' | 'portal'

export function isLatticeWorkspaceType(value: unknown): value is LatticeWorkspaceType {
  return value === 'index' || value === 'portal'
}

/** 评论方向（DB 无 CHECK，自由取值；这两个是最常用的） */
export type LatticeCommentRole = 'assigner' | 'assignee'

export const LATTICE_COMMENT_ROLES: readonly LatticeCommentRole[] = ['assigner', 'assignee']

export function isLatticeCommentRole(value: unknown): value is LatticeCommentRole {
  return value === 'assigner' || value === 'assignee'
}

/** 评论作者类型（DB 无 CHECK） */
export type LatticeCommentAuthorType = 'user' | 'agent' | 'system'

export const LATTICE_COMMENT_AUTHOR_TYPES: readonly LatticeCommentAuthorType[] = ['user', 'agent', 'system']

export function isLatticeCommentAuthorType(value: unknown): value is LatticeCommentAuthorType {
  return value === 'user' || value === 'agent' || value === 'system'
}

/** 批量状态更新的逐条失败原因（与服务端 `reason` 逐字一致） */
export type LatticeStatusFailureReason =
  | 'issue_id_required'
  | 'invalid_status'
  | 'invalid_expected_status'
  | 'not_found'
  | 'status_conflict'
  | 'update_conflict'

export const LATTICE_STATUS_FAILURE_REASONS: readonly LatticeStatusFailureReason[] = [
  'issue_id_required',
  'invalid_status',
  'invalid_expected_status',
  'not_found',
  'status_conflict',
  'update_conflict',
]

/** 本机平台（组合层的本地判据用） */
export type LatticeOs = 'windows' | 'linux'

// ────────────────────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────────────────────

/**
 * `issueId` 的形状：**1..100、不含控制字符**（DB `ck_tw_issue_id_len`）。
 * 不做 UUID 硬约束——`dsh:<host>:<uuid5>` 这类语义键是合法业务键（D7）。
 */
export const LATTICE_ISSUE_ID_PATTERN = /^(?=[\s\S]{1,100}$)[^\u0000-\u001f\u007f]+$/

/** `issueId` 守卫（不 trim，调用方自己 trim；空串/纯空白不合法） */
export function isLatticeIssueId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && LATTICE_ISSUE_ID_PATTERN.test(value)
}

/** 预置来源通道（`source` 是开放取值，这三个是内置） */
export const LATTICE_PRESET_SOURCES: readonly string[] = ['self', 'dsh', 'welink']

export const LATTICE_DEFAULT_SOURCE = 'self'

/** 分页默认值（`api-design` §0.5） */
export const LATTICE_TEAMWORK_DEFAULT_PAGE_NUM = 1
export const LATTICE_TEAMWORK_DEFAULT_PAGE_SIZE = 20
export const LATTICE_MAX_PAGE_SIZE = 200

// ────────────────────────────────────────────────────────────────────────────
// 实体（DB 列的 camelCase 投影）
// ────────────────────────────────────────────────────────────────────────────

/** `*Meta` 入参：已是 JSON 文本就原样透传，对象/数组则序列化 */
export type LatticeMetaInput = string | Record<string, unknown> | unknown[]

/** Issue（22 字段）；`dependsOn` 读回时已归一成 `string[]` */
export interface LatticeIssue {
  id: number
  issueId: string
  projectId: number | null
  title: string
  detail: string | null
  assigner: string
  assignerTask: string | null
  assignerMeta: string | null
  cwd: string | null
  urgency: LatticeUrgency | (string & {})
  permission: LatticePermission | '' | null
  assignee: string
  assigneeTask: string | null
  assigneeInstance: string | null
  assigneeMeta: string | null
  status: LatticeIssueStatus
  source: string
  sourceInstance: string | null
  dependsOn: string[]
  createdAt: string
  assignedAt: string | null
  updatedAt: string
}

/** 可写字段（`assigner`/`id`/`createdAt`/`updatedAt` 不在内：身份来自 token） */
export interface LatticeIssueInput {
  issueId?: string
  projectId?: number | null
  title?: string
  detail?: string | null
  assignerTask?: string | null
  assignerMeta?: LatticeMetaInput | null
  cwd?: string | null
  urgency?: LatticeUrgency
  permission?: LatticePermission | '' | null
  assignee?: string
  assigneeTask?: string | null
  assigneeInstance?: string | null
  assigneeMeta?: LatticeMetaInput | null
  status?: LatticeIssueStatus
  source?: string
  sourceInstance?: string | null
  dependsOn?: readonly string[] | null
  assignedAt?: string | null
}

export interface LatticeIssueQuery {
  status?: LatticeIssueStatus
  source?: string
  projectId?: number
  keyword?: string
  /** raw 的写法（等价 `pageNum`） */
  page?: number
  pageNum?: number
  pageSize?: number
}

/** Issue 分页信封；`page` 与 `pageNum` 恒等（D11） */
export interface LatticeIssuePage {
  total: number
  page: number
  pageNum: number
  pageSize: number
  items: LatticeIssue[]
}

export interface LatticeStatusUpdate {
  issueId: string
  status: LatticeIssueStatus
  expectedStatus?: LatticeIssueStatus
  assigneeTask?: string
  assigneeInstance?: string
  assigneeMeta?: LatticeMetaInput
  assignedAt?: string
}

export interface LatticeStatusFailure {
  issueId: string
  reason: LatticeStatusFailureReason | (string & {})
}

export interface LatticeStatusBatchResult {
  success: number
  failed: LatticeStatusFailure[]
}

export interface LatticeAttachment {
  id: number
  issueId: string
  fileId: string
  fileName: string | null
  type: LatticeAttachmentType
  description: string | null
  createdAt: string
  updatedAt: string
}

export interface LatticeAttachmentInput {
  issueId: string
  fileId: string
  type: LatticeAttachmentType | LatticeWireAttachmentType
  fileName?: string
  description?: string
}

export interface LatticeComment {
  id: number
  commentId: string
  issueId: string
  author: string | null
  content: string
  commentRole: LatticeCommentRole | (string & {}) | null
  commentAuthorType: LatticeCommentAuthorType | (string & {}) | null
  commentAt: string
  createdAt: string
  updatedAt: string
}

export interface LatticeCommentInput {
  content: string
  commentId?: string
  commentAt?: string
  commentRole?: LatticeCommentRole | (string & {})
  commentAuthorType?: LatticeCommentAuthorType | (string & {})
}

export interface LatticeCommentIncrementQuery {
  sinceId?: number
  limit?: number
}

export interface LatticeCommentIncrement {
  items: LatticeComment[]
  nextSinceId: number
  hasMore: boolean
}

export interface LatticeSource {
  id: number
  code: string
  description: string | null
  pluginName: string | null
  createdAt: string
  updatedAt: string
}

export interface LatticeSourceInput {
  code: string
  description?: string
  pluginName?: string
}

export interface LatticeDeviceWorkspace {
  id: number
  accountId: string
  instance: string
  workspaceId: string | null
  cwd: string | null
  type: LatticeWorkspaceType
  detail: string
  createdAt: string
  updatedAt: string
}

export interface LatticeDeviceWorkspaceInput {
  instance: string
  type: LatticeWorkspaceType
  detail: string
  workspaceId?: string | null
  cwd?: string | null
}

export interface LatticeDeviceWorkspaceQuery {
  accountId?: string
  instance?: string
  workspaceId?: string
  cwd?: string
  cwdPrefix?: string
  type?: LatticeWorkspaceType
}

export interface LatticeDevice {
  id: number
  accountId: string
  host: string
  port: number
  os: string | null
  status: LatticeDeviceStatus | (string & {})
  lastActiveAt: string | null
  createdAt: string
  updatedAt: string
}

export interface LatticeDeviceInput {
  host: string
  port?: number
  os?: string
}

export interface LatticeProject {
  id: number
  name: string
  owner: string | null
  createdBy: string | null
  status: LatticeProjectStatus | (string & {})
  visibility: LatticeProjectVisibility | (string & {})
  description: string | null
  memberCount: number
  createdAt: string
  updatedAt: string
}

export interface LatticeProjectMember {
  id: number
  projectId: number
  accountId: string
  displayName: string | null
  role: LatticeMemberRole | (string & {})
  joinedAt: string
  updatedAt: string
}

export interface LatticeProjectDetail extends LatticeProject {
  members: LatticeProjectMember[]
}

/** teamwork 分页信封（`pageNum` 命名；本协议所有分页端点都用它） */
export interface LatticeTeamworkPage<T> {
  total: number
  pageNum: number
  pageSize: number
  items: T[]
}

/** teamwork 项目项 = 项目（本协议两个项目端点同形，不再分两套） */
export type LatticeTeamworkProject = LatticeProject

export interface LatticeProjectPageQuery {
  pageNum?: number
  pageSize?: number
  keyword?: string
  includeArchived?: boolean
}

export interface LatticeDevicePageQuery {
  pageNum?: number
  pageSize?: number
}

export interface LatticeProjectCreateInput {
  name: string
  visibility?: LatticeProjectVisibility
  description?: string
}

export interface LatticeProjectUpdateInput {
  name?: string
  description?: string | null
  visibility?: LatticeProjectVisibility
  status?: LatticeProjectStatus
}

export interface LatticeProjectMemberInput {
  accountId: string
  role?: LatticeAssignableRole
}

/** F1 上传结果（服务端不落元数据表，只在响应里回） */
export interface LatticeFileInfo {
  fileId: string
  fileName: string
  size: number
  sha256: string
  createdAt: string
}

export interface LatticeAccount {
  accountId: string
  displayName: string | null
  globalRole: LatticeGlobalRole
  status: LatticeAccountStatus
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

export interface LatticeAuthSession {
  account: LatticeAccount
  accountToken: string
  ttlSeconds: number
}

export interface LatticeHealth {
  ok: boolean
  version: string
  pid: number
  uptimeMs: number
  startedAt: string
  serverTime: string
  db: { path: string; userVersion: number; journalMode: string }
  authCache: { size: number; hits: number; misses: number; ttlMs: number }
}

export interface LatticeVersion {
  protocol: string
  name: string
  version: string
  dshEngine?: string
  node?: string
  endpoints: string[]
}
