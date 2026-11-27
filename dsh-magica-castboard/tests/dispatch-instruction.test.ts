/** 分发指令：目标三字段以属性交给模型，请求正文单独转义。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { taskDispatchInstruction } from '../src/host/context/task-instruction.ts'
import { taskRecord } from './helpers.ts'

test('taskDispatchInstruction：target 三字段进属性，请求正文转义', () => {
  const xml = taskDispatchInstruction(taskRecord({ id: 't-1', title: '卡 <A>' }), {
    text: '拆成两条 <request>',
    projectId: 'g-1',
    assignee: 'user-123',
    assigneeInstance: '127.0.0.1:3080',
  })
  assert.ok(xml.startsWith('<castboard_task_dispatch>'))
  assert.match(xml, /<task id="t-1">/)
  assert.match(xml, /<title>卡 &lt;A&gt;<\/title>/)
  assert.match(xml, /<target project="g-1" assignee="user-123" instance="127.0.0.1:3080"\/>/)
  assert.match(xml, /<request>拆成两条 &lt;request&gt;<\/request>/)
  assert.match(xml, /<step order="1">Call castboard_issue \(capability="help"\)/)
  assert.match(xml, /<constraints>Do not change this task's status/)
})

test('taskDispatchInstruction：没有实例时只输出两个属性；request 原样保留引号', () => {
  const xml = taskDispatchInstruction(taskRecord({ id: 't-2', title: '卡' }), {
    text: '说 "好"',
    projectId: 'g-2',
    assignee: 'user-456',
  })
  assert.match(xml, /<target project="g-2" assignee="user-456"\/>/)
  assert.doesNotMatch(xml, /instance=/)
  assert.match(xml, /<request>说 "好"<\/request>/)
})
