/**
 * 「连续工具调用无文本输出」提醒的纯逻辑测试。
 *
 * 只测 `advance` / `hasTextOutput` / `isSubagentSession` / `buildContextMessage`：
 * 事件订阅与投递是接线，由 E2E 覆盖。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  advance, buildContextMessage, EMPTY_COUNTERS, hasTextOutput, isSubagentSession, nudgeText,
} from '../src/nudge.ts'

const TIMING = { everyToolCalls: 7, remindEvery: 7 }

const tool = (seq: number) => ({ type: 'tool/call', seq, data: { name: 'x' } })
const text = (seq: number) => ({ type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text: 'done' }] } } })

/** 依次喂事件，返回每一步的 `remind`（undefined 表示没触发）。 */
function run(events: Array<{ type: string; seq?: number; data?: unknown }>, timing = TIMING) {
  let counters = EMPTY_COUNTERS
  const reminders: Array<string | undefined> = []
  for (const event of events) {
    const outcome = advance(counters, event, timing)
    counters = outcome.counters
    reminders.push(outcome.remind)
  }
  return { counters, reminders }
}

describe('advance：计数与触发', () => {
  it('连续 7 次工具调用触发一次，且只在第 7 次触发', () => {
    const { counters, reminders } = run([1, 2, 3, 4, 5, 6, 7].map(tool))
    assert.equal(reminders.filter(Boolean).length, 1)
    assert.match(String(reminders[6]), /7 consecutive tool calls/)
    assert.equal(counters.toolCalls, 7)
    assert.equal(counters.nudgedAt, 7)
  })

  it('第 6 次不触发', () => {
    const { reminders } = run([1, 2, 3, 4, 5, 6].map(tool))
    assert.deepEqual(reminders, [undefined, undefined, undefined, undefined, undefined, undefined])
  })

  it('有文本输出后清零，重新数到 7 才再提醒', () => {
    const { counters, reminders } = run([
      ...[1, 2, 3, 4, 5, 6, 7].map(tool),
      { type: 'assistant/message', seq: 8, data: { message: { content: [{ type: 'text', text: 'here you go' }] } } },
      ...[9, 10, 11, 12, 13, 14, 15].map(tool),
    ])
    assert.equal(reminders.filter(Boolean).length, 2)
    assert.equal(counters.toolCalls, 7)
  })

  it('纯空白文本不算输出（thinking/工具块也不算）', () => {
    const { counters } = run([
      ...Array.from({ length: 7 }, (_, i) => tool(i + 1)),
      { type: 'assistant/message', seq: 8, data: { content: [{ type: 'text', text: '   \n ' }] } },
      { type: 'assistant/message', seq: 9, data: { message: { content: [{ type: 'thinking', text: 'hmm' }] } } },
    ])
    assert.equal(counters.toolCalls, 7, '空白/思考不应清零')
  })

  it('remindEvery=14 时：第一次提醒推迟到第 14 次，之后每 14 次一次', () => {
    // remindEvery 是「两次提醒之间的最小间隔」，所以它 >= everyToolCalls 时，
    // 第一次提醒发生在第 14 次（而不是第 7 次）。
    const fourteen = run([...Array.from({ length: 14 }, (_, i) => tool(i + 1))], { everyToolCalls: 7, remindEvery: 14 })
    assert.equal(fourteen.reminders.filter(Boolean).length, 1, '14 次里提醒一次')
    assert.match(String(fourteen.reminders[13]), /14 consecutive tool calls/)

    const twentyEight = run([...Array.from({ length: 28 }, (_, i) => tool(i + 1))], { everyToolCalls: 7, remindEvery: 14 })
    assert.equal(twentyEight.reminders.filter(Boolean).length, 2, '28 次里提醒两次')
    assert.match(String(twentyEight.reminders[27]), /28 consecutive tool calls/)
  })

  it('旧序号事件被忽略（会话恢复重放）', () => {
    const { counters, reminders } = run([tool(5), tool(3), tool(1)])
    assert.equal(counters.toolCalls, 1)
    assert.equal(reminders.filter(Boolean).length, 0)
  })

  it('超过阈值后没有新文本也不会每步重复提醒', () => {
    const { reminders } = run([...Array.from({ length: 10 }, (_, i) => tool(i + 1))])
    assert.equal(reminders.filter(Boolean).length, 1)
  })
})

