/**
 * Single-round portrait executor: turns one ledger entry into one session round and reports whether
 * the file actually landed.
 *
 * The caller probes the file before dispatch to choose create vs. update, records `in_progress`,
 * then relies on {@link runPortraitTurn}. The only success criterion is `stat().size > 0`; a round
 * that throws still returns (`ok: false`) so settlement always runs and no entry stays stuck.
 *
 * @module dsh-magica-castboard/host/portrait/runner
 */
import { stat } from 'node:fs/promises'

import {
  PORTRAIT_TARGET_SECTION,
  portraitInstruction,
  portraitTargetXml,
  type PortraitTarget,
} from './prompt.ts'
import type { PortraitEntry, PortraitLog } from './store.ts'

// `error` is human-readable and lands in the log and the ledger's `error` field.
export type PortraitTurnOutcome = { ok: true } | { ok: false; error: string }

export interface PortraitSessionFace {
  readonly id: string
  readonly resumed: boolean
  /** `contexts` are appended to this step's message, after the instruction. */
  run(instruction: string, contexts?: readonly { name: string; text: string }[]): Promise<PortraitTurnOutcome>
  dispose(): Promise<void>
}

export interface PortraitRoundDeps {
  /** True only for an existing file with content; a zero-byte file means "created, not written". */
  readonly portraitWritten: (workspaceId: string) => Promise<boolean>
  readonly outputFileFor: (workspaceId: string) => string
  readonly indexFile: string
  readonly log?: PortraitLog
}

export interface PortraitTurnResult {
  readonly outcome: PortraitTurnOutcome
  readonly written: boolean
}

export async function preparePortraitTarget(deps: PortraitRoundDeps, entry: PortraitEntry): Promise<PortraitTarget> {
  let exists = false
  try {
    exists = await deps.portraitWritten(entry.id)
  } catch (error) {
    // Defaults to create; one failed stat should not throw away the tick.
    deps.log?.('warn', 'portrait-stat-failed', `${entry.id}：${errorText(error)}`)
  }
  return {
    id: entry.id,
    path: entry.path,
    title: entry.title,
    outputFile: deps.outputFileFor(entry.id),
    indexFile: deps.indexFile,
    portraitExists: exists,
  }
}

export async function runPortraitTurn(
  deps: PortraitRoundDeps,
  target: PortraitTarget,
  session: PortraitSessionFace,
): Promise<PortraitTurnResult> {
  let outcome: PortraitTurnOutcome
  try {
    outcome = await session.run(portraitInstruction(target), [
      { name: PORTRAIT_TARGET_SECTION, text: portraitTargetXml(target) },
    ])
  } catch (error) {
    // Fold into ok:false so the caller still settles.
    outcome = { ok: false, error: `会话这一轮直接抛错：${errorText(error)}` }
  }
  let written = false
  try {
    written = await deps.portraitWritten(target.id)
  } catch (error) {
    deps.log?.('warn', 'portrait-stat-failed', `${target.id}：${errorText(error)}`)
  }
  return { outcome, written }
}

/**
 * True only for a regular file larger than 0 bytes. An empty file means "created but not written" —
 * exactly the self-report we refuse to trust.
 */
export async function portraitFileWritten(file: string): Promise<boolean> {
  try {
    const info = await stat(file)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
