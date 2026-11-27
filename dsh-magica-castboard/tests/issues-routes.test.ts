/**
 * issue 路由：建/读/改/放弃/删除/评论/已读、派出去的列表与在线建 issue，全部走真实路由表。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { issuesRoutes, type IssueRouteDeps } from '../src/host/http/routes/issues.ts'
import { matchPath, type Route, type RouteContext } from '../src/host/http/router.ts'
import { TaskStore } from '../src/host/ledger/task-store.ts'
import { IssueStore } from '../src/host/ledger/issue-store.ts'
import { LinkStore } from '../src/host/ledger/link-store.ts'
import { CommentStore } from '../src/host/ledger/comment-store.ts'
import { ThreadService } from '../src/host/pipeline/thread.ts'
import { TemplateStore } from '../src/host/ledger/template-store.ts'
import { castboardPaths } from '../src/host/ledger/paths.ts'
import { ExecutionService } from '../src/host/exec/engine.ts'
import { AcceptanceRunner } from '../src/host/exec/acceptance-runner.ts'
import type { CreateIssueBody, IssueDraft } from '../src/host/model.ts'
import { tempRoot } from './helpers.ts'

interface CallResult {
  status: number
  value: unknown
}

async function call(
  routes: readonly Route[],
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<CallResult> {
  const [pathname = ''] = path.split('?')
  for (const route of routes) {
    if (route.method !== method) continue
    const params = matchPath(route.path, pathname)
    if (params === undefined) continue
    const url = new URL(`http://x${path}`)
    const context: RouteContext = {
      req: {} as never,
      res: {} as never,
      params,
      query: url.searchParams,
      body: body as unknown,
      url,
    }
    const out = await route.handler(context)
    if (out !== null && typeof out === 'object' && 'status' in out && 'value' in out) {
      return out as CallResult
    }
    return { status: 200, value: out }
  }
  throw new Error(`没有匹配：${method} ${path}`)
}

function makeDeps(root: string, overrides: Partial<IssueRouteDeps> = {}): IssueRouteDeps {
  const tasks = new TaskStore({ dir: root })
  const issues = new IssueStore({ dir: root })
  const links = new LinkStore({ dir: root })
  const comments = new CommentStore({ dir: root })
  const thread = new ThreadService({ comments, links, now: () => 5_000 })
  const execution = new ExecutionService({ tasks, now: () => 5_000, hostInstanceId: 'host-1' })
  return {
    tasks,
    issues,
    links,
    comments,
    thread,
    execution,
    acceptance: new AcceptanceRunner({ execution }),
    templates: new TemplateStore(join(root, 'castboard-templates.json')),
    paths: castboardPaths(root),
    settings: { read: async () => ({}), stored: () => ({}), write: async () => ({}) },
    acceptanceStrategies: { list: async () => [], replace: async () => [] },
    customWorkspaces: {
      read: async () => ({ schemaVersion: 1, workspaces: {} }),
      replace: async () => ({ schemaVersion: 1, workspaces: {} }),
    },
    customStrategies: {
      read: async () => ({ schemaVersion: 1, strategies: [] }),
      replace: async () => ({ schemaVersion: 1, strategies: [] }),
    },
    instance: () => '127.0.0.1:3080',
    now: () => 5_000,
    isWritable: () => true,
    ownerHint: () => '127.0.0.1:3080',
    reload: async () => {},
    version: 'test',
    workspaces: { get: id => (id === 'ws-1' ? { id, path: 'D:/repo' } : undefined) },
    // 所有 issue 都在共享库：放弃/删除必须带云端面，缺了会 503。
    abandonRemote: async () => {},
    ...overrides,
  }
}

/** 本地镜像：所有 issue 都由云端同步而来，测试直接写镜像台账，不走建 issue 路由。 */
async function seedIssue(deps: IssueRouteDeps, overrides: Partial<IssueDraft> = {}): Promise<string> {
  const record = await deps.issues.create({
    title: '需求',
    detail: '正文',
    workspaceId: 'ws-1',
    urgency: 'relaxed',
    ...overrides,
  })
  return record.id
}

test('GET /issues：列出本地镜像的待规划，可用 status 过滤', async (t) => {
  const deps = makeDeps(tempRoot(t))
  const routes = issuesRoutes(deps)
  const pendingId = await seedIssue(deps)
  const doneId = await seedIssue(deps, { title: '已成功' })
  await deps.issues.update(doneId, draft => { draft.status = 'success' })

  const listed = await call(routes, 'GET', '/issues')
  assert.deepEqual((listed.value as { items: Array<{ id: string }> }).items.map(item => item.id), [pendingId])
  assert.equal((listed.value as { revision: number }).revision, deps.issues.revision())

  const done = await call(routes, 'GET', '/issues?status=success')
  assert.deepEqual((done.value as { items: Array<{ id: string }> }).items.map(item => item.id), [doneId])
})

