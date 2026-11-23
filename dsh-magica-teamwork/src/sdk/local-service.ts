/**
 * 本地服务生命周期�?*检测到 domain �?local 时，确保那份本地服务活着**�? *
 * 为什么放�?SDK 里：本地服务（`dsh-teamwork` 参考实现）�?数据�?的一部分�? * 谁用 SDK 谁就可能需要它活着。调用方（castboard 插件�?host 半侧）在装配时调一次即可�? *
 * 语义（不�?无脑 restart"，而是"保证可用"）：
 * 1. �?local �?�?`skipped`（远端服务不归我们管，绝�?ssh/pkill 别人机器）；
 * 2. `GET {baseUrl}/health` 通过 �?`already-running`�? * 3. 有记录在案的 pid（`<dataDir>/.teamwork-service.pid`）且进程已死 / 探活失败 �?先清掉再拉起�? * 4. 拉起�?*指数退避轮�?*探活，超时返�?`failed`（带最后一次错误，绝不抛）�? *
 * 所有副作用（fetch / spawn / �?pid / 时钟）都可注入，便于单测�? *
 * @module dsh-teamwork/sdk/local-service
 */
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { teamworkBaseUrl, readServerConfig } from './env.js'
import { parseDomain } from '../shared/domain.js'
import { castboardFail, castboardOk, type CastboardResult } from './result.js'

/** 只认回环地址；`0.0.0.0` 不是“本地”，绝不允许本地启动。 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const FORBIDDEN_HOSTS = new Set(['0.0.0.0', '::', '[::]'])

/** 未指定地址（会让服务暴露到所有网卡），必须拒绝。 */
function isForbiddenHost(host: string): boolean {
  return FORBIDDEN_HOSTS.has(host.toLowerCase())
}

/** URL 是否指向本机�?*/
export function isLocalDomain(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return LOCAL_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

/** �?baseUrl 里取端口（`/dsh-teamwork/v1` 这种路径前缀会被忽略）�?*/
export function portOf(baseUrl: string, fallback = 3939): number {
  try {
    const url = new URL(baseUrl)
    if (url.port !== '') return Number(url.port)
    return url.protocol === 'https:' ? 443 : 80
  } catch {
    return fallback
  }
}

/** 一次探活的结果�?*/
export interface LocalServiceProbe {
  healthy: boolean
  status?: number
  error?: string
}

/** 拉起命令�?*/
export interface LocalServiceCommand {
  /** 可执行文件（默认 `dsh-teamwork`，即 teamwork 包的 bin）�?*/
  bin: string
  /** 额外参数（端�?数据目录会自动追加）�?*/
  args?: readonly string[]
  /** 数据目录（pid 文件也放这里）�?*/
  dataDir: string
}

/**
 * Resolve this package's own CLI entry. The publish layout is owned by this package,
 * so callers must not guess `lib/index.js`.
 */
export function localServiceCommand(dataDir: string): LocalServiceCommand {
  let current = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth += 1) {
    const file = join(current, 'package.json')
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
          name?: string
          bin?: string | Record<string, string>
        }
        if (parsed.name === '@meiyukichan/dsh-magica-teamwork') {
          const bin = typeof parsed.bin === 'string' ? parsed.bin : parsed.bin?.['dsh-teamwork']
          if (typeof bin !== 'string' || bin === '') throw new Error('teamwork package has no dsh-teamwork bin')
          return { bin: process.execPath, args: [join(current, bin)], dataDir }
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('no dsh-teamwork bin')) throw error
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error('cannot locate the teamwork package root')
}

/** 选项�?*/
export interface EnsureLocalServiceOptions {
  /** 服务基址；omit to use this package's normal environment resolution. */
  baseUrl?: string
  /** 拉起命令；不给且未开 `autostart` 则只探活、不启动�?*/
  command?: LocalServiceCommand
  /** 探测到本地且未运行时，使用本包自己的 bin 自动拉起�?*/
  autostart?: boolean
  /** `autostart` 使用的数据目录（默认 `~/.dsh/storages/teamwork`）�?*/
  dataDir?: string
  /** 单次探活超时（默�?1500ms）�?*/
  probeTimeoutMs?: number
  /** 启动后等待就绪的总时长（默认 15000ms）�?*/
  startTimeoutMs?: number
  /** 首次退避（默认 200ms，逐次 ×1.6，封�?1500ms）�?*/
  backoffMs?: number
  /** 注入：fetch（默认全局）�?*/
  fetchImpl?: typeof fetch
  /** 注入：spawn（默�?`node:child_process` �?detached spawn）�?*/
  spawnImpl?: (bin: string, args: readonly string[]) => number | undefined
  /** 注入：时钟�?*/
  now?: () => number
  /** 注入：sleep�?*/
  sleep?: (ms: number) => Promise<void>
  /** 日志�?*/
  log?: (level: 'info' | 'warn', event: string, detail?: unknown) => void
}

