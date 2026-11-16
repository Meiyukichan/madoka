/**
 * **真机联调**：起真实服务端（Fastify + SQLite + 真 HTTP），用传输层逐条调协议端点。
 *
 * 与 `sdk-transport.test.ts`（mock fetch）的分工：
 *  - 那边证明"管线逻辑对不对"；
 *  - 这边证明"**和真实服务端真的通**"：现签 JWT 能被 guard 验过、路径/字段/状态码/错误码全对上、
 *    幂等与并发仲裁在真库上生效。
 *
 * 覆盖：version 探测 → 注册 → authMe → 建项目 → 建 issue → 认领仲裁 → 评论幂等 → 增量游标 →
 *       文件上传/下载 → 挂附件（类型映射）→ 工作区 → 设备 → 分页 → 局部覆盖 → 管理面 → 错误归一。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startServer } from '../src/server/main.js'
import {
  LATTICE_ENDPOINTS,
  LatticeAuth,
  LatticeTransport,
  type LatticeAccount,
  type LatticeAttachment,
  type LatticeAuthSession,
  type LatticeComment,
  type LatticeDevice,
  type LatticeDeviceWorkspace,
  type LatticeFileInfo,
  type LatticeHealth,
  type LatticeIssue,
  type LatticeIssuePage,
  type LatticeProject,
  type LatticeProjectDetail,
  type LatticeStatusBatchResult,
  type LatticeTeamworkPage,
  type LatticeVersion,
} from '../src/sdk/index.js'

const PASSWORD = 'correct horse battery'
const ACCOUNT = 'alice-live'

let server: Awaited<ReturnType<typeof startServer>>
let dataDir = ''
let transport: LatticeTransport
const auth = new LatticeAuth({ persist: false })

function b64(plain: string): string {
  return Buffer.from(plain, 'utf8').toString('base64')
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'dsh-teamwork-live-'))
  server = await startServer({ dataDir, port: 0, log: () => {}, rateLimit: false })
  transport = new LatticeTransport({
    baseUrl: `http://127.0.0.1:${server.port}/dsh-teamwork/v1`,
    auth,
  })
})

after(async () => {
  await transport.dispose()
  await server.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('真机联调：一条完整链路（注册→项目→issue→认领→评论→附件→工作区→设备）', async () => {
  // ① 能力探测（public，零会话）
  const version = await transport.call<LatticeVersion>('version')
  assert.equal(version.ok, true)
  if (!version.ok) return
  assert.equal(version.data.protocol, 'dsh-teamwork/1')
  assert.equal(version.data.endpoints.length, 47)
  transport.setCapabilities(version.data.endpoints)
  for (const name of Object.keys(LATTICE_ENDPOINTS) as (keyof typeof LATTICE_ENDPOINTS)[]) {
    assert.equal(transport.supports(name), true, `${name} 未出现在 /version.endpoints[]`)
  }

  // ② 注册（public；密码走 base64）→ 首个账号自动 administrator
  const registered = await transport.call<LatticeAuthSession>('authRegister', {}, {
    body: { accountId: ACCOUNT, password: b64(PASSWORD), displayName: '联调账号' },
  })
  assert.equal(registered.ok, true, registered.ok ? '' : registered.reason)
  if (!registered.ok) return
  assert.equal(registered.data.account.globalRole, 'administrator')
  assert.equal(typeof registered.data.accountToken, 'string')
  assert.equal(registered.data.accountToken.length, 64)

  auth.acceptSession({
    accountId: registered.data.account.accountId,
    accountToken: registered.data.accountToken,
    ttlSeconds: registered.data.ttlSeconds,
    displayName: registered.data.account.displayName,
    globalRole: registered.data.account.globalRole,
  })

  // ③ 现签 JWT 被真实 guard 验过
  const me = await transport.call<{ account: LatticeAccount }>('authMe')
  assert.equal(me.ok, true, me.ok ? '' : `${me.code}: ${me.reason}`)
  if (me.ok) assert.equal(me.data.account.accountId, ACCOUNT)

  // ④ 建项目（201 + ProjectDetailVo；owner = 创建人）
  const project = await transport.call<LatticeProjectDetail>('teamworkProjectCreate', {}, {
    body: { name: '联调项目', visibility: 'private', description: 'live test' },
  })
  assert.equal(project.ok, true, project.ok ? '' : `${project.code}: ${project.reason}`)
  if (!project.ok) return
  assert.equal(project.data.owner, ACCOUNT)
  assert.equal(project.data.members.length, 1)
  assert.equal(project.data.members[0]!.role, 'owner')
  const projectId = project.data.id

  const mine = await transport.call<LatticeProject[]>('projectList')
  assert.equal(mine.ok, true)
  if (mine.ok) assert.ok(mine.data.some((p) => p.id === projectId))

  const paged = await transport.call<LatticeTeamworkPage<LatticeProject>>('teamworkProjectList', {}, {
    query: { pageNum: 1, pageSize: 10 },
  })
  assert.equal(paged.ok, true)
  if (paged.ok) {
    assert.equal(paged.data.pageNum, 1)
    assert.equal(paged.data.pageSize, 10)
  }

  // ⑤ 建 issue（C1；整批原子）
  const issueId = `live-${Date.now()}`
  const submitted = await transport.call<string[]>('issueSubmit', {}, {
    body: [
      {
        issueId,
        title: '联调 issue',
        detail: '正文',
        assignee: ACCOUNT,
        projectId,
        urgency: 'urgent',
        dependsOn: JSON.stringify([]),
        source: 'self',
      },
    ],
  })
  assert.equal(submitted.ok, true, submitted.ok ? '' : `${submitted.code}: ${submitted.reason}`)
  if (submitted.ok) assert.deepEqual(submitted.data, [issueId])

  const got = await transport.call<LatticeIssue>('issueGet', { issueId })
  assert.equal(got.ok, true)
  if (!got.ok) return
  assert.equal(got.data.title, '联调 issue')
  assert.equal(got.data.detail, '正文')
  assert.equal(got.data.status, 'pending')
  assert.equal(got.data.projectId, projectId)
  assert.equal(got.data.assigner, ACCOUNT, 'assigner 必须由 token 决定')
  assert.equal(got.data.urgency, 'urgent')

  // ⑥ 认领仲裁：第一次抢到；第二次 status_conflict（真库条件更新）
  const claim = await transport.call<LatticeStatusBatchResult>('issueUpdateStatuses', {}, {
    body: [
      {
        issueId,
        status: 'accepted',
        expectedStatus: 'pending',
        assigneeInstance: '10.1.2.3:3080',
        assignedAt: new Date().toISOString(),
      },
    ],
  })
  assert.equal(claim.ok, true)
  if (claim.ok) {
    assert.equal(claim.data.success, 1)
    assert.deepEqual(claim.data.failed, [])
  }

  const steal = await transport.call<LatticeStatusBatchResult>('issueUpdateStatuses', {}, {
    body: [{ issueId, status: 'accepted', expectedStatus: 'pending' }],
  })
  assert.equal(steal.ok, true, '批量状态更新即使全失败也是 HTTP 200')
  if (steal.ok) {
    assert.equal(steal.data.success, 0)
    assert.equal(steal.data.failed[0]!.reason, 'status_conflict')
  }

  const afterClaim = await transport.call<LatticeIssue>('issueGet', { issueId })
  assert.equal(afterClaim.ok, true)
  if (afterClaim.ok) {
    assert.equal(afterClaim.data.status, 'accepted')
    assert.equal(afterClaim.data.assigneeInstance, '10.1.2.3:3080')
    assert.ok(afterClaim.data.assignedAt !== null)
  }

  // ⑦ 评论幂等：同 commentId 两次 → 同一条
  const commentId = `c-${Date.now()}`
  const firstComment = await transport.call<LatticeComment>('issueCommentAdd', { issueId }, {
    body: { content: '第一条评论', commentId, commentRole: 'assignee', commentAuthorType: 'agent' },
  })
  assert.equal(firstComment.ok, true, firstComment.ok ? '' : `${firstComment.code}: ${firstComment.reason}`)
  const secondComment = await transport.call<LatticeComment>('issueCommentAdd', { issueId }, {
    body: { content: '第一条评论', commentId },
  })
  assert.equal(secondComment.ok, true)
  if (firstComment.ok && secondComment.ok) {
    assert.equal(firstComment.data.id, secondComment.data.id, '同 commentId 必须返回已存在的那条')
    assert.equal(secondComment.data.content, '第一条评论')
  }

  const listed = await transport.call<LatticeComment[]>('issueCommentList', { issueId })
  assert.equal(listed.ok, true)
  if (listed.ok) assert.equal(listed.data.length, 1)

  // ⑧ 评论增量游标（全局）
  // 注意：协议原样回 `{ maxId }`；折成 `number` 是组合层 `latticeCommentCursor()` 的事（M2）
  const cursor = await transport.call<{ maxId: number }>('issueCommentCursor')
  assert.equal(cursor.ok, true)
  if (cursor.ok) assert.ok(cursor.data.maxId > 0)

  const increment = await transport.call<{ items: LatticeComment[]; nextSinceId: number; hasMore: boolean }>(
    'issueCommentListSince',
    {},
    { query: { sinceId: 0, limit: 10 } },
  )
  assert.equal(increment.ok, true)
  if (increment.ok) {
    assert.ok(increment.data.items.length >= 1)
    assert.ok(increment.data.nextSinceId >= increment.data.items.at(-1)!.id)
    assert.equal(typeof increment.data.hasMore, 'boolean')
  }

  // ⑨ 文件：raw 上传 → 挂附件（output → 线上 assignee）→ 列表映射回来 → 下载字节一致
  const bytes = Buffer.from('hello lattice', 'utf8')
  const uploaded = await transport.callRaw('fileUpload', {}, {
    body: bytes,
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent('联调 产物.txt'),
    },
  })
  assert.equal(uploaded.ok, true, uploaded.ok ? '' : `${uploaded.code}: ${uploaded.reason}`)
  if (!uploaded.ok) return
  const file = (await uploaded.data.json()) as LatticeFileInfo
  assert.equal(file.size, bytes.length)
  assert.match(file.fileId, /^[0-9a-f-]{36}$/)

  // 传输层看到的是**线上值** `assigner|assignee`；门面值 `input|output` 的映射在 M1 分组层（wire.toWireAttachmentType）
  const attached = await transport.call<{ count: number }>('issueAttachmentAdd', {}, {
    body: [{ issueId, fileId: file.fileId, type: 'assignee', fileName: '联调 产物.txt' }],
  })
  assert.equal(attached.ok, true, attached.ok ? '' : `${attached.code}: ${attached.reason}`)

  const attachments = await transport.call<LatticeAttachment[]>('issueAttachmentList', { issueId })
  assert.equal(attachments.ok, true)
  if (attachments.ok) {
    assert.equal(attachments.data.length, 1)
    assert.equal(attachments.data[0]!.type, 'assignee', '线上值是 assigner/assignee（门面映射在 M1 分组层做）')
  }

  const downloaded = await transport.callRaw('fileDownload', { fileId: file.fileId })
  assert.equal(downloaded.ok, true)
  if (downloaded.ok) {
    const buffer = Buffer.from(await downloaded.data.arrayBuffer())
    assert.deepEqual(buffer, bytes)
  }

  // ⑩ 工作区两种粒度（index 形状强校验）
  const indexRow = await transport.call<LatticeDeviceWorkspace>('workspaceUpsert', {}, {
    body: { instance: '10.1.2.3:3080', type: 'index', detail: '# 项目索引' },
  })
  assert.equal(indexRow.ok, true, indexRow.ok ? '' : `${indexRow.code}: ${indexRow.reason}`)
  if (indexRow.ok) {
    assert.equal(indexRow.data.type, 'index')
    assert.equal(indexRow.data.workspaceId, null)
  }

  const badShape = await transport.call('workspaceUpsert', {}, {
    body: { instance: '10.1.2.3:3080', type: 'index', detail: 'x', workspaceId: 'ws-1' },
  })
  assert.equal(badShape.ok, false)
  if (!badShape.ok) assert.equal(badShape.code, 'invalid_workspace_shape')

  const workspaces = await transport.call<LatticeDeviceWorkspace[]>('workspaceList', {}, {
    query: { type: 'index' },
  })
  assert.equal(workspaces.ok, true)
  if (workspaces.ok) assert.ok(workspaces.data.some((w) => w.instance === '10.1.2.3:3080'))

  // ⑪ 设备全量同步 + 在线列表
  const synced = await transport.call<{ synced: number; deactivated: number }>('deviceSync', {}, {
    body: { devices: [{ host: '10.1.2.3', port: 3080, os: 'linux' }] },
  })
  assert.equal(synced.ok, true, synced.ok ? '' : `${synced.code}: ${synced.reason}`)
  if (synced.ok) assert.ok(synced.data.synced >= 1)

  const devices = await transport.call<LatticeDevice[]>('deviceList')
  assert.equal(devices.ok, true)
  if (devices.ok) {
    assert.ok(devices.data.some((d) => d.host === '10.1.2.3' && d.port === 3080))
    assert.ok(devices.data.every((d) => d.status === 'active'))
  }

  // ⑫ 分页：page 与 pageNum 一致（issue 列表）
  const page = await transport.call<LatticeIssuePage>('issueList', {}, {
    query: { status: 'accepted', pageNum: 1, pageSize: 5 },
  })
  assert.equal(page.ok, true)
  if (page.ok) {
    assert.ok(page.data.total >= 1)
    assert.equal(page.data.pageNum, 1)
    assert.equal(page.data.pageSize, 5)
  }

  // ⑬ 局部覆盖：只改 urgency，其它字段不许被清空
  const patched = await transport.call<LatticeIssue>('issueReplace', { issueId }, {
    body: { urgency: 'relaxed' },
  })
  assert.equal(patched.ok, true, patched.ok ? '' : `${patched.code}: ${patched.reason}`)
  if (patched.ok) {
    assert.equal(patched.data.urgency, 'relaxed')
    assert.equal(patched.data.title, '联调 issue', '未传字段必须保留原值')
    assert.equal(patched.data.status, 'accepted', '未传 status 不许被重置')
    assert.equal(patched.data.assigneeInstance, '10.1.2.3:3080')
  }

  // ⑭ 管理面（administrator）：账号列表
  const accounts = await transport.call<LatticeTeamworkPage<LatticeAccount>>('adminAccounts', {}, {
    query: { pageNum: 1, pageSize: 10 },
  })
  assert.equal(accounts.ok, true)
  if (accounts.ok) assert.ok(accounts.data.items.some((a) => a.accountId === ACCOUNT))

  // ⑮ 健康检查（public）
  const health = await transport.call<LatticeHealth>('health')
  assert.equal(health.ok, true)
  if (health.ok) {
    assert.equal(health.data.ok, true)
    assert.ok(Number.isFinite(Date.parse(health.data.serverTime)))
  }
})

test('真机联调：错误归一（404 / unknown_field / 401 → login_required / 能力闸）', async () => {
  const missing = await transport.call<LatticeIssue>('issueGet', { issueId: 'not-exist-live' })
  assert.equal(missing.ok, false)
  if (!missing.ok) {
    assert.equal(missing.status, 404)
    assert.equal(missing.code, 'issue_not_found')
  }

  const unknownField = await transport.call('issueSubmit', {}, {
    body: [{ title: 'x', assignee: ACCOUNT, bogusField: 1 }],
  })
  assert.equal(unknownField.ok, false)
  if (!unknownField.ok) {
    assert.equal(unknownField.status, 400)
    assert.equal(unknownField.code, 'unknown_field')
  }

  // 错的 accountToken → guard 验签失败 → 401 unauthorized → 传输层折成 login_required 并清会话
  const badAuth = new LatticeAuth({ persist: false })
  badAuth.acceptSession({ accountId: ACCOUNT, accountToken: 'f'.repeat(64), ttlSeconds: 3600 })
  const badTransport = new LatticeTransport({
    baseUrl: `http://127.0.0.1:${server.port}/dsh-teamwork/v1`,
    auth: badAuth,
  })
  try {
    const denied = await badTransport.call<{ account: LatticeAccount }>('authMe')
    assert.equal(denied.ok, false)
    if (!denied.ok) {
      assert.equal(denied.status, 401)
      assert.equal(denied.code, 'login_required')
    }
    assert.equal(badAuth.headers(), null, '签名对不上要清内存会话')
  } finally {
    await badTransport.dispose()
  }

  // 能力闸：服务端没声明的端点 → unsupported，零请求
  const gated = new LatticeTransport({
    baseUrl: `http://127.0.0.1:${server.port}/dsh-teamwork/v1`,
    auth,
    capabilities: ['GET /projects/mine'],
  })
  try {
    const unsupported = await gated.call('issueGet', { issueId: 'x' })
    assert.equal(unsupported.ok, false)
    if (!unsupported.ok) assert.equal(unsupported.code, 'unsupported')

    const allowed = await gated.call<LatticeProject[]>('projectList')
    assert.equal(allowed.ok, true, allowed.ok ? '' : allowed.reason)
  } finally {
    await gated.dispose()
  }
})
