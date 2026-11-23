/**
 * Storage facade for the acceptance strategy file.
 *
 * Parsing and atomic writes stay in `../exec/acceptance.ts`; this file just binds that
 * logic to one absolute path for the settings route and the assembly layer.
 *
 * @module dsh-magica-castboard/host/ledger/config-stores
 */
import { join } from 'node:path'

import {
  normalizeAcceptanceStrategies,
  readAcceptanceStrategies,
  writeAcceptanceStrategies,
  type AcceptanceStrategy,
  type AcceptanceStrategyFile,
} from '../exec/acceptance.ts'
import type { CastboardPaths } from './paths.ts'

export {
  ACCEPTANCE_STRATEGY_SCHEMA_VERSION,
  ACCEPTANCE_TYPES,
  MAX_ACCEPTANCE_PER_TASK,
  MAX_ACCEPTANCE_STRATEGIES,
  MAX_ACCEPTANCE_TEXT_CHARS,
  MAX_ACCEPTANCE_TITLE_CHARS,
  acceptanceIdFor,
  acceptanceStrategyText,
  emptyAcceptanceStrategies,
  normalizeAcceptanceStrategies,
  normalizeInlineAcceptanceStrategies,
  parseAcceptanceStrategies,
  readAcceptanceStrategies,
  writeAcceptanceStrategies,
} from '../exec/acceptance.ts'
export type { AcceptanceStrategy, AcceptanceStrategyFile, AcceptanceType } from '../exec/acceptance.ts'

export class AcceptanceStrategyStore {
  private readonly file: string

  /** @param source - A path bundle, or the strategy file's absolute path. */
  constructor(source: CastboardPaths | string) {
    this.file = typeof source === 'string' ? source : join(source.root, 'castboard-strategy.json')
  }

  get path(): string {
    return this.file
  }

  async read(): Promise<AcceptanceStrategyFile> {
    return await readAcceptanceStrategies(this.file)
  }

  /** Read fresh each time; there is no cache to invalidate. */
  async list(): Promise<readonly AcceptanceStrategy[]> {
    return (await this.read()).strategies
  }

  /**
   * Replace the whole set: strict validation first, one atomic write last.
   *
   * A malformed entry, a duplicate name, or an exceeded cap throws a readable error that
   * the route layer turns into a 400.
   */
  async replace(input: unknown): Promise<readonly AcceptanceStrategy[]> {
    const strategies = normalizeAcceptanceStrategies(input)
    const value = await writeAcceptanceStrategies(this.file, strategies)
    return value.strategies
  }
}
