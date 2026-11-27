/**
 * 上下文消息的 V4 source 形状：form 正确、notice 带 summary、不再写 plugin 字段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildContextMessage } from '../src/host/exec/engine.ts'

function sourceOf(message: unknown): Record<string, unknown> {
  return (message as { source: Record<string, unknown> }).source
}

test('snapshot：kind + form + sections，且没有退役的 plugin 字段', () => {
  const source = sourceOf(buildContextMessage('castboard-task-context', '<task/>'))
  assert.deepEqual(source, {
    kind: 'castboard-task-context',
    form: 'snapshot',
    sections: [{ name: 'castboard-task-context', text: '<task/>' }],
  })
  assert.equal('plugin' in source, false)
})

test('instructions：只带 kind + form，不伪造 sections', () => {
  assert.deepEqual(
    sourceOf(buildContextMessage('castboard-task-protocol', 'rules', 'instructions')),
    { kind: 'castboard-task-protocol', form: 'instructions' },
  )
})

test('notice：必须带 summary，且不伪造 sections', () => {
  assert.deepEqual(
    sourceOf(buildContextMessage('castboard-issue-comments', 'comments', 'notice', 'New comments')),
    { kind: 'castboard-issue-comments', form: 'notice', summary: 'New comments' },
  )
  assert.throws(
    () => buildContextMessage('castboard-issue-comments', 'comments', 'notice'),
    /has no summary/,
  )
})

test("拒绝 kind='plugin'", () => {
  assert.throws(() => buildContextMessage('plugin', 'x'), /must not be 'plugin'/)
})
