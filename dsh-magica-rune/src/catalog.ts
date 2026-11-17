/**
 * 目录 HTTP：`GET /rune-ability/catalog`。
 *
 * 为什么用 HTTP 而不是 Typert Remote：`ctx.remote.<ns>` 需要 Typert 生成物
 * （`@Remote` 装饰 + codegen），那是 monorepo 内建能力；本包在仓库外，
 * `webServer.register` 是 Service 目录里公开稳定的原生 API
 * （`packages/host/webserver/src/index.ts:42-48, 160-173`），零 codegen 依赖。
 * 配置读写不自己造 —— 直接用 shell 已生成的 `ctx.remote.settings`。
 *
 * 数据源要点：
 * - `tools` 取自 `state.internalTools`（**restrict 之前**的快照，只增不减）。
 *   不能用 `tools.schemas()`（无参只有 global 层，会漏掉 preset 挂在 agent 平面的工具）。
 * - `skills` 两段式：global 层拿原始 description，再叠加 agent 层与本地缓存
 *   （preset 才有本地 provider，`snapshot({scope:undefined})` 拿不到 preset skill）。
 * @module dsh-magica-rune/catalog
 */

import type {
  DshAgent, DshContext, DshSkills, DshWorkspace, DshWorkspaceRegistry, SkillSummary,
  AgentCreatedPayload,
} from './shared/dsh.ts'
import type { GuardState } from './state.ts'
import { CATALOG_PATH, ABILITY_NS } from './namespace.ts'
import { sendJson, sendMethodNotAllowed } from './router.ts'

/** 单段 snapshot 的超时，防止 provider 挂起把请求拖死。 */
const SNAPSHOT_TIMEOUT_MS = 2000

export function installCatalog(ctx: DshContext, state: GuardState): () => void {
  // 记住最近一个 live agent：snapshot 的 scope 需要一个 agent 实例。
  const liveAgents = new Map<string, DshAgent>()

  const disposeListeners = ctx.effect(() => {
    const offCreated = ctx.on('agent/created', (...args: unknown[]) => {
      const payload = args[0] as AgentCreatedPayload
      if (payload?.agent !== undefined) liveAgents.set(String(payload.agent.id), payload.agent)
    })
    const offDisposed = ctx.on('agent/disposed', (...args: unknown[]) => {
      const payload = args[0] as { agent?: DshAgent }
      if (payload?.agent !== undefined) liveAgents.delete(String(payload.agent.id))
    })
    return () => { offCreated(); offDisposed(); liveAgents.clear() }
  }, 'dsh-magica-rune: catalog agents')

  const disposeRoute = ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CATALOG_PATH,
    async handler(req, res) {
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      try {
        // 读取时**刷新一次**工具快照，取「全局层 ∪ 所有 live agent 视图」的并集：
        // - 全局层：`tools.schemas()` 无参视图，覆盖 dsh-base 直接挂的工具；
        //   进程刚起、还没有任何 agent 时也能列出东西（否则设置页是空的）。
        // - 每个 live agent：补上 **agent 预设** 挂在自己平面的工具。不同预设的工具集
        //   不同（例：创造模式才有 `cordis_inspect_*` / `plugin_manager`），所以必须
        //   遍历全部 live agent，不能只取一个 —— 否则换个预设打开会话就会发现页面少了工具。
        // 快照语义是「只增不减」，被 restrict 掉的名字不会让已有条目消失。
        state.updateInternalTools(readTools(ctx))
        for (const agent of liveAgents.values()) state.updateInternalTools(readTools(ctx, agent))
        // 兜底：配置里已禁用、但当前视图看不到的工具（重挂后快照为空 / 被 mask 摘掉）
        state.updateInternalTools(state.allDeniedNames().map(name => ({ name, description: '' })))

        const payload = {
          ns: ABILITY_NS,
          // 受保护（`toolProtected`）的名字**不下发**：UI 不该出现一个点了没用的开关。
          // 典型例子是 `run_code`——它在 ptc 模式下确实会进 `tools.schemas(agent)`
          // （`packages/core/tools/src/index.ts:1215-1217` 在能力过滤之外插入），
          // 但 guard 会放行、restrict 会跳过，所以它不是一个可切换的能力。
          tools: [...state.internalTools.values()]
            .filter(entry => !state.policy.toolProtected(entry.name))
            .sort((a, b) => a.name.localeCompare(b.name)),
          skills: await collectSkills(ctx, state, firstAgent(liveAgents)),
          workspaces: collectWorkspaces(ctx),
          // 名单仍然下发：builtin 徽章与 UI 侧二次过滤都要用
          builtinDisabled: [...state.policy.builtinTool].sort(),
          nonDisableable: [...state.policy.toolNonDisableable],
          skillNonDisableable: [...state.policy.skillNonDisableable],
        }
        sendJson(res, 200, payload)
      } catch (error) {
        ctx.logger.warn(`[rune] catalog failed: ${String(error)}`)
        if (!res.headersSent) sendJson(res, 500, { error: 'catalog failed' })
      }
    },
  }), 'dsh-magica-rune: catalog route')

  return () => { disposeRoute(); disposeListeners() }
}

