/**
 * 构建产物形状测试：lib/ 只允许 index.js / client.js，且都符合 0.2 契约。
 *
 * 跑法见 package.json 的 test 脚本（Node 24 原生 TS 剥离，无需构建器）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LIB = join(ROOT, 'lib')

/** 平台模块表：client bundle 里允许出现的裸 require。 */
const ALLOWED_REQUIRES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** bundle 里出现的 require("...") 的 specifier 集合。 */
function requiresOf(source: string): (string | undefined)[] {
  return [...source.matchAll(/require\((["'])([^"']+)\1\)/g)].map(match => match[2])
}

test('lib 只有 index.js 与 client.js', () => {
  const entries = readdirSync(LIB).sort()
  assert.deepEqual(entries.filter(name => name !== 'types'), ['client.js', 'index.js'])
  assert.equal(existsSync(join(LIB, 'index.js.map')), false, 'lib 里不允许 js.map')
  assert.equal(existsSync(join(LIB, 'client.js.map')), false, 'lib 里不允许 js.map')
})

test('client.js 是闭包工厂且只 require 平台模块', () => {
  const source = readFileSync(join(LIB, 'client.js'), 'utf8')
  assert.ok(source.startsWith('window.__ModuleLoader__.load('), '缺少 banner')
  assert.ok(source.includes('id: "@meiyukichan/dsh-magica-castboard"'), 'id 必须是包名')
  assert.ok(source.trimEnd().endsWith('return module.exports; } });'), '缺少 footer')

  const requires = [...new Set(requiresOf(source))].filter((specifier): specifier is string => specifier !== undefined)
  const unexpected = requires.filter(specifier => !ALLOWED_REQUIRES.includes(specifier))
  assert.deepEqual(unexpected, [], `出现平台模块表之外的 require：${unexpected.join(', ')}`)
})

test('host 半侧没有运行时 @deepseek-ai 依赖（只有类型导入）', () => {
  const source = readFileSync(join(LIB, 'index.js'), 'utf8')
  const requires = [...new Set(requiresOf(source))].filter((specifier): specifier is string => specifier !== undefined).filter(specifier => specifier.startsWith('@deepseek-ai/'))
  assert.deepEqual(requires, [], `host 半侧出现运行时 dsh import：${requires.join(', ')}`)
  assert.ok(source.includes('export'), 'host 产物必须是 ESM 且有导出')
})

test('体积哨兵：client.js 小于 512 KiB（防误打包依赖/整份 JSON）', () => {
  const bytes = statSync(join(LIB, 'client.js')).size
  assert.ok(bytes < 512 * 1024, `client.js 已 ${(bytes / 1024).toFixed(1)} KiB，超过 512 KiB 哨兵`)
})
