import assert from 'node:assert/strict'
import { test } from 'node:test'

import { interactionCommentId } from '../src/host/exec/interaction-id.ts'
import {
  INTERACTION_SCHEMA,
  canonicalInteractionAnswer,
  decodeInteraction,
  encodeInteraction,
  isInteractionBody,
  type AnsweredQuestionEvent,
  type CompletedInteractionEvent,
  type RequestedApprovalEvent,
  type RequestedQuestionEvent,
} from '../src/shared/interaction-protocol.ts'

const base = {
  schema: INTERACTION_SCHEMA,
  interactionId: 'i-1',
  issueId: 'issue-1',
  sessionId: 'session-1',
  at: 1730000000000,
} as const

const requestedQuestion: RequestedQuestionEvent = {
  ...base,
  event: 'requested',
  kind: 'question',
  instance: '127.0.0.1:3080',
  taskId: 't-1',
  request: {
    questions: [{
      id: 'q-1',
      header: '发布范围',
      question: '只发测试环境还是生产？',
      options: [{ label: '仅测试', description: '只发测试' }, { label: '生产' }],
      multiSelect: true,
    }],
  },
}

const requestedApproval: RequestedApprovalEvent = {
  ...base,
  interactionId: 'a-1',
  event: 'requested',
  kind: 'approval',
  instance: '127.0.0.1:3080',
  request: { toolName: 'bash', reason: '执行迁移', callId: 'call-1', argsPreview: '{"cmd":"x"}', argsTruncated: true },
}

const answeredQuestion: AnsweredQuestionEvent = {
  ...base,
  event: 'answered',
  kind: 'question',
  by: { role: 'assigner', sessionId: 'session-2' },
  answer: { answers: [{ questionId: 'q-1', selected: ['仅测试'] }] },
}

const completed: CompletedInteractionEvent = {
  ...base,
  event: 'completed',
  kind: 'question',
  outcome: 'answered',
}

test('协议：requested/answered/completed 往返', () => {
  for (const event of [requestedQuestion, requestedApproval, answeredQuestion, completed] as const) {
    const body = encodeInteraction(event)
    assert.ok(body.length <= 4000)
    const decoded = decodeInteraction(body)
    assert.equal(decoded.ok, true)
    if (!decoded.ok) continue
    assert.deepEqual(decoded.event, event)
  }
})

test('协议：普通 JSON / 坏 JSON / 未知版本都不会抛', () => {
  const ordinary = decodeInteraction('{"hello":1}')
  assert.deepEqual(ordinary, { ok: false, reason: 'not-interaction' })
  assert.equal(isInteractionBody('{"hello":1}'), false)

  const broken = decodeInteraction('{"schema":"castboard.interaction/v1",')
  assert.equal(broken.ok, false)
  if (!broken.ok) assert.equal(broken.reason, 'malformed')
  assert.equal(isInteractionBody('{"schema":"castboard.interaction/v1",'), true)

  const unsupported = decodeInteraction('{"schema":"castboard.interaction/v2"}')
  assert.equal(unsupported.ok, false)
  if (!unsupported.ok) assert.equal(unsupported.reason, 'unsupported')
})

test('协议：字段缺失/类型错误返回 malformed', () => {
  const decoded = decodeInteraction(JSON.stringify({
    schema: INTERACTION_SCHEMA,
    event: 'requested',
    interactionId: 'i-1',
    issueId: 'issue-1',
    sessionId: 'session-1',
    kind: 'question',
    at: 1,
    instance: '127.0.0.1:3080',
    request: { questions: [] },
  }))
  assert.equal(decoded.ok, false)
  if (!decoded.ok) assert.equal(decoded.reason, 'malformed')
})

test('协议：超长请求会压缩且仍可 decode', () => {
  const long = {
    ...requestedQuestion,
    request: {
      questions: Array.from({ length: 20 }, (_, index) => ({
        id: `q-${index}`,
        question: 'x'.repeat(1000),
        header: 'h'.repeat(100),
        detail: 'd'.repeat(500),
        options: Array.from({ length: 20 }, (_, option) => ({
          label: `label-${option}-${'l'.repeat(60)}`,
          description: 'd'.repeat(200),
        })),
      })),
    },
  } satisfies RequestedQuestionEvent
  const body = encodeInteraction(long)
  assert.ok(body.length <= 4000)
  const decoded = decodeInteraction(body)
  assert.equal(decoded.ok, true)
  if (decoded.ok && decoded.event.event === 'requested' && decoded.event.kind === 'question') {
    assert.equal(decoded.event.request.truncated, true)
  }
})

test('评论 id：requested/completed 稳定，answered 按 canonical 答案去重', () => {
  const requestId = interactionCommentId(requestedQuestion)
  const sameRequest: RequestedQuestionEvent = {
    ...requestedQuestion,
    at: requestedQuestion.at + 1,
    request: { questions: [{ ...requestedQuestion.request.questions[0]!, question: '换了文案' }] },
  }
  assert.equal(interactionCommentId(sameRequest), requestId, 'requested 不把 payload/at 放进 id')

  const completedId = interactionCommentId(completed)
  assert.equal(completedId, interactionCommentId({ ...completed, outcome: 'cancelled' }), 'completed 只认 interaction')

  const first = interactionCommentId(answeredQuestion)
  const sameAnswer: AnsweredQuestionEvent = {
    ...answeredQuestion,
    answer: { answers: [{ questionId: 'q-1', selected: ['仅测试'] }] },
  }
  assert.equal(interactionCommentId(sameAnswer), first)
  const otherAnswer: AnsweredQuestionEvent = {
    ...answeredQuestion,
    answer: { answers: [{ questionId: 'q-1', selected: ['生产'] }] },
  }
  assert.notEqual(interactionCommentId(otherAnswer), first)
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('canonicalInteractionAnswer：多题/多选顺序稳定', () => {
  const left: AnsweredQuestionEvent = {
    ...answeredQuestion,
    answer: {
      answers: [
        { questionId: 'q-2', selected: ['b', 'a'] },
        { questionId: 'q-1', custom: '自定义' },
      ],
    },
  }
  const right: AnsweredQuestionEvent = {
    ...answeredQuestion,
    answer: {
      answers: [
        { questionId: 'q-1', custom: '自定义' },
        { questionId: 'q-2', selected: ['a', 'b'] },
      ],
    },
  }
  assert.equal(canonicalInteractionAnswer(left), canonicalInteractionAnswer(right))
})

test('协议：answer 超出长度不会被静默截断', () => {
  const huge: AnsweredQuestionEvent = {
    ...answeredQuestion,
    answer: {
      answers: Array.from({ length: 20 }, (_, index) => ({
        questionId: `q-${index}`,
        custom: 'x'.repeat(1000),
      })),
    },
  }
  assert.throws(() => encodeInteraction(huge), /exceeds the comment limit/)

  const longCustom: AnsweredQuestionEvent = {
    ...answeredQuestion,
    answer: { answers: [{ questionId: 'q-1', custom: 'x'.repeat(1001) }] },
  }
  assert.throws(() => encodeInteraction(longCustom), /too long/)
})
