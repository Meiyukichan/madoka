/**
 * 设备分组（B11 / B12）：全量同步 + 在线设备。
 *
 * 两个语义陷阱（旧实现踩过，注释必须留着）：
 *  1. `sync()` 是**全量同步**：先把该账号所有设备标 `inactive`，再 upsert 本批。
 *     **传空数组 = 把该用户所有设备下线**。
 *  2. 同批 `(host, port)` 重复会撞唯一键（服务端 500），本层不做去重（调用方自己保证）。
 *
 * `list()` 只回 `active`（派活寻址用）；要看含历史的全量请用 `teamwork.device.mine()`。
 */

import type { CastboardTransport } from './transport.js'
import { castboardOk, type CastboardResult } from './result.js'
import { type CastboardDevice, type CastboardDeviceInput } from './types.js'
import { toAccount } from './wire.js'

export class CastboardDeviceApi {
  constructor(private readonly transport: CastboardTransport) {}

  /**
   * B11 `POST /devices/batch`：全量同步我的设备。
   *
   * ⚠️ 传空数组等于"我这台机器下线了"——该账号所有设备会被标 `inactive`。
   */
  async sync(devices: readonly CastboardDeviceInput[]): Promise<CastboardResult<{ synced: number; deactivated: number }>> {
    const batch: Record<string, unknown>[] = []
    for (const [index, device] of devices.entries()) {
      if (typeof device.host !== 'string' || device.host.trim() === '') {
        return {
          ok: false,
          status: 400,
          code: 'invalid_body',
          reason: `devices[${index}].host 必填`,
          field: 'host',
        }
      }
      const port = device.port ?? 0
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
        return {
          ok: false,
          status: 400,
          code: 'invalid_body',
          reason: `devices[${index}].port 必须是 0..65535 的整数`,
          field: 'port',
        }
      }
      batch.push({
        host: device.host,
        port,
        ...(device.os === undefined ? {} : { os: device.os }),
      })
    }
    const result = await this.transport.call<{ synced?: number; deactivated?: number }>('deviceSync', {}, {
      body: { devices: batch },
    })
    if (!result.ok) return result
    return castboardOk(result.status, {
      synced: typeof result.data?.synced === 'number' ? result.data.synced : 0,
      deactivated: typeof result.data?.deactivated === 'number' ? result.data.deactivated : 0,
    })
  }

  /** B12 `GET /devices?accountId=`：在线设备（只含 `active`；省略 = 查自己） */
  async list(accountId?: string): Promise<CastboardResult<CastboardDevice[]>> {
    let query: Record<string, string> = {}
    if (accountId !== undefined) {
      const account = toAccount(accountId, 'accountId', '查他人设备时必须给合法账号')
      if (!account.ok) return account.fail
      query = { accountId: account.value }
    }
    const result = await this.transport.call<CastboardDevice[] | null>('deviceList', {}, { query })
    if (!result.ok) return result
    const items = Array.isArray(result.data) ? result.data : []
    return castboardOk(
      result.status,
      items.filter((item) => item.status === 'active'),
    )
  }
}
