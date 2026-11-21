/**
 * 「官方界面插件」开关：读写 **profile** 的 `cordis.patch.yml`。
 *
 * 为什么必须改 profile：其它插件的启用状态只由 loader 的 patch 行决定
 * （`{ id, disabled }`），插件包里改不了别人。这与官方 plugin-manager 的做法一致
 * （`packages/boot/plugin-manager/src/patch.ts:22-76`：读 patch 文件 → 改/加一条 →
 * `writeFileAtomic` 落盘）。区别只在于我们不需要整棵 YAML 树：只碰这 6 个 id
 * 的 `disabled` 行，其余内容**原样保留**（注释也不动）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 可以被本页开关的 6 个官方插件（顺序即 UI 顺序）。 */
export const PANEL_PLUGINS = [
  // defaultDisabled = 本插件 bundle patch 里给的默认值；profile 没有覆盖行时以它为准，
  // 否则 UI 会把「默认已关」显示成「开着」，与实际生效状态相反。
  { id: 'ui-plugin-manager', label: '插件页', hint: '侧栏「插件」行 + 插件安装页', defaultDisabled: true },
  { id: 'entry-customization', label: '更多菜单', hint: '侧栏 / 会话 / 右栏的「更多」；依赖插件页，必须一起停', defaultDisabled: true },
  { id: 'ui-schedule', label: '自动化任务', hint: '侧栏「自动化任务」行与任务页', defaultDisabled: true },
  { id: 'ui-settings-account', label: '账号页', hint: '设置「账号」；每轮拉 profile/balance 的消费方', defaultDisabled: true },
  { id: 'account-controller', label: '账号 RPC', hint: '账号页的 RPC 后端，页面停了它就是空转', defaultDisabled: true },
  { id: 'deepseek-account', label: '账号 Host', hint: '真正发 HTTP 的一层；⚠️ 停止前必须把默认模型切到 deepseek-official', defaultDisabled: false },
] as const

/**
 * 依赖关系：`entry-customization` 的 inject 里有 `pluginNavigation`，它由
 * `ui-plugin-manager` 提供。只停后者会让前者一直 pending，Web 启动审计把 pending
 * 当失败（`1 entry did not activate / waiting for service: pluginNavigation`）。
 */
const PANEL_REQUIRES: Record<string, string> = {
  'entry-customization': 'ui-plugin-manager',
}

/** 某个 id 被禁用时，必须一起禁用的「依赖它的」条目。 */
function dependentsOf(id: string): string[] {
  return Object.entries(PANEL_REQUIRES).filter(([, needs]) => needs === id).map(([dependent]) => dependent)
}

/** 解析 profile 的 patch 文件路径（服务优先，其次命令行，最后退回 web）。 */
export function resolvePatchPath(ctx: { get?: (name: string) => unknown }): string | undefined {
  try {
    const profile = ctx.get?.('profile') as { patchPath?: unknown } | undefined
    if (profile !== undefined && typeof profile.patchPath === 'string' && profile.patchPath !== '') {
      return profile.patchPath
    }
  } catch {
    // 未声明该服务会抛：忽略，走命令行探测
  }
  const argv = process.argv
  const index = argv.findIndex(arg => arg === '--profile')
  const raw = index >= 0 ? argv[index + 1] : undefined
  const name = typeof raw === 'string' && raw !== '' ? raw : 'web'
  const path = join(homedir(), '.dsh', 'profiles', name, 'cordis.patch.yml')
  if (existsSync(path)) return path
  const fallback = join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml')
  return existsSync(fallback) ? fallback : path
}

interface RowState { disabled: boolean; start: number; end: number }

/** 在文本里找 `- id: <id>` 这条 patch 行，并读它的 disabled 与行范围。 */
function findRow(lines: string[], id: string): RowState | undefined {
  const header = new RegExp(`^\\s*-\\s*id:\\s*["']?${id}["']?\\s*$`)
  for (let i = 0; i < lines.length; i++) {
    if (!header.test(lines[i] ?? '')) continue
    // 行块：直到下一个同级 `- ` 开头（或文件结束）
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? ''
      if (/^\s*-\s+\S/.test(line) || /^\S/.test(line)) { end = j; break }
    }
    let disabled = false
    for (let j = i + 1; j < end; j++) {
      const match = /^\s*disabled:\s*(true|false)\s*$/.exec(lines[j] ?? '')
      if (match !== null) disabled = match[1] === 'true'
    }
    return { disabled, start: i, end }
  }
  return undefined
}

/** 某个 id 的生效状态：profile 有覆盖用覆盖，否则用 bundle 默认。 */
export function effectivePanelDisabled(id: string, overrides: Record<string, boolean | undefined>): boolean | undefined {
  const override = overrides[id]
  if (override !== undefined) return override
  return PANEL_PLUGINS.find(plugin => plugin.id === id)?.defaultDisabled
}

