/**
 * Spill an over-long execution error to a cache file.
 *
 * The task context is allowed to carry a path to the full log instead of
 * hundreds of kilobytes of stack trace. The task record itself is never
 * mutated; the caller gets a shallow clone with only the last finished
 * execution's `error` replaced by the file path.
 *
 * @module dsh-magica-castboard/host/exec/error-file
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ExecutionRecord, TaskRecord } from '../model.ts'

/** Errors at or below this many characters stay inline. */
export const MAX_INLINE_ERROR_CHARS = 4_000

const ERROR_FILE_NAME = 'last-execution.log'

export interface SpillErrorOptions {
  /** `<storage>/.cache`; omitted = keep the error inline. */
  readonly cacheDir?: string
  /** Issue id when the card came from an issue; task id otherwise. */
  readonly ownerId?: string
  readonly log?: (level: 'warn', event: string, detail: string) => void
}

function lastFinished(task: TaskRecord): ExecutionRecord | undefined {
  return [...task.executions].reverse().find(execution => execution.outcome !== 'running')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Return `task` unchanged when the error is short or cannot be persisted;
 * otherwise return a clone whose `<last_execution><error>` points at the file.
 */
export async function spillExecutionError(task: TaskRecord, options: SpillErrorOptions): Promise<TaskRecord> {
  const execution = lastFinished(task)
  const error = execution?.error
  if (execution === undefined || error === undefined || error === '' || error.length <= MAX_INLINE_ERROR_CHARS) {
    return task
  }
  if (options.cacheDir === undefined || options.cacheDir === '') return task

  const owner = options.ownerId === undefined || options.ownerId === '' ? task.id : options.ownerId
  const dir = join(options.cacheDir, owner)
  const file = join(dir, ERROR_FILE_NAME)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(file, error, 'utf8')
  } catch (caught) {
    // Losing the error file is worse than keeping the large inline message.
    options.log?.('warn', 'execution-error-spill-failed', `${task.id}: ${errorText(caught)}`)
    return task
  }

  return {
    ...task,
    executions: task.executions.map(entry => entry.id === execution.id ? { ...entry, error: file } : entry),
  }
}
