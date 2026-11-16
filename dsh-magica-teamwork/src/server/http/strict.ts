/** 严格请求体：出现未声明字段 → `400 unknown_field`（api-design §0.4.1） */
import { errors } from '../errors.js'

/** 身份字段在任何请求体里都不允许出现 */
export const IDENTITY_FIELDS = ['assigner', 'author', 'createdBy', 'id', 'createdAt', 'updatedAt'] as const

export function assertNoUnknownFields(body: unknown, allowed: readonly string[], { allowIdentity = false } = {}): void {
  if (body === undefined || body === null) return
  if (typeof body !== 'object' || Array.isArray(body)) throw errors.invalidRequest('请求体必须是 JSON 对象')
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (!allowedSet.has(key)) throw errors.unknownField(key)
    if (!allowIdentity && (IDENTITY_FIELDS as readonly string[]).includes(key)) throw errors.unknownField(key)
  }
}

/** 数组型请求体（批量端点） */
export function assertArrayBody(body: unknown, maxItems: number, what = '请求体'): unknown[] {
  if (!Array.isArray(body)) throw errors.invalidRequest(`${what}必须是 JSON 数组`)
  if (body.length > maxItems) throw errors.invalidRequest(`${what}最多 ${maxItems} 条，收到 ${body.length}`)
  return body
}

export function str(v: unknown, field: string, { required = false, max = 0, min = 0 } = {}): string | undefined {
  if (v === undefined || v === null) {
    if (required) throw errors.invalidRequest(`缺少 ${field}`)
    return undefined
  }
  if (typeof v !== 'string') throw errors.invalidRequest(`${field} 必须是字符串`)
  const t = v
  if (min > 0 && t.length < min) throw errors.invalidRequest(`${field} 至少 ${min} 个字符`)
  if (max > 0 && t.length > max) throw errors.invalidRequest(`${field} 最多 ${max} 个字符`)
  return t
}

export function int(v: unknown, field: string, { required = false, min, max }: { required?: boolean; min?: number; max?: number } = {}): number | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw errors.invalidRequest(`缺少 ${field}`)
    return undefined
  }
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n)) throw errors.invalidRequest(`${field} 必须是整数`)
  if (min !== undefined && n < min) throw errors.invalidRequest(`${field} 不能小于 ${min}`)
  if (max !== undefined && n > max) throw errors.invalidRequest(`${field} 不能大于 ${max}`)
  return n
}

export function oneOfStr<T extends string>(v: unknown, field: string, allowed: readonly T[], fallback?: T): T | undefined {
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw errors.invalidRequest(`${field} 只能是 ${allowed.join(' / ')}`, { field })
  }
  return v as T
}
