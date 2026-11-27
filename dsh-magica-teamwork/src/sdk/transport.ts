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
  CASTBOARD_ENDPOINTS,
  endpointCapabilityKey,
  type CastboardAuthMode,
  type CastboardEndpointName,
  type CastboardHttpMethod,
} from './endpoints.js'
import {
  createCastboardFetch,
  createLimitedFetch,
  type CastboardFetch,
  type CastboardFetchInit,
  type CastboardFetchOptions,
} from './net.js'
import { castboardFail, castboardOk, type CastboardErrorCode, type CastboardFail, type CastboardResult } from './result.js'
import { castboardLog } from './log.js'
import type { CastboardAuthLike } from './auth.js'
import { CastboardAuthError } from './auth.js'
import { CASTBOARD_BODY_LIMIT, describeHttpFailure, safeText, seg } from './wire.js'

/** 默认超时（与 `CastboardOptions.timeoutMs` 一致） */
export const CASTBOARD_DEFAULT_TIMEOUT_MS = 15_000
/** 出站并发上限：单 Node 进程 libuv 只有 4 个线程池槽 */
export const CASTBOARD_DEFAULT_MAX_CONCURRENCY = 4
/** 默认重试次数（仅幂等请求） */
export const CASTBOARD_DEFAULT_RETRIES = 2
/** 文件端点最小超时（大文件上传/下载） */
export const CASTBOARD_FILE_TIMEOUT_MS = 60_000

export interface CastboardTransportOptions {
  /** 已归一（含前缀）的 base URL */
  baseUrl: string
  timeoutMs?: number
  maxConcurrency?: number
  retries?: number
  /** 注入自定义 fetch（仍会套并发闸与超时） */
  fetchImpl?: CastboardFetch
  /** 出站句柄选项（TLS / 代理）；`fetchImpl` 给了就忽略 */
  fetchOptions?: CastboardFetchOptions
  onRequest?: (info: { method: string; path: string; status: number; ms: number }) => void
  auth?: CastboardAuthLike
  /** 已知能力清单（`/version.endpoints[]`）；`null` = 未探测 */
  capabilities?: readonly string[] | null
}

export interface CastboardRequestOptions {
  method?: CastboardHttpMethod
  body?: unknown
  query?: Record<string, string | number | boolean | null | undefined>
  /** `request()` 用；默认 `signed` */
  auth?: CastboardAuthMode
  timeoutMs?: number
  /** 调用方已知本次带业务幂等键 → 允许重试（D15） */
  idempotent?: boolean
  headers?: Record<string, string>
}

export interface CastboardRawOptions {
  method?: CastboardHttpMethod
  body?: string | Uint8Array
  query?: Record<string, string | number | boolean | null | undefined>
  auth?: CastboardAuthMode
  timeoutMs?: number
  idempotent?: boolean
  headers?: Record<string, string>
  /** 不加默认超时（大文件 / 流式） */
  noTimeout?: boolean
}

/** 失败的原始描述（尚未包成信封） */
interface AttemptFailure {
  status: number
  code: CastboardErrorCode
  reason: string
  body?: string
  retryable: boolean
}

type AttemptOk = { ok: true; status: number; data: Response }
type AttemptResult = AttemptOk | { ok: false; failure: AttemptFailure }

export class CastboardTransport {
  readonly baseUrl: string
  readonly timeoutMs: number
  readonly maxConcurrency: number
  readonly retries: number
  private readonly auth: CastboardAuthLike | undefined
  private readonly onRequest: CastboardTransportOptions['onRequest']
  private readonly fetchImpl: CastboardFetch
  private readonly ownHandle: ReturnType<typeof createCastboardFetch> | null
  private capabilities: readonly string[] | null
  private disposed = false

