/** C1–C16 issue / 评论 / 附件 / 来源路由 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { authHook, userOf } from '../http/auth-hook.js'
import { assertArrayBody, assertNoUnknownFields, int } from '../http/strict.js'
import { errors } from '../errors.js'

export function registerIssueRoutes(app: FastifyInstance, ctx: AppContext): void {
  const v1 = '/dsh-teamwork/v1'
  const signed = { preHandler: authHook(ctx, 'signed') }

  /** C1 批量提交（整批原子） */
  app.post(`${v1}/issues/batch`, signed, async (req) => {
    const items = assertArrayBody(req.body, 100, 'issues')
    return ctx.issues.batchCreate(userOf(req), items)
  })

  /** C2 列表 */
  app.get(`${v1}/issues`, signed, async (req) => ctx.issues.list((req.query ?? {}) as Record<string, unknown>))

  /** C8 评论游标（放在 C3 之前，避免 `:issueId` 抢先匹配） */
  app.get(`${v1}/issues/comments/cursor`, signed, async () => ctx.issues.commentsCursor())

  /** C7 增量评论 */
  app.get(`${v1}/issues/comments`, signed, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    return ctx.issues.commentsDelta(q.sinceId, q.limit)
  })

  /** C3 单条 */
  app.get<{ Params: { issueId: string } }>(`${v1}/issues/:issueId`, signed, async (req) => ctx.issues.get(req.params.issueId))

  /** C4 全字段覆盖 */
  app.put<{ Params: { issueId: string } }>(`${v1}/issues/:issueId`, signed, async (req) =>
    ctx.issues.overwrite(userOf(req), req.params.issueId, req.body ?? {}),
  )

  /** C5 遗弃 */
  app.delete<{ Params: { issueId: string } }>(`${v1}/issues/:issueId`, signed, async (req, reply) => {
    ctx.issues.abandon(req.params.issueId)
    return reply.code(204).send()
  })

  /** C6 状态批量（部分成功，HTTP 恒 200） */
  app.post(`${v1}/issues/status/batch`, signed, async (req) => {
    const items = assertArrayBody(req.body, 200, 'items')
    return ctx.issues.statusBatch(items)
  })

  /** C9 追加评论（幂等） */
  app.post<{ Params: { issueId: string } }>(`${v1}/issues/:issueId/comments`, signed, async (req, reply) => {
    const result = ctx.issues.addComment(userOf(req), req.params.issueId, req.body ?? {})
    return reply.code(result.created ? 201 : 200).send(result.comment)
  })

  /** C10 查评论 */
  app.get<{ Params: { issueId: string } }>(`${v1}/issues/:issueId/comments`, signed, async (req) =>
    ctx.issues.listComments(req.params.issueId),
  )

  /** C11 批量挂附件 */
  app.post(`${v1}/issues/attachments/batch`, signed, async (req) => {
    const items = assertArrayBody(req.body, 50, 'attachments')
    return ctx.issues.addAttachments(items)
  })

  /** C12 查附件 */
  app.get<{ Params: { issueId: string } }>(`${v1}/issues/:issueId/attachments`, signed, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    return ctx.issues.listAttachments(req.params.issueId, q.type)
  })

  /** C13 来源列表 */
  app.get(`${v1}/issue-sources`, signed, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    return ctx.issues.listSources(q.q)
  })

  /** C14 批量注册来源 */
  app.post(`${v1}/issue-sources/batch`, signed, async (req) => {
    const items = assertArrayBody(req.body, 100, 'sources')
    return ctx.issues.registerSources(items)
  })

  /** C15 改来源（administrator） */
  app.put<{ Params: { id: string } }>(`${v1}/issue-sources/:id`, { preHandler: authHook(ctx, 'administrator') }, async (req) => {
    const id = int(req.params.id, 'id', { required: true, min: 1 })
    if (id === undefined) throw errors.invalidRequest('id 必须是正整数')
    return ctx.issues.updateSource(id, req.body ?? {})
  })

  /** C16 删来源（administrator） */
  app.delete<{ Params: { id: string } }>(`${v1}/issue-sources/:id`, { preHandler: authHook(ctx, 'administrator') }, async (req, reply) => {
    const id = int(req.params.id, 'id', { required: true, min: 1 })
    if (id === undefined) throw errors.invalidRequest('id 必须是正整数')
    ctx.issues.deleteSource(id)
    return reply.code(204).send()
  })
}
