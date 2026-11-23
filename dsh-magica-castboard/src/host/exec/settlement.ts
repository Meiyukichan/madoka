/**
 * Settlement layer: translates the outcome of a turn into board semantics and writes
 * it to the ledger.
 *
 * Split into two halves with a deliberate boundary:
 *
 * - {@link settlePlan} is a **pure function** that maps every outcome (including
 *   "outcome not observed") to an "execution record outcome + where the card goes";
 *   it has no IO and can be tested exhaustively;
 * - {@link applySettlement} writes the ledger: **one mutate**, idempotent (only touches
 *   `running` records), and the execution engine's only state-landing exit — normal
 *   completion, cancellation, and startup reconciliation all go through it, so two
 *   paths never race to write the same card.
 *
 * A system comment **cannot** be written inside mutate: the comment stream is a separate
 * file (`comments/<anchor>.jsonl`) while the mutate callback is a synchronous pure
 * transform. The callback therefore only collects drafts and hands them to the sink
 * after the write has landed.
 *
 * @module dsh-magica-castboard/host/exec/settlement
 */
import { normalizeBody } from '../rules.ts'
import { anchorOf } from '../pipeline/thread.ts'
import type { TaskStore } from '../ledger/task-store.ts'
import type { SettlePlan, TaskRecord, TurnSettlementLike } from '../model.ts'

export interface SystemCommentDraft {
  body: string
  /** i18n key for rendering this message in the UI language. */
  systemKey: string
  systemParams?: Record<string, string>
  createdAt: number
}

/**
 * Persistence point for system comments. It sits outside mutate because it writes files
 * asynchronously. `hasFrom` tells apart "handed off but did not move the column" from
 * "did not hand off at all"; treat a failed read as `false` (warn more strongly).
 */
export interface SystemCommentSink {
  addSystem(anchorId: string, draft: SystemCommentDraft): Promise<unknown> | unknown
  hasFrom?(anchorId: string, sessionId: string): Promise<boolean>
}

const FAILURE_REASONS: Readonly<Record<string, string>> = {
  blocked: '执行被阻塞（等待审批或人工交互未完成）',
  'max-tokens': '输出被截断（max-tokens）',
  interrupted: '执行被中断（崩溃恢复关闭的孤儿 turn）',
  forked: '会话已分叉（forked），本轮不再继续',
  error: '执行失败（turn/end: error）',
}

/**
 * "Did not finish" never counts as success: only `completed` succeeds; `aborted` is a
 * user cancellation; everything else, including no observed outcome, goes back to todo
 * as a failure with a reason. Whether the card auto-moves to review is decided by
 * {@link applySettlement} from the session's handoff behavior.
 */
export function settlePlan(settlement: TurnSettlementLike): SettlePlan {
  switch (settlement.kind) {
    case 'completed':
      return { outcome: 'succeeded' }
    case 'aborted':
      // User cancellation (or a watchdog abort) is not a failure, but it is definitely
      // not success either.
      return { outcome: 'cancelled', to: 'todo' }
    case undefined:
      // Session activity dropped to zero without a turn/end: the driver may never have
      // started, so this must not count as success.
      return { outcome: 'failed', to: 'todo', error: '未观察到 turn/end（会话活动归零但无结局）' }
    default: {
      const reason = FAILURE_REASONS[settlement.kind]
      if (reason !== undefined) return { outcome: 'failed', to: 'todo', error: reason }
      // Be conservative for outcomes the host may add later, so none silently counts
      // as success.
      return { outcome: 'failed', to: 'todo', error: `未知结局：${String(settlement.kind)}` }
    }
  }
}

/**
 * Pure function, in place. Only touches `in_progress`: the session may already have
 * moved the card (to review, say), and reverting would overwrite the agent's decision.
 */
export function revertToTodo(task: TaskRecord, now: number): boolean {
  if (task.status !== 'in_progress') return false
  task.status = 'todo'
  task.updatedAt = now
  delete task.claimedBy
  delete task.claimedAt
  return true
}

