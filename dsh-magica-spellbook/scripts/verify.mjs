/**
 * 产物契约校验：`pnpm verify`。
 *
 * 六条断言（见 `docs/design/00-overview.zh.md` §3.6）：
 * 1. `lib/` 里恰好两个 `.js`；
 * 2. 两个文件都被压缩过（行数少、无 4 空格缩进代码行）；
 * 3. `lib/index.js` 零运行时 `@deepseek-ai/*` 导入；
 * 4. `lib/client.js` 的裸 import 只在平台白名单内；
 * 5. `undici` 仍以 `require(...)`/动态形式出现（证明惰性没被 inline）；
 * 6. `exports` 目标文件都存在。
 *
 * @module dsh-magica-spellbook/scripts/verify
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const PLATFORM_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

const failures = []

function check(condition, message) {
  if (!condition) failures.push(message)
}

const libFiles = existsSync('lib') ? readdirSync('lib') : []
const jsFiles = libFiles.filter((name) => name.endsWith('.js')).sort()
check(
  jsFiles.length === 2 && jsFiles[0] === 'client.js' && jsFiles[1] === 'index.js',
  `lib/ 必须恰好有 index.js 与 client.js 两个 JS，实际: ${JSON.stringify(jsFiles)}`,
)

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

const host = readIfExists(join('lib', 'index.js'))
const client = readIfExists(join('lib', 'client.js'))

check(host !== '', 'lib/index.js 不存在或为空')
check(client !== '', 'lib/client.js 不存在或为空')

for (const [name, text] of [
  ['index.js', host],
  ['client.js', client],
]) {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  check(lines.length <= 40, `${name} 疑似未压缩：${lines.length} 个非空行`)
  const indented = lines.filter((line) => /^ {4}\S/.test(line)).length
  check(indented === 0, `${name} 疑似未压缩：${indented} 行有 4 空格缩进`)
}

const dshImport = /(?:from\s*|import\s*\(|require\()\s*["']@deepseek-ai\//
check(!dshImport.test(host), 'lib/index.js 出现了运行时 @deepseek-ai/* 导入')

const specifiers = new Set()
for (const match of client.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
  const specifier = match[1]
  if (specifier === undefined) continue
  if (specifier.startsWith('./') || specifier.startsWith('../')) continue
  specifiers.add(specifier)
}
for (const specifier of specifiers) {
  const base = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]
  check(
    PLATFORM_MODULES.has(specifier) || PLATFORM_MODULES.has(base ?? ''),
    `lib/client.js 出现平台白名单之外的裸 import: ${specifier}`,
  )
}

check(
  host.includes('createRequire') && /["']undici["']/.test(host),
  'lib/index.js 丢失了 undici 的惰性加载点（createRequire + "undici" 至少应各出现一次）',
)

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
for (const [key, target] of Object.entries(manifest.exports ?? {})) {
  const path = typeof target === 'string' ? target : (target.import ?? target.default)
  if (typeof path !== 'string') {
    failures.push(`exports["${key}"] 缺少目标`)
    continue
  }
  check(existsSync(path), `exports["${key}"] 目标不存在: ${path}`)
}

// d.ts 声明过、但曾经因为中间 index 漏再导出而在产物里缺席的符号（diff「幽灵声明」十条）。
// 这条守卫的作用：以后谁删掉再导出，构建会当场红，而不是让消费方 import 到 undefined。
const DECLARED_EXPORTS = {
  host: ['ephemeralPending', 'isLoopbackHost', 'isTrustedHost'],
  client: [
    'pickDisplayText',
    'currentLang',
    'parseRecommended',
    'carrierKey',
    'claim',
    'InteractionRegistry',
    'serviceOf',
  ],
}
for (const [side, names] of Object.entries(DECLARED_EXPORTS)) {
  const text = side === 'host' ? host : client
  const file = side === 'host' ? 'lib/index.js' : 'lib/client.js'
  for (const name of names) {
    check(text.includes(name), `${file} 缺少已声明导出: ${name}`)
  }
}

if (failures.length > 0) {
  console.error('verify 失败:')
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log('verify 通过: lib 两个压缩 JS / 零 dsh 运行时导入 / client 裸 import 均在白名单 / undici 仍惰性')
