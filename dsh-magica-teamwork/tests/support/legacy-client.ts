/**
 * TeamworkClient：宿主/脚本用的客户端。
 *
 * - `host` 默认 `http://127.0.0.1:3939`，可改任意域名（服务端可替换，只要遵守契约）
 * - 凭据只存 `accountToken`；`authToken` 每个请求现签（HS256，payload `{a,iat,exp}`）
 * - 401 自动处理：`token_expired` 重签重试一次；`unauthorized` → 需要重新登录
 */
import { createHmac } from 'node:crypto'
import { CredentialStore, CredentialError, defaultHome, type StoredCredential } from '../../src/sdk/credentials.js'
import type {
  Account, Attachment, AttachmentRole, AttachmentTargetType, AuthSession, Comment, CommentDelta, Device, FileInfo, Issue,
  IssueCreateInput, Project, ProjectDetail, ProjectMember, ProjectRole, Source, StatusUpdateItem,
  StatusUpdateResult, VersionInfo, Workspace,
} from './legacy-types.js'

/** fetch 的请求体：不引 lib.dom，统一走宽松类型 */
type RequestPayload = unknown

export const PROTOCOL = 'dsh-teamwork/1'
export const DEFAULT_HOST = 'http://127.0.0.1:3939'
export const DEFAULT_TTL = 259_200
const EXP_SKEW_MS = 60_000

export class TeamworkError extends Error {
  readonly code: string
  readonly status: number
  readonly details: unknown
  readonly requestId: string | undefined

  constructor(code: string, status: number, message: string, details?: unknown, requestId?: string) {
    super(message)
    this.name = 'TeamworkError'
    this.code = code
    this.status = status
    this.details = details
    this.requestId = requestId
  }
}

export type AuthState = 'authenticated' | 'login_required' | 'anonymous'

export interface ClientOptions {
  /** 服务端根地址，默认 `http://127.0.0.1:3939` */
  host?: string
  /** 凭据目录，默认 `~/.dsh/storages/teamwork` */
  home?: string
  /** `false` = 纯内存（不写盘，测试用） */
  persist?: boolean
  /** 注入 fetch（默认全局 fetch） */
  fetch?: typeof fetch
  /** 供 doctor/日志使用的网络耗时（毫秒） */
  onRequest?: (info: { method: string; path: string; status: number; ms: number }) => void
}

interface Session {
  account: Account
  accountToken: string
  ttlSeconds: number
}

export class TeamworkClient {
  readonly host: string
  private readonly store: CredentialStore | null
  private readonly fetchImpl: typeof fetch
  private readonly onRequest: ClientOptions['onRequest']
  private session: Session | null = null
  private skewMs = 0

