/**
 * 原子层对真服务：8 个分组的公开方法逐条打真 HTTP。
 *
 * 重点验证两处"必须由分组层做"的加工（设计文档 §16.8 的两行）：
 *  1. `issue.comment.cursor()` 把协议 `{ maxId }` 折成 `number`；
 *  2. 附件按 `targetType + targetId + role` 存取，行原样返回（没有门面翻译）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CastboardClient, CastboardProjectDetail } from '../src/sdk/index.js'
import { bootServer, makeClient, registeredClient } from './sdk-helpers.js'

let baseUrl = ''
let cleanup: () => Promise<void>
let alice: CastboardClient
let projectId = 0

before(async () => {
  const booted = await bootServer()
  baseUrl = booted.baseUrl
  cleanup = booted.cleanup
  alice = await registeredClient(baseUrl, 'atomic-alice')
})

after(async () => {
  assert.equal(typeof cleanup, 'function')
  await cleanup()
})

test('原子层：账号 / 项目 / issue / 评论 / 来源 / 附件 / 工作区 / 设备 / 文件 / 运维', async () => {
  // ── ops：协议 + 能力探测 ──────────────────────────────────────────────
  const version = await alice.ops.version()
  assert.equal(version.ok, true)
  if (version.ok) assert.equal(version.data.endpoints.length, 49)

  const probed = await alice.ops.probe()
  assert.equal(probed.ok, true)

  const health = await alice.ops.health()
  assert.equal(health.ok, true)

  // ── auth：注册自动登录 → me ────────────────────────────────────────────
  assert.equal(alice.state, 'authenticated')
  const me = await alice.auth.me()
  assert.equal(me.ok, true, me.ok ? '' : `${me.code}: ${me.reason}`)
  if (me.ok) {
    assert.equal(me.data.accountId, 'atomic-alice')
    assert.equal(me.data.globalRole, 'administrator')
  }

  // ── teamwork.project：建项目 → 详情 → 列表 → 局部更新 ─────────────────
  const created = await alice.teamwork.project.create({ name: '原子层项目', visibility: 'private' })
  assert.equal(created.ok, true, created.ok ? '' : `${created.code}: ${created.reason}`)
  if (!created.ok) return
  const project: CastboardProjectDetail = created.data
  projectId = project.id
  assert.equal(project.members.length, 1)

  // owner 不可指定（零请求）
  const withOwner = await alice.teamwork.project.create({ name: '另一个', owner: 'someone-else' })
  assert.equal(withOwner.ok, false)
  if (!withOwner.ok) assert.equal(withOwner.code, 'invalid_body')

  const detail = await alice.teamwork.project.detail(projectId)
  assert.equal(detail.ok, true)

  const minePage = await alice.teamwork.project.mine()
  assert.equal(minePage.ok, true)
  if (minePage.ok) {
    assert.equal(minePage.data.pageNum, 1, '裸数组要包成分页信封')
    assert.ok(minePage.data.items.some((p) => p.id === projectId))
  }

  const emptyUpdate = await alice.teamwork.project.update(projectId, {})
  assert.equal(emptyUpdate.ok, false)
  if (!emptyUpdate.ok) assert.equal(emptyUpdate.code, 'invalid_body')

  const updated = await alice.teamwork.project.update(projectId, { description: '改过' })
  assert.equal(updated.ok, true)
  if (updated.ok) assert.equal(updated.data.description, '改过')

  // ── file：上传（raw body）→ 下载 → 别名 ────────────────────────────────
  const bytes = Buffer.from('atomic payload', 'utf8')
  const uploadedFile = await alice.file.upload({ name: '原子.txt', data: bytes })
  assert.equal(uploadedFile.ok, true, uploadedFile.ok ? '' : `${uploadedFile.code}: ${uploadedFile.reason}`)
  if (!uploadedFile.ok) return
  const fileId = uploadedFile.data.fileId

  const downloadedAgain = await alice.file.download(fileId)
  assert.equal(downloadedAgain.ok, true)
  if (downloadedAgain.ok) assert.deepEqual(downloadedAgain.data, bytes)

  const publicAlias = await alice.file.downloadPublic(fileId)
  assert.equal(publicAlias.ok, true, 'downloadPublic 是 download 的别名')

  const badFileId = await alice.file.download('not-a-uuid')
  assert.equal(badFileId.ok, false)
  if (!badFileId.ok) assert.equal(badFileId.code, 'invalid_file_id')

  // ── issue：submit → get → list → 状态 ─────────────────────────────────
  const issueId = `atomic-${Date.now()}`
  const submitted = await alice.issue.submit([
    { issueId, title: '原子层 issue', assignee: 'atomic-alice', projectId, dependsOn: [] },
  ])
  assert.equal(submitted.ok, true, submitted.ok ? '' : `${submitted.code}: ${submitted.reason}`)

  const got = await alice.issue.get(issueId)
  assert.equal(got.ok, true)
  if (got.ok) {
    assert.deepEqual(got.data.dependsOn, [], 'dependsOn 读回必须是 string[]（不是 null/字符串）')
    assert.equal(got.data.title, '原子层 issue')
  }

  const listed = await alice.issue.list({ status: 'pending', pageSize: 5 })
  assert.equal(listed.ok, true)
  if (listed.ok) {
    assert.equal(listed.data.page, listed.data.pageNum, 'page 与 pageNum 恒等')
    assert.ok(Array.isArray(listed.data.items))
  }

  const statusUpdated = await alice.issue.updateStatuses([
    { issueId, status: 'accepted', expectedStatus: 'pending', assigneeInstance: '10.0.0.9:3080' },
  ])
  assert.equal(statusUpdated.ok, true)
  if (statusUpdated.ok) assert.equal(statusUpdated.data.success, 1)

  const conflict = await alice.issue.updateStatuses([{ issueId, status: 'accepted', expectedStatus: 'pending' }])
  assert.equal(conflict.ok, true)
  if (conflict.ok) {
    assert.equal(conflict.data.success, 0)
    assert.equal(conflict.data.failed[0]!.reason, 'status_conflict')
  }

  // ── attachment：目标 issue / 角色 assigner|assignee，行原样返回 ──────
  const attached = await alice.issue.attachment.add([
    { targetType: 'issue', targetId: issueId, fileId, role: 'assignee', fileName: '原子.txt', description: '产物' },
  ])
  assert.equal(attached.ok, true, attached.ok ? '' : `${attached.code}: ${attached.reason}`)
  if (attached.ok) assert.equal(attached.data.count, 1)

  const attachments = await alice.issue.attachment.list({ targetType: 'issue', targetId: issueId })
  assert.equal(attachments.ok, true)
  if (attachments.ok) {
    assert.equal(attachments.data.length, 1)
    assert.equal(attachments.data[0]!.role, 'assignee')
    assert.equal(attachments.data[0]!.targetType, 'issue')
    assert.equal(attachments.data[0]!.targetId, issueId)
  }

  const assignerOnly = await alice.issue.attachment.list({ targetType: 'issue', targetId: issueId, role: 'assigner' })
  assert.equal(assignerOnly.ok, true)
  if (assignerOnly.ok) assert.equal(assignerOnly.data.length, 0, 'role 过滤必须生效')

  // 直接看原始响应，证明线上就是同名字段（没有门面翻译）
  const rawList = await alice.raw(`/attachments?targetType=issue&targetId=${encodeURIComponent(issueId)}`)
  assert.equal(rawList.ok, true)
  if (rawList.ok) {
    const raw = (await rawList.data.json()) as Array<{ role: string; targetType: string; targetId: string }>
    assert.equal(raw[0]!.role, 'assignee')
    assert.equal(raw[0]!.targetType, 'issue')
    assert.equal(raw[0]!.targetId, issueId)
  }

  // ── comment：cursor 折 number + 幂等 + 增量 ───────────────────────────
  const comment = await alice.issue.comment.add(issueId, { content: '原子层评论', commentId: `c-${issueId}` })
  assert.equal(comment.ok, true, comment.ok ? '' : `${comment.code}: ${comment.reason}`)

  const cursor = await alice.issue.comment.cursor()
  assert.equal(cursor.ok, true)
  if (cursor.ok) assert.ok(cursor.data > 0, 'cursor 必须是 number 且 > 0')

  const since = await alice.issue.comment.listSince({ sinceId: 0, limit: 10 })
  assert.equal(since.ok, true)
  if (since.ok) assert.ok(since.data.items.length >= 1)

  const comments = await alice.issue.comment.list(issueId)
  assert.equal(comments.ok, true)
  if (comments.ok) assert.equal(comments.data.length, 1)

  // ── source：注册（非法 code 本地拦）→ 查 ─────────────────────────────
  const badSource = await alice.issue.source.register([{ code: 'BadCode' }])
  assert.equal(badSource.ok, false)
  if (!badSource.ok) assert.equal(badSource.code, 'invalid_source_code')

  const registered = await alice.issue.source.register([{ code: 'atomic-source', pluginName: 'test' }])
  assert.equal(registered.ok, true)
  const sources = await alice.issue.source.list('atomic-source')
  assert.equal(sources.ok, true)
  if (sources.ok) assert.ok(sources.data.some((s) => s.code === 'atomic-source'))

  // ── workspace：index / portal 形状 + 列表 ─────────────────────────────
  const indexRow = await alice.issue.workspace.upsert({ instance: '10.0.0.9:3080', type: 'index', detail: '# 索引' })
  assert.equal(indexRow.ok, true, indexRow.ok ? '' : `${indexRow.code}: ${indexRow.reason}`)

  const badShape = await alice.issue.workspace.upsert({
    instance: '10.0.0.9:3080',
    type: 'index',
    detail: 'x',
    workspaceId: 'ws-1',
  } as never)
  assert.equal(badShape.ok, false)
  if (!badShape.ok) assert.equal(badShape.code, 'invalid_workspace_shape')

  const portalRow = await alice.issue.workspace.upsert({
    instance: '10.0.0.9:3080',
    workspaceId: 'ws-1',
    cwd: 'D:/proj',
    type: 'portal',
    detail: '# 肖像',
  })
  assert.equal(portalRow.ok, true)

  const workspaces = await alice.issue.workspace.list({ type: 'portal', instance: '10.0.0.9:3080' })
  assert.equal(workspaces.ok, true)
  if (workspaces.ok) assert.equal(workspaces.data.length, 1)

  // ── device：同步 → 在线列表；teamwork.device.mine 分页 ────────────────
  const synced = await alice.device.sync([{ host: '10.0.0.9', port: 3080, os: 'linux' }])
  assert.equal(synced.ok, true)
  if (synced.ok) assert.ok(synced.data.synced >= 1)

  const devices = await alice.device.list()
  assert.equal(devices.ok, true)
  if (devices.ok) assert.ok(devices.data.every((d) => d.status === 'active'))

  const mineDevices = await alice.teamwork.device.mine({ pageNum: 1, pageSize: 10 })
  assert.equal(mineDevices.ok, true)
  if (mineDevices.ok) assert.ok(mineDevices.data.items.length >= 1)

  // ── project 只读视图 ──────────────────────────────────────────────────
  const myProjects = await alice.project.list()
  assert.equal(myProjects.ok, true)
  if (myProjects.ok) assert.ok(myProjects.data.some((p) => p.id === projectId))

  const members = await alice.project.members(projectId)
  assert.equal(members.ok, true)

  // ── admin：账号列表（administrator）───────────────────────────────────
  const accounts = await alice.admin.accounts({ pageNum: 1, pageSize: 10 })
  assert.equal(accounts.ok, true)
  if (accounts.ok) assert.ok(accounts.data.items.some((a) => a.accountId === 'atomic-alice'))

  // ── file 删除 + issue 遗弃（收尾）────────────────────────────────────
  const removedFile = await alice.file.remove(fileId)
  assert.equal(removedFile.ok, true, removedFile.ok ? '' : `${removedFile.code}: ${removedFile.reason}`)

  const abandoned = await alice.issue.abandon(issueId)
  assert.equal(abandoned.ok, true)

  const afterAbandon = await alice.issue.get(issueId)
  assert.equal(afterAbandon.ok, true)
  if (afterAbandon.ok) assert.equal(afterAbandon.data.status, 'abandoned')
})

test('原子层：未登录 client 的 signed 端点 → login_required（零请求）', async () => {
  const anonymous = makeClient(baseUrl)
  const result = await anonymous.castboardMyProjects()
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'login_required')
    assert.equal(result.status, 401)
  }
})
