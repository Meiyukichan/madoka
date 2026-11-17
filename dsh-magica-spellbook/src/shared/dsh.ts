/**
 * dsh 类型面：**全部直接引用 dsh 包的类型**，这里不手写任何结构镜像。
 *
 * 为什么可以"零运行时依赖"却仍直接引用类型：`import type` 在构建时被完全擦除，
 * 产物里不会出现 `@deepseek-ai/*`（`scripts/verify.mjs` 会断言这一点）；
 * 而类型来自真实包，dsh 升级时 `pnpm typecheck` 直接报错，不会静默漂移。
 *
 * 依赖声明见 package.json：这些包**同时**写在 `devDependencies`（`tsc` 解析用）
 * 与 `peerDependencies`（消费方运行时由宿主提供，语义同 `dsh-magica-lattice`/`rune`）。
 *
 * 唯一"我们产生"的类型是 brand 铸造器（`asSessionId` / `asMessageId` / `asReasoningEffortId` /
 * `asWorkspaceId`）与 {@link MessageSourceMap} 的生产者声明：
 * dsh 的 brand 函数是**值**（`SessionId()` 等），本包运行时零 dsh 导入，所以只能在**一个**
 * 地方把它们摊平（品牌在运行时是 no-op，等价于 dsh 自己的铸造函数）；
 * 而 `MessageSourceMap` 本来就是 dsh 官方文档要求生产者用声明合并登记的扩展点。
 *
 * @module dsh-magica-spellbook/shared/dsh
 */

import type { Context, EventOptions, LoggerService } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentCancelCause,
  AgentHandle,
  AgentOptions,
  AgentRegistry,
  AgentSetup,
  AgentSetupCommit,
  CancelOptions,
  CreateAgentOptions,
  PreStepDecision,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { ContextSnapshotSection, MessageId } from '@deepseek-ai/dsh-llm'
import type { PermissionPresetService, PresetSpec } from '@deepseek-ai/dsh-permission-presets'
import type {
  Session,
  SessionEvent,
  SessionEventMap,
  SessionId,
  TurnEndReason,
  UserMessage,
} from '@deepseek-ai/dsh-session'
import type { SessionTitleService } from '@deepseek-ai/dsh-session-title'
import type { Workspace, WorkspaceId, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
// 以下都是**只为声明合并**而 import 的类型空导入：
// 少了它们，`SessionEventMap` / cordis `Events` 里就没有对应分支，`tsc` 会直接在
// `session/event` 的 switch 与 `ctx.on('sandbox/mode', ...)` 上报错。
import type {} from '@deepseek-ai/dsh-agent' // cordis Events：agent/created、agent/disposed …
import type {} from '@deepseek-ai/dsh-plan-mode' // SessionEventMap：plan/mode
import type {} from '@deepseek-ai/dsh-sandbox-policy' // SessionEventMap：sandbox/mode
import type {} from '@deepseek-ai/dsh-session' // cordis Events：session/event …
import type {} from '@deepseek-ai/dsh-user-approval' // cordis Events：approval/request；SessionEventMap：approval/*
import type {} from '@deepseek-ai/dsh-user-questions' // cordis Events：user-questions/request

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * spellbook 注入的插件上下文（`agent.inject()` / 会话上下文投递）。
     *
     * dsh 的 `MessageSourceMap` 按**生产者**合并，而我们的生产者是"任意具名 section"：
     * 具体 `kind` 由调用方给的 section 名决定（无名时是 `spellbook-context`），
     * 所以这里只能声明成 `string` —— 这也是运行时事实（dsh 不枚举 user 消息的 `kind`，
     * session format v4 只拒绝已退役的字面量 `plugin`）。段落名同时出现在 `sections` 里，
     * 消费方需要精确定位时读 `sections[].name`。
     */
    'spellbook-context': {
      /** 生产者自有 kind：调用方给的 section 名，无名时是 `spellbook-context`。 */
      kind: string
      /** 注入方包名（表达"谁注入的"）。 */
      plugin: string
      /** 快照形态：一次注入的具名段落。 */
      form: 'snapshot'
      /** 本次注入的具名段落（`name` 与 `kind` 同值）。 */
      sections: readonly ContextSnapshotSection[]
    }
  }
}

// ── brand 铸造器（运行时 no-op，集中一处）────────────────────────
//
// dsh 的 brand 是纯类型标记，铸造函数（`SessionId()` / `MessageId()`）是**值导出**；
// 本包运行时零 `@deepseek-ai/*` 导入，所以在"JSON/调用方字符串 → dsh brand"这一个
// 边界上摊平，等价于 dsh 自己的铸造实现。

/**
 * 把普通字符串认作 dsh 的 `SessionId`。
 * @param id - 会话 id 原文。
 * @returns 同一个字符串，带上 brand。
 */
export function asSessionId(id: string): SessionId {
  return id as SessionId
}

/**
 * 把普通字符串认作 dsh 的 `MessageId`。
 * @param id - 消息 id 原文。
 * @returns 同一个字符串，带上 brand。
 */
export function asMessageId(id: string): MessageId {
  return id as MessageId
}

/** dsh 的 `ReasoningEffortId`（`AgentOptions` 上那个 brand）。 */
export type DshReasoningEffortId = NonNullable<AgentOptions['reasoningEffort']>

/**
 * 把普通字符串认作 dsh 的 `ReasoningEffortId`。
 * @param effort - 路由登记里读到的字符串。
 * @returns 同一个字符串，带上 brand。
 */
export function asReasoningEffortId(effort: string): DshReasoningEffortId {
  return effort as DshReasoningEffortId
}