test('GET /issues/mine：优先云端列表并按账号过滤，缺 face 回退本地', async (t) => {
  const cloudDeps = makeDeps(tempRoot(t), {
    auth: { status: () => ({ state: 'authenticated', accountId: 'me' }) } as never,
    issueList: async () => [
      { issueId: 'mine-1', title: '我创建的', status: 'pending', assigner: 'me', updatedAt: 10 },
      { issueId: 'other-1', title: '别人的', status: 'pending', assigner: 'other', assignee: 'other' },
    ],
  })
  const cloud = await call(issuesRoutes(cloudDeps), 'GET', '/issues/mine')
  assert.deepEqual(cloud.value, {
    items: [{ id: 'mine-1', title: '我创建的', status: 'pending', updatedAt: 10 }],
  })

  const localDeps = makeDeps(tempRoot(t))
  const localId = await seedIssue(localDeps)
  const local = await call(issuesRoutes(localDeps), 'GET', '/issues/mine')
  const localItems = (local.value as { items: Array<{ id: string }> }).items
  assert.deepEqual(localItems.map(item => item.id), [localId])
})

test('GET /issues/:id 与 /state：本地镜像详情、评论与 404', async (t) => {
  const deps = makeDeps(tempRoot(t))
  const routes = issuesRoutes(deps)
  const id = await seedIssue(deps)

  const detail = await call(routes, 'GET', `/issues/${id}`)
  assert.equal((detail.value as { title: string }).title, '需求')
  await assert.rejects(() => call(routes, 'GET', '/issues/-bad'), /无效的 issue id/)
  await assert.rejects(() => call(routes, 'GET', '/issues/11111111-1111-4111-8111-111111111111'), /issue 不存在/)

  const state = await call(routes, 'GET', `/issues/${id}/state`)
  assert.equal((state.value as { source: string }).source, 'mirror')
  assert.deepEqual((state.value as { comments: unknown[] }).comments, [])

  // 本机没有镜像时读云端；没有云端面就是诚实的 404。
  await assert.rejects(
    () => call(routes, 'GET', '/issues/11111111-1111-4111-8111-111111111111/state'),
    /共享库不可用/,
  )
  const cloud = issuesRoutes(makeDeps(tempRoot(t), {
    issueState: async () => ({ id: '11111111-1111-4111-8111-111111111111', title: '云端标题' }),
  }))
  const remoteState = await call(cloud, 'GET', '/issues/11111111-1111-4111-8111-111111111111/state')
  assert.equal((remoteState.value as { source: string }).source, 'cloud')
  assert.equal((remoteState.value as { issue: { title: string } }).issue.title, '云端标题')
})

test('评论与已读：POST comment 落 user 评论，mark-read 推 lastSeenAt', async (t) => {
  const deps = makeDeps(tempRoot(t))
  const routes = issuesRoutes(deps)
  const id = await seedIssue(deps)

  const commented = await call(routes, 'POST', `/issues/${id}/comment`, { body: '请补充', role: 'assigner' })
  assert.equal(commented.status, 201)
  const row = commented.value as { id: string; role: string | null; authorType: string; origin: string }
  // Human comments never carry a side: a caller-supplied role must not misroute them.
  assert.equal(row.role, null)
  assert.equal(row.authorType, 'user')
  assert.equal(row.origin, 'local')
  assert.equal(deps.links.get(id)?.lastCommentAt, 5_000)

  const read = await call(routes, 'POST', `/issues/${id}/read`)
  assert.equal((read.value as { lastSeenAt: number }).lastSeenAt, 5_000)
  assert.equal(deps.links.get(id)?.lastSeenAt, 5_000)
  await assert.rejects(() => call(routes, 'POST', `/issues/${id}/comment`, { body: '   ' }), /comment body/)
})

