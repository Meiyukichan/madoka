/** 账号模块的数据访问（唯一碰 SQL 的地方） */
import type { DatabaseSync } from 'node:sqlite'
import { row, rows } from '../../db/rows.js'

export type GlobalRole = 'administrator' | 'leader' | 'user'
export type AccountStatus = 'active' | 'disabled'

export interface AccountRow {
  id: number
  accountId: string
  displayName: string | null
  accountToken: string
  globalRole: GlobalRole
  status: AccountStatus
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

export interface AccountVo {
  accountId: string
  displayName: string | null
  globalRole: GlobalRole
  status: AccountStatus
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

export function toAccountVo(r: AccountRow): AccountVo {
  return {
    accountId: r.accountId,
    displayName: r.displayName,
    globalRole: r.globalRole,
    status: r.status,
    lastLoginAt: r.lastLoginAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

const COLUMNS = `id, account_id AS accountId, display_name AS displayName, account_token AS accountToken,
                 global_role AS globalRole, status, last_login_at AS lastLoginAt,
                 created_at AS createdAt, updated_at AS updatedAt`

export class AccountMapper {
  constructor(private readonly db: DatabaseSync) {}

  findByAccountId(accountId: string): AccountRow | undefined {
    return row<AccountRow>(this.db.prepare(`SELECT ${COLUMNS} FROM dsh_teamwork_account WHERE account_id = ?`).get(accountId))
  }

  count(): number {
    return row<{ c: number }>(this.db.prepare('SELECT count(*) AS c FROM dsh_teamwork_account').get())!.c
  }

  /** 插入账号；**首个账号自动成为 administrator**。调用方负责事务。 */
  insertFirstAware(accountId: string, displayName: string | null, accountToken: string, now: string): AccountRow {
    this.db
      .prepare(
        `INSERT INTO dsh_teamwork_account(account_id, display_name, account_token, global_role, last_login_at)
         SELECT ?, ?, ?, CASE WHEN (SELECT count(*) FROM dsh_teamwork_account) = 0 THEN 'administrator' ELSE 'user' END, ?`,
      )
      .run(accountId, displayName, accountToken, now)
    const created = this.findByAccountId(accountId)
    if (!created) throw new Error('插入账号后读取失败（不应发生）')
    return created
  }

  touchLastLogin(accountId: string, now: string): void {
    this.db.prepare('UPDATE dsh_teamwork_account SET last_login_at = ?, updated_at = ? WHERE account_id = ?').run(now, now, accountId)
  }

  updateToken(accountId: string, accountToken: string, now: string): void {
    this.db.prepare('UPDATE dsh_teamwork_account SET account_token = ?, updated_at = ? WHERE account_id = ?').run(accountToken, now, accountId)
  }

  updateRole(accountId: string, role: GlobalRole, now: string): void {
    this.db.prepare('UPDATE dsh_teamwork_account SET global_role = ?, updated_at = ? WHERE account_id = ?').run(role, now, accountId)
  }

  countByRole(role: GlobalRole): number {
    return row<{ c: number }>(this.db.prepare('SELECT count(*) AS c FROM dsh_teamwork_account WHERE global_role = ?').get(role))!.c
  }

  exists(accountId: string): boolean {
    return row<{ ok: number }>(this.db.prepare('SELECT 1 AS ok FROM dsh_teamwork_account WHERE account_id = ?').get(accountId)) !== undefined
  }

  roleOf(accountId: string): GlobalRole | undefined {
    return row<{ r: GlobalRole }>(this.db.prepare('SELECT global_role AS r FROM dsh_teamwork_account WHERE account_id = ?').get(accountId))?.r
  }

  list(q: string | null, pageNum: number, pageSize: number): { total: number; items: AccountRow[] } {
    const where = q ? `WHERE account_id LIKE ? OR coalesce(display_name,'') LIKE ?` : ''
    const args: unknown[] = q ? [`%${q}%`, `%${q}%`] : []
    const total = row<{ c: number }>(this.db.prepare(`SELECT count(*) AS c FROM dsh_teamwork_account ${where}`).get(...(args as never[])))!.c
    const items = rows<AccountRow>(
      this.db
        .prepare(`SELECT ${COLUMNS} FROM dsh_teamwork_account ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...(args as never[]), pageSize, (pageNum - 1) * pageSize),
    )
    return { total, items }
  }
}
