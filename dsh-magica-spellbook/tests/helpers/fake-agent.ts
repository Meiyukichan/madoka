/**
 * 测试桩：可编排的 agents 注册表 + Agent。
 * @module dsh-magica-spellbook/tests/helpers/fake-agent
 */

import { fakeCtx, type FakeCtx } from './fake.ts'

export interface FakeAgentOptions {
  /** 每次 followup 后是否自动产出一轮（文本 + turn/end）。 */
  autoTurn?: boolean
  text?: string
  endKind?: string
  /** `whenIdle()` 是否永不收敛（看门狗用例）。 */
  neverIdle?: boolean
  provider?: string
  model?: string
  /** 初始 `agent.status`（`pushNamedContext` 的三档投递靠它区分）。 */
  status?: 'idle' | 'running' | 'closed'
}

/** 一次投递记录（followup / steer / inject）。 */
export interface FakeDelivery {
  kind: 'followup' | 'steer' | 'inject'
  id: string
}

export interface FakeAgentBundle {
  registry: {
    create(options: any): Promise<{ agent: any; dispose(): Promise<void> }>
    resume(options: any): Promise<{ agent: any; dispose(): Promise<void> }>
    get(id: string): any
  }
  agentCtx: FakeCtx
  session: { id: string; appended: Array<{ type: string; data: unknown }>; append(type: string, data?: unknown): void }
  created: any[]
  resumed: any[]
  disposed: number
  /** 每一次投递（按发生顺序）。 */
  calls: FakeDelivery[]
  /** 改 `agent.status`（模拟运行中 / 已结束）。 */
  setStatus(next: 'idle' | 'running' | 'closed'): void
  /** 当前 `agent.status`。 */
  status(): string
  /** 手动结束一轮（autoTurn 关闭时用）。 */
  endTurn(kind?: string, text?: string): void
}

/** 造一套可编排的 agents。 */
export function fakeAgents(options: FakeAgentOptions = {}): FakeAgentBundle {
  const agentCtx = fakeCtx()
  const created: any[] = []
  const resumed: any[] = []
  const appended: Array<{ type: string; data: unknown }> = []
  const idleWaiters: Array<() => void> = []
  const calls: FakeDelivery[] = []
  let status: 'idle' | 'running' | 'closed' = options.status ?? 'idle'
  const bundle: FakeAgentBundle = {
    registry: {
      async create(createOptions: any) {
        created.push(createOptions)
        const agent = makeAgent(createOptions.sessionId)
        await createOptions.setup?.(agentCtx, agent)
        return { agent, dispose: async () => {} }
      },
      async resume(resumeOptions: any) {
        resumed.push(resumeOptions)
        const agent = makeAgent(resumeOptions.resumeSessionId)
        await resumeOptions.setup?.(agentCtx, agent)
        return { agent, dispose: async () => {} }
      },
      get() {
        return undefined
      },
    },
    agentCtx,
    session: {
      id: '',
      appended,
      append(type, data) {
        appended.push({ type, data })
      },
    },
    created,
    resumed,
    disposed: 0,
    calls,
    setStatus(next) {
      status = next
    },
    status() {
      return status
    },
    endTurn(kind = 'completed', text) {
      if (text !== undefined) {
        agentCtx.emit('session/event', session, {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text }] } },
        })
      }
      agentCtx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind } } })
      for (const waiter of idleWaiters.splice(0, idleWaiters.length)) waiter()
    },
  }

  let session: { id: string }

  function makeAgent(sessionId: string) {
    session = bundle.session
    bundle.session.id = sessionId
    return {
      id: sessionId,
      session: bundle.session,
      get status() {
        return status
      },
      followup(_message: unknown) {
        calls.push({ kind: 'followup', id: sessionId })
        if (options.autoTurn === false) return
        queueMicrotask(() => bundle.endTurn(options.endKind ?? 'completed', options.text ?? 'done'))
      },
      steer(_message: unknown) {
        calls.push({ kind: 'steer', id: sessionId })
      },
      inject(_message: unknown) {
        calls.push({ kind: 'inject', id: sessionId })
      },
      cancel() {},
      whenIdle() {
        if (options.neverIdle === true) return new Promise<void>(() => {})
        return new Promise<void>((resolve) => {
          idleWaiters.push(resolve)
          if (options.autoTurn === false) return
          // autoTurn 时由 endTurn 触发
        })
      },
    }
  }

  return bundle
}

/** 直接造一个只有 `append` 的会话对象（不需要 agents 的场景）。 */
export function fakeSession(id = 'session-1'): FakeAgentBundle['session'] {
  return {
    id,
    appended: [],
    append(type, data) {
      this.appended.push({ type, data })
    },
  }
}
