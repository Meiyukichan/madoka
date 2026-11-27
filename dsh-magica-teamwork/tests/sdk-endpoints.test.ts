/**
 * 端点表契约：**表是唯一真源**，与分组映射互为护栏。
 *
 * 对应设计文档 §16.1 的断言集。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CASTBOARD_COMPOSITES,
  CASTBOARD_DEFAULT_PREFIX,
  CASTBOARD_ENDPOINTS,
  CASTBOARD_ENDPOINT_OWNER,
  CASTBOARD_EXTENSION_COMPOSITES,
  capabilityKey,
  createCastboardClient,
  endpointCapabilityKey,
} from '../src/sdk/index.js'

test('端点表恰好 51 条表项 / 50 个协议端点（projectList 与 teamworkProjectMine 同路径）', () => {
  const names = Object.keys(CASTBOARD_ENDPOINTS)
  assert.equal(names.length, 51)

  const unique = new Set(names.map((name) => endpointCapabilityKey(name as keyof typeof CASTBOARD_ENDPOINTS)))
  assert.equal(unique.size, 50)
  assert.equal(endpointCapabilityKey('projectList'), endpointCapabilityKey('teamworkProjectMine'))
  assert.equal(endpointCapabilityKey('projectList'), 'GET /projects/mine')
  assert.equal(endpointCapabilityKey('issueAttachmentListByTarget'), 'GET /attachments')
})

test('每条表项的形状合法：method / auth / retry / path', () => {
  const methods = new Set(['GET', 'POST', 'PUT', 'DELETE'])
  const auths = new Set(['public', 'signed', 'admin', 'local'])
  // 唯一一个非幂等的 PUT：改密码带旧密码，重放会失败（所以显式 retry:false）
  const nonIdempotentWrites = new Set(['authPassword'])
  for (const [name, endpoint] of Object.entries(CASTBOARD_ENDPOINTS)) {
    assert.ok(methods.has(endpoint.method), `${name} 的 method 非法：${endpoint.method}`)
    assert.ok(auths.has(endpoint.auth), `${name} 的 auth 非法：${endpoint.auth}`)
    assert.equal(typeof endpoint.retry, 'boolean', `${name} 的 retry 必须是布尔`)
    assert.ok(endpoint.path.startsWith('/'), `${name} 的 path 必须以 / 开头`)
    assert.ok(!endpoint.path.startsWith(CASTBOARD_DEFAULT_PREFIX), `${name} 的 path 不该带前缀`)
    // 除显式列出的以外，GET/PUT/DELETE 都天然幂等；POST 只有声明过的才重试
    if (endpoint.method !== 'POST' && !nonIdempotentWrites.has(name)) {
      assert.equal(endpoint.retry, true, `${name}（${endpoint.method}）应可重试`)
    }
    if (nonIdempotentWrites.has(name)) assert.equal(endpoint.retry, false, `${name} 不该重试`)
  }
})

test('分组映射与表键集合完全相等（防表与实现漂移）', () => {
  const fromOwners = Object.values(CASTBOARD_ENDPOINT_OWNER).flat() as string[]
  assert.equal(fromOwners.length, new Set(fromOwners).size, '分组映射里有重复端点名')
  assert.deepEqual([...fromOwners].sort(), Object.keys(CASTBOARD_ENDPOINTS).sort())
})

test('能力键把 {param} 归一成 :param（服务端 /version 用 Express 风格）', () => {
  assert.equal(capabilityKey({ method: 'GET', path: '/projects/{id}', auth: 'signed', retry: true }), 'GET /projects/:id')
  assert.equal(endpointCapabilityKey('issueGet'), 'GET /issues/:issueId')
  assert.equal(endpointCapabilityKey('teamworkProjectMemberRemove'), 'DELETE /projects/:id/members/:accountId')
  assert.equal(endpointCapabilityKey('fileDownload'), 'GET /files/:fileId')
})

test('鉴权级别分布：5 个公开 / local 只有停机 / 需要 administrator 的有 7 个', () => {
  const publicNames = Object.entries(CASTBOARD_ENDPOINTS)
    .filter(([, endpoint]) => endpoint.auth === 'public')
    .map(([name]) => name)
  assert.deepEqual(publicNames.sort(), ['authLogin', 'authRegister', 'authToken', 'health', 'version'])

  const localNames = Object.entries(CASTBOARD_ENDPOINTS)
    .filter(([, endpoint]) => endpoint.auth === 'local')
    .map(([name]) => name)
  assert.deepEqual(localNames, ['shutdown'])

  const adminNames = Object.entries(CASTBOARD_ENDPOINTS)
    .filter(([, endpoint]) => endpoint.auth === 'admin')
    .map(([name]) => name)
  assert.deepEqual(
    adminNames.sort(),
    ['adminAccounts', 'adminResetPassword', 'adminSetRole', 'authAccountLookup', 'fileDelete', 'issueSourceDelete', 'issueSourceUpdate'],
  )
})

test('组合层清单：24 个 raw 方法 + 1 个扩展，且都挂在 CastboardClient 上', () => {
  assert.equal(CASTBOARD_COMPOSITES.length, 24, 'raw 的 24 个组合方法一个不能少')
  assert.equal(new Set(CASTBOARD_COMPOSITES).size, 24)
  assert.deepEqual([...CASTBOARD_EXTENSION_COMPOSITES], ['castboardIssueStatuses'])

  const client = createCastboardClient({ baseUrl: 'http://127.0.0.1:1/dsh-teamwork/v1' })
  for (const name of [...CASTBOARD_COMPOSITES, ...CASTBOARD_EXTENSION_COMPOSITES]) {
    assert.equal(typeof (client as unknown as Record<string, unknown>)[name], 'function', `${name} 必须挂在 client 上`)
  }
  for (const group of ['auth', 'project', 'issue', 'teamwork', 'device', 'file', 'ops', 'admin']) {
    assert.ok((client as unknown as Record<string, unknown>)[group] !== undefined, `分组 ${group} 必须存在`)
  }
  void client.dispose()
})
