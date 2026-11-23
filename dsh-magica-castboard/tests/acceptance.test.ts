/**
 * 验收策略：严格/宽松两套归一化、文件读写、验收轮规划与历史形状迁移；模板遮蔽。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  acceptanceIdFor,
  checklistProgress,
  emptyAcceptanceStrategies,
  normalizeAcceptanceStrategies,
  normalizeInlineAcceptanceStrategies,
  parseAcceptanceStrategies,
  planAcceptance,
  readAcceptanceStrategies,
  settleAcceptance,
  writeAcceptanceStrategies,
  type AcceptanceStrategy,
} from '../src/host/exec/acceptance.ts'
import { TemplateStore } from '../src/host/ledger/template-store.ts'
import type { TaskLedger, TaskRecord } from '../src/host/model.ts'
import { checklistItem, taskRecord, tempRoot } from './helpers.ts'

const STRATEGY: AcceptanceStrategy = { id: 'a-1', title: '测试通过', type: 'close', description: 'pnpm test' }

test('严格归一化：类型、标题、重复与上限都拒绝', () => {
  const strategies = normalizeAcceptanceStrategies([
    { title: '测试通过', type: 'close', description: 'pnpm test' },
    { title: '遗留项', type: 'issue', text: '拆 issue' },
  ])
  assert.equal(strategies.length, 2)
  assert.equal(strategies[0]?.id, acceptanceIdFor('测试通过', 'close'))
  assert.equal(strategies[1]?.description, '拆 issue')
  assert.equal(acceptanceIdFor('测试通过', 'close'), acceptanceIdFor('测试通过', 'close'))
  assert.notEqual(acceptanceIdFor('测试通过', 'close'), acceptanceIdFor('测试通过', 'issue'))

  assert.throws(() => normalizeAcceptanceStrategies('x'), /必须是数组/)
  assert.throws(() => normalizeAcceptanceStrategies([{ title: 'x', type: 'later', description: 'y' }]), /只允许/)
  assert.throws(() => normalizeAcceptanceStrategies([{ title: 'x', type: 'close', description: 'y' }, { title: ' x ', type: 'issue', description: 'z' }]), /标题不能重复/)
  assert.throws(
    () => normalizeAcceptanceStrategies(Array.from({ length: 101 }, (_, index) => ({
      title: `t${index}`,
      type: 'close',
      description: 'x',
    }))),
    /最多 100 条/,
  )
})

test('宽松归一化：坏条目跳过、重名只留第一条、卡上限 10', () => {
  const inline = normalizeInlineAcceptanceStrategies([
    'bad',
    { title: '一条', type: 'close', description: 'x' },
    { title: '一条', type: 'issue', description: '重复' },
    { title: '', type: 'close', description: 'x' },
    { title: '二条', type: 'issue', description: 'y' },
  ])
  assert.deepEqual(inline?.map(strategy => strategy.title), ['一条', '二条'])
  assert.equal(normalizeInlineAcceptanceStrategies('x'), undefined)
  assert.equal(normalizeInlineAcceptanceStrategies([]), undefined)

  const many = normalizeInlineAcceptanceStrategies(Array.from({ length: 20 }, (_, index) => ({
    title: `t${index}`,
    type: 'close',
    description: 'x',
  })))
  assert.equal(many?.length, 10)
})

test('文件解析：空文件为空、坏 JSON 抛错、坏条目与重名被跳过', () => {
  assert.deepEqual(parseAcceptanceStrategies(''), emptyAcceptanceStrategies())
  assert.throws(() => parseAcceptanceStrategies('{ bad'), /不是合法 JSON/)
  assert.throws(() => parseAcceptanceStrategies('[]'), /顶层必须是对象/)

  const parsed = parseAcceptanceStrategies(JSON.stringify({
    strategies: [
      { title: '一条', type: 'close', text: '旧字段' },
      { title: '一条', type: 'issue', description: '重名' },
      { title: '坏', type: 'nope', description: 'x' },
    ],
  }))
  assert.equal(parsed.strategies.length, 1)
  assert.equal(parsed.strategies[0]?.description, '旧字段')
})

test('读写往返：缺失文件为空、写入后逐字可读', async (t) => {
  const root = tempRoot(t)
  const file = join(root, 'castboard-strategy.json')
  assert.deepEqual(await readAcceptanceStrategies(file), emptyAcceptanceStrategies())
  const written = await writeAcceptanceStrategies(file, [STRATEGY])
  assert.deepEqual(written.strategies, [STRATEGY])
  assert.deepEqual(await readAcceptanceStrategies(file), written)
})

test('清单完成度看 checked 字段', () => {
  assert.deepEqual(checklistProgress({ checklist: undefined }), { done: 0, total: 0 })
  assert.deepEqual(checklistProgress({
    checklist: [
      checklistItem('a', { checked: true }),
      checklistItem('b'),
      checklistItem('c', { checked: true }),
    ],
  }), { done: 2, total: 3 })
})

test('验收轮规划：只在待验收、未注入、有策略时启动', () => {
  const base = taskRecord({ status: 'in_review', title: '待验收' })
  assert.equal(planAcceptance({ task: { ...base, status: 'todo' }, strategies: [STRATEGY] }).shouldRun, false)
  assert.equal(planAcceptance({ task: { ...base, acceptanceInjectedAt: 1 }, strategies: [STRATEGY] }).reason, 'already injected')
  assert.equal(planAcceptance({ task: base, strategies: [] }).reason, 'no strategy')

  const plan = planAcceptance({
    task: {
      ...base,
      checklist: [checklistItem('a', { checked: true }), checklistItem('b')],
    },
    strategies: [
      { id: 'a-2', title: '遗留项', type: 'issue', description: '拆出去' },
      STRATEGY,
    ],
  })
  assert.equal(plan.shouldRun, true)
  assert.deepEqual(plan.closeStrategies.map(strategy => strategy.id), ['a-1'])
  assert.deepEqual(plan.issueStrategies.map(strategy => strategy.id), ['a-2'])
  assert.ok(plan.injectText.includes('清单完成度：1/2'))
  assert.ok(plan.injectText.includes('[close] 测试通过'))
  assert.ok(plan.injectText.includes('issue 类'))
})

test('验收结算：issue 策略优先拆条，close 策略要求清单全勾', () => {
  const plan = planAcceptance({
    task: taskRecord({ status: 'in_review', title: 'x' }),
    strategies: [
      { id: 'a-1', title: '完成', type: 'close', description: 'x' },
      { id: 'a-2', title: '拆条', type: 'issue', description: 'y' },
    ],
  })
  assert.equal(settleAcceptance({ plan, checklist: { done: 0, total: 0 }, spawnedIssues: 2 }), 'spawn-issues')
  assert.equal(settleAcceptance({ plan, checklist: { done: 0, total: 0 }, spawnedIssues: 0 }), 'back-to-todo')
  assert.equal(settleAcceptance({ plan, checklist: { done: 1, total: 1 }, spawnedIssues: 0 }), 'done')
  assert.equal(settleAcceptance({ plan, checklist: { done: 0, total: 1 }, spawnedIssues: 0 }), 'back-to-todo')

  const closeOnly = planAcceptance({
    task: taskRecord({ status: 'in_review', title: 'x' }),
    strategies: [STRATEGY],
  })
  assert.equal(settleAcceptance({ plan: closeOnly, checklist: { done: 1, total: 1 }, spawnedIssues: 0 }), 'done')
  assert.equal(settleAcceptance({ plan: closeOnly, checklist: { done: 0, total: 0 }, spawnedIssues: 0 }), 'back-to-todo')
})

test('模板：出厂模板可列出，用户同 id 遮蔽、删除后恢复', async (t) => {
  const root = tempRoot(t)
  const store = new TemplateStore(join(root, 'castboard-templates.json'))
  const builtin = await store.list()
  assert.ok(builtin.length >= 2)
  assert.equal(builtin.every(template => template.builtin === true), true)
  const target = builtin[0]!
  assert.equal(await store.isBuiltin(target.id), true)

  const shadow = await store.upsert({ id: target.id, name: '我的版本', task: { title: '自定义' } })
  assert.equal(shadow.builtin, undefined)
  const merged = await store.list()
  assert.equal(merged.filter(template => template.id === target.id).length, 1)
  assert.equal(merged.find(template => template.id === target.id)?.name, '我的版本')

  const reopened = new TemplateStore(join(root, 'castboard-templates.json'))
  assert.equal((await reopened.list()).find(template => template.id === target.id)?.name, '我的版本')

  assert.equal(await reopened.remove(target.id), true)
  const restored = await reopened.list()
  assert.equal(restored.find(template => template.id === target.id)?.builtin, true)
  assert.equal(await reopened.remove(target.id), false)
})

test('模板：名称校验与用户模板新增', async (t) => {
  const root = tempRoot(t)
  const store = new TemplateStore(join(root, 'castboard-templates.json'))
  await assert.rejects(() => store.upsert({ name: ' ', task: {} }), /1..60/)
  await assert.rejects(() => store.upsert({ name: 'x'.repeat(61), task: {} }), /1..60/)
  const created = await store.upsert({ name: '我的模板', task: { title: 't', urgency: 'urgent' } })
  assert.match(created.id, /^tpl-/)
  assert.equal((await store.list()).find(template => template.id === created.id)?.name, '我的模板')
})
