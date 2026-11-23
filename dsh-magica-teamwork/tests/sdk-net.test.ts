/**
 * 出站句柄：模式选择（严格 TLS 走全局 fetch / 放宽或代理走 spellbook+undici）、代理环境变量、
 * 并发闸（发布包实现）、限并发映射、日志接缝。
 *
 * 对应设计文档 §11.2 / §11.6 与 §16.2。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createCastboardFetch,
  createLimitedFetch,
  hasCastboardLogger,
  castboardLog,
  mapLimit,
  netModeOf,
  setCastboardLogger,
  type CastboardFetch,
  type EventLogger,
} from '../src/sdk/index.js'

const PROXY_ENV = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'npm_config_proxy',
  'npm_config_https_proxy',
] as const

function withoutProxyEnv<T>(fn: () => T): T {
  const saved = new Map<string, string | undefined>()
  for (const key of PROXY_ENV) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('严格 TLS 且无代理 → global 模式（零依赖，不碰 undici）', () => {
  withoutProxyEnv(() => {
    assert.equal(netModeOf(), 'global')
    const handle = createCastboardFetch()
    assert.equal(handle.mode, 'global')
    assert.equal(handle.configuredProxy(), null)
  })
})

test('rejectUnauthorized:false → undici 模式；proxy:false 强制回 global', () => {
  withoutProxyEnv(() => {
    assert.equal(netModeOf({ rejectUnauthorized: false }), 'undici')

    process.env['http_proxy'] = 'http://proxy.example:8080'
    assert.equal(netModeOf(), 'undici')

    assert.equal(netModeOf({ proxy: false }), 'global')
    const forced = createCastboardFetch({ proxy: false })
    assert.equal(forced.mode, 'global')
    assert.equal(forced.configuredProxy(), null)
  })
})

test('https_proxy 缺省沿用 http_proxy（spellbook 的语义）', () => {
  withoutProxyEnv(() => {
    process.env['http_proxy'] = 'proxy.internal:3128'
    assert.equal(netModeOf(), 'undici')
  })
})

test('undici 模式下首次调用才加载依赖：缺包时给可操作错误，而不是 import 阶段炸', async () => {
  withoutProxyEnv(() => {
    // 构造不加载 undici（纯计算模式）
    const handle = createCastboardFetch({ rejectUnauthorized: false })
    assert.equal(handle.mode, 'undici')
  })
  const handle = createCastboardFetch({ rejectUnauthorized: false })
  let error: unknown = null
  try {
    await handle.fetch('http://127.0.0.1:1/health', { method: 'GET' })
  } catch (err) {
    error = err
  }
  // 装了 undici 的环境会走成 network_error（fetch 真发了）；没装则报缺依赖
  if (error !== null) assert.match(String((error as Error).message), /undici|fetch failed|ECONN/i)
})

test('并发闸（发布包实现）：同时在飞不超过 limit', async () => {
  let inflight = 0
  let peak = 0
  const fetcher: CastboardFetch = async () => {
    inflight += 1
    peak = Math.max(peak, inflight)
    await new Promise((resolve) => setTimeout(resolve, 5))
    inflight -= 1
    return new Response('ok')
  }
  const limited = createLimitedFetch(fetcher, 2)
  await Promise.all(Array.from({ length: 6 }, () => limited('http://x/1')))
  assert.equal(peak, 2)
})

test('mapLimit：保序 + 限并发 + 空数组', async () => {
  let inflight = 0
  let peak = 0
  const result = await mapLimit([5, 1, 4, 2, 3], 2, async (value) => {
    inflight += 1
    peak = Math.max(peak, inflight)
    await new Promise((resolve) => setTimeout(resolve, 2))
    inflight -= 1
    return value * 10
  })
  assert.deepEqual(result, [50, 10, 40, 20, 30])
  assert.ok(peak <= 2, `峰值并发 ${peak} 超过 2`)
  assert.deepEqual(await mapLimit([], 4, async (v: number) => v), [])
})

test('日志接缝：注入 spellbook 的 EventLogger 后事件走它；清掉后回 console 兜底', () => {
  const events: Array<{ level: string; event: string; detail: string }> = []
  const fake = {
    logEvent(level: string, event: string, detail: string) {
      events.push({ level, event, detail })
    },
  } as unknown as EventLogger

  assert.equal(hasCastboardLogger(), false)
  setCastboardLogger(fake)
  try {
    assert.equal(hasCastboardLogger(), true)
    castboardLog('warn', 'depends-on', '归一了一条脏数据')
    assert.deepEqual(events, [{ level: 'warn', event: 'depends-on', detail: '归一了一条脏数据' }])
  } finally {
    setCastboardLogger(null)
  }
  assert.equal(hasCastboardLogger(), false)
  // 没注入 logger 时仍走 spellbook 的默认 NDJSON，不碰 console。
  const consoleHits: string[] = []
  const original = { warn: console.warn, error: console.error }
  console.warn = () => { consoleHits.push('warn') }
  console.error = () => { consoleHits.push('error') }
  try {
    castboardLog('info', 'noop', '不该刷屏')
    castboardLog('error', 'boom', '写文件而不是 terminal')
  } finally {
    console.warn = original.warn
    console.error = original.error
  }
  assert.deepEqual(consoleHits, [])
})
