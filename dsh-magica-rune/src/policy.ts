/**
 * 生效集计算 + 名单匹配（纯函数，无 ctx，可单测）。
 *
 * 两张名单（都可在 `cordis.patch.yml` 里改，见 src/config.ts）：
 * - `builtinDisabled`：开箱即禁，且用户 `enabled` **不能**恢复
 * - `nonDisableable` ：永不禁用（guard 放行 / restrict 跳过 / UI 不下发）
 *
 * 名单项以 `*` 结尾表示**前缀匹配**（`sandore_*` 就是这个语义）。
 *
 * 「restrict 不能命名」不单独设表：`restrict` 只 deny 那些**通过**
 * `toolProtected()` 的名字，所以一个名字进了 `nonDisableable` 就不会被 restrict
 * 命名 —— 约束天然成立。
 *
 * 合并语义：
 * ```
 * global = builtin ∪ kind.global.disabled
 *        − { n ∈ kind.global.enabled | n ∉ builtin }
 * for each wsId:
 *   effective(ws) = global ∪ ws.disabled
 *                 − { n ∈ ws.enabled | n ∉ builtin }
 * ```
 * **永不禁的剔除不在折叠阶段做**，而是在查询阶段（`Policy` 的谓词），
 * 因为前缀规则无法塞进 `Set`，而折叠阶段只知道配置里的名字。
 * @module dsh-magica-rune/policy
 */

import type { AbilityLayer, ReadonlyAbilityKindSettings, ReadonlyAbilityLayer } from './shared/ability.ts'

/** 一份折叠完成的门禁（只反映配置，不含保护名单）。 */
export interface EffectiveGate {
  global: ReadonlySet<string>
  workspaces: ReadonlyMap<string, ReadonlySet<string>>
}

/** 名单输入（来自插件 Config）。 */
export interface PolicyInput {
  toolBuiltin: readonly string[]
  toolNonDisableable: readonly string[]
  skillNonDisableable: readonly string[]
}

/**
 * **不可通过配置解除**的保护名字。
 *
 * `run_code` 是 PTC 呈现传输（不是能力工具）：`tools.restrict` 一旦命名它就抛错
 * （`packages/core/tools/src/index.ts:1111-1112`），注册同名工具也被拒（`:1080-1081`）。
 * 所以它在代码里硬保护 —— 即使有人把它从 `nonDisableable` 里删掉，也依然受保护。
 */
export const HARD_RESERVED: ReadonlySet<string> = new Set<string>(['run_code'])

/**
 * schema 默认值 —— 与 `cordis.patch.yml` 保持一致。
 *
 * 权威来源是 **patch**（它是组件期的 base 层）；这里的默认值只在 patch 里
 * 整块删掉该字段时兜底。两处不一致时以 patch 为准。
 */
export const DEFAULT_TOOL_BUILTIN_DISABLED: readonly string[] = []
export const DEFAULT_TOOL_NON_DISABLEABLE: readonly string[] = ['run_code', 'sandore_*']
export const DEFAULT_SKILL_NON_DISABLEABLE: readonly string[] = [
  'dsh-plugins-principles',
  'sandore-workflow-authoring',
  'cordis-plugin-development',
  'editing-cordis-compositions',
]

/** 名单匹配器。 */
export class Policy {
  readonly builtinTool: ReadonlySet<string>
  readonly toolNonDisableable: readonly string[]
  readonly skillNonDisableable: readonly string[]

  constructor(input: PolicyInput) {
    this.builtinTool = new Set(input.toolBuiltin)
    this.toolNonDisableable = [...input.toolNonDisableable]
    this.skillNonDisableable = [...input.skillNonDisableable]
  }

  /** 该工具是否**永不禁用**（同时意味着 restrict 不会命名它、UI 不下发它）。 */
  toolProtected(name: string): boolean {
    if (HARD_RESERVED.has(name)) return true
    return matches(this.toolNonDisableable, name)
  }

  /** 该 skill 是否永不禁用。 */
  skillProtected(name: string): boolean {
    return matches(this.skillNonDisableable, name)
  }

