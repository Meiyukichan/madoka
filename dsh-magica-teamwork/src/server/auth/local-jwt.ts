/** 样例服务的本地 JWT 鉴权：保持旧的 HS256 双头协议，但藏在 AuthProvider 后面。 */
import type { DatabaseSync } from 'node:sqlite'
import { errors } from '../errors.js'
import { signJwt } from '../crypto/jwt.js'
import { DUMMY_TOKEN, timingSafeHexEqual } from '../crypto/password.js'
import { AccountMapper } from '../modules/account/mapper.js'
import type { AuthCache } from './cache.js'
import {
  ACCOUNT_HEADER,
  TOKEN_HEADER,
  authenticateHeaders,
  type CurrentUser,
} from './guard.js'
import type { AuthGrant, AuthProvider, AuthTokenInput, RequestHeaders } from './provider.js'

export interface LocalJwtAuthOptions {
  db: DatabaseSync
  ttlSeconds: number
  authCache?: AuthCache | undefined
}

export class LocalJwtAuthProvider implements AuthProvider {
  constructor(private readonly options: LocalJwtAuthOptions) {}

  issue(input: AuthTokenInput): AuthGrant {
    const row = new AccountMapper(this.options.db).findByAccountId(input.accountId)
    if (!row) {
      // Keep the same expensive compare for unknown accounts to avoid a timing oracle.
      timingSafeHexEqual(input.accountToken, DUMMY_TOKEN)
      throw errors.invalidCredentials()
    }
    if (!timingSafeHexEqual(row.accountToken, input.accountToken)) {
      throw errors.invalidCredentials()
    }
    if (row.status !== 'active') throw errors.accountDisabled()

    const now = Date.now()
    const exp = now + this.options.ttlSeconds * 1000
    const token = signJwt({ a: row.accountId, iat: now, exp }, row.accountToken)
    return {
      accountId: row.accountId,
      headers: {
        [TOKEN_HEADER]: token,
        [ACCOUNT_HEADER]: row.accountId,
      },
      expiresAt: exp,
      displayName: row.displayName,
      globalRole: row.globalRole,
    }
  }

  authenticate(input: { headers: RequestHeaders }): CurrentUser {
    return authenticateHeaders(input.headers, {
      db: this.options.db,
      ttlSeconds: this.options.ttlSeconds,
      authCache: this.options.authCache,
    }).user
  }

  logout(input: { headers: RequestHeaders }): void {
    const token = pick(input.headers[TOKEN_HEADER])
    if (token !== undefined && token !== '') this.options.authCache?.invalidateToken(token)
  }
}

function pick(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
