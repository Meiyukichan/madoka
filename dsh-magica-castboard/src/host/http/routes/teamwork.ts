/**
 * Project-management + device routes: thin proxies over the shared-library SDK faces.
 *
 * The browser never sees a token; every operation stays in the host process.
 *
 * @module dsh-magica-castboard/host/http/routes/teamwork
 */
import type { Route } from '../router.ts'
import {
  fail,
  objectBody,
  optionalString,
  queryNumber,
  requireString,
  unavailable,
  type RouteDeps,
} from './shared.ts'

function projectsOf(deps: RouteDeps) {
  if (deps.projects === undefined) throw unavailable('当前宿主没有项目管理能力（SDK project 面缺失）')
  return deps.projects
}

function devicesOf(deps: RouteDeps) {
  if (deps.devices === undefined) throw unavailable('当前宿主没有设备能力（SDK device 面缺失）')
  return deps.devices
}

function projectId(context: { params: Record<string, string> }): number {
  const raw = context.params['id'] ?? ''
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw fail('invalid_input', `projectId 不合法：${raw}`, 400)
  return id
}

function idOrAccount(raw: string, label: string): string {
  const value = raw.trim()
  if (value === '') throw fail('invalid_input', `${label} 必填`, 400)
  return value
}

export function teamworkRoutes(deps: RouteDeps): readonly Route[] {
  return [
    {
      method: 'GET',
      path: '/projects',
      handler: async context => {
        const projects = projectsOf(deps)
        return await projects.list({
          pageNum: queryNumber(context, 'pageNum') ?? 1,
          pageSize: queryNumber(context, 'pageSize') ?? 20,
          ...(context.query.get('keyword') === null ? {} : { keyword: String(context.query.get('keyword')) }),
          includeArchived: context.query.get('includeArchived') === '1',
        })
      },
    },
    {
      method: 'GET',
      path: '/projects/mine',
      handler: async context => await projectsOf(deps).mine({
        includeArchived: context.query.get('includeArchived') === '1',
      }),
    },
    {
      method: 'POST',
      path: '/projects',
      handler: async context => {
        const body = objectBody(context)
        const name = requireString(body, 'name', 120)
        const visibility = optionalString(body, 'visibility', 20)
        const description = optionalString(body, 'description', 2000)
        const owner = optionalString(body, 'owner', 120)
        return await projectsOf(deps).create({
          name,
          ...(visibility === null ? {} : { visibility }),
          ...(description === null ? {} : { description }),
          ...(owner === null ? {} : { owner }),
        })
      },
    },
    {
      method: 'GET',
      path: '/projects/:id',
      handler: async context => await projectsOf(deps).detail(projectId(context)),
    },
    {
      method: 'PUT',
      path: '/projects/:id',
      handler: async context => {
        const body = objectBody(context)
        const name = optionalString(body, 'name', 120)
        const description = body['description']
        const visibility = optionalString(body, 'visibility', 20)
        const status = optionalString(body, 'status', 20)
        return await projectsOf(deps).update(projectId(context), {
          ...(name === null ? {} : { name }),
          ...(description === undefined ? {} : { description: description === null ? null : String(description) }),
          ...(visibility === null ? {} : { visibility }),
          ...(status === null ? {} : { status }),
        })
      },
    },
    {
      method: 'DELETE',
      path: '/projects/:id',
      handler: async context => {
        await projectsOf(deps).remove(projectId(context))
        return { ok: true }
      },
    },
    {
      method: 'GET',
      path: '/projects/:id/members',
      handler: async context => await projectsOf(deps).members(projectId(context)),
    },
    {
      method: 'GET',
      path: '/projects/:id/accounts',
      handler: async context => await projectsOf(deps).searchAccounts(
        projectId(context),
        String(context.query.get('q') ?? ''),
      ),
    },
    {
      method: 'POST',
      path: '/projects/:id/members',
      handler: async context => {
        const body = objectBody(context)
        const accountId = requireString(body, 'accountId', 120)
        const role = optionalString(body, 'role', 20)
        await projectsOf(deps).memberAdd(projectId(context), {
          accountId,
          ...(role === null ? {} : { role }),
        })
        return { ok: true }
      },
    },
    {
      method: 'DELETE',
      path: '/projects/:id/members/:accountId',
      handler: async context => {
        await projectsOf(deps).memberRemove(
          projectId(context),
          idOrAccount(context.params['accountId'] ?? '', 'accountId'),
        )
        return { ok: true }
      },
    },
    {
      method: 'PUT',
      path: '/projects/:id/owner',
      handler: async context => {
        const body = objectBody(context)
        await projectsOf(deps).transferOwner(projectId(context), requireString(body, 'accountId', 120))
        return { ok: true }
      },
    },
    {
      method: 'GET',
      path: '/devices/mine',
      handler: async context => await devicesOf(deps).mine({
        pageNum: queryNumber(context, 'pageNum') ?? 1,
        pageSize: queryNumber(context, 'pageSize') ?? 20,
      }),
    },
    {
      method: 'POST',
      path: '/devices',
      handler: async context => {
        const body = objectBody(context)
        const host = requireString(body, 'host', 200)
        const os = optionalString(body, 'os', 80)
        const portValue = body['port']
        const port = portValue === undefined || portValue === null || portValue === ''
          ? 0
          : Number(portValue)
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw fail('invalid_input', 'port 必须是 0..65535 的整数', 400)
        }
        await devicesOf(deps).create({ host, port, ...(os === null ? {} : { os }) })
        return { ok: true }
      },
    },
    {
      method: 'DELETE',
      path: '/devices/:id',
      handler: async context => {
        await devicesOf(deps).remove(idOrAccount(context.params['id'] ?? '', 'deviceId'))
        return { ok: true }
      },
    },
  ]
}
