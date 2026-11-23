/**
 * teamwork.project（B1 / B3–B6 / B8–B10）：项目管理面（可写）。
 *
 * 与 `project.ts`（只读 `projectList` / `projectMembers`）的分工：
 *  - 本文件是 `/projects*` 的完整 CRUD（旧 castboard 的 `teamwork` 分组）；
 *  - 只读视图另开一组，是为了保持 raw 里 `project.list/members` 的调用形状不变。
 */

import type { CastboardTransport } from '../transport.js'
import { castboardFail, castboardOk, type CastboardResult } from '../result.js'
import {
  isCastboardGlobalRole,
  isCastboardMemberRole,
  isCastboardProjectStatus,
  isCastboardProjectVisibility,
  type CastboardProjectCreateInput,
  type CastboardProjectDetail,
  type CastboardProjectMember,
  type CastboardProjectMemberInput,
  type CastboardProjectPageQuery,
  type CastboardProjectUpdateInput,
  type CastboardAccountOption,
  type CastboardTeamworkPage,
  type CastboardTeamworkProject,
} from '../types.js'
import { pick, toAccount, toProjectId } from '../wire.js'
import { emptyBodyFail, invalidBodyCode, mapFailure, normalizePage, pageOfArray, pageParams } from './shared.js'

const CREATE_KEYS = ['name', 'visibility', 'description'] as const
const UPDATE_KEYS = ['name', 'description', 'visibility', 'status'] as const
const MEMBER_KEYS = ['accountId', 'role'] as const

export class CastboardTeamworkProjectApi {
  constructor(private readonly transport: CastboardTransport) {}

  /** B1 `GET /projects`：我可见的项目（分页；administrator 见全部） */
  async list(query: CastboardProjectPageQuery = {}): Promise<CastboardResult<CastboardTeamworkPage<CastboardTeamworkProject>>> {
    const { pageNum, pageSize } = pageParams(query)
    const result = await this.transport.call<unknown>('teamworkProjectList', {}, {
      query: {
        pageNum,
        pageSize,
        keyword: query.keyword,
        includeArchived: query.includeArchived,
      },
    })
    if (!result.ok) return result
    return castboardOk(result.status, normalizePage<CastboardTeamworkProject>(result.data, { pageNum, pageSize }))
  }

  /**
   * B2 `GET /projects/mine`：我参与的项目。
   * 服务端回**裸数组**（不分页），这里包成 `CastboardTeamworkPage` 以保持 raw 的返回形状。
   */
  async mine(query: { includeArchived?: boolean } = {}): Promise<CastboardResult<CastboardTeamworkPage<CastboardTeamworkProject>>> {
    const result = await this.transport.call<CastboardTeamworkProject[] | null>('teamworkProjectMine', {}, {
      query: { includeArchived: query.includeArchived },
    })
    if (!result.ok) return result
    return castboardOk(result.status, pageOfArray(Array.isArray(result.data) ? result.data : []))
  }

  /** B3 `GET /projects/{id}`：项目详情（含 members；非成员回 404，不透 403） */
  async detail(projectId: number | string): Promise<CastboardResult<CastboardProjectDetail>> {
    const id = toProjectId(projectId)
    if (!id.ok) return id.fail
    const result = await this.transport.call<CastboardProjectDetail>('teamworkProjectDetail', { id: id.value })
    if (!result.ok) return mapFailure(result, { 403: 'forbidden', 404: 'project_not_found' })
    const members = Array.isArray(result.data?.members) ? result.data.members : []
    return castboardOk(result.status, { ...result.data, members })
  }

