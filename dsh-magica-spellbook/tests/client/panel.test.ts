import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  INTERACTION_TAG,
  PendingInteractionCarrier,
  interactionRecords,
  isInteractionCarrier,
} from '../../src/client/panel/carrier.ts'
import { en, makeTranslate, zh } from '../../src/client/panel/locales.ts'
import { INTERACTION_STYLE_ID, INTERACTION_STYLES } from '../../src/client/panel/styles.ts'
import { createInteractionTransport } from '../../src/client/panel/transport.ts'
import { serviceOf } from '../../src/client/panel/services.ts'
import type { PendingInteractionRecord } from '../../src/shared/interaction.ts'

const questionRecord: PendingInteractionRecord = {
  kind: 'question',
  id: 'q1',
  sessionId: 's1',
  since: 100,
  questions: [{ id: '1', question: '选哪个？' }],
}

const approvalRecord: PendingInteractionRecord = {
  kind: 'approval',
  id: 'a1',
  sessionId: 's2',
  since: 50,
  toolName: 'bash',
}

describe('carrier', () => {
  it('key = kind:id，且带标记字段', () => {
    const carrier = new PendingInteractionCarrier(questionRecord)
    assert.equal(carrier.key, 'question:q1')
    assert.equal(carrier.kind, 'question')
    assert.equal(carrier.sessionId, 's1')
    assert.equal(carrier.tag, INTERACTION_TAG)
    assert.equal(isInteractionCarrier(carrier), true)
  })

  it('只认标记字段，不认结构相似的陌生对象', () => {
    assert.equal(isInteractionCarrier({ tag: 'other', key: 'k', kind: 'k', sessionId: 's' }), false)
    assert.equal(isInteractionCarrier({ key: 'k', kind: 'k', sessionId: 's' }), false)
    assert.equal(isInteractionCarrier(null), false)
    assert.equal(isInteractionCarrier('x'), false)
  })

  it('interactionRecords 只挑本 SDK 的载体并按 since 升序', () => {
    const snapshot = new Map<string, unknown>([
      ['question:q1', new PendingInteractionCarrier(questionRecord)],
      ['approval:a1', new PendingInteractionCarrier(approvalRecord)],
      ['foreign', { tag: 'someone-else', key: 'f', kind: 'f', sessionId: 's3' }],
    ])
    const records = interactionRecords(snapshot)
    assert.deepEqual(
      records.map((record) => record.id),
      ['a1', 'q1'],
    )
  })
})

describe('locales', () => {
  it('中英键集完全一致', () => {
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  })

  it('makeTranslate 支持 {param} 插值并回退 key', () => {
    const t = makeTranslate(zh)
    assert.equal(t('ix.progress', { current: '2', total: '3' }), '2 / 3')
    assert.equal(makeTranslate(en)('ix.next'), 'Next')
    // 未知 key 原样返回（类型层不允许，运行时容错）
    assert.equal(t('ix.unknown' as never), 'ix.unknown')
  })
})

