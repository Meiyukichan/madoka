/**
 * 回归测试：禁用后工具**不能**重新出现在模型工具表里。
 *
 * 现场症状（线上复现过）：
 * 1. 在工作区层禁用 `web_fetch` → 工具从模型工具表消失（mask 生效）；
 * 2. 工作区映射因一次解析失败被删掉 → 目标禁用集算成空；
 * 3. `restrict.refresh()` 先 dispose 旧 mask、再发现目标集为空就 return →
 *    mask 永久丢失，工具重新出现；
 * 4. 调用时 guard 早已恢复映射，于是仍然拒绝 —— 表现为「列表里有、调用报禁用」。
 *
 * 两处修复各自覆盖一环：
 * - `workspace.ts`：解析失败**不删**映射，并延迟重试一次；
 * - `restrict.ts`：先算目标集再决定是否动 mask；工作区未知且目标集为空时保留旧 mask。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { shouldKeepMask } from '../src/policy.ts'
import { GuardState } from '../src/state.ts'
import { installWorkspaceIndex } from '../src/workspace.ts'

describe('shouldKeepMask（fail-closed 判定）', () => {
  it('工作区未知 + 目标集为空 + 已有 mask → 保留', () => {
    assert.equal(shouldKeepMask({ hasMask: true, deniedCount: 0, workspaceKnown: false }), true)
  })

  it('工作区已知 + 目标集为空 → 允许撤掉（用户确实全部启用了）', () => {
    assert.equal(shouldKeepMask({ hasMask: true, deniedCount: 0, workspaceKnown: true }), false)
  })

  it('还有禁用项 → 不适用（要重挂而不是保留）', () => {
    assert.equal(shouldKeepMask({ hasMask: true, deniedCount: 2, workspaceKnown: false }), false)
  })

  it('本来就没有 mask → 无需保留', () => {
    assert.equal(shouldKeepMask({ hasMask: false, deniedCount: 0, workspaceKnown: false }), false)
  })
})

describe('installWorkspaceIndex（映射只增不删）', () => {
  const makeState = (): GuardState => new GuardState()

  /** 极简 ctx：只实现本模块用到的 effect / on / get / logger。 */
  const makeCtx = (registry: unknown) => {
    const handlers = new Map<string, (payload?: unknown) => void>()
    const disposers: (() => void)[] = []
    const ctx = {
      logger: { warn: () => {}, info: () => {} },
      get: (name: string) => (name === 'workspaceRegistry' ? registry : undefined),
      on: (event: string, handler: (payload?: unknown) => void) => {
        handlers.set(event, handler)
        return () => { handlers.delete(event) }
      },
      effect: (fn: () => () => void) => {
        const dispose = fn()
        disposers.push(dispose)
        return () => { dispose() }
      },
    }
    return { ctx, handlers, disposers }
  }

  const agentEvent = (id: string, cwd: string) => ({ agent: { id, session: { header: { cwd } } } })

  it('首次解析失败后重试成功，映射落表并触发 onResolved', async () => {
    let attempt = 0
    const registry = {
      resolveByPath: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('registry not ready')
        return { id: 'ws-1' }
      },
    }
    const { ctx, handlers } = makeCtx(registry)
    const state = makeState()
    const resolved: string[] = []
    installWorkspaceIndex(ctx as never, state, agentId => { resolved.push(agentId) })

    handlers.get('agent/created')!(agentEvent('a1', 'D:\\work'))
    // 首帧：解析失败，映射不能有任何值，更不能写入 undefined
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(state.hasWorkspace('a1'), false)

    // 等重试窗口（WORKSPACE_RETRY_MS = 800）
    await new Promise(resolve => setTimeout(resolve, 900))
    assert.equal(state.hasWorkspace('a1'), true)
    assert.deepEqual(resolved, ['a1'])
  })

  it('解析返回 undefined 时保留上一次成功映射（只增不删）', async () => {
    let mode: 'ok' | 'miss' = 'ok'
    const registry = { resolveByPath: async () => (mode === 'ok' ? { id: 'ws-1' } : undefined) }
    const { ctx, handlers } = makeCtx(registry)
    const state = makeState()
    installWorkspaceIndex(ctx as never, state)

    handlers.get('agent/created')!(agentEvent('a2', 'D:\\work'))
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(state.hasWorkspace('a2'), true)

    // 同一 agent 再次解析失败（resume 等场景）：映射必须仍在
    mode = 'miss'
    handlers.get('agent/created')!(agentEvent('a2', 'D:\\work'))
    await new Promise(resolve => setTimeout(resolve, 900))
    assert.equal(state.hasWorkspace('a2'), true)
  })

  it('agent/disposed 才真正清理映射', async () => {
    const registry = { resolveByPath: async () => ({ id: 'ws-1' }) }
    const { ctx, handlers } = makeCtx(registry)
    const state = makeState()
    installWorkspaceIndex(ctx as never, state)

    handlers.get('agent/created')!(agentEvent('a3', 'D:\\work'))
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(state.hasWorkspace('a3'), true)

    handlers.get('agent/disposed')!({ agent: { id: 'a3' } })
    assert.equal(state.hasWorkspace('a3'), false)
  })
})
