/**
 * 清理**不上场**：本仓库禁止在脚本里做删除操作。
 *
 * 这个文件保留历史名字，但只做 **dry-run 报告**：列出 `lib/` 下现有的产物文件，
 * 由人自行决定要不要手工清理。它永远不会调用 `rmSync` / `unlink` / `rmdir`。
 *
 * 为什么不需要清理：`pnpm build` 直接用 esbuild/tsc 覆盖 `lib/index.js`、`lib/client.js`
 * 与 `lib/types/**`；改名/删除源文件后才可能残留旧声明，此时人工处理即可。
 *
 * @module dsh-magica-spellbook/scripts/rm
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.log('rm.mjs(dry-run): 用法 → node scripts/rm.mjs <dir>，只报告，不删除')
  process.exit(0)
}

for (const target of targets) {
  if (!existsSync(target)) {
    console.log(`rm.mjs(dry-run): ${target} 不存在，无需处理`)
    continue
  }
  let entries
  try {
    entries = readdirSync(target, { recursive: true })
  } catch (error) {
    console.log(`rm.mjs(dry-run): 无法读取 ${target}: ${String(error)}`)
    continue
  }
  console.log(`rm.mjs(dry-run): ${target} 下现有 ${entries.length} 项（未删除）：`)
  for (const entry of entries.slice(0, 40)) console.log(`  - ${join(target, String(entry))}`)
  if (entries.length > 40) console.log(`  … 其余 ${entries.length - 40} 项省略`)
}
console.log('rm.mjs(dry-run): 结束（本次没有删除任何文件）')
