/**
 * skill 运行时遮蔽：在 **agent scope 层** 注册同名 runtime skill，两个 invocation 全 false。
 *
 * 一个 register 覆盖四个消费点（`packages/skill/skill/src/index.ts` + `tool-skill`）：
 * - `skill` 工具 execute 的 `isModelInvocable`（`tool-skill/src/index.ts:138,145`）
 * - `<available_skills>` 注入过滤（`:226`）
 * - 斜杠菜单 `SessionSkillCatalog` 的 `isUserInvocable`（`api/session-controller/src/skill-catalog.ts:62-86`）
 * - `/skill-name` 手势注入（`tool-skill/src/index.ts:195`）
 *
 * ⚠️ **落层是生死线**：跨层 nearest-wins（无视 rank），同层内 rank 小者胜；
 * runtime rank=250，而 project-dsh=100 / project-agents=200。
 * 所以必须用 `agent.ctx.get('skills')` 落 **agent 层**；
 * 注册在 preset / global 层会与 project provider 同层 → 静默漏放（不报错、不 warn）。
 *
 * ⚠️ **必须先 dispose 再 register**：同层同名 runtime 是 first-wins + warn + no-op disposer
 * （`:445-448`），不先清旧的，`register` 会被静默忽略，「启用」操作永远失败。
 * @module dsh-magica-rune/skill-gate
 */

import type { DshAgent, DshContext, DshSkills, AgentCreatedPayload, AgentDisposedPayload } from './shared/dsh.ts'
import type { GuardState } from './state.ts'

/** 对外句柄。 */
export interface SkillGateHandle {
  refresh(): void
  dispose(): void
}

export function installSkillGate(ctx: DshContext, state: GuardState): SkillGateHandle {
  /** agentId → 该 agent 的遮蔽 disposer 列表。 */
  const disposers = new Map<string, Array<() => void>>()
  const liveAgents = new Map<string, DshAgent>()

  const applyTo = (agent: DshAgent): void => {
    const agentId = String(agent.id)

    // ① 先撤旧的（否则同名 register 被 no-op 忽略）
    for (const dispose of disposers.get(agentId) ?? []) {
      try { dispose() } catch { /* 已被回收 */ }
    }
    disposers.set(agentId, [])

    // 名单已在 state 里剔除受保护项
    const denied = state.effectiveSkillNames(agentId)
    if (denied.length === 0) return

    // ② 必须 agent-scoped
    const skills = agent.ctx.get<DshSkills>('skills')
    if (skills === undefined) {
      ctx.logger.warn(`[rune] skills service missing for ${agentId}; skill gate skipped`)
      return
    }

    const mine: Array<() => void> = []
    for (const name of denied) {
      try {
        mine.push(skills.register({
          name,
          description: '(disabled by ability gate)',
          content: '',
          source: 'custom',
          invocation: { modelInvocable: false, userInvocable: false },
        }))
      } catch (error) {
        ctx.logger.warn(`[rune] skill shadow "${name}" failed for ${agentId}: ${String(error)}`)
      }
    }
    disposers.set(agentId, mine)
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
        ctx.logger.warn(`[rune] skill gate setup failed: ${String(error)}`)
      }
    })
    const offDisposed = ctx.on('agent/disposed', (...args: unknown[]) => {
      const payload = args[0] as AgentDisposedPayload
      if (payload?.agent === undefined) return
      const agentId = String(payload.agent.id)
      liveAgents.delete(agentId)
      for (const dispose of disposers.get(agentId) ?? []) {
        try { dispose() } catch { /* 已被回收 */ }
      }
      disposers.delete(agentId)
    })
    return () => {
      offCreated(); offDisposed()
      for (const list of disposers.values()) {
        for (const dispose of list) { try { dispose() } catch { /* 已被回收 */ } }
      }
      disposers.clear(); liveAgents.clear()
    }
  }, 'dsh-magica-rune: skill gate scope')

  return {
    refresh(): void {
      for (const agent of liveAgents.values()) {
        try {
          applyTo(agent)
        } catch (error) {
          ctx.logger.warn(`[rune] skill refresh failed: ${String(error)}`)
        }
      }
    },
    dispose(): void { disposeListeners() },
  }
}