/** 结果数据�?*/
export interface LocalServiceState {
  baseUrl: string
  action: 'already-running' | 'started' | 'restarted' | 'skipped'
  port: number
  pid?: number
  waitedMs: number
}

/** health 端点（保�?base URL 的路径前缀；服务端只挂�?`/dsh-teamwork/v1/health`）�?*/
export function healthUrlOf(baseUrl: string): string {
  const url = new URL(baseUrl)
  const prefix = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${prefix}/health`
}

/** pid 文件路径�?*/
export function pidFileOf(dataDir: string): string {
  return join(dataDir, '.teamwork-service.pid')
}


/**
 * 启动/重启锁文件�? *
 * 多个 dsh web 进程会同�?`ensureLocalService()`。pid 文件�?spawn 之后才写的，挡不�? * “两个进程同时探活失败、同�?spawn”的竞态；这里�?`open(..., 'wx')` 的原子创建做
 * **跨进程启动租�?*：抢到的进程负责 spawn/restart，其余进程只等健康检查�? */
export function lockFileOf(dataDir: string): string {
  return join(dataDir, '.teamwork-service.lock')
}

export interface ServiceLock {
  /** 持锁�?*插件进程** pid（不是被拉起的服�?pid）�?*/
  pid: number
  port: number
  at: number
}

/** 读锁文件（坏文件当没有）�?*/
export function readServiceLock(file: string): ServiceLock | undefined {
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ServiceLock>
    if (!Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) return undefined
    return {
      pid: parsed.pid!,
      port: Number.isInteger(parsed.port) ? parsed.port! : 0,
      at: Number.isFinite(parsed.at) ? parsed.at! : 0,
    }
  } catch {
    return undefined
  }
}

/** 本机进程是否还活着（EPERM 也算活着）�?*/
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM'
  }
}

/**
 * 尝试拿启动锁。返�?true = 本进程负责启动；false = 另一个活着的进程正在启�?重启�? * 持锁进程已死（或锁文件损坏）时清掉旧锁再抢一次�? */
export function acquireServiceLock(file: string, port: number, now: () => number = Date.now): boolean {
  mkdirSync(dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx')
      try {
        const lock: ServiceLock = { pid: process.pid, port, at: now() }
        writeFileSync(fd, `${JSON.stringify(lock)}\n`, 'utf8')
      } finally {
        closeSync(fd)
      }
      return true
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') return false
      const holder = readServiceLock(file)
      // Same process already owns it (or another live process does): wait, never steal.
      if (holder !== undefined && (holder.pid === process.pid || isProcessAlive(holder.pid))) return false
      // Dead holder or unreadable lock: remove and retry once.
      rmSync(file, { force: true })
    }
  }
  return false
}

/** 释放启动锁（只删自己的锁）�?*/
export function releaseServiceLock(file: string): void {
  const holder = readServiceLock(file)
  if (holder !== undefined && holder.pid !== process.pid) return
  rmSync(file, { force: true })
}

/** 探活（不抛）�?*/
export async function probeLocalService(
  baseUrl: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<LocalServiceProbe> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 1500
  try {
    const response = await fetchImpl(healthUrlOf(baseUrl), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    })
    return { healthy: response.ok, status: response.status }
  } catch (error) {
    return { healthy: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 服务已经在跑时，让它补写被删的运行期文件；旧版服务 404 就忽略。 */
async function requestRuntimeFiles(baseUrl: string, fetchImpl: typeof fetch): Promise<void> {
  try {
    await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/admin/runtime-files`, {
      method: 'POST',
      signal: AbortSignal.timeout(1_000),
      headers: { accept: 'application/json' },
    })
  } catch {
    /* best-effort: old service, network hiccup, or shutdown race */
  }
}

/** TCP 端口是否仍被监听（比 health 更可靠：崩溃中的服务也可能拒�?health）�?*/
async function isPortOpen(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: host.replace(/^\[|\]$/g, ''), port })
    const done = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => { done(true) })
    socket.once('error', () => { done(false) })
    socket.setTimeout(timeoutMs, () => { done(false) })
  })
}

