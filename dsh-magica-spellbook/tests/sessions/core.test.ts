import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_PERMISSION_PRESET,
  SESSION_ID_SAFE,
  SessionResumeError,
  TURN_END_KINDS,
  applyPermission,
  buildPluginMessage,
  buildUserMessage,
  describeTurnEnd,
  emptyRunState,
  errorMessage,
  extractAssistantText,
  isTurnCompleted,
  mintMessageId,
  pickModel,
  resolveAgents,
  resolvePermission,
  resolveResumeTarget,
  snapshotRunState,
  toContextEntries,
  toResumeError,
} from '../../src/sessions/core.ts'
import { fakeCtx } from '../helpers/fake.ts'

describe('结局判定', () => {
  it('TURN_END_KINDS 是 7 个且顺序锁定（0.2 新增 forked）', () => {
    assert.deepEqual(
      [...TURN_END_KINDS],
      ['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked'],
    )
  })

  it('只有 completed 算完成，undefined 不算', () => {
    for (const kind of TURN_END_KINDS) {
      assert.equal(isTurnCompleted({ kind } as never), kind === 'completed')
    }
    assert.equal(isTurnCompleted(undefined), false)
  })

  it('describeTurnEnd 的 9 条精确文案', () => {
    assert.equal(describeTurnEnd(undefined), 'no turn/end observed')
    assert.equal(describeTurnEnd({ kind: 'completed' }), 'completed')
    assert.equal(describeTurnEnd({ kind: 'aborted', reason: { kind: 'hook', reason: 'x' } }), 'aborted (hook)')
    assert.equal(describeTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }), 'aborted (user)')
    assert.equal(describeTurnEnd({ kind: 'blocked' }), 'blocked')
    assert.equal(describeTurnEnd({ kind: 'error', error: { message: 'boom' } }), 'error: boom')
    assert.equal(describeTurnEnd({ kind: 'error', error: {} }), 'error: unknown')
    assert.equal(describeTurnEnd({ kind: 'max-tokens' }), 'output truncated (max-tokens)')
    assert.equal(describeTurnEnd({ kind: 'interrupted' }), 'interrupted (crash recovery)')
    assert.equal(describeTurnEnd({ kind: 'forked' }), 'forked (fork seed)')
  })
})

describe('消息构造', () => {
  it('buildUserMessage：source 只有 user，字符串数组 → 多 block', () => {
    const single = buildUserMessage('hi')
    assert.deepEqual(single.source, { kind: 'user' })
    assert.equal(single.content.length, 1)
    assert.equal(typeof single.id, 'string')

    const many = buildUserMessage(['A', 'B'])
    assert.deepEqual(
      many.content.map((block) => block.text),
      ['A', 'B'],
    )
  })

  it('buildPluginMessage 无名：用默认 kind（v4 拒绝 plugin 这个 kind）', () => {
    const message = buildPluginMessage('@x/y', '规则')
    assert.deepEqual(message.source, {
      kind: 'spellbook-context',
      plugin: '@x/y',
      form: 'snapshot',
      sections: [{ name: 'spellbook-context', text: '规则' }],
    })
    assert.notEqual((message.source as { kind: string }).kind, 'plugin')
  })

  it("buildPluginMessage 拒绝把 section 取名 'plugin'（v4 会整条 event 抛错）", () => {
    assert.throws(() => buildPluginMessage('@x/y', '规则', 'plugin'), /retired plugin source kind/)
  })

  it('buildPluginMessage 具名：section 名当 kind，且带 form + sections', () => {
    const message = buildPluginMessage('@x/y', '规则', 'lattice-rules')
    assert.deepEqual(message.source, {
      kind: 'lattice-rules',
      plugin: '@x/y',
      form: 'snapshot',
      sections: [{ name: 'lattice-rules', text: '规则' }],
    })
  })

  it('mintMessageId 连续 200 次不重复', () => {
    const ids = new Set<string>()
    for (let index = 0; index < 200; index += 1) ids.add(mintMessageId())
    assert.equal(ids.size, 200)
  })

  it('toContextEntries 归一与丢弃', () => {
    assert.deepEqual(toContextEntries(undefined), [])
    assert.deepEqual(toContextEntries(''), [])
    assert.deepEqual(toContextEntries('x'), [{ text: 'x' }])
    assert.deepEqual(toContextEntries({ name: '', text: 'y' }), [{ text: 'y' }])
    assert.deepEqual(toContextEntries({ name: 'n', text: 'y' }), [{ name: 'n', text: 'y' }])
    assert.deepEqual(toContextEntries([{ name: 'n', text: '' }, { name: 'm', text: 'ok' }]), [
      { name: 'm', text: 'ok' },
    ])
  })

  it('extractAssistantText 多 block 用 join("")，过滤 reasoning/tool-call', () => {
    const text = extractAssistantText({
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'text', text: '第一段' },
            { type: 'reasoning', text: 'ignored' },
            { type: 'text', text: '第二段' },
          ],
        },
      },
    })
    assert.equal(text, '第一段第二段')
    assert.equal(
      extractAssistantText({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '   ' }] } } }),
      null,
    )
  })
})

