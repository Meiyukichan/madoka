/**
 * 请求管线（传输层）：能力闸 / 鉴权级别 / 现签 / 401 四分支 / 重试 / 并发闸 / 归一。
 *
 * 全部用注入的 mock fetch，不碰真服务。
 * 对应设计文档 §16.2。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CastboardAuthError,
  CastboardTransport,
  type CastboardAuthLike,
  type CastboardFetch,
  type CastboardGlobalRole,
} from '../src/sdk/index.js'

const BASE = 'http://127.0.0.1:3939/dsh-teamwork/v1'

interface RecordedCall {
  url: string
  init: { method?: string; headers?: Record<string, string>; body?: unknown }
}

function recorder(handler: (call: RecordedCall) => Response | Promise<Response>): {
  calls: RecordedCall[]
  fetchImpl: CastboardFetch
} {
  const calls: RecordedCall[] = []
  const fetchImpl: CastboardFetch = async (url, init) => {
    const call: RecordedCall = {
      url,
      init: { method: init?.method, headers: init?.headers, body: init?.body },
    }
    calls.push(call)
    return handler(call)
  }
  return { calls, fetchImpl }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

class FakeAuth implements CastboardAuthLike {
  signed = true
  role: CastboardGlobalRole | undefined = 'administrator'
  refreshed = 0
  refreshError: Error | null = null
  cleared = 0
  private counter = 0

  async headers(): Promise<Record<string, string> | null> {
    if (!this.signed) return null
    this.counter += 1
    return { 'x-auth-token': `token-${this.counter}`, cookie: 'sid=abc' }
  }

  async refresh(): Promise<void> {
    this.refreshed += 1
    if (this.refreshError !== null) throw this.refreshError
  }

  globalRole(): CastboardGlobalRole | undefined {
    return this.role
  }

  onUnauthorized(): void {
    this.cleared += 1
    this.signed = false
  }
}

function makeTransport(
  fetchImpl: CastboardFetch,
  extra: Partial<ConstructorParameters<typeof CastboardTransport>[0]> = {},
): CastboardTransport {
  return new CastboardTransport({ baseUrl: BASE, fetchImpl, ...extra })
}

test('public 端点不带鉴权头；signed 端点带双头', async () => {
  const { calls, fetchImpl } = recorder(() => json({ ok: true }))
  const transport = makeTransport(fetchImpl, { auth: new FakeAuth() })

  await transport.call('version')
  await transport.call('projectList')

  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.init.headers?.['x-auth-token'], undefined)
  assert.equal(calls[1]!.init.headers?.['x-auth-token'], 'token-1')
  assert.equal(calls[1]!.init.headers?.['cookie'], 'sid=abc')
})

test('signed 端点无会话 → 401 login_required，且零请求', async () => {
  const { calls, fetchImpl } = recorder(() => json({ ok: true }))
  const transport = makeTransport(fetchImpl)

  const result = await transport.call('projectList')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.status, 401)
  assert.equal(result.code, 'login_required')
  assert.equal(calls.length, 0)
})

test('admin 端点：已知角色不是 administrator → 403 forbidden，零请求', async () => {
  const auth = new FakeAuth()
  auth.role = 'user'
  const { calls, fetchImpl } = recorder(() => json({ ok: true }))
  const transport = makeTransport(fetchImpl, { auth })

  const result = await transport.call('adminAccounts')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.status, 403)
  assert.equal(result.code, 'forbidden')
  assert.equal(calls.length, 0)
})

test('401 → 刷新 headers 一次并重试；headers 名字由 auth 决定', async () => {
  let attempt = 0
  const { calls, fetchImpl } = recorder(() => {
    attempt += 1
    return attempt === 1 ? json({ code: 'token_expired', message: 'token 已过期' }, 401) : json([])
  })
  const auth = new FakeAuth()
  const transport = makeTransport(fetchImpl, { auth })

  const result = await transport.call('projectList')
  assert.equal(result.ok, true)
  assert.equal(calls.length, 2)
  assert.equal(auth.refreshed, 1)
  assert.notEqual(
    calls[0]!.init.headers!['x-auth-token'],
    calls[1]!.init.headers!['x-auth-token'],
  )
})

test('刷新认证失败 → auth_refresh_failed，不无限重试', async () => {
  const { calls, fetchImpl } = recorder(() => json({ code: 'token_expired' }, 401))
  const auth = new FakeAuth()
  auth.refreshError = new CastboardAuthError('auth_refresh_failed', 'auth endpoint down', 503)
  const transport = makeTransport(fetchImpl, { auth })

  const result = await transport.call('projectList')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'auth_refresh_failed')
  assert.equal(auth.refreshed, 1)
  assert.equal(calls.length, 1)
})

test('重新认证后仍 401 → login_required 且清 headers', async () => {
  const { calls, fetchImpl } = recorder(() => json({ code: 'unauthorized', message: '仍被拒绝' }, 401))
  const auth = new FakeAuth()
  const transport = makeTransport(fetchImpl, { auth })

  const result = await transport.call('projectList')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'login_required')
  assert.equal(auth.cleared, 1)
  assert.equal(auth.refreshed, 1)
  assert.equal(calls.length, 2)
})

test('网络错误只对幂等请求重试；非幂等 POST 只打一次', async () => {
  const boom = (() => {
    throw new Error('boom')
  }) as never
  const { calls, fetchImpl } = recorder(() => {
    throw new Error('boom')
  })
  void boom
  const transport = makeTransport(fetchImpl, { auth: new FakeAuth(), retries: 2 })

  const get = await transport.call('projectList')
  assert.equal(get.ok, false)
  if (!get.ok) assert.equal(get.code, 'network_error')
  assert.equal(calls.length, 3, 'GET 应当 1 + 2 次重试')

  calls.length = 0
  const post = await transport.raw('/files', { method: 'POST', body: 'x', idempotent: false })
  assert.equal(post.ok, false)
  assert.equal(calls.length, 1, '非幂等 POST 不重试')
})

test('并发闸：10 个并发请求同时在飞的不超过 4', async () => {
  let inflight = 0
  let peak = 0
  const { fetchImpl } = recorder(async () => {
    inflight += 1
    peak = Math.max(peak, inflight)
    await new Promise((resolve) => setTimeout(resolve, 10))
    inflight -= 1
    return json([])
  })
  const transport = makeTransport(fetchImpl, { auth: new FakeAuth() })

  await Promise.all(Array.from({ length: 10 }, () => transport.call('projectList')))
  assert.equal(peak, 4)
})

test('204 → data 为 undefined；非 JSON 2xx → data 是原文', async () => {
  const responses = [new Response(null, { status: 204 }), new Response('ok', { status: 200 })]
  let index = 0
  const { fetchImpl } = recorder(() => responses[index++]!)
  const transport = makeTransport(fetchImpl, { auth: new FakeAuth() })

  const empty = await transport.request<undefined>('/issues/x', { method: 'DELETE' })
  assert.equal(empty.ok, true)
  if (empty.ok) assert.equal(empty.data, undefined)

  const text = await transport.request<string>('/health', { auth: 'public' })
  assert.equal(text.ok, true)
  if (text.ok) assert.equal(text.data, 'ok')
})

test('能力闸：/version 没声明的端点 → unsupported，零请求', async () => {
  const { calls, fetchImpl } = recorder(() => json({}))
  const transport = makeTransport(fetchImpl, { auth: new FakeAuth() })
  transport.setCapabilities(['GET /projects/mine'])

  const ok = await transport.call('projectList')
  assert.equal(ok.ok, true)

  const denied = await transport.call('issueGet', { issueId: 'abc' })
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.equal(denied.code, 'unsupported')
  assert.equal(calls.length, 1)
})

test('路径占位符没替换完 → internal_error（不让字面量打到服务端）', async () => {
  const { calls, fetchImpl } = recorder(() => json({}))
  const transport = makeTransport(fetchImpl, { auth: new FakeAuth() })

  const result = await transport.call('issueGet')
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'internal_error')
  assert.equal(calls.length, 0)
})

test('非 2xx 的错误体归一：code/reason/body 都带上，body 截断 2KB', async () => {
  const longMessage = 'x'.repeat(50)
  const { fetchImpl } = recorder(() =>
    new Response(JSON.stringify({ code: 'issue_not_found', message: longMessage, padding: 'y'.repeat(4000) }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }),
  )
  const transport = makeTransport(fetchImpl, { auth: new FakeAuth() })

  const result = await transport.call('issueGet', { issueId: 'abc' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.status, 404)
  assert.equal(result.code, 'issue_not_found')
  assert.equal(result.reason, longMessage)
  assert.ok((result.body ?? '').length <= 2049)
})

test('issueId 在路径里被 encodeURIComponent', async () => {
  const { calls, fetchImpl } = recorder(() => json({}))
  const transport = makeTransport(fetchImpl, { auth: new FakeAuth() })
  await transport.call('issueGet', { issueId: 'a b/c' })
  assert.ok(calls[0]!.url.includes('/issues/a%20b%2Fc'), calls[0]!.url)
})
