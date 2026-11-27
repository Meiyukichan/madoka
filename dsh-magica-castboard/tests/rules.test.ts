/**
 * 规则层：状态机、字段归一化、cron 可调度性、导入校验。
 *
 * 这些是纯函数，覆盖的是「什么能落库、什么迁移合法」这套边界。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_CHECKLIST_ITEMS,
  MAX_TAGS,
} from '../src/host/model.ts'
import {
  ALL_STATUSES,
  canTransition,
  checklistFromTexts,
  commentPollMsOf,
  commentsEnabled,
  defaultPermissionOf,
  isClaim,
  isBacklogStageTask,
  isPlausibleTaskRecord,
  maxConcurrentOf,
  normalizeAcceptanceStrategies,
  normalizeAcceptanceStrategyIds,
  normalizeBody,
  normalizeChecklist,
  normalizeChecklistText,
  normalizeExecution,
  normalizeExecutionReport,
  normalizeModel,
  normalizeTags,
  normalizeTitle,
} from '../src/host/rules.ts'
import { taskRecord } from './helpers.ts'
import { acceptanceIdFor } from '../src/host/exec/acceptance.ts'

test('inline acceptance strategy：工具传入的 id 一律忽略，按 type + title 生成规范 id', () => {
  const strategies = normalizeAcceptanceStrategies([{
    id: 'close-on-miku',
    title: '验收通过',
    type: 'close',
    description: '清单全勾',
  }])
  assert.equal(strategies?.[0]?.id, acceptanceIdFor('验收通过', 'close'))
  assert.notEqual(strategies?.[0]?.id, 'close-on-miku')
})

test('状态机：正向与横移合法，终态不可逆', () => {
  assert.equal(canTransition('todo', 'in_progress'), true)
  assert.equal(canTransition('in_progress', 'in_review'), true)
  assert.equal(canTransition('in_review', 'done'), true)
  assert.equal(canTransition('in_review', 'todo'), true)
  assert.equal(canTransition('canceled', 'todo'), true)
  assert.equal(canTransition('done', 'archived'), true)
  assert.equal(canTransition('done', 'todo'), false)
  assert.equal(canTransition('archived', 'todo'), false)
  assert.equal(canTransition('abandoned', 'todo'), false)
  for (const status of ALL_STATUSES) {
    assert.equal(canTransition(status, status), false, `${status} 不能迁移到自己`)
  }
})

test('认领只有「待办 → 进行中」一条边', () => {
  assert.equal(isClaim('todo', 'in_progress'), true)
  for (const [from, to] of [['in_progress', 'in_review'], ['todo', 'canceled'], ['in_review', 'todo']] as const) {
    assert.equal(isClaim(from, to), false)
  }
})

test('标题与正文：trim 后长度受限', () => {
  assert.equal(normalizeTitle('  修复  '), '修复')
  assert.throws(() => normalizeTitle('   '), /title must be 1..200/)
  assert.throws(() => normalizeTitle('x'.repeat(201)), /title must be 1..200/)
  assert.equal(normalizeBody(' 收到 '), '收到')
  assert.throws(() => normalizeBody(''), /comment body must be 1..4000/)
})

test('执行配置：queue 直接接受；scheduled 必须能排出来', () => {
  assert.deepEqual(normalizeExecution({}), { mode: 'queue' })
  assert.deepEqual(normalizeExecution({ mode: 'claim' }), { mode: 'queue' })
  assert.deepEqual(normalizeExecution({ mode: 'scheduled', cron: '*/5 * * * *' }), {
    mode: 'scheduled',
    cron: '*/5 * * * *',
  })
  assert.throws(
    () => normalizeExecution({ mode: 'scheduled', cron: '0 0 31 4 *' }),
    /is not schedulable/,
  )
  assert.throws(
    () => normalizeExecution({ mode: 'scheduled', cron: '0 0 * *' }),
    /exactly 5 fields/,
  )
  assert.throws(
    () => normalizeExecution({ mode: 'scheduled', cron: '61 * * * *' }),
    /is not schedulable/,
  )
  assert.throws(() => normalizeExecution({ mode: 'later' }), /must be 'queue' or 'scheduled'/)
})

