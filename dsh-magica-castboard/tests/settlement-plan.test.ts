import { test } from 'node:test'
import assert from 'node:assert/strict'

import { revertToTodo, settlePlan } from '../src/host/exec/settlement.ts'
import type { TaskRecord, TurnSettlementLike } from '../src/host/model.ts'

function settlement(kind: TurnSettlementLike['kind']): TurnSettlementLike {
  return { kind, completed: false, texts: [], externallyDisposed: false }
}

test('completed is the only successful outcome', () => {
  assert.deepEqual(settlePlan(settlement('completed')), { outcome: 'succeeded' })
})

test('aborted is a cancellation, not a failure and not success', () => {
  assert.deepEqual(settlePlan(settlement('aborted')), { outcome: 'cancelled', to: 'todo' })
})

test('blocked, max-tokens, interrupted and error all fail back to todo', () => {
  for (const kind of ['blocked', 'max-tokens', 'interrupted', 'error'] as const) {
    const plan = settlePlan(settlement(kind))
    assert.equal(plan.outcome, 'failed', kind)
    assert.equal(plan.to, 'todo', kind)
    assert.ok(plan.error !== undefined && plan.error !== '', kind)
  }
})

test('a missing turn/end is a failure, never success', () => {
  const plan = settlePlan(settlement(undefined))
  assert.equal(plan.outcome, 'failed')
  assert.equal(plan.to, 'todo')
})

test('an unknown future kind is treated as a failure', () => {
  const plan = settlePlan({ kind: 'future-kind', completed: false, texts: [] } as unknown as TurnSettlementLike)
  assert.equal(plan.outcome, 'failed')
  assert.equal(plan.to, 'todo')
})

test('revertToTodo only rolls an in-progress card back and releases the claim', () => {
  const task = {
    id: 't-1',
    status: 'in_progress',
    claimedBy: 'session-1',
    claimedAt: 1,
    updatedAt: 1,
  } as unknown as TaskRecord
  assert.equal(revertToTodo(task, 2), true)
  assert.equal(task.status, 'todo')
  assert.equal(task.updatedAt, 2)
  assert.equal(task.claimedBy, undefined)
  assert.equal(revertToTodo(task, 3), false)
})
