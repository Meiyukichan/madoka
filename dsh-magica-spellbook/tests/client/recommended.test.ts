import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseRecommended } from '../../src/client/panel/recommended.ts'

describe('parseRecommended', () => {
  it('英文后缀 (Recommended)', () => {
    assert.deepEqual(parseRecommended('方案 A (Recommended)'), { clean: '方案 A', recommended: true })
    assert.deepEqual(parseRecommended('A(Recommended)'), { clean: 'A', recommended: true })
  })

  it('中文后缀（推荐）/ (推荐)', () => {
    assert.deepEqual(parseRecommended('方案 A（推荐）'), { clean: '方案 A', recommended: true })
    assert.deepEqual(parseRecommended('方案 A (推荐)'), { clean: '方案 A', recommended: true })
  })

  it('普通标签原样返回', () => {
    assert.deepEqual(parseRecommended('方案 B'), { clean: '方案 B', recommended: false })
    assert.deepEqual(parseRecommended(''), { clean: '', recommended: false })
  })

  it('纯后缀不当推荐（clean 为空时回退原文，避免出现空标签）', () => {
    assert.deepEqual(parseRecommended('(Recommended)'), { clean: '(Recommended)', recommended: false })
  })

  it('答回宿主的仍是纯标签（后缀必须去掉，否则宿主按 label 匹配会答非所问）', () => {
    const parsed = parseRecommended('部署到预发（推荐）')
    assert.equal(parsed.clean, '部署到预发')
    assert.equal(parsed.recommended, true)
  })
})

describe('parseRecommended 的 旧实现 并集口径（diff D9）', () => {
  it('小写后缀也识别', () => {
    assert.deepEqual(parseRecommended('Allow (recommended)'), { clean: 'Allow', recommended: true })
  })

  it('全角括号 + 英文后缀', () => {
    assert.deepEqual(parseRecommended('Allow（Recommended）'), { clean: 'Allow', recommended: true })
  })

  it('后缀前空白被吞掉', () => {
    assert.deepEqual(parseRecommended('Allow   (Recommended)  '), { clean: 'Allow', recommended: true })
  })
})