/** dsh 的 `WorkspaceId`。 */
export type DshWorkspaceId = WorkspaceId

/**
 * 把普通字符串认作 dsh 的 `WorkspaceId`。
 * @param id - 调用方给的 workspace id。
 * @returns 同一个字符串，带上 brand。
 */
export function asWorkspaceId(id: string): DshWorkspaceId {
  return id as WorkspaceId
}

// ── 公开类型别名（名字沿用，形状全部来自 dsh）──────────────────────

/** 会话 id（dsh 的 branded 类型）。 */
export type SessionIdLike = SessionId

/** 日志服务（cordis 的 `ctx.logger`，`warn` 等分级方法齐全）。 */
export type DshLoggerLike = LoggerService

/** dsh 会话。 */
export type DshSessionLike = Session

/** dsh agent 实例。 */
export type DshAgentLike = Agent

/** `agents.create()` / `resume()` 返回的句柄（含 disposer）。 */
export type DshAgentHandleLike = AgentHandle

/** 取消原因（`{ kind: 'user' } | { kind: 'parent' } | { kind: 'hook', reason } | { kind: 'disposed' }`）。 */
export type DshCancelCause = AgentCancelCause

/** `cancel()` 的第二参。 */
export type DshCancelOptions = CancelOptions

/** 本轮结束原因（`turn/end` 的 `reason`，7 种 `kind`）。 */
export type DshTurnEndReason = TurnEndReason

/** 会话事件（dsh 的可合并判别联合）。 */
export type DshSessionEvent = SessionEvent

/** 会话事件表（插件可合并扩展）。 */
export type DshSessionEventMap = SessionEventMap

/** 投给 agent 的用户消息。 */
export type DshUserMessageLike = UserMessage

/** `agent/pre-step` 瀑布的返回值。 */
export type DshPreStepDecision = PreStepDecision

/** setup 的提交回包。 */
export type DshAgentSetupCommit = AgentSetupCommit

/**
 * 创建期的装配回调。
 *
 * 与 dsh 的 {@link AgentSetup} 同源，但本 SDK 在 `composeAgentScope()` 里只转发 `agentCtx`
 * （`agent` 由 dsh 的创建事务自己消费），所以第二参被投影掉——这不是新形状，
 * 只是把真实类型收窄成我们实际提供的调用面。
 */
export type DshAgentSetup = (agentCtx: Parameters<AgentSetup>[0]) => ReturnType<AgentSetup>

/** `agents.create()` 入参。 */
export type DshCreateAgentOptions = CreateAgentOptions

/** `agents.resume()` 入参。 */
export type DshResumeAgentOptions = ResumeAgentOptions

/** 单 agent 选项（model 等）。 */
export type DshAgentOptions = AgentOptions

/** agent 注册表服务（`ctx.agents`）。 */
export type DshAgentRegistryLike = AgentRegistry

/** 权限档位服务（`ctx.permissionPresets`）。 */
export type DshPermissionPresetsLike = PermissionPresetService

/** 沙箱模式（dsh 的 `SandboxMode`，经 `PresetSpec` 转出，避免多引一个包）。 */
export type DshSandboxMode = PresetSpec['sandbox']

/** 审批策略（dsh 的 `ApprovalPolicy`）。 */
export type DshApprovalPolicy = PresetSpec['approval']

/** preset 解析服务（`ctx.agentPresets`）。 */
export type DshAgentPresetsLike = AgentPresetRegistry

/** 标题服务（`ctx.sessionTitle`）。 */
export type DshSessionTitleLike = SessionTitleService

/** 工作区（`ctx.workspaceRegistry.get()` 的返回值）。 */
export type DshWorkspaceLike = Workspace

/** 工作区注册表（`ctx.workspaceRegistry`）。 */
export type DshWorkspaceRegistryLike = WorkspaceRegistry

/** `ctx.on` 的选项（waterfall 抢占用 `{ prepend: true, global: true }`）。 */
export type DshEventOptions = EventOptions

/** 宿主 context（cordis）。 */
export type DshContextLike = Context

/** `$DSH_HOME` 路径解析服务（`@deepseek-ai/dsh-home-paths` 的 `dshHomePath`）。 */
export type DshHomePath = typeof dshHomePath

// ── 运行时辅助（这两条是逻辑，不是类型镜像）──────────────────────

/**
 * 取服务：先 `ctx.get(name)`，再退回属性访问；两条路径都吞异常。
 * @param ctx - cordis context（或它的最小结构面）。
 * @param name - 服务名。
 * @returns 服务或 `undefined`。
 */
export function serviceOf<T>(ctx: unknown, name: string): T | undefined {
  const scope = ctx as { get?: (key: string) => unknown; [key: string]: unknown }
  if (typeof scope.get === 'function') {
    try {
      const value = scope.get(name)
      if (value !== undefined && value !== null) return value as T
    } catch {
      // 未注册：退回属性访问
    }
  }
  try {
    const value = scope[name]
    return value === undefined || value === null ? undefined : (value as T)
  } catch {
    return undefined
  }
}

/**
 * 把副作用登记到 fiber（宿主卸载时自动回收）。
 * @param ctx - cordis context。
 * @param callback - 返回 disposer 的回调。
 * @param label - 诊断标签。
 * @returns 手动解绑函数。
 */
export function effectOf(ctx: unknown, callback: () => unknown, label: string): () => void {
  const scope = ctx as { effect?: (cb: () => unknown, label?: string) => unknown }
  if (typeof scope.effect !== 'function') return () => {}
  try {
    const dispose = scope.effect(callback, label)
    return typeof dispose === 'function' ? (dispose as () => void) : () => {}
  } catch {
    return () => {}
  }
}
