import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyToggle, batchTarget, cloneSettings, effectiveState, emptyKind, emptySettings, normalizeSettings,
  type AbilityKindSettings,
} from '../src/shared/ability.ts'

const NONE: ReadonlySet<string> = new Set<string>()

describe('effectiveState', () => {
  it('默认启用', () => {
    assert.equal(effectiveState(emptyKind(), 'global', 'bash', NONE), 'enabled')
  })

  it('全局禁用后为 disabled', () => {
    const kind = emptyKind()
    kind.global.disabled.push('bash')
    assert.equal(effectiveState(kind, 'global', 'bash', NONE), 'disabled')
  })

  it('工作区未写过时继承全局', () => {
    const kind = emptyKind()
    kind.global.disabled.push('bash')
    assert.equal(effectiveState(kind, 'workspace', 'bash', NONE, 'ws1'), 'disabled')
  })

  it('工作区 enabled 覆盖全局禁用（仅非内置）', () => {
    const kind = emptyKind()
    kind.global.disabled.push('bash')
    kind.workspaces['ws1'] = { disabled: [], enabled: ['bash'] }
    assert.equal(effectiveState(kind, 'workspace', 'bash', NONE, 'ws1'), 'enabled')
  })

  it('内置禁用不可被 enabled 恢复', () => {
    const kind = emptyKind()
    kind.workspaces['ws1'] = { disabled: [], enabled: ['web_search'] }
    const builtin = new Set(['web_search'])
    assert.equal(effectiveState(kind, 'workspace', 'web_search', builtin, 'ws1'), 'builtin')
  })
})

describe('applyToggle — global', () => {
  it('enabled → 点一下写入 disabled', () => {
    const kind = emptyKind()
    assert.equal(applyToggle(kind, 'global', 'bash', NONE), true)
    assert.deepEqual(kind.global.disabled, ['bash'])
  })

  it('disabled → 点一下移除', () => {
    const kind = emptyKind()
    kind.global.disabled.push('bash')
    applyToggle(kind, 'global', 'bash', NONE)
    assert.deepEqual(kind.global.disabled, [])
  })

  it('内置禁用不可点', () => {
    const kind = emptyKind()
    assert.equal(applyToggle(kind, 'global', 'web_search', new Set(['web_search'])), false)
    assert.deepEqual(kind.global.disabled, [])
  })
})

describe('applyToggle — workspace', () => {
  it('enabled → 写入 ws.disabled 并清掉陈旧的 enabled', () => {
    const kind = emptyKind()
    kind.workspaces['ws1'] = { disabled: [], enabled: ['bash'] }
    applyToggle(kind, 'workspace', 'bash', NONE, 'ws1')
    assert.deepEqual(kind.workspaces['ws1'], { disabled: ['bash'], enabled: [] })
  })

  it('disabled 且全局也禁 → 用 enabled 捞回', () => {
    const kind = emptyKind()
    kind.global.disabled.push('bash')
    kind.workspaces['ws1'] = { disabled: ['bash'], enabled: [] }
    applyToggle(kind, 'workspace', 'bash', NONE, 'ws1')
    assert.deepEqual(kind.workspaces['ws1'], { disabled: [], enabled: ['bash'] })
  })

  it('disabled 且全局未禁 → 不写 enabled（顺手清陈旧项）', () => {
    const kind = emptyKind()
    kind.workspaces['ws1'] = { disabled: ['bash'], enabled: [] }
    applyToggle(kind, 'workspace', 'bash', NONE, 'ws1')
    assert.deepEqual(kind.workspaces['ws1'], { disabled: [], enabled: [] })
  })

  it('没有 workspaceId 时不改动', () => {
    const kind = emptyKind()
    assert.equal(applyToggle(kind, 'workspace', 'bash', NONE), false)
  })
})

describe('batchTarget', () => {
  it('不是全启用 → 目标是启用', () => {
    const kind = emptyKind()
    kind.global.disabled.push('bash')
    assert.equal(batchTarget(kind, 'global', ['bash', 'pwsh'], NONE), true)
  })

  it('全启用 → 目标是禁用', () => {
    assert.equal(batchTarget(emptyKind(), 'global', ['bash', 'pwsh'], NONE), false)
  })
})

describe('normalize / clone', () => {
  it('缺字段的 wire 值被补全', () => {
    const value = normalizeSettings({ tools: { global: { disabled: ['bash'] } } })
    assert.deepEqual(value.tools.global, { disabled: ['bash'], enabled: [] })
    assert.deepEqual(value.tools.workspaces, {})
    assert.deepEqual(value.skills, emptyKind())
  })

  it('clone 是深拷贝', () => {
    const kind: AbilityKindSettings = emptyKind()
    kind.global.disabled.push('bash')
    const copy = cloneSettings({ tools: kind, skills: emptyKind() })
    copy.tools.global.disabled.push('pwsh')
    assert.deepEqual(kind.global.disabled, ['bash'])
  })
})
