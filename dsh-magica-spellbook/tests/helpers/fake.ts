/**
 * 测试桩：最小 ctx / ServerResponse / IncomingMessage。
 * @module dsh-magica-spellbook/tests/helpers/fake
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export interface FakeCtx {
  get(name: string): unknown
  on(event: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean; global?: boolean }): () => void
  effect(callback: () => unknown, label?: string): () => void
  emit(event: string, ...args: unknown[]): void
  /** 调第一个监听器并返回它的返回值（测试 waterfall 的挂起 Promise）。 */
  invoke(event: string, ...args: unknown[]): unknown
  listenerCount(event: string): number
  /** 某个事件上各次 on() 注册的选项（按注册顺序）。 */
  listenerOptions(event: string): Array<{ prepend?: boolean; global?: boolean } | undefined>
  effects(): number
  /** 模拟 cordis fiber 卸载：执行并清空所有 effect 的 disposer（倒序）。 */
  disposeEffects(): void
}

/** 造一个只实现 `get` / `on` / `effect` 的 ctx。 */
export function fakeCtx(services: Record<string, unknown> = {}): FakeCtx {
  const listeners = new Map<string, Set<(...args: any[]) => unknown>>()
  const effectDisposers: Array<() => void> = []
  const listenerOptions = new Map<string, Array<{ prepend?: boolean; global?: boolean } | undefined>>()
  let effectCount = 0
  return {
    get(name) {
      return services[name]
    },
    on(event, listener, options) {
      let set = listeners.get(event)
      if (set === undefined) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(listener)
      // 记下注册选项：`{prepend:true, global:true}` 是"抢在 api/remotes 之前认领"的关键，
      // 早前 fake 丢掉第三参，导致这条承重约定无法断言（G-4）
      listenerOptions.set(event, [...(listenerOptions.get(event) ?? []), options])
      return () => {
        set?.delete(listener)
      }
    },
    effect(callback) {
      effectCount += 1
      const disposer = callback()
      const dispose = () => {
        effectCount = Math.max(0, effectCount - 1)
        if (typeof disposer === 'function') (disposer as () => void)()
      }
      effectDisposers.push(dispose)
      return dispose
    },
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
    invoke(event, ...args) {
      const first = [...(listeners.get(event) ?? [])][0]
      return first === undefined ? undefined : first(...args)
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0
    },
    /** 某个事件上各次 `on()` 注册的选项（按注册顺序）。 */
    listenerOptions(event) {
      return [...(listenerOptions.get(event) ?? [])]
    },
    effects() {
      return effectCount
    },
    /** 模拟 fiber 卸载：倒序执行所有 effect 的 disposer。 */
    disposeEffects() {
      const pending = effectDisposers.splice(0, effectDisposers.length)
      for (const dispose of pending.reverse()) dispose()
    },
  }
}

export interface RecordedResponse {
  status: number
  headers: Record<string, string>
  body: string
  headersSent: boolean
  json<T = unknown>(): T
}

/** 造一个记录写入的 ServerResponse 桩。 */
export function fakeResponse(): ServerResponse & RecordedResponse {
  const recorded = {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    headersSent: false,
    json<T>() {
      return JSON.parse(recorded.body) as T
    },
  }

  const response = {
    get status() {
      return recorded.status
    },
    get headers() {
      return recorded.headers
    },
    get body() {
      return recorded.body
    },
    get headersSent() {
      return recorded.headersSent
    },
    json<T>() {
      return recorded.json<T>()
    },
    writeHead(status: number, headers?: Record<string, string>) {
      recorded.status = status
      recorded.headers = { ...(headers ?? {}) }
      recorded.headersSent = true
      return response
    },
    end(body?: string) {
      recorded.body = body ?? ''
      recorded.headersSent = true
      return response
    },
  }

  return response as unknown as ServerResponse & RecordedResponse
}

export interface FakeRequestInit {
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: string
}

/** 造一个可被 `for await` 读的 IncomingMessage 桩。 */
export function fakeRequest(init: FakeRequestInit = {}): IncomingMessage {
  const body = init.body ?? ''
  // 默认给回环 Host：路由器的 Host 围栏默认只信任回环（挡 DNS rebinding）
  const headers = { host: '127.0.0.1:3081', ...(init.headers ?? {}) }
  const stream = {
    method: init.method ?? 'GET',
    url: init.url ?? '/',
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body, 'utf8')
    },
  }
  return stream as unknown as IncomingMessage
}
