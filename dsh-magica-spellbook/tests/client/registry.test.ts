import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InteractionRegistry, carrierKey, claim } from '../../src/client/panel/registry.ts'
import type { PendingInteractionRecord } from '../../src/shared/interaction.ts'

function question(id: string, sessionId: string, since = 1): PendingInteractionRecord {
  return { kind: 'question', id, sessionId, since, questions: [{ id: 'q', question: 'x' }] }
}

function approval(id: string, sessionId: string, since = 1): PendingInteractionRecord {
  return { kind: 'approval', id, sessionId, since, toolName: 'bash' }
}

describe('carrierKey / claim', () => {
  it('key 是 kind:id（不是裸 id）', () => {
    assert.equal(carrierKey(question('a', 's')), 'question:a')
    assert.equal(carrierKey(approval('a', 's')), 'approval:a')
  })

  it('claim 按会话去重，取 since 最早的一条，结果按 since 升序', () => {
    const kept = claim([
      question('q2', 's1', 20),
      question('q1', 's1', 10),
      approval('a1', 's2', 5),
    ])
    assert.deepEqual(kept.map((record) => record.id), ['a1', 'q1'])
  })
})

describe('InteractionRegistry', () => {
  it('sync 发布新载体、摘掉消失的载体', () => {
    const calls: string[] = []
    const registry = new InteractionRegistry((record) => {
      calls.push(`publish:${carrierKey(record)}`)
      return () => calls.push(`unpublish:${carrierKey(record)}`)
    })

    registry.sync([question('q1', 's1')])
    assert.deepEqual(registry.keys(), ['question:q1'])
    registry.sync([question('q1', 's1'), approval('a1', 's2')])
    assert.deepEqual(registry.keys().sort(), ['approval:a1', 'question:q1'])
    registry.sync([approval('a1', 's2')])
    assert.deepEqual(registry.keys(), ['approval:a1'])
    // 同会话换载体：旧的必须被摘、新的必须发（顺序不敏感，靠 keys 断言结果）
    assert.deepEqual([...calls].sort(), ['publish:approval:a1', 'publish:question:q1', 'unpublish:question:q1'])
  })

  it('同会话换载体：先摘旧的、再发新的（不按 sessionId 一把清）', () => {
    const calls: string[] = []
    const registry = new InteractionRegistry((record) => {
      calls.push(`publish:${carrierKey(record)}`)
      return () => calls.push(`unpublish:${carrierKey(record)}`)
    })
    registry.sync([question('q1', 's1')])
    // 同一会话里 q1 结算、来了审批 a1
    registry.sync([approval('a1', 's1')])
    assert.deepEqual(registry.keys(), ['approval:a1'])
    // 同会话换载体：旧的必须被摘、新的必须发（顺序不敏感，靠 keys 断言结果）
    assert.deepEqual([...calls].sort(), ['publish:approval:a1', 'publish:question:q1', 'unpublish:question:q1'])
  })

  it('drop 按 kind:id 精确摘，未发布的 key 是无操作', () => {
    const calls: string[] = []
    const registry = new InteractionRegistry((record) => {
      calls.push(`publish:${carrierKey(record)}`)
      return () => calls.push(`unpublish:${carrierKey(record)}`)
    })
    registry.sync([question('q1', 's1')])
    registry.drop(approval('q1', 's1'))
    assert.deepEqual(calls, ['publish:question:q1'], 'kind 不同 → 不摘')
    registry.drop(question('q1', 's1'))
    assert.deepEqual(calls, ['publish:question:q1', 'unpublish:question:q1'])
    registry.drop(question('q1', 's1'))
    assert.equal(calls.length, 2, '重复摘是无操作')
  })

  it('publish 抛错记为 failed，不阻断其它载体', () => {
    const registry = new InteractionRegistry((record) => {
      if (record.kind === 'question') throw new Error('uiSession: duplicate key')
      return () => {}
    })
    const result = registry.sync([question('q1', 's1'), approval('a1', 's2')])
    assert.deepEqual(result.failed, ['question:q1'])
    assert.deepEqual(registry.keys(), ['approval:a1'])
  })

  it('clear 摘掉全部（幂等）', () => {
    const calls: string[] = []
    const registry = new InteractionRegistry((record) => () => calls.push(carrierKey(record)))
    registry.sync([question('q1', 's1'), approval('a1', 's2')])
    registry.clear()
    registry.clear()
    assert.deepEqual(calls.sort(), ['approval:a1', 'question:q1'])
    assert.deepEqual(registry.keys(), [])
  })
})
