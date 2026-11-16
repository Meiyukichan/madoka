/**
 * 脱敏诊断日志：内存环形缓冲 + 周轮转 NDJSON + bug 报告导出。
 *
 * 设计要点（见 `docs/design/01-core-utils.zh.md` §1）：
 * - 写入路径**全同步、零 await**（热路径不写盘）；
 * - 落盘异步、批量、失败一次即熔断（不再重试，也不再刷屏）；
 * - 三层容量控制：周轮转（保留 4 周）/ 单周 256 KiB / 内存 200 条。
 *
 * @module dsh-magica-spellbook/core/logger
 */

import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomePath, userHome } from './home.ts'

/** 日志级别（刻意没有 `debug`：诊断日志面向用户，不面向开发）。 */
export type LogLevel = 'info' | 'warn' | 'error'

/** 一条内存条目。 */
interface LogEntry {
  at: string
  level: LogLevel
  event: string
  detail: string
}

/** 诊断日志句柄。 */
export interface EventLogger {
  /** 写一条事件：同步推内存缓冲 + 推进待写队列（满 50 条立即异步刷盘）。 */
  logEvent(level: LogLevel, event: string, detail: string): void
  /** 拼一份纯文本 bug 报告。 */
  exportLogs(header: Record<string, string>, snapshot?: string[], priorSessions?: string[]): string
  /** 读本周 NDJSON 的最近 N 行，并合并尚未 flush 的待写行。 */
  readPersistentLog(maxLines?: number): string[]
  /** 强制把待写行刷盘（永不 reject）。 */
  flush(): Promise<void>
  /** 停定时器 + best-effort flush；环形缓冲仍可用到进程退出。 */
  dispose(): void
}

const MAX_ENTRIES = 200
const DETAIL_MAX = 600
const PERSISTENT_MAX_BYTES = 256 * 1024
const KEEP_WEEKS = 4
const FLUSH_INTERVAL_MS = 5_000
const FLUSH_THRESHOLD = 50

const LOG_FILE_PATTERN = /^log-(\d{4})-(\d{2})-(\d{2})\.ndjson$/
const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

/** 通用脱敏：任何要落盘 / 落日志的字符串都应先过它。 */
export function sanitize(text: string): string {
  let out = text
  const home = (() => {
    try {
      return userHome()
    } catch {
      return undefined
    }
  })()
  if (home !== undefined && home.length > 0) out = out.split(home).join('~')
  out = out.replace(/[\u0000-\u001f\u007f]/g, '')
  out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
  out = out.replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_***')
  out = out.replace(/npm_[A-Za-z0-9]{16,}/g, 'npm_***')
  out = out.replace(/bearer\s+\S+/gi, 'Bearer ***')
  // cookie 必须抹到**行尾**（c.md:182「余下内容」）：cookie 是 =1; b=2 这种多段串，\S+ 只会抹掉第一段，=2 会随 bug 报告外发
  out = out.replace(/(cookie|set-cookie)(\s*:\s*)[^\r\n]*/gi, '$1$2***')
  out = out.replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, 'jwt.***')
  // 身份证放在手机号之前只是"优先级意图"的表达：两条正则都带数字边界断言，
  // 18 位串不会被 `1[3-9]\d{9}` 命中（第 12 位仍是数字，被 `(?![\d])` 挡住），所以顺序可交换。
  out = out.replace(/(?<![\dXx])\d{17}[\dXx](?![\dXx])/g, '******************')
  out = out.replace(/(?<![\d])1[3-9]\d{9}(?![\d])/g, '1**********')
  out = out.replace(
    /(authorization|token|apikey|api-key|password|mtoken|x-auth-token)(\s*[=:]\s*)(?!Bearer \*\*\*)\S+/gi,
    '$1$2***',
  )
  return out
}

/** 本周一的 `YYYY-MM-DD`（周 key：同一周内文件名不变）。 */
function weekKey(date: Date): string {
  const tmp = new Date(date.getTime())
  tmp.setHours(0, 0, 0, 0)
  const day = (tmp.getDay() + 6) % 7
  tmp.setDate(tmp.getDate() - day)
  return localDay(tmp)
}

