import assert from 'node:assert/strict'
import { test } from 'node:test'

import { interactionTools } from '../src/host/tools/interaction-tools.ts'
import type { InteractionView } from '../src/host/exec/interaction-projection.ts'
import type { ThreadComment } from '../src/host/ledger/comment-store.ts'
import { taskRecord } from './helpers.ts'
import {
  decodeInteraction,
  type AnsweredQuestionEvent,
} from '../src/shared/interaction-protocol.ts'

const request: InteractionView = {
  interactionId: 'i-1',
  issueId: 'issue-1',
  sessionId: 'executor',
  kind: 'question',
  status: 'pending',
  requestedAt: 100,
  request: {
    questions: [{
      id: 'q-1',
      question: '选哪个？',
      options: [{ label: 'a' }, { label: 'b' }],
    }],
  },
}

const dispatcher = { agent: { session: { id: 'dispatcher' } } } as never
const observer = { agent: { session: { id: 'observer' } } } as never

function tools(views: readonly InteractionView[] = [request], options: { enabled?: boolean } = {}) {
  const controls: Array<{ anchorId: string; body: string; role: string }> = []
  const list = interactionTools({
    projection: {
      of: async () => views,
      invalidate: () => {},
    },
    thread: {
      addControl: async (anchorId, draft) => {
        controls.push({ anchorId, body: draft.body, role: draft.role })
        return undefined as unknown as ThreadComment
      },
    },
    interactions: {
      list: () => [],
      answerRemote: async () => false,
    },
    links: {
      get: () => ({ assignerSessionId: 'dispatcher', assigneeSessionId: 'executor' }),
    },
    tasks: {
      get: () => taskRecord({ id: 't-1', issueId: 'issue-1' }),
    },
    ...(options.enabled === undefined ? {} : { enabled: () => options.enabled === true }),
    now: () => 1_000,
  })
  const listTool = list.find(tool => tool.name === 'castboard_interactions_list')
  const answerTool = list.find(tool => tool.name === 'castboard_interaction_answer')
  assert.ok(listTool !== undefined)
  assert.ok(answerTool !== undefined)
  return { controls, listTool, answerTool }
}

test('interaction tools：列交互与回答 question', async () => {
  const { controls, listTool, answerTool } = tools()
  const listed = await listTool.execute({ issueId: 'issue-1' }, dispatcher)
  assert.deepEqual(listed, {
    issueId: 'issue-1',
    interactions: [{
      interactionId: 'i-1',
      kind: 'question',
      status: 'pending',
      sessionId: 'executor',
      request: request.request,
      requestedAt: 100,
    }],
  })

  const answered = await answerTool.execute({
    issueId: 'issue-1',
    interactionId: 'i-1',
    answers: [{ questionId: 'q-1', selected: ['a'] }],
  }, dispatcher)
  assert.deepEqual(answered, { ok: true, status: 'accepted', interactionId: 'i-1' })
  assert.equal(controls.length, 1)
  assert.equal(controls[0]!.role, 'assigner')
  const event = decodeInteraction(controls[0]!.body)
  assert.equal(event.ok, true)
  if (!event.ok) return
  assert.equal(event.event.event, 'answered')
  assert.equal(event.event.sessionId, 'executor')
  if (event.event.kind !== 'question') return
  assert.deepEqual((event.event as AnsweredQuestionEvent).answer.answers, [{ questionId: 'q-1', selected: ['a'] }])
  assert.deepEqual(event.event.by, { role: 'assigner', sessionId: 'dispatcher' })
})

test('interaction tools：approval / 非 assigner / stale / 非法选项', async () => {
  const approval: InteractionView = {
    interactionId: 'a-1',
    issueId: 'issue-1',
    sessionId: 'executor',
    kind: 'approval',
    status: 'pending',
    requestedAt: 100,
    request: { toolName: 'bash', reason: '迁移' },
  }
  const { answerTool } = tools([approval])
  const answered = await answerTool.execute({
    issueId: 'issue-1',
    interactionId: 'a-1',
    decision: 'rejected',
    note: '不跑',
  }, dispatcher)
  assert.deepEqual(answered, { ok: true, status: 'accepted', interactionId: 'a-1' })

  await assert.rejects(
    () => Promise.resolve(answerTool.execute({
      issueId: 'issue-1',
      interactionId: 'a-1',
      decision: 'rejected',
    }, observer)),
  )

  const stale = await answerTool.execute({
    issueId: 'issue-1',
    interactionId: 'missing',
    decision: 'rejected',
  }, dispatcher)
  assert.deepEqual(stale, { ok: false, status: 'stale', interactionId: 'missing', message: '交互不存在、已应答或已关闭' })

  const invalid = tools([request]).answerTool
  await assert.rejects(
    () => Promise.resolve(invalid.execute({
      issueId: 'issue-1',
      interactionId: 'i-1',
      answers: [{ questionId: 'q-1', selected: ['nope'] }],
    }, dispatcher)),
  )
})

test('interaction tools：commentsEnabled=false 时拒绝应答', async () => {
  const { controls, answerTool } = tools([request], { enabled: false })
  await assert.rejects(
    () => Promise.resolve(answerTool.execute({
      issueId: 'issue-1',
      interactionId: 'i-1',
      answers: [{ questionId: 'q-1', selected: ['a'] }],
    }, dispatcher)),
    /评论通道已关闭/,
  )
  assert.equal(controls.length, 0)
})
