/**
 * 调度链路：五段 cron（数字时刻入参）、单定时器放行、过期窗口、待办派发顺序与并发名额。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_SLEEP_MS,
  SchedulerService,
  STALE_WINDOW_MS,
  type SchedulerStore,
  type SystemCommentInput,
} from '../src/host/dispatch/scheduler.ts'
import {
  DispatcherService,
  RETRY_MS,
  dispatchOrder,
  needsDispatch,
} from '../src/host/dispatch/dispatcher.ts'
import { nextCronRunAt, nextCronRunAtOrUndefined, withNextRunAt } from '../src/host/dispatch/cron.ts'
import { summarize } from '../src/host/ledger/task-derive.ts'
import { TaskStore } from '../src/host/ledger/task-store.ts'
import type { RunRequestResult, TaskSummary } from '../src/host/model.ts'
import { taskRecord, tempRoot } from './helpers.ts'

const at = (hour: number, minute: number, second = 0): number =>
  new Date(2026, 0, 1, hour, minute, second, 0).getTime()

function summaryOf(overrides: Parameters<typeof taskRecord>[0] = {}): TaskSummary {
  return summarize(taskRecord(overrides))
}

test('cron：五分钟之后、次日、每周与周日 7 的折叠', () => {
  const base = at(10, 30, 20)
  const next = nextCronRunAt('* * * * *', base)
  assert.equal(new Date(next).getHours(), 10)
  assert.equal(new Date(next).getMinutes(), 31)
  assert.equal(new Date(next).getSeconds(), 0)

  const daily = nextCronRunAt('0 3 * * *', base)
  assert.equal(new Date(daily).getDate(), 2)
  assert.equal(new Date(daily).getHours(), 3)

  const sunday = nextCronRunAt('0 0 * * 7', base)
  assert.equal(new Date(sunday).getDay(), 0)
  assert.equal(nextCronRunAt('0 0 * * 0', base), sunday)
})

test('cron：不可调度返回 undefined，永不匹配抛错', () => {
  assert.equal(nextCronRunAtOrUndefined(undefined, at(10, 0)), undefined)
  assert.equal(nextCronRunAtOrUndefined('  ', at(10, 0)), undefined)
  assert.equal(nextCronRunAtOrUndefined('not a cron', at(10, 0)), undefined)
  assert.throws(() => nextCronRunAt('0 0 31 4 *', at(10, 0)), /No valid next date|no future occurrence/)
  assert.throws(() => nextCronRunAt('0 0 30 2 *', at(10, 0)), /No valid next date|no future occurrence/)
  assert.throws(() => nextCronRunAt('0 0 * *', at(10, 0)), /exactly 5 fields/)
  assert.throws(() => nextCronRunAt('61 * * * *', at(10, 0)), /outside of constraint range|out of range/)
})

test('withNextRunAt：只给定时卡补派生值', () => {
  const now = at(10, 0)
  const scheduled = summaryOf({ execution: { mode: 'scheduled', cron: '0 3 * * *' } })
  const withNext = withNextRunAt(scheduled, now)
  assert.equal(withNext.nextRunAt, nextCronRunAt('0 3 * * *', now))

  const queue = summaryOf()
  assert.equal(withNextRunAt(queue, now), queue)
  const broken = summaryOf({ execution: { mode: 'scheduled', cron: 'bad cron' } })
  assert.equal(withNextRunAt(broken, now), broken)
})

interface SchedulerFixture {
  store: SchedulerStore
  tasks: TaskStore
  thread: { addSystem(anchor: string, input: SystemCommentInput): Promise<unknown> }
  systemComments: Array<{ anchor: string; input: SystemCommentInput }>
  timer: { callback: () => void | Promise<void>; delay: number } | undefined
  clock: { now: number }
}

function schedulerFixture(root: string): SchedulerFixture {
  const tasks = new TaskStore({ dir: root })
  const systemComments: SchedulerFixture['systemComments'] = []
  return {
    tasks,
    store: {
      load: () => tasks.load(),
      summaries: () => tasks.summaries(),
      subscribe: listener => tasks.subscribe(listener),
      mutate: (kind, mutator) => tasks.mutate(kind as never, mutator),
    },
    thread: {
      addSystem: async (anchor, input) => {
        systemComments.push({ anchor, input })
        return undefined
      },
    },
    systemComments,
    timer: undefined,
    clock: { now: at(10, 30, 20) },
  }
}

function schedulerOf(fixture: SchedulerFixture): SchedulerService {
  return new SchedulerService({
    store: fixture.store,
    thread: fixture.thread,
    now: () => fixture.clock.now,
    setTimer: (callback, delay) => {
      fixture.timer = { callback, delay }
      return 1
    },
    clearTimer: () => { fixture.timer = undefined },
  })
}

async function seed(fixture: SchedulerFixture, record: ReturnType<typeof taskRecord>): Promise<void> {
  await fixture.tasks.mutate('task-created', (ledger) => {
    ledger.tasks.push(record)
    return [record]
  })
}

test('调度器：武装到最近一张定时卡，到点只打放行令牌', async (t) => {
  const root = tempRoot(t)
  const fixture = schedulerFixture(root)
  await seed(fixture, taskRecord({ id: 't-1', execution: { mode: 'scheduled', cron: '* * * * *' } }))
  await seed(fixture, taskRecord({ id: 't-2', title: '非定时' }))

  const scheduler = schedulerOf(fixture)
  await scheduler.start()
  assert.equal(fixture.timer?.delay, 40_000)

  fixture.clock.now = at(10, 31)
  await fixture.timer?.callback()
  const fired = fixture.tasks.get('t-1')
  assert.equal(fired?.releasedAt, at(10, 31))
  assert.equal(fired?.status, 'todo')
  assert.equal(fixture.tasks.get('t-2')?.releasedAt, undefined)
  assert.equal(fixture.timer?.delay !== undefined, true, '放行后重新武装')
  scheduler.dispose()
})

test('调度器：睡过头超过窗口就作废这一窗', async (t) => {
  const root = tempRoot(t)
  const fixture = schedulerFixture(root)
  await seed(fixture, taskRecord({ id: 't-1', execution: { mode: 'scheduled', cron: '* * * * *' } }))
  const scheduler = schedulerOf(fixture)
  await scheduler.start()

  fixture.clock.now = at(10, 31) + STALE_WINDOW_MS + 1_000
  await fixture.timer?.callback()
  assert.equal(fixture.tasks.get('t-1')?.releasedAt, undefined)
  scheduler.dispose()
})

test('调度器：待验收的定时卡到点退回待办，并释放持有者', async (t) => {
  const root = tempRoot(t)
  const fixture = schedulerFixture(root)
  await seed(fixture, taskRecord({
    id: 't-1',
    status: 'in_review',
    claimedBy: 'session-1',
    execution: { mode: 'scheduled', cron: '* * * * *' },
  }))
  const scheduler = schedulerOf(fixture)
  await scheduler.start()
  fixture.clock.now = at(10, 31)
  await fixture.timer?.callback()
  const fired = fixture.tasks.get('t-1')
  assert.equal(fired?.status, 'todo')
  assert.equal(fired?.claimedBy, undefined)
  assert.equal(fired?.claimedAt, undefined)
  scheduler.dispose()
})

test('调度器：算不出下次时间的 cron 停用并留系统评论', async (t) => {
  const root = tempRoot(t)
  const fixture = schedulerFixture(root)
  await seed(fixture, taskRecord({
    id: 't-1',
    issueId: '11111111-1111-4111-8111-111111111111',
    execution: { mode: 'scheduled', cron: '0 0 31 4 *' },
  }))
  const scheduler = schedulerOf(fixture)
  await scheduler.start()
  for (let attempt = 0; attempt < 50 && fixture.tasks.get('t-1')?.execution.cron !== undefined; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(fixture.tasks.get('t-1')?.execution.cron, undefined)
  assert.equal(fixture.systemComments.length, 1)
  assert.equal(fixture.systemComments[0]?.anchor, '11111111-1111-4111-8111-111111111111')
  assert.equal(fixture.systemComments[0]?.input.systemKey, 'sys.cronDead')
  assert.equal(fixture.timer, undefined)
  scheduler.dispose()
})

test('调度器：睡眠上限一小时', async (t) => {
  const root = tempRoot(t)
  const fixture = schedulerFixture(root)
  await seed(fixture, taskRecord({ id: 't-1', execution: { mode: 'scheduled', cron: '0 3 * * *' } }))
  const scheduler = schedulerOf(fixture)
  await scheduler.start()
  assert.equal(fixture.timer?.delay, MAX_SLEEP_MS)
  scheduler.dispose()
})

test('派发条件：待办才排队，定时卡要有放行令牌，失败不自动重跑', () => {
  assert.equal(needsDispatch(summaryOf()), true)
  assert.equal(needsDispatch(summaryOf({ blocked: true })), false)
  assert.equal(needsDispatch(summaryOf({ trashedAt: 1 })), false)
  assert.equal(needsDispatch(summaryOf({ status: 'in_progress' })), false)
  assert.equal(needsDispatch(summaryOf({ executions: [{ id: 'e', trigger: 'manual', outcome: 'running' }] })), false)
  assert.equal(needsDispatch(summaryOf({ executions: [{ id: 'e', trigger: 'manual', outcome: 'failed' }] })), false)
  assert.equal(needsDispatch(summaryOf({ executions: [{ id: 'e', trigger: 'manual', outcome: 'cancelled' }] })), false)

  const scheduled = summaryOf({ execution: { mode: 'scheduled', cron: '0 3 * * *' } })
  assert.equal(needsDispatch(scheduled), false)
  assert.equal(needsDispatch({ ...scheduled, releasedAt: 5 }), true)
})

test('派发顺序：紧急度 → 创建时间 → id', () => {
  const relaxed = summaryOf({ id: 't-3', urgency: 'relaxed', createdAt: 1 })
  const urgentLate = summaryOf({ id: 't-2', urgency: 'urgent', createdAt: 20 })
  const urgentEarly = summaryOf({ id: 't-1', urgency: 'urgent', createdAt: 10 })
  const ordered = dispatchOrder([relaxed, urgentLate, urgentEarly])
  assert.deepEqual(ordered.map(item => item.id), ['t-1', 't-2', 't-3'])
})

function dispatcherFixture(summaries: TaskSummary[], limit: number): {
  store: ConstructorParameters<typeof DispatcherService>[0]['store']
} {
  return {
    store: {
      load: async () => {},
      summaries: () => summaries,
      settings: () => ({ maxConcurrent: limit }),
      subscribe: () => () => {},
    },
  }
}

test('派发器：按并发上限开跑，满员后跳过', async () => {
  const fixture = dispatcherFixture([
    summaryOf({ id: 't-1', urgency: 'urgent', createdAt: 3 }),
    summaryOf({ id: 't-2', urgency: 'normal', createdAt: 2 }),
    summaryOf({ id: 't-3', urgency: 'relaxed', createdAt: 1 }),
  ], 2)
  const calls: string[] = []
  const service = new DispatcherService({
    store: fixture.store,
    execution: {
      run: async (taskId) => {
        calls.push(taskId)
        return { ok: true, executionId: `e-${taskId}`, sessionId: `s-${taskId}` }
      },
    },
    setTimer: () => 1,
    clearTimer: () => {},
  })
  await service.start()
  assert.deepEqual(calls, ['t-1', 't-2'])
  service.dispose()
})

test('派发器：welink 卡不占名额，满员也照跑', async () => {
  const fixture = dispatcherFixture([
    summaryOf({ id: 't-1', source: 'welink' }),
    summaryOf({ id: 't-2' }),
  ], 1)
  const calls: string[] = []
  const service = new DispatcherService({
    store: fixture.store,
    execution: {
      run: async (taskId) => {
        calls.push(taskId)
        return { ok: true, executionId: 'e', sessionId: 's' }
      },
    },
    setTimer: () => 1,
    clearTimer: () => {},
  })
  await service.start()
  assert.deepEqual(calls.sort(), ['t-1', 't-2'])
  service.dispose()
})

test('派发器：并发口径被拒时按固定间隔补一次', async () => {
  const fixture = dispatcherFixture([summaryOf({ id: 't-1' })], 1)
  const timers: number[] = []
  const service = new DispatcherService({
    store: fixture.store,
    execution: { run: async () => ({ ok: false, error: 'execution concurrency limit reached (1/1 running)' }) },
    setTimer: (_callback, delay) => { timers.push(delay); return 1 },
    clearTimer: () => {},
  })
  await service.start()
  assert.deepEqual(timers, [RETRY_MS])
  service.dispose()
})

test('派发器：别人抢先起走不算失败，不排重试', async () => {
  const fixture = dispatcherFixture([summaryOf({ id: 't-1' })], 1)
  const timers: number[] = []
  const service = new DispatcherService({
    store: fixture.store,
    execution: { run: async () => ({ ok: false, error: 'task is already in progress' }) },
    setTimer: (_callback, delay) => { timers.push(delay); return 1 },
    clearTimer: () => {},
  })
  await service.start()
  assert.deepEqual(timers, [])
  service.dispose()
})
