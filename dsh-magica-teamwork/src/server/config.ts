/**
 * 配置解析：CLI flag > 环境变量 > config.json > 默认值。
 *
 * 用户态最简单：什么都不配，起在 127.0.0.1:3939，数据落在
 * `~/.dsh/storages/teamwork/`（自动创建）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isLoopbackHost } from './net.js'
import { join, resolve } from 'node:path'
import { formatDomain, parseDomain } from '../shared/domain.js'

export interface Config {
  host: string
  port: number
  dataDir: string
  /** 数据库文件（= dataDir/teamwork.db） */
  dbPath: string
  tokenTtlSeconds: number
  maxUploadBytes: number
  shutdownGraceMs: number
  startTimeoutMs: number
  /** 对外地址：本机 `127.0.0.1:3939`，线上 `xxx.com`（不带端口）。 */
  domain: string
  registration: 'open' | 'closed'
  privateMemberLimit: number
  authCacheTtlMs: number
  /** 关闭后不再限流（仅本地压测/自动化用） */
  rateLimit: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  logFile: string | null
  /** 内部：本次启动的原始来源，便于 /version 与日志展示 */
  source: { file: string | null; fromEnv: string[]; fromCli: string[] }
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3939,
  tokenTtlDays: 3,
  maxUploadMb: 64,
  shutdownGraceMs: 5_000,
  startTimeoutMs: 10_000,
  registration: 'open' as const,
  privateMemberLimit: 5,
  authCacheTtlMs: 60_000,
  rateLimit: true,
  logLevel: 'info' as const,
}

export function defaultHome(): string {
  return process.env.DSH_TEAMWORK_HOME ?? process.env.DSH_TEAMWORK_DATA ?? join(homedir(), '.dsh', 'storages', 'teamwork')
}

export function defaultDataDir(): string {
  return process.env.DSH_TEAMWORK_DATA ?? defaultHome()
}

interface RawConfig {
  host?: string
  port?: number
  dataDir?: string
  tokenTtlDays?: number
  maxUploadMb?: number
  shutdownGraceMs?: number
  startTimeoutMs?: number
  domain?: string
  registration?: string
  privateMemberLimit?: number
  authCacheTtlMs?: number
  rateLimit?: boolean | string
  logLevel?: string
  logFile?: string | null
  localServiceRestart?: boolean
}

const ENV_MAP: Record<string, keyof RawConfig> = {
  DSH_TEAMWORK_HOST: 'host',
  DSH_TEAMWORK_PORT: 'port',
  DSH_TEAMWORK_DATA: 'dataDir',
  DSH_TEAMWORK_TOKEN_TTL_DAYS: 'tokenTtlDays',
  DSH_TEAMWORK_MAX_UPLOAD_MB: 'maxUploadMb',
  DSH_TEAMWORK_SHUTDOWN_GRACE_MS: 'shutdownGraceMs',
  DSH_TEAMWORK_START_TIMEOUT_MS: 'startTimeoutMs',
  DSH_TEAMWORK_DOMAIN: 'domain',
  DSH_TEAMWORK_REGISTRATION: 'registration',
  DSH_TEAMWORK_PRIVATE_MEMBER_LIMIT: 'privateMemberLimit',
  DSH_TEAMWORK_AUTH_CACHE_TTL_MS: 'authCacheTtlMs',
  DSH_TEAMWORK_RATE_LIMIT: 'rateLimit',
  DSH_TEAMWORK_LOG_LEVEL: 'logLevel',
  DSH_TEAMWORK_LOG_FILE: 'logFile',
}

const FLAG_MAP: Record<string, keyof RawConfig> = {
  '--host': 'host',
  '--port': 'port',
  '--data-dir': 'dataDir',
  '--token-ttl-days': 'tokenTtlDays',
  '--max-upload-mb': 'maxUploadMb',
  '--shutdown-grace': 'shutdownGraceMs',
  '--start-timeout': 'startTimeoutMs',
  '--domain': 'domain',
  '--registration': 'registration',
  '--private-member-limit': 'privateMemberLimit',
  '--auth-cache-ttl': 'authCacheTtlMs',
  '--rate-limit': 'rateLimit',
  '--log-level': 'logLevel',
  '--log-file': 'logFile',
}

