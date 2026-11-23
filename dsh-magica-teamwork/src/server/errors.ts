/**
 * 业务错误：`code` 是契约（SDK 按它分支），`message` 可改。
 * 码表与 `docs/design/api-design.zh.md` 各模块「错误码汇总」一一对应。
 */
export class BusinessError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(code: string, status: number, message?: string, details?: unknown) {
    super(message ?? code)
    this.name = 'BusinessError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export const errors = {
  // ── 通用 ────────────────────────────────────────────────
  invalidRequest: (message = '请求参数不合法', details?: unknown) => new BusinessError('invalid_request', 400, message, details),
  unknownField: (field: string) => new BusinessError('unknown_field', 400, `不支持的字段: ${field}`, { field }),
  unauthorized: (message = '未认证') => new BusinessError('unauthorized', 401, message),
  forbidden: (message = '权限不足') => new BusinessError('forbidden', 403, message),
  notFound: (what: string) => new BusinessError('not_found', 404, `${what}不存在`),
  conflict: (message: string, details?: unknown) => new BusinessError('conflict', 409, message, details),
  rateLimited: (retryAfterSeconds: number) =>
    new BusinessError('rate_limited', 429, `请求过于频繁，请 ${retryAfterSeconds}s 后重试`, { retryAfterSeconds }),
  notSupported: (message = '不支持该操作') => new BusinessError('not_supported', 400, message),
  internal: (message = '服务内部错误') => new BusinessError('internal_error', 500, message),

  // ── 模块 A：账号 ─────────────────────────────────────────
  invalidAccountId: (reason: string) => new BusinessError('invalid_account_id', 400, `账号不合法：${reason}`, { field: 'accountId', reason }),
  invalidPassword: (reason: string) => new BusinessError('invalid_password', 400, `密码不合法：${reason}`, { field: 'password', reason }),
  invalidPasswordEncoding: () => new BusinessError('invalid_password_encoding', 400, '密码字段必须是合法 base64', { field: 'password' }),
  weakPassword: () => new BusinessError('weak_password', 400, '密码过于简单', { field: 'password' }),
  samePassword: () => new BusinessError('same_password', 400, '新密码不能与旧密码相同'),
  invalidCredentials: () => new BusinessError('invalid_credentials', 401, '账号或密码错误'),
  tokenExpired: () => new BusinessError('token_expired', 401, 'token 已过期'),
  tokenAccountMismatch: () => new BusinessError('token_account_mismatch', 401, '两个鉴权头不一致'),
  tokenExpTooLong: () => new BusinessError('token_exp_too_long', 401, 'token 有效期超过服务端上限'),
  accountDisabled: () => new BusinessError('account_disabled', 403, '账号已被禁用'),
  registrationClosed: () => new BusinessError('registration_closed', 403, '当前不对外开放注册'),
  accountExists: () => new BusinessError('account_exists', 409, '账号已存在'),
  accountNotFound: (accountId: string) => new BusinessError('account_not_found', 404, '账号不存在', { accountId }),
  lastAdministrator: () => new BusinessError('last_administrator', 409, '不能降级最后一个 administrator'),

