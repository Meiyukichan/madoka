/** 数据库迁移：自动建库 / 幂等 / 回滚 / 版本护栏 / 预置数据 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../src/server/db/database.js'
import { currentVersion, loadMigrations, migrate } from '../src/server/db/migrate.js'

test('迁移：全新目录自动建库 + 9 表 / 30 索引 / 预置 3 条', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-mig-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'deep', 'nested', 'teamwork.db')
  assert.equal(existsSync(dbPath), false)

  const handle = openDatabase({ path: dbPath, log: () => {} })
  try {
    assert.ok(existsSync(dbPath), '库文件应被自动创建')
    assert.equal(handle.userVersion, 1)
    assert.equal(handle.journalMode.toLowerCase(), 'wal')

    const tables = handle.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dsh_teamwork_%' ORDER BY name")
      .all() as Array<{ name: string }>
    assert.equal(tables.length, 9)

    const attachmentCols = (handle.db.prepare('PRAGMA table_info(dsh_teamwork_issue_attachment)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    )
    assert.deepEqual(attachmentCols, [
      'id', 'target_type', 'target_id', 'file_id', 'file_name', 'role', 'description', 'created_at', 'updated_at',
    ])

    const idx = handle.db
      .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
      .get() as { c: number }
    assert.equal(idx.c, 30)

    const checks = (handle.db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all() as Array<{ sql: string }>).reduce(
      (n, r) => n + ((r.sql.match(/CHECK \(/g) ?? []).length),
      0,
    )
    assert.equal(checks, 20)

    const fks = (handle.db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all() as Array<{ sql: string }>).reduce(
      (n, r) => n + ((r.sql.match(/FOREIGN KEY/g) ?? []).length),
      0,
    )
    assert.equal(fks, 1)

    const presets = (handle.db.prepare('SELECT code FROM dsh_teamwork_issue_source ORDER BY code').all() as Array<{ code: string }>).map(
      (r) => r.code,
    )
    assert.deepEqual(presets, ['dsh', 'im-group', 'self'])

    const integrity = handle.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    assert.equal(integrity.integrity_check, 'ok')
  } finally {
    handle.close()
  }
})

test('迁移：重复打开幂等，数据不被重建', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-mig2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'teamwork.db')

  const a = openDatabase({ path: dbPath, log: () => {} })
  a.db.prepare("INSERT INTO dsh_teamwork_account(account_id, account_token) VALUES('keep', ?)").run('a'.repeat(64))
  a.close()

  const b = openDatabase({ path: dbPath, log: () => {} })
  try {
    assert.equal(b.userVersion, 1)
    const n = b.db.prepare('SELECT count(*) AS c FROM dsh_teamwork_account').get() as { c: number }
    assert.equal(n.c, 1, '数据必须还在')
  } finally {
    b.close()
  }
})

test('迁移：坏 SQL 整体回滚且不推进版本', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  let threw = false
  try {
    db.exec('BEGIN IMMEDIATE')
    db.exec('CREATE TABLE ok1(a INTEGER); CREATE TABLE broken (')
    db.exec('PRAGMA user_version = 1')
    db.exec('COMMIT')
  } catch {
    threw = true
    db.exec('ROLLBACK')
  }
  assert.equal(threw, true)
  assert.equal(currentVersion(db), 0)
  const leftover = db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get() as { c: number }
  assert.equal(leftover.c, 0, '半个 schema 不能残留')
  db.close()
})

test('迁移：库版本高于程序支持版本时拒绝启动', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA user_version = 99')
  assert.throws(() => migrate(db), /高于本程序支持/)
  db.close()
})

test('迁移文件：命名规范与版本号连续', () => {
  const migrations = loadMigrations()
  assert.ok(migrations.length >= 1)
  assert.equal(migrations[0]!.version, 1)
  for (const m of migrations) {
    assert.match(m.name, /^\d{3}_[a-z0-9_]+\.sql$/)
  }
  // 版本号严格递增
  for (let i = 1; i < migrations.length; i++) {
    assert.ok(migrations[i]!.version > migrations[i - 1]!.version)
  }
})

test('数据库：外键级联删除成员行', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-mig3-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const handle = openDatabase({ path: join(dir, 'teamwork.db'), log: () => {} })
  try {
    const db = handle.db
    db.prepare("INSERT INTO dsh_teamwork_account(account_id, account_token) VALUES('acc', ?)").run('a'.repeat(64))
    const pid = (db.prepare("INSERT INTO dsh_teamwork_project(name) VALUES('p') RETURNING id").get() as { id: number }).id
    db.prepare("INSERT INTO dsh_teamwork_project_member(project_id, account_id, role) VALUES(?, 'acc', 'owner')").run(pid)
    assert.equal((db.prepare('SELECT count(*) AS c FROM dsh_teamwork_project_member').get() as { c: number }).c, 1)

    db.prepare('DELETE FROM dsh_teamwork_project WHERE id = ?').run(pid)
    assert.equal(
      (db.prepare('SELECT count(*) AS c FROM dsh_teamwork_project_member').get() as { c: number }).c,
      0,
      '删项目必须级联清成员',
    )
  } finally {
    handle.close()
  }
})

test('数据库：唯一 owner 部分索引真的拦得住第二个 owner', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-mig4-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const handle = openDatabase({ path: join(dir, 'teamwork.db'), log: () => {} })
  try {
    const db = handle.db
    for (const id of ['usr1', 'usr2']) db.prepare('INSERT INTO dsh_teamwork_account(account_id, account_token) VALUES(?, ?)').run(id, 'a'.repeat(64))
    const pid = (db.prepare("INSERT INTO dsh_teamwork_project(name) VALUES('p') RETURNING id").get() as { id: number }).id
    db.prepare("INSERT INTO dsh_teamwork_project_member(project_id, account_id, role) VALUES(?, 'usr1', 'owner')").run(pid)
    assert.throws(() => db.prepare("INSERT INTO dsh_teamwork_project_member(project_id, account_id, role) VALUES(?, 'usr2', 'owner')").run(pid), /UNIQUE/)
  } finally {
    handle.close()
  }
})
