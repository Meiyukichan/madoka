import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GuardState } from '../src/state.ts'
import { emptyKind } from '../src/shared/ability.ts'

function state(): GuardState {
  const value = new GuardState()
  value.sync({
    tools: emptyKind(),
    skills: emptyKind(),
    builtinDisabled: [],
    nonDisableable: ['sandore_*'],
    skillNonDisableable: ['cordis-plugin-development'],
  })
  return value
}

describe('GuardState — 工具门禁', () => {
  it('无 agentId 时只看全局', () => {
    const s = state()
    const tools = emptyKind()
    tools.global.disabled.push('bash')
    s.sync({ tools, skills: emptyKind(), builtinDisabled: [], nonDisableable: [], skillNonDisableable: [] })
    assert.equal(s.denied(undefined, 'bash'), true)
  })

  it('agentWorkspace 未命中 → 回退全局', () => {
    const s = state()
    const tools = emptyKind()
    tools.global.disabled.push('bash')
    s.sync({ tools, skills: emptyKind(), builtinDisabled: [], nonDisableable: [], skillNonDisableable: [] })
    assert.equal(s.denied('unknown-agent', 'bash'), true)
  })

  it('工作区配置按 agentId 生效', () => {
    const s = state()
    const tools = emptyKind()
    tools.workspaces['ws1'] = { disabled: ['pwsh'], enabled: [] }
    s.sync({ tools, skills: emptyKind(), builtinDisabled: [], nonDisableable: [], skillNonDisableable: [] })
    s.agentWorkspace.set('a1', 'ws1')
    s.agentWorkspace.set('a2', 'ws2')
    assert.equal(s.denied('a1', 'pwsh'), true, '命中 ws1')
    assert.equal(s.denied('a2', 'pwsh'), false, 'ws2 无配置')
  })

  it('受保护的名字恒 false（含 run_code）', () => {
    const s = state()
    const tools = emptyKind()
    tools.global.disabled.push('run_code', 'sandore_craft')
    s.sync({
      tools, skills: emptyKind(), builtinDisabled: [],
      nonDisableable: ['sandore_*'], skillNonDisableable: [],
    })
    assert.equal(s.denied(undefined, 'run_code'), false)
    assert.equal(s.denied(undefined, 'sandore_craft'), false)
  })

  it('工作区 enabled 捞回全局禁用（不先查 global）', () => {
    const s = state()
    const tools = emptyKind()
    tools.global.disabled.push('bash')
    tools.workspaces['ws1'] = { disabled: [], enabled: ['bash'] }
    s.sync({ tools, skills: emptyKind(), builtinDisabled: [], nonDisableable: [], skillNonDisableable: [] })
    s.agentWorkspace.set('a1', 'ws1')
    assert.equal(s.denied('a1', 'bash'), false)
    assert.equal(s.denied('a2', 'bash'), true)
  })
})

describe('GuardState — restrict 集合', () => {
  it('restrictableNamesFor 剔除受保护项', () => {
    const s = state()
    const tools = emptyKind()
    tools.global.disabled.push('bash', 'sandore_craft', 'run_code')
    s.sync({
      tools, skills: emptyKind(), builtinDisabled: [],
      nonDisableable: ['sandore_*'], skillNonDisableable: [],
    })
    assert.deepEqual(s.restrictableNamesFor(undefined).sort(), ['bash'])
    assert.deepEqual([...s.effectiveNamesFor(undefined)].sort(), ['bash'])
  })
})

describe('GuardState — skill 门禁', () => {
  it('受保护的 skill 恒 false', () => {
    const s = state()
    const skills = emptyKind()
    skills.global.disabled.push('cordis-plugin-development', 'some-skill')
    s.sync({
      tools: emptyKind(), skills, builtinDisabled: [],
      nonDisableable: [], skillNonDisableable: ['cordis-plugin-development'],
    })
    assert.equal(s.isSkillDenied(undefined, 'cordis-plugin-development'), false)
    assert.equal(s.isSkillDenied(undefined, 'some-skill'), true)
    assert.deepEqual(s.effectiveSkillNames(undefined), ['some-skill'])
  })
})

describe('GuardState — 目录缓存', () => {
  it('internalTools 只增不减', () => {
    const s = state()
    s.updateInternalTools([{ name: 'read', description: 'a' }, { name: 'bash', description: 'b' }])
    s.updateInternalTools([{ name: 'read', description: 'a' }])
    assert.equal(s.internalTools.size, 2)
  })

  it('描述变化会更新', () => {
    const s = state()
    s.updateInternalTools([{ name: 'read', description: 'old' }])
    s.updateInternalTools([{ name: 'read', description: 'new' }])
    assert.equal(s.internalTools.get('read')?.description, 'new')
  })

  it('skillDescCache 首次写入后不再覆盖', () => {
    const s = state()
    s.updateSkillDesc([{ name: 'x', description: '原始' }])
    s.updateSkillDesc([{ name: 'x', description: '(disabled)' }])
    assert.equal(s.skillDescCache.get('x')?.description, '原始')
  })
})
