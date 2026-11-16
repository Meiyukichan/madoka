/**
 * 环境与实例发现：**取值链统一为「显式参数 > 环境变量 > config.json > 默认值」**。
 *
 * 两个文件契约（都不是本包写的，是本包"读别人的"）：
 *  - `$DSH_TEAMWORK_DATA ?? ($DSH_TEAMWORK_HOME ?? ~/.dsh/storages/teamwork)/server/config.json`
 *    —— 与 `src/server/config.ts` 同源；服务端改端口后，本机 SDK 自动跟着连。
 *  - `~/.dsh/storages/webide/.local.device.json` + `{ host, port }`
 *    —— 由 dsh-webide 写；**只认 `os.homedir()`**（它不读 `DSH_HOME`，这边认了反而找不到）。
 *
 * 缓存策略：身份文件用 `path + mtimeMs` 双键失效；同一份坏文件只 parse 一次
 * （这是热路径上的 🟡 情形，正确处置是缓存而不是机械改 async）。
 *
 * 文档：`docs/design/lattice-sdk-design.zh.md` §4 / §12
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'

/** 协议前缀（服务端写死；可由构造参数覆盖） */
export const DEFAULT_PREFIX = '/dsh-teamwork/v1'
/** 服务端默认端口（`src/server/config.ts` 的 DEFAULTS.port） */
export const DEFAULT_SERVER_PORT = 3939
/** 服务端默认 host */
export const DEFAULT_SERVER_HOST = '127.0.0.1'

export interface LatticeDeviceIdentity {
  ip: string
  port?: number
  source: 'identity-file' | 'local-ip'
}

interface DeviceIdentityFile {
  host?: string
  port?: number
  ip?: string
}

// ────────────────────────────────────────────────────────────────────────────
// 目录与配置
// ────────────────────────────────────────────────────────────────────────────

/** `$DSH_TEAMWORK_HOME`（凭据目录；默认 `~/.dsh/storages/teamwork`） */
export function teamworkHome(): string {
  return process.env['DSH_TEAMWORK_HOME'] ?? join(homedir(), '.dsh', 'storages', 'teamwork')
}

/** 服务端数据目录（`DSH_TEAMWORK_DATA` 优先，与 `src/server/config.ts` 一致） */
export function teamworkDataDir(): string {
  return process.env['DSH_TEAMWORK_DATA'] ?? join(teamworkHome(), 'server')
}

/** 剥掉 `//` 与 `/* *\/` 注释再 JSON.parse（配置文件允许注释；与服务端同算法） */
function parseJsonc(text: string): unknown {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const noLine = noBlock
    .split(/\r?\n/)
    .map((line) => {
      let inStr = false
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (c === '"' && line[i - 1] !== '\\') inStr = !inStr
        if (!inStr && c === '/' && line[i + 1] === '/') return line.slice(0, i)
      }
      return line
    })
    .join('\n')
  return JSON.parse(noLine)
}

interface ConfigCacheEntry {
  path: string
  mtimeMs: number
  value: { host: string | null; port: number | null }
}

let configCache: ConfigCacheEntry | null = null

/** 读 `<dataDir>/config.json` 的 `host` / `port`（失败一律当"没有"，不抛） */
export function readServerConfig(): { host: string | null; port: number | null } {
  const path = resolve(join(teamworkDataDir(), 'config.json'))
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    configCache = null
    return { host: null, port: null }
  }
  if (configCache !== null && configCache.path === path && configCache.mtimeMs === mtimeMs) {
    return configCache.value
  }
  let value: { host: string | null; port: number | null } = { host: null, port: null }
  try {
    const parsed = parseJsonc(readFileSync(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const raw = parsed as Record<string, unknown>
      const host = typeof raw['host'] === 'string' && raw['host'].trim() !== '' ? raw['host'].trim() : null
      const portNumber = typeof raw['port'] === 'number' ? raw['port'] : Number(raw['port'])
      const port = Number.isInteger(portNumber) && portNumber >= 0 && portNumber <= 65535 ? portNumber : null
      value = { host, port }
    }
  } catch {
    /* 坏文件当"没有"；同一份坏文件由 mtime 缓存兜住，不会反复 parse */
  }
  configCache = { path, mtimeMs, value }
  return value
}

/** 配置里有没有人显式设过 host / port（决定要不要沿用默认端口） */
function portFromConfig(): number | null {
  return readServerConfig().port
}

function hostFromConfig(): string | null {
  return readServerConfig().host
}

// ────────────────────────────────────────────────────────────────────────────
// baseUrl
// ────────────────────────────────────────────────────────────────────────────

export interface BaseUrlOptions {
  baseUrl?: string
  host?: string
  port?: number
  prefix?: string
}

export type BaseUrlResolution =
  | { ok: true; value: string }
  | { ok: false; reason: string; value: string }

function envFirst(keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = process.env[key]
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  return null
}

function withProtocol(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
}

