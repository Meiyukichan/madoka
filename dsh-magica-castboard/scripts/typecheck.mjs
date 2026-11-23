/**
 * 类型检查：`tsc --noEmit`，优先本包 typescript，其次兄弟包。
 *
 * 依赖真实的 `@deepseek-ai/dsh-*` 类型（peerDependencies），所以**必须先 pnpm install**。
 * 这是刻意的：不装依赖就检查类型，等于用 any 骗自己。
 * @module dsh-magica-castboard/scripts/typecheck
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { PKG_ROOT, tscBin } from './deps.mjs'

const result = spawnSync(process.execPath, [tscBin(), '-p', join(PKG_ROOT, 'tsconfig.json'), '--noEmit'], {
  stdio: 'inherit',
  cwd: PKG_ROOT,
})
if (result.error !== undefined) throw result.error
process.exit(result.status ?? 1)