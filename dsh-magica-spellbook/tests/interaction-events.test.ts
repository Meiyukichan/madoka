import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'

import { answerApproval, installApprovalAnswerer } from '../src/sessions/approval.ts'
import { answerQuestion, installQuestionAnswerer } from '../src/sessions/questions.ts'
import type { InteractionChangedEvent } from '../src/shared/interaction.ts'

interface FakeCtx {
  readonly handlers: Map<string, (...args: never[]) => unknown>
  readonly changes: InteractionChangedEvent[]
  readonly ctx: {
    on(name: string, listener: (...args: never[]) => unknown): () => void
    effect(callback: () => unknown): () => void
    emit(name: string, change: InteractionChangedEvent): void
  }
}

function fakeCtx(): FakeCtx {
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const changes: InteractionChangedEvent[] = []
  const cleanups: Array<() => void> = []
  const ctx = {
    on(name: string, listener: (...args: never[]) => unknown): () => void {
      handlers.set(name, listener)
      return () => { handlers.delete(name) }
    },
    effect(callback: () => unknown): () => void {
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup as () => void)
      return () => { for (const item of cleanups.splice(0)) item() }
    },
    emit(name: string, change: InteractionChangedEvent): void {
      if (name === 'magica/interaction-changed') changes.push(change)
    },
  }
  return { handlers, changes, ctx }
}

describe('待决交互变更事件', () => {
  it('审批：hold 发 added，answer 发 removed(outcome)', async () => {
    const fake = fakeCtx()
    const uninstall = installApprovalAnswerer(fake.ctx, 'session-1')
    const handler = fake.handlers.get('approval/request') as unknown as
      | ((request: ApprovalRequestEvent, next: () => Promise<string>) => Promise<string>)
      | undefined
    assert.equal(typeof handler, 'function')

    const request = {
      agent: { session: { id: 'session-1' } },
      toolName: 'bash',
      reason: '执行迁移',
      callId: 'call-1',
      signal: new AbortController().signal,
    } as unknown as ApprovalRequestEvent
    const pending = handler!(request, () => Promise.resolve('allowed-once'))

    assert.equal(fake.changes.length, 1)
    const added = fake.changes[0]!
    assert.equal(added.action, 'added')
    assert.equal(added.item.kind, 'approval')
    assert.equal(added.item.sessionId, 'session-1')
    if (added.item.kind !== 'approval') throw new Error('expected approval')
    assert.equal(added.item.toolName, 'bash')
    assert.equal(added.item.callId, 'call-1')

    assert.equal(answerApproval('session-1', added.item.id, 'allowed-once'), 'answered')
    assert.equal(fake.changes.length, 2)
    const removed = fake.changes[1]!
    assert.equal(removed.action, 'removed')
    assert.equal(removed.outcome, 'allowed-once')
    assert.equal(removed.item.id, added.item.id)
    assert.equal(await pending, 'allowed-once')
    uninstall()
  })

  it('提问：hold 发 added，answer 发 removed(answered)', async () => {
    const fake = fakeCtx()
    const uninstall = installQuestionAnswerer(fake.ctx, 'session-1')
    const handler = fake.handlers.get('user-questions/request') as unknown as
      | ((request: AskUserQuestionRequestEvent, next: () => Promise<unknown>) => Promise<unknown>)
      | undefined
    assert.equal(typeof handler, 'function')

    const request = {
      agent: { session: { id: 'session-1' } },
      questions: [{ id: 'q-1', question: '选哪个？', options: [{ label: 'a' }, { label: 'b' }] }],
    } as unknown as AskUserQuestionRequestEvent
    const pending = handler!(request, () => Promise.reject(new Error('unused')))

    assert.equal(fake.changes.length, 1)
    const added = fake.changes[0]!
    assert.equal(added.action, 'added')
    assert.equal(added.item.kind, 'question')
    if (added.item.kind !== 'question') throw new Error('expected question')
    assert.equal(added.item.questions[0]?.id, 'q-1')

    assert.equal(answerQuestion('session-1', added.item.id, {
      answers: [{ id: 'q-1', selected: ['a'] }],
    }), 'answered')
    assert.equal(fake.changes.length, 2)
    const removed = fake.changes[1]!
    assert.equal(removed.action, 'removed')
    assert.equal(removed.outcome, 'answered')
    assert.deepEqual(await pending, { answers: [{ id: 'q-1', selected: ['a'] }] })
    uninstall()
  })
})
