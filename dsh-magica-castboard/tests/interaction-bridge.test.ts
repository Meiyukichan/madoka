import assert from 'node:assert/strict'
import { test } from 'node:test'

import { InteractionBridge } from '../src/host/exec/interaction-bridge.ts'
import type { PendingInteraction } from '../src/host/exec/interactions.ts'
import type { ThreadComment } from '../src/host/ledger/comment-store.ts'
import {
  INTERACTION_SCHEMA,
  encodeInteraction,
  type AnsweredApprovalEvent,
  type AnsweredQuestionEvent,
} from '../src/shared/interaction-protocol.ts'
import { threadComment, taskRecord } from './helpers.ts'

const pending: PendingInteraction = {
  id: 'i-1',
  kind: 'question',
  sessionId: 's-1',
  taskId: 't-1',
  title: '选哪个',
  body: '选哪个？',
  createdAt: 10,
}

const answered: AnsweredQuestionEvent = {
  schema: INTERACTION_SCHEMA,
  event: 'answered',
  interactionId: 'i-1',
  issueId: 'issue-1',
  sessionId: 's-1',
  kind: 'question',
  at: 20,
  by: { role: 'assigner', sessionId: 'dispatcher' },
  answer: { answers: [{ questionId: 'q-1', selected: ['a'] }] },
}

function setup(comments: readonly ThreadComment[], overrides: Partial<{
  issueId: string
  kind: 'question' | 'approval'
  result: boolean
  enabled: boolean
}> = {}) {
  const calls: unknown[] = []
  const bridge = new InteractionBridge({
    interactions: {
      answerRemote: async input => {
        calls.push(input)
        return overrides.result ?? true
      },
    },
    tasks: {
      get: () => taskRecord({ id: 't-1', issueId: overrides.issueId ?? 'issue-1' }),
      taskIdOfSession: () => 't-1',
    },
    links: {
      get: () => ({ assigneeSessionId: 's-1' }),
    },
    thread: {
      list: async () => [...comments],
    },
    enabled: () => overrides.enabled ?? true,
  })
  return { bridge, calls }
}

test('Bridge：answered 匹配后调用 answerRemote(full answers)', async () => {
  const { bridge, calls } = setup([
    threadComment({
      id: 'c-1',
      body: encodeInteraction(answered),
      role: 'assigner',
      authorType: 'system',
    }),
  ])
  const applied = await bridge.reconcile([pending])
  assert.deepEqual([...applied], ['i-1'])
  assert.deepEqual(calls, [{
    interactionId: 'i-1',
    sessionId: 's-1',
    kind: 'question',
    answers: [{ questionId: 'q-1', selected: ['a'] }],
  }])
})

test('Bridge：approval decision 透传', async () => {
  const approval: AnsweredApprovalEvent = {
    ...answered,
    kind: 'approval',
    answer: { decision: 'rejected', note: '不跑' },
  }
  const { bridge, calls } = setup([
    threadComment({
      id: 'c-1',
      body: encodeInteraction(approval),
      role: 'assigner',
      authorType: 'system',
    }),
  ])
  const applied = await bridge.reconcile([{ ...pending, kind: 'approval' }])
  assert.deepEqual([...applied], ['i-1'])
  assert.deepEqual(calls, [{
    interactionId: 'i-1',
    sessionId: 's-1',
    kind: 'approval',
    decision: 'rejected',
    note: '不跑',
  }])
})

test('Bridge：issue / session / kind 不匹配不 apply', async () => {
  const wrongIssue: AnsweredQuestionEvent = { ...answered, issueId: 'issue-2' }
  const wrongSession: AnsweredQuestionEvent = { ...answered, sessionId: 's-2' }
  const { bridge, calls } = setup([
    threadComment({ id: 'c-1', body: encodeInteraction(wrongIssue), role: 'assigner', authorType: 'system' }),
    threadComment({ id: 'c-2', body: encodeInteraction(wrongSession), role: 'assigner', authorType: 'system' }),
  ])
  const applied = await bridge.reconcile([pending])
  assert.equal(applied.size, 0)
  assert.deepEqual(calls, [])
})

test('Bridge：answered 的 role 不是 assigner 时不 apply', async () => {
  const { bridge, calls } = setup([
    threadComment({ id: 'c-1', body: encodeInteraction(answered), role: 'assignee', authorType: 'system' }),
  ])
  const applied = await bridge.reconcile([pending])
  assert.equal(applied.size, 0)
  assert.deepEqual(calls, [])
})

test('Bridge：answerRemote false 不标记 applied', async () => {
  const { bridge } = setup([
    threadComment({ id: 'c-1', body: encodeInteraction(answered), role: 'assigner', authorType: 'system' }),
  ], { result: false })
  const applied = await bridge.reconcile([pending])
  assert.equal(applied.size, 0)
})

test('Bridge：commentsEnabled=false 时不 apply 远端 answer', async () => {
  const { bridge, calls } = setup([
    threadComment({ id: 'c-1', body: encodeInteraction(answered), role: 'assigner', authorType: 'system' }),
  ], { enabled: false })
  const applied = await bridge.reconcile([pending])
  assert.equal(applied.size, 0)
  assert.deepEqual(calls, [])
})
