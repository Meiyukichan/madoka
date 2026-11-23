/**
 * 项目管理（共享库侧）的业务规则�? *
 * 位置约定（用户要求）�?*项目管理的代码放 `dsh-magica-teamwork/src/sdk`**�? * 这里只放**纯函�?*（角色判定、私人项目上限、visibility 权限、分页归一），
 * 类型全部复用 `./types.js` 的线格式类型，不另造一套�? *
 * 规则来源：raw `s/v/t` 三篇�?2 组件 / 13 端点 / 权限矩阵与两条产品规则）�? *
 * @module dsh-teamwork/sdk/project-management
 */
import type {
  CastboardDevice,
  CastboardIssue,
  CastboardMemberRole,
  CastboardProject,
  CastboardProjectMember,
  CastboardTeamworkPage,
} from './types.js'

/** 全局角色（`unknown` = 查不到，**不等�?*普通用户）�?*/
export type RoleLookup = 'administrator' | 'leader' | 'user' | 'unknown'

/** 界面视角的有效角色�?*/
export type EffectiveRole = 'admin' | 'owner' | 'manager' | 'member' | 'none'

/** 私人项目成员上限�?*含负责人**）�?*/
export const PRIVATE_PROJECT_MEMBER_LIMIT = 5

/** 分页默认与上限（�?`dsh-teamwork/1` 协议一致）�?*/
export const PAGE_SIZE_DEFAULT = 20
export const PAGE_SIZE_MAX = 200

/** 会话/身份面（替代 raw �?`GET /session`）�?*/
export interface SessionInfo {
  userId: string
  baseUrl: string
  role: RoleLookup
  roleKnown: boolean
  canCreateProject: boolean
}

/** 人员目录行�?*/
export interface PersonRow {
  userId: string
  displayName?: string
  dept?: string
}

/** 人员目录查询结果（失败降级为空列�?+ `degraded`）�?*/
export interface PeopleResult {
  items: PersonRow[]
  degraded: boolean
  reason?: string
}

/**
 * 计算有效角色�? *
 * 优先级：全局 administrator > 项目 owner（`owner` �?`createdBy` 命中�? 成员表角�?> none�? */
export function effectiveRoleOf(input: {
  globalRole: RoleLookup
  userId: string | null | undefined
  project?: Pick<CastboardProject, 'owner' | 'createdBy'>
  memberRole?: CastboardMemberRole
}): EffectiveRole {
  if (input.globalRole === 'administrator') return 'admin'
  if (input.userId === null || input.userId === undefined || input.userId === '') return 'none'
  if (input.project !== undefined) {
    if (input.project.owner === input.userId) return 'owner'
    if (input.project.createdBy === input.userId) return 'owner'
  }
  if (input.memberRole !== undefined) return input.memberRole as EffectiveRole
  return 'none'
}

/** 能否新建项目（`roleKnown === false` **不拦**：查不到不等于没权限）�?*/
export function canCreateProject(role: RoleLookup, roleKnown: boolean): boolean {
  if (!roleKnown) return true
  return role === 'administrator' || role === 'leader' || role === 'user'
}

/** 能否新建私人项目（不看角色；靠成员上限兜底）�?*/
export function canCreatePrivateProject(userId: string | null | undefined): boolean {
  return typeof userId === 'string' && userId !== ''
}

/** 能否改项目基本信息（名称/描述/负责人）�?*/
export function canEditProject(role: EffectiveRole): boolean {
  return role === 'admin' || role === 'owner'
}

/** 能否删项目�?*/
export function canDeleteProject(role: EffectiveRole): boolean {
  return role === 'admin' || role === 'owner'
}

/** 能否增删成员 / 改角色（manager 只能�?`member`）�?*/
export function canManageMembers(role: EffectiveRole): boolean {
  return role === 'admin' || role === 'owner' || role === 'manager'
}

/** 能否授予这个角色（`owner` 不可直接授予）�?*/
export function canAssignRole(actor: EffectiveRole, next: CastboardMemberRole): boolean {
  if (next === 'owner') return false
  if (actor === 'admin' || actor === 'owner') return true
  if (actor === 'manager') return next === 'member'
  return false
}

/** 私人项目是否已到上限�?*含负责人**）�?*/
export function privateMemberCapReached(memberCount: number, limit = PRIVATE_PROJECT_MEMBER_LIMIT): boolean {
  return memberCount >= limit
}

