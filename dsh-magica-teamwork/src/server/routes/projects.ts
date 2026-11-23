/** B1–B10 项目与成员路由 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { authHook, userOf } from '../http/auth-hook.js'
import { assertNoUnknownFields, int } from '../http/strict.js'
import { errors } from '../errors.js'

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  const base = '/dsh-teamwork/v1/projects'
  const signed = { preHandler: authHook(ctx, 'signed') }

  app.get(base, signed, async (req) => ctx.projects.list(userOf(req), (req.query ?? {}) as Record<string, unknown>))

  app.get(`${base}/mine`, signed, async (req) => ctx.projects.mine(userOf(req), (req.query ?? {}) as Record<string, unknown>))

  app.get<{ Params: { id: string } }>(`${base}/:id/accounts`, signed, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    return ctx.projects.searchAccounts(userOf(req), parseId(req.params.id), typeof q.q === 'string' ? q.q : '')
  })

  app.get<{ Params: { id: string } }>(`${base}/:id`, signed, async (req) =>
    ctx.projects.detail(userOf(req), parseId(req.params.id)),
  )

  app.post(base, signed, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    assertNoUnknownFields(body, ['name', 'visibility', 'description'])
    const created = ctx.projects.create(userOf(req), body)
    return reply.code(201).send(created)
  })

  app.put<{ Params: { id: string } }>(`${base}/:id`, signed, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    assertNoUnknownFields(body, ['name', 'description', 'visibility', 'status'])
    return ctx.projects.update(userOf(req), parseId(req.params.id), body)
  })

  app.delete<{ Params: { id: string } }>(`${base}/:id`, signed, async (req, reply) => {
    ctx.projects.remove(userOf(req), parseId(req.params.id))
    return reply.code(204).send()
  })

  app.get<{ Params: { id: string } }>(`${base}/:id/members`, signed, async (req) =>
    ctx.projects.members(userOf(req), parseId(req.params.id)),
  )

  app.post<{ Params: { id: string } }>(`${base}/:id/members`, signed, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    assertNoUnknownFields(body, ['accountId', 'role'])
    return ctx.projects.addMember(userOf(req), parseId(req.params.id), body)
  })

  app.delete<{ Params: { id: string; accountId: string } }>(`${base}/:id/members/:accountId`, signed, async (req, reply) => {
    ctx.projects.removeMember(userOf(req), parseId(req.params.id), req.params.accountId)
    return reply.code(204).send()
  })

  app.put<{ Params: { id: string } }>(`${base}/:id/owner`, signed, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    assertNoUnknownFields(body, ['accountId'])
    return ctx.projects.transferOwner(userOf(req), parseId(req.params.id), body)
  })
}

function parseId(raw: string): number {
  const id = int(raw, 'id', { required: true, min: 1 })
  if (id === undefined) throw errors.invalidRequest('id 必须是正整数')
  return id
}
