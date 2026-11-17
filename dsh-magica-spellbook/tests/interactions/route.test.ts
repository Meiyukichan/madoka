import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'
import { createInteractionHandler } from '../../src/interactions/route.ts'
import { resetMagicaSessionCache } from '../../src/interactions/ownership.ts'
import { resetQuestions } from '../../src/sessions/questions.ts'
import { resetApprovals } from '../../src/sessions/approval.ts'
import { installQuestionAnswerer } from '../../src/sessions/questions.ts'
import { installApprovalAnswerer } from '../../src/sessions/approval.ts'
import { getSessionStore } from '../../src/sessions/store.ts'
import { resetSessionStores } from '../../src/sessions/store.ts'
import { fakeCtx } from '../helpers/fake.ts'
import { fakeRequest, fakeResponse } from '../helpers/fake.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spellbook-route-'))
  dirs.push(dir)
  return dir
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  resetSessionStores()
  resetQuestions()
  resetApprovals()
  resetMagicaSessionCache()
})

let dir = ''
let ctx = fakeCtx()

function seedSession(sessionId: string): void {
  const store = getSessionStore(fakeCtx({ dshHomePath: (...segments: string[]) => join(dir, ...segments) }), dir)
  assert.ok(store !== null)
  store.put({ sessionId, kind: 'workspace', createdAt: Date.now(), workspaceId: 'w', workspacePath: 'D:/w' })
  resetMagicaSessionCache()
}

function handler() {
  return createInteractionHandler(ctx, { storeDir: dir })
}

/**
 * 发一条请求。
 *
 * `strictMutations` 默认 `true`（安全默认），所以默认把请求扮成**同源浏览器请求**；
 * 需要断言"无 Origin 被拒"时传 `{ origin: false }`。
 */
async function call(
  request: ReturnType<typeof fakeRequest>,
  options: { origin?: string | false } = {},
): Promise<{ status: number; body: any }> {
  const headers = (request as unknown as { headers: Record<string, string> }).headers
  if (options.origin === false) delete headers['origin']
  else if (headers['origin'] === undefined) headers['origin'] = `http://${headers['host'] ?? '127.0.0.1:3081'}`
  const response = fakeResponse()
  await handler()(request as never, response as never)
  return { status: response.status, body: response.body === '' ? null : JSON.parse(response.body) }
}

beforeEach(() => {
  dir = tempDir()
  ctx = fakeCtx()
})

describe('GET /interactions', () => {
  it('列出待决项（只有台账里的会话）', async () => {
    seedSession('s1')
    installQuestionAnswerer(ctx, 's1')
    const held = ctx.invoke(
      'user-questions/request',
      {
        agent: { session: { id: 's1' } },
        questions: [{ id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }],
        wait: { callId: 'c1', timed: true },
      },
      async () => ({ answers: [] }),
    ) as Promise<unknown>
    held.catch(() => {})

    const listed = await call(fakeRequest({ method: 'GET', url: '/magica/interactions', headers: { host: '127.0.0.1:3081' } }))
    assert.equal(listed.status, 200)
    assert.equal(listed.body.ok, true)
    assert.equal(listed.body.value.items.length, 1)
    const item = listed.body.value.items[0]
    assert.equal(item.kind, 'question')
    assert.equal(item.sessionId, 's1')
    assert.equal(item.questions[0].waitCallId, 'c1')
    assert.equal(item.questions[0].waitTimed, true)
  })

  it('非台账会话一律不出现', async () => {
    installQuestionAnswerer(ctx, 'stranger')
    const held = ctx.invoke(
      'user-questions/request',
      { agent: { session: { id: 'stranger' } }, questions: [{ id: 'q1', question: 'x' }] },
      async () => ({ answers: [] }),
    ) as Promise<unknown>
    held.catch(() => {})
    const listed = await call(fakeRequest({ method: 'GET', url: '/magica/interactions', headers: { host: '127.0.0.1:3081' } }))
    assert.deepEqual(listed.body.value.items, [])
  })
})

