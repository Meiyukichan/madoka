/**
 * 技能目录取数的回归测试：**cwd 必须传给 provider**。
 *
 * 背景（对比报告指出、已在源码确认）：项目级 skill 的 provider 只按 `cwd` 枚举
 * （`SkillLookupOptions.cwd`，`packages/skill/skill/src/index.ts:102-108`），官方
 * `tool-skill` 也是 `snapshot({ cwd: agent.session.header.cwd, signal, scope: agent })`
 * （`:222`）。如果两次 snapshot 都不带 cwd，这类 skill 在目录里**永远不出现**。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collectSkills } from '../src/catalog.ts'
import { GuardState } from '../src/state.ts'

interface Recorded { scope?: object; cwd?: string }

function makeCtx(calls: Recorded[], skills: unknown) {
  return { get: (name: string) => (name === 'skills' ? skills : undefined) } as never
}

const fakeSkills = (calls: Recorded[]) => ({
  snapshot: async (options: Recorded = {}) => {
    calls.push({ ...options })
    return { skills: [{ name: `s${String(calls.length)}`, description: 'd' }], complete: true }
  },
})

const agentWith = (cwd: string) => ({ session: { header: { cwd } } }) as never

describe('collectSkills：cwd 透传', () => {
  it('有 live agent 时，两次 snapshot 都带 cwd（global 一次 + agent scope 一次）', async () => {
    const calls: Recorded[] = []
    const agent = agentWith('D:\\work\\proj')
    await collectSkills(makeCtx(calls, fakeSkills(calls)), new GuardState(), agent)

    assert.equal(calls.length, 2)
    assert.equal(calls[0].cwd, 'D:\\work\\proj', 'global 那次必须带 cwd')
    assert.equal(calls[0].scope, undefined)
    assert.equal(calls[1].cwd, 'D:\\work\\proj', 'agent 那次也必须带 cwd')
    assert.equal(calls[1].scope, agent)
  })

  it('没有 live agent 时，global 那次不带 cwd，也不会发第二次', async () => {
    const calls: Recorded[] = []
    await collectSkills(makeCtx(calls, fakeSkills(calls)), new GuardState(), undefined)

    assert.equal(calls.length, 1)
    assert.equal(calls[0].cwd, undefined)
  })

  it('cwd 为空串时不传（避免 provider 把空串当路径）', async () => {
    const calls: Recorded[] = []
    await collectSkills(makeCtx(calls, fakeSkills(calls)), new GuardState(), agentWith(''))

    assert.equal(calls.length, 2)
    assert.equal(calls[0].cwd, undefined)
    assert.equal(calls[1].cwd, undefined)
  })
})
