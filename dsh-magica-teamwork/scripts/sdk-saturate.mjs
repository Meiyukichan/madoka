#!/usr/bin/env node
/**
 * SDK 饱和测试入口（真机）：**先起本地服务，再用 SDK 打满每个端点与每个组合方法**。
 *
 * 用法：
 *   node scripts/sdk-saturate.mjs                  # 自起本地服务（随机端口 / 临时目录）
 *   node scripts/sdk-saturate.mjs --verbose        # 逐条打印断言
 *   node scripts/sdk-saturate.mjs --url <baseUrl>  # 打已部署服务（第三方实现验收；跳过停机与凭据文件用例）
 *
 * 前置：`lib-tests/` 已编译（`pnpm pretest` 或 `tsc -p tsconfig.tests.json`）。
 * 退出码：0 = 全绿；1 = 有断言失败或端点未覆盖；2 = 没编译。
 */
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const urlIndex = argv.indexOf('--url')
const baseUrl = urlIndex >= 0 ? argv[urlIndex + 1] : undefined

const compiled = resolve('lib-tests/tests/sdk-saturate.js')
if (!existsSync(compiled)) {
  console.error('找不到 lib-tests/tests/sdk-saturate.js —— 先编译：')
  console.error('  node ./node_modules/typescript/bin/tsc -p tsconfig.tests.json')
  process.exit(2)
}

const mod = await import(pathToFileURL(compiled).href)

console.log('SDK 饱和测试')
console.log(`  目标：${baseUrl === undefined ? '本地自起服务（随机端口）' : baseUrl}`)
console.log('')

const started = Date.now()
let report
try {
  report = await mod.runSaturation({ baseUrl, verbose })
} catch (err) {
  console.error('饱和测试异常中止：', err)
  process.exit(1)
}

console.log(mod.formatReport(report, verbose))
console.log(`  用时：${Date.now() - started} ms`)
process.exit(report.ok ? 0 : 1)
