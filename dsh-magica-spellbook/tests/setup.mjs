/**
 * 测试进程的全局隔离：**绝不写真实的 `~/.dsh`**。
 *
 * 为什么需要：spellbook 的诊断日志在拿不到 `dshHomePath` 时会按 `$DSH_HOME` 兜底、
 * 再兜底到 `~/.dsh`。单元测试直接 import 这些模块并触发 fail-fast 提问/审批时，
 * 就会往用户真实 home 里写 `logs/…`（真机事故：`~/.dsh/logs/dsh-magica-spellbook/questions/` 11.9 KB）。
 *
 * 注意：**无条件覆盖**。这台机器上 `DSH_HOME` 本来就是全局设置的（指向真实 home），
 * 所以"仅在未设置时才改"的写法根本不起作用。
 *
 * 用法：`node --import ./tests/setup.mjs --test …`（见 package.json 的 `test` 脚本）。
 *
 * @module dsh-magica-spellbook/tests/setup
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'spellbook-test-home-'))
process.env['DSH_HOME'] = home
console.log(`[tests] DSH_HOME → ${home}`)
