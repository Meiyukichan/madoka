/** 人读渲染：工具把 JSON 结果压成模型与人都能读的多行文本。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderHuman } from '../src/host/tools/shared.ts'

test('renderHuman：degraded / items / issueIds / task+link+comments 四种形状', () => {
  assert.equal(renderHuman({ degraded: true, reason: '未登录' }), '共享库不可用：未登录')
  assert.equal(
    renderHuman({ items: [{ id: 'g-1', label: '项目组 A' }, { id: 'g-2', label: '项目组 B', detail: '备注' }] }),
    '- 项目组 A（g-1）\n- 项目组 B（g-2） — 备注',
  )
  assert.equal(renderHuman({ items: [] }), '（空）')
  assert.equal(renderHuman({ issueIds: ['i-1', 'i-2'] }), '已建 2 条：i-1, i-2')
  assert.equal(renderHuman('纯文本'), '纯文本')
  assert.equal(renderHuman(42), '42')

  const mixed = renderHuman({
    task: { id: 't-1', title: '卡', status: 'in_review' },
    link: { assignerSessionId: 's-1', assigneeSessionId: 's-2', assigneeTaskId: 't-1' },
    comments: [{}, {}],
  })
  assert.ok(mixed.includes('任务 t-1'))
  assert.ok(mixed.includes('assignerSessionId=s-1'))
  assert.ok(mixed.includes('assigneeSessionId=s-2'))
  assert.ok(mixed.includes('评论 2 条'))
})

test('renderHuman：未知对象退回 JSON，不抛错', () => {
  assert.equal(renderHuman({ foo: 'bar' }), '{"foo":"bar"}')
  const emptyLink = renderHuman({ link: {} })
  assert.equal(emptyLink, '{"link":{}}')
})