/** 剥离 `//` 与 `/* *​/` 注释后再 JSON.parse（配置文件允许注释） */
function parseJsonc(text: string): unknown {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const noLine = noBlock
    .split(/\r?\n/)
    .map((line) => {
      // 只剥「不在字符串里」的行注释：足够应付配置文件，不追求完整 JSONC
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

const KNOWN_KEYS = new Set([
  'host', 'port', 'dataDir', 'tokenTtlDays', 'maxUploadMb', 'shutdownGraceMs', 'startTimeoutMs',
  'domain', 'registration', 'privateMemberLimit', 'authCacheTtlMs', 'rateLimit', 'logLevel', 'logFile',
  'localServiceRestart',
])

export interface ResolveArgs {
  argv?: string[]
  env?: NodeJS.ProcessEnv
}

export interface ResolveResult {
  config: Config
  /** `--help` / `--version` 之类的短路动作 */
  action?: 'help' | 'version'
}

export function resolveConfig(args: ResolveArgs = {}): ResolveResult {
  const argv = args.argv ?? process.argv.slice(2)
  const env = args.env ?? process.env

  const raw: RawConfig = {}
  const source: Config['source'] = { file: null, fromEnv: [], fromCli: [] }

  // ① 发现 --help / --version / --config
  let configPath: string | null = env.DSH_TEAMWORK_CONFIG ?? null
  let action: 'help' | 'version' | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--help' || a === '-h') action = 'help'
    if (a === '--version' || a === '-v') action = 'version'
    if (a === '--config') configPath = argv[++i] ?? null
  }
  if (action) return { config: buildConfig({}, source), action }

  // ② 配置文件（默认 dataDir 下的 config.json；dataDir 本身可能来自 env/cli，故先探一遍）
  const probeDataDir = pickDataDir(argv, env)
  const file = configPath ?? join(probeDataDir, 'config.json')
  if (existsSync(file)) {
    let parsed: unknown
    try {
      parsed = parseJsonc(readFileSync(file, 'utf8'))
    } catch (err) {
      throw new Error(`配置文件解析失败：${file}（${(err as Error).message}）`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`配置文件必须是 JSON 对象：${file}`)
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!KNOWN_KEYS.has(k)) throw new Error(`配置文件里有未知键 "${k}"（${file}）`)
      ;(raw as Record<string, unknown>)[k] = v
    }
    source.file = file
  }

  // ③ 环境变量
  for (const [name, key] of Object.entries(ENV_MAP)) {
    const v = env[name]
    if (v === undefined || v === '') continue
    ;(raw as Record<string, unknown>)[key] = v
    source.fromEnv.push(key)
  }

  // ④ CLI
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const key = FLAG_MAP[a]
    if (!key) continue
    const v = argv[++i]
    if (v === undefined) throw new Error(`${a} 缺少值`)
    ;(raw as Record<string, unknown>)[key] = v
    source.fromCli.push(key)
  }

  return { config: buildConfig(raw, source) }
}

function pickDataDir(argv: string[], env: NodeJS.ProcessEnv): string {
  let dir = env.DSH_TEAMWORK_DATA ?? defaultDataDir()
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir') dir = argv[i + 1] ?? dir
  }
  return dir
}

/** on/off、true/false、1/0 都接受 */
function bool(v: unknown, field: string, fallback: boolean): boolean {
  if (v === undefined || v === null || v === '') return fallback
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toLowerCase()
  if (['on', 'true', '1', 'yes'].includes(s)) return true
  if (['off', 'false', '0', 'no'].includes(s)) return false
  throw new Error(`配置项 ${field} 只接受 on/off，收到：${String(v)}`)
}

function num(v: unknown, name: string, fallback: number, min: number, max: number): number {
  if (v === undefined || v === null || v === '') return fallback
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new Error(`${name} 必须是数字，收到 ${JSON.stringify(v)}`)
  if (n < min || n > max) throw new Error(`${name} 必须在 ${min}..${max}，收到 ${n}`)
  return n
}

function str(v: unknown, name: string, fallback: string): string {
  if (v === undefined || v === null || v === '') return fallback
  if (typeof v !== 'string') throw new Error(`${name} 必须是字符串`)
  return v
}

function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[], fallback: T): T {
  const s = str(v, name, fallback)
  if (!allowed.includes(s as T)) throw new Error(`${name} 只能是 ${allowed.join(' / ')}，收到 ${JSON.stringify(s)}`)
  return s as T
}

