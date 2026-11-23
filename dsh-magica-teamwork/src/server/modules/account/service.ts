/**
 * 账号业务层（A1–A6）。
 *
 * 硬要求（写错就是安全洞）：
 *  - 登录按 `account_id` 取行，**绝不** `WHERE account_token = ?`
 *  - 账号不存在也走一次等量哈希 + 同样的 300ms 延迟
 *  - `timingSafeEqual` 比较
 *  - 失败统一 `invalid_credentials`
 */
import type { DatabaseSync } from 'node:sqlite'
import { errors, nowIso } from '../../errors.js'
import {
  DUMMY_TOKEN,
  checkAccountId,
  checkPasswordPolicy,
  decodePasswordField,
  deriveAccountToken,
  describePasswordProblem,
  timingSafeHexEqual,
} from '../../crypto/password.js'
import { AccountMapper, toAccountVo, type AccountRow, type AccountVo, type GlobalRole } from './mapper.js'
import type { AuthCache } from '../../auth/cache.js'
import type { CurrentUser } from '../../auth/guard.js'

export interface AuthSessionVo {
  account: AccountVo
  accountToken: string
  ttlSeconds: number
}

export interface AccountServiceDeps {
  db: DatabaseSync
  ttlSeconds: number
  registration: 'open' | 'closed'
  authCache: AuthCache
  /** 失败延迟（测试里设为 0） */
  failureDelayMs?: number
  now?: () => number
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

export class AccountService {
  private readonly mapper: AccountMapper
  private readonly delayMs: number
  private readonly now: () => number

  constructor(private readonly deps: AccountServiceDeps) {
    this.mapper = new AccountMapper(deps.db)
    this.delayMs = deps.failureDelayMs ?? 300
    this.now = deps.now ?? (() => Date.now())
  }

  /** A1 注册（注册即登录） */
  async register(input: Record<string, unknown>): Promise<AuthSessionVo> {
    if (this.deps.registration === 'closed') throw errors.registrationClosed()

    const accountId = this.requireAccountId(input.accountId)
    const plain = this.requirePassword(input.password)
    const displayName = this.normalizeDisplayName(input.displayName)

    // 已存在？
    if (this.mapper.findByAccountId(accountId)) throw errors.accountExists()

    const token = deriveAccountToken(accountId, plain)
    const at = nowIso()
    this.deps.db.exec('BEGIN IMMEDIATE')
    let row: AccountRow
    try {
      if (this.mapper.findByAccountId(accountId)) throw errors.accountExists()
      row = this.mapper.insertFirstAware(accountId, displayName, token, at)
      this.deps.db.exec('COMMIT')
    } catch (err) {
      this.deps.db.exec('ROLLBACK')
      // UNIQUE 冲突并发兜底
      if (String(err).includes('UNIQUE')) throw errors.accountExists()
      throw err
    }

    return { account: toAccountVo(row), accountToken: row.accountToken, ttlSeconds: this.deps.ttlSeconds }
  }

  /** A2 登录 */
  async login(input: Record<string, unknown>): Promise<AuthSessionVo> {
    const accountId = typeof input.accountId === 'string' ? input.accountId : ''
    const decoded = decodePasswordField(input.password)

    const row = accountId ? this.mapper.findByAccountId(accountId) : undefined
    const stored = row?.accountToken ?? DUMMY_TOKEN
    const plain = decoded.ok ? decoded.plain! : ''
    const computed = deriveAccountToken(row?.accountId ?? (accountId || 'dummy'), plain)
    const ok = timingSafeHexEqual(stored, computed)

    if (!row || !decoded.ok || !ok) {
      await sleep(this.delayMs)
      throw errors.invalidCredentials()
    }
    if (row.status !== 'active') throw errors.accountDisabled()

    // 写失败不影响登录
    try {
      this.mapper.touchLastLogin(row.accountId, nowIso())
    } catch {
      /* 审计字段，失败只记日志（此处无 logger，交给上层统一记） */
    }
    const fresh = this.mapper.findByAccountId(row.accountId) ?? row
    return { account: toAccountVo(fresh), accountToken: fresh.accountToken, ttlSeconds: this.deps.ttlSeconds }
  }

  /** A3 当前账号（token 已由 guard 校验） */
  me(user: CurrentUser): { account: AccountVo } {
    const row = this.mapper.findByAccountId(user.accountId)
    if (!row) throw errors.unauthorized()
    return { account: toAccountVo(row) }
  }

  /** A4 登出：纯语义，服务端只清缓存 */
  logout(token: string): void {
    this.deps.authCache.invalidateToken(token)
  }