  /** 内置禁用（开箱即禁，`enabled` 不能恢复）。 */
  isBuiltinDisabled(name: string): boolean {
    return this.builtinTool.has(name)
  }
}

/** `*` 结尾 = 前缀匹配；否则精确匹配。 */
export function matches(patterns: readonly string[], name: string): boolean {
  for (const pattern of patterns) {
    if (pattern === name) return true
    if (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1))) return true
  }
  return false
}

/** 把一份 kind 配置折叠成 `EffectiveGate`（只处理内置禁用与用户覆盖）。 */
export function buildEffective(kind: ReadonlyAbilityKindSettings, builtin: ReadonlySet<string>): EffectiveGate {
  const global = mergeLayer(builtin, kind.global, builtin)
  const workspaces = new Map<string, ReadonlySet<string>>()
  for (const [workspaceId, layer] of Object.entries(kind.workspaces)) {
    workspaces.set(workspaceId, mergeLayer(global, layer, builtin))
  }
  return { global, workspaces }
}

/** 空的 gate（配置还没到的初始值）。 */
export function emptyGate(): EffectiveGate {
  return { global: new Set<string>(), workspaces: new Map<string, ReadonlySet<string>>() }
}

function mergeLayer(base: ReadonlySet<string>, layer: ReadonlyAbilityLayer, builtin: ReadonlySet<string>): Set<string> {
  const next = new Set(base)
  for (const name of layer.disabled) next.add(name)
  for (const name of layer.enabled) {
    // 内置禁用不可被工作区「捞回」
    if (builtin.has(name)) continue
    next.delete(name)
  }
  return next
}
/**
 * 逐名降级地应用 `tools.restrict`，返回**藏不掉**的名字。
 *
 * 为什么不能一次传整批：`restrict({ deny })` 只要有一个名字不在
 * `view(scope).restrictableNames` 里就**整体抛错**（`tools/src/index.ts:1114-1118`），
 * 而这个集合只含「继承层」的名字——agent 自己那一层注册的工具（`subagent`、
 * `subagent_fork` 这类按 agent 注册的）不在其中，虽然它们对模型可见、却无法被
 * restrict 摘掉。整批调用因此会被一个坏名字毒死，连能藏的也一起放弃。
 *
 * 策略：先整批试（常见情况一次成功、只留一条 restriction），失败再逐名重试。
 * 藏不掉的名字返回给调用方记日志——它们仍由 guard 在执行期拒绝。
 * @param restrict - 真正调用 `tools.restrict` 的薄封装（注入以便单测）
 * @param names - 目标 deny 名单
 * @returns 无法 restrict 的名字（已被 guard 兜底）
 */
export function restrictWithFallback(
  restrict: (names: string[]) => void,
  names: readonly string[],
): string[] {
  if (names.length === 0) return []
  try {
    restrict([...names])
    return []
  } catch {
    // 整批被拒：逐名重试，能藏几个藏几个
  }
  const skipped: string[] = []
  for (const name of names) {
    try {
      restrict([name])
    } catch {
      skipped.push(name)
    }
  }
  return skipped
}
/**
 * 「藏不掉、只能拒」的工具该在系统提示词里怎么讲。
 *
 * 对应设计里的第三层兜底：`tools.restrict` 摘不掉 agent 自有层注册的工具
 * （`view()` 对 own 层不参与过滤），guard 会在执行期拒绝，但模型仍看得到
 * 工具定义、会白调一轮。这条提示紧跟工具描述之后，明确告诉它不要调。
 * @param names - 本次无法 restrict 的禁用工具名
 * @returns 提示段文本；名字为空时返回空串（调用方据此跳过注入）
 */
export function disabledToolsNotice(names: readonly string[]): string {
  if (names.length === 0) return ''
  return 'The following tools are disabled by settings and cannot be removed from the tool list: '
    + `${[...names].join(', ')}. Do not call them: every call is rejected before execution. `
    + 'If you need one of them, ask the user to enable it in Settings → 能力管理.'
}