/**
 * 会话运行内核：两个门面共用的全部机制。
 *
 * 三件事（也是它存在的理由）：
 * ① `whenIdle()` 不是成功信号 —— 结局只有 `turn/end` 的 `reason` 说了算；
 * ② `agents.create()` 不会自动挂 agent preset —— 不挂就是空全局层；
 * ③ `agents.resume()` 需要的参数，会话日志里一个都没有 —— 只能靠台账。
 *
 * 本文件**不 import 任何同目录模块**（除类型），是纯内核。
 *
 * @module dsh-magica-spellbook/sessions/core
 */

import {
  effectOf,
  serviceOf,
  type DshAgentHandleLike,
  type DshAgentLike,
  type DshAgentOptions,
  type DshAgentPresetsLike,
  type DshAgentRegistryLike,
  type DshAgentSetup,
  type DshAgentSetupCommit,
  type DshCancelCause,
  type DshContextLike,
  type DshPermissionPresetsLike,
  type DshSessionEvent,
  type DshSessionLike,
  type DshTurnEndReason,
  type DshUserMessageLike,
} from '../shared/dsh.ts'
import { WATERFALL_TAKEOVER } from '../shared/wire.ts'
import type { SessionRecord } from './store.ts'

/** 0.2 的 7 种结局（`.0.1.6` 只有 6 种，缺 `forked`）。 */
export const TURN_END_KINDS = [
  'completed',
  'aborted',
  'blocked',
  'error',
  'max-tokens',
  'interrupted',
  'forked',
] as const

type TurnEndKind = (typeof TURN_END_KINDS)[number]

/** 编译期双向断言：dsh 增删 kind 时这里会报错，而不是运行时静默漂移。 */
type KindsMatchDsh = DshTurnEndReason['kind'] extends TurnEndKind
  ? TurnEndKind extends DshTurnEndReason['kind']
    ? true
    : never
  : never
const _assertKindsMatchDsh: KindsMatchDsh = true
void _assertKindsMatchDsh

/** 只有 `completed` 算完成；`undefined`（没观察到 `turn/end`）也算未完成。 */
export function isTurnCompleted(reason: DshTurnEndReason | undefined): boolean {
  return reason?.kind === 'completed'
}

/** 把任意结局归一成英文短语（本地化交给调用方）。 */
export function describeTurnEnd(reason: DshTurnEndReason | undefined): string {
  if (reason === undefined) return 'no turn/end observed'
  switch (reason.kind) {
    case 'completed':
      return 'completed'
    case 'aborted':
      return `aborted (${reason.reason.kind})`
    case 'blocked':
      return 'blocked'
    case 'error': {
      const message = (reason.error as { message?: string }).message ?? 'unknown'
      return `error: ${message}`
    }
    case 'max-tokens':
      return 'output truncated (max-tokens)'
    case 'interrupted':
      return 'interrupted (crash recovery)'
    case 'forked':
      return 'forked (fork seed)'
    default:
      return String((reason as { kind?: unknown }).kind)
  }
}

/** 一条审批的历史记录。 */
export interface ApprovalRecord {
  toolName: string
  callId?: string
  reason?: string
  outcome: string
  since: number
  waitedMs: number
}

/** 运行状态（门面与内核共用）。 */
export interface SessionRunState {
  running: boolean
  messages: string[]
  done: boolean
  error: string | null
  errorCode?: ResumeFailure
  turnEnds: DshTurnEndReason[]
  outcome?: TurnEndKind
  externallyDisposed: boolean
  ledgerWriteFailed?: boolean
  disposed: boolean
  approvals: ApprovalRecord[]
  approvalPolicy?: 'ask' | 'never'
  sandboxMode?: string
  planMode?: boolean
}

/** 消费方钩子（异常会被吞掉并记一条日志）。 */
export interface ObserverHooks {
  onText?: (text: string) => void
  onTurnEnd?: (reason: DshTurnEndReason, turn: number) => void
  onToolCall?: (callId: string, toolName: string, args: string) => void
  onToolResult?: (callId: string) => void
  onDisposed?: () => void
}

