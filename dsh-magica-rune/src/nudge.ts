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
    'They only see your messages, not tool output — send a brief progress note now, 1-3 sentences is enough.',
  ].join('\n')
}

/** 该会话是否属于子代理（子代理不提醒）。 */
export function isSubagentSession(session: NudgeSession | undefined): boolean {
  const header = session?.header
  if (header === undefined) return false
  return header.origin === 'subagent' || header.parentSession !== undefined
}

/**
 * 事件里是否包含**给用户看的文本**。
 *
 * 逐字对齐 spellbook 的 `extractAssistantText`（`dsh-magica-spellbook/src/sessions/core.ts:429`）：
 * 只看 `event.data.message.content` 里 `type === 'text'` 的块，拼起来 trim 非空才算说话。
 * 不做递归扫描、不猜字段 —— 思考（thinking/reasoning）在 content 里是**另一种 type**，
 * 自然就被排除；之前递归找 `text` 字段会把思考当回答，导致计数被清零、永远不提醒。
 */
export function hasTextOutput(data: unknown): boolean {
  const message = (data as { message?: { content?: unknown } } | undefined)?.message
  const content = message?.content
  if (!Array.isArray(content)) return false
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type !== 'text') continue
    if (typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('').trim() !== ''
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

/**
 * `installNudge` 需要的最小 ctx 形状（只声明用到的成员）。
 *
 * 为什么必须有 `inject`：未在 `inject` 里声明的服务，`ctx.get('agents')` 会**抛**，
 * 而 `deliver` 的 try/catch 会把它吞成 `false` —— 表现就是「提醒永远投不出去且无声」。
 * 所以监听与取服务都放进 `ctx.inject(['agents'], child => …)` 的子上下文里。
 */
export interface NudgeContext {
  effect(callback: () => () => void, label?: string): unknown
  on(event: 'session/event', listener: (session: NudgeSession, event: NudgeEvent) => void): () => void
  on(event: 'agent/disposed', listener: (payload: { agent?: { id?: string } }) => void): () => void
  get(name: 'agents'): unknown
  inject(services: readonly string[], callback: (child: NudgeContext) => void): unknown
}

export interface NudgeOptions extends NudgeTiming {
  readonly plugin: string
  /** 上下文的具名段（GUI 的上下文行会显示它）。 */
  readonly section: string
  /** 跳过子代理会话（默认 true）。 */
  readonly skipSubagents: boolean
}

/** 往会话里投递一条具名上下文（agent 不在/已结束则静默丢弃）。 */
export function deliver(ctx: NudgeContext, sessionId: string, text: string, options: NudgeOptions): 'sent' | 'skip' | 'retry' {
  let agents: unknown
  try {
    agents = ctx.get('agents')
  } catch (error) {
    return 'retry'
  }
  const get = (agents as { get?: (id: string) => unknown } | undefined)?.get
  if (typeof get !== 'function') {
    return 'retry'
  }
  let agent: unknown
  try {
    agent = get.call(agents, sessionId)
  } catch (error) {
    return 'retry'
  }
  if (agent === undefined || agent === null) {
    return 'retry'
  }
  // 只处理**正在跑**的会话：提醒的意义是「它还在闷头调工具」，插话（steer）
  // 才能立刻生效。空闲/已结束的会话不管——用户已经在等下一句，不需要我们插嘴。
  const live = agent as { status?: string; steer?: (message: unknown) => void }
  if (live.status !== 'running') {
    return 'skip'
  }
  if (typeof live.steer !== 'function') {
    return 'retry'
  }
  try {
    live.steer.call(agent, buildContextMessage(options.plugin, text, options.section))
    return 'sent'
  } catch (error) {
    return 'retry'
  }
}

/** 延后投递的重试间隔（毫秒）；投递成功即停止。 */
const DELIVERY_RETRY_DELAYS = [0, 60, 200, 500] as const

/**
 * 把投递挪到当前 append 之后，并且**只对 running 会话**用 steer 插话。
 *
 * `session/event` 的派发发生在会话 append 发布期间，此时在监听里同步 `agent.steer()`
 * 会抛 `session append cannot reenter while another append is being published`
 * （0.2.1 实测，seq=134）。用 setTimeout 出栈后再投，并按固定间隔重试几次；
 * 会话没在跑（idle / 已结束）时直接跳过，不 followup、不 inject。
 */
export function scheduleDelivery(
  ctx: NudgeContext,
  sessionId: string,
  text: string,
  options: NudgeOptions,
  isDisposed: () => boolean,
  onSkip?: () => void,
): void {
  const attempt = (index: number): void => {
    if (isDisposed()) return
    const outcome = deliver(ctx, sessionId, text, options)
    if (outcome === 'sent') {
      return
    }
    if (outcome === 'skip') {
      // 会话此刻没在跑 → 这次没投出去，把「已提醒」的位置退回去，下一个工具调用再试，
      // 否则 10/20 这种窗口会被白白吃掉，用户只能看到 30 那一次。
      onSkip?.()
      return
    }
    if (index + 1 >= DELIVERY_RETRY_DELAYS.length) {
      return
    }
    setTimeout(() => attempt(index + 1), DELIVERY_RETRY_DELAYS[index + 1])
  }
  setTimeout(() => attempt(0), DELIVERY_RETRY_DELAYS[0])
}

/** 注册监听；`ctx.effect` 负责卸载回收（含计数器）。 */
export function installNudge(ctx: NudgeContext, options: () => NudgeOptions): void {
  const counters = new Map<string, NudgeCounters>()
  // 在声明过 `agents` 的子上下文里监听：否则 `ctx.get('agents')` 会抛，投递永远失败。
  ctx.inject(['agents'], (child) => {
    installListener(child, counters, options)
  })
}

function installListener(ctx: NudgeContext, counters: Map<string, NudgeCounters>, options: () => NudgeOptions): void {
  ctx.effect(() => {
    let disposed = false
    const isDisposed = () => disposed
    const disposeEvent = ctx.on('session/event', (session, event) => {
      if (session === undefined || typeof session.id !== 'string' || session.id === '') return
      if (options().skipSubagents && isSubagentSession(session)) return
      const settings = options()
      const current = counters.get(session.id) ?? EMPTY_COUNTERS
      const outcome = advance(current, event, settings)
      counters.set(session.id, outcome.counters)
      if (outcome.remind !== undefined) {
        // 不能在派发过程中同步 inject：`session/event` 是在会话 append 发布期间派发的，
        // 此时 append 重入会抛 `session append cannot reenter while another append is being published`。
        // 所以延后到当前 append 结束后再投递，并做有界重试（可能撞上别的 append）。
        scheduleDelivery(ctx, session.id, outcome.remind, settings, isDisposed, () => {
          const latest = counters.get(session.id)
          if (latest === undefined) return
          counters.set(session.id, { ...latest, nudgedAt: Math.max(0, latest.nudgedAt - 1) })
        })
      }
    })
    const disposeGone = ctx.on('agent/disposed', ({ agent }) => {
      const id = agent?.id
      if (typeof id === 'string') counters.delete(id)
    })
    return () => {
      disposed = true
      disposeEvent()
      disposeGone()
      counters.clear()
    }
  }, 'dsh-magica-rune: nudge')
}
