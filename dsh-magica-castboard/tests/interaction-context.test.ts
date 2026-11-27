import assert from 'node:assert/strict'
import { test } from 'node:test'

import { commentsXml } from '../src/host/context/comment-context.ts'
import { castboardTaskContext } from '../src/host/context/task-context.ts'
import {
  INTERACTION_SCHEMA,
  encodeInteraction,
  type RequestedApprovalEvent,
  type RequestedQuestionEvent,
} from '../src/shared/interaction-protocol.ts'
import { taskRecord, threadComment } from './helpers.ts'

const requested: RequestedQuestionEvent = {
  schema: INTERACTION_SCHEMA,
  event: 'requested',
  interactionId: 'i-1',
  issueId: 'issue-1',
  sessionId: 'session-1',
  kind: 'question',
  at: 1_730_000_000_000,
  instance: '127.0.0.1:3080',
  request: {
    questions: [{
      id: 'q-1',
      header: '发布范围',
      question: '只发测试环境还是生产？',
      options: [{ label: '仅测试', description: '只发测试' }, { label: '生产' }],
    }],
  },
}

const approval: RequestedApprovalEvent = {
  ...requested,
  interactionId: 'a-1',
  kind: 'approval',
  request: { toolName: 'bash', reason: '执行迁移', argsPreview: '{"cmd":"x"}', argsTruncated: true },
}

function controlComment(event: RequestedQuestionEvent | RequestedApprovalEvent) {
  return threadComment({
    id: `c-${event.interactionId}`,
    body: encodeInteraction(event),
    role: 'assignee',
    authorType: 'system',
    createdAt: event.at,
  })
}

test('commentsXml：requested 渲染成 <interaction>，不出现 raw JSON', () => {
  const xml = commentsXml('issue-1', [controlComment(requested)], 'assigner')
  assert.ok(xml.includes('<interaction id="i-1" kind="question" status="pending"'))
  assert.ok(xml.includes('<summary>发布范围: 只发测试环境还是生产？</summary>'))
  assert.ok(xml.includes('<option label="仅测试">只发测试</option>'))
  assert.ok(xml.includes('capability="answer_interaction"'))
  assert.ok(!xml.includes('"schema"'))
})

test('commentsXml：approval 渲染工具、原因与参数预览', () => {
  const xml = commentsXml('issue-1', [controlComment(approval)], 'assigner')
  assert.ok(xml.includes('<approval tool="bash" args_truncated="true">'))
  assert.ok(xml.includes('<reason>执行迁移</reason>'))
  assert.ok(xml.includes('<args_preview>{"cmd":"x"}</args_preview>'))
})

test('commentsXml：解析失败按普通文本注入，不抛', () => {
  const broken = threadComment({
    id: 'c-broken',
    body: '{"schema":"castboard.interaction/v1",',
    role: 'assignee',
    authorType: 'system',
  })
  const xml = commentsXml('issue-1', [broken], 'assigner')
  assert.ok(xml.includes('<comment '))
  assert.ok(xml.includes('{"schema":"castboard.interaction/v1",'))
})

test('commentsXml：未知版本只给 warning，不输出 raw JSON', () => {
  const unsupported = threadComment({
    id: 'c-v2',
    body: '{"schema":"castboard.interaction/v2"}',
    role: 'assignee',
    authorType: 'system',
  })
  const xml = commentsXml('issue-1', [unsupported], 'assigner')
  assert.ok(xml.includes('<interaction status="unsupported">'))
  assert.ok(!xml.includes('castboard.interaction/v2'))
})

test('task-context：首轮 references 也渲染 interaction；answered 显示答案', () => {
  const task = taskRecord({ issueId: 'issue-1' })
  const xml = castboardTaskContext(task, 'D:/repo', [], [controlComment(requested)])
  assert.ok(xml.includes('<interaction id="i-1" kind="question" status="pending"'))
  assert.ok(xml.includes('Waiting for the dispatcher'))
  assert.ok(!xml.includes('"schema"'))

  const answered = threadComment({
    id: 'c-answer',
    body: encodeInteraction({
      ...requested,
      at: requested.at + 1,
      event: 'answered',
      by: { role: 'assigner' },
      answer: { answers: [{ questionId: 'q-1', selected: ['仅测试'] }] },
    }),
    role: 'assigner',
    authorType: 'system',
  })
  const answeredXml = castboardTaskContext(task, 'D:/repo', [], [answered])
  assert.ok(answeredXml.includes('status="answered"'))
  assert.ok(answeredXml.includes('<label>仅测试</label>'))
})
