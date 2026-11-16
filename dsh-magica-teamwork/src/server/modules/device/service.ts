/** 设备与工作区肖像（B11–B16） */
import type { DatabaseSync } from 'node:sqlite'
import { errors, nowIso } from '../../errors.js'
import { row, rows } from '../../db/rows.js'
import type { CurrentUser } from '../../auth/guard.js'

export type DeviceStatus = 'active' | 'inactive'
export type WorkspaceType = 'index' | 'portal'

export interface DeviceVo {
  id: number
  accountId: string
  host: string
  port: number
  os: string | null
  status: DeviceStatus
  lastActiveAt: string
  createdAt: string
  updatedAt: string
}

export interface WorkspaceVo {
  id: number
  accountId: string
  instance: string
  workspaceId: string | null
  cwd: string | null
  type: WorkspaceType
  detail: string
  createdAt: string
  updatedAt: string
}

const DEVICE_COLUMNS = `id, account_id AS accountId, host, port, os, status,
  last_active_at AS lastActiveAt, created_at AS createdAt, updated_at AS updatedAt`

const WORKSPACE_COLUMNS = `id, account_id AS accountId, instance, workspace_id AS workspaceId, cwd, type, detail,
  created_at AS createdAt, updated_at AS updatedAt`

export class DeviceService {
  constructor(private readonly deps: { db: DatabaseSync }) {}

