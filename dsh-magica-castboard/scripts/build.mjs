/**
 * 构建：两个入口 → `lib/index.js`（host，ESM）+ `lib/client.js`（client，闭包工厂）。
 *
 * 契约（AGENTS.md 一.1 / 一.4）：
 * - `lib/` 只允许 `index.js`、`client.js` 与 `lib/types/**`；**不产出 `*.js.map`**。
 * - client 的裸 import 只允许平台模块表里的 9 个 specifier，其余一律打进 bundle。
 * - client 必须是 `window.__ModuleLoader__.load({ id, factory })` 闭包工厂，intro/footer 不可省。
 *
 * 实现说明：直接调 esbuild CLI（`spawnSync` + `stdio:'inherit'`），不用 JS API
 * ——后者在受限沙箱里会起 pipe 子进程并 EPERM。
 * @module dsh-magica-castboard/scripts/build
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { PKG_ROOT, REPO_ROOT, esbuildBin, findInPackages } from './deps.mjs'

const PKG = '@meiyukichan/dsh-magica-castboard'
const LIB = join(PKG_ROOT, 'lib')

/** 平台模块表（不可增删）：这些 specifier 由 shell 注入，不打包。 */
const CLIENT_EXTERNALS = [
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

/**
 * 组件库入口：优先本包 node_modules（发布形态），否则指向兄弟包源码（workspace 开发形态）。
 * 组件库不是插件、没有 client bundle，所以开发期直接编 TS 源码进我们的 bundle。
 */
// teamwork 已发布：直接走包导出（`./client` 指向其源码，esbuild 会编译）

const CLIENT_BANNER = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
].join('\n')
const CLIENT_FOOTER = 'return module.exports; } });'

function run(label, args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: PKG_ROOT })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`[build] ${label} exited with ${String(result.status)}`)
}

function buildHost(bin) {
  run('host', [
    bin,
    join(PKG_ROOT, 'src', 'index.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--target=node22',
    '--minify',
    '--legal-comments=none',
    `--outfile=${join(LIB, 'index.js')}`,
    '--external:@deepseek-ai/*',
    // 运行时依赖保持外部：动态 import 才能拿到宿主那份（否则会被内联成第二份副本）
    '--external:@meiyukichan/dsh-magica-spellbook',
    '--external:@meiyukichan/dsh-magica-teamwork',
    '--log-level=warning',
  ])
}

function buildClient(bin) {
  run('client', [
    bin,
    join(PKG_ROOT, 'src', 'client', 'index.ts'),
    '--bundle',
    '--format=cjs',
    '--platform=browser',
    '--target=chrome120',
    '--minify',
    '--legal-comments=none',
    '--jsx=automatic',
    '--loader:.tsx=tsx',
    `--outfile=${join(LIB, 'client.js')}`,
    ...CLIENT_EXTERNALS.map(specifier => `--external:${specifier}`),
    `--banner:js=${CLIENT_BANNER}`,
    `--footer:js=${CLIENT_FOOTER}`,
    '--log-level=warning',
  ])
}

/** 生成 `lib/types/**`：package.json 的 types / exports["."].types 依赖它。 */
function declarations() {
  const result = spawnSync(process.execPath, [join(PKG_ROOT, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.dts.json'], {
    stdio: 'inherit',
    cwd: PKG_ROOT,
  })
  if (result.error !== undefined) throw result.error
  if ((result.status ?? 1) !== 0) throw new Error('[build] declarations exited with ' + String(result.status))
  if (!existsSync(join(LIB, 'types', 'index.d.ts'))) throw new Error('[build] 没生成 lib/types/index.d.ts')
}

function cleanup() {
  if (existsSync(LIB)) rmSync(LIB, { recursive: true, force: true })
  mkdirSync(LIB, { recursive: true })
}

/** 断言 `lib/` 的产物形状：只允许 index.js / client.js（+ 将来的 types/ 目录）。 */
function assertShape() {
  const entries = readdirSync(LIB).sort()
  const allowed = new Set(['index.js', 'client.js', 'types'])
  const unexpected = entries.filter(name => !allowed.has(name))
  if (unexpected.length > 0) throw new Error(`[build] lib/ 里出现多余产物：${unexpected.join(', ')}`)
  for (const required of ['index.js', 'client.js']) {
    if (!existsSync(join(LIB, required))) throw new Error(`[build] 缺少 ${required}`)
  }
  const client = readFileSync(join(LIB, 'client.js'), 'utf8')
  if (!client.startsWith('window.__ModuleLoader__.load(')) throw new Error('[build] client.js 缺少闭包工厂 banner')
  if (!client.trimEnd().endsWith('return module.exports; } });')) throw new Error('[build] client.js 缺少 footer')
}

const bin = esbuildBin()
cleanup()
buildHost(bin)
buildClient(bin)
declarations()
assertShape()

const size = name => `${(statSync(join(LIB, name)).size / 1024).toFixed(1)} KiB`
console.log(`[build] lib/index.js  ${size('index.js')}`)
console.log(`[build] lib/client.js ${size('client.js')}`)
