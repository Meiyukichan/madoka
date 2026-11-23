/**
 * 项目与成员业务层（B1–B10）。
 *
 * 不变式：
 *  - 每个项目恰好一个 owner（DB 部分唯一索引兜底）
 *  - `public` 项目的 owner 必须是 leader/administrator；`private` 不限
 *  - `private` 成员上限可配（默认 5）
 *  - `archived` 项目只读（只允许改 status 还原）
 *  - 删项目前 issue 必须为 0
 */
import type { DatabaseSync } from 'node:sqlite'
import { errors, nowIso } from '../../errors.js'
import type { CurrentUser } from '../../auth/guard.js'
import type { AccountService } from '../account/service.js'
import type { AccountVo } from '../account/mapper.js'
import { normalizePage, normalizePageSize } from '../account/service.js'
import { ProjectMapper, toMemberVo, type MemberVo, type ProjectDetailVo, type ProjectRole, type ProjectStatus, type Visibility } from './mapper.js'

export interface ProjectServiceDeps {
  db: DatabaseSync
  privateMemberLimit: number
  accounts: Pick<AccountService, 'list'>
}

const NAME_MAX = 100
const DESC_MAX = 2000

export class ProjectService {
  private readonly mapper: ProjectMapper

  constructor(private readonly deps: ProjectServiceDeps) {
    this.mapper = new ProjectMapper(deps.db)
  }

  private isAdmin(user: CurrentUser): boolean {
    return user.globalRole === 'administrator'
  }

  private canCreatePublic(user: CurrentUser): boolean {
    return user.globalRole === 'administrator' || user.globalRole === 'leader'
  }

  private requireVisible(user: CurrentUser, projectId: number) {
    const project = this.mapper.findById(projectId)
    if (!project) throw errors.projectNotFound(projectId)
    if (this.isAdmin(user)) return { project, member: undefined as ReturnType<ProjectMapper['findMember']> }
    const member = this.mapper.findMember(projectId, user.accountId)
    if (!member) throw errors.projectNotFound(projectId)
    return { project, member }
  }

  private requireOwner(user: CurrentUser, projectId: number) {
    const ctx = this.requireVisible(user, projectId)
    if (this.isAdmin(user)) return ctx
    if (ctx.member?.role !== 'owner') throw errors.forbidden('需要项目 owner 或 administrator')
    return ctx
  }

  /** 成员管理写路径：全局 leader 不需要先成为项目成员。 */
  private requireMemberManager(user: CurrentUser, projectId: number) {
    if (user.globalRole === 'leader' && !this.isAdmin(user)) {
      const project = this.mapper.findById(projectId)
      if (!project) throw errors.projectNotFound(projectId)
      return { project, member: this.mapper.findMember(projectId, user.accountId) }
    }
    return this.requireVisible(user, projectId)
  }

  // ── B1 / B2 ────────────────────────────────────────────────
  list(user: CurrentUser, query: { keyword?: unknown; includeArchived?: unknown; pageNum?: unknown; pageSize?: unknown }) {
    const pageNum = normalizePage(query.pageNum)
    const pageSize = normalizePageSize(query.pageSize)
    const keyword = typeof query.keyword === 'string' && query.keyword.trim() ? query.keyword.trim() : null
    const includeArchived = query.includeArchived === true || query.includeArchived === 'true'
    const accountId = this.isAdmin(user) ? null : user.accountId
    const { total, items } = this.mapper.list({ accountId, keyword, includeArchived, pageNum, pageSize })
    return { total, pageNum, pageSize, items }
  }

  mine(user: CurrentUser, query: { includeArchived?: unknown }) {
    const includeArchived = query.includeArchived === true || query.includeArchived === 'true'
    return this.mapper.mine(user.accountId, includeArchived)
  }

  // ── B3 ─────────────────────────────────────────────────────
  detail(user: CurrentUser, projectId: number): ProjectDetailVo {
    const { project } = this.requireVisible(user, projectId)
    return { ...project, members: this.mapper.members(projectId).map(toMemberVo) }
  }

  // ── B4 ─────────────────────────────────────────────────────
  create(user: CurrentUser, body: { name?: unknown; visibility?: unknown; description?: unknown }): ProjectDetailVo {
    const name = normalizeName(body.name)
    const visibility = normalizeVisibility(body.visibility) ?? 'public'
    const description = normalizeDescription(body.description)

    if (visibility === 'public' && !this.canCreatePublic(user)) {
      throw errors.publicProjectRequiresLeader()
    }
    if (this.mapper.findByName(name)) throw errors.projectNameExists()

    const at = nowIso()
    this.deps.db.exec('BEGIN IMMEDIATE')
    let id: number
    try {
      id = this.mapper.insert({ name, visibility, description, createdBy: user.accountId, now: at })
      this.mapper.upsertMember(id, user.accountId, 'owner', at)
      this.deps.db.exec('COMMIT')
    } catch (err) {
      this.deps.db.exec('ROLLBACK')
      if (String(err).includes('UNIQUE')) throw errors.projectNameExists()
      throw err
    }
    return this.detail(user, id)
  }

