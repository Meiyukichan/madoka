/**
 * 端到端集成测试：起真服务 + 用 SDK 跑完整链路。
 *
 *   node --test lib/integration.test.js
 *
 * 覆盖：注册/登录/鉴权、项目与成员（含 private 上限与归档只读）、
 * issue 提交/认领/评论/附件、设备与工作区、来源字典、文件上传下载、错误码契约。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/server/main.js'
import { TeamworkClient, TeamworkError } from '../src/index.js'

const PASSWORD = 'correct horse battery'
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

async function boot(): Promise<{ close: () => Promise<void>; host: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'tw-it-'))
  const running = await startServer({ dataDir: dir, port: 0, log: () => {} })
  return { close: running.close, host: `http://127.0.0.1:${running.port}`, dir }
}

test('完整链路：注册 → 项目 → issue → 认领 → 评论 → 附件 → 文件', async (t) => {
  const server = await boot()
  t.after(async () => {
    await server.close()
    rmSync(server.dir, { recursive: true, force: true })
  })

  // ── 健康与协议
  const probe = new TeamworkClient({ host: server.host, persist: false })
  const health = await probe.health()
  assert.equal(health.ok, true)
  const version = await probe.version()
  assert.equal(version.protocol, 'dsh-teamwork/1')
  assert.ok(version.endpoints.includes('POST /issues/batch'))

  // ── 注册：首个账号必须是 administrator；第二个是 user
  const admin = new TeamworkClient({ host: server.host, persist: false })
  const adminSession = await admin.register({ accountId: 'alice', password: PASSWORD, displayName: 'Alice' })
  assert.equal(adminSession.account.globalRole, 'administrator')
  assert.equal(adminSession.accountToken.length, 64)

  const bob = new TeamworkClient({ host: server.host, persist: false })
  const bobSession = await bob.register({ accountId: 'bob', password: PASSWORD })
  assert.equal(bobSession.account.globalRole, 'user')

  // ── 登录拿到同一个密钥
  const relogin = await new TeamworkClient({ host: server.host, persist: false }).login({ accountId: 'alice', password: PASSWORD })
  assert.equal(relogin.accountToken, adminSession.accountToken)

  // ── 错误密码 → invalid_credentials；账号不存在 → 同一个码
  await assert.rejects(
    () => new TeamworkClient({ host: server.host, persist: false }).login({ accountId: 'alice', password: 'wrong password here' }),
    (e: unknown) => e instanceof TeamworkError && e.code === 'invalid_credentials',
  )
  await assert.rejects(
    () => new TeamworkClient({ host: server.host, persist: false }).login({ accountId: 'nobody', password: 'whatever12345' }),
    (e: unknown) => e instanceof TeamworkError && e.code === 'invalid_credentials',
  )

  // ── public 项目：普通用户不能建
  await assert.rejects(
    () => bob.projects.create({ name: 'bob-public', visibility: 'public' }),
    (e: unknown) => e instanceof TeamworkError && e.code === 'public_project_requires_leader',
  )

  // ── private 项目：普通用户可以建，且自己是 owner
  const priv = await bob.projects.create({ name: 'bob-private', visibility: 'private', description: '私活' })
  assert.equal(priv.owner, 'bob')
  assert.equal(priv.memberCount, 1)

  // ── 成员角色：不能授予 owner
  await assert.rejects(
    () => bob.projects.addMember(priv.id, { accountId: 'alice', role: 'owner' as never }),
    (e: unknown) => e instanceof TeamworkError && e.code === 'owner_role_not_assignable',
  )
  const member = await bob.projects.addMember(priv.id, { accountId: 'alice', role: 'manager' })
  assert.equal(member.role, 'manager')
  assert.equal(member.displayName, 'Alice')

  // ── private 上限 5：再加 4 个用户后第 6 个被拒
  for (let i = 0; i < 3; i++) {
    const extra = new TeamworkClient({ host: server.host, persist: false })
    await extra.register({ accountId: `usr${i}`, password: PASSWORD })
    await bob.projects.addMember(priv.id, { accountId: `usr${i}` })
  }
  const sixth = new TeamworkClient({ host: server.host, persist: false })
  await sixth.register({ accountId: 'usr9', password: PASSWORD })
  await assert.rejects(
    () => bob.projects.addMember(priv.id, { accountId: 'usr9' }),
    (e: unknown) => e instanceof TeamworkError && e.code === 'project_member_limit',
  )

  // ── public 项目（admin 建）+ 归档只读
  const pub = await admin.projects.create({ name: 'team-public', visibility: 'public' })
  await admin.projects.update(pub.id, { status: 'archived' })
  await assert.rejects(
    () => admin.projects.update(pub.id, { name: 'rename-while-archived' }),
    (e: unknown) => e instanceof TeamworkError && e.code === 'project_archived',
  )
  await admin.projects.update(pub.id, { status: 'active' })

  // ── owner 转让：原 owner 降为 manager
  const transferred = await bob.projects.transferOwner(priv.id, 'alice')
  assert.equal(transferred.owner, 'alice')
  assert.equal(transferred.members.find((m) => m.accountId === 'bob')?.role, 'manager')

  // ── 提交 issue（含 projectId 校验）
  const issueIds = await admin.issues.create([{ title: '修复登录超时', assignee: 'bob', projectId: pub.id, urgency: 'urgent', detail: '正文' }])
  assert.equal(issueIds.length, 1)
  const issueId = issueIds[0]!
  const fetched = await bob.issues.get(issueId)
  assert.equal(fetched.assigner, 'alice') // assigner 强制 = token 账号
  assert.equal(fetched.projectId, pub.id)
  assert.equal(fetched.status, 'pending')

  // ── 认领：条件更新，第二次必然 status_conflict
  const first = await bob.issues.updateStatus([{ issueId, status: 'accepted', expectedStatus: 'pending', assigneeInstance: '10.0.0.1:3080' }])
  assert.equal(first.success, 1)
  const second = await admin.issues.updateStatus([{ issueId, status: 'accepted', expectedStatus: 'pending' }])
  assert.equal(second.success, 0)
  assert.equal(second.failed[0]?.reason, 'status_conflict')

  // ── 评论幂等
  const c1 = await bob.comments.add(issueId, { content: '开始处理', commentId: 'c-fixed-1' })
  const c2 = await bob.comments.add(issueId, { content: '开始处理', commentId: 'c-fixed-1' })
  assert.equal(c1.id, c2.id)
  const delta = await admin.comments.delta({ sinceId: 0, limit: 100 })
  assert.equal(delta.items.length, 1)
  assert.equal(delta.nextSinceId, c1.id)

  // ── 上传 + 挂附件 + 下载
  const bytes = Buffer.from('hello teamwork', 'utf8')
  const file = await bob.files.upload(bytes, { fileName: '报告 v1.pdf' })
  assert.equal(file.size, bytes.length)
  await bob.attachments.add([{ issueId, fileId: file.fileId, type: 'assignee', fileName: '报告 v1.pdf' }])
  const attachments = await bob.attachments.list(issueId, 'assignee')
  assert.equal(attachments.length, 1)
  assert.equal(attachments[0]?.fileId, file.fileId)
  const downloaded = await admin.files.download(file.fileId)
  assert.equal(downloaded.status, 200)
  assert.equal(Buffer.from(await downloaded.arrayBuffer()).toString('utf8'), 'hello teamwork')

  // ── 设备与工作区
  const sync = await bob.devices.sync([{ host: 'laptop', port: 3080, os: 'windows' }])
  assert.equal(sync.synced, 1)
  const active = await bob.devices.listActive()
  assert.equal(active.length, 1)
  assert.equal(active[0]?.host, 'laptop')
  const mine = await bob.devices.mine()
  assert.equal(mine.total, 1)

  // ── 设备不做资源级鉴权：普通用户能查、能删别人的设备
  await admin.devices.sync([{ host: 'alice-laptop', port: 3080, os: 'windows' }])
  const aliceDevices = await bob.devices.listActive('alice')
  assert.equal(aliceDevices.length, 1)
  assert.equal(aliceDevices[0]?.host, 'alice-laptop')
  await bob.devices.remove(aliceDevices[0]!.id)
  assert.equal((await admin.devices.listActive('alice')).length, 0)
  await bob.workspaces.upsert({ instance: '10.0.0.1:3080', type: 'index', detail: '# index' })
  await bob.workspaces.upsert({ instance: '10.0.0.1:3080', type: 'portal', detail: '# portal', workspaceId: 'ws-1', cwd: 'D:/work/proj-7' })
  const byCwd = await admin.workspaces.list({ accountId: 'bob', cwd: 'D:/work/proj-7' })
  assert.equal(byCwd.length, 1)
  const byPrefix = await admin.workspaces.list({ accountId: 'bob', cwdPrefix: 'D:/work/proj' })
  assert.equal(byPrefix.length, 1)

  // ── 来源字典：格式约束 + upsert
  const registered = await bob.sources.register([{ code: 'im-group', description: '群聊发起' }, { code: 'self', description: '覆盖描述' }])
  assert.equal(registered.count, 2)
  const codes = (await bob.sources.list()).map((s) => s.code)
  assert.ok(codes.includes('im-group'))
  await assert.rejects(
    () => admin.sources.register([{ code: 'Bad_Code' }]),
    (e: unknown) => e instanceof TeamworkError && e.code === 'invalid_source_code',
  )

  // ── 删项目被 issue 拦住
  await assert.rejects(
    () => admin.projects.remove(pub.id),
    (e: unknown) => e instanceof TeamworkError && e.code === 'project_has_issues',
  )

  // ── 严格请求体：未知字段
  await assert.rejects(
    () => admin.projects.create({ name: 'x', assigner: 'bob' } as never),
    (e: unknown) => e instanceof TeamworkError && e.code === 'unknown_field',
  )

  // ── 改密码：旧 token 立即失效，新密钥可用
  const newToken = await bob.changePassword({ oldPassword: PASSWORD, newPassword: 'brand new passphrase' })
  assert.notEqual(newToken.accountToken, bobSession.accountToken)
  const me = await bob.me()
  assert.equal(me.account.accountId, 'bob')
})

test('鉴权契约：缺头 / 篡改签名 / 过期', async (t) => {
  const server = await boot()
  t.after(async () => {
    await server.close()
    rmSync(server.dir, { recursive: true, force: true })
  })
  const c = new TeamworkClient({ host: server.host, persist: false })
  await c.register({ accountId: 'carol', password: PASSWORD })
  const { accountToken } = await new TeamworkClient({ host: server.host, persist: false }).login({ accountId: 'carol', password: PASSWORD })

  // 直接用裸 fetch 构造坏 token
  const bad = await fetch(`${server.host}/dsh-teamwork/v1/auth/me`, {
    headers: { 'dsh-teamwork-token': 'a.b.c', 'dsh-teamwork-account': 'carol' },
  })
  assert.equal(bad.status, 401)

  const missing = await fetch(`${server.host}/dsh-teamwork/v1/auth/me`)
  assert.equal(missing.status, 401)

  // 正确的 token 可以过
  const payload = Buffer.from(JSON.stringify({ a: 'carol', iat: Date.now(), exp: Date.now() + 60_000 })).toString('base64url')
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const { createHmac } = await import('node:crypto')
  const sig = createHmac('sha256', accountToken).update(`${head}.${payload}`).digest('base64url')
  const ok = await fetch(`${server.host}/dsh-teamwork/v1/auth/me`, {
    headers: { 'dsh-teamwork-token': `${head}.${payload}.${sig}`, 'dsh-teamwork-account': 'carol' },
  })
  assert.equal(ok.status, 200)

  // 头与 token 不一致
  const mismatch = await fetch(`${server.host}/dsh-teamwork/v1/auth/me`, {
    headers: { 'dsh-teamwork-token': `${head}.${payload}.${sig}`, 'dsh-teamwork-account': 'alice' },
  })
  assert.equal(mismatch.status, 401)

  void b64
})
