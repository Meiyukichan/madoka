/**
 * 端点表：**唯一真源**。方法体里不许出现手写路径字面量（INV-3）。
 *
 * 48 条表项 / 47 个协议端点（`projectList` 与 `teamworkProjectMine` 同路径 `/projects/mine`）。
 * 逐条语义、入参、出参与错误码见 `docs/design/api-design.zh.md`；
 * 表项与分组方法的映射见设计文档 §7.2 / §9.1。
 */

export type LatticeHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/**
 * 鉴权级别：
 *  - `public`：不带鉴权头
 *  - `signed`：双头（无会话 → 本地 401 `login_required`，零请求）
 *  - `admin`：双头 + 已知角色非 `administrator` 时本地拦 403
 *  - `local`：双头 **或** `X-Shutdown-Token`（回环），不做本地角色拦截
 */
export type LatticeAuthMode = 'public' | 'signed' | 'admin' | 'local'

export interface LatticeEndpoint {
  readonly method: LatticeHttpMethod
  /** 含 `{issueId}` / `{id}` / `{accountId}` / `{fileId}` 占位符；**不含** `/dsh-teamwork/v1` 前缀 */
  readonly path: string
  readonly auth: LatticeAuthMode
  /** true = 端点本身幂等，可无条件重试；false 时调用方可凭业务幂等键逐次置 true（D15） */
  readonly retry: boolean
}

export const LATTICE_ENDPOINTS = {
  // ── 账号（6）─────────────────────────────────────────────────────────
  authRegister: { method: 'POST', path: '/auth/register', auth: 'public', retry: false },
  authLogin: { method: 'POST', path: '/auth/login', auth: 'public', retry: false },
  authMe: { method: 'GET', path: '/auth/me', auth: 'signed', retry: true },
  authLogout: { method: 'POST', path: '/auth/logout', auth: 'signed', retry: false },
  authPassword: { method: 'PUT', path: '/auth/password', auth: 'signed', retry: false },
  authAccountLookup: { method: 'GET', path: '/auth/accounts', auth: 'admin', retry: true },

  // ── 项目（11：含 1 个别名）───────────────────────────────────────────
  teamworkProjectList: { method: 'GET', path: '/projects', auth: 'signed', retry: true },
  teamworkProjectMine: { method: 'GET', path: '/projects/mine', auth: 'signed', retry: true },
  /** 只读视图别名（与 `teamworkProjectMine` 同路径；旧 lattice 的 `project.list()`） */
  projectList: { method: 'GET', path: '/projects/mine', auth: 'signed', retry: true },
  projectMembers: { method: 'GET', path: '/projects/{id}/members', auth: 'signed', retry: true },
  teamworkProjectDetail: { method: 'GET', path: '/projects/{id}', auth: 'signed', retry: true },
  teamworkProjectCreate: { method: 'POST', path: '/projects', auth: 'signed', retry: false },
  teamworkProjectUpdate: { method: 'PUT', path: '/projects/{id}', auth: 'signed', retry: true },
  teamworkProjectDelete: { method: 'DELETE', path: '/projects/{id}', auth: 'signed', retry: true },
  teamworkProjectMemberAdd: { method: 'POST', path: '/projects/{id}/members', auth: 'signed', retry: true },
  teamworkProjectMemberRemove: {
    method: 'DELETE',
    path: '/projects/{id}/members/{accountId}',
    auth: 'signed',
    retry: true,
  },
  teamworkProjectTransferOwner: { method: 'PUT', path: '/projects/{id}/owner', auth: 'signed', retry: true },

  // ── 设备与工作区（6）─────────────────────────────────────────────────
  deviceSync: { method: 'POST', path: '/devices/batch', auth: 'signed', retry: true },
  deviceList: { method: 'GET', path: '/devices', auth: 'signed', retry: true },
  teamworkDeviceMine: { method: 'GET', path: '/devices/mine', auth: 'signed', retry: true },
  teamworkDeviceDelete: { method: 'DELETE', path: '/devices/{id}', auth: 'signed', retry: true },
  workspaceUpsert: { method: 'POST', path: '/device-workspaces', auth: 'signed', retry: true },
  workspaceList: { method: 'GET', path: '/device-workspaces', auth: 'signed', retry: true },

  // ── Issue（16）───────────────────────────────────────────────────────
  issueSubmit: { method: 'POST', path: '/issues/batch', auth: 'signed', retry: false },
  issueList: { method: 'GET', path: '/issues', auth: 'signed', retry: true },
  issueGet: { method: 'GET', path: '/issues/{issueId}', auth: 'signed', retry: true },
  issueReplace: { method: 'PUT', path: '/issues/{issueId}', auth: 'signed', retry: true },
  issueAbandon: { method: 'DELETE', path: '/issues/{issueId}', auth: 'signed', retry: true },
  issueUpdateStatuses: { method: 'POST', path: '/issues/status/batch', auth: 'signed', retry: true },
  issueCommentListSince: { method: 'GET', path: '/issues/comments', auth: 'signed', retry: true },
  issueCommentCursor: { method: 'GET', path: '/issues/comments/cursor', auth: 'signed', retry: true },
  issueCommentAdd: { method: 'POST', path: '/issues/{issueId}/comments', auth: 'signed', retry: false },
  issueCommentList: { method: 'GET', path: '/issues/{issueId}/comments', auth: 'signed', retry: true },
  issueAttachmentAdd: { method: 'POST', path: '/issues/attachments/batch', auth: 'signed', retry: true },
  issueAttachmentList: { method: 'GET', path: '/issues/{issueId}/attachments', auth: 'signed', retry: true },
  issueSourceList: { method: 'GET', path: '/issue-sources', auth: 'signed', retry: true },
  issueSourceRegister: { method: 'POST', path: '/issue-sources/batch', auth: 'signed', retry: true },
  issueSourceUpdate: { method: 'PUT', path: '/issue-sources/{id}', auth: 'admin', retry: true },
  issueSourceDelete: { method: 'DELETE', path: '/issue-sources/{id}', auth: 'admin', retry: true },

  // ── 文件（3）─────────────────────────────────────────────────────────
  fileUpload: { method: 'POST', path: '/files', auth: 'signed', retry: false },
  fileDownload: { method: 'GET', path: '/files/{fileId}', auth: 'signed', retry: true },
  fileDelete: { method: 'DELETE', path: '/files/{fileId}', auth: 'admin', retry: true },

  // ── 运维 / 管理（6）──────────────────────────────────────────────────
  health: { method: 'GET', path: '/health', auth: 'public', retry: true },
  version: { method: 'GET', path: '/version', auth: 'public', retry: true },
  shutdown: { method: 'POST', path: '/admin/shutdown', auth: 'local', retry: true },
  adminAccounts: { method: 'GET', path: '/admin/accounts', auth: 'admin', retry: true },
  adminSetRole: { method: 'PUT', path: '/admin/accounts/{accountId}/role', auth: 'admin', retry: true },
  adminResetPassword: { method: 'POST', path: '/admin/accounts/{accountId}/password', auth: 'admin', retry: false },
} as const satisfies Record<string, LatticeEndpoint>

