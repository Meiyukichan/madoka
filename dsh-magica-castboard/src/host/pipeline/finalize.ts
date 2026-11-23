/**
 * Issue finalization: when a task reaches a terminal state, write the conclusion back to the issue it came from.
 *
 * ```text
 * task.done      ─┐
 * task.canceled  ─┼─→ issue.status = success / failed / abandoned
 * task.abandoned ─┘        └─→ assigneeMeta gets the final execution report + execution history
 *                              └─→ cloud-originated issues also call issueFinalize
 * ```
 *
 * ## Why subscribe to the ledger instead of patching every write path
 *
 * Tasks reach a terminal state through many entry points: settlement, dragging a card to done, cancellation, quick
 * rejection... patching each one is easy to miss. `TaskStore.subscribe()` delivers **committed** changes and covers every path.
 *
 * ## Idempotence
 *
 * Only issues still in flight (`routing` / `running`) are handled. Anything already `success` / `failed` /
 * `abandoned` is skipped, so repeatedly updating the same finished card never repeats remote requests.
 *
 * ## Only "actually ran" counts
 *
 * Finalization is an execution conclusion, so the card must have at least one execution record. When a person drags
 * a card that never ran into done/canceled, the issue stays untouched: that is a scheduling action, not an execution result.
 *
 * `archived` is not handled here: archiving is the user's way of filing cards, not an execution conclusion.
 *
 * @module dsh-magica-castboard/host/pipeline/finalize
 */
import { eventLog } from '../shared/event-log.ts'

import type { IssueRecord, IssueStatus } from '../model.ts'
import type { IssueStore } from '../ledger/issue-store.ts'
import type { TaskStore } from '../ledger/task-store.ts'
import type { ExecutionRecord, TaskRecord, TaskStatus } from '../model.ts'

export interface FinalizeRemoteInput {
  status: 'success' | 'failed' | 'abandoned'
  assigneeMeta: Record<string, unknown>
}

export interface IssueFinalizeDeps {
  readonly issues: IssueStore
  readonly now: () => number
  /**
   * Remote finalization (`issueFinalize`), called only for cloud-originated records; failures are logged only.
   */
  readonly issueFinalize?: (issueId: string, input: FinalizeRemoteInput) => Promise<void>
  /**
   * Retry the report's artifact list at terminal state. The list is authoritative;
   * this never guesses files. Omitted = no retry.
   */
  readonly uploadArtifacts?: (
    issueId: string,
    artifacts: readonly string[],
    options: { cwd?: string; description?: string },
  ) => Promise<void>
  /** Whether this process holds the storage lease (only the holder writes the issue ledger). */
  readonly isOwner?: () => boolean
}

/** Task terminal state -> issue terminal state (unlisted states are not handled). */
const TERMINAL_TARGET: Readonly<Partial<Record<TaskStatus, FinalizeRemoteInput['status']>>> = {
  done: 'success',
  canceled: 'failed',
  abandoned: 'abandoned',
}

/** Issue states that are still "in flight" -- only these may be finalized. */
const IN_FLIGHT: readonly IssueStatus[] = ['routing', 'running']

const STATUS_CHANGING_KINDS = new Set(['task-moved', 'task-updated', 'execution-recorded'])

