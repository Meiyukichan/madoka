/**
 * 真机测试的共用脚手架：起一个真服务端 + 造 N 个已登录 client。
 *
 * 与 `helpers.ts`（旧 CastboardClient 专用）分开：这里只依赖**新 SDK**。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startServer } from '../src/server/main.js'
import { createCastboardClient, type CastboardClient } from '../src/sdk/index.js'

export const PASSWORD = 'correct horse battery'

/** 起服务 + 返回基址 */
export async function bootServer(): Promise<{
  server: Awaited<ReturnType<typeof startServer>>
  baseUrl: string
  cleanup: () => Promise<void>
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-teamwork-sdk-'))
  const server = await startServer({ dataDir, port: 0, log: () => {}, rateLimit: false })
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.port}/dsh-teamwork/v1`,
    cleanup: async () => {
      await server.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** 造一个持久化 client（每个 client 独立临时凭据目录，避免互相覆盖） */
export function makeClient(baseUrl: string, extra: Parameters<typeof createCastboardClient>[0] = {}): CastboardClient {
  return createCastboardClient({
    baseUrl,
    home: mkdtempSync(join(tmpdir(), 'dsh-teamwork-sdk-client-')),
    ...extra,
  })
}

/** 注册并返回已登录 client（首个账号自动 administrator） */
export async function registeredClient(baseUrl: string, accountId: string): Promise<CastboardClient> {
  const client = makeClient(baseUrl)
  const registered = await client.auth.register({ accountId, password: PASSWORD, displayName: accountId })
  if (!registered.ok) throw new Error(`注册失败：${registered.code}: ${registered.reason}`)
  return client
}
