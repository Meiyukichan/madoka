/**
 * token 校验：组件库只允许用白名单里的 `--dsw-*` token，且不许硬编码颜色。
 *
 * 退出码：0 = 干净；1 = 有违规（CI/预提交用）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const WHITELIST = ['--dsw-alias-', '--dsw-elevation-', '--dsw-specific-', '--dsw-menu-', '--dsw-radius-', '--dsw-focus-']
const ROOT = 'src/client'

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...walk(path))
    else if (/\.(ts|tsx|css)$/.test(entry)) out.push(path)
  }
  return out
}

const violations = []
for (const file of walk(ROOT)) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/var\((--[a-z0-9-]+)/gi)) {
    const token = match[1]
    if (!WHITELIST.some(prefix => token.startsWith(prefix))) {
      violations.push(`${file}: 非白名单 token ${token}`)
    }
  }
  for (const match of text.matchAll(/(#[0-9a-f]{3,8}\b|rgba?\()/gi)) {
    violations.push(`${file}: 硬编码颜色 ${match[1]}`)
  }
}

if (violations.length > 0) {
  console.error(`token 校验失败（${violations.length} 处）：`)
  for (const item of violations.slice(0, 30)) console.error('  ' + item)
  process.exit(1)
}
console.log('token 校验通过：无越界 token、无硬编码颜色')
