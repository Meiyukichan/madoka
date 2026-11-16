/**
 * 客户端 context 的服务取用（纯 TS，**不 import 任何 `.tsx`**）。
 *
 * 抽出来的原因：装配代码在 `surface.ts`（依赖 `Composer.tsx`），而 Node 的测试进程
 * 不能 import `.tsx`，导致"属性回退是否安全"这类关键韧性没有可测入口。
 *
 * @module dsh-magica-spellbook/client/panel/services
 */

/** 客户端 context 的最小结构面（不 import cordis / dsh 的类型）。 */
export interface InteractionScopeFace {
  get?(name: string): unknown
  effect?(callback: () => unknown, label?: string): unknown
  [key: string]: unknown
}

/** `uiSession` 的最小面。 */
export interface UiSessionFace {
  registerPendingInteraction?<T extends { key: string; kind: string; sessionId: string }>(
    precedence: (interaction: T) => number,
  ): (interaction: T, delegate: () => Promise<void>) => () => void
}

/** `slots` 的最小面。 */
export interface SlotsFace {
  inject?(key: string, callback: () => () => void): () => void
  register?(options: Record<string, unknown>, component: unknown): () => void
}

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
      const value = scope.get(name)
      if (value !== undefined && value !== null) return value as T
    } catch {
      // 未注册：退回属性访问
    }
  }
  try {
    const direct = scope[name]
    return direct === undefined || direct === null ? undefined : (direct as T)
  } catch {
    return undefined
  }
}