describe('styles', () => {
  it('统一前缀、无硬编码颜色、无深色主题选择器', () => {
    assert.equal(INTERACTION_STYLE_ID, 'magica-ix-styles')
    assert.match(INTERACTION_STYLES, /\.magica-ix-card\{/)
    assert.doesNotMatch(INTERACTION_STYLES, /#[0-9a-fA-F]{3,6}\b/)
    assert.doesNotMatch(INTERACTION_STYLES, /rgba?\(/)
    assert.doesNotMatch(INTERACTION_STYLES, /data-ds-dark-theme/)
    assert.match(INTERACTION_STYLES, /--dsw-alias-/)
  })
})

describe('transport', () => {
  const original = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = original
  })

  it('list 解包信封', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, value: { items: [questionRecord] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    const transport = createInteractionTransport()
    const items = await transport.list()
    assert.equal(items.length, 1)
    assert.equal(items[0]?.id, 'q1')
  })

  it('list 失败信封抛错（读操作不折成 Result）', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'nope' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    await assert.rejects(() => createInteractionTransport().list(), /forbidden: nope/)
  })

  it('answerQuestion 成功 → { ok: true }，失败 → { ok: false, error }', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, value: { result: 'answered' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    assert.deepEqual(
      await createInteractionTransport().answerQuestion(questionRecord, [{ id: '1', selected: ['A'] }]),
      { ok: true },
    )

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'gone' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    const failed = await createInteractionTransport().answerApproval(approvalRecord, 'rejected')
    assert.equal(failed.ok, false)
    assert.match(failed.ok === false ? failed.error : '', /not_found/)
  })

  it('请求打到 prefix + 约定路径', async () => {
    const seen: string[] = []
    globalThis.fetch = (async (url: string) => {
      seen.push(url)
      return new Response(JSON.stringify({ ok: true, value: { items: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    await createInteractionTransport({ prefix: '/magica' }).list()
    assert.deepEqual(seen, ['/magica/interactions'])
  })

  it('list 形状容错：响应没有 items 时返回空数组（不抛进轮询）', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, value: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    assert.deepEqual(await createInteractionTransport().list(), [])
  })
})

describe('DirectoryBrowser 文案（G1 P0-4 回归）', () => {
  const BROWSER_KEYS = [
    'browser.title',
    'browser.loading',
    'browser.open',
    'browser.cancel',
    'browser.create',
    'browser.newFolder',
    'browser.folderName',
    'browser.showHidden',
    'browser.editPath',
  ] as const

  it('9 个 browser.* key 在 zh / en 里都存在（消费方注册一次即可用）', () => {
    for (const key of BROWSER_KEYS) {
      assert.ok(key in zh, `zh 缺 ${key}`)
      assert.ok(key in en, `en 缺 ${key}`)
      assert.notEqual((zh as Record<string, string>)[key], '', `${key} 不能为空`)
    }
  })

  it('makeTranslate 能翻译 browser.* 且不是回显 key', () => {
    const t = makeTranslate(zh)
    assert.equal(t('browser.title'), '选择目录')
    assert.equal(makeTranslate(en)('browser.open'), 'Open')
  })
})

describe('serviceOf 取用韧性（G1 P0-1 回归）', () => {

})

describe('A 组收尾项（Round 9）', () => {
  it('卡片/审批卡重绑了浮层描边与滚动条 token（T4）', () => {
    for (const name of ['--dsw-elevation-stroke-color', '--dsh-scrollbar-thumb', '--dsh-scrollbar-thumb-hover']) {
      assert.ok(INTERACTION_STYLES.includes(name), `样式里缺 ${name}`)
    }
    // 仍然不硬编码颜色
    assert.doesNotMatch(INTERACTION_STYLES, /#[0-9a-fA-F]{3,6}\b/)
    assert.doesNotMatch(INTERACTION_STYLES, /rgba?\(/)
  })

  it('自定义答案用自增高 textarea 样式（T8）', () => {
    assert.match(INTERACTION_STYLES, /\.magica-ix-fieldInput\{[^}]*resize:none/)
    assert.match(INTERACTION_STYLES, /\.magica-ix-fieldInput\{[^}]*overflow-y:auto/)
    assert.match(INTERACTION_STYLES, /\.magica-ix-fieldMirror\{[^}]*max-height:144px/)
  })

  it('选择框指标位与 dsh QuestionComposer 一致（单选序号 / 多选勾选框）', () => {
    // dsh：.number 是 20×20、12px/500 的序号座；.checkbox 是 14×14 描边块。
    assert.match(INTERACTION_STYLES, /\.magica-ix-number\{[^}]*font-size:12px/)
    assert.match(INTERACTION_STYLES, /\.magica-ix-number\{[^}]*border-radius:var\(--dsw-radius-xs,4px\)/)
    assert.match(INTERACTION_STYLES, /\.magica-ix-checkbox::before\{[^}]*width:14px;height:14px/)
    // 选项行几何：md 圆角、40px 最小高、8px 左内边距。
    assert.match(INTERACTION_STYLES, /\.magica-ix-option\{[^}]*min-height:40px/)
    assert.match(INTERACTION_STYLES, /\.magica-ix-option\{[^}]*border-radius:var\(--dsw-radius-md,12px\)/)
    // 单选选中态才有底色/描边；多选只体现在勾选框。
    assert.match(INTERACTION_STYLES, /\.magica-ix-optionSelected\{border-color:var\(--dsw-alias-border-l2\);\}/)
  })

  it('目录截断提示有中英文案（T5）', () => {
    for (const key of ['browser.truncated'] as const) {
      assert.ok(key in zh, `zh 缺 ${key}`)
      assert.ok(key in en, `en 缺 ${key}`)
    }
    // 键集仍然一致
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  })
})