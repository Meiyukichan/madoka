import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DSH_BUILTIN_CATS, FIXED_CATS, catColor, categorizeSkill, categorizeTool, groupCount, groupRows, matchesRow,
} from '../src/client/categorize.ts'

describe('categorizeTool', () => {
  const none: string[] = []

  it('按名字分组', () => {
    assert.equal(categorizeTool('read', none), 'file')
    assert.equal(categorizeTool('grep', none), 'file')
    assert.equal(categorizeTool('pwsh', none), 'shell')
    assert.equal(categorizeTool('read_image', none), 'image')
    assert.equal(categorizeTool('subagent', none), 'agent')
    assert.equal(categorizeTool('job_output', none), 'job')
    assert.equal(categorizeTool('create_goal', none), 'goal')
    assert.equal(categorizeTool('cordis_inspect_list', none), 'cordis')
    assert.equal(categorizeTool('ask_user_question', none), 'misc')
    assert.equal(categorizeTool('present', none), 'misc')
    assert.equal(categorizeTool('mcp__context7__search', none), 'mcp')
  })

  it('dsh 原生但 raw 未单列的三种：web / workflow / plugin', () => {
    assert.equal(categorizeTool('web_search', none), 'web')
    assert.equal(categorizeTool('web_fetch', none), 'web')
    assert.equal(categorizeTool('workflow', none), 'workflow')
    assert.equal(categorizeTool('plugin_manager', none), 'plugin')
    for (const cat of ['web', 'workflow', 'plugin']) {
      assert.ok(DSH_BUILTIN_CATS.has(cat), cat + ' 应算 dsh 内置分类')
    }
  })

  it('动态前缀 → 首字母大写分类；无下划线 → plugin-other', () => {
    assert.equal(categorizeTool('sandore_craft', none), 'Sandore')
    assert.equal(categorizeTool('whatever', none), 'plugin-other')
  })

  it('内置禁用优先', () => {
    assert.equal(categorizeTool('web_search', ['web_search']), 'builtin')
  })
})

describe('categorizeSkill', () => {
  it('连字符前缀', () => {
    assert.equal(categorizeSkill('gc-brainstorming'), 'Gc')
    assert.equal(categorizeSkill('openpowers-tdd'), 'Openpowers')
  })

  it('无连字符用自身', () => {
    assert.equal(categorizeSkill('skill'), 'Skill')
  })
})

describe('catColor', () => {
  it('稳定：同一分类多次调用同色', () => {
    assert.equal(catColor('Sandore'), catColor('Sandore'))
  })

  it('内置分类统一橙；mcp 蓝；plugin-other 灰', () => {
    assert.equal(catColor('file'), 'var(--dsw-alias-state-warn-primary)')
    assert.equal(catColor('mcp'), 'var(--dsw-alias-state-business-primary)')
    assert.equal(catColor('plugin-other'), 'var(--dsw-alias-label-tertiary)')
  })
})

describe('groupRows', () => {
  const row = (name: string, category: string) => ({ name, description: '', category })

  it('动态分类 ≥2 独立成组、<2 并入 plugin-other（工具）', () => {
    const groups = groupRows([
      row('a_x', 'Alpha'), row('a_y', 'Alpha'),
      row('b_x', 'Beta'),
      row('read', 'file'),
    ], 'tools')
    const names = groups.map(group => group.category)
    assert.ok(names.includes('Alpha'), 'Alpha 有 2 个 → 独立')
    assert.ok(!names.includes('Beta'), 'Beta 只有 1 个 → 并入 plugin-other')
    assert.ok(names.includes('plugin-other'), '合并目标出现在结果里')
    assert.ok(names.includes('file'))
    assert.equal(names[0], 'Alpha', '动态分类排在最前')
    const merged = groups.find(group => group.category === 'plugin-other')
    assert.deepEqual(merged?.rows.map(item => item.name), ['b_x'])
  })

  it('技能并入 misc', () => {
    const groups = groupRows([row('only-one', 'Onlyone'), row('x-skill', 'X')], 'skills')
    const names = groups.map(group => group.category)
    assert.ok(!names.includes('Onlyone'))
    assert.ok(!names.includes('X'))
    assert.deepEqual(names, ['misc'])
    assert.deepEqual(groups[0]?.rows.map(item => item.name), ['only-one', 'x-skill'])
  })

  it('固定分类按 FIXED_CATS 顺序', () => {
    const groups = groupRows([row('read', 'file'), row('pwsh', 'shell'), row('mcp__a', 'mcp')], 'tools')
    const names = groups.map(group => group.category)
    assert.deepEqual(names, ['mcp', 'file', 'shell'])
    assert.ok(FIXED_CATS.indexOf('mcp') < FIXED_CATS.indexOf('file'))
  })

  it('组内按名字排序', () => {
    const groups = groupRows([row('write', 'file'), row('edit', 'file')], 'tools')
    assert.deepEqual(groups[0]?.rows.map(item => item.name), ['edit', 'write'])
  })
})

describe('groupCount', () => {
  it('全启用 / 部分 / 全禁用', () => {
    assert.deepEqual(groupCount(['enabled', 'enabled']), {
      enabled: 2, total: 2, allEnabled: true, someEnabled: false,
    })
    assert.deepEqual(groupCount(['enabled', 'disabled']), {
      enabled: 1, total: 2, allEnabled: false, someEnabled: true,
    })
    assert.deepEqual(groupCount(['disabled']), {
      enabled: 0, total: 1, allEnabled: false, someEnabled: false,
    })
  })
})

describe('matchesRow', () => {
  const row = { name: 'pwsh', description: '', category: 'shell' }

  it('空查询全部通过', () => {
    assert.equal(matchesRow(row, '', 'Shell'), true)
    assert.equal(matchesRow(row, '   ', 'Shell'), true)
  })

  it('按工具名匹配', () => {
    assert.equal(matchesRow(row, 'pws', 'Shell'), true)
    assert.equal(matchesRow(row, 'read', 'Shell'), false)
  })

  it('按分类标识匹配（英文）', () => {
    assert.equal(matchesRow(row, 'shell', 'Shell'), true)
  })

  it('按分类展示名匹配（中文）', () => {
    const file = { name: 'read', description: '', category: 'file' }
    assert.equal(matchesRow(file, '文件', '文件操作'), true)
    assert.equal(matchesRow(file, 'file', '文件操作'), true)
    assert.equal(matchesRow(file, 'shell', '文件操作'), false)
  })

  it('大小写不敏感', () => {
    assert.equal(matchesRow(row, 'PWSH', 'Shell'), true)
  })
})