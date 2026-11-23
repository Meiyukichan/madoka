/** 设备与工作区肖像 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootHarness, isCode, PASSWORD, signToken } from './helpers.js'

test('全量同步：本批之外置 inactive；空批 = 全部下线', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')

  const first = await alice.devices.sync([
    { host: 'laptop-a', port: 3080, os: 'windows' },
    { host: 'laptop-b', port: 3081 },
  ])
  assert.equal(first.synced, 2)
  assert.equal(first.deactivated, 0)

  // 只报一台 → 另一台变 inactive
  const second = await alice.devices.sync([{ host: 'laptop-a', port: 3080, os: 'windows' }])
  assert.equal(second.synced, 1)
  assert.equal(second.deactivated, 2)
  assert.equal((await alice.devices.listActive()).length, 1)
  assert.equal((await alice.devices.mine()).total, 2, 'mine 含 inactive')

  // 空数组 → 全部下线
  const cleared = await alice.devices.sync([])
  assert.equal(cleared.synced, 0)
  assert.equal((await alice.devices.listActive()).length, 0)
})

test('组合索引冲突：同 host+port 更新 os/status/last_active，不新增行', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')

  await alice.devices.sync([{ host: 'same-host', port: 3080, os: 'linux' }])
  const first = await alice.devices.mine({ pageNum: 1, pageSize: 10 })
  assert.equal(first.items.length, 1)
  const firstRow = first.items[0]!

  await alice.devices.sync([{ host: 'same-host', port: 3080, os: 'windows' }])
  const second = await alice.devices.mine({ pageNum: 1, pageSize: 10 })
  assert.equal(second.items.length, 1)
  const secondRow = second.items[0]!
  assert.equal(secondRow.id, firstRow.id)
  assert.equal(secondRow.os, 'windows')
  assert.equal(secondRow.status, 'active')
  assert.ok(Date.parse(secondRow.lastActiveAt ?? '') >= Date.parse(firstRow.lastActiveAt ?? ''))
})

test('同步：host 必填 / port 范围 / 条数上限', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  await assert.rejects(() => alice.devices.sync([{ host: '' }]), isCode('invalid_request'))
  await assert.rejects(() => alice.devices.sync([{ host: 'x', port: 70000 }]), isCode('invalid_request'))
  const many = Array.from({ length: 201 }, (_, i) => ({ host: `h${i}` }))
  await assert.rejects(() => alice.devices.sync(many), isCode('invalid_request'))
})

test('设备不做资源级鉴权：可查、可删他人设备', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  const bob = await h.register('bob')

  await alice.devices.sync([{ host: 'alice-laptop', port: 3080 }])
  const seen = await bob.devices.listActive('alice')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.host, 'alice-laptop')

  await bob.devices.remove(seen[0]!.id)
  assert.equal((await alice.devices.listActive()).length, 0)
  await assert.rejects(() => bob.devices.remove(seen[0]!.id), isCode('device_not_found'))
})

test('工作区：index / portal 两种形状与幂等 upsert', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')

  const idx = await alice.workspaces.upsert({ instance: '10.0.0.1:3080', type: 'index', detail: '# v1' })
  assert.equal(idx.type, 'index')
  assert.equal(idx.workspaceId, null)
  assert.equal(idx.cwd, null)
  const idx2 = await alice.workspaces.upsert({ instance: '10.0.0.1:3080', type: 'index', detail: '# v2' })
  assert.equal(idx2.id, idx.id, '同 (account, instance) 的 index 只刷新')
  assert.equal(idx2.detail, '# v2')

  const portal = await alice.workspaces.upsert({
    instance: '10.0.0.1:3080',
    type: 'portal',
    detail: '# p1',
    workspaceId: 'ws-1',
    cwd: 'D:/work/proj-7',
  })
  assert.equal(portal.type, 'portal')
  const portal2 = await alice.workspaces.upsert({
    instance: '10.0.0.1:3080',
    type: 'portal',
    detail: '# p2',
    workspaceId: 'ws-1',
    cwd: 'D:/work/proj-7-renamed',
  })
  assert.equal(portal2.id, portal.id)
  assert.equal(portal2.cwd, 'D:/work/proj-7-renamed')

  assert.equal((await alice.workspaces.list()).length, 2)
})

test('工作区：形状非法与类型非法', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')

  await assert.rejects(
    () => alice.workspaces.upsert({ instance: 'i:1', type: 'index', detail: 'x', cwd: 'D:/x' }),
    isCode('invalid_workspace_shape'),
  )
  await assert.rejects(
    () => alice.workspaces.upsert({ instance: 'i:1', type: 'portal', detail: 'x' }),
    isCode('invalid_workspace_shape'),
  )
  const res = await h.raw('POST', '/device-workspaces', {
    body: { instance: 'i:1', type: 'weird', detail: 'x' },
    token: signToken(alice.accountToken!, 'alice'),
    account: 'alice',
  })
  assert.equal(res.status, 400)
  assert.equal((res.body as { code: string }).code, 'invalid_type')
})

test('工作区查询：cwd 精确 / cwdPrefix 前缀 / 不能同时传 / 跨账号可查', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  const bob = await h.register('bob')

  for (const [ws, cwd] of [
    ['ws-1', 'D:/work/proj-7'],
    ['ws-2', 'D:/work/proj-70'],
    ['ws-3', 'D:/work/other'],
  ] as const) {
    await alice.workspaces.upsert({ instance: 'i:1', type: 'portal', detail: 'x', workspaceId: ws, cwd })
  }

  // bob 查 alice 的
  assert.equal((await bob.workspaces.list({ accountId: 'alice', cwd: 'D:/work/proj-7' })).length, 1)
  const prefix = await bob.workspaces.list({ accountId: 'alice', cwdPrefix: 'D:/work/proj-7' })
  assert.equal(prefix.length, 2, '前缀匹配 proj-7 与 proj-70')
  const exact = await bob.workspaces.list({ accountId: 'alice', cwd: 'D:/work/proj-7' })
  assert.equal(exact.length, 1, '精确匹配不会带上 proj-70')

  await assert.rejects(
    () => bob.workspaces.list({ accountId: 'alice', cwd: 'D:/x', cwdPrefix: 'D:/x' }),
    isCode('invalid_request'),
  )
  // 默认查自己
  assert.equal((await bob.workspaces.list()).length, 0)
})
