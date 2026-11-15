/** 删除构建产物（只删 lib/，目标路径写死并二次校验）。 @module dsh-magica-rune/scripts/clean */

import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const target = fileURLToPath(new URL('../lib', import.meta.url))
if (!target.endsWith('dsh-magica-rune/lib') && !target.endsWith('dsh-magica-rune\\lib')) {
  throw new Error(`refusing to remove unexpected path: ${target}`)
}
rmSync(target, { recursive: true, force: true })
console.log(`[clean] removed ${target}`)
