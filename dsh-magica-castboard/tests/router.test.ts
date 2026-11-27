/**
 * router：候选优先级、失败退避、到上限放弃、孤儿复位、上下文压缩换会话、依赖门禁与直通。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_MAX_ATTEMPTS,
  IssueRouterService,
  type RouterSessionFace,
  type RouterTimers,
} from '../src/host/pipeline/router.ts'
import { IssueStore } from '../src/host/ledger/issue-store.ts'
import type { IssueDraft, IssueRecord } from '../src/host/model.ts'
import { tempRoot } from './helpers.ts'

function draft(overrides: Partial<IssueDraft> = {}): IssueDraft {
  return { title: '待规划', detail: '正文', workspaceId: 'ws-1', urgency: 'normal', ...overrides }
}

async function createIssue(store: IssueStore, overrides: Partial<IssueDraft> = {}): Promise<IssueRecord> {
  return await store.create(draft(overrides))
}

interface FakeSession {
  face: RouterSessionFace
  runs: Array<{ instruction: string; references: string }>
  disposed: number
  compact: () => void
}

function fakeSession(
  id: string,
  result: { ok: true } | { ok: false; error: string } = { ok: true },
  throwError?: string,
): FakeSession {
  const fake: FakeSession = {
    runs: [],
    disposed: 0,
    compact: () => {},
    face: {
      id,
      resumed: false,
      run: async (instruction, references) => {
        fake.runs.push({ instruction, references })
        if (throwError !== undefined) throw new Error(throwError)
        return result
      },
      dispose: async () => { fake.disposed += 1 },
    },
  }
  return fake
}

function fakeTimers(): RouterTimers & { scheduled: number[] } {
  const scheduled: number[] = []
  return {
    scheduled,
    set: (_run, delayMs) => { scheduled.push(delayMs); return scheduled.length },
    clear: () => {},
  }
}

const fixedNow = () => 1_000

function routedIssues(instruction: string): string | undefined {
  return /issueId: ([0-9a-f-]{36})/.exec(instruction)?.[1]
}

/**
 * 所有 issue 都在共享库：routing / abandoned 是必填的云端面，缺了 router 会拒绝本地改状态。
 * 这里记录调用，用例既能提供面，也能断言「云端先行」。
 */
function cloudFaces(): {
  routed: string[]
  abandoned: string[]
  issueRouting: (issueIds: readonly string[]) => Promise<void>
  issueAbandoned: (issueId: string) => Promise<void>
} {
  const routed: string[] = []
  const abandoned: string[] = []
  return {
    routed,
    abandoned,
    issueRouting: async issueIds => { routed.push(...issueIds) },
    issueAbandoned: async issueId => { abandoned.push(issueId) },
  }
}

test('候选：accepted 优先，其次按紧急度与创建时间', async (t) => {
  const root = tempRoot(t)
  const clock = { now: 1_000 }
  const issues = new IssueStore({ dir: root, now: () => clock.now })
  const pendingUrgent = await createIssue(issues, { urgency: 'urgent', createdAt: 1 })
  const acceptedRelaxed = await createIssue(issues, { urgency: 'relaxed', createdAt: 2 })
  await issues.update(acceptedRelaxed.id, draft => { draft.status = 'accepted' })
  const calls: string[] = []
  let index = 0
  const fake = fakeSession('session-1')
  const cloud = cloudFaces()
  const service = new IssueRouterService({
    issues,
    now: () => clock.now,
    timers: fakeTimers(),
    log: () => {},
    ...cloud,
    openSession: async () => {
      index += 1
      return fake.face
    },
  })
  // 一轮只派一条；两轮看顺序。
  await service.tick()
  calls.push(routedIssues(fake.runs[0]?.instruction ?? '') ?? '')
  await issues.update(acceptedRelaxed.id, draft => { draft.status = 'routing'; draft.assigneeTask = 't-1' })
  clock.now += 1
  await service.tick()
  calls.push(routedIssues(fake.runs[1]?.instruction ?? '') ?? '')
  assert.deepEqual(calls, [acceptedRelaxed.id, pendingUrgent.id])
  assert.equal(index, 1, '常驻会话只开一次')
  assert.deepEqual(cloud.routed, [acceptedRelaxed.id, pendingUrgent.id], '每次派活前都先推进云端 routing')
})

