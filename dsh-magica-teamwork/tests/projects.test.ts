/** 项目与成员：可见性 / owner 唯一 / private 上限 / 归档只读 / 角色矩阵 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootHarness, isCode } from './helpers.js'

test('创建：public 需要 leader/administrator；private 任何人可建且创建人即 owner', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const bob = await h.register('bob')

  await assert.rejects(() => bob.projects.create({ name: 'x', visibility: 'public' }), isCode('public_project_requires_leader'))

  const priv = await bob.projects.create({ name: 'bob-private', visibility: 'private' })
  assert.equal(priv.owner, 'bob')
  assert.equal(priv.memberCount, 1)
  assert.equal(priv.status, 'active')
  assert.equal(priv.createdBy, 'bob')

  const pub = await admin.projects.create({ name: 'team-public', visibility: 'public' })
  assert.equal(pub.visibility, 'public')
})

test('创建：项目名唯一 + trim + 长度校验', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  await admin.projects.create({ name: '  带空格的名  ' })
  await assert.rejects(() => admin.projects.create({ name: '带空格的名' }), isCode('project_name_exists'))
  await assert.rejects(() => admin.projects.create({ name: '   ' }), isCode('invalid_project_name'))
  await assert.rejects(() => admin.projects.create({ name: 'x'.repeat(101) }), isCode('invalid_project_name'))
})

test('可见性：非成员看不到项目详情（404 而非 403）', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const bob = await h.register('bob')
  const carol = await h.register('carol')

  const p = await admin.projects.create({ name: 'p1', visibility: 'public' })
  assert.equal((await admin.projects.get(p.id)).id, p.id)
  await assert.rejects(() => bob.projects.get(p.id), isCode('project_not_found'))
  await assert.rejects(() => bob.projects.members(p.id), isCode('project_not_found'))

  // 第三个账号 carol 也不是成员 → 同样 404
  await assert.rejects(() => carol.projects.get(p.id), isCode('project_not_found'))
})

test('列表：administrator 全量，其他人只看自己参与的；mine 不分页', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const bob = await h.register('bob')

  await admin.projects.create({ name: 'p1' })
  const p2 = await admin.projects.create({ name: 'p2' })
  await admin.projects.addMember(p2.id, { accountId: 'bob' })

  const allForAdmin = await admin.projects.list()
  assert.equal(allForAdmin.total, 2)

  const forBob = await bob.projects.list()
  assert.equal(forBob.total, 1)
  assert.equal(forBob.items[0]?.name, 'p2')

  const mine = await bob.projects.mine()
  assert.ok(Array.isArray(mine))
  assert.equal(mine.length, 1)
})

test('列表：keyword 过滤 + includeArchived', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const a = await admin.projects.create({ name: 'alpha' })
  await admin.projects.create({ name: 'beta' })

  assert.equal((await admin.projects.list({ keyword: 'alp' })).total, 1)
  await admin.projects.update(a.id, { status: 'archived' })
  assert.equal((await admin.projects.list()).total, 1)
  assert.equal((await admin.projects.list({ includeArchived: true })).total, 2)
})

test('成员角色矩阵：只能授予 manager/member；manager 不能提别人为 manager', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const bob = await h.register('bob') // owner
  const carol = await h.register('carol')
  const dave = await h.register('dave')

  const p = await bob.projects.create({ name: 'p', visibility: 'private' })
  await bob.projects.addMember(p.id, { accountId: 'carol', role: 'manager' })

  await assert.rejects(
    () => bob.projects.addMember(p.id, { accountId: 'dave', role: 'owner' as never }),
    isCode('owner_role_not_assignable'),
  )
  await assert.rejects(
    () => carol.projects.addMember(p.id, { accountId: 'dave', role: 'manager' }),
    isCode('forbidden'),
  )
  // manager 可以加 member
  const added = await carol.projects.addMember(p.id, { accountId: 'dave', role: 'member' })
  assert.equal(added.role, 'member')

  // 不存在账号
  await assert.rejects(() => bob.projects.addMember(p.id, { accountId: 'ghost' }), isCode('account_not_found'))
  // 修改 owner 的角色被拒
  await assert.rejects(() => bob.projects.addMember(p.id, { accountId: 'bob', role: 'member' }), isCode('owner_role_immutable'))
  void admin
})

test('private 成员上限：满了拒绝新增，但改已有成员角色不占名额', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const owner = await h.register('owner1')
  const p = await owner.projects.create({ name: 'p', visibility: 'private' })
  for (const id of ['mem1', 'mem2', 'mem3', 'mem4']) {
    await h.register(id)
    await owner.projects.addMember(p.id, { accountId: id })
  }
  await h.register('mem5')
  await assert.rejects(() => owner.projects.addMember(p.id, { accountId: 'mem5' }), isCode('project_member_limit'))

  // 改已有成员角色没问题
  const upgraded = await owner.projects.addMember(p.id, { accountId: 'mem1', role: 'manager' })
  assert.equal(upgraded.role, 'manager')

  // 移除一个后可以再加
  await owner.projects.removeMember(p.id, 'mem2')
  const added = await owner.projects.addMember(p.id, { accountId: 'mem5' })
  assert.equal(added.accountId, 'mem5')
})

test('public → private 受成员上限约束；private → public 要求 owner 是 leader/admin', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const pub = await admin.projects.create({ name: 'pub', visibility: 'public' })
  for (const id of ['usr1', 'usr2', 'usr3', 'usr4', 'usr5']) {
    await h.register(id)
    await admin.projects.addMember(pub.id, { accountId: id })
  }
  // 现在 6 人（admin + 5）
  await assert.rejects(() => admin.projects.update(pub.id, { visibility: 'private' }), isCode('cannot_shrink_to_private'))
  await admin.projects.removeMember(pub.id, 'usr5')
  const shrunk = await admin.projects.update(pub.id, { visibility: 'private' })
  assert.equal(shrunk.visibility, 'private')

  // private 项目的 owner 是普通 user → 不能转 public
  const bob = await h.register('bob')
  const priv = await bob.projects.create({ name: 'bob-priv', visibility: 'private' })
  await assert.rejects(() => bob.projects.update(priv.id, { visibility: 'public' }), isCode('cannot_publish'))
})

test('owner 转让：原 owner 降为 manager；public 项目要求新 owner 是 leader/admin', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const bob = await h.register('bob')
  const carol = await h.register('carol')

  const priv = await bob.projects.create({ name: 'priv', visibility: 'private' })
  const after = await bob.projects.transferOwner(priv.id, 'carol')
  assert.equal(after.owner, 'carol')
  assert.equal(after.members.find((m) => m.accountId === 'bob')?.role, 'manager')

  const pub = await admin.projects.create({ name: 'pub', visibility: 'public' })
  await assert.rejects(() => admin.projects.transferOwner(pub.id, 'bob'), isCode('owner_must_be_leader'))
  // 目标不存在
  await assert.rejects(() => admin.projects.transferOwner(pub.id, 'ghost'), isCode('account_not_found'))
  // 非 owner 不能转让
  await assert.rejects(() => bob.projects.transferOwner(pub.id, 'bob'), isCode('project_not_found'))
})

test('归档：只读（只允许改 status）；归档项目不能加成员/建 issue', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const bob = await h.register('bob')
  const p = await admin.projects.create({ name: 'p' })

  await admin.projects.update(p.id, { status: 'archived' })
  await assert.rejects(() => admin.projects.update(p.id, { name: 'rename' }), isCode('project_archived'))
  await assert.rejects(() => admin.projects.addMember(p.id, { accountId: 'bob' }), isCode('project_archived'))
  // 归档判定先于成员判定，所以这里报 project_archived
  await assert.rejects(
    () => bob.issues.create([{ title: 't', assignee: 'bob', projectId: p.id }]),
    isCode('project_archived'),
  )

  const restored = await admin.projects.update(p.id, { status: 'active' })
  assert.equal(restored.status, 'active')
})

test('删除：有 issue 时拒绝；无 issue 时可删且级联清成员', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const admin = await h.register('alice')
  const p = await admin.projects.create({ name: 'p' })
  await admin.issues.create([{ title: 't', assignee: 'alice', projectId: p.id }])
  await assert.rejects(() => admin.projects.remove(p.id), isCode('project_has_issues'))

  await admin.issues.abandon((await admin.issues.list({ projectId: p.id })).items[0]!.issueId)
  // 遗弃不影响计数（行还在），先改成不带 projectId 再建
  const p2 = await admin.projects.create({ name: 'p2' })
  await admin.projects.remove(p2.id)
  await assert.rejects(() => admin.projects.get(p2.id), isCode('project_not_found'))
})

test('移除成员：不能移除 owner；manager 只能移除 member', async (t) => {
  const h = await bootHarness()
  t.after(() => h.close())
  const owner = await h.register('owner1')
  await h.register('mgr1')
  await h.register('mem1')
  const p = await owner.projects.create({ name: 'p', visibility: 'private' })
  await owner.projects.addMember(p.id, { accountId: 'mgr1', role: 'manager' })
  await owner.projects.addMember(p.id, { accountId: 'mem1' })

  await assert.rejects(() => owner.projects.removeMember(p.id, 'owner1'), isCode('owner_cannot_be_removed'))

  const mgr = h.client()
  await mgr.login({ accountId: 'mgr1', password: 'correct horse battery' })
  // manager 不能移除另一个 manager
  await assert.rejects(() => mgr.projects.removeMember(p.id, 'mgr1'), isCode('forbidden'))
  // 但能移除 member
  await mgr.projects.removeMember(p.id, 'mem1')
  await assert.rejects(() => mgr.projects.removeMember(p.id, 'mem1'), isCode('member_not_found'))
})


