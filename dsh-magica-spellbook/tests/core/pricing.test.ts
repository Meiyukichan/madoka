import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PRICE_TABLE_VERSION,
  loadPriceTable,
  priceForModel,
  stepBill,
  stepOutputBill,
} from '../../src/core/pricing.ts'

describe('pricing', () => {
  const table = loadPriceTable()

  it('内置表可用且版本为正整数', () => {
    assert.ok(table.length >= 5)
    assert.equal(PRICE_TABLE_VERSION, 1)
  })

  it('第一层：模型名包含匹配（最长优先）', () => {
    assert.equal(priceForModel('GLM-5.2-Auto(BaiLian)', table)?.model, 'glm-5.2')
    assert.equal(priceForModel('deepseek-v4-flash', table)?.model, 'deepseek-v4-flash')
  })

  it('第二层：家族兜底', () => {
    assert.equal(priceForModel('GLM-5.9-Foo', table)?.family, 'glm')
  })

  it('第三层：未知模型落到 deepseek flash', () => {
    assert.equal(priceForModel('SomeUnknownModel', table)?.model, 'deepseek-v4-flash')
    assert.equal(priceForModel(undefined, table)?.model, 'deepseek-v4-flash')
  })

  it('stepBill 三档计费（usage 计数互斥：inputTokens 只含未缓存输入）', () => {
    const entry = priceForModel('deepseek-v4-flash', table)
    assert.ok(entry !== undefined)
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 500_000 }
    // dsh `TokenUsage`：inputTokens 是**未缓存**输入，缓存读单独计（diff C16）
    const expected = (1_000_000 * entry.cacheMiss + 500_000 * entry.cacheHit + 1_000_000 * entry.output) / 1_000_000
    assert.equal(stepBill(usage, 'deepseek-v4-flash', table), expected)
    assert.equal(stepBill(undefined, 'x', table), 0)
    assert.equal(stepOutputBill({ outputTokens: 1_000_000 }, 'deepseek-v4-flash', table), entry.output)
  })

  it('缓存读不会被漏算（回归：早期实现减 cacheRead 导致少算）', () => {
    const entry = priceForModel('deepseek-v4-flash', table)
    assert.ok(entry !== undefined)
    const base = { inputTokens: 1_000_000, outputTokens: 0 }
    const withCache = stepBill({ ...base, cacheReadTokens: 500_000 }, 'deepseek-v4-flash', table)
    const withoutCache = stepBill(base, 'deepseek-v4-flash', table)
    assert.ok(withCache > withoutCache, '缓存读档位必须叠加，不能被减掉')
    assert.equal(withCache - withoutCache, (500_000 * entry.cacheHit) / 1_000_000)
  })

  it('未知路径返回空表，账单为 0', () => {
    assert.deepEqual(loadPriceTable('definitely-missing.json'), [])
    assert.equal(stepBill({ inputTokens: 1, outputTokens: 1 }, 'x', []), 0)
  })
})
