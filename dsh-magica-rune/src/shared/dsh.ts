/**
 * 本包用到的 dsh 运行时表面的**结构性声明**。
 *
 * 为什么不用 `Context` 直接贯穿所有函数：本包只需要 Cordis Context 的一个子集，
 * 收敛成结构接口可以让测试构造最小假上下文，也不会把 cordis 的泛型/服务增强
 * 泄漏到插件内部 API。
 *
 * 但结构不能凭空手写：下面的 `_DshContextMatchesRuntime` 在编译期要求真实的
 * `Context` 必须满足 `DshContext`。dsh 0.2.1-rc.5 的 API 一变，这里就会红。
 * @module dsh-magica-rune/shared/dsh
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

/** `@deepseek-ai/cosmokit` 的 `Volatile<T>`：只读引用，值由 loader 原地更新。 */
export interface VolatileRef<T> {
  get(): T
}

/** cordis logger（`ctx.logger`）。 */
export interface DshLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}

/**
 * cordis `Context` 的子集。
 * `effect(cb, label)` 的 cb 返回 disposer；`on` 返回 disposer；
 * `get(name)` 取可选 service 且可能 undefined（AGENTS §二.4）。
 */
export interface DshContext {
  get<T = unknown>(name: string): T | undefined
  /**
   * 事件订阅。载荷按事件名不同，这里不逐一建模：listener 形参是 `unknown[]`，
   * 由调用方按事件契约 `args[0] as XxxPayload` 收窄。
   *
   * 注意**不能**写 `never[]`：在 `noUncheckedIndexedAccess` 下 `args[0]` 会变成
   * `never | undefined`，`as XxxPayload` 直接被 TS 判为「类型不重叠」（TS2352）。
   */
  on(event: string, listener: (...args: unknown[]) => unknown): () => void
  effect(callback: () => (() => unknown) | Iterable<() => unknown>, label?: string): () => void
  inject(deps: readonly string[], callback: (ctx: DshContext) => void): void
  readonly logger: DshLogger
  readonly fiber: unknown
  readonly tools: DshTools
  readonly webServer: DshWebServer
  readonly systemPrompt: DshSystemPrompt
}

/** `tools.schemas()` 的元素（`packages/core/tools/src/index.ts:1282-1294`）。 */
export interface ToolSchema {
  readonly name: string
  readonly description?: string
}

/** guard 看到的执行体（`packages/core/tools/src/index.ts:326-352, 393-398`）。 */
export interface ToolExecution {
  readonly name: string
  readonly arguments: unknown
  readonly agent?: DshAgent
}

/** 单调拒绝：返回 reason 即拒绝（`:723-731`）。 */
export type ToolGuard = (exec: ToolExecution) => string | undefined

/** 视图过滤（`:696-705`）。 */
export interface ToolRestriction {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

/** `ctx.tools`（`:1097-1262`）。 */
export interface DshTools {
  guard(guard: ToolGuard): () => void
  restrict(filter: ToolRestriction): () => void
  schemas(scope?: object): ToolSchema[]
  get(name: string, scope?: object): unknown
}

/** `SkillInvocationPolicy`（`packages/skill/skill/src/index.ts:48-54`）。 */
export interface SkillInvocationPolicy {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

/** `SkillRegistration`（`:94-100`）：source 必填、description 非空。 */
export interface SkillRegistration {
  readonly name: string
  readonly description: string
  readonly content: string
  readonly source: string
  readonly invocation?: SkillInvocationPolicy
  readonly provider?: string
}

/** `SkillSummary` 的最小子集。 */
export interface SkillSummary {
  readonly name: string
  readonly description?: string
  readonly source?: string
  readonly invocation?: SkillInvocationPolicy
}

/** `SkillCatalogSnapshot`（`:231-236`）：注意字段是 `complete`，不是 `incomplete`。 */
export interface SkillCatalogSnapshot {
  readonly skills: SkillSummary[]
  readonly complete: boolean
}

/** `ctx.skills`（`:439-500`）。 */
export interface DshSkills {
  register(skill: SkillRegistration): () => void
  list(options?: SkillViewOptions): Promise<SkillSummary[]>
  snapshot(options?: SkillViewOptions): Promise<SkillCatalogSnapshot>
  get(name: string, options?: SkillViewOptions): Promise<unknown>
}

/** `SkillViewOptions`（`:116-119`）：`scope` 是 ScopeKey，agent 实例即其值。 */
export interface SkillViewOptions {
  readonly cwd?: string
  readonly signal?: AbortSignal
  readonly scope?: object
}

/** `SessionHeader`（`packages/core/session/src/types.ts:91-105`）。 */
export interface SessionHeader {
  readonly id: string
  readonly cwd?: string
}

/** `Agent` 的最小子集（`packages/core/agent/src/runtime-types.ts:163-242`）。 */
export interface DshAgent {
  readonly id: string
  readonly ctx: DshContext
  readonly session: { readonly header: SessionHeader }
}

/** `PromptSection`（`packages/core/system-prompt/src/index.ts:52-76`）：没有 `title`。 */
export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: unknown) => string)
  readonly interpolate?: boolean
  readonly complete?: boolean
}

/** assemble waterfall 里的 section。 */
export interface AssembledSection {
  readonly name: string
  text: string
  readonly interpolate?: boolean
}

/** `PromptAssembly` 的最小子集：`sections` 可变（源码就是可变数组）。 */
export interface PromptAssembly {
  sections: AssembledSection[]
  readonly [key: string]: unknown
}

/** `ctx.systemPrompt`（`:454-472`）。 */
export interface DshSystemPrompt {
  section(section: PromptSection): () => void
  getSectionOrder(name: string): number
}

/** `WebRoute`（`packages/host/webserver/src/index.ts:38-58`）。 */
export interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void | Promise<void>
}

/** `ctx.webServer`（`:160-173`）。 */
export interface DshWebServer {
  register(route: WebRoute): () => void
}

/** `Workspace`（`packages/workspace/workspace/src/types.ts:63-91`）：没有 `name`。 */
export interface DshWorkspace {
  readonly id: string
  readonly path: string
  readonly title?: string
}

/** `ctx.workspaceRegistry`（`packages/workspace/workspace/src/index.ts:284-298, 493-506`）。 */
export interface DshWorkspaceRegistry {
  list(): DshWorkspace[]
  /** 路径不存在时 **reject**；存在但未被登记时返回 undefined。 */
  resolveByPath(path: string): Promise<DshWorkspace | undefined>
}

/** `Scope`（`packages/core/scope/src/index.ts:104-147`）。 */
export interface DshScope {
  readonly ctx: DshContext
  dispose(): Promise<void>
}

/** `agent/created` 的载荷（`packages/core/agent/src/runtime-types.ts:248-261`）。 */
export interface AgentCreatedPayload {
  readonly agent: DshAgent
  readonly source?: string
  readonly signal?: AbortSignal
}

/** `agent/disposed` 的载荷（`:270`）。 */
export interface AgentDisposedPayload {
  readonly agent: DshAgent
}

/** 编译期护栏：真实 `Context` 必须覆盖本包用到的结构子集（反向不要求）。 */
type AssertAssignable<From extends To, To> = From
type _DshContextMatchesRuntime = AssertAssignable<Context, DshContext>
