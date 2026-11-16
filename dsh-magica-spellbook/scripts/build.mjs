/**
 * 构建：两个入口 → `lib/index.js`（host ESM）+ `lib/client.js`（浏览器 ESM），都压缩。
 *
 * 契约（见 `docs/design/00-overview.zh.md` §3）：
 * - `lib/` 只有这两个 JS（压缩源码），外加 `lib/types/**` 声明；
 * - `undici` / `@primno/dpapi` 必须 external —— 惰性加载靠 `createRequire`，不能被打进产物；
 * - client 的裸 import 只允许平台模块表里的 specifier。
 *
 * 实现说明：这里调 **esbuild CLI**（`spawnSync` + `stdio: 'inherit'`），
 * 不用它的 JS API —— 后者会起一个 pipe 通信的子进程，受限沙箱下会 EPERM。
 *
 * @module dsh-magica-spellbook/scripts/build
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../node_modules/esbuild/bin/esbuild', import.meta.url))

const HOST_EXTERNALS = ['undici', '@primno/dpapi', '@deepseek-ai/*']
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

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// 注意：这里**不做任何删除**。esbuild 直接覆盖 lib/index.js 与 lib/client.js，
// tsc 覆盖 lib/types/**；改名源文件后可能残留旧声明，由人工处理（见 scripts/rm.mjs 的 dry-run 报告）。

run([
  'src/index.ts',
  '--bundle',
  '--format=esm',
  '--platform=node',
  '--target=node22',
  '--minify',
  '--legal-comments=none',
  '--outfile=lib/index.js',
  ...HOST_EXTERNALS.flatMap((name) => [`--external:${name}`]),
])

run([
  'src/client/index.ts',
  '--bundle',
  '--format=esm',
  '--platform=browser',
  '--target=es2022',
  '--jsx=automatic',
  '--minify',
  '--legal-comments=none',
  '--define:process.env.NODE_ENV="production"',
  '--define:import.meta.env.MODE="production"',
  '--outfile=lib/client.js',
  ...CLIENT_EXTERNALS.flatMap((name) => [`--external:${name}`]),
])