/** 一轮的结算。 */
export interface TurnSettlement {
  reason?: DshTurnEndReason
  kind?: TurnEndKind
  completed: boolean
  texts: string[]
  externallyDisposed: boolean
  timedOut?: boolean
}

/** 空的运行状态（`running` 初始为 `true`）。 */
export function emptyRunState(): SessionRunState {
  return {
    running: true,
    messages: [],
    done: false,
    error: null,
    turnEnds: [],
    approvals: [],
    externallyDisposed: false,
    disposed: false,
  }
}

/** 状态的深副本（可选键在 `undefined` 时**不出现**）。 */
export function snapshotRunState(state: SessionRunState): Omit<SessionRunState, 'approvals'> & {
  approvals: ApprovalRecord[]
} {
  return {
    running: state.running,
    messages: state.messages.slice(),
    done: state.done,
    error: state.error,
    turnEnds: state.turnEnds.slice(),
    externallyDisposed: state.externallyDisposed,
    disposed: state.disposed,
    approvals: state.approvals.map((entry) => ({ ...entry })),
    ...(state.errorCode !== undefined ? { errorCode: state.errorCode } : {}),
    ...(state.outcome !== undefined ? { outcome: state.outcome } : {}),
    ...(state.ledgerWriteFailed !== undefined ? { ledgerWriteFailed: state.ledgerWriteFailed } : {}),
    ...(state.approvalPolicy !== undefined ? { approvalPolicy: state.approvalPolicy } : {}),
    ...(state.sandboxMode !== undefined ? { sandboxMode: state.sandboxMode } : {}),
    ...(state.planMode !== undefined ? { planMode: state.planMode } : {}),
  }
}

/**
 * 释放句柄持有的会话累计输出（句柄本身还被下游引用，闭包里挂着整场会话的字符串）。
 * 不清 `outcome` / `error`：调用方还要靠它们判成败。
 */
export function releaseRunState(state: SessionRunState): void {
  state.running = false
  state.done = true
  state.disposed = true
  state.messages.length = 0
  state.turnEnds.length = 0
  state.approvals.length = 0
}

let messageSeq = 0
let sessionSeq = 0

/** 造一个消息 id（本地单调计数器 + 时间 + 随机，不 import dsh 的品牌函数）。 */
export function mintMessageId(): string {
  messageSeq += 1
  return `magica-msg-${Date.now().toString(36)}-${messageSeq.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

/** 会话 id 的自定义铸造器允许的字符集（比文件名正则更严：不允许点号）。 */
export const SESSION_ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/

/** 造一个会话 id（随机段 8 位，因为它会变成文件名）。 */
export function mintSessionId(prefix: string): string {
  sessionSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${sessionSeq.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`
}

/** 品牌类型在运行时是 no-op，转换点集中在一处。 */
export function asSessionId(id: string): string {
  return id
}

/** 普通用户消息（`string[]` → 同一条消息的多个 block）。 */
export function buildUserMessage(text: string | string[]): DshUserMessageLike {
  const blocks = Array.isArray(text) ? text : [text]
  return {
    id: mintMessageId(),
    role: 'user',
    content: blocks.map((item) => ({ type: 'text', text: item })),
    source: { kind: 'user' },
  }
}

/** 无名插件上下文的缺省 source kind（0.2 的 v4 会话格式拒绝 `kind: 'plugin'`）。 */
export const DEFAULT_CONTEXT_KIND = 'spellbook-context'

/**
 * 插件上下文消息。
 *
 * ⚠️ 0.2 破坏性变更：会话格式 v4 要求 user 消息带**生产者自有**的 `source.kind`，
 * 并且**明确拒绝** `kind: 'plugin'`（`packages/session/session-format-v3-to-v4/src/message-sources.ts`：
 * `refuses retired plugin wrappers`）。所以这里永远发具名 kind：
 * - 传了 `section` → 用 section 名当 kind（GUI 的上下文行显示它，例：`lattice-rules`）；
 * - 没传 → 用 {@link DEFAULT_CONTEXT_KIND}。
 *
 * `plugin` 字段保留（表达"谁注入的"），`form`/`sections` 按 snapshot 形状给出。
 */