  constructor(options: CastboardTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.timeoutMs = Math.max(1, options.timeoutMs ?? CASTBOARD_DEFAULT_TIMEOUT_MS)
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? CASTBOARD_DEFAULT_MAX_CONCURRENCY))
    this.retries = Math.max(0, Math.floor(options.retries ?? CASTBOARD_DEFAULT_RETRIES))
    this.auth = options.auth
    this.onRequest = options.onRequest
    this.capabilities = options.capabilities ?? null

    let raw: CastboardFetch
    if (options.fetchImpl !== undefined) {
      this.ownHandle = null
      raw = options.fetchImpl
    } else {
      const handle = createCastboardFetch({
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
  supports(name: CastboardEndpointName): boolean {
    if (this.capabilities === null) return true
    return this.capabilities.includes(endpointCapabilityKey(name))
  }

  /** 按端点表发 JSON 请求 */
  async call<T>(
    name: CastboardEndpointName,
    params: Record<string, string | number> = {},
    options: Omit<CastboardRequestOptions, 'method' | 'auth'> = {},
  ): Promise<CastboardResult<T>> {
    if (!this.supports(name)) return this.unsupported(name)
    const endpoint = CASTBOARD_ENDPOINTS[name]
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
    name: CastboardEndpointName,
    params: Record<string, string | number> = {},
    options: Omit<CastboardRawOptions, 'method' | 'auth'> = {},
  ): Promise<CastboardResult<Response>> {
    if (!this.supports(name)) return this.unsupported(name)
    const endpoint = CASTBOARD_ENDPOINTS[name]
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
  async request<T>(path: string, options: CastboardRequestOptions = {}): Promise<CastboardResult<T>> {
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
  async raw(path: string, options: CastboardRawOptions = {}): Promise<CastboardResult<Response>> {
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

  private unsupported(name: CastboardEndpointName): CastboardFail {
    castboardLog('warn', 'sdk-unsupported', name)
    return castboardFail({
      status: 0,
      code: 'unsupported',
      reason: `服务端未声明该端点（见 /version 的 endpoints[]）：${name}`,
    })
  }

  /** 占位符替换 + 编码；残留 `{` → `internal_error`（不让字面量打到服务端） */
  private pathOf(path: string, params: Record<string, string | number>): string | CastboardFail {
    let out = path
    for (const [key, value] of Object.entries(params)) {
      out = out.split(`{${key}}`).join(seg(value))
    }
    if (out.includes('{') || out.includes('}')) {
      return castboardFail({
        status: 0,
        code: 'internal_error',
        reason: `端点路径占位符没替换完：${out}（SDK 内部错误，请报 bug）`,
        path: out,
      })
    }
    return out
  }

  private buildUrl(path: string, query: CastboardRequestOptions['query']): string {
    const suffix = path.startsWith('/') ? path : `/${path}`
    const url = new URL(`${this.baseUrl}${suffix}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  private async authHeaders(
    mode: CastboardAuthMode,
  ): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; fail: CastboardFail }> {
    if (mode === 'public') return { ok: true, headers: {} }
    const auth = this.auth
    if (auth === undefined) {
      if (mode === 'local') return { ok: true, headers: {} }
      return { ok: false, fail: this.loginRequired('需要先登录：client 还没有会话') }
    }
    let snapshot: Record<string, string> | null
    try {
      snapshot = await auth.headers()
    } catch (error) {
      if (mode === 'local') return { ok: true, headers: {} }
      return { ok: false, fail: this.authFailure(error) }
    }
    if (snapshot === null) {
      if (mode === 'local') return { ok: true, headers: {} }
      return { ok: false, fail: this.loginRequired('需要先登录：client 还没有会话') }
    }
    if (mode === 'admin') {
      const role = auth.globalRole()
      if (role !== undefined && role !== 'administrator') {
        return {
          ok: false,
          fail: castboardFail({
            status: 403,
            code: 'forbidden',
            reason: `该端点需要 administrator，当前账号 globalRole=${role}`,
          }),
        }
      }
    }
    return { ok: true, headers: snapshot }
  }

  private loginRequired(reason: string): CastboardFail {
    return castboardFail({
      status: 401,
      code: 'login_required',
      reason,
    })
  }

  private authFailure(error: unknown): CastboardFail {
    const authError = error instanceof CastboardAuthError ? error : null
    return castboardFail({
      status: 401,
      code: authError?.code ?? 'auth_refresh_failed',
      reason: `认证交换失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  private async perform(
    path: string,
    options: CastboardRequestOptions | CastboardRawOptions,
  ): Promise<CastboardResult<Response>> {
    const method = options.method ?? 'GET'
    const startedAt = Date.now()
    // Every SDK HTTP interface funnels through here: one request line + one outcome line.
    // Never log headers/body: they may contain tokens or passwords.
    castboardLog('info', 'sdk-request', `${method} ${path}`)
    if (this.disposed) {
      return castboardFail({ status: 0, code: 'internal_error', reason: 'client 已 dispose，不能再发请求' })
    }
    const mode = options.auth ?? 'signed'
    let authResult = await this.authHeaders(mode)
    if (!authResult.ok) {
      castboardLog('warn', 'sdk-auth-failed', `${method} ${path} ${mode} ${authResult.fail.code}`)
      return authResult.fail
    }

    const url = this.buildUrl(path, options.query)
    const body = 'body' in options ? options.body : undefined
    const noTimeout = 'noTimeout' in options ? options.noTimeout === true : false
    const plainHeaders: Record<string, string> = { ...(options.headers ?? {}) }
    let payload: string | Uint8Array | undefined
    if (body !== undefined) {
      if (typeof body === 'string' || body instanceof Uint8Array) {
        payload = body
      } else {
        plainHeaders['content-type'] = 'application/json'
        try {
          payload = JSON.stringify(body)
        } catch (err) {
          return castboardFail({
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
    let lastFail: CastboardFail | null = null

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        // A 5xx retry can happen after an in-attempt auth refresh; always take the
        // latest cached headers instead of reusing the pre-refresh snapshot.
        authResult = await this.authHeaders(mode)
        if (!authResult.ok) return authResult.fail
      }
      const outcome = await this.attempt(url, {
        method,
        headers: { ...authResult.headers, ...plainHeaders },
        plainHeaders,
        ...(payload === undefined ? {} : { body: payload }),
        ...(noTimeout ? { noTimeout: true } : { timeoutMs: options.timeoutMs ?? this.timeoutMs }),
      }, mode !== 'public')
      if (outcome.ok) {
        castboardLog('info', 'sdk-response', `${method} ${path} ${outcome.status} ${Date.now() - startedAt}ms`)
        return castboardOk(outcome.status, outcome.data)
      }

      const failure = outcome.failure
      lastFail = castboardFail({
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

    const failure = lastFail ?? castboardFail({
      status: 0,
      code: 'internal_error',
      reason: '请求未发出（SDK 内部错误）',
      method,
      path,
    })
    castboardLog(
      'warn',
      'sdk-error',
      `${method} ${path} ${failure.status} ${failure.code} ${Date.now() - startedAt}ms`,
    )
    return failure
  }

  private async attempt(
    url: string,
    init: {
      method: string
      headers: Record<string, string>
      plainHeaders?: Record<string, string>
      body?: string | Uint8Array
      timeoutMs?: number
      noTimeout?: boolean
    },
    allowAuthRetry = false,
  ): Promise<AttemptResult> {
    const started = Date.now()
    const requestInit: CastboardFetchInit = {
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
      body: text.length > CASTBOARD_BODY_LIMIT ? `${text.slice(0, CASTBOARD_BODY_LIMIT)}…` : text,
      retryable: response.status === 429 || response.status >= 500,
    }

    if (allowAuthRetry && (response.status === 401 || (response.status === 403 && failure.code === 'account_disabled'))) {
      const retried = await this.handleAuthFailure(failure, url, init)
      if (retried !== null) return retried
    }
    return { ok: false, failure }
  }

  /** 401/403 分支：刷新 headers 后只重试一次。返回 `null` = 交给上层归一。 */
  private async handleAuthFailure(
    failure: AttemptFailure,
    url: string,
    init: {
      method: string
      headers: Record<string, string>
      plainHeaders?: Record<string, string>
      body?: string | Uint8Array
      timeoutMs?: number
      noTimeout?: boolean
    },
  ): Promise<AttemptResult | null> {
    if (failure.code === 'account_disabled') {
      return {
        ok: false,
        failure: {
          ...failure,
          code: 'login_required',
          reason: `账号已被禁用，恢复后可直接使用：${failure.reason}`,
        },
      }
    }
    if (failure.status !== 401 || this.auth === undefined) return null

    try {
      await this.auth.refresh()
      const headers = await this.auth.headers()
      if (headers === null) {
        return {
          ok: false,
          failure: { ...failure, code: 'login_required', reason: '认证已失效，需要重新登录' },
        }
      }
      const retried = await this.attempt(url, {
        ...init,
        headers: { ...headers, ...(init.plainHeaders ?? {}) },
      }, false)
      if (!retried.ok && retried.failure.status === 401) {
        this.auth.onUnauthorized()
        return {
          ok: false,
          failure: {
            ...retried.failure,
            code: 'login_required',
            reason: `重新认证后仍被拒绝，需要重新登录：${retried.failure.reason}`,
          },
        }
      }
      return retried
    } catch (error) {
      const authError = error instanceof CastboardAuthError ? error : null
      return {
        ok: false,
        failure: {
          ...failure,
          code: authError?.code ?? 'auth_refresh_failed',
          reason: `重新认证失败：${error instanceof Error ? error.message : String(error)}`,
        },
      }
    }
  }

  /** 直连 fetch（无默认超时；TLS/代理句柄下走 `fetchDirect`） */
  private async fetchDirect(url: string, init: CastboardFetchInit): Promise<Response> {
    if (this.ownHandle !== null) return this.ownHandle.fetchDirect(url, init)
    return this.fetchImpl(url, init)
  }

  private async parseJson<T>(response: Response, method: string, path: string): Promise<CastboardResult<T>> {
    void method
    void path
    if (response.status === 204) return castboardOk(204, undefined as T)
    const text = await safeText(response)
    if (text.trim() === '') return castboardOk(response.status, undefined as T)
    try {
      return castboardOk(response.status, JSON.parse(text) as T)
    } catch {
      // 非 JSON 但 2xx：把文本原样给调用方（网关 HTML 之类）
      return castboardOk(response.status, text as unknown as T)
    }
  }
}

function parseErrorBody(text: string): { code?: CastboardErrorCode; message?: string } {
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text) as { code?: unknown; message?: unknown }
    return {
      ...(typeof parsed.code === 'string' ? { code: parsed.code as CastboardErrorCode } : {}),
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
