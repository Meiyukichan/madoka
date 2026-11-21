#!/usr/bin/env node
/**
 * 把 `@deepseek-ai/dsh-llm-deepseek` 里那行「model listing … loaded N model(s)」从
 * **info 降级为 debug**，这样启动时终端不再打印它（失败时的 warn 保留）。
 *
 * 为什么是改安装产物：那行在**插件 apply 之前**就打出来了（provider 初始化时预热列表），
 * 插件层拦不到，dsh 也没有「按名字压 info」的配置；而且 Cordis 的日志级别是详细度
 * （ERROR=0/INFO=1/WARN=2/DEBUG=3，`if (targetLevel < level) continue`），
 * 没有「只压 info 保留 warn」的阈值。所以只能就地降级这一行。
 *
 * 用法（全局安装）：
 *   node scripts/patch-dsh-log.mjs
 *   node scripts/patch-dsh-log.mjs --restore   # 还原备份
 *
 * ⚠️ `npm i -g @deepseek-ai/dsh` 升级会覆盖，升级后重跑本脚本即可（幂等）。
 */
import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const NEEDLE_INFO = 'this.dependencies.info(`model listing from'
const NEEDLE_DEBUG = 'this.dependencies.debug(`model listing from'

function dshRoot() {
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim()
    const candidate = join(root, '@deepseek-ai', 'dsh')
    return existsSync(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

const restore = process.argv.includes('--restore')
const root = dshRoot()
if (root === undefined) {
  console.error('找不到全局安装的 @deepseek-ai/dsh（npm root -g）')
  process.exit(1)
}
const target = join(root, 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js')
if (!existsSync(target)) {
  console.error('找不到目标文件: ' + target)
  process.exit(1)
}
const backup = `${target}.bak-rune`

if (restore) {
  if (!existsSync(backup)) {
    console.error('没有备份可还原: ' + backup)
    process.exit(1)
  }
  copyFileSync(backup, target)
  console.log('已还原: ' + target)
  process.exit(0)
}

const text = readFileSync(target, 'utf8')
if (text.includes(NEEDLE_DEBUG) && !text.includes(NEEDLE_INFO)) {
  console.log('已经是 debug 级别，无需修改')
  process.exit(0)
}
if (!text.includes(NEEDLE_INFO)) {
  console.error('没找到目标调用（dsh 版本可能变了，需重新确认行号）')
  process.exit(1)
}
if (!existsSync(backup)) copyFileSync(target, backup)
writeFileSync(target, text.replace(NEEDLE_INFO, NEEDLE_DEBUG), 'utf8')
console.log('已把 model listing 日志从 info 降级为 debug')
console.log('  目标: ' + target)
console.log('  备份: ' + backup)
console.log('重启 dsh 后生效；升级 dsh 后重跑本脚本。')