describe('POST /interactions/question/answer', () => {
  it('正常应答 → answered，且挂住的 Promise 被 resolve', async () => {
    seedSession('s1')
    installQuestionAnswerer(ctx, 's1')
    const held = ctx.invoke(
      'user-questions/request',
      { agent: { session: { id: 's1' } }, questions: [{ id: 'q1', question: 'x' }] },
      async () => ({ answers: [] }),
    ) as Promise<{ answers: unknown[] }>
    const settled = held.catch(() => null)

    const response = await call(
      fakeRequest({
        method: 'POST',
        url: '/magica/interactions/question/answer',
        headers: { host: '127.0.0.1:3081', 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', questionId: '1', answers: [{ id: 'q1', selected: ['A'] }] }),
      }),
    )
    // questionId 用错了 → 404（待决 id 是随机 uuid）
    assert.equal(response.status, 404)

    const listResponse = await call(fakeRequest({ method: 'GET', url: '/magica/interactions', headers: { host: '127.0.0.1:3081' } }))
    const pendingId = listResponse.body.value.items[0].id as string
    const ok = await call(
      fakeRequest({
        method: 'POST',
        url: '/magica/interactions/question/answer',
        headers: { host: '127.0.0.1:3081', 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', questionId: pendingId, answers: [{ id: 'q1', selected: ['A'] }] }),
      }),
    )
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body, { ok: true, value: { result: 'answered' } })
    assert.deepEqual(await settled, { answers: [{ id: 'q1', selected: ['A'] }] })

    // 重复应答 → 404
    const again = await call(
      fakeRequest({
        method: 'POST',
        url: '/magica/interactions/question/answer',
        headers: { host: '127.0.0.1:3081', 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', questionId: pendingId, answers: [{ id: 'q1', selected: ['A'] }] }),
      }),
    )
    assert.equal(again.status, 404)
    assert.match(again.body.error.code, /not_found/)
  })

  it('字段错误先于归属错误（400 而不是 403）', async () => {
    const response = await call(
      fakeRequest({
        method: 'POST',
        url: '/magica/interactions/question/answer',
        headers: { host: '127.0.0.1:3081', 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'nobody', questionId: 'x' }),
      }),
    )
    assert.equal(response.status, 403)

    const missing = await call(
      fakeRequest({
        method: 'POST',
        url: '/magica/interactions/question/answer',
        headers: { host: '127.0.0.1:3081', 'content-type': 'application/json' },
        body: JSON.stringify({ questionId: 'x' }),
      }),
    )
    assert.equal(missing.status, 400)
    assert.match(missing.body.error.message, /sessionId is required/)
  })

  it('会话不在接管表里 → 409 invalid_transition', async () => {
    seedSession('s2')
    const response = await call(
      fakeRequest({
        method: 'POST',
        url: '/magica/interactions/question/answer',
        headers: { host: '127.0.0.1:3081', 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's2', questionId: 'q', answers: [{ id: 'q1', selected: [] }] }),
      }),
    )
    assert.equal(response.status, 409)
    assert.match(response.body.error.code, /invalid_transition/)
  })
})

describe('POST /interactions/approval/answer', () => {
  it('decision 非法 → 400；合法 → answered', async () => {
    seedSession('s3')
    installApprovalAnswerer(ctx, 's3')
    const held = ctx.invoke(
      'approval/request',
      { agent: { session: { id: 's3' } }, toolName: 'bash', callId: 'c9', reason: 'run rm -rf' },
      async () => 'rejected',
    ) as Promise<string>
    const settled = held.catch(() => null)

    const listResponse = await call(fakeRequest({ method: 'GET', url: '/magica/interactions', headers: { host: '127.0.0.1:3081' } }))
    const item = listResponse.body.value.items[0]
    assert.equal(item.kind, 'approval')
    assert.equal(item.toolName, 'bash')
    assert.equal(item.callId, 'c9')

    const bad = await call(
      fakeRequest({
        method: 'POST',
        url: '/magica/interactions/approval/answer',
        headers: { host: '127.0.0.1:3081', 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's3', approvalId: item.id, decision: 'cancelled' }),
      }),
    )
    assert.equal(bad.status, 400)

    const ok = await call(
      fakeRequest({
        method: 'POST',
        url: '/magica/interactions/approval/answer',
        headers: { host: '127.0.0.1:3081', 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's3', approvalId: item.id, decision: 'allowed-once' }),
      }),
    )
    assert.equal(ok.status, 200)
    assert.equal(await settled, 'allowed-once')
  })
})

describe('表级闸门', () => {
  it('未声明方法 → 405', async () => {
    const response = await call(fakeRequest({ method: 'DELETE', url: '/magica/interactions', headers: { host: '127.0.0.1:3081' } }))
    assert.equal(response.status, 405)
  })

  it('跨站 → 403；未命中端点 → 信封 404', async () => {
    const crossSite = await call(
      fakeRequest({ method: 'GET', url: '/magica/interactions', headers: { host: '127.0.0.1:3081', 'sec-fetch-site': 'cross-site' } }),
    )
    assert.equal(crossSite.status, 403)

    const notFound = await call(fakeRequest({ method: 'GET', url: '/旧实现/nope', headers: { host: '127.0.0.1:3081' } }))
    assert.equal(notFound.status, 404)
    assert.equal(notFound.body.error.code, 'not_found')
    assert.match(notFound.body.error.message, /no such interaction endpoint/)
  })

  it('content-type 非 JSON → 415', async () => {
    const response = await call(
      fakeRequest({
        method: 'POST',
        url: '/magica/interactions/question/cancel',
        headers: { host: '127.0.0.1:3081', 'content-type': 'text/plain' },
        body: 'x',
      }),
    )
    assert.equal(response.status, 415)
  })
})

