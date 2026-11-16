/**
 * 内网出站 fetch：scoped TLS + 代理感知 + 超时 + 并发限制。
 *
 * 为什么不用 `ctx.web.fetch`：官方 provider 只放行**公网单播**地址（SSRF 防护），
 * 企业内网自签证书 / 内网域名 / 必须走代理的端点全部连不上。
 *
 * `undici` 必须**惰性**加载（三层：子路径解耦 -> 依赖声明 -> `createRequire` 推到调用期）。
 * 本包把 host 打成单文件 `lib/index.js`，所以第三层最关键：`undici` 在构建里必须是 external。
 *
 * @module dsh-magica-spellbook/core/net
 */

import { createRequire } from 'node:module'
import { Agent as HttpsAgent } from 'node:https'
import type { Agent } from 'undici'

type UndiciModule = typeof import('undici')

/** 请求选项（undici `fetch` 的子集；不给 redirect / dispatcher / duplex）。 */
export interface ProxyFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string | Buffer
  signal?: AbortSignal
  timeoutMs?: number
}

/** 构造选项。 */
export interface ProxyFetchOptions {
  /** 默认超时；缺省 30 000 ms。 */
  defaultTimeoutMs?: number
  /** 是否放宽 TLS 校验（企业内网自签）；缺省 `true`。 */
  insecure?: boolean
}

/** 出站句柄。 */
export interface ProxyFetchHandle {
  fetch(url: string, init?: ProxyFetchInit): Promise<Response>
  configuredProxy(): string | null
  insecureFetch(url: string, init?: ProxyFetchInit): Promise<Response>
  readonly insecureAgent: Agent
  readonly insecureHttpsAgent: HttpsAgent
  dispose(): Promise<void>
}

let cachedUndici: UndiciModule | null | undefined

function undici(): UndiciModule {
  if (cachedUndici !== undefined) {
    if (cachedUndici === null) throw new Error('proxy-fetch: optional dependency "undici" is not installed')
    return cachedUndici
  }
  try {
    const require = createRequire(import.meta.url)
    cachedUndici = require('undici') as UndiciModule
    return cachedUndici
  } catch {
    cachedUndici = null
    throw new Error('proxy-fetch: optional dependency "undici" is not installed')
  }
}

function pick(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  return trimmed.includes('://') ? trimmed : `http://${trimmed}`
}

function proxyFromEnv(): { http: string | null; https: string | null } {
  const env = process.env
  const http = pick(env['http_proxy'] ?? env['HTTP_PROXY'] ?? env['npm_config_proxy'])
  const https = pick(env['https_proxy'] ?? env['HTTPS_PROXY'] ?? env['npm_config_https_proxy']) ?? http
  return { http, https }
}

/**
 * 造一个内网出站句柄（同步）。
 * @param options - 超时与 TLS 策略。
 */
export function createProxyFetch(options: ProxyFetchOptions = {}): ProxyFetchHandle {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000
  const rejectUnauthorized = !(options.insecure ?? true)
  const undiciModule = undici()
  const insecureAgent = new undiciModule.Agent({ connect: { rejectUnauthorized } })
  const insecureHttpsAgent = new HttpsAgent({ rejectUnauthorized })

  let proxyAgent: Agent | undefined
  let disposed = false

  function currentProxy(): string | null {
    // 对外暴露（诊断）仍报"有没有代理"；分档判断在 dispatcherFor 内部做
    const env = proxyFromEnv()
    return env.https ?? env.http
  }

  function dispatcherFor(): Agent {
    // http 与 https 分档（c.md:497-499）：只设 http_proxy 时，http:// 出站要走它，
    // https:// 走直连。早前两档都塞 `.https`，http_proxy 从未被消费。
    const env = proxyFromEnv()
    if (env.http === null && env.https === null) return insecureAgent
    proxyAgent ??= new undiciModule.EnvHttpProxyAgent({
      ...(env.http === null ? {} : { httpProxy: env.http }),
      ...(env.https === null ? {} : { httpsProxy: env.https }),
    }) as unknown as Agent
    return proxyAgent
  }

  async function fetchImpl(
    url: string,
    init: ProxyFetchInit | undefined,
    useTimeout = true,
    direct = false,
  ): Promise<Response> {
    if (disposed) throw new Error('proxy-fetch: handle already disposed')
    // `insecureFetch` 的语义是"**始终直连**"（内网自签证书场景常伴随不可用代理）：
    // 配了 https_proxy 也绝不能把它送进代理，否则语义丢失（C-198 回归）。
    const dispatcher = direct ? insecureAgent : dispatcherFor()
    const signals: AbortSignal[] = []
    if (useTimeout) signals.push(AbortSignal.timeout(init?.timeoutMs ?? defaultTimeoutMs))
    if (init?.signal !== undefined) signals.push(init.signal)
    const signal =
      signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
    const request: Record<string, unknown> = { dispatcher }
    if (init?.method !== undefined) request['method'] = init.method
    if (init?.headers !== undefined) request['headers'] = init.headers
    if (init?.body !== undefined) request['body'] = init.body
    if (signal !== undefined) request['signal'] = signal
    return undiciModule.fetch(
      url,
      request as unknown as Parameters<UndiciModule['fetch']>[1],
    ) as unknown as Promise<Response>
  }

  return {
    fetch: (url, init) => fetchImpl(url, init, true),
    configuredProxy: currentProxy,
    // 流式长响应不能被总超时掐断：该入口不加默认超时，且**始终直连**
    insecureFetch: (url, init) => fetchImpl(url, init, false, true),
    insecureAgent,
    insecureHttpsAgent,
    async dispose() {
      if (disposed) return
      disposed = true
      try {
        await insecureAgent.close()
        if (proxyAgent !== undefined) await proxyAgent.close()
      } catch {
        // 关闭失败不影响后续流程
      }
      try {
        insecureHttpsAgent.destroy()
      } catch {
        // 同上
      }
    },
  }
}

/**
 * 给任意 fetch 加并发上限（不要在单进程里无上限并发：libuv 只有 4 个线程池槽）。
 * @param fetcher - 原始 fetch。
 * @param concurrency - 并发数（向下取整、下限 1）。
 */
export function createLimitedFetch<T>(
  fetcher: (url: string, init?: T) => Promise<Response>,
  concurrency: number,
): (url: string, init?: T) => Promise<Response> {
  const limit = Math.max(1, Math.floor(concurrency))
  let active = 0
  const queue: Array<() => void> = []

  async function acquire(): Promise<void> {
    if (active < limit) {
      active += 1
      return
    }
    await new Promise<void>((resolve) => queue.push(resolve))
    active += 1
  }

  function release(): void {
    active = Math.max(0, active - 1)
    const next = queue.shift()
    if (next !== undefined) next()
  }

  return async (url, init) => {
    await acquire()
    try {
      return await fetcher(url, init)
    } finally {
      release()
    }
  }
}
