/**
 * 任务台账：索引/详情双文件、revision、原子落盘、串行写队列、备份与坏索引重建。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { MAX_EXECUTIONS } from '../src/host/model.ts'
import { TaskStore, ReadOnlyError, type LedgerChange } from '../src/host/ledger/task-store.ts'
import { castboardPaths } from '../src/host/ledger/paths.ts'
import { taskRecord, tempRoot } from './helpers.ts'

test('空目录载入为空台账，revision 从 0 开始', async (t) => {
  const root = tempRoot(t)
  const store = new TaskStore({ dir: root })
  await store.load()
  assert.equal(store.revision(), 0)
  assert.deepEqual(store.snapshot().tasks, [])
  assert.deepEqual(store.summaries(), [])
  assert.equal(store.settings(), undefined)
})

test('mutate 落详情与索引、涨 revision，返回冻结副本', async (t) => {
  const root = tempRoot(t)
  const store = new TaskStore({ dir: root })
  const changes: LedgerChange[] = []
  store.subscribe(change => changes.push(change))

  const task = taskRecord({ id: 't-1' })
  const result = await store.mutate('task-created', ledger => {
    ledger.tasks.push(task)
    return [task]
  })
  assert.equal(result.ledger.revision, 1)
  assert.equal(result.changed[0]?.id, 't-1')
  assert.equal(store.revision(), 1)
  assert.equal(readdirSync(join(root, 'tasks')).includes('t-1.json'), true)

  const index = JSON.parse(readFileSync(join(root, 'castboard-task.json'), 'utf8')) as {
    revision: number
    tasks: Array<{ id: string; title: string }>
  }
  assert.equal(index.revision, 1)
  assert.equal(index.tasks[0]?.id, 't-1')
  assert.equal(index.tasks[0]?.title, '补检测')
  assert.equal(changes.length, 1)
  assert.equal(changes[0]?.kind, 'task-created')

  const snapshot = store.snapshot()
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.tasks[0]), true)
  assert.throws(() => { (snapshot.tasks[0] as { title: string }).title = 'x' })
  const fetched = store.get('t-1')
  assert.equal(fetched?.title, '补检测')
  assert.equal(Object.isFrozen(fetched), true)
})

test('mutator 返回 undefined 表示放弃，不涨 revision、不落盘', async (t) => {
  const root = tempRoot(t)
  const store = new TaskStore({ dir: root })
  const result = await store.mutate('task-updated', () => undefined)
  assert.equal(result.ledger.revision, 0)
  assert.deepEqual(result.changed, [])
  assert.equal(store.revision(), 0)
  assert.equal(existsSync(join(root, 'castboard-task.json')), false)
})

test('并发 mutate 走同一条串行队列：两个写入都保留、revision 累加', async (t) => {
  const root = tempRoot(t)
  const store = new TaskStore({ dir: root })
  const first = taskRecord({ id: 't-1' })
  const second = taskRecord({ id: 't-2' })

  await Promise.all([
    store.mutate('task-created', ledger => {
      ledger.tasks.push(first)
      return [first]
    }),
    store.mutate('task-created', ledger => {
      ledger.tasks.push(second)
      return [second]
    }),
  ])

  const snapshot = store.snapshot()
  assert.equal(snapshot.revision, 2)
  assert.deepEqual(snapshot.tasks.map(task => task.id), ['t-1', 't-2'])
  assert.equal(store.summaries().length, 2)

  await Promise.all([
    store.read(ledger => ledger.tasks.length),
    store.read(ledger => ledger.tasks.map(task => task.id)),
  ])
  assert.deepEqual(await store.read(ledger => ledger.tasks.map(task => task.id)), ['t-1', 't-2'])
})

test('旧台账里的 settings 仍可读，但写台账时不再落回索引', async (t) => {
  const root = tempRoot(t)
  const store = new TaskStore({ dir: root })
  const task = taskRecord()
  await store.mutate('task-created', (ledger) => {
    ledger.tasks.push(task)
    return [task]
  })

  // 模拟旧版写出的索引：settings 还在台账里（现在只作为迁移来源）。
  const file = join(root, 'castboard-task.json')
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  parsed.settings = { maxConcurrent: 4, autoRoute: false }
  writeFileSync(file, JSON.stringify(parsed), 'utf8')

  const reopened = new TaskStore({ dir: root })
  await reopened.load()
  assert.deepEqual(reopened.settings(), { maxConcurrent: 4, autoRoute: false })

  await reopened.mutate('task-updated', (ledger) => {
    const target = ledger.tasks[0]!
    target.title = '改过标题'
    return [target]
  })
  const after = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  assert.equal('settings' in after, false, '设置不再写回台账')
  assert.equal(reopened.settings()?.maxConcurrent, 4, '内存里仍保留旧值，供 SettingsStore 迁移')
})

test('备份是异步的、写在索引旁边且内容是完整台账', async (t) => {
  const root = tempRoot(t)
  const store = new TaskStore({ dir: root, now: () => 42_000 })
  const task = taskRecord()
  await store.mutate('task-created', (ledger) => {
    ledger.tasks.push(task)
    return [task]
  })

  const file = await store.backup()
  assert.equal(file, join(root, 'castboard-task.json.backup-42000'))
  assert.equal(existsSync(file), true)
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { revision: number; tasks: Array<{ id: string }> }
  assert.equal(parsed.revision, 1)
  assert.equal(parsed.tasks[0]?.id, 't-1')
})

test('执行史按上限裁剪，并把裁掉条数记进 executionsPruned', async (t) => {
  const root = tempRoot(t)
  const store = new TaskStore({ dir: root })
  const executions = Array.from({ length: MAX_EXECUTIONS + 5 }, (_, index) => ({
    id: `e-${index}`,
    trigger: 'manual' as const,
    outcome: 'succeeded' as const,
  }))
  const task = taskRecord({ executions })
  await store.mutate('task-created', (ledger) => {
    ledger.tasks.push(task)
    return [task]
  })

  const saved = store.get('t-1')
  assert.equal(saved?.executions.length, MAX_EXECUTIONS)
  assert.equal(saved?.executionsPruned, 5)
  assert.equal(saved?.executions[0]?.id, 'e-5')
})

test('坏索引被隔离，从 tasks/ 重建并清掉隔离副本', async (t) => {
  const root = tempRoot(t)
  mkdirSync(join(root, 'tasks'), { recursive: true })
  writeFileSync(join(root, 'tasks', 't-1.json'), JSON.stringify(taskRecord()), 'utf8')
  writeFileSync(join(root, 'castboard-task.json'), '{ not json', 'utf8')

  const store = new TaskStore({ dir: root })
  await store.load()
  assert.equal(store.revision(), 0)
  assert.deepEqual(store.summaries().map(summary => summary.id), ['t-1'])
  assert.equal(readdirSync(root).some(name => name.startsWith('castboard-task.json.corrupt-')), false, '重建后清掉隔离副本')

  const index = JSON.parse(readFileSync(join(root, 'castboard-task.json'), 'utf8')) as { tasks: Array<{ id: string }> }
  assert.equal(index.tasks[0]?.id, 't-1')
})

test('索引缺失时从详情重建，坏详情被跳过', async (t) => {
  const root = tempRoot(t)
  mkdirSync(join(root, 'tasks'), { recursive: true })
  writeFileSync(join(root, 'tasks', 't-1.json'), JSON.stringify(taskRecord()), 'utf8')
  writeFileSync(join(root, 'tasks', 'broken.json'), '{ bad', 'utf8')
  writeFileSync(join(root, 'tasks', 'wrong.json'), JSON.stringify({ id: 'wrong', title: 'x' }), 'utf8')

  const store = new TaskStore({ dir: root })
  await store.load()
  assert.deepEqual(store.snapshot().tasks.map(task => task.id), ['t-1'])
})

test('只读进程：能载入与读，mutate 抛 ReadOnlyError', async (t) => {
  const root = tempRoot(t)
  const writer = new TaskStore({ dir: root })
  const task = taskRecord()
  await writer.mutate('task-created', (ledger) => {
    ledger.tasks.push(task)
    return [task]
  })

  const reader = new TaskStore({ dir: root, canWrite: () => false })
  await reader.load()
  assert.equal(reader.writable(), false)
  assert.equal(reader.snapshot().tasks.length, 1)
  await assert.rejects(
    () => reader.mutate('task-updated', () => [task]),
    (error: unknown) => error instanceof ReadOnlyError && error.name === 'ReadOnlyError',
  )

  // 磁盘 revision 前进后，只读进程显式重载能追上。
  await writer.mutate('task-updated', (ledger) => {
    ledger.tasks[0]!.title = '改过'
    ledger.tasks[0]!.updatedAt = 9_000
    return [ledger.tasks[0]!]
  })
  assert.equal(await reader.reloadIfChanged(), true)
  assert.equal(reader.get('t-1')?.title, '改过')
})

test('订阅者抛错不影响写入', async (t) => {
  const root = tempRoot(t)
  const store = new TaskStore({ dir: root })
  store.subscribe(() => { throw new Error('boom') })
  const task = taskRecord()
  await store.mutate('task-created', (ledger) => {
    ledger.tasks.push(task)
    return [task]
  })
  assert.equal(store.get('t-1')?.id, 't-1')
})

test('taskIdOfSession 只认执行史里的会话', async (t) => {
  const root = tempRoot(t)
  const store = new TaskStore({ dir: root })
  const task = taskRecord({
    executions: [
      { id: 'e-1', trigger: 'manual', outcome: 'succeeded', sessionId: 'session-1' },
      { id: 'e-2', trigger: 'followup', outcome: 'running', sessionId: 'session-2' },
    ],
  })
  await store.mutate('task-created', (ledger) => {
    ledger.tasks.push(task)
    return [task]
  })
  assert.equal(store.taskIdOfSession('session-1'), 't-1')
  assert.equal(store.taskIdOfSession('session-2'), 't-1')
  assert.equal(store.taskIdOfSession('session-3'), undefined)
  assert.equal(store.taskIdOfSession(''), undefined)
})

test('历史待规划记录单独收存，迁移后可删详情', async (t) => {
  const root = tempRoot(t)
  mkdirSync(join(root, 'tasks'), { recursive: true })
  const backlog = taskRecord({ id: 't-backlog', status: 'backlog' as never })
  writeFileSync(join(root, 'tasks', 't-backlog.json'), JSON.stringify(backlog), 'utf8')

  const store = new TaskStore({ dir: root })
  await store.load()
  assert.deepEqual(store.snapshot().tasks, [])
  assert.deepEqual(store.archivedBacklogRecords().map(task => task.id), ['t-backlog'])
  await store.dropArchivedDetails(['t-backlog'])
  assert.equal(existsSync(join(root, 'tasks', 't-backlog.json')), false)
  assert.deepEqual(store.archivedBacklogRecords(), [])
})

test('paths 选项与 dir 等价', async (t) => {
  const root = tempRoot(t)
  const store = new TaskStore({ paths: castboardPaths(root) })
  const task = taskRecord()
  await store.mutate('task-created', (ledger) => {
    ledger.tasks.push(task)
    return [task]
  })
  assert.equal(existsSync(join(root, 'tasks', 't-1.json')), true)
})
