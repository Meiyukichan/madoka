/**
 * 工作区索引的语义测试。
 *
 * 钉住「解析失败 ≠ 崩溃」：`cwd` 为空、目录不存在、路径不是已注册工作区根，
 * 都应安静退化成「无工作区」（此时门禁只看全局层），而不是抛错或留下脏映射。
 *
 * ⚠️ 这里**不**声称「解析失败会让工具重新出现」——全局层禁用时 deny 集仍非空，
 * mask 照样会挂上。工具重新出现的真实原因见 `restrict.ts` 的 `seedFromRegistry()`：
 * 插件晚于会话启用时，`agent/created` 没被我们观察到，那些 agent 从没进过索引。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { disabledToolsNotice, restrictWithFallback } from '../src/policy.ts'
import { GuardState } from '../src/state.ts'
import { installWorkspaceIndex } from '../src/workspace.ts'

interface FakeCtx {
  ctx: never
  handlers: Map<string, (payload?: unknown) => void>
}

/** 极简 ctx：只实现本模块用到的 effect / on / get / logger。 */
function makeCtx(registry: unknown): FakeCtx {
  const handlers = new Map<string, (payload?: unknown) => void>()
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    get: (name: string) => (name === 'workspaceRegistry' ? registry : undefined),
    on: (event: string, handler: (payload?: unknown) => void) => {
      handlers.set(event, handler)
      return () => { handlers.delete(event) }
    },
    effect: (fn: () => () => void) => fn(),
  }
  return { ctx: ctx as never, handlers }
}

const agentEvent = (id: string, cwd: string) => ({ agent: { id, session: { header: { cwd } } } })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('installWorkspaceIndex', () => {
  it('解析成功 → 落表', async () => {
    const { ctx, handlers } = makeCtx({ resolveByPath: async () => ({ id: 'ws-1' }) })
    const state = new GuardState()
    installWorkspaceIndex(ctx, state)

    handlers.get('agent/created')!(agentEvent('a1', 'D:\\work'))
    await tick()
    assert.equal(state.agentWorkspace.get('a1'), 'ws-1')
  })

  it('路径不是已注册工作区（resolve 返回 undefined）→ 不留映射', async () => {
    const { ctx, handlers } = makeCtx({ resolveByPath: async () => undefined })
    const state = new GuardState()
    installWorkspaceIndex(ctx, state)

    handlers.get('agent/created')!(agentEvent('a2', 'D:\\work\\sub'))
    await tick()
    assert.equal(state.agentWorkspace.has('a2'), false)
  })

  it('resolveByPath 抛错（目录不存在 / 路径未完全限定）→ 吞掉且不留映射', async () => {
    const { ctx, handlers } = makeCtx({
      resolveByPath: async () => { throw new Error('ENOENT') },
    })
    const state = new GuardState()
    installWorkspaceIndex(ctx, state)

    handlers.get('agent/created')!(agentEvent('a3', 'D:\\gone'))
    await tick()
    assert.equal(state.agentWorkspace.has('a3'), false)
  })

  it('cwd 为空 → 不调用 registry，也不留映射', async () => {
    let called = 0
    const { ctx, handlers } = makeCtx({
      resolveByPath: async () => { called += 1; return { id: 'ws-1' } },
    })
    const state = new GuardState()
    installWorkspaceIndex(ctx, state)

    handlers.get('agent/created')!(agentEvent('a4', ''))
    await tick()
    assert.equal(called, 0)
    assert.equal(state.agentWorkspace.has('a4'), false)
  })

  it('agent/disposed 清理映射', async () => {
    const { ctx, handlers } = makeCtx({ resolveByPath: async () => ({ id: 'ws-1' }) })
    const state = new GuardState()
    installWorkspaceIndex(ctx, state)

    handlers.get('agent/created')!(agentEvent('a5', 'D:\\work'))
    await tick()
    assert.equal(state.agentWorkspace.get('a5'), 'ws-1')

    handlers.get('agent/disposed')!({ agent: { id: 'a5' } })
    assert.equal(state.agentWorkspace.has('a5'), false)
  })
})
describe('restrictWithFallback（不让一个坏名字毒死整批）', () => {
  const ownLayer = new Set(['subagent', 'subagent_fork'])

  /** 模拟 DSH 的 restrict：整批里只要有一个不可 restrict 的名字就整体抛错。 */
  const makeRestrict = (applied: string[][]) => (names: string[]) => {
    const bad = names.filter(name => ownLayer.has(name))
    if (bad.length > 0) throw new Error(`tools.restrict() names unknown global tool "${bad[0]}"`)
    applied.push(names)
  }

  it('整批可 restrict → 一次调用、无跳过', () => {
    const applied: string[][] = []
    const skipped = restrictWithFallback(makeRestrict(applied), ['plugin_manager', 'workflow'])
    assert.deepEqual(skipped, [])
    assert.deepEqual(applied, [['plugin_manager', 'workflow']])
  })

  it('整批含不可 restrict 的名字 → 逐名降级，其余仍然生效', () => {
    const applied: string[][] = []
    const skipped = restrictWithFallback(
      makeRestrict(applied),
      ['plugin_manager', 'subagent', 'workflow'],
    )
    assert.deepEqual(skipped, ['subagent'])
    assert.deepEqual(applied, [['plugin_manager'], ['workflow']])
  })

  it('全部不可 restrict → 全部跳过，不抛错', () => {
    const applied: string[][] = []
    const skipped = restrictWithFallback(makeRestrict(applied), ['subagent', 'subagent_fork'])
    assert.deepEqual(skipped, ['subagent', 'subagent_fork'])
    assert.deepEqual(applied, [])
  })

  it('空名单 → 不调用', () => {
    const applied: string[][] = []
    assert.deepEqual(restrictWithFallback(makeRestrict(applied), []), [])
    assert.deepEqual(applied, [])
  })
})
describe('disabledToolsNotice（第三层文本兜底）', () => {
  it('空名单 → 空串（调用方据此跳过注入）', () => {
    assert.equal(disabledToolsNotice([]), '')
  })

  it('有名字 → 明确列出并禁止调用', () => {
    const text = disabledToolsNotice(['workflow', 'subagent'])
    assert.match(text, /workflow, subagent/)
    assert.match(text, /Do not call them/)
    assert.match(text, /rejected before execution/)
  })
})