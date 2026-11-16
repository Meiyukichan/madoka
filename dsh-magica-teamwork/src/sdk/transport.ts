/**
 * 传输底座：**一条请求管线**（URL 拼装 / 现签 JWT / 能力闸 / 并发闸 / 超时 / 重试 / 错误归一）。
 *
 * 九个决策点（设计文档 §11）：
 *   ① 能力检查（`/version.endpoints[]` 里没有 → `unsupported`，零请求）
 *   ② `pathOf`：占位符替换 + `encodeURIComponent`，残留 `{` → `internal_error`
 *   ③ 鉴权级别：`public` / `signed` / `admin` / `local`
 *   ④ 请求体投影由调用方（分组方法）做，本层不猜
 *   ⑤ `buildUrl`：query 跳过 `undefined`/`null`/`''`
 *   ⑥ `auth.headers()`：现签 HS256（失败 → `login_required`，零请求）
 *   ⑦ fetch：`AbortSignal.timeout` 由出站句柄造（`timeoutMs` 不是标准 init 字段）
 *   ⑧ 非 2xx 归一：`code` / `status` / `reason` / `body`（截断 2KB）
 *   ⑨ 401 四分支：重签一次 / 修 skew 再试 / 代码 bug / `login_required`
 */

import {
  LATTICE_ENDPOINTS,
  endpointCapabilityKey,
  type LatticeAuthMode,
  type LatticeEndpointName,
  type LatticeHttpMethod,
} from './endpoints.js'
import {
  createLatticeFetch,
  createLimitedFetch,
  type LatticeFetch,
  type LatticeFetchInit,
  type LatticeFetchOptions,
} from './net.js'
import { latticeFail, latticeOk, type LatticeErrorCode, type LatticeFail, type LatticeResult } from './result.js'
import type { LatticeAuthLike } from './auth.js'
import { LATTICE_BODY_LIMIT, describeHttpFailure, safeText, seg } from './wire.js'

/** 默认超时（与 `LatticeOptions.timeoutMs` 一致） */
export const LATTICE_DEFAULT_TIMEOUT_MS = 15_000
/** 出站并发上限：单 Node 进程 libuv 只有 4 个线程池槽 */
export const LATTICE_DEFAULT_MAX_CONCURRENCY = 4
/** 默认重试次数（仅幂等请求） */
export const LATTICE_DEFAULT_RETRIES = 2
/** 文件端点最小超时（大文件上传/下载） */
export const LATTICE_FILE_TIMEOUT_MS = 60_000

export interface LatticeTransportOptions {
  /** 已归一（含前缀）的 base URL */
  baseUrl: string
  timeoutMs?: number
  maxConcurrency?: number
  retries?: number
  /** 注入自定义 fetch（仍会套并发闸与超时） */
  fetchImpl?: LatticeFetch
  /** 出站句柄选项（TLS / 代理）；`fetchImpl` 给了就忽略 */
  fetchOptions?: LatticeFetchOptions
  onRequest?: (info: { method: string; path: string; status: number; ms: number }) => void
  auth?: LatticeAuthLike
  /** 已知能力清单（`/version.endpoints[]`）；`null` = 未探测 */
  capabilities?: readonly string[] | null
}

export interface LatticeRequestOptions {
  method?: LatticeHttpMethod
  body?: unknown
  query?: Record<string, string | number | boolean | null | undefined>
  /** `request()` 用；默认 `signed` */
  auth?: LatticeAuthMode
  timeoutMs?: number
  /** 调用方已知本次带业务幂等键 → 允许重试（D15） */
  idempotent?: boolean
  headers?: Record<string, string>
}

export interface LatticeRawOptions {
  method?: LatticeHttpMethod
  body?: string | Uint8Array
  query?: Record<string, string | number | boolean | null | undefined>
  auth?: LatticeAuthMode
  timeoutMs?: number
  idempotent?: boolean
  headers?: Record<string, string>
  /** 不加默认超时（大文件 / 流式） */
  noTimeout?: boolean
}

/** 失败的原始描述（尚未包成信封） */
interface AttemptFailure {
  status: number
  code: LatticeErrorCode
  reason: string
  body?: string
  retryable: boolean
}

type AttemptOk = { ok: true; status: number; data: Response }
type AttemptResult = AttemptOk | { ok: false; failure: AttemptFailure }

export class LatticeTransport {
  readonly baseUrl: string
  readonly timeoutMs: number
  readonly maxConcurrency: number
  readonly retries: number
  private readonly auth: LatticeAuthLike | undefined
  private readonly onRequest: LatticeTransportOptions['onRequest']
  private readonly fetchImpl: LatticeFetch
  private readonly ownHandle: ReturnType<typeof createLatticeFetch> | null
  private capabilities: readonly string[] | null
  private disposed = false

