import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  answerApproval,
  installApprovalAnswerer,
  listPendingApprovals,
  resetApprovals,
  snapshotPendingApprovals,
} from '../../src/sessions/approval.ts'
import { fakeCtx } from '../helpers/fake.ts'

afterEach(() => {
  resetApprovals()
})

/** 造一条被挂住的审批。 */
function hold(
  ctx: ReturnType<typeof fakeCtx>,
  sessionId: string,
  extra: Record<string, unknown> = {},
  options: { timeoutMs?: number } = {},
  resolveArgs?: (callId: string | undefined) => string | undefined,
) {
  installApprovalAnswerer(ctx, sessionId, options, resolveArgs)
  return ctx.invoke(
    'approval/request',
    { agent: { session: { id: sessionId } }, toolName: 'bash', callId: 'c1', ...extra },
    async () => 'rejected',
  ) as Promise<string>
}

describe('审批接管', () => {
  it('挂住后进入待决表，answer 结算并清表', async () => {
    const ctx = fakeCtx()
    const held = hold(ctx, 's1')
    const pending = snapshotPendingApprovals('s1')
    assert.equal(pending.length, 1)
    assert.equal(pending[0]?.toolName, 'bash')
    assert.equal(pending[0]?.callId, 'c1')

    const result = answerApproval('s1', pending[0]?.id ?? '', 'allowed-once')
    assert.equal(result, 'answered')
    assert.equal(await held, 'allowed-once')
    assert.deepEqual(snapshotPendingApprovals('s1'), [])
  })

  it('allowed-once / rejected 两个值都原样回给宿主', async () => {
    for (const outcome of ['allowed-once', 'rejected'] as const) {
      const ctx = fakeCtx()
      const held = hold(ctx, `s-${outcome}`)
      const id = snapshotPendingApprovals(`s-${outcome}`)[0]?.id ?? ''
      assert.equal(answerApproval(`s-${outcome}`, id, outcome), 'answered')
      assert.equal(await held, outcome)
      resetApprovals()
    }
  })

  it('timeoutMs 到点后自动 cancelled，并清表', async () => {
    const ctx = fakeCtx()
    const held = hold(ctx, 's-timeout', {}, { timeoutMs: 20 })
    assert.equal(await held, 'cancelled')
    assert.deepEqual(snapshotPendingApprovals('s-timeout'), [])
  })

  it('已 abort 的 signal 立刻 cancelled（不挂住）', async () => {
    const ctx = fakeCtx()
    const controller = new AbortController()
    controller.abort()
    installApprovalAnswerer(ctx, 's-abort')
    const outcome = await (ctx.invoke(
      'approval/request',
      { agent: { session: { id: 's-abort' } }, toolName: 'bash', signal: controller.signal },
      async () => 'rejected',
    ) as Promise<string>)
    assert.equal(outcome, 'cancelled')
    assert.deepEqual(snapshotPendingApprovals('s-abort'), [])
  })

  it('response.signal 在挂住期间 abort → settle cancelled', async () => {
    const ctx = fakeCtx()
    const controller = new AbortController()
    installApprovalAnswerer(ctx, 's-live')
    const held = ctx.invoke(
      'approval/request',
      { agent: { session: { id: 's-live' } }, toolName: 'bash', signal: controller.signal },
      async () => 'rejected',
    ) as Promise<string>
    assert.equal(snapshotPendingApprovals('s-live').length, 1)
    controller.abort()
    assert.equal(await held, 'cancelled')
    assert.deepEqual(snapshotPendingApprovals('s-live'), [])
  })

  it('注销接管：待决项全部结算为 cancelled，且不再收新请求', async () => {
    const ctx = fakeCtx()
    const held = hold(ctx, 's-uninstall')
    assert.equal(ctx.listenerCount('approval/request'), 1)
    // 触发 disposer（fake 的 effect 回收）
    ctx.disposeEffects()
    assert.equal(await held, 'cancelled')
    assert.equal(ctx.listenerCount('approval/request'), 0)
  })

  it('多会话隔离：只结算自己会话的待决项', async () => {
    const ctxA = fakeCtx()
    const ctxB = fakeCtx()
    const heldA = hold(ctxA, 'iso-a')
    const heldB = hold(ctxB, 'iso-b')
    const idA = snapshotPendingApprovals('iso-a')[0]?.id ?? ''
    assert.equal(answerApproval('iso-a', idA, 'allowed-once'), 'answered')
    assert.equal(await heldA, 'allowed-once')
    assert.equal(snapshotPendingApprovals('iso-b').length, 1, 'B 的待决项不受影响')
    const list = listPendingApprovals()
    assert.equal(list.length, 1)
    assert.equal(list[0]?.sessionId, 'iso-b')
    assert.equal(answerApproval('iso-b', list[0]?.id ?? '', 'rejected'), 'answered')
    assert.equal(await heldB, 'rejected')
  })

  it('重复安装同会话：旧 bridge 的待决项先结算 cancelled', async () => {
    const ctx = fakeCtx()
    installApprovalAnswerer(ctx, 's-dup')
    const first = ctx.invoke(
      'approval/request',
      { agent: { session: { id: 's-dup' } }, toolName: 'bash' },
      async () => 'rejected',
    ) as Promise<string>
    installApprovalAnswerer(ctx, 's-dup')
    assert.equal(await first, 'cancelled')
    assert.deepEqual(snapshotPendingApprovals('s-dup'), [])
  })

  it('listPendingApprovals 按 since 非降序', async () => {
    const ctx = fakeCtx()
    installApprovalAnswerer(ctx, 'ord')
    const one = ctx.invoke(
      'approval/request',
      { agent: { session: { id: 'ord' } }, toolName: 'a' },
      async () => 'rejected',
    ) as Promise<string>
    one.catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 5))
    const two = ctx.invoke(
      'approval/request',
      { agent: { session: { id: 'ord' } }, toolName: 'b' },
      async () => 'rejected',
    ) as Promise<string>
    two.catch(() => {})
    const list = listPendingApprovals()
    assert.equal(list.length, 2)
    const sinces = list.map((item) => item.since)
    assert.deepEqual(sinces, [...sinces].sort((x, y) => x - y))
  })

  it('resolveArgs 按 callId 反查入参；反查抛错不影响审批', async () => {
    const ctx = fakeCtx()
    const resolver = (callId: string | undefined): string | undefined => {
      if (callId === undefined) throw new Error('boom')
      return '{"cmd":"ls"}'
    }
    hold(ctx, 's-args', { callId: 'c9' }, {}, resolver)
    const pending = snapshotPendingApprovals('s-args')[0]
    assert.equal(pending?.args, '{"cmd":"ls"}')
    assert.equal(pending?.callId, 'c9')
  })

  it('displayReason 原样透传（只展示，不持久化）', () => {
    const ctx = fakeCtx()
    hold(ctx, 's-display', { displayReason: { en: 'run bash', zh: '运行 bash' } })
    const pending = snapshotPendingApprovals('s-display')[0]
    assert.deepEqual(pending?.displayReason, { en: 'run bash', zh: '运行 bash' })
  })

  it('answerApproval 对未知 id / 未知会话给出可判读结果', () => {
    const ctx = fakeCtx()
    hold(ctx, 's-unknown')
    assert.equal(answerApproval('s-unknown', 'nope', 'allowed-once'), 'not-found')
    assert.equal(answerApproval('no-such-session', 'whatever', 'allowed-once'), 'session-gone')
  })

  it('非法 decision 被拒（不落进待决结算）', () => {
    const ctx = fakeCtx()
    hold(ctx, 's-bad')
    const id = snapshotPendingApprovals('s-bad')[0]?.id ?? ''
    // 运行期收窄：HTTP 层会先挡，但库层也不能把任意字符串当结果
    const bad = answerApproval('s-bad', id, 'allow' as never)
    assert.notEqual(bad, 'answered')
    assert.equal(snapshotPendingApprovals('s-bad').length, 1, '非法值不应结算掉待决项')
  })
})