export function buildPluginMessage(
  plugin: string,
  text: string,
  section?: string,
): DshUserMessageLike {
  const kind = section === undefined || section === '' ? DEFAULT_CONTEXT_KIND : section
  if (kind === 'plugin') {
    throw new Error(
      "context section must not be 'plugin': dsh session format v4 rejects the retired plugin source kind",
    )
  }
  const source: Record<string, unknown> = {
    kind,
    plugin,
    form: 'snapshot',
    sections: [{ name: kind, text }],
  }
  return {
    id: mintMessageId(),
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }
}

/** 插件上下文条目。 */
export type PluginContextEntry = string | { readonly name: string; readonly text: string }

/** 归一插件上下文条目（空串 / 非对象 / 无 text 一律静默丢弃）。 */
export function toContextEntries(
  value: PluginContextEntry | readonly PluginContextEntry[] | undefined,
): Array<{ name?: string; text: string }> {
  if (value === undefined) return []
  const list = Array.isArray(value) ? value : [value as PluginContextEntry]
  const out: Array<{ name?: string; text: string }> = []
  for (const item of list) {
    if (typeof item === 'string') {
      if (item !== '') out.push({ text: item })
      continue
    }
    if (typeof item !== 'object' || item === null) continue
    const text = item.text
    if (typeof text !== 'string' || text === '') continue
    const name = item.name
    out.push(typeof name === 'string' && name !== '' ? { name, text } : { text })
  }
  return out
}

/** 插件上下文条目 → 消息列表。 */
export function toMessages(
  plugin: string,
  value: PluginContextEntry | readonly PluginContextEntry[] | undefined,
): DshUserMessageLike[] {
  return toContextEntries(value).map((entry) =>
    entry.name === undefined
      ? buildPluginMessage(plugin, entry.text)
      : buildPluginMessage(plugin, entry.text, entry.name),
  )
}

/**
 * 时长文案：小于 1 分钟说毫秒/秒，避免 `Math.round(120/60000)=0` 写成「0 分钟」。
 * @param ms - 毫秒数。
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  if (ms < 60_000) {
    const seconds = ms / 1000
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`
  }
  return `${Math.round(ms / 60_000)} 分钟`
}

/** 解析后的模型路由（provider/model 都非空才算数）。 */
export interface ResolvedModel {
  provider: string
  model: string
  reasoningEffort?: string
}

/**
 * 取 dsh 的默认模型选择。
 *
 * `agentDefaultModel` 是**拉取式**服务（`currentSelection()`）：dsh 自己的入口（web / headless）
 * 在创建 agent 时主动查询它并填 `agentOptions`。库如果不查，agent 就没有模型路由，
 * 首个 turn 会在 system-prompt 组装阶段炸成 `prompt variable "{{model}}" has no value`。
 */
export function resolveDefaultModel(ctx: unknown): ResolvedModel | undefined {
  const service = serviceOf<{ currentSelection?: () => unknown }>(ctx, 'agentDefaultModel')
  if (service === undefined || typeof service.currentSelection !== 'function') return undefined
  try {
    const raw = service.currentSelection()
    if (typeof raw !== 'object' || raw === null) return undefined
    const candidate = raw as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    if (typeof candidate.provider !== 'string' || candidate.provider === '') return undefined
    if (typeof candidate.model !== 'string' || candidate.model === '') return undefined
    const resolved: ResolvedModel = { provider: candidate.provider, model: candidate.model }
    if (candidate.reasoningEffort !== undefined && candidate.reasoningEffort !== null) {
      resolved.reasoningEffort = String(candidate.reasoningEffort)
    }
    return resolved
  } catch {
    return undefined
  }
}

/**
 * 选模型：调用方显式给 → 台账里的 → dsh 默认。都没有就抛可读错误（早于建 agent）。
 * @param ctx - 宿主 context。
 * @param explicit - 调用方给的模型。
 * @param record - 台账记录（续跑沿用原路由）。
 */
