/**
 * 出站 fetch 门面：**直接使用发布包 `@meiyukichan/dsh-magica-spellbook`** 的 `createProxyFetch` /
 * `createLimitedFetch`（不 vendor、不 link）。
 *
 * ## 为什么还要一层门面（而不是到处直接 import）
 *
 * 1. **TLS 语义相反**：spellbook 的 `insecure` 缺省 `true`（默认放宽证书校验），
 *    本 SDK 的 `rejectUnauthorized` 缺省 `true`（**默认严格**）。直接在调用点翻转容易写错。
 * 2. **最常用路径不该依赖 undici**：spellbook 的 `createProxyFetch` 构造时就要 `require('undici')`
 *    （它总要建 Agent）。而"严格 TLS + 无代理"这条路径用运行时全局 `fetch` 就够，
 *    不该让九成用户为了连 localhost 去装 undici。所以门面按模式分流：
 *      - `global`：严格 TLS + 无代理 → 原生 `fetch`（零依赖）
 *      - `undici`：放宽证书或存在代理 → **spellbook 的句柄**（这才需要 undici）
 * 3. **名称统一**：spellbook 的 `insecureFetch`（无超时 + 始终直连）在这里叫 `fetchDirect`，
 *    给 F2 下载大文件用。
 *
 * 其余一切（代理分档、`AbortSignal.any` 合并、未消费 body、并发闸语义）**完全由发布包负责**。
 *
 * 文档：`docs/design/lattice-sdk-design.zh.md` §11.2
 */

import {
  createLimitedFetch as spellbookLimitedFetch,
  createProxyFetch,
} from '@meiyukichan/dsh-magica-spellbook'

/** 请求选项（undici `fetch` 的子集；不给 redirect / dispatcher / duplex） */
export interface LatticeFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  signal?: AbortSignal
  /** 单次超时（毫秒）；不传用句柄默认值。`fetchDirect` 忽略它 */
  timeoutMs?: number
}

export type LatticeFetch = (url: string, init?: LatticeFetchInit) => Promise<Response>

export interface LatticeProxyConfig {
  http?: string
  https?: string
}

export interface LatticeFetchOptions {
  /** 默认超时；缺省 15 000 ms */
  defaultTimeoutMs?: number
  /**
   * 是否校验证书。**缺省 `true`（严格）**；内网自签服务需显式 `false`。
   * 放宽只作用于本句柄（spellbook 的 Agent），绝不改进程级 `NODE_TLS_REJECT_UNAUTHORIZED`。
   */
  rejectUnauthorized?: boolean
  /** 显式代理；`false` = 强制直连（忽略 `http_proxy`/`https_proxy`）；缺省读环境变量 */
  proxy?: LatticeProxyConfig | false
}

/** `global` = 运行时全局 fetch（零依赖）；`undici` = spellbook 的 Agent/代理句柄 */
export type LatticeFetchMode = 'global' | 'undici'

export interface LatticeFetchHandle {
  fetch: LatticeFetch
  /** 无默认超时 + **始终直连**（大文件 / 流式响应） */
  fetchDirect: LatticeFetch
  configuredProxy(): string | null
  readonly mode: LatticeFetchMode
  dispose(): Promise<void>
}

function pickUrl(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  return trimmed.includes('://') ? trimmed : `http://${trimmed}`
}

function proxyFromEnv(): { http: string | null; https: string | null } {
  const env = process.env
  const http = pickUrl(env['http_proxy'] ?? env['HTTP_PROXY'] ?? env['npm_config_proxy'])
  const https =
    pickUrl(env['https_proxy'] ?? env['HTTPS_PROXY'] ?? env['npm_config_https_proxy']) ?? http
  return { http, https }
}

function mergeSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const list = signals.filter((s): s is AbortSignal => s !== undefined)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  return AbortSignal.any(list)
}

/** 判定这条配置该走哪条路（不构造任何 Agent，纯计算） */
export function netModeOf(options: LatticeFetchOptions = {}): LatticeFetchMode {
  const rejectUnauthorized = options.rejectUnauthorized ?? true
  const explicit = options.proxy
  const env = explicit === false ? { http: null, https: null } : proxyFromEnv()
  const http = explicit !== undefined && explicit !== false ? pickUrl(explicit.http) ?? env.http : env.http
  const https = explicit !== undefined && explicit !== false ? pickUrl(explicit.https) ?? env.https : env.https
  const hasProxy = http !== null || https !== null
  return rejectUnauthorized && !hasProxy ? 'global' : 'undici'
}

