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
  { id: 'ui-plugin-manager', label: '插件页', hint: '侧栏「插件」行 + 插件安装页' },
  { id: 'entry-customization', label: '更多菜单', hint: '侧栏 / 会话 / 右栏的「更多」；依赖插件页，必须一起停' },
  { id: 'ui-schedule', label: '自动化任务', hint: '侧栏「自动化任务」行与任务页' },
  { id: 'ui-settings-account', label: '账号页', hint: '设置「账号」；每轮拉 profile/balance 的消费方' },
  { id: 'account-controller', label: '账号 RPC', hint: '账号页的 RPC 后端，页面停了它就是空转' },
  { id: 'deepseek-account', label: '账号 Host', hint: '真正发 HTTP 的一层；⚠️ 停止前必须把默认模型切到 deepseek-official' },
] as const

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
  let text = ''
  try { text = readFileSync(patchPath, 'utf8') } catch { text = '' }
  if (text.trim() === '') text = '[]\n'
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  const disabled = !enabled
  const row = findRow(lines, id)

  if (row === undefined) {
    lines.push(`- id: ${id}`, `  disabled: ${String(disabled)}`)
  } else {
    let replaced = false
    for (let j = row.start + 1; j < row.end; j++) {
      if (/^\s*disabled:\s*(true|false)\s*$/.test(lines[j] ?? '')) {
        lines[j] = `  disabled: ${String(disabled)}`
        replaced = true
      }
    }
    if (!replaced) lines.splice(row.start + 1, 0, `  disabled: ${String(disabled)}`)
  }

  const next = `${lines.join('\n')}\n`
  const tmp = `${patchPath}.rune.tmp`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, patchPath)
}
