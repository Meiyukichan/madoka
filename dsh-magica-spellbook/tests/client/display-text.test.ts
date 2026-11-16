import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pickDisplayText } from '../../src/client/panel/display-text.ts'

const both = { en: 'Run bash', zh: '运行 bash' }

describe('pickDisplayText（审批标题本地化）', () => {
  it('按界面语言取', () => {
    assert.equal(pickDisplayText(both, 'zh-CN', 'fallback'), '运行 bash')
    assert.equal(pickDisplayText(both, 'en-US', 'fallback'), 'Run bash')
  })

  it('没有当前语言时退回 en', () => {
    assert.equal(pickDisplayText(both, 'fr', 'fallback'), 'Run bash')
    assert.equal(pickDisplayText(both, undefined, 'fallback'), 'Run bash')
  })

  it('只有 zh 时也能取到（不显示 fallback）', () => {
    assert.equal(pickDisplayText({ zh: '运行 bash' }, 'en', 'fallback'), '运行 bash')
  })

  it('空串/非字符串值被跳过', () => {
    assert.equal(pickDisplayText({ en: '  ', zh: '运行' }, 'en', 'fallback'), '运行')
    assert.equal(pickDisplayText({ en: '', fr: 'Exécuter' }, 'en', 'fallback'), 'Exécuter')
  })

  it('displayReason 缺失 → fallback（通常是 reason 或工具名）', () => {
    assert.equal(pickDisplayText(undefined, 'zh', 'bash'), 'bash')
    assert.equal(pickDisplayText({}, 'zh', 'bash'), 'bash')
  })

  it('主语言回退：zh-TW 能命中 zh 前缀之外时按 primary 取', () => {
    assert.equal(pickDisplayText({ 'zh-tw': '執行 bash', en: 'Run bash' }, 'zh-TW', 'x'), '執行 bash')
  })
})
