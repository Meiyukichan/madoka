import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  composeAgentScope,
  emptyRunState,
  installContextDelivery,
  installObservers,
  runTurnVerified,
} from '../../src/sessions/core.ts'
import { fakeAgents } from '../helpers/fake-agent.ts'
import { fakeCtx } from '../helpers/fake.ts'

const session = { id: 's1' }

describe('installObservers', () => {
  it('assistant/message 抽文本并回调 onText', () => {
    const ctx = fakeCtx()
    const state = emptyRunState()
    const texts: string[] = []
    const off = installObservers(ctx, 's1', state, { onText: (text) => texts.push(text) })
    ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'hello' }] } },
    })
    assert.deepEqual(state.messages, ['hello'])
    assert.deepEqual(texts, ['hello'])
    off()
  })

  it('只处理本会话的事件（纵深防御）', () => {
    const ctx = fakeCtx()
    const state = emptyRunState()
    installObservers(ctx, 's1', state)
    ctx.emit('session/event', { id: 'other' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } })
    assert.deepEqual(state.messages, [])
  })

  it('turn/end 记结局、写 outcome、清空未配对审批', () => {
    const ctx = fakeCtx()
    const state = emptyRunState()
    const off = installObservers(ctx, 's1', state)
    ctx.emit('session/event', session, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' }, time: 1000 })
    ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    assert.equal(state.outcome, 'completed')
    assert.equal(state.turnEnds.length, 1)
    assert.deepEqual(state.approvals, [])
    off()
  })

  it('approval/asked + decided 配对出 waitedMs', () => {
    const ctx = fakeCtx()
    const state = emptyRunState()
    installObservers(ctx, 's1', state)
    ctx.emit('session/event', session, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash', callId: 'c1' }, time: 1000 })
    ctx.emit('session/event', session, { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' }, time: 1500 })
    assert.equal(state.approvals.length, 1)
    assert.equal(state.approvals[0]?.outcome, 'allowed-once')
    assert.equal(state.approvals[0]?.waitedMs, 500)
    assert.equal(state.approvals[0]?.callId, 'c1')
  })

  it('sandbox/mode、plan/mode、approval/policy、tool/call|result 都进状态或钩子', () => {
    const ctx = fakeCtx()
    const state = emptyRunState()
    const toolCalls: string[] = []
    const toolResults: string[] = []
    installObservers(ctx, 's1', state, {
      onToolCall: (callId, name, args) => toolCalls.push(`${callId}:${name}:${args}`),
      onToolResult: (callId) => toolResults.push(callId),
    })
    ctx.emit('session/event', session, { type: 'sandbox/mode', data: { mode: 'read-only' } })
    ctx.emit('session/event', session, { type: 'plan/mode', data: { active: true } })
    ctx.emit('session/event', session, { type: 'approval/policy', data: { policy: 'never' } })
    ctx.emit('session/event', session, { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' } })
    ctx.emit('session/event', session, { type: 'tool/result', data: { message: { source: { callId: 'c1' } } } })
    assert.equal(state.sandboxMode, 'read-only')
    assert.equal(state.planMode, true)
    assert.equal(state.approvalPolicy, 'never')
    assert.deepEqual(toolCalls, ['c1:bash:{"cmd":"ls"}'])
    assert.deepEqual(toolResults, ['c1'])
  })

  it('钩子抛错被吞掉，不影响状态更新', () => {
    const ctx = fakeCtx()
    const state = emptyRunState()
    installObservers(ctx, 's1', state, {
      onText: () => {
        throw new Error('hook boom')
      },
    })
    ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'x' }] } },
    })
    assert.deepEqual(state.messages, ['x'])
  })

  it('agent/disposed 置 externallyDisposed', () => {
    const ctx = fakeCtx()
    const state = emptyRunState()
    installObservers(ctx, 's1', state)
    ctx.emit('agent/disposed', { agent: { id: 's1' } })
    assert.equal(state.externallyDisposed, true)
  })

  it('注销后不再收事件', () => {
    const ctx = fakeCtx()
    const state = emptyRunState()
    const off = installObservers(ctx, 's1', state)
    off()
    ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'late' }] } },
    })
    assert.deepEqual(state.messages, [])
  })
})