function buildConfig(raw: RawConfig, source: Config['source']): Config {
  const dataDir = resolve(str(raw.dataDir, 'dataDir', defaultDataDir()))
  const registration = oneOf(raw.registration, 'registration', ['open', 'closed'] as const, 'open')
  const tokenTtlDays = num(raw.tokenTtlDays, 'tokenTtlDays', DEFAULTS.tokenTtlDays, 1, 30)
  const host = str(raw.host, 'host', DEFAULTS.host)
  const port = num(raw.port, 'port', DEFAULTS.port, 0, 65535)
  const configuredDomain = raw.domain === undefined || raw.domain === '' ? null : String(raw.domain).trim()
  const parsedDomain = configuredDomain === null ? null : parseDomain(configuredDomain)
  if (configuredDomain !== null && parsedDomain === null) {
    throw new Error(`domain 不是合法地址：${configuredDomain}（例：127.0.0.1:3939 或 team.example.com）`)
  }
  if (parsedDomain !== null && ['0.0.0.0', '::', '[::]'].includes(parsedDomain.host)) {
    throw new Error(`domain 不能是 ${parsedDomain.host}：请写 127.0.0.1:端口，或线上域名`)
  }
  // 本机 domain 带端口时，它就是 bind 地址；线上 domain 只作对外地址，bind 仍走 host/port。
  const bindHost = raw.host === undefined && parsedDomain !== null && isLoopbackHost(parsedDomain.host)
    ? parsedDomain.host
    : host
  const bindPort = raw.port === undefined && parsedDomain !== null && parsedDomain.port !== null
    ? parsedDomain.port
    : port
  const domain = configuredDomain ?? formatDomain(bindHost, bindPort)
  // 安全边界：本服务不做资源级鉴权，绑到非回环等于把数据全暴露给局域网
  if (!isLoopbackHost(bindHost)) {
    throw new Error(
      `拒绝绑定 ${bindHost}：本服务只允许回环地址（127.0.0.1 / ::1 / localhost）。` +
        '需要跨机访问请用 SSH 隧道或反向代理，不要把服务直接暴露出去。',
    )
  }

  return {
    host: bindHost,
    port: bindPort,
    domain,
    dataDir,
    dbPath: join(dataDir, 'teamwork.db'),
    tokenTtlSeconds: Math.round(tokenTtlDays * 86400),
    maxUploadBytes: Math.round(num(raw.maxUploadMb, 'maxUploadMb', DEFAULTS.maxUploadMb, 1, 4096) * 1024 * 1024),
    shutdownGraceMs: num(raw.shutdownGraceMs, 'shutdownGraceMs', DEFAULTS.shutdownGraceMs, 0, 120_000),
    startTimeoutMs: num(raw.startTimeoutMs, 'startTimeoutMs', DEFAULTS.startTimeoutMs, 100, 120_000),
    registration,
    privateMemberLimit: num(raw.privateMemberLimit, 'privateMemberLimit', DEFAULTS.privateMemberLimit, 1, 1000),
    authCacheTtlMs: num(raw.authCacheTtlMs, 'authCacheTtlMs', DEFAULTS.authCacheTtlMs, 0, 3_600_000),
    rateLimit: bool(raw.rateLimit, 'rateLimit', DEFAULTS.rateLimit),
    logLevel: oneOf(raw.logLevel, 'logLevel', ['debug', 'info', 'warn', 'error'] as const, 'info'),
    logFile: raw.logFile ? String(raw.logFile) : null,
    source,
  }
}

export const HELP = `dsh-teamwork — 本地协作服务（issue / 项目 / 设备 / 文件）

用法：
  dsh-teamwork [serve] [选项]

选项（优先级：CLI > 环境变量 > config.json > 默认值）
  --host <ip>                  监听地址（默认 127.0.0.1；改成非回环会打安全告警）
  --port <n>                   监听端口（默认 3939；0 = 随机）
  --data-dir <dir>            数据目录（默认 ~/.dsh/storages/teamwork，自动创建）
  --config <path>              配置文件路径（默认 <data-dir>/config.json）
  --token-ttl-days <n>         token 有效期天数（默认 3）
  --max-upload-mb <n>          单文件上传上限 MB（默认 64）
  --shutdown-grace <ms>        优雅停机等待在飞请求上限（默认 5000）
  --domain <addr>              对外地址（127.0.0.1:3939；线上写 team.example.com，不带端口）
  --registration <mode>        注册闸门 open|closed（默认 open）
  --private-member-limit <n>   private 项目成员上限（默认 5）
  --auth-cache-ttl <ms>        鉴权缓存 TTL（默认 60000；0 = 关闭）
  --rate-limit <on|off>        限流开关（默认 on；off 仅用于本地压测/自动化）
  --log-level <level>          debug|info|warn|error（默认 info）
  --log-file <path>            日志文件（默认 stdout）
  -h, --help                   显示本帮助
  -v, --version                显示版本

数据库不需要手动创建：首次启动会自动建库、建表并写入预置数据。
`
