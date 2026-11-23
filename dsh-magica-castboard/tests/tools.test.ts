/**
 * 工具面：新入口的注册形状与关键写路径（建卡、认领、评论、执行报告、issue 转换）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { castboardTools } from '../src/host/tools/task-tools.ts'
import { buildIssueDispatchTools } from '../src/host/tools/issue-tools.ts'
import { issueTaskTools } from '../src/host/tools/issue-task.ts'
import { issueCommentTools } from '../src/host/tools/issue-comment.ts'
import { TaskStore } from '../src/host/ledger/task-store.ts'
import { IssueStore } from '../src/host/ledger/issue-store.ts'
import { LinkStore } from '../src/host/ledger/link-store.ts'
import { CommentStore } from '../src/host/ledger/comment-store.ts'
import { ThreadService } from '../src/host/pipeline/thread.ts'
import type { TaskRecord } from '../src/host/model.ts'
import { taskRecord, tempRoot } from './helpers.ts'

interface CallableTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

function byName(tools: readonly unknown[], name: string): CallableTool {
  const found = (tools as CallableTool[]).find(tool => tool.name === name)
  assert.ok(found !== undefined, `缺少工具 ${name}`)
  return found
}

function execContext(cwd = 'D:/repo', sessionId = 'session-1'): unknown {
  return { agent: { id: sessionId, session: { id: sessionId, header: { cwd } } } }
}

interface Fixture {
  tasks: TaskStore
  issues: IssueStore
  links: LinkStore
  comments: CommentStore
  thread: ThreadService
}

function fixture(root: string): Fixture {
  const tasks = new TaskStore({ dir: root })
  const issues = new IssueStore({ dir: root })
  const links = new LinkStore({ dir: root })
  const comments = new CommentStore({ dir: root })
  const thread = new ThreadService({ comments, links, now: () => 1_000 })
  return { tasks, issues, links, comments, thread }
}

function workspaces(ids: Record<string, string> = { 'D:/repo': 'ws-1' }) {
  return {
    resolveByPath: async (path: string) => {
      const id = ids[path]
      return id === undefined ? undefined : { id }
    },
    get: (id: string) => {
      const path = Object.keys(ids).find(key => ids[key] === id)
      return path === undefined ? undefined : { id, path, title: path }
    },
    list: () => Object.entries(ids).map(([path, id]) => ({ id, path, title: path })),
  }
}

function taskDeps(input: {
  fixture: Fixture
  getWorkspaceIds?: Record<string, string>
}): Parameters<typeof castboardTools>[0] {
  return {
    store: input.fixture.tasks,
    workspaces: workspaces(input.getWorkspaceIds),
    thread: input.fixture.thread,
    now: () => 2_000,
  }
}

async function seedTask(tasks: TaskStore, record: TaskRecord): Promise<void> {
  await tasks.mutate('task-created', (ledger) => {
    ledger.tasks.push(record)
    return [record]
  })
}

test('工具注册：任务 10 个、issue 8 个、转换 1 个、评论 1 个，名称不重复', async (t) => {
  const rootless = fixture(tempRoot(t))
  const taskNames = castboardTools(taskDeps({ fixture: rootless })).map(tool => tool.name)
  assert.deepEqual(taskNames, [
    'castboard_list',
    'castboard_get',
    'castboard_create',
    'castboard_update',
    'castboard_move',
    'castboard_comment_add',
    'castboard_comments',
    'castboard_delete',
    'castboard_checklist',
    'castboard_execution_report',
  ])
  assert.equal(new Set(taskNames).size, taskNames.length)

  const dispatchNames = buildIssueDispatchTools({
    tasks: rootless.tasks,
    issues: rootless.issues,
    comments: rootless.comments,
    thread: rootless.thread,
    now: () => 1,
  }).map(tool => tool.name)
  assert.deepEqual(dispatchNames, [
    'castboard_issues_help',
    'castboard_issue_groups',
    'castboard_issue_group_members',
    'castboard_issue_devices',
    'castboard_issue_workspaces',
    'castboard_issue_state',
    'castboard_issue_links',
    'castboard_issues_create',
  ])
  assert.equal(issueTaskTools({
    issues: rootless.issues,
    store: rootless.tasks,
    now: () => 1,
    resolveWorkspace: async () => undefined,
  })[0]?.name, 'castboard_issue_task')
  assert.equal(issueCommentTools({
    links: rootless.links,
    tasks: rootless.tasks,
    thread: rootless.thread,
  })[0]?.name, 'castboard_issue_comment_add')
})

test('castboard_create：校验项目、清单与来源 issue', async (t) => {
  const root = tempRoot(t)
  const kit = fixture(root)
  const create = byName(castboardTools(taskDeps({ fixture: kit })), 'castboard_create')

  const result = await create.execute({
    title: '  新卡  ',
    workspaceId: 'ws-1',
    urgency: 'urgent',
    detail: '正文',
    checklist: ['通过', '回归'],
    tags: ['ui'],
    issueId: '11111111-1111-4111-8111-111111111111',
  }, execContext()) as { task?: { id: string; title: string } }
  assert.ok(result.task !== undefined)
  assert.equal(result.task.title, '新卡')

  const stored = kit.tasks.get(result.task.id)
  assert.equal(stored?.status, 'todo')
  assert.equal(stored?.issueId, '11111111-1111-4111-8111-111111111111')
  assert.deepEqual(stored?.tags, ['ui'])
  assert.equal(stored?.checklist?.[0]?.checked, false)
  assert.equal(stored?.createdBy.kind, 'agent')

  await assert.rejects(
    () => create.execute({ title: 'x', workspaceId: 'nope', urgency: 'normal' }, execContext()),
    /unknown workspaceId/,
  )
})

test('castboard_move：认领要求同项目，越权与非法迁移被拒', async (t) => {
  const root = tempRoot(t)
  const kit = fixture(root)
  await seedTask(kit.tasks, taskRecord({ id: 't-1', workspaceId: 'ws-1' }))
  const move = byName(castboardTools(taskDeps({ fixture: kit })), 'castboard_move')

  const claimed = await move.execute({ id: 't-1', status: 'in_progress' }, execContext('D:/repo')) as {
    task: { status: string; claimOwner?: string }
  }
  assert.equal(claimed.task.status, 'in_progress')
  const stored = kit.tasks.get('t-1')
  assert.equal(stored?.claimedBy, 'session-1')
  assert.equal(stored?.claimedAt, 2_000)

  await seedTask(kit.tasks, taskRecord({ id: 't-2', workspaceId: 'ws-2' }))
  await assert.rejects(
    () => move.execute({ id: 't-2', status: 'in_progress' }, execContext('D:/repo')),
    (error: unknown) => (error as { code?: string }).code === 'workspace_mismatch',
  )
  await assert.rejects(
    () => move.execute({ id: 't-1', status: 'done' }, execContext('D:/repo')),
    (error: unknown) => (error as { code?: string }).code === 'forbidden',
  )
  await assert.rejects(
    () => move.execute({ id: 't-1', status: 'archived' }, execContext('D:/repo')),
    /illegal transition/,
  )
})

test('castboard_move：自动验收会话可收卡，其他会话仍被拒', async (t) => {
  const root = tempRoot(t)
  const kit = fixture(root)
  await seedTask(kit.tasks, taskRecord({
    id: 't-1',
    workspaceId: 'ws-1',
    status: 'in_review',
    acceptanceInjectedAt: 1_000,
    acceptanceStrategies: [{ id: 'a-1', title: '验收', type: 'close', description: '输出 MIKU' }],
    executions: [{ id: 'e-1', trigger: 'acceptance', outcome: 'running', sessionId: 'session-1' }],
  }))
  await seedTask(kit.tasks, taskRecord({
    id: 't-2',
    workspaceId: 'ws-1',
    status: 'in_review',
    acceptanceInjectedAt: 1_000,
    acceptanceStrategies: [{ id: 'a-1', title: '验收', type: 'close', description: '输出 MIKU' }],
    executions: [{ id: 'e-1', trigger: 'acceptance', outcome: 'running', sessionId: 'session-1' }],
  }))
  const move = byName(castboardTools(taskDeps({ fixture: kit })), 'castboard_move')

  const accepted = await move.execute({ id: 't-1', status: 'done' }, execContext('D:/repo', 'session-1')) as {
    task: { status: string }
  }
  assert.equal(accepted.task.status, 'done')

  await assert.rejects(
    () => move.execute({ id: 't-2', status: 'done' }, execContext('D:/repo', 'session-other')),
    (error: unknown) => (error as { code?: string }).code === 'forbidden',
  )

  // Any single missing condition must keep the gate closed.
  const forbidden = (id: string, sessionId: string) => assert.rejects(
    () => move.execute({ id, status: 'done' }, execContext('D:/repo', sessionId)),
    (error: unknown) => (error as { code?: string }).code === 'forbidden',
  )
  await seedTask(kit.tasks, taskRecord({
    id: 't-3',
    workspaceId: 'ws-1',
    status: 'in_review',
    acceptanceInjectedAt: 1_000,
    executions: [{ id: 'e-1', trigger: 'manual', outcome: 'succeeded', sessionId: 'session-1' }],
  }))
  await forbidden('t-3', 'session-1')

  await seedTask(kit.tasks, taskRecord({
    id: 't-4',
    workspaceId: 'ws-1',
    status: 'in_review',
    acceptanceStrategies: [{ id: 'a-1', title: '验收', type: 'close', description: '输出 MIKU' }],
    executions: [{ id: 'e-1', trigger: 'manual', outcome: 'succeeded', sessionId: 'session-1' }],
  }))
  await forbidden('t-4', 'session-1')

  await seedTask(kit.tasks, taskRecord({
    id: 't-5',
    workspaceId: 'ws-1',
    status: 'in_progress',
    acceptanceInjectedAt: 1_000,
    acceptanceStrategies: [{ id: 'a-1', title: '验收', type: 'close', description: '输出 MIKU' }],
    executions: [{ id: 'e-1', trigger: 'manual', outcome: 'running', sessionId: 'session-1' }],
  }))
  await forbidden('t-5', 'session-1')

  await seedTask(kit.tasks, taskRecord({
    id: 't-6',
    workspaceId: 'ws-1',
    status: 'in_review',
    acceptanceInjectedAt: 1_000,
    acceptanceStrategies: [{ id: 'a-1', title: '验收', type: 'close', description: '输出 MIKU' }],
    executions: [
      { id: 'e-1', trigger: 'manual', outcome: 'succeeded', sessionId: 'session-1' },
      { id: 'e-2', trigger: 'acceptance', outcome: 'succeeded', sessionId: 'session-2' },
    ],
  }))
  // An older session is not the retained one that received the acceptance context.
  await forbidden('t-6', 'session-1')
})

test('castboard_comment_add 与 castboard_execution_report：写评论、落报告', async (t) => {
  const root = tempRoot(t)
  const kit = fixture(root)
  await seedTask(kit.tasks, taskRecord({
    id: 't-1',
    status: 'in_progress',
    claimedBy: 'session-1',
    executions: [{ id: 'e-1', trigger: 'manual', outcome: 'running', sessionId: 'session-1' }],
  }))
  const tools = castboardTools(taskDeps({ fixture: kit }))
  const comment = byName(tools, 'castboard_comment_add')
  const receipt = await comment.execute({ id: 't-1', body: '交接说明' }, execContext()) as { id: string }
  assert.ok(receipt.id !== '')
  const rows = await kit.thread.list('t-1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.body, '交接说明')
  assert.equal(rows[0]?.role, 'assignee')
  assert.equal(rows[0]?.authorType, 'agent')
  assert.equal(rows[0]?.threadId, 'session-1')

  const report = byName(tools, 'castboard_execution_report')
  const saved = await report.execute({
    summary: '做完',
    changedFiles: ['a.ts'],
    checks: ['pnpm test'],
    artifacts: [],
    risk: '',
  }, execContext()) as { taskId: string; executionId: string; report: { summary: string } }
  assert.equal(saved.taskId, 't-1')
  assert.equal(saved.executionId, 'e-1')
  assert.equal(saved.report.summary, '做完')
  assert.equal(kit.tasks.get('t-1')?.executions[0]?.report?.summary, '做完')
})

test('castboard_comment_add 只落评论，绝不 steer/followUp 正在执行的会话（raw: castboard_comment_add）', async (t) => {
  const root = tempRoot(t)
  const kit = fixture(root)
  await seedTask(kit.tasks, taskRecord({
    id: 't-1',
    status: 'in_progress',
    claimedBy: 'session-1',
    executions: [{ id: 'e-1', trigger: 'manual', outcome: 'running', sessionId: 'session-1' }],
  }))
  const calls: string[] = []
  const tools = castboardTools({
    ...taskDeps({ fixture: kit }),
    execution: {
      // 旧实现会调用这两个方法，把评论正文当成用户消息塞回执行会话；保留同名方法做报警器。
      liveSessionOfTask: () => 'session-1',
      steerSession: () => { calls.push('steer'); return 'steer' },
      followUpSession: () => { calls.push('followUp'); return true },
      releaseTaskSessions: () => undefined,
    },
  } as never)
  const receipt = await byName(tools, 'castboard_comment_add')
    .execute({ id: 't-1', body: '进展' }, execContext()) as {
      id: string
      steered?: boolean
      task: { id: string; status: string }
    }
  assert.ok(receipt.id !== '')
  assert.equal(receipt.steered, undefined)
  assert.deepEqual(calls, [])
  // 回执与 raw 同形：带上卡片状态，下一笔写入不用再读。
  assert.equal(receipt.task.status, 'in_progress')
  const rows = await kit.thread.list('t-1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.body, '进展')
})

test('castboard_issue_state：issue 目标（双角色）+ 每条评论目标附件（raw/host/9）', async (t) => {
  const root = tempRoot(t)
  const kit = fixture(root)
  const issue = await kit.issues.create({
    title: '需求',
    detail: '正文',
    workspaceId: 'ws-1',
    urgency: 'normal',
  })
  const comment = await kit.thread.add(issue.id, { body: '收到', role: 'assigner', authorType: 'agent' })
  assert.ok(comment !== undefined)
  const downloads: string[] = []
  const commentSyncs: string[] = []
  const tool = byName(buildIssueDispatchTools({
    tasks: kit.tasks,
    issues: kit.issues,
    comments: kit.comments,
    thread: kit.thread,
    now: () => 1_000,
    syncIssueAttachments: async issueId => {
      downloads.push(issueId)
      return {
        attachments: [
          {
            name: 'brief.md', path: 'D:/state/input/brief.md', targetType: 'issue' as const,
            targetId: issueId, role: 'assigner' as const, kind: 'input' as const, state: 'ready' as const,
          },
          {
            name: 'report.md', path: 'D:/state/output/report.md', targetType: 'issue' as const,
            targetId: issueId, role: 'assignee' as const, kind: 'output' as const, state: 'ready' as const,
            size: 12, description: '报告',
          },
        ],
        failed: [{ fileName: 'x.bin', reason: 'not_found: gone' }],
        outputDir: 'D:/state',
      }
    },
    syncCommentAttachments: async (issueId, commentId) => {
      commentSyncs.push(commentId)
      return {
        attachments: [{
          name: 'shot.png', path: `D:/state/comments/${commentId}/shot.png`, targetType: 'comment' as const,
          targetId: commentId, role: 'assigner' as const, kind: 'comment' as const, state: 'ready' as const,
        }],
        failed: [],
        outputDir: 'D:/state',
      }
    },
  }), 'castboard_issue_state')
  const receipt = await tool.execute({ issueId: issue.id }, execContext()) as {
    attachments: Array<{ name: string; targetType: string; role: string; kind: string }>
    failed: Array<{ fileName: string; reason: string }>
    downloadedTo: string
  }
  assert.deepEqual(downloads, [issue.id])
  assert.deepEqual(commentSyncs, [comment.id])
  assert.deepEqual(receipt.attachments.map(item => [item.name, item.targetType, item.role, item.kind]), [
    ['brief.md', 'issue', 'assigner', 'input'],
    ['report.md', 'issue', 'assignee', 'output'],
    ['shot.png', 'comment', 'assigner', 'comment'],
  ])
  assert.deepEqual(receipt.failed, [{ fileName: 'x.bin', reason: 'not_found: gone' }])
  assert.equal(receipt.downloadedTo, 'D:/state')
})

test('castboard_issue_task：建卡并双向绑定 issue', async (t) => {
  const root = tempRoot(t)
  const kit = fixture(root)
  const created = await kit.issues.create({
    title: '需求',
    detail: '正文',
    workspaceId: 'ws-1',
    urgency: 'normal',
  })
  await kit.issues.markRouting(created.id)

  const routed: Array<{ issueId: string; assigneeTask: string }> = []
  const tool = byName(issueTaskTools({
    issues: kit.issues,
    store: kit.tasks,
    now: () => 3_000,
    resolveWorkspace: async () => ({ id: 'ws-1', path: 'D:/repo' }),
    links: kit.links,
    thread: kit.thread,
    issueRouted: async (issueId, input) => { routed.push({ issueId, assigneeTask: input.assigneeTask }) },
  }), 'castboard_issue_task')

  const receipt = await tool.execute({
    issueId: created.id,
    title: '需求',
    detail: '正文',
    cwd: 'D:/repo',
    checklist: [{ text: '通过' }],
  }, execContext()) as { task: { id: string; issueId: string; status: string }; issue: { assigneeTask: string; status: string } }

  assert.equal(receipt.task.issueId, created.id)
  assert.equal(receipt.task.status, 'todo')
  assert.equal(receipt.issue.assigneeTask, receipt.task.id)
  assert.equal(receipt.issue.status, 'routing')
  assert.equal(kit.links.get(created.id)?.assigneeTaskId, receipt.task.id)
  assert.equal((await kit.issues.get(created.id))?.assigneeTask, receipt.task.id)
  // 所有 issue 都在共享库：routing 结果必须先写回云端，本地镜像随后才更新。
  assert.deepEqual(routed, [{ issueId: created.id, assigneeTask: receipt.task.id }])

  const again = tool.execute({
    issueId: '22222222-2222-4222-8222-222222222222',
    title: '需求',
    detail: '正文',
    cwd: 'D:/repo',
  }, execContext())
  await assert.rejects(again, /issue 不存在/)
  assert.equal(routed.length, 1, '不存在的 issue 不发云端请求')
})

test('castboard_issue_task：继承 issue 的 cron/checklist/验收策略', async (t) => {
  const root = tempRoot(t)
  const kit = fixture(root)
  const created = await kit.issues.create({
    title: '定时需求',
    detail: '正文',
    workspaceId: 'ws-1',
    urgency: 'normal',
    assignerMeta: {
      cron: '0 9 * * 1-5',
      checklist: ['接口通过', '无报错'],
      acceptanceStrategies: [{
        id: 'a-check',
        title: '自动验收',
        type: 'issue',
        description: '检查接口返回',
      }],
    },
  })
  await kit.issues.markRouting(created.id)

  const routedMeta: Array<Record<string, unknown>> = []
  const tool = byName(issueTaskTools({
    issues: kit.issues,
    store: kit.tasks,
    now: () => 3_000,
    resolveWorkspace: async () => ({ id: 'ws-1', path: 'D:/repo' }),
    links: kit.links,
    thread: kit.thread,
    issueRouted: async (_issueId, input) => { routedMeta.push(input.assignerMeta) },
  }), 'castboard_issue_task')

  const receipt = await tool.execute({
    issueId: created.id,
    title: '定时需求',
    detail: '正文',
    cwd: 'D:/repo',
  }, execContext()) as {
    task: {
      id: string
      execution: { mode: string; cron?: string }
      checklist?: Array<{ text: string; checked: boolean }>
      acceptanceStrategies?: Array<{ id: string; title: string }>
    }
  }

  assert.deepEqual(receipt.task.execution, { mode: 'scheduled', cron: '0 9 * * 1-5' })
  assert.deepEqual(receipt.task.checklist?.map(item => [item.text, item.checked]), [
    ['接口通过', false],
    ['无报错', false],
  ])
  assert.deepEqual(receipt.task.acceptanceStrategies?.map(item => [item.id, item.title]), [
    ['a-check', '自动验收'],
  ])
  const issue = await kit.issues.get(created.id)
  assert.deepEqual(issue?.assignerMeta?.cron, '0 9 * * 1-5')
  assert.deepEqual(issue?.assignerMeta?.checklist, ['接口通过', '无报错'])
  // 云端拿到的是同一份归一化后的规划字段（云先行，本地镜像随后）。
  assert.equal(routedMeta.length, 1)
  assert.equal(routedMeta[0]?.['cron'], '0 9 * * 1-5')
  assert.deepEqual(routedMeta[0]?.['checklist'], ['接口通过', '无报错'])
})

test('castboard_issue_task：丢弃非法的 issue 规划字段', async (t) => {
  const root = tempRoot(t)
  const kit = fixture(root)
  const created = await kit.issues.create({
    title: '坏规划',
    detail: '正文',
    workspaceId: 'ws-1',
    urgency: 'normal',
    assignerMeta: {
      cron: 'not-a-cron',
      checklist: ['有效', 42],
      acceptanceStrategies: 'nope',
    },
  })
  await kit.issues.markRouting(created.id)

  const routedMeta: Array<Record<string, unknown>> = []
  const tool = byName(issueTaskTools({
    issues: kit.issues,
    store: kit.tasks,
    now: () => 3_000,
    resolveWorkspace: async () => ({ id: 'ws-1', path: 'D:/repo' }),
    links: kit.links,
    thread: kit.thread,
    issueRouted: async (_issueId, input) => { routedMeta.push(input.assignerMeta) },
  }), 'castboard_issue_task')

  const receipt = await tool.execute({
    issueId: created.id,
    title: '坏规划',
    detail: '正文',
    cwd: 'D:/repo',
  }, execContext()) as {
    task: {
      execution: { mode: string; cron?: string }
      checklist?: unknown[]
      acceptanceStrategies?: unknown[]
    }
  }

  assert.deepEqual(receipt.task.execution, { mode: 'queue' })
  assert.equal(receipt.task.checklist, undefined)
  assert.equal(receipt.task.acceptanceStrategies, undefined)
  const issue = await kit.issues.get(created.id)
  assert.equal(issue?.assignerMeta?.cron, undefined)
  assert.equal(issue?.assignerMeta?.checklist, undefined)
  assert.equal(issue?.assignerMeta?.acceptanceStrategies, undefined)
  assert.equal(routedMeta.length, 1)
  assert.equal(routedMeta[0]?.['cron'], undefined, '非法 cron 不带进云端 meta')
  assert.equal(routedMeta[0]?.['checklist'], undefined)
  assert.equal(routedMeta[0]?.['acceptanceStrategies'], undefined)
})

test('castboard_issue_comment_add：按会话推断方向并落盘', async (t) => {
  const root = tempRoot(t)
  const kit = fixture(root)
  const issue = await kit.issues.create({
    title: '需求',
    detail: '正文',
    workspaceId: 'ws-1',
    urgency: 'normal',
  })
  const tool = byName(issueCommentTools({
    links: kit.links,
    tasks: kit.tasks,
    thread: kit.thread,
  }), 'castboard_issue_comment_add')

  const result = await tool.execute({
    issueId: issue.id,
    body: '补充说明',
    role: 'assigner',
  }, execContext()) as { id: string; appended: boolean; role: string }
  assert.equal(result.appended, true)
  assert.equal(result.role, 'assigner')
  const rows = await kit.thread.list(issue.id)
  assert.equal(rows[0]?.body, '补充说明')
  assert.equal(rows[0]?.role, 'assigner')
  assert.equal(rows[0]?.origin, 'local')

  await assert.rejects(
    () => tool.execute({ issueId: 't-123', body: 'x' }, execContext()),
    /是任务 id/,
  )
})

test('castboard_issue_comment_add：把评论附件上传为 comment target', async (t) => {
  const root = tempRoot(t)
  const kit = fixture(root)
  const issue = await kit.issues.create({
    title: '带附件评论',
    detail: '正文',
    workspaceId: 'ws-1',
    urgency: 'normal',
  })
  const uploads: Array<{ issueId: string; commentId: string; role: string; paths: readonly string[] }> = []
  const tool = byName(issueCommentTools({
    links: kit.links,
    tasks: kit.tasks,
    thread: kit.thread,
    uploadCommentAttachments: async input => {
      uploads.push(input)
      return { attached: input.paths.length, failed: [] }
    },
    attachmentCwd: () => 'D:/work',
  }), 'castboard_issue_comment_add')

  const result = await tool.execute({
    issueId: issue.id,
    body: '见图',
    attachments: ['D:/tmp/shot.png', 'D:/tmp/log.txt'],
  }, execContext()) as {
    id: string
    attachments: { attached: number; failed: unknown[] }
  }
  await tool.execute(
    { issueId: issue.id, body: '相对路径', attachments: ['shot.png'] },
    execContext(),
  )
  assert.equal(uploads.length, 2)
  assert.ok(uploads[1]?.paths[0]?.endsWith('shot.png'))
  assert.ok(uploads[1]?.paths[0]?.startsWith('D:') || uploads[1]?.paths[0]?.startsWith('/'))
  assert.equal(result.attachments.attached, 2)
  assert.deepEqual(result.attachments.failed, [])
  assert.equal(uploads[0]?.commentId, result.id)
  assert.equal(uploads[0]?.role, 'assigner')
  assert.deepEqual(uploads[0]?.paths, ['D:/tmp/shot.png', 'D:/tmp/log.txt'])
})

test('castboard_issues_help：能注入时把指导送进会话，不能时随返回值下发', async (t) => {
  const injected: Array<{ sessionId: string; entries: ReadonlyArray<{ name: string }> }> = []
  const kit = fixture(tempRoot(t))
  const help = byName(buildIssueDispatchTools({
    tasks: kit.tasks,
    issues: kit.issues,
    comments: kit.comments,
    thread: kit.thread,
    now: () => 1,
    instance: () => '10.0.0.1:3080',
    inject: (sessionId, entries) => {
      injected.push({ sessionId: sessionId ?? '', entries })
      return true
    },
  }), 'castboard_issues_help')

  const result = await help.execute({}, execContext()) as { injected: boolean; local: { instance: string } }
  assert.equal(result.injected, true)
  assert.equal(result.local.instance, '10.0.0.1:3080')
  assert.deepEqual(injected[0]?.entries.map(entry => entry.name), ['castboard-issue-creation-guidance'])

  const withoutInjection = byName(buildIssueDispatchTools({
    tasks: kit.tasks,
    issues: kit.issues,
    comments: kit.comments,
    thread: kit.thread,
    now: () => 1,
    instance: () => '10.0.0.1:3080',
  }), 'castboard_issues_help')
  const fallback = await withoutInjection.execute({}, execContext()) as {
    injected: boolean
    guidance?: string
  }
  assert.equal(fallback.injected, false)
  assert.ok((fallback.guidance ?? '').includes('castboard_issues_create'))
})
