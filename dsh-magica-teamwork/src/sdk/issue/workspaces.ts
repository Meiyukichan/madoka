/**
 * issue.workspace（B15 / B16）：工作区肖像两种粒度。
 *
 * DB 形状硬约束（`ck_tw_ws_shape`）：
 *  - `type='index'`：必须有 `instance`/`detail`，**必须没有** `workspaceId`/`cwd`；
 *  - `type='portal'`：`instance`/`workspaceId`/`cwd`/`detail` 全必填。
 * 写错 → 服务端 `400 invalid_workspace_shape`；这里先在本地拦（零请求）。
 *
 * 另：没有批量接口、没有删除接口（协议如此）。
 */

import type { LatticeTransport } from '../transport.js'
import { latticeFail, latticeOk, type LatticeResult } from '../result.js'
import type {
  LatticeDeviceWorkspace,
  LatticeDeviceWorkspaceInput,
  LatticeDeviceWorkspaceQuery,
} from '../types.js'
import { isLatticeWorkspaceType } from '../types.js'
import { pick } from '../wire.js'

const UPSERT_KEYS = ['instance', 'workspaceId', 'cwd', 'type', 'detail'] as const

export class LatticeWorkspaceApi {
  constructor(private readonly transport: LatticeTransport) {}

  /** B15 `POST /device-workspaces`：上报一条（覆盖式；同键只刷新 `detail`/`cwd`） */
  async upsert(input: LatticeDeviceWorkspaceInput): Promise<LatticeResult<LatticeDeviceWorkspace>> {
    if (!isLatticeWorkspaceType(input.type)) {
      return latticeFail({ status: 400, code: 'invalid_type', reason: 'type 只能是 index / portal', field: 'type' })
    }
    if (typeof input.instance !== 'string' || input.instance.trim() === '') {
      return latticeFail({
        status: 400,
        code: 'invalid_body',
        reason: 'instance 必填（ip:port）—— 要上报的是哪台机器上的工作区',
        field: 'instance',
      })
    }
    if (typeof input.detail !== 'string') {
      return latticeFail({ status: 400, code: 'invalid_body', reason: 'detail 必填（md 文本）', field: 'detail' })
    }
    if (input.type === 'index') {
      if (input.workspaceId !== undefined && input.workspaceId !== null) {
        return latticeFail({
          status: 400,
          code: 'invalid_workspace_shape',
          reason: 'type=index 时 workspaceId 必须为空（index 是"一台实例一条"的粒度）',
          field: 'workspaceId',
        })
      }
      if (input.cwd !== undefined && input.cwd !== null) {
        return latticeFail({
          status: 400,
          code: 'invalid_workspace_shape',
          reason: 'type=index 时 cwd 必须为空',
          field: 'cwd',
        })
      }
    } else {
      if (typeof input.workspaceId !== 'string' || input.workspaceId.trim() === '') {
        return latticeFail({
          status: 400,
          code: 'invalid_workspace_shape',
          reason: 'type=portal 时 workspaceId 必填',
          field: 'workspaceId',
        })
      }
      if (typeof input.cwd !== 'string' || input.cwd.trim() === '') {
        return latticeFail({
          status: 400,
          code: 'invalid_workspace_shape',
          reason: 'type=portal 时 cwd 必填',
          field: 'cwd',
        })
      }
    }
    const body = pick(input as unknown as Record<string, unknown>, UPSERT_KEYS)
    return this.transport.call<LatticeDeviceWorkspace>('workspaceUpsert', {}, { body })
  }

  /**
   * B16 `GET /device-workspaces`：按条件查（不分页）。
   *
   * 匹配语义：`accountId`/`instance`/`type`/`workspaceId` 精确；`cwd` 精确；`cwdPrefix` 前缀。
   * **不提供包含匹配**（`LIKE '%x%'` 会跨实例派错目标）。
   */
  async list(query: LatticeDeviceWorkspaceQuery = {}): Promise<LatticeResult<LatticeDeviceWorkspace[]>> {
    if (query.cwd !== undefined && query.cwdPrefix !== undefined) {
      return latticeFail({
        status: 400,
        code: 'invalid_request',
        reason: 'cwd 与 cwdPrefix 不能同时传（精确与前缀二选一）',
      })
    }
    if (query.type !== undefined && !isLatticeWorkspaceType(query.type)) {
      return latticeFail({ status: 400, code: 'invalid_type', reason: 'type 只能是 index / portal', field: 'type' })
    }
    const result = await this.transport.call<LatticeDeviceWorkspace[] | null>('workspaceList', {}, {
      query: {
        accountId: query.accountId,
        instance: query.instance,
        workspaceId: query.workspaceId,
        cwd: query.cwd,
        cwdPrefix: query.cwdPrefix,
        type: query.type,
      },
    })
    if (!result.ok) return result
    return latticeOk(result.status, Array.isArray(result.data) ? result.data : [])
  }
}
