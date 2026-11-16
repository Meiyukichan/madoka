/**
 * 旧 SDK（`TeamworkClient`）的公开类型：与服务端契约一一对应，但不依赖服务端实现。
 *
 * ⚠️ **历史层**：新 SDK（`dsh-teamwork/1` 协议面 + lattice 兼容面）在 `src/sdk/lattice/**`，
 * 类型见 `src/sdk/lattice/types.ts`。本文件只服务旧 `TeamworkClient`，按迁移计划（设计文档 §15）
 * 在 P2 阶段改为薄适配、P3 阶段删除。**新代码不要 import 这里的类型。**
 */

export type GlobalRole = 'administrator' | 'leader' | 'user'
export type AccountStatus = 'active' | 'disabled'

export interface Account {
  accountId: string
  displayName: string | null
  globalRole: GlobalRole
  status: AccountStatus
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

export interface AuthSession {
  account: Account
  accountToken: string
  ttlSeconds: number
}

export type Visibility = 'public' | 'private'
export type ProjectStatus = 'active' | 'archived'
export type ProjectRole = 'owner' | 'manager' | 'member'

export interface Project {
  id: number
  name: string
  owner: string | null
  createdBy: string | null
  status: ProjectStatus
  visibility: Visibility
  description: string | null
  memberCount: number
  createdAt: string
  updatedAt: string
}

export interface ProjectMember {
  id: number
  projectId: number
  accountId: string
  displayName: string | null
  role: ProjectRole
  joinedAt: string
  updatedAt: string
}

export interface ProjectDetail extends Project {
  members: ProjectMember[]
}

export type DeviceStatus = 'active' | 'inactive'

export interface Device {
  id: number
  accountId: string
  host: string
  port: number
  os: string | null
  status: DeviceStatus
  lastActiveAt: string
  createdAt: string
  updatedAt: string
}

export type WorkspaceType = 'index' | 'portal'

export interface Workspace {
  id: number
  accountId: string
  instance: string
  workspaceId: string | null
  cwd: string | null
  type: WorkspaceType
  detail: string
  createdAt: string
  updatedAt: string
}

export type IssueStatus = 'pending' | 'accepted' | 'routing' | 'running' | 'success' | 'failed' | 'abandoned'
export type IssueUrgency = 'runtime' | 'direct' | 'urgent' | 'normal' | 'relaxed'
export type IssuePermission = 'read-only' | 'workspace-write' | 'danger-full-access'
export type AttachmentType = 'assigner' | 'assignee'

export interface Issue {
  id: number
  issueId: string
  projectId: number | null
  title: string
  detail: string | null
  assigner: string
  assignerTask: string | null
  assignerMeta: string | null
  cwd: string | null
  urgency: IssueUrgency
  permission: IssuePermission | null
  assignee: string
  assigneeTask: string | null
  assigneeInstance: string | null
  assigneeMeta: string | null
  status: IssueStatus
  source: string
  sourceInstance: string | null
  dependsOn: string | null
  createdAt: string
  assignedAt: string | null
  updatedAt: string
}

export interface IssueCreateInput {
  issueId?: string
  title: string
  detail?: string | null
  assignee: string
  projectId?: number | null
  cwd?: string | null
  urgency?: IssueUrgency
  permission?: IssuePermission | null
  source?: string
  sourceInstance?: string | null
  assignerTask?: string | null
  assignerMeta?: string | null
  dependsOn?: string | null
  status?: IssueStatus
  assigneeTask?: string | null
  assigneeInstance?: string | null
  assigneeMeta?: string | null
  assignedAt?: string | null
}

export interface Comment {
  id: number
  commentId: string
  issueId: string
  author: string | null
  content: string
  commentRole: string | null
  commentAuthorType: string | null
  commentAt: string
  createdAt: string
  updatedAt: string
}

export interface Attachment {
  id: number
  issueId: string
  fileId: string
  fileName: string
  type: AttachmentType
  description: string | null
  createdAt: string
  updatedAt: string
}

export interface Source {
  id: number
  code: string
  description: string | null
  pluginName: string | null
  createdAt: string
  updatedAt: string
}

export interface FileInfo {
  fileId: string
  fileName: string
  size: number
  sha256: string
  createdAt: string
}

export interface Page<T> {
  total: number
  pageNum: number
  pageSize: number
  items: T[]
}

export interface CommentDelta {
  items: Comment[]
  nextSinceId: number
  hasMore: boolean
}

export interface StatusUpdateItem {
  issueId: string
  status: IssueStatus
  expectedStatus?: IssueStatus
  assigneeTask?: string | null
  assigneeInstance?: string | null
  assigneeMeta?: string | null
  assignedAt?: string | null
}

export interface StatusUpdateResult {
  success: number
  failed: Array<{ issueId: string; reason: string }>
}

export interface VersionInfo {
  protocol: string
  name: string
  version: string
  node: string
  endpoints: string[]
}