  // ── B5 ─────────────────────────────────────────────────────
  update(user: CurrentUser, projectId: number, body: { name?: unknown; description?: unknown; visibility?: unknown; status?: unknown }): ProjectDetailVo {
    const { project } = this.requireOwner(user, projectId)

    const patch: { name?: string; description?: string | null; visibility?: Visibility; status?: ProjectStatus } = {}
    if (body.name !== undefined) patch.name = normalizeName(body.name)
    if (body.description !== undefined) patch.description = normalizeDescription(body.description)
    if (body.visibility !== undefined) patch.visibility = normalizeVisibility(body.visibility, true)!
    if (body.status !== undefined) patch.status = normalizeStatus(body.status)

    // 归档项目只读：只允许改 status
    if (project.status === 'archived') {
      const onlyStatus = Object.keys(patch).every((k) => k === 'status')
      if (!onlyStatus) throw errors.projectArchived()
    }

    if (patch.visibility === 'private' && project.visibility !== 'private') {
      const current = this.mapper.memberCount(projectId)
      if (current > this.deps.privateMemberLimit) {
        throw errors.cannotShrinkToPrivate(current, this.deps.privateMemberLimit)
      }
    }
    if (patch.visibility === 'public' && project.visibility !== 'public') {
      const owner = this.mapper.findById(projectId)?.owner ?? null
      if (!owner || !this.ownerIsLeaderOrAdmin(owner)) throw errors.cannotPublish(owner)
    }
    if (patch.name && patch.name !== project.name && this.mapper.findByName(patch.name)) {
      throw errors.projectNameExists()
    }

    this.mapper.update(projectId, patch, nowIso())
    return this.detail(user, projectId)
  }

  // ── B6 ─────────────────────────────────────────────────────
  remove(user: CurrentUser, projectId: number): void {
    const { project } = this.requireOwner(user, projectId)
    void project
    const issues = this.mapper.issueCount(projectId)
    if (issues > 0) throw errors.projectHasIssues(issues)
    this.mapper.remove(projectId)
  }

  // ── B7 ─────────────────────────────────────────────────────
  members(user: CurrentUser, projectId: number): MemberVo[] {
    this.requireVisible(user, projectId)
    return this.mapper.members(projectId).map(toMemberVo)
  }

  /** 成员管理资格：全局 administrator / leader，或项目 owner / manager。 */
  canManageMembers(user: CurrentUser, projectId: number): boolean {
    const project = this.mapper.findById(projectId)
    if (!project) return false
    if (this.isAdmin(user) || user.globalRole === 'leader') return true
    const member = this.mapper.findMember(projectId, user.accountId)
    return member?.role === 'owner' || member?.role === 'manager'
  }

  /** 成员搜索：复用账号目录的模糊查询，只返回成员选择需要的字段。 */
  searchAccounts(
    user: CurrentUser,
    projectId: number,
    keyword: string,
    limit = 20,
  ): Array<Pick<AccountVo, 'accountId' | 'displayName' | 'globalRole'>> {
    if (!this.canManageMembers(user, projectId)) throw errors.forbidden('需要 owner / manager / administrator / leader')
    const q = keyword.trim()
    if (q === '') return []
    return this.deps.accounts.list(q, 1, limit).items.map(({ accountId, displayName, globalRole }) => ({
      accountId,
      displayName,
      globalRole,
    }))
  }

  // ── B8 ─────────────────────────────────────────────────────
  addMember(user: CurrentUser, projectId: number, body: { accountId?: unknown; role?: unknown }): MemberVo {
    const { project, member } = this.requireMemberManager(user, projectId)
    if (!this.isAdmin(user) && member?.role === 'member') throw errors.forbidden('需要 owner / manager / administrator')
    if (project.status === 'archived') throw errors.projectArchived()

    if (typeof body.accountId !== 'string' || !body.accountId) throw errors.invalidRequest('缺少 accountId')
    const targetId = body.accountId
    const role = normalizeMemberRole(body.role)

    const target = this.mapper.findMember(projectId, targetId)
    if (target?.role === 'owner') throw errors.ownerRoleImmutable()
    if (!this.accountExists(targetId)) throw errors.accountNotFound(targetId)

    if (member?.role === 'manager' && role === 'manager') throw errors.forbidden('项目 manager 只能授予 member')

    const existing = target !== undefined
    if (!existing && project.visibility === 'private') {
      const current = this.mapper.memberCount(projectId)
      if (current >= this.deps.privateMemberLimit) {
        throw errors.projectMemberLimit(this.deps.privateMemberLimit, current)
      }
    }

    this.deps.db.exec('BEGIN IMMEDIATE')
    try {
      // 事务内复核名额（并发加人可能越过上限）
      if (!existing && project.visibility === 'private') {
        const current = this.mapper.memberCount(projectId)
        if (current >= this.deps.privateMemberLimit) {
          throw errors.projectMemberLimit(this.deps.privateMemberLimit, current)
        }
      }
      this.mapper.upsertMember(projectId, targetId, role, nowIso())
      this.deps.db.exec('COMMIT')
    } catch (err) {
      this.deps.db.exec('ROLLBACK')
      throw err
    }
    return toMemberVo(this.mapper.findMember(projectId, targetId)!)
  }

