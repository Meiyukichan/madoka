import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { APPROVAL_OUTCOMES, isApprovalOutcome } from '../../src/sessions/approval.ts'

describe('审批结果闭集（E-154 钉住）', () => {
  it('精确元组：四值且顺序固定（dsh 增删取值这里必红）', () => {
    assert.deepEqual([...APPROVAL_OUTCOMES], ['allowed-once', 'rejected', 'cancelled', 'unavailable'])
    assert.equal(APPROVAL_OUTCOMES.length, 4)
    assert.equal(new Set(APPROVAL_OUTCOMES).size, 4, '不能有重复值')
  })

  it('不可变（Object.freeze）', () => {
    assert.equal(Object.isFrozen(APPROVAL_OUTCOMES), true)
    assert.throws(() => {
      // @ts-expect-error 运行期验证冻结语义
      APPROVAL_OUTCOMES.push('denied')
    }, /read only|not extensible/i)
  })

  it('isApprovalOutcome 收窄', () => {
    for (const value of APPROVAL_OUTCOMES) assert.equal(isApprovalOutcome(value), true)
    for (const value of ['allowed', 'denied', '', null, undefined, 1, {}]) {
      assert.equal(isApprovalOutcome(value), false)
    }
  })
})