function note(level: 'info' | 'warn', event: string, detail: string): void {
  eventLog(level, event, detail)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `assigneeMeta.executions` mirrors the task's `executions`; it is cloned so the async remote layer never receives a live ledger object.
 */
export function taskExecutions(task: TaskRecord): ExecutionRecord[] {
  return structuredClone(task.executions)
}

export class IssueFinalizer {
  private readonly deps: IssueFinalizeDeps
  private disposed = false
  /** Serial queue: when several tasks finalize in one tick, issue-ledger writes happen in commit order to avoid stepping on each other. */
  private chain: Promise<void> = Promise.resolve()
  /** Retry timers for a transient cloud write failure; a terminal task may never emit another event. */
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(deps: IssueFinalizeDeps) {
    this.deps = deps
  }

  attach(store: TaskStore): () => void {
    const unsubscribe = store.subscribe(change => {
      if (this.disposed) return
      if (!STATUS_CHANGING_KINDS.has(change.kind)) return
      const terminal = change.tasks.filter(task =>
        task.issueId !== undefined
        && task.issueId !== ''
        && TERMINAL_TARGET[task.status] !== undefined)
      if (terminal.length === 0) return
      // Subscribers receive live ledger records that may be changed again during async work, so snapshot first.
      const snapshot = terminal.map(task => structuredClone(task))
      this.chain = this.chain.then(async () => {
        for (const task of snapshot) {
          if (this.disposed) return
          await this.finalizeOne(task).catch((error: unknown) => {
            note('warn', 'issue-finalize-failed', `${task.issueId ?? '?'}: ${errorText(error)}`)
            this.scheduleRetry(task)
          })
        }
      })
    })
    return () => {
      this.disposed = true
      unsubscribe()
      for (const timer of this.retries.values()) clearTimeout(timer)
      this.retries.clear()
    }
  }

  private scheduleRetry(task: TaskRecord): void {
    if (this.disposed) return
    const key = task.issueId ?? ''
    if (key === '' || this.retries.has(key)) return
    const timer = setTimeout(() => {
      this.retries.delete(key)
      if (this.disposed) return
      void this.finalizeOne(task)
        .catch((error: unknown) => {
          note('warn', 'issue-finalize-retry-failed', `${key}: ${errorText(error)}`)
          this.scheduleRetry(task)
        })
    }, 5_000)
    timer.unref?.()
    this.retries.set(key, timer)
  }

  private async finalizeOne(task: TaskRecord): Promise<void> {
    const issueId = task.issueId
    if (issueId === undefined || issueId === '') return
    const target = TERMINAL_TARGET[task.status]
    if (target === undefined) return
    if (this.deps.isOwner !== undefined && !this.deps.isOwner()) return

    // No execution records = the card never ran; dragging it to a terminal state is a scheduling action, so do not overwrite the issue status with it.
    if (task.executions.length === 0) {
      note('info', 'issue-finalize-skipped', `${issueId}: 任务 ${task.id} 到 ${task.status} 但从没跑过执行，issue 状态不动`)
      return
    }

    // The issue ledger is lazy: without this a cold process would see `undefined` and skip finalization.
    await this.deps.issues.load()
    const issue = await this.deps.issues.get(issueId)
    if (issue === undefined) return
    // Idempotence: only finalize issues still in flight.
    if (!(IN_FLIGHT as readonly string[]).includes(issue.status)) return
    if (issue.status === target) return

    // The conclusion belongs to the executor, so it goes into `assigneeMeta` (the output column), not `assignerMeta` (requirements from the dispatcher).
    // Only report fields and `executions` are overwritten: other `assigneeMeta` keys may have been written during
    // execution, and finalization should not wipe them.
    const report = [...task.executions].reverse().find(execution => execution.report !== undefined)?.report
    const sessionExecution = [...task.executions].reverse().find(execution => execution.sessionId !== undefined)
    const meta: Record<string, unknown> = {
      ...(issue.assigneeMeta ?? {}),
      ...(report !== undefined
        ? {
            summary: report.summary,
            changedFiles: report.changedFiles,
            checks: report.checks,
            artifacts: report.artifacts,
            risk: report.risk,
          }
        : {}),
      taskId: task.id,
      ...(sessionExecution?.sessionId !== undefined ? { sessionId: sessionExecution.sessionId } : {}),
      settledAt: this.deps.now(),
      executions: taskExecutions(task),
    }
    // Cloud first: the local mirror is updated only after the shared library accepted the
    // terminal status. A missing face / failed write reaches the caller and is retried.
    if (this.deps.issueFinalize === undefined) {
      throw new Error('共享库不可用：不能更新 issue 终态')
    }
    await this.deps.issueFinalize(issueId, {
      status: target,
      assigneeMeta: meta,
    })

    const artifacts = report?.artifacts ?? []
    if (artifacts.length > 0 && this.deps.uploadArtifacts !== undefined) {
      // Retry exactly the report's list; upload failure must not block the issue status.
      await this.deps.uploadArtifacts(issueId, artifacts, {
        ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
        ...(report?.summary === undefined ? {} : { description: report.summary }),
      }).catch((error: unknown) => {
        note('warn', 'issue-finalize-artifacts-failed', `${issueId}: ${errorText(error)}`)
      })
    }

    const updated: IssueRecord | undefined = await this.deps.issues.update(issueId, draft => {
      draft.status = target
      draft.assigneeMeta = meta
      // Pin the lineage again: the task is certainly still in the ledger at finalization.
      draft.assigneeTask = task.id
    }, 'issue-updated')
    if (updated === undefined) throw new Error(`issue ${issueId} 的本地镜像更新失败`)
    note('info', 'issue-finalized', `${issueId} → ${target}（任务 ${task.id} ${task.status}）`)
  }

  /** Wait for queued finalizations to finish (for tests; production does not need to await this). */
  async settled(): Promise<void> {
    await this.chain
  }
}
