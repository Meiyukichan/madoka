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
