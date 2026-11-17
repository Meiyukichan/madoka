import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, it } from 'node:test'
import { runWorkspaceSession } from '../../src/sessions/workspace.ts'
import { resetSessionStores } from '../../src/sessions/store.ts'
import { resetApprovals } from '../../src/sessions/approval.ts'
import { resetQuestions } from '../../src/sessions/questions.ts'
import { resetMagicaSessionCache } from '../../src/interactions/ownership.ts'
import { fakeAgents } from '../helpers/fake-agent.ts'
import { fakeCtx } from '../helpers/fake.ts'

/**
 * `pushNamedContext` / `steer` 的三档投递（0.2.1 的 `agent.status` 驱动）。
 *
 * 这三档是 0.2.1-rc.5 新增能力在 SDK 里的出口，必须钉住：
 * - idle → `followup`（起一轮）
 * - running → `steer`（插进当前 step）
 * - 其它（closed/undefined）→ `inject`（挂收件箱等唤醒）
 * - `wake: 'always'` → 无论状态都 `steer`
 * - 没有 handle / 已 dispose / 空内容 → `skipped` / `false`
 */

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spellbook-push-'))
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

function harness(status: 'idle' | 'running' | 'closed' = 'idle') {
  const dir = tempDir()
  const bundle = fakeAgents({ text: 'done' })
  bundle.setStatus(status)
  const ctx = fakeCtx({
    agents: bundle.registry,
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-model' }) },
    dshHomePath: (...segments: string[]) => join(dir, ...segments),
  })
  const session = runWorkspaceSession(ctx as never, {
    workspaceId: 'w-1',
    workspacePath: 'D:/proj',
    prompt: 'go',
    storeDir: dir,
  })
  return { ctx, bundle, session, dir }
}

describe('pushNamedContext（三档投递）', () => {
  it('空闲时走 followup', async () => {
    const { session, bundle } = harness('idle')
    await session.firstTurn
    bundle.calls.length = 0
    const mode = session.pushNamedContext({ name: 'ctx', text: '新上下文' })
    assert.equal(mode, 'followup')
    assert.deepEqual(bundle.calls.map((call) => call.kind), ['followup'])
    await session.dispose()
  })

  it('运行中走 steer（不排队等下一轮）', async () => {
    const { session, bundle } = harness('running')
    await session.firstTurn
    bundle.calls.length = 0
    const mode = session.pushNamedContext({ name: 'ctx', text: '插话' })
    assert.equal(mode, 'steer')
    assert.deepEqual(bundle.calls.map((call) => call.kind), ['steer'])
    await session.dispose()
  })

  it('已结束/未知状态走 inject', async () => {
    const { session, bundle } = harness('closed')
    await session.firstTurn
    bundle.calls.length = 0
    const mode = session.pushNamedContext({ name: 'ctx', text: '挂收件箱' })
    assert.equal(mode, 'inject')
    assert.deepEqual(bundle.calls.map((call) => call.kind), ['inject'])
    await session.dispose()
  })

  it("wake: 'always' 即使空闲也走 steer", async () => {
    const { session, bundle } = harness('idle')
    await session.firstTurn
    bundle.calls.length = 0
    const mode = session.pushNamedContext([{ name: 'a', text: '一' }, { name: 'b', text: '二' }], {
      wake: 'always',
    })
    assert.equal(mode, 'steer')
    assert.equal(bundle.calls.filter((call) => call.kind === 'steer').length, 2)
    await session.dispose()
  })

  it('空内容 / 已 dispose 一律 skipped', async () => {
    const { session } = harness('idle')
    await session.firstTurn
    assert.equal(session.pushNamedContext([]), 'skipped')
    await session.dispose()
    assert.equal(session.pushNamedContext({ name: 'ctx', text: '晚了' }), 'skipped')
  })
})

describe('steer（直接插话）', () => {
  it('活动会话上返回 true 并落一次 steer', async () => {
    const { session, bundle } = harness('running')
    await session.firstTurn
    bundle.calls.length = 0
    assert.equal(session.steer('插一句'), true)
    assert.deepEqual(bundle.calls.map((call) => call.kind), ['steer'])
    await session.dispose()
  })

  it('已 dispose 返回 false 且不投递', async () => {
    const { session, bundle } = harness('idle')
    await session.firstTurn
    await session.dispose()
    bundle.calls.length = 0
    assert.equal(session.steer('晚了'), false)
    assert.equal(bundle.calls.length, 0)
  })
})
