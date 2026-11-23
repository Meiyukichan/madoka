/**
 * issue 收尾（raw/host/10）：终态映射、只认跑过的卡、幂等、产物过滤与远端回写。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { IssueFinalizer } from '../src/host/pipeline/finalize.ts'
import { IssueStore } from '../src/host/ledger/issue-store.ts'
import { TaskStore } from '../src/host/ledger/task-store.ts'
import type { TaskRecord } from '../src/host/model.ts'
import { taskRecord, tempRoot } from './helpers.ts'

async function setup(t: { after: (fn: () => void) => void }) {
  const root = tempRoot(t)
  const issues = new IssueStore({ dir: root })
  const tasks = new TaskStore({ dir: root })
  const issue = await issues.create({
    title: '需求',
    detail: '正文',
    workspaceId: 'ws-1',
    urgency: 'normal',
  })
  await issues.update(issue.id, draft => {
    draft.status = 'running'
  })
  const task = taskRecord({
    id: 't-1',
    issueId: issue.id,
    status: 'in_progress',
    cwd: 'D:/repo',
    executions: [{
      id: 'e-1',
      trigger: 'manual',
      outcome: 'succeeded',
      sessionId: 'session-1',
      report: {
        summary: '做完',
        changedFiles: ['src/a.ts'],
        checks: ['pnpm test'],
        artifacts: ['a.txt', 'already.txt'],
        risk: '',
      },
    }],
  })
  await tasks.mutate('task-created', ledger => {
    ledger.tasks.push(task)
    return [task]
  })
  return { issues, tasks, issue, task }
}

test('收尾：done → success，写 assigneeMeta，重试 report 里的产物', async (t) => {
  const { issues, tasks, issue, task } = await setup(t)
  const calls: Array<{ issueId: string; status: string }> = []
  const uploads: Array<{ issueId: string; artifacts: readonly string[]; cwd?: string }> = []
  const finalizer = new IssueFinalizer({
    issues,
    now: () => 1_000,
    uploadArtifacts: async (issueId, artifacts, options) => {
      uploads.push({ issueId, artifacts, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) })
    },
    issueFinalize: async (issueId, input) => {
      calls.push({ issueId, status: input.status })
    },
  })
  finalizer.attach(tasks)
  await tasks.mutate('task-moved', ledger => {
    const current = ledger.tasks.find(item => item.id === task.id)
    if (current === undefined) return undefined
    current.status = 'done'
    return [current]
  })
  await finalizer.settled()

  const updated = await issues.get(issue.id)
  assert.equal(updated?.status, 'success')
  assert.equal(updated?.assigneeTask, task.id)
  const meta = updated?.assigneeMeta as Record<string, unknown>
  assert.equal(meta.summary, '做完')
  assert.equal(meta.taskId, task.id)
  assert.equal(meta.sessionId, 'session-1')
  assert.deepEqual(meta.executions, task.executions)
  assert.deepEqual(uploads, [{
    issueId: issue.id,
    artifacts: ['a.txt', 'already.txt'],
    cwd: 'D:/repo',
  }])
  assert.deepEqual(calls, [{ issueId: issue.id, status: 'success' }])
})

test('收尾：没跑过的卡、非主人、已 success 的 issue 都不动', async (t) => {
  const { issues, tasks, issue } = await setup(t)
  // No execution records: never ran.
  const never: TaskRecord = taskRecord({ id: 't-2', issueId: issue.id, status: 'in_progress', executions: [] })
  await tasks.mutate('task-created', ledger => {
    ledger.tasks.push(never)
    return [never]
  })
  const calls: string[] = []
  const finalizer = new IssueFinalizer({
    issues,
    now: () => 2_000,
    isOwner: () => false,
    issueFinalize: async () => { calls.push('finalize') },
  })
  finalizer.attach(tasks)
  await tasks.mutate('task-moved', ledger => {
    const current = ledger.tasks.find(item => item.id === never.id)
    if (current === undefined) return undefined
    current.status = 'done'
    return [current]
  })
  await finalizer.settled()
  assert.equal((await issues.get(issue.id))?.status, 'running')
  assert.deepEqual(calls, [])
})

test('收尾：abandoned → abandoned', async (t) => {
  const { issues, tasks, issue, task } = await setup(t)
  const finalized: Array<{ issueId: string; status: string }> = []
  const finalizer = new IssueFinalizer({
    issues,
    now: () => 3_000,
    issueFinalize: async (issueId, input) => { finalized.push({ issueId, status: input.status }) },
  })
  finalizer.attach(tasks)
  await tasks.mutate('task-moved', ledger => {
    const current = ledger.tasks.find(item => item.id === task.id)
    if (current === undefined) return undefined
    current.status = 'abandoned'
    return [current]
  })
  await finalizer.settled()
  assert.deepEqual(finalized, [{ issueId: issue.id, status: 'abandoned' }])
  assert.equal((await issues.get(issue.id))?.status, 'abandoned')
})