describe('hasTextOutput', () => {
  const wrap = (content: unknown[]) => ({ message: { content } })

  it('识别 content 里的 text 块', () => {
    assert.equal(hasTextOutput(wrap([{ type: 'text', text: 'hi' }])), true)
  })

  it('思考块（type 不是 text）不算', () => {
    assert.equal(hasTextOutput(wrap([{ type: 'thinking', text: 'hmm' }])), false)
    assert.equal(hasTextOutput(wrap([{ type: 'reasoning', text: 'hmm' }])), false)
  })

  it('纯空白与空数组不算', () => {
    assert.equal(hasTextOutput(wrap([{ type: 'text', text: '   \n ' }])), false)
    assert.equal(hasTextOutput(wrap([])), false)
    assert.equal(hasTextOutput(undefined), false)
    assert.equal(hasTextOutput({}), false)
  })

  it('工具块不算文本', () => {
    assert.equal(hasTextOutput(wrap([{ type: 'tool-call', name: 'x' }])), false)
  })

  it('思考与回答混排：有回答就算说话', () => {
    assert.equal(hasTextOutput(wrap([{ type: 'thinking', text: 'x' }, { type: 'text', text: '结论' }])), true)
  })
})

describe('isSubagentSession', () => {
  it('origin=subagent 判定为子代理', () => {
    assert.equal(isSubagentSession({ id: 's', header: { origin: 'subagent' } }), true)
  })

  it('带 parentSession 判定为子代理（fork 也算，避免重复提醒）', () => {
    assert.equal(isSubagentSession({ id: 's', header: { parentSession: 'p' } }), true)
  })

  it('普通会话不是子代理', () => {
    assert.equal(isSubagentSession({ id: 's', header: {} }), false)
    assert.equal(isSubagentSession({ id: 's' }), false)
    assert.equal(isSubagentSession(undefined), false)
  })
})

describe('nudgeText / buildContextMessage', () => {
  it('语气递增：第一次轻、第二次中、第三次起重', () => {
    const first = nudgeText(10, 1)
    const second = nudgeText(20, 2)
    const third = nudgeText(30, 3)
    assert.match(first, /1-3 sentences/)
    assert.match(second, /previous nudge was ignored/)
    assert.match(third, /Reminder #3/)
    // 三次都点明「连续 N 次没有文本」
    for (const text of [first, second, third]) assert.match(text, /consecutive tool calls|tool calls in a row/)
  })

  it('有文本输出后语气也归零（level 重置）', () => {
    const { counters } = run([
      ...Array.from({ length: 30 }, (_, i) => tool(i + 1)),
      { type: 'assistant/message', seq: 31, data: { message: { content: [{ type: 'text', text: '汇报' }] } } },
    ])
    assert.equal(counters.level, 0)
    const after = run([
      ...Array.from({ length: 30 }, (_, i) => tool(i + 1)),
      { type: 'assistant/message', seq: 31, data: { message: { content: [{ type: 'text', text: '汇报' }] } } },
      ...Array.from({ length: 7 }, (_, i) => tool(32 + i)),
    ])
    // 归零后从 1 开始数：第 7 次要达到 7 才触发（阈值 7），语气回到 level 1
    assert.match(String(after.reminders[after.reminders.length - 1] ?? ''), /1-3 sentences/)
  })

  it('文案是简短英文，且带次数', () => {
    const value = nudgeText(7)
    assert.match(value, /7 consecutive tool calls/)
    assert.ok(value.split('\n').length <= 3, '不超过三行')
  })

  it('上下文消息是 dsh 认的具名快照形状', () => {
    const message = buildContextMessage('dsh-magica-rune', 'hi', 'nudge') as {
      role: string; content: Array<{ type: string; text: string }>; source: Record<string, unknown>
    }
    assert.equal(message.role, 'user')
    assert.deepEqual(message.content, [{ type: 'text', text: 'hi' }])
    assert.equal(message.source.plugin, 'dsh-magica-rune')
    assert.equal(message.source.kind, 'nudge')
    assert.equal(message.source.form, 'snapshot')
    assert.deepEqual(message.source.sections, [{ name: 'nudge', text: 'hi' }])
  })
})

describe('默认值', () => {
  it('Config 里的默认是 15 次（不是 7 次）', () => {
    // 不 import config.ts：单测环境没有 @deepseek-ai/schemastery（那是 typecheck-only 的 peer）。
    const source = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8')
    assert.match(source, /everyToolCalls: z\.number\(\)\.default\(15\)/)
    assert.match(source, /remindEvery: z\.number\(\)\.default\(15\)/)
    assert.doesNotMatch(source, /default\(7\)/)
  })

  it('15 次才触发（7 次不触发）', () => {
    const { reminders } = run([...Array.from({ length: 15 }, (_, i) => tool(i + 1))], { everyToolCalls: 15, remindEvery: 15 })
    assert.equal(reminders.filter(Boolean).length, 1)
    assert.equal(reminders[6], undefined, '第 7 次不应触发')
    assert.match(String(reminders[14]), /15 consecutive tool calls/)
  })
})