test('放弃与删除：先写云端再动本地镜像；已转任务的 issue 不许删', async (t) => {
  const abandonedRemotely: string[][] = []
  const deps = makeDeps(tempRoot(t), {
    abandonRemote: async issueIds => { abandonedRemotely.push([...issueIds]) },
  })
  const routes = issuesRoutes(deps)
  const firstId = await seedIssue(deps)
  await deps.tasks.mutate('task-created', (ledger) => {
    const task = {
      id: 't-1', title: '卡', detail: '', workspaceId: 'ws-1', urgency: 'normal' as const,
      status: 'todo' as const, blocked: false, execution: { mode: 'queue' as const },
      createdAt: 1, updatedAt: 1, createdBy: { kind: 'user' as const },
      updatedBy: { kind: 'user' as const }, executions: [],
    }
    ledger.tasks.push(task)
    return [task]
  })
  await deps.issues.transfer(firstId, 't-1')
  await assert.rejects(() => call(routes, 'DELETE', `/issues/${firstId}`), /已转成任务/)
  await assert.rejects(() => call(routes, 'POST', `/issues/${firstId}/abandon`), /已经是 routing/)
  assert.deepEqual(abandonedRemotely, [[firstId]], '放弃前先请求云端')

  const abandonId = await seedIssue(deps)
  const abandoned = await call(routes, 'POST', `/issues/${abandonId}/abandon`)
  assert.equal((abandoned.value as { status: string }).status, 'abandoned')
  assert.deepEqual(abandonedRemotely, [[firstId], [abandonId]])

  const secondId = await seedIssue(deps)
  await deps.issues.transfer(secondId, 't-missing')
  await call(routes, 'POST', `/issues/${secondId}/delete`)
  assert.equal(await deps.issues.get(secondId), undefined)
  assert.deepEqual(abandonedRemotely.at(-1), [secondId])
})

test('GET /issues/dispatched：按关系表列出派出去的 issue 与未读', async (t) => {
  const deps = makeDeps(tempRoot(t))
  const routes = issuesRoutes(deps)
  await deps.links.patch('22222222-2222-4222-8222-222222222222', {
    assignerSessionId: 'session-1',
    lastCommentAt: 10,
    lastSeenAt: 5,
    assigneeTaskId: 't-9',
  })
  await deps.links.patch('33333333-3333-4333-8333-333333333333', {
    assigneeSessionId: 'session-2',
  })

  const listed = await call(routes, 'GET', '/issues/dispatched')
  const value = listed.value as {
    issues: Array<{ issueId: string; hasUnread: boolean; assigneeTaskId?: string }>
    truncated: boolean
  }
  assert.equal(value.truncated, false)
  assert.deepEqual(value.issues.map(item => item.issueId), ['22222222-2222-4222-8222-222222222222'])
  assert.equal(value.issues[0]?.hasUnread, true)
  assert.equal(value.issues[0]?.assigneeTaskId, 't-9')
})

test('POST /issues：云端建 issue；能力缺席 400，接了 createRemote 回 201', async (t) => {
  const deps = makeDeps(tempRoot(t))
  const routes = issuesRoutes(deps)
  await assert.rejects(
    () => call(routes, 'POST', '/issues', { title: '线上', assignee: 'self' }),
    /共享库不可用/,
  )

  const drafts: CreateIssueBody[] = []
  const withRemote = issuesRoutes({
    ...deps,
    createRemote: async draft => {
      drafts.push(draft)
      return { issueId: '44444444-4444-4444-8444-444444444444', assignee: draft.assignee }
    },
  })
  await assert.rejects(
    () => call(withRemote, 'POST', '/issues', { title: '线上' }),
    /assignee 必填/,
  )
  assert.deepEqual(drafts, [], '缺必填字段时一个云端请求都不发')
  const created = withRemote.find(route => route.method === 'POST' && route.path === '/issues')
  assert.ok(created !== undefined)
  const result = await call(withRemote, 'POST', '/issues', {
    title: '线上',
    detail: '正文',
    assignee: 'self',
    assigneeInstance: '127.0.0.1:3080',
    cwd: 'D:/repo',
    urgency: 'urgent',
  })
  assert.equal(result.status, 201)
  assert.equal((result.value as { assignee: string }).assignee, 'self')
  assert.deepEqual(drafts, [{
    title: '线上',
    assignee: 'self',
    detail: '正文',
    assigneeInstance: '127.0.0.1:3080',
    cwd: 'D:/repo',
    urgency: 'urgent',
  }])

  const broken = issuesRoutes({ ...deps, createRemote: async () => ({ issueId: '../evil', assignee: 'self' }) })
  await assert.rejects(
    () => call(broken, 'POST', '/issues', { title: '线上', assignee: 'self' }),
    /非法的 issue id/,
  )
})

test('路由顺序：字面量 /issues/dispatched 不会被 :id 吃掉', async (t) => {
  const deps = makeDeps(tempRoot(t))
  const routes = issuesRoutes(deps)
  const listed = await call(routes, 'GET', '/issues/dispatched')
  assert.equal((listed.value as { issues: unknown[] }).issues.length, 0)
})
