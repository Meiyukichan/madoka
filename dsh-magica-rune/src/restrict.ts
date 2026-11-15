/**
 * 辅通道：per-agent `tools.restrict` + `system-prompt/assemble` 过滤（省 token）。
 *
 * 为什么挂在 `createScope(ctx, agent)` 上而不是直接 `agent.ctx`：
 * 0.2 的官方范式（`packages/experimental/browser-use-runtime/src/mcp.ts:108-118`）——
 * 同一 scope key 落**同一层**，但有**独立 dispose 边界**，刷新时只撤这个 scope，
 * 不碰 agent 自身注册、也不会累加 restriction。
 *
 * 三条硬约束（都在源码里）：
 * - `tools.restrict` 必须 scoped，unscoped 直接抛（`packages/core/tools/src/index.ts:1098-1101`）。
 * - 未知名**抛错**（`:1114-1118`），0.2 没有公开的 `restrictableNames` → 只能先用
 *   `tools.schemas(agent)` 的可见名预过滤。
 * - `system-prompt/assemble` 的第三参才是 `next`，且 `next()` **不接参数**
 *   （`packages/core/system-prompt/src/index.ts:19-31`）。
 * @module dsh-magica-rune/restrict
 */

import { createScope as createScopeTyped } from '@deepseek-ai/dsh-scope'
import type {
  AssembledSection, DshAgent, DshContext, DshScope, DshTools, PromptAssembly,
  AgentCreatedPayload, AgentDisposedPayload,
} from './shared/dsh.ts'
import type { GuardState } from './state.ts'

/**
 * `@deepseek-ai/dsh-scope` 的 `createScope` 声明的是**真 Cordis `Context`**，
 * 而本包不依赖 `@deepseek-ai/cordis`（不装、也不 import 它的运行时），
 * 用的是 `shared/dsh.ts` 里的结构性 `DshContext`。这里做一次收窄转换，
 * 而不是到处 `as`：签名说清楚「入参是结构兼容的 ctx、返回本包的 DshScope」。
 */
const createScope = createScopeTyped as unknown as (ctx: DshContext, key: object) => DshScope

/** 对外句柄：配置变更时 `refresh()`，卸载时 `dispose()`。 */
export interface RestrictHandle {
  refresh(): void
  dispose(): void
}

export function installRestrict(ctx: DshContext, state: GuardState): RestrictHandle {
  const masks = new Map<string, DshScope>()
  const liveAgents = new Map<string, DshAgent>()

  /** 把某个 agent 的禁用集落到 schema 视图与提示词段。 */
  const applyTo = (agent: DshAgent): void => {
    const agentId = String(agent.id)
    const tools = ctx.get<DshTools>('tools')
    if (tools === undefined) return

    // ① 先快照（restrict 之前的可见集才是 restrict-free 全量，用于目录 UI）
    try {
      state.updateInternalTools(tools.schemas(agent))
    } catch (error) {
      ctx.logger.warn(`[rune] tool snapshot failed for ${agentId}: ${String(error)}`)
    }

    // ② 撤销旧 mask（独立 scope，不动 agent 自己的注册）
    const previous = masks.get(agentId)
    if (previous !== undefined) {
      masks.delete(agentId)
      void previous.dispose()
    }

    // 名单已在 state 里剔除「受保护」的名字，这里拿到的是可以 restrict 的集合
    const denied = state.restrictableNamesFor(agentId)
    if (denied.length === 0) return

    const scope = createScope(ctx, agent)

    // ③ 预过滤未知名字：restrict 对未知名抛错，用「agent 视角可见名」当安全集合
    let visible: Set<string>
    try {
      visible = new Set(tools.schemas(agent).map(schema => schema.name))
    } catch {
      visible = new Set<string>()
    }
    const known = denied.filter(name => visible.has(name))
    if (known.length > 0) {
      try {
        scope.ctx.tools.restrict({ deny: known })
      } catch (error) {
        ctx.logger.warn(`[rune] restrict skipped for ${agentId}: ${String(error)}`)
      }
    }

    // ④ assemble 过滤（省 token）：动态读 state，配置变更无需重挂中间件
    scope.ctx.on('system-prompt/assemble', async (...args: unknown[]) => {
      const next = args[2] as () => Promise<PromptAssembly>
      const result = await next()
      // 上游（next）自己的失败让它继续冒泡——那是 assemble 链的事；
      // 但**我们这段过滤**必须自己兜住（SKILL §2.2：不能有未捕获异常）。
      try {
        const now = state.effectiveNamesFor(agentId)
        if (now.size === 0 || !Array.isArray(result?.sections)) return result
        result.sections = result.sections.filter((section: AssembledSection) => {
          if (!section.name.startsWith('tool:')) return true
          return !now.has(section.name.slice('tool:'.length))
        })
      } catch (error) {
        ctx.logger.warn(`[rune] assemble filter failed for ${agentId}: ${String(error)}`)
      }
      return result
    })

    masks.set(agentId, scope)
  }

  const disposeListeners = ctx.effect(() => {
    const offCreated = ctx.on('agent/created', (...args: unknown[]) => {
      const payload = args[0] as AgentCreatedPayload
      const agent = payload?.agent
      if (agent === undefined) return
      liveAgents.set(String(agent.id), agent)
      try {
        applyTo(agent)
      } catch (error) {
        ctx.logger.warn(`[rune] restrict setup failed for ${String(agent.id)}: ${String(error)}`)
      }
    })
    const offDisposed = ctx.on('agent/disposed', (...args: unknown[]) => {
      const payload = args[0] as AgentDisposedPayload
      if (payload?.agent === undefined) return
      const agentId = String(payload.agent.id)
      liveAgents.delete(agentId)
      const scope = masks.get(agentId)
      masks.delete(agentId)
      void scope?.dispose()
    })
    return () => {
      offCreated(); offDisposed()
      for (const scope of masks.values()) void scope.dispose()
      masks.clear(); liveAgents.clear()
    }
  }, 'dsh-magica-rune: restrict scope')

  return {
    refresh(): void {
      for (const agent of liveAgents.values()) {
        try {
          applyTo(agent)
        } catch (error) {
          ctx.logger.warn(`[rune] restrict refresh failed: ${String(error)}`)
        }
      }
    },
    dispose(): void { disposeListeners() },
  }
}