test('执行配置：每天 / 每周 / 区间步长都被接受', () => {
  for (const cron of [
    '0 3 * * *',
    '0 3 * * 1-5',
    '0 3 1 * *',
    '0 3 1 1 *',
    '*/15 9-18 * * 1,3,5',
    '0 0 29 2 *',
  ]) {
    assert.deepEqual(normalizeExecution({ mode: 'scheduled', cron }), { mode: 'scheduled', cron })
  }
})

test('看板设置：缺省按出厂值解释，非法值抛错', () => {
  assert.equal(commentsEnabled(undefined), true)
  assert.equal(commentsEnabled({ commentsEnabled: false }), false)
  assert.equal(defaultPermissionOf(undefined), 'workspace-write')
  assert.equal(maxConcurrentOf(undefined, 7), 7)
  assert.equal(maxConcurrentOf({ maxConcurrent: 5 }, 7), 5)
  assert.equal(commentPollMsOf(undefined, 2_000), 2_000)
  assert.equal(commentPollMsOf({ commentPollMs: 10 }, 2_000), 1_000)
})

test('模型、标签、清单与报告归一化', () => {
  assert.deepEqual(normalizeModel({ provider: ' p ', model: ' m ' }), { provider: 'p', model: 'm' })
  assert.throws(() => normalizeModel({ provider: '', model: 'm' }), /non-empty/)
  assert.throws(() => normalizeModel(null), /must be/)

  assert.deepEqual(normalizeTags('example, example, ui'), ['example', 'ui'])
  assert.equal(normalizeTags([]), undefined)
  assert.equal(normalizeTags(Array.from({ length: 20 }, (_, index) => `t${index}`))?.length, MAX_TAGS)
  assert.equal(normalizeTags('x'.repeat(40))?.[0]?.length, 30)

  assert.deepEqual(checklistFromTexts([' 一条 '])[0]?.checked, false)
  assert.throws(() => checklistFromTexts(Array.from({ length: MAX_CHECKLIST_ITEMS + 1 }, () => 'x')), /at most 30/)
  assert.throws(() => normalizeChecklistText(''), /1..200/)

  const checklist = normalizeChecklist([
    { id: 'k-1', text: '通过', checked: true, checkedBy: ' session-1 ', note: ' 日志 ', checkedAt: 5 },
    { id: 'k-2', text: '未通过', checked: false, checkedBy: 'session-2', note: '不该保留' },
    { text: '补 id' },
  ])
  assert.equal(checklist.length, 3)
  assert.deepEqual(checklist[0], { id: 'k-1', text: '通过', checked: true, checkedBy: 'session-1', note: '日志', checkedAt: 5 })
  assert.deepEqual(checklist[1], { id: 'k-2', text: '未通过', checked: false })
  assert.ok(checklist[2]?.id.startsWith('k-'))

  assert.deepEqual(
    normalizeExecutionReport({ summary: ' 做完 ', changedFiles: [' src/a.ts '], checks: ['pnpm test'], risk: '  ' }),
    { summary: '做完', changedFiles: ['src/a.ts'], checks: ['pnpm test'], artifacts: [], risk: '' },
  )
  assert.throws(() => normalizeExecutionReport({ summary: '' }), /summary/)
  assert.throws(
    () => normalizeExecutionReport({ summary: 'x', changedFiles: Array.from({ length: 51 }, () => 'a') }),
    /at most 50/,
  )

  assert.deepEqual(normalizeAcceptanceStrategyIds([' a-1 ', 'a-1', 'bad id', '', 'b-2']), ['a-1', 'b-2'])
})

test('落盘重读的骨架检查与历史待规划识别', () => {
  assert.equal(isPlausibleTaskRecord(taskRecord()), true)
  assert.equal(isPlausibleTaskRecord({ ...taskRecord(), id: 'bad id' }), false)
  assert.equal(isPlausibleTaskRecord({ ...taskRecord(), execution: {} }), false)
  assert.equal(isPlausibleTaskRecord({ ...taskRecord(), status: 'nope' }), false)
  assert.equal(isBacklogStageTask({ ...taskRecord(), status: 'backlog' }), true)
  assert.equal(isBacklogStageTask(taskRecord()), false)
})
