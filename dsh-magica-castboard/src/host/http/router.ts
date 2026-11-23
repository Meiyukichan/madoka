/**
 * HTTP plumbing for `/castboard`: request gates, result envelopes, error mapping, and a
 * small linear router. Gate order matters. Untrusted Hosts and cross-origin requests
 * are rejected first, then writes without the lease, then read-only views are refreshed
 * before they are served.
 *
 * @module dsh-magica-castboard/host/http
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { CastboardErrorCode, Result } from '../../shared/wire.ts'
import { eventLog } from '../shared/event-log.ts'

export const MAX_BODY_BYTES = 5 * 1024 * 1024

export class HttpFailure extends Error {
  readonly code: CastboardErrorCode
  readonly status: number

  constructor(code: CastboardErrorCode, message: string, status: number) {
    super(message)
    this.name = 'HttpFailure'
    this.code = code
    this.status = status
  }
}

export function sendOk(res: ServerResponse, value: unknown, status = 200): void {
  const payload: Result<unknown> = { ok: true, value }
  sendJson(res, status, payload)
}

export function sendFail(res: ServerResponse, code: CastboardErrorCode, message: string, status: number): void {
  const payload: Result<never> = { ok: false, error: { code, message } }
  sendJson(res, status, payload)
}

// A handler can fail after headers are sent; guard before writing.
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export function toFailure(error: unknown): { code: CastboardErrorCode; status: number; message: string } {
  if (error instanceof HttpFailure) return { code: error.code, status: error.status, message: error.message }
  if (error instanceof Error && error.name === 'ReadOnlyError') {
    return { code: 'forbidden', status: 403, message: error.message }
  }
  // Filesystem and network errno values must never surface as 400s, and their messages may contain absolute paths.
  const code = (error as { code?: unknown } | null | undefined)?.code
  const isErrno = typeof code === 'string' && /^(E[A-Z]+|ERR_[A-Z_]+|UV_)/.test(code)
  const internal = isErrno || error instanceof TypeError || error instanceof RangeError
  if (internal) {
    eventLog('warn', 'internal-failure', error instanceof Error ? error.message : String(error))
    return { code: 'internal', status: 500, message: 'internal error' }
  }
  return { code: 'invalid_input', status: 400, message: error instanceof Error ? error.message : String(error) }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function isTrustedHost(host: string | undefined): boolean {
  if (host === undefined || host === '') return false
  const bare = host.replace(/:\d+$/, '')
  if (LOOPBACK.has(bare)) return true
  const trusted = (process.env.DSH_CASTBOARD_TRUSTED_HOSTS ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
  return trusted.some(entry => entry === bare || entry === host)
}

export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  params: Readonly<Record<string, string>>
  query: URLSearchParams
  body: unknown
  url: URL
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  handler: (context: RouteContext) => Promise<unknown> | unknown
}

export interface RouterOptions {
  // The table can be a getter: the handler registers synchronously while the table becomes ready at runtime.
  routes: readonly Route[] | (() => readonly Route[])
  isWritable: () => boolean
  ownerHint: () => string
  onRead?: () => Promise<void>
  awaitReady?: () => Promise<void>
  // The table uses prefix-relative paths; strip the mount prefix before matching.
  stripPrefix?: string
}

export function createRouter(options: RouterOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      if (!isTrustedHost(req.headers.host)) {
        sendFail(res, 'forbidden', 'untrusted Host header', 403)
        return
      }
      // A browser-supplied Origin must match Host. A malicious page posting directly
      // still sends the real target in Host, so Origin is the only cross-site signal.
      const origin = req.headers.origin
      if (typeof origin === 'string' && origin !== '') {
        // A sandboxed iframe sends Origin: null; treat it as cross-site.
        if (origin === 'null') {
          sendFail(res, 'forbidden', 'cross-origin request rejected', 403)
          return
        }
        const host = (req.headers.host ?? '').toLowerCase()
        let originHost = ''
        try {
          originHost = new URL(origin).host.toLowerCase()
        } catch {
          originHost = ''
        }
        if (originHost === '' || originHost !== host) {
          sendFail(res, 'forbidden', 'cross-origin request rejected', 403)
          return
        }
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      const isRead = req.method === 'GET' || req.method === 'HEAD'
      if (!isRead && !options.isWritable()) {
        sendFail(res, 'forbidden', `read-only: ${options.ownerHint()}`, 403)
        return
      }
      if (isRead) {
        try {
          await options.onRead?.()
        } catch (error) {
          eventLog('warn', 'readonly-sync-failed', error instanceof Error ? error.message : String(error))
        }
      }

      await options.awaitReady?.()
      const table = typeof options.routes === 'function' ? options.routes() : options.routes
      const prefix = options.stripPrefix ?? ''
      const relative = prefix !== '' && url.pathname.startsWith(prefix)
        ? (url.pathname.slice(prefix.length) || '/')
        : url.pathname
      const matched = matchRoute(table, req.method ?? 'GET', relative)
      if (matched === undefined) {

        const allowed = table.filter(route => matchPath(route.path, relative) !== undefined)
        if (allowed.length > 0) {
          res.setHeader('allow', [...new Set(allowed.map(route => route.method))].join(', '))
          sendFail(res, 'invalid_input', 'method not allowed', 405)
          return
        }
        res.writeHead(404).end()
        return
      }

      const body = isRead ? undefined : await readJsonBody(req)
      const value = await matched.route.handler({
        req,
        res,
        params: matched.params,
        query: url.searchParams,
        body,
        url,
      })
      if (value === undefined || res.writableEnded) return
      if (isRouteResult(value)) sendOk(res, value.value, value.status)
      else sendOk(res, value)
    } catch (error) {
      const failure = toFailure(error)
      if (!res.headersSent) sendFail(res, failure.code, failure.message, failure.status)
      else res.end()
    }
  }
}

export interface RouteResult {
  status: number
  value: unknown
}

function isRouteResult(value: unknown): value is RouteResult {
  return typeof value === 'object' && value !== null && 'status' in value && 'value' in value
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = String(req.headers['content-type'] ?? '')
  const declaredLength = Number(req.headers['content-length'] ?? '0')
  const hasBody = Number.isFinite(declaredLength) && declaredLength > 0
  // 415 only applies when a body was sent with the wrong type. Bodyless writes such as
  // `POST /mark-read` must pass: curl -X POST sends no content-type by default.
  if (contentType === '' && !hasBody) return undefined
  if (!contentType.includes('application/json')) {
    throw new HttpFailure('invalid_input', 'content-type must be application/json', 415)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new HttpFailure('invalid_input', 'request body too large', 413)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new HttpFailure('invalid_input', 'invalid JSON body', 400)
  }
}

export function matchPath(pattern: string, pathname: string): Record<string, string> | undefined {
  const patternParts = pattern.split('/').filter(part => part !== '')
  const pathParts = pathname.split('/').filter(part => part !== '')
  if (patternParts.length !== pathParts.length) return undefined
  const params: Record<string, string> = {}
  for (let index = 0; index < patternParts.length; index++) {
    const expected = patternParts[index]
    const actual = pathParts[index]
    if (expected === undefined || actual === undefined) return undefined
    if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual)
    else if (expected !== actual) return undefined
  }
  return params
}

function matchRoute(
  routes: readonly Route[],
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue
    const params = matchPath(route.path, pathname)
    if (params !== undefined) return { route, params }
  }
  return undefined
}
