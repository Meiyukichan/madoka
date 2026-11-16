/** Issue：提交 / upsert / 查询 / 覆盖 / 遗弃 / 状态批量 / 评论 / 附件 / 来源 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootHarness, isCode, PASSWORD, signToken } from './helpers.js'
import type { TeamworkClient } from '../src/index.js'

test('提交：assigner 强制 = token 账号；返回顺序与入参一致', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  const bob = await h.register('bob')

  const ids = await alice.issues.create([
    { title: '第一条', assignee: 'bob' },
    { title: '第二条', assignee: 'bob', urgency: 'urgent' },
  ])
  assert.equal(ids.length, 2)
  const first = await bob.issues.get(ids[0]!)
  assert.equal(first.assigner, 'alice')
  assert.equal(first.status, 'pending')
  assert.equal(first.urgency, 'normal')
  assert.equal((await bob.issues.get(ids[1]!)).urgency, 'urgent')
})

test('提交：title 必填 / 长度；assignee 必须存在；枚举校验', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')

  await assert.rejects(() => alice.issues.create([{ title: '', assignee: 'alice' }]), isCode('invalid_title'))
  await assert.rejects(() => alice.issues.create([{ title: 'x'.repeat(201), assignee: 'alice' }]), isCode('invalid_title'))
  await assert.rejects(() => alice.issues.create([{ title: 't', assignee: 'ghost' }]), isCode('account_not_found'))
  await assert.rejects(
    () => alice.issues.create([{ title: 't', assignee: 'alice', urgency: 'oops' as never }]),
    isCode('invalid_urgency'),
  )
  await assert.rejects(
    () => alice.issues.create([{ title: 't', assignee: 'alice', permission: 'root' as never }]),
    isCode('invalid_permission'),
  )
  await assert.rejects(
    () => alice.issues.create([{ title: 't', assignee: 'alice', status: 'nope' as never }]),
    isCode('invalid_status'),
  )
})

test('提交：projectId 校验（存在 / 成员 / 未归档）', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const bob = await h.register('bob')
  const p = await admin.projects.create({ name: 'p' })

  await assert.rejects(
    () => bob.issues.create([{ title: 't', assignee: 'bob', projectId: p.id }]),
    isCode('not_project_member'),
  )
  await assert.rejects(
    () => issueWithMissingProject(admin),
    isCode('project_not_found'),
  )
  await admin.projects.update(p.id, { status: 'archived' })
  await assert.rejects(
    () => admin.issues.create([{ title: 't', assignee: 'alice', projectId: p.id }]),
    isCode('project_archived'),
  )
})

async function issueWithMissingProject(client: TeamworkClient): Promise<unknown> {
  return client.issues.create([{ title: 't', assignee: 'alice', projectId: 99999 }])
}

test('upsert：同 issueId 重复提交不新增，字段整体覆盖', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')

  const [id] = await alice.issues.create([{ issueId: 'fixed-1', title: '旧标题', assignee: 'alice' }])
  assert.equal(id, 'fixed-1')
  await alice.issues.create([{ issueId: 'fixed-1', title: '新标题', assignee: 'alice', detail: '正文' }])

  const list = await alice.issues.list()
  assert.equal(list.total, 1)
  const got = await alice.issues.get('fixed-1')
  assert.equal(got.title, '新标题')
  assert.equal(got.detail, '正文')
})

test('查询：分页 / status 过滤 / keyword / 404', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  await alice.issues.create([
    { title: '登录超时', assignee: 'alice' },
    { title: '导出失败', assignee: 'alice' },
    { title: '登录崩溃', assignee: 'alice', status: 'accepted' },
  ])

  assert.equal((await alice.issues.list()).total, 3)
  assert.equal((await alice.issues.list({ keyword: '登录' })).total, 2)
  assert.equal((await alice.issues.list({ status: 'accepted' })).total, 1)
  assert.equal((await alice.issues.list({ pageSize: 2 })).items.length, 2)
  await assert.rejects(() => alice.issues.get('ghost'), isCode('issue_not_found'))
})

test('全字段覆盖：只改传入字段，null 清空可空列', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  const [id] = await alice.issues.create([{ title: 't', assignee: 'alice', detail: '正文', cwd: 'D:/x' }])

  const updated = await alice.issues.overwrite(id!, { title: '新标题' })
  assert.equal(updated.title, '新标题')
  assert.equal(updated.detail, '正文', '未传字段保持原值')
  assert.equal(updated.cwd, 'D:/x')

  const cleared = await alice.issues.overwrite(id!, { detail: null })
  assert.equal(cleared.detail, null, '显式 null 清空')
})

test('遗弃：status=abandoned，行不删；二次幂等', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  const [id] = await alice.issues.create([{ title: 't', assignee: 'alice' }])
  await alice.issues.abandon(id!)
  assert.equal((await alice.issues.get(id!)).status, 'abandoned')
  await alice.issues.abandon(id!) // 幂等
  assert.equal((await alice.issues.list()).total, 1)
})

test('状态批量：部分成功 + expectedStatus 竞态 + reason 码', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  const [a, b] = await alice.issues.create([
    { title: 'A', assignee: 'alice' },
    { title: 'B', assignee: 'alice' },
  ])

  const first = await alice.issues.updateStatus([{ issueId: a!, status: 'accepted', expectedStatus: 'pending' }])
  assert.equal(first.success, 1)

  const mixed = await alice.issues.updateStatus([
    { issueId: a!, status: 'accepted', expectedStatus: 'pending' }, // 冲突
    { issueId: b!, status: 'accepted', expectedStatus: 'pending' }, // 成功
    { issueId: 'ghost', status: 'accepted' }, // not_found
    { issueId: b!, status: 'bogus' as never }, // invalid_status
    { issueId: b!, status: 'running', expectedStatus: 'bogus' as never }, // invalid_expected_status
  ])
  assert.equal(mixed.success, 1)
  const reasons = mixed.failed.map((f) => f.reason).sort()
  assert.deepEqual(reasons, ['invalid_expected_status', 'invalid_status', 'not_found', 'status_conflict'])
})

test('状态批量：不做状态机与角色校验（服务端只落库）', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  const bob = await h.register('bob')
  const [id] = await alice.issues.create([{ title: 't', assignee: 'alice' }])

  // 非参与者、非法转移（pending → success）也允许
  const r = await bob.issues.updateStatus([{ issueId: id!, status: 'success' }])
  assert.equal(r.success, 1)
  assert.equal((await alice.issues.get(id!)).status, 'success')
})

test('评论：幂等 + 增量游标 + 单 issue 列表', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  const [id] = await alice.issues.create([{ title: 't', assignee: 'alice' }])

  const c1 = await alice.comments.add(id!, { content: '第一条', commentId: 'c-1' })
  const c1again = await alice.comments.add(id!, { content: '第一条', commentId: 'c-1' })
  assert.equal(c1again.id, c1.id)
  const c2 = await alice.comments.add(id!, { content: '第二条' })
  assert.ok(c2.id > c1.id)

  const list = await alice.comments.list(id!)
  assert.deepEqual(list.map((x) => x.content), ['第一条', '第二条'])

  const cursor = await alice.comments.cursor()
  assert.equal(cursor.maxId, c2.id)

  const delta = await alice.comments.delta({ sinceId: c1.id, limit: 10 })
  assert.equal(delta.items.length, 1)
  assert.equal(delta.nextSinceId, c2.id)
  assert.equal(delta.hasMore, false)

  const empty = await alice.comments.delta({ sinceId: c2.id })
  assert.equal(empty.items.length, 0)
  assert.equal(empty.nextSinceId, c2.id, '空批游标不推进')
})

test('评论：内容校验 + 不存在的 issue', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  const [id] = await alice.issues.create([{ title: 't', assignee: 'alice' }])
  await assert.rejects(() => alice.comments.add(id!, { content: '' }), isCode('invalid_request'))
  await assert.rejects(() => alice.comments.add('ghost', { content: 'x' }), isCode('issue_not_found'))
})

test('附件：挂载 upsert + 按类型过滤 + invalid fileId / type', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')
  const [id] = await alice.issues.create([{ title: 't', assignee: 'alice' }])

  const file = await alice.files.upload(Buffer.from('hello'), { fileName: 'a.txt' })
  const r = await alice.attachments.add([{ issueId: id!, fileId: file.fileId, type: 'assigner', description: '输入' }])
  assert.equal(r.count, 1)

  const list = await alice.attachments.list(id!)
  assert.equal(list.length, 1)
  assert.equal(list[0]?.type, 'assigner')
  assert.equal((await alice.attachments.list(id!, 'assignee')).length, 0)

  await assert.rejects(
    () => alice.attachments.add([{ issueId: id!, fileId: 'not-a-uuid', type: 'assigner' }]),
    isCode('invalid_file_id'),
  )
  await assert.rejects(
    () => alice.attachments.add([{ issueId: id!, fileId: file.fileId, type: 'input' as never }]),
    isCode('invalid_type'),
  )
  // 不校验 fileId 是否存在（与契约一致）
  const ghost = await alice.attachments.add([{ issueId: id!, fileId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', type: 'assignee' }])
  assert.equal(ghost.count, 1)
})

test('来源字典：预置 / 格式约束 / upsert / administrator 改删', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const bob = await h.register('bob')

  const presets = (await admin.sources.list()).map((s) => s.code)
  assert.deepEqual(presets.sort(), ['dsh', 'im-group', 'self'])

  await bob.sources.register([{ code: 'custom-a', description: '自定义' }])
  const found = (await admin.sources.list('custom')).map((s) => s.code)
  assert.deepEqual(found, ['custom-a'])

  await assert.rejects(() => bob.sources.register([{ code: 'Bad' }]), isCode('invalid_source_code'))
  await assert.rejects(() => bob.sources.register([{ code: 'a--b' }]), isCode('invalid_source_code'))

  const src = (await admin.sources.list('custom-a'))[0]!
  await assert.rejects(() => bob.sources.update(src.id, { description: 'x' }), isCode('forbidden'))
  const updated = await admin.sources.update(src.id, { description: '改过了' })
  assert.equal(updated.description, '改过了')
  await admin.sources.remove(src.id)
  assert.equal((await admin.sources.list('custom-a')).length, 0)
  await assert.rejects(() => admin.sources.remove(src.id), isCode('source_not_found'))
})

test('严格请求体：身份字段不可传', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const alice = await h.register('alice')

  const res = await h.raw('POST', '/issues/batch', {
    body: [{ title: 't', assignee: 'alice', assigner: 'bob' }],
    token: signToken(alice.accountToken!, 'alice'),
    account: 'alice',
  })
  assert.equal(res.status, 400)
  assert.equal((res.body as { code: string }).code, 'unknown_field')
})


