/** 包入口（SDK）：纯库，无 apply/inject/dsh.bundle */
export { CredentialStore, CredentialError, defaultHome } from './sdk/credentials.js'

// ── 新 SDK（`dsh-teamwork/1` 协议面 + castboard 兼容面，24 组合方法 + E1）────
export * from './sdk/index.js'

// ── 服务端（可编程启动；同时也是 bin 的入口）────────────────────
export { startServer, main } from './server/main.js'
export type { StartServerOptions } from './server/main.js'
export { buildApp } from './server/app.js'
export { createContext, ENDPOINTS, SERVICE_VERSION } from './server/context.js'
export type { AppContext } from './server/context.js'
export { openDatabase } from './server/db/database.js'
export type { DatabaseHandle } from './server/db/database.js'
export { migrate, loadMigrations, currentVersion } from './server/db/migrate.js'
export { resolveConfig, HELP } from './server/config.js'
export type { Config } from './server/config.js'
export { BusinessError, errors } from './server/errors.js'
