/**
 * 会话页接管装配：轮询 → 发布载体 → 占位 `conversation.composer` → 注入样式 → runtime。
 *
 * 不订阅任何 dsh 事件：待决状态活在 host 的调用栈上，而插件规则禁 SSE 长连接，
 * 所以只能"前端短轮询 + 发布进 uiSession 注册表"。
 *
 * @module dsh-magica-spellbook/client/panel/surface
 */

import { InteractionComposer } from './Composer.tsx'
import { PendingInteractionCarrier, isInteractionCarrier, type InteractionActions } from './carrier.ts'
import { INTERACTION_LOCALE_NS, makeTranslate, zh } from './locales.ts'
import { installInteractionRuntime, releaseInteractionRuntime, type InteractionRuntime } from './runtime.ts'
import { InteractionRegistry, claim as claimRecords } from './registry.ts'
import { serviceOf as pickService, type InteractionScopeFace, type SlotsFace, type UiSessionFace } from './services.ts'
import { injectInteractionStyles } from './styles.ts'
import { createInteractionTransport, type InteractionTransport } from './transport.ts'
import type { InteractionTranslate } from './locales.ts'
import type { PendingInteractionRecord } from '../../shared/wire.ts'

export type { InteractionScopeFace } from './services.ts'
const serviceOf = pickService

/** 轮询缺省间隔（也是硬下限：不得低于 5 s）。 */
export const INTERACTION_POLL_MS = 5_000



/** 装配选项。 */
export interface InteractionSurfaceOptions {
  t: InteractionTranslate
  pluginId: string
  intervalMs?: number
  prefix?: string
  transport?: InteractionTransport
  /** 诊断钩子：每轮轮询/发布后回调（消费方可以据此打日志或断言）。 */
  debug?: (state: InteractionDebugState) => void
}

/** 一轮轮询的诊断快照。 */
export interface InteractionDebugState {
  /** 本轮拿到的待决记录数（取不到时为 undefined）。 */
  records?: number
  /** 当前已发布的会话（按 sessionId）。 */
  published?: readonly string[]
  /** 轮询失败的原因。 */
  error?: string
}

/** 装配结果。 */
export interface InteractionSurface {
  /** 手动补一拍（回前台 / 应答后）。 */
  refresh(): void
  dispose(): void
}







/** 同一会话只保留等得最久的那条载体（实现与测试都在 registry.ts）。 */
const claim = claimRecords

/**
 * 装配会话页接管。
 * @param scope - 客户端 context（只要 `get` / `effect`）。
 * @param options - 翻译、pluginId、轮询间隔。
 * @returns 句柄；`uiSession` 不可用时返回 `undefined`。
 */
