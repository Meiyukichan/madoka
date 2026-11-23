/** A1–A6 账号路由 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppContext } from '../context.js'
import { authHook, ipOf, tokenOf, userOf } from '../http/auth-hook.js'
import { assertNoUnknownFields } from '../http/strict.js'
import { errors } from '../errors.js'

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const limited = (req: FastifyRequest, accountId?: string): void => {
    const ipHit = ctx.rateLimiter.hit('ip', ipOf(req))
    if (ipHit.limited) throw errors.rateLimited(ipHit.retryAfterSeconds)
    if (accountId) {
      const accHit = ctx.rateLimiter.hit('account', accountId)
      if (accHit.limited) throw errors.rateLimited(accHit.retryAfterSeconds)
    }
  }

  /** A1 注册（公开 + 注册闸门） */
  app.post('/dsh-teamwork/v1/auth/register', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    assertNoUnknownFields(body, ['accountId', 'password', 'displayName'])
    limited(req, typeof body.accountId === 'string' ? body.accountId : undefined)
    const session = await ctx.accounts.register(body)
    return reply.code(201).send(session)
  })

  /** A2 登录 */
  app.post('/dsh-teamwork/v1/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    assertNoUnknownFields(body, ['accountId', 'password'])
    limited(req, typeof body.accountId === 'string' ? body.accountId : undefined)
    const session = await ctx.accounts.login(body)
    return reply.code(200).send(session)
  })

  /** A3 当前账号 */
  app.get('/dsh-teamwork/v1/auth/me', { preHandler: authHook(ctx, 'signed') }, async (req) => ctx.accounts.me(userOf(req)))

  /** A4 登出（纯语义） */
  app.post('/dsh-teamwork/v1/auth/logout', { preHandler: authHook(ctx, 'signed') }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    assertNoUnknownFields(body, ['allDevices'])
    if (body.allDevices === true) throw errors.notSupported('没有会话表，无法按设备踢人；要全踢请改密码')
    ctx.accounts.logout(tokenOf(req))
    return reply.code(204).send()
  })

  /** A5 改密码（返回新密钥） */
  app.put('/dsh-teamwork/v1/auth/password', { preHandler: authHook(ctx, 'signed') }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    assertNoUnknownFields(body, ['oldPassword', 'newPassword'])
    limited(req, userOf(req).accountId)
    return ctx.accounts.changePassword(userOf(req), body)
  })

  /** A6 查账号（administrator） */
  app.get('/dsh-teamwork/v1/auth/accounts', { preHandler: authHook(ctx, 'administrator') }, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    return ctx.accounts.lookup(q.accountId)
  })
}
