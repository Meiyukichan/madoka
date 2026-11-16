/** 管理与运维：健康 / 版本 / 账号列表 / 改角色 / 重置密码 / 停机 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootHarness, isCode, PASSWORD, PASSWORD2, signToken } from './helpers.js'

test('M1 健康：公开；含 db 与缓存统计；user_version=1', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const res = await h.raw('GET', '/health')
  assert.equal(res.status, 200)
  const body = res.body as { ok: boolean; version: string; db: { userVersion: number; journalMode: string }; authCache: { ttlMs: number } }
  assert.equal(body.ok, true)
  assert.equal(body.version, '0.2.0-alpha.1')
  assert.equal(body.db.userVersion, 1)
  assert.equal(body.db.journalMode, 'wal')
  assert.equal(body.authCache.ttlMs, 60_000)
})

test('M2 版本：protocol = dsh-teamwork/1；endpoints 恰好 47 个', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const res = await h.raw('GET', '/version')
  const body = res.body as { protocol: string; endpoints: string[]; node: string }
  assert.equal(body.protocol, 'dsh-teamwork/1')
  assert.equal(body.endpoints.length, 47)
  assert.ok(body.endpoints.includes('POST /issues/batch'))
  assert.ok(body.endpoints.includes('GET /health'))
  assert.match(body.node, /^v\d+/)
})

test('M6 账号列表：分页 + q 搜索 + 只有 administrator；不含 accountToken', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const bob = await h.register('bob')

  const res = await h.raw('GET', '/admin/accounts', { token: signToken(admin.accountToken!, 'alice'), account: 'alice' })
  assert.equal(res.status, 200)
  const body = res.body as { total: number; items: Array<Record<string, unknown>> }
  assert.equal(body.total, 2)
  for (const item of body.items) {
    assert.equal('accountToken' in item, false, '列表不能返回 accountToken')
    assert.ok(typeof item.accountId === 'string')
  }

  const searched = await h.raw('GET', '/admin/accounts?q=bo', { token: signToken(admin.accountToken!, 'alice'), account: 'alice' })
  assert.equal((searched.body as { total: number }).total, 1)

  const forbidden = await h.raw('GET', '/admin/accounts', { token: signToken(bob.accountToken!, 'bob'), account: 'bob' })
  assert.equal(forbidden.status, 403)
})

test('M4 改角色：不能降级最后一个 administrator', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')

  await assert.rejects(() => admin.admin.setRole('alice', 'user'), isCode('last_administrator'))
  await assert.rejects(() => admin.admin.setRole('alice', 'leader'), isCode('last_administrator'))

  // 建第二个 admin 后可以降级第一个
  const bob = await h.register('bob')
  await setRoleRaw(h, admin, 'bob', 'administrator')
  const demoted = await setRoleRaw(h, admin, 'bob', 'leader')
  assert.equal(demoted.status, 200)
  assert.equal((demoted.body as { globalRole: string }).globalRole, 'leader')
  void bob
})

test('M4 改角色：仍是 public 项目 owner 时不能降级', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const leader = await h.register('leader1')
  await setRoleRaw(h, admin, 'leader1', 'leader')
  await leader.projects.create({ name: 'pub', visibility: 'public' })

  const res = await setRoleRaw(h, admin, 'leader1', 'user')
  assert.equal(res.status, 409)
  assert.equal((res.body as { code: string }).code, 'owner_of_public_projects')
})

test('M4 改角色：非法角色 / 目标不存在', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const bad = await setRoleRaw(h, admin, 'alice', 'root')
  assert.equal(bad.status, 400)
  const missing = await setRoleRaw(h, admin, 'ghost', 'user')
  assert.equal(missing.status, 404)
  assert.equal((missing.body as { code: string }).code, 'account_not_found')
})

test('M5 重置密码：旧 token 失效，新密码可登录', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const bob = await h.register('bob')
  const oldToken = bob.accountToken!

  const res = await h.raw('POST', '/admin/accounts/bob/password', {
    body: { newPassword: Buffer.from(PASSWORD2, 'utf8').toString('base64') },
    token: signToken(admin.accountToken!, 'alice'),
    account: 'alice',
  })
  assert.equal(res.status, 204)

  // 旧 token 失效
  const stale = await h.raw('GET', '/auth/me', { token: signToken(oldToken, 'bob'), account: 'bob' })
  assert.equal(stale.status, 401)
  // 旧密码不能登录，新密码可以
  await assert.rejects(() => h.client().login({ accountId: 'bob', password: PASSWORD }), isCode('invalid_credentials'))
  await h.client().login({ accountId: 'bob', password: PASSWORD2 })
})

test('M5 重置密码：非 administrator 被拒；密码策略生效', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const bob = await h.register('bob')

  const forbidden = await h.raw('POST', '/admin/accounts/alice/password', {
    body: { newPassword: Buffer.from(PASSWORD2, 'utf8').toString('base64') },
    token: signToken(bob.accountToken!, 'bob'),
    account: 'bob',
  })
  assert.equal(forbidden.status, 403)

  const weak = await h.raw('POST', '/admin/accounts/bob/password', {
    body: { newPassword: Buffer.from('password1234', 'utf8').toString('base64') },
    token: signToken(admin.accountToken!, 'alice'),
    account: 'alice',
  })
  assert.equal(weak.status, 400)
  assert.equal((weak.body as { code: string }).code, 'weak_password')
})

test('M3 停机：缺 token 且非 administrator → 403；带锁文件 token → 202', async (t) => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { startServer } = await import('../src/server/index.js')

  const dir = mkdtempSync(join(tmpdir(), 'tw-stop-'))
  const server = await startServer({ dataDir: dir, port: 0, log: () => {}, rateLimit: false })
  const lock = JSON.parse(readFileSync(join(dir, 'run', 'server.json'), 'utf8')) as { shutdownToken: string }

  // 不带任何凭据
  const denied = await fetch(`http://127.0.0.1:${server.port}/dsh-teamwork/v1/admin/shutdown`, { method: 'POST' })
  assert.equal(denied.status, 401, '既无 token 也无签名头 → 401')

  // 带错误 token
  const wrong = await fetch(`http://127.0.0.1:${server.port}/dsh-teamwork/v1/admin/shutdown`, {
    method: 'POST',
    headers: { 'x-shutdown-token': 'nope' },
  })
  assert.equal(wrong.status, 401)

  // 带锁文件 token
  const ok = await fetch(`http://127.0.0.1:${server.port}/dsh-teamwork/v1/admin/shutdown`, {
    method: 'POST',
    headers: { 'x-shutdown-token': lock.shutdownToken },
  })
  assert.equal(ok.status, 202)
  assert.deepEqual(await ok.json(), { ok: true, stopping: true })

  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

async function setRoleRaw(h: Awaited<ReturnType<typeof bootHarness>>, admin: { accountToken: string | null }, accountId: string, role: string) {
  return h.raw(`PUT`, `/admin/accounts/${accountId}/role`, {
    body: { role },
    token: signToken(admin.accountToken!, 'alice'),
    account: 'alice',
  })
}