/** 走全局 fetch 的直连实现（严格 TLS + 无代理时用；零依赖） */
function globalHandle(options: LatticeFetchOptions): LatticeFetchHandle {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000

  const run = async (
    url: string,
    init: LatticeFetchInit | undefined,
    useTimeout: boolean,
  ): Promise<Response> => {
    const request: RequestInit = {}
    if (init?.method !== undefined) request.method = init.method
    if (init?.headers !== undefined) request.headers = init.headers
    if (init?.body !== undefined) request.body = init.body as never
    const signal = mergeSignals([
      useTimeout ? AbortSignal.timeout(init?.timeoutMs ?? defaultTimeoutMs) : undefined,
      init?.signal,
    ])
    if (signal !== undefined) request.signal = signal
    return fetch(url, request)
  }

  return {
    mode: 'global',
    fetch: (url, init) => run(url, init, true),
    fetchDirect: (url, init) => run(url, init, false),
    configuredProxy: () => null,
    async dispose() {
      /* 全局 fetch 无需回收 */
    },
  }
}

/** 走 spellbook 句柄（放宽 TLS 或存在代理时用；**首次调用**才加载 undici） */
function undiciHandle(options: LatticeFetchOptions): LatticeFetchHandle {
  let handle: ReturnType<typeof createProxyFetch> | null = null
  let configuredProxy: string | null = null
  let disposed = false

  const ensure = (): ReturnType<typeof createProxyFetch> => {
    if (handle !== null) return handle
    handle = createProxyFetch({
      defaultTimeoutMs: options.defaultTimeoutMs ?? 15_000,
      // spellbook 的 `insecure` 是"放宽"，我们的 `rejectUnauthorized` 是"校验"，取反
      insecure: !(options.rejectUnauthorized ?? true),
    })
    configuredProxy = handle.configuredProxy()
    return handle
  }

  const toSpellbookInit = (
    init: LatticeFetchInit | undefined,
  ): { method?: string; headers?: Record<string, string>; body?: string | Buffer; signal?: AbortSignal; timeoutMs?: number } => {
    const out: {
      method?: string
      headers?: Record<string, string>
      body?: string | Buffer
      signal?: AbortSignal
      timeoutMs?: number
    } = {}
    if (init?.method !== undefined) out.method = init.method
    if (init?.headers !== undefined) out.headers = init.headers
    if (init?.body !== undefined) out.body = init.body as string | Buffer
    if (init?.signal !== undefined) out.signal = init.signal
    if (init?.timeoutMs !== undefined) out.timeoutMs = init.timeoutMs
    return out
  }

  return {
    mode: 'undici',
    fetch: (url, init) => {
      if (disposed) return Promise.reject(new Error('lattice-fetch: handle already disposed'))
      return ensure().fetch(url, toSpellbookInit(init))
    },
    fetchDirect: (url, init) => {
      if (disposed) return Promise.reject(new Error('lattice-fetch: handle already disposed'))
      return ensure().insecureFetch(url, toSpellbookInit(init))
    },
    configuredProxy: () => {
      if (configuredProxy === null && handle === null) ensure()
      return configuredProxy
    },
    async dispose() {
      if (disposed) return
      disposed = true
      if (handle !== null) {
        try {
          await handle.dispose()
        } catch {
          /* best-effort */
        }
        handle = null
      }
      configuredProxy = null
    },
  }
}

/**
 * 造一个出站句柄（同步、无 I/O；`global` 模式不 touch undici）。
 *
 * 模式见 `netModeOf()`：严格 TLS 且无代理 → `global`；否则 → `undici`（spellbook 实现）。
 */
export function createLatticeFetch(options: LatticeFetchOptions = {}): LatticeFetchHandle {
  return netModeOf(options) === 'global' ? globalHandle(options) : undiciHandle(options)
}

/**
 * 并发闸：**直接用发布包的实现**（与是否注入自定义 fetch 无关，
 * 闸在 fetch 层加，调用方 `Promise.all` 也压得住）。
 */
export function createLimitedFetch<TInit extends LatticeFetchInit | undefined>(
  fetcher: (url: string, init?: TInit) => Promise<Response>,
  concurrency: number,
): (url: string, init?: TInit) => Promise<Response> {
  return spellbookLimitedFetch(fetcher, concurrency)
}

/** 限并发映射（保序）。组合层批量读回/上传用；spellbook 无此助手，本层自己实现。 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.floor(limit))
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await fn(items[index]!, index)
    }
  })
  await Promise.all(workers)
  return results
}
