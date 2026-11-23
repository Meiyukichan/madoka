/** 账号模块：注册 / 登录 / 鉴权 / 改密 / 账号管控 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootHarness, isCode, PASSWORD, PASSWORD2, signToken } from './helpers.js'
import { TeamworkClient, TeamworkError } from '../src/index.js'

test('注册：首个账号自动 administrator，后续都是 user', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())

  const first = await h.root.register({ accountId: 'alice', password: PASSWORD, displayName: 'Alice' })
  assert.equal(first.account.globalRole, 'administrator')
  assert.equal(first.account.displayName, 'Alice')
  assert.equal(first.accountToken.length, 64)
  assert.match(first.accountToken, /^[0-9a-f]{64}$/)
  assert.equal(first.ttlSeconds, 259_200)

  const second = await h.client().register({ accountId: 'bob', password: PASSWORD })
  assert.equal(second.account.globalRole, 'user')
  assert.equal(second.account.displayName, null) // 未传 → null
})

test('注册校验：accountId 格式 / 密码策略 / 重复账号 / base64', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  await h.register('alice')

  await assert.rejects(() => h.client().register({ accountId: 'ab', password: PASSWORD }), isCode('invalid_account_id'))
  await assert.rejects(() => h.client().register({ accountId: 'has space', password: PASSWORD }), isCode('invalid_account_id'))
  await assert.rejects(() => h.client().register({ accountId: 'has:colon', password: PASSWORD }), isCode('invalid_account_id'))
  await assert.rejects(() => h.client().register({ accountId: 'short', password: 'short' }), isCode('invalid_password'))
  await assert.rejects(() => h.client().register({ accountId: 'spacepw', password: ' has surrounding ' }), isCode('invalid_password'))
  await assert.rejects(() => h.client().register({ accountId: 'weakpw', password: 'password1234' }), isCode('weak_password'))
  await assert.rejects(() => h.client().register({ accountId: 'alice', password: PASSWORD }), isCode('account_exists'))

  // 密码不是合法 base64
  const bad = await h.raw('POST', '/auth/register', { body: { accountId: 'base64x', password: '不是 base64' } })
  assert.equal(bad.status, 400)
  assert.equal((bad.body as { code: string }).code, 'invalid_password_encoding')
})

test('登录：成功拿到同一个 accountToken；失败与不存在同码', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const reg = await h.register('alice')

  const again = await h.client().login({ accountId: 'alice', password: PASSWORD })
  assert.equal(again.accountToken, reg.accountToken, '同一账号的 accountToken 必须稳定')

  await assert.rejects(() => h.client().login({ accountId: 'alice', password: PASSWORD2 }), isCode('invalid_credentials'))
  await assert.rejects(() => h.client().login({ accountId: 'ghost', password: PASSWORD }), isCode('invalid_credentials'))
})

test('登录失败延迟 ≥ 300ms（抑制爆破）', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  await h.register('alice')
  const started = Date.now()
  await assert.rejects(() => h.client().login({ accountId: 'alice', password: PASSWORD2 }))
  assert.ok(Date.now() - started >= 280, '失败响应必须被延迟')
})

test('鉴权：缺头 / 篡改 / 过期 / exp 超上限 / 账号不一致 / 未知账号', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const reg = await h.register('alice')
  const token = reg.accountToken
  const path = '/auth/me'

  assert.equal((await h.raw('GET', path)).status, 401)
  assert.equal((await h.raw('GET', path, { token: 'a.b.c', account: 'alice' })).status, 401)

  const good = signToken(token, 'alice')
  assert.equal((await h.raw('GET', path, { token: good, account: 'alice' })).status, 200)

  // 过期
  const expired = signToken(token, 'alice', { exp: Date.now() - 1000 })
  const r1 = await h.raw('GET', path, { token: expired, account: 'alice' })
  assert.equal((r1.body as { code: string }).code, 'token_expired')

  // exp 超上限（3 天 + 60s 之外）
  const tooLong = signToken(token, 'alice', { exp: Date.now() + 4 * 86400_000 })
  const r2 = await h.raw('GET', path, { token: tooLong, account: 'alice' })
  assert.equal((r2.body as { code: string }).code, 'token_exp_too_long')

  // 头与 token 内的账号不一致：用 bob 的密钥签一个 a=alice 的 token，头却报 bob
  const bobReg = await h.client().register({ accountId: 'bob', password: PASSWORD })
  const forged = signToken(bobReg.accountToken, 'alice')
  const r3 = await h.raw('GET', path, { token: forged, account: 'bob' })
  assert.equal((r3.body as { code: string }).code, 'token_account_mismatch')

  // 未知账号：同样 401，不泄露存在性
  const r4 = await h.raw('GET', path, { token: good, account: 'nobody' })
  assert.equal(r4.status, 401)
})

test('改密码：旧 token 立即失效，返回新密钥', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  const before = alice.accountToken!

  const res = await alice.changePassword({ oldPassword: PASSWORD, newPassword: PASSWORD2 })
  assert.notEqual(res.accountToken, before)
  assert.equal(await alice.me().then((m) => m.account.accountId), 'alice')

  // 旧 token 不能再签出有效请求
  const oldSigned = signToken(before, 'alice')
  const r = await h.raw('GET', '/auth/me', { token: oldSigned, account: 'alice' })
  assert.equal(r.status, 401)

  // 旧密码不能登录，新密码可以
  await assert.rejects(() => h.client().login({ accountId: 'alice', password: PASSWORD }), isCode('invalid_credentials'))
  await h.client().login({ accountId: 'alice', password: PASSWORD2 })
})

test('改密码：新旧相同 / 旧密码错', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  await assert.rejects(() => alice.changePassword({ oldPassword: PASSWORD, newPassword: PASSWORD }), isCode('same_password'))
  await assert.rejects(() => alice.changePassword({ oldPassword: PASSWORD2, newPassword: 'brand new passphrase' }), isCode('invalid_credentials'))
})

test('登出：204；allDevices 不支持', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  const ok = await h.raw('POST', '/auth/logout', { token: signToken(alice.accountToken!, 'alice'), account: 'alice' })
  assert.equal(ok.status, 204)

  const notSupported = await h.raw('POST', '/auth/logout', {
    body: { allDevices: true },
    token: signToken(alice.accountToken!, 'alice'),
    account: 'alice',
  })
  assert.equal(notSupported.status, 400)
  assert.equal((notSupported.body as { code: string }).code, 'not_supported')
})

test('严格请求体：未声明字段 → unknown_field', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const res = await h.raw('POST', '/auth/register', { body: { accountId: 'alice', password: PASSWORD, role: 'administrator' } })
  assert.equal(res.status, 400)
  assert.equal((res.body as { code: string }).code, 'unknown_field')
  assert.equal((res.body as { details: { field: string } }).details.field, 'role')
})

test('A6 查账号：只有 administrator 能调', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const bob = await h.register('bob')

  const hit = await admin.lookupAccount('bob')
  assert.equal(hit.exists, true)
  assert.equal(hit.account?.globalRole, 'user')
  const miss = await admin.lookupAccount('ghost')
  assert.equal(miss.exists, false)
  assert.equal(miss.account, null)

  await assert.rejects(() => bob.lookupAccount('alice'), isCode('forbidden'))
})

test('注册闸门：closed 模式拒绝注册', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { startServer } = await import('../src/server/index.js')

  const dir = mkdtempSync(join(tmpdir(), 'tw-gate-'))
  const server = await startServer({
    dataDir: dir,
    port: 0,
    log: () => {},
    rateLimit: false,
    argv: ['--registration', 'closed'],
  })
  t.after(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const c = new TeamworkClient({ host: `http://127.0.0.1:${server.port}`, persist: false })
  await assert.rejects(() => c.register({ accountId: 'noEntry', password: PASSWORD }), isCode('registration_closed'))
})

test('SDK：凭据加密落盘 + 重新载入 + 重置', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const home = `${h.dir}/home`
  const { mkdirSync } = await import('node:fs')
  mkdirSync(home, { recursive: true })

  const c1 = new TeamworkClient({ host: h.host, home })
  await c1.register({ accountId: 'alice', password: PASSWORD })

  const { readFileSync, existsSync } = await import('node:fs')
  const keyPath = `${home}/.credentials.key`
  const filePath = `${home}/.credentials.json`
  assert.ok(existsSync(keyPath), '必须生成密钥文件')
  assert.ok(existsSync(filePath), '必须生成凭据文件')
  const raw = readFileSync(filePath, 'utf8')
  assert.ok(!raw.includes(PASSWORD), '凭据文件不能出现明文密码')
  assert.ok(!raw.includes(c1.accountToken!), '凭据文件不能出现明文 accountToken')
  const envelope = JSON.parse(raw) as Record<string, unknown>
  assert.equal(envelope.alg, 'aes-256-gcm')
  assert.ok(typeof envelope.iv === 'string' && typeof envelope.tag === 'string' && typeof envelope.ct === 'string')

  // 新实例可复用凭据直接发请求
  const c2 = new TeamworkClient({ host: h.host, home })
  assert.equal(c2.authState, 'authenticated')
  assert.equal((await c2.me()).account.accountId, 'alice')

  // 重置后变回 anonymous
  c2.resetCredentials(true)
  assert.equal(c2.authState, 'anonymous')
  assert.ok(!existsSync(filePath))

  void TeamworkError
})
