/**
 * 门禁状态：guard / restrict / skill 遮蔽三个热路径共用的唯一数据源。
 *
 * 约束：
 * - **零 I/O**、O(1)、永不 throw（guard 体内纪律）。
 * - `sync()` 只替换字段，**不替换实例**，所以 guard 闭包不需要重挂。
 * @module dsh-magica-rune/state
 */

import type { ReadonlyAbilityKindSettings } from './shared/ability.ts'
import type { SkillSummary } from './shared/dsh.ts'
import { Policy, buildEffective, emptyGate, type EffectiveGate } from './policy.ts'

/** 目录里的一行工具。 */
export interface ToolCatalogEntry {
  name: string
  description: string
}

/** 目录里的一行技能。 */
export interface SkillCatalogEntry {
  name: string
  description: string
  source?: string
}

/** `sync()` 的输入：配置快照。 */
export interface StateInput {
  tools: ReadonlyAbilityKindSettings
  skills: ReadonlyAbilityKindSettings
  builtinDisabled: readonly string[]
  nonDisableable: readonly string[]
  skillNonDisableable: readonly string[]
}

export class GuardState {
  /** 名单匹配器（`run_code` 的硬保护在 Policy 内部，与配置无关）。 */
  policy: Policy = new Policy({
    toolBuiltin: [], toolNonDisableable: [], skillNonDisableable: [],
  })

  /** 工具门禁（只反映配置，保护名单在查询期剔除）。 */
  gate: EffectiveGate = emptyGate()
  /** 技能门禁（无内置禁用）。 */
  skillGate: EffectiveGate = emptyGate()

  /** agentId(string) → workspaceId。只由 workspace.ts 在 agent/created 写入。 */
  readonly agentWorkspace = new Map<string, string>()
  /** restrict 之前的全量工具快照；**只增不减**，这样被禁工具在 UI 仍可见。 */
  readonly internalTools = new Map<string, ToolCatalogEntry>()
  /** 遮蔽之前的 skill 原始 description 缓存；同样只增不减。 */
  readonly skillDescCache = new Map<string, SkillCatalogEntry>()

  /** 配置变更时整体重建名单与两份 gate。 */
  sync(input: StateInput): void {
    this.policy = new Policy({
      toolBuiltin: input.builtinDisabled,
      toolNonDisableable: input.nonDisableable,
      skillNonDisableable: input.skillNonDisableable,
    })
    this.gate = buildEffective(input.tools, this.policy.builtinTool)
    this.skillGate = buildEffective(input.skills, new Set<string>())
  }

  /** 工具目录（只增不减 + 描述变化时更新）。 */
  updateInternalTools(entries: readonly { name: string; description?: string }[]): void {
    for (const entry of entries) {
      const description = entry.description ?? ''
      const previous = this.internalTools.get(entry.name)
      if (previous === undefined || previous.description !== description) {
        this.internalTools.set(entry.name, { name: entry.name, description })
      }
    }
  }

  /** 缓存 skill 原始描述（只增不减）。 */
  updateSkillDesc(entries: readonly SkillSummary[]): void {
    for (const entry of entries) {
      if (this.skillDescCache.has(entry.name)) continue
      this.skillDescCache.set(entry.name, {
        name: entry.name,
        description: entry.description ?? '',
        ...(entry.source === undefined ? {} : { source: entry.source }),
      })
    }
  }

  /** guard 热路径：该 agent 是否禁用该**工具名**。受保护的名字恒 false。 */
  denied(agentId: string | undefined, name: string): boolean {
    if (this.policy.toolProtected(name)) return false
    return resolve(this.gate, this.workspaceOf(agentId)).has(name)
  }

  /** guard 热路径：该 agent 是否禁用该 **skill 名**。受保护恒 false。 */
  isSkillDenied(agentId: string | undefined, name: string): boolean {
    if (this.policy.skillProtected(name)) return false
    return resolve(this.skillGate, this.workspaceOf(agentId)).has(name)
  }

  /** restrict 用：该 agent 当前生效、**且允许 restrict** 的工具禁用集。 */
  restrictableNamesFor(agentId: string | undefined): string[] {
    const names: string[] = []
    for (const name of resolve(this.gate, this.workspaceOf(agentId))) {
      if (this.policy.toolProtected(name)) continue
      names.push(name)
    }
    return names
  }

  /** assemble 过滤用：该 agent 当前生效的工具禁用集（与 restrict 同源）。 */
  effectiveNamesFor(agentId: string | undefined): ReadonlySet<string> {
    return new Set(this.restrictableNamesFor(agentId))
  }

  /** skill 遮蔽用：该 agent 当前生效的技能禁用集。 */
  effectiveSkillNames(agentId: string | undefined): string[] {
    const names: string[] = []
    for (const name of resolve(this.skillGate, this.workspaceOf(agentId))) {
      if (this.policy.skillProtected(name)) continue
      names.push(name)
    }
    return names
  }

  /**
   * 配置里**被禁用**的全部工具名（全局 ∪ 每个工作区）。
   *
   * 用途：目录接口的兜底。插件在 0.2.1 上会因配置写入而重挂，重挂后 `internalTools`
   * 快照是空的，而 `tools.schemas()` 此时已经是**受限视图**——被禁用的名字看不到。
   * 少了这层兜底，用户在 UI 上禁用某工具后它就**从列表里消失**，再也点不回来。
   */
  allDeniedNames(): string[] {
    const names = new Set<string>(resolve(this.gate, undefined))
    for (const workspaceId of this.gate.workspaces.keys()) {
      for (const name of resolve(this.gate, workspaceId)) names.add(name)
    }
    return [...names]
  }
  private workspaceOf(agentId: string | undefined): string | undefined {
    return agentId === undefined ? undefined : this.agentWorkspace.get(agentId)
  }
}

function resolve(gate: EffectiveGate, workspaceId: string | undefined): ReadonlySet<string> {
  if (workspaceId === undefined) return gate.global
  return gate.workspaces.get(workspaceId) ?? gate.global
}
