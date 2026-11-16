/**
 * 鉴权 guard：两个头 + 无状态 JWT 验签。
 *
 * 校验顺序（顺序错了会泄露信息）：
 *  1. 两个头都在 → 否则 401
 *  2. 头里的账号 === token 内的 `a` → 否则 token_account_mismatch
 *  3. 按 `a` 查账号 → 不存在同样报 401（不区分账号是否存在）
 *  4. 用该账号的 `accountToken` 验签 + 判过期 + 判 exp 上限
 *  5. 账号状态必须 active
 *  6. 角色从 DB 取（**不信 token**）
 */
import type { DatabaseSync } from 'node:sqlite'
import { errors } from '../errors.js'
import { verifyJwt } from '../crypto/jwt.js'
import { AccountMapper, type AccountRow } from '../modules/account/mapper.js'
import type { AuthCache } from './cache.js'

export const TOKEN_HEADER = 'dsh-teamwork-token'
export const ACCOUNT_HEADER = 'dsh-teamwork-account'

/** 客户端 exp 最多比服务端时间超前 ttl + 这个余量 */
export const EXP_SKEW_MS = 60_000

export interface CurrentUser {
  accountId: string
  displayName: string | null
  globalRole: AccountRow['globalRole']
  status: AccountRow['status']
}

export interface AuthenticateOptions {
  db: DatabaseSync
  ttlSeconds: number
  authCache?: AuthCache | undefined
  now?: number
}

/**
 * 从请求头解析出当前用户；失败抛 BusinessError（401 / 403）。
 */
export function authenticateHeaders(
  headers: Record<string, string | string[] | undefined>,
  options: AuthenticateOptions,
): { user: CurrentUser; fromCache: boolean } {
  const rawToken = pick(headers[TOKEN_HEADER])
  const rawAccount = pick(headers[ACCOUNT_HEADER])
  if (!rawToken || !rawAccount) throw errors.unauthorized('缺少鉴权头')

  const now = options.now ?? Date.now()
  const maxTtl = options.ttlSeconds * 1000 + EXP_SKEW_MS

  // 缓存命中（按 token 指纹），命中也要绑 accountId
  const cached = options.authCache?.get(rawToken, rawAccount, now)
  if (cached) return { user: cached, fromCache: true }

  const mapper = new AccountMapper(options.db)
  const row = mapper.findByAccountId(rawAccount)

  // 账号不存在：走一次等量验签再报 401（避免按耗时判断账号是否存在）
  if (!row) {
    verifyJwt(rawToken, '0'.repeat(64), now, maxTtl)
    throw errors.unauthorized()
  }

  const result = verifyJwt(rawToken, row.accountToken, now, maxTtl)
  if (!result.ok) {
    if (result.reason === 'expired') throw errors.tokenExpired()
    if (result.reason === 'exp_too_long') throw errors.tokenExpTooLong()
    throw errors.unauthorized()
  }
  if (result.payload.a !== rawAccount) throw errors.tokenAccountMismatch()
  if (row.status !== 'active') throw errors.accountDisabled()

  const user: CurrentUser = {
    accountId: row.accountId,
    displayName: row.displayName,
    globalRole: row.globalRole,
    status: row.status,
  }
  options.authCache?.set(rawToken, user, result.payload.exp, now)
  return { user, fromCache: false }
}

function pick(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0]
  return v
}

/** 需要 administrator 的端点在此之上再包一层 */
export function requireAdministrator(user: CurrentUser): void {
  if (user.globalRole !== 'administrator') throw errors.forbidden('需要 administrator')
}
