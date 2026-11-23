/**
 * spellbook 适配器单测：只用注入的假模块，不装 spellbook 也能跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createSpellbookSessions, toTurnResult, type SpellbookSessionsModule } from '../src/host/exec/spellbook-sessions.ts'

/** 假句柄。 */
function fakeHandle(settlement: Parameters<typeof toTurnResult>[0]) {
  const state = { cancelled: 0, disposed: 0, wakes: 0, pushes: 0, named: [] as unknown[], followups: [] as string[] }
  return {
    state,
    handle: {
      id: 's-1',
      firstTurn: Promise.resolve(settlement),
      followup: async (message: string) => {
        state.followups.push(message)
        return settlement
      },
      followupNamedContext: async (entries: unknown) => {
        state.named.push(entries)
        return settlement
      },
      injectContext: () => true,
      pushNamedContext: () => { state.pushes += 1; return 'inject' },
      cancel: () => { state.cancelled += 1 },
      dispose: async () => { state.disposed += 1 },
    },
  }
}

test('toTurnResult：已知 kind 透传，未知结局不带 kind', () => {
  const completed = toTurnResult({ kind: 'completed', completed: true, texts: ['a'] })
  assert.equal(completed.kind, 'completed')
  assert.equal(completed.completed, true)
  assert.deepEqual(completed.texts, ['a'])
  assert.equal(completed.externallyDisposed, false)
  assert.equal(toTurnResult({ kind: 'weird', completed: false, texts: [] }).kind, undefined)
  assert.equal(toTurnResult({ completed: false, texts: [], timedOut: true }).timedOut, true)
})

test('正式会话：调 runWorkspaceSession，且要求 workspace', async () => {
  const seen: Record<string, unknown>[] = []
  const fake = fakeHandle({ kind: 'completed', completed: true, texts: ['ok'] })
  const handle = fake.handle
  const module: SpellbookSessionsModule = {
    runWorkspaceSession: (_ctx, options) => {
      seen.push(options)
      return handle
    },
  }
  const face = await createSpellbookSessions({
    ctx: {},
    kind: 'workspace',
    load: async () => module,
    resolveWorkspacePath: id => `D:/ws/${id}`,
  })
  assert.ok(face !== undefined)
  const task = { id: 't-1', title: '写文档', workspaceId: 'ws-1', permission: 'workspace-write' } as never
  const session = await face.start({ task, prompt: '开始' })
  assert.equal(session.id, 's-1')
  assert.equal(seen[0]!.workspaceId, 'ws-1')
  assert.equal(seen[0]!.workspacePath, 'D:/ws/ws-1')
  assert.equal(seen[0]!.permission, 'workspace-write')
  const turn = await session.firstTurn
  assert.equal(turn.kind, 'completed')
  // Named-context wake is forwarded with the spellbook settlement converted the same way.
  assert.equal(typeof session.followupNamedContext, 'function')
  const namedTurn = await session.followupNamedContext!([{ name: 'x', text: 'y' }])
  assert.equal(namedTurn.kind, 'completed')
  assert.equal(fake.state.named.length, 1)
})

test('适配器：底层缺少 named-context 唤醒时明确失败，不退回用户 followup', async () => {
  const module: SpellbookSessionsModule = {
    runWorkspaceSession: () => ({
      id: 's-legacy',
      firstTurn: Promise.resolve({ completed: true, texts: [] }),
      followup: async () => ({ completed: true, texts: [] }),
      cancel: () => {},
      dispose: async () => {},
    }),
  }
  const face = await createSpellbookSessions({
    ctx: {},
    kind: 'workspace',
    load: async () => module,
    resolveWorkspacePath: () => 'D:/ws/legacy',
  })
  const session = await face!.start({ task: { id: 't-1', workspaceId: 'ws-1' } as never, prompt: '开始' })
  await assert.rejects(() => session.followupNamedContext([{ name: 'x', text: 'y' }]), /named-context wake/)
})

test('新版契约：context 原样透传给门面，sections 变成 setup(agentCtx)，句柄带 injectContext/wake', async () => {
  const seen: Record<string, unknown>[] = []
  const sections: { name: string; order?: number; text: string }[] = []
  const { handle } = fakeHandle({ kind: 'completed', completed: true, texts: ['ok'] })
  const module: SpellbookSessionsModule = {
    runWorkspaceSession: (_ctx, options) => {
      seen.push(options)
      return handle
    },
  }
  const face = await createSpellbookSessions({
    ctx: {},
    kind: 'workspace',
    load: async () => module,
    resolveWorkspacePath: id => `D:/ws/${id}`,
  })
  assert.ok(face !== undefined)
  const entries = [
    { name: 'castboard-task-rules', text: '<castboard_task_rules></castboard_task_rules>' },
    { name: 'castboard-task-references', text: '<castboard_task_references></castboard_task_references>' },
  ]
  const session = await face.start({
    task: { id: 't-9', title: '契约', workspaceId: 'ws-9' } as never,
    prompt: '执行',
    context: entries,
    sections: [{ name: 'castboard-issue-routing', order: 150, text: '<castboard_issue_routing/>' }],
  })
  assert.deepEqual(seen[0]!.context, entries)
  assert.equal(seen[0]!.contextPlugin, '@meiyukichan/dsh-magica-castboard')
  const setup = seen[0]!.setup as (agentCtx: unknown) => void
  assert.equal(typeof setup, 'function', 'sections 必须变成 setup')
  setup({ systemPrompt: { section: (input: { name: string; order?: number; text: string }) => { sections.push(input) } } })
  assert.deepEqual(sections, [{ name: 'castboard-issue-routing', order: 150, text: '<castboard_issue_routing/>' }])
  // 新版两个门面都有 injectContext/pushNamedContext：适配器必须把它们透出去
  assert.equal(typeof session.injectContext, 'function')
  assert.equal(session.injectContext?.([{ name: 'x', text: 'y' }]), true)
  assert.equal(typeof session.pushNamedContext, 'function')
  assert.equal(session.pushNamedContext?.([{ name: 'x', text: 'y' }]), 'inject')
})

test('临时会话：调 runEphemeralSession，缺 cwd 抛错', async () => {
  const seen: Record<string, unknown>[] = []
  const { handle } = fakeHandle({ kind: 'aborted', completed: false, texts: [] })
  const module: SpellbookSessionsModule = {
    runEphemeralSession: (_ctx, options) => {
      seen.push(options)
      return handle
    },
  }
  const face = await createSpellbookSessions({ ctx: {}, kind: 'ephemeral', load: async () => module })
  assert.ok(face !== undefined)
  const session = await face.start({ task: { id: 't-2', title: 'r', cwd: 'D:/proj' } as never, prompt: '转卡' })
  assert.equal(seen[0]!.cwd, 'D:/proj')
  await assert.rejects(
    () => face.start({ task: { id: 't-3', title: 'x' } as never, prompt: 'p' }),
    /临时会话需要 cwd/,
  )
  const turn = await session.followUp('再来一轮')
  assert.equal(turn.kind, 'aborted')
})

test('没有 session 门面 → 返回 undefined（插件退化为只记账）', async () => {
  const face = await createSpellbookSessions({ ctx: {}, load: async () => ({}) })
  assert.equal(face, undefined)
})
