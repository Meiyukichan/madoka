/**
 * 新 SDK 门面（`dsh-teamwork/1` 协议面 + castboard 兼容面）。
 *
 * 分层：
 *  - `result` / `types` / `wire`：信封、线格式类型、翻译与校验（纯函数）
 *  - `endpoints`：50 条协议端点表（唯一真源）
 *  - `net` / `log`：出站句柄与日志接缝（**都用发布包 `@meiyukichan/dsh-magica-spellbook`**）
 *  - `auth` / `auth-api`：长期凭据 + `/auth/token` 交换 headers + 账号端点
 *  - `transport`：一条请求管线
 *  - 原子分组：`project` / `device` / `file` / `issue/*` / `teamwork/*` / `ops` / `admin`
 *  - 组合层：`sdk.ts`（24 个语义方法 + E1）
 *  - 总入口：`client.ts`（`CastboardClient`）
 *
 * 文档：`docs/design/castboard-sdk-design.zh.md`
 */

import { CastboardClient, type CastboardClientOptions } from './client.js'

export * from './result.js'
export * from './types.js'
export * from './endpoints.js'
export * from './log.js'
export * from './wire.js'
export * from './env.js'
export * from './local-service.js'
export * from './net.js'
export * from './auth.js'
export * from './auth-api.js'
export * from './transport.js'
export * from './project.js'
export * from './device.js'
export * from './file.js'
export * from './issue/index.js'
export * from './teamwork/index.js'
export * from './ops.js'
export * from './admin.js'
export * from './sdk.js'
export * from './client.js'

/**
 * 唯一工厂：**同步、无 I/O**（最多读一次 env / `config.json`）。
 *
 * `baseUrl` 缺省按 `显式 > DSH_TEAMWORK_URL > DSH_TEAMWORK_HOST/PORT > <dataDir>/config.json > 127.0.0.1:3939`
 * 解析；地址不合法时不抛，所有方法统一返回 `invalid_host` 信封。
 */
export function createCastboardClient(options: CastboardClientOptions = {}): CastboardClient {
  return new CastboardClient(options)
}