function localDay(date: Date): string {
  const y = date.getFullYear().toString().padStart(4, '0')
  const m = (date.getMonth() + 1).toString().padStart(2, '0')
  const d = date.getDate().toString().padStart(2, '0')
  return `${y}-${m}-${d}`
}

function timezoneNote(): string {
  try {
    const offsetMinutes = -new Date().getTimezoneOffset()
    const sign = offsetMinutes >= 0 ? '+' : '-'
    const abs = Math.abs(offsetMinutes)
    const hh = Math.floor(abs / 60).toString().padStart(2, '0')
    const mm = (abs % 60).toString().padStart(2, '0')
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const base = `timestamps: UTC - this machine is UTC${sign}${hh}:${mm}`
    return zone === undefined || zone === ''
      ? base
      : `${base} (${zone}), so add ${sign}${hh}h for local time`
  } catch {
    return 'timestamps: UTC'
  }
}

/** 默认日志根目录：`$DSH_HOME/logs/<pluginName>`（`$DSH_HOME` 缺省 `os.homedir()/.dsh`）。 */
function defaultLogRoot(pluginName: string): string {
  return dshHomePath('logs', pluginName)
}

/** 目录名只能是单段：带分隔符会把 `logs/<name>` 拼成嵌套目录（真机 bug：出现过 `logs/pkg/questions/`）。 */
function assertSingleSegment(pluginName: string): void {
  if (pluginName === '' || /[/\\]/.test(pluginName) || pluginName === '.' || pluginName === '..') {
    throw new Error(
      `createEventLogger: pluginName must be one path segment (got ${JSON.stringify(pluginName)}); `
        + 'use the package name and distinguish events by their `event` field',
    )
  }
}

/**
 * 创建一个插件专属的诊断日志实例。
 * @param pluginName - 目录名（`~/.dsh/logs/<pluginName>/`），**单段**，不含分隔符。
 * @param rootDir - 覆盖日志根目录（宿主用 `dshHomePath('logs', name)` 传；测试用）。
 */
