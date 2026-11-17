import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as root from '../src/index.ts'
import { ephemeralPending } from '../src/sessions/index.ts'

/**
 * diff.md「幽灵声明」十条的宿主侧三条：d.ts 声明过，但中间 index 漏再导出 →
 * 按 d.ts `import` 会拿到 `undefined`。这里直接对**包入口**断言，防止再被删掉。
 */
describe('包入口的再导出（幽灵声明回归）', () => {
  it('ephemeralPending 能从包入口拿到', () => {
    assert.equal(typeof ephemeralPending, 'function')
    assert.equal(typeof root.ephemeralPending, 'function')
    const snapshot = ephemeralPending('no-such-session')
    assert.deepEqual(snapshot.approvals, [])
    assert.deepEqual(snapshot.questions, [])
  })

  it('isLoopbackHost / isTrustedHost 能从包入口拿到', () => {
    assert.equal(typeof root.isLoopbackHost, 'function')
    assert.equal(typeof root.isTrustedHost, 'function')
    assert.equal(root.isLoopbackHost('127.0.0.1:3081'), true)
    assert.equal(root.isLoopbackHost('[::1]:3081'), true)
    assert.equal(root.isLoopbackHost('evil.example'), false)
    // 默认只信回环；显式白名单才放行
    assert.equal(root.isTrustedHost('127.0.0.1:1'), true)
    assert.equal(root.isTrustedHost('evil.example'), false)
    assert.equal(root.isTrustedHost('evil.example', ['evil.example']), true)
    assert.equal(root.isTrustedHost(undefined), false)
  })
})
