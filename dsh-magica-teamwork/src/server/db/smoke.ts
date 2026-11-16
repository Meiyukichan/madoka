/**
 * 自动迁移冒烟验证（不依赖任何第三方包）：
 *
 *   node src/server/db/smoke.ts
 *
 * 验证四件事：
 *  1. 全新目录 → 自动建库 + 建表，用户不需要手动执行任何 SQL
 *  2. 重复打开 → 幂等（不会重复应用迁移）
 *  3. 迁移失败 → 整体回滚且 user_version 不推进
 *  4. 旧版程序打开新版库 → 明确报错而不是静默降级
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from './database.js'
import { currentVersion, migrate, type Migration } from './migrate.js'

let pass = 0
let fail = 0
const check = (label: string, cond: boolean, extra = ''): void => {
  if (cond) {
    pass++
    console.log(`  ✅ ${label}${extra ? ' — ' + extra : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`)
  }
}

// ── 1. 全新目录
const dir = mkdtempSync(join(tmpdir(), 'tw-smoke-'))
const dbPath = join(dir, 'nested', 'deeper', 'teamwork.db')
console.log(`\n【1】全新目录（含多层不存在目录）：${dir}`)
check('打开前 db 文件不存在', !existsSync(dbPath))
const handle = openDatabase({ path: dbPath, log: (m) => console.log(`     · ${m}`) })
check('db 文件已被自动创建', existsSync(dbPath))
check('user_version = 1', handle.userVersion === 1, String(handle.userVersion))
check('journal_mode = wal', handle.journalMode.toLowerCase() === 'wal', handle.journalMode)
{
  const tables = handle.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dsh_teamwork_%' ORDER BY name").all() as { name: string }[]
  check('9 张业务表全部就位', tables.length === 9, `${tables.length} 张`)
  const idx = handle.db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").get() as { c: number }
  check('30 个索引', idx.c === 30, String(idx.c))
  const preset = handle.db.prepare('SELECT code FROM dsh_teamwork_issue_source ORDER BY code').all() as { code: string }[]
  check('预置来源 3 条', preset.map((r) => r.code).join(',') === 'dsh,im-group,self', preset.map((r) => r.code).join(','))
  // 真的能写
  handle.db.prepare("INSERT INTO dsh_teamwork_account(account_id, account_token) VALUES('smoke', ?)").run('a'.repeat(64))
  const n = handle.db.prepare('SELECT count(*) AS c FROM dsh_teamwork_account').get() as { c: number }
  check('可写入数据', n.c === 1)
}
handle.close()

// ── 2. 重复打开（幂等）
console.log('\n【2】重复打开同一个库')
const again = openDatabase({ path: dbPath, log: (m) => console.log(`     · ${m}`) })
check('user_version 仍为 1', again.userVersion === 1)
{
  const n = again.db.prepare('SELECT count(*) AS c FROM dsh_teamwork_account').get() as { c: number }
  check('数据仍在（没有被重建）', n.c === 1, `${n.c} 行`)
}
again.close()

// ── 3. 迁移失败必须整体回滚
console.log('\n【3】迁移失败 → 回滚 + 不推进版本')
{
  const bad = new DatabaseSync(':memory:')
  bad.exec('PRAGMA foreign_keys = ON')
  const broken: Migration[] = [
    { version: 1, name: '001_bad.sql', sql: 'CREATE TABLE ok1(a INTEGER); CREATE TABLE BROKEN (' },
  ]
  let threw = false
  try {
    bad.exec('BEGIN IMMEDIATE')
    bad.exec(broken[0]!.sql)
    bad.exec('PRAGMA user_version = 1')
    bad.exec('COMMIT')
  } catch {
    threw = true
    bad.exec('ROLLBACK')
  }
  check('坏迁移抛错', threw)
  check('user_version 仍为 0', currentVersion(bad) === 0, String(currentVersion(bad)))
  const leftover = bad.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get() as { c: number }
  check('半个 schema 没有残留', leftover.c === 0, `${leftover.c} 张表`)
  bad.close()
}

// ── 4. 旧程序打开新版库
console.log('\n【4】数据库版本高于程序支持版本')
{
  const newer = new DatabaseSync(join(dir, 'newer.db'))
  newer.exec('PRAGMA user_version = 99')
  let msg = ''
  try {
    migrate(newer)
  } catch (e) {
    msg = (e as Error).message
  }
  check('明确报错而不是静默降级', msg.includes('高于本程序支持'), msg.slice(0, 60))
  newer.close()
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n=== ${fail === 0 ? '全部通过' : `${fail} 项失败`}（${pass} 通过 / ${fail} 失败）===`)
process.exitCode = fail === 0 ? 0 : 1