  constructor(options: ClientOptions = {}) {
    this.host = normalizeHost(options.host ?? DEFAULT_HOST)
    this.store = options.persist === false ? null : new CredentialStore(options.home ?? defaultHome())
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args))
    this.onRequest = options.onRequest

    if (this.store) {
      const saved = this.store.load()
      if (saved && saved.server === this.host) {
        this.session = {
          account: {
            accountId: saved.accountId,
            displayName: saved.displayName,
            globalRole: 'user',
            status: 'active',
            lastLoginAt: null,
            createdAt: saved.savedAt,
            updatedAt: saved.savedAt,
          },
          accountToken: saved.accountToken,
          ttlSeconds: saved.ttlSeconds,
        }
      }
    }
  }

  // ── 状态 ──────────────────────────────────────────────────
  get authState(): AuthState {
    if (this.session) return 'authenticated'
    return this.accountId ? 'login_required' : 'anonymous'
  }

  get accountId(): string | null {
    return this.session?.account.accountId ?? null
  }

  get account(): Account | null {
    return this.session?.account ?? null
  }

  /** JWT 签名密钥（= SHA256(账号:密码)）。按密码级机密对待，不要写日志。 */
  get accountToken(): string | null {
    return this.session?.accountToken ?? null
  }

  /** 重置本地凭据（`alsoKey` 连密钥一起删） */
  resetCredentials(alsoKey = false): void {
    this.store?.clear(alsoKey)
    this.session = null
  }

  // ── 认证 ──────────────────────────────────────────────────
  async register(input: { accountId: string; password: string; displayName?: string }): Promise<AuthSession> {
    const session = await this.request<AuthSession>('POST', '/auth/register', {
      body: { accountId: input.accountId, password: encodeBase64(input.password), displayName: input.displayName },
      anonymous: true,
    })
    this.acceptSession(session)
    return session
  }

  async login(input: { accountId: string; password: string }): Promise<AuthSession> {
    const session = await this.request<AuthSession>('POST', '/auth/login', {
      body: { accountId: input.accountId, password: encodeBase64(input.password) },
      anonymous: true,
    })
    this.acceptSession(session)
    return session
  }

  async me(): Promise<{ account: Account }> {
    return this.request<{ account: Account }>('GET', '/auth/me')
  }

  async logout(): Promise<void> {
    if (this.session) {
      try {
        await this.request<void>('POST', '/auth/logout', { body: {} })
      } catch {
        /* 服务端无会话，失败也照样清本地 */
      }
    }
    this.store?.clear(false)
    this.session = null
  }

  async changePassword(input: { oldPassword: string; newPassword: string }): Promise<{ accountToken: string; ttlSeconds: number }> {
    const result = await this.request<{ accountToken: string; ttlSeconds: number }>('PUT', '/auth/password', {
      body: { oldPassword: encodeBase64(input.oldPassword), newPassword: encodeBase64(input.newPassword) },
    })
    if (this.session) {
      this.session = { ...this.session, accountToken: result.accountToken, ttlSeconds: result.ttlSeconds }
      this.persist()
    }
    return result
  }

  /** A6 查账号是否存在（administrator） */
  async lookupAccount(accountId: string): Promise<{ exists: boolean; account: Account | null }> {
    return this.request('GET', '/auth/accounts', { query: { accountId } })
  }

  // ── 项目 ──────────────────────────────────────────────────
  readonly projects = {
    list: (query: { pageNum?: number; pageSize?: number; keyword?: string; includeArchived?: boolean } = {}) =>
      this.request<{ total: number; pageNum: number; pageSize: number; items: Project[] }>('GET', '/projects', { query }),
    mine: (query: { includeArchived?: boolean } = {}) => this.request<Project[]>('GET', '/projects/mine', { query }),
    get: (id: number) => this.request<ProjectDetail>('GET', `/projects/${id}`),
    create: (input: { name: string; visibility?: 'public' | 'private'; description?: string }) =>
      this.request<ProjectDetail>('POST', '/projects', { body: input }),
    update: (id: number, input: { name?: string; description?: string | null; visibility?: 'public' | 'private'; status?: 'active' | 'archived' }) =>
      this.request<ProjectDetail>('PUT', `/projects/${id}`, { body: input }),
    remove: (id: number) => this.request<void>('DELETE', `/projects/${id}`),
    members: (id: number) => this.request<ProjectMember[]>('GET', `/projects/${id}/members`),
    addMember: (id: number, input: { accountId: string; role?: Exclude<ProjectRole, 'owner'> }) =>
      this.request<ProjectMember>('POST', `/projects/${id}/members`, { body: input }),
    removeMember: (id: number, accountId: string) => this.request<void>('DELETE', `/projects/${id}/members/${accountId}`),
    transferOwner: (id: number, accountId: string) => this.request<ProjectDetail>('PUT', `/projects/${id}/owner`, { body: { accountId } }),
  }

  // ── 设备与工作区 ──────────────────────────────────────────
  readonly devices = {
    sync: (devices: Array<{ host: string; port?: number; os?: string }>) =>
      this.request<{ synced: number; deactivated: number }>('POST', '/devices/batch', { body: { devices } }),
    listActive: (accountId?: string) => this.request<Device[]>('GET', '/devices', { query: { accountId } }),
    mine: (query: { pageNum?: number; pageSize?: number } = {}) =>
      this.request<{ total: number; pageNum: number; pageSize: number; items: Device[] }>('GET', '/devices/mine', { query }),
    remove: (id: number) => this.request<void>('DELETE', `/devices/${id}`),
  }

  readonly workspaces = {
    upsert: (input: { instance: string; type: 'index' | 'portal'; detail: string; workspaceId?: string; cwd?: string }) =>
      this.request<Workspace>('POST', '/device-workspaces', { body: input }),
    list: (query: { accountId?: string; instance?: string; type?: 'index' | 'portal'; workspaceId?: string; cwd?: string; cwdPrefix?: string } = {}) =>
      this.request<Workspace[]>('GET', '/device-workspaces', { query }),
  }

  // ── Issue ─────────────────────────────────────────────────
  readonly issues = {
    create: (items: IssueCreateInput[]) => this.request<string[]>('POST', '/issues/batch', { body: items }),
    list: (query: { pageNum?: number; pageSize?: number; status?: string; source?: string; projectId?: number; keyword?: string } = {}) =>
      this.request<{ total: number; pageNum: number; pageSize: number; items: Issue[] }>('GET', '/issues', { query }),
    get: (issueId: string) => this.request<Issue>('GET', `/issues/${encodeURIComponent(issueId)}`),
    overwrite: (issueId: string, patch: Partial<IssueCreateInput> & { title?: string }) =>
      this.request<Issue>('PUT', `/issues/${encodeURIComponent(issueId)}`, { body: patch }),
    abandon: (issueId: string) => this.request<void>('DELETE', `/issues/${encodeURIComponent(issueId)}`),
    updateStatus: (items: StatusUpdateItem[]) => this.request<StatusUpdateResult>('POST', '/issues/status/batch', { body: items }),
  }

  readonly comments = {
    add: (issueId: string, input: { content: string; commentId?: string; commentAt?: string; commentRole?: string; commentAuthorType?: string }) =>
      this.request<Comment>('POST', `/issues/${encodeURIComponent(issueId)}/comments`, { body: input }),
    list: (issueId: string) => this.request<Comment[]>('GET', `/issues/${encodeURIComponent(issueId)}/comments`),
    delta: (query: { sinceId?: number; limit?: number } = {}) => this.request<CommentDelta>('GET', '/issues/comments', { query }),
    cursor: () => this.request<{ maxId: number }>('GET', '/issues/comments/cursor'),
  }

  readonly attachments = {
    add: (items: Array<{ targetType: AttachmentTargetType; targetId: string; fileId: string; role: AttachmentRole; fileName?: string; description?: string }>) =>
      this.request<{ count: number }>('POST', '/issues/attachments/batch', { body: items }),
    list: (targetType: AttachmentTargetType, targetId: string, role?: AttachmentRole) =>
      this.request<Attachment[]>('GET', '/attachments', { query: { targetType, targetId, ...(role === undefined ? {} : { role }) } }),
  }

  readonly sources = {
    list: (q?: string) => this.request<Source[]>('GET', '/issue-sources', { query: q ? { q } : {} }),
    register: (items: Array<{ code: string; description?: string; pluginName?: string }>) =>
      this.request<{ count: number }>('POST', '/issue-sources/batch', { body: items }),
    update: (id: number, patch: { description?: string | null; pluginName?: string | null }) =>
      this.request<Source>('PUT', `/issue-sources/${id}`, { body: patch }),
    remove: (id: number) => this.request<void>('DELETE', `/issue-sources/${id}`),
  }

  // ── 文件 ──────────────────────────────────────────────────
  readonly files = {
    upload: async (
      body: AsyncIterable<Uint8Array> | Uint8Array | Buffer,
      input: { fileName: string; sha256?: string },
    ): Promise<FileInfo> => {
      const payload = toWebStream(body)
      return this.request<FileInfo>('POST', '/files', {
        rawBody: payload,
        headers: {
          'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(input.fileName),
          ...(input.sha256 ? { 'x-file-sha256': input.sha256 } : {}),
        },
      })
    },
    download: async (fileId: string): Promise<Response> => this.requestRaw('GET', `/files/${fileId}`),
    remove: (fileId: string) => this.request<void>('DELETE', `/files/${fileId}`),
  }

  readonly admin = {
    accounts: (query: { q?: string; pageNum?: number; pageSize?: number } = {}) =>
      this.request<{ total: number; pageNum: number; pageSize: number; items: Account[] }>('GET', '/admin/accounts', { query }),
    setRole: (accountId: string, role: 'administrator' | 'leader' | 'user') =>
      this.request<Account>('PUT', `/admin/accounts/${accountId}/role`, { body: { role } }),
    resetPassword: (accountId: string, newPassword: string) =>
      this.request<void>('POST', `/admin/accounts/${accountId}/password`, {
        body: { newPassword: encodeBase64(newPassword) },
      }),
  }

  // ── 运维 ──────────────────────────────────────────────────
  async health(): Promise<Record<string, unknown>> {
    return this.request('GET', '/health', { anonymous: true })
  }

  async version(): Promise<VersionInfo> {
    const info = await this.request<VersionInfo>('GET', '/version', { anonymous: true })
    if (info.protocol !== PROTOCOL) {
      throw new TeamworkError('incompatible_server', 0, `协议不匹配：期望 ${PROTOCOL}，服务端是 ${info.protocol}`)
    }
    return info
  }

  // ── 内部：HTTP ────────────────────────────────────────────
  private acceptSession(session: AuthSession): void {
    this.session = { account: session.account, accountToken: session.accountToken, ttlSeconds: session.ttlSeconds }
    this.persist()
  }

  private persist(): void {
    if (!this.store || !this.session) return
    const credential: StoredCredential = {
      v: 2,
      server: this.host,
      accountId: this.session.account.accountId,
      displayName: this.session.account.displayName,
      accountToken: this.session.accountToken,
      ttlSeconds: this.session.ttlSeconds,
      auth: null,
      savedAt: new Date().toISOString(),
    }
    try {
      this.store.save(credential)
    } catch (err) {
      throw new CredentialError('credential_save_failed', `凭据写入失败：${(err as Error).message}`)
    }
  }

  private signToken(): { token: string; accountId: string } {
    if (!this.session) throw new TeamworkError('not_authenticated', 0, '尚未登录')
    const now = Date.now() + this.skewMs
    const exp = now + Math.min(this.session.ttlSeconds * 1000, this.session.ttlSeconds * 1000 + EXP_SKEW_MS)
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    const payload = base64url(JSON.stringify({ a: this.session.account.accountId, iat: now, exp }))
    const sig = createHmac('sha256', this.session.accountToken).update(`${header}.${payload}`).digest('base64url')
    return { token: `${header}.${payload}.${sig}`, accountId: this.session.account.accountId }
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown
      query?: Record<string, unknown>
      headers?: Record<string, string>
      anonymous?: boolean
      rawBody?: RequestPayload
      retried?: boolean
    } = {},
  ): Promise<T> {
    const res = await this.requestRaw(method, path, options)
    if (res.status === 204) return undefined as T
    const text = await res.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }

  private async requestRaw(
    method: string,
    path: string,
    options: {
      body?: unknown
      query?: Record<string, unknown>
      headers?: Record<string, string>
      anonymous?: boolean
      rawBody?: RequestPayload
      retried?: boolean
    } = {},
  ): Promise<Response> {
    const url = new URL(this.host + path)
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
    const headers: Record<string, string> = { ...(options.headers ?? {}) }
    let body: RequestPayload | undefined = options.rawBody
    if (options.body !== undefined && body === undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(options.body)
    }
    if (!options.anonymous) {
      const { token, accountId } = this.signToken()
      headers['dsh-teamwork-token'] = token
      headers['dsh-teamwork-account'] = accountId
    }

    const started = Date.now()
    const res = await this.fetchImpl(url, { method, headers, body: body as never })
    this.onRequest?.({ method, path, status: res.status, ms: Date.now() - started })

    if (res.ok) return res

    let payload: { code?: string; message?: string; details?: unknown; requestId?: string } = {}
    try {
      payload = (await res.json()) as typeof payload
    } catch {
      /* 非 JSON 错误体 */
    }
    const code = payload.code ?? `http_${res.status}`

    // 自动重签一次：本地时钟偏差 / token 过期
    if (!options.retried && (code === 'token_expired' || code === 'token_exp_too_long') && this.session) {
      if (code === 'token_exp_too_long') this.skewMs -= 60_000
      return this.requestRaw(method, path, { ...options, retried: true })
    }
    if (code === 'unauthorized' || code === 'token_account_mismatch') {
      // 密钥已失效：必须重新登录
      this.store?.clear(false)
      this.session = null
    }
    throw new TeamworkError(code, res.status, payload.message ?? res.statusText, payload.details, payload.requestId)
  }
}

