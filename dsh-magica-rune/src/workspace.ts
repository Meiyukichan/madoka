/**
 * 工作区索引：`agent/created` → `Map<agentId, workspaceId>`。
 *
 * 解析走 0.2 原生 API `workspaceRegistry.resolveByPath()`
 * （`packages/workspace/workspace/src/index.ts:493-506`），它内部做 `fs.realpath`
 * 归一，所以不需要手写 `realpathSync` + 大小写归一。
 *
 * 两条不变量：
 * - 映射**只增不删**（除 `agent/disposed`）：解析失败时保留上一次结果，
 *   否则 guard / restrict 会回退到「只看全局层」，静默丢掉工作区级禁用。
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
