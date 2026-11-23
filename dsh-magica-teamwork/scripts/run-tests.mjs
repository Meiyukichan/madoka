/**
 * 测试入口：用 node:test 的编程式 API 跑 `lib-tests/tests/*.test.js`。
 *
 * 为什么不用 `node --test <glob>`：
 *  - Windows 的 cmd/无 glob 展开，`--test` 拿到字面量通配符会报错
 *  - `--test` 默认每个文件一个子进程，本机沙箱下 spawn 会 EPERM
 * 这里用 `isolation: 'none'` 在**同一进程**内跑完全部用例。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { run } from 'node:test'
import { spec } from 'node:test/reporters'

const dir = 'lib-tests/tests'
// Unit tests exercise castboardLog; keep their fake `boom`/network fixtures out of the real log file.
process.env.DSH_TEAMWORK_NO_LOG = '1'
let files
try {
  files = readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => join(dir, f))
} catch {
  console.error(`找不到 ${dir}，请先执行：node ./node_modules/typescript/bin/tsc -p tsconfig.tests.json`)
  process.exit(1)
}

if (files.length === 0) {
  console.error(`${dir} 下没有测试文件`)
  process.exit(1)
}

console.log(`运行 ${files.length} 个测试文件（同进程，isolation: none）\n`)
const stream = run({ files, isolation: 'none', concurrency: 1 })
stream.compose(new spec()).pipe(process.stdout)
