/**
 * Backfill of the source channel for cards that have none.
 *
 * `source` (`dsh` / `im` …) decides two execution-scheduling rules: cards
 * from `im` do not consume a concurrency slot, and they run immediately once
 * forwarded. Both are judged from the summary on hot paths (every dispatcher drain,
 * every execution-gate run), so the source is read only from **task ledger fields** in
 * this process and never goes back to the issue ledger.
 *
 * New cards copy their source at creation time; this module handles only **cards
 * created before the `source` field existed in the ledger**: they have an `issueId` but
 * no `source`, so the source is filled once from the originating issue. When it cannot
 * be filled (the issue was physically removed or was never synced), the field stays
 * empty and the card is treated as an ordinary card — guessing a source is more
 * dangerous than leaving it blank.
 *
 * A failed backfill only logs: such cards keep running as ordinary cards, and the
 * attempt is made again the next time one becomes the owner.
 *
 * @module dsh-magica-castboard/host/exec/source-backfill
 */
import type { TaskLedger, TaskRecord, TaskSummary } from '../model.ts'
import { eventLog } from '../shared/event-log.ts'
import { normalizeIssueSource } from '../../shared/wire.ts'

/** Ledger face; tests may pass a narrow implementation. */
export interface TaskSourceBackfillStore {
  load(): Promise<void>
  summaries(): readonly TaskSummary[]
  mutate(
    kind: 'task-updated',
    mutator: (ledger: TaskLedger) => TaskRecord[] | undefined,
  ): Promise<unknown>
}

export interface TaskSourceBackfillDeps {
  readonly store: TaskSourceBackfillStore
  /**
   * Look up the source channel by issue id (wired to `issues.summary(id)?.source`).
   * Reads the issue ledger's in-memory index, not disk.
   */
  readonly issueSourceOf: (issueId: string) => string | undefined
}

function missingSource(summary: TaskSummary): boolean {
  return summary.issueId !== undefined
    && summary.issueId !== ''
    && (summary.source === undefined || summary.source === '')
}

/**
 * Fill in the source for cards missing it. One `mutate`, so no half-filled state is
 * ever written; returns the number of cards filled.
 */
export async function backfillTaskSources(deps: TaskSourceBackfillDeps): Promise<number> {
  const store = deps.store
  await store.load()
  const pending = store.summaries().filter(missingSource)
  // The vast majority of ledgers have no such cards: decide in memory and return
  // without touching disk.
  if (pending.length === 0) return 0

  let filled = 0
  try {
    await store.mutate('task-updated', ledger => {
      const touched: TaskRecord[] = []
      for (const task of ledger.tasks) {
        if (task.issueId === undefined || task.issueId === '') continue
        if (task.source !== undefined && task.source !== '') continue
        const source = deps.issueSourceOf(task.issueId)
        if (source === undefined || source === '') continue
        task.source = normalizeIssueSource(source)
        filled += 1
        touched.push(task)
      }
      return touched.length === 0 ? undefined : touched
    })
  } catch (error) {
    eventLog('warn', 'task-source-backfill-failed', errorText(error))
    return 0
  }
  if (filled > 0) {
    eventLog('info', 'task-source-backfilled', `${filled} 张卡补上了来源通道`)
  }
  return filled
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
