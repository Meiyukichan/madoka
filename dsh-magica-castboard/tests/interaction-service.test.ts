import assert from 'node:assert/strict'
import { test } from 'node:test'

import { InteractionService, type PendingInteraction } from '../src/host/exec/interactions.ts'

const approval: PendingInteraction = {
  id: 'ap-1',
  kind: 'approval',
  sessionId: 's-1',
  taskId: 't-1',
  title: '要执行 rm',
  body: 'rm -rf /tmp/x',
  createdAt: 1,
}

test('InteractionService：refreshResult 区分成功/失败，失败保留 cache', async () => {
  const empty = new InteractionService({ now: () => 1 })
  const emptyResult = await empty.refreshResult()
  assert.equal(emptyResult.ok, false, '没有 face 时不能声称“没有 pending”')
  assert.deepEqual(emptyResult.items, [])

  let fail = false
  const service = new InteractionService({
    now: () => 1,
    face: {
      listPendingApprovals: async () => {
        if (fail) throw new Error('net')
        return [approval]
      },
    },
  })

  const first = await service.refreshResult()
  assert.equal(first.ok, true)
  assert.equal(first.items.length, 1)

  fail = true
  const second = await service.refreshResult()
  assert.equal(second.ok, false)
  assert.equal(second.items.length, 1, '失败时保留上一次快照')

  fail = false
  const third = await service.refreshResult()
  assert.equal(third.ok, true)
  assert.equal(third.items.length, 1)
})

test('InteractionService：outcome 先到先得，take 后清空', () => {
  const service = new InteractionService({ now: () => 1 })
  service.noteOutcome('a-1', 'answered')
  service.noteOutcome('a-1', 'cancelled')
  assert.equal(service.outcomeOf('a-1'), 'answered')
  assert.equal(service.takeOutcome('a-1'), 'answered')
  assert.equal(service.outcomeOf('a-1'), undefined)
})

test('InteractionService：answerApproval 记录 answered', async () => {
  const service = new InteractionService({
    now: () => 1,
    face: {
      listPendingApprovals: async () => [approval],
      answerApproval: async () => {},
    },
  })
  await service.refresh()
  assert.equal(await service.answerApproval('ap-1', true), true)
  assert.equal(service.outcomeOf('ap-1'), 'answered')
  assert.equal(service.list().length, 0)
})
