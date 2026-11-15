/**
 * 构建：两个入口 →
 *   - `lib/index.js`  host 半侧（ESM / node22 / minified）
 *   - `lib/client.js` client 半侧（CJS 闭包工厂 / minified）
 *
 * 契约（见 docs/design/04 §4）：
 * - `lib/` 只允许 `index.js`、`client.js` 与 `lib/types/**`（声明文件）：
 *   **不产出 `*.js.map`**（仓库硬规则；构建末尾还会清掉历史残留）。
 * - client 的裸 import 只允许「平台模块表」里的 9 个 specifier
 *   （dsh 源码 `packages/client/web/src/platform.ts:7-21`），其余必须打进 bundle。
 * - client 必须是 `window.__ModuleLoader__.load({ id, factory })` 闭包工厂，
 *   intro/footer 两段不可省，否则模块系统无法回收它的 `<style>` 与副作用。
 *
 * 实现说明：这里调 **esbuild CLI**（`spawnSync` + `stdio:'inherit'`），不用它的 JS API
 * ——后者会起一个 pipe 通信的子进程，在受限沙箱下会 EPERM。
 * @module dsh-magica-rune/scripts/build
 */

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG = '@meiyukichan/dsh-magica-rune'
const LIB_DIR = fileURLToPath(new URL('../lib', import.meta.url))

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

const CLIENT_BANNER = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
].join('\n')

const CLIENT_FOOTER = 'return module.exports; } });'

/** 在候选路径里找可执行的 esbuild（本地优先，其次本仓同级包）。 */
function findEsbuild() {
  const candidates = [
    new URL('../node_modules/esbuild/bin/esbuild', import.meta.url),
    new URL('../../dsh-magica-spellbook/node_modules/esbuild/bin/esbuild', import.meta.url),
  ].map(url => fileURLToPath(url))
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  throw new Error(`esbuild not found; looked in:\n${candidates.join('\n')}`)
}

/** 同上，用于可选的声明文件构建。 */
function findTsc() {
  const candidates = [
    new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    new URL('../../dsh-magica-spellbook/node_modules/typescript/bin/tsc', import.meta.url),
  ].map(url => fileURLToPath(url))
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return undefined
}

function run(label, args, optional = false) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (result.error !== undefined) {
    if (optional) {
      console.warn(`[build] ${label}: skipped (${String(result.error)})`)
      return
    }
    throw result.error
  }
  if (result.status !== 0) {
    const message = `[build] ${label} exited with ${String(result.status)}`
    if (optional) {
      console.warn(`${message}; continuing`)
      return
    }
    throw new Error(message)
  }
}

const esbuild = findEsbuild()

// ① host 半侧
run('host bundle', [
  esbuild,
  'src/index.ts',
  '--bundle',
  '--format=esm',
  '--platform=node',
  '--target=node22',
  '--minify',
  '--legal-comments=none',
  '--outfile=lib/index.js',
  // 与宿主共享实例的类型/值一律不打包；本包 host 侧实际只有 type-only import，
  // 这条规则是防止后续误加运行时依赖。
  '--external:@deepseek-ai/*',
])

// ② client 半侧（闭包工厂）
run('client bundle', [
  esbuild,
  'src/client.ts',
  '--bundle',
  '--format=cjs',
  '--platform=browser',
  '--target=es2022',
  '--jsx=automatic',
  '--minify',
  '--legal-comments=none',
  '--outfile=lib/client.js',
  `--banner:js=${CLIENT_BANNER}`,
  `--footer:js=${CLIENT_FOOTER}`,
  // 三个 define 缺一不可：CJS 产物没有 import.meta，双模库会探测它。
  '--define:process.env.NODE_ENV="production"',
  '--define:import.meta.env.MODE="production"',
  '--define:import.meta.env="{\\"MODE\\":\\"production\\"}"',
  ...CLIENT_EXTERNALS.flatMap(name => [`--external:${name}`]),
])

// ③ 声明文件（可选：本机未安装 typescript 时跳过，不影响运行时产物）
const tsc = findTsc()
if (tsc === undefined) {
  console.warn('[build] typescript not found; skipping lib/types (runtime artifacts are complete)')
} else {
  run('dts', [tsc, '-p', 'tsconfig.dts.json'], true)
}

// ④ 清理：`lib/` 里禁止出现 `*.js.map`（含历史残留与 esbuild 的默认行为）
function dropSourcemaps() {
  if (!existsSync(LIB_DIR)) return
  for (const name of readdirSync(LIB_DIR)) {
    if (!name.endsWith('.js.map')) continue
    rmSync(new URL(`../lib/${name}`, import.meta.url), { force: true })
    console.log(`[build] removed lib/${name}`)
  }
}
dropSourcemaps()

console.log('[build] done: lib/index.js, lib/client.js')
