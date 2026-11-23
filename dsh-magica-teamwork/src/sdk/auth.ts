/**
 * 会话与鉴权：**只存 `accountToken`，`authToken` 每个请求现签**。
 *
 * 三条铁律（`docs/design/castboard-sdk-design.zh.md` §5）：
 *  1. `accountToken` 是唯一落盘机密（= `SHA256(账号:密码)`，同时是 HS256 的签名密钥）；
 *  2. `authToken`（JWT）每请求现签，**永不落盘**——所以不存在"文件里的 token 过期了"；
 *  3. 401 分四支处理：`token_expired` 重签重试一次、`token_exp_too_long` 修 skew 再试、
 *     `token_account_mismatch` 当代码 bug、`unauthorized` / `account_disabled` → `login_required`。
 *
 * 与传输层的关系：`CastboardTransport` 只认 `CastboardAuthLike`（本文件实现），
 * 所以 transport 可以脱离会话单独测（传一个假的）。
 */

import { createHmac } from 'node:crypto'
import { CredentialStore, CredentialError, defaultHome, type StoredCredential } from './credentials.js'
import type { CastboardGlobalRole } from './types.js'

/** JWT 头（固定 HS256） */
const JWT_HEADER = { alg: 'HS256', typ: 'JWT' } as const

/** 服务端允许的 exp 上限：3 天（与 `api-design` §0.2 的 `now + 3d + 60s` 对齐） */
const MAX_TTL_MS = 3 * 24 * 3_600_000

export type CastboardAuthState = 'authenticated' | 'login_required' | 'anonymous'

/** 会话快照（签名材料；`accountToken` 不出 SDK） */
export interface CastboardSession {
  accountId: string
  accountToken: string
  ttlSeconds: number
  displayName?: string | null
  globalRole?: CastboardGlobalRole
}

/** 传输层需要的最小鉴权面 */
export interface CastboardAuthLike {
  /** 本次请求要带的双头；`null` = 无会话 */
  headers(): { token: string; accountId: string } | null
  /** 已知的全局角色（`admin` 端点的本地拦用；未知返回 `undefined`） */
  globalRole(): CastboardGlobalRole | undefined
  /** 服务端说 exp 已过：重签即可（无副作用） */
  onExpired(): void
  /** 服务端说 exp 太长：用服务端时间修正 skew（毫秒，负值 = 本地快了） */
  onExpTooLong(skewMs: number): void
  /** 签名对不上：清内存会话（**不删**凭据文件，留给用户决定） */
  onUnauthorized(): void
}

export interface CastboardAuthOptions {
  /** 凭据目录；缺省 `~/.dsh/storages/teamwork` */
  home?: string
  /** `false` = 纯内存（不碰任何文件） */
  persist?: boolean
  /** 直接注入会话（CI / 测试）；优先于 `tokenProvider` */
  credentials?: CastboardSession
  /** 异步解析会话（测试 / 自定义凭据源） */
  tokenProvider?: () => Promise<CastboardSession | null>
  /** 401 时通知调用方清自己的缓存 */
  onTokenInvalid?: () => void
  /** 复用的服务端标识（`baseUrl`）；与落盘值不一致时**不复用**凭据 */
  serverKey?: string
}

export class CastboardAuth implements CastboardAuthLike {
  private readonly store: CredentialStore | null
  private readonly tokenProvider: CastboardAuthOptions['tokenProvider']
  private readonly onTokenInvalid: CastboardAuthOptions['onTokenInvalid']
  private readonly serverKey: string | undefined
  private session: CastboardSession | null = null
  private skewMs = 0
  private lastAccountToken: string | null = null
  /** 401 / logout 后禁止自动回读，避免把刚失效的凭据又恢复回来。 */
  private restoreDisabled = false

  constructor(options: CastboardAuthOptions = {}) {
    this.store = options.persist === false ? null : new CredentialStore(options.home ?? defaultHome())
    this.tokenProvider = options.tokenProvider
    this.onTokenInvalid = options.onTokenInvalid
    this.serverKey = options.serverKey

    if (options.credentials !== undefined) {
      this.session = options.credentials
      this.lastAccountToken = options.credentials.accountToken
    } else {
      this.restore()
    }
  }

  get state(): CastboardAuthState {
    this.ensureRestored()
    if (this.session !== null) return 'authenticated'
    return this.savedAccountId() !== null ? 'login_required' : 'anonymous'
  }

  get accountId(): string | null {
    this.ensureRestored()
    return this.session?.accountId ?? this.savedAccountId()
  }

  get accountDisplayName(): string | null {
    this.ensureRestored()
    return this.session?.displayName ?? this.savedDisplayName()
  }

  /** 已知的全局角色（`admin` 端点的本地拦用） */
  globalRole(): CastboardGlobalRole | undefined {
    this.ensureRestored()
    return this.session?.globalRole
  }

