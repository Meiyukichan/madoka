/**
 * 只读项目视图（B2 / B7）：`client.project.list()` / `client.project.members()`。
 *
 * 为什么和 `teamwork.project` 并存：
 *  - 旧 castboard 的 `project` 分组是"/api/internal/projects*"那套只读视图（我名下 + 成员）；
 *  - 写操作（建 / 改 / 删 / 加成员 / 转让）在 `teamwork.project`。
 * 两者路径不同（`/projects/mine` + `/projects/{id}/members`），互不覆盖。
 */

import type { CastboardTransport } from './transport.js'
import { castboardOk, type CastboardResult } from './result.js'
import type { CastboardProject, CastboardProjectMember } from './types.js'
import { toProjectId } from './wire.js'
import { mapFailure } from './teamwork/shared.js'

export class CastboardProjectApi {
  constructor(private readonly transport: CastboardTransport) {}

  /** B2 `GET /projects/mine`：我参与的项目（**裸数组**，不分页） */
  async list(query: { includeArchived?: boolean } = {}): Promise<CastboardResult<CastboardProject[]>> {
    const result = await this.transport.call<CastboardProject[] | null>('projectList', {}, {
      query: { includeArchived: query.includeArchived },
    })
    if (!result.ok) return result
    return castboardOk(result.status, Array.isArray(result.data) ? result.data : [])
  }

  /** B7 `GET /projects/{id}/members`：项目成员（非成员回 404） */
  async members(projectId: number | string): Promise<CastboardResult<CastboardProjectMember[]>> {
    const id = toProjectId(projectId)
    if (!id.ok) return id.fail
    const result = await this.transport.call<CastboardProjectMember[] | null>('projectMembers', { id: id.value })
    if (!result.ok) return mapFailure(result, { 403: 'forbidden', 404: 'project_not_found' })
    return castboardOk(result.status, Array.isArray(result.data) ? result.data : [])
  }
}
