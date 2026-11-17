import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CLIENT_SERVICES,
  HOST_EVENTS,
  HOST_SERVICES,
  describeHostRequirements,
  requiredHostServices,
} from '../../src/shared/host-contract.ts'

/**
 * 「会话能力从哪来」的契约测试：本库对 dsh 是**零 import**，
 * 会话能力全靠宿主 ctx 里的 service。这个文件把契约钉住，
 * 防止有人误把 dsh 包写进 dependencies/peerDependencies。
 */
describe('宿主服务契约', () => {
  it('只有 agents 是硬要求（其余缺失都能降级）', () => {
    assert.deepEqual(requiredHostServices(), ['agents'])
    const required = HOST_SERVICES.filter((item) => item.required).map((item) => item.name)
    assert.deepEqual(required, ['agents'])
  })

  it('每条都写明提供方与缺失行为', () => {
    for (const item of HOST_SERVICES) {
      assert.match(item.name, /^[a-zA-Z][a-zA-Z0-9]*$/)
      assert.ok(item.providedBy.length > 0, `${item.name} 缺 providedBy`)
      assert.ok(item.note.length > 0, `${item.name} 缺 note`)
    }
  })

  it('事件模式：session/agent 事件是 on，提问/审批是 waterfall 认领', () => {
    const map = new Map(HOST_EVENTS.map((item) => [item.event, item.mode]))
    assert.equal(map.get('session/event'), 'on')
    assert.equal(map.get('agent/disposed'), 'on')
    assert.equal(map.get('user-questions/request'), 'waterfall')
    assert.equal(map.get('approval/request'), 'waterfall')
  })

  it('客户端只有 uiSession 是硬要求', () => {
    assert.deepEqual(
      CLIENT_SERVICES.filter((item) => item.required).map((item) => item.name),
      ['uiSession'],
    )
  })

  it('describeHostRequirements 输出可读摘要（供报错/文档用）', () => {
    const text = describeHostRequirements()
    assert.match(text, /host services:/)
    assert.match(text, /必需 agents/)
    assert.match(text, /waterfall approval\/request/)
    assert.match(text, /client services:/)
  })
})
