import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { currentVersion, loadMigrations, migrate, type Migration } from './migrate.js'

export interface DatabaseHandle {
  db: DatabaseSync
  path: string
  userVersion: number
  journalMode: string
  close(): void
}

export interface OpenDatabaseOptions {
  /** SQLite 文件路径；`':memory:'` 表示内存库（测试用）。 */
  path: string
  /** 迁移目录覆盖（默认与 migrate.js 同级的 migrations/）。 */
  migrationsDir?: string
  /** 已加载的迁移（测试注入用）。 */
  migrations?: Migration[]
  log?: (msg: string) => void
}

/**
 * 打开（必要时创建）数据库，并把 schema 迁移到最新。
 *
 * ## 为什么不需要用户手动建库/建表
 *
 * 1. `node:sqlite` 是 Node 内置模块 —— 不需要 `npm i better-sqlite3`，也不需要系统装 sqlite3；
 * 2. `new DatabaseSync(path)` 打开不存在的文件时会**自动创建**空库；
 * 3. 目录由本函数 `mkdirSync(recursive)` 保证存在；
 * 4. 表结构由 `migrate()` 用内嵌的 `migrations/*.sql` 自动应用，版本号记在 `PRAGMA user_version` 里
 *    （不需要额外的 `_migrations` 表），重复启动是幂等的。
 *
 * 用户侧唯一要做的事：把服务跑起来。
 */
export function openDatabase(options: OpenDatabaseOptions): DatabaseHandle {
  const log = options.log ?? (() => {})
  const path = options.path
  const inMemory = path === ':memory:'

  if (!inMemory) mkdirSync(dirname(path), { recursive: true })

  const db = new DatabaseSync(path)

  // WAL：读写不互相阻塞（单进程多连接场景下也稳）；这是持久化属性，只对新库首次设置生效
  const journalMode = String((db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string })?.journal_mode ?? 'unknown')
  // 外键必须【每个连接】都开 —— SQLite 默认是关的
  db.exec('PRAGMA foreign_keys = ON')
  // 写冲突时最多等 5s 再报 SQLITE_BUSY，而不是立刻失败
  db.exec('PRAGMA busy_timeout = 5000')
  // WAL 下 NORMAL 已足够安全（崩溃最多丢最后一个事务，不会损坏库），比 FULL 快
  db.exec('PRAGMA synchronous = NORMAL')

  const before = currentVersion(db)
  if (options.migrations) {
    // 注入式迁移（测试用）：直接跑
    for (const m of options.migrations.filter((x) => x.version > before)) {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.exec(m.sql)
        db.exec(`PRAGMA user_version = ${m.version}`)
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    }
  } else {
    migrate(db, { dir: options.migrationsDir, log })
  }

  const userVersion = currentVersion(db)
  if (userVersion === 0) {
    // 迁移后仍为 0 说明迁移目录是空的 —— 宁可拒绝启动，也不要带着空库对外服务
    db.close()
    throw new Error('迁移后 user_version 仍为 0：没有可用的迁移文件，拒绝启动')
  }

  // 启动自检：坏库要立刻暴露，而不是等第一次查询
  const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
  if (integrity.integrity_check !== 'ok') {
    db.close()
    throw new Error(`数据库完整性检查失败：${integrity.integrity_check}`)
  }

  const tables = (db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name LIKE 'dsh_teamwork_%'").get() as { c: number }).c
  if (tables !== 9) {
    db.close()
    throw new Error(`期望 9 张 dsh_teamwork_* 表，实际 ${tables} 张`)
  }

  log(`数据库就绪：${inMemory ? ':memory:' : path}（user_version=${userVersion}, journal=${journalMode}, tables=${tables}）`)

  return {
    db,
    path,
    userVersion,
    journalMode,
    close: () => db.close(),
  }
}

/** 只读地报告迁移状态（`doctor` 用，不写库）。 */
export function inspectSchema(db: DatabaseSync, migrationsDir?: string): { version: number; latest: number; pending: string[] } {
  const version = currentVersion(db)
  const migrations = loadMigrations(migrationsDir)
  const latest = migrations[migrations.length - 1]!.version
  return {
    version,
    latest,
    pending: migrations.filter((m) => m.version > version).map((m) => m.name),
  }
}