  constructor(options: LatticeTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.timeoutMs = Math.max(1, options.timeoutMs ?? LATTICE_DEFAULT_TIMEOUT_MS)
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? LATTICE_DEFAULT_MAX_CONCURRENCY))
    this.retries = Math.max(0, Math.floor(options.retries ?? LATTICE_DEFAULT_RETRIES))
    this.auth = options.auth
    this.onRequest = options.onRequest
    this.capabilities = options.capabilities ?? null

    let raw: LatticeFetch
    if (options.fetchImpl !== undefined) {
      this.ownHandle = null
      raw = options.fetchImpl
    } else {
      const handle = createLatticeFetch({
        defaultTimeoutMs: this.timeoutMs,
        ...(options.fetchOptions ?? {}),
      })
      this.ownHandle = handle
      raw = (url, init) => handle.fetch(url, init)
    }
    // 无论是否注入 fetch 都套闸（INV-4）
    this.fetchImpl = createLimitedFetch(raw, this.maxConcurrency)
  }

  /** 更新能力清单（`ops.probe()` 的结果）；`null` = 关闭能力闸 */
  setCapabilities(endpoints: readonly string[] | null): void {
    this.capabilities = endpoints
  }

  /** 探过能力后，某个端点是否被服务端声明 */
  supports(name: LatticeEndpointName): boolean {
    if (this.capabilities === null) return true
    return this.capabilities.includes(endpointCapabilityKey(name))
  }

  /** 按端点表发 JSON 请求 */
  async call<T>(
    name: LatticeEndpointName,
    params: Record<string, string | number> = {},
    options: Omit<LatticeRequestOptions, 'method' | 'auth'> = {},
  ): Promise<LatticeResult<T>> {
    if (!this.supports(name)) return this.unsupported(name)
    const endpoint = LATTICE_ENDPOINTS[name]
    const path = this.pathOf(endpoint.path, params)
    if (typeof path !== 'string') return path
    const raw = await this.perform(path, {
      ...options,
      method: endpoint.method,
      auth: endpoint.auth,
      idempotent: options.idempotent ?? endpoint.retry,
    })
    if (!raw.ok) return raw
    return this.parseJson<T>(raw.data, endpoint.method, path)
  }

  /** 按端点表发原始请求（自己读 `Response`） */
  async callRaw(
    name: LatticeEndpointName,
    params: Record<string, string | number> = {},
    options: Omit<LatticeRawOptions, 'method' | 'auth'> = {},
  ): Promise<LatticeResult<Response>> {
    if (!this.supports(name)) return this.unsupported(name)
    const endpoint = LATTICE_ENDPOINTS[name]
    const path = this.pathOf(endpoint.path, params)
    if (typeof path !== 'string') return path
    return this.perform(path, {
      ...options,
      method: endpoint.method,
      auth: endpoint.auth,
      idempotent: options.idempotent ?? endpoint.retry,
    })
  }

  /** 逃生口：按裸路径发 JSON（端点表之外，同 host） */
  async request<T>(path: string, options: LatticeRequestOptions = {}): Promise<LatticeResult<T>> {
    const method = options.method ?? 'GET'
    const raw = await this.perform(path, {
      ...options,
      method,
      auth: options.auth ?? 'signed',
      idempotent: options.idempotent ?? (method === 'GET' || method === 'PUT' || method === 'DELETE'),
    })
    if (!raw.ok) return raw
    return this.parseJson<T>(raw.data, method, path)
  }

  /** 逃生口：按裸路径发原始请求 */
  async raw(path: string, options: LatticeRawOptions = {}): Promise<LatticeResult<Response>> {
    const method = options.method ?? 'GET'
    return this.perform(path, {
      ...options,
      method,
      auth: options.auth ?? 'signed',
      idempotent: options.idempotent ?? (method === 'GET' || method === 'PUT' || method === 'DELETE'),
    })
  }

  /** 回收出站句柄（幂等、不抛） */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.ownHandle !== null) {
      try {
        await this.ownHandle.dispose()
      } catch {
        /* best-effort */
      }
    }
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private unsupported(name: LatticeEndpointName): LatticeFail {
    return latticeFail({
      status: 0,
      code: 'unsupported',
      reason: `服务端未声明该端点（见 /version 的 endpoints[]）：${name}`,
    })
  }

  /** 占位符替换 + 编码；残留 `{` → `internal_error`（不让字面量打到服务端） */
  private pathOf(path: string, params: Record<string, string | number>): string | LatticeFail {
    let out = path
    for (const [key, value] of Object.entries(params)) {
      out = out.split(`{${key}}`).join(seg(value))
    }
    if (out.includes('{') || out.includes('}')) {
      return latticeFail({
        status: 0,
        code: 'internal_error',
        reason: `端点路径占位符没替换完：${out}（SDK 内部错误，请报 bug）`,
        path: out,
      })
    }
    return out
  }

  private buildUrl(path: string, query: LatticeRequestOptions['query']): string {
    const suffix = path.startsWith('/') ? path : `/${path}`
    const url = new URL(`${this.baseUrl}${suffix}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  private authHeaders(
    mode: LatticeAuthMode,
  ): { ok: true; headers: Record<string, string> } | { ok: false; fail: LatticeFail } {
    if (mode === 'public') return { ok: true, headers: {} }
    const auth = this.auth
    const snapshot = auth?.headers() ?? null
    if (snapshot === null) {
      if (mode === 'local') return { ok: true, headers: {} }
      return {
        ok: false,
        fail: latticeFail({
          status: 401,
          code: 'login_required',
          reason: '需要先登录：client 还没有会话（调用 auth.login() / auth.register()，或注入 credentials / tokenProvider）',
        }),
      }
    }
    if (mode === 'admin') {
      const role = auth?.globalRole()
      if (role !== undefined && role !== 'administrator') {
        return {
          ok: false,
          fail: latticeFail({
            status: 403,
            code: 'forbidden',
            reason: `该端点需要 administrator，当前账号 globalRole=${role}`,
          }),
        }
      }
    }
    return {
      ok: true,
      headers: { 'dsh-teamwork-token': snapshot.token, 'dsh-teamwork-account': snapshot.accountId },
    }
  }

  private async perform(
    path: string,
    options: LatticeRequestOptions | LatticeRawOptions,
  ): Promise<LatticeResult<Response>> {
    if (this.disposed) {
      return latticeFail({ status: 0, code: 'internal_error', reason: 'client 已 dispose，不能再发请求' })
    }
    const mode = options.auth ?? 'signed'
    const authResult = this.authHeaders(mode)
    if (!authResult.ok) return authResult.fail

    const url = this.buildUrl(path, options.query)
    const method = options.method ?? 'GET'
    const body = 'body' in options ? options.body : undefined
    const noTimeout = 'noTimeout' in options ? options.noTimeout === true : false
    const headers: Record<string, string> = { ...authResult.headers, ...(options.headers ?? {}) }
    let payload: string | Uint8Array | undefined
    if (body !== undefined) {
      if (typeof body === 'string' || body instanceof Uint8Array) {
        payload = body
      } else {
        headers['content-type'] = 'application/json'
        try {
          payload = JSON.stringify(body)
        } catch (err) {
          return latticeFail({
            status: 0,
            code: 'internal_error',
            reason: `请求体无法序列化：${(err as Error).message}`,
            method,
            path,
          })
        }
      }
    }

    const idempotent = options.idempotent === true
    const attempts = 1 + (idempotent ? this.retries : 0)
    let lastFail: LatticeFail | null = null

    for (let attempt = 0; attempt < attempts; attempt++) {
      const outcome = await this.attempt(url, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        ...(noTimeout ? { noTimeout: true } : { timeoutMs: options.timeoutMs ?? this.timeoutMs }),
      })
      if (outcome.ok) return latticeOk(outcome.status, outcome.data)

      const failure = outcome.failure
      lastFail = latticeFail({
        status: failure.status,
        code: failure.code,
        reason: failure.reason,
        method,
        path,
        ...(failure.body === undefined ? {} : { body: failure.body }),
      })
      if (!failure.retryable || attempt === attempts - 1) break
      await sleep(backoffMs(attempt))
    }

    return (
      lastFail ??
      latticeFail({ status: 0, code: 'internal_error', reason: '请求未发出（SDK 内部错误）', method, path })
    )
  }

  private async attempt(
    url: string,
    init: {
      method: string
      headers: Record<string, string>
      body?: string | Uint8Array
      timeoutMs?: number
      noTimeout?: boolean
    },
  ): Promise<AttemptResult> {
    const started = Date.now()
    const requestInit: LatticeFetchInit = {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.timeoutMs === undefined ? {} : { timeoutMs: init.timeoutMs }),
    }
    let response: Response
    try {
      response =
        init.noTimeout === true
          ? await this.fetchDirect(url, requestInit)
          : await this.fetchImpl(url, requestInit)
    } catch (err) {
      const name = (err as { name?: string })?.name ?? ''
      if (name === 'TimeoutError' || name === 'AbortError') {
        return {
          ok: false,
          failure: {
            status: 0,
            code: 'timeout',
            reason: `请求超时（${init.timeoutMs ?? this.timeoutMs}ms）：${url}`,
            retryable: true,
          },
        }
      }
      return {
        ok: false,
        failure: {
          status: 0,
          code: 'network_error',
          reason: `网络错误：${(err as Error).message}`,
          retryable: true,
        },
      }
    }

    this.onRequest?.({
      method: init.method,
      path: new URL(url).pathname,
      status: response.status,
      ms: Date.now() - started,
    })

    if (response.ok) return { ok: true, status: response.status, data: response }

    const text = await safeText(response)
    const parsed = parseErrorBody(text)
    const failure: AttemptFailure = {
      status: response.status,
      code: parsed.code ?? 'http_error',
      reason: parsed.message ?? describeHttpFailure(response.status, text),
      body: text.length > LATTICE_BODY_LIMIT ? `${text.slice(0, LATTICE_BODY_LIMIT)}…` : text,
      retryable: response.status === 429 || response.status >= 500,
    }

    if (response.status === 401 || (response.status === 403 && failure.code === 'account_disabled')) {
      const retried = await this.handleAuthFailure(failure, url, init)
      if (retried !== null) return retried
    }
    return { ok: false, failure }
  }

  /** 401/403 分支。返回 `null` = 不重试（交给上层按 failure 归一） */
  private async handleAuthFailure(
    failure: AttemptFailure,
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; timeoutMs?: number },
  ): Promise<AttemptResult | null> {
    switch (failure.code) {
      case 'token_expired': {
        // 现签模式：重签一次（新的 exp）
        this.auth?.onExpired()
        return this.retryWithFreshAuth(url, init, failure)
      }
      case 'token_exp_too_long': {
        const skew = await this.learnSkew()
        if (skew === null) return null
        this.auth?.onExpTooLong(skew)
        return this.retryWithFreshAuth(url, init, failure)
      }
      case 'token_account_mismatch': {
        return {
          ok: false,
          failure: {
            ...failure,
            code: 'internal_error',
            reason: `两个鉴权头不一致（SDK 内部错误，请报 bug）：${failure.reason}`,
          },
        }
      }
      case 'unauthorized': {
        this.auth?.onUnauthorized()
        return {
          ok: false,
          failure: {
            ...failure,
            code: 'login_required',
            reason: `会话已失效（签名对不上等认证失败），需要重新登录：${failure.reason}`,
          },
        }
      }
      case 'account_disabled': {
        return {
          ok: false,
          failure: {
            ...failure,
            code: 'login_required',
            reason: `账号已被禁用，恢复后可直接使用：${failure.reason}`,
          },
        }
      }
      default:
        return null
    }
  }

  private async retryWithFreshAuth(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; timeoutMs?: number },
    failure: AttemptFailure,
  ): Promise<AttemptResult> {
    const snapshot = this.auth?.headers() ?? null
    if (snapshot === null) {
      return { ok: false, failure: { ...failure, code: 'login_required', reason: '会话已失效，需要重新登录' } }
    }
    return this.attempt(url, {
      ...init,
      headers: {
        ...init.headers,
        'dsh-teamwork-token': snapshot.token,
        'dsh-teamwork-account': snapshot.accountId,
      },
    })
  }

  /** 读 `/health.serverTime` 学时钟差；失败返回 `null`（不递归、不重试） */
  private async learnSkew(): Promise<number | null> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, { method: 'GET' })
      if (!response.ok) return null
      const data = (await response.json()) as { serverTime?: unknown }
      if (typeof data.serverTime !== 'string') return null
      const parsed = Date.parse(data.serverTime)
      if (!Number.isFinite(parsed)) return null
      return Date.now() - parsed
    } catch {
      return null
    }
  }

  /** 直连 fetch（无默认超时；TLS/代理句柄下走 `fetchDirect`） */
  private async fetchDirect(url: string, init: LatticeFetchInit): Promise<Response> {
    if (this.ownHandle !== null) return this.ownHandle.fetchDirect(url, init)
    return this.fetchImpl(url, init)
  }

  private async parseJson<T>(response: Response, method: string, path: string): Promise<LatticeResult<T>> {
    void method
    void path
    if (response.status === 204) return latticeOk(204, undefined as T)
    const text = await safeText(response)
    if (text.trim() === '') return latticeOk(response.status, undefined as T)
    try {
      return latticeOk(response.status, JSON.parse(text) as T)
    } catch {
      // 非 JSON 但 2xx：把文本原样给调用方（网关 HTML 之类）
      return latticeOk(response.status, text as unknown as T)
    }
  }
}

function parseErrorBody(text: string): { code?: LatticeErrorCode; message?: string } {
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text) as { code?: unknown; message?: unknown }
    return {
      ...(typeof parsed.code === 'string' ? { code: parsed.code as LatticeErrorCode } : {}),
      ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
    }
  } catch {
    return {}
  }
}

function backoffMs(attempt: number): number {
  return 300 * 2 ** attempt + Math.floor(Math.random() * 100)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