/**
 * Idempotent by construction: only records with `outcome === 'running'` are touched, so
 * repeated calls, a late cancellation, and startup reconciliation all converge on the
 * first write. `keepStatus` is for auxiliary rounds: outcome only, no card status, no
 * system comments.
 */
export async function applySettlement(
  store: TaskStore,
  executionId: string,
  sessionId: string | undefined,
  plan: SettlePlan,
  now: number,
  keepStatus = false,
  sink?: SystemCommentSink,
): Promise<boolean> {
  // ① Anchor and comment reads need await, so locate the card before the synchronous
  // mutate callback runs.
  const located = await store.read((ledger) => {
    for (const task of ledger.tasks) {
      if (task.executions.some(execution => execution.id === executionId && execution.outcome === 'running')) {
        return task
      }
    }
    return undefined
  })
  const anchorId = located === undefined ? undefined : anchorOf(located)
  const commented = anchorId !== undefined && sessionId !== undefined && sink?.hasFrom !== undefined
    ? await sink.hasFrom(anchorId, sessionId).catch(() => false)
    : false
  const pending: Array<{ anchorId: string; draft: SystemCommentDraft }> = []

  const written = await store.mutate('execution-recorded', (ledger) => {
    for (const task of ledger.tasks) {
      const execution = task.executions.find(entry => entry.id === executionId)
      if (execution === undefined || execution.outcome !== 'running') continue

      execution.outcome = plan.outcome
      execution.endedAt = now
      if (plan.error !== undefined) execution.error = plan.error.slice(0, 500)
      // The execution record is visible in the details, so this is always a visible change.
      task.updatedAt = now

      // Auxiliary rounds only keep the session working; the card stays put and the
      // execution record carries any failure trace.
      if (keepStatus) return [task]

      const push = (draft: SystemCommentDraft): void => { pending.push({ anchorId: anchorOf(task), draft }) }

      if (plan.to === 'todo') {
        // A user cancellation must not render as "execution failed", so cancellation
        // and failure (including abandonment) use different systemKeys.
        const cancelled = plan.outcome === 'cancelled'
        const reason = plan.error ?? '执行已取消'
        const abandoned = task.status === 'abandoned'
        revertToTodo(task, now)
        task.updatedBy = { kind: 'system' }
        if (abandoned) {
          push({
            body: normalizeBody('[系统] 任务已遗弃，本轮执行已停止。'),
            systemKey: 'sys.execStoppedAbandoned',
            createdAt: now,
          })
        } else {
          push({
            body: normalizeBody(cancelled
              ? '[系统] 执行已取消；任务已退回待办。'
              : `[系统] 执行失败：${reason}；任务已退回待办。`),
            systemKey: cancelled ? 'sys.execCancelled' : 'sys.execFailed',
            systemParams: { error: reason },
            createdAt: now,
          })
        }
      } else if (plan.outcome === 'succeeded') {
        delete task.claimedBy
        delete task.claimedAt
        if (task.status === 'in_progress') {
          // The session did not move the card per the handoff protocol; move it to review
          // so it cannot sit in progress forever.
          push({
            body: normalizeBody(commented
              ? '[系统] 执行会话已结束并留有评论，但未移至待验收；系统自动移入待验收。'
              : '[系统] 执行会话已结束，但未按协议交接（无评论、未移至待验收）；系统自动移入待验收，请审查后退回或验收。'),
            systemKey: commented ? 'sys.endedWithComment' : 'sys.endedNoHandoff',
            createdAt: now,
          })
          task.status = 'in_review'
          task.updatedAt = now
          task.updatedBy = { kind: 'system' }
        }
      } else {
        // cancelled / failed, but the session already moved the card out of
        // in_progress: release the claim only.
        delete task.claimedBy
        delete task.claimedAt
      }
      return [task]
    }
    return undefined
  })

  // ② Comments are written after the ledger lands. A trace failure must not fail the
  // settlement; the sink takes care of its own errors.
  if (sink !== undefined) {
    for (const item of pending) {
      try {
        await sink.addSystem(item.anchorId, item.draft)
      } catch {
        /* the settlement has already landed */
      }
    }
  }
  return written.changed.length > 0
}
