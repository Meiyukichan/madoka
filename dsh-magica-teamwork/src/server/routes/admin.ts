/** M1–M6 运维与管理路由 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { authHook, isLoopback, ipOf, userOf } from '../http/auth-hook.js'
import { assertNoUnknownFields } from '../http/strict.js'
import { normalizePage, normalizePageSize } from '../modules/account/service.js'
import { ENDPOINTS, PROTOCOL, SERVICE_VERSION } from '../context.js'
import { errors } from '../errors.js'

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const v1 = '/dsh-teamwork/v1'

  /** M1 健康检查（公开；停机中 503） */
  app.get(`${v1}/health`, async (_req, reply) => {
    const journal = ctx.db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined
    const body = {
      ok: !ctx.stopping,
      version: SERVICE_VERSION,
      pid: process.pid,
      uptimeMs: Date.now() - ctx.startedAt,
      startedAt: new Date(ctx.startedAt).toISOString(),
      serverTime: new Date().toISOString(),
      db: {
        path: ctx.config.dbPath,
        userVersion: (ctx.db.prepare('PRAGMA user_version').get() as { user_version?: number })?.user_version ?? 0,
        journalMode: journal?.journal_mode ?? 'unknown',
      },
      authCache: ctx.authCache.stats(),
    }
    return reply.code(ctx.stopping ? 503 : 200).send(body)
  })

  /** M2 版本与能力探测（公开） */
  app.get(`${v1}/version`, async () => ({
    protocol: PROTOCOL,
    name: 'dsh-teamwork',
    version: SERVICE_VERSION,
    node: process.version,
    endpoints: ENDPOINTS,
  }))

  /** 运维补写运行期文件：SDK 在 already-running 时按需调用，不轮询。 */
  app.post(`${v1}/admin/runtime-files`, async (req, reply) => {
    if (!isLoopback(ipOf(req))) throw errors.forbidden('只接受回环来源')
    ctx.ensureRuntimeFiles?.()
    return reply.code(200).send({ ok: true })
  })

  /** M3 停机：锁文件 token + 回环，或 administrator JWT */  app.post(`${v1}/admin/shutdown`, async (req, reply) => {
    const ip = ipOf(req)
    if (!isLoopback(ip)) throw errors.forbidden('只接受回环来源')

    const tokenHeader = req.headers['x-shutdown-token']
    const token = Array.isArray(tokenHeader) ? String(tokenHeader[0]) : tokenHeader === undefined ? '' : String(tokenHeader)
    const tokenOk = Boolean(ctx.shutdownToken) && token === ctx.shutdownToken

    if (!tokenOk) {
      // 退化为 administrator 签名头
      const { authenticateHeaders, requireAdministrator } = await import('../auth/guard.js')
      const { user } = authenticateHeaders(req.headers as Record<string, string | string[] | undefined>, {
        db: ctx.db,
        ttlSeconds: ctx.config.tokenTtlSeconds,
        authCache: ctx.authCache,
      })
      requireAdministrator(user)
    }

    if (!ctx.stopping) {
      ctx.stopping = true
      // 异步停机，先回 202
      setImmediate(() => ctx.shutdown('api'))
    }
    return reply.code(202).send({ ok: true, stopping: true })
  })

  /** M4 改全局角色（administrator） */
  app.put<{ Params: { accountId: string } }>(`${v1}/admin/accounts/:accountId/role`, {
    preHandler: authHook(ctx, 'administrator'),
  }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    assertNoUnknownFields(body, ['role'])
    // 降级会让他失去 public 项目 owner 资格 → 先检查
    const nextRole = body.role
    if (nextRole === 'user') {
      const projects = ctx.projects.publicProjectsOwnedBy(req.params.accountId)
      if (projects.length > 0) throw errors.ownerOfPublicProjects(projects)
    }
    return ctx.accounts.setRole(req.params.accountId, nextRole)
  })

  /** M5 管理员重置密码（administrator） */
  app.post<{ Params: { accountId: string } }>(`${v1}/admin/accounts/:accountId/password`, {
    preHandler: authHook(ctx, 'administrator'),
  }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    assertNoUnknownFields(body, ['newPassword'])
    ctx.accounts.adminResetPassword(req.params.accountId, body.newPassword)
    return reply.code(204).send()
  })

  /** M6 账号列表（administrator） */
  app.get(`${v1}/admin/accounts`, { preHandler: authHook(ctx, 'administrator') }, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    return ctx.accounts.list(q.q, q.pageNum ?? normalizePage(undefined), q.pageSize ?? normalizePageSize(undefined))
  })

  void userOf
}
