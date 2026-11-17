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

/**
 * 一步账单（元）= (未缓存输入×cacheMiss + 缓存读×cacheHit + 输出×output) / 1e6。
 *
 * **口径（dsh `TokenUsage` 的契约，diff C16）**：dsh 的计数字段是**互斥**的 ——
 * `inputTokens` 只是**未缓存输入**，缓存段单独走 `cacheReadTokens` / `cacheWriteTokens`
 * （源码注释：`Counts are DISJOINT: inputTokens is uncached input only`）。
 * 所以这里直接相加，**不能**再减 `cacheReadTokens`：那样会把缓存读算两遍——
 * 首次是"少算"，缓存占比高时账单会明显偏低（早期版本就是这个错误）。
 * 若调用方手里是 provider 的 `prompt_tokens` 总数（含缓存），请先减去缓存段再传入。
 */
export function stepBill(
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | undefined,
  routeModel: string | undefined,
  table: PriceTable,
): number {
  if (usage === undefined) return 0
  const entry = priceForModel(routeModel, table)
  if (entry === undefined) return 0
  const cacheRead = usage.cacheReadTokens ?? 0
  const total = usage.inputTokens * entry.cacheMiss + cacheRead * entry.cacheHit + usage.outputTokens * entry.output
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
