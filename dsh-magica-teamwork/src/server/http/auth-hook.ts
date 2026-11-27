import type { FastifyReply, FastifyRequest } from 'fastify'
import type { CurrentUser } from '../auth/guard.js'
import { requireAdministrator } from '../auth/guard.js'
import type { AppContext } from '../context.js'

declare module 'fastify' {
  interface FastifyRequest {
    user?: CurrentUser
    /** F1 的原始字节流（application/octet-stream） */
    rawBody?: NodeJS.ReadableStream
  }
}

export type AuthLevel = 'public' | 'signed' | 'administrator'

/** 生成 preHandler：`signed` 只要求登录，`administrator` 再判全局角色 */
export function authHook(ctx: AppContext, level: AuthLevel) {
  if (level === 'public') return undefined
  return async function preHandler(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const headers = req.headers as Record<string, string | string[] | undefined>
    const user = await ctx.auth.authenticate({ headers })
    if (level === 'administrator') requireAdministrator(user)
    req.user = user
  }
}

/** 路由里取当前用户（已由 preHandler 保证存在） */
export function userOf(req: FastifyRequest): CurrentUser {
  if (!req.user) throw new Error('路由缺少鉴权 preHandler（这是代码 bug）')
  return req.user
}

/** 客户端 IP（只信任直连地址；本服务默认只绑回环） */
export function ipOf(req: FastifyRequest): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

export { isLoopbackAddress as isLoopback } from '../net.js'
