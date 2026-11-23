/**
 * 组合层对真服务：**24 个语义方法 + E1** 的协同闭环。
 *
 * 剧本 = 设计文档 §16.7 的裁剪版（两人 / 两实例 / 一个外部来源）：
 *   派活四步 → 创建（带附件/来源/dependsOn）→ 认领仲裁 → 进规划 → 回填 → 执行 → 收尾
 *   → 评论双向 → 产物回拉 → 依赖门禁 → 工作区上报 → E1
 *
 * 这里断言的都是**协同根基**，不是"能不能调到"。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CastboardClient } from '../src/sdk/index.js'
import { bootServer, makeClient, registeredClient } from './sdk-helpers.js'

const BOB_INSTANCE = '10.9.9.9:3090'
const ALICE_INSTANCE = '10.8.8.8:3080'

let baseUrl = ''
let cleanup: () => Promise<void>
let workdir = ''
let alice: CastboardClient
let bob: CastboardClient
let projectId = 0
let issueId = ''
let inputPath = ''
let outputPath = ''

before(async () => {
  const booted = await bootServer()
  baseUrl = booted.baseUrl
  cleanup = booted.cleanup

  workdir = mkdtempSync(join(tmpdir(), 'dsh-teamwork-composite-'))
  inputPath = join(workdir, 'input.txt')
  outputPath = join(workdir, 'output.txt')
  writeFileSync(inputPath, '输入材料', 'utf8')
  writeFileSync(outputPath, '执行产物', 'utf8')

  alice = await registeredClient(baseUrl, 'comp-alice')
  await registeredClient(baseUrl, 'comp-bob')

  // 换成"带显式实例"的 client（模拟两台机器），同一个账号重新登录一次
  alice = makeClient(baseUrl, { instance: ALICE_INSTANCE, userId: 'comp-alice' })
  const aliceLogin = await alice.auth.login({ accountId: 'comp-alice', password: 'correct horse battery' })
  assert.equal(aliceLogin.ok, true, aliceLogin.ok ? '' : `${aliceLogin.code}: ${aliceLogin.reason}`)

  bob = makeClient(baseUrl, { instance: BOB_INSTANCE, userId: 'comp-bob' })
  const login = await bob.auth.login({ accountId: 'comp-bob', password: 'correct horse battery' })
  assert.equal(login.ok, true, login.ok ? '' : `${login.code}: ${login.reason}`)
})

after(async () => {
  await cleanup()
  rmSync(workdir, { recursive: true, force: true })
})

test('组合层：派活 → 创建 → 认领仲裁 → 规划 → 回填 → 执行 → 收尾 → 评论/产物回拉', async () => {
  // ① 派活第 1 步：我参与的项目
  const project = await alice.teamwork.project.create({ name: '协同项目', visibility: 'private' })
  assert.equal(project.ok, true, project.ok ? '' : `${project.code}: ${project.reason}`)
  if (!project.ok) return
  projectId = project.data.id

  const memberAdded = await alice.teamwork.project.memberAdd(projectId, { accountId: 'comp-bob', role: 'manager' })
  assert.equal(memberAdded.ok, true, memberAdded.ok ? '' : `${memberAdded.code}: ${memberAdded.reason}`)

  const myProjects = await alice.castboardMyProjects()
  assert.equal(myProjects.ok, true)
  if (myProjects.ok) assert.ok(myProjects.data.some((p) => p.id === projectId))

  // ② 派活第 2 步：能派活的人（owner + manager，bob 是 manager）
  const members = await alice.castboardProjectMembers(projectId, { manager: true })
  assert.equal(members.ok, true, members.ok ? '' : `${members.code}: ${members.reason}`)
  if (members.ok) {
    const ids = members.data.map((m) => m.accountId).sort()
    assert.deepEqual(ids, ['comp-alice', 'comp-bob'])
  }

  // ③ 派活第 3 步：bob 的实例（先上报设备）
  const bobDevice = await bob.device.sync([{ host: '10.9.9.9', port: 3090, os: 'linux' }])
  assert.equal(bobDevice.ok, true)
  const bobDevices = await alice.castboardUserDevices('comp-bob')
  assert.equal(bobDevices.ok, true)
  if (bobDevices.ok) assert.ok(bobDevices.data.some((d) => `${d.host}:${d.port}` === BOB_INSTANCE))

  // ④ 派活第 4 步：bob 那台机器的项目索引（先上报）
  const index = await bob.castboardUpsertWorkspaceIndex({ detail: '# comp-bob 的索引' })
  assert.equal(index.ok, true, index.ok ? '' : `${index.code}: ${index.reason}`)
  if (index.ok) assert.equal(index.data.type, 'index')

  const indexes = await alice.castboardWorkspaceIndexes('comp-bob')
  assert.equal(indexes.ok, true)
  if (indexes.ok) assert.ok(indexes.data.some((row) => row.instance === BOB_INSTANCE))

  // ⑤ 来源字典 + 创建（带附件、dependsOn、source）
  const source = await alice.castboardAddIssueSource({ code: 'comp-source', pluginName: 'composite-test' })
  assert.equal(source.ok, true, source.ok ? '' : `${source.code}: ${source.reason}`)

  issueId = `comp-${Date.now()}`
  const created = await alice.issueCreate({
    issueId,
    title: '组合层 issue',
    detail: '正文（应被保留）',
    assignee: 'comp-bob',
    projectId,
    source: 'comp-source',
    dependsOn: ['dep-fake'],
    attachments: [{ path: inputPath, role: 'assigner', description: '现场材料' }],
  })
  assert.equal(created.ok, true, created.ok ? '' : `${created.code}: ${created.reason}`)
  if (!created.ok) return
  assert.equal(created.data.attachments.length, 1)
  assert.equal(created.data.attachments[0]!.role, 'assigner', 'issueCreate 附件默认/显式角色都是 assigner')
  assert.equal(created.data.attachments[0]!.targetType, 'issue')
  assert.equal(created.data.skipped, false)
  assert.deepEqual(created.data.issue.dependsOn, ['dep-fake'], 'dependsOn 必须是 string[]')
  assert.equal(created.data.issue.assigner, 'comp-alice', 'assigner 由 token 决定')
  assert.equal(created.data.issue.source, 'comp-source')

  // ⑥ 重放同一个 issueId：默认 skip（不许把 accepted 打回 pending）
  const replay = await alice.issueCreate({
    issueId,
    title: '组合层 issue',
    assignee: 'comp-bob',
    projectId,
  })
  assert.equal(replay.ok, true)
  if (replay.ok) {
    assert.equal(replay.data.skipped, true, 'D13：撞已有 issueId 默认跳过')
    assert.equal(replay.data.issue.status, 'pending')
  }

  // ⑦ bob 拉本机待办：应当能看到这条 + unclaimed
  const bobPending = await bob.castboardMyInstanceIssues({ status: 'pending' })
  assert.equal(bobPending.ok, true, bobPending.ok ? '' : `${bobPending.code}: ${bobPending.reason}`)
  if (bobPending.ok) {
    assert.ok(bobPending.data.items.some((i) => i.issueId === issueId), '本机待办里应有这条')
    assert.ok(bobPending.data.unclaimed.some((i) => i.issueId === issueId), 'pending 且未写实例 → unclaimed')
    assert.equal(bobPending.data.instance, BOB_INSTANCE)
    assert.equal(bobPending.data.userId, 'comp-bob')
  }

  // ⑧ 认领仲裁：两个 client 同时抢 → 恰好一个成功
  const [claimA, claimB] = await Promise.all([alice.issueClaim([issueId]), bob.issueClaim([issueId])])
  assert.equal(claimA.ok, true)
  assert.equal(claimB.ok, true)
  const claimedCount = (claimA.ok ? claimA.data.claimed.length : 0) + (claimB.ok ? claimB.data.claimed.length : 0)
  assert.equal(claimedCount, 1, '并发认领只能成功一个')
  const loser = claimA.ok && claimA.data.claimed.length === 0 ? claimA : claimB
  if (loser.ok) {
    assert.equal(loser.data.failed[0]!.reason, 'status_conflict')
  }

  const executor = claimA.ok && claimA.data.claimed.length === 1 ? alice : bob
  const claimedIssue = await executor.issue.get(issueId)
  assert.equal(claimedIssue.ok, true)
  if (claimedIssue.ok) {
    assert.equal(claimedIssue.data.status, 'accepted')
    assert.equal(claimedIssue.data.assigneeInstance, executor === alice ? ALICE_INSTANCE : BOB_INSTANCE)
  }

  // ⑨ 进规划 → 回填（转成 task）
  const routing = await executor.issueRouting([issueId])
  assert.equal(routing.ok, true)
  if (routing.ok) assert.deepEqual(routing.data.routed, [issueId])

  const routed = await executor.issueRouted(issueId, {
    assigneeTask: 'task-1',
    cwd: 'D:/proj',
    urgency: 'urgent',
    assignerMeta: { title: '组合层 issue', detail: '回填的诉求' },
  })
  assert.equal(routed.ok, true, routed.ok ? '' : `${routed.code}: ${routed.reason}`)
  if (routed.ok) {
    assert.equal(routed.data.status, 'routing')
    assert.equal(routed.data.assigneeTask, 'task-1')
    assert.equal(routed.data.assignee, 'comp-bob')
    // 关键：回填不许把其它字段清空
    assert.equal(routed.data.title, '组合层 issue')
    assert.equal(routed.data.detail, '正文（应被保留）')
    assert.deepEqual(routed.data.dependsOn, ['dep-fake'])
  }

  // 状态门：非 accepted/routing 时本地拒绝
  const gate = await executor.issueRouted(issueId, {
    assigneeTask: 'task-2',
    cwd: 'D:/proj',
    assignerMeta: { title: 'x', detail: 'y' },
  })
  assert.equal(gate.ok, true, 'routing 状态仍可再回填（幂等场景）')

  const running = await executor.issueRunning(issueId)
  assert.equal(running.ok, true)
  if (running.ok) assert.equal(running.data.status, 'running')

  const blocked = await executor.issueRouted(issueId, {
    assigneeTask: 'task-3',
    cwd: 'D:/proj',
    assignerMeta: { title: 'x', detail: 'y' },
  })
  assert.equal(blocked.ok, false, 'running 之后不能再回填')
  if (!blocked.ok) assert.equal(blocked.code, 'invalid_request')

  // ⑩ 收尾：先上传产物再改状态
  const finalized = await executor.issueFinalize(issueId, {
    status: 'success',
    assigneeMeta: { summary: '做完', changedFiles: ['a.ts'], checks: ['ok'] },
    attachments: [{ path: outputPath, role: 'assignee' }],
  })
  assert.equal(finalized.ok, true, finalized.ok ? '' : `${finalized.code}: ${finalized.reason}`)
  if (finalized.ok) {
    assert.equal(finalized.data.issue.status, 'success')
    assert.equal(finalized.data.attachments.length, 1)
    assert.equal(finalized.data.attachments[0]!.role, 'assignee')
  }

  // ⑪ 评论双向 + 幂等
  const commentId = `c-${issueId}`
  const firstComments = await executor.castboardAddIssueComments(issueId, [
    { commentId, content: '执行中，需要确认', commentRole: 'assignee', commentAuthorType: 'agent' },
  ])
  assert.equal(firstComments.ok, true, firstComments.ok ? '' : `${firstComments.code}: ${firstComments.reason}`)
  if (firstComments.ok) assert.equal(firstComments.data.written, 1)

  const replayComment = await executor.castboardAddIssueComments(issueId, [
    { commentId, content: '执行中，需要确认', commentRole: 'assignee', commentAuthorType: 'agent' },
  ])
  assert.equal(replayComment.ok, true, '同 commentId 重放必须幂等成功')

  const comments = await alice.castboardIssueComments(issueId)
  assert.equal(comments.ok, true)
  if (comments.ok) assert.equal(comments.data.length, 1, '幂等后仍只有一条评论')

  const cursor = await alice.castboardCommentCursor()
  assert.equal(cursor.ok, true)
  if (cursor.ok) assert.ok(cursor.data > 0)

  const since = await alice.castboardCommentsSince({ sinceId: 0, limit: 100 })
  assert.equal(since.ok, true)
  if (since.ok) assert.ok(since.data.items.length >= 1)

  // ⑫ 产物回拉（只取 assignee；assigner 的输入件不该被当产物）
  const outDir = join(workdir, 'products')
  mkdirSync(outDir, { recursive: true })
  const downloaded = await alice.castboardDownloadIssueAttachments(issueId, outDir, { role: 'assignee' })
  assert.equal(downloaded.ok, true, downloaded.ok ? '' : `${downloaded.code}: ${downloaded.reason}`)
  if (downloaded.ok) {
    assert.equal(downloaded.data.downloaded.length, 1)
    assert.equal(downloaded.data.failed.length, 0)
    assert.equal(downloaded.data.downloaded[0]!.attachment.role, 'assignee')
    assert.equal(downloaded.data.downloaded[0]!.size, Buffer.byteLength('执行产物'))
  }

  // 不传 role = 两种角色都要（assigner 的输入件 + assignee 的产物）
  const allDir = join(workdir, 'products-all')
  mkdirSync(allDir, { recursive: true })
  const allDownloaded = await alice.castboardDownloadIssueAttachments(issueId, allDir)
  assert.equal(allDownloaded.ok, true, allDownloaded.ok ? '' : `${allDownloaded.code}: ${allDownloaded.reason}`)
  if (allDownloaded.ok) {
    assert.equal(allDownloaded.data.downloaded.length, 2)
    assert.deepEqual(
      allDownloaded.data.downloaded.map((item) => item.attachment.role).sort(),
      ['assignee', 'assigner'],
    )
  }

  // ⑬ E1：依赖门禁（存在 + 不存在 → null）
  const statuses = await alice.castboardIssueStatuses({ issueIds: [issueId, 'does-not-exist'] })
  assert.equal(statuses.ok, true, statuses.ok ? '' : `${statuses.code}: ${statuses.reason}`)
  if (statuses.ok) {
    assert.equal(statuses.data[issueId], 'success')
    assert.equal(statuses.data['does-not-exist'], null)
  }

  // ⑭ 工作区门户：上报 → 查询
  const portal = await bob.castboardUpsertWorkspacePortal({
    workspaceId: 'ws-comp',
    cwd: 'D:/proj',
    detail: '# 门户说明',
  })
  assert.equal(portal.ok, true, portal.ok ? '' : `${portal.code}: ${portal.reason}`)

  // 查别人的肖像必须显式给 userId（缺省是本机账号）
  const found = await alice.castboardWorkspacePortal({ workspaceId: 'ws-comp', instance: BOB_INSTANCE, userId: 'comp-bob' })
  assert.equal(found.ok, true)
  if (found.ok) {
    assert.ok(found.data !== null, '应当查到刚上报的肖像')
    assert.equal(found.data?.cwd, 'D:/proj')
  }

  const missingPortal = await alice.castboardWorkspacePortal({ workspaceId: 'ws-none', instance: BOB_INSTANCE, userId: 'comp-bob' })
  assert.equal(missingPortal.ok, true)
  if (missingPortal.ok) assert.equal(missingPortal.data, null)
})

test('组合层：单条状态更新 / 放弃 / 校验前置 / 能力闸', async () => {
  const secondId = `comp2-${Date.now()}`
  const created = await alice.issueCreate({ issueId: secondId, title: '第二条', assignee: 'comp-alice' })
  assert.equal(created.ok, true)

  const bad = await alice.issueCreate({ assignee: 'comp-alice' })
  assert.equal(bad.ok, false, '缺 title → 本地拒绝')
  if (!bad.ok) assert.equal(bad.status, 400)

  const badAssignee = await alice.issueCreate({ title: 'x', assignee: 'comp-alice', assigner: 'someone-else' })
  assert.equal(badAssignee.ok, false, 'D18：assigner 必须等于当前账号')
  if (!badAssignee.ok) assert.equal(badAssignee.code, 'invalid_body')

  const badCwd = await alice.issueCreate({ title: 'x', assignee: 'comp-alice', cwd: 'a'.repeat(501) })
  assert.equal(badCwd.ok, false)
  if (!badCwd.ok) assert.equal(badCwd.code, 'invalid_request')

  const updated = await alice.issueUpdateStatus({ issueId: secondId, status: 'accepted', expectedStatus: 'pending' })
  assert.equal(updated.ok, true)
  if (updated.ok) assert.equal(updated.data.status, 'accepted')

  const badDatetime = await alice.issueUpdateStatus({ issueId: secondId, status: 'routing', assignedAt: '2025-06-16 10:12:30' })
  assert.equal(badDatetime.ok, false)
  if (!badDatetime.ok) assert.equal(badDatetime.code, 'invalid_datetime')

  const abandoned = await alice.issueAbandon([secondId])
  assert.equal(abandoned.ok, true)
  if (abandoned.ok) assert.deepEqual(abandoned.data.abandoned, [secondId])

  const abandonedAgain = await alice.issueAbandon([secondId])
  assert.equal(abandonedAgain.ok, true, '已是终态时服务端仍接受（不做终态校验）')

  // 本地校验：非法 issueId（含空格）→ 零请求
  const gated = makeClient(baseUrl)
  await gated.auth.login({ accountId: 'comp-alice', password: 'correct horse battery' })
  const gatedResult = await gated.castboardIssueStatuses({ issueIds: ['x'.repeat(101)] })
  assert.equal(gatedResult.ok, false, '非法 issueId 先被本地拦')
  if (!gatedResult.ok) assert.equal(gatedResult.code, 'invalid_issue_id')
})

test('组合层：issue 列表翻页 + 本机待办的 truncated/maxPages', async () => {
  const pageResult = await alice.issue.list({ pageNum: 1, pageSize: 2 })
  assert.equal(pageResult.ok, true)
  if (pageResult.ok) {
    assert.equal(pageResult.data.pageSize, 2)
    assert.ok(pageResult.data.total >= 1)
  }

  const capped = await bob.castboardMyInstanceIssues({ maxPages: 1, pageSize: 1 })
  assert.equal(capped.ok, true)
  if (capped.ok) {
    assert.ok(capped.data.pages <= 1)
    assert.equal(typeof capped.data.truncated, 'boolean')
  }
})
