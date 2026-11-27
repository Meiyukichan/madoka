/** 测试公共设施：起服务、造客户端、直连 HTTP（绕过 SDK 验证服务端契约） */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { startServer } from '../src/server/main.js'
import { TeamworkClient } from './support/legacy-client.js'

export const PASSWORD = 'correct horse battery'
export const PASSWORD2 = 'another good passphrase'

/** 已登录的客户端：accountToken 一定存在，省掉测试里的非空断言 */
export type AuthedClient = TeamworkClient & { readonly accountToken: string; readonly accountId: string }

export interface Harness {
  host: string
  base: string
  dir: string
  root: TeamworkClient
  /** 造一个全新客户端（独立凭据，persist:false） */
  client: () => TeamworkClient
  /** 注册一个新账号并返回客户端 */
  register: (accountId: string, password?: string) => Promise<AuthedClient>
  /** 裸 HTTP：返回 { status, body, headers } */
  raw: (
    method: string,
    path: string,
    init?: { body?: unknown; token?: string; account?: string; headers?: Record<string, string>; rawBody?: string; contentType?: string },
  ) => Promise<{ status: number; body: unknown; text: string; headers: Headers }>
  close: () => Promise<void>
}

export async function bootHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'tw-test-'))
  const server = await startServer({ dataDir: dir, port: 0, log: () => {}, rateLimit: false })
  const host = `http://127.0.0.1:${server.port}`
  const base = `${host}/dsh-teamwork/v1`

  const harness: Harness = {
    host,
    base,
    dir,
    root: new TeamworkClient({ host, persist: false }),
    client: () => new TeamworkClient({ host, persist: false }),
    register: async (accountId: string, password = PASSWORD) => {
      const c = new TeamworkClient({ host, persist: false })
      await c.register({ accountId, password })
      return c as unknown as AuthedClient
    },
    raw: async (method, path, init = {}) => {
      const headers: Record<string, string> = { ...(init.headers ?? {}) }
      if (init.token) headers['dsh-teamwork-token'] = init.token
      if (init.account) headers['dsh-teamwork-account'] = init.account
      let body: string | undefined
      if (init.rawBody !== undefined) {
        body = init.rawBody
        headers['content-type'] = init.contentType ?? 'application/octet-stream'
      } else if (init.body !== undefined) {
        body = JSON.stringify(init.body)
        headers['content-type'] = 'application/json'
      }
      const res = await fetch(base + path, { method, headers, body })
      const text = await res.text()
      let parsed: unknown = undefined
      try {
        parsed = text ? JSON.parse(text) : undefined
      } catch {
        parsed = text
      }
      return { status: res.status, body: parsed, text, headers: res.headers }
    },
    close: async () => {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return harness
}

/**
 * 断言业务错误码。
 * 命中返回 true（给 `assert.rejects` 用）；不命中时抛错并带上**实际码**，方便定位。
 */
export function isCode(code: string) {
  return (err: unknown): boolean => {
    const actual = (err as { code?: string }).code
    if (actual !== code) {
      throw new Error(`期望错误码 ${code}，实际 ${actual ?? '(无)'}：${(err as Error).message}`)
    }
    return true
  }
}

/** 用 accountToken 现场签一个 JWT（用于直连 HTTP 测试） */
export function signToken(accountToken: string, accountId: string, overrides: { exp?: number; iat?: number } = {}): string {
  const now = Date.now()
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ a: accountId, iat: overrides.iat ?? now, exp: overrides.exp ?? now + 60_000 }),
  ).toString('base64url')
  const sig = createHmac('sha256', accountToken).update(`${head}.${payload}`).digest('base64url')
  return `${head}.${payload}.${sig}`
}
