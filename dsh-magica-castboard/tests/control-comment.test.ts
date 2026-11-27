import assert from 'node:assert/strict'
import { test } from 'node:test'

import { controlCommentText } from '../src/client/features/interactions/control-comment.ts'
import { INTERACTION_SCHEMA, encodeInteraction } from '../src/shared/interaction-protocol.ts'

const t = ((key: string, params?: Record<string, string>) => params === undefined
  ? key
  : `${key}:${Object.values(params).join(',')}`) as never

test('client：普通评论/坏 JSON 不显示成交互', () => {
  assert.equal(controlCommentText({ authorType: 'user', body: '普通评论' }, t), undefined)
  assert.equal(controlCommentText({ authorType: 'system', body: '{"schema":"castboard.interaction/v1",' }, t), undefined)
})

test('client：requested/answered/completed/unsupported 摘要', () => {
  const requested = encodeInteraction({
    schema: INTERACTION_SCHEMA,
    event: 'requested',
    interactionId: 'i-1',
    issueId: 'issue-1',
    sessionId: 's-1',
    kind: 'question',
    at: 1,
    instance: '127.0.0.1:3080',
    request: { questions: [{ id: 'q-1', header: '发布范围', question: '选哪个？' }] },
  })
  assert.equal(controlCommentText({ authorType: 'system', body: requested }, t), 'interaction.summaryRequested:发布范围')

  const answered = encodeInteraction({
    schema: INTERACTION_SCHEMA,
    event: 'answered',
    interactionId: 'i-1',
    issueId: 'issue-1',
    sessionId: 's-1',
    kind: 'question',
    at: 2,
    by: { role: 'assigner' },
    answer: { answers: [{ questionId: 'q-1', selected: ['a'] }] },
  })
  assert.equal(controlCommentText({ authorType: 'system', body: answered }, t), 'interaction.summaryAnswered:a')

  const completed = encodeInteraction({
    schema: INTERACTION_SCHEMA,
    event: 'completed',
    interactionId: 'i-1',
    issueId: 'issue-1',
    sessionId: 's-1',
    kind: 'question',
    at: 3,
    outcome: 'answered',
  })
  assert.equal(controlCommentText({ authorType: 'system', body: completed }, t), 'interaction.summaryCompleted:answered')

  assert.equal(
    controlCommentText({ authorType: 'system', body: '{"schema":"castboard.interaction/v2"}' }, t),
    'interaction.unsupported',
  )
})
