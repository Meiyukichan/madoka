/**
 * 界面侧权限判据（pure，六条；与 SDK 的 `effectiveRoleOf` 对齐但不做 I/O）。
 *
 * 命名与 SDK 一致：`canEditProject` / `canDeleteProject` / `canManageMembers` /
 * `canAssignRole` / `canCreateProject` / `canEditIssue`。
 *
 * @module dsh-magica-teamwork/client/model/permissions
 */

/** 角色。 */
export type ClientRole = 'owner' | 'admin' | 'member' | 'viewer'

/** 判据输入。 */
export interface PermissionInput {
  role: ClientRole | undefined
  /** 是否全局管理员。 */
  globalAdmin?: boolean
  /** 项目是否私有。 */
  private?: boolean
  /** 是否是项目创建者。 */
  creator?: boolean
}

/** 管理员或更高。 */
function isManaging(input: PermissionInput): boolean {
  return input.globalAdmin === true || input.role === 'owner' || input.role === 'admin'
}

/** 能建项目：任何人（含 viewer? 不行）。 */
export function canCreateProject(input: PermissionInput): boolean {
  return input.role !== undefined && input.role !== 'viewer'
}

/** 能编辑项目：管理级，或私有项目的创建者。 */
export function canEditProject(input: PermissionInput): boolean {
  if (isManaging(input)) return true
  return input.private === true && input.creator === true
}

/** 能删项目：**只有 owner 或全局管理员**。 */
export function canDeleteProject(input: PermissionInput): boolean {
  return input.globalAdmin === true || input.role === 'owner'
}

/** 能管成员：管理级。 */
export function canManageMembers(input: PermissionInput): boolean {
  return isManaging(input)
}

/** 能改别人的角色：管理级，且不能改 owner。 */
export function canAssignRole(input: PermissionInput, targetRole: ClientRole): boolean {
  if (input.globalAdmin === true) return true
  if (!isManaging(input)) return false
  if (targetRole === 'owner') return false
  return true
}

/** 能编辑 issue：非 viewer。 */
export function canEditIssue(input: PermissionInput): boolean {
  return input.role !== undefined && input.role !== 'viewer'
}

/** 能切换可见性：**仅全局管理员**（raw v 两条产品规则之一）。 */
export function canSwitchVisibility(input: PermissionInput): boolean {
  return input.globalAdmin === true
}
