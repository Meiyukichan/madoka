/**
 * 密码与账号密钥：
 *  - 传输：请求体里的密码一律 **base64(UTF-8)**（api-design §0.3）
 *  - 存储：`account_token = SHA256(utf8(accountId + ":" + 明文))`，小写 hex 64 字符
 *
 * 注意：哈希只算【解码后的明文】，编码只影响传输。
 */
import { createHash, timingSafeEqual } from 'node:crypto'

const MIN_LEN = 8
const MAX_LEN = 128
const MAX_ENCODED = 512

/** 常见弱口令（命中即拒绝；不做复杂度强制） */
const WEAK = new Set([
  'password', 'passw0rd', '123456789012', 'qwertyuiop12', 'abcdefghijkl',
  'password1234', 'administrator', 'dsh-teamwork', 'letmein12345',
])

export interface DecodeResult {
  ok: boolean
  /** 解码后的明文（ok 时有效） */
  plain?: string
  reason?: 'not_base64' | 'not_utf8' | 'too_long_encoded'
}

/** 宽松 base64 解码：接受标准 / URL-safe / 省略填充 */
export function decodePasswordField(value: unknown): DecodeResult {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, reason: 'not_base64' }
  if (value.length > MAX_ENCODED) return { ok: false, reason: 'too_long_encoded' }

  let normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')
  const pad = normalized.length % 4
  if (pad === 2) normalized += '=='
  else if (pad === 3) normalized += '='
  else if (pad === 1) return { ok: false, reason: 'not_base64' }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return { ok: false, reason: 'not_base64' }

  const buf = Buffer.from(normalized, 'base64')
  // Node 的 base64 解码是宽松的，回编码比对可发现非法输入
  if (buf.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
    return { ok: false, reason: 'not_base64' }
  }
  let plain: string
  try {
    plain = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return { ok: false, reason: 'not_utf8' }
  }
  return { ok: true, plain }
}

export type PasswordProblem = 'too_short' | 'too_long' | 'edge_whitespace' | 'weak' | 'empty'

export function checkPasswordPolicy(plain: string): PasswordProblem | null {
  if (plain.length === 0) return 'empty'
  if (plain.length < MIN_LEN) return 'too_short'
  if (plain.length > MAX_LEN) return 'too_long'
  if (plain.trim() !== plain) return 'edge_whitespace'
  if (WEAK.has(plain.toLowerCase())) return 'weak'
  return null
}

export function describePasswordProblem(p: PasswordProblem): string {
  switch (p) {
    case 'too_short': return `至少 ${MIN_LEN} 个字符`
    case 'too_long': return `最多 ${MAX_LEN} 个字符`
    case 'edge_whitespace': return '首尾不能有空白'
    case 'weak': return '过于常见'
    case 'empty': return '不能为空'
  }
}

/** `account_token = SHA256(utf8(accountId + ":" + 明文))`，小写 hex */
export function deriveAccountToken(accountId: string, plain: string): string {
  return createHash('sha256').update(`${accountId}:${plain}`, 'utf8').digest('hex')
}

/** 常量时间比较两个 hex */
export function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** 账号不存在时也走一次等量计算，避免用响应时间判断账号是否存在 */
export const DUMMY_TOKEN = createHash('sha256').update('dummy:account', 'utf8').digest('hex')

export const ACCOUNT_ID_RE = /^[A-Za-z0-9@_-]{3,64}$/

export function checkAccountId(accountId: unknown): string | null {
  if (typeof accountId !== 'string' || accountId.length === 0) return '不能为空'
  if (!ACCOUNT_ID_RE.test(accountId)) return '只能包含字母、数字、@、_、-，长度 3..64'
  if (accountId.includes(':')) return '不能包含冒号'
  return null
}
