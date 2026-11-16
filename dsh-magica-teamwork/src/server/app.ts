/** Fastify 应用装配：内容类型、错误处理、路由 */
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppContext } from './context.js'
import { installErrorHandler } from './http/error-handler.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerProjectRoutes } from './routes/projects.js'
import { registerDeviceRoutes } from './routes/devices.js'
import { registerIssueRoutes } from './routes/issues.js'
import { registerFileRoutes } from './routes/files.js'
import { registerAdminRoutes } from './routes/admin.js'

export interface BuildAppOptions {
  ctx: AppContext
  /** 测试里设 false 以静音 */
  logger?: boolean
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { ctx } = options
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1024 * 1024, // JSON body 上限 1 MB（文件走 raw 流）
    genReqId: () => cryptoRandomId(),
  })

  // F1 用原始字节流，不缓冲进内存
  app.addContentTypeParser('application/octet-stream', (_req, _payload, done) => {
    done(null, undefined)
  })

  // 空 body + application/json 不该 400（不少客户端的 DELETE 就这么发）
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = String(body ?? '')
    if (text.trim() === '') return done(null, undefined)
    try {
      done(null, JSON.parse(text))
    } catch (err) {
      done(err as Error, undefined)
    }
  })
  // 表单内容类型：无 body 的 POST 常带它（PowerShell / curl -d 空字符串），不该 415
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body.length === 0 ? undefined : body)
  })

  // 兜底：其余未知 Content-Type 按裸字节收下
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body.length === 0 ? undefined : body)
  })
  installErrorHandler(app)

  registerAuthRoutes(app, ctx)
  registerProjectRoutes(app, ctx)
  registerDeviceRoutes(app, ctx)
  registerIssueRoutes(app, ctx)
  registerFileRoutes(app, ctx)
  registerAdminRoutes(app, ctx)

  return app
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID()
}
