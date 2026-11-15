/**
 * 主通道：`tools.guard`（执行前单调拒绝，权威）。
 *
 * 0.2 语义（`packages/core/tools/src/index.ts:723-731, 1136-1154, 1503-1531`）：
 * - 签名不变：`(exec) => string | undefined`；返回字符串即拒绝。
 * - 在 `tools/pre-execute` waterfall **之后**、tool body **之前**执行。
 * - **单调**：任何 guard 都不能把另一个 guard 的拒绝改回放行 → 强制禁用必须用它。
 * - 全局层先查、再走 scope 链 → 用**插件顶层 ctx**（unscoped）注册即覆盖所有 agent（含子代理）。
 *
 * 体内纪律：只做 Map/Set 查找，永不 throw（throw 会走异常路径，后续 guard 不再执行）。
 * @module dsh-magica-rune/guard
 */

import type { DshContext, ToolExecution } from './shared/dsh.ts'
import type { GuardState } from './state.ts'

/** `skill` 工具的参数名（`packages/skill/tool-skill/src/index.ts:81-161`）。 */
export const SKILL_TOOL_NAME = 'skill'

export function installGuard(ctx: DshContext, state: GuardState): () => void {
  const tools = ctx.get<{ guard: (fn: (exec: ToolExecution) => string | undefined) => () => void }>('tools')
  if (tools === undefined) {
    ctx.logger.warn('[rune] tools service missing; tool gate disabled')
    return () => {}
  }
  return ctx.effect(() => tools.guard((exec) => {
    try {
      const agentId = exec.agent === undefined ? undefined : String(exec.agent.id)

      // ① skill 的**参数级**门禁必须排在「受保护早退」之前。
      //    否则 `skill` 一旦进了 nonDisableable 名单，就再也禁不掉任何单个 skill。
      if (exec.name === SKILL_TOOL_NAME) {
        const name = (exec.arguments as { name?: unknown } | undefined)?.name
        if (typeof name === 'string' && state.isSkillDenied(agentId, name)) {
          return `ability: skill "${name}" is disabled by settings`
        }
        return undefined
      }

      // ② 受保护（含 `run_code` 硬保护）的工具直接放过
      if (state.policy.toolProtected(exec.name)) return undefined

      // ③ 工具名门禁
      if (state.denied(agentId, exec.name)) {
        return `ability: tool "${exec.name}" is disabled by settings`
      }
      return undefined
    } catch (error) {
      ctx.logger.warn(`[rune] guard failed: ${String(error)}`)
      return undefined
    }
  }), 'dsh-magica-rune: tool guard')
}