export function createEventLogger(pluginName: string, rootDir?: string): EventLogger {
  assertSingleSegment(pluginName)
  const dir = rootDir ?? defaultLogRoot(pluginName)
  const entries: LogEntry[] = []
  const pendingLines: string[] = []

  let currentWeek = ''
  let currentFile = ''
  let persistentBytes = 0
  let persistenceEnabled = true
  let flushing = false
  let timer: ReturnType<typeof setInterval> | null = null
  let disposed = false

  function refreshWeek(): void {
    if (!persistenceEnabled) return
    try {
      const key = weekKey(new Date())
      if (key === currentWeek && currentFile !== '') return
      mkdirSync(dir, { recursive: true })
      currentWeek = key
      currentFile = join(dir, `log-${key}.ndjson`)
      try {
        persistentBytes = statSync(currentFile).size
      } catch {
        persistentBytes = 0
      }
      cleanupOldFiles()
    } catch {
      persistenceEnabled = false
    }
  }

  function cleanupOldFiles(): void {
    try {
      const cutoff = Date.now() - KEEP_WEEKS * WEEK_MS
      for (const name of readdirSync(dir)) {
        const matched = LOG_FILE_PATTERN.exec(name)
        const y = matched?.[1]
        const m = matched?.[2]
        const d = matched?.[3]
        if (y === undefined || m === undefined || d === undefined) continue
        const at = new Date(Number(y), Number(m) - 1, Number(d)).getTime()
        if (Number.isNaN(at) || at >= cutoff) continue
        try {
          unlinkSync(join(dir, name))
        } catch {
          // 单个文件删不掉不影响其它文件
        }
      }
    } catch {
      // 清理是尽力而为
    }
  }

  async function trimAsync(): Promise<void> {
    const target = Math.floor(PERSISTENT_MAX_BYTES / 2)
    const text = await readFile(currentFile, 'utf8')
    if (text.length <= PERSISTENT_MAX_BYTES) return
    // 按**行**保留后半（c.md:211）：直接按字节切会把首行切成半行，
    // 那份 NDJSON 从此不可解析，bug 报告里会出现坏行
    const lines = text.split('\n')
    const kept: string[] = []
    let bytes = 0
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index] ?? ''
      const size = line.length + 1
      if (bytes + size > target && kept.length > 0) break
      kept.unshift(line)
      bytes += size
    }
    const trimmed = kept.join('\n')
    await writeFile(currentFile, trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`, 'utf8')
    persistentBytes = trimmed.length + 1
  }

  async function flushPending(): Promise<void> {
    if (!persistenceEnabled || flushing || pendingLines.length === 0 || currentFile === '') return
    flushing = true
    const batch = pendingLines.splice(0, pendingLines.length)
    try {
      const payload = `${batch.join('\n')}\n`
      await appendFile(currentFile, payload, 'utf8')
      persistentBytes += payload.length
      if (persistentBytes > PERSISTENT_MAX_BYTES) await trimAsync()
    } catch {
      // 写失败：批次回放（不丢），并熔断（不再重试）
      pendingLines.unshift(...batch)
      persistenceEnabled = false
    } finally {
      flushing = false
    }
  }

  if (persistenceEnabled) {
    refreshWeek()
    if (persistenceEnabled) {
      timer = setInterval(() => {
        void flushPending()
      }, FLUSH_INTERVAL_MS)
      timer.unref?.()
    }
  }

  return {
    logEvent(level, event, detail) {
      const clean = sanitize(detail).slice(0, DETAIL_MAX)
      const entry: LogEntry = { at: new Date().toISOString(), level, event, detail: clean }
      entries.push(entry)
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
      if (!persistenceEnabled) return
      refreshWeek()
      if (!persistenceEnabled || currentFile === '') return
      pendingLines.push(JSON.stringify(entry))
      if (pendingLines.length >= FLUSH_THRESHOLD) void flushPending()
    },

    exportLogs(header, snapshot, priorSessions) {
      const lines: string[] = [`# ${pluginName} log export`]
      for (const [key, value] of Object.entries(header)) lines.push(`${key}: ${sanitize(value)}`)
      lines.push(timezoneNote())
      lines.push('## profile state')
      lines.push(...(snapshot === undefined || snapshot.length === 0 ? ['(none)'] : snapshot.map(sanitize)))
      lines.push('## previous sessions (persisted log)')
      lines.push(
        ...(priorSessions === undefined || priorSessions.length === 0
          ? ['(none)']
          : priorSessions.map(sanitize)),
      )
      lines.push('## events this session')
      if (entries.length === 0) {
        lines.push('(none - the buffer starts empty on every start)')
      } else {
        for (const entry of entries) lines.push(`${entry.at} [${entry.level}] ${entry.event}: ${entry.detail}`)
      }
      return lines.join('\n')
    },

    readPersistentLog(maxLines = 80) {
      const limit = maxLines > 0 ? maxLines : 80
      const collected: string[] = []
      if (currentFile !== '') {
        try {
          const text = readFileSync(currentFile, 'utf8')
          for (const line of text.split('\n')) {
            if (line !== '') collected.push(line)
          }
        } catch {
          // 文件还没建：只返回内存里的待写行
        }
      }
      for (const line of pendingLines) collected.push(line)
      return collected.length <= limit ? collected : collected.slice(collected.length - limit)
    },

    async flush() {
      await flushPending()
    },

    dispose() {
      if (disposed) return
      disposed = true
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      // 收尾必须是**同步**的：异步 flush 在进程/测试结束时经常来不及跑，
      // 会把最后一批（最多 5 s / 50 条）日志丢掉（真机 bug：dispose 后文件为空）。
      if (persistenceEnabled && pendingLines.length > 0 && currentFile !== '') {
        try {
          const batch = pendingLines.splice(0, pendingLines.length)
          const payload = `${batch.join('\n')}\n`
          appendFileSync(currentFile, payload, 'utf8')
          persistentBytes += payload.length
        } catch {
          pendingLines.length = 0
        }
      }
      // dispose 之后**不再写盘**（C-035）：否则日志实例被回收后仍会因 pendingLines 累积而落盘
      persistenceEnabled = false
      void flushPending()
    },
  }
}
