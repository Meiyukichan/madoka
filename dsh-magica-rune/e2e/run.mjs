/**
 * E2E 入口：起（或复用）一个 dev 实例，然后用 `node --test` 跑 specs。
 *
 * 为什么由一个进程管服务与配置：
 * - 每个 spec 各起一个 dsh 会抢端口；
 * - **中途改写 profile patch 会让 loader 换 revision**，正在跑的页面会撞上乐观锁冲突
 *   （实测：spec 之间 `restore()` 会让后面的写盘静默失败）。所以快照/还原只在
 *   这里做一次，spec 内部全程不碰文件。
 *
 * 用法：
 *   pnpm e2e                                                  # 自动找空闲端口起 dev 实例
 *   DSH_E2E_URL=http://127.0.0.1:3082/?token=... pnpm e2e      # 复用已跑着的实例
 *   DSH_E2E_CHROMIUM=/path/to/chrome pnpm e2e                  # 指定 Chromium
 *   DSH_E2E_PROFILE=web pnpm e2e                               # 换 profile（默认 dev）
 * @module dsh-magica-rune/e2e/run
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { snapshotPatch, startServer } from './harness.mjs'

const ALL = ['style', 'toggle', 'scope', 'search', 'skills']
const chosen = process.env.DSH_E2E_ONLY === undefined ? ALL : process.env.DSH_E2E_ONLY.split(',')
const SPECS = chosen.map(name => fileURLToPath(new URL(`./${name}.test.mjs`, import.meta.url)))

const restorePatch = snapshotPatch()
const server = await startServer()
console.log(`[e2e] server: ${server.url}`)
console.log(`[e2e] profile patch: 已快照，结束后原样写回`)

let exitCode = 1
try {
  exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-concurrency=1', '--test-reporter=spec', ...SPECS],
      { stdio: 'inherit', env: { ...process.env, DSH_E2E_URL: server.url } },
    )
    child.once('exit', code => resolve(code ?? 1))
    child.once('error', reject)
  })
} finally {
  await server.stop()
  if (process.env.DSH_E2E_KEEP_PATCH === '1') console.log('[e2e] DSH_E2E_KEEP_PATCH=1，保留 patch 现场')
  else { restorePatch(); console.log('[e2e] profile patch 已还原') }
}

process.exit(exitCode)
