/**
 * dsh 0.2.0-rc.2 契约的**结构面**。
 *
 * 为什么不用 `import type { ... } from '@deepseek-ai/dsh-*'`：
 * spellbook 是库不是插件，构建产物必须零运行时 `@deepseek-ai/*` 导入；类型若也来自那些包，
 * 消费方就被迫在 devDependencies 里装一整套 dsh（而它们只用于类型）。这里改成"按源码逐项抄下来的
 * 结构面"，每一处都标了 dsh 源码坐标，源码变动时靠 `docs/design/00-overview.zh.md` §5 的适配矩阵复核。
 *
 * @module dsh-magica-spellbook/shared/dsh
 */

/** 会话 id（dsh 侧是 `Branded<'SessionId'>`，这里退化成 string，只在类型层使用）。 */
export type SessionIdLike = string

/** cordis `LoggerService` 的最小面（`vendor/cordis/src/logger.ts`）。 */
export interface DshLoggerLike {
  warn?(message: string): void
  error?(message: string): void
}

/** `Session`（`packages/core/session/src/index.ts`）的最小面。 */
export interface DshSessionLike {
  readonly id: SessionIdLike
  append(type: string, data?: unknown): unknown
}

/** `Agent`（`packages/core/agent/src/runtime-types.ts:150-242`）的最小面。 */
export interface DshAgentLike {
  readonly id: SessionIdLike
  readonly session: DshSessionLike
  followup(message: DshUserMessageLike): void
  steer(message: DshUserMessageLike): void
  inject(message: DshUserMessageLike): void
  cancel(cause: DshCancelCause, options?: { keepInbox?: boolean }): void
  whenIdle(): Promise<void>
}

/** `AgentHandle`（`packages/core/agent/src/index.ts:160-163`）。 */
export interface DshAgentHandleLike {
  readonly agent: DshAgentLike
  dispose(): Promise<void>
}

/** `AgentCancelCause`（`packages/core/session/src/types.ts:189-193`）。 */
export type DshCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

/** `TurnEndCancelCause`（`packages/core/session/src/types.ts:196`）。 */
export type DshTurnEndCancelCause = DshCancelCause | { readonly kind: 'legacy' }

/**
 * `TurnEndReason`（`packages/core/session/src/types.ts:201-232`）。
 * ⚠️ 0.2 比 0.1.6 多了 `forked` 一档，`TURN_END_KINDS` 必须同步。
 */
export type DshTurnEndReason =
  | { readonly kind: 'completed' }
  | { readonly kind: 'aborted'; readonly reason: DshTurnEndCancelCause }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'error'; readonly error: { readonly message?: string } }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'forked' }

/** `SessionEvent`（`packages/core/session/src/types.ts:434`）；只用到 type/data。 */
export interface DshSessionEvent {
  readonly type: string
  readonly data?: unknown
  readonly time?: number
}

/** `UserMessage`（`packages/llm/llm/src/message.ts:143-145`）。 */
export interface DshUserMessageLike {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: Record<string, unknown>
}

/** `AgentSetupCommit`（`packages/core/agent/src/index.ts:36-43`）。 */
export interface DshAgentSetupCommit {
  commit(): void
}

/** `AgentSetup`（`packages/core/agent/src/index.ts:51-54`，0.2 起是两参）。 */
export type DshAgentSetup = (
  agentCtx: unknown,
  agent?: unknown,
) => DshAgentSetupCommit | Promise<DshAgentSetupCommit | void> | void

/** `CreateAgentOptions` 的最小子集（`packages/core/agent/src/index.ts:63-119`）。 */
export interface DshCreateAgentOptions {
  readonly sessionId: SessionIdLike
  readonly meta?: {
    readonly cwd?: string
    readonly agentPreset?: string
    readonly parentSession?: SessionIdLike
  }
  readonly agentOptions?: DshAgentOptions
  readonly signal?: AbortSignal
  readonly setup?: DshAgentSetup
}

/** `ResumeAgentOptions`（`packages/core/agent/src/index.ts:125-144`）。 */
export interface DshResumeAgentOptions {
  readonly resumeSessionId: SessionIdLike
  readonly agentOptions?: DshAgentOptions
  readonly signal?: AbortSignal
  readonly setup?: DshAgentSetup
}

