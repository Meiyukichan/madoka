/**
 * `/settings` and configuration routes: board settings, task templates, user-maintained
 * files, and portrait refresh. The file endpoints mirror disk contents exactly and do
 * not touch the task ledger, so they do not bump its revision.
 *
 * @module dsh-magica-castboard/host/http/routes/settings
 */
import type { Route } from '../router.ts'
import {
  ACCEPTANCE_STRATEGY_SCHEMA_VERSION,
  type AcceptanceStrategyResponse,
  type BoardSettings,
  type PortraitRefreshResponse,
  type SettingsResponse,
  type StrategyCustomResponse,
  type TaskTemplate,
  type TaskTemplateSpec,
  type TemplatesResponse,
  type WorkspacesCustomResponse,
} from '../../model.ts'
import {
  created,
  fail,
  objectBody,
  optionalString,
  requireString,
  unavailable,
  type RouteDeps,
} from './shared.ts'

function templateSpecOf(raw: unknown): TaskTemplateSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw fail('invalid_input', 'task 必须是模板规格对象', 400)
  }
  return raw as TaskTemplateSpec
}

function templatesResponse(templates: readonly TaskTemplate[]): TemplatesResponse {
  return { templates: [...templates] }
}

export function settingsRoutes(deps: RouteDeps): readonly Route[] {
  return [
    {
      method: 'GET',
      path: '/templates',
      handler: async (): Promise<TemplatesResponse> => templatesResponse(await deps.templates.list()),
    },
    {
      method: 'POST',
      path: '/templates',
      handler: async (context) => {
        const body = objectBody(context)
        const name = requireString(body, 'name', 60)
        const id = optionalString(body, 'id', 100)
        const task = templateSpecOf(body.task)
        const stored = await deps.templates.upsert({
          ...(id === undefined || id.trim() === '' ? {} : { id: id.trim() }),
          name,
          task,
        }).catch((error: unknown) => {
          throw fail('invalid_input', error instanceof Error ? error.message : String(error), 400)
        })
        return created(stored)
      },
    },
    {
      method: 'POST',
      path: '/templates/delete',
      handler: async (context) => {
        const body = objectBody(context)
        const id = requireString(body, 'id', 100).trim()
        const deleted = await deps.templates.remove(id)
        return { deleted }
      },
    },
    {
      method: 'GET',
      path: '/acceptance-strategy',
      handler: async (): Promise<AcceptanceStrategyResponse> => ({
        schemaVersion: ACCEPTANCE_STRATEGY_SCHEMA_VERSION,
        strategies: [...await deps.acceptanceStrategies.list()],
      }),
    },
    {
      method: 'POST',
      path: '/acceptance-strategy/update',
      handler: async (context): Promise<AcceptanceStrategyResponse> => {
        const body = objectBody(context)
        const strategies = await deps.acceptanceStrategies.replace(body.strategies)
        return { schemaVersion: ACCEPTANCE_STRATEGY_SCHEMA_VERSION, strategies: [...strategies] }
      },
    },
    {
      method: 'GET',
      path: '/workspaces-custom',
      handler: async (): Promise<WorkspacesCustomResponse> => await deps.customWorkspaces.read(),
    },
    {
      method: 'POST',
      path: '/workspaces-custom/update',
      handler: async (context): Promise<WorkspacesCustomResponse> => {
        const body = objectBody(context)
        return await deps.customWorkspaces.replace(body.workspaces)
      },
    },
    {
      method: 'GET',
      path: '/strategy-custom',
      handler: async (): Promise<StrategyCustomResponse> => await deps.customStrategies.read(),
    },
    {
      method: 'POST',
      path: '/strategy-custom/update',
      handler: async (context): Promise<StrategyCustomResponse> => {
        const body = objectBody(context)
        // The write body may name the list under either `strategies` or `items`.
        return await deps.customStrategies.replace(body.strategies ?? body.items)
      },
    },
    {
      method: 'POST',
      path: '/portrait/refresh',
      handler: async (): Promise<PortraitRefreshResponse> => {
        const face = deps.portrait
        if (face === undefined) throw unavailable('项目肖像服务未接入')
        return await face.refreshAll()
      },
    },
    {
      method: 'GET',
      path: '/settings',
      handler: async (): Promise<SettingsResponse> => await deps.settings.read(),
    },
    {
      method: 'POST',
      path: '/settings/update',
      handler: async (context): Promise<BoardSettings> => {
        const body = objectBody(context)
        return await deps.settings.write(body)
      },
    },
  ]
}