export function pickModel(
  ctx: unknown,
  explicit: ResolvedModel | undefined,
  record: SessionRecord | undefined,
): ResolvedModel {
  if (explicit !== undefined && explicit.provider !== '' && explicit.model !== '') return explicit
  if (record?.model !== undefined && record.model.provider !== '' && record.model.model !== '') {
    return {
      provider: record.model.provider,
      model: record.model.model,
      ...(record.model.reasoningEffort !== undefined ? { reasoningEffort: record.model.reasoningEffort } : {}),
    }
  }
  const fallback = resolveDefaultModel(ctx)
  if (fallback !== undefined) return fallback
  throw new Error(
    'no model route: pass `model: { provider, model }` or configure the agentDefaultModel service '
      + '(dsh-agent-default-model) in this composition',
  )
}

/** 取 `agents` 服务并校验形状（这是调用时的硬要求，所以抛可读错误）。 */
export function resolveAgents(ctx: unknown): DshAgentRegistryLike {
  const agents = serviceOf<DshAgentRegistryLike>(ctx, 'agents')
  if (agents === undefined || typeof agents.create !== 'function') {
    throw new Error(
      'session helper requires ctx.agents — declare inject: ["agents"] in the referencing plugin',
    )
  }
  return agents
}

/** 取可选服务并做形状校验。 */
export function resolveAgentPresets(ctx: unknown): DshAgentPresetsLike | undefined {
  const presets = serviceOf<DshAgentPresetsLike>(ctx, 'agentPresets')
  if (presets === undefined || typeof presets.mount !== 'function') return undefined
  return presets
}

function readPresetId(mounted: unknown): string | undefined {
  if (typeof mounted !== 'object' || mounted === null) return undefined
  const id = (mounted as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** 解析默认 preset 的**具体 id**（`meta.agentPreset` 是创建参数，必须在创建前拿到）。 */
export async function resolveAgentPresetId(
  ctx: unknown,
  requested?: string | undefined,
): Promise<string | undefined> {
  if (requested !== undefined && requested !== '') return requested
  const presets = resolveAgentPresets(ctx)
  if (presets === undefined || typeof presets.resolve !== 'function') return undefined
  try {
    return readPresetId(await presets.resolve())
  } catch {
    return undefined
  }
}

/** 从会话事件里抽纯文本（只取 text block，多 block 用 `join('')`）。 */
export function extractAssistantText(event: DshSessionEvent): string | null {
  const data = event.data as { message?: { content?: unknown } } | undefined
  const content = data?.message?.content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type !== 'text' || typeof candidate.text !== 'string') continue
    parts.push(candidate.text)
  }
  const text = parts.join('').trim()
  return text === '' ? null : text
}