describe('运行状态快照', () => {
  it('emptyRunState 初值', () => {
    const state = emptyRunState()
    assert.equal(state.running, true)
    assert.equal(state.done, false)
    assert.equal(state.error, null)
    assert.deepEqual(state.turnEnds, [])
    assert.equal(state.externallyDisposed, false)
  })

  it('snapshotRunState 深拷数组，可选键缺省时不存在', () => {
    const state = emptyRunState()
    const snapshot = snapshotRunState(state)
    assert.equal('outcome' in snapshot, false)
    assert.deepEqual(snapshot.messages, [])
    state.messages.push('x')
    assert.deepEqual(snapshot.messages, [])
  })

  it('errorMessage 归一', () => {
    assert.equal(errorMessage(new Error('boom')), 'boom')
    assert.equal(errorMessage('plain'), 'plain')
    assert.equal(errorMessage(42), '42')
    assert.equal(errorMessage(undefined), 'undefined')
  })
})

describe('服务取用与权限', () => {
  it('resolveAgents 缺失 / 形状不符都抛可读错误', () => {
    for (const ctx of [{}, { get: () => undefined }, { get: () => ({}) }, { get: () => ({ create: 1 }) }]) {
      assert.throws(() => resolveAgents(ctx), /ctx\.agents/)
    }
  })

  it('resolveAgents 形状正确时原样返回同一引用', () => {
    const agents = { create: async () => ({}), resume: async () => ({}), get: () => undefined }
    assert.equal(resolveAgents(fakeCtx({ agents })), agents)
  })

  it('resolvePermission 三级回退', () => {
    assert.equal(resolvePermission(fakeCtx(), 'read-only'), 'read-only')
    assert.equal(resolvePermission(fakeCtx(), undefined), DEFAULT_PERMISSION_PRESET)
    assert.equal(resolvePermission(fakeCtx({ permissionPresets: { defaultPreset: 'danger-full-access' } })), 'danger-full-access')
    assert.equal(
      resolvePermission(fakeCtx({ permissionPresets: { get defaultPreset() { throw new Error('gone') } } })),
      DEFAULT_PERMISSION_PRESET,
    )
  })

  it('applyPermission：预设可用走 preset，read-only 降级 sandbox', () => {
    const appended: Array<{ type: string; data: unknown }> = []
    const session = { id: 's', append: (type: string, data?: unknown) => { appended.push({ type, data }) } }
    const calls: string[] = []
    const ctx = fakeCtx({ permissionPresets: { set: (_session: unknown, name: string) => { calls.push(name) } } })
    assert.equal(applyPermission(ctx, session, 'workspace-write'), 'preset')
    assert.deepEqual(calls, ['workspace-write'])

    const throwing = fakeCtx({ permissionPresets: { set: () => { throw new Error('unknown preset "read-only"') } } })
    assert.equal(applyPermission(throwing, session, 'read-only'), 'sandbox')
    assert.equal(appended.length, 1)
    assert.equal(appended[0]?.type, 'sandbox/mode')
  })
})

