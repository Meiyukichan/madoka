/**
 * dsh home 的唯一解析器。
 *
 * 为什么集中：`process.env['DSH_HOME']` 曾经散在 logger / crypto 的多处，各自实现、
 * 各有各的兜底——其中一处退化成相对路径 `'.'`，等于把密钥/日志写到**当前工作目录**。
 * 现在统一为：`$DSH_HOME` → `os.homedir()/.dsh`，**永不返回相对路径**。
 *
 * 宿主里更准的来源是 Cordis 的 `dshHomePath` 服务（会话门面/交互层优先用它）；
 * 本模块只解决"没有 ctx 时"（纯工具层、测试、CLI）的解析。
 *
 * @module dsh-magica-spellbook/core/home
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 用户 home；`os.homedir()` 不可用时抛可读错误，**不**退化到相对路径。 */
export function userHome(): string {
  try {
    const home = homedir()
    if (typeof home === 'string' && home !== '') return home
  } catch {
    // 落到下面抛错
  }
  throw new Error(
    'cannot resolve the user home directory (os.homedir() failed); set DSH_HOME explicitly',
  )
}

/**
 * dsh home：`$DSH_HOME`（去空白）→ `os.homedir()/.dsh`。
 *
 * `env` 可显式传入：测试**不要**去改 `process.env`（同进程的测试文件是并行的，
 * 改全局 env 会污染别的测试——本仓踩过一次，把日志写进了真实 `~/.dsh`）。
 *
 * @param env - 环境映射，默认 `process.env`。
 */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env['DSH_HOME']
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(userHome(), '.dsh')
}

/**
 * `$DSH_HOME/<segments…>`。
 * @param segments - 相对 dsh home 的段；不传就是 home 本身。
 */
export function dshHomePath(...segments: string[]): string {
  const home = resolveDshHome()
  return segments.length === 0 ? home : join(home, ...segments)
}
