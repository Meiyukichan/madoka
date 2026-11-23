/**
 * bin 入口：解析配置 → 打开/迁移数据库 → 抢单实例锁 → 监听 → 优雅停机。
 *
 * 用户侧零手工步骤：目录、数据库、表结构都在这里自动就绪。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type DatabaseHandle } from './db/database.js'
import { resolveConfig, HELP } from './config.js'
import { createContext, PROTOCOL, SERVICE_VERSION, type AppContext } from './context.js'
import { buildApp } from './app.js'
import { pathToFileURL } from 'node:url'
import { isLoopback } from './http/auth-hook.js'
import { formatDomain } from '../shared/domain.js'

interface LockFile {
  pid: number
  host: string
  port: number
  startedAt: string
  version: string
  protocol: string
  shutdownToken: string
}

export interface StartServerOptions {
  argv?: string[]
  /** 测试用：直接给定内存库或临时目录 */
  dataDir?: string
  port?: number
  log?: (msg: string) => void
  /** 测试用：关闭限流（生产不要传 false） */
  rateLimit?: boolean
}

export interface RunningServer {
  ctx: AppContext
  app: Awaited<ReturnType<typeof buildApp>['listen']> extends never ? never : ReturnType<typeof buildApp>
  port: number
  host: string
  lockPath: string | null
  close: () => Promise<void>
}

/** 供测试与外部集成复用：启动一个完整服务 */
export async function startServer(options: StartServerOptions = {}): Promise<{
  app: ReturnType<typeof buildApp>
  ctx: AppContext
  db: DatabaseHandle
  port: number
  host: string
  close: () => Promise<void>
}> {
  const log = options.log ?? ((m: string) => process.stdout.write(`${m}\n`))
  const argv = [...(options.argv ?? [])]
  if (options.dataDir !== undefined && !argv.includes('--data-dir')) argv.push('--data-dir', options.dataDir)
  if (options.port !== undefined && !argv.includes('--port')) argv.push('--port', String(options.port))
  const { config, action } = resolveConfig({ argv })
  if (action === 'help') {
    process.stdout.write(HELP)
    throw new Error('help')
  }
  if (action === 'version') {
    process.stdout.write(`${SERVICE_VERSION} (${PROTOCOL})\n`)
    throw new Error('version')
  }
  const finalConfig = {
    ...config,
    ...(options.dataDir ? { dataDir: options.dataDir, dbPath: join(options.dataDir, 'teamwork.db') } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
  }

  const db = openDatabase({ path: finalConfig.dbPath, log })

  // 单实例锁
  const runDir = join(finalConfig.dataDir, 'run')
  mkdirSync(runDir, { recursive: true })
  const lockPath = join(runDir, 'server.json')
  const shutdownToken = randomUUID()
  if (existsSync(lockPath)) {
    const existing = safeReadLock(lockPath)
    if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
      throw new Error(
        `已有实例在运行（pid=${existing.pid}, ${existing.host}:${existing.port}, startedAt=${existing.startedAt}）。` +
          `要重启请先调 POST /dsh-teamwork/v1/admin/shutdown。`,
      )
    }
  }
  const lock: LockFile = {
    pid: process.pid,
    host: finalConfig.host,
    port: finalConfig.port,
    startedAt: new Date().toISOString(),
    version: SERVICE_VERSION,
    protocol: PROTOCOL,
    shutdownToken,
  }

  let closing = false
  const ctx = createContext({
    config: finalConfig,
    db: db.db,
    rateLimit: options.rateLimit,
    shutdown: () => {
      void close()
    },
  })
  ctx.shutdownToken = shutdownToken

  const app = buildApp({ ctx, logger: false })

  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    ctx.stopping = true
    try {
      const grace = setTimeout(() => {
        // 在飞请求可能无限阻塞 close()，到点强制断开
        app.server.closeAllConnections?.()
      }, finalConfig.shutdownGraceMs)
      await app.close()
      clearTimeout(grace)
    } catch (err) {
      log(`[server] 关闭时出错：${(err as Error).message}`)
    } finally {
      try {
        db.close()
      } catch {
        /* ignore */
      }
      if (existsSync(lockPath)) {
        try {
          const current = safeReadLock(lockPath)
          if (current?.token === shutdownToken || current?.pid === process.pid) unlinkSync(lockPath)
        } catch {
          /* ignore */
        }
      }
    }
  }

  try {
    await app.listen({ host: finalConfig.host, port: finalConfig.port })
  } catch (err) {
    await close()
    throw err
  }
  const address = app.server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : finalConfig.port
  const configPath = join(finalConfig.dataDir, 'config.json')
  const template = {
    domain: finalConfig.port === 0 ? formatDomain(finalConfig.host, actualPort) : finalConfig.domain,
    tokenTtlDays: Math.round(finalConfig.tokenTtlSeconds / 86_400),
    maxUploadMb: Math.round(finalConfig.maxUploadBytes / (1024 * 1024)),
    shutdownGraceMs: finalConfig.shutdownGraceMs,
    startTimeoutMs: finalConfig.startTimeoutMs,
    registration: finalConfig.registration,
    privateMemberLimit: finalConfig.privateMemberLimit,
    authCacheTtlMs: finalConfig.authCacheTtlMs,
    rateLimit: finalConfig.rateLimit,
    localServiceRestart: false,
    logLevel: finalConfig.logLevel,
    logFile: finalConfig.logFile,
  }
  const lockBody = JSON.stringify({ ...lock, pid: process.pid, port: actualPort }, null, 2)

  // A fresh install should leave a visible, editable file with every effective setting.
  // Never overwrite a user file. Re-check periodically so a deleted file self-heals while
  // the service is already running (dsh dev then sees the same state on every restart).
  const ensureRuntimeFiles = (): void => {
    if (closing) return
    if (!existsSync(lockPath)) {
      try {
        writeFileSync(lockPath, lockBody, { mode: 0o600 })
      } catch {
        /* best-effort */
      }
    }
    if (!existsSync(configPath)) {
      try {
        writeFileSync(configPath, `${JSON.stringify(template, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
        })
      } catch {
        /* another process may have won the race; its file is equally valid */
      }
    }
  }
  ctx.ensureRuntimeFiles = ensureRuntimeFiles
  ensureRuntimeFiles()
  log(`[server] listening on http://${finalConfig.host}:${actualPort}${''}`)
  log(`[server] data: ${finalConfig.dataDir}`)

  return { app, ctx, db, port: actualPort, host: finalConfig.host, close }
}

function safeReadLock(path: string): (LockFile & { token?: string }) | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockFile & { token?: string }
  } catch {
    return null
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** CLI 入口 */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === 'serve') argv = argv.slice(1)
  const { action } = resolveConfig({ argv })
  if (action === 'help') {
    process.stdout.write(HELP)
    return
  }
  if (action === 'version') {
    process.stdout.write(`${SERVICE_VERSION} (${PROTOCOL})\n`)
    return
  }

  const running = await startServer({ argv })
  const shutdown = (reason: string): void => {
    process.stdout.write(`[server] shutting down (${reason})\n`)
    void running.close().then(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[server] uncaught exception: ${err.stack ?? err.message}\n`)
    shutdown('uncaughtException')
  })
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[server] unhandled rejection: ${String(reason)}\n`)
    shutdown('unhandledRejection')
  })
}


/** 作为 bin 直接执行时自动启动；被 import 时只导出 startServer / main */
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  void main().catch((err: unknown) => {
    process.stderr.write('[server] 启动失败：' + String((err as Error).message) + '\n')
    process.exit(1)
  })
}