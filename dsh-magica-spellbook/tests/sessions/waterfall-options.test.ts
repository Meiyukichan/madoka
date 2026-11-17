import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { installApprovalAnswerer, resetApprovals, snapshotPendingApprovals } from '../../src/sessions/approval.ts'
import {
  answerQuestion,
  installQuestionAnswerer,
  resetQuestions,
  snapshotPendingQuestions,
} from '../../src/sessions/questions.ts'
import { WATERFALL_TAKEOVER } from '../../src/shared/interaction.ts'
import { fakeCtx } from '../helpers/fake.ts'

afterEach(() => {
  resetQuestions()
  resetApprovals()
})

/** 逼出一个被挂住的提问（返回 settle 后的 promise，便于断言）。 */
function holdQuestion(ctx: ReturnType<typeof fakeCtx>, sessionId: string) {
  installQuestionAnswerer(ctx, sessionId)
  return ctx.invoke(
    'user-questions/request',
    {
      agent: { session: { id: sessionId } },
      questions: [{ id: 'q1', question: '选？', options: [{ label: 'A' }, { label: 'B' }] }],
    },
    async () => ({ answers: [] }),
  ) as Promise<unknown>
}

describe('waterfall 注册选项（G-4：prepend + global 必须可断言）', () => {
  it('提问接管用 { prepend: true, global: true }', () => {
    const ctx = fakeCtx()
    installQuestionAnswerer(ctx, 's-opt')
    const options = ctx.listenerOptions('user-questions/request')
    assert.equal(options.length, 1)
    assert.deepEqual(options[0], WATERFALL_TAKEOVER)
    assert.equal(WATERFALL_TAKEOVER.prepend, true)
    assert.equal(WATERFALL_TAKEOVER.global, true)
    resetQuestions()
  })

  it('审批接管用 { prepend: true, global: true }', () => {
    const ctx = fakeCtx()
    installApprovalAnswerer(ctx, 's-opt2')
    const options = ctx.listenerOptions('approval/request')
    assert.deepEqual(options[0], WATERFALL_TAKEOVER)
    resetApprovals()
  })
})

describe('提问的 cancel 语义', () => {
  it('cancelQuestion 结算挂住的 Promise（走 not_found/invalid 之外的正常路径）', async () => {
    const ctx = fakeCtx()
    const held = holdQuestion(ctx, 's-cancel')
    const settled = held.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const pending = snapshotPendingQuestions('s-cancel')
    assert.equal(pending.length, 1)
    const id = pending[0]?.id ?? ''
    assert.notEqual(id, '')

    const result = answerQuestion('s-cancel', id, { answers: [{ id: 'q1', selected: ['A'] }] })
    assert.notEqual(result, 'not_found')
    const outcome = await settled
    assert.equal(outcome.ok, true)
    // 结算后待决表清空
    assert.deepEqual(snapshotPendingQuestions('s-cancel'), [])
    resetQuestions()
  })
})
