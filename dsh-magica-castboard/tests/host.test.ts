/**
 * 宿主装配冒烟：`createRuntime` 拉起四本台账与路由表，跑通探活、任务、设置与 issue 端点。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createRuntime, ROUTE_PREFIX, type CastboardRuntime } from '../src/index.ts'
import { matchPath, type Route, type RouteContext } from '../src/host/http/router.ts'
import { tempRoot } from './helpers.ts'

async function call(
  runtime: CastboardRuntime,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; value: unknown }> {
  const [pathname = ''] = path.split('?')
  for (const route of runtime.routes as readonly Route[]) {
    if (route.method !== method) continue
    const params = matchPath(route.path, pathname)
    if (params === undefined) continue
    const url = new URL(`http://x${ROUTE_PREFIX}${path}`)
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
      return out as { status: number; value: unknown }
    }
    return { status: 200, value: out }
  }
  throw new Error(`没有匹配：${method} ${path}`)
}

async function boot(t: { after: (fn: () => void) => void }): Promise<CastboardRuntime> {
  const root = tempRoot(t)
  const runtime = await createRuntime({
    root,
    startOwner: false,
    instanceId: 'host-test',
    now: () => 1_000,
    listWorkspaces: () => [{ id: 'ws-1', path: 'D:/repo', title: 'repo' }],
  })
  t.after(() => { void runtime.dispose() })
  return runtime
}

test('探活：/version 报协议与端点清单，/health 报 owner 角色', async (t) => {
  const runtime = await boot(t)
  const version = await call(runtime, 'GET', '/version')
  const value = version.value as { protocol: string; endpoints: string[]; version?: string }
  assert.equal(value.protocol, 'dsh-castboard/1')
  assert.ok(value.endpoints.includes('GET /state'))
  assert.ok(value.endpoints.includes('POST /tasks/:id/move'))

  const health = await call(runtime, 'GET', '/health')
  const healthValue = health.value as { ok: boolean; role: string; instance: string }
  assert.equal(healthValue.ok, true)
  assert.equal(healthValue.role, 'owner')
  assert.equal(healthValue.instance, 'host-test')
})

test('data-plane：启动失败时把原因和配置文件路径暴露给面板', async (t) => {
  const runtime = await createRuntime({
    root: tempRoot(t),
    startOwner: false,
    instanceId: 'host-test',
    dataPlaneIssue: { reason: 'config.json 的 domain 不能是 0.0.0.0', configPath: 'C:/tmp/config.json' },
  })
  t.after(() => { void runtime.dispose() })
  assert.deepEqual((await call(runtime, 'GET', '/data-plane')).value, {
    ok: false,
    reason: 'config.json 的 domain 不能是 0.0.0.0',
    configPath: 'C:/tmp/config.json',
  })
})

test('认证：GET /auth、POST /auth/login、POST /auth/register、POST /auth/logout 走宿主 auth 面', async (t) => {
  const calls: string[] = []
  const runtime = await createRuntime({
    root: tempRoot(t),
    startOwner: false,
    instanceId: 'host-test',
    now: () => 1_000,
    faces: {
      missing: [],
      auth: {
        status: () => ({ state: 'anonymous' }),
        login: async input => {
          calls.push(`login:${input.accountId}`)
          return { state: 'authenticated', accountId: input.accountId }
        },
        register: async input => {
          calls.push(`register:${input.accountId}:${input.displayName ?? ''}`)
          return { state: 'authenticated', accountId: input.accountId }
        },
        logout: async () => {
          calls.push('logout')
          return { state: 'anonymous' }
        },
      },
    },
  })
  t.after(() => { void runtime.dispose() })

  assert.deepEqual((await call(runtime, 'GET', '/auth')).value, { state: 'anonymous' })
  assert.deepEqual((await call(runtime, 'POST', '/auth/login', { accountId: 'a-1', password: 'p' })).value, {
    state: 'authenticated', accountId: 'a-1',
  })
  assert.deepEqual((await call(runtime, 'POST', '/auth/register', {
    accountId: 'a-2', password: 'p', displayName: 'Alice',
  })).value, {
    state: 'authenticated', accountId: 'a-2',
  })
  assert.deepEqual((await call(runtime, 'POST', '/auth/logout')).value, { state: 'anonymous' })
  assert.deepEqual(calls, ['login:a-1', 'register:a-2:Alice', 'logout'])
})

test('任务：建卡 → /state → 详情 → 移动，revision 递增', async (t) => {
  const runtime = await boot(t)
  const created = await call(runtime, 'POST', '/tasks', {
    title: '装配冒烟',
    workspaceId: 'ws-1',
    urgency: 'urgent',
    detail: '正文',
    checklist: ['通过'],
  })
  assert.equal(created.status, 201)
  const task = created.value as { id: string; status: string }
  assert.equal(task.status, 'todo')

  const state = await call(runtime, 'GET', '/state')
  const board = state.value as {
    revision: number
    issueRevision: number
    tasks: Array<{ id: string; title: string; checklist?: { done: number; total: number } }>
  }
  assert.equal(board.revision, 1)
  assert.equal(board.issueRevision, 0)
  assert.deepEqual(board.tasks.map(row => row.id), [task.id])
  assert.deepEqual(board.tasks[0]?.checklist, { done: 0, total: 1 })

  const detail = await call(runtime, 'GET', `/tasks/${task.id}`)
  assert.equal((detail.value as { title: string }).title, '装配冒烟')

  const moved = await call(runtime, 'POST', `/tasks/${task.id}/move`, { status: 'canceled' })
  assert.equal((moved.value as { status: string }).status, 'canceled')
  const afterMove = await call(runtime, 'GET', '/state')
  assert.equal((afterMove.value as { revision: number }).revision, 2)
})

test('设置：默认值可读，整对象替换后立即生效', async (t) => {
  const runtime = await boot(t)
  const before = await call(runtime, 'GET', '/settings')
  const defaults = before.value as { maxConcurrent: number; autoRoute: boolean }
  assert.ok(defaults.maxConcurrent >= 1)

  const updated = await call(runtime, 'POST', '/settings/update', {
    maxConcurrent: 5,
    autoRoute: false,
    commentsEnabled: false,
  })
  const saved = updated.value as { maxConcurrent: number; autoRoute: boolean; commentsEnabled: boolean }
  assert.equal(saved.maxConcurrent, 5)
  assert.equal(saved.autoRoute, false)
  assert.equal(saved.commentsEnabled, false)

  const reread = await call(runtime, 'GET', '/settings')
  assert.equal((reread.value as { maxConcurrent: number }).maxConcurrent, 5)
  assert.equal(runtime.settings.get().maxConcurrent, 5)

  // 落盘位置：设置进 YAML；台账要不要带 settings 由 task-store 的用例守着。
  const file = runtime.settings.path
  assert.equal(file.endsWith('castboard.settings.yaml'), true, file)
  assert.equal(existsSync(file), true)
  assert.match(readFileSync(file, 'utf8'), /^maxConcurrent: 5$/m)
})

test('issue：本地镜像在列表里可见', async (t) => {
  const runtime = await boot(t)
  // 所有 issue 都由共享库同步而来：这里直接写本地镜像，不经过建 issue 路由。
  const issue = await runtime.issues.create({
    title: '待规划冒烟',
    workspaceId: 'ws-1',
    detail: '正文',
    urgency: 'relaxed',
  })
  assert.equal(issue.status, 'pending')

  const listed = await call(runtime, 'GET', '/issues')
  assert.deepEqual((listed.value as { items: Array<{ id: string }> }).items.map(row => row.id), [issue.id])
})

test('task 附件接口：无 issue 的任务返回空列表', async (t) => {
  const runtime = await boot(t)
  const created = await call(runtime, 'POST', '/tasks', { title: '无 issue', workspaceId: 'ws-1', urgency: 'normal' })
  const task = created.value as { id: string }
  const response = await call(runtime, 'GET', `/tasks/${encodeURIComponent(task.id)}/attachments`)
  assert.deepEqual(response.value, { taskId: task.id, items: [] })
})

test('task 附件接口：只返回 issue 目标（带 role/kind），comment 目标不混入', async (t) => {
  const root = tempRoot(t)
  const runtime = await createRuntime({
    root,
    startOwner: false,
    instanceId: 'host-test',
    now: () => 1_000,
    listWorkspaces: () => [{ id: 'ws-1', path: 'D:/repo', title: 'repo' }],
    faces: {
      missing: [],
      issueAttachmentList: async () => [],
      attachmentDownload: async fileId => new TextEncoder().encode(fileId),
    },
  })
  t.after(() => { void runtime.dispose() })
  const issue = await runtime.issues.create({ title: '附件', detail: '', workspaceId: 'ws-1', urgency: 'normal' })
  const commentId = '22222222-2222-4222-8222-222222222222'
  const dir = runtime.attachments.dirOf(issue.id)
  const inputPath = join(dir, 'input', 'brief.md')
  const outputPath = join(dir, 'output', 'report.md')
  const commentPath = join(dir, 'comments', commentId, 'shot.png')
  mkdirSync(join(dir, 'input'), { recursive: true })
  mkdirSync(join(dir, 'output'), { recursive: true })
  mkdirSync(join(dir, 'comments', commentId), { recursive: true })
  writeFileSync(inputPath, 'in')
  writeFileSync(outputPath, 'out')
  writeFileSync(commentPath, 'png')
  await runtime.attachments.put(issue.id, dir, [
    { name: 'brief.md', path: inputPath, targetType: 'issue', targetId: issue.id, role: 'assigner', state: 'ready' },
    { name: 'report.md', path: outputPath, targetType: 'issue', targetId: issue.id, role: 'assignee', state: 'ready' },
    { name: 'shot.png', path: commentPath, targetType: 'comment', targetId: commentId, role: 'assigner', state: 'ready' },
  ])

  const created = await call(runtime, 'POST', '/tasks', {
    title: '带 issue',
    workspaceId: 'ws-1',
    urgency: 'normal',
    issueId: issue.id,
  })
  const task = created.value as { id: string }
  const response = await call(runtime, 'GET', `/tasks/${encodeURIComponent(task.id)}/attachments`)
  const items = (response.value as { items: Array<Record<string, unknown>> }).items
  assert.deepEqual(
    items.map(item => [item['name'], item['targetType'], item['targetId'], item['role'], item['kind'], item['state']]),
    [
      ['brief.md', 'issue', issue.id, 'assigner', 'input', 'ready'],
      ['report.md', 'issue', issue.id, 'assignee', 'output', 'ready'],
    ],
  )
  for (const item of items) assert.equal('type' in item, false)
})

test('备份与诊断：备份文件落盘，诊断数一致', async (t) => {
  const runtime = await boot(t)
  await call(runtime, 'POST', '/tasks', { title: '一张', workspaceId: 'ws-1', urgency: 'normal' })
  const backup = await call(runtime, 'POST', '/backup')
  assert.equal(backup.status, 201)
  const file = (backup.value as { backupFile: string }).backupFile
  assert.equal(typeof file, 'string')

  const diagnostics = await call(runtime, 'GET', '/diagnostics')
  const value = diagnostics.value as { tasks: number; staleRunning: number; revision: number }
  assert.equal(value.tasks, 1)
  assert.equal(value.staleRunning, 0)
  assert.equal(value.revision, 1)
})
