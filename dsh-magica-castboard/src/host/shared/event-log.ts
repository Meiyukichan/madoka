/**
 * Structured event log shared by every host module.
 *
 * Uses the spellbook event logger so events land in the same weekly NDJSON stream as the
 * rest of the system. Never writes to stdout/stderr: `dsh web` owns the terminal, and
 * host diagnostics must not pollute it.
 */
import { createEventLogger, type LogLevel } from '@meiyukichan/dsh-magica-spellbook'

const logger = createEventLogger('dsh-magica-castboard')

export function eventLog(level: LogLevel, event: string, detail = ''): void {
  try {
    logger.logEvent(level, event, detail)
  } catch {
    // Logging is diagnostic only; never let it take down the caller.
  }
}
