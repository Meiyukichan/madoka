import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { spillExecutionError, MAX_INLINE_ERROR_CHARS } from '../src/host/exec/error-file.ts'
import { taskRecord, tempRoot } from './helpers.ts'

const ISSUE = '11111111-1111-4111-8111-111111111111'
const LONG = 'x'.repeat(MAX_INLINE_ERROR_CHARS + 1)

function failedTask(error: string) {
  return taskRecord({
    id: 't-1',
    executions: [{
      id: 'e-1',
      trigger: 'manual',
      outcome: 'failed',
      startedAt: 1,
      endedAt: 2,
      error,
    }],
  })
}

test('error-file：超长 error 落盘，task context 只留路径，原 task 不变', async (t) => {
  const root = tempRoot(t)
  const task = failedTask(LONG)
  const spilled = await spillExecutionError(task, { cacheDir: root, ownerId: ISSUE })
  const file = join(root, ISSUE, 'last-execution.log')

  assert.equal(spilled.executions[0]?.error, file)
  assert.equal(task.executions[0]?.error, LONG)
  assert.equal(await readFile(file, 'utf8'), LONG)
})

test('error-file：短 error 保持内联', async (t) => {
  const root = tempRoot(t)
  const task = failedTask('boom')
  const spilled = await spillExecutionError(task, { cacheDir: root, ownerId: ISSUE })
  assert.equal(spilled, task)
})
