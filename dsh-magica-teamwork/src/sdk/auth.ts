/**
 * 会话与鉴权：只保存长期凭据和最近一次 `/auth/token` 换来的 headers。
 *
 * 铁律：
 *  1. `accountToken` 是唯一长期机密（本地样例里 = SHA256(账号:密码)）；
 *  2. 请求 headers 完全由服务端 `/auth/token` 决定，SDK 不签 JWT、不假设 header 名字；
 *  3. headers 过期或 API 返回 401 时，用 `accountToken` 重新换一次，单飞并只重试一次；
 *  4. `/auth/token` 明确拒绝账号凭据 → login_required；网络/5xx → auth_refresh_failed。
 */

import { CredentialStore, CredentialError, defaultHome, type StoredAuth, type StoredCredential } from './credentials.js'
import { isCastboardGlobalRole, type CastboardGlobalRole } from './types.js'

export type CastboardAuthState = 'authenticated' | 'login_required' | 'anonymous'

/** 服务端 `/auth/token` 返回的认证 grant。 */
export interface CastboardAuthGrant {
  accountId: string
  headers: Record<string, string>
  expiresAt: number | null
  displayName?: string | null
  globalRole?: CastboardGlobalRole
}

/** `/auth/token` 请求里可选的设备信息；IP 不作为身份。 */
export interface CastboardAuthDevice {
  id?: string
  host?: string
  port?: number
  os?: string
}

export interface CastboardAuthExchangeInput {
  accountId: string
  accountToken: string
  device?: CastboardAuthDevice
}

export type CastboardAuthExchange = (input: CastboardAuthExchangeInput) => Promise<CastboardAuthGrant>

/** 会话快照（长期凭据；`accountToken` 不出 SDK）。 */
export interface CastboardSession {
  accountId: string
  accountToken: string
  ttlSeconds: number
  displayName?: string | null
  globalRole?: CastboardGlobalRole
}

/** 传输层需要的最小鉴权面。 */
export interface CastboardAuthLike {
  /** 本次请求要带的全部 auth headers；`null` = 无会话。 */
  headers(): Promise<Record<string, string> | null>
  /** 强制重新 `/auth/token`；并发调用共享同一个 Promise。 */
  refresh(): Promise<void>
  /** 已知的全局角色（`admin` 端点的本地拦用；未知返回 `undefined`） */
  globalRole(): CastboardGlobalRole | undefined
  /** 服务端说当前 headers 无效：只清 headers，保留长期凭据。 */
  onUnauthorized(): void
}

export type CastboardAuthErrorCode = 'login_required' | 'auth_exchange_missing' | 'auth_refresh_failed'

export class CastboardAuthError extends Error {
  readonly code: CastboardAuthErrorCode
  readonly status: number

  constructor(code: CastboardAuthErrorCode, message: string, status = 0) {
    super(message)
    this.name = 'CastboardAuthError'
    this.code = code
    this.status = status
  }
}

export interface CastboardAuthOptions {
  /** 凭据目录；缺省 `~/.dsh/storages/teamwork` */
  home?: string
  /** 直接注入会话（CI / 测试）；优先于 `tokenProvider` */
  credentials?: CastboardSession
  /** 异步解析会话（测试 / 自定义凭据源）；仅在没有落盘会话时调用一次 */
  tokenProvider?: () => Promise<CastboardSession | null>
  /** `/auth/token` 交换；由 client 用 transport 的 public 请求实现。 */
  authExchange?: CastboardAuthExchange
  /** 可选设备信息（函数形式用于每次刷新取最新值）。 */
  device?: CastboardAuthDevice | (() => CastboardAuthDevice | undefined)
  /** 401 / 凭据被拒时通知调用方清自己的缓存 */
  onTokenInvalid?: () => void
  /** 复用的服务端标识（`baseUrl`）；与落盘值不一致时**不复用**凭据 */
  serverKey?: string
}

