import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LIB = fileURLToPath(new URL('../lib', import.meta.url))

/**
 * 产物规则（仓库硬约束）：
 * - `lib/` 只允许 `index.js`、`client.js` 与 `types/**`（声明文件）；
 * - **不允许任何 `*.js.map`**。
 *
 * 未构建时（无 `lib/`）跳过，避免「先跑测试后构建」的流水线误报。
 */
describe('构建产物', () => {
  it('lib/ 不含 *.js.map', () => {
    if (!existsSync(LIB)) return
    const maps = readdirSync(LIB).filter(name => name.endsWith('.js.map'))
    assert.deepEqual(maps, [], `lib/ 里出现了 sourcemap：${maps.join(', ')}`)
  })

  it('lib/ 顶层只有两个 JS 与 types 目录', () => {
    if (!existsSync(LIB)) return
    const top = readdirSync(LIB, { withFileTypes: true })
    const js = top.filter(entry => entry.isFile() && entry.name.endsWith('.js')).map(entry => entry.name).sort()
    const others = top.filter(entry => entry.isFile() && !entry.name.endsWith('.js')).map(entry => entry.name)
    assert.deepEqual(js, ['client.js', 'index.js'])
    assert.deepEqual(others, [], `lib/ 里出现了非 JS 文件：${others.join(', ')}`)
  })
})