async function waitPortFree(host: string, port: number, sleep: (ms: number) => Promise<void>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isPortOpen(host, port))) return true
    await sleep(250)
  }
  return !(await isPortOpen(host, port))
}

/** 先请�?`/admin/shutdown`，失败再 SIGTERM；参�?furina �?gracefulShutdown�?*/
async function stopLocalService(
  baseUrl: string,
  pid: number | undefined,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  log: (level: 'info' | 'warn', event: string, detail?: unknown) => void,
): Promise<boolean> {
  const url = new URL(baseUrl)
  const host = url.hostname
  const port = portOf(baseUrl)
  const shutdownUrl = new URL('/dsh-teamwork/v1/admin/shutdown', url)

  try {
    const response = await fetchImpl(shutdownUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    })
    if (response.ok && await waitPortFree(host, port, sleep)) {
      log('info', 'local-service.shutdown', { port })
      return true
    }
  } catch (error) {
    log('warn', 'local-service.shutdown-failed', error instanceof Error ? error.message : String(error))
  }

  if (pid !== undefined) {
    try {
      process.kill(pid, 'SIGTERM')
      log('warn', 'local-service.sigterm', { pid, port })
      if (await waitPortFree(host, port, sleep)) return true
    } catch (error) {
      log('warn', 'local-service.sigterm-failed', error instanceof Error ? error.message : String(error))
    }
  }

  return !(await isPortOpen(host, port))
}

