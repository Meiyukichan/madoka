/**
 * 客户端端点边界：自定义文件的两种历史字段名（`name/text` ↔ `title/description`）
 * 与 issue 已读端点。防止宿主换字段名时面板静默显示空行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  apiAcceptanceStrategies,
  apiRouterStrategies,
  apiUpdateAcceptanceStrategies,
  apiUpdateRouterStrategies,
  apiUpdateWorkspaceNotes,
  apiWorkspaceNotes,
} from '../src/client/data/endpoints/index.ts'
import { apiMarkIssueRead } from '../src/client/data/endpoints/issues.ts'

interface Call { url: string; method: string; body: unknown }

function withFetch(reply: (call: Call) => unknown): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    }
    calls.push(call)
    return new Response(JSON.stringify(reply(call)), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('验收策略：读宿主的 description，写回时 text/description 双写', async () => {
  const { calls, restore } = withFetch(call => call.method === 'GET'
    ? { ok: true, value: { strategies: [{ id: 'a-1', type: 'close', title: '达标才收', description: '清单全勾' }] } }
    : { ok: true, value: { strategies: [{ id: 'a-1', type: 'close', title: '达标才收', description: '清单全勾' }] } })
  try {
    const listed = await apiAcceptanceStrategies()
    assert.deepEqual(listed.strategies, [{ id: 'a-1', type: 'close', title: '达标才收', description: '清单全勾' }])
    await apiUpdateAcceptanceStrategies([{ id: 'a-1', type: 'close', title: '达标才收', description: '清单全勾' }])
    const body = calls[1]?.body as { strategies: { description: string; text: string }[] }
    assert.equal(body.strategies[0]?.description, '清单全勾')
    assert.equal(body.strategies[0]?.text, '清单全勾')
  } finally {
    restore()
  }
})

test('Router 策略：宿主形状 title/description → 面板 name/text，写回双写', async () => {
  const { calls, restore } = withFetch(() => ({
    ok: true,
    value: { items: [{ id: 's-1', title: '优先级', description: '先做阻塞项' }] },
  }))
  try {
    const listed = await apiRouterStrategies()
    assert.deepEqual(listed.items, [{ id: 's-1', name: '优先级', text: '先做阻塞项' }])
    await apiUpdateRouterStrategies([{ id: 's-1', name: '优先级', text: '先做阻塞项' }])
    const body = calls[1]?.body as { items: { name: string; text: string; title: string; description: string }[] }
    assert.equal(body.items[0]?.name, '优先级')
    assert.equal(body.items[0]?.title, '优先级')
    assert.equal(body.items[0]?.text, '先做阻塞项')
    assert.equal(body.items[0]?.description, '先做阻塞项')
  } finally {
    restore()
  }
})

test('工作区指导：兼容 items 数组与 id→说明字典两种形状', async () => {
  const { calls, restore } = withFetch(call => call.method === 'GET'
    ? { ok: true, value: { workspaces: { 'ws-1': '负责前端', 'ws-2': '负责后端' } } }
    : { ok: true, value: { items: [{ workspaceId: 'ws-1', description: '负责前端' }] } })
  try {
    const listed = await apiWorkspaceNotes()
    assert.deepEqual(listed.items.map(item => item.workspaceId), ['ws-1', 'ws-2'])
    const updated = await apiUpdateWorkspaceNotes([{ workspaceId: 'ws-1', description: '负责前端' }])
    assert.deepEqual(updated.items, [{ workspaceId: 'ws-1', description: '负责前端' }])
    const body = calls[1]?.body as { items: { workspaceId: string; description: string }[]; workspaces: Record<string, string> }
    assert.equal(body.items[0]?.description, '负责前端')
    assert.equal(body.workspaces['ws-1'], '负责前端')
  } finally {
    restore()
  }
})

test('issue 已读走 /issues/:id/mark-read', async () => {
  const { calls, restore } = withFetch(() => ({ ok: true, value: { seenAt: 1 } }))
  try {
    await apiMarkIssueRead('i-1')
    assert.equal(calls[0]?.url, '/api/castboard/issues/i-1/mark-read')
    assert.equal(calls[0]?.method, 'POST')
  } finally {
    restore()
  }
})
