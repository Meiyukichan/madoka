/**
 * 结果信封：整个 SDK 的"永不抛异常"契约载体。
 *
 * 三个字段分工（不许混用）：
 *   status  = HTTP 层发生了什么（0 = 本地或网络层）
 *   code    = 我该怎么处理（机器可读）
 *   reason  = 直接展示给人的中文短句
 *
 * 文档：`docs/design/castboard-sdk-design.zh.md` §6
 */

/** 已知原因码（服务端 `code` 原样透传，未知码由 `(string & {})` 兜住） */
export type KnownCastboardErrorCode =
  // ── 线格式 / 本地校验 ───────────────────────────────────
  | 'invalid_issue_id'
  | 'invalid_project_id'
  | 'invalid_device_id'
  | 'invalid_user_id'
  | 'invalid_body'
  | 'invalid_role'
  | 'invalid_meta'
  | 'invalid_datetime'
  | 'invalid_attachment'
  | 'invalid_path'
  | 'invalid_host'
  // ── 传输 ────────────────────────────────────────────────
  | 'http_error'
  | 'network_error'
  | 'timeout'
  | 'internal_error'
  // ── 会话 ────────────────────────────────────────────────
  | 'login_required'
  | 'auth_refresh_failed'
  | 'auth_exchange_missing'
  | 'token_unavailable'
  | 'credential_missing'
  | 'credential_corrupt'
  | 'credential_busy'
  | 'credential_key_invalid'
  // ── 能力 ────────────────────────────────────────────────
  | 'incompatible_server'
  | 'unsupported'
  // ── 组合层语义 ──────────────────────────────────────────
  | 'read_back_failed'
  | 'update_rejected'
  // ── 协议错误码（`src/server/errors.ts`）─────────────────
  | 'invalid_request'
  | 'unknown_field'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'not_supported'
  | 'rate_limited'
  | 'status_conflict'
  | 'invalid_title'
  | 'invalid_description'
  | 'invalid_content'
  | 'invalid_status'
  | 'invalid_urgency'
  | 'invalid_permission'
  | 'invalid_visibility'
  | 'invalid_project_name'
  | 'invalid_source_code'
  | 'invalid_file_id'
  | 'invalid_file_name'
  | 'sha256_mismatch'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'project_not_found'
  | 'issue_not_found'
  | 'account_not_found'
  | 'member_not_found'
  | 'device_not_found'
  | 'source_not_found'
  | 'file_not_found'
  | 'project_archived'
  | 'project_name_exists'
  | 'project_has_issues'
  | 'project_member_limit'
  | 'cannot_shrink_to_private'
  | 'cannot_publish'
  | 'owner_role_not_assignable'
  | 'owner_role_immutable'
  | 'owner_cannot_be_removed'
  | 'owner_must_be_leader'
  | 'owner_transfer_forbidden'
  | 'not_project_member'
  | 'public_project_requires_leader'
  | 'account_exists'
  | 'registration_closed'
  | 'invalid_credentials'
  | 'same_password'
  | 'weak_password'
  | 'invalid_password'
  | 'invalid_password_encoding'
  | 'invalid_account_id'
  | 'last_administrator'
  | 'owner_of_public_projects'
  | 'invalid_workspace_shape'
  | 'invalid_type'
  | 'token_expired'
  | 'token_exp_too_long'
  | 'token_account_mismatch'
  | 'account_disabled'

/** 失败原因码：已知码 + 任何服务端新增码（不阻断前向兼容） */
export type CastboardErrorCode = KnownCastboardErrorCode | (string & {})

/** 已知码全集（测试与文档对账用） */
export const CASTBOARD_ERROR_CODES: readonly KnownCastboardErrorCode[] = [
  'invalid_issue_id', 'invalid_project_id', 'invalid_device_id', 'invalid_user_id', 'invalid_body',
  'invalid_role', 'invalid_meta', 'invalid_datetime', 'invalid_attachment', 'invalid_path', 'invalid_host',
  'http_error', 'network_error', 'timeout', 'internal_error',
  'login_required', 'token_unavailable', 'credential_missing', 'credential_corrupt', 'credential_busy',
  'credential_key_invalid', 'incompatible_server', 'unsupported', 'read_back_failed', 'update_rejected',
  'invalid_request', 'unknown_field', 'forbidden', 'not_found', 'conflict', 'not_supported', 'rate_limited',
  'status_conflict', 'invalid_title', 'invalid_description', 'invalid_content', 'invalid_status',
  'invalid_urgency', 'invalid_permission', 'invalid_visibility', 'invalid_project_name', 'invalid_source_code',
  'invalid_file_id', 'invalid_file_name', 'sha256_mismatch', 'payload_too_large', 'unsupported_media_type',
  'project_not_found', 'issue_not_found', 'account_not_found', 'member_not_found', 'device_not_found',
  'source_not_found', 'file_not_found', 'project_archived', 'project_name_exists', 'project_has_issues',
  'project_member_limit', 'cannot_shrink_to_private', 'cannot_publish', 'owner_role_not_assignable',
  'owner_role_immutable', 'owner_cannot_be_removed', 'owner_must_be_leader', 'owner_transfer_forbidden',
  'not_project_member', 'public_project_requires_leader', 'account_exists', 'registration_closed',
  'invalid_credentials', 'same_password', 'weak_password', 'invalid_password',
  'invalid_password_encoding', 'invalid_account_id', 'last_administrator', 'owner_of_public_projects',
  'invalid_workspace_shape', 'invalid_type', 'token_expired', 'token_exp_too_long', 'token_account_mismatch',
  'account_disabled',
]

/** 成功信封 */
export interface CastboardOk<T> {
  ok: true
  status: number
  data: T
}

/** 失败信封 */
export interface CastboardFail {
  ok: false
  /** HTTP 状态码；本地校验失败按 400、网络层失败按 0 */
  status: number
  code: CastboardErrorCode
  /** 人可读中文，可含服务端 message */
  reason: string
  /** 入参校验失败时的字段名 */
  field?: string
  /** 出问题的值（`safeJson` 渲染，防 BigInt/BigInt 循环抛错） */
  value?: string
  method?: string
  path?: string
  /** 服务端响应原文，截断 2KB */
  body?: string
  /** "已写入但后续步骤失败"时回传已创建的 issueId */
  created?: string[]
}

/** 结果信封判别联合 */
export type CastboardResult<T> = CastboardOk<T> | CastboardFail

export function castboardOk<T>(status: number, data: T): CastboardOk<T> {
  return { ok: true, status, data }
}

export function castboardFail(init: Omit<CastboardFail, 'ok'>): CastboardFail {
  return { ok: false, ...init }
}

export function isCastboardOk<T>(result: CastboardResult<T>): result is CastboardOk<T> {
  return result.ok
}

export function isCastboardFail<T>(result: CastboardResult<T>): result is CastboardFail {
  return !result.ok
}

/** 失败信封的日志串（`code: reason`），日志与工具错误文案统一用它 */
export function describeCastboardFail(fail: CastboardFail): string {
  return `${fail.code}: ${fail.reason}`
}
