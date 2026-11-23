/**
 * 附件清单（raw/host/2）：目标模型、落盘路径、派生 kind、宽松解析与去重/上限。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  MAX_ATTACHMENTS_PER_ISSUE,
  TaskAttachmentIndex,
  attachmentKind,
  safeFileName,
  type StoredAttachment,
} from '../src/host/pipeline/attachments.ts'
import { tempRoot } from './helpers.ts'

const ISSUE = '11111111-1111-4111-8111-111111111111'
const COMMENT = '22222222-2222-4222-8222-222222222222'

function issueRow(overrides: Partial<StoredAttachment> = {}): StoredAttachment {
  return {
    name: 'a.txt',
    path: '',
    targetType: 'issue',
    targetId: ISSUE,
    role: 'assigner',
    state: 'ready',
    ...overrides,
  }
}

test('safeFileName：只保留安全基名并兜底', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd')
  assert.equal(safeFileName('C:\\tmp\\a.txt'), 'a.txt')
  assert.equal(safeFileName('a:b?.txt'), 'b_.txt')
  assert.equal(safeFileName('..'), 'attachment')
})

test('attachmentKind：comment 优先，issue 按 role 派生 input/output', () => {
  assert.equal(attachmentKind({ targetType: 'comment', role: 'assigner' }), 'comment')
  assert.equal(attachmentKind({ targetType: 'comment', role: 'assignee' }), 'comment')
  assert.equal(attachmentKind({ targetType: 'issue', role: 'assigner' }), 'input')
  assert.equal(attachmentKind({ targetType: 'issue', role: 'assignee' }), 'output')
})

test('清单：put 后可按 issue / kind 读回；重新加载仍一致', async (t) => {
  const root = tempRoot(t)
  const index = new TaskAttachmentIndex({ dir: root, now: () => 1_000 })
  const inputDir = join(index.dirOf(ISSUE), 'input')
  await index.put(ISSUE, inputDir, [
    issueRow({ path: join(inputDir, 'a.txt'), size: 3 }),
  ])
  assert.deepEqual(index.list(ISSUE).map(file => file.name), ['a.txt'])
  assert.deepEqual(index.list(ISSUE, 'input').map(file => file.name), ['a.txt'])
  assert.deepEqual(index.list(ISSUE, 'output'), [])
  assert.deepEqual(index.list(ISSUE, 'comment'), [])

  const reread = new TaskAttachmentIndex({ dir: root })
  await reread.load()
  const entry = await reread.read(ISSUE)
  assert.equal(entry?.dir, index.dirOf(ISSUE))
  assert.deepEqual(entry?.files.map(file => file.name), ['a.txt'])
  assert.equal(entry?.files[0]?.targetType, 'issue')
  assert.equal(entry?.files[0]?.targetId, ISSUE)
  assert.equal(entry?.files[0]?.role, 'assigner')
  assert.equal((entry?.files[0] as unknown as Record<string, unknown> | undefined)?.['type'], undefined)
})

test('路径：issue assigner -> input，issue assignee -> output，comment -> comments/<commentId>', async (t) => {
  const index = new TaskAttachmentIndex({ dir: tempRoot(t) })
  assert.equal(
    index.filePathOf(ISSUE, 'issue', ISSUE, 'assigner', 'result.md'),
    join(index.dirOf(ISSUE), 'input', 'result.md'),
  )
  assert.equal(
    index.filePathOf(ISSUE, 'issue', ISSUE, 'assignee', 'result.md'),
    join(index.dirOf(ISSUE), 'output', 'result.md'),
  )
  assert.equal(
    index.filePathOf(ISSUE, 'comment', COMMENT, 'assigner', 'shot.png'),
    join(index.dirOf(ISSUE), 'comments', COMMENT, 'shot.png'),
  )
  // A comment target id is a path segment too: it must pass the id whitelist.
  assert.throws(() => index.filePathOf(ISSUE, 'comment', '../evil', 'assigner', 'x.txt'), /invalid attachment target/)
  // File names are normalized instead of escaping.
  assert.equal(
    index.filePathOf(ISSUE, 'issue', ISSUE, 'assigner', '../escape.txt'),
    join(index.dirOf(ISSUE), 'input', 'escape.txt'),
  )
})

test('清单：issue input/output 同名单文件可共存；comment 目标独立', async (t) => {
  const root = tempRoot(t)
  const index = new TaskAttachmentIndex({ dir: root })
  const dir = index.dirOf(ISSUE)
  await index.put(ISSUE, dir, [
    issueRow({ name: 'result.md', path: join(dir, 'input', 'result.md') }),
    issueRow({ name: 'result.md', targetId: ISSUE, role: 'assignee', path: join(dir, 'output', 'result.md') }),
  ])
  assert.deepEqual(index.list(ISSUE, 'input').map(file => file.path), [join(dir, 'input', 'result.md')])
  assert.deepEqual(index.list(ISSUE, 'output').map(file => file.path), [join(dir, 'output', 'result.md')])

  await index.putTarget(ISSUE, 'comment', COMMENT, [issueRow({
    name: 'shot.png',
    targetType: 'comment',
    targetId: COMMENT,
    role: 'assigner',
    path: join(dir, 'comments', COMMENT, 'shot.png'),
  })])
  assert.deepEqual(index.list(ISSUE, 'comment').map(file => file.path), [join(dir, 'comments', COMMENT, 'shot.png')])
  // putTarget only replaces its own target.
  assert.equal(index.list(ISSUE, 'input').length, 1)
  assert.equal(index.list(ISSUE, 'output').length, 1)
})

test('清单：put 按 target（targetType+targetId）整体替换，其他 target 保留', async (t) => {
  const root = tempRoot(t)
  const index = new TaskAttachmentIndex({ dir: root })
  const dir = index.dirOf(ISSUE)
  await index.put(ISSUE, dir, [
    issueRow({ name: 'keep.txt', path: join(dir, 'input', 'keep.txt') }),
    issueRow({ name: 'old.txt', path: join(dir, 'input', 'old.txt') }),
    issueRow({ name: 'deliver.md', role: 'assignee', path: join(dir, 'output', 'deliver.md') }),
  ])
  await index.putTarget(ISSUE, 'comment', COMMENT, [issueRow({
    name: 'shot.png',
    targetType: 'comment',
    targetId: COMMENT,
    role: 'assigner',
    path: join(dir, 'comments', COMMENT, 'shot.png'),
  })])
  // Issue input and output share one target (issue + issueId), so replacing that target
  // replaces both roles; the comment target is a different target and survives.
  await index.put(ISSUE, dir, [issueRow({ name: 'new.txt', path: join(dir, 'input', 'new.txt') })])
  assert.deepEqual(index.list(ISSUE, 'input').map(file => file.name), ['new.txt'])
  assert.deepEqual(index.list(ISSUE, 'output'), [])
  assert.deepEqual(index.list(ISSUE, 'comment').map(file => file.name), ['shot.png'])

  // Empty batch = the default worklab input target (this issue) is cleared, nothing else is.
  await index.put(ISSUE, dir, [])
  assert.deepEqual(index.list(ISSUE, 'input'), [])
  assert.deepEqual(index.list(ISSUE, 'comment').map(file => file.name), ['shot.png'])
})

test('清单：宽松解析，坏条目/越界路径丢掉但不作废整份文件；旧行回落到 issue/assigner', async (t) => {
  const root = tempRoot(t)
  const dir = join(root, 'attachments', ISSUE)
  const other = '33333333-3333-4333-8333-333333333333'
  const otherDir = join(root, 'attachments', other)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'ok.txt'), 'x')
  await writeFile(join(dir, 'legacy-output.txt'), 'x')
  await writeFile(join(root, 'task-attachments.json'), JSON.stringify({
    attachments: [
      {
        issueId: ISSUE,
        dir,
        updatedAt: 1,
        files: [
          { name: 'ok.txt', path: join(dir, 'ok.txt'), size: 1 },
          {
            name: 'result.md',
            path: join(dir, 'output', 'result.md'),
            targetType: 'issue',
            targetId: ISSUE,
            role: 'assignee',
            fileId: 'f-out',
            size: 2,
          },
        ],
      },
      { issueId: other, dir: otherDir, files: [{ name: 'evil.txt', path: join(root, 'evil.txt') }] },
      { issueId: 'not a valid id', files: [] },
      { junk: true },
    ],
  }))
  const index = new TaskAttachmentIndex({ dir: root })
  await index.load()
  const entry = await index.read(ISSUE)
  assert.deepEqual(entry?.files.map(file => file.name), ['ok.txt', 'result.md'])
  const legacy = entry?.files[0]
  assert.equal(legacy?.targetType, 'issue')
  assert.equal(legacy?.targetId, ISSUE)
  assert.equal(legacy?.role, 'assigner')
  assert.equal(entry?.files[1]?.role, 'assignee')
  assert.equal(entry?.files[1]?.targetType, 'issue')
  // The out-of-bounds path is dropped; the issue entry survives with no files.
  assert.deepEqual((await index.read(other))?.files ?? [], [])
})

test('listForTask：只取 issue 目标、assigner、已就绪的输入件', async (t) => {
  const root = tempRoot(t)
  const index = new TaskAttachmentIndex({ dir: root })
  const dir = index.dirOf(ISSUE)
  await index.put(ISSUE, dir, [
    issueRow({ name: 'ready-input.md', path: join(dir, 'input', 'ready-input.md'), state: 'ready' }),
    issueRow({ name: 'pending-input.md', path: join(dir, 'input', 'pending-input.md'), state: 'pending' }),
    issueRow({ name: 'output.md', role: 'assignee', path: join(dir, 'output', 'output.md'), state: 'ready' }),
    issueRow({
      name: 'comment.png',
      targetType: 'comment',
      targetId: COMMENT,
      path: join(dir, 'comments', COMMENT, 'comment.png'),
      state: 'ready',
    }),
  ])
  const rows = await index.listForTask({ id: 't-1', issueId: ISSUE })
  assert.deepEqual(rows.map(file => file.name), ['ready-input.md'])
  assert.deepEqual(await index.listForTask({ id: 't-2' }), [])
})

test('add：默认为 issue/assigner；comment 目标落进 comments/<commentId>；同名跳过', async (t) => {
  const root = tempRoot(t)
  const source = join(root, 'source.txt')
  await writeFile(source, 'hello')
  const index = new TaskAttachmentIndex({ dir: root, now: () => 2_000 })
  const first = await index.add(ISSUE, [
    { name: 'log.txt', path: source, description: '崩溃日志' },
    { name: '../escape.txt', path: source },
    { name: 'shot.png', path: source, targetType: 'comment', targetId: COMMENT, role: 'assignee' },
  ])
  assert.deepEqual(first.added.map(file => file.name).sort(), ['escape.txt', 'log.txt', 'shot.png'])
  assert.equal(await readFile(join(index.dirOf(ISSUE), 'input', 'log.txt'), 'utf8'), 'hello')
  assert.equal(await readFile(join(index.dirOf(ISSUE), 'input', 'escape.txt'), 'utf8'), 'hello')
  assert.equal(
    await readFile(join(index.dirOf(ISSUE), 'comments', COMMENT, 'shot.png'), 'utf8'),
    'hello',
  )
  const comment = index.list(ISSUE, 'comment')
  assert.equal(comment[0]?.targetType, 'comment')
  assert.equal(comment[0]?.role, 'assignee')
  assert.equal(attachmentKind(comment[0]!), 'comment')

  const again = await index.add(ISSUE, [{ name: 'log.txt', path: source }])
  assert.equal(again.added.length, 0)
  assert.equal(again.skipped[0]?.reason, '同名附件已在清单里')

  const badTarget = await index.add(ISSUE, [{ name: 'x.txt', path: source, targetType: 'comment', targetId: '../evil' }])
  assert.equal(badTarget.added.length, 0)
  assert.match(badTarget.skipped[0]?.reason ?? '', /目标非法/)
})

test('add：超过单条 issue 上限的附件跳过；只读进程拒绝写入', async (t) => {
  const root = tempRoot(t)
  const source = join(root, 'source.txt')
  await writeFile(source, 'x')
  const many = Array.from({ length: MAX_ATTACHMENTS_PER_ISSUE + 1 }, (_, i) => ({
    name: `f-${String(i)}.txt`,
    path: source,
  }))
  const index = new TaskAttachmentIndex({ dir: root })
  const result = await index.add(ISSUE, many)
  assert.equal(result.added.length, MAX_ATTACHMENTS_PER_ISSUE)
  assert.ok(result.skipped.some(item => item.reason.includes('最多')))

  const readonly = new TaskAttachmentIndex({
    dir: root,
    canWrite: () => false,
  })
  await assert.rejects(() => readonly.add(ISSUE, [{ name: 'x.txt', path: source }]), /read-only/)
})