/**
 * 能否加成员�? *
 * private 到上限就拒（�?改角�?一起拒，否则绕过上限）�?*移除成员永远放行**（否则死锁）�? */
export function canAddMember(input: {
  visibility: string
  memberCount: number
  alreadyMember?: boolean
  limit?: number
}): boolean {
  if (input.visibility !== 'private') return true
  if (input.alreadyMember === true) return true
  return !privateMemberCapReached(input.memberCount, input.limit)
}

/**
 * 能否切换可见性：**只有全局 administrator**；只读窗口不行；
 * 切到 `private` 还要求成员数 �?上限�? */
export function canSwitchVisibility(input: {
  globalRole: RoleLookup
  readOnly?: boolean
  next: string
  memberCount: number
  limit?: number
}): boolean {
  if (input.globalRole !== 'administrator') return false
  if (input.readOnly === true) return false
  if (input.next !== 'private') return true
  return !privateMemberCapReached(input.memberCount, input.limit)
}

/** 分页归一：页�?�?，页大小 1..200（默�?20）�?*/
export function normalizePageQuery(pageNum?: number, pageSize?: number): { pageNum: number; pageSize: number } {
  const page = Number.isInteger(pageNum) && (pageNum ?? 0) >= 1 ? (pageNum as number) : 1
  const size =
    Number.isInteger(pageSize) && (pageSize ?? 0) >= 1 ? Math.min(pageSize as number, PAGE_SIZE_MAX) : PAGE_SIZE_DEFAULT
  return { pageNum: page, pageSize: size }
}

/** 在内存里切一页（服务端分页由协议负责；这里给测试与小数据用）�?*/
export function pageOf<T>(items: readonly T[], pageNum?: number, pageSize?: number): CastboardTeamworkPage<T> {
  const { pageNum: page, pageSize: size } = normalizePageQuery(pageNum, pageSize)
  const start = (page - 1) * size
  return { items: items.slice(start, start + size), pageNum: page, pageSize: size, total: items.length }
}

/** 会话信息 �?`canCreateProject`（`GET /session` 的等价物）�?*/
export function sessionOf(input: { userId: string; baseUrl: string; globalRole: RoleLookup }): SessionInfo {
  const roleKnown = input.globalRole !== 'unknown'
  return {
    userId: input.userId,
    baseUrl: input.baseUrl,
    role: input.globalRole,
    roleKnown,
    canCreateProject: canCreateProject(input.globalRole, roleKnown),
  }
}

/** 项目管理页签的读模型（组件层直接吃）�?*/
export interface ProjectManagementModel {
  session: SessionInfo
  role: EffectiveRole
  projects: CastboardTeamworkPage<CastboardProject>
  devices: CastboardTeamworkPage<CastboardDevice>
  issues: CastboardTeamworkPage<CastboardIssue>
}

/** 项目详情页的判断集合（省得组件里散着算）�?*/
export function detailCapabilities(input: {
  session: SessionInfo
  detail: { owner: string | null; createdBy: string | null; visibility: string; memberCount: number }
  members: readonly CastboardProjectMember[]
  readOnly?: boolean
}): {
  role: EffectiveRole
  canEdit: boolean
  canDelete: boolean
  canManageMembers: boolean
  canAddMember: boolean
  canSwitchVisibility: boolean
  canBecomePrivate: boolean
} {
  const self = input.members.find(member => member.accountId === input.session.userId)
  const role = effectiveRoleOf({
    globalRole: input.session.role,
    userId: input.session.userId,
    project: { owner: input.detail.owner, createdBy: input.detail.createdBy },
    memberRole: self?.role as CastboardMemberRole | undefined,
  })
  const memberCount = Math.max(input.detail.memberCount, input.members.length)
  return {
    role,
    canEdit: canEditProject(role),
    canDelete: canDeleteProject(role),
    canManageMembers: canManageMembers(role),
    canAddMember: canManageMembers(role) && canAddMember({ visibility: input.detail.visibility, memberCount }),
    canSwitchVisibility: canSwitchVisibility({
      globalRole: input.session.role,
      readOnly: input.readOnly,
      next: 'private',
      memberCount,
    }),
    canBecomePrivate: !privateMemberCapReached(memberCount),
  }
}
