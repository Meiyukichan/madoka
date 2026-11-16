/**
 * 模块级 runtime：槽位组件读它拿 `t` 与 `actions`。
 *
 * `install` / `release` **刻意不从包入口导出**：装配权只归 `surface.ts`；
 * 对外暴露会让第三方绕过 surface 覆盖，并误用 release 的身份比对语义。
 *
 * @module dsh-magica-spellbook/client/panel/runtime
 */

import type { InteractionActions } from './carrier.ts'
import type { InteractionTranslate } from './locales.ts'

/** 卡片渲染需要的外部输入。 */
export interface InteractionRuntime {
  t: InteractionTranslate
  actions: InteractionActions
}

let current: InteractionRuntime | undefined

/** 装 runtime（仅 surface 调用）。 */
export function installInteractionRuntime(next: InteractionRuntime): void {
  current = next
}

/** 读当前 runtime（槽位组件用）。 */
export function interactionRuntime(): InteractionRuntime | undefined {
  return current
}

/** 摘 runtime（只在 `current === candidate` 时清空，热重载不误清新装的那份）。 */
export function releaseInteractionRuntime(candidate: InteractionRuntime): void {
  if (current === candidate) current = undefined
}
