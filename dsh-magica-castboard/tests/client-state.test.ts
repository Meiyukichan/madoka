/**
 * Client 状态机的纯逻辑回归：
 * - 会话列表（归档「连同会话」的依据）
 * - 侧栏入口读数
 * - `move(archived, { archiveSessions })` 真的把会话交给注入的归档面
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_SETTINGS } from '../src/shared/wire.ts'
import { BoardStore } from '../src/client/data/state/index.ts'
import type { BoardState } from '../src/client/data/state/index.ts'
import { entryStats, taskSessionIds } from '../src/client/data/derive/index.ts'

function withFetch(handler: (url: string) => unknown): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const body = handler(String(input))
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

const summary = {
  id: 't-1', title: 'card', status: 'done', urgency: 'normal', createdAt: 1, updatedAt: 2,
} as const

const detail = {
  ...summary,
  executions: [
    { id: 'e-1', trigger: 'user', startedAt: 1, outcome: 'succeeded', sessionId: 'session-aaa' },
    { id: 'e-2', trigger: 'comment', startedAt: 2, outcome: 'succeeded', sessionId: 'session-bbb' },
    { id: 'e-3', trigger: 'acceptance', startedAt: 3, outcome: 'failed', sessionId: 'session-aaa' },
  ],
  claimedBy: 'session-ccc',
} as const

const snapshot = {
  schemaVersion: 1,
  revision: 1,
  issueRevision: 0,
  linkRevision: 0,
  tasks: [summary],
  issues: [],
  issueLinks: {},
  settings: DEFAULT_SETTINGS,
}

test('taskSessionIds：执行史 + 持有者，去重且保持首次出现顺序', () => {
  assert.deepEqual(taskSessionIds(detail), ['session-aaa', 'session-bbb', 'session-ccc'])
  assert.deepEqual(taskSessionIds({ executions: [], claimedBy: 'tester' }), [])
  assert.deepEqual(taskSessionIds({}), [])
})

test('entryStats：trashed 不计，交互数单独一列', () => {
  const state = {
    tasks: [
      { id: 'a', title: 'a', status: 'todo', urgency: 'normal', createdAt: 1, updatedAt: 1 },
      { id: 'b', title: 'b', status: 'todo', urgency: 'normal', createdAt: 1, updatedAt: 1, trashedAt: 5 },
      { id: 'c', title: 'c', status: 'in_progress', urgency: 'normal', createdAt: 1, updatedAt: 1 },
      { id: 'd', title: 'd', status: 'in_review', urgency: 'normal', createdAt: 1, updatedAt: 1 },
    ],
    issues: [{ issueId: 'i-1' }, { issueId: 'i-2' }],
    interactions: [{ id: 'x' }],
  } as unknown as BoardState
  assert.deepEqual(entryStats(state), { issue: 2, todo: 1, doing: 1, review: 1, pending: 1 })
})

test('未安装归档面：archiveTaskSessions 把会话记为 unsupported，不改台账', async () => {
  const store = new BoardStore()
  const restore = withFetch(() => ({ ok: true, value: { task: detail, comments: [] } }))
  try {
    assert.equal(store.getSnapshot().archiveSessionsSupported, false)
    const result = await store.archiveTaskSessions('t-1')
    assert.deepEqual(result.archived, [])
    assert.deepEqual([...result.unsupported], ['session-aaa', 'session-bbb', 'session-ccc'])
    assert.equal(store.getSnapshot().sessionArchive?.taskId, 't-1')
  } finally {
    restore()
    store.dispose()
  }
})

test('move(archived, archiveSessions)：先移卡，再把全部会话交给归档面', async () => {
  const store = new BoardStore()
  const archived: string[] = []
  store.installSessionArchiver(async ids => {
    archived.push(...ids)
    return { archived: [...ids], failed: [], unsupported: [] }
  })
  const restore = withFetch(url => {
    if (url.includes('/tasks/t-1/move')) return { ok: true, value: { task: { ...summary, status: 'archived' } } }
    if (url.includes('/tasks/t-1')) return { ok: true, value: { task: detail, comments: [] } }
    if (url.includes('/state')) return { ok: true, value: snapshot }
    return { ok: false, error: { code: 'not_found', message: url } }
  })
  try {
    const ok = await store.move('t-1', 'archived', { archiveSessions: true })
    assert.equal(ok, true)
    assert.deepEqual(archived, ['session-aaa', 'session-bbb', 'session-ccc'])
    assert.equal(store.getSnapshot().sessionArchive?.result.archived.length, 3)
  } finally {
    restore()
    store.dispose()
  }
})

test('installSessionArchiver(undefined) 收回能力', () => {
  const store = new BoardStore()
  try {
    store.installSessionArchiver(async () => ({ archived: [], failed: [], unsupported: [] }))
    assert.equal(store.getSnapshot().archiveSessionsSupported, true)
    store.installSessionArchiver(undefined)
    assert.equal(store.getSnapshot().archiveSessionsSupported, false)
  } finally {
    store.dispose()
  }
})

test('设置：打开设置页重读 /settings，保存后直接用响应里的有效值', async () => {
  const store = new BoardStore()
  let current = { ...DEFAULT_SETTINGS, maxConcurrent: 4 }
  const restore = withFetch(url => {
    if (url.includes('/settings/update')) return { ok: true, value: { ...current } }
    if (url.includes('/settings')) return { ok: true, value: { ...current } }
    if (url.includes('/state')) return { ok: true, value: { ...snapshot, settings: undefined } }
    return { ok: false, error: { code: 'not_found', message: url } }
  })
  try {
    store.openSettings()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    assert.equal(store.getSnapshot().settings?.maxConcurrent, 4, '打开设置页要读一次')

    current = { ...DEFAULT_SETTINGS, maxConcurrent: 6 }
    const ok = await store.updateSettings(current)
    assert.equal(ok, true)
    assert.equal(store.getSnapshot().settings?.maxConcurrent, 6, '保存后不要还显示旧值')
  } finally {
    restore()
    store.dispose()
  }
})
