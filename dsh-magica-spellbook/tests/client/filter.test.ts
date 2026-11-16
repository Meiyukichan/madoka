import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { filterEntries, prefixWithin, tailPrefixOf } from '../../src/client/directory-browser/filter.ts'

const entries = [
  { name: 'src', path: 'D:\\p\\src' },
  { name: 'scripts', path: 'D:\\p\\scripts' },
  { name: 'docs', path: 'D:\\p\\docs' },
  { name: 'secret', path: 'D:\\p\\secret', hidden: true },
]

describe('tailPrefixOf', () => {
  it('取最后一段（正反斜杠都算）', () => {
    assert.equal(tailPrefixOf('D:\\p\\scr'), 'scr')
    assert.equal(tailPrefixOf('/home/me/scr'), 'scr')
    assert.equal(tailPrefixOf('scr'), 'scr')
  })

  it('以分隔符结尾 / 空串 → 不过滤', () => {
    assert.equal(tailPrefixOf('D:\\p\\'), '')
    assert.equal(tailPrefixOf(''), '')
    assert.equal(tailPrefixOf('D:\\'), '')
  })

  it('前后空白被去掉', () => {
    assert.equal(tailPrefixOf('D:\\p\\  src  '), 'src')
  })
})

describe('filterEntries', () => {
  it('空前缀 = 只按隐藏项过滤', () => {
    assert.deepEqual(filterEntries(entries, '', false).map((e) => e.name), ['src', 'scripts', 'docs'])
    assert.deepEqual(filterEntries(entries, '', true).map((e) => e.name), ['src', 'scripts', 'docs', 'secret'])
  })

  it('前缀过滤（默认忽略大小写）', () => {
    assert.deepEqual(filterEntries(entries, 'scr', false).map((e) => e.name), ['scripts'])
    assert.deepEqual(filterEntries(entries, 'SRC', false).map((e) => e.name), ['src'])
  })

  it('选中项始终保留（避免过滤把焦点锚点弄丢）', () => {
    assert.deepEqual(
      filterEntries(entries, 'zzz', false, 'D:\\p\\docs').map((e) => e.name),
      ['docs'],
    )
  })

  it('大小写敏感模式', () => {
    assert.deepEqual(filterEntries(entries, 'SRC', false, undefined, false).map((e) => e.name), [])
  })

  it('返回类型保留原条目（泛型不丢字段）', () => {
    const filtered = filterEntries(entries, '', true)
    assert.equal(filtered.length, 4)
    assert.equal(filtered[3]?.hidden, true)
  })
})

describe('prefixWithin（路径编辑不能把列表弄空）', () => {
  const dir = 'D:\\p'
  it('草稿 = 当前层目录全路径 → 前缀为空（不过滤）', () => {
    assert.equal(prefixWithin(dir, 'D:\\p'), '')
    assert.equal(prefixWithin(dir, 'D:\\p\\'), '')
  })

  it('草稿 = 目录 + 子串 → 只取第一段作前缀', () => {
    assert.equal(prefixWithin(dir, 'D:\\p\\s'), 's')
    assert.equal(prefixWithin(dir, 'D:\\p\\src\\x'), 'src')
  })

  it('草稿是完全不同的路径 → 退回 tailPrefixOf', () => {
    assert.equal(prefixWithin(dir, 'D:\\other\\doc'), 'doc')
    assert.equal(prefixWithin(undefined, 'D:\\other\\doc'), 'doc')
  })

  it('前导斜杠差异不误判（D:/p vs D:\\p）', () => {
    assert.equal(prefixWithin('D:/p', 'D:/p/scr'), 'scr')
  })
})