test('正常结束但尚未转卡：先给异步子代理 120s 宽限，不立刻重派', async (t) => {
  const root = tempRoot(t)
  const clock = { now: 1_000 }
  const issues = new IssueStore({ dir: root, now: () => clock.now })
  const created = await createIssue(issues)
  const fake = fakeSession('session-1', { ok: true })
  const cloud = cloudFaces()
  const service = new IssueRouterService({
    issues,
    now: () => clock.now,
    timers: fakeTimers(),
    log: () => {},
    ...cloud,
    openSession: async () => fake.face,
  })

  await service.tick()
  const issue = await issues.get(created.id)
  assert.equal(fake.runs.length, 1)
  assert.deepEqual(cloud.routed, [created.id])
  assert.equal(issue?.status, 'routing')
  assert.ok((issue?.routeNextTryAt ?? 0) >= clock.now + 120_000)

  clock.now += 60_000
  await service.tick()
  assert.equal(fake.runs.length, 1, '60s 退避期内不应重复 followup')

  clock.now += 61_000
  await service.tick()
  assert.equal(fake.runs.length, 2, '宽限期结束后仍未转卡才重试')
})

test('注入前失败：丢弃会话、attempts 归零，下一拍新会话注入完整材料', async (t) => {
  const root = tempRoot(t)
  const issues = new IssueStore({ dir: root })
  const created = await createIssue(issues)
  const broken = fakeSession('session-1', { ok: true }, 'agent handle not created yet')
  const fresh = fakeSession('session-2')
  let opens = 0
  const cloud = cloudFaces()
  const service = new IssueRouterService({
    issues,
    now: fixedNow,
    timers: fakeTimers(),
    log: () => {},
    ...cloud,
    openSession: async () => (opens++ === 0 ? broken.face : fresh.face),
  })

  await service.tick()
  let issue = await issues.get(created.id)
  assert.equal(issue?.status, 'pending')
  assert.equal(issue?.routeAttempts, 0)
  assert.equal(broken.disposed, 1, '注入失败的会话必须 dispose')
  assert.deepEqual(cloud.routed, [created.id], '注入失败也要先把云端标成 routing')

  await service.tick()
  issue = await issues.get(created.id)
  assert.equal(fresh.runs.length, 1)
  assert.ok(fresh.runs[0]!.references.length > 0, '新会话必须重新注入完整 references')
  assert.doesNotMatch(fresh.runs[0]!.instruction, /Continue with the issue/)
  assert.equal(issue?.status, 'routing')
  service.dispose()
})

test('SESSION_LIVE：放弃旧会话，下一拍新建', async (t) => {
  const root = tempRoot(t)
  const clock = { now: 1_000 }
  const issues = new IssueStore({ dir: root, now: () => clock.now })
  const created = await createIssue(issues)
  await issues.saveRouter({ sessionId: 'session-live' })
  const fresh = fakeSession('session-2')
  const opened: Array<string | undefined> = []
  const cloud = cloudFaces()
  const service = new IssueRouterService({
    issues,
    now: () => clock.now,
    timers: fakeTimers(),
    log: () => {},
    ...cloud,
    openSession: async (sessionId) => {
      opened.push(sessionId)
      if (opened.length === 1) {
        const error = new Error('session is still live')
        Object.assign(error, { code: 'SESSION_LIVE' })
        throw error
      }
      return fresh.face
    },
  })

  await service.tick()
  assert.deepEqual(opened, ['session-live'])
  assert.equal(fresh.runs.length, 0)
  assert.equal(issues.router().sessionId, '', 'live 的旧会话 id 必须清掉')
  assert.deepEqual(cloud.routed, [], '会话没开起来就不能先在云端标 routing')

  await service.tick()
  assert.deepEqual(opened, ['session-live', undefined])
  assert.equal(fresh.runs.length, 1)
  assert.deepEqual(cloud.routed, [created.id])
  service.dispose()
})

test('失败退避：未转换成功回 pending 并记录重试时刻，到上限改判 abandoned', async (t) => {
  const root = tempRoot(t)
  const clock = { now: 1_000 }
  const issues = new IssueStore({ dir: root, now: () => clock.now })
  const created = await createIssue(issues)
  const fake = fakeSession('session-1', { ok: false, error: '会话坏了' })
  const cloud = cloudFaces()
  const service = new IssueRouterService({
    issues,
    now: () => clock.now,
    timers: fakeTimers(),
    log: () => {},
    ...cloud,
    maxAttempts: 2,
    openSession: async () => fake.face,
  })

  await service.tick()
  let issue = await issues.get(created.id)
  assert.equal(issue?.status, 'pending')
  assert.equal(issue?.routeAttempts, 1)
  assert.equal(issue?.routeError, '会话坏了')
  assert.ok((issue?.routeNextTryAt ?? 0) > clock.now)
  assert.deepEqual(cloud.abandoned, [], '没到上限不放弃云端 issue')

  // 退避期内不再派
  clock.now += 1_000
  await service.tick()
  assert.equal(fake.runs.length, 1)

  // 退避期过后再失败一次 → 放弃
  clock.now += 120_000
  await service.tick()
  issue = await issues.get(created.id)
  assert.equal(fake.runs.length, 2)
  assert.match(fake.runs[1]?.instruction ?? '', /Continue with the issue/)
  assert.equal(fake.runs[1]?.references, '', '重试只注入 issueId 提醒，不重复完整 references')
  assert.equal(issue?.status, 'abandoned')
  assert.equal(issue?.routeAttempts, 2)
  assert.equal(issue?.routeNextTryAt, undefined)
  assert.deepEqual(cloud.abandoned, [created.id], '到上限先在云端放弃，再改本地镜像')
  assert.deepEqual(cloud.routed, [created.id, created.id], '每轮真正派活前都先标云端 routing')
})

