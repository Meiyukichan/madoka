import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  HttpRouteError,
  createJsonRouter,
  isTrustedInbound,
  queryOf,
  sendResponse,
  type JsonRouterRoute,
} from '../../src/core/router.ts'
import { fakeRequest, fakeResponse } from '../helpers/fake.ts'

function routes(hits: string[]): JsonRouterRoute[] {
  return [
    {
      method: 'GET',
      path: '/items',
      handler: ({ response }) => {
        hits.push('list')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
      },
    },
    {
      method: 'GET',
      path: '/items/:id',
      handler: ({ params, response }) => {
        hits.push(`item:${params['id'] ?? ''}`)
        response.end('{}')
      },
    },
    {
      method: 'POST',
      path: '/items',
      handler: ({ body, response }) => {
        hits.push(`create:${String(body['name'])}`)
        response.end('{}')
      },
    },
  ]
}

describe('createJsonRouter', () => {
  it('方法门：表里没有的方法 → 405 + allow', async () => {
    const response = fakeResponse()
    await createJsonRouter({ prefix: '/api', routes: routes([]) })(
      fakeRequest({ method: 'DELETE', url: '/api/items' }),
      response,
    )
    assert.equal(response.status, 405)
    assert.equal(response.headers['allow'], 'GET, POST')
  })

  it('未命中的 POST 仍然先过围栏（跨站 → 403 而不是 404）', async () => {
    const response = fakeResponse()
    await createJsonRouter({ prefix: '/api', routes: routes([]) })(
      fakeRequest({
        method: 'POST',
        url: '/api/nope',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        body: '{}',
      }),
      response,
    )
    assert.equal(response.status, 403)
  })

  it('browser 档放行不带 Origin 的请求，strict 档拒绝', async () => {
    const browser = fakeResponse()
    await createJsonRouter({ prefix: '/api', routes: routes([]), trust: 'browser' })(
      fakeRequest({ method: 'GET', url: '/api/items' }),
      browser,
    )
    assert.equal(browser.status, 200)

    const strict = fakeResponse()
    await createJsonRouter({ prefix: '/api', routes: routes([]) })(
      fakeRequest({ method: 'GET', url: '/api/items' }),
      strict,
    )
    assert.equal(strict.status, 403)
  })

  it('content-type 非 JSON → 415', async () => {
    const response = fakeResponse()
    await createJsonRouter({ prefix: '/api', routes: routes([]), trust: 'browser' })(
      fakeRequest({ method: 'POST', url: '/api/items', headers: { 'content-type': 'text/plain' }, body: '{}' }),
      response,
    )
    assert.equal(response.status, 415)
    assert.match(response.body, /content-type must be application\/json/)
  })

  it('声明长度超限 → 413', async () => {
    const response = fakeResponse()
    await createJsonRouter({ prefix: '/api', routes: routes([]), trust: 'browser', maxBytes: 8 })(
      fakeRequest({
        method: 'POST',
        url: '/api/items',
        headers: { 'content-type': 'application/json', 'content-length': '999' },
        body: '{}',
      }),
      response,
    )
    assert.equal(response.status, 413)
  })

  it('非对象 JSON → 400 body is not a JSON object', async () => {
    const response = fakeResponse()
    await createJsonRouter({ prefix: '/api', routes: routes([]), trust: 'browser' })(
      fakeRequest({
        method: 'POST',
        url: '/api/items',
        headers: { 'content-type': 'application/json' },
        body: '[1,2]',
      }),
      response,
    )
    assert.equal(response.status, 400)
    assert.match(response.body, /body is not a JSON object/)
  })

  it('路径参数匹配与尾斜杠容忍', async () => {
    const hits: string[] = []
    await createJsonRouter({ prefix: '/api', routes: routes(hits), trust: 'browser' })(
      fakeRequest({ method: 'GET', url: '/api/items/abc' }),
      fakeResponse(),
    )
    // 尾斜杠归一：/api/items// 落回 /items（不是 :id 的空参数）
    await createJsonRouter({ prefix: '/api', routes: routes(hits), trust: 'browser' })(
      fakeRequest({ method: 'GET', url: '/api/items//' }),
      fakeResponse(),
    )
    assert.deepEqual(hits, ['item:abc', 'list'])
  })

  it('带 query / hash 的 GET 仍按 pathname 匹配（真机回归）', async () => {
    const hits: string[] = []
    const response = fakeResponse()
    await createJsonRouter({
      prefix: '/e2e',
      trust: 'browser',
      routes: [
        {
          method: 'GET',
          path: '/state',
          handler: ({ query, response: res }) => {
            hits.push(`state:${String(query('id'))}`)
            res.end('{}')
          },
        },
      ],
    })(fakeRequest({ method: 'GET', url: '/e2e/state?id=abc%2Fdef&x=1' }), response)
    assert.deepEqual(hits, ['state:abc/def'])
    assert.equal(response.status, 0)

    const withHash = fakeResponse()
    await createJsonRouter({
      prefix: '/e2e',
      trust: 'browser',
      routes: [
        {
          method: 'GET',
          path: '/state',
          handler: ({ response: res }) => {
            res.end('{}')
          },
        },
      ],
    })(fakeRequest({ method: 'GET', url: '/e2e/state#frag' }), withHash)
    assert.equal(withHash.body, '{}')
  })

  it('前缀碰撞不匹配（/apix 不算 /api 下）', async () => {
    const response = fakeResponse()
    await createJsonRouter({ prefix: '/api', routes: routes([]), trust: 'browser', onNotFound: (res) => {
      res.writeHead(404)
      res.end('nf')
    } })(fakeRequest({ method: 'GET', url: '/apix/items' }), response)
    assert.equal(response.status, 404)
    assert.equal(response.body, 'nf')
  })

  it('HttpRouteError 用自带 status/code，其它错误 500 internal', async () => {
    const response = fakeResponse()
    await createJsonRouter({
      prefix: '/api',
      trust: 'browser',
      routes: [
        {
          method: 'GET',
          path: '/boom',
          handler: () => {
            throw new HttpRouteError(409, 'invalid_transition', 'nope')
          },
        },
      ],
    })(fakeRequest({ method: 'GET', url: '/api/boom' }), response)
    assert.equal(response.status, 409)
    assert.match(response.body, /invalid_transition/)

    const internal = fakeResponse()
    await createJsonRouter({
      prefix: '/api',
      trust: 'browser',
      routes: [
        {
          method: 'GET',
          path: '/boom',
          handler: () => {
            throw new Error('kaboom')
          },
        },
      ],
    })(fakeRequest({ method: 'GET', url: '/api/boom' }), internal)
    assert.equal(internal.status, 500)
    assert.match(internal.body, /internal/)
  })

  it('已发头后 sendResponse 静默返回（headersSent 守卫）', () => {
    const response = fakeResponse()
    response.writeHead(200)
    sendResponse(response, 500, 'ignored')
    assert.equal(response.status, 200)
    assert.equal(response.body, '')
  })
})

