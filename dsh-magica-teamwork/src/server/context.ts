/** 应用上下文：一次启动里所有模块共享的东西 */
import type { DatabaseSync } from 'node:sqlite'
import type { Config } from './config.js'
import { AuthCache } from './auth/cache.js'
import { RateLimiter } from './security/rate-limit.js'
import { AccountService } from './modules/account/service.js'
import { ProjectService } from './modules/project/service.js'
import { DeviceService } from './modules/device/service.js'
import { IssueService } from './modules/issue/service.js'
import { FileService } from './modules/file/service.js'

export const PROTOCOL = 'dsh-teamwork/1' as const
export const SERVICE_VERSION = '0.2.0-alpha.1' as const

/** 已实现的端点清单（`/version` 的能力探测，也是「49 个是否齐了」的自检） */
export const ENDPOINTS: readonly string[] = [
  'POST /auth/register', 'POST /auth/login', 'GET /auth/me', 'POST /auth/logout',
  'PUT /auth/password', 'GET /auth/accounts',
  'GET /projects', 'GET /projects/mine', 'GET /projects/:id', 'GET /projects/:id/accounts', 'POST /projects',
  'PUT /projects/:id', 'DELETE /projects/:id', 'GET /projects/:id/members',
  'POST /projects/:id/members', 'DELETE /projects/:id/members/:accountId',
  'PUT /projects/:id/owner',
  'POST /devices/batch', 'GET /devices', 'GET /devices/mine', 'DELETE /devices/:id',
  'POST /device-workspaces', 'GET /device-workspaces',
  'POST /issues/batch', 'GET /issues', 'GET /issues/:issueId', 'PUT /issues/:issueId',
  'DELETE /issues/:issueId', 'POST /issues/status/batch', 'GET /issues/comments',
  'GET /issues/comments/cursor', 'POST /issues/:issueId/comments', 'GET /issues/:issueId/comments',
  'POST /issues/attachments/batch', 'GET /issues/:issueId/attachments', 'GET /attachments',
  'GET /issue-sources', 'POST /issue-sources/batch', 'PUT /issue-sources/:id', 'DELETE /issue-sources/:id',
  'POST /files', 'GET /files/:fileId', 'DELETE /files/:fileId',
  'GET /health', 'GET /version', 'POST /admin/shutdown',
  'PUT /admin/accounts/:accountId/role', 'POST /admin/accounts/:accountId/password',
  'GET /admin/accounts',
]

export interface AppContext {
  config: Config
  db: DatabaseSync
  authCache: AuthCache
  rateLimiter: RateLimiter
  accounts: AccountService
  projects: ProjectService
  devices: DeviceService
  issues: IssueService
  files: FileService
  /** 停机钩子：由 main.ts 注入 */
  shutdown: (reason: string) => void
  startedAt: number
  shutdownToken: string | null
  /** 当前是否正在停机（M1 返回 503） */
  stopping: boolean
  /** 运维入口：按需补写 config.json / run/server.json（不轮询）。 */
  ensureRuntimeFiles?: () => void
}

export interface CreateContextArgs {
  config: Config
  db: DatabaseSync
  shutdown?: (reason: string) => void
  failureDelayMs?: number
  /** false = 关闭限流（仅测试） */
  rateLimit?: boolean
}

export function createContext(args: CreateContextArgs): AppContext {
  const { config, db } = args
  const authCache = new AuthCache(config.authCacheTtlMs)
  const rateLimiter =
    args.rateLimit === false || config.rateLimit === false
      ? new RateLimiter({})
      : new RateLimiter({
          ip: [{ limit: 10, windowMs: 60_000 }],
          account: [
            { limit: 5, windowMs: 60_000 },
            { limit: 30, windowMs: 3_600_000 },
          ],
        })
  const accounts = new AccountService({
    db,
    ttlSeconds: config.tokenTtlSeconds,
    registration: config.registration,
    authCache,
    failureDelayMs: args.failureDelayMs ?? 300,
  })
  const projects = new ProjectService({ db, privateMemberLimit: config.privateMemberLimit, accounts })
  const devices = new DeviceService({ db })
  const issues = new IssueService({ db, privateMemberLimit: config.privateMemberLimit })
  const files = new FileService({ db, dataDir: config.dataDir, maxUploadBytes: config.maxUploadBytes })

  return {
    config,
    db,
    authCache,
    rateLimiter,
    accounts,
    projects,
    devices,
    issues,
    files,
    shutdown: args.shutdown ?? (() => {}),
    startedAt: Date.now(),
    shutdownToken: null,
    stopping: false,
  }
}