  /** B11 全量同步：先全标 inactive，再 upsert 本批为 active */
  sync(user: CurrentUser, devices: unknown): { synced: number; deactivated: number } {
    if (!Array.isArray(devices)) throw errors.invalidRequest('devices 必须是数组')
    if (devices.length > 200) throw errors.invalidRequest('devices 最多 200 条')
    const at = nowIso()
    const db = this.deps.db

    db.exec('BEGIN IMMEDIATE')
    try {
      const before = row<{ c: number }>(
        db.prepare("SELECT count(*) AS c FROM dsh_teamwork_device WHERE account_id = ? AND status = 'active'").get(user.accountId),
      )!.c
      db.prepare("UPDATE dsh_teamwork_device SET status = 'inactive', updated_at = ? WHERE account_id = ? AND status = 'active'").run(at, user.accountId)

      let synced = 0
      for (const raw of devices) {
        if (typeof raw !== 'object' || raw === null) throw errors.invalidRequest('devices 的元素必须是对象')
        const d = raw as Record<string, unknown>
        const host = typeof d.host === 'string' ? d.host.trim() : ''
        if (!host) throw errors.invalidRequest('devices[].host 不能为空')
        if (host.length > 255) throw errors.invalidRequest('devices[].host 最多 255 个字符')
        const port = d.port === undefined || d.port === null ? 0 : Number(d.port)
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw errors.invalidRequest('devices[].port 必须是 0..65535 的整数')
        const os = typeof d.os === 'string' && d.os.trim() ? d.os.trim().slice(0, 64) : null
        db.prepare(
          `INSERT INTO dsh_teamwork_device(account_id, host, port, os, status, last_active_at, updated_at)
           VALUES(?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT(account_id, host, port) DO UPDATE SET
             os = COALESCE(excluded.os, os), status = 'active',
             last_active_at = excluded.last_active_at, updated_at = excluded.updated_at`,
        ).run(user.accountId, host, port, os, at, at)
        synced++
      }
      db.exec('COMMIT')
      return { synced, deactivated: before }
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  /** B12 在线设备（只返 active） */
  listActive(user: CurrentUser, accountIdRaw: unknown): DeviceVo[] {
    const target = this.resolveAccount(user, accountIdRaw)
    return rows<DeviceVo>(
      this.deps.db
        .prepare(`SELECT ${DEVICE_COLUMNS} FROM dsh_teamwork_device WHERE account_id = ? AND status = 'active' ORDER BY last_active_at DESC`)
        .all(target),
    )
  }

  /** B13 我的设备（分页，含 inactive） */
  mine(user: CurrentUser, pageNum: number, pageSize: number): { total: number; pageNum: number; pageSize: number; items: DeviceVo[] } {
    const db = this.deps.db
    const total = row<{ c: number }>(db.prepare('SELECT count(*) AS c FROM dsh_teamwork_device WHERE account_id = ?').get(user.accountId))!.c
    const items = rows<DeviceVo>(
      db
        .prepare(`SELECT ${DEVICE_COLUMNS} FROM dsh_teamwork_device WHERE account_id = ? ORDER BY last_active_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(user.accountId, pageSize, (pageNum - 1) * pageSize),
    )
    return { total, pageNum, pageSize, items }
  }

  /** B14 删设备（任何登录用户都能删任意设备；服务端不做资源级鉴权） */
  remove(user: CurrentUser, id: number): void {
    void user
    const target = row<{ accountId: string }>(this.deps.db.prepare('SELECT account_id AS accountId FROM dsh_teamwork_device WHERE id = ?').get(id))
    if (!target) throw errors.deviceNotFound(id)
    this.deps.db.prepare('DELETE FROM dsh_teamwork_device WHERE id = ?').run(id)
  }

  /** B15 工作区 upsert（两种形状） */
  upsertWorkspace(user: CurrentUser, body: Record<string, unknown>): WorkspaceVo {
    const instance = typeof body.instance === 'string' ? body.instance.trim() : ''
    if (!instance || instance.length > 255) throw errors.invalidRequest('instance 必填且 ≤255')
    const type = body.type
    if (type !== 'index' && type !== 'portal') throw errors.invalidType('type')
    const detail = body.detail
    if (typeof detail !== 'string') throw errors.invalidRequest('detail 必须是字符串')

    const workspaceId = body.workspaceId === undefined || body.workspaceId === null ? null : String(body.workspaceId)
    const cwd = body.cwd === undefined || body.cwd === null ? null : String(body.cwd)

    if (type === 'index') {
      if (workspaceId !== null || cwd !== null) throw errors.invalidWorkspaceShape('index 时 workspaceId/cwd 必须为空')
    } else if (!workspaceId || !cwd) {
      throw errors.invalidWorkspaceShape('portal 时 workspaceId/cwd 必填')
    }

    const at = nowIso()
    const db = this.deps.db
    if (type === 'index') {
      db.prepare(
        `INSERT INTO dsh_teamwork_device_workspace(account_id, instance, workspace_id, cwd, type, detail, created_at, updated_at)
         VALUES(?, ?, NULL, NULL, 'index', ?, ?, ?)
         ON CONFLICT(account_id, instance) WHERE workspace_id IS NULL
         DO UPDATE SET detail = excluded.detail, updated_at = excluded.updated_at`,
      ).run(user.accountId, instance, detail, at, at)
    } else {
      db.prepare(
        `INSERT INTO dsh_teamwork_device_workspace(account_id, instance, workspace_id, cwd, type, detail, created_at, updated_at)
         VALUES(?, ?, ?, ?, 'portal', ?, ?, ?)
         ON CONFLICT(account_id, instance, workspace_id) WHERE workspace_id IS NOT NULL
         DO UPDATE SET cwd = excluded.cwd, detail = excluded.detail, updated_at = excluded.updated_at`,
      ).run(user.accountId, instance, workspaceId, cwd, detail, at, at)
    }

    const saved =
      type === 'index'
        ? row<WorkspaceVo>(
            db
              .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM dsh_teamwork_device_workspace WHERE account_id = ? AND instance = ? AND workspace_id IS NULL`)
              .get(user.accountId, instance),
          )
        : row<WorkspaceVo>(
            db
              .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM dsh_teamwork_device_workspace WHERE account_id = ? AND instance = ? AND workspace_id = ?`)
              .get(user.accountId, instance, workspaceId),
          )
    if (!saved) throw errors.internal('工作区写入后读取失败')
    return saved
  }

  /** B16 条件查询（`cwd` 精确 / `cwdPrefix` 前缀；不提供包含匹配） */
  listWorkspaces(user: CurrentUser, query: Record<string, unknown>): WorkspaceVo[] {
    const accountId =
      query.accountId === undefined || query.accountId === null || query.accountId === '' ? user.accountId : String(query.accountId)
    const where: string[] = ['account_id = ?']
    const args: unknown[] = [accountId]
    const eq = (field: string, col: string): void => {
      const v = query[field]
      if (v !== undefined && v !== null && v !== '') {
        where.push(`${col} = ?`)
        args.push(String(v))
      }
    }
    eq('instance', 'instance')
    eq('type', 'type')
    eq('workspaceId', 'workspace_id')
    eq('cwd', 'cwd')

    const prefix = query.cwdPrefix
    if (prefix !== undefined && prefix !== null && prefix !== '') {
      if (query.cwd !== undefined && query.cwd !== null && query.cwd !== '') {
        throw errors.invalidRequest('cwd 与 cwdPrefix 不能同时传')
      }
      where.push('cwd >= ? AND cwd < ?')
      args.push(String(prefix), String(prefix) + '\uffff')
    }
    return rows<WorkspaceVo>(
      this.deps.db
        .prepare(`SELECT ${WORKSPACE_COLUMNS} FROM dsh_teamwork_device_workspace WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC`)
        .all(...(args as never[])),
    )
  }

  /** 省略 accountId = 查自己；显式给谁都允许（服务端不做资源级鉴权） */
  private resolveAccount(user: CurrentUser, raw: unknown): string {
    if (raw === undefined || raw === null || raw === '') return user.accountId
    return String(raw)
  }
}
