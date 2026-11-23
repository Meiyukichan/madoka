/**
 * 字典与解析的纯逻辑测试（不依赖 React / 浏览器）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { NS, en, zh } from '../src/client/labels/index.ts'
import { canTransition } from '../src/shared/wire.ts'
import { isSessionId, visibleIssues, visibleTasks } from '../src/client/data/derive/index.ts'
import type { BoardState } from '../src/client/data/state/index.ts'

test('zh / en 键集完全一致', () => {
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(enKeys, zhKeys)
  assert.ok(zhKeys.length >= 150)
})

test('每个字典值都非空', () => {
  for (const key of Object.keys(zh)) {
    assert.notEqual((zh as Record<string, string>)[key]!.trim(), '', `zh.${key} 为空`)
    assert.notEqual((en as Record<string, string>)[key]!.trim(), '', `en.${key} 为空`)
  }
})

test('locale 命名空间是 castboard', () => {
  assert.equal(NS, 'castboard')
})

function fakeState(patch: Partial<BoardState>): BoardState {
  return {
    status: 'ready',
    revision: 0,
    issueRevision: 0,
    linkRevision: 0,
    tasks: [],
    issues: [],
    details: new Map(),
    issueDetails: new Map(),
    interactions: [],
    workspaces: [],
    templates: [],
    filters: { urgencies: [] },
    search: '',
    sortBy: 'default',
    composer: { open: false },
    issueComposer: { open: false },
    secondaryOpen: false,
    diagOpen: false,
    tplManagerOpen: false,
    settingsOpen: false,
    dispatchedOpen: false,
    interactionInboxOpen: false,
    archiveSessionsSupported: false,
    ...patch,
  }
}

const task = (id: string, title: string, status: 'todo' | 'in_progress', updatedAt: number) => ({
  id, title, status, urgency: 'normal' as const, createdAt: 1, updatedAt,
})

test('visibleTasks 按搜索 / 项目 / 紧急度过滤并支持排序', () => {
  const state = fakeState({ search: 'a', filters: { urgencies: ['urgent'] } })
  const tasks = [
    { ...task('t-1', 'alpha', 'todo', 1), urgency: 'urgent' as const },
    { ...task('t-2', 'alpha', 'todo', 2), urgency: 'normal' as const },
    { ...task('t-3', 'beta', 'todo', 3), urgency: 'urgent' as const },
  ]
  assert.deepEqual(visibleTasks(state, tasks).map(item => item.id), ['t-1', 't-3'])
  const sorted = visibleTasks(fakeState({ sortBy: 'updated' }), tasks)
  assert.deepEqual(sorted.map(item => item.id), ['t-3', 't-2', 't-1'])
})

test('visibleIssues 只画未转卡的 pending/accepted/routing，并按状态 → 紧急度 → 创建时间排序', () => {
  const issues = [
    { issueId: 'i-1', title: 'a', status: 'pending', urgency: 'relaxed', source: 'self', createdAt: 2, updatedAt: 2 },
    { issueId: 'i-2', title: 'b', status: 'routing', urgency: 'relaxed', source: 'self', createdAt: 3, updatedAt: 3 },
    { issueId: 'i-3', title: 'c', status: 'pending', urgency: 'urgent', source: 'self', createdAt: 1, updatedAt: 1 },
    { issueId: 'i-4', title: 'd', status: 'success', urgency: 'urgent', source: 'self', createdAt: 0, updatedAt: 0 },
  ] as const
  const state = fakeState({
    tasks: [{ id: 't-1', title: 'a', status: 'todo', urgency: 'relaxed', issueId: 'i-1', createdAt: 2, updatedAt: 2 }],
  })
  assert.deepEqual(visibleIssues(state, issues).map(item => item.issueId), ['i-2', 'i-3'])
})

test('isSessionId 认标准 dsh UUID / session- / 旧 magica-', () => {
  assert.equal(isSessionId('078b90db-5e2d-4035-86c8-890667837674'), true)
  assert.equal(isSessionId('session-088ae453-ac82-4d04-be9d-6dbf8af0c115'), true)
  assert.equal(isSessionId('magica-ws-abc-1-def'), true)
  assert.equal(isSessionId(''), false)
  assert.equal(isSessionId(undefined), false)
  assert.equal(isSessionId('Yuki'), false)
})

test('状态机：done 只能去 archived', () => {
  assert.equal(canTransition('done', 'todo'), false)
  assert.equal(canTransition('done', 'archived'), true)
  assert.equal(canTransition('in_review', 'done'), true)
})