  /**
   * B4 `POST /projects`：新建项目。
   *
   * **`owner` 不可指定**：本协议 owner = 创建人（`created_by` 也是服务端填）。
   * 传了不一致的 `owner` → 本地 `invalid_body`（零请求），避免"以为能代建"。
   */
  async create(input: CastboardProjectCreateInput & { owner?: string }): Promise<CastboardResult<CastboardProjectDetail>> {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (name === '') {
      return castboardFail({
        status: 400,
        code: 'invalid_project_name',
        reason: '新建项目的 name 不能为空；项目名全局唯一，重名服务端回 409 project_name_exists',
        field: 'name',
      })
    }
    if (input.visibility !== undefined && !isCastboardProjectVisibility(input.visibility)) {
      return castboardFail({
        status: 400,
        code: 'invalid_visibility',
        reason: 'visibility 只能是 public / private',
        field: 'visibility',
      })
    }
    if (input.owner !== undefined) {
      return castboardFail({
        status: 400,
        code: 'invalid_body',
        reason: `本协议的 owner 由创建人决定，不能指定他人（收到 ${input.owner}）：请创建后用 transferOwner()`,
        field: 'owner',
      })
    }
    const body = pick(input as unknown as Record<string, unknown>, CREATE_KEYS)
    const result = await this.transport.call<CastboardProjectDetail>('teamworkProjectCreate', {}, { body })
    if (!result.ok) {
      return mapFailure(result, { 403: 'public_project_requires_leader', 409: 'project_name_exists' })
    }
    const members = Array.isArray(result.data?.members) ? result.data.members : []
    return castboardOk(result.status, { ...result.data, members })
  }

  /** B5 `PUT /projects/{id}`：部分更新（未传字段不动；归档后只允许改 status） */
  async update(
    projectId: number | string,
    input: CastboardProjectUpdateInput,
  ): Promise<CastboardResult<CastboardProjectDetail>> {
    const id = toProjectId(projectId)
    if (!id.ok) return id.fail
    if (input.status !== undefined && !isCastboardProjectStatus(input.status)) {
      return castboardFail({
        status: 400,
        code: 'invalid_status',
        reason: 'status 只能是 active / archived',
        field: 'status',
      })
    }
    if (input.visibility !== undefined && !isCastboardProjectVisibility(input.visibility)) {
      return castboardFail({
        status: 400,
        code: 'invalid_visibility',
        reason: 'visibility 只能是 public / private',
        field: 'visibility',
      })
    }
    const body = pick(input as unknown as Record<string, unknown>, UPDATE_KEYS)
    if (Object.keys(body).length === 0) return emptyBodyFail('teamwork.project.update')
    const result = await this.transport.call<CastboardProjectDetail>('teamworkProjectUpdate', { id: id.value }, { body })
    if (!result.ok) {
      return mapFailure(result, {
        403: 'forbidden',
        404: 'project_not_found',
        409: 'project_archived',
      })
    }
    const members = Array.isArray(result.data?.members) ? result.data.members : []
    return castboardOk(result.status, { ...result.data, members })
  }

  /** B6 `DELETE /projects/{id}`：硬删除（有 issue → 409 project_has_issues） */
  async remove(projectId: number | string): Promise<CastboardResult<void>> {
    const id = toProjectId(projectId)
    if (!id.ok) return id.fail
    const result = await this.transport.call<void>('teamworkProjectDelete', { id: id.value })
    if (!result.ok) {
      return mapFailure(result, { 403: 'forbidden', 404: 'project_not_found', 409: 'project_has_issues' })
    }
    return result
  }

  /** B7a `GET /projects/{id}/accounts?q=`：成员搜索（owner/manager/admin/leader） */
  async searchAccounts(
    projectId: number | string,
    keyword: string,
  ): Promise<CastboardResult<CastboardAccountOption[]>> {
    const id = toProjectId(projectId)
    if (!id.ok) return id.fail
    const q = keyword.trim()
    if (q === '') return castboardOk(200, [])
    const result = await this.transport.call<CastboardAccountOption[] | null>(
      'teamworkProjectAccounts',
      { id: id.value },
      { query: { q } },
    )
    if (!result.ok) return mapFailure(result, { 403: 'forbidden', 404: 'project_not_found' })
    return castboardOk(result.status, Array.isArray(result.data) ? result.data : [])
  }