/** 结局判定的观察者：装在 agent scope 上，仍显式比对 `session.id`（纵深防御）。 */
export function installObservers(
  agentCtx: unknown,
  sessionId: string,
  state: SessionRunState,
  hooks: ObserverHooks = {},
): () => void {
  const offs: Array<() => void> = []
  const openApprovals = new Map<string, { toolName: string; callId?: string; reason?: string; since: number }>()
  let disposed = false

  const log = (...parts: string[]): void => {
    const logger = serviceOf<{ warn?: (m: string) => void }>(agentCtx, 'logger')
    if (typeof logger?.warn === 'function') {
      logger.warn(parts.join(' '))
      return
    }
    try {
      process.stderr.write(`[spellbook] ${parts.join(' ')}\n`)
    } catch {
      // 连 stderr 都写不了：放弃
    }
  }

  const safeHook = <T>(name: string, call: (() => T) | undefined): T | undefined => {
    if (call === undefined) return undefined
    try {
      return call()
    } catch {
      log('magica-sessions: observer hook threw', name)
      return undefined
    }
  }

  const ctx = agentCtx as DshContextLike

  try {
    const off = ctx.on('session/event', (session: DshSessionLike, event: DshSessionEvent) => {
      // disposed 闸门（l.md:192）：句柄释放后事件还会漏一拍，回调不该再触发用户的观察者
      if (state.disposed) return
      if (String(session.id) !== String(sessionId)) return
      const data = event.data as Record<string, unknown> | undefined
      switch (event.type) {
        case 'assistant/message': {
          const text = extractAssistantText(event)
          if (text !== null) {
            state.messages.push(text)
            safeHook('onText', hooks.onText === undefined ? undefined : () => hooks.onText?.(text))
          }
          return
        }
        case 'turn/end': {
          const reason = data?.['reason'] as DshTurnEndReason | undefined
          if (reason === undefined || typeof reason.kind !== 'string') return
          const turn = typeof data?.['turn'] === 'number' ? data['turn'] : state.turnEnds.length + 1
          state.turnEnds.push(reason)
          state.outcome = reason.kind
          // 审批对是 turn-enclosed 的：turn 结束时还挂着的必然悬空
          openApprovals.clear()
          safeHook('onTurnEnd', hooks.onTurnEnd === undefined ? undefined : () => hooks.onTurnEnd?.(reason, turn))
          return
        }
        case 'approval/asked': {
          const id = String(data?.['id'] ?? '')
          if (id === '') return
          const entry: { toolName: string; callId?: string; reason?: string; since: number } = {
            toolName: String(data?.['toolName'] ?? ''),
            since: typeof event.time === 'number' ? event.time : Date.now(),
          }
          if (data?.['callId'] !== undefined) entry.callId = String(data['callId'])
          if (typeof data?.['reason'] === 'string') entry.reason = data['reason']
          openApprovals.set(id, entry)
          return
        }
        case 'approval/decided': {
          const id = String(data?.['id'] ?? '')
          const open = openApprovals.get(id)
          if (open === undefined) return
          openApprovals.delete(id)
          const at = typeof event.time === 'number' ? event.time : Date.now()
          const record: ApprovalRecord = {
            toolName: open.toolName,
            outcome: String(data?.['outcome'] ?? 'unavailable'),
            since: open.since,
            waitedMs: Math.max(0, at - open.since),
          }
          if (open.callId !== undefined) record.callId = open.callId
          if (open.reason !== undefined) record.reason = open.reason
          state.approvals.push(record)
          return
        }
        case 'approval/policy': {
          const policy = data?.['policy']
          if (policy === 'ask' || policy === 'never') state.approvalPolicy = policy
          return
        }
        case 'sandbox/mode': {
          const mode = data?.['mode']
          if (typeof mode === 'string') state.sandboxMode = mode
          return
        }
        case 'plan/mode': {
          const active = data?.['active']
          if (typeof active === 'boolean') state.planMode = active
          return
        }
        case 'tool/call': {
          const callId = data?.['callId']
          if (callId === undefined) return
          const name = typeof data?.['name'] === 'string' ? data['name'] : ''
          const args = typeof data?.['arguments'] === 'string' ? data['arguments'] : ''
          safeHook('onToolCall', hooks.onToolCall === undefined ? undefined : () => hooks.onToolCall?.(String(callId), name, args))
          return
        }
        case 'tool/result': {
          const callId = (data?.['message'] as { source?: { callId?: unknown } } | undefined)?.source?.callId
          if (callId === undefined) return
          safeHook('onToolResult', hooks.onToolResult === undefined ? undefined : () => hooks.onToolResult?.(String(callId)))
          return
        }
        default:
          return
      }
    })
    offs.push(off)
  } catch {
    // agentCtx 形状不符：降级（调用方仍可用 whenIdle 拿「活动归零」，但拿不到结局原因）
  }

  try {
    const off = ctx.on('agent/disposed', () => {
      state.externallyDisposed = true
      safeHook('onDisposed', hooks.onDisposed)
    })
    offs.push(off)
  } catch {
    // 同上
  }

  return () => {
    if (disposed) return
    disposed = true
    for (const off of offs) {
      try {
        off()
      } catch {
        // 注销失败不影响后续
      }
    }
    offs.length = 0
  }
}

/** 上下文投递器（常驻会话可反复 push）。 */
export interface ContextDeliveryHandle {
  push(entries: readonly DshUserMessageLike[]): void
  dispose(): void
}

