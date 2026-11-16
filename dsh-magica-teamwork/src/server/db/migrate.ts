import { readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { EMBEDDED_MIGRATIONS } from './migrations.generated.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

/** 一个迁移文件：版本号就是文件名前缀（001_init.sql → 1）。 */
export interface Migration {
  version: number
  name: string
  sql: string
}

export interface MigrateOptions {
  /** 迁移目录；缺省为与当前模块同级的 `migrations/`。 */
  dir?: string
  /** 日志出口，默认不输出。 */
  log?: (msg: string) => void
}

export interface MigrateResult {
  from: number
  to: number
  applied: string[]
}

const FILE_RE = /^(\d{3})_([a-z0-9_]+)\.sql$/

/**
 * 从目录读取迁移文件，按版本号升序返回。
 *
 * 文件名必须形如 `001_init.sql`（三位版本号 + 下划线 + 名字）。
 * 目录为空或不存在时抛错 —— 静默跳过迁移会让服务带着空库跑起来，这是最难查的故障。
 */
export function loadMigrations(dir?: string): Migration[] {
  // 显式传 dir → 读目录（开发/测试）；否则用构建期内联的 SQL（单文件产物没有目录可读）
  const fromDir = dir !== undefined ? readDirMigrations(dir) : null
  const migrations = fromDir ?? embeddedMigrations()
  migrations.sort((a, b) => a.version - b.version)
  const dup = migrations.find((x, i) => i > 0 && x.version === migrations[i - 1]!.version)
  if (dup) throw new Error(`迁移版本号重复：${dup.version}`)
  return migrations
}

function readDirMigrations(base: string): Migration[] {
  let entries: string[]
  try {
    entries = readdirSync(base)
  } catch (err) {
    throw new Error(`迁移目录不可读：${base}（${(err as Error).message}）`)
  }
  const migrations: Migration[] = []
  for (const file of entries) {
    const m = FILE_RE.exec(file)
    if (!m) continue
    migrations.push({ version: Number(m[1]), name: file, sql: readFileSync(join(base, file), 'utf8') })
  }
  if (migrations.length === 0) throw new Error(`迁移目录里没有 *.sql：${base}`)
  return migrations
}

/** 构建期内联的迁移（scripts/build.mjs 生成） */
function embeddedMigrations(): Migration[] {
  const migrations: Migration[] = []
  for (const [file, sql] of Object.entries(EMBEDDED_MIGRATIONS)) {
    const m = FILE_RE.exec(file)
    if (!m) continue
    migrations.push({ version: Number(m[1]), name: file, sql })
  }
  if (migrations.length === 0) throw new Error('内联迁移为空：构建脚本没有生成 migrations.generated.ts')
  return migrations
}

function defaultMigrationsDir(): string {
  return join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'migrations')
}

/** 读 `PRAGMA user_version`（SQLite 内置的 schema 版本号，不需要额外建表）。 */
export function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return Number(row?.user_version ?? 0)
}

/**
 * 执行未应用的迁移。
 *
 * 每个文件一个 `BEGIN IMMEDIATE … COMMIT`：
 *  - 成功 → 把 `user_version` 推进到该版本
 *  - 失败 → 整个文件回滚，`user_version` 不推进，抛错
 *
 * 由此保证：**进程中途崩溃也不会留下半个 schema**，下次启动从同一版本重试。
 */
export function migrate(db: DatabaseSync, options: MigrateOptions = {}): MigrateResult {
  const log = options.log ?? (() => {})
  const migrations = loadMigrations(options.dir)
  const from = currentVersion(db)
  const latest = migrations[migrations.length - 1]!.version

  if (from > latest) {
    throw new Error(
      `数据库 schema 版本（user_version=${from}）高于本程序支持的最高版本（${latest}）。` +
        `这通常意味着你用旧版服务打开了新版数据库，请升级程序而不是降级数据。`,
    )
  }

  const pending = migrations.filter((m) => m.version > from)
  if (pending.length === 0) {
    log(`schema 已是最新（user_version=${from}）`)
    return { from, to: from, applied: [] }
  }

  const applied: string[] = []
  for (const m of pending) {
    log(`应用迁移 ${m.name}（${from} → ${m.version}）`)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(m.sql)
      // user_version 接受字面量，不能用参数绑定
      db.exec(`PRAGMA user_version = ${m.version}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`迁移 ${m.name} 失败，已回滚（数据库仍是 user_version=${currentVersion(db)}）：${(err as Error).message}`)
    }
    applied.push(m.name)
  }
  const to = currentVersion(db)
  log(`迁移完成：${from} → ${to}`)
  return { from, to, applied }
}

/** 供测试用：内存库或临时库上跑一遍迁移。 */
export function migrateInMemory(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

export function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}