describe('模型选择（真机 bug 回归）', () => {
  it('显式 model 优先', () => {
    const ctx = fakeCtx({ agentDefaultModel: { currentSelection: () => ({ provider: 'd', model: 'm' }) } })
    const model = pickModel(ctx, { provider: 'x', model: 'y' }, undefined)
    assert.deepEqual(model, { provider: 'x', model: 'y' })
  })

  it('其次用台账里的路由（续跑沿用原模型）', () => {
    const ctx = fakeCtx({ agentDefaultModel: { currentSelection: () => ({ provider: 'd', model: 'm' }) } })
    const record = { sessionId: 's', kind: 'workspace', createdAt: 1, updatedAt: 1, version: 1, model: { provider: 'r', model: 'q', reasoningEffort: 'high' } }
    const model = pickModel(ctx, undefined, record as never)
    assert.deepEqual(model, { provider: 'r', model: 'q', reasoningEffort: 'high' })
  })

  it('再次落 agentDefaultModel.currentSelection()（0.2 是拉取式）', () => {
    const ctx = fakeCtx({
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-flash' }) },
    })
    assert.deepEqual(pickModel(ctx, undefined, undefined), { provider: 'deepseek', model: 'deepseek-flash' })
  })

  it('三者都没有 → 可读错误（而不是建出一个没模型的 agent）', () => {
    assert.throws(() => pickModel(fakeCtx(), undefined, undefined), /no model route/)
    assert.throws(() => pickModel(fakeCtx({ agentDefaultModel: { currentSelection: () => ({}) } }), undefined, undefined), /no model route/)
    assert.throws(
      () =>
        pickModel(
          fakeCtx({ agentDefaultModel: { currentSelection: () => { throw new Error('gone') } } }),
          undefined,
          undefined,
        ),
      /no model route/,
    )
  })
})

describe('续跑分派', () => {
  const store = (records: Record<string, { sessionId: string; kind: 'ephemeral' | 'workspace' }>) => ({
    get: (id: string) => {
      const record = records[id]
      return record === undefined ? null : ({ ...record, version: 1, createdAt: 1, updatedAt: 1 } as never)
    },
  })

  it('台账不可用 / 无记录 / kind 不符 → 新建', () => {
    const fresh = resolveResumeTarget(null, 'x', 'magica')
    assert.equal(fresh.resumed, false)
    assert.notEqual(fresh.sessionId, 'x')

    const missing = resolveResumeTarget(store({}), 'x', 'magica')
    assert.equal(missing.resumed, false)
    assert.notEqual(missing.sessionId, 'x')

    const mismatch = resolveResumeTarget(store({ x: { sessionId: 'x', kind: 'workspace' } }), 'x', 'magica', 'ephemeral')
    assert.equal(mismatch.resumed, false)
  })

  it('命中且 kind 一致 → 续跑', () => {
    const target = resolveResumeTarget(store({ x: { sessionId: 'x', kind: 'workspace' } }), 'x', 'magica', 'workspace')
    assert.equal(target.resumed, true)
    assert.equal(target.sessionId, 'x')
    assert.equal(target.record?.sessionId, 'x')
  })

  it('自定义铸造器要过 SESSION_ID_SAFE', () => {
    assert.throws(() => resolveResumeTarget(null, undefined, 'p', undefined, () => 'bad/id'), /store file name/)
    assert.match(SESSION_ID_SAFE.source, /\^\[A-Za-z0-9\]/)
  })

  it('toResumeError：活动写 handle → SESSION_ALREADY_ACTIVE（真机回归）', () => {
    const owned = toResumeError(
      new Error('session "s" is already owned by an active write handle'),
      's',
    ) as SessionResumeError
    assert.equal(owned.code, 'SESSION_ALREADY_ACTIVE')
    assert.match(owned.message, /dispose/)
  })

  it('toResumeError：结构化 code 优先，正则兜底', () => {
    const coded = Object.assign(new Error('x'), { code: 'SESSION_LOG_MISSING' })
    assert.equal((toResumeError(coded, 's') as SessionResumeError).code, 'SESSION_LOG_MISSING')

    const notFound = toResumeError(new Error('session not found'), 's')
    assert.ok(notFound instanceof SessionResumeError)
    assert.equal(notFound.code, 'SESSION_LOG_MISSING')

    const other = toResumeError(new Error('kaboom'), 's')
    assert.equal(other.message, 'kaboom')
    assert.equal(other instanceof SessionResumeError, false)
  })
})
