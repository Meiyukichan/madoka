import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { collectPendingInteractions } from '../../src/interactions/collect.ts'
import { installApprovalAnswerer, resetApprovals } from '../../src/sessions/approval.ts'
import { installQuestionAnswerer, resetQuestions } from '../../src/sessions/questions.ts'
import { noteMagicaSession, resetMagicaSessionCache } from '../../src/interactions/ownership.ts'
import { fakeCtx } from '../helpers/fake.ts'

afterEach(() => {
  resetQuestions()
  resetApprovals()
  resetMagicaSessionCache()
})

/** 直接在白名单里登记，省掉台账文件。 */
function ctxWith(...sessionIds: string[]) {
  const ctx = fakeCtx()
  for (const id of sessionIds) noteMagicaSession(id)
  return ctx
}

describe('collectPendingInteractions', () => {
  it('透传 plan-review 的 intent（kind/approve/callId），卡片据此分流', () => {
    const ctx = ctxWith('s-plan')
    installQuestionAnswerer(ctx, 's-plan')
    const held = ctx.invoke(
      'user-questions/request',
      {
        agent: { session: { id: 's-plan' } },
        questions: [
          {
            id: 'plan',
            question: '批准这份计划吗？',
            options: [{ label: '批准' }, { label: '拒绝' }],
            intent: { kind: 'plan-review', approve: '批准' },
            wait: { callId: 'call-9', timed: true },
          },
        ],
      },
      async () => ({ answers: [] }),
    ) as Promise<unknown>
    held.catch(() => {})

    const items = collectPendingInteractions(ctx)
    assert.equal(items.length, 1)
    const question = items[0]?.kind === 'question' ? items[0].questions[0] : undefined
    assert.ok(question !== undefined)
    assert.deepEqual(question.intent, { kind: 'plan-review', approve: '批准' })
    assert.equal(question.options?.[0]?.label, '批准')
  })

  it('透传 wait.callId / waitTimed（0.2 限时提问）', () => {
    const ctx = ctxWith('s-timed')
    installQuestionAnswerer(ctx, 's-timed')
    const held = ctx.invoke(
      'user-questions/request',
      {
        agent: { session: { id: 's-timed' } },
        questions: [{ id: 'q', question: 'x' }],
        wait: { callId: 'c1', timed: true },
      },
      async () => ({ answers: [] }),
    ) as Promise<unknown>
    held.catch(() => {})

    const items = collectPendingInteractions(ctx)
    const question = items[0]?.kind === 'question' ? items[0].questions[0] : undefined
    assert.equal(question?.waitCallId, 'c1')
    assert.equal(question?.waitTimed, true)
  })

  it('非台账会话一律过滤；可按 sessionId 过滤；按 since 升序', async () => {
    // 两条会话各用**独立的 ctx**：fakeCtx.invoke 只调第一个监听器，
    // 同一个 ctx 上装两个 answerer 时第二个永远收不到（测试桩的局限，不是实现问题）。
    const ctxA = fakeCtx()
    const ctxB = fakeCtx()
    noteMagicaSession('a')
    noteMagicaSession('b')
    installQuestionAnswerer(ctxA, 'a')
    installQuestionAnswerer(ctxB, 'b')
    const heldA = ctxA.invoke(
      'user-questions/request',
      { agent: { session: { id: 'a' } }, questions: [{ id: 'qa', question: 'A' }] },
      async () => ({ answers: [] }),
    ) as Promise<unknown>
    heldA.catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 5))
    const heldB = ctxB.invoke(
      'user-questions/request',
      { agent: { session: { id: 'b' } }, questions: [{ id: 'qb', question: 'B' }] },
      async () => ({ answers: [] }),
    ) as Promise<unknown>
    heldB.catch(() => {})

    const host = fakeCtx()
    const all = collectPendingInteractions(host)
    assert.deepEqual([...all.map((item) => item.sessionId)].sort(), ['a', 'b'])
    const sinces = all.map((item) => item.since)
    assert.deepEqual(sinces, [...sinces].sort((x, y) => x - y), 'since 必须非降序')
    const onlyB = collectPendingInteractions(host, { sessionId: 'b' })
    assert.deepEqual(onlyB.map((item) => item.sessionId), ['b'])
  })

  it('审批的 args 会被截断（clipArgs），并保留 toolName/callId/displayReason', async () => {
    const ctx = ctxWith('s-app')
    const longArgs = JSON.stringify({ cmd: 'x'.repeat(5000) })
    // dsh 0.2 的 ApprovalRequestEvent **没有 args**：入参由 resolveArgs 按 callId 反查
    installApprovalAnswerer(ctx, 's-app', {}, () => longArgs)
    const held = ctx.invoke(
      'approval/request',
      {
        agent: { session: { id: 's-app' } },
        toolName: 'bash',
        callId: 'call-1',
        reason: 'run it',
        displayReason: { en: 'run it', zh: '运行它' },
      },
      async () => 'rejected',
    ) as Promise<unknown>
    held.catch(() => {})

    const items = collectPendingInteractions(ctx, { maxArgsChars: 100 })
    const approval = items[0]
    assert.equal(approval?.kind, 'approval')
    if (approval?.kind !== 'approval') return
    assert.equal(approval.toolName, 'bash')
    assert.equal(approval.callId, 'call-1')
    assert.deepEqual(approval.displayReason, { en: 'run it', zh: '运行它' })
    assert.ok((approval.args ?? '').length <= 120, 'args 必须被截断')
    assert.match(approval.args ?? '', /…/, '截断要有省略号')
  })
})
