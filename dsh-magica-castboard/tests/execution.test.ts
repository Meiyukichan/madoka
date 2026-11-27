/**
 * 执行引擎：一次 mutate 的启动闸门、并发名额、启动期取消、结算落态、会话池去留与启动对账。
 *
 * 会话门面全部用可控假句柄：turn 的结局由用例决定，这样状态机可以完整覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ExecutionService,
  keepsSession,
  type SessionHandle,
  type SessionsFace,
} from '../src/host/exec/engine.ts'
import { TaskStore } from '../src/host/ledger/task-store.ts'
import type { ExecutionReport, TaskRecord, TurnSettlementLike } from '../src/host/model.ts'
import { taskRecord, tempRoot } from './helpers.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

interface FakeHandle {
  handle: SessionHandle
  first: Deferred<TurnSettlementLike>
  calls: { injected: number; steered: number; cancelled: number; disposed: number }
}

function fakeHandle(id = 'session-1'): FakeHandle {
  const first = deferred<TurnSettlementLike>()
  const calls = { injected: 0, steered: 0, cancelled: 0, disposed: 0 }
  const handle: SessionHandle = {
    id,
    firstTurn: first.promise,
    followUp: () => {
      const next = deferred<TurnSettlementLike>()
      return next.promise
    },
    followupNamedContext: async () => ({ kind: 'completed', completed: true, texts: [], externallyDisposed: false }),
    injectContext: () => { calls.injected += 1; return true },
    steer: () => { calls.steered += 1; return true },
    cancel: () => { calls.cancelled += 1 },
    dispose: async () => { calls.disposed += 1 },
    getState: () => ({}),
  }
  return { handle, first, calls }
}

function sessionsWith(handles: FakeHandle[]): SessionsFace {
  let index = 0
  return {
    start: async () => {
      const entry = handles[index++]
      if (entry === undefined) throw new Error('no more fake handles')
      return entry.handle
    },
    resume: async () => {
      const entry = handles[index++]
      if (entry === undefined) throw new Error('no more fake handles')
      return entry.handle
    },
  }
}

function settleCompleted(): TurnSettlementLike {
  return { kind: 'completed', completed: true, texts: [], externallyDisposed: false }
}

async function seeded(t: { after: (fn: () => void) => void }, records: TaskRecord[]): Promise<{ root: string; tasks: TaskStore }> {
  const root = tempRoot(t)
  const tasks = new TaskStore({ dir: root })
  for (const record of records) {
    await tasks.mutate('task-created', (ledger) => {
      ledger.tasks.push(record)
      return [record]
    })
  }
  return { root, tasks }
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition not reached')
}

test('run：抢到闸门、记会话、结算成功后自动移入待验收', async (t) => {
  const { tasks } = await seeded(t, [taskRecord({ id: 't-1' })])
  const fake = fakeHandle()
  const started: string[] = []
  const sessions: SessionsFace = {
    start: async () => {
      started.push('start')
      return fake.handle
    },
  }
  const service = new ExecutionService({
    tasks,
    sessions,
    now: () => 1_000,
    hostInstanceId: 'host-1',
  })

  const result = await service.run('t-1')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.sessionId, 'session-1')
  assert.deepEqual(started, ['start'])

  const running = tasks.get('t-1')
  assert.equal(running?.status, 'in_progress')
  assert.equal(running?.claimedBy, 'session-1')
  assert.equal(running?.executions[0]?.outcome, 'running')
  assert.equal(running?.executions[0]?.sessionId, 'session-1')
  assert.equal(service.inFlight(), 1)
  assert.equal(service.ownsSession('session-1'), true)

  fake.first.resolve(settleCompleted())
  await service.waitForIdle()

  const settled = tasks.get('t-1')
  assert.equal(settled?.status, 'in_review')
  assert.equal(settled?.claimedBy, undefined)
  assert.equal(settled?.executions[0]?.outcome, 'succeeded')
  assert.equal(service.inFlight(), 0)
  assert.equal(keepsSession(settled?.status ?? ''), true)
  service.dispose()
})

test('run：同一张卡重复启动被闸门拒绝', async (t) => {
  const { tasks } = await seeded(t, [taskRecord({ id: 't-1' })])
  const fake = fakeHandle()
  const service = new ExecutionService({
    tasks,
    sessions: sessionsWith([fake]),
    now: () => 1,
    hostInstanceId: 'host-1',
  })
  assert.equal((await service.run('t-1')).ok, true)
  const second = await service.run('t-1')
  assert.equal(second.ok, false)
  if (!second.ok) assert.match(second.error, /already in progress/)
  fake.first.resolve(settleCompleted())
  await service.waitForIdle()
  service.dispose()
})

test('run：并发上限在闸门内生效，im 不占名额', async (t) => {
  const { tasks } = await seeded(t, [
    taskRecord({ id: 't-1' }),
    taskRecord({ id: 't-2' }),
    taskRecord({ id: 't-3', source: 'im' }),
  ])
  const first = fakeHandle('session-1')
  const im = fakeHandle('session-2')
  let index = 0
  const service = new ExecutionService({
    tasks,
    sessions: {
      start: async () => [first.handle, im.handle][index++]!,
    },
    now: () => 1,
    hostInstanceId: 'host-1',
    // 并发上限来自设置（`castboard.settings.yaml`），运行时装配成 live getter。
    maxConcurrent: () => 1,
  })

  assert.equal((await service.run('t-1')).ok, true)
  const blocked = await service.run('t-2')
  assert.equal(blocked.ok, false)
  if (!blocked.ok) assert.match(blocked.error, /concurrency limit/)
  assert.equal((await service.run('t-3')).ok, true)

  first.first.resolve(settleCompleted())
  im.first.resolve(settleCompleted())
  await service.waitForIdle()
  service.dispose()
})

test('run：没有会话门面时按失败结算并退回待办', async (t) => {
  const { tasks } = await seeded(t, [taskRecord({ id: 't-1' })])
  const service = new ExecutionService({ tasks, now: () => 5, hostInstanceId: 'host-1' })
  const result = await service.run('t-1')
  assert.equal(result.ok, false)
  const task = tasks.get('t-1')
  assert.equal(task?.status, 'todo')
  assert.equal(task?.executions[0]?.outcome, 'failed')
  assert.match(task?.executions[0]?.error ?? '', /no session facade/)
  service.dispose()
})

test('cancel：已登记句柄时走 cancel，aborted 结算为取消并退回待办', async (t) => {
  const { tasks } = await seeded(t, [taskRecord({ id: 't-1' })])
  const fake = fakeHandle()
  const service = new ExecutionService({
    tasks,
    sessions: sessionsWith([fake]),
    now: () => 7,
    hostInstanceId: 'host-1',
  })
  const run = await service.run('t-1')
  assert.equal(run.ok, true)

  const cancelled = await service.cancel('t-1')
  assert.equal(cancelled.ok, true)
  assert.equal(fake.calls.cancelled, 1)

  fake.first.resolve({ kind: 'aborted', completed: false, texts: [], externallyDisposed: false })
  await service.waitForIdle()
  const task = tasks.get('t-1')
  assert.equal(task?.status, 'todo')
  assert.equal(task?.executions[0]?.outcome, 'cancelled')
  assert.equal(task?.claimedBy, undefined)

  const again = await service.cancel('t-1')
  assert.equal(again.ok, false)
  service.dispose()
})

test('cancel：启动窗口内取消会销毁刚建的会话', async (t) => {
  const { tasks } = await seeded(t, [taskRecord({ id: 't-1' })])
  const fake = fakeHandle()
  const started = deferred<SessionHandle>()
  let startedAt = 0
  const service = new ExecutionService({
    tasks,
    sessions: {
      start: async () => {
        startedAt += 1
        return started.promise
      },
    },
    now: () => 9,
    hostInstanceId: 'host-1',
  })

  const runPromise = service.run('t-1')
  await until(() => startedAt === 1)
  const cancelled = await service.cancel('t-1')
  assert.equal(cancelled.ok, true)
  started.resolve(fake.handle)

  const run = await runPromise
  assert.equal(run.ok, false)
  if (!run.ok) assert.match(run.error, /cancelled during startup/)
  assert.equal(fake.calls.disposed, 1)
  assert.equal(tasks.get('t-1')?.status, 'todo')
  service.dispose()
})

test('followUp：台账里有会话时走 resume，而不是新起一条', async (t) => {
  const record = taskRecord({
    id: 't-1',
    executions: [{ id: 'e-0', trigger: 'manual', outcome: 'succeeded', sessionId: 'session-prev' }],
  })
  const { tasks } = await seeded(t, [record])
  const fake = fakeHandle('session-prev')
  const resumes: string[] = []
  const service = new ExecutionService({
    tasks,
    sessions: {
      start: async () => { throw new Error('should resume') },
      resume: async options => {
        resumes.push(options.sessionId)
        return fake.handle
      },
    },
    now: () => 11,
    hostInstanceId: 'host-1',
  })

  const result = await service.followUp('t-1', '继续')
  assert.equal(result.ok, true)
  assert.deepEqual(resumes, ['session-prev'])
  fake.first.resolve(settleCompleted())
  await service.waitForIdle()
  service.dispose()
})

test('wakeForComment：resume 只带具名上下文，不产生 prompt', async (t) => {
  const record = taskRecord({
    id: 't-1',
    status: 'in_review',
    executions: [{ id: 'e-0', trigger: 'manual', outcome: 'succeeded', sessionId: 'session-prev' }],
  })
  const { tasks } = await seeded(t, [record])
  const fake = fakeHandle('session-prev')
  const resumes: Array<{ prompt?: string; context?: readonly { name: string; text: string }[] }> = []
  const service = new ExecutionService({
    tasks,
    sessions: {
      start: async () => { throw new Error('should resume') },
      resume: async options => {
        resumes.push(options)
        return fake.handle
      },
    },
    now: () => 11,
    hostInstanceId: 'host-1',
  })

  const result = await service.wakeForComment('t-1', '<issue_comments/>')
  assert.equal(result.ok, true)
  assert.equal(resumes.length, 1)
  assert.equal(resumes[0]?.prompt, undefined)
  assert.equal(resumes[0]?.context?.[0]?.name, 'castboard-issue-comments')
  assert.equal(resumes[0]?.context?.[0]?.text, '<issue_comments/>')
  fake.first.resolve(settleCompleted())
  await service.waitForIdle()
  service.dispose()
})

test('dispatch：只唤醒保留会话，辅助轮不移动卡片状态', async (t) => {
  const { tasks } = await seeded(t, [taskRecord({
    id: 't-1',
    status: 'in_review',
    executions: [{ id: 'e-0', trigger: 'manual', outcome: 'succeeded', sessionId: 'session-prev' }],
  })])
  const fake = fakeHandle('session-prev')
  const resumed: Array<{ prompt?: string; context?: readonly { name: string; text: string }[] }> = []
  const service = new ExecutionService({
    tasks,
    sessions: {
      start: async () => { throw new Error('should resume') },
      resume: async options => {
        resumed.push(options)
        return fake.handle
      },
    },
    now: () => 13,
    hostInstanceId: 'host-1',
  })

  const result = await service.dispatch('t-1', '拆两件事')
  assert.equal(result.ok, true)
  assert.equal(resumed[0]?.prompt, undefined)
  assert.equal(resumed[0]?.context?.[0]?.name, 'castboard-task-dispatch')
  assert.equal(resumed[0]?.context?.[0]?.text, '拆两件事')
  fake.first.resolve(settleCompleted())
  await service.waitForIdle()

  const task = tasks.get('t-1')
  const dispatch = task?.executions.find(execution => execution.trigger === 'issue-dispatch')
  assert.equal(task?.status, 'in_review')
  assert.equal(dispatch?.assist, true)
  assert.equal(dispatch?.trigger, 'issue-dispatch')
  assert.equal(task?.claimedBy, undefined)
  service.dispose()
})

test('会话去留：卡片离开待验收后释放句柄', async (t) => {
  const { tasks } = await seeded(t, [taskRecord({ id: 't-1' })])
  const fake = fakeHandle()
  const service = new ExecutionService({
    tasks,
    sessions: sessionsWith([fake]),
    now: () => 17,
    hostInstanceId: 'host-1',
  })
  const stop = service.watchReleases()
  await service.run('t-1')
  fake.first.resolve(settleCompleted())
  await service.waitForIdle()
  assert.equal(service.ownsSession('session-1'), true)

  await tasks.mutate('task-moved', (ledger) => {
    const task = ledger.tasks[0]!
    task.status = 'done'
    task.updatedAt = 18
    return [task]
  })
  await until(() => fake.calls.disposed === 1)
  assert.equal(service.ownsSession('session-1'), false)
  stop()
  service.dispose()
})

test('reconcile：只结算上一个宿主进程留下的 running', async (t) => {
  const { tasks } = await seeded(t, [taskRecord({
    id: 't-1',
    status: 'in_progress',
    executions: [
      { id: 'e-prev', trigger: 'manual', outcome: 'running', hostInstanceId: 'host-0' },
      { id: 'e-new', trigger: 'manual', outcome: 'running', hostInstanceId: 'host-1' },
    ],
  })])
  const service = new ExecutionService({ tasks, now: () => 21, hostInstanceId: 'host-1' })
  assert.equal(await service.reconcile(), 1)
  const task = tasks.get('t-1')
  assert.equal(task?.status, 'todo')
  assert.equal(task?.executions[0]?.outcome, 'failed')
  assert.equal(task?.executions[0]?.error, 'interrupted by host restart')
  assert.equal(task?.executions[1]?.outcome, 'running')
  service.dispose()
})

test('recordExecutionReport：挂到本会话正在跑的执行上', async (t) => {
  const { tasks } = await seeded(t, [taskRecord({
    id: 't-1',
    status: 'in_progress',
    executions: [{ id: 'e-1', trigger: 'manual', outcome: 'running', sessionId: 'session-1' }],
  })])
  const service = new ExecutionService({ tasks, now: () => 23, hostInstanceId: 'host-1' })
  const report: ExecutionReport = {
    summary: '做完',
    changedFiles: ['a.ts'],
    checks: ['pnpm test'],
    artifacts: [],
    risk: '',
  }
  assert.deepEqual(await service.recordExecutionReport('session-1', report), { taskId: 't-1', executionId: 'e-1' })
  assert.deepEqual(tasks.get('t-1')?.executions[0]?.report, report)
  assert.equal(await service.recordExecutionReport('', report), undefined)
  service.dispose()
})

test('验收轮是正式执行：用 named context 唤醒并落 trigger=acceptance 记录', async (t) => {
  const { tasks } = await seeded(t, [taskRecord({
    id: 't-1',
    acceptanceStrategies: [{ id: 'a-1', title: '验收', type: 'close', description: '输出结果' }],
  })])
  const base = fakeHandle()
  const named: Deferred<TurnSettlementLike>[] = []
  let instructionFollowups = 0
  const handle: SessionHandle = {
    ...base.handle,
    followUp: (...args) => {
      instructionFollowups += 1
      return base.handle.followUp(...args)
    },
    followupNamedContext: () => {
      const next = deferred<TurnSettlementLike>()
      named.push(next)
      return next.promise
    },
  }
  const service = new ExecutionService({
    tasks,
    sessions: { start: async () => handle },
    now: () => 1_000,
    hostInstanceId: 'host-1',
  })

  await service.run('t-1')
  base.first.resolve(settleCompleted())
  await until(() => tasks.get('t-1')?.executions.some(execution =>
    execution.trigger === 'acceptance' && execution.sessionId !== undefined) === true)

  const review = tasks.get('t-1')
  assert.equal(review?.status, 'in_review')
  const acceptance = review?.executions.find(execution => execution.trigger === 'acceptance')
  assert.equal(acceptance?.outcome, 'running')
  assert.equal(acceptance?.sessionId, 'session-1')
  assert.equal(instructionFollowups, 0) // acceptance woke via named context, not a user follow-up
  assert.equal(named.length, 1)
  await until(() => tasks.get('t-1')?.acceptanceInjectedAt !== undefined)

  // Already injected: a second automatic attempt is a no-op and must not wake another turn.
  await service.startAcceptanceRound('t-1')
  assert.equal(named.length, 1)

  named[0]!.resolve(settleCompleted())
  await until(() => tasks.get('t-1')?.executions.find(execution => execution.trigger === 'acceptance')?.outcome === 'succeeded')
  assert.ok(tasks.get('t-1')?.acceptanceInjectedAt !== undefined)
  service.dispose()
})

test('dispose 之后不再接受新执行', async (t) => {
  const { tasks } = await seeded(t, [taskRecord({ id: 't-1' })])
  const service = new ExecutionService({ tasks, now: () => 1, hostInstanceId: 'host-1' })
  service.dispose()
  const result = await service.run('t-1')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /disposed/)
})
