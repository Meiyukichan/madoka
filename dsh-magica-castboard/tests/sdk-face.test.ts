/**
 * SDK 面适配器单测：缺包降级 / 缺方法记录 / 信封拆包。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createSdkFaces, type CastboardClientLike } from '../src/host/pipeline/sdk-face.ts'

test('缺 createCastboardClient → 全部缺失、不抛', async () => {
  const faces = await createSdkFaces({ instance: 'x', load: async () => ({}) })
  assert.deepEqual(faces.missing, ['createCastboardClient / CastboardClient'])
  assert.equal(faces.comments, undefined)
  assert.equal(faces.sync, undefined)
})

test('createCastboardClient 工厂建面', async () => {
  const faces = await createSdkFaces({
    instance: 'x',
    load: async () => ({
      createCastboardClient: () => ({ auth: { me: async () => ({ ok: true, data: { accountId: 'a-1' } }) } }),
    }),
  })
  assert.equal(faces.missing.some(item => item.includes('createCastboardClient')), false)
})

test('auth 面：读状态 / 登录后刷新快照 / 登出', async () => {
  const client: CastboardClientLike = {
    auth: {
      state: 'anonymous',
      accountId: 'a-1',
      accountDisplayName: 'Alice',
      me: async () => ({ ok: true, data: { accountId: 'a-1' } }),
      login: async () => {
        client.auth!.state = 'authenticated'
        return { ok: true, data: { accountId: 'a-1' } }
      },
      logout: async () => {
        client.auth!.state = 'login_required'
        return { ok: true, data: {} }
      },
    },
  }
  const faces = await createSdkFaces({ instance: 'x', load: async () => ({ createCastboardClient: () => client }) })
  assert.deepEqual(faces.auth?.status(), { state: 'anonymous', accountId: 'a-1', displayName: 'Alice' })
  assert.deepEqual(await faces.auth!.login({ accountId: 'a-1', password: 'x' }), {
    state: 'authenticated', accountId: 'a-1', displayName: 'Alice',
  })
  assert.equal((await faces.auth!.logout()).state, 'login_required')
})

test('会话状态读 client.state，而不是 client.auth API 面', async () => {
  const client: CastboardClientLike = {
    state: 'authenticated',
    accountId: 'a-1',
    auth: {
      me: async () => ({ ok: true, data: { accountId: 'a-1' } }),
      login: async () => ({ ok: true, data: { accountId: 'a-1' } }),
      logout: async () => ({ ok: true, data: {} }),
    },
  }
  const faces = await createSdkFaces({ instance: 'x', load: async () => ({ createCastboardClient: () => client }) })
  assert.equal(faces.auth?.status().state, 'authenticated')
  assert.equal(faces.auth?.status().accountId, 'a-1')
})

test('未登录：auth 面仍然存在，面板才能弹登录框', async () => {
  const client: CastboardClientLike = {
    auth: {
      state: 'login_required',
      accountId: 'a-1',
      me: async () => ({ ok: false, code: 'login_required', reason: '需要先登录' }),
      login: async () => ({ ok: true, data: { accountId: 'a-1' } }),
      logout: async () => ({ ok: true, data: {} }),
    },
  }
  const faces = await createSdkFaces({ instance: 'x', load: async () => ({ createCastboardClient: () => client }) })
  assert.ok(faces.auth !== undefined)
  assert.equal(faces.auth.status().state, 'login_required')
  assert.equal(faces.missing.some(item => item.includes('未登录')), false)
})

test('projects.mine：SDK 返回分页对象时解包 items', async () => {
  const client: CastboardClientLike = {
    auth: { me: async () => ({ ok: true, data: { accountId: 'a-1' } }) },
    teamwork: {
      project: {
        list: async () => ({ ok: true, data: { total: 0, pageNum: 1, pageSize: 20, items: [] } }),
        mine: async () => ({ ok: true, data: { total: 1, pageNum: 1, pageSize: 20, items: [{ id: 7, name: 'p' }] } }),
        detail: async () => ({ ok: true, data: { id: 7 } }),
        create: async () => ({ ok: true, data: { id: 7 } }),
      },
    },
  }
  const faces = await createSdkFaces({ instance: 'x', load: async () => ({ createCastboardClient: () => client }) })
  assert.deepEqual(await faces.projects?.mine(), [{ id: 7, name: 'p' }])
})

test('device 自动上报：登录成功后 host 内部调用 sync，固定 3080 且不重复当前 host', async () => {
  let synced: unknown[] = []
  let loggedIn = false
  const client: CastboardClientLike = {
    state: 'login_required',
    auth: {
      me: async () => loggedIn ? { ok: true, data: { accountId: 'a-1' } } : { ok: false, code: 'login_required' },
      login: async () => {
        loggedIn = true
        client.state = 'authenticated'
        return { ok: true, data: { accountId: 'a-1' } }
      },
      logout: async () => ({ ok: true, data: {} }),
    },
    device: {
      sync: async (devices: unknown[]) => {
        synced = devices
        return { ok: true, data: {} }
      },
    },
    teamwork: {
      device: {
        mine: async () => ({ ok: true, data: { items: [
          { host: 'localhost', port: 3080, os: 'linux' },
          { host: '127.0.0.1', port: 3080, os: 'win32' },
        ] } }),
      },
    },
  }
  const faces = await createSdkFaces({
    instance: 'x',
    load: async () => ({ createCastboardClient: () => client, getLocalIp: () => '127.0.0.1' }),
  })
  assert.ok(faces.auth?.login)
  await faces.auth.login({ accountId: 'a-1', password: 'x' })
  assert.deepEqual(synced, [
    { host: 'localhost', port: 3080, os: 'linux' },
    { host: '127.0.0.1', port: 3080, os: process.platform === 'win32' ? 'windows' : process.platform },
  ])
})

test('device 自动上报：host 启动时已登录也会上报', async () => {
  let synced = 0
  const client: CastboardClientLike = {
    state: 'authenticated',
    accountId: 'a-1',
    auth: {
      me: async () => ({ ok: true, data: { accountId: 'a-1' } }),
      logout: async () => ({ ok: true, data: {} }),
    },
    device: { sync: async () => { synced += 1; return { ok: true, data: {} } } },
    teamwork: {
      device: {
        mine: async () => ({ ok: true, data: { items: [] } }),
      },
    },
  }
  await createSdkFaces({
    instance: 'x',
    load: async () => ({ createCastboardClient: () => client, getLocalIp: () => '127.0.0.1' }),
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(synced, 1)
})

test('query.workspaces：使用顶层 castboardWorkspaceIndexes/Portal，不调用缺失方法', async () => {
  const client: CastboardClientLike = {
    auth: { me: async () => ({ ok: true, data: { accountId: 'a-1' } }) },
    project: { mine: async () => ({ ok: true, data: [] }) },
    castboardWorkspaceIndexes: async () => ({
      ok: true,
      data: [
        { workspaceId: null, instance: '127.0.0.1:3080', cwd: 'D:/work', detail: '# index' },
        { workspaceId: null, instance: 'localhost:3080', cwd: 'D:/other', detail: '# other' },
      ],
    }),
    castboardWorkspacePortal: async () => ({ ok: true, data: { workspaceId: 'w1', instance: '127.0.0.1:3080', cwd: 'D:/work', detail: '# portal' } }),
  }
  const faces = await createSdkFaces({ instance: 'x', load: async () => ({ createCastboardClient: () => client }) })
  const index = await faces.query?.workspaces({ type: 'index', userId: 'a-1', instance: '127.0.0.1:3080' })
  assert.deepEqual(index?.map(item => item.cwd), ['D:/work'])
  const portal = await faces.query?.workspaces({ type: 'portal', instance: '127.0.0.1:3080', workspaceId: 'w1' })
  assert.equal(portal?.[0]?.id, 'w1')
  assert.equal(portal?.[0]?.cwd, 'D:/work')
})

test('sync.myInstanceIssues：自动带当前 accountId', async () => {
  let seen: Record<string, unknown> | undefined
  const client: CastboardClientLike = {
    accountId: 'a-1',
    auth: { me: async () => ({ ok: true, data: { accountId: 'a-1' } }) },
    castboardMyInstanceIssues: async (options: Record<string, unknown>) => {
      seen = options
      return { ok: true, data: { items: [] } }
    },
    issueClaim: async () => ({ ok: true, data: { claimed: [], failed: [] } }),
  }
  const faces = await createSdkFaces({ instance: 'x', load: async () => ({ createCastboardClient: () => client }) })
  await faces.sync?.myInstanceIssues({ status: 'pending', instance: '127.0.0.1:3080', os: 'windows' })
  assert.equal(seen?.['userId'], 'a-1')
  assert.equal(seen?.['instance'], '127.0.0.1:3080')
})

test('issueAttachmentList：兼容对象/位置两代入参，映射 targetType/targetId/role', async () => {
  const issueId = '11111111-1111-4111-8111-111111111111'
  const seen: unknown[] = []
  const objectClient: CastboardClientLike = {
    auth: { me: async () => ({ ok: true, data: { accountId: 'a-1' } }) },
    issue: {
      attachment: {
        list: async (input: { targetType: string; targetId: string; role?: string }) => {
          seen.push(input)
          return {
            ok: true,
            data: [{
              id: 1,
              targetType: input.targetType,
              targetId: input.targetId,
              fileId: 'f-1',
              fileName: 'a.txt',
              role: 'assigner',
              description: '说明',
            }],
          }
        },
      },
    },
  }
  const objectFaces = await createSdkFaces({ instance: 'x', load: async () => ({ createCastboardClient: () => objectClient }) })
  const objectRows = await objectFaces.issueAttachmentList!('issue', issueId, 'assigner')
  assert.deepEqual(seen, [{ targetType: 'issue', targetId: issueId, role: 'assigner' }])
  assert.deepEqual(objectRows, [{
    fileId: 'f-1',
    fileName: 'a.txt',
    targetType: 'issue',
    targetId: issueId,
    role: 'assigner',
    description: '说明',
  }])

  const positionalSeen: unknown[] = []
  const positionalClient: CastboardClientLike = {
    auth: { me: async () => ({ ok: true, data: { accountId: 'a-1' } }) },
    issue: {
      attachment: {
        list: async (targetType: string, targetId: string, role?: string) => {
          positionalSeen.push([targetType, targetId, role])
          return {
            ok: true,
            data: [{ fileId: 'f-2', fileName: 'b.txt', targetType, targetId, role: role ?? 'assignee' }],
          }
        },
      },
    },
  }
  const positionalFaces = await createSdkFaces({ instance: 'x', load: async () => ({ createCastboardClient: () => positionalClient }) })
  const positionalRows = await positionalFaces.issueAttachmentList!('comment', issueId)
  assert.deepEqual(positionalSeen, [['comment', issueId, undefined]])
  assert.deepEqual(positionalRows, [{
    fileId: 'f-2',
    fileName: 'b.txt',
    targetType: 'comment',
    targetId: issueId,
    role: 'assignee',
  }])
})

test('只实现部分方法 → 其余记进 missing', async () => {
  const client: CastboardClientLike = {
    auth: { me: async () => ({ ok: true, data: { accountId: 'a-1' } }) },
    castboardAddIssueComments: async () => ({ ok: true, data: {} }),
    issue: { comment: { listSince: async () => ({ ok: true, data: { items: [], nextSinceId: 'n-1' } }) } },
  }
  const faces = await createSdkFaces({ instance: 'x', load: async () => ({ createCastboardClient: () => client }) })
  assert.ok(faces.comments !== undefined)
  assert.equal(faces.sync, undefined)
  assert.equal(faces.finalize, undefined)
  assert.deepEqual(faces.missing.sort(), [
    'abandon',
    'artifacts',
    'attachmentDownload',
    'auth',
    'devices',
    'finalize',
    'issueAttachmentList',
    'issueComments',
    'issueGet',
    'issueList',
    'issues',
    'portrait',
    'projects',
    'query',
    'routed',
    'routing',
    'running',
    'sources',
    'status',
    'sync',
  ])
})

test('comments.publish：带 commentAt / 作者类型，role 为空时不写列；信封 ok 才算成功', async () => {
  let fail = false
  const sent: unknown[] = []
  const client: CastboardClientLike = {
    auth: { me: async () => ({ ok: true, data: { accountId: 'a-1' } }) },
    castboardAddIssueComments: async (issueId: string, comments: unknown) => {
      sent.push({ issueId, comments })
      return fail ? { ok: false, code: 'forbidden', reason: 'nope' } : { ok: true, data: { written: 1 } }
    },
    issue: { comment: { listSince: async () => ({ ok: true, data: { items: [], nextSinceId: undefined } }) } },
  }
  const faces = await createSdkFaces({ instance: 'x', load: async () => ({ createCastboardClient: () => client }) })
  assert.ok(faces.comments !== undefined)
  await faces.comments.publish({
    issueId: 'i-1',
    commentId: 'c-1',
    body: 'x',
    role: 'assignee',
    authorType: 'system',
    createdAt: Date.UTC(2026, 7, 1, 1, 0, 0),
  })
  await faces.comments.publish({
    issueId: 'i-1',
    commentId: 'c-2',
    body: 'y',
    role: null,
    authorType: 'user',
    createdAt: Date.UTC(2026, 7, 1, 1, 0, 1),
  })
  const first = (sent[0] as { comments: Record<string, unknown>[] }).comments[0]!
  assert.equal(first.commentId, 'c-1')
  assert.equal(first.commentRole, 'assignee')
  assert.equal(first.commentAuthorType, 'system')
  assert.match(String(first.commentAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
  const second = (sent[1] as { comments: Record<string, unknown>[] }).comments[0]!
  // NULL direction must stay unset in the cloud (not rewritten to `assigner`).
  assert.equal('commentRole' in second, false)
  assert.equal(second.commentAuthorType, 'user')

  fail = true
  await assert.rejects(
    () => faces.comments!.publish({
      issueId: 'i-1', commentId: 'c-3', body: 'x', role: 'assignee', authorType: 'agent', createdAt: 0,
    }),
    /forbidden/,
  )
})

test('comments.listSince：把云端行映射成 RemoteComment（commentAt / 作者类型 / 作者）', async () => {
  const client: CastboardClientLike = {
    auth: { me: async () => ({ ok: true, data: { accountId: 'a-1' } }) },
    castboardAddIssueComments: async () => ({ ok: true, data: {} }),
    issue: {
      comment: {
        listSince: async () => ({
          ok: true,
          data: {
            items: [
              {
                id: '100',
                content: '你好',
                createdAt: '2026-08-01T10:00:00Z',
                commentAt: '2026-08-01 09:00:00',
                commentRole: 'assigner',
                commentAuthorType: 'system',
                author: 'tester',
                issueId: 'i-1',
              },
              { id: '101', content: '无方向', createdAt: '2026-08-01T09:00:00+08:00', commentRole: null, issueId: 'i-1' },
            ],
            nextSinceId: '101',
          },
        }),
      },
    },
  }
  const faces = await createSdkFaces({ instance: 'x', load: async () => ({ createCastboardClient: () => client }) })
  const page = await faces.comments!.listSince({ sinceId: '50', limit: 500 })
  assert.equal(page.items.length, 2)
  const first = page.items[0]!
  assert.equal(first.issueId, 'i-1')
  assert.equal(first.commentId, '100')
  assert.equal(first.role, 'assigner')
  assert.equal(first.authorType, 'system')
  assert.equal(first.author, 'tester')
  // `commentAt` wins over `createdAt`, and a zone-less Beijing string must be +08:00.
  assert.equal(first.createdAt, Date.parse('2026-08-01T09:00:00+08:00'))
  // Unknown direction stays null instead of being rewritten to `assigner`.
  assert.equal(page.items[1]!.role, null)
  assert.equal(page.items[1]!.createdAt, Date.parse('2026-08-01T09:00:00+08:00'))
  assert.equal(page.nextSinceId, '101')
})

test('sources：ensure 只补 dsh；isRegistered 精确匹配且不注册', async () => {
  const added: string[] = []
  let rows = [
    { code: 'self', pluginName: '@meiyukichan/dsh-magica-castboard' },
    { code: 'im', pluginName: 'other' },
  ] as Array<{ code: string; pluginName?: string | null }>
  const client: CastboardClientLike = {
    auth: { me: async () => ({ ok: true, data: { accountId: 'a-1' } }) },
    castboardIssueSources: async (code?: string) => ({
      ok: true,
      data: code === undefined ? rows : rows.filter(row => row.code.includes(code)),
    }),
    castboardAddIssueSource: async (input: { code: string }) => {
      added.push(input.code)
      rows = [...rows, { code: input.code, pluginName: '@meiyukichan/dsh-magica-castboard' }]
      return { ok: true, data: { code: input.code } }
    },
  }
  const faces = await createSdkFaces({ instance: 'x', load: async () => ({ createCastboardClient: () => client }) })
  assert.ok(faces.sources !== undefined)
  await faces.sources.ensure()
  // `self` is a legacy row, already present; only `dsh` is registered by this plugin.
  assert.deepEqual(added, ['dsh'])
  await faces.sources.ensure()
  assert.deepEqual(added, ['dsh'], 'second ensure is a no-op')

  assert.equal(await faces.sources.isRegistered('im'), true)
  // Server-side ILIKE returns `im` for `i`; exact comparison must reject it, and lookup never registers.
  assert.equal(await faces.sources.isRegistered('i'), false)
  assert.equal(await faces.sources.isRegistered('ix'), false)
  assert.deepEqual(added, ['dsh'])
})

test('sync.claim：SDK 收到 issueId 数组，结果收敛成 claimed/failed', async () => {
  let seenClaim: unknown
  const client: CastboardClientLike = {
    auth: { me: async () => ({ ok: true, data: { accountId: 'a-1' } }) },
    castboardMyInstanceIssues: async () => ({ ok: true, data: { items: [{ issueId: 'i-1', title: 't' }] } }),
    issueClaim: async (issueIds: unknown) => {
      seenClaim = issueIds
      return { ok: true, data: { claimed: ['i-1'], failed: [] } }
    },
  }
  const faces = await createSdkFaces({ instance: 'x', load: async () => ({ createCastboardClient: () => client }) })
  assert.ok(faces.sync !== undefined)
  const page = await faces.sync.myInstanceIssues({ status: 'pending', instance: 'x' })
  assert.equal(page.length, 1)
  const claim = await faces.sync.claim({ issueIds: ['i-1'], expectedStatus: 'pending' })
  assert.deepEqual(seenClaim, ['i-1'])
  assert.deepEqual(claim.claimed, ['i-1'])
})

test('未登录共享库 → auth 面仍保留，登录弹窗可恢复', async () => {
  const client: CastboardClientLike = {
    castboardAddIssueComments: async () => ({ ok: true, data: {} }),
    issue: { comment: { listSince: async () => ({ ok: true, data: { items: [] } }) } },
    auth: {
      state: 'login_required',
      me: async () => ({ ok: false, code: 'unauthorized', reason: 'no session' }),
      login: async () => ({ ok: true, data: { accountId: 'a-1' } }),
      logout: async () => ({ ok: true, data: {} }),
    },
  }
  const faces = await createSdkFaces({ instance: 'x', load: async () => ({ createCastboardClient: () => client }) })
  assert.ok(faces.auth !== undefined)
  assert.equal(faces.auth.status().state, 'login_required')
  assert.equal(faces.missing.some(item => item.includes('未登录')), false)
})

test('类方法绑定：SDK 是 class 实例方法（用 this.transport），必须 bind 后再用', async () => {
  /** 模拟真实 SDK：API 对象自带 transport，方法内部用 this.transport。 */
  interface TransportLike { call: () => Promise<{ ok: true; data: { items: unknown[]; nextSinceId?: string } }> }
  const makeCommentApi = (transport: TransportLike) => ({
    transport,
    async listSince(this: { transport: TransportLike }) {
      return this.transport.call()
    },
  })
  class FakeClient {
    transport: TransportLike = { call: async () => ({ ok: true as const, data: { items: [], nextSinceId: undefined } }) }
    issue = { comment: makeCommentApi(this.transport) }
    auth = { me: async () => ({ ok: true as const, data: { accountId: 'a-1' } }) }
    async castboardAddIssueComments() { return { ok: true as const, data: {} } }
    async castboardIssueStatuses() { return { ok: true as const, data: {} } }
  }
  const client = new FakeClient()
  const faces = await createSdkFaces({ instance: 'x', load: async () => ({ createCastboardClient: () => client as never }) })
  assert.equal(faces.missing.includes('comments'), false, `comments 面应就绪：${faces.missing.join(',')}`)
  assert.ok(faces.comments !== undefined)
  const page = await faces.comments!.listSince({ limit: 10 })
  assert.deepEqual(page.items, [])
})

test('issueList 面：拆响应信封并映射 issueId / updatedAt', async () => {
  const client: CastboardClientLike = {
    issue: {
      list: async () => ({
        ok: true,
        data: {
          items: [
            { issueId: 'i-1', title: '需求', status: 'pending', assigner: 'a-1', updatedAt: '2026-01-02T03:04:05.000Z' },
            { id: 'i-2', title: '采纳', status: 'success', assignee: 'a-1', urgency: 'urgent' },
          ],
        },
      }),
    },
  }
  const faces = await createSdkFaces({ instance: 'x', load: async () => ({ createCastboardClient: () => client }) })
  const rows = await faces.issueList!({ pageNum: 1, pageSize: 200 })
  assert.deepEqual(rows, [
    {
      issueId: 'i-1', title: '需求', status: 'pending', assigner: 'a-1',
      updatedAt: Date.parse('2026-01-02T03:04:05.000Z'),
    },
    { issueId: 'i-2', title: '采纳', status: 'success', assignee: 'a-1', urgency: 'urgent' },
  ])
})