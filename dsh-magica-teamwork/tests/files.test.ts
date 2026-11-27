/** 文件：上传（raw body + 哈希校验 + 大小限制）/ 下载（登录即可）/ 删除（administrator） */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { bootHarness, isCode, PASSWORD, signToken } from './helpers.js'

test('上传：返回 fileId/fileName/size/sha256；文件名 percent-encoded', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')

  const bytes = Buffer.from('hello teamwork', 'utf8')
  const info = await alice.files.upload(bytes, { fileName: '报告 v1.pdf' })
  assert.match(info.fileId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(info.fileName, '报告 v1.pdf')
  assert.equal(info.size, bytes.length)
  assert.equal(info.sha256, createHash('sha256').update(bytes).digest('hex'))
})

test('上传：哈希不符 → 400 且不留半成品', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')

  const res = await h.raw('POST', '/files', {
    rawBody: 'abc',
    token: signToken(alice.accountToken!, 'alice'),
    account: 'alice',
    headers: {
      'x-file-name': encodeURIComponent('a.txt'),
      'x-file-sha256': 'f'.repeat(64),
    },
  })
  assert.equal(res.status, 400)
  assert.equal((res.body as { code: string }).code, 'sha256_mismatch')

  // 目录里不应留下 .tmp
  const { readdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const files = readdirSync(join(h.dir, 'files'))
  assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0)
})

test('上传：Content-Type 必须 octet-stream；缺文件名；非法 UUID 下载', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')

  const wrongCt = await h.raw('POST', '/files', {
    rawBody: 'x',
    contentType: 'text/plain',
    token: signToken(alice.accountToken!, 'alice'),
    account: 'alice',
  })
  assert.equal(wrongCt.status, 400)
  assert.equal((wrongCt.body as { code: string }).code, 'invalid_request')

  const noName = await h.raw('POST', '/files', {
    rawBody: 'x',
    token: signToken(alice.accountToken!, 'alice'),
    account: 'alice',
    headers: { 'x-file-name': '' },
  })
  assert.equal(noName.status, 400)
  assert.equal((noName.body as { code: string }).code, 'invalid_file_name')

  const badId = await h.raw('GET', '/files/..%2F..%2Fetc%2Fpasswd', {
    token: signToken(alice.accountToken!, 'alice'),
    account: 'alice',
  })
  assert.equal(badId.status, 400)
  assert.equal((badId.body as { code: string }).code, 'invalid_file_id')
})

test('下载：任何登录用户都能下；不存在 404', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  const bob = await h.register('bob')

  const bytes = Buffer.from('secret payload', 'utf8')
  const info = await alice.files.upload(bytes, { fileName: 'secret.bin' })

  const res = await bob.files.download(info.fileId)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/octet-stream')
  assert.equal(res.headers.get('content-length'), String(bytes.length))
  assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="/)
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('utf8'), 'secret payload')

  await assert.rejects(
    () => bob.files.download('3f2504e0-4f89-41d3-9a0c-0305e82c3301'),
    isCode('file_not_found'),
  )
})

test('删除：只有 administrator；删完引用一起清、再下 404', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const bob = await h.register('bob')

  const info = await bob.files.upload(Buffer.from('x'), { fileName: 'x.txt' })
  const [issueId] = await bob.issues.create([{ title: 't', assignee: 'bob' }])
  await bob.attachments.add([{ targetType: 'issue', targetId: issueId!, fileId: info.fileId, role: 'assignee' }])

  await assert.rejects(() => bob.files.remove(info.fileId), isCode('forbidden'))

  await admin.files.remove(info.fileId)
  assert.equal((await bob.attachments.list('issue', issueId!)).length, 0, '附件引用被清掉')
  await assert.rejects(() => bob.files.download(info.fileId), isCode('file_not_found'))
})

test('上传大小上限：超过 --max-upload-mb 被拒', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { startServer } = await import('../src/server/index.js')
  const { TeamworkClient } = await import('./support/legacy-client.js')

  const dir = mkdtempSync(join(tmpdir(), 'tw-size-'))
  const server = await startServer({ dataDir: dir, port: 0, log: () => {}, rateLimit: false, argv: ['--max-upload-mb', '1'] })
  t.after(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const c = new TeamworkClient({ host: `http://127.0.0.1:${server.port}`, persist: false })
  await c.register({ accountId: 'alice', password: PASSWORD })
  const big = Buffer.alloc(1024 * 1024 + 1, 1)
  await assert.rejects(() => c.files.upload(big, { fileName: 'big.bin' }))
})

