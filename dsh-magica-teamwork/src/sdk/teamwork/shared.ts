/**
 * teamwork 分组共用的纯函数：分页归一 / 分页信封兜底 / 影响行数 / HTTP 码 → 业务码。
 *
 * 这些函数不碰 transport，单测可直接跑（设计文档 §3 `teamwork/shared.ts`）。
 */

import { castboardFail, type CastboardErrorCode, type CastboardFail } from '../result.js'
import { pageParams } from '../wire.js'
import type { CastboardTeamworkPage } from '../types.js'

/** 分页入参归一（非法值回落而不是报错，与服务端一致） */
export { pageParams }

/** 分页信封兜底：字段缺失/类型不对一律归一成空页 */
export function normalizePage<T>(data: unknown, fallback: { pageNum: number; pageSize: number }): CastboardTeamworkPage<T> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { total: 0, pageNum: fallback.pageNum, pageSize: fallback.pageSize, items: [] }
  }
  const raw = data as Record<string, unknown>
  const items = Array.isArray(raw['items']) ? (raw['items'] as T[]) : []
  const total = typeof raw['total'] === 'number' && Number.isFinite(raw['total']) ? raw['total'] : items.length
  const pageNum = typeof raw['pageNum'] === 'number' && raw['pageNum'] >= 1 ? raw['pageNum'] : fallback.pageNum
  const pageSize = typeof raw['pageSize'] === 'number' && raw['pageSize'] >= 1 ? raw['pageSize'] : fallback.pageSize
  return { total, pageNum, pageSize, items }
}

/** 把裸数组包成分页信封（`/projects/mine` 与 `/devices` 这类不分页端点用） */
export function pageOfArray<T>(items: readonly T[]): CastboardTeamworkPage<T> {
  return { total: items.length, pageNum: 1, pageSize: items.length, items: [...items] }
}

/** 影响行数归一：裸 `int`；`0` 是成功结果不是失败 */
export function affectedOf(data: unknown): number {
  if (typeof data === 'number' && Number.isFinite(data)) return Math.max(0, Math.floor(data))
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const raw = data as Record<string, unknown>
    for (const key of ['count', 'affected', 'synced']) {
      const value = raw[key]
      if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
    }
  }
  return 0
}

/** 只把 `http_error` 细分成具体业务码；`status` / `reason` / `body` 原样保留 */
export function mapFailure(result: CastboardFail, overrides: Partial<Record<number, CastboardErrorCode>>): CastboardFail {
  if (result.code !== 'http_error') return result
  const mapped = overrides[result.status]
  return mapped === undefined ? result : { ...result, code: mapped }
}

/** 400 的细分：命中 role 判角色错，其余判项目入参错（启发式，已在文档标注风险） */
export function invalidBodyCode(result: CastboardFail): CastboardErrorCode {
  if (result.status !== 400) return result.code
  return /role/i.test(`${result.reason} ${result.field ?? ''}`) ? 'invalid_role' : 'invalid_project'
}

/** 统一的"空 body 不允许"检查（`PUT` 至少给一个字段） */
export function emptyBodyFail(where: string): CastboardFail {
  return castboardFail({
    status: 400,
    code: 'invalid_body',
    reason: `${where} 至少要给一个字段；空 body 只会拿到原样记录`,
  })
}
