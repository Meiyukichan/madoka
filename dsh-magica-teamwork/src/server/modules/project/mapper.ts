/** 项目与成员的数据访问 */
import type { DatabaseSync } from 'node:sqlite'
import { row, rows } from '../../db/rows.js'

export type Visibility = 'public' | 'private'
export type ProjectStatus = 'active' | 'archived'
export type ProjectRole = 'owner' | 'manager' | 'member'

export interface ProjectRow {
  id: number
  name: string
  status: ProjectStatus
  visibility: Visibility
  description: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
  owner: string | null
  memberCount: number
}

export interface MemberRow {
  id: number
  projectId: number
  accountId: string
  role: ProjectRole
  joinedAt: string
  updatedAt: string
  displayName: string | null
}

export interface ProjectVo {
  id: number
  name: string
  owner: string | null
  createdBy: string | null
  status: ProjectStatus
  visibility: Visibility
  description: string | null
  memberCount: number
  createdAt: string
  updatedAt: string
}

export interface MemberVo {
  id: number
  projectId: number
  accountId: string
  displayName: string | null
  role: ProjectRole
  joinedAt: string
  updatedAt: string
}

export interface ProjectDetailVo extends ProjectVo {
  members: MemberVo[]
}

export function toProjectVo(p: ProjectRow): ProjectVo {
  return {
    id: p.id, name: p.name, owner: p.owner, createdBy: p.createdBy, status: p.status,
    visibility: p.visibility, description: p.description, memberCount: p.memberCount,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  }
}

export function toMemberVo(m: MemberRow): MemberVo {
  return {
    id: m.id, projectId: m.projectId, accountId: m.accountId,
    displayName: m.displayName ?? m.accountId, role: m.role,
    joinedAt: m.joinedAt, updatedAt: m.updatedAt,
  }
}

const PROJECT_SELECT = `
  SELECT p.id, p.name, p.status, p.visibility, p.description,
         p.created_by AS createdBy, p.created_at AS createdAt, p.updated_at AS updatedAt,
         (SELECT m2.account_id FROM dsh_teamwork_project_member m2
           WHERE m2.project_id = p.id AND m2.role = 'owner'
           ORDER BY m2.joined_at ASC, m2.id ASC LIMIT 1) AS owner,
         (SELECT count(*) FROM dsh_teamwork_project_member m3 WHERE m3.project_id = p.id) AS memberCount
    FROM dsh_teamwork_project p`

const MEMBER_SELECT = `
  SELECT m.id, m.project_id AS projectId, m.account_id AS accountId, m.role,
         m.joined_at AS joinedAt, m.updated_at AS updatedAt,
         a.display_name AS displayName
    FROM dsh_teamwork_project_member m
    LEFT JOIN dsh_teamwork_account a ON a.account_id = m.account_id`

export class ProjectMapper {
  constructor(private readonly db: DatabaseSync) {}

  list(opts: { accountId: string | null; keyword: string | null; includeArchived: boolean; pageNum: number; pageSize: number }): {
    total: number
    items: ProjectVo[]
  } {
    const where: string[] = []
    const args: unknown[] = []
    if (opts.accountId !== null) {
      where.push('pm.account_id = ?')
      args.push(opts.accountId)
    }
    if (!opts.includeArchived) where.push("p.status = 'active'")
    if (opts.keyword) {
      where.push('p.name LIKE ?')
      args.push('%' + opts.keyword + '%')
    }
    const join = opts.accountId !== null ? 'JOIN dsh_teamwork_project_member pm ON pm.project_id = p.id' : ''
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : ''

    const total = row<{ c: number }>(
      this.db.prepare('SELECT count(*) AS c FROM dsh_teamwork_project p ' + join + ' ' + whereSql).get(...(args as never[])),
    )!.c
    const items = rows<ProjectRow>(
      this.db
        .prepare(PROJECT_SELECT + ' ' + join + ' ' + whereSql + ' ORDER BY p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?')
        .all(...(args as never[]), opts.pageSize, (opts.pageNum - 1) * opts.pageSize),
    ).map(toProjectVo)
    return { total, items }
  }

  mine(accountId: string, includeArchived: boolean): ProjectVo[] {
    const active = includeArchived ? '' : "AND p.status = 'active'"
    return rows<ProjectRow>(
      this.db
        .prepare(
          PROJECT_SELECT +
            ' JOIN dsh_teamwork_project_member pm ON pm.project_id = p.id WHERE pm.account_id = ? ' +
            active +
            ' ORDER BY p.updated_at DESC, p.id DESC',
        )
        .all(accountId),
    ).map(toProjectVo)
  }