test('孤儿复位：routing 但没有任务会回到 pending 并重新排队', async (t) => {
  const root = tempRoot(t)
  const issues = new IssueStore({ dir: root })
  const created = await createIssue(issues)
  await issues.update(created.id, draft => { draft.status = 'routing' })
  const fake = fakeSession('session-1')
  const cloud = cloudFaces()
  const service = new IssueRouterService({
    issues,
    now: fixedNow,
    timers: fakeTimers(),
    log: () => {},
    ...cloud,
    openSession: async () => fake.face,
  })
  await service.tick()
  assert.equal(fake.runs.length, 1)
  assert.deepEqual(cloud.routed, [created.id])
  assert.equal((await issues.get(created.id))?.status, 'routing')
  assert.ok((await issues.get(created.id))?.routeNextTryAt !== undefined, '这一轮没转换成功，保留 routing 等宽限期重试')
})

test('上下文压缩：下一拍销毁旧会话并新建', async (t) => {
  const root = tempRoot(t)
  const clock = { now: 1_000 }
  const issues = new IssueStore({ dir: root, now: () => clock.now })
  await createIssue(issues)
  const opened: FakeSession[] = []
  const opens: Array<string | undefined> = []
  let compact: (() => void) | undefined
  const service = new IssueRouterService({
    issues,
    now: () => clock.now,
    timers: fakeTimers(),
    log: () => {},
    ...cloudFaces(),
    openSession: async (sessionId, onCompacted) => {
      opens.push(sessionId)
      compact = onCompacted
      const fake = fakeSession(`session-${opened.length + 1}`)
      opened.push(fake)
      return fake.face
    },
  })
  await service.tick()
  assert.equal(opened.length, 1)
  compact?.()
  clock.now += 120_000
  await service.tick()
  assert.equal(opened.length, 2)
  assert.equal(opened[0]?.disposed, 1)
  assert.deepEqual(opens, [undefined, undefined])
})

test('依赖门禁：未 success 不派活、写退避与一次评论；满足后继续', async (t) => {
  const root = tempRoot(t)
  const clock = { now: 1_000 }
  const issues = new IssueStore({ dir: root, now: () => clock.now })
  const dependency = await createIssue(issues, { title: '前置' })
  await issues.update(dependency.id, draft => { draft.status = 'running' })
  const created = await createIssue(issues, { title: '依赖它' })
  await issues.update(created.id, draft => { draft.dependsOn = [dependency.id] })

  const comments: string[] = []
  const fake = fakeSession('session-1')
  const cloud = cloudFaces()
  const service = new IssueRouterService({
    issues,
    now: () => clock.now,
    timers: fakeTimers(),
    log: () => {},
    ...cloud,
    openSession: async () => fake.face,
    dependsOnStatuses: async ids => ids.map(id => ({ issueId: id, found: true, status: 'running' })),
    commentBlocked: async (issueId, body) => { comments.push(`${issueId}:${body}`) },
  })
  await service.tick()
  assert.equal(fake.runs.length, 0)
  assert.deepEqual(cloud.routed, [], '依赖阻塞时不能先标云端 routing')
  assert.ok(comments[0]?.includes(dependency.id))
  assert.equal((await issues.get(created.id))?.status, 'pending', '依赖阻塞不改状态')

  // 冷却期内不重复评论
  await service.tick()
  assert.equal(comments.length, 1)

  // 依赖完成 + 退避到点 → 派活
  await issues.update(dependency.id, draft => { draft.status = 'success' })
  clock.now += 31_000
  const ready = new IssueRouterService({
    issues,
    now: () => clock.now,
    timers: fakeTimers(),
    log: () => {},
    ...cloud,
    openSession: async () => fake.face,
    dependsOnStatuses: async ids => ids.map(id => ({ issueId: id, found: true, status: 'success' })),
  })
  await ready.tick()
  assert.equal(fake.runs.length, 1)
  assert.deepEqual(cloud.routed, [created.id])
})

