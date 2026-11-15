import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  HARD_RESERVED, Policy, buildEffective, matches,
  type PolicyInput,
} from '../src/policy.ts'
import { emptyKind } from '../src/shared/ability.ts'

function policy(overrides: Partial<PolicyInput> = {}): Policy {
  return new Policy({
    toolBuiltin: [], toolNonDisableable: [], skillNonDisableable: [], ...overrides,
  })
}

describe('matches', () => {
  it('精确匹配', () => {
    assert.equal(matches(['bash'], 'bash'), true)
    assert.equal(matches(['bash'], 'pwsh'), false)
  })

  it('`*` 结尾是前缀匹配', () => {
    assert.equal(matches(['sandore_*'], 'sandore_craft'), true)
    assert.equal(matches(['sandore_*'], 'sandore'), false)
    assert.equal(matches(['sandore_*'], 'not_sandore_x'), false)
  })
})

describe('Policy.toolProtected', () => {
  it('run_code 恒受保护（配置删了也保护）', () => {
    assert.equal(policy().toolProtected('run_code'), true)
    assert.equal(HARD_RESERVED.has('run_code'), true)
  })

  it('名单命中即受保护', () => {
    assert.equal(policy({ toolNonDisableable: ['bash'] }).toolProtected('bash'), true)
    assert.equal(policy({ toolNonDisableable: ['sandore_*'] }).toolProtected('sandore_craft'), true)
  })

  it('普通工具不受保护', () => {
    assert.equal(policy().toolProtected('read'), false)
  })

  it('skill 侧只看技能名单', () => {
    const p = policy({ skillNonDisableable: ['cordis-plugin-development'] })
    assert.equal(p.skillProtected('cordis-plugin-development'), true)
    assert.equal(p.skillProtected('openpowers-tdd'), false)
  })
})

describe('buildEffective', () => {
  it('全局 = builtin ∪ disabled', () => {
    const kind = emptyKind()
    kind.global.disabled.push('bash')
    const gate = buildEffective(kind, new Set(['web_search']))
    assert.equal(gate.global.has('bash'), true)
    assert.equal(gate.global.has('web_search'), true)
    assert.equal(gate.global.has('read'), false)
  })

  it('enabled 能移除普通禁用', () => {
    const kind = emptyKind()
    kind.global.disabled.push('bash')
    kind.workspaces['ws1'] = { disabled: [], enabled: ['bash'] }
    const gate = buildEffective(kind, new Set())
    assert.equal(gate.workspaces.get('ws1')?.has('bash'), false)
  })

  it('enabled 不能移除内置禁用', () => {
    const kind = emptyKind()
    kind.workspaces['ws1'] = { disabled: [], enabled: ['web_search'] }
    const gate = buildEffective(kind, new Set(['web_search']))
    assert.equal(gate.global.has('web_search'), true)
    assert.equal(gate.workspaces.get('ws1')?.has('web_search'), true)
  })

  it('工作区 set 已折叠全局（不是差集）', () => {
    const kind = emptyKind()
    kind.global.disabled.push('bash')
    kind.workspaces['ws1'] = { disabled: ['pwsh'], enabled: [] }
    const gate = buildEffective(kind, new Set())
    const ws = gate.workspaces.get('ws1')
    assert.equal(ws?.has('bash'), true, '继承全局禁用')
    assert.equal(ws?.has('pwsh'), true, '叠加自身禁用')
  })
})