export function createInteractionSurface(
  scope: InteractionScopeFace,
  options: InteractionSurfaceOptions,
): InteractionSurface | undefined {
  const uiSession = serviceOf<UiSessionFace>(scope, 'uiSession')
  if (uiSession === undefined || typeof uiSession.registerPendingInteraction !== 'function') return undefined

  const transport = options.transport ?? createInteractionTransport(options.prefix === undefined ? {} : { prefix: options.prefix })
  const intervalMs = Math.max(INTERACTION_POLL_MS, options.intervalMs ?? INTERACTION_POLL_MS)
  const runtime: InteractionRuntime = { t: options.t ?? makeTranslate(zh), actions: transport as InteractionActions }

  const disposeStyles = injectInteractionStyles(options.pluginId)
  const publish = uiSession.registerPendingInteraction<PendingInteractionCarrier>(() => 1)
  const registry = new InteractionRegistry((record) =>
    publish(new PendingInteractionCarrier(record), () => Promise.resolve()),
  )

  let disposed = false
  let inFlight = false
  /** 世代号：每次应答/摘卡 +1，用来丢弃"过期响应"（A-224）。 */
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposeSlot: (() => void) | null = null
  let onVisibility: (() => void) | null = null

  function isHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  }

  function drop(record: PendingInteractionRecord): void {
    // 摘卡 = 世界变了：把在途轮询作废，否则"应答前发出的那次 list"回来时
    // 会把刚摘掉的卡片按旧数据重新发布一拍（用户会看到卡片"复活"）
    generation += 1
    registry.drop(record)
  }

  function dropCarrier(record: PendingInteractionRecord): void {
    drop(record)
  }

  function publishRecords(records: readonly PendingInteractionRecord[]): void {
    if (disposed) return
    const { kept, failed } = registry.sync(records.map((record) => record))
    if (failed.length > 0) {
      options.debug?.({ records: records.length, error: `publish failed: ${failed.join(',')}`, published: registry.keys() })
    }
    options.debug?.({ records: records.length, published: registry.keys() })
    void kept
  }

  async function pollOnce(): Promise<void> {
    // 在途互斥（A-224）：定时器 / 回前台 / refresh() 三路并发时只允许一次 list()
    if (disposed || isHidden() || inFlight) return
    inFlight = true
    const startedAt = generation
    try {
      let records: PendingInteractionRecord[]
      try {
        records = await transport.list()
      } catch (error) {
        // 网络抖动：保留上一份
        options.debug?.({ error: `list failed: ${String(error)}`, published: registry.keys() })
        return
      }
      if (disposed) return
      // 世代守卫（A-224）：请求在途期间发生过应答/摘卡，这份响应已经过期，整份丢弃
      if (startedAt !== generation) {
        options.debug?.({ records: records.length, error: 'stale response discarded', published: registry.keys() })
        return
      }
      // 后半段也要兜住：publish 抛错不能变成 unhandled rejection（A-227）
      try {
        publishRecords(records)
      } catch (error) {
        options.debug?.({ error: `publish crashed: ${String(error)}`, published: registry.keys() })
      }
    } finally {
      inFlight = false
    }
  }

  function schedule(): void {
    if (disposed) return
    timer = setTimeout(() => {
      timer = null
      void pollOnce().finally(() => schedule())
    }, intervalMs)
    timer.unref?.()
  }

  const actions: InteractionActions = {
    async answerQuestion(view, answers) {
      const result = await transport.answerQuestion(view, answers)
      if (result.ok) dropCarrier(view)
      return result
    },
    async cancelQuestion(view) {
      const result = await transport.cancelQuestion(view)
      if (result.ok) dropCarrier(view)
      return result
    },
    async answerApproval(view, decision) {
      const result = await transport.answerApproval(view, decision)
      if (result.ok) dropCarrier(view)
      return result
    },
  }

  const runtimeWithActions: InteractionRuntime = { t: runtime.t, actions }
  installInteractionRuntime(runtimeWithActions)

  const slots = serviceOf<SlotsFace>(scope, 'slots')
  if (slots !== undefined && typeof slots.inject === 'function' && typeof slots.register === 'function') {
    try {
      const register = slots.register.bind(slots)
      disposeSlot = slots.inject('conversation.composer', () =>
        register(
          {
            name: 'conversation.composer',
            // 只认带标记的载体，绝不抢 dsh 自己的提问/审批卡片
            select: (owner: { pendingInteraction?: unknown }) => {
              const candidate = owner.pendingInteraction
              return isInteractionCarrier(candidate) ? candidate.view : null
            },
            locale: INTERACTION_LOCALE_NS,
            // 注意：**不要**写 0.1.6 的 `registrant` 选项——0.2 的 Slot 注册不接受它，
            // 传了会让 register 抛错，而这里如果静默 catch 就等于「接管面永远不出现」。
          },
          InteractionComposer,
        ),
      )
    } catch (error) {
      disposeSlot = null
      // 立刻可见：真机上这类失败必须能在控制台看到，而不是安静地什么都不发生
      if (typeof console !== 'undefined') {
        console.warn('[spellbook] conversation.composer takeover failed to register:', error)
      }
    }
  }

  if (typeof document !== 'undefined') {
    onVisibility = () => {
      if (document.visibilityState === 'visible') void pollOnce()
    }
    document.addEventListener('visibilitychange', onVisibility)
  }

  void pollOnce()
  schedule()

  return {
    refresh() {
      void pollOnce()
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (onVisibility !== null) {
        document.removeEventListener('visibilitychange', onVisibility)
        onVisibility = null
      }
      registry.clear()
      try {
        disposeSlot?.()
      } catch {
        // 已注销
      }
      disposeSlot = null
      releaseInteractionRuntime(runtimeWithActions)
      disposeStyles()
    },
  }
}
