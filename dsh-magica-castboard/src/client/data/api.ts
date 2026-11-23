/**
 * 传输层：路径前缀、信封拆包、超时与可读错误。
 *
 * @module dsh-magica-castboard/client/data/api
 */

import { ROUTE_PREFIX } from '../../shared/wire.ts'

/** 接口前缀（与 host 共用同一个常量）。 */
export const BASE = ROUTE_PREFIX

/** 请求失败（带稳定错误码）。 */
export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

const TIMEOUT_MS = 10_000

async function unwrap<T>(pending: Promise<Response>): Promise<T> {
  let response: Response
  try {
    response = await pending
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : ''
    throw new ApiError(
      'network',
      name === 'TimeoutError' || name === 'AbortError' ? '请求超时，正在重试' : '网络不可用，正在重试',
      0,
    )
  }
  const payload = (await response.json().catch(() => null)) as unknown
  if (payload === null) throw new ApiError('network', `HTTP ${String(response.status)}（响应不是 JSON）`, response.status)
  const envelope = payload as { ok?: boolean; value?: unknown; error?: { code?: string; message?: string }; reason?: string; code?: string }
  if (envelope.ok !== true) {
    const message = envelope.error?.message ?? envelope.reason ?? envelope.code ?? `HTTP ${String(response.status)}`
    throw new ApiError(envelope.error?.code ?? envelope.code ?? 'error', message, response.status)
  }
  return envelope.value as T
}

/** GET 一条。 */
export function apiGet<T>(path: string): Promise<T> {
  return unwrap<T>(fetch(`${BASE}${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }))
}

/** POST 一条（无 body 时发 `{}`）。 */
export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return unwrap<T>(fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }))
}