  findById(id: number): ProjectRow | undefined {
    return row<ProjectRow>(this.db.prepare(PROJECT_SELECT + ' WHERE p.id = ?').get(id))
  }

  findByName(name: string): { id: number } | undefined {
    return row<{ id: number }>(this.db.prepare('SELECT id FROM dsh_teamwork_project WHERE name = ?').get(name))
  }

  insert(input: { name: string; visibility: Visibility; description: string | null; createdBy: string; now: string }): number {
    return row<{ id: number }>(
      this.db
        .prepare(
          `INSERT INTO dsh_teamwork_project(name, status, visibility, description, created_by, created_at, updated_at)
           VALUES(?, 'active', ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(input.name, input.visibility, input.description, input.createdBy, input.now, input.now),
    )!.id
  }

  update(id: number, patch: { name?: string; description?: string | null; visibility?: Visibility; status?: ProjectStatus }, now: string): void {
    const sets: string[] = []
    const args: unknown[] = []
    if (patch.name !== undefined) { sets.push('name = ?'); args.push(patch.name) }
    if (patch.description !== undefined) { sets.push('description = ?'); args.push(patch.description) }
    if (patch.visibility !== undefined) { sets.push('visibility = ?'); args.push(patch.visibility) }
    if (patch.status !== undefined) { sets.push('status = ?'); args.push(patch.status) }
    if (!sets.length) return
    sets.push('updated_at = ?')
    args.push(now, id)
    this.db.prepare('UPDATE dsh_teamwork_project SET ' + sets.join(', ') + ' WHERE id = ?').run(...(args as never[]))
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM dsh_teamwork_project WHERE id = ?').run(id)
  }

  memberCount(projectId: number): number {
    return row<{ c: number }>(this.db.prepare('SELECT count(*) AS c FROM dsh_teamwork_project_member WHERE project_id = ?').get(projectId))!.c
  }

  members(projectId: number): MemberRow[] {
    return rows<MemberRow>(this.db.prepare(MEMBER_SELECT + ' WHERE m.project_id = ? ORDER BY m.joined_at ASC, m.id ASC').all(projectId))
  }

  findMember(projectId: number, accountId: string): MemberRow | undefined {
    return row<MemberRow>(this.db.prepare(MEMBER_SELECT + ' WHERE m.project_id = ? AND m.account_id = ?').get(projectId, accountId))
  }

  upsertMember(projectId: number, accountId: string, role: ProjectRole, now: string): void {
    this.db
      .prepare(
        `INSERT INTO dsh_teamwork_project_member(project_id, account_id, role, joined_at, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(project_id, account_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
      )
      .run(projectId, accountId, role, now, now)
  }

  removeMember(projectId: number, accountId: string): void {
    this.db.prepare('DELETE FROM dsh_teamwork_project_member WHERE project_id = ? AND account_id = ?').run(projectId, accountId)
  }

  transferOwner(projectId: number, nextAccountId: string, now: string): void {
    this.db
      .prepare("UPDATE dsh_teamwork_project_member SET role = 'manager', updated_at = ? WHERE project_id = ? AND role = 'owner' AND account_id <> ?")
      .run(now, projectId, nextAccountId)
    this.db
      .prepare(
        `INSERT INTO dsh_teamwork_project_member(project_id, account_id, role, joined_at, updated_at)
         VALUES(?, ?, 'owner', ?, ?)
         ON CONFLICT(project_id, account_id) DO UPDATE SET role = 'owner', updated_at = excluded.updated_at`,
      )
      .run(projectId, nextAccountId, now, now)
  }

  issueCount(projectId: number): number {
    return row<{ c: number }>(this.db.prepare('SELECT count(*) AS c FROM dsh_teamwork_issue WHERE project_id = ?').get(projectId))!.c
  }

  publicProjectsOwnedBy(accountId: string): string[] {
    return rows<{ name: string }>(
      this.db
        .prepare(
          `SELECT p.name FROM dsh_teamwork_project p
             JOIN dsh_teamwork_project_member m ON m.project_id = p.id
            WHERE m.account_id = ? AND m.role = 'owner' AND p.visibility = 'public'`,
        )
        .all(accountId),
    ).map((r) => r.name)
  }

  isProjectMember(projectId: number, accountId: string): boolean {
    return this.findMember(projectId, accountId) !== undefined
  }
}
