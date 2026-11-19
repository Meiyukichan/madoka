/**
 * 「连续工具调用但没有文本输出」提醒。
 *
 * 语义（与设计一致）：
 * - **按 session 计数**（`agent id === session id`），每个会话独立；
 * - 每满 `everyToolCalls`（默认 15）次**连续**工具调用、且期间没有任何文本输出，
 *   就往该会话说一句简短的英文提醒，让它给用户几行状态描述；
 * - **子代理不管**：`session.header.origin === 'subagent'` 或带 `parentSession` 的会话直接跳过；
 * - 有文本输出就清零（`assistant/message` 里出现实际文本）；
 * - 提醒默认每 15 次一次（7 次太频繁，实测会打断正常的多步工具链）。
 *
 * 事件来源：`ctx.on('session/event', (session, event) => …)` 是**全局总线**，每个事件自带
 * session 对象。我们要的就是**所有主会话**，所以不做任何「挑某个 agent」的过滤：
 * 计数器按 `session.id` 分桶（Map），各算各的。唯一要排除的是**子代理**（含 fork）。
 * 事件类型见 `packages/core/session`：`tool/call` / `assistant/message` / `step/*` / `turn/*`。
 */

/** 计数节奏。 */
export interface NudgeTiming {
  /** 连续多少次工具调用触发一次提醒。 */
  everyToolCalls: number
  /** 距上次提醒再隔多少次才允许再提醒（防连续刷屏）。 */
  remindEvery: number
}

/** 单个会话的计数器。 */
export interface NudgeCounters {
  /** 自上次文本输出以来的工具调用数。 */
  toolCalls: number
  /** 上次提醒时的 `toolCalls`。 */
  nudgedAt: number
  /** 已处理的最大事件序号（重放/恢复时会重复投递事件）。 */
  lastSeq: number
}

export const EMPTY_COUNTERS: NudgeCounters = { toolCalls: 0, nudgedAt: 0, lastSeq: 0 }

/** 会话事件的最小形状（只取用到的字段，避免依赖宿主类型）。 */
export interface NudgeEvent {
  readonly type: string
  readonly seq?: number
  readonly data?: unknown
}

/** 会话的最小形状。 */
export interface NudgeSession {
  readonly id: string
  readonly header?: {
    readonly origin?: string
    readonly parentSession?: unknown
  }
}

/** 提醒文案：短、英文、只说要做什么。 */
export function nudgeText(toolCalls: number): string {
  return [
    `You have made ${toolCalls} consecutive tool calls without any text to the user.`,
    'They only see your messages, not tool output — send a brief progress note now, two or three sentences is enough.',
  ].join('\n')
}

/** 该会话是否属于子代理（子代理不提醒）。 */
export function isSubagentSession(session: NudgeSession | undefined): boolean {
  const header = session?.header
  if (header === undefined) return false
  return header.origin === 'subagent' || header.parentSession !== undefined
}

/**
 * 事件里是否包含**实际文本**（不是纯空白、不是工具/思考块）。
 *
 * `assistant/message` 的 data 里带消息体（`{ content: [{ type, text }] }` 或 `{ message: … }`），
 * 这里递归找 `type === 'text'` 的块和裸 `text` 字段，避免绑死某一层嵌套。
 */
export function hasTextOutput(data: unknown, depth = 0): boolean {
  if (depth > 6 || data === null || typeof data !== 'object') return false
  if (Array.isArray(data)) return data.some(item => hasTextOutput(item, depth + 1))
  const record = data as Record<string, unknown>
  const type = record.type
  if (type === 'text' && typeof record.text === 'string' && record.text.trim() !== '') return true
  if (type === 'thinking' || type === 'tool-call' || type === 'tool_use' || type === 'reasoning') return false
  for (const value of Object.values(record)) {
    if (hasTextOutput(value, depth + 1)) return true
  }
  return false
}

/**
 * 纯函数：吃一个会话事件，返回新计数器（以及需要投递时的提醒文本）。
 *
 * 不修改入参；`lastSeq` 只增，旧序号的事件直接忽略（会话恢复/重放场景）。
 */
