/**
 * 清掉构建产物与 e2e 临时目录。
 * @module dsh-magica-castboard/scripts/clean
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { PKG_ROOT } from './deps.mjs'

for (const relative of ['lib', '.e2e']) {
  const target = join(PKG_ROOT, relative)
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true })
    console.log(`[clean] removed ${relative}/`)
  }
}