/** `AgentOptions`（`packages/core/agent/src/runtime-types.ts:26-35`）。 */
export interface DshAgentOptions {
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
}

/** `AgentRegistry`（`packages/core/agent/src/index.ts:249+`）的最小面。 */
export interface DshAgentRegistryLike {
  create(options: DshCreateAgentOptions): Promise<DshAgentHandleLike>
  resume(options: DshResumeAgentOptions): Promise<DshAgentHandleLike>
  get(id: SessionIdLike): DshAgentLike | undefined
}

/** `PermissionPresetService`（`packages/interaction/permission-presets/src/index.ts:162+`）。 */
export interface DshPermissionPresetsLike {
  readonly defaultPreset?: string
  set?(session: DshSessionLike, name: string): void
}

/** `agentPresets` 服务（`packages/preset/agent-presets/src/index.ts:164+`）的最小面。 */
export interface DshAgentPresetsLike {
  readonly defaultId?: string
  mount?(agentCtx: unknown, id?: string): Promise<unknown>
  resolve?(id?: string): Promise<unknown>
}

/** `SessionTitleService`（`packages/session/session-title/src/index.ts:295+`）。 */
export interface DshSessionTitleLike {
  rename?(session: DshSessionLike, title: string): unknown
}

/** `Workspace`（`packages/workspace/workspace/src/entity.ts:69+`）。 */
export interface DshWorkspaceLike {
  readonly id: string
  readonly path?: string
  attachSession?(sessionId: string): Promise<void>
}

/** `WorkspaceRegistry`（`packages/workspace/workspace/src/index.ts:92+`）。 */
export interface DshWorkspaceRegistryLike {
  create(path: string, title?: string): Promise<DshWorkspaceLike>
  resolveByPath(path: string): Promise<DshWorkspaceLike | undefined>
  get(id: string): DshWorkspaceLike | undefined
  list?(): DshWorkspaceLike[]
}

/** 事件监听选项（cordis `EventOptions`）。 */
export interface DshEventOptions {
  prepend?: boolean
  global?: boolean
}

/**
 * 宿主 context 的最小面。库不 `inject`，因此只需要 `get` / `on` / `effect`。
 * `get` 在 0.2 只查 service store（`vendor/cordis/src/reflect.ts`），所以 `logger` 用它取不到。
 */
export interface DshContextLike {
  get(name: string): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 事件参数由各事件自己声明，库内只做结构性读取
  on(event: string, listener: (...args: any[]) => unknown, options?: DshEventOptions): () => void
  effect(callback: () => unknown, label?: string): () => void
  logger?: DshLoggerLike
}

/** `dshHomePath`（`packages/util/home-paths/src/index.ts:98-100`，由 app-boot provide）。 */
export type DshHomePath = (...segments: string[]) => string

/** 从任意 ctx 面里按名字取服务，永不抛错。 */
export function serviceOf<T>(ctx: unknown, name: string): T | undefined {
  if (ctx === null || typeof ctx !== 'object') return undefined
  const candidate = ctx as { get?: (key: string) => unknown }
  if (typeof candidate.get === 'function') {
    try {
      const value = candidate.get(name)
      if (value !== undefined && value !== null) return value as T
    } catch {
      // 服务已 dispose 或未注册：退回到属性访问
    }
  }
  const direct = (ctx as Record<string, unknown>)[name]
  return direct === null ? undefined : (direct as T | undefined)
}

/** `effect` 的最小调用面（缺失时退化为立即执行并返回 noop）。 */
export function effectOf(ctx: unknown, callback: () => unknown, label: string): () => void {
  const candidate = ctx as { effect?: (fn: () => unknown, label?: string) => unknown } | undefined
  if (candidate !== undefined && typeof candidate.effect === 'function') {
    try {
      const disposer = candidate.effect(callback, label)
      if (typeof disposer === 'function') return disposer as () => void
      return () => {}
    } catch {
      // fiber 已 inactive：不登记，直接拿到回调自身的 disposer
    }
  }
  const inner = callback()
  return typeof inner === 'function' ? (inner as () => void) : () => {}
}