/**
 * 把插件上下文追加在首个**进入**的 step 的消息**末尾**（只投一次）。
 *
 * 为什么不用 `agent.inject()`：`inject` 排进 `next-step` 队列，而 turn 的第一个 step 边界
 * 先排空 `next-step`、再从 `next-turn` 取 1 条 → 上下文必然排在用户消息**前面**，规则占住会话开头。
 * 为什么 `{ prepend: true }`：最外层监听在 `next()` 返回之后才追加，于是排在其它所有监听产出之后。
 */
export function installContextDelivery(
  agentCtx: unknown,
  contexts: readonly DshUserMessageLike[],
): ContextDeliveryHandle {
  let pending = [...contexts]
  const ctx = agentCtx as DshContextLike
  let off: (() => void) | null = null
  let disposed = false

  try {
    off = ctx.on(
      'agent/pre-step',
      async (
        _payload: unknown,
        next: () => Promise<{ kind: string; messages?: DshUserMessageLike[] }>,
      ) => {
        const decision = await next()
        if (pending.length === 0) return decision
        if (decision.kind === 'reject') return decision
        const batch = pending
        pending = []
        return { ...decision, messages: [...(decision.messages ?? []), ...batch] }
      },
      { prepend: true },
    )
  } catch {
    off = null
  }

  return {
    push(entries) {
      if (disposed || entries.length === 0) return
      pending = [...pending, ...entries]
    },
    dispose() {
      if (disposed) return
      disposed = true
      try {
        off?.()
      } catch {
        // agent scope 可能已拆掉
      }
    },
  }
}

/** 默认权限预设（与 dsh composition 默认一致）。 */
export const DEFAULT_PERMISSION_PRESET = 'workspace-write'

/** 权限名三级回退：调用方传的 → dsh 全局默认 → composition 默认。 */
export function resolvePermission(ctx: unknown, explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return explicit
  const presets = serviceOf<DshPermissionPresetsLike>(ctx, 'permissionPresets')
  if (presets !== undefined) {
    try {
      const preset = presets.defaultPreset
      if (typeof preset === 'string' && preset !== '') return preset
    } catch {
      // 服务已 dispose 或未注册 settings：落到 composition 默认
    }
  }
  return DEFAULT_PERMISSION_PRESET
}

/**
 * 应用权限：优先走 `permissionPresets.set()`（三个 knob 都写），否则降级为 `sandbox/mode`。
 * `'read-only'` 是合法沙箱模式但**不是预设名**，必然走降级路径。
 */
export function applyPermission(
  ctx: unknown,
  session: DshSessionLike,
  name: string,
): 'preset' | 'sandbox' | 'none' {
  const presets = serviceOf<DshPermissionPresetsLike>(ctx, 'permissionPresets')
  if (presets !== undefined && typeof presets.set === 'function') {
    try {
      presets.set(session, name)
      return 'preset'
    } catch {
      // 未知预设名 / 服务内部错误：降级
    }
  }
  try {
    session.append('sandbox/mode', { mode: name })
    return 'sandbox'
  } catch {
    return 'none'
  }
}

/**
 * waterfall 监听的统一收口：幂等注销 + `ctx.effect` 兜底。
 *
 * `register` 写成回调而不是直接收事件名，是为了让每个调用点保留 dsh 的 `Events` 增强类型检查。
 */
export function manageWaterfallListener(
  ctx: unknown,
  label: string,
  register: () => () => void,
  onUninstall?: () => void,
): () => void {
  let off: (() => void) | null = null
  let effectDisposer: (() => void) | null = null
  let uninstalled = false

  try {
    off = register()
  } catch {
    // 无事件总线（测试 mock / 非 cordis 环境）：不接管
    onUninstall?.()
    return () => {}
  }

  const uninstall = (): void => {
    if (uninstalled) return
    uninstalled = true
    try {
      off?.()
    } catch {
      // 已注销
    }
    onUninstall?.()
    // 只有调用 disposer 才会摘掉 ctx.effect 里那条登记记录
    try {
      effectDisposer?.()
    } catch {
      // fiber 已 inactive
    }
  }

  effectDisposer = effectOf(ctx, () => uninstall, label)
  return uninstall
}

