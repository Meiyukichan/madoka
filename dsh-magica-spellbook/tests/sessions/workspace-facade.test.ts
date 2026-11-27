import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, it } from 'node:test'
import { runWorkspaceSession } from '../../src/sessions/workspace.ts'
import { normalizeProjectPath } from '../../src/sessions/ensure-workspace.ts'
import { resetSessionStores } from '../../src/sessions/store.ts'
import { resetApprovals } from '../../src/sessions/approval.ts'
import { resetQuestions } from '../../src/sessions/questions.ts'
import { resetMagicaSessionCache } from '../../src/interactions/ownership.ts'
import { fakeAgents } from '../helpers/fake-agent.ts'
import { fakeCtx } from '../helpers/fake.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spellbook-wsf-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
afterEach(() => {
  resetSessionStores()
  resetApprovals()
  resetQuestions()
  resetMagicaSessionCache()
})

interface Harness {
  ctx: ReturnType<typeof fakeCtx>
  bundle: ReturnType<typeof fakeAgents>
  registry: { attached: string[] }
  titled: string[]
  dir: string
}

function harness(options: { attachFails?: boolean; withTitle?: boolean } = {}): Harness {
  const dir = tempDir()
  const bundle = fakeAgents({ text: 'done' })
  const attached: string[] = []
  const titled: string[] = []
  const workspace = {
    id: 'w-1',
    path: 'D:/proj',
    attachSession: async (sessionId: string) => {
      if (options.attachFails === true) throw new Error('attach exploded')
      attached.push(sessionId)
    },
  }
  const ctx = fakeCtx({
    agents: bundle.registry,
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-model' }) },
    dshHomePath: (...segments: string[]) => join(dir, ...segments),
    workspaceRegistry: { get: (id: string) => (id === 'w-1' ? workspace : undefined) },
    ...(options.withTitle === true
      ? { sessionTitle: { rename: (_session: unknown, title: string) => titled.push(title) } }
      : {}),
  })
  return { ctx, bundle, registry: { attached }, titled, dir }
}

const base = {
  workspaceId: 'w-1',
  workspacePath: 'D:/proj',
  prompt: 'go',
}

