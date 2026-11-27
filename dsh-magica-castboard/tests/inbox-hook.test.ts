import assert from 'node:assert/strict'
import { test } from 'node:test'

import { IssueCommentInbox } from '../src/host/pipeline/inbox.ts'
import type { ThreadComment } from '../src/host/ledger/comment-store.ts'
import { threadComment } from './helpers.ts'

const ISSUE = '11111111-1111-4111-8111-111111111111'

function inbox(options: { onIngested?: (anchorId: string, added: readonly ThreadComment[]) => Promise<void> }) {
  let cursor = 0
  const delivered: string[] = []
  const instance = new IssueCommentInbox({
    interest: () => new Set([ISSUE]),
    fetchPage: async () => ({
      items: [{ commentId: 'c-1', issueId: ISSUE, body: 'hello', createdAt: 1, role: 'assignee', authorType: 'system' }],
      nextSinceId: 1,
    }),
    thread: {
      ingest: async () => [threadComment({ id: 'c-1', body: 'hello', role: 'assignee', authorType: 'system' })],
    },
    deliverer: {
      deliver: async (_source, anchorId) => { delivered.push(anchorId) },
      retryPending: async () => 0,
    },
    cursor: {
      load: async () => {},
      current: () => cursor,
      advance: id => { cursor = id },
    },
    ...(options.onIngested === undefined ? {} : { onIngested: options.onIngested }),
    now: () => 1,
  })
  return { instance, delivered }
}

test('Inbox：onIngested 在落盘后、投递前唤醒', async () => {
  const seen: string[] = []
  const { instance, delivered } = inbox({
    onIngested: async anchorId => { seen.push(anchorId) },
  })
  const result = await instance.tick()
  assert.equal(result.written, 1)
  assert.deepEqual(seen, [ISSUE])
  assert.deepEqual(delivered, [ISSUE])
})

test('Inbox：onIngested 抛错不阻塞投递/游标', async () => {
  const { instance, delivered } = inbox({
    onIngested: async () => { throw new Error('boom') },
  })
  const result = await instance.tick()
  assert.equal(result.written, 1)
  assert.equal(result.advanced, true)
  assert.deepEqual(delivered, [ISSUE])
})
