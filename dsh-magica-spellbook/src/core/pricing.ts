/**
 * 定价与账单（token → 元）。
 *
 * 单文件模块：内置定价表以常量形式内联（单文件产物 `lib/index.js` 约束下不能靠旁路 JSON 资产）。
 *
 * 官方只有 token 数估算（`ctx.tokenMeter`，明确"非 billing record"）与图片视觉 token 定价，
 * **货币级 ¥/token 定价表官方没有**，所以由 SDK 提供。
 *
 * @module dsh-magica-spellbook/core/pricing
 */

import { readFileSync } from 'node:fs'

/** 表里的一行。 */
export interface PriceEntry {
  /** 厂商族（deepseek / glm / qwen / kimi / minimax …）。 */
  family: string
  /** 模型名（normalize 后参与包含匹配）。 */
  model: string
  /** 输入缓存命中价（元 / 百万 token）。 */
  cacheHit: number
  /** 输入缓存未命中价。 */
  cacheMiss: number
  /** 输出价。 */
  output: number
}

/** 定价表。 */
export type PriceTable = readonly PriceEntry[]

/** 内置表版本（写进诊断快照，便于定位"账单为 0 是因为表里没这个模型"）。 */
export const PRICE_TABLE_VERSION = 1

const BUILTIN_TABLE: PriceTable = [
  { family: 'deepseek', model: 'deepseek-v4-flash', cacheHit: 0.5, cacheMiss: 2, output: 8 },
  { family: 'deepseek', model: 'deepseek-v4', cacheHit: 2, cacheMiss: 8, output: 24 },
  { family: 'glm', model: 'glm-5.2', cacheHit: 1.5, cacheMiss: 6, output: 20 },
  { family: 'glm', model: 'glm-5.3', cacheHit: 1.5, cacheMiss: 6, output: 20 },
  { family: 'qwen', model: 'qwen3-max', cacheHit: 2.4, cacheMiss: 9.6, output: 38.4 },
  { family: 'kimi', model: 'kimi-k2.6', cacheHit: 1.2, cacheMiss: 4.8, output: 19.2 },
  { family: 'minimax', model: 'minimax-m2', cacheHit: 1, cacheMiss: 4, output: 16 },
]

let cachedDefault: PriceTable | null = null

function normalize(text: string): string {
  return text.toLowerCase().replace(/-/g, '')
}

/** 读价格表：不传路径读内置表（闭包缓存）；传路径则每次读盘（失败返空表）。 */
export function loadPriceTable(filePath?: string): PriceTable {
  if (filePath === undefined) {
    cachedDefault ??= BUILTIN_TABLE
    return cachedDefault
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    if (Array.isArray(parsed)) return parsed as PriceTable
    const entries = (parsed as { entries?: unknown }).entries
    return Array.isArray(entries) ? (entries as PriceTable) : []
  } catch {
    return []
  }
}

/**
 * 按路由模型名匹配价格：三层回退（model 最长匹配 → family → deepseek-flash）。
 * @param routeModel - 路由模型名（如 `GLM-5.2-Auto(BaiLian)`）。
 * @param table - 定价表。
 */
export function priceForModel(routeModel: string | undefined, table: PriceTable): PriceEntry | undefined {
  if (routeModel === undefined || routeModel === '') return fallbackOf(table)
  const needle = normalize(routeModel)

  let best: PriceEntry | undefined
  let bestLength = 0
  for (const entry of table) {
    const candidate = normalize(entry.model)
    if (candidate === '' || !needle.includes(candidate)) continue
    if (candidate.length > bestLength) {
      best = entry
      bestLength = candidate.length
    }
  }
  if (best !== undefined) return best

  for (const entry of table) {
    const family = normalize(entry.family)
    if (family === '' || !needle.includes(family)) continue
    return entry
  }
  return fallbackOf(table)
}

function fallbackOf(table: PriceTable): PriceEntry | undefined {
  for (const entry of table) {
    if (normalize(entry.family) === 'deepseek' && normalize(entry.model).includes('flash')) return entry
  }
  for (const entry of table) {
    if (normalize(entry.family) === 'deepseek') return entry
  }
  return table[0]
}

/** 一步账单（元）= (input×cacheMiss + cacheRead×cacheHit + output×output) / 1e6。 */
export function stepBill(
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | undefined,
  routeModel: string | undefined,
  table: PriceTable,
): number {
  if (usage === undefined) return 0
  const entry = priceForModel(routeModel, table)
  if (entry === undefined) return 0
  const cacheRead = usage.cacheReadTokens ?? 0
  const missInput = Math.max(0, usage.inputTokens - cacheRead)
  const total = missInput * entry.cacheMiss + cacheRead * entry.cacheHit + usage.outputTokens * entry.output
  return total / 1_000_000
}

/** 一步的 output 部分账单（元）。 */
export function stepOutputBill(
  usage: { outputTokens: number } | undefined,
  routeModel: string | undefined,
  table: PriceTable,
): number {
  if (usage === undefined) return 0
  const entry = priceForModel(routeModel, table)
  if (entry === undefined) return 0
  return (usage.outputTokens * entry.output) / 1_000_000
}
