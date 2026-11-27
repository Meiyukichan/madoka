/**
 * 关系表、评论流、评论服务与两个游标：写入串行、幂等去重、红点与水位。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { LinkStore } from '../src/host/ledger/link-store.ts'
import { CommentStore } from '../src/host/ledger/comment-store.ts'
import { PullCursorStore, PublishCursorStore } from '../src/host/ledger/cursors.ts'
import { ThreadService } from '../src/host/pipeline/thread.ts'
import { tempRoot, threadComment } from './helpers.ts'

const ISSUE = '11111111-1111-4111-8111-111111111111'

test('LinkStore：patch 合并写、revision 累加、null 清字段', async (t) => {
  const root = tempRoot(t)
  const store = new LinkStore({ dir: root })
  const first = await store.patch(ISSUE, { assignerSessionId: 'session-1', lastCommentAt: 5 })
  assert.equal(first.assignerSessionId, 'session-1')
  assert.equal(first.lastCommentAt, 5)
  assert.equal(store.revision(), 1)
  assert.equal(store.size(), 1)
  assert.deepEqual(store.issueIds(), [ISSUE])
  assert.equal(Object.isFrozen(store.get(ISSUE)), true)

  const second = await store.patch(ISSUE, { assigneeSessionId: 'session-2', assignerSessionId: undefined })
  assert.equal(second.assigneeSessionId, 'session-2')
  assert.equal(second.assignerSessionId, 'session-1')

  const cleared = await store.patch(ISSUE, { assigneeSessionId: null })
  assert.equal(cleared.assigneeSessionId, undefined)
  assert.equal(store.revision(), 3)
  await assert.rejects(() => store.patch('', { assignerSessionId: 'session-x' }), /needs an issue id/)
})

test('LinkStore：删除整条关系并持久化，坏文件从空表重建', async (t) => {
  const root = tempRoot(t)
  const store = new LinkStore({ dir: root })
  await store.patch(ISSUE, { lastCommentAt: 5 })
  assert.equal(await store.remove(ISSUE), true)
  assert.equal(await store.remove(ISSUE), false)
  assert.equal(store.size(), 0)

  const reopened = new LinkStore({ dir: root })
  await reopened.load()
  assert.equal(reopened.size(), 0)

  writeFileSync(join(root, 'castboard-link.json'), '{ bad', 'utf8')
  const rebuilt = new LinkStore({ dir: root })
  await rebuilt.load()
  assert.equal(rebuilt.size(), 0)
})

test('LinkStore：只读进程拒绝写入', async (t) => {
  const root = tempRoot(t)
  const store = new LinkStore({ dir: root, canWrite: () => false })
  await assert.rejects(() => store.patch(ISSUE, { assignerSessionId: 'session-1' }), /read-only/)
})

test('CommentStore：追加幂等、按时间排序、坏行跳过', async (t) => {
  const root = tempRoot(t)
  const store = new CommentStore({ dir: root })
  const first = threadComment({ id: 'c-1', createdAt: 30 })
  const second = threadComment({ id: 'c-2', createdAt: 10, role: 'assignee' })
  assert.deepEqual(await store.append(ISSUE, [first]), [first])
  assert.deepEqual(await store.append(ISSUE, [second, first]), [second])
  assert.equal(await store.has(ISSUE, 'c-1'), true)
  assert.equal(await store.has(ISSUE, 'c-9'), false)
  assert.deepEqual((await store.list(ISSUE)).map(comment => comment.id), ['c-2', 'c-1'])
  assert.deepEqual([...(await store.seenIds(ISSUE))].sort(), ['c-1', 'c-2'])

  // 手改坏行与超长行：读的时候跳过，不影响好行。
  writeFileSync(join(root, 'comments', `${ISSUE}.jsonl`), [
    JSON.stringify(first),
    '{ half',
    JSON.stringify({ id: 'x'.repeat(100), body: 'x'.repeat(70_000), createdAt: 1 }),
    JSON.stringify(threadComment({ id: 'c-3', createdAt: 20 })),
    '',
  ].join('\n'), 'utf8')
  const reopened = new CommentStore({ dir: root })
  assert.deepEqual((await reopened.list(ISSUE)).map(comment => comment.id), ['c-3', 'c-1'])
})

test('CommentStore：锚点必须合法，删除整条流', async (t) => {
  const root = tempRoot(t)
  const store = new CommentStore({ dir: root })
  await assert.rejects(() => store.list('../x'), /invalid comment anchor/)
  await store.append(ISSUE, [threadComment()])
  assert.equal(await store.remove(ISSUE), true)
  assert.equal(await store.remove(ISSUE), false)
  assert.deepEqual(await store.list(ISSUE), [])
})

test('ThreadService：add 补全作者与方向，落盘后触发投递与上云', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  const comments = new CommentStore({ dir: root })
  const published: string[] = []
  const delivered: string[][] = []
  const thread = new ThreadService({
    comments,
    links,
    now: () => 1_000,
    publish: anchorId => { published.push(anchorId) },
    deliver: async (_source, _anchor, rows) => { delivered.push(rows.map(row => row.id)) },
  })

  const added = await thread.add(ISSUE, { body: '人写的', role: null })
  assert.ok(added !== undefined)
  assert.equal(added.authorType, 'user')
  assert.equal(added.origin, 'local')
  assert.equal(added.role, null)
  assert.deepEqual(published, [ISSUE])
  assert.deepEqual(delivered, [[added.id]])
  assert.equal(links.get(ISSUE)?.lastCommentAt, 1_000)
  assert.equal((await thread.list(ISSUE)).length, 1)

  const agentRow = await thread.add(ISSUE, { body: 'agent 写的', threadId: 'session-1', role: 'assignee' })
  assert.equal(agentRow?.authorType, 'agent')
  assert.equal(agentRow?.threadId, 'session-1')

  const system = await thread.addSystem(ISSUE, { body: '系统消息', systemKey: 'sys.test', createdAt: 2_000 })
  assert.equal(system?.authorType, 'system')
  assert.equal(system?.role, 'assignee')
  assert.equal(system?.systemKey, 'sys.test')

  const control = await thread.addControl(ISSUE, {
    id: 'c-control',
    body: '{"schema":"castboard.interaction/v1"}',
    role: 'assigner',
    threadId: 'session-1',
    createdAt: 3_000,
    systemKey: 'castboard.interaction.answered',
  })
  assert.equal(control?.authorType, 'system')
  assert.equal(control?.role, 'assigner')
  assert.equal(control?.createdAt, 3_000)

  const duplicate = await thread.addControl(ISSUE, {
    id: 'c-control',
    body: '{"schema":"castboard.interaction/v1"}',
    role: 'assigner',
  })
  assert.equal(duplicate, undefined, '同 id 幂等')

  await assert.rejects(
    () => thread.addControl(ISSUE, { body: 'x'.repeat(4_001), role: 'assignee' }),
    /control comment too large/,
  )
})

test('ThreadService：deliver:false 跳过投递，ingest 落 remote 且不再上云', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  const comments = new CommentStore({ dir: root })
  let delivered = 0
  let published = 0
  const thread = new ThreadService({
    comments,
    links,
    now: () => 1_000,
    publish: () => { published += 1 },
    deliver: async () => { delivered += 1 },
  })

  const added = await thread.add(ISSUE, { body: '静默', authorType: 'user' }, { deliver: false })
  assert.ok(added !== undefined)
  assert.equal(published, 1)
  assert.equal(delivered, 0)

  const ingested = await thread.ingest(ISSUE, [
    { id: 'cloud-1', body: '云端', createdAt: 500, role: 'assignee', authorType: 'user' },
  ])
  assert.equal(ingested.length, 1)
  assert.equal(ingested[0]?.origin, 'remote')
  assert.equal(published, 1, 'remote 行不再上云')
  assert.equal(delivered, 0, 'ingest 不重放投递')
  assert.deepEqual(await thread.ingest(ISSUE, [{ id: 'cloud-1', body: '重复', createdAt: 600 }]), [])
})

test('ThreadService：markRead 只在有未读时推进，覆盖水位只前进', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  const comments = new CommentStore({ dir: root })
  const thread = new ThreadService({ comments, links, now: () => 5_000 })
  await thread.add(ISSUE, { body: '一条', createdAt: 3_000 })

  assert.equal(thread.coveredUntil(ISSUE), 0)
  assert.equal(thread.markCovered(ISSUE, [threadComment({ createdAt: 2_000 })]), 2_000)
  assert.equal(thread.markCovered(ISSUE, [threadComment({ createdAt: 1_000 })]), 2_000)

  assert.equal(await thread.markRead(ISSUE), 5_000)
  assert.equal(links.get(ISSUE)?.lastSeenAt, 5_000)
  const revision = links.revision()
  assert.equal(await thread.markRead(ISSUE), 5_000)
  assert.equal(links.revision(), revision, '已读后再点不重复写')
})

test('PullCursorStore：只前进、懒刷落盘、重开可读', async (t) => {
  const root = tempRoot(t)
  const cursor = new PullCursorStore(root)
  await cursor.load()
  assert.equal(cursor.current(), 0)
  cursor.advance(5)
  cursor.advance(3)
  assert.equal(cursor.current(), 5)
  await cursor.flush()
  const file = JSON.parse(readFileSync(join(root, 'comment-cursor.json'), 'utf8')) as { lastCommentId: number }
  assert.equal(file.lastCommentId, 5)

  const reopened = new PullCursorStore(root)
  await reopened.load()
  assert.equal(reopened.current(), 5)
})

test('PublishCursorStore：发布水位与产物幂等表立即落盘', async (t) => {
  const root = tempRoot(t)
  const cursor = new PublishCursorStore(root)
  await cursor.setPublished(ISSUE, 'comment-1')
  await cursor.setUploadedFile('D:/a.log', 'file-1')
  assert.equal(cursor.lastPublished(ISSUE), 'comment-1')
  assert.equal(cursor.uploadedFileId('D:/a.log'), 'file-1')

  const reopened = new PublishCursorStore(root)
  await reopened.load()
  assert.equal(reopened.lastPublished(ISSUE), 'comment-1')
  assert.equal(reopened.uploadedFileId('D:/a.log'), 'file-1')
  assert.equal(existsSync(join(root, 'comment-publish-cursor.json')), true)

  // 手改坏的值被过滤
  writeFileSync(join(root, 'comment-publish-cursor.json'), JSON.stringify({
    byAnchor: { [ISSUE]: '' },
    uploadedFiles: { 'D:/b.log': 7 },
  }), 'utf8')
  const sanitized = new PublishCursorStore(root)
  await sanitized.load()
  assert.deepEqual(sanitized.snapshot(), { byAnchor: {}, uploadedFiles: {} })
})
