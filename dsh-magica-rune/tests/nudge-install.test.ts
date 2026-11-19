/**
 * `installNudge` 的接线测试（假 ctx）。
 *
 * 锁住三件在真机上很容易悄悄坏掉的事：
 * 1. 监听必须注册在 `ctx.inject(['agents'], child => …)` 的子上下文里 ——
 *    未声明 inject 时 `ctx.get('agents')` 会抛，投递会静默失败（这就是线上「没注入」的候选原因）；
 * 2. 第 15 次连续工具调用时**真的调用** `agent.inject`，且消息 source.kind = `rune-nudge`；
 * 3. 子代理会话不注入、文本输出会清零。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { installNudge, type NudgeContext, type NudgeEvent, type NudgeSession } from '../src/nudge.ts'

interface Injected { source?: { kind?: string; plugin?: string }; content?: Array<{ text?: string }> }

function makeHarness() {
  const listeners: Array<{ event: string; listener: (session: NudgeSession, event: NudgeEvent) => void }> = []
  const injected: Injected[] = []
  const injectedInto: string[] = []
  const agents = new Map<string, { inject: (message: Injected) => void }>()
  let injectServices: readonly string[] | undefined

  const agentFor = (id: string) => {
    const existing = agents.get(id)
    if (existing !== undefined) return existing
    const created = {
      inject: (message: Injected) => { injected.push(message); injectedInto.push(id) },
    }
    agents.set(id, created)
    return created
  }

  const ctx: NudgeContext = {
    effect: callback => callback(),
    on: (event: string, listener: never) => {
      listeners.push({ event, listener })
      return () => {}
    },
    get: (name: 'agents') => (name === 'agents' ? { get: (id: string) => agentFor(id) } : undefined),
    inject: (services, callback) => { injectServices = services; callback(ctx) },
  }

  const emit = (session: NudgeSession, event: NudgeEvent) => {
    for (const entry of listeners) if (entry.event === 'session/event') entry.listener(session, event)
  }

  return { ctx, emit, injected, injectedInto, get injectServices() { return injectServices } }
}

const MAIN: NudgeSession = { id: 'main-1', header: {} }
const SUB: NudgeSession = { id: 'sub-1', header: { origin: 'subagent', parentSession: 'main-1' } }
const toolCall = (seq: number): NudgeEvent => ({ type: 'tool/call', seq, data: {} })
const text = (seq: number): NudgeEvent => ({ type: 'assistant/message', seq, data: { content: [{ type: 'text', text: 'hi' }] } })

const OPTIONS = { plugin: 'dsh-magica-rune', section: 'rune-nudge', everyToolCalls: 15, remindEvery: 15, skipSubagents: true }

describe('installNudge 接线', () => {
  it('在 inject([agents]) 的子上下文里注册监听', () => {
    const harness = makeHarness()
    installNudge(harness.ctx, OPTIONS)
    assert.deepEqual(harness.injectServices, ['agents'])
  })

  it('第 15 次连续工具调用时注入具名上下文', () => {
    const harness = makeHarness()
    installNudge(harness.ctx, OPTIONS)
    for (let i = 1; i <= 14; i++) harness.emit(MAIN, toolCall(i))
    assert.equal(harness.injected.length, 0, '14 次不应注入')
    harness.emit(MAIN, toolCall(15))
    assert.equal(harness.injected.length, 1, '15 次应注入一次')
    assert.equal(harness.injected[0]?.source?.kind, 'rune-nudge')
    assert.equal(harness.injected[0]?.source?.plugin, 'dsh-magica-rune')
    assert.match(String(harness.injected[0]?.content?.[0]?.text), /15 consecutive tool calls/)
    assert.deepEqual(harness.injectedInto, ['main-1'])
  })

  it('子代理会话不注入', () => {
    const harness = makeHarness()
    installNudge(harness.ctx, OPTIONS)
    for (let i = 1; i <= 20; i++) harness.emit(SUB, toolCall(i))
    assert.equal(harness.injected.length, 0)
  })

  it('文本输出会清零，之后要重新数满 15 次', () => {
    const harness = makeHarness()
    installNudge(harness.ctx, OPTIONS)
    for (let i = 1; i <= 14; i++) harness.emit(MAIN, toolCall(i))
    harness.emit(MAIN, text(15))
    for (let i = 16; i <= 29; i++) harness.emit(MAIN, toolCall(i))
    assert.equal(harness.injected.length, 0, '清零后 14 次不应注入')
    harness.emit(MAIN, toolCall(30))
    assert.equal(harness.injected.length, 1)
  })

  it('两个会话各自计数，互不影响', () => {
    const harness = makeHarness()
    installNudge(harness.ctx, OPTIONS)
    const other: NudgeSession = { id: 'main-2', header: {} }
    for (let i = 1; i <= 15; i++) harness.emit(MAIN, toolCall(i))
    for (let i = 1; i <= 14; i++) harness.emit(other, toolCall(i))
    assert.equal(harness.injected.length, 1)
    assert.deepEqual(harness.injectedInto, ['main-1'])
    harness.emit(other, toolCall(15))
    assert.deepEqual(harness.injectedInto, ['main-1', 'main-2'])
  })
})
