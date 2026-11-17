/**
 * 进站 HTTP 路由助手：响应写入、同源围栏、读体、query、两级包装器。
 *
 * 为什么需要它：`ctx.webServer.register({ kind, path, handler })` 只给裸 `(req, res)`，
 * 每个插件都会重复抄同一套方法判定 / content-type / 体积上限 / JSON 解析 / 错误信封 / headersSent 守卫。
 *
 * 闸门顺序（不可调整，见 `docs/design/01-core-utils.zh.md` §3.3）：
 * 方法门 → 信任围栏 → 读体闸门 → 匹配 → 业务 → onError。
 *
 * @module dsh-magica-spellbook/core/router
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** 统一错误：闸门只抛它，响应形状由 `onError` 决定。 */
export class HttpRouteError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HttpRouteError'
    this.status = status
    this.code = code
  }
}

/** 写响应（唯一写响应点；已发头则静默返回）。 */
export function sendResponse(
  response: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent) return
  response.writeHead(status, headers)
  response.end(body)
}

/** 写 JSON（带 `cache-control: no-store`）。 */
export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  sendResponse(response, status, JSON.stringify(payload), {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
}

/** 写文本（带 `cache-control: no-store`）。 */
export function sendText(
  response: ServerResponse,
  status: number,
  text: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  sendResponse(response, status, text, { 'cache-control': 'no-store', 'content-type': contentType })
}

/** 405 + `Allow` 头。 */
export function sendMethodNotAllowed(response: ServerResponse, allow: string): void {
  sendResponse(response, 405, '', { allow })
}

/** 严格同源判断：`Origin` 缺失即拒；比较**含端口**的 host。 */
export function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** 读 JSON 请求体；超限抛 `request body too large`。 */
export async function readJsonBody(request: IncomingMessage, maxBytes = 8192): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (total === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function safeDecode(text: string, plusAsSpace = false): string | null {
  try {
    // `+` 只在 query 里表示空格；路径参数里的 `+` 是加号本身（diff C20）
    return decodeURIComponent(plusAsSpace ? text.replace(/\+/g, ' ') : text)
  } catch {
    return null
  }
}

/**
 * 取 query 参数（手写解析：非法 URL 不抛错；**畸形 pair 直接跳过**）。
 *
 * 真机回归：`?a=%E0%A4&a=2` 以前会把 `%E0%A4`（解码失败）当值返回，
 * 正确行为是丢掉这个 pair、返回下一条能解码的 `2`。
 */
export function queryOf(request: IncomingMessage, key: string): string | null {
  const url = request.url ?? ''
  const index = url.indexOf('?')
  if (index < 0) return null
  for (const pair of url.slice(index + 1).split('&')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    const rawKey = eq < 0 ? pair : pair.slice(0, eq)
    if (safeDecode(rawKey, true) !== key) continue
    if (eq < 0) return ''
    // query 的 value 也把 `+` 当空格（form-encoded 约定）；只有路径参数才保留加号
    const value = safeDecode(pair.slice(eq + 1), true)
    if (value === null) continue
    return value
  }
  return null
}

/** 单条路由的上下文（不含 response）。 */
export interface JsonRouteContext {
  request: IncomingMessage
  query(key: string): string | null
}

/** 单条路由的返回值：任意值走 200；`{ status, body }` 走指定状态码。 */
export type JsonRouteResult = unknown | { status: number; body?: unknown }

/** 单条路由选项（恒严格同源）。 */
export interface JsonRouteOptions {
  method: string
  maxBytes?: number
  handler(body: unknown, context: JsonRouteContext): Promise<JsonRouteResult> | JsonRouteResult
}

function isStatusEnvelope(value: unknown): value is { status: number; body?: unknown } {
  return typeof value === 'object' && value !== null && typeof (value as { status?: unknown }).status === 'number'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 单条路由包装器：方法门 → 同源 → 读体 → 业务 → 兜底。 */
export function jsonRoute(
  options: JsonRouteOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const method = options.method.toUpperCase()
  const needsBody = method !== 'GET' && method !== 'HEAD'
  return async (request, response) => {
    if ((request.method ?? '').toUpperCase() !== method) {
      sendMethodNotAllowed(response, method)
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { error: 'forbidden', message: 'same-origin request required' })
      return
    }
    let body: unknown
    if (needsBody) {
      try {
        body = await readJsonBody(request, options.maxBytes)
      } catch (error) {
        sendJson(response, 400, { error: 'bad request', message: messageOf(error) })
        return
      }
    }
    try {
      const result = await options.handler(body, { request, query: (key) => queryOf(request, key) })
      if (isStatusEnvelope(result)) {
        sendJson(response, result.status, result.body)
        return
      }
      sendJson(response, 200, result)
    } catch (error) {
      sendJson(response, 500, { error: 'internal', message: messageOf(error) })
    }
  }
}

/** 表驱动路由器支持的方法。 */
export type JsonRouterMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'

/** 信任档位。 */
export type JsonRouterTrust = 'strict' | 'browser'

/** 入站请求是否可信（`browser` 档放行不带 Origin 的请求）。 */
export function isTrustedInbound(request: IncomingMessage, trust: JsonRouterTrust = 'strict'): boolean {
  const site = request.headers['sec-fetch-site']
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false
  if (trust === 'browser' && request.headers.origin === undefined) return true
  return sameOrigin(request)
}

/**
 * Host 头是不是回环地址（可带端口，IPv6 可带方括号）。
 *
 * 为什么要它：只校验 Origin 挡不住 **DNS rebinding**——攻击者把域名解析到 127.0.0.1 后，
 * 浏览器发出的 `Host` 与 `Origin` 同为 `evil.example`、`Sec-Fetch-Site` 也是 `same-origin`，
 * 三道 old 判定全过。所以 Host 必须**默认**限定为回环（部署在域名后面的场景用 `trustedHosts` 显式放行）。
 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1'
}

/** Host 是否被允许：显式白名单优先，否则必须是回环。 */
export function isTrustedHost(host: string | undefined, trustedHosts: readonly string[] = []): boolean {
  if (typeof host !== 'string' || host === '') return false
  const normalized = host.toLowerCase()
  if (trustedHosts.some((entry) => entry.toLowerCase() === normalized)) return true
  return isLoopbackHost(normalized)
}

/** 表驱动路由器的 handler 上下文（带 response：handler 自己写响应）。 */
export interface JsonRouterContext {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly params: Readonly<Record<string, string>>
  query(key: string): string | null
  readonly body: Readonly<Record<string, unknown>>
}

/** 一行路由。 */
export interface JsonRouterRoute {
  readonly method: JsonRouterMethod
  readonly path: string
  handler(context: JsonRouterContext): Promise<void> | void
}

/** 路由器选项。 */
export interface JsonRouterOptions {
  readonly prefix: string
  readonly routes: readonly JsonRouterRoute[]
  readonly trust?: JsonRouterTrust
  readonly maxBytes?: number
  readonly requireJsonContentType?: boolean
  readonly allow?: string
  readonly trustedHosts?: readonly string[]
  onError?(response: ServerResponse, error: unknown): void
  onNotFound?(response: ServerResponse): void
}

const METHOD_ORDER: readonly JsonRouterMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH'])
const PARAM_PREFIX = ':'

interface CompiledRoute {
  readonly method: string
  readonly segments: readonly string[]
  readonly route: JsonRouterRoute
}

function defaultRouterOnError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) return
  if (error instanceof HttpRouteError) {
    sendJson(response, error.status, { error: error.code, message: error.message })
    return
  }
  sendJson(response, 500, { error: 'internal', message: messageOf(error) })
}

