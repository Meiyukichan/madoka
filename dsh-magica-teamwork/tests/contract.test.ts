/**
 * 契约测试：不看业务，只验证「47 个端点 × 鉴权级别 × 错误体形状」是否与文档一致。
 *
 * 这是防"接口忘了挂鉴权"的机械护栏。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootHarness, PASSWORD } from './helpers.js'
import { ENDPOINTS } from '../src/server/context.js'

/** 文档声明的鉴权级别（api-design §0.2.1） */
const PUBLIC = new Set(['POST /auth/register', 'POST /auth/login', 'GET /health', 'GET /version'])
const ADMIN = new Set([
  'GET /auth/accounts',
  'PUT /issue-sources/:id',
  'DELETE /issue-sources/:id',
  'DELETE /files/:fileId',
  'PUT /admin/accounts/:accountId/role',
  'POST /admin/accounts/:accountId/password',
  'GET /admin/accounts',
])
const LOCAL_OR_ADMIN = new Set(['POST /admin/shutdown'])

test('端点清单：49 个、无重复、分级完整', () => {
  assert.equal(ENDPOINTS.length, 49)
  assert.equal(new Set(ENDPOINTS).size, 49, '不能有重复端点')
  const classified = new Set([...PUBLIC, ...ADMIN, ...LOCAL_OR_ADMIN])
  const signed = ENDPOINTS.filter((e) => !classified.has(e))
  assert.equal(PUBLIC.size, 4)
  assert.equal(ADMIN.size, 7)
  assert.equal(LOCAL_OR_ADMIN.size, 1)
  assert.equal(signed.length, 37, '其余 37 个应该只依赖签名头')
})

test('所有需要鉴权的端点：不带签名头一律 401', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())

  const failures: string[] = []
  for (const endpoint of ENDPOINTS) {
    if (PUBLIC.has(endpoint)) continue
    const [method, rawPath] = endpoint.split(' ') as [string, string]
    const path = rawPath
      .replace(':id', '1')
      .replace(':accountId', 'alice')
      .replace(':issueId', 'x')
      .replace(':fileId', '3f2504e0-4f89-41d3-9a0c-0305e82c3301')
    const hasBody = method === 'POST' || method === 'PUT'
    const res = await fetch(`${h.base}${path}`, {
      method,
      ...(hasBody ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
    })
    if (res.status !== 401) failures.push(`${endpoint} → ${res.status}`)
  }
  assert.deepEqual(failures, [], '这些端点没有正确要求鉴权头')
})

test('公开端点：不带签名头也能访问', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  assert.equal((await fetch(`${h.base}/health`)).status, 200)
  assert.equal((await fetch(`${h.base}/version`)).status, 200)
  // register / login 需要合法 body，只验证"不是 401"
  const reg = await fetch(`${h.base}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: 'alice', password: Buffer.from(PASSWORD, 'utf8').toString('base64') }),
  })
  assert.equal(reg.status, 201)
  const login = await fetch(`${h.base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: 'alice', password: Buffer.from(PASSWORD, 'utf8').toString('base64') }),
  })
  assert.equal(login.status, 200)
})

test('错误体形状：所有错误都是 { code, message, requestId }', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())

  const cases: Array<{ path: string; method: string; body?: unknown; expect: number }> = [
    { path: '/nope', method: 'GET', expect: 404 },
    { path: '/auth/me', method: 'GET', expect: 401 },
  ]
  for (const c of cases) {
    const res = await fetch(`${h.base}${c.path}`, {
      method: c.method,
      ...(c.body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(c.body) } : {}),
    })
    assert.equal(res.status, c.expect)
    const body = (await res.json()) as Record<string, unknown>
    assert.ok(typeof body.code === 'string' && body.code.length > 0, `${c.path} 缺 code`)
    assert.ok(typeof body.message === 'string', `${c.path} 缺 message`)
    assert.ok(typeof body.requestId === 'string', `${c.path} 缺 requestId`)
  }
})

test('管理端点：普通用户一律 403', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const bob = await h.register('bob')
  void admin

  const { signToken } = await import('./helpers.js')
  const token = signToken(bob.accountToken!, 'bob')
  const attempts: Array<[string, string, unknown?]> = [
    ['GET', '/auth/accounts?accountId=alice'],
    ['GET', '/admin/accounts'],
    ['PUT', '/admin/accounts/bob/role', { role: 'leader' }],
    ['POST', '/admin/accounts/bob/password', { newPassword: Buffer.from('another good passphrase', 'utf8').toString('base64') }],
    ['PUT', '/issue-sources/1', { description: 'x' }],
    ['DELETE', '/issue-sources/1'],
    ['DELETE', '/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
  ]
  const failures: string[] = []
  for (const [method, path, body] of attempts) {
    const res = await fetch(`${h.base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'dsh-teamwork-token': token, 'dsh-teamwork-account': 'bob' },
      ...(body !== undefined && method !== 'DELETE' ? { body: JSON.stringify(body) } : {}),
    })
    if (res.status !== 403) failures.push(`${method} ${path} → ${res.status}`)
  }
  assert.deepEqual(failures, [])
})

test('错误体：未知路由 404 且带 code', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const res = await h.raw('GET', '/definitely-not-a-route')
  assert.equal(res.status, 404)
  assert.equal((res.body as { code: string }).code, 'not_found')
})

test('时间格式：所有时间字段都是 ISO-8601 UTC 毫秒', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  const p = await alice.projects.create({ name: 'p' })
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
  for (const v of [p.createdAt, p.updatedAt]) assert.match(v, iso)
  const me = await alice.me()
  assert.match(me.account.createdAt, iso)
  assert.match(me.account.updatedAt, iso)
})

test('分页结构：{ total, pageNum, pageSize, items }', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  const res = await alice.projects.list({ pageNum: 2, pageSize: 5 })
  assert.deepEqual(Object.keys(res).sort(), ['items', 'pageNum', 'pageSize', 'total'])
  assert.equal(res.pageNum, 2)
  assert.equal(res.pageSize, 5)
})
