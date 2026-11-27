import assert from 'node:assert/strict'
import { test } from 'node:test'

import { InteractionReporter } from '../src/host/exec/interaction-reporter.ts'
import type { PendingInteraction } from '../src/host/exec/interactions.ts'
import { decodeInteraction } from '../src/shared/interaction-protocol.ts'

interface Recorded {
  anchorId: string
  draft: {
    id?: string
    body: string
    role: string
    threadId?: string
    createdAt?: number
    systemKey?: string
  }
}

interface Harness {
  reporter: InteractionReporter
  readonly comments: Recorded[]
  items: PendingInteraction[]
  outcome?: 'answered' | 'cancelled' | 'expired' | 'reporting_disabled' | 'unknown'
  enabled: boolean
  commentsEnabled: boolean
}

function harness(overrides: {
  items?: PendingInteraction[]
  enabled?: boolean
  commentsEnabled?: boolean
  projection?: readonly unknown[]
  outcome?: Harness['outcome']
} = {}): Harness {
  const comments: Recorded[] = []
  const state: Harness = {
    reporter: undefined as never,
    comments,
    items: overrides.items ?? [],
    outcome: overrides.outcome,
    enabled: overrides.enabled ?? true,
    commentsEnabled: overrides.commentsEnabled ?? true,
  }
  const deps = {
    interactions: {
      refreshResult: async () => ({ items: state.items, ok: true }),
      outcomeOf: () => state.outcome,
      takeOutcome: () => {
        const value = state.outcome
        state.outcome = undefined
        return value
      },
    },
    tasks: {
      get: () => ({ id: 't-1', issueId: 'issue-1', trashedAt: undefined }),
      taskIdOfSession: (sessionId: string) => sessionId === 's-1' ? 't-1' : undefined,
      summaries: () => [],
    },
    links: {
      get: () => ({ assigneeSessionId: 's-1' }),
      issueIds: () => ['issue-1'],
    },
    thread: {
      addControl: async (anchorId: string, draft: Recorded['draft']) => {
        comments.push({ anchorId, draft })
        return undefined
      },
      list: async () => [],
    },
    projection: {
      of: async () => overrides.projection ?? [],
    },
    settings: () => ({
      commentsEnabled: state.commentsEnabled,
      interactionReportEnabled: state.enabled,
    }),
    instance: () => '127.0.0.1:3080',
    now: () => 1_000,
  }
  state.reporter = new InteractionReporter(deps as never)
  return state
}

const pending: PendingInteraction = {
  id: 'i-1',
  kind: 'question',
  sessionId: 's-1',
  taskId: 't-1',
  title: '选哪个',
  body: '选哪个？',
  options: ['a', 'b'],
  createdAt: 100,
}

test('Reporter：新 pending 写 requested，消失后写 completed', async () => {
  const state = harness({ items: [pending] })
  await state.reporter.tick()
  assert.equal(state.comments.length, 1)
  const requested = decodeInteraction(state.comments[0]!.draft.body)
  assert.equal(requested.ok, true)
  if (!requested.ok) return
  assert.equal(requested.event.event, 'requested')
  assert.equal(requested.event.issueId, 'issue-1')
  assert.equal(requested.event.sessionId, 's-1')
  assert.equal(state.comments[0]!.draft.role, 'assignee')
  assert.equal(state.comments[0]!.draft.threadId, 's-1')
  assert.equal(state.comments[0]!.draft.systemKey, 'castboard.interaction.requested')

  await state.reporter.tick()
  assert.equal(state.comments.length, 1, '同一条 pending 不重复 requested')

  state.items = []
  state.outcome = 'answered'
  await state.reporter.tick()
  assert.equal(state.comments.length, 2)
  const completed = decodeInteraction(state.comments[1]!.draft.body)
  assert.equal(completed.ok, true)
  if (!completed.ok || completed.event.event !== 'completed') return
  assert.equal(completed.event.outcome, 'answered')
})

test('Reporter：关闭开关不发新 requested，打开后补发', async () => {
  const state = harness({ items: [pending], enabled: false })
  await state.reporter.tick()
  assert.equal(state.comments.length, 0)
  state.enabled = true
  await state.reporter.tick()
  assert.equal(state.comments.length, 1)
})

test('Reporter：commentsEnabled=false 停 requested/completed，重新打开后补', async () => {
  const state = harness({ items: [pending], commentsEnabled: false })
  await state.reporter.tick()
  assert.equal(state.comments.length, 0, '评论通道关闭时一条控制评论都不写')

  state.commentsEnabled = true
  await state.reporter.tick()
  assert.equal(state.comments.length, 1, '重新打开后补 requested')

  state.items = []
  state.outcome = 'answered'
  state.commentsEnabled = false
  await state.reporter.tick()
  assert.equal(state.comments.length, 1, '关闭时 completed 也停')

  state.commentsEnabled = true
  await state.reporter.tick()
  assert.equal(state.comments.length, 2, '重新打开后补 completed')
})

test('Reporter：重启后从 projection 收养并补 expired', async () => {
  const state = harness({
    items: [],
    projection: [{
      interactionId: 'i-1',
      issueId: 'issue-1',
      sessionId: 's-1',
      kind: 'question',
      status: 'pending',
      requestedAt: 100,
    }],
  })
  await state.reporter.tick()
  assert.equal(state.reporter.isSeeded, true)
  assert.equal(state.comments.length, 1)
  const completed = decodeInteraction(state.comments[0]!.draft.body)
  assert.equal(completed.ok, true)
  if (!completed.ok || completed.event.event !== 'completed') return
  assert.equal(completed.event.outcome, 'expired')
})

test('Reporter：seeded 但有本地 apply 证据时写真实 outcome', async () => {
  const state = harness({
    items: [],
    outcome: 'answered',
    projection: [{
      interactionId: 'i-1',
      issueId: 'issue-1',
      sessionId: 's-1',
      kind: 'question',
      status: 'answered',
      requestedAt: 100,
      answeredAt: 200,
    }],
  })
  await state.reporter.tick()
  const completed = decodeInteraction(state.comments[0]!.draft.body)
  assert.equal(completed.ok, true)
  if (!completed.ok || completed.event.event !== 'completed') return
  assert.equal(completed.event.outcome, 'answered')
})
