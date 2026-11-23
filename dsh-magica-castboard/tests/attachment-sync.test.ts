import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { TaskAttachmentIndex } from '../src/host/pipeline/attachments.ts'
import { AttachmentSync, type RemoteAttachmentMeta } from '../src/host/pipeline/attachment-sync.ts'
import { tempRoot } from './helpers.ts'

const ISSUE = '11111111-1111-4111-8111-111111111111'
const COMMENT = '22222222-2222-4222-8222-222222222222'

/** Fake cloud: returns only the rows of the requested target, like the SDK does. */
function lister(rows: readonly RemoteAttachmentMeta[]) {
  return async (targetType: RemoteAttachmentMeta['targetType'], targetId: string, role?: RemoteAttachmentMeta['role']) =>
    rows.filter(row =>
      row.targetType === targetType
      && row.targetId === targetId
      && (role === undefined || row.role === role),
    )
}

function metas(): RemoteAttachmentMeta[] {
  return [
    { fileId: 'f-input', fileName: 'result.md', targetType: 'issue', targetId: ISSUE, role: 'assigner' },
    { fileId: 'f-output', fileName: 'result.md', targetType: 'issue', targetId: ISSUE, role: 'assignee' },
    { fileId: 'f-comment', fileName: 'shot.png', targetType: 'comment', targetId: COMMENT, role: 'assigner' },
  ]
}

test('AttachmentSync：issue 目标 input/output 同名分目录，重复同步不重复下载', async t => {
  const index = new TaskAttachmentIndex({ dir: tempRoot(t) })
  const downloaded: string[] = []
  const sync = new AttachmentSync({
    index,
    list: lister(metas()),
    download: async fileId => {
      downloaded.push(fileId)
      return new TextEncoder().encode(fileId)
    },
  })

  const first = await sync.syncIssue(ISSUE)
  assert.deepEqual(downloaded.sort(), ['f-input', 'f-output'])
  assert.deepEqual(first.map(row => [row.targetType, row.role, row.name, row.state]), [
    ['issue', 'assigner', 'result.md', 'ready'],
    ['issue', 'assignee', 'result.md', 'ready'],
  ])
  const paths = new Set(first.map(row => row.path))
  assert.equal(paths.size, 2)
  assert.ok([...paths].includes(join(index.dirOf(ISSUE), 'input', 'result.md')))
  assert.ok([...paths].includes(join(index.dirOf(ISSUE), 'output', 'result.md')))
  await Promise.all([...paths].map(path => access(path)))

  const listed = await sync.listIssue(ISSUE)
  assert.equal(listed.length, 2)
  assert.deepEqual(listed.map(row => row.state), ['ready', 'ready'])

  const second = await sync.syncIssue(ISSUE)
  assert.deepEqual(downloaded.sort(), ['f-input', 'f-output'])
  assert.equal(second.length, 2)
})

test('AttachmentSync：comment 目标单独同步，syncIssue 不碰 comment 行', async t => {
  const index = new TaskAttachmentIndex({ dir: tempRoot(t) })
  const downloaded: string[] = []
  const sync = new AttachmentSync({
    index,
    list: lister(metas()),
    download: async fileId => {
      downloaded.push(fileId)
      return new TextEncoder().encode(fileId)
    },
  })

  await sync.syncIssue(ISSUE)
  assert.deepEqual(downloaded, ['f-input', 'f-output'])
  assert.deepEqual(index.list(ISSUE, 'comment'), [])

  const comments = await sync.syncComment(ISSUE, COMMENT)
  assert.deepEqual(downloaded, ['f-input', 'f-output', 'f-comment'])
  assert.deepEqual(comments.map(row => [row.targetType, row.targetId, row.role, row.name]), [
    ['comment', COMMENT, 'assigner', 'shot.png'],
  ])
  assert.equal(comments[0]?.path, join(index.dirOf(ISSUE), 'comments', COMMENT, 'shot.png'))
  await access(comments[0]!.path)

  // A later issue sync must preserve the comment target rows (and files).
  const again = await sync.syncIssue(ISSUE)
  assert.equal(again.length, 2)
  assert.deepEqual(index.list(ISSUE, 'comment').map(row => row.name), ['shot.png'])
})

test('AttachmentSync：下载失败保留 pending，执行读取只取 ready', async t => {
  const index = new TaskAttachmentIndex({ dir: tempRoot(t) })
  const sync = new AttachmentSync({
    index,
    list: lister([{ fileId: 'f-input', fileName: 'a.txt', targetType: 'issue', targetId: ISSUE, role: 'assigner' }]),
    download: async () => { throw new Error('network down') },
  })

  const rows = await sync.syncIssue(ISSUE)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.state, 'pending')
  assert.deepEqual(index.list(ISSUE, 'input'), rows)
  assert.deepEqual(await sync.listIssue(ISSUE), rows)
  assert.deepEqual(await index.listForTask({ id: 't-1', issueId: ISSUE }), [])
})

test('AttachmentSync：同角色重名用 fileId 后缀区分；无关目标的行被过滤', async t => {
  const index = new TaskAttachmentIndex({ dir: tempRoot(t) })
  const sync = new AttachmentSync({
    index,
    list: async () => [
      { fileId: 'aaa111', fileName: 'report.md', targetType: 'issue', targetId: ISSUE, role: 'assignee' },
      { fileId: 'bbb222', fileName: 'report.md', targetType: 'issue', targetId: ISSUE, role: 'assignee' },
      // A row for another target must never be adopted by this sync.
      { fileId: 'ccc333', fileName: 'other.md', targetType: 'comment', targetId: COMMENT, role: 'assigner' },
    ],
    download: async fileId => new TextEncoder().encode(fileId),
  })
  const rows = await sync.syncIssue(ISSUE)
  assert.deepEqual(rows.map(row => row.name).sort(), ['report.bbb222.md', 'report.md'])
  assert.deepEqual(index.list(ISSUE, 'comment'), [])
  assert.equal(new Set(rows.map(row => row.path)).size, 2)
})