async function readMutationBody(
  request: IncomingMessage,
  maxBytes: number,
  requireJsonContentType: boolean,
): Promise<Record<string, unknown>> {
  if (requireJsonContentType) {
    const contentType = request.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
      throw new HttpRouteError(415, 'invalid_input', 'content-type must be application/json')
    }
  }
  const declared = request.headers['content-length']
  if (typeof declared === 'string') {
    const size = Number(declared)
    if (Number.isFinite(size) && size > maxBytes) {
      throw new HttpRouteError(413, 'invalid_input', `request body exceeds ${maxBytes} bytes`)
    }
  }
  let parsed: unknown
  try {
    parsed = await readJsonBody(request, maxBytes)
  } catch {
    throw new HttpRouteError(400, 'invalid_input', 'body is not valid JSON or too large')
  }
  if (parsed === undefined) return {}
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpRouteError(400, 'invalid_input', 'body is not a JSON object')
  }
  return parsed as Record<string, unknown>
}

function splitRoutePath(path: string): readonly string[] {
  return path.split('/').filter((segment) => segment !== '')
}

/** 去掉 query 与 hash：路径匹配只看 pathname（真机 bug：带 `?id=` 的 GET 曾落到空体 404）。 */
function pathnameOf(url: string): string {
  const hash = url.indexOf('#')
  const withoutHash = hash < 0 ? url : url.slice(0, hash)
  const query = withoutHash.indexOf('?')
  return query < 0 ? withoutHash : withoutHash.slice(0, query)
}