/**
 * 自愈：若某个提供者被显式禁用、而依赖它的条目没有被显式禁用，就补一条禁用，
 * 否则下次启动会 pending 失败。返回修正过的 id 列表。
 */
export function healPanelDependencies(patchPath: string): string[] {
  let text = ''
  try { text = readFileSync(patchPath, 'utf8') } catch { return [] }
  const lines = text.split(/\r?\n/)
  const healed: string[] = []
  for (const [dependent, needs] of Object.entries(PANEL_REQUIRES)) {
    const providerRow = findRow(lines, needs)
    const dependentRow = findRow(lines, dependent)
    if (providerRow?.disabled !== true) continue
    if (dependentRow?.disabled === true) continue
    writePanelOverride(patchPath, dependent, false)
    healed.push(dependent)
  }
  return healed
}

/** 读当前**用户覆盖**状态：返回每个 id 是否被 profile 显式关了（没有行 = 未覆盖）。 */
export function readPanelOverrides(patchPath: string): Record<string, boolean | undefined> {
  let text = ''
  try { text = readFileSync(patchPath, 'utf8') } catch { text = '' }
  const lines = text.split(/\r?\n/)
  const result: Record<string, boolean | undefined> = {}
  for (const plugin of PANEL_PLUGINS) result[plugin.id] = findRow(lines, plugin.id)?.disabled
  return result
}

/**
 * 写入一条覆盖：`enabled === false` → `disabled: true`；`true` → `disabled: false`。
 * 只改这一条行块，其余字节保持原样；用 tmp + rename 原子替换。
 */
export function writePanelOverride(patchPath: string, id: string, enabled: boolean): void {
  // 依赖成对处理，避免出现「提供者停了、依赖者还在」的 pending 死局
  const also: Array<{ id: string; enabled: boolean }> = []
  if (!enabled) {
    for (const dependent of dependentsOf(id)) also.push({ id: dependent, enabled: false })
  } else {
    const needs = PANEL_REQUIRES[id]
    if (needs !== undefined) also.push({ id: needs, enabled: true })
  }
  writePanelRow(patchPath, id, enabled)
  for (const extra of also) writePanelRow(patchPath, extra.id, extra.enabled)
}

/** 该 id 在 bundle patch 里的默认状态（未覆盖时生效的值）。 */
function defaultDisabledOf(id: string): boolean | undefined {
  return PANEL_PLUGINS.find(plugin => plugin.id === id)?.defaultDisabled
}

/**
 * 写单条 `{ id, disabled }`。
 *
 * **与 bundle 默认相同时不写、反而删除已有行** —— 这样 profile 里只留「用户改过」的覆盖，
 * 卸载本插件后不会残留一堆 `disabled: true` 把官方插件永久关掉。
 */
function writePanelRow(patchPath: string, id: string, enabled: boolean): void {
  const desired = !enabled
  const fallback = defaultDisabledOf(id)
  if (fallback !== undefined && desired === fallback) {
    removePanelRow(patchPath, id)
    return
  }
  let text = ''
  try { text = readFileSync(patchPath, 'utf8') } catch { text = '' }
  if (text.trim() === '') text = '[]\n'
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  const row = findRow(lines, id)

  if (row === undefined) {
    lines.push(`- id: ${id}`, `  disabled: ${String(desired)}`)
  } else {
    let replaced = false
    for (let j = row.start + 1; j < row.end; j++) {
      if (/^\s*disabled:\s*(true|false)\s*$/.test(lines[j] ?? '')) {
        lines[j] = `  disabled: ${String(desired)}`
        replaced = true
      }
    }
    if (!replaced) lines.splice(row.start + 1, 0, `  disabled: ${String(desired)}`)
  }

  writeAtomic(patchPath, lines)
}

/** 删除某个 id 的整条 patch 行块（没有就什么都不做）。 */
export function removePanelRow(patchPath: string, id: string): boolean {
  let text = ''
  try { text = readFileSync(patchPath, 'utf8') } catch { return false }
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  const row = findRow(lines, id)
  if (row === undefined) return false
  lines.splice(row.start, row.end - row.start)
  writeAtomic(patchPath, lines)
  return true
}

/** 清掉本插件写过的**全部**开关行（卸载后恢复官方默认用）。返回删掉的 id。 */
export function clearPanelOverrides(patchPath: string): string[] {
  const removed: string[] = []
  for (const plugin of PANEL_PLUGINS) {
    if (removePanelRow(patchPath, plugin.id)) removed.push(plugin.id)
  }
  return removed
}

/** 原子写回（tmp + rename）。 */
function writeAtomic(patchPath: string, lines: string[]): void {
  const next = `${lines.join('\n')}\n`
  const tmp = `${patchPath}.rune.tmp`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, patchPath)
}
