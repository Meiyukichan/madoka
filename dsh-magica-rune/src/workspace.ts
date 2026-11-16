/**
 * 工作区索引：`agent/created` → `Map<agentId, workspaceId>`。
 *
 * 解析走 0.2 原生 API `workspaceRegistry.resolveByPath()`
 * （`packages/workspace/workspace/src/index.ts:493-506`），它内部做 `fs.realpath`
 * 归一，所以不需要手写 `realpathSync` + 大小写归一。
 *
 * 两条不变量：
 * - 映射**按解析结果覆写**：解析成功则 `set`，解析不出（`cwd` 为空 / registry 未就绪 /
 *   `realpath` 抛错 / 不是已注册工作区根）则 `delete`；只有 `agent/disposed` 才无条件清理。
 *   解析不出时 `state.workspaceOf` 返回 undefined，门禁与 restrict 会**回退到全局层** ——
 *   这是设计意图（不是工作区根的会话不套用工作区级策略），不是丢数据。
 * - 处理器绝不 throw：`agent/created` 是 serial 监听器，throw 会让 agent 创建失败。
 * @module dsh-magica-rune/workspace
 */

import { normalize } from 'node:path'
import type { DshContext, DshWorkspaceRegistry, AgentCreatedPayload, AgentDisposedPayload } from './shared/dsh.ts'
import type { GuardState } from './state.ts'

/** 纯字符串归一（不碰文件系统；物理 canon 由 dsh registry 唯一负责）。 */
export function normalizeProjectPath(input: string): string {
  const normalized = normalize(input)
  if (normalized.length > 1 && (normalized.endsWith('\\') || normalized.endsWith('/'))) {
    return normalized.slice(0, -1)
  }
  return normalized
}

/**
 * 由 cwd 解析 workspaceId。
 * registry 缺失 → undefined（headless / 测试部署降级为「只按全局」）。
 * 路径不存在时 `resolveByPath` 会 reject → 这里吞掉返回 undefined。
 */
export async function resolveWorkspaceId(ctx: DshContext, cwd: string): Promise<string | undefined> {
  if (cwd === '') return undefined
  const registry = ctx.get<DshWorkspaceRegistry>('workspaceRegistry')
  if (registry === undefined) return undefined
  try {
    const workspace = await registry.resolveByPath(normalizeProjectPath(cwd))
    return workspace?.id
  } catch {
    return undefined
  }
}

/**
 * 安装 workspace 索引。
 *
 * ⚠️ 两个必须遵守的点：
 * 1. `agent/created` 的载荷是 `{ agent, source, signal }` **对象**，必须解构；
 *    拿错会让 `agent.id` 为 undefined，工作区策略静默失效。
 * 2. 处理器**绝不 throw**：`agent/created` 是 serial 监听器，throw 会让 agent 创建失败。
 */

export function installWorkspaceIndex(ctx: DshContext, state: GuardState): () => void {
  return ctx.effect(() => {
    const offCreated = ctx.on('agent/created', async (...args: unknown[]) => {
      const payload = args[0] as AgentCreatedPayload
      const agent = payload?.agent
      if (agent === undefined) return
      const agentId = String(agent.id)
      try {
        const cwd = agent.session.header.cwd
        const workspaceId = cwd === undefined || cwd === '' ? undefined : await resolveWorkspaceId(ctx, cwd)
        if (workspaceId === undefined) state.agentWorkspace.delete(agentId)
        else state.agentWorkspace.set(agentId, workspaceId)
      } catch (error) {
        state.agentWorkspace.delete(agentId)
        ctx.logger.warn(`[rune] workspace resolve failed for agent ${agentId}: ${String(error)}`)
      }
    })
    const offDisposed = ctx.on('agent/disposed', (...args: unknown[]) => {
      const payload = args[0] as AgentDisposedPayload
      if (payload?.agent !== undefined) state.agentWorkspace.delete(String(payload.agent.id))
    })
    return () => { offCreated(); offDisposed() }
  }, 'dsh-magica-rune: workspace index')
}
