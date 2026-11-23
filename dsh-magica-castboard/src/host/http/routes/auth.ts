/**
 * `/auth` routes: login state and login/logout over the shared library.
 *
 * The panel only needs three operations. Password handling stays entirely in the host:
 * the browser sends it once over the local HTTP channel, the SDK stores the derived
 * session credential, and no token is ever returned to the browser.
 *
 * @module dsh-magica-castboard/host/http/routes/auth
 */
import type { AuthSnapshot } from '../../pipeline/sdk-face.ts'
import type { Route } from '../router.ts'
import {
  fail,
  objectBody,
  optionalString,
  requireString,
  unavailable,
  type RouteDeps,
} from './shared.ts'

function requireAuth(deps: RouteDeps) {
  if (deps.auth === undefined) throw unavailable('当前宿主没有登录能力（SDK auth 面缺失）')
  return deps.auth
}

export function authRoutes(deps: RouteDeps): readonly Route[] {
  return [
    {
      method: 'GET',
      path: '/auth',
      handler: async (): Promise<AuthSnapshot> => {
        const auth = requireAuth(deps)
        await auth.refresh?.()
        return auth.status()
      },
    },
    {
      method: 'POST',
      path: '/auth/login',
      handler: async (context): Promise<AuthSnapshot> => {
        const auth = requireAuth(deps)
        const body = objectBody(context)
        const accountId = requireString(body, 'accountId', 120)
        const password = requireString(body, 'password', 200)
        try {
          return await auth.login({ accountId, password })
        } catch (error) {
          throw fail('invalid_input', error instanceof Error ? error.message : String(error), 401)
        }
      },
    },
    {
      method: 'POST',
      path: '/auth/register',
      handler: async (context): Promise<AuthSnapshot> => {
        const auth = requireAuth(deps)
        if (auth.register === undefined) throw unavailable('当前共享库没有注册能力（SDK auth.register 缺失）')
        const body = objectBody(context)
        const accountId = requireString(body, 'accountId', 120)
        const password = requireString(body, 'password', 200)
        const displayName = optionalString(body, 'displayName', 120)
        try {
          return await auth.register({
            accountId,
            password,
            ...(displayName === null ? {} : { displayName }),
          })
        } catch (error) {
          throw fail('invalid_input', error instanceof Error ? error.message : String(error), 400)
        }
      },
    },
    {
      method: 'POST',
      path: '/auth/logout',
      handler: async (): Promise<AuthSnapshot> => {
        const auth = requireAuth(deps)
        try {
          return await auth.logout()
        } catch (error) {
          throw fail('invalid_input', error instanceof Error ? error.message : String(error), 400)
        }
      },
    },
  ]
}
