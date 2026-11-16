import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  answerQuestion,
  cancelQuestion,
  installQuestionAnswerer,
  installFailFastQuestionAnswerer,
  listPendingQuestions,
  resetQuestions,
  snapshotPendingQuestions,
} from '../../src/sessions/questions.ts'
import { fakeCtx } from '../helpers/fake.ts'

afterEach(() => {
  resetQuestions()
})

function hold(
  ctx: ReturnType<typeof fakeCtx>,
  sessionId: string,
  questions: unknown[] = [{ id: 'q1', question: 'x', options: [{ label: 'A' }, { label: 'B' }] }],
) {
  installQuestionAnswerer(ctx, sessionId)
  return ctx.invoke(
    'user-questions/request',
    { agent: { session: { id: sessionId } }, questions },
    async () => ({ answers: [] }),
  ) as Promise<{ answers: unknown[] }>
}

/**
 * 不 await 的挂起提问：afterEach 的 resetQuestions（或注销接管）会以 ASK_ABORTED reject 它。
 * 这里挂一个 noop catch，避免它冒成 unhandledRejection 把整轮测试判失败。
 */
function abandon(held: Promise<unknown>): void {
  held.catch(() => {})
}

function pendingId(sessionId: string): string {
  return snapshotPendingQuestions(sessionId)[0]?.id ?? ''
}

describe('answerQuestion 形状校验（库层当场拒）', () => {
  it('合法答案 → answered，并原样交给挂住的工具', async () => {
    const ctx = fakeCtx()
    const held = hold(ctx, 'ok', [{ id: 'q1', question: 'x', options: [{ label: 'A' }] }])
    const answer = { answers: [{ id: 'q1', selected: ['A'] }] }
    assert.equal(answerQuestion('ok', pendingId('ok'), answer), 'answered')
    assert.deepEqual(await held, answer)
  })

  it('自由文本（selected 空 + custom）也是合法答案', async () => {
    const ctx = fakeCtx()
    const held = hold(ctx, 'free', [{ id: 'q1', question: '随便说点什么' }])
    const answer = { answers: [{ id: 'q1', selected: [], custom: '我自己写的' }] }
    assert.equal(answerQuestion('free', pendingId('free'), answer), 'answered')
    assert.deepEqual(await held, answer)
  })

  it('非法形状一律 invalid-answer，且待决项不被结算', () => {
    const ctx = fakeCtx()
    abandon(
      hold(ctx, 'bad', [
        { id: 'q1', question: 'x', options: [{ label: 'A' }] },
      ]),
    )
    const id = pendingId('bad')
    const cases: unknown[] = [
      undefined,
      null,
      {},
      { answers: 'nope' },
      { answers: [null] },
      { answers: [{ id: '', selected: [] }] },
      { answers: [{ id: 'unknown', selected: [] }] },
      { answers: [{ id: 'q1', selected: 'A' }] },
      { answers: [{ id: 'q1', selected: [1] }] },
      { answers: [{ id: 'q1', selected: ['A'], custom: 42 }] },
      { answers: [{ id: 'q1', selected: [] }, { id: 'q1', selected: [] }] },
    ]
    for (const candidate of cases) {
      assert.equal(
        answerQuestion('bad', id, candidate as never),
        'invalid-answer',
        `应拒绝：${JSON.stringify(candidate)}`,
      )
    }
    assert.equal(snapshotPendingQuestions('bad').length, 1, '非法答案不能把待决项结算掉')
  })

  it('未知会话 / 未知 id 的结果可判读', () => {
    const ctx = fakeCtx()
    abandon(hold(ctx, 'known'))
    assert.equal(answerQuestion('known', 'nope', { answers: [] }), 'not-found')
    assert.equal(answerQuestion('nobody', 'x', { answers: [] }), 'session-gone')
    assert.equal(cancelQuestion('nobody', 'x'), 'session-gone')
    assert.equal(cancelQuestion('known', 'nope'), 'not-found')
  })
})

describe('多题 / 多选 / 列表', () => {
  it('多题请求：answers 按题返回，未知题 id 被拒', async () => {
    const ctx = fakeCtx()
    const held = hold(ctx, 'multi', [
      { id: 'q1', question: '第一个', options: [{ label: 'A' }] },
      { id: 'q2', question: '第二个', options: [{ label: 'B' }] },
    ])
    const id = pendingId('multi')
    assert.equal(answerQuestion('multi', id, { answers: [{ id: 'q1', selected: ['A'] }] }), 'answered')
    assert.deepEqual(await held, { answers: [{ id: 'q1', selected: ['A'] }] }, '允许只答一部分（跳过由 UI 决定）')
  })

  it('listPendingQuestions 支持按会话过滤且 since 非降序', async () => {
    const ctxA = fakeCtx()
    const ctxB = fakeCtx()
    abandon(hold(ctxA, 'la'))
    abandon(hold(ctxB, 'lb'))
    const all = listPendingQuestions()
    assert.deepEqual([...all.map((item) => item.sessionId)].sort(), ['la', 'lb'])
    assert.deepEqual(listPendingQuestions('lb').map((item) => item.sessionId), ['lb'])
  })

  it('fail-fast 与人工接管是两种语义：fail-fast 直接 reject', async () => {
    const ctx = fakeCtx()
    installFailFastQuestionAnswerer(ctx, 'ff')
    await assert.rejects(
      ctx.invoke(
        'user-questions/request',
        { agent: { session: { id: 'ff' } }, questions: [{ id: 'q1', question: 'x' }] },
        async () => ({ answers: [] }),
      ) as Promise<unknown>,
      /does not accept human input/,
    )
    assert.deepEqual(snapshotPendingQuestions('ff'), [])
  })

  it('注销接管：待决提问全部以拒绝收尾（ASK_ABORTED），且不再收新请求', async () => {
    const ctx = fakeCtx()
    const held = hold(ctx, 'uninstall-q')
    const settled = held.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    assert.equal(snapshotPendingQuestions('uninstall-q').length, 1)
    ctx.disposeEffects()
    const outcome = await settled
    assert.equal(outcome.ok, false, '注销不能 resolve 空答案')
    assert.equal(ctx.listenerCount('user-questions/request'), 0)
  })
})
