/**
 * 产物上行（raw/host/1）：跳过规则、批上限、幂等表、挂载成功后才记水位。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PublishCursorStore } from '../src/host/ledger/cursors.ts'
import {
  ArtifactUplink,
  MAX_UPLOAD_FILES,
  shouldSkipPath,
} from '../src/host/pipeline/uplink.ts'
import { tempRoot } from './helpers.ts'

function makeUplink(t: { after: (fn: () => void) => void }, options: {
  upload?: (path: string, fileName: string) => Promise<string>
  attach?: (issueId: string, spec: { fileId: string; fileName: string }) => Promise<void>
  writable?: boolean
} = {}): {
  uplink: ArtifactUplink
  cursor: PublishCursorStore
  uploads: string[]
  attachments: string[]
} {
  const root = tempRoot(t)
  const cursor = new PublishCursorStore(root)
  const uploads: string[] = []
  const attachments: string[] = []
  const uplink = new ArtifactUplink({
    cursors: cursor,
    upload: options.upload ?? (async (path, fileName) => {
      uploads.push(path)
      return `file-${fileName}`
    }),
    attach: options.attach ?? (async (issueId, spec) => {
      attachments.push(`${issueId}:${spec.fileId}`)
    }),
    ...(options.writable === undefined ? {} : { isWritable: () => options.writable as boolean }),
  })
  return { uplink, cursor, uploads, attachments }
}

test('shouldSkipPath：node_modules / .git / 日志 / 临时文件 / sourcemap 跳过', () => {
  assert.ok(shouldSkipPath('/repo/node_modules/pkg/a.js'))
  assert.ok(shouldSkipPath('C:\\repo\\.git\\config'))
  assert.ok(shouldSkipPath('/repo/run.log'))
  assert.ok(shouldSkipPath('/repo/x.tmp'))
  assert.ok(shouldSkipPath('/repo/dist/a.js.map'))
  assert.equal(shouldSkipPath('/repo/report.md'), undefined)
})

test('uplink：上传 → 挂载 → 记幂等；第二次同一路径跳过', async (t) => {
  const root = tempRoot(t)
  const file = join(root, 'report.md')
  await writeFile(file, 'done')
  const kit = makeUplink(t)
  const first = await kit.uplink.uplink('11111111-1111-4111-8111-111111111111', [file])
  assert.deepEqual(first.uploaded.map(item => item.path), [file])
  assert.deepEqual(kit.uploads, [file])
  assert.deepEqual(kit.attachments, ['11111111-1111-4111-8111-111111111111:file-report.md'])
  assert.equal(kit.cursor.uploadedFileId(file), 'file-report.md')

  const second = await kit.uplink.uplink('11111111-1111-4111-8111-111111111111', [file])
  assert.equal(second.uploaded.length, 0)
  assert.equal(second.skipped[0]?.reason, '已上传过')
  assert.equal(kit.uploads.length, 1)
})

test('uplink：空文件跳过且不调用上传；超过批上限的路径进 skipped', async (t) => {
  const root = tempRoot(t)
  const empty = join(root, 'empty.txt')
  await writeFile(empty, '')
  const files: string[] = []
  await mkdir(join(root, 'many'), { recursive: true })
  for (let index = 0; index < MAX_UPLOAD_FILES + 1; index += 1) {
    const path = join(root, 'many', `f-${String(index)}.txt`)
    await writeFile(path, 'x')
    files.push(path)
  }
  const kit = makeUplink(t)
  const emptyResult = await kit.uplink.uplink('11111111-1111-4111-8111-111111111111', [empty])
  assert.equal(emptyResult.uploaded.length, 0)
  assert.equal(kit.uploads.length, 0)
  assert.equal(emptyResult.skipped[0]?.reason, '空文件')

  const result = await kit.uplink.uplink('11111111-1111-4111-8111-111111111111', files)
  assert.equal(kit.uploads.length, MAX_UPLOAD_FILES)
  assert.ok(result.skipped.some(item => item.reason === `单次最多 ${MAX_UPLOAD_FILES} 个`))
})

test('uplink：相对路径按 cwd 解析；只读进程全部 skipped', async (t) => {
  const root = tempRoot(t)
  await writeFile(join(root, 'report.md'), 'x')
  const kit = makeUplink(t)
  const result = await kit.uplink.uplink('11111111-1111-4111-8111-111111111111', ['report.md'], { cwd: root })
  assert.equal(result.uploaded.length, 1)

  const readonly = makeUplink(t, { writable: false })
  const blocked = await readonly.uplink.uplink('11111111-1111-4111-8111-111111111111', [join(root, 'report.md')])
  assert.equal(blocked.uploaded.length, 0)
  assert.equal(readonly.uploads.length, 0)
  assert.equal(blocked.skipped[0]?.reason, '本进程只读')
})

test('uplink：挂载失败不写幂等表，下次会重试', async (t) => {
  const root = tempRoot(t)
  const file = join(root, 'report.md')
  await writeFile(file, 'x')
  let fail = true
  const kit = makeUplink(t, {
    attach: async () => {
      if (fail) throw new Error('attach failed')
    },
  })
  const first = await kit.uplink.uplink('11111111-1111-4111-8111-111111111111', [file])
  assert.equal(first.failed.length, 1)
  assert.equal(kit.cursor.uploadedFileId(file), undefined)

  fail = false
  const second = await kit.uplink.uplink('11111111-1111-4111-8111-111111111111', [file])
  assert.equal(second.uploaded.length, 1)
  assert.equal(kit.cursor.uploadedFileId(file), 'file-report.md')
})