/** 看门狗超时的结算（形状完整，不再用 `as` 断言绕过）。 */
function timeoutSettlement(): TurnSettlement {
  return {
    reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'magica:idle-timeout' } },
    kind: 'aborted',
    completed: false,
    texts: [],
    externallyDisposed: false,
    timedOut: true,
  }
}

/** 交叉验证：`whenIdle()` 只判「活动归零」，结局取本轮新增的最后一条 `turn/end`。 */
export async function runTurnVerified(
  handle: DshAgentHandleLike,
  state: SessionRunState,
  message: DshUserMessageLike | undefined,
  alreadyDelivered = false,
  idleTimeoutMs?: number,
): Promise<TurnSettlement> {
  const turnEndCountBefore = state.turnEnds.length
  const msgCountBefore = state.messages.length

  if (!alreadyDelivered && message !== undefined) handle.agent.followup(message)

  if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), idleTimeoutMs)
      timer.unref?.()
    })
    const idle = handle.agent.whenIdle().then(() => 'idle' as const)
    const winner = await Promise.race([idle, timeout])
    if (timer !== undefined) clearTimeout(timer)
    if (winner === 'timeout') {
      try {
        handle.agent.cancel({ kind: 'hook', reason: 'magica:idle-timeout' }, { keepInbox: true })
      } catch {
        // 已结束
      }
      return timeoutSettlement()
    }
  } else {
    await handle.agent.whenIdle()
  }

  const fresh = state.turnEnds.slice(turnEndCountBefore)
  const reason = fresh.length === 0 ? undefined : fresh[fresh.length - 1]
  return {
    ...(reason !== undefined ? { reason, kind: reason.kind } : {}),
    completed: reason?.kind === 'completed',
    texts: state.messages.slice(msgCountBefore),
    externallyDisposed: state.externallyDisposed,
  }
}

/** 续跑失败的可判读码（调用方按 code 分支，不要匹配 message）。 */
export type ResumeFailure =
  | 'SESSION_LIVE'
  | 'SESSION_ALREADY_ACTIVE'
  | 'SESSION_LOG_MISSING'
  | 'SESSION_SETUP_REQUIRED'

/** 续跑错误。 */
export class SessionResumeError extends Error {
  readonly code: ResumeFailure

  constructor(code: ResumeFailure, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SessionResumeError'
    this.code = code
  }
}

/** 续跑分派结果。 */
export interface ResumeTarget {
  resumed: boolean
  sessionId: string
  record?: SessionRecord
}

/** 从任意错误里取一句人话。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 续跑分派：台账是唯一凭证。
 * 台账不可用 / 无记录 / kind 不符 → **新建并忽略传入 id**（绝不改写别人的记录）。
 */
export function resolveResumeTarget(
  store: { get(id: string): SessionRecord | null } | null,
  requestedId: string | undefined,
  mintPrefix: string,
  expectedKind?: 'ephemeral' | 'workspace',
  mintNew?: () => string,
): ResumeTarget {
  const mint = (): ResumeTarget => {
    const id = mintNew === undefined ? mintSessionId(mintPrefix) : mintNew()
    if (!SESSION_ID_SAFE.test(id)) {
      throw new Error(
        `${id} is not usable as a store file name (^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$)`,
      )
    }
    return { resumed: false, sessionId: asSessionId(id) }
  }
  if (store === null || requestedId === undefined || requestedId === '') return mint()
  const record = store.get(requestedId)
  if (record === null) return mint()
  if (expectedKind !== undefined && record.kind !== expectedKind) return mint()
  return { resumed: true, sessionId: asSessionId(requestedId), record }
}

/** 会话是否还在活层（提前查是为了给可读错误，而不是让调用方去猜 `already exists`）。 */
export function assertSessionNotLive(agents: DshAgentRegistryLike, sessionId: string): void {
  let live: DshAgentLike | undefined
  try {
    live = agents.get(sessionId)
  } catch {
    return
  }
  if (live !== undefined) {
    throw new SessionResumeError(
      'SESSION_LIVE',
      `session "${sessionId}" is still live; (use the handle that owns it, or dispose it before resuming)`,
    )
  }
}

