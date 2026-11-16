/** B11–B16 设备与工作区路由 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import { authHook, userOf } from '../http/auth-hook.js'
import { assertNoUnknownFields, int } from '../http/strict.js'
import { normalizePage, normalizePageSize } from '../modules/account/service.js'
import { errors } from '../errors.js'

export function registerDeviceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const v1 = '/dsh-teamwork/v1'
  const signed = { preHandler: authHook(ctx, 'signed') }

  /** B11 全量同步 */
  app.post(`${v1}/devices/batch`, signed, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    assertNoUnknownFields(body, ['devices'])
    return ctx.devices.sync(userOf(req), body.devices)
  })

  /** B12 在线设备（只返 active） */
  app.get(`${v1}/devices`, signed, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    return ctx.devices.listActive(userOf(req), q.accountId)
  })

  /** B13 我的设备（分页，含 inactive） */
  app.get(`${v1}/devices/mine`, signed, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    return ctx.devices.mine(userOf(req), normalizePage(q.pageNum), normalizePageSize(q.pageSize))
  })

  /** B14 删设备 */
  app.delete<{ Params: { id: string } }>(`${v1}/devices/:id`, signed, async (req, reply) => {
    const id = int(req.params.id, 'id', { required: true, min: 1 })
    if (id === undefined) throw errors.invalidRequest('id 必须是正整数')
    ctx.devices.remove(userOf(req), id)
    return reply.code(204).send()
  })

  /** B15 工作区 upsert */
  app.post(`${v1}/device-workspaces`, signed, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    assertNoUnknownFields(body, ['instance', 'workspaceId', 'cwd', 'type', 'detail'])
    return ctx.devices.upsertWorkspace(userOf(req), body)
  })

  /** B16 条件查询 */
  app.get(`${v1}/device-workspaces`, signed, async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    return ctx.devices.listWorkspaces(userOf(req), q)
  })
}