describe('runWorkspaceSession（G-1：正式门面必须有测试）', () => {
  it('跑通首轮：agent 用 workspacePath 当 cwd、挂进 workspace、台账 kind=workspace', async () => {
    const h = harness()
    const handle = runWorkspaceSession(h.ctx, { ...base, storeDir: h.dir })
    const settlement = await handle.firstTurn
    assert.equal(settlement.completed, true)
    assert.deepEqual(settlement.texts, ['done'])

    assert.equal(h.bundle.created.length, 1)
    // cwd 走 normalizeProjectPath（Windows 上是反斜杠）
    assert.equal(h.bundle.created[0]?.meta?.cwd, normalizeProjectPath('D:/proj'))
    assert.deepEqual(h.registry.attached, [handle.id])

    const state = handle.getState()
    assert.equal(state.done, true)
    assert.equal(state.workspaceAttached, true)
    assert.equal(state.attachError, undefined)

    const record = JSON.parse(readFileSync(join(h.dir, `${handle.id}.json`), 'utf8')) as {
      kind: string
      cwd: string
      workspaceId: string
    }
    assert.equal(record.kind, 'workspace')
    assert.equal(record.workspacePath, normalizeProjectPath('D:/proj'))
    assert.equal(record.workspaceId, 'w-1')
    await handle.dispose()
  })

  it('attach 失败只记 attachError，不影响 turn', async () => {
    const h = harness({ attachFails: true })
    const handle = runWorkspaceSession(h.ctx, { ...base, storeDir: h.dir })
    const settlement = await handle.firstTurn
    assert.equal(settlement.completed, true)
    const state = handle.getState()
    assert.equal(state.workspaceAttached, false)
    assert.match(state.attachError ?? '', /attach exploded/)
    await handle.dispose()
  })

  it('workspace 不在 registry 里 → attachError 说明，但会话照跑', async () => {
    const h = harness()
    const handle = runWorkspaceSession(h.ctx, { ...base, workspaceId: 'missing', storeDir: h.dir })
    await handle.firstTurn
    assert.match(handle.getState().attachError ?? '', /not found in registry/)
    await handle.dispose()
  })

  it('registry 服务缺失 → attachError（不是抛）', async () => {
    const dir = tempDir()
    const bundle = fakeAgents({ text: 'done' })
    const ctx = fakeCtx({
      agents: bundle.registry,
      agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-model' }) },
      dshHomePath: (...segments: string[]) => join(dir, ...segments),
    })
    const handle = runWorkspaceSession(ctx, { ...base, storeDir: dir })
    await handle.firstTurn
    assert.match(handle.getState().attachError ?? '', /workspaceRegistry service unavailable/)
    await handle.dispose()
  })

  it('给 title 时会 pinTitle（sessionTitle.rename）', async () => {
    const h = harness({ withTitle: true })
    const handle = runWorkspaceSession(h.ctx, { ...base, title: '我的标题', storeDir: h.dir })
    await handle.firstTurn
    assert.deepEqual(h.titled, ['我的标题'])
    await handle.dispose()
  })

  it('prompt 省略：用具名上下文直接唤醒首轮，不生成 user 消息', async () => {
    const h = harness()
    const handle = runWorkspaceSession(h.ctx, {
      workspaceId: 'w-1',
      workspacePath: 'D:/proj',
      context: [{ name: 'castboard-issue-comments', text: '<issue_comments/>' }],
      storeDir: h.dir,
    })
    const settlement = await handle.firstTurn
    assert.equal(settlement.completed, true)
    assert.equal(h.bundle.calls.length, 1)
    assert.equal(h.bundle.calls[0]?.kind, 'followup')
    await handle.dispose()
  })

  it('humanInteraction 打开时安装 approval + question 接管（都是 prepend+global）', async () => {
    const h = harness()
    const handle = runWorkspaceSession(h.ctx, {
      ...base,
      humanInteraction: { approvalTimeoutMs: 1_000 },
      storeDir: h.dir,
    })
    await handle.firstTurn
    assert.equal(h.ctx.listenerCount('approval/request'), 1)
    assert.equal(h.ctx.listenerCount('user-questions/request'), 1)
    assert.deepEqual(h.ctx.listenerOptions('approval/request')[0], { prepend: true, global: true })
    await handle.dispose()
  })

  it('不给 humanInteraction 时不装接管（避免抢掉宿主自己的卡片）', async () => {
    const h = harness()
    const handle = runWorkspaceSession(h.ctx, { ...base, storeDir: h.dir })
    await handle.firstTurn
    assert.equal(h.ctx.listenerCount('approval/request'), 0)
    assert.equal(h.ctx.listenerCount('user-questions/request'), 0)
    await handle.dispose()
  })

  it('续跑：同一 sessionId 走 resumes 且台账保留 createdAt', async () => {
    const h = harness()
    const first = runWorkspaceSession(h.ctx, { ...base, storeDir: h.dir })
    await first.firstTurn
    const created = JSON.parse(readFileSync(join(h.dir, `${first.id}.json`), 'utf8')) as { createdAt: number }
    await first.dispose()

    const second = harness()
    const resumed = runWorkspaceSession(second.ctx, { ...base, sessionId: first.id, storeDir: h.dir })
    await resumed.firstTurn
    assert.equal(resumed.resumed, true)
    assert.equal(second.bundle.resumed.length, 1)
    const again = JSON.parse(readFileSync(join(h.dir, `${resumed.id}.json`), 'utf8')) as { createdAt: number }
    assert.equal(again.createdAt, created.createdAt, '续跑必须沿用原 createdAt')
    await resumed.dispose()
  })

  it('fiber 卸载自动 dispose（与临时门面一致）', async () => {
    const h = harness()
    const handle = runWorkspaceSession(h.ctx, { ...base, storeDir: h.dir })
    await handle.firstTurn
    assert.equal(handle.getState().disposed, false)
    h.ctx.disposeEffects()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(handle.getState().disposed, true)
  })
})

describe('getState 与 attach 的如实上报（Round 11 遗漏修复）', () => {
  it('workspace 没有 attachSession → 不谎报已挂载', async () => {
    const dir = tempDir()
    const bundle = fakeAgents({ text: 'done' })
    const ctx = fakeCtx({
      agents: bundle.registry,
      agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-model' }) },
      dshHomePath: (...segments: string[]) => join(dir, ...segments),
      workspaceRegistry: { get: () => ({ id: 'w-1', path: 'D:/proj' }) },
    })
    const handle = runWorkspaceSession(ctx, { ...base, storeDir: dir })
    await handle.firstTurn
    assert.equal(handle.getState().workspaceAttached, false)
    assert.match(handle.getState().attachError ?? '', /no attachSession/)
    await handle.dispose()
  })

  it('getState 暴露审批历史与运行期模式（看板要读）', async () => {
    const h = harness()
    const handle = runWorkspaceSession(h.ctx, {
      ...base,
      permission: 'workspace-write',
      humanInteraction: {},
      storeDir: h.dir,
    })
    await handle.firstTurn
    const state = handle.getState()
    assert.ok(Array.isArray(state.approvals), 'approvals 必须是数组（不再被过滤掉）')
    // 模式字段由会话事件驱动（core.ts:517-527）；没有事件时**不出现**而不是 null
    assert.equal('sandboxMode' in state, false)
    await handle.dispose()
  })
})