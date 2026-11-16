/**
 * teamwork.device（B13 / B14）：我的设备（含 `inactive`）与删设备。
 *
 * 与 `device.ts`（`deviceList` / `deviceSync`）的分工：
 *  - `device.list()` = **在线**设备（B12，派活寻址用）；
 *  - `teamwork.device.mine()` = **我的全部**设备（B13，管理页面用，含历史）。
 * 这两个差别是刻意的，别合并。
 */

import type { LatticeTransport } from '../transport.js'
import { latticeOk, type LatticeResult } from '../result.js'
import type { LatticeDevice, LatticeDevicePageQuery, LatticeTeamworkPage } from '../types.js'
import { toDeviceId } from '../wire.js'
import { mapFailure, normalizePage, pageParams } from './shared.js'

export class LatticeTeamworkDeviceApi {
  constructor(private readonly transport: LatticeTransport) {}

  /** B13 `GET /devices/mine`：我的设备（分页，含 `inactive`） */
  async mine(query: LatticeDevicePageQuery = {}): Promise<LatticeResult<LatticeTeamworkPage<LatticeDevice>>> {
    const { pageNum, pageSize } = pageParams(query)
    const result = await this.transport.call<unknown>('teamworkDeviceMine', {}, { query: { pageNum, pageSize } })
    if (!result.ok) return result
    return latticeOk(result.status, normalizePage<LatticeDevice>(result.data, { pageNum, pageSize }))
  }

  /** B14 `DELETE /devices/{id}`：删设备（删别人的设备服务端也返回 204，不做资源级鉴权） */
  async remove(deviceId: number | string): Promise<LatticeResult<void>> {
    const id = toDeviceId(deviceId)
    if (!id.ok) return id.fail
    const result = await this.transport.call<void>('teamworkDeviceDelete', { id: id.value })
    if (!result.ok) return mapFailure(result, { 404: 'device_not_found' })
    return result
  }
}
