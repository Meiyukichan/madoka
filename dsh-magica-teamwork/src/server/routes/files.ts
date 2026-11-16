/** F1–F3 文件路由：raw body 上传、流式下载、administrator 删除 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { authHook, isLoopback, userOf } from '../http/auth-hook.js'
import { errors } from '../errors.js'
import { FileService } from '../modules/file/service.js'

export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  const v1 = '/dsh-teamwork/v1'
  const signed = { preHandler: authHook(ctx, 'signed') }

  /** F1 上传：`application/octet-stream` + `X-File-Name`（percent-encoded） */
  app.post(`${v1}/files`, signed, async (req, reply) => {
    const contentType = String(req.headers['content-type'] ?? '')
    if (!contentType.toLowerCase().startsWith('application/octet-stream')) {
      throw errors.invalidRequest('Content-Type 必须是 application/octet-stream')
    }
    const nameHeader = req.headers['x-file-name']
    const shaHeader = req.headers['x-file-sha256']
    const result = await ctx.files.upload(req.raw as never, {
      fileName: Array.isArray(nameHeader) ? String(nameHeader[0]) : nameHeader === undefined ? undefined : String(nameHeader),
      sha256: Array.isArray(shaHeader) ? String(shaHeader[0]) : shaHeader === undefined ? undefined : String(shaHeader),
    })
    return reply.code(201).send(result)
  })

  /** F2 下载：只要登录（不做资源级鉴权） */
  app.get<{ Params: { fileId: string } }>(`${v1}/files/:fileId`, signed, async (req, reply) => {
    const { stream, size } = ctx.files.openDownload(req.params.fileId)
    reply
      .code(200)
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(size))
      .header('content-disposition', `attachment; filename="${req.params.fileId}"`)
    return reply.send(stream)
  })

  /** F3 删除：仅 administrator */
  app.delete<{ Params: { fileId: string } }>(`${v1}/files/:fileId`, {
    preHandler: authHook(ctx, 'administrator'),
  }, async (req, reply) => {
    if (!FileService.isFileId(req.params.fileId)) throw errors.invalidFileId()
    ctx.files.remove(userOf(req), req.params.fileId)
    return reply.code(204).send()
  })

  // 供本地停机接口复用的回环判断（避免重复实现）
  void isLoopback
}