/** 补齐前缀与默认端口，并校验前缀（前缀是契约的一部分，不猜） */
export function normalizeBaseUrl(raw: string, prefix: string = DEFAULT_PREFIX): BaseUrlResolution {
  const trimmed = raw.trim().replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(withProtocol(trimmed))
  } catch {
    return { ok: false, reason: `baseUrl 不是合法 URL：${raw}`, value: raw }
  }
  const normalizedPrefix = `/${prefix.replace(/^\/+/, '').replace(/\/+$/, '')}`
  const path = url.pathname.replace(/\/+$/, '')
  if (path === '' || path === '/') {
    url.pathname = normalizedPrefix
  } else if (path === normalizedPrefix) {
    url.pathname = normalizedPrefix
  } else {
    return {
      ok: false,
      reason: `baseUrl 不能带业务路径（前缀只认 ${normalizedPrefix}）：${raw}。需要换前缀请用 options.prefix`,
      value: raw,
    }
  }
  if (url.port === '' && url.protocol === 'http:') url.port = String(DEFAULT_SERVER_PORT)
  return { ok: true, value: `${url.origin}${url.pathname}` }
}

/**
 * 解析 baseUrl（含 `/dsh-teamwork/v1` 前缀）。
 *
 * 优先级：`baseUrl` > `host`+`port` > `DSH_TEAMWORK_URL` > `DSH_TEAMWORK_HOST`/`_PORT` >
 *         `<dataDir>/config.json` > `127.0.0.1:3939`
 */
export function teamworkBaseUrl(options: BaseUrlOptions = {}): BaseUrlResolution {
  const prefix = options.prefix ?? DEFAULT_PREFIX
  if (options.baseUrl !== undefined && options.baseUrl.trim() !== '') {
    return normalizeBaseUrl(options.baseUrl, prefix)
  }
  if (options.host !== undefined && options.host.trim() !== '') {
    const port = options.port ?? portFromConfig() ?? DEFAULT_SERVER_PORT
    return normalizeBaseUrl(`${options.host.trim()}:${port}`, prefix)
  }
  const envUrl = envFirst(['DSH_TEAMWORK_URL'])
  if (envUrl !== null) return normalizeBaseUrl(envUrl, prefix)

  const envHost = envFirst(['DSH_TEAMWORK_HOST'])
  const envPort = envFirst(['DSH_TEAMWORK_PORT'])
  if (envHost !== null || envPort !== null) {
    const host = envHost ?? hostFromConfig() ?? DEFAULT_SERVER_HOST
    const parsedPort = envPort === null ? Number.NaN : Number(envPort)
    const port = Number.isInteger(parsedPort) ? parsedPort : portFromConfig() ?? DEFAULT_SERVER_PORT
    return normalizeBaseUrl(`${host}:${port}`, prefix)
  }

  const configHost = hostFromConfig()
  const configPort = portFromConfig()
  if (configHost !== null || configPort !== null) {
    return normalizeBaseUrl(`${configHost ?? DEFAULT_SERVER_HOST}:${configPort ?? DEFAULT_SERVER_PORT}`, prefix)
  }
  return normalizeBaseUrl(`${DEFAULT_SERVER_HOST}:${DEFAULT_SERVER_PORT}`, prefix)
}

// ────────────────────────────────────────────────────────────────────────────
// 本机身份 / 实例
// ────────────────────────────────────────────────────────────────────────────

/** 身份文件路径（`DSH_TEAMWORK_DEVICE_FILE` > `~/.dsh/storages/webide/.local.device.json`） */
export function teamworkDeviceFile(): string {
  const override = process.env['DSH_TEAMWORK_DEVICE_FILE']
  if (override !== undefined && override.trim() !== '') return resolve(override.trim())
  return join(homedir(), '.dsh', 'storages', 'webide', '.local.device.json')
}

const HOST_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/
const PORT_PATTERN = /^\d{1,5}$/

interface IdentityCacheEntry {
  path: string
  mtimeMs: number
  value: LatticeDeviceIdentity | null
}

let identityCache: IdentityCacheEntry | null = null

function readDeviceIdentityFile(): DeviceIdentityFile | null {
  const path = teamworkDeviceFile()
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    identityCache = null
    return null
  }
  if (identityCache !== null && identityCache.path === path && identityCache.mtimeMs === mtimeMs) {
    const cached = identityCache.value
    if (cached === null) return null
    return { host: cached.ip, ...(cached.port === undefined ? {} : { port: cached.port }) }
  }

  let identity: LatticeDeviceIdentity | null = null
  try {
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text) as Record<string, unknown>
    const hostRaw = typeof parsed['host'] === 'string' ? parsed['host'].trim() : ''
    const ipRaw = typeof parsed['ip'] === 'string' ? parsed['ip'].trim() : ''
    const host = HOST_PATTERN.test(hostRaw) ? hostRaw : HOST_PATTERN.test(ipRaw) ? ipRaw : ''
    if (host !== '') {
      const portRaw = parsed['port']
      const portText = typeof portRaw === 'number' ? String(portRaw) : typeof portRaw === 'string' ? portRaw.trim() : ''
      const port = PORT_PATTERN.test(portText) ? Number(portText) : undefined
      identity = { ip: host, source: 'identity-file', ...(port === undefined ? {} : { port }) }
    }
  } catch {
    /* 坏 JSON / 形状不合规 → 记住 null，同一份坏文件不重复 parse */
    identity = null
  }
  identityCache = { path, mtimeMs, value: identity }
  if (identity === null) return null
  return { host: identity.ip, ...(identity.port === undefined ? {} : { port: identity.port }) }
}

