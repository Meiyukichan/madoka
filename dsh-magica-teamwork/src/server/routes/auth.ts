/** A1–A7 账号路由 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppContext } from '../context.js'
import { authHook, ipOf, userOf } from '../http/auth-hook.js'
import { assertNoUnknownFields } from '../http/strict.js'
import { errors } from '../errors.js'
import type { AuthDevice, RequestHeaders } from '../auth/provider.js'

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const limited = (req: FastifyRequest, accountId?: string): void => {
    const ipHit = ctx.rateLimiter.hit('ip', ipOf(req))
    if (ipHit.limited) throw errors.rateLimited(ipHit.retryAfterSeconds)
    if (accountId) {
      const accHit = ctx.rateLimiter.hit('account', accountId)
      if (accHit.limited) throw errors.rateLimited(accHit.retryAfterSeconds)
    }
  }

  /** A0 认证交换：账号 + 长期凭据 → 短期请求 headers（名字由服务端决定） */
  app.post('/dsh-teamwork/v1/auth/token', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    assertNoUnknownFields(body, ['accountId', 'accountToken', 'device'])
    if (typeof body.accountId !== 'string' || body.accountId === '') {
      throw errors.invalidCredentials()
    }
    if (typeof body.accountToken !== 'string' || body.accountToken === '' || body.accountToken.length > 4096) {
      throw errors.invalidCredentials()
    }
    limited(req, body.accountId)
    const device = parseDevice(body.device)
    const grant = await ctx.auth.issue({
      accountId: body.accountId,
      accountToken: body.accountToken,
      ...(device === undefined ? {} : { device }),
    })
    return reply.header('cache-control', 'no-store').code(200).send(grant)
  })

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

  /** A4 登出（语义由 AuthProvider 决定；本地 provider 清鉴权缓存） */
  app.post('/dsh-teamwork/v1/auth/logout', { preHandler: authHook(ctx, 'signed') }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    assertNoUnknownFields(body, ['allDevices'])
    if (body.allDevices === true) throw errors.notSupported('没有会话表，无法按设备踢人；要全踢请改密码')
    await ctx.auth.logout({ headers: req.headers as RequestHeaders })
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

function parseDevice(value: unknown): AuthDevice | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw errors.invalidRequest('device 必须是对象')
  }
  const record = value as Record<string, unknown>
  assertNoUnknownFields(record, ['id', 'host', 'port', 'os'], { allowIdentity: true })
  for (const key of ['id', 'host', 'os'] as const) {
    const item = record[key]
    if (item !== undefined && (typeof item !== 'string' || item.length > 256)) {
      throw errors.invalidRequest(`device.${key} 必须是长度不超过 256 的字符串`)
    }
  }
  if (record.port !== undefined) {
    if (
      typeof record.port !== 'number'
      || !Number.isInteger(record.port)
      || record.port < 0
      || record.port > 65_535
    ) {
      throw errors.invalidRequest('device.port 必须是 0..65535 的整数')
    }
  }
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.host === 'string' ? { host: record.host } : {}),
    ...(typeof record.port === 'number' ? { port: record.port } : {}),
    ...(typeof record.os === 'string' ? { os: record.os } : {}),
  }
}
