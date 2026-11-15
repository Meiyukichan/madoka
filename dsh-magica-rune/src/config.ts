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
}

/** 名单字段：数组整体 volatile（固定路径，合法）。 */
const nameList = (defaults: readonly string[]) => z.array(z.string()).default([...defaults]).volatile()

export const Config: z<Config> = z.object({
  tools: kind(),
  skills: kind(),
  builtinDisabled: nameList(DEFAULT_TOOL_BUILTIN_DISABLED),
  nonDisableable: nameList(DEFAULT_TOOL_NON_DISABLEABLE),
  skillNonDisableable: nameList(DEFAULT_SKILL_NON_DISABLEABLE),
}) as unknown as z<Config>

/** 从 live config 取一份不可变快照。 */
export function readConfig(config: Config): {
  tools: ReadonlyAbilityKindSettings
  skills: ReadonlyAbilityKindSettings
  builtinDisabled: readonly string[]
  nonDisableable: readonly string[]
  skillNonDisableable: readonly string[]
} {
  return {
    tools: config.tools.get(),
    skills: config.skills.get(),
    builtinDisabled: config.builtinDisabled.get(),
    nonDisableable: config.nonDisableable.get(),
    skillNonDisableable: config.skillNonDisableable.get(),
  }
}