let localIpCache: string | null = null

/** 本机第一个非内网 IPv4；拿不到回落 `127.0.0.1`（进程内缓存） */
export function getLocalIp(): string {
  if (localIpCache !== null) return localIpCache
  const interfaces = networkInterfaces()
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (name === 'lo') continue
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      if (addr.address.startsWith('169.254.')) continue
      localIpCache = addr.address
      return localIpCache
    }
  }
  localIpCache = DEFAULT_SERVER_HOST
  return localIpCache
}

/** 端口回退链：`DSH_TEAMWORK_PORT` > `DSH_PORT` > `PORT` > 身份文件 */
export function teamworkPort(): number | undefined {
  for (const key of ['DSH_TEAMWORK_PORT', 'DSH_PORT', 'PORT']) {
    const value = process.env[key]
    if (value === undefined || value.trim() === '') continue
    const n = Number(value.trim())
    if (Number.isInteger(n) && n >= 0 && n <= 65535) return n
  }
  return readDeviceIdentityFile()?.port
}

/** 本机对外身份：`LATTICE_*`-style 环境变量 > 身份文件 > 本机网卡 */
export function teamworkDeviceIdentity(): LatticeDeviceIdentity {
  const overrides = (): LatticeDeviceIdentity | null => {
    const ip = envFirst(['DSH_TEAMWORK_IP', 'LATTICE_IP'])
    const portText = envFirst(['DSH_TEAMWORK_PORT', 'LATTICE_PORT'])
    const port = portText === null ? undefined : Number(portText)
    if (ip === null && port === undefined) return null
    return {
      ip: ip ?? getLocalIp(),
      source: 'local-ip',
      ...(port === undefined || !Number.isInteger(port) ? {} : { port }),
    }
  }
  const override = overrides()
  if (override !== null) return override

  const fromFile = readDeviceIdentityFile()
  if (fromFile !== null && typeof fromFile.host === 'string') {
    const port = teamworkPort()
    return { ip: fromFile.host, source: 'identity-file', ...(port === undefined ? {} : { port }) }
  }
  const port = teamworkPort()
  return { ip: getLocalIp(), source: 'local-ip', ...(port === undefined ? {} : { port }) }
}

export function teamworkIp(): string {
  return teamworkDeviceIdentity().ip
}

/** 实例标识：`DSH_TEAMWORK_INSTANCE` > `ip:port` > `ip` */
export function teamworkInstanceName(): string {
  const explicit = envFirst(['DSH_TEAMWORK_INSTANCE', 'LATTICE_INSTANCE'])
  if (explicit !== null) return explicit
  const { ip, port } = teamworkDeviceIdentity()
  return port === undefined ? ip : `${ip}:${port}`
}

/** `device.sync()` 的默认上报值 */
export function teamworkDefaultDevice(): { host: string; os: string; port?: number } {
  const { ip, port } = teamworkDeviceIdentity()
  return { host: ip, os: process.platform, ...(port === undefined ? {} : { port }) }
}

/** 本机账号兜底（正常情况下身份来自会话，这里只给组合层用） */
export function teamworkUserId(): string | undefined {
  const explicit = envFirst(['DSH_TEAMWORK_USER_ID'])
  return explicit ?? undefined
}

/** 重置进程内缓存（测试用） */
export function resetEnvCache(): void {
  configCache = null
  identityCache = null
  localIpCache = null
}

// ────────────────────────────────────────────────────────────────────────────
// 旧 lattice 名字的别名（保证 raw 文档里的调用能编译；新代码用 teamwork*）
// ────────────────────────────────────────────────────────────────────────────

/** @deprecated 用 `teamworkBaseUrl()` */
export function latticeBaseUrl(): string {
  const resolved = teamworkBaseUrl()
  return resolved.ok ? resolved.value : ''
}

/** @deprecated 用 `teamworkDeviceFile()` */
export const latticeDeviceFile = teamworkDeviceFile
/** @deprecated 用 `teamworkDeviceIdentity()` */
export const latticeDeviceIdentity = teamworkDeviceIdentity
/** @deprecated 用 `teamworkIp()` */
export const latticeIp = teamworkIp
/** @deprecated 用 `teamworkInstanceName()` */
export const latticeInstanceName = teamworkInstanceName
/** @deprecated 用 `teamworkUserId()` */
export const latticeUserId = teamworkUserId
/** @deprecated 用 `teamworkDefaultDevice()` */
export const latticeDefaultDevice = teamworkDefaultDevice

/** 判断某个路径是否存在（`resolve` 过的绝对路径；测试与诊断用） */
export function existsResolved(path: string): boolean {
  return existsSync(resolve(path))
}
