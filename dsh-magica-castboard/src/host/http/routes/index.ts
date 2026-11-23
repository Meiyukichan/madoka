/**
 * Assembles the full route table. Matching is linear, so order is a contract: literal
 * paths must be tried before parameterized ones (`/issues/:id` would otherwise swallow
 * `/issues/dispatched`). A stable sort by parameter-segment count keeps that property
 * while preserving each group's declaration order.
 *
 * @module dsh-magica-castboard/host/http/routes
 */
import type { Route } from '../router.ts'
import { authRoutes } from './auth.ts'
import { issuesRoutes, type IssueRouteCapabilities } from './issues.ts'
import { magicaRoutes } from './magica.ts'
import { settingsRoutes } from './settings.ts'
import { stateRoutes } from './state.ts'
import { tasksRoutes } from './tasks.ts'
import { teamworkRoutes } from './teamwork.ts'
import type { RouteDeps } from './shared.ts'

export * from './shared.ts'

export type RouteAssembly = RouteDeps & IssueRouteCapabilities

function paramSegments(path: string): number {
  let count = 0
  for (const segment of path.split('/')) {
    if (segment.startsWith(':')) count += 1
  }
  return count
}

function literalFirst(routes: readonly Route[]): readonly Route[] {
  return routes
    .map((route, order) => ({ route, order }))
    .sort((left, right) => paramSegments(left.route.path) - paramSegments(right.route.path)
      || left.order - right.order)
    .map(entry => entry.route)
}

/**
 * Passes `deps` to every group unchanged, so optional issue capabilities
 * (`workspaces`, `issueState`, `issueBrief`, `createRemote`, `abandonRemote`,
 * `taskExists`) reach the routes that need them; endpoints degrade when one is absent.
 */
export function createRoutes(deps: RouteAssembly): readonly Route[] {
  return literalFirst([
    ...stateRoutes(deps),
    ...authRoutes(deps),
    ...tasksRoutes(deps),
    ...issuesRoutes(deps),
    ...teamworkRoutes(deps),
    ...settingsRoutes(deps),
    ...magicaRoutes(deps),
  ])
}