function firstAgent(agents: Map<string, DshAgent>): DshAgent | undefined {
  for (const agent of agents.values()) return agent
  return undefined
}

/** agent 可见的工具（省略 agent 时取全局层视图）。 */
function readTools(ctx: DshContext, agent?: DshAgent): Array<{ name: string; description: string }> {
  try {
    const schemas = agent === undefined ? (ctx.tools.schemas() ?? []) : (ctx.tools.schemas(agent) ?? [])
    return schemas.map(schema => ({
      name: String(schema.name),
      description: schema.description ?? '',
    }))
  } catch {
    return []
  }
}

export async function collectSkills(
  ctx: DshContext, state: GuardState, agent: DshAgent | undefined,
): Promise<Array<{ name: string; description: string; source?: string }>> {
  const skills = ctx.get<DshSkills>('skills')
  if (skills === undefined) return []

  // cwd 必须传给 provider：项目级 skill 的 provider 只按 cwd 枚举（`SkillLookupOptions.cwd`，
  // `packages/skill/skill/src/index.ts:102-108`）；官方 `tool-skill` 也是这么传的
  // （`:222` `snapshot({ cwd: agent.session.header.cwd, signal, scope: agent })`）。
  // 不传的后果：这些 skill 在目录里**永远不出现**（不是"晚一点出现"）。
  let cwd: string | undefined
  try {
    cwd = agent?.session?.header?.cwd
  } catch {
    cwd = undefined
  }
  const lookup = cwd === undefined || cwd === '' ? {} : { cwd }

  // ① global 层：拿原始 description（不被 agent 层遮蔽成占位符）
  const globalSnapshot = await snapshotOrUndefined(skills, lookup)
  if (globalSnapshot !== undefined) state.updateSkillDesc(globalSnapshot)

  // ② agent 层：补充 preset provider 发现的、global 视图里没有的项
  const scopedSnapshot = agent === undefined
    ? undefined
    : await snapshotOrUndefined(skills, { scope: agent, ...lookup })
  if (scopedSnapshot !== undefined) state.updateSkillDesc(scopedSnapshot)

  // ③ 合并：global 优先（原始 desc），agent 补缺，最后填本地缓存里被遮蔽掉的那些
  const merged = new Map<string, { name: string; description: string; source?: string }>()
  for (const summary of globalSnapshot ?? []) merged.set(summary.name, toEntry(summary))
  for (const summary of scopedSnapshot ?? []) if (!merged.has(summary.name)) merged.set(summary.name, toEntry(summary))
  for (const [name, entry] of state.skillDescCache) if (!merged.has(name)) merged.set(name, entry)
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function snapshotOrUndefined(
  skills: DshSkills, options: { scope?: object; cwd?: string },
): Promise<SkillSummary[] | undefined> {
  try {
    // 收集期发生并发改版时 `complete === false`；这一轮仍可用已有结果，
    // 下一轮 pre-step 的 snapshot 会自愈（skill registry 的 pull + digest 机制）。
    const snapshot = await skills.snapshot({ ...options, signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) })
    return snapshot.skills
  } catch {
    return undefined
  }
}

function toEntry(summary: SkillSummary): { name: string; description: string; source?: string } {
  return {
    name: summary.name,
    description: summary.description ?? '',
    ...(summary.source === undefined ? {} : { source: summary.source }),
  }
}

function collectWorkspaces(ctx: DshContext): Array<{ id: string; title: string; path: string }> {
  const registry = ctx.get<DshWorkspaceRegistry>('workspaceRegistry')
  if (registry === undefined) return []
  try {
    return registry.list().map((workspace: DshWorkspace) => ({
      id: String(workspace.id),
      title: workspace.title ?? workspace.path,
      path: workspace.path,
    }))
  } catch {
    return []
  }
}
