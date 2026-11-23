/**
 * teamwork.device（B13 / B14）：我的设备（含 `inactive`）与删设备。
 *
 * 与 `device.ts`（`deviceList` / `deviceSync`）的分工：
 *  - `device.list()` = **在线**设备（B12，派活寻址用）；
 *  - `teamwork.device.mine()` = **我的全部**设备（B13，管理页面用，含历史）。
 * 这两个差别是刻意的，别合并。
 */

import type { CastboardTransport } from '../transport.js'
import { castboardOk, type CastboardResult } from '../result.js'
import type { CastboardDevice, CastboardDevicePageQuery, CastboardTeamworkPage } from '../types.js'
import { toDeviceId } from '../wire.js'
import { mapFailure, normalizePage, pageParams } from './shared.js'

export class CastboardTeamworkDeviceApi {
  constructor(private readonly transport: CastboardTransport) {}

  /** B13 `GET /devices/mine`：我的设备（分页，含 `inactive`） */
  async mine(query: CastboardDevicePageQuery = {}): Promise<CastboardResult<CastboardTeamworkPage<CastboardDevice>>> {
    const { pageNum, pageSize } = pageParams(query)
    const result = await this.transport.call<unknown>('teamworkDeviceMine', {}, { query: { pageNum, pageSize } })
    if (!result.ok) return result
    return castboardOk(result.status, normalizePage<CastboardDevice>(result.data, { pageNum, pageSize }))
  }

  /** B14 `DELETE /devices/{id}`：删设备（删别人的设备服务端也返回 204，不做资源级鉴权） */
  async remove(deviceId: number | string): Promise<CastboardResult<void>> {
    const id = toDeviceId(deviceId)
    if (!id.ok) return id.fail
    const result = await this.transport.call<void>('teamworkDeviceDelete', { id: id.value })
    if (!result.ok) return mapFailure(result, { 404: 'device_not_found' })
    return result
  }
}
