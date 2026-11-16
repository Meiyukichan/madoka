/**
 * 无状态 JWT（HS256），只用 node:crypto，不引入第三方库。
 *
 * - 签名密钥 = 账号自己的 `accountToken`（= SHA256(accountId:password)）
 * - payload 只放 `{ a, iat, exp }`，**绝不放 accountToken**（payload 是 base64，可读）
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface JwtPayload {
  /** accountId */
  a: string
  /** issued at（毫秒） */
  iat: number
  /** expires at（毫秒） */
  exp: number
}

export interface JwtHeader {
  alg: 'HS256'
  typ: 'JWT'
}

const HEADER: JwtHeader = { alg: 'HS256', typ: 'JWT' }

function b64u(input: Buffer | string): string {
  return Buffer.from(input as never).toString('base64url')
}

function hmac(key: string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

export function signJwt(payload: JwtPayload, key: string): string {
  const head = b64u(JSON.stringify(HEADER))
  const body = b64u(JSON.stringify(payload))
  const sig = hmac(key, `${head}.${body}`).toString('base64url')
  return `${head}.${body}.${sig}`
}

export type VerifyResult =
  | { ok: true; payload: JwtPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'bad_payload' | 'expired' | 'exp_too_long' }

/**
 * 验签 + 结构校验（**不判过期策略之外的东西**；账号状态由调用方查库）。
 *
 * @param maxTtlMs 服务端允许的最长有效期（`exp <= now + maxTtlMs`）
 */
export function verifyJwt(token: string, key: string, now: number, maxTtlMs: number): VerifyResult {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [head, body, sig] = parts as [string, string, string]

  // 头必须是 HS256（不接受 `none`）
  try {
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as Partial<JwtHeader>
    if (header.alg !== 'HS256') return { ok: false, reason: 'malformed' }
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  const expected = hmac(key, `${head}.${body}`)
  const actual = Buffer.from(sig, 'base64url')
  if (actual.length !== expected.length) return { ok: false, reason: 'bad_signature' }
  if (!timingSafeEqual(actual, expected)) return { ok: false, reason: 'bad_signature' }

  let payload: Partial<JwtPayload>
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<JwtPayload>
  } catch {
    return { ok: false, reason: 'bad_payload' }
  }
  if (typeof payload.a !== 'string' || typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
    return { ok: false, reason: 'bad_payload' }
  }
  if (payload.exp <= now) return { ok: false, reason: 'expired' }
  if (payload.exp > now + maxTtlMs) return { ok: false, reason: 'exp_too_long' }

  return { ok: true, payload: payload as JwtPayload }
}