/** 这些 header 不允许由 auth 响应注入，避免破坏请求或跳协议。 */
const RESERVED_AUTH_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'upgrade',
  'set-cookie',
])

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export class CastboardAuth implements CastboardAuthLike {
  private readonly store: CredentialStore
  private readonly tokenProvider: CastboardAuthOptions['tokenProvider']
  private readonly authExchange: CastboardAuthExchange | undefined
  private readonly device: CastboardAuthOptions['device']
  private readonly onTokenInvalid: CastboardAuthOptions['onTokenInvalid']
  private readonly serverKey: string | undefined
  private session: CastboardSession | null = null
  private auth: StoredAuth | null = null
  private refreshPromise: Promise<void> | null = null
  private loginRequired = false
  /** 会话代际：登录/登出/换 token 期间，旧刷新结果不能覆盖新会话。 */
  private generation = 0
  private providerTried = false
  /** 401 / logout 后禁止自动回读，避免把刚失效的凭据又恢复回来。 */
  private restoreDisabled = false

  constructor(options: CastboardAuthOptions = {}) {
    this.store = new CredentialStore(options.home ?? defaultHome())
    this.tokenProvider = options.tokenProvider
    this.authExchange = options.authExchange
    this.device = options.device
    this.onTokenInvalid = options.onTokenInvalid
    this.serverKey = options.serverKey

    if (options.credentials !== undefined) {
      this.session = options.credentials
      this.providerTried = true
    } else {
      this.restore()
    }
  }

  get state(): CastboardAuthState {
    this.ensureRestored()
    if (this.session !== null) return this.loginRequired ? 'login_required' : 'authenticated'
    return this.readSavedAccountId() !== null ? 'login_required' : 'anonymous'
  }

  get accountId(): string | null {
    this.ensureRestored()
    return this.session?.accountId ?? this.readSavedAccountId()
  }

  get accountDisplayName(): string | null {
    this.ensureRestored()
    return this.session?.displayName ?? this.readSavedDisplayName()
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

  /** 登录/注册成功后接受服务端下发的长期凭据；headers 由随后 `refresh()` 取得。 */
  acceptSession(session: CastboardSession): void {
    this.restoreDisabled = false
    this.loginRequired = false
    this.session = session
    this.auth = null
    this.refreshPromise = null
    this.generation += 1
    this.providerTried = true
    this.persist()
  }

  /** 改密码后换长期凭据；旧 auth headers 立即作废，下一次请求重新换。 */
  rotateAccountToken(accountToken: string, ttlSeconds?: number): void {
    if (this.session === null) return
    this.session = {
      ...this.session,
      accountToken,
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
    }
    this.auth = null
    this.generation += 1
    this.persist()
  }

  /** 清内存会话（保留凭据文件；登出时用 `clearStored`） */
  clearMemory(): void {
    this.restoreDisabled = true
    this.session = null
    this.auth = null
    this.refreshPromise = null
    this.generation += 1
    this.providerTried = true
  }

  /** 清凭据文件 + 内存（`alsoKey` 连密钥一起删） */
  clearStored(alsoKey = false): void {
    this.restoreDisabled = true
    try {
      this.store.clear(alsoKey)
    } catch {
      /* 删失败不影响内存清理 */
    }
    this.session = null
    this.auth = null
    this.refreshPromise = null
    this.loginRequired = false
    this.generation += 1
    this.providerTried = true
  }

  // ── CastboardAuthLike ─────────────────────────────────────────────────────

  async headers(): Promise<Record<string, string> | null> {
    this.ensureRestored()
    if (this.needsProvider()) await this.ensureSession()
    if (this.session === null || this.loginRequired) return null
    if (this.auth !== null && this.authValid(this.auth)) return { ...this.auth.headers }
    await this.refresh()
    if (this.session === null || this.loginRequired || this.auth === null) return null
    return { ...this.auth.headers }
  }

  async refresh(): Promise<void> {
    this.ensureRestored()
    if (this.needsProvider()) await this.ensureSession()
    if (this.session === null) throw new CastboardAuthError('login_required', '需要先登录')
    if (this.authExchange === undefined) {
      throw new CastboardAuthError('auth_exchange_missing', 'SDK 缺少 /auth/token 交换实现')
    }
    if (this.refreshPromise !== null) return this.refreshPromise

    const generation = this.generation
    const refresh = this.doRefresh(generation)
    const tracked = refresh.finally(() => {
      if (this.refreshPromise === tracked) this.refreshPromise = null
    })
    this.refreshPromise = tracked
    return tracked
  }

  onUnauthorized(): void {
    this.auth = null
    this.loginRequired = true
    this.refreshPromise = null
    this.generation += 1
    this.persistBestEffort()
    this.notifyInvalid()
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /**
   * 没有落盘会话时，允许外部 `tokenProvider` 提供一次会话。
   * 失败不能被误当成“未登录”，否则调用方会以为只需要重新登录。
   */
  private needsProvider(): boolean {
    return this.session === null
      && this.tokenProvider !== undefined
      && !this.providerTried
      && !this.restoreDisabled
  }

  private async ensureSession(): Promise<void> {
    if (
      this.session !== null
      || this.restoreDisabled
      || this.tokenProvider === undefined
      || this.providerTried
    ) return

    this.providerTried = true
    let provided: CastboardSession | null
    try {
      provided = await this.tokenProvider()
    } catch (error) {
      // 源暂时不可用：允许下一次请求重试，而不是永久停在 anonymous。
      this.providerTried = false
      throw new CastboardAuthError('auth_refresh_failed', `tokenProvider 失败：${authErrorMessage(error)}`)
    }
    if (provided === null || this.restoreDisabled) return
    this.session = provided
    this.auth = null
    this.loginRequired = false
    this.generation += 1
    this.persist()
  }

  private async doRefresh(generation: number): Promise<void> {
    const session = this.session
    if (session === null) throw new CastboardAuthError('login_required', '需要先登录')
    const exchange = this.authExchange
    if (exchange === undefined) throw new CastboardAuthError('auth_exchange_missing', 'SDK 缺少 /auth/token 交换实现')
    const device = this.deviceOf()
    try {
      const grant = await exchange({
        accountId: session.accountId,
        accountToken: session.accountToken,
        ...(device === undefined ? {} : { device }),
      })
      // 刷新期间可能登录了新账号或已登出：旧结果必须丢弃，而不是覆盖新状态。
      if (generation !== this.generation || this.session !== session) return
      this.applyGrant(grant)
    } catch (error) {
      if (generation !== this.generation || this.session !== session) return
      this.auth = null
      if (isAuthRejected(error)) {
        this.loginRequired = true
        this.generation += 1
        this.persistBestEffort()
        this.notifyInvalid()
        throw new CastboardAuthError('login_required', authErrorMessage(error), authErrorStatus(error))
      }
      this.persistBestEffort()
      throw new CastboardAuthError('auth_refresh_failed', authErrorMessage(error), authErrorStatus(error))
    }
  }

  private applyGrant(grant: CastboardAuthGrant): void {
    if (grant === null || typeof grant !== 'object') {
      throw new CastboardAuthError('auth_refresh_failed', '/auth/token 响应不是对象')
    }
    if (grant.accountId !== this.session?.accountId) {
      throw new CastboardAuthError('auth_refresh_failed', '/auth/token 返回的 accountId 与当前会话不一致')
    }
    const headers = normalizeAuthHeaders(grant.headers)
    if (headers === null) {
      throw new CastboardAuthError('auth_refresh_failed', '/auth/token 没有返回可用的 headers')
    }
    const expiresAt = grant.expiresAt === null || (typeof grant.expiresAt === 'number' && Number.isFinite(grant.expiresAt))
      ? grant.expiresAt
      : null
    this.auth = {
      headers,
      expiresAt,
      obtainedAt: new Date().toISOString(),
    }
    this.loginRequired = false
    if (grant.displayName !== undefined) {
      this.session = { ...this.session!, displayName: grant.displayName }
    }
    if (isCastboardGlobalRole(grant.globalRole)) {
      this.session = { ...this.session!, globalRole: grant.globalRole }
    }
    this.persist()
  }

  private authValid(auth: StoredAuth): boolean {
    if (auth.expiresAt === null) return true
    return Date.now() + 30_000 < auth.expiresAt
  }

  private deviceOf(): CastboardAuthDevice | undefined {
    return typeof this.device === 'function' ? this.device() : this.device
  }

  private notifyInvalid(): void {
    try {
      this.onTokenInvalid?.()
    } catch {
      /* 调用方的清理失败不能影响 SDK */
    }
  }

  private persistBestEffort(): void {
    try {
      this.persist()
    } catch {
      /* 认证失败路径不能被磁盘写失败掩盖 */
    }
  }

  /**
   * 凭据文件可能在 SDK 构造之后才出现（登录写盘、另一个 host 实例写入）。
   * 会话为空时按需再读一次；401/登出后由 `restoreDisabled` 阻止回读。
   */
  private ensureRestored(): void {
    if (this.restoreDisabled || this.session !== null) return
    this.restore()
  }

  private restore(): void {
    let saved: StoredCredential | null
    try {
      saved = this.store.load()
    } catch {
      // `credential_corrupt` 等：不自动删（可能想手工抢救）
      return
    }
    if (saved === null) return
    const serverKey = this.serverKey
    if (serverKey !== undefined && saved.server !== serverKey) return
    this.session = {
      accountId: saved.accountId,
      accountToken: saved.accountToken,
      ttlSeconds: saved.ttlSeconds,
      displayName: saved.displayName,
    }
    this.auth = normalizeStoredAuth(saved.auth)
  }

  private readSavedAccountId(): string | null {
    try {
      return this.store.load()?.accountId ?? null
    } catch {
      return null
    }
  }

  private readSavedDisplayName(): string | null {
    try {
      return this.store.load()?.displayName ?? null
    } catch {
      return null
    }
  }

  private persist(): void {
    const session = this.session
    if (session === null) return
    const credential: StoredCredential = {
      v: 2,
      server: this.serverKey ?? '',
      accountId: session.accountId,
      displayName: session.displayName ?? null,
      accountToken: session.accountToken,
      ttlSeconds: session.ttlSeconds,
      auth: this.auth,
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

function normalizeStoredAuth(auth: StoredAuth | null): StoredAuth | null {
  if (auth === null) return null
  const headers = normalizeAuthHeaders(auth.headers)
  return headers === null ? null : { ...auth, headers }
}

function normalizeAuthHeaders(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, string> = {}
  const seen = new Set<string>()
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const key = name.toLowerCase()
    if (!HEADER_NAME.test(name) || RESERVED_AUTH_HEADERS.has(key) || seen.has(key)) continue
    if (typeof raw !== 'string' || /[\r\n]/.test(raw)) continue
    seen.add(key)
    out[name] = raw
  }
  return Object.keys(out).length === 0 ? null : out
}

function authErrorStatus(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'status' in error && typeof (error as { status?: unknown }).status === 'number') {
    return (error as { status: number }).status
  }
  return 0
}

function authErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAuthRejected(error: unknown): boolean {
  const status = authErrorStatus(error)
  if (status === 401 || status === 403) return true
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return code === 'invalid_credentials' || code === 'account_disabled' || code === 'unauthorized' || code === 'login_required'
  }
  return false
}
