import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  disposeInteractionLogger,
  installFailFastQuestionAnswerer,
  resetQuestions,
  setInteractionLogger,
} from '../../src/sessions/questions.ts'
import { fakeCtx } from '../helpers/fake.ts'
import { resolveDshHome } from '../../src/core/home.ts'
import { homedir } from 'node:os'

afterEach(() => {
  setInteractionLogger(null)
  disposeInteractionLogger()
  resetQuestions()
})

/** 逼出一次 fail-fast 提问：直接调第一个 waterfall 监听器（sessionId 必须与安装时一致）。 */
function askOnce(ctx: ReturnType<typeof fakeCtx>, sessionId: string): Promise<unknown> {
  return ctx.invoke(
    'user-questions/request',
    { agent: { session: { id: sessionId } }, questions: [{ id: 'q1', question: 'x' }] },
    async () => ({ answers: [] }),
  ) as Promise<unknown>
}

describe('交互日志落盘', () => {
  const SESSION = 'log-probe'
  const SESSION2 = 'log-probe-2'
  it('日志根目录取自宿主的 dshHomePath，且目录名是单段（不再有 questions 子目录）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'spellbook-log-home-'))
    const ctx = fakeCtx({ dshHomePath: (...segments: string[]) => join(home, ...segments) })
    disposeInteractionLogger()

    installFailFastQuestionAnswerer(ctx, SESSION)
    // fail-fast 的语义就是「拒绝并告诉模型这里不接受人类输入」
    await assert.rejects(askOnce(ctx, SESSION), /does not accept human input/)
    disposeInteractionLogger()

    const logsRoot = join(home, 'logs')
    const dirs = readdirSync(logsRoot)
    assert.deepEqual(dirs, ['dsh-magica-spellbook'], '只有一个单段目录，没有 questions/ 子目录')

    const files = readdirSync(join(logsRoot, 'dsh-magica-spellbook'))
    assert.ok(files.length >= 1)
    const text = readFileSync(join(logsRoot, 'dsh-magica-spellbook', files[0] as string), 'utf8')
    assert.match(text, /question\.fail-fast/)
    // 事件靠 event 字段区分，而不是靠子目录
    assert.match(text, /"event":"question\.fail-fast"/)
  })

  it('没有 dshHomePath 时落到 $DSH_HOME（测试进程已由 setup.mjs 隔离到临时目录）', async () => {
    const ctx = fakeCtx()
    disposeInteractionLogger()
    installFailFastQuestionAnswerer(ctx, SESSION2)
    assert.equal(ctx.listenerCount('user-questions/request'), 1, 'fail-fast 应注册到 user-questions/request')
    await assert.rejects(askOnce(ctx, SESSION2), /does not accept human input/)
    disposeInteractionLogger()

    const home = resolveDshHome()
    const dirs = readdirSync(join(home, 'logs'))
    assert.deepEqual(dirs, ['dsh-magica-spellbook'], '单段目录，没有 questions 子命名空间')
    assert.notEqual(home, join(homedir(), '.dsh'), 'setup.mjs 应把 DSH_HOME 指到临时目录')
  })
})
