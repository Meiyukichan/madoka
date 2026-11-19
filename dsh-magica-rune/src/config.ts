/**
 * 插件 Config schema（**替代** 0.1.2 的 `settings.register(ns, schema)` 写法）。
 *
 * 五个 volatile 字段，缺一不可（否则 settings 写不进来，
 * `packages/settings/settings/src/index.ts:385-389`；且配置改动会 remount 插件）：
 * - `tools` / `skills`：用户的开关键（全局 + 按工作区）
 * - `builtinDisabled` / `nonDisableable` / `skillNonDisableable`：三张内置名单
 *
 * ⚠️ `.volatile()` **不能**出现在 dict / array 内部
 * （`vendor/schemastery/src/index.ts:488-509`），所以：
 * - 固定路径上的对象/数组整体标 `.volatile()` 是**合法**的；
 * - 但 `tools.workspaces`（dict）的**值**里不能再标 volatile。
 * @module dsh-magica-rune/config
 */

import z from '@deepseek-ai/schemastery'
import type { VolatileRef } from './shared/dsh.ts'
import type { ReadonlyAbilityKindSettings } from './shared/ability.ts'
import {
  DEFAULT_SKILL_NON_DISABLEABLE,
  DEFAULT_TOOL_BUILTIN_DISABLED,
  DEFAULT_TOOL_NON_DISABLEABLE,
} from './policy.ts'

/** 一层（不标 volatile —— 它可能位于 dict 内部）。 */
const layer = () => z.object({
  disabled: z.array(z.string()).default([]),
  enabled: z.array(z.string()).default([]),
})

/** 一个 kind：volatile 落在这个固定路径的对象上。 */
const kind = () => z.object({
  global: layer().default({ disabled: [], enabled: [] }),
  workspaces: z.dict(layer()).default({}),
}).default({ global: { disabled: [], enabled: [] }, workspaces: {} }).volatile()

export interface Config {
  tools: VolatileRef<ReadonlyAbilityKindSettings>
  skills: VolatileRef<ReadonlyAbilityKindSettings>
  builtinDisabled: VolatileRef<string[]>
  nonDisableable: VolatileRef<string[]>
  skillNonDisableable: VolatileRef<string[]>
  /** 「连续工具调用无文本输出」提醒（普通配置，不进设置页）。 */
  nudge: NudgeConfig
}

/** 提醒的配置形状。 */
export interface NudgeConfig {
  /** 关掉后完全不计数、不提醒。 */
  enabled: boolean
  /** 连续多少次工具调用触发一次（默认 15）。 */
  everyToolCalls: number
  /** 距上次提醒再隔多少次才允许再提醒（默认 15）。 */
  remindEvery: number
  /** 子代理（含 fork）不提醒。 */
  skipSubagents: boolean
}

/** 名单字段：数组整体 volatile（固定路径，合法）。 */
const nameList = (defaults: readonly string[]) => z.array(z.string()).default([...defaults]).volatile()

export const Config: z<Config> = z.object({
  tools: kind(),
  skills: kind(),
  builtinDisabled: nameList(DEFAULT_TOOL_BUILTIN_DISABLED),
  nonDisableable: nameList(DEFAULT_TOOL_NON_DISABLEABLE),
  skillNonDisableable: nameList(DEFAULT_SKILL_NON_DISABLEABLE),
  // 整段标 volatile：通用设置页要能即时改 everyToolCalls（settings.update 只写 volatile 字段）。
  nudge: z.object({
    enabled: z.boolean().default(true),
    everyToolCalls: z.number().default(15),
    remindEvery: z.number().default(15),
    skipSubagents: z.boolean().default(true),
  }).default({ enabled: true, everyToolCalls: 15, remindEvery: 15, skipSubagents: true }).volatile(),
}) as unknown as z<Config>

/** 从 live config 取一份不可变快照。 */
export function readConfig(config: Config): {
  tools: ReadonlyAbilityKindSettings
  skills: ReadonlyAbilityKindSettings
  builtinDisabled: readonly string[]
  nonDisableable: readonly string[]
  skillNonDisableable: readonly string[]
  nudge: Readonly<NudgeConfig>
} {
  return {
    tools: config.tools.get(),
    skills: config.skills.get(),
    builtinDisabled: config.builtinDisabled.get(),
    nonDisableable: config.nonDisableable.get(),
    skillNonDisableable: config.skillNonDisableable.get(),
    nudge: config.nudge,
  }
}