  // ── B9 ─────────────────────────────────────────────────────
  removeMember(user: CurrentUser, projectId: number, targetAccountId: string): void {
    const { project, member } = this.requireVisible(user, projectId)
    if (project.status === 'archived') throw errors.projectArchived()

    const target = this.mapper.findMember(projectId, targetAccountId)
    if (!target) throw errors.memberNotFound(targetAccountId)
    if (target.role === 'owner') throw errors.ownerCannotBeRemoved()

    if (!this.isAdmin(user)) {
      if (member?.role === 'manager' && target.role !== 'member') {
        throw errors.forbidden('项目 manager 只能移除 member')
      }
      if (member?.role !== 'owner' && member?.role !== 'manager') {
        throw errors.forbidden('需要 owner / manager / administrator')
      }
    }
    this.mapper.removeMember(projectId, targetAccountId)
  }

  // ── B10 ────────────────────────────────────────────────────
  transferOwner(user: CurrentUser, projectId: number, body: { accountId?: unknown }): ProjectDetailVo {
    const { project, member } = this.requireVisible(user, projectId)
    if (project.status === 'archived') throw errors.projectArchived()
    if (!this.isAdmin(user) && member?.role !== 'owner') throw errors.ownerTransferForbidden()

    if (typeof body.accountId !== 'string' || !body.accountId) throw errors.invalidRequest('缺少 accountId')
    const next = body.accountId
    if (!this.accountExists(next)) throw errors.accountNotFound(next)

    const currentOwner = project.owner
    if (currentOwner === next) return this.detail(user, projectId) // 幂等

    if (project.visibility === 'public' && !this.ownerIsLeaderOrAdmin(next)) {
      throw errors.ownerMustBeLeader(next)
    }

    this.deps.db.exec('BEGIN IMMEDIATE')
    try {
      this.mapper.transferOwner(projectId, next, nowIso())
      this.deps.db.exec('COMMIT')
    } catch (err) {
      this.deps.db.exec('ROLLBACK')
      throw err
    }
    return this.detail(user, projectId)
  }

  // ── 供其他模块（降级检查）──────────────────────────────────
  publicProjectsOwnedBy(accountId: string): string[] {
    return this.mapper.publicProjectsOwnedBy(accountId)
  }

  private accountExists(accountId: string): boolean {
    const row = this.deps.db.prepare('SELECT 1 AS ok FROM dsh_teamwork_account WHERE account_id = ?').get(accountId) as { ok: number } | undefined
    return row !== undefined
  }

  private ownerIsLeaderOrAdmin(accountId: string): boolean {
    const row = this.deps.db
      .prepare(`SELECT global_role AS r FROM dsh_teamwork_account WHERE account_id = ?`)
      .get(accountId) as { r: string } | undefined
    return row?.r === 'leader' || row?.r === 'administrator'
  }
}

// ── 校验 + 错误构造 ──────────────────────────────────────────
function normalizeName(v: unknown): string {
  if (typeof v !== 'string') throw errors.invalidProjectName('必须是字符串')
  const t = v.trim()
  if (t.length < 1 || t.length > NAME_MAX) throw errors.invalidProjectName(`长度必须是 1..${NAME_MAX}`)
  return t
}

function normalizeDescription(v: unknown): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw errors.invalidRequest('description 必须是字符串')
  if (v.length > DESC_MAX) throw errors.invalidDescription(DESC_MAX)
  return v
}

function normalizeVisibility(v: unknown, required = false): Visibility | undefined {
  if (v === undefined || v === null) {
    if (required) throw errors.invalidVisibility()
    return undefined
  }
  if (v !== 'public' && v !== 'private') throw errors.invalidVisibility()
  return v
}

function normalizeStatus(v: unknown): ProjectStatus {
  if (v !== 'active' && v !== 'archived') throw errors.invalidRequest('status 只能是 active / archived')
  return v
}

function normalizeMemberRole(v: unknown): ProjectRole {
  if (v === undefined || v === null) return 'member'
  if (v === 'owner') throw errors.ownerRoleNotAssignable()
  if (v !== 'manager' && v !== 'member') throw errors.invalidRole()
  return v
}


