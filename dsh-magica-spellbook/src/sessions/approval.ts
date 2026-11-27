/**
 * 审批接管：用 `{ prepend: true, global: true }` 的 waterfall 监听抢在 `api/remotes` 之前认领
 * `approval/request`，把 Promise 挂住，等看板通过 HTTP 结算。
 *
 * 为什么必须抢：dsh web 的 remote 桥（`packages/api/remotes`）会把请求塞进缓冲等浏览器回答，
 * 而它在监听链里排在后面且没有 `prepend` —— 不抢就永远轮不到我们，看板永远看不到待决项。
 *
 * @module dsh-magica-spellbook/sessions/approval
 */

import { randomUUID } from 'node:crypto'
import { manageWaterfallListener } from './core.ts'
import {
  WATERFALL_TAKEOVER,
  emitInteractionChanged,
  type PendingInteractionRecord,
} from '../shared/interaction.ts'
import type { ApprovalOutcome as DshApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { DshContextLike } from '../shared/dsh.ts'

/**
 * 审批结果闭集 = dsh 的 `ApprovalOutcome`（`@deepseek-ai/dsh-user-approval`）。
 *
 * 为什么还要在运行时列一遍：`settle` 的分支与 HTTP 入参校验需要**值**。
 * 下面的编译期断言保证这个元组与 dsh 的联合始终一致（dsh 增删取值 → `tsc` 当场报错）。
 */
export const APPROVAL_OUTCOMES = Object.freeze([
  'allowed-once',
  'rejected',
  'cancelled',
  'unavailable',
] as const satisfies readonly DshApprovalOutcome[])

type MissingOutcome = Exclude<DshApprovalOutcome, (typeof APPROVAL_OUTCOMES)[number]>
const _assertAllOutcomes: MissingOutcome extends never ? true : never = true
void _assertAllOutcomes

/** 审批结果。 */
export type ApprovalOutcome = DshApprovalOutcome

/** 运行时类型守卫（HTTP 入参收窄用）。 */
export function isApprovalOutcome(value: unknown): value is ApprovalOutcome {
  return typeof value === 'string' && (APPROVAL_OUTCOMES as readonly string[]).includes(value)
}

/** 待决审批。 */
export interface PendingApproval {
  id: string
  toolName: string
  callId?: string
  reason?: string
  /** 原始工具入参 JSON（可能被截断，截断后不再是合法 JSON）。 */
  args?: string
  /** 0.2 新增：本地化展示用，不持久化（形状直接取 dsh 的 `ApprovalRequestEvent.displayReason`）。 */
  displayReason?: ApprovalRequestEvent['displayReason']
  since: number
}

/** 应答结果。 */
export type ApprovalAnswerResult = 'answered' | 'invalid-outcome' | 'not-found' | 'session-gone'

/** 接管选项。 */
export interface ApprovalAnswererOptions {
  /** 超时毫秒；不传 = 不超时（与 dsh 一致）。 */
  timeoutMs?: number
}

interface PendingEntry extends PendingApproval {
  settle: (outcome: ApprovalOutcome) => void
}

interface Bridge {
  readonly sessionId: string
  readonly pending: Map<string, PendingEntry>
}

const bridges = new Map<string, Bridge>()

function toPending(entry: PendingEntry): PendingApproval {
  const { settle: _settle, ...rest } = entry
  void _settle
  return { ...rest }
}

function bridgeFor(sessionId: string): Bridge {
  let bridge = bridges.get(sessionId)
  if (bridge === undefined) {
    bridge = { sessionId, pending: new Map() }
    bridges.set(sessionId, bridge)
  }
  return bridge
}

/**
 * 安装一个接管（同一 sessionId 重复安装会先把旧 bridge 的待决项全部结算为 `cancelled`）。
 * @param ctx - 宿主 context（只用 `on` / `effect`）。
 * @param sessionId - 要接管的会话。
 * @param options - 超时。
 * @param resolveArgs - 按 `callId` 反查工具入参（`tool/call` 时记下来的原始 JSON）。
 */
export function installApprovalAnswerer(
  ctx: unknown,
  sessionId: string,
  options: ApprovalAnswererOptions = {},
  resolveArgs?: (callId: string | undefined) => string | undefined,
): () => void {
  const key = String(sessionId)
  const previous = bridges.get(key)
  if (previous !== undefined) {
    for (const entry of [...previous.pending.values()]) entry.settle('cancelled')
    previous.pending.clear()
  }
  const bridge = bridgeFor(key)
  let uninstalled = false

  const hold = (request: ApprovalRequestEvent): Promise<ApprovalOutcome> => {
    const signal = request.signal
    const callId = request.callId === undefined ? undefined : String(request.callId)
    const id = randomUUID()
    const since = Date.now()
    const entry: PendingApproval = { id, toolName: request.toolName ?? '', since }
    if (callId !== undefined) entry.callId = callId
    if (request.reason !== undefined) entry.reason = request.reason
    if (request.displayReason !== undefined) entry.displayReason = { ...request.displayReason }
    if (callId !== undefined) {
      try {
        const args = resolveArgs?.(callId)
        if (args !== undefined) entry.args = args
      } catch {
        // 反查失败不影响审批本身
      }
    }

    // 已经 abort 的 AbortSignal 不会再触发 abort 事件，必须先查
    if (signal?.aborted === true) return Promise.resolve<ApprovalOutcome>('cancelled')

    const record: PendingInteractionRecord = {
      kind: 'approval',
      id,
      sessionId: key,
      since,
      toolName: entry.toolName,
      ...(entry.callId === undefined ? {} : { callId: entry.callId }),
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      ...(entry.displayReason === undefined ? {} : { displayReason: entry.displayReason }),
      ...(entry.args === undefined ? {} : { args: entry.args }),
    }

    return new Promise<ApprovalOutcome>((resolve) => {
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const settle = (outcome: ApprovalOutcome): void => {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        try {
          signal?.removeEventListener('abort', onAbort)
        } catch {
          // 已移除
        }
        bridge.pending.delete(id)
        emitInteractionChanged(ctx, { action: 'removed', item: record, outcome })
        resolve(outcome)
      }

      const onAbort = (): void => {
        settle('cancelled')
      }

      // `timeoutMs: 0` = **不超时**（diff C17 定口径；旧实现的 0 = 立即超时）。
      // "0 秒就取消"太反直觉，想要立刻失败请传一个很小的正数。
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(() => settle('cancelled'), options.timeoutMs)
        timer.unref?.()
      }
      try {
        signal?.addEventListener('abort', onAbort, { once: true })
      } catch {
        // 无法监听：只能靠超时/注销
      }
      bridge.pending.set(id, { ...entry, settle })
      emitInteractionChanged(ctx, { action: 'added', item: record })
    })
  }

  return manageWaterfallListener(
    ctx,
    `magica:approval(${key})`,
    () =>
      (ctx as DshContextLike).on(
        'approval/request',
        (request: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) => {
          if (uninstalled) return next()
          const owner = request.agent?.session?.id
          if (owner === undefined || String(owner) !== key) return next()
          return hold(request)
        },
        WATERFALL_TAKEOVER,
      ),
    () => {
      uninstalled = true
      for (const entry of [...bridge.pending.values()]) entry.settle('cancelled')
      if (bridges.get(key) === bridge) bridges.delete(key)
    },
  )
}