describe('安全默认（真实利用链回归）', () => {
  it('strictMutations 默认开：无 Origin 的 POST 被拒（本机脚本不能零凭证批审批）', async () => {
    seedSession('s-lock')
    installApprovalAnswerer(ctx, 's-lock')
    const held = ctx.invoke(
      'approval/request',
      { agent: { session: { id: 's-lock' } }, toolName: 'bash', callId: 'c1' },
      async () => 'rejected',
    ) as Promise<string>
    held.catch(() => {})

    const listed = await call(fakeRequest({ method: 'GET', url: '/magica/interactions' }))
    const item = listed.body.value.items[0]

    const blocked = await call(
      fakeRequest({
        method: 'POST',
        url: '/magica/interactions/approval/answer',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's-lock', approvalId: item.id, decision: 'allowed-once' }),
      }),
      { origin: false },
    )
    assert.equal(blocked.status, 403, '无 Origin 必须被拒')
    assert.match(blocked.body.error.message, /same-origin request required|cross-origin/)

    // 显式关掉严格模式才放行（老部署的逃生门）
    const lenient = createInteractionHandler(ctx, { storeDir: dir, strictMutations: false })
    const response = fakeResponse()
    const request = fakeRequest({
      method: 'POST',
      url: '/magica/interactions/approval/answer',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's-lock', approvalId: item.id, decision: 'allowed-once' }),
    })
    await lenient(request as never, response as never)
    assert.equal(response.status, 200)
  })

  it('Host 非回环 → 403 untrusted host（DNS rebinding 防护）', async () => {
    const response = await call(
      fakeRequest({ method: 'GET', url: '/magica/interactions', headers: { host: 'evil.example' } }),
    )
    assert.equal(response.status, 403)
    assert.match(response.body.error.message, /untrusted host/)
  })

  it('trustedHosts 可显式放行反向代理域名', async () => {
    const proxied = createInteractionHandler(ctx, { storeDir: dir, trustedHosts: ['magica.internal:8080'] })
    const response = fakeResponse()
    await proxied(
      fakeRequest({
        method: 'GET',
        url: '/magica/interactions',
        headers: { host: 'magica.internal:8080', origin: 'http://magica.internal:8080' },
      }) as never,
      response as never,
    )
    assert.equal(response.status, 200)
  })
})

describe('POST /interactions/question/cancel', () => {
  it('取消 → cancelled，挂住的 Promise 得到空答案，待决表清空', async () => {
    seedSession('s-cancel')
    installQuestionAnswerer(ctx, 's-cancel')
    const held = ctx.invoke(
      'user-questions/request',
      { agent: { session: { id: 's-cancel' } }, questions: [{ id: 'q1', question: 'x' }] },
      async () => ({ answers: [] }),
    ) as Promise<{ answers: unknown[] }>
    const settled = held.catch(() => null)

    const listed = await call(fakeRequest({ method: 'GET', url: '/magica/interactions' }))
    const item = listed.body.value.items.find((entry: { sessionId: string }) => entry.sessionId === 's-cancel')
    assert.ok(item !== undefined, '取消前应当能看到待决项')

    const cancelled = await call(
      fakeRequest({
        method: 'POST',
        url: '/magica/interactions/question/cancel',
        headers: { host: '127.0.0.1:3081', 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's-cancel', questionId: item.id }),
      }),
    )
    assert.equal(cancelled.status, 200)
    assert.deepEqual(cancelled.body, { ok: true, value: { result: 'cancelled' } })
    // 语义铁律（E-051）：取消/失败一律 **reject**，绝不 resolve 一个空答案让模型以为用户答了
    assert.equal(await settled, null, '取消后挂住的 Promise 必须以拒绝收尾')

    const after = await call(fakeRequest({ method: 'GET', url: '/magica/interactions' }))
    assert.equal(
      after.body.value.items.filter((entry: { sessionId: string }) => entry.sessionId === 's-cancel').length,
      0,
      '取消后待决表必须清空',
    )

    // 再取消一次 → 404 not_found
    const again = await call(
      fakeRequest({
        method: 'POST',
        url: '/magica/interactions/question/cancel',
        headers: { host: '127.0.0.1:3081', 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's-cancel', questionId: item.id }),
      }),
    )
    assert.equal(again.status, 404)
    assert.equal(again.body.error.code, 'not_found')
  })

  it('缺 questionId → 400（字段校验先于归属）', async () => {
    const response = await call(
      fakeRequest({
        method: 'POST',
        url: '/magica/interactions/question/cancel',
        headers: { host: '127.0.0.1:3081', 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'nobody' }),
      }),
    )
    assert.equal(response.status, 400)
    assert.match(response.body.error.message, /questionId is required/)
  })
})