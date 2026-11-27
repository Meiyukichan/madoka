import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ThreadComment } from '../src/host/ledger/comment-store.ts'
import {
  InteractionProjection,
  projectInteractionEvents,
} from '../src/host/exec/interaction-projection.ts'
import {
  INTERACTION_SCHEMA,
  encodeInteraction,
  type AnsweredQuestionEvent,
  type CompletedInteractionEvent,
  type RequestedQuestionEvent,
} from '../src/shared/interaction-protocol.ts'

const requested: RequestedQuestionEvent = {
  schema: INTERACTION_SCHEMA,
  event: 'requested',
  interactionId: 'i-1',
  issueId: 'issue-1',
  sessionId: 'session-1',
  kind: 'question',
  at: 10,
  instance: '127.0.0.1:3080',
  request: {
    questions: [{ id: 'q-1', question: '选哪个？', options: [{ label: 'a' }, { label: 'b' }] }],
  },
}

const answered: AnsweredQuestionEvent = {
  schema: INTERACTION_SCHEMA,
  event: 'answered',
  interactionId: 'i-1',
  issueId: 'issue-1',
  sessionId: 'session-1',
  kind: 'question',
  at: 20,
  by: { role: 'assigner', sessionId: 'session-2' },
  answer: { answers: [{ questionId: 'q-1', selected: ['a'] }] },
}

const completed: CompletedInteractionEvent = {
  schema: INTERACTION_SCHEMA,
  event: 'completed',
  interactionId: 'i-1',
  issueId: 'issue-1',
  sessionId: 'session-1',
  kind: 'question',
  at: 30,
  outcome: 'answered',
}

function comment(event: RequestedQuestionEvent | AnsweredQuestionEvent | CompletedInteractionEvent, createdAt: number, id: string): ThreadComment {
  return {
    id,
    body: encodeInteraction(event),
    createdAt,
    role: event.event === 'answered' ? 'assigner' : 'assignee',
    authorType: 'system',
    origin: 'remote',
  }
}

test('projection：requested -> answered -> completed', () => {
  const views = projectInteractionEvents([
    comment(requested, 10, 'c-1'),
    comment(answered, 20, 'c-2'),
    comment(completed, 30, 'c-3'),
  ], 'issue-1')
  assert.equal(views.length, 1)
  const view = views[0]!
  assert.equal(view.kind, 'question')
  assert.equal(view.status, 'completed')
  assert.equal(view.outcome, 'answered')
  if (view.kind !== 'question') return
  assert.equal(view.request?.questions[0]?.id, 'q-1')
  assert.deepEqual(view.answer?.answers[0]?.selected, ['a'])
})

test('projection：answered 先于 requested，后到的 request 补上', () => {
  const views = projectInteractionEvents([
    comment(answered, 10, 'c-1'),
    comment(requested, 20, 'c-2'),
  ], 'issue-1')
  const view = views[0]!
  assert.equal(view.status, 'answered')
  assert.equal(view.answeredAt, 10)
  assert.equal(view.requestedAt, 20)
  if (view.kind !== 'question') return
  assert.equal(view.request?.questions[0]?.id, 'q-1')
})

test('projection：completed 是终态，迟到事件不重开', () => {
  const views = projectInteractionEvents([
    comment(completed, 10, 'c-1'),
    comment(answered, 20, 'c-2'),
    comment({ ...requested, at: 30 }, 30, 'c-3'),
  ], 'issue-1')
  const view = views[0]!
  assert.equal(view.status, 'completed')
  assert.equal(view.outcome, 'answered')
  assert.equal(view.requestedAt, 30, 'request 可以补，但状态仍是 completed')
})

test('projection：重复 requested / answered 保留第一条', () => {
  const secondAnswer: AnsweredQuestionEvent = {
    ...answered,
    answer: { answers: [{ questionId: 'q-1', selected: ['b'] }] },
  }
  const views = projectInteractionEvents([
    comment(requested, 10, 'c-1'),
    comment(answered, 20, 'c-2'),
    comment(secondAnswer, 30, 'c-3'),
  ], 'issue-1')
  const view = views[0]!
  if (view.kind !== 'question') return
  assert.deepEqual(view.answer?.answers[0]?.selected, ['a'])
})

test('projection：普通评论、错误 issue、坏控制评论都忽略', () => {
  const normal: ThreadComment = {
    id: 'c-normal',
    body: '普通评论',
    createdAt: 1,
    role: 'assignee',
    authorType: 'user',
    origin: 'remote',
  }
  const wrongIssue = comment({ ...requested, issueId: 'issue-2' }, 2, 'c-other')
  const wrongRole = { ...comment(requested, 3, 'c-role'), role: 'assigner' as const }
  const broken: ThreadComment = {
    id: 'c-broken',
    body: '{"schema":"castboard.interaction/v1",',
    createdAt: 4,
    role: 'assignee',
    authorType: 'system',
    origin: 'remote',
  }
  assert.deepEqual(projectInteractionEvents([normal, wrongIssue, wrongRole, broken], 'issue-1'), [])
})

test('InteractionProjection：评论签名变化后才重建', async () => {
  let comments: ThreadComment[] = [comment(requested, 10, 'c-1')]
  let reads = 0
  const projection = new InteractionProjection({
    commentsOf: async () => {
      reads += 1
      return comments
    },
  })
  const first = await projection.of('issue-1')
  assert.equal(first[0]?.status, 'pending')
  const cached = await projection.of('issue-1')
  assert.equal(cached[0]?.status, 'pending')
  assert.equal(reads, 2, '每次 of 都读评论流（签名由内容决定）')

  comments = [...comments, comment(completed, 20, 'c-2')]
  const updated = await projection.of('issue-1')
  assert.equal(updated[0]?.status, 'completed')
})