/** fail-fast 接管：恒 `'unavailable'`（「这个会话不接受人工审批」，不是"自动批准"）。 */
export function installFailFastAnswerer(ctx: unknown, sessionId: string): () => void {
  const key = String(sessionId)
  let uninstalled = false
  return manageWaterfallListener(
    ctx,
    `magica:approval(${key})`,
    () =>
      (ctx as DshContextLike).on(
        'approval/request',
        (request: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) => {
          if (uninstalled) return next()
          const owner = request.agent?.session?.id
          if (owner === undefined || String(owner) !== key) return next()
          return Promise.resolve<ApprovalOutcome>('unavailable')
        },
        WATERFALL_TAKEOVER,
      ),
    () => {
      uninstalled = true
    },
  )
}

/** 结算一条审批（非法 outcome 明确拒绝且**不结算**）。 */
export function answerApproval(sessionId: string, approvalId: string, outcome: string): ApprovalAnswerResult {
  if (!(APPROVAL_OUTCOMES as readonly string[]).includes(outcome)) return 'invalid-outcome'
  const bridge = bridges.get(String(sessionId))
  if (bridge === undefined) return 'session-gone'
  const entry = bridge.pending.get(approvalId)
  if (entry === undefined) return 'not-found'
  entry.settle(outcome as ApprovalOutcome)
  return 'answered'
}

/** 列出全部待决审批（按 `since` 升序）。 */
export function listPendingApprovals(sessionId?: string): Array<PendingApproval & { sessionId: string }> {
  const out: Array<PendingApproval & { sessionId: string }> = []
  for (const [key, bridge] of bridges) {
    if (sessionId !== undefined && key !== String(sessionId)) continue
    for (const entry of bridge.pending.values()) {
      out.push({ ...toPending(entry), sessionId: key })
    }
  }
  return out.sort((a, b) => a.since - b.since)
}

/** 单个会话的待决审批快照（会话不在接管表里返回空数组）。 */
export function snapshotPendingApprovals(sessionId: string): PendingApproval[] {
  const bridge = bridges.get(String(sessionId))
  if (bridge === undefined) return []
  return [...bridge.pending.values()].map(toPending).sort((a, b) => a.since - b.since)
}

/** 丢掉全部接管状态（测试 / 诊断用）。 */
export function resetApprovals(): void {
  for (const bridge of bridges.values()) {
    for (const entry of [...bridge.pending.values()]) entry.settle('cancelled')
  }
  bridges.clear()
}