  // ── 模块 B：项目 / 成员 / 设备 / 工作区 ─────────────────
  invalidProjectName: (reason: string) => new BusinessError('invalid_project_name', 400, `项目名不合法：${reason}`, { field: 'name' }),
  invalidDescription: (max: number) => new BusinessError('invalid_description', 400, `描述最多 ${max} 个字符`, { field: 'description' }),
  invalidVisibility: () => new BusinessError('invalid_visibility', 400, 'visibility 只能是 public / private', { field: 'visibility' }),
  invalidRole: () => new BusinessError('invalid_role', 400, 'role 只能是 manager / member', { field: 'role' }),
  ownerRoleNotAssignable: () => new BusinessError('owner_role_not_assignable', 400, 'owner 不能通过成员接口授予（请用转让）', { field: 'role' }),
  publicProjectRequiresLeader: () =>
    new BusinessError('public_project_requires_leader', 403, '建 public 项目需要 leader 或 administrator'),
  ownerTransferForbidden: () => new BusinessError('owner_transfer_forbidden', 403, '只有 administrator 或该项目 owner 能转让'),
  projectNotFound: (id: number) => new BusinessError('project_not_found', 404, '项目不存在', { projectId: id }),
  memberNotFound: (accountId: string) => new BusinessError('member_not_found', 404, '成员不存在', { accountId }),
  deviceNotFound: (id: number) => new BusinessError('device_not_found', 404, '设备不存在', { id }),
  projectNameExists: () => new BusinessError('project_name_exists', 409, '项目名已存在', { field: 'name' }),
  projectMemberLimit: (limit: number, current: number) =>
    new BusinessError('project_member_limit', 409, `private 项目成员上限 ${limit}（当前 ${current}）`, { limit, current }),
  cannotShrinkToPrivate: (current: number, limit: number) =>
    new BusinessError('cannot_shrink_to_private', 409, `成员数 ${current} 超过 private 上限 ${limit}`, { current, limit }),
  cannotPublish: (owner: string | null) =>
    new BusinessError('cannot_publish', 409, '当前 owner 不是 leader/administrator，无法转为 public', { owner }),
  projectArchived: () => new BusinessError('project_archived', 409, '项目已归档（只读）'),
  projectHasIssues: (count: number) => new BusinessError('project_has_issues', 409, `该项目下还有 ${count} 个 issue`, { count }),
  ownerCannotBeRemoved: () => new BusinessError('owner_cannot_be_removed', 409, '不能直接移除 owner，请先转让'),
  ownerRoleImmutable: () => new BusinessError('owner_role_immutable', 409, '不能通过成员接口修改 owner 的角色，请走转让'),
  ownerMustBeLeader: (accountId: string) =>
    new BusinessError('owner_must_be_leader', 409, 'public 项目的 owner 必须是 leader/administrator', { accountId }),
  invalidWorkspaceShape: (reason: string) =>
    new BusinessError('invalid_workspace_shape', 400, `工作区形状不合法：${reason}`, { field: 'type' }),
  invalidType: (field = 'type') => new BusinessError('invalid_type', 400, `${field} 取值不合法`, { field }),

  // ── 模块 C：Issue ───────────────────────────────────────
  invalidTitle: (reason: string) => new BusinessError('invalid_title', 400, `标题不合法：${reason}`, { field: 'title' }),
  invalidStatus: (field = 'status') => new BusinessError('invalid_status', 400, `${field} 取值不合法`, { field }),
  invalidUrgency: () => new BusinessError('invalid_urgency', 400, 'urgency 取值不合法', { field: 'urgency' }),
  invalidPermission: () => new BusinessError('invalid_permission', 400, 'permission 取值不合法', { field: 'permission' }),
  invalidContent: (reason: string) => new BusinessError('invalid_content', 400, `评论内容不合法：${reason}`, { field: 'content' }),
  invalidSourceCode: (reason: string) => new BusinessError('invalid_source_code', 400, `来源编码不合法：${reason}`, { field: 'code' }),
  issueNotFound: (issueId: string) => new BusinessError('issue_not_found', 404, 'issue 不存在', { issueId }),
  notProjectMember: (projectId: number) => new BusinessError('not_project_member', 403, '不是该项目的成员', { projectId }),

  // ── 模块 F：文件 ────────────────────────────────────────
  invalidFileId: () => new BusinessError('invalid_file_id', 400, 'fileId 必须是 UUID v4', { field: 'fileId' }),
  invalidFileName: (reason: string) => new BusinessError('invalid_file_name', 400, `文件名不合法：${reason}`, { field: 'fileName' }),
  sha256Mismatch: () => new BusinessError('sha256_mismatch', 400, '文件哈希与声明不符'),
  fileNotFoundByFileId: (fileId: string) => new BusinessError('file_not_found', 404, '文件不存在', { fileId }),

  // ── 模块 M / 来源字典 ───────────────────────────────────
  sourceNotFound: (id: number) => new BusinessError('source_not_found', 404, '来源不存在', { id }),
  ownerOfPublicProjects: (projects: string[]) =>
    new BusinessError('owner_of_public_projects', 409, '该账号仍是 public 项目的 owner，不能降级', { projects }),
}

export function nowIso(): string {
  return new Date().toISOString()
}