/** 读记录的 pid（坏文件当没有）�?*/
export function readPid(file: string): number | undefined {
  if (!existsSync(file)) return undefined
  try {
    const value = Number(readFileSync(file, 'utf8').trim())
    return Number.isInteger(value) && value > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** 默认 spawn：detached + stdio ignore，绝不接管子进程的输出管道�?*/
function defaultSpawn(bin: string, args: readonly string[]): number | undefined {
  // 延迟 require：浏览器 bundle 不该解析 node:child_process
  const { spawn } = process.getBuiltinModule('node:child_process') as typeof import('node:child_process')
  const child = spawn(bin, [...args], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  return child.pid
}

/**
 * 确保本地服务可用�? *
 * 返回 `CastboardResult<LocalServiceState>`�?*不抛**，失败也是信封（�?SDK 其他方法一致）�? */
export async function ensureLocalService(options: EnsureLocalServiceOptions): Promise<CastboardResult<LocalServiceState>> {
  const baseUrl = options.baseUrl ?? teamworkBaseUrl().value
  if (baseUrl === '') {
    return castboardFail({ code: 'invalid_host', status: 0, reason: 'cannot resolve the teamwork base URL' })
  }
  const command = options.command ?? (options.autostart === true
    ? localServiceCommand(options.dataDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'teamwork'))
    : undefined)
  const log = options.log ?? ((): void => {})
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) }))
  const started = now()

  // Startup policy follows config.json:
  // - absent / local domain (localhost, 127.x, ::1) -> manage the local service;
  // - remote domain -> leave it alone (use the remote service);
  // - 0.0.0.0 / :: -> refuse (would expose the service on every interface).
  const config = readServerConfig()
  const configuredDomain = config.domain === null ? null : parseDomain(config.domain)
  const configuredHost = configuredDomain?.host ?? config.host
  if (configuredHost !== null && isForbiddenHost(configuredHost)) {
    return castboardFail({
      code: 'invalid_host',
      status: 0,
      reason: `config.json 的 domain 不能是 ${configuredHost}：请写 127.0.0.1:端口，或线上域名（不带端口）`,
    })
  }
  if (configuredHost !== null && !LOCAL_HOSTS.has(configuredHost.toLowerCase())) {
    return castboardOk(0, { baseUrl, action: 'skipped', port: portOf(baseUrl), waitedMs: 0 })
  }

  if (!isLocalDomain(baseUrl)) {
    return castboardOk(0, { baseUrl, action: 'skipped', port: portOf(baseUrl), waitedMs: 0 })
  }

  const port = portOf(baseUrl)
  const probeOnce = (): Promise<LocalServiceProbe> =>
    probeLocalService(baseUrl, { fetchImpl: options.fetchImpl, timeoutMs: options.probeTimeoutMs })

  const first = await probeOnce()
  if (first.healthy) {
    if (config.localServiceRestart !== true || command === undefined) {
      await requestRuntimeFiles(baseUrl, options.fetchImpl ?? fetch)
      return castboardOk(0, { baseUrl, action: 'already-running', port, waitedMs: now() - started })
    }
    const runningPid = readPid(pidFileOf(command.dataDir))
    log('info', 'local-service.restart-requested', { port, pid: runningPid })
    const stopped = await stopLocalService(
      baseUrl,
      runningPid,
      options.fetchImpl ?? fetch,
      sleep,
      log,
    )
    if (!stopped) {
      return castboardFail({
        code: 'network_error',
        status: 0,
        reason: `localServiceRestart=true，但无法停止现有的本地服务（${healthUrlOf(baseUrl)}）`,
      })
    }
  }

  if (command === undefined) {
    return castboardFail({
      code: 'unsupported',
      status: 0,
      reason: `本地服务未运行且没有给启动命令（${healthUrlOf(baseUrl)}）`,
    })
  }

  const lockFile = lockFileOf(command.dataDir)
  const deadline = now() + (options.startTimeoutMs ?? 15_000)

  if (!acquireServiceLock(lockFile, port, now)) {
    // Another live process owns startup/restart: never spawn here, only wait for health.
    log('info', 'local-service.waiting', { port, owner: readServiceLock(lockFile)?.pid })
    let last: LocalServiceProbe = first
    let wait = options.backoffMs ?? 200
    while (now() < deadline) {
      await sleep(wait)
      wait = Math.min(Math.round(wait * 1.6), 1500)
      last = await probeOnce()
      if (last.healthy) {
        await requestRuntimeFiles(baseUrl, options.fetchImpl ?? fetch)
        const servicePid = readPid(pidFileOf(command.dataDir))
        return castboardOk(0, {
          baseUrl,
          action: 'already-running',
          port,
          ...(servicePid === undefined ? {} : { pid: servicePid }),
          waitedMs: now() - started,
        })
      }
    }
    return castboardFail({
      code: 'network_error',
      status: 0,
      reason: `另一个进程正在启动本地服务，等待超时�?{healthUrlOf(baseUrl)}）：${last.error ?? `status ${String(last.status ?? 0)}`}`,
    })
  }

  try {
    // Another process may have finished between our first probe and the lock acquisition.
    const second = await probeOnce()
    if (second.healthy) {
      await requestRuntimeFiles(baseUrl, options.fetchImpl ?? fetch)
      return castboardOk(0, { baseUrl, action: 'already-running', port, waitedMs: now() - started })
    }

    const pidFile = pidFileOf(command.dataDir)
    const stalePid = readPid(pidFile)
    const url = new URL(baseUrl)
    const occupied = await isPortOpen(url.hostname, port)
    const restarting = occupied || stalePid !== undefined

    // 探活失败但端口还在：先优雅停机，绝不再起一个抢同一端口的进程。
    if (occupied) {
      log('warn', 'local-service.restarting', { port, pid: stalePid })
      const stopped = await stopLocalService(
        baseUrl,
        stalePid,
        options.fetchImpl ?? fetch,
        sleep,
        log,
      )
      if (!stopped) {
        return castboardFail({
          code: 'network_error',
          status: 0,
          reason: `端口 ${String(port)} 仍被占用，旧的 teamwork 服务未能优雅退出`,
        })
      }
    }
    if (stalePid !== undefined) {
      log('warn', 'local-service.stale-pid', { pid: stalePid })
      rmSync(pidFile, { force: true })
    }

    const args = [...(command.args ?? []), '--port', String(port), '--data-dir', command.dataDir]
    let pid: number | undefined
    try {
      mkdirSync(dirname(pidFile), { recursive: true })
      pid = (options.spawnImpl ?? defaultSpawn)(command.bin, args)
      if (pid !== undefined) writeFileSync(pidFile, String(pid), 'utf8')
      log('info', 'local-service.spawned', { pid, port })
    } catch (error) {
      return castboardFail({
        code: 'network_error',
        status: 0,
        reason: `拉起本地服务失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }

    let wait = options.backoffMs ?? 200
    let last: LocalServiceProbe = second
    while (now() < deadline) {
      await sleep(wait)
      wait = Math.min(Math.round(wait * 1.6), 1500)
      last = await probeOnce()
      if (last.healthy) {
        return castboardOk(0, {
          baseUrl,
          action: restarting ? 'restarted' : 'started',
          port,
          pid,
          waitedMs: now() - started,
        })
      }
    }

    return castboardFail({
      code: 'network_error',
      status: 0,
      reason: `本地服务在 ${String(options.startTimeoutMs ?? 15_000)}ms 内未就绪（${healthUrlOf(baseUrl)}）：${last.error ?? `status ${String(last.status ?? 0)}`}`,
    })
  } finally {
    releaseServiceLock(lockFile)
  }
}
