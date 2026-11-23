/**
 * issue 台账：`id` 主键、异步详情、router 簿记、五类远端合并、墓碑与坏索引重建。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { IssueStore } from '../src/host/ledger/issue-store.ts'
import type { IssueDraft, RemoteIssueDraft } from '../src/host/model.ts'
import { issueRecord, tempRoot } from './helpers.ts'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const ID_C = '33333333-3333-4333-8333-333333333333'

function draft(overrides: Partial<IssueDraft> = {}): IssueDraft {
  return { title: '待规划', detail: '正文', workspaceId: 'ws-1', urgency: 'normal', ...overrides }
}

function remote(overrides: Partial<RemoteIssueDraft> = {}): RemoteIssueDraft {
  return {
    id: ID_A,
    title: '线上标题',
    detail: '线上正文',
    urgency: 'urgent',
    workspaceId: 'ws-1',
    ...overrides,
  }
}

test('create：生成 UUID id、状态 pending、索引与待规划列同步', async (t) => {
  const root = tempRoot(t)
  const store = new IssueStore({ dir: root, now: () => 5_000 })
  const created = await store.create(draft())
  assert.match(created.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(created.status, 'pending')
  assert.equal(created.assignerMeta?.title, '待规划')
  assert.equal(created.assignerMeta?.detail, '正文')
  assert.equal(store.revision(), 1)
  assert.deepEqual(store.summaries().map(summary => summary.id), [created.id])
  assert.deepEqual(store.pending().map(summary => summary.id), [created.id])

  const fetched = await store.get(created.id)
  assert.equal(fetched?.title, '待规划')
  assert.equal(Object.isFrozen(fetched), true)
  assert.equal(existsSync(join(root, 'issues', `${created.id}.json`)), true)
})

test('get：非法 id 或不存在都返回 undefined', async (t) => {
  const root = tempRoot(t)
  const store = new IssueStore({ dir: root })
  assert.equal(await store.get('../../x'), undefined)
  assert.equal(await store.get(ID_A), undefined)
})

test('update：修改后重投影 assignerMeta；返回 false 放弃写入', async (t) => {
  const root = tempRoot(t)
  const store = new IssueStore({ dir: root, now: () => 1_000 })
  const created = await store.create(draft())
  const updated = await store.update(created.id, (issue) => {
    issue.title = '新标题'
    issue.detail = '新正文'
  })
  assert.equal(updated?.title, '新标题')
  assert.equal(updated?.assignerMeta?.title, '新标题')
  assert.equal(updated?.assignerMeta?.detail, '新正文')
  const before = store.revision()
  assert.equal(await store.update(created.id, () => false), undefined)
  assert.equal(store.revision(), before)
})

test('状态迁移：transfer 只接受可合并态，attachTask 只接受 routing', async (t) => {
  const root = tempRoot(t)
  const store = new IssueStore({ dir: root })
  const created = await store.create(draft())
  const routed = await store.transfer(created.id, 't-1')
  assert.equal(routed?.status, 'routing')
  assert.equal(routed?.assigneeTask, 't-1')
  assert.equal(await store.transfer(created.id, 't-2'), undefined)
  assert.equal((await store.attachTask(created.id, 't-3'))?.assigneeTask, 't-3')
  assert.equal((await store.get(created.id))?.assigneeTask, 't-3')
  assert.equal(await store.abandon(created.id), undefined)
})

test('remove：物理删除详情与索引，并写墓碑', async (t) => {
  const root = tempRoot(t)
  const store = new IssueStore({ dir: root, now: () => 9_000 })
  const created = await store.create(draft())
  assert.equal(await store.remove(created.id), true)
  assert.equal(await store.get(created.id), undefined)
  assert.equal(existsSync(join(root, 'issues', `${created.id}.json`)), false)
  assert.deepEqual(store.summaries(), [])
  const tombstone = JSON.parse(readFileSync(join(root, 'castboard-issue-deleted.json'), 'utf8')) as {
    ids: Record<string, number>
  }
  assert.equal(tombstone.ids[created.id], 9_000)
})

test('projectId：本地草稿与远端合并都保留到记录和摘要', async (t) => {
  const root = tempRoot(t)
  const store = new IssueStore({ dir: root, now: () => 6_000 })
  const local = await store.create(draft({ projectId: 7 }))
  assert.equal(local.projectId, 7)
  assert.equal(store.summaries().find(item => item.id === local.id)?.projectId, 7)

  const merged = await store.mergeRemote([remote({ id: ID_B, projectId: 24 })], 6_100)
  assert.deepEqual(merged.inserted, [ID_B])
  assert.equal((await store.get(ID_B))?.projectId, 24)
  assert.equal(store.summaries().find(item => item.id === ID_B)?.projectId, 24)
})

test('mergeRemote：插入 / 更新 / 跳过 / 不变 / 拒绝五类', async (t) => {
  const root = tempRoot(t)
  const store = new IssueStore({ dir: root, now: () => 2_000 })

  // 插入
  const inserted = await store.mergeRemote([remote({ id: ID_A })], 2_000)
  assert.deepEqual(inserted.inserted, [ID_A])
  assert.deepEqual(inserted.updated, [])
  assert.equal((await store.get(ID_A))?.title, '线上标题')

  // 不变：同一份远端稿再合并一次
  const unchanged = await store.mergeRemote([remote({ id: ID_A })], 2_100)
  assert.deepEqual(unchanged.unchanged, [ID_A])

  // 更新：本地 pending 的镜像字段被线上覆盖
  const updated = await store.mergeRemote([remote({ id: ID_A, title: '改过的标题', urgency: 'relaxed' })], 2_200)
  assert.deepEqual(updated.updated, [ID_A])
  const record = await store.get(ID_A)
  assert.equal(record?.title, '改过的标题')
  assert.equal(record?.urgency, 'relaxed')

  // 跳过：本地已 routing
  await store.transfer(ID_A, 't-1')
  const skipped = await store.mergeRemote([remote({ id: ID_A, title: '不该进来' })], 2_300)
  assert.deepEqual(skipped.skipped, [ID_A])
  assert.equal((await store.get(ID_A))?.title, '改过的标题')

  // 拒绝：id 拼不进文件名
  const rejected = await store.mergeRemote([remote({ id: '../evil' })], 2_400)
  assert.deepEqual(rejected.rejected, ['../evil'])
})

test('mergeRemote：墓碑上的 issue 不会再被同步回来', async (t) => {
  const root = tempRoot(t)
  const store = new IssueStore({ dir: root })
  const created = await store.create(draft({ createdAt: 1_000 }))
  await store.remove(created.id)
  const report = await store.mergeRemote([
    remote({ id: created.id, title: '复活？' }),
  ], 3_000)
  assert.deepEqual(report.skipped, [created.id])
  assert.equal(await store.get(created.id), undefined)
})

test('mergeRemote：空输入直接返回空报告', async (t) => {
  const root = tempRoot(t)
  const store = new IssueStore({ dir: root })
  assert.deepEqual(await store.mergeRemote([], 1), {
    inserted: [],
    updated: [],
    skipped: [],
    unchanged: [],
    rejected: [],
  })
})

test('claimable：剔除墓碑、非法 id 与已定案状态', async (t) => {
  const root = tempRoot(t)
  const store = new IssueStore({ dir: root })
  const pending = await store.create(draft())
  await store.create(draft())
  const routing = await store.create(draft())
  await store.transfer(routing.id, 't-1')
  const removed = await store.create(draft())
  await store.remove(removed.id)

  const claimable = await store.claimable([pending.id, routing.id, removed.id, 'bad id', ID_B])
  assert.ok(claimable.includes(pending.id))
  assert.ok(claimable.includes(ID_B))
  assert.ok(!claimable.includes(routing.id))
  assert.ok(!claimable.includes(removed.id))
  assert.ok(!claimable.includes('bad id'))
})

test('refreshTitles 只刷新已有记录的标题，不动正文', async (t) => {
  const root = tempRoot(t)
  const store = new IssueStore({ dir: root })
  const created = await store.create(draft())
  const changed = await store.refreshTitles([
    { id: created.id, title: '云端改名' },
    { id: ID_C, title: '不存在' },
    { id: created.id, title: '' },
  ], 4_000)
  assert.equal(changed, 1)
  const record = await store.get(created.id)
  assert.equal(record?.title, '云端改名')
  assert.equal(record?.detail, '正文')
  assert.equal(record?.updatedAt, 4_000)
})

test('router 簿记随索引落盘，迁移到新进程仍可读', async (t) => {
  const root = tempRoot(t)
  const store = new IssueStore({ dir: root, now: () => 10_000 })
  await store.saveRouter({ sessionId: 'session-1', failures: 2, lastIssueId: ID_A })
  assert.deepEqual(store.router(), {
    sessionId: 'session-1',
    failures: 2,
    lastIssueId: ID_A,
    updatedAt: 10_000,
  })
  const reopened = new IssueStore({ dir: root })
  await reopened.load()
  assert.equal(reopened.router().sessionId, 'session-1')
  assert.equal(reopened.router().failures, 2)
})

test('坏索引被隔离，从 issues/ 重建', async (t) => {
  const root = tempRoot(t)
  mkdirSync(join(root, 'issues'), { recursive: true })
  writeFileSync(join(root, 'issues', `${ID_A}.json`), JSON.stringify(issueRecord({
    id: ID_A,
    source: 'wecom',
  })), 'utf8')
  writeFileSync(join(root, 'castboard-issue.json'), 'not json', 'utf8')

  const store = new IssueStore({ dir: root })
  await store.load()
  assert.deepEqual(store.summaries().map(summary => summary.id), [ID_A])
  const record = await store.get(ID_A)
  assert.equal(record?.id, ID_A)
  assert.equal(record?.source, 'wecom')
})

test('索引摘要坏条目被丢弃，其余保留', async (t) => {
  const root = tempRoot(t)
  mkdirSync(join(root, 'issues'), { recursive: true })
  writeFileSync(join(root, 'castboard-issue.json'), JSON.stringify({
    schemaVersion: 1,
    revision: 3,
    issues: [
      { id: ID_A, title: '好的', workspaceId: '', urgency: 'normal', status: 'pending', createdAt: 1, updatedAt: 1 },
      { id: '../bad', title: '坏的', workspaceId: '', urgency: 'normal', status: 'pending', createdAt: 1, updatedAt: 1 },
    ],
  }), 'utf8')
  writeFileSync(join(root, 'issues', `${ID_A}.json`), JSON.stringify(issueRecord({ id: ID_A })), 'utf8')

  const store = new IssueStore({ dir: root })
  await store.load()
  assert.equal(store.revision(), 3)
  assert.deepEqual(store.summaries().map(summary => summary.id), [ID_A])
})

test('只读进程：读得到，写操作全部无副作用', async (t) => {
  const root = tempRoot(t)
  const writer = new IssueStore({ dir: root })
  const created = await writer.create(draft())

  const reader = new IssueStore({ dir: root, canWrite: () => false })
  await reader.load()
  assert.equal(reader.writable(), false)
  assert.equal((await reader.get(created.id))?.id, created.id)
  const report = await reader.mergeRemote([remote({ id: ID_B })], 1)
  assert.deepEqual(report, { inserted: [], updated: [], skipped: [], unchanged: [], rejected: [] })
  await reader.saveRouter({ sessionId: 'should-not-write' })
  assert.deepEqual(reader.router(), {})
  await assert.rejects(() => reader.create(draft()), /read-only/)
})
