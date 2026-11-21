#!/usr/bin/env node
/**
 * 把 `@deepseek-ai/dsh-llm-deepseek` 里「model listing … loaded N model(s)」那行日志
 * **整句删掉**（失败时的 warn 保留）。
 *
 * ⚠️ 不要再改成 `this.dependencies.debug(...)`：该文件的依赖接口只声明了
 * `info` / `warn`（两个消费方 dsh-llm-deepseek-account / -api-key 也只传这两个），
 * 调 `.debug` 会在「/models 拉取成功」时抛 TypeError，直接把会话打崩。
 * 所以这里用 `void 0;` 替换整条语句 —— 既不打日志，也不会引入不存在的方法。
 *
 * 为什么只能改安装产物：那行在插件 apply 之前就打出（provider 初始化预热模型列表），
 * 插件层拦不到；而 Cordis 的日志级别是「详细度」（ERROR=0/INFO=1/WARN=2/DEBUG=3），
 * 没有「只压 info 保留 warn」的阈值。
 *
 * 用法：
 *   node scripts/patch-dsh-log.mjs            # 打补丁（幂等，自动备份 .bak-rune）
 *   node scripts/patch-dsh-log.mjs --restore  # 还原备份
 *
 * `npm i -g @deepseek-ai/dsh` 升级会覆盖，升级后重跑一次即可。
 */
import { execFileSync, execSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 匹配「整条 info 调用语句」（模板字符串里没有反引号）。 */
const CALL = /this\.dependencies\.info\(`model listing from[^`]*`\);/g
const SAFE = 'void 0;'

const restore = process.argv.includes('--restore')

function dshRoot() {
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim()
    const candidate = join(root, '@deepseek-ai', 'dsh')
    return existsSync(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

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
if (text.includes('this.dependencies.debug(`model listing from')) {
  console.error('检测到之前那次危险补丁（.debug）。先跑 --restore 还原，再重跑本脚本。')
  process.exit(1)
}
if (!CALL.test(text)) {
  console.log('没有匹配到目标语句（可能已打过补丁，或 dsh 版本变了）')
  process.exit(0)
}
CALL.lastIndex = 0
if (!existsSync(backup)) copyFileSync(target, backup)
const next = text.replace(CALL, SAFE)
writeFileSync(target, next, 'utf8')

// 语法自检：语法坏了立刻还原，别让用户重启后才发现
try {
  execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' })
} catch (error) {
  copyFileSync(backup, target)
  console.error('补丁后语法检查失败，已自动还原：' + String(error).slice(0, 300))
  process.exit(1)
}

console.log('已删除 model listing 日志语句（失败时的 warn 保留）')
console.log('  目标: ' + target)
console.log('  备份: ' + backup)
console.log('重启 dsh 后生效；升级 dsh 后重跑本脚本。')