  /** A5 改密码（返回新密钥，避免客户端再登录一次） */
  async changePassword(
    user: CurrentUser,
    input: Record<string, unknown>,
  ): Promise<{ accountToken: string; ttlSeconds: number }> {
    const row = this.mapper.findByAccountId(user.accountId)
    if (!row) throw errors.unauthorized()

    const oldDecoded = decodePasswordField(input.oldPassword)
    const oldPlain = oldDecoded.ok ? oldDecoded.plain! : ''
    const matched = timingSafeHexEqual(row.accountToken, deriveAccountToken(row.accountId, oldPlain))
    if (!oldDecoded.ok || !matched) {
      await sleep(this.delayMs)
      throw errors.invalidCredentials()
    }

    const newPlain = this.requirePassword(input.newPassword)
    if (newPlain === oldPlain) throw errors.samePassword()

    const token = deriveAccountToken(row.accountId, newPlain)
    this.mapper.updateToken(row.accountId, token, nowIso())
    // 签名密钥变了 → 该账号所有缓存项立即失效
    this.deps.authCache.invalidateAccount(row.accountId)
    return { accountToken: token, ttlSeconds: this.deps.ttlSeconds }
  }

  /** A6 查账号是否存在（administrator） */
  lookup(accountId: unknown): { exists: boolean; account: AccountVo | null } {
    if (typeof accountId !== 'string' || accountId.length === 0) throw errors.invalidRequest('缺少 accountId')
    const row = this.mapper.findByAccountId(accountId)
    return row ? { exists: true, account: toAccountVo(row) } : { exists: false, account: null }
  }

  /** M5 管理员重置密码 */
  adminResetPassword(accountId: string, newPassword: unknown): void {
    const row = this.mapper.findByAccountId(accountId)
    if (!row) throw errors.accountNotFound(accountId)
    const plain = this.requirePassword(newPassword)
    this.mapper.updateToken(row.accountId, deriveAccountToken(row.accountId, plain), nowIso())
    this.deps.authCache.invalidateAccount(row.accountId)
  }

  /** M4 改全局角色 */
  setRole(accountId: string, role: unknown): AccountVo {
    const row = this.mapper.findByAccountId(accountId)
    if (!row) throw errors.accountNotFound(accountId)
    if (role !== 'administrator' && role !== 'leader' && role !== 'user') {
      throw errors.invalidRequest('role 只能是 administrator / leader / user')
    }
    const next = role as GlobalRole
    if (row.globalRole === 'administrator' && next !== 'administrator' && this.mapper.countByRole('administrator') <= 1) {
      throw errors.lastAdministrator()
    }
    this.mapper.updateRole(row.accountId, next, nowIso())
    this.deps.authCache.invalidateAccount(row.accountId)
    const fresh = this.mapper.findByAccountId(row.accountId)!
    return toAccountVo(fresh)
  }

  /** M6 账号列表 */
  list(q: unknown, pageNum: unknown, pageSize: unknown): { total: number; pageNum: number; pageSize: number; items: AccountVo[] } {
    const pn = normalizePage(pageNum)
    const ps = normalizePageSize(pageSize)
    const keyword = typeof q === 'string' && q.trim() ? q.trim() : null
    const { total, items } = this.mapper.list(keyword, pn, ps)
    return { total, pageNum: pn, pageSize: ps, items: items.map(toAccountVo) }
  }

  // ── 校验辅助 ────────────────────────────────────────────────
  private requireAccountId(v: unknown): string {
    const problem = checkAccountId(v)
    if (problem) throw errors.invalidAccountId(problem)
    return v as string
  }

  private requirePassword(v: unknown): string {
    const decoded = decodePasswordField(v)
    if (!decoded.ok) throw errors.invalidPasswordEncoding()
    const problem = checkPasswordPolicy(decoded.plain!)
    if (problem === 'weak') throw errors.weakPassword()
    if (problem) throw errors.invalidPassword(describePasswordProblem(problem))
    return decoded.plain!
  }

  private normalizeDisplayName(v: unknown): string | null {
    if (v === undefined || v === null) return null
    if (typeof v !== 'string') throw errors.invalidRequest('displayName 必须是字符串')
    const trimmed = v.trim()
    if (trimmed.length === 0) return null
    if (trimmed.length > 64) throw errors.invalidRequest('displayName 最多 64 个字符')
    return trimmed
  }
}

export function normalizePage(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.floor(n)
}

export function normalizePageSize(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 1) return 20
  return Math.min(200, Math.floor(n))
}
