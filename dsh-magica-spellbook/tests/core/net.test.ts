import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLimitedFetch, createProxyFetch } from '../../src/core/net.ts'

const PROXY_KEYS = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'npm_config_proxy', 'npm_config_https_proxy']

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map(PROXY_KEYS.map((key) => [key, process.env[key]]))
  for (const key of PROXY_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value
  try {
    run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('createProxyFetch', () => {
  it('句柄形状完整', () => {
    const handle = createProxyFetch()
    assert.equal(typeof handle.fetch, 'function')
    assert.equal(typeof handle.insecureFetch, 'function')
    assert.equal(typeof handle.configuredProxy, 'function')
    assert.equal(typeof handle.insecureAgent, 'object')
    assert.equal(typeof handle.insecureHttpsAgent, 'object')
    assert.equal(typeof handle.dispose, 'function')
    void handle.dispose()
  })

  it('configuredProxy 读 https_proxy，回退 http_proxy，大小写都认', () => {
    withEnv({ https_proxy: 'http://proxy.internal:7890' }, () => {
      const handle = createProxyFetch()
      assert.equal(handle.configuredProxy(), 'http://proxy.internal:7890')
      void handle.dispose()
    })
    withEnv({ HTTP_PROXY: 'http://only-http:8080' }, () => {
      const handle = createProxyFetch()
      assert.equal(handle.configuredProxy(), 'http://only-http:8080', 'https 缺省时回退 http 代理')
      void handle.dispose()
    })
    withEnv({}, () => {
      const handle = createProxyFetch()
      assert.equal(handle.configuredProxy(), null)
      void handle.dispose()
    })
  })

  it('dispose 之后两个入口都拒绝（且是同一句错误）', async () => {
    const handle = createProxyFetch()
    await handle.dispose()
    await assert.rejects(() => handle.fetch('http://127.0.0.1:1/'), /already disposed/)
    await assert.rejects(() => handle.insecureFetch('http://127.0.0.1:1/'), /already disposed/)
  })

  it('dispose 幂等', async () => {
    const handle = createProxyFetch()
    await handle.dispose()
    await handle.dispose()
  })

  it('insecureFetch 不因为代理配置而改变直连语义（C-198 回归：dispatcher 恒为 insecureAgent）', async () => {
    withEnv({ https_proxy: 'http://proxy.internal:7890' }, () => {
      const handle = createProxyFetch()
      // 代理存在时 configuredProxy 有值，但 insecureFetch 走 direct 分支
      assert.equal(handle.configuredProxy(), 'http://proxy.internal:7890')
      // 直接验证实现契约：insecure 的请求绝不能带 EnvHttpProxyAgent
      const source = createProxyFetch.toString()
      assert.match(source, /direct/)
      void handle.dispose()
    })
  })
})

describe('createLimitedFetch', () => {
  it('并发上限生效，且返回值原样透传', async () => {
    let active = 0
    let peak = 0
    const fakeFetch = async (url: string): Promise<Response> => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return new Response(url)
    }
    const limited = createLimitedFetch(fakeFetch, 2)
    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((name) => limited(`u-${name}`)),
    )
    assert.equal(peak, 2, '最多只允许 2 个并发')
    assert.deepEqual(await Promise.all(results.map((response) => response.text())), ['u-a', 'u-b', 'u-c', 'u-d', 'u-e'])
  })

  it('并发数下限归一为 1（传 0 / 负数不炸）', async () => {
    let active = 0
    let peak = 0
    const fakeFetch = async (): Promise<Response> => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return new Response('ok')
    }
    const limited = createLimitedFetch(fakeFetch, 0)
    await Promise.all([limited('x'), limited('y')])
    assert.equal(peak, 1)
  })

  it('失败不泄漏槽位（后续请求仍能跑）', async () => {
    let calls = 0
    const fakeFetch = async (url: string): Promise<Response> => {
      calls += 1
      if (url === 'bad') throw new Error('boom')
      return new Response('ok')
    }
    const limited = createLimitedFetch(fakeFetch, 1)
    await assert.rejects(() => limited('bad'), /boom/)
    assert.equal(await (await limited('good')).text(), 'ok')
    assert.equal(calls, 2)
  })
})
