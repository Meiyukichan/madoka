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

import type { CastboardTransport } from '../transport.js'
import { castboardFail, castboardOk, type CastboardResult } from '../result.js'
import type {
  CastboardDeviceWorkspace,
  CastboardDeviceWorkspaceInput,
  CastboardDeviceWorkspaceQuery,
} from '../types.js'
import { isCastboardWorkspaceType } from '../types.js'
import { pick } from '../wire.js'

const UPSERT_KEYS = ['instance', 'workspaceId', 'cwd', 'type', 'detail'] as const

export class CastboardWorkspaceApi {
  constructor(private readonly transport: CastboardTransport) {}

  /** B15 `POST /device-workspaces`：上报一条（覆盖式；同键只刷新 `detail`/`cwd`） */
  async upsert(input: CastboardDeviceWorkspaceInput): Promise<CastboardResult<CastboardDeviceWorkspace>> {
    if (!isCastboardWorkspaceType(input.type)) {
      return castboardFail({ status: 400, code: 'invalid_type', reason: 'type 只能是 index / portal', field: 'type' })
    }
    if (typeof input.instance !== 'string' || input.instance.trim() === '') {
      return castboardFail({
        status: 400,
        code: 'invalid_body',
        reason: 'instance 必填（ip:port）—— 要上报的是哪台机器上的工作区',
        field: 'instance',
      })
    }
    if (typeof input.detail !== 'string') {
      return castboardFail({ status: 400, code: 'invalid_body', reason: 'detail 必填（md 文本）', field: 'detail' })
    }
    if (input.type === 'index') {
      if (input.workspaceId !== undefined && input.workspaceId !== null) {
        return castboardFail({
          status: 400,
          code: 'invalid_workspace_shape',
          reason: 'type=index 时 workspaceId 必须为空（index 是"一台实例一条"的粒度）',
          field: 'workspaceId',
        })
      }
      if (input.cwd !== undefined && input.cwd !== null) {
        return castboardFail({
          status: 400,
          code: 'invalid_workspace_shape',
          reason: 'type=index 时 cwd 必须为空',
          field: 'cwd',
        })
      }
    } else {
      if (typeof input.workspaceId !== 'string' || input.workspaceId.trim() === '') {
        return castboardFail({
          status: 400,
          code: 'invalid_workspace_shape',
          reason: 'type=portal 时 workspaceId 必填',
          field: 'workspaceId',
        })
      }
      if (typeof input.cwd !== 'string' || input.cwd.trim() === '') {
        return castboardFail({
          status: 400,
          code: 'invalid_workspace_shape',
          reason: 'type=portal 时 cwd 必填',
          field: 'cwd',
        })
      }
    }
    const body = pick(input as unknown as Record<string, unknown>, UPSERT_KEYS)
    return this.transport.call<CastboardDeviceWorkspace>('workspaceUpsert', {}, { body })
  }

  /**
   * B16 `GET /device-workspaces`：按条件查（不分页）。
   *
   * 匹配语义：`accountId`/`instance`/`type`/`workspaceId` 精确；`cwd` 精确；`cwdPrefix` 前缀。
   * **不提供包含匹配**（`LIKE '%x%'` 会跨实例派错目标）。
   */
  async list(query: CastboardDeviceWorkspaceQuery = {}): Promise<CastboardResult<CastboardDeviceWorkspace[]>> {
    if (query.cwd !== undefined && query.cwdPrefix !== undefined) {
      return castboardFail({
        status: 400,
        code: 'invalid_request',
        reason: 'cwd 与 cwdPrefix 不能同时传（精确与前缀二选一）',
      })
    }
    if (query.type !== undefined && !isCastboardWorkspaceType(query.type)) {
      return castboardFail({ status: 400, code: 'invalid_type', reason: 'type 只能是 index / portal', field: 'type' })
    }
    const result = await this.transport.call<CastboardDeviceWorkspace[] | null>('workspaceList', {}, {
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
    return castboardOk(result.status, Array.isArray(result.data) ? result.data : [])
  }
}
