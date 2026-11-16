/** 统一错误处理器（server-design §6.1.1） */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { BusinessError } from '../errors.js'

const FRAMEWORK_CODES: Record<number, string> = {
  400: 'invalid_request',
  401: 'unauthorized',
  404: 'not_found',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    if (reply.sent) return
    const requestId = String(req.id)

    if (err instanceof BusinessError) {
      if (err.status === 429 && typeof err.details === 'object' && err.details !== null) {
        const wait = (err.details as { retryAfterSeconds?: number }).retryAfterSeconds
        if (wait) reply.header('retry-after', String(wait))
      }
      return reply.code(err.status).send({
        code: err.code,
        message: err.message,
        ...(err.details === undefined ? {} : { details: err.details }),
        requestId,
      })
    }

    // Fastify 自己的校验错误（当前未用 TypeBox，保留兼容）
    if (err.validation) {
      return reply.code(400).send({
        code: 'invalid_request',
        message: err.message,
        details: { field: err.validation[0]?.instancePath?.replace(/^\//, '') },
        requestId,
      })
    }

    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500
    if (status === 500) {
      req.log.error({ err }, 'unhandled error')
      return reply.code(500).send({ code: 'internal_error', message: '服务内部错误', requestId })
    }
    return reply.code(status).send({
      code: FRAMEWORK_CODES[status] ?? 'invalid_request',
      message: err.message,
      requestId,
    })
  })

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    reply.code(404).send({ code: 'not_found', message: `没有这个路由：${req.method} ${req.url}`, requestId: String(req.id) })
  })
}