test('依赖数超过上限直接阻塞，不查远端', async (t) => {
  const root = tempRoot(t)
  const issues = new IssueStore({ dir: root })
  const created = await createIssue(issues)
  await issues.update(created.id, draft => {
    draft.dependsOn = Array.from({ length: 51 }, (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`)
  })
  let probed = 0
  const fake = fakeSession('session-1')
  const service = new IssueRouterService({
    issues,
    now: fixedNow,
    timers: fakeTimers(),
    log: () => {},
    openSession: async () => fake.face,
    dependsOnStatuses: async () => { probed += 1; return [] },
  })
  await service.tick()
  assert.equal(probed, 0)
  assert.equal(fake.runs.length, 0)
})

test('直通：先准备现场材料；依赖阻塞时同拍跳到下一条', async (t) => {
  const root = tempRoot(t)
  const issues = new IssueStore({ dir: root })
  const dependency = '99999999-9999-4999-8999-999999999999'
  const blocked = await createIssue(issues, {
    urgency: 'direct',
    createdAt: 1,
    dependsOn: [dependency],
  })
  const runnable = await createIssue(issues, { urgency: 'direct', createdAt: 2 })

  const order: string[] = []
  const service = new IssueRouterService({
    issues,
    now: fixedNow,
    timers: fakeTimers(),
    log: () => {},
    openSession: async () => {
      throw new Error('direct must not open a router session')
    },
    dependsOnStatuses: async ids => ids.map(issueId => ({
      issueId,
      found: true,
      status: issueId === dependency ? 'running' : 'success',
    })),
    renderReferences: async issue => {
      order.push(`refs:${issue.id}`)
      return ''
    },
    directRoute: async issueId => {
      order.push(`direct:${issueId}`)
      return { kind: 'converted' }
    },
  })

  await service.tick()
  assert.deepEqual(order, [`refs:${runnable.id}`, `direct:${runnable.id}`])
  assert.equal((await issues.get(blocked.id))?.status, 'pending')
  assert.equal((await issues.get(runnable.id))?.status, 'pending')
})

test('runtime issue 永远不进入 router（交给 RuntimeCommandWorker）', async (t) => {
  const root = tempRoot(t)
  const issues = new IssueStore({ dir: root })
  const runtime = await createIssue(issues, { urgency: 'runtime', createdAt: 1 })
  let opened = 0
  const service = new IssueRouterService({
    issues,
    now: fixedNow,
    timers: fakeTimers(),
    log: () => {},
    openSession: async () => { opened += 1; return fakeSession('session-1').face },
  })
  await service.tick()
  assert.equal(opened, 0)
  assert.equal((await issues.get(runtime.id))?.status, 'pending')
})

test('runtime issue 在 routing 时不被 router 复位（由 RuntimeCommandWorker 收尾）', async (t) => {
  const root = tempRoot(t)
  const issues = new IssueStore({ dir: root })
  const runtime = await createIssue(issues, { urgency: 'runtime', createdAt: 1 })
  await issues.update(runtime.id, draft => { draft.status = 'routing' })
  const service = new IssueRouterService({
    issues,
    now: fixedNow,
    timers: fakeTimers(),
    log: () => {},
    openSession: async () => fakeSession('session-1').face,
  })
  await service.tick()
  assert.equal((await issues.get(runtime.id))?.status, 'routing')
})

test('自动规划关闭与租约主人闸门：一拍都不派', async (t) => {
  const root = tempRoot(t)
  const issues = new IssueStore({ dir: root })
  await createIssue(issues)
  const fake = fakeSession('session-1')
  const disabled = new IssueRouterService({
    issues,
    now: fixedNow,
    timers: fakeTimers(),
    log: () => {},
    openSession: async () => fake.face,
    enabled: () => false,
  })
  await disabled.tick()
  assert.equal(fake.runs.length, 0)

  const secondary = new IssueRouterService({
    issues,
    now: fixedNow,
    timers: fakeTimers(),
    log: () => {},
    openSession: async () => fake.face,
    isOwner: () => false,
  })
  await secondary.tick()
  assert.equal(fake.runs.length, 0)
})

test('现场材料失败时退回本地台账渲染', async (t) => {
  const root = tempRoot(t)
  const issues = new IssueStore({ dir: root })
  await createIssue(issues)
  const fake = fakeSession('session-1')
  const cloud = cloudFaces()
  const service = new IssueRouterService({
    issues,
    now: fixedNow,
    timers: fakeTimers(),
    log: () => {},
    ...cloud,
    openSession: async () => fake.face,
    renderReferences: async () => { throw new Error('network down') },
  })
  await service.tick()
  assert.equal(fake.runs.length, 1)
  assert.deepEqual(cloud.routed.length, 1)
  assert.ok(fake.runs[0]?.references.includes('castboard_issue_context'))
})

test('默认上限是 3 次', () => {
  assert.equal(DEFAULT_MAX_ATTEMPTS, 3)
})
