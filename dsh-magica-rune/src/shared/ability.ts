/**
 * 能力配置的纯数据层：schema 形状、默认值、生效态计算、开关写回。
 *
 * 这里**不 import 任何 dsh 运行时**，因此可以被 host、client、单元测试三方共用
 * （client bundle 会把本文件打成字面量，purity gate 不会拦同包相对 import）。
 * @module dsh-magica-rune/shared/ability
 */

/** 一层门禁：`disabled` = 本层新增禁用；`enabled` = 本层恢复上层禁用（相对增量）。 */
export interface AbilityLayer {
  disabled: string[]
  enabled: string[]
}

/**
 * 只读视图（**宿主 Config 侧用这个**）。
 *
 * schemastery 的 `.volatile()` 会把数组推导成 `readonly string[]`，而 UI / 变换函数
 * 需要在副本上 `push`/`splice`，所以两份类型并存：
 * - 写侧（applyToggle / cloneSettings / 组件）用可变的 `AbilityLayer`；
 * - 读侧（Config 声明、buildEffective、GuardState.sync）用这里的只读版本。
 */
export interface ReadonlyAbilityLayer {
  readonly disabled: readonly string[]
  readonly enabled: readonly string[]
}

/** 一个能力类别：全局层 + 按 workspaceId 的覆盖层。 */
export interface AbilityKindSettings {
  global: AbilityLayer
  workspaces: Record<string, AbilityLayer>
}

/** `AbilityKindSettings` 的只读视图。 */
export interface ReadonlyAbilityKindSettings {
  readonly global: ReadonlyAbilityLayer
  readonly workspaces: Readonly<Record<string, ReadonlyAbilityLayer>>
}

/** 配置整体的两个子树（只有工具与技能）。 */
export interface AbilitySettingsValue {
  tools: AbilityKindSettings
  skills: AbilityKindSettings
}

/** 能力类别标识（只有两个）。 */
export type AbilityKind = 'tools' | 'skills'

/** 作用域：全局或某个工作区。 */
export type ScopeKind = 'global' | 'workspace'

/** 空的一层。 */
export function emptyLayer(): AbilityLayer {
  return { disabled: [], enabled: [] }
}

/** 空的一个 kind。 */
export function emptyKind(): AbilityKindSettings {
  return { global: emptyLayer(), workspaces: {} }
}

/** 空的整份配置。 */
export function emptySettings(): AbilitySettingsValue {
  return { tools: emptyKind(), skills: emptyKind() }
}

/** 把可能缺字段的外部输入补成完整结构（settings 值来自 wire，必须防御）。 */
export function normalizeKind(raw: unknown): AbilityKindSettings {
  const source = (raw ?? {}) as Partial<AbilityKindSettings>
  return {
    global: normalizeLayer(source.global),
    workspaces: normalizeWorkspaces(source.workspaces),
  }
}

/** 同上，整份。 */
export function normalizeSettings(raw: unknown): AbilitySettingsValue {
  const source = (raw ?? {}) as Partial<AbilitySettingsValue>
  return { tools: normalizeKind(source.tools), skills: normalizeKind(source.skills) }
}

function normalizeLayer(raw: unknown): AbilityLayer {
  const source = (raw ?? {}) as Partial<AbilityLayer>
  return {
    disabled: strings(source.disabled),
    enabled: strings(source.enabled),
  }
}

function normalizeWorkspaces(raw: unknown): Record<string, AbilityLayer> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, AbilityLayer> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) out[key] = normalizeLayer(value)
  return out
}

function strings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) if (typeof item === 'string' && item !== '') out.push(item)
  return out
}

/** 该层是否显式写过这个 name。 */
export function layerMentions(layer: AbilityLayer, name: string): boolean {
  return layer.disabled.includes(name) || layer.enabled.includes(name)
}

/** 取某个作用域对应的层（工作区未写过时返回 undefined）。 */
export function layerFor(kind: AbilityKindSettings, scope: ScopeKind, workspaceId?: string): AbilityLayer | undefined {
  if (scope === 'global') return kind.global
  if (workspaceId === undefined) return undefined
  return kind.workspaces[workspaceId]
}

/**
 * 计算某个 name 在某个作用域的**生效态**。
 *
 * `builtin` 命中时恒为 `builtin`（不可编辑）；否则按
 * 工作区 → 全局 → 默认启用的顺序回落。
 */
export function effectiveState(
  kind: AbilityKindSettings,
  scope: ScopeKind,
  name: string,
  builtin: ReadonlySet<string>,
  workspaceId?: string,
): 'enabled' | 'disabled' | 'builtin' {
  if (builtin.has(name)) return 'builtin'
  const local = layerFor(kind, scope, workspaceId)
  if (local !== undefined) {
    if (local.disabled.includes(name)) return 'disabled'
    if (local.enabled.includes(name)) return 'enabled'
  }
  if (scope === 'global') return 'enabled'
  // 工作区没写过 → 继承全局
  return kind.global.disabled.includes(name) ? 'disabled' : 'enabled'
}

/**
 * 一次开关点击对配置的写回（**就地修改**传入的 kind）。
 *
 * 语义与 raw 设计一致：
 * - global：enabled → push disabled；disabled → remove from disabled。
 * - workspace：enabled → push disabled 且从 enabled 移除；
 *              disabled → 从 disabled 移除，若全局也禁则 push enabled（捞回），否则顺手清掉陈旧项。
 *
 * @returns 是否发生了变更（用于乐观更新时判断要不要落盘）
 */
export function applyToggle(
  kind: AbilityKindSettings,
  scope: ScopeKind,
  name: string,
  builtin: ReadonlySet<string>,
  workspaceId?: string,
): boolean {
  if (builtin.has(name)) return false
  const next = effectiveState(kind, scope, name, builtin, workspaceId)
  if (scope === 'global') {
    if (next === 'enabled') {
      if (!kind.global.disabled.includes(name)) kind.global.disabled.push(name)
      remove(kind.global.enabled, name)
      return true
    }
    remove(kind.global.disabled, name)
    return true
  }
  if (workspaceId === undefined) return false
  const layer = kind.workspaces[workspaceId] ?? { disabled: [], enabled: [] }
  kind.workspaces[workspaceId] = layer
  if (next === 'enabled') {
    if (!layer.disabled.includes(name)) layer.disabled.push(name)
    remove(layer.enabled, name)
    return true
  }
  remove(layer.disabled, name)
  if (kind.global.disabled.includes(name)) {
    if (!layer.enabled.includes(name)) layer.enabled.push(name)
  } else {
    remove(layer.enabled, name)
  }
  return true
}

/** 批量：不是全启用就全部启用，否则全部禁用。 */
export function batchTarget(
  kind: AbilityKindSettings,
  scope: ScopeKind,
  names: readonly string[],
  builtin: ReadonlySet<string>,
  workspaceId?: string,
): boolean {
  const allEnabled = names.every(name => effectiveState(kind, scope, name, builtin, workspaceId) === 'enabled')
  return !allEnabled
}

function remove(list: string[], value: string): void {
  const index = list.indexOf(value)
  if (index >= 0) list.splice(index, 1)
}

/** 深拷贝一份配置，供乐观更新前的快照使用。 */
export function cloneSettings(value: AbilitySettingsValue): AbilitySettingsValue {
  return normalizeSettings(JSON.parse(JSON.stringify(value)))
}
