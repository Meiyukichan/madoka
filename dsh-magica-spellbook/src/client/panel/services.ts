/**
 * 客户端 context 的服务取用（纯 TS，**不 import 任何 `.tsx`**）。
 *
 * 抽出来的原因：装配代码在 `surface.ts`（依赖 `Composer.tsx`），而 Node 的测试进程
 * 不能 import `.tsx`，导致"属性回退是否安全"这类关键韧性没有可测入口。
 *
 * 三个服务面**都是 dsh 的真实类型**：
 * - {@link InteractionScopeFace} = cordis `Context`（`dsh-client-ui-renderer` / `ui-session` /
 *   `ui-conversation` 的声明合并已经把 `ctx.slots`、`ctx.uiSession` 与
 *   `SlotMap['conversation.composer']` 合进来）；
 * - {@link UiSessionFace} = `dsh-client-ui-session` 的 `UiSession`；
 * - {@link SlotsFace} = `dsh-client-ui-renderer` 的 `SlotRegistry`。
 *
 * @module dsh-magica-spellbook/client/panel/services
 */

import type { Context } from '@deepseek-ai/cordis'
import type { UiSession } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'

/** 客户端 context（cordis 的真实 `Context`）。 */
export type InteractionScopeFace = Context

/** `uiSession`（会话 UI 状态与被控注册表）。 */
export type UiSessionFace = UiSession

/** `slots`（slot 注册表）。 */
export type SlotsFace = SlotRegistry

/**
 * 取服务：先 `ctx.get(name)`，再退到属性访问。
 *
 * 两条路径都**必须**包 try/catch：未在 `inject` 里声明的服务，属性访问会抛；
 * 一次漏 catch 就会让整个接管装配崩掉（真机表现为"卡片整片消失"）。
 *
 * @param scope - 客户端 context。
 * @param name - 服务名。
 * @returns 服务实例，取不到时 `undefined`。
 */
export function serviceOf<T>(scope: InteractionScopeFace, name: string): T | undefined {
  if (typeof scope.get === 'function') {
    try {
      const value: unknown = scope.get(name)
      if (value !== undefined && value !== null) return value as T
    } catch {
      // 未注册：退回属性访问
    }
  }
  try {
    // `Context` 是代理，服务是**动态属性**：类型上不可枚举，只能运行时读。
    const direct: unknown = Reflect.get(scope, name)
    return direct === undefined || direct === null ? undefined : (direct as T)
  } catch {
    return undefined
  }
}
