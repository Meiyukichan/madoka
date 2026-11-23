/**
 * 账号分组（A1–A6）：注册 / 登录 / 当前账号 / 登出 / 改密码 / 查账号。
 *
 * 三条约定：
 *  - 密码字段**一律 base64(UTF-8)**：本层收明文、发请求前编码；**绝不**把明文/b64 写进日志或信封；
 *  - 登录 / 注册成功后**立刻** `auth.acceptSession()`（内存 + 加密落盘），失败不留"假装已登录"；
 *  - `logout()` 清内存会话与凭据文件（服务端无会话表，最多清鉴权缓存）。
 */

import type { CastboardAuth } from './auth.js'
import type { CastboardTransport } from './transport.js'
import { castboardOk, type CastboardResult, type CastboardFail } from './result.js'
import type { CastboardAccount, CastboardAuthSession, CastboardGlobalRole } from './types.js'
import { isCastboardGlobalRole } from './types.js'
import { toAccount } from './wire.js'

export interface CastboardRegisterInput {
  accountId: string
  /** 明文；本层负责 base64 */
  password: string
  displayName?: string
}

export interface CastboardLoginInput {
  accountId: string
  /** 明文；本层负责 base64 */
  password: string
}

function encodePassword(plain: string): string {
  return Buffer.from(plain, 'utf8').toString('base64')
}

export class CastboardAuthApi {
  constructor(
    private readonly transport: CastboardTransport,
    private readonly auth: CastboardAuth,
  ) {}

  /** A1 `POST /auth/register`：注册即登录（首个账号自动 administrator） */
  async register(input: CastboardRegisterInput): Promise<CastboardResult<CastboardAuthSession>> {
    const account = toAccount(input.accountId, 'accountId', '账号 3..64 个字符')
    if (!account.ok) return account.fail
    const body: Record<string, unknown> = {
      accountId: account.value,
      password: encodePassword(input.password),
    }
    if (input.displayName !== undefined) body['displayName'] = input.displayName
    const result = await this.transport.call<CastboardAuthSession>('authRegister', {}, { body })
    return this.accept(result)
  }

  /** A2 `POST /auth/login`：登录（同一账号永远拿到同一个 `accountToken`） */
  async login(input: CastboardLoginInput): Promise<CastboardResult<CastboardAuthSession>> {
    const account = toAccount(input.accountId, 'accountId', '')
    if (!account.ok) return account.fail
    const result = await this.transport.call<CastboardAuthSession>('authLogin', {}, {
      body: { accountId: account.value, password: encodePassword(input.password) },
    })
    return this.accept(result)
  }

  /**
   * A3 `GET /auth/me`：当前账号。
   *
   * 服务端回 `{ account }`（`api-design` §1.3 写的是裸 `AccountVo`，**以代码为准**），
   * 这里两种形状都兼容。
   */
  async me(): Promise<CastboardResult<CastboardAccount>> {
    const result = await this.transport.call<CastboardAccount | { account?: CastboardAccount }>('authMe')
    if (!result.ok) return result
    const data = result.data
    const account = isAccountLike(data) ? data : isAccountLike((data as { account?: CastboardAccount }).account) ? (data as { account: CastboardAccount }).account : null
    if (account === null) {
      return {
        ok: false,
        status: result.status,
        code: 'internal_error',
        reason: 'authMe 响应里没有 account（服务端形状变了？）',
      }
    }
    return castboardOk(result.status, account)
  }

  /** A4 `POST /auth/logout`：清服务端鉴权缓存 + 清本地会话（保留密钥文件） */
  async logout(options: { allDevices?: boolean } = {}): Promise<CastboardResult<void>> {
    const result = await this.transport.call<void>('authLogout', {}, {
      body: options.allDevices === undefined ? {} : { allDevices: options.allDevices },
    })
    // 无论服务端怎么回，本地都清（登出的语义就是"这台机器不再带着密钥"）
    if (result.ok) this.auth.clearStored(false)
    return result
  }

  /** A5 `PUT /auth/password`：改密码（响应给**新密钥**，本地直接换上，不用重登） */
  async changePassword(input: { oldPassword: string; newPassword: string }): Promise<CastboardResult<{ accountToken: string; ttlSeconds: number }>> {
    const result = await this.transport.call<{ accountToken: string; ttlSeconds: number }>('authPassword', {}, {
      body: {
        oldPassword: encodePassword(input.oldPassword),
        newPassword: encodePassword(input.newPassword),
      },
    })
    if (!result.ok) return result
    if (typeof result.data?.accountToken === 'string') {
      this.auth.rotateAccountToken(result.data.accountToken, result.data.ttlSeconds)
    }
    return result
  }

  /** A6 `GET /auth/accounts?accountId=`：查账号是否存在（administrator） */
  async lookupAccount(accountId: string): Promise<CastboardResult<{ exists: boolean; account: CastboardAccount | null }>> {
    const account = toAccount(accountId, 'accountId', '')
    if (!account.ok) return account.fail
    const result = await this.transport.call<{ exists?: boolean; account?: CastboardAccount | null }>('authAccountLookup', {}, {
      query: { accountId: account.value },
    })
    if (!result.ok) return result
    return castboardOk(result.status, {
      exists: result.data?.exists === true,
      account: result.data?.account ?? null,
    })
  }

  /** A6 的补充：只有角色改动（M4）用得到，放在 admin 分组 */
  static isRole(value: unknown): value is CastboardGlobalRole {
    return isCastboardGlobalRole(value)
  }

  private accept(result: CastboardResult<CastboardAuthSession>): CastboardResult<CastboardAuthSession> {
    if (!result.ok) return result
    const session = result.data
    if (session === null || typeof session !== 'object' || typeof session.accountToken !== 'string' || session.account === undefined) {
      const fail: CastboardFail = {
        ok: false,
        status: result.status,
        code: 'internal_error',
        reason: '登录响应缺少 account / accountToken（服务端形状变了？）',
      }
      return fail
    }
    this.auth.acceptSession({
      accountId: session.account.accountId,
      accountToken: session.accountToken,
      ttlSeconds: session.ttlSeconds,
      displayName: session.account.displayName,
      globalRole: session.account.globalRole,
    })
    return result
  }
}

function isAccountLike(value: unknown): value is CastboardAccount {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { accountId?: unknown }).accountId === 'string' &&
    typeof (value as { globalRole?: unknown }).globalRole === 'string'
  )
}
