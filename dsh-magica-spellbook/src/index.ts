/**
 * dsh-magica-spellbook —— 面向 DSH 0.2.0-rc.2 的插件 SDK（host 侧唯一入口）。
 *
 * 四个一级模块：
 * - `core`：零依赖工具层（诊断日志 / 字段加解密 / HTTP 路由 / 内网出站 / 定价）；
 * - `sessions`：会话运行内核与两个门面；
 * - `interactions`：待决交互的线上契约与 host HTTP 面；
 * - `shared`：host 与 browser 共用的线上契约。
 *
 * 浏览器侧从 `dsh-magica-spellbook/client` 取。
 *
 * @module dsh-magica-spellbook
 */

// ── core：诊断日志 ──────────────────────────────────────────────
export { createEventLogger, sanitize } from './core/logger.ts'
export type { EventLogger, LogLevel } from './core/logger.ts'
export { dshHomePath, resolveDshHome, userHome } from './core/home.ts'

// ── core：字段加解密 ────────────────────────────────────────────
export { createFieldCrypto, masterKeyExists } from './core/crypto.ts'
export type { FieldCryptoHandle, FieldCryptoOptions } from './core/crypto.ts'

// ── core：进站 HTTP 路由 ────────────────────────────────────────
export {
  HttpRouteError,
  createJsonRouter,
  isLoopbackHost,
  isTrustedHost,
  isTrustedInbound,
  jsonRoute,
  queryOf,
  readJsonBody,
  sameOrigin,
  sendJson,
  sendMethodNotAllowed,
  sendResponse,
  sendText,
} from './core/router.ts'
export type {
  JsonRouteContext,
  JsonRouteOptions,
  JsonRouteResult,
  JsonRouterContext,
  JsonRouterMethod,
  JsonRouterOptions,
  JsonRouterRoute,
  JsonRouterTrust,
} from './core/router.ts'

// ── core：内网出站 ──────────────────────────────────────────────
export { createLimitedFetch, createProxyFetch } from './core/net.ts'
export type { ProxyFetchHandle, ProxyFetchInit, ProxyFetchOptions } from './core/net.ts'

// ── core：定价 ─────────────────────────────────────────────────
export {
  PRICE_TABLE_VERSION,
  loadPriceTable,
  priceForModel,
  stepBill,
  stepOutputBill,
} from './core/pricing.ts'
export type { PriceEntry, PriceTable } from './core/pricing.ts'

// ── 宿主契约（服务/事件清单；不是 npm 依赖）──────────────────────
export {
  CLIENT_SERVICES,
  HOST_EVENTS,
  HOST_SERVICES,
  describeHostRequirements,
  requiredHostServices,
} from './shared/host-contract.ts'
export type { HostServiceRequirement } from './shared/host-contract.ts'

// ── sessions / interactions ────────────────────────────────────
export * from './sessions/index.ts'
export * from './interactions/index.ts'
