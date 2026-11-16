/**
 * 管理分组（M3–M6）：停机 / 账号列表 / 改全局角色 / 重置密码。
 *
 * 两个要点：
 *  - `shutdown()` 走 `local` 鉴权：**回环 + `X-Shutdown-Token`**（锁文件里的）或 administrator 双头；
 *    token 只走 header（不能在 query 里，会进访问日志）。
 *  - `resetPassword()` 的 `newPassword` 是明文入参，本层 base64；成功后该账号旧 token 全部失效。
 */

import type { LatticeTransport } from './transport.js'
import { latticeOk, type LatticeResult } from './result.js'
import { isLatticeGlobalRole, type LatticeAccount, type LatticeGlobalRole, type LatticeTeamworkPage } from './types.js'
import { toAccount } from './wire.js'
import { normalizePage, pageParams } from './teamwork/shared.js'
import { latticeFail } from './result.js'

export class LatticeAdminApi {
  constructor(private readonly transport: LatticeTransport) {}

  /** M6 `GET /admin/accounts`：账号列表（分页；绝不返回 `accountToken`） */
  async accounts(query: { q?: string; pageNum?: number; pageSize?: number } = {}): Promise<LatticeResult<LatticeTeamworkPage<LatticeAccount>>> {
    const { pageNum, pageSize } = pageParams(query)
    const result = await this.transport.call<unknown>('adminAccounts', {}, {
      query: { q: query.q, pageNum, pageSize },
    })
    if (!result.ok) return result
    return latticeOk(result.status, normalizePage<LatticeAccount>(result.data, { pageNum, pageSize }))
  }

  /** M4 `PUT /admin/accounts/{accountId}/role`：改全局角色（最后一个管理员不能降级） */
  async setRole(accountId: string, role: LatticeGlobalRole): Promise<LatticeResult<LatticeAccount>> {
    const account = toAccount(accountId, 'accountId', '')
    if (!account.ok) return account.fail
    if (!isLatticeGlobalRole(role)) {
      return latticeFail({
        status: 400,
        code: 'invalid_role',
        reason: 'role 只能是 administrator / leader / user',
        field: 'role',
      })
    }
    return this.transport.call<LatticeAccount>('adminSetRole', { accountId: account.value }, { body: { role } })
  }

  /** M5 `POST /admin/accounts/{accountId}/password`：管理员重置密码（204；旧 token 立即失效） */
  async resetPassword(accountId: string, newPassword: string): Promise<LatticeResult<void>> {
    const account = toAccount(accountId, 'accountId', '')
    if (!account.ok) return account.fail
    const encoded = Buffer.from(newPassword, 'utf8').toString('base64')
    return this.transport.call<void>('adminResetPassword', { accountId: account.value }, {
      body: { newPassword: encoded },
    })
  }

  /**
   * M3 `POST /admin/shutdown`：停机（202，异步停）。
   *
   * 两种通道：`shutdownToken`（锁文件里的，仅回环）或 administrator 双头。
   */
  async shutdown(options: { shutdownToken?: string } = {}): Promise<LatticeResult<{ ok: boolean; stopping: boolean }>> {
    const headers = options.shutdownToken === undefined ? undefined : { 'x-shutdown-token': options.shutdownToken }
    const result = await this.transport.call<{ ok?: boolean; stopping?: boolean }>('shutdown', {}, {
      ...(headers === undefined ? {} : { headers }),
    })
    if (!result.ok) return result
    return latticeOk(result.status, {
      ok: result.data?.ok === true,
      stopping: result.data?.stopping === true,
    })
  }
}