describe('installContextDelivery', () => {
  type PreStepListener = (
    payload: unknown,
    next: () => Promise<{ kind: string; messages?: unknown[] }>,
  ) => Promise<{ kind: string; messages?: unknown[] }>

  function capture(): { ctx: unknown; listeners: PreStepListener[] } {
    const listeners: PreStepListener[] = []
    const ctx = {
      get: () => undefined,
      on: (event: string, listener: PreStepListener) => {
        if (event === 'agent/pre-step') listeners.push(listener)
        return () => {}
      },
      effect: (callback: () => unknown) => {
        callback()
        return () => {}
      },
    }
    return { ctx, listeners }
  }

  const message = {
    id: 'm1',
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'rule' }],
    source: { kind: 'plugin', plugin: 'p' },
  }

  it('把上下文追加到 enter 决策的末尾，并保留其余字段', async () => {
    const { ctx, listeners } = capture()
    const delivery = installContextDelivery(ctx, [message])
    const listener = listeners[0]
    assert.ok(listener !== undefined)
    const decision = await listener({}, async () => ({ kind: 'enter', messages: [{ id: 'user' }] }))
    assert.equal(decision.messages?.length, 2)
    assert.equal((decision.messages?.[1] as { id: string }).id, 'm1')
    delivery.dispose()
  })

  it('reject 时不动，上下文继续等下一个 step', async () => {
    const { ctx, listeners } = capture()
    const delivery = installContextDelivery(ctx, [message])
    const listener = listeners[0]
    assert.ok(listener !== undefined)
    const rejected = await listener({}, async () => ({ kind: 'reject' }))
    assert.deepEqual(rejected, { kind: 'reject' })
    const entered = await listener({}, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(entered.messages?.length, 1)
    delivery.dispose()
  })

  it('push 的条目在下一次 step 投递，且 dispose 后不再投', async () => {
    const { ctx, listeners } = capture()
    const delivery = installContextDelivery(ctx, [])
    const listener = listeners[0]
    assert.ok(listener !== undefined)
    assert.equal(delivery.push([message]), undefined)
    const first = await listener({}, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(first.messages?.length, 1)
    delivery.dispose()
    const second = await listener({}, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(second.messages?.length, 0)
  })
})

describe('composeAgentScope', () => {
  it('顺序：观察者 → preset → setup；setup 抛错时回滚监听', async () => {
    const calls: string[] = []
    const ctx = fakeCtx({ agentPresets: { mount: async () => { calls.push('mount'); return { id: 'p1' } } } })
    const agentCtx = fakeCtx()
    await assert.rejects(
      composeAgentScope({
        ctx,
        agentCtx,
        sessionId: 's1',
        state: emptyRunState(),
        hooks: {},
        presetId: 'p1',
        userSetup: () => {
          calls.push('setup')
          throw new Error('bad setup')
        },
      }),
      /bad setup/,
    )
    assert.deepEqual(calls, ['mount', 'setup'])
    assert.equal(agentCtx.listenerCount('session/event'), 0)
  })
})

describe('runTurnVerified', () => {
  it('交叉验证：whenIdle 归来后取本轮最后一条 turn/end', async () => {
    const bundle = fakeAgents({ text: 'hi' })
    const state = emptyRunState()
    installObservers(bundle.agentCtx, 's1', state)
    const handle = await bundle.registry.create({ sessionId: 's1', setup: async () => {} })
    const settlement = await runTurnVerified(handle, state, {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    })
    assert.equal(settlement.completed, true)
    assert.deepEqual(settlement.texts, ['hi'])
    assert.equal(settlement.kind, 'completed')
  })

  it('看门狗：whenIdle 不收敛 → aborted + timedOut，且取消原因可判读', async () => {
    const bundle = fakeAgents({ neverIdle: true })
    const cancelled: string[] = []
    const state = emptyRunState()
    const agent = {
      id: 's1',
      session: { id: 's1', append() {} },
      followup() {},
      steer() {},
      inject() {},
      cancel(cause: { kind: string; reason?: string }) {
        cancelled.push(`${cause.kind}:${cause.reason ?? ''}`)
      },
      whenIdle: () => new Promise<void>(() => {}),
    }
    const handle = { agent, dispose: async () => {} }
    const settlement = await runTurnVerified(handle as never, state, undefined, true, 10)
    assert.equal(settlement.timedOut, true)
    assert.equal(settlement.completed, false)
    assert.equal(settlement.reason?.kind, 'aborted')
    assert.deepEqual(cancelled, ['hook:magica:idle-timeout'])
    void bundle
  })
})
