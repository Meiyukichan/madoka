/**
 * Acceptance round entry point: hands "inject acceptance context → wake one round" to
 * the execution service.
 *
 * Why not implement it again at this layer: the injection idempotency marker
 * (`acceptanceInjectedAt`), session pool retention, and auxiliary-round settlement are
 * invariants of the execution engine; splitting them across two places would mean
 * maintaining two copies of the decision "when an acceptance round should start". This
 * module only **converts result shapes**, so routes and the tool layer receive a stable
 * `{ started, reason }`.
 *
 * @module dsh-magica-castboard/host/exec/acceptance-runner
 */
import type { RunRequestResult } from '../model.ts'

export interface AcceptanceRunFace {
  startAcceptanceRound(taskId: string, options?: { inject?: boolean }): Promise<RunRequestResult>
}

export interface AcceptanceRunnerDeps {
  execution: AcceptanceRunFace
}

export interface AcceptanceRunResult {
  started: boolean
  reason: string
}

export class AcceptanceRunner {
  private readonly deps: AcceptanceRunnerDeps

  constructor(deps: AcceptanceRunnerDeps) {
    this.deps = deps
  }

  /**
   * Idempotency comes from the engine's `acceptanceInjectedAt` guard: a card whose
   * marker is written is never injected or started again.
   *
   * @param taskId - Card in review.
   * @param options - `inject` carries the acceptance XML on this round (manual re-run);
   *   the automatic settlement round relies on the already-queued context instead.
   */
  async run(taskId: string, options?: { inject?: boolean }): Promise<AcceptanceRunResult> {
    try {
      const result = await this.deps.execution.startAcceptanceRound(taskId, options)
      return result.ok
        ? { started: true, reason: 'started' }
        : { started: false, reason: result.error }
    } catch (error) {
      return { started: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}
