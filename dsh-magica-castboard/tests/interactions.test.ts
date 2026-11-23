/** 待决交互服务：两类记录合并、按卡片过滤、应答后摘除、读取失败保留上一次。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { InteractionService, type PendingInteraction } from '../src/host/exec/interactions.ts'
import { interactionRecords } from '../src/host/http/routes/shared.ts'

const approval: PendingInteraction = {
  id: 'ap-1', kind: 'approval', sessionId: 's-1', taskId: 't-1',
  title: '要执行 rm', body: 'rm -rf /tmp/x', createdAt: 1,
}
const question: PendingInteraction = {
  id: 'q-1', kind: 'question', sessionId: 's-1', taskId: 't-1',
  title: '选哪个', body: '用 a 还是 b', options: ['a', 'b'], createdAt: 2,
}

test('InteractionService：refresh 合并两类、ofTask 过滤、应答后摘除', async () => {
  const answered: string[] = []
  const service = new InteractionService({
    now: () => 1,
    face: {
      listPendingApprovals: async () => [approval],
      listPendingQuestions: async () => [question],
      answerApproval: async input => { answered.push(`approval:${input.id}:${input.approved}`) },
      answerQuestion: async input => { answered.push(`question:${input.id}:${input.answer}`) },
      cancelQuestion: async input => { answered.push(`cancel:${input.id}`) },
    },
  })
  const all = await service.refresh()
  assert.equal(all.length, 2)
  assert.equal(service.ofTask('t-1').length, 2)
  assert.equal(service.ofTask('t-2').length, 0)

  assert.equal(await service.answerApproval('ap-1', true), true)
  assert.equal(service.list().length, 1)
  assert.equal(await service.answerQuestion('q-1', 'b'), true)
  assert.equal(service.list().length, 0)
  assert.deepEqual(answered, ['approval:ap-1:true', 'question:q-1:b'])
  assert.equal(await service.answerApproval('nope', true), false)
})

test('InteractionService：多选答案把整组 selected 交给 face', async () => {
  let received: readonly string[] | undefined
  const multi: PendingInteraction = {
    id: 'q-multi', kind: 'question', sessionId: 's-1',
    title: '多选', body: '选几个', options: ['a', 'b', 'c'], multiSelect: true, createdAt: 3,
  }
  const service = new InteractionService({
    now: () => 1,
    face: {
      listPendingQuestions: async () => [multi],
      answerQuestion: async input => { received = input.selected },
    },
  })
  await service.refresh()
  const [record] = interactionRecords([multi])
  assert.equal(record?.kind, 'question')
  if (record?.kind !== 'question') throw new Error('expected a question record')
  assert.equal(record.questions[0]?.multiSelect, true)
  assert.equal(await service.answerQuestion('q-multi', '', ['a', 'c']), true)
  assert.deepEqual(received, ['a', 'c'])
})

test('InteractionService：无 face 时为空、读失败保留上一次、取消提问', async () => {
  const empty = new InteractionService({ now: () => 1 })
  assert.deepEqual(await empty.refresh(), [])

  let fail = false
  const cancelled: string[] = []
  const flaky = new InteractionService({
    now: () => 1,
    face: {
      listPendingApprovals: async () => {
        if (fail) throw new Error('net')
        return [approval]
      },
      listPendingQuestions: async () => [question],
      cancelQuestion: async input => { cancelled.push(input.id) },
    },
  })
  await flaky.refresh()
  assert.equal(flaky.list().length, 2)
  fail = true
  await flaky.refresh()
  assert.equal(flaky.list().length, 2, '读失败保留上一次')

  fail = false
  await flaky.refresh()
  assert.equal(await flaky.cancelQuestion('q-1'), true)
  assert.deepEqual(cancelled, ['q-1'])
  assert.equal(flaky.list().some(item => item.id === 'q-1'), false)
  assert.equal(await flaky.cancelQuestion('nope'), false)
})
