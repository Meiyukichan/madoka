import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { runEphemeralSession } from '../../src/sessions/ephemeral.ts'
import { getSessionStore, resetSessionStores } from '../../src/sessions/store.ts'
import { resetApprovals } from '../../src/sessions/approval.ts'
import { resetQuestions } from '../../src/sessions/questions.ts'
import { resetMagicaSessionCache } from '../../src/interactions/ownership.ts'
import { fakeAgents } from '../helpers/fake-agent.ts'
import { fakeCtx } from '../helpers/fake.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spellbook-facade-'))
  dirs.push(dir)
  return dir
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  resetSessionStores()
  resetApprovals()
  resetQuestions()
  resetMagicaSessionCache()
})

function makeCtx(dir: string, agents: unknown) {
  return fakeCtx({
    agents,
    // 0.2 的模型默认值是拉取式服务；没有它门面会同步抛 "no model route"
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-model' }) },
    dshHomePath: (...segments: string[]) => join(dir, ...segments),
  })
}

describe('runEphemeralSession', () => {
  it('给 title 时会 pinTitle（sessionTitle.rename）', async () => {
    const dir = tempDir()
    const bundle = fakeAgents({ text: '答案' })
    const titled: string[] = []
    const ctx = fakeCtx({
      agents: bundle.registry,
      agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-model' }) },
      dshHomePath: (...segments: string[]) => join(dir, ...segments),
      sessionTitle: {
        rename: (_session: unknown, title: string) => { titled.push(title) },
      },
    })
    const handle = runEphemeralSession(ctx, {
      cwd: 'D:/tmp/project',
      prompt: '你好',
      title: 'DSH任务面板项目肖像',
      storeDir: dir,
    })
    await handle.firstTurn
    assert.deepEqual(titled, ['DSH任务面板项目肖像'])
    await handle.dispose()
  })

  it('首轮跑通：completed、状态收敛、台账落盘', async () => {
    const dir = tempDir()
    const bundle = fakeAgents({ text: '答案' })
    const ctx = makeCtx(dir, bundle.registry)
    const handle = runEphemeralSession(ctx, {
      cwd: 'D:/tmp/project',
      prompt: '你好',
      sandbox: 'read-only',
      storeDir: dir,
    })
    const settlement = await handle.firstTurn
    assert.equal(settlement.completed, true)
    assert.deepEqual(settlement.texts, ['答案'])

    const state = handle.getState()
    assert.equal(state.done, true)
    assert.equal(state.running, false)
    assert.equal(state.error, null)
    assert.equal(state.resumed, false)
    assert.deepEqual(state.pendingApprovals, [])

    const record = JSON.parse(readFileSync(join(dir, `${handle.id}.json`), 'utf8')) as {
      kind: string
      cwd: string
      permission: string
      version: number
    }
    assert.equal(record.kind, 'ephemeral')
    assert.equal(record.cwd, 'D:/tmp/project')
    assert.equal(record.permission, 'read-only')
    assert.equal(record.version, 1)

    // 上下文投递器挂在 agent scope 上；交互接管挂在插件级 ctx 上
    assert.equal(bundle.agentCtx.listenerCount('agent/pre-step'), 1)
    assert.equal(ctx.listenerCount('approval/request'), 1)
    assert.equal(ctx.listenerCount('user-questions/request'), 1)

    await handle.dispose()
    assert.equal(handle.getState().disposed, true)
    assert.equal(ctx.listenerCount('approval/request'), 0)
  })

  it('续跑：同一 sessionId 走 resume 而不是 create', async () => {
    const dir = tempDir()
    const first = fakeAgents({ text: 'one' })
    const firstHandle = runEphemeralSession(makeCtx(dir, first.registry), {
      cwd: 'D:/tmp/p',
      prompt: 'a',
      storeDir: dir,
    })
    await firstHandle.firstTurn
    await firstHandle.dispose()

    const second = fakeAgents({ text: 'two' })
    const resumedHandle = runEphemeralSession(makeCtx(dir, second.registry), {
      sessionId: firstHandle.id,
      cwd: 'D:/tmp/p',
      prompt: 'b',
      storeDir: dir,
    })
    await resumedHandle.firstTurn
    assert.equal(resumedHandle.resumed, true)
    assert.equal(second.resumed.length, 1)
    assert.equal(second.created.length, 0)
    assert.equal(resumedHandle.getState().resumed, true)
    await resumedHandle.dispose()
  })

  it('跨门面误用：把正式会话 id 传给临时门面 → 新建并忽略', async () => {
    const dir = tempDir()
    const store = getSessionStore(fakeCtx({ dshHomePath: (...segments: string[]) => join(dir, ...segments) }), dir)
    assert.ok(store !== null)
    store.put({ sessionId: 'ws-1', kind: 'workspace', createdAt: 1, workspaceId: 'w1', workspacePath: 'D:/w' })

    const bundle = fakeAgents({ text: 'x' })
    const handle = runEphemeralSession(makeCtx(dir, bundle.registry), {
      sessionId: 'ws-1',
      cwd: 'D:/tmp/p',
      prompt: 'a',
      storeDir: dir,
    })
    await handle.firstTurn
    assert.equal(handle.resumed, false)
    assert.notEqual(handle.id, 'ws-1')
    await handle.dispose()
  })

  it('看门狗：whenIdle 不收敛时首轮以 timedOut 结束而不是永久挂起', async () => {
    const dir = tempDir()
    const bundle = fakeAgents({ neverIdle: true })
    const handle = runEphemeralSession(makeCtx(dir, bundle.registry), {
      cwd: 'D:/tmp/p',
      prompt: 'a',
      idleTimeoutMs: 10,
      storeDir: dir,
    })
    const settlement = await handle.firstTurn
    assert.equal(settlement.timedOut, true)
    assert.equal(settlement.completed, false)
    await handle.dispose()
  })

  it('dispose 之后 followup 直接抛 session disposed', async () => {
    const dir = tempDir()
    const bundle = fakeAgents({ text: 'x' })
    const handle = runEphemeralSession(makeCtx(dir, bundle.registry), {
      cwd: 'D:/tmp/p',
      prompt: 'a',
      storeDir: dir,
    })
    await handle.firstTurn
    await handle.dispose()
    await assert.rejects(() => handle.followup('again'), /session disposed/)
  })

  it('followup 串行：两次并发调用按顺序完成', async () => {
    const dir = tempDir()
    const bundle = fakeAgents({ text: 'r' })
    const handle = runEphemeralSession(makeCtx(dir, bundle.registry), {
      cwd: 'D:/tmp/p',
      prompt: 'a',
      storeDir: dir,
    })
    await handle.firstTurn
    const first = handle.followup('b')
    const second = handle.followup('c')
    const [one, two] = await Promise.all([first, second])
    assert.equal(one.completed, true)
    assert.equal(two.completed, true)
    await handle.dispose()
  })

  it('没有模型路由时同步抛（而不是建出一个 {{model}} 为空的 agent）', () => {
    const dir = tempDir()
    const bundle = fakeAgents({ text: 'x' })
    const ctx = fakeCtx({ agents: bundle.registry, dshHomePath: (...segments: string[]) => join(dir, ...segments) })
    assert.throws(() => runEphemeralSession(ctx, { cwd: 'D:/tmp/p', prompt: 'a', storeDir: dir }), /no model route/)
    assert.equal(bundle.created.length, 0)
  })

  it('插件卸载（fiber 回收 effect）会自动 dispose 会话，不泄漏 agent handle', async () => {
    const dir = tempDir()
    const bundle = fakeAgents({ text: 'x' })
    const ctx = makeCtx(dir, bundle.registry)
    const handle = runEphemeralSession(ctx, { cwd: 'D:/tmp/p', prompt: 'a', storeDir: dir })
    await handle.firstTurn
    assert.equal(handle.getState().disposed, false)

    // 模拟 cordis fiber 卸载
    ctx.disposeEffects()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(handle.getState().disposed, true, '门面必须挂 ctx.effect，卸载时自动 dispose')
    assert.equal(ctx.listenerCount('approval/request'), 0)
    assert.equal(ctx.listenerCount('user-questions/request'), 0)
  })

  it('noInteraction: false → 不装 fail-fast（把提问/审批留给上层接管）', async () => {
    const dir = tempDir()
    const bundle = fakeAgents({ text: 'x' })
    const ctx = makeCtx(dir, bundle.registry)
    const handle = runEphemeralSession(ctx, {
      cwd: 'D:/tmp/p',
      prompt: 'a',
      noInteraction: false,
      storeDir: dir,
    })
    await handle.firstTurn
    assert.equal(ctx.listenerCount('approval/request'), 0)
    assert.equal(ctx.listenerCount('user-questions/request'), 0)
    await handle.dispose()
  })

  it('默认（noInteraction 缺省）仍装 fail-fast', async () => {
    const dir = tempDir()
    const bundle = fakeAgents({ text: 'x' })
    const ctx = makeCtx(dir, bundle.registry)
    const handle = runEphemeralSession(ctx, { cwd: 'D:/tmp/p', prompt: 'a', storeDir: dir })
    await handle.firstTurn
    assert.equal(ctx.listenerCount('approval/request'), 1)
    assert.equal(ctx.listenerCount('user-questions/request'), 1)
    await handle.dispose()
  })

  it('ctx.effect 兜底登记存在（副作用可逆）', async () => {
    const dir = tempDir()
    const bundle = fakeAgents({ text: 'x' })
    const ctx = makeCtx(dir, bundle.registry)
    const handle = runEphemeralSession(ctx, { cwd: 'D:/tmp/p', prompt: 'a', storeDir: dir })
    await handle.firstTurn
    assert.ok(ctx.effects() >= 1)
    await handle.dispose()
  })
})