  /** B7 `GET /projects/{id}/members`（成员列表；本类提供是为了 `detail()` 之外的直取） */  async members(projectId: number | string): Promise<CastboardResult<CastboardProjectMember[]>> {
    const id = toProjectId(projectId)
    if (!id.ok) return id.fail
    const result = await this.transport.call<CastboardProjectMember[] | null>('projectMembers', { id: id.value })
    if (!result.ok) return mapFailure(result, { 403: 'forbidden', 404: 'project_not_found' })
    return castboardOk(result.status, Array.isArray(result.data) ? result.data : [])
  }

  /** B8 `POST /projects/{id}/members`：加成员 / 改角色（upsert；`owner` 不可授予） */
  async memberAdd(
    projectId: number | string,
    input: CastboardProjectMemberInput,
  ): Promise<CastboardResult<CastboardProjectMember>> {
    const id = toProjectId(projectId)
    if (!id.ok) return id.fail
    const account = toAccount(input.accountId, 'accountId', '成员账号不能为空')
    if (!account.ok) return account.fail
    if (input.role !== undefined && !isCastboardMemberRole(input.role)) {
      return castboardFail({ status: 400, code: 'invalid_role', reason: 'role 只能是 manager / member', field: 'role' })
    }
    if ((input.role as string | undefined) === 'owner') {
      return castboardFail({
        status: 400,
        code: 'owner_role_not_assignable',
        reason: 'owner 不能通过成员接口授予（不传默认 member；manager 只能把别人加成 member）',
        field: 'role',
      })
    }
    const body = pick({ accountId: account.value, role: input.role }, MEMBER_KEYS)
    const result = await this.transport.call<CastboardProjectMember>('teamworkProjectMemberAdd', { id: id.value }, { body })
    if (!result.ok) {
      const mapped = mapFailure(result, {
        403: 'forbidden',
        404: 'project_not_found',
        409: 'project_archived',
      })
      if (mapped.status === 400) return { ...mapped, code: invalidBodyCode(mapped) }
      return mapped
    }
    return result
  }

  /** B9 `DELETE /projects/{id}/members/{accountId}`：路径里的 memberId 是**账号**，不是 members[].id */
  async memberRemove(projectId: number | string, accountId: string): Promise<CastboardResult<void>> {
    const id = toProjectId(projectId)
    if (!id.ok) return id.fail
    const account = toAccount(accountId, 'accountId', '路径里的 memberId 是被移除人的账号，不是 members[].id')
    if (!account.ok) return account.fail
    const result = await this.transport.call<void>('teamworkProjectMemberRemove', {
      id: id.value,
      accountId: account.value,
    })
    if (!result.ok) {
      return mapFailure(result, {
        403: 'forbidden',
        404: 'project_not_found',
        409: 'owner_cannot_be_removed',
      })
    }
    return result
  }

  /** B10 `PUT /projects/{id}/owner`：转让 owner（旧 owner 降为 manager） */
  async transferOwner(projectId: number | string, accountId: string): Promise<CastboardResult<CastboardProjectDetail>> {
    const id = toProjectId(projectId)
    if (!id.ok) return id.fail
    const account = toAccount(accountId, 'accountId', '目标负责人账号不能为空')
    if (!account.ok) return account.fail
    const result = await this.transport.call<CastboardProjectDetail>('teamworkProjectTransferOwner', { id: id.value }, {
      body: { accountId: account.value },
    })
    if (!result.ok) {
      return mapFailure(result, {
        403: 'owner_transfer_forbidden',
        404: 'account_not_found',
        409: 'owner_must_be_leader',
      })
    }
    const members = Array.isArray(result.data?.members) ? result.data.members : []
    return castboardOk(result.status, { ...result.data, members })
  }

  /** 管理者改角色用不到本项目；保留全局角色守卫的类型出口（避免 import 未使用） */
  static isGlobalRole(value: unknown): boolean {
    return isCastboardGlobalRole(value)
  }
}
