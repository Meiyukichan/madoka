/**
 * A task's associated sessions: which dsh sessions belong to it, and archiving them.
 * The two live together because one reads the task record while the other reports
 * per-session outcomes from whatever archive capability the runtime offers.
 *
 * @module dsh-magica-castboard/host/exec/task-sessions
 */
import type { SessionArchiveResult, TaskRecord } from '../model.ts'

// Only non-empty sessionIds count: creator and claiming sessions may serve other tasks
// too, so they must not leak in. First-appearance order, de-duplicated.
export function taskAssociatedSessionIds(task: TaskRecord): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  const push = (raw: unknown): void => {
    if (typeof raw !== 'string') return
    const trimmed = raw.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) return
    seen.add(trimmed)
    result.push(trimmed)
  }

  if (Array.isArray(task.executions)) {
    for (const execution of task.executions) {
      if (execution !== null && typeof execution === 'object') push(execution.sessionId)
    }
  }
  return result
}

/**
 * Idempotent, best-effort archiving, one outcome per session. Called when a task enters
 * `archived` and from "retry archiving" on an archived task. Without the `archive`
 * callback everything is reported as `unsupported`.
 */
export async function archiveTaskSessions(
  task: TaskRecord,
  archive?: (id: string) => Promise<void>,
): Promise<SessionArchiveResult> {
  const sessionIds = taskAssociatedSessionIds(task)
  if (archive === undefined) return { archived: [], failed: [], unsupported: sessionIds }
  const result: SessionArchiveResult = { archived: [], failed: [], unsupported: [] }
  for (const sessionId of sessionIds) {
    try {
      await archive(sessionId)
      result.archived.push(sessionId)
    } catch (error) {
      result.failed.push({
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}
