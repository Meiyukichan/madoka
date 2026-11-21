#!/usr/bin/env node
/**
 * 卸载本插件后收尾：把 `dsh-magica-rune` 写进 profile 的 6 条开关行删掉，
 * 让 `ui-plugin-manager / entry-customization / ui-schedule / ui-settings-account /
 * account-controller / deepseek-account` 回到官方默认。
 *
 * 为什么需要：那些行是 **设置页点开关时写进 profile 的**（`- id: X` + `disabled: true`），
 * 它们不随包卸载消失。新版写入逻辑已经做到「与默认相同就不写」，但老版本留下的行还要清。
 *
 * 用法：
 *   node scripts/uninstall-clean.mjs                 # 默认清 web profile
 *   node scripts/uninstall-clean.mjs --profile dev
 *   node scripts/uninstall-clean.mjs --dry-run       # 只列出会删什么
 */
import { existsSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const IDS = [
  'ui-plugin-manager',
  'entry-customization',
  'ui-schedule',
  'ui-settings-account',
  'account-controller',
  'deepseek-account',
]

const argv = process.argv
const profileIndex = argv.findIndex(arg => arg === '--profile')
const profile = profileIndex >= 0 && typeof argv[profileIndex + 1] === 'string' ? argv[profileIndex + 1] : 'web'
const dryRun = argv.includes('--dry-run')

const patchPath = join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  console.error(`找不到 profile patch: ${patchPath}`)
  process.exit(1)
}

const text = readFileSync(patchPath, 'utf8')
const lines = text.split(/\r?\n/)
if (lines[lines.length - 1] === '') lines.pop()

const header = id => new RegExp(`^\\s*-\\s*id:\\s*["']?${id}["']?\\s*$`)
const removed = []
for (let i = lines.length - 1; i >= 0; i--) {
  const id = IDS.find(candidate => header(candidate).test(lines[i] ?? ''))
  if (id === undefined) continue
  let end = lines.length
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j] ?? ''
    if (/^\s*-\s+\S/.test(line) || /^\S/.test(line)) { end = j; break }
  }
  if (!dryRun) lines.splice(i, end - i)
  removed.push(id)
}

if (removed.length === 0) {
  console.log(`profile "${profile}" 里没有本插件写入的开关行，无需清理`)
  process.exit(0)
}

console.log(`profile "${profile}": ${dryRun ? '将删除' : '已删除'} ${removed.length} 条 → ${removed.join(', ')}`)
if (dryRun) process.exit(0)

copyFileSync(patchPath, `${patchPath}.bak-rune-clean`)
const tmp = `${patchPath}.rune.tmp`
writeFileSync(tmp, `${lines.join('\n')}\n`, 'utf8')
renameSync(tmp, patchPath)
console.log(`已写回: ${patchPath}（备份: ${patchPath}.bak-rune-clean）`)
console.log('重启 dsh 后这些官方插件恢复默认。')