export type LatticeEndpointName = keyof typeof LATTICE_ENDPOINTS

/** 协议前缀（可由 `options.prefix` 覆盖） */
export const LATTICE_DEFAULT_PREFIX = '/dsh-teamwork/v1'

/** 端点 → 分组（表与实现漂移的护栏，测试断言两边键集完全相等） */
export const LATTICE_ENDPOINT_OWNER = {
  auth: ['authRegister', 'authLogin', 'authMe', 'authLogout', 'authPassword', 'authAccountLookup'],
  project: ['projectList', 'projectMembers'],
  teamworkProject: [
    'teamworkProjectList',
    'teamworkProjectMine',
    'teamworkProjectDetail',
    'teamworkProjectCreate',
    'teamworkProjectUpdate',
    'teamworkProjectDelete',
    'teamworkProjectMemberAdd',
    'teamworkProjectMemberRemove',
    'teamworkProjectTransferOwner',
  ],
  teamworkDevice: ['teamworkDeviceMine', 'teamworkDeviceDelete'],
  device: ['deviceSync', 'deviceList'],
  issue: [
    'issueSubmit',
    'issueList',
    'issueGet',
    'issueReplace',
    'issueAbandon',
    'issueUpdateStatuses',
  ],
  issueAttachment: ['issueAttachmentAdd', 'issueAttachmentList'],
  issueComment: [
    'issueCommentListSince',
    'issueCommentCursor',
    'issueCommentAdd',
    'issueCommentList',
  ],
  issueSource: [
    'issueSourceList',
    'issueSourceRegister',
    'issueSourceUpdate',
    'issueSourceDelete',
  ],
  issueWorkspace: ['workspaceUpsert', 'workspaceList'],
  file: ['fileUpload', 'fileDownload', 'fileDelete'],
  ops: ['health', 'version'],
  admin: ['shutdown', 'adminAccounts', 'adminSetRole', 'adminResetPassword'],
} as const satisfies Record<string, readonly LatticeEndpointName[]>

/** 能力键：`{id}` → `:id`（服务端 `ENDPOINTS` 用 Express 风格占位符） */
export function capabilityKey(endpoint: LatticeEndpoint): string {
  return `${endpoint.method} ${endpoint.path.replace(/\{([^}]+)\}/g, ':$1')}`
}

/** 由端点名取能力键（`/version.endpoints[]` 的比对用） */
export function endpointCapabilityKey(name: LatticeEndpointName): string {
  return capabilityKey(LATTICE_ENDPOINTS[name])
}