function segmentsAfterPrefix(pathname: string, prefix: string): readonly string[] | undefined {
  const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  if (normalized === '') return splitRoutePath(pathname)
  if (pathname === normalized) return []
  if (!pathname.startsWith(`${normalized}/`)) return undefined
  return splitRoutePath(pathname.slice(normalized.length))
}

function matchRoute(
  compiled: readonly CompiledRoute[],
  method: string,
  segments: readonly string[],
): { route: JsonRouterRoute; params: Record<string, string> } | undefined {
  for (const entry of compiled) {
    if (entry.method !== method) continue
    if (entry.segments.length !== segments.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let index = 0; index < entry.segments.length; index += 1) {
      const expected = entry.segments[index]
      const actual = segments[index]
      if (expected === undefined || actual === undefined) {
        ok = false
        break
      }
      if (expected.startsWith(PARAM_PREFIX)) {
        if (actual === '') {
          ok = false
          break
        }
        // 路径参数解码失败：**保留原文**（c.md:433 / `decodePathSegment` 的语义）。
        // 早前改成"整条不匹配"是错的口径：形如 `/x/a%2Fb` 的合法编码、
        // 以及 `%ZZ` 这类脏串都应当照原样落到 params，由 handler 自己决定怎么处理。
        const decoded = safeDecode(actual, false)
        params[expected.slice(PARAM_PREFIX.length)] = decoded ?? actual
        continue
      }
      if (expected !== actual) {
        ok = false
        break
      }
    }
    if (ok) return { route: entry.route, params }
  }
  return undefined
}

/**
 * 造一个可直接交给 `webServer.register({ kind: 'prefix', path, handler })` 的处理器。
 * @param options - 前缀、路由表、信任档位等。
 */
export function createJsonRouter(
  options: JsonRouterOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const trust = options.trust ?? 'strict'
  const maxBytes = options.maxBytes ?? 8192
  const requireJsonContentType = options.requireJsonContentType ?? true
  const onError = options.onError ?? defaultRouterOnError
  const compiled: CompiledRoute[] = options.routes.map((route) => ({
    method: route.method.toUpperCase(),
    segments: splitRoutePath(route.path),
    route,
  }))
  const allow =
    options.allow ??
    [...new Set(compiled.map((entry) => entry.method))]
      .sort(
        (a, b) =>
          METHOD_ORDER.indexOf(a as JsonRouterMethod) - METHOD_ORDER.indexOf(b as JsonRouterMethod),
      )
      .join(', ')

  return async (request, response) => {
    try {
      const method = (request.method ?? 'GET').toUpperCase()
      // 1. 方法门（表级：不泄漏路径是否存在）
      if (!compiled.some((entry) => entry.method === method)) {
        sendMethodNotAllowed(response, allow)
        return
      }
      // 2. 信任围栏：Host 默认必须是回环（挡 DNS rebinding），再判 Origin / Sec-Fetch-Site
      if (!isTrustedHost(request.headers.host, options.trustedHosts)) {
        throw new HttpRouteError(403, 'forbidden', 'untrusted host')
      }
      if (!isTrustedInbound(request, trust)) {
        throw new HttpRouteError(403, 'forbidden', 'cross-origin request rejected')
      }
      // 3. 读体闸门
      let body: Record<string, unknown> = {}
      if (BODY_METHODS.has(method)) {
        body = await readMutationBody(request, maxBytes, requireJsonContentType)
      }
      // 4. 匹配（只按 pathname：query/hash 不参与路径段）
      const rest = segmentsAfterPrefix(pathnameOf(request.url ?? ''), options.prefix)
      const matched = rest === undefined ? undefined : matchRoute(compiled, method, rest)
      if (matched === undefined) {
        if (options.onNotFound !== undefined) {
          options.onNotFound(response)
          return
        }
        sendResponse(response, 404, '')
        return
      }
      // 5. 业务
      await matched.route.handler({
        request,
        response,
        params: matched.params,
        query: (key) => queryOf(request, key),
        body,
      })
    } catch (error) {
      // 6. 兜底
      onError(response, error)
    }
  }
}
