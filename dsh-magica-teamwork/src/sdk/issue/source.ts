/**
 * issue.source（C13–C16）：事件来源字典。
 *
 * - 对外参数名沿用 raw 的 `code`（模糊查），协议 query 名是 `q`；
 * - `register` 按 `code` upsert（同批重复由服务端去重，保留最后一条）。
 */

import type { LatticeTransport } from '../transport.js'
import { latticeOk, type LatticeResult } from '../result.js'
import type { LatticeSource, LatticeSourceInput } from '../types.js'
import { pick, toPositiveIntId, toSourceCode } from '../wire.js'

const SOURCE_KEYS = ['code', 'description', 'pluginName'] as const

export class LatticeSourceApi {
  constructor(private readonly transport: LatticeTransport) {}

  /** C13 `GET /issue-sources?q=`：查字典（`code` 省略 = 全部；服务端按 code/description 模糊） */
  async list(code?: string): Promise<LatticeResult<LatticeSource[]>> {
    const result = await this.transport.call<LatticeSource[] | null>('issueSourceList', {}, {
      query: code === undefined || code.trim() === '' ? {} : { q: code.trim() },
    })
    if (!result.ok) return result
    return latticeOk(result.status, Array.isArray(result.data) ? result.data : [])
  }

  /** C14 `POST /issue-sources/batch`：批量注册 / 更新（返回写入条数） */
  async register(batch: readonly LatticeSourceInput[]): Promise<LatticeResult<{ count: number }>> {
    if (batch.length === 0) return latticeOk(200, { count: 0 })
    const body: Record<string, unknown>[] = []
    for (const [index, item] of batch.entries()) {
      const checked = toSourceCode(item.code)
      if (!checked.ok) {
        return {
          ok: false,
          status: 400,
          code: 'invalid_source_code',
          reason: `${checked.fail.reason}（第 ${index} 条）`,
          field: 'code',
        }
      }
      body.push(pick(item as unknown as Record<string, unknown>, SOURCE_KEYS))
    }
    const result = await this.transport.call<{ count?: number }>('issueSourceRegister', {}, { body })
    if (!result.ok) return result
    return latticeOk(result.status, { count: typeof result.data?.count === 'number' ? result.data.count : 0 })
  }

  /** C15 `PUT /issue-sources/{id}`：改描述 / 插件名（administrator；`code` 不可改） */
  async update(
    id: number | string,
    patch: { description?: string | null; pluginName?: string | null },
  ): Promise<LatticeResult<LatticeSource>> {
    const checked = toPositiveIntId(id, 'id', 'invalid_request', '来源主键', '')
    if (!checked.ok) return checked.fail
    const body = pick(patch as Record<string, unknown>, ['description', 'pluginName'])
    return this.transport.call<LatticeSource>('issueSourceUpdate', { id: checked.value }, { body })
  }

  /** C16 `DELETE /issue-sources/{id}`：删来源（administrator；已有 issue 的 `source` 字符串不受影响） */
  async remove(id: number | string): Promise<LatticeResult<void>> {
    const checked = toPositiveIntId(id, 'id', 'invalid_request', '来源主键', '')
    if (!checked.ok) return checked.fail
    const result = await this.transport.call<void>('issueSourceDelete', { id: checked.value })
    if (!result.ok && result.status === 404) return { ...result, code: 'source_not_found' }
    return result
  }
}
