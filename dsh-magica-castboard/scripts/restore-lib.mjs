/**
 * 临时救急构建（宿主重构完成前用，之后请删掉本文件并直接 `node scripts/build.mjs`）。
 *
 * 现状：`src/host` 正在按 `docs/align/PLAN.md` 迁移到 `model.ts` / `rules.ts`，而
 * `src/index.ts` 与部分路由还没跟上（`node scripts/build.mjs` 会在 host 半步报
 * "No matching export"）。为了让面板仍能加载，这里用 `.align-baseline/src`（最后一次
 * 能完整构建的 host 快照）产出 `lib/index.js`，client 仍然从**当前** `src/client` 构建。
 *
 * 用法：`node scripts/restore-lib.mjs`
 * 先决条件：`.align-baseline/src` 存在；如果宿主已迁移完成，请改用正常构建。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(PKG, 'lib')
const BASELINE = join(PKG, '.align-baseline', 'src', 'index.ts')

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

const BANNER = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify('@meiyukichan/dsh-magica-castboard')}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
].join('\n')

if (!existsSync(BASELINE)) {
  console.error('[restore-lib] 缺少 .align-baseline/src；宿主已迁移完成的话请直接 node scripts/build.mjs')
  process.exit(1)
}

const packageDir = readdirSync(join(PKG, 'node_modules', '.pnpm')).find(name => name.startsWith('esbuild@') && !name.includes('win32'))
if (packageDir === undefined) {
  console.error('[restore-lib] 找不到 esbuild，请先 pnpm install')
  process.exit(1)
}
const bin = join(PKG, 'node_modules', '.pnpm', packageDir, 'node_modules', 'esbuild', 'bin', 'esbuild')

function run(label, args) {
  const result = spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit', cwd: PKG })
  if (result.status !== 0) throw new Error(`[restore-lib] ${label} 退出码 ${String(result.status)}`)
}

// 只覆盖两个 JS 产物；lib/types 保留（由 tsc 生成，重跑本脚本不该把它抹掉）。
mkdirSync(LIB, { recursive: true })

run('host(baseline)', [
  '.align-baseline/src/index.ts',
  '--bundle', '--format=esm', '--platform=node', '--target=node22',
  '--minify', '--legal-comments=none', `--outfile=${join(LIB, 'index.js')}`,
  '--external:@deepseek-ai/*',
  '--external:@meiyukichan/dsh-magica-spellbook',
  '--external:@meiyukichan/dsh-magica-teamwork',
  '--log-level=warning',
])

run('client', [
  'src/client/index.ts',
  '--bundle', '--format=cjs', '--platform=browser', '--target=chrome120',
  '--minify', '--legal-comments=none', '--jsx=automatic', '--loader:.tsx=tsx',
  `--outfile=${join(LIB, 'client.js')}`,
  ...CLIENT_EXTERNALS.map(specifier => `--external:${specifier}`),
  `--banner:js=${BANNER}`,
  '--footer:js=return module.exports; } });',
  '--log-level=warning',
])

// 类型声明：与 host 产物同源（baseline），避免 d.ts 与 index.js 的导出对不上。
const tsc = join(PKG, 'node_modules', 'typescript', 'bin', 'tsc')
const types = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.dts.baseline.json'], { stdio: 'inherit', cwd: PKG })
if (types.status !== 0) throw new Error(`[restore-lib] types 退出码 ${String(types.status)}`)

console.log('[restore-lib] 已恢复 lib/index.js（baseline host）、lib/client.js（当前 client）与 lib/types')
console.log('[restore-lib] 宿主迁移完成后请删掉本脚本，直接跑 node scripts/build.mjs')