  /** 只给排障用：`accountToken` 按密码级机密对待，不要写日志 */
  get accountToken(): string | null {
    this.ensureRestored()
    return this.session?.accountToken ?? null
  }

  /** 登录/注册成功后接受服务端下发的会话 */
  acceptSession(session: CastboardSession): void {
    this.restoreDisabled = false
    this.session = session
    this.lastAccountToken = session.accountToken
    this.skewMs = 0
    this.persist()
  }

  /** 改密码后换密钥（不重新登录） */
  rotateAccountToken(accountToken: string, ttlSeconds?: number): void {
    if (this.session === null) return
    this.session = {
      ...this.session,
      accountToken,
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
    }
    this.lastAccountToken = accountToken
    this.persist()
  }

  /** 清内存会话（保留凭据文件；登出时用 `clearStored`） */
  clearMemory(): void {
    this.restoreDisabled = true
    this.session = null
  }

  /** 清凭据文件 + 内存（`alsoKey` 连密钥一起删） */
  clearStored(alsoKey = false): void {
    this.restoreDisabled = true
    try {
      this.store?.clear(alsoKey)
    } catch {
      /* 删失败不影响内存清理 */
    }
    this.session = null
    this.lastAccountToken = null
  }

  /** 用服务端 `/health.serverTime` 学时钟差 */
  noteServerTime(serverTime: string): void {
    const parsed = Date.parse(serverTime)
    if (Number.isFinite(parsed)) this.skewMs = Date.now() - parsed
  }

  // ── CastboardAuthLike ─────────────────────────────────────────────────────

  headers(): { token: string; accountId: string } | null {
    this.ensureRestored()
    const session = this.session
    if (session === null) return null
    return { token: signToken(session, this.skewMs), accountId: session.accountId }
  }

  onExpired(): void {
    // 现签模式：什么都不用做，下一次 `headers()` 自然带新 exp
  }

  onExpTooLong(skewMs: number): void {
    this.skewMs = Math.min(0, skewMs)
  }

  onUnauthorized(): void {
    this.restoreDisabled = true
    this.session = null
    try {
      this.onTokenInvalid?.()
    } catch {
      /* 调用方的清理失败不能影响 SDK */
    }
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /**
   * 凭据文件可能在 SDK 构造之后才出现（登录写盘、另一个 host 实例写入）。
   * 会话为空时按需再读一次；401/登出后由 `restoreDisabled` 阻止回读。
   */
  private ensureRestored(): void {
    if (this.store === null || this.restoreDisabled || this.session !== null) return
    this.restore()
  }

  private restore(): void {
    if (this.store === null) return
    let saved: StoredCredential | null
    try {
      saved = this.store.load()
    } catch {
      // `credential_corrupt` 等：不自动删（可能想手工抢救）
      return
    }
    if (saved === null) return
    if (this.serverKey !== undefined && saved.server !== this.serverKey) return
    this.session = {
      accountId: saved.accountId,
      accountToken: saved.accountToken,
      ttlSeconds: saved.ttlSeconds,
      displayName: saved.displayName,
    }
    this.lastAccountToken = saved.accountToken
  }

  private savedAccountId(): string | null {
    if (this.store === null) return null
    try {
      return this.store.load()?.accountId ?? null
    } catch {
      return null
    }
  }

  private savedDisplayName(): string | null {
    if (this.store === null) return null
    try {
      return this.store.load()?.displayName ?? null
    } catch {
      return null
    }
  }

  private persist(): void {
    const session = this.session
    if (this.store === null || session === null || this.serverKey === undefined) return
    const credential: StoredCredential = {
      v: 1,
      server: this.serverKey,
      accountId: session.accountId,
      displayName: session.displayName ?? null,
      accountToken: session.accountToken,
      ttlSeconds: session.ttlSeconds,
      savedAt: new Date().toISOString(),
    }
    try {
      this.store.save(credential)
    } catch (err) {
      // 写失败只记在错误信息里；调用方（login）会把它折成 credential_* 信封
      throw new CredentialError('credential_save_failed', `凭据写入失败：${(err as Error).message}`)
    }
  }
}

/** 现签 HS256 JWT：payload 只放 `{a, iat, exp}`（**绝不放 accountToken**） */
export function signToken(session: CastboardSession, skewMs = 0, nowMs = Date.now()): string {
  const now = nowMs + skewMs
  const ttlMs = Math.min(Math.max(session.ttlSeconds, 1) * 1000, MAX_TTL_MS)
  const header = base64url(JSON.stringify(JWT_HEADER))
  const payload = base64url(JSON.stringify({ a: session.accountId, iat: now, exp: now + ttlMs }))
  const signature = createHmac('sha256', session.accountToken).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}