export function advance(
  counters: NudgeCounters,
  event: NudgeEvent,
  timing: NudgeTiming,
): { counters: NudgeCounters; remind?: string } {
  const seq = typeof event.seq === 'number' ? event.seq : undefined
  if (seq !== undefined && seq <= counters.lastSeq) return { counters }
  const next: NudgeCounters = { ...counters, lastSeq: seq ?? counters.lastSeq }

  if (event.type === 'assistant/message' && hasTextOutput(event.data)) {
    // 有说话 → 清零，下次重新数
    next.toolCalls = 0
    next.nudgedAt = 0
    return { counters: next }
  }

  if (event.type !== 'tool/call') return { counters: next }

  next.toolCalls = counters.toolCalls + 1
  const every = Math.max(1, timing.everyToolCalls)
  const remindEvery = Math.max(1, timing.remindEvery)
  if (next.toolCalls < every) return { counters: next }
  if (next.toolCalls - next.nudgedAt < remindEvery) return { counters: next }

  next.nudgedAt = next.toolCalls
  return { counters: next, remind: nudgeText(next.toolCalls) }
}

/** 具名上下文消息（与 spellbook 的 `buildPluginMessage` 同形，dsh 的官方扩展点）。 */
export function buildContextMessage(
  plugin: string,
  text: string,
  section: string,
): Record<string, unknown> {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: section,
      plugin,
      form: 'snapshot',
      sections: [{ name: section, text }],
    },
  }
}

/** `installNudge` 需要的最小 ctx 形状（只声明用到的成员）。 */
export interface NudgeContext {
  effect(callback: () => () => void, label?: string): unknown
  on(event: 'session/event', listener: (session: NudgeSession, event: NudgeEvent) => void): () => void
  on(event: 'agent/disposed', listener: (payload: { agent?: { id?: string } }) => void): () => void
  get(name: 'agents'): unknown
}

export interface NudgeOptions extends NudgeTiming {
  readonly plugin: string
  /** 上下文的具名段（GUI 的上下文行会显示它）。 */
  readonly section: string
  /** 跳过子代理会话（默认 true）。 */
  readonly skipSubagents: boolean
}

/** 往会话里投递一条具名上下文（agent 不在/已结束则静默丢弃）。 */
export function deliver(ctx: NudgeContext, sessionId: string, text: string, options: NudgeOptions): boolean {
  let agents: unknown
  try {
    agents = ctx.get('agents')
  } catch {
    return false
  }
  const get = (agents as { get?: (id: string) => unknown } | undefined)?.get
  if (typeof get !== 'function') return false
  let agent: unknown
  try {
    agent = get.call(agents, sessionId)
  } catch {
    return false
  }
  const inject = (agent as { inject?: (message: unknown) => void } | undefined)?.inject
  if (typeof inject !== 'function') return false
  try {
    inject.call(agent, buildContextMessage(options.plugin, text, options.section))
    return true
  } catch {
    return false
  }
}

/** 注册监听；`ctx.effect` 负责卸载回收（含计数器）。 */
export function installNudge(ctx: NudgeContext, options: NudgeOptions): void {
  const counters = new Map<string, NudgeCounters>()
  ctx.effect(() => {
    const disposeEvent = ctx.on('session/event', (session, event) => {
      if (session === undefined || typeof session.id !== 'string' || session.id === '') return
      if (options.skipSubagents && isSubagentSession(session)) return
      const current = counters.get(session.id) ?? EMPTY_COUNTERS
      const outcome = advance(current, event, options)
      counters.set(session.id, outcome.counters)
      if (outcome.remind !== undefined) deliver(ctx, session.id, outcome.remind, options)
    })
    const disposeGone = ctx.on('agent/disposed', ({ agent }) => {
      const id = agent?.id
      if (typeof id === 'string') counters.delete(id)
    })
    return () => {
      disposeEvent()
      disposeGone()
      counters.clear()
    }
  }, 'dsh-magica-rune: nudge')
}