describe('queryOf / isTrustedInbound', () => {
  it('queryOf 处理空值、重复键与畸形编码', () => {
    assert.equal(queryOf(fakeRequest({ url: '/x?flag' }), 'flag'), '')
    assert.equal(queryOf(fakeRequest({ url: '/x?a=1&a=2' }), 'a'), '1')
    assert.equal(queryOf(fakeRequest({ url: '/x?bad=%E0%A4%A&ok=1' }), 'ok'), '1')
    assert.equal(queryOf(fakeRequest({ url: '/x' }), 'a'), null)
  })

  it('queryOf 跳过解码失败的 pair，取下一条能解码的（C-120 回归）', () => {
    assert.equal(queryOf(fakeRequest({ url: '/x?a=%E0%A4&a=2' }), 'a'), '2')
    // 全部解码失败 → null（绝不把乱码当值返回）
    assert.equal(queryOf(fakeRequest({ url: '/x?a=%E0%A4' }), 'a'), null)
  })

  it('isTrustedInbound 四档', () => {
    assert.equal(isTrustedInbound(fakeRequest({ headers: { 'sec-fetch-site': 'cross-site' } }), 'browser'), false)
    assert.equal(isTrustedInbound(fakeRequest({ headers: {} }), 'browser'), true)
    assert.equal(isTrustedInbound(fakeRequest({ headers: {} }), 'strict'), false)
    assert.equal(
      isTrustedInbound(fakeRequest({ headers: { origin: 'http://localhost:3080', host: 'localhost:3080' } }), 'strict'),
      true,
    )
  })
})

describe('query 与路径参数的 + 语义（diff C20）', () => {
  it('query value 里 + 是空格，路径参数里 + 是加号本身', async () => {
    const seen: Array<{ query: string | null; param: string | undefined }> = []
    const router = createJsonRouter({
      prefix: '/api',
      // 默认 strict 档要求同源 Origin；这条只测解码，用 browser 档放行裸 GET
      trust: 'browser',
      routes: [
        {
          method: 'GET',
          path: '/a/:name',
          handler: ({ request, params, response }) => {
            seen.push({ query: queryOf(request, 'q'), param: params['name'] as string | undefined })
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end('{}')
          },
        } as JsonRouterRoute,
      ],
    })
    await router(fakeRequest({ method: 'GET', url: '/api/a/x+y?q=b+c' }), fakeResponse())
    assert.deepEqual(seen, [{ query: 'b c', param: 'x+y' }])
  })
})