/** 把 resume 抛出的原始错误归一成 `SessionResumeError`（结构化 code 优先，正则只做兜底）。 */
export function toResumeError(error: unknown, sessionId: string): Error {
  if (error instanceof SessionResumeError) return error
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && code.startsWith('SESSION_')) {
    return new SessionResumeError('SESSION_LOG_MISSING', errorMessage(error), { cause: error })
  }
  const message = errorMessage(error)
  // 真机实测：同一 sessionId 还有活动写 handle 时，dsh 会拒绝并给这句话
  if (/already owned by an active write handle|is still live/i.test(message)) {
    return new SessionResumeError(
      'SESSION_ALREADY_ACTIVE',
      `cannot resume "${sessionId}": ${message}（先 dispose 掉持有它的 handle 再续跑）`,
      { cause: error },
    )
  }
  if (/not found|SESSION_QUERY_SESSION_NOT_FOUND|no such session|ENOENT/i.test(message)) {
    return new SessionResumeError('SESSION_LOG_MISSING', `cannot resume "${sessionId}": ${message}`, {
      cause: error,
    })
  }
  return error instanceof Error ? error : new Error(message)
}

/** agent scope 装配结果。 */
export interface AgentScopeComposition {
  unsubscribe: () => void
  commit?: DshAgentSetupCommit
  presetId?: string
}

/** 装配 agent scope：**先装监听 → 再挂 preset → 最后跑调用方 setup**。 */
export async function composeAgentScope(options: {
  readonly ctx: unknown
  readonly agentCtx: unknown
  readonly sessionId: string
  readonly state: SessionRunState
  readonly hooks: ObserverHooks
  readonly presetId?: string | false | undefined
  readonly userSetup?: DshAgentSetup | undefined
}): Promise<AgentScopeComposition> {
  const unsubscribe = installObservers(options.agentCtx, options.sessionId, options.state, options.hooks)
  let mountedPresetId: string | undefined
  try {
    if (options.presetId !== false) {
      const presets = resolveAgentPresets(options.ctx)
      if (presets !== undefined && typeof presets.mount === 'function') {
        const mounted = await presets.mount(options.agentCtx, options.presetId)
        mountedPresetId = readPresetId(mounted) ?? (typeof options.presetId === 'string' ? options.presetId : undefined)
      } else if (typeof options.presetId === 'string') {
        mountedPresetId = options.presetId
      }
    }
    let commit: DshAgentSetupCommit | undefined
    if (options.userSetup !== undefined) {
      const result = await options.userSetup(options.agentCtx)
      if (result !== undefined && result !== null) {
        if (typeof (result as DshAgentSetupCommit).commit !== 'function') {
          throw new Error(
            'setup 的返回值必须是 `{ commit(): void }` 对象或 undefined；'
              + '返回裸函数会让 dsh 的 setupCommit?.commit() 抛 "is not a function"',
          )
        }
        commit = result as DshAgentSetupCommit
      }
    }
    return {
      unsubscribe,
      ...(commit !== undefined ? { commit } : {}),
      ...(mountedPresetId !== undefined ? { presetId: mountedPresetId } : {}),
    }
  } catch (error) {
    try {
      unsubscribe()
    } catch {
      // 已回滚
    }
    throw error
  }
}

/** 台账写失败告警：logger → stderr → 放弃（三级）。 */
export function warnLedgerWriteFailure(ctx: unknown, message: string): void {
  const logger = serviceOf<{ warn?: (m: string) => void }>(ctx, 'logger')
  if (typeof logger?.warn === 'function') {
    try {
      logger.warn(message)
      return
    } catch {
      // 落到 stderr
    }
  }
  try {
    process.stderr.write(`[dsh-magica-spellbook] ${message}\n`)
  } catch {
    // 放弃
  }
}

/** agent 选项（转出给调用方）。 */
export type { DshAgentOptions, DshAgentSetup, DshAgentSetupCommit, DshCancelCause, DshTurnEndReason }

/** 瀑布式接管的常量（单点导出，避免各处手写从而漏掉某个选项）。 */
export const TAKEOVER_OPTIONS = WATERFALL_TAKEOVER
