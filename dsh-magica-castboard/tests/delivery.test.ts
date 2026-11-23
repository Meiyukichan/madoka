/**
 * 评论链路：投递三档（直推 / 续跑 / 记欠账）、合并窗口与回声守卫；
 * 收件箱的游标推进；上云水位只发本地行、失败即停。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { CommentDeliverer, commentsXml } from '../src/host/pipeline/deliver.ts'
import { IssueCommentInbox, COMMENT_PAGE_LIMIT } from '../src/host/pipeline/inbox.ts'
import { CommentPublisher } from '../src/host/pipeline/publish.ts'
import { LinkStore } from '../src/host/ledger/link-store.ts'
import { CommentStore } from '../src/host/ledger/comment-store.ts'
import { PublishCursorStore } from '../src/host/ledger/cursors.ts'
import { ThreadService } from '../src/host/pipeline/thread.ts'
import type { ThreadComment } from '../src/host/model.ts'
import { tempRoot, threadComment } from './helpers.ts'

const ISSUE = '11111111-1111-4111-8111-111111111111'

interface LiveFixture {
  live: {
    running: boolean
    push?: (entries: readonly { name: string; text: string }[]) => string | false
    steer?: (text: string) => boolean
    followUp?: (text: string) => unknown
  }
  pushed: Array<readonly { name: string; text: string }[]>
  steered: string[]
  followed: string[]
}

function liveSession(running: boolean): LiveFixture {
  const fixture: LiveFixture = {
    live: { running },
    pushed: [],
    steered: [],
    followed: [],
  }
  fixture.live.push = entries => {
    fixture.pushed.push(entries)
    return running ? 'steer' : 'followup'
  }
  fixture.live.steer = text => {
    fixture.steered.push(text)
    return true
  }
  fixture.live.followUp = text => {
    fixture.followed.push(text)
    return Promise.resolve()
  }
  return fixture
}

test('直推：push 成功即清欠账，消息体带 issue id 且转义正文', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  await links.patch(ISSUE, { assigneeSessionId: 'session-1' })
  const live = liveSession(true)
  const deliverer = new CommentDeliverer({
    links,
    liveSession: id => (id === 'session-1' ? live.live : undefined),
    mergeWindowMs: 0,
  })
  await deliverer.deliver('local', ISSUE, [threadComment({ id: 'c-1', body: '看 <b>这里</b>', role: 'assigner' })])
  assert.equal(live.pushed.length, 1)
  const text = live.pushed[0]?.[0]?.text ?? ''
  assert.ok(text.includes(`issue="${ISSUE}"`))
  assert.ok(text.includes('&lt;b&gt;这里&lt;/b&gt;'))
  assert.equal(links.get(ISSUE)?.assignerPendingSince, undefined)
})

test('直推：没有 push 时按 running 退到 steer 或 followUp', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  await links.patch(ISSUE, { assigneeSessionId: 'session-1' })
  const busy = liveSession(true)
  delete busy.live.push
  const busyDeliverer = new CommentDeliverer({
    links,
    liveSession: () => busy.live,
    mergeWindowMs: 0,
  })
  await busyDeliverer.deliver('local', ISSUE, [threadComment()])
  assert.equal(busy.steered.length, 1)

  const idle = liveSession(false)
  delete idle.live.push
  const idleDeliverer = new CommentDeliverer({
    links,
    liveSession: () => idle.live,
    mergeWindowMs: 0,
  })
  await idleDeliverer.deliver('local', ISSUE, [threadComment({ id: 'c-2' })])
  assert.equal(idle.followed.length, 1)
})

test('合并窗口：同一侧多条评论合成一次注入', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  await links.patch(ISSUE, { assigneeSessionId: 'session-1' })
  const live = liveSession(true)
  const deliverer = new CommentDeliverer({
    links,
    liveSession: () => live.live,
    mergeWindowMs: 400,
    setTimer: () => 1,
    clearTimer: () => {},
  })
  await deliverer.deliver('local', ISSUE, [threadComment({ id: 'c-1', createdAt: 1 })])
  await deliverer.deliver('local', ISSUE, [threadComment({ id: 'c-2', createdAt: 2 })])
  assert.equal(live.pushed.length, 0)
  assert.equal(await deliverer.flushAll(), 1)
  assert.equal(live.pushed.length, 1)
  const text = live.pushed[0]?.[0]?.text ?? ''
  assert.ok(text.includes('count="2"'))
})

test('回声守卫：写评论的会话不会收到自己的评论；系统消息不投递', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  await links.patch(ISSUE, { assigneeSessionId: 'session-1' })
  const live = liveSession(true)
  const deliverer = new CommentDeliverer({
    links,
    liveSession: () => live.live,
    mergeWindowMs: 0,
  })
  await deliverer.deliver('local', ISSUE, [threadComment({ threadId: 'session-1' })])
  assert.equal(live.pushed.length, 0)
  await deliverer.deliver('local', ISSUE, [threadComment({ id: 'c-2', authorType: 'system' })])
  assert.equal(live.pushed.length, 0)
})

test('task 自建评论（锚点是卡片 id）：不进任何会话，只落评论流', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  const comments = new CommentStore({ dir: root })
  const live = liveSession(true)
  const deliverer = new CommentDeliverer({
    links,
    liveSession: () => live.live,
    mergeWindowMs: 0,
  })
  const thread = new ThreadService({
    comments,
    links,
    now: () => 1_000,
    deliver: (source, anchorId, rows) => deliverer.deliver(source, anchorId, rows),
  })
  // 手工卡：anchorOf(task) = t-…，关系表里没有这条锚点 —— raw 的 deliver 直接跳过。
  const added = await thread.add('t-mwpx03kd-mh9o09', {
    body: '执行进展',
    role: 'assignee',
    authorType: 'agent',
    threadId: 'session-1',
  })
  assert.ok(added !== undefined)
  assert.equal((await thread.list('t-mwpx03kd-mh9o09')).length, 1)
  assert.equal(live.pushed.length, 0)
  assert.equal(live.steered.length, 0)
  assert.equal(live.followed.length, 0)
})

test('无目标：先记欠账，目标出现后补投', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  await links.patch(ISSUE, { assignerSessionId: 'session-1' })
  const live = liveSession(true)
  const comment = threadComment({ id: 'c-1', role: 'assigner', createdAt: 100 })
  const deliverer = new CommentDeliverer({
    links,
    liveSession: () => live.live,
    commentsOf: async () => [comment],
    mergeWindowMs: 0,
  })
  await deliverer.deliver('local', ISSUE, [comment])
  assert.equal(live.pushed.length, 0)
  assert.equal(links.get(ISSUE)?.assigneePendingSince, 100)

  await links.patch(ISSUE, { assigneeSessionId: 'session-1' })
  assert.equal(await deliverer.retryPending(), 1)
  assert.equal(live.pushed.length, 1)
  assert.equal(links.get(ISSUE)?.assigneePendingSince, undefined)
})

test('续跑：会话不在本进程但允许 resume 时走续跑，否则留欠账', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  await links.patch(ISSUE, { assigneeSessionId: 'session-1' })
  const resumed: string[] = []
  const deliverer = new CommentDeliverer({
    links,
    mergeWindowMs: 0,
    canResume: () => true,
    resume: async (sessionId) => { resumed.push(sessionId); return true },
  })
  await deliverer.deliver('local', ISSUE, [threadComment()])
  assert.deepEqual(resumed, ['session-1'])
  assert.equal(links.get(ISSUE)?.assigneePendingSince, undefined)

  const blocked = new CommentDeliverer({
    links,
    mergeWindowMs: 0,
    canResume: () => false,
    resume: async () => true,
  })
  await blocked.deliver('local', ISSUE, [threadComment({ id: 'c-2', createdAt: 50 })])
  assert.equal(links.get(ISSUE)?.assigneePendingSince, 50)
})

test('补投冷却：目标虽在但送不进去时，冷却期内不重复读评论流', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  await links.patch(ISSUE, { assigneeSessionId: 'session-1', assigneePendingSince: 10 })
  const failing = {
    running: true,
    push: () => false as const,
  }
  let reads = 0
  let clock = 1_000
  const deliverer = new CommentDeliverer({
    links,
    liveSession: () => failing,
    commentsOf: async () => {
      reads += 1
      return [threadComment({ id: 'c-1', role: 'assigner', createdAt: 20 })]
    },
    now: () => clock,
    mergeWindowMs: 0,
  })
  assert.equal(await deliverer.retryPending(), 0)
  assert.equal(reads, 1)
  assert.equal(await deliverer.retryPending(), 0)
  assert.equal(reads, 1)
  clock += 31_000
  assert.equal(await deliverer.retryPending(), 0)
  assert.equal(reads, 2)
})

test('commentsXml：锚点、role、作者与正文都安全落入 XML', () => {
  const xml = commentsXml(ISSUE, [
    threadComment({ body: 'a & b', role: 'assignee', authorType: 'user', author: 'r"1"' }),
  ])
  assert.ok(xml.includes(`issue="${ISSUE}"`))
  assert.ok(xml.includes('role="assignee"'))
  assert.ok(xml.includes('by="user"'))
  assert.ok(xml.includes('author="r&quot;1&quot;"'))
  assert.ok(xml.includes('a &amp; b'))
})

function fakeInboxDeps(options: {
  items: Array<{ commentId: string; issueId: string; body: string; createdAt: number }>
  interest: Set<string>
  failFetch?: boolean
  failAnchor?: string
}): {
  inbox: IssueCommentInbox
  cursor: { value: number; advanced: number[]; load(): Promise<void>; current(): number; advance(id: number): void }
  delivered: Array<{ anchorId: string; ids: string[] }>
  queries: Array<{ sinceId: number; limit: number }>
} {
  const delivered: Array<{ anchorId: string; ids: string[] }> = []
  const queries: Array<{ sinceId: number; limit: number }> = []
  const cursor = {
    value: 100,
    advanced: [] as number[],
    load: async () => {},
    current: () => cursor.value,
    advance: (id: number) => { cursor.value = id; cursor.advanced.push(id) },
  }
  const inbox = new IssueCommentInbox({
    interest: () => options.interest,
    fetchPage: async query => {
      queries.push(query)
      if (options.failFetch === true) throw new Error('net down')
      return { items: options.items, nextSinceId: 200 }
    },
    thread: {
      ingest: async (anchorId, drafts) => {
        if (anchorId === options.failAnchor) throw new Error('disk full')
        return drafts
          .filter(() => options.interest.has(anchorId))
          .map(draft => ({
            id: draft.id!,
            body: draft.body,
            createdAt: draft.createdAt ?? 0,
            role: draft.role ?? null,
            authorType: draft.authorType ?? 'user',
            origin: 'remote' as const,
          }))
      },
    },
    deliverer: {
      deliver: async (_source, anchorId, comments) => {
        delivered.push({ anchorId, ids: comments.map(comment => comment.id) })
      },
      retryPending: async () => 0,
    },
    cursor,
    now: () => 5_000,
  })
  return { inbox, cursor, delivered, queries }
}

test('收件箱：从游标前 50 开始拉，按关注集合过滤、落盘、投递并推进游标', async () => {
  const deps = fakeInboxDeps({
    items: [
      { commentId: 'c-1', issueId: ISSUE, body: 'a', createdAt: 1 },
      { commentId: 'c-2', issueId: 'other', body: 'b', createdAt: 2 },
      { commentId: 'c-3', issueId: ISSUE, body: 'c', createdAt: 3 },
    ],
    interest: new Set([ISSUE]),
  })
  const result = await deps.inbox.tick()
  assert.deepEqual(deps.queries[0], { sinceId: 50, limit: COMMENT_PAGE_LIMIT })
  assert.deepEqual(result, { fetched: 3, written: 2, delivered: 1, advanced: true })
  assert.deepEqual(deps.cursor.advanced, [200])
  assert.deepEqual(deps.delivered, [{ anchorId: ISSUE, ids: ['c-1', 'c-3'] }])
  const metrics = deps.inbox.metrics()
  assert.equal(metrics.ticks, 1)
  assert.equal(metrics.written, 2)
  assert.equal(metrics.lastTickAt, 5_000)
})

test('收件箱：拉取失败不动游标；单锚点落盘失败整拍不推进', async () => {
  const failedFetch = fakeInboxDeps({
    items: [],
    interest: new Set([ISSUE]),
    failFetch: true,
  })
  assert.deepEqual(await failedFetch.inbox.tick(), { fetched: 0, written: 0, delivered: 0, advanced: false })
  assert.deepEqual(failedFetch.cursor.advanced, [])
  assert.equal(failedFetch.inbox.metrics().failures, 1)

  const failedIngest = fakeInboxDeps({
    items: [{ commentId: 'c-1', issueId: ISSUE, body: 'a', createdAt: 1 }],
    interest: new Set([ISSUE]),
    failAnchor: ISSUE,
  })
  const result = await failedIngest.inbox.tick()
  assert.equal(result.advanced, false)
  assert.deepEqual(failedIngest.cursor.advanced, [])
})

test('收件箱：关闭通道时一个请求都不发，单飞复用同一拍', async () => {
  const deps = fakeInboxDeps({ items: [], interest: new Set([ISSUE]) })
  const disabled = new IssueCommentInbox({
    interest: () => new Set([ISSUE]),
    fetchPage: async () => { throw new Error('should not fetch') },
    thread: { ingest: async () => [] },
    deliverer: { deliver: async () => {}, retryPending: async () => 0 },
    cursor: { load: async () => {}, current: () => 0, advance: () => {} },
    enabled: () => false,
  })
  assert.deepEqual(await disabled.tick(), { fetched: 0, written: 0, delivered: 0, advanced: false })

  const first = deps.inbox.tick()
  const second = deps.inbox.tick()
  assert.equal(first, second)
  await first
})

test('上云：只发本地行、水位逐条推进；失败停在原地', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  const comments = new CommentStore({ dir: root })
  const cursor = new PublishCursorStore(join(root))
  const rows: ThreadComment[] = [
    threadComment({ id: 'remote-1', origin: 'remote', createdAt: 1 }),
    threadComment({ id: 'local-1', origin: 'local', createdAt: 2 }),
    threadComment({ id: 'local-2', origin: 'local', createdAt: 3 }),
  ]
  await comments.append(ISSUE, rows)

  let fail = false
  const sent: string[] = []
  const publisher = new CommentPublisher({
    comments,
    links,
    cursor,
    publishComment: async pending => {
      if (fail) throw new Error('net')
      sent.push(pending.commentId)
    },
    debounceMs: 0,
  })

  const outcome = await publisher.publishAnchor(ISSUE)
  assert.deepEqual(outcome, { attempted: 2, published: 2, failed: 0, skipped: 1 })
  assert.deepEqual(sent, ['local-1', 'local-2'])
  assert.equal(cursor.lastPublished(ISSUE), 'local-2')

  await comments.append(ISSUE, [threadComment({ id: 'local-3', origin: 'local', createdAt: 4 })])
  fail = true
  const failed = await publisher.publishAnchor(ISSUE)
  assert.deepEqual(failed, { attempted: 1, published: 0, failed: 1, skipped: 0 })
  assert.equal(cursor.lastPublished(ISSUE), 'local-2')

  fail = false
  const retried = await publisher.publishAnchor(ISSUE)
  assert.deepEqual(retried, { attempted: 1, published: 1, failed: 0, skipped: 0 })
  assert.equal(cursor.lastPublished(ISSUE), 'local-3')
  await publisher.dispose()
})

test('上云：没有本地台账的跨机 issue 也先发，404 后负缓存跳过', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  const comments = new CommentStore({ dir: root })
  const cursor = new PublishCursorStore(join(root))
  await comments.append(ISSUE, [threadComment({ id: 'local-1', origin: 'local' })])
  const publisher = new CommentPublisher({
    comments,
    links,
    cursor,
    // Every issue is cloud-backed: publishing is always attempted, even without a link row.
    publishComment: async () => { throw new Error('not_found: issue 不存在') },
  })
  assert.deepEqual(await publisher.publishAnchor(ISSUE), { attempted: 1, published: 0, failed: 0, skipped: 1 })
  assert.equal(cursor.lastPublished(ISSUE), 'local-1')
  assert.deepEqual(await publisher.publishAnchor(ISSUE), { attempted: 0, published: 0, failed: 0, skipped: 0 })
  await publisher.dispose()
})

test('上云：发布开关关闭时一条都不发', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  const comments = new CommentStore({ dir: root })
  const cursor = new PublishCursorStore(join(root))
  await comments.append(ISSUE, [threadComment({ origin: 'local' })])
  const publisher = new CommentPublisher({
    enabled: () => false,
    comments,
    links,
    cursor,
    publishComment: async () => { throw new Error('should not publish') },
  })
  assert.deepEqual(await publisher.publishAnchor(ISSUE), { attempted: 0, published: 0, failed: 0, skipped: 0 })
  assert.equal(cursor.lastPublished(ISSUE), undefined)
  await publisher.dispose()
})

test('ThreadService + 投递器：评论落盘、红点、投递一次到位', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  const comments = new CommentStore({ dir: root })
  await links.patch(ISSUE, { assigneeSessionId: 'session-1' })
  const live = liveSession(true)
  const deliverer = new CommentDeliverer({
    links,
    liveSession: () => live.live,
    mergeWindowMs: 0,
  })
  const thread = new ThreadService({
    comments,
    links,
    now: () => 1_000,
    deliver: (source, anchorId, rows) => deliverer.deliver(source, anchorId, rows),
  })
  const added = await thread.add(ISSUE, { body: '请继续', role: 'assigner', authorType: 'agent' })
  assert.ok(added !== undefined)
  assert.equal(live.pushed.length, 1)
  assert.equal(links.get(ISSUE)?.lastCommentAt, 1_000)
  assert.deepEqual((await thread.list(ISSUE)).map(comment => comment.id), [added.id])
})

test('投递跳过 references 已覆盖的评论，只补水位之后的', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  await links.patch(ISSUE, { assigneeSessionId: 'session-1' })
  const live = liveSession(false)
  const deliverer = new CommentDeliverer({
    links,
    liveSession: () => live.live,
    coveredUntil: () => 2_000,
    mergeWindowMs: 0,
  })
  await deliverer.deliver('local', ISSUE, [
    threadComment({ id: 'older', body: '已经进过 references', role: 'assigner', createdAt: 1_999 }),
    threadComment({ id: 'newer', body: '水位之后的新评论', role: 'assigner', createdAt: 2_001 }),
  ])
  assert.equal(live.pushed.length, 1)
  assert.match(live.pushed[0]?.[0]?.text ?? '', /水位之后的新评论/)
  assert.doesNotMatch(live.pushed[0]?.[0]?.text ?? '', /已经进过 references/)
})

test('上云：commentAt 用原时刻、作者类型原样上传，role=null 不伪造成 assigner', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  const comments = new CommentStore({ dir: root })
  const cursor = new PublishCursorStore(join(root))
  await comments.append(ISSUE, [
    threadComment({ id: 'c-1', body: '进展', role: 'assignee', authorType: 'agent', origin: 'local', createdAt: 1_234 }),
    threadComment({ id: 'c-2', body: '系统', role: null, authorType: 'system', origin: 'local', createdAt: 5_678 }),
  ])
  const sent: Array<{ role: string | null; authorType: string; createdAt: number }> = []
  const publisher = new CommentPublisher({
    comments,
    links,
    cursor,
    publishComment: async pending => {
      sent.push({ role: pending.role, authorType: pending.authorType, createdAt: pending.createdAt })
    },
    debounceMs: 0,
  })
  await publisher.publishAnchor(ISSUE)
  assert.deepEqual(sent, [
    { role: 'assignee', authorType: 'agent', createdAt: 1_234 },
    { role: null, authorType: 'system', createdAt: 5_678 },
  ])
  await publisher.dispose()
})

test('上云：非租约主人一个请求都不发（canPublish）', async (t) => {
  const root = tempRoot(t)
  const links = new LinkStore({ dir: root })
  const comments = new CommentStore({ dir: root })
  const cursor = new PublishCursorStore(join(root))
  await comments.append(ISSUE, [threadComment({ origin: 'local' })])
  const publisher = new CommentPublisher({
    comments,
    links,
    cursor,
    canPublish: () => false,
    publishComment: async () => { throw new Error('should not publish') },
  })
  assert.deepEqual(await publisher.publishAnchor(ISSUE), { attempted: 0, published: 0, failed: 0, skipped: 0 })
  assert.deepEqual(await publisher.recover([ISSUE]), { attempted: 0, published: 0, failed: 0, skipped: 0 })
  await publisher.dispose()
})

test('收件箱：非租约主人不拉取；云端空方向保持 null，作者类型/作者进入草稿', async () => {
  let fetched = 0
  const drafts: Array<{ role: string | null; authorType?: string; author?: string }> = []
  const makeInbox = (canPoll: () => boolean) => new IssueCommentInbox({
    interest: () => new Set([ISSUE]),
    fetchPage: async () => {
      fetched += 1
      return { items: [{ commentId: 'c-1', issueId: ISSUE, body: 'x', createdAt: 1, role: null, authorType: 'system', author: 'alice' }], nextSinceId: 1 }
    },
    thread: {
      ingest: async (_anchorId, input) => {
        drafts.push(...input.map(draft => ({ role: draft.role ?? null, authorType: draft.authorType, author: draft.author })))
        return input.map(draft => ({
          id: draft.id!,
          body: draft.body,
          createdAt: draft.createdAt ?? 0,
          role: draft.role ?? null,
          authorType: draft.authorType ?? 'user',
          origin: 'remote' as const,
        }))
      },
    },
    deliverer: { deliver: async () => {}, retryPending: async () => 0 },
    cursor: { load: async () => {}, current: () => 0, advance: () => {} },
    canPoll,
  })

  const owner = makeInbox(() => true)
  await owner.tick()
  assert.equal(fetched, 1)
  assert.deepEqual(drafts[0], { role: null, authorType: 'system', author: 'alice' })

  const secondary = makeInbox(() => false)
  assert.deepEqual(await secondary.tick(), { fetched: 0, written: 0, delivered: 0, advanced: false })
  assert.equal(fetched, 1)
})
