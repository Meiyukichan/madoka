/**
 * 诊断日志接缝：**直接用发布包 `@meiyukichan/dsh-magica-spellbook` 的 `EventLogger`**，
 * 本 SDK 不自己造日志框架、也不写文件。
 *
 * 分工：
 *  - **谁创建**：宿主（dsh 插件 / CLI）用 spellbook 的 `createEventLogger(pluginName, rootDir)` 造一个，
 *    通过 `LatticeOptions.logger` 传进来；SDK 只调 `logEvent(level, event, detail)`。
 *  - **没传时**：`warn` / `error` 落到 `console`，`info` 静默（SDK 在库场景下不该刷屏）。
 *  - **级别语义**：spellbook 刻意只有 `info | warn | error`（没有 debug）。
 *
 * 为什么要这个接缝：SDK 是库，日志出口属于持有 `ctx` 的一方；抢出口会让 `name` / 级别失控。
 * 详情见设计文档 §11.6。
 */

import type { EventLogger, LogLevel } from '@meiyukichan/dsh-magica-spellbook'

export type { EventLogger, LogLevel }

/** 结构等价于发布包的 `EventLogger`（宿主传它自己的实例就行；便于测试传假对象） */
export type LatticeEventLoggerLike = Pick<EventLogger, 'logEvent'>

/** 当前生效的 logger（`null` = 走 console 兜底） */
let current: LatticeEventLoggerLike | null = null

/** 注入 / 清除 logger（宿主在 `apply` 里调一次；`ctx.effect` 回收时传 `null`） */
export function setLatticeLogger(logger: LatticeEventLoggerLike | null): void {
  current = logger
}

/** 当前是否已注入 logger（测试 / 诊断用） */
export function hasLatticeLogger(): boolean {
  return current !== null
}

/**
 * 写一条事件。**永不抛**（日志失败不能影响业务）。
 *
 * @param level - `info` / `warn` / `error`
 * @param event - 稳定的事件名（小写短横线，如 `depends-on` / `auth-expired`）
 * @param detail - 细节（**不要放凭据 / 密码 / accountToken**）
 */
export function latticeLog(level: LogLevel, event: string, detail: string): void {
  if (current !== null) {
    try {
      current.logEvent(level, event, detail)
      return
    } catch {
      /* 落到 console 兜底 */
    }
  }
  if (level === 'info') return
  const line = `[dsh-teamwork] ${event}: ${detail}`
  if (level === 'error') console.error(line)
  else console.warn(line)
}