// ── 工具 ────────────────────────────────────────────────────
/**
 * 规整 host：
 *  - `127.0.0.1`            → `http://127.0.0.1:3939/dsh-teamwork/v1`
 *  - `https://team.example` → `https://team.example/dsh-teamwork/v1`
 *  - 已经带 `/dsh-teamwork/v1` 的原样保留
 * 其它业务路径直接报错（前缀是契约的一部分）。
 */
export function normalizeHost(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  const url = new URL(withProtocol)
  if (url.port === '' && url.protocol === 'http:') url.port = '3939'
  const prefix = '/dsh-teamwork/v1'
  const path = url.pathname.replace(/\/+$/, '')
  if (path === '' || path === '/') {
    url.pathname = prefix
  } else if (path === prefix) {
    url.pathname = prefix
  } else {
    throw new TeamworkError('invalid_host', 0, `host 不能带业务路径：${raw}`)
  }
  return `${url.origin}${url.pathname}`
}

/** 密码字段一律 base64(UTF-8) 传输 */
export function encodeBase64(plain: string): string {
  return Buffer.from(plain, 'utf8').toString('base64')
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function toWebStream(body: AsyncIterable<Uint8Array> | Uint8Array | Buffer): RequestPayload {
  if (body instanceof Uint8Array) return body as unknown as RequestPayload
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const chunk of body as AsyncIterable<Uint8Array>) controller.enqueue(chunk)
      controller.close()
    },
  })
  return stream as unknown as RequestPayload
}
