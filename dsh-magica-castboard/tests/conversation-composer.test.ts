import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installConversationInteractions } from '../src/client/features/interactions/conversation.ts'

test('conversation surface publishes the earliest pending interaction per session', () => {
  const published: Array<{ key: string; sessionId: string }> = []
  const disposed: string[] = []
  let registration: { options: Record<string, unknown> } | undefined
  const interactions = [
    { id: 'q2', kind: 'question', sessionId: 's1', title: 'late', body: 'late', createdAt: 20 },
    { id: 'q1', kind: 'question', sessionId: 's1', title: 'early', body: 'early', createdAt: 10 },
    { id: 'q3', kind: 'question', sessionId: 's2', title: 'other', body: 'other', createdAt: 30 },
  ]
  const store = {
    getSnapshot: () => ({ interactions }),
    subscribe: () => () => {},
  }
  const uiSession = {
    registerPendingInteraction: (precedence: (item: { key: string }) => number) => {
      assert.equal(typeof precedence, 'function')
      return (carrier: { key: string; sessionId: string }) => {
        published.push(carrier)
        return () => { disposed.push(carrier.key) }
      }
    },
  }
  const slots = {
    inject: (_key: string, callback: () => () => void) => callback(),
    register: (options: Record<string, unknown>) => {
      registration = { options }
      return () => {}
    },
  }
  const dispose = installConversationInteractions(
    { uiSession, slots } as never,
    store as never,
    (() => null) as never,
  )
  assert.deepEqual(published.map(item => item.key), ['question:q1', 'question:q3'])
  assert.deepEqual(published.map(item => item.sessionId), ['s1', 's2'])
  assert.ok(registration !== undefined)
  const select = registration.options.select as (owner: { pendingInteraction?: unknown }) => unknown
  assert.equal(select({ pendingInteraction: published[0] }), published[0])
  assert.equal(select({ pendingInteraction: { tag: 'other' } }), null)
  dispose()
  assert.deepEqual(disposed.sort(), ['question:q1', 'question:q3'])
})
