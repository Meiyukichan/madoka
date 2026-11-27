/** 新鉴权：/auth/token 交换、headers 缓存/过期/单飞刷新、凭据 v2。 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CastboardAuth,
  CastboardAuthApi,
  CastboardAuthError,
  type CastboardAuthGrant,
} from '../src/sdk/index.js'
import { CredentialStore, type StoredCredential } from '../src/sdk/credentials.js'

const homes: string[] = []
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'teamwork-auth-home-'))
  homes.push(dir)
  return dir
}
after(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true })
})

const SESSION = {
  accountId: 'alice',
  accountToken: 'a'.repeat(64),
  ttlSeconds: 3600,
}

function grant(overrides: Partial<CastboardAuthGrant> = {}): CastboardAuthGrant {
  return {
    accountId: 'alice',
    headers: { authorization: 'Bearer one', cookie: 'sid=abc' },
    expiresAt: Date.now() + 3_600_000,
    displayName: 'Alice',
    globalRole: 'administrator',
    ...overrides,
  }
}

test('headers 使用服务端返回的任意 K-V；有效期内不重复交换', async () => {
  let calls = 0
  const auth = new CastboardAuth({
    home: home(),
    credentials: SESSION,
    authExchange: async () => {
      calls += 1
      return grant()
    },
  })
  assert.deepEqual(await auth.headers(), { authorization: 'Bearer one', cookie: 'sid=abc' })
  assert.deepEqual(await auth.headers(), { authorization: 'Bearer one', cookie: 'sid=abc' })
  assert.equal(calls, 1)
  assert.equal(auth.state, 'authenticated')
  assert.equal(auth.globalRole(), 'administrator')
})

test('过期/401 后重新交换；并发只发一次', async () => {
  let calls = 0
  let release!: (value: CastboardAuthGrant) => void
  const auth = new CastboardAuth({
    home: home(),
    credentials: SESSION,
    authExchange: () => {
      calls += 1
      return new Promise((resolve) => { release = resolve })
    },
  })
  const first = auth.headers()
  const second = auth.headers()
  assert.equal(calls, 1)
  release(grant({ headers: { authorization: 'Bearer fresh' }, expiresAt: Date.now() + 10 }))
  assert.deepEqual(await first, { authorization: 'Bearer fresh' })
  assert.deepEqual(await second, { authorization: 'Bearer fresh' })

  // expiresAt 只有 10ms，30s 保护窗内直接要求重新交换
  const third = auth.headers()
  assert.equal(calls, 2)
  release(grant({ headers: { authorization: 'Bearer next' } }))
  assert.deepEqual(await third, { authorization: 'Bearer next' })
})

test('auth 拒绝 → login_required；headers 清空但账号仍在', async () => {
  const auth = new CastboardAuth({
    home: home(),
    credentials: SESSION,
    authExchange: async () => {
      throw Object.assign(new Error('bad account token'), { status: 401, code: 'invalid_credentials' })
    },
  })
  await assert.rejects(() => auth.headers(), (error: unknown) => error instanceof CastboardAuthError && error.code === 'login_required')
  assert.equal(auth.state, 'login_required')
  assert.equal(auth.accountId, 'alice')
  assert.equal(await auth.headers(), null)
})

test('网络失败 → auth_refresh_failed，不清账号', async () => {
  const auth = new CastboardAuth({
    home: home(),
    credentials: SESSION,
    authExchange: async () => {
      throw Object.assign(new Error('down'), { status: 503 })
    },
  })
  await assert.rejects(() => auth.headers(), (error: unknown) => error instanceof CastboardAuthError && error.code === 'auth_refresh_failed')
  assert.equal(auth.state, 'authenticated')
  assert.equal(auth.accountId, 'alice')
})

test('拒绝保留 header、cookie 与设备信息透传', async () => {
  let seenDevice: unknown
  const auth = new CastboardAuth({
    home: home(),
    credentials: SESSION,
    device: { id: 'device-1', host: '10.0.0.2', port: 3939, os: 'win32' },
    authExchange: async (input) => {
      seenDevice = input.device
      return grant({
        headers: {
          authorization: 'Bearer ok',
          cookie: 'sid=abc',
          'content-type': 'text/plain',
          'bad\nheader': 'x',
        },
      })
    },
  })
  assert.deepEqual(await auth.headers(), { authorization: 'Bearer ok', cookie: 'sid=abc' })
  assert.deepEqual(seenDevice, { id: 'device-1', host: '10.0.0.2', port: 3939, os: 'win32' })
})

test('tokenProvider 只在没有落盘会话时提供一次', async () => {
  let provided = 0
  const auth = new CastboardAuth({
    home: home(),
    tokenProvider: async () => {
      provided += 1
      return SESSION
    },
    authExchange: async () => grant(),
  })
  assert.deepEqual(await auth.headers(), { authorization: 'Bearer one', cookie: 'sid=abc' })
  assert.deepEqual(await auth.headers(), { authorization: 'Bearer one', cookie: 'sid=abc' })
  assert.equal(provided, 1)
})

test('onUnauthorized 进入 login_required，之后不再自动刷新', async () => {
  let calls = 0
  const auth = new CastboardAuth({
    home: home(),
    credentials: SESSION,
    authExchange: async () => {
      calls += 1
      return grant()
    },
  })
  await auth.headers()
  auth.onUnauthorized()
  assert.equal(auth.state, 'login_required')
  assert.equal(await auth.headers(), null)
  assert.equal(calls, 1)
})

test('logout 即使服务端失败也清本地凭据', async () => {
  const dir = home()
  const auth = new CastboardAuth({
    home: dir,
    credentials: SESSION,
    authExchange: async () => grant(),
  })
  await auth.headers()
  assert.equal(existsSync(join(dir, '.credentials.json')), true)

  const transport = {
    call: async () => ({
      ok: false as const,
      status: 503,
      code: 'http_error' as const,
      reason: 'server down',
    }),
  }
  const api = new CastboardAuthApi(transport as never, auth)
  const result = await api.logout()
  assert.equal(result.ok, false)
  assert.equal(existsSync(join(dir, '.credentials.json')), false)
})

test('凭据 v2 保存 auth headers；v1 自动迁移为 auth=null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamwork-auth-'))
  try {
    const store = new CredentialStore(dir)
    const v2: StoredCredential = {
      v: 2,
      server: 'http://127.0.0.1:3939/dsh-teamwork/v1',
      accountId: 'alice',
      displayName: 'Alice',
      accountToken: 'a'.repeat(64),
      ttlSeconds: 3600,
      auth: { headers: { authorization: 'Bearer one' }, expiresAt: 123, obtainedAt: '2026-01-01T00:00:00.000Z' },
      savedAt: '2026-01-01T00:00:00.000Z',
    }
    store.save(v2)
    assert.deepEqual(store.load(), v2)

    const legacy = {
      v: 1,
      server: v2.server,
      accountId: 'bob',
      displayName: null,
      accountToken: 'b'.repeat(64),
      ttlSeconds: 60,
      savedAt: v2.savedAt,
    } as unknown as StoredCredential
    store.save(legacy)
    const migrated = store.load()
    assert.equal(migrated?.v, 2)
    assert.equal(migrated?.accountId, 'bob')
    assert.equal(migrated?.auth, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
