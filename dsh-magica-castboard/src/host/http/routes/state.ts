/**
 * Read-only endpoints: the polling snapshot, health, diagnostics, protocol discovery,
 * and full-ledger backup. `GET /state` is the hottest read path (every five seconds),
 * so it sends summaries only and details are fetched when a card is opened. A push
 * stream is deliberately avoided: long-lived connections are hard to reclaim and each
 * open panel would pin a socket.
 *
 * Three revisions cover the three kinds of change — tasks, issues, and comment links —
 * plus a fingerprint for pending interactions. Any mismatch returns a full snapshot;
 * numeric cursors cover the first two and string cursors the last two.
 *
 * @module dsh-magica-castboard/host/http/routes/state
 */
import { eventLog } from '../../shared/event-log.ts'
import { withNextRunAt } from '../../dispatch/cron.ts'
import type { Route } from '../router.ts'
import {
  ENDPOINTS,
  PROTOCOL,
  created,
  fail,
  interactionFingerprint,
  pendingInteractionRecords,
  queryNumber,
  queryCursor,
  type RouteDeps,
} from './shared.ts'
import {
  LEDGER_SCHEMA_VERSION,
  type AcceptanceStrategy,
  type DiagnosticsResponse,
  type IssueLink,
  type StatePollResponse,
  type StateResponse,
  type TaskSummary,
} from '../../model.ts'

export function stateRoutes(deps: RouteDeps): readonly Route[] {
  return [
    {
      method: 'GET',
      path: '/version',
      handler: () => ({
        protocol: PROTOCOL,
        schemaVersion: LEDGER_SCHEMA_VERSION,
        endpoints: ENDPOINTS,
        ...(deps.version === undefined ? {} : { version: deps.version }),
      }),
    },

    {
      method: 'GET',
      path: '/health',
      handler: () => ({
        ok: true,
        role: deps.isWritable() ? 'owner' : 'secondary',
        instance: deps.instance(),
        protocol: PROTOCOL,
      }),
    },

    {
      method: 'GET',
      path: '/data-plane',
      handler: () => deps.dataPlane ?? { ok: true },
    },

    {
      method: 'GET',
      path: '/diagnostics',
      handler: async (): Promise<DiagnosticsResponse> => {
        // Diagnostics answer "what is on disk now", so catch up with the owner's writes first.
        await alignQuietly(deps)
        const ledger = deps.tasks.snapshot()
        let staleRunning = 0
        for (const task of ledger.tasks) {
          for (const execution of task.executions) {
            if (execution.outcome === 'running') staleRunning += 1
          }
        }
        return { revision: ledger.revision, tasks: ledger.tasks.length, staleRunning }
      },
    },

    {
      method: 'GET',
      path: '/state',
      handler: async (context): Promise<StatePollResponse> => {
        // All three loads are idempotent; the first poll after cold start must wait for them.
        await Promise.all([deps.tasks.load(), deps.issues.load(), deps.links.load()])

        const since = queryNumber(context, 'since')
        const issueSince = queryNumber(context, 'issueSince')
        // `ixSince` and `linkSince` keep their literal value: empty means "known empty", not "not sent".
        const interactionSince = queryCursor(context, 'ixSince')
        const linkSince = queryCursor(context, 'linkSince')

        const revision = deps.tasks.revision()
        const issueRevision = deps.issues.revision()
        const linkRevision = String(deps.links.revision())
        // The fingerprint must be computed first: a change in interactions alone still
        // requires a full snapshot, or the UI would never learn that someone is waiting.
        const interactions = await pendingInteractionRecords(deps.interactions)
        const interactionRevision = interactionFingerprint(interactions)

        const unchanged = since !== undefined && since === revision
          && (issueSince === undefined || issueSince === issueRevision)
          && (interactionSince === null || interactionSince === interactionRevision)
          && (linkSince === null || linkSince === linkRevision)
        if (unchanged) {
          return { unchanged: true, revision, issueRevision, interactionRevision, linkRevision }
        }

        const links = deps.links.snapshot()
        const summaries = deps.tasks.summaries()
        const catalog = await strategyCatalog(deps, summaries)
        return {
          schemaVersion: LEDGER_SCHEMA_VERSION,
          revision,
          issueRevision,
          linkRevision,
          interactionRevision,
          interactions,
          tasks: projectTasks(deps, summaries, links, catalog),
          issues: [...deps.issues.pending()],
          issueLinks: unreadLinks(links),
          ...(deps.version === undefined ? {} : { version: deps.version }),
          capabilities: { archiveSessions: canArchiveSessions(deps.execution) },
        }
      },
    },

    {
      method: 'POST',
      path: '/backup',
      handler: async () => {
        // Backup writes into the storage directory; a read-only window must not interleave with the owner.
        if (!deps.isWritable()) {
          throw fail('forbidden', `只有持有存储租约的窗口能写备份（${deps.ownerHint()}）`, 403)
        }
        return created({ backupFile: await deps.tasks.backup() })
      },
    },
  ]
}

function warn(event: string, detail: string): void {
  eventLog('warn', event, detail)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Read-only processes catch up with the owner here; on failure, answer from memory.
async function alignQuietly(deps: RouteDeps): Promise<void> {
  try {
    await deps.reload()
  } catch (error) {
    warn('read-refresh-failed', errorText(error))
  }
}

/**
 * Read the strategy file only when some card actually references a strategy; most polls
 * have none, and an unreadable file is rendered as "finalize as complete".
 */
async function strategyCatalog(
  deps: RouteDeps,
  summaries: readonly TaskSummary[],
): Promise<readonly AcceptanceStrategy[] | undefined> {
  const needed = summaries.some(summary => summary.acceptanceStrategyCount !== undefined)
  if (!needed) return undefined
  try {
    return await deps.acceptanceStrategies.list()
  } catch (error) {
    warn('acceptance-strategies-unreadable', errorText(error))
    return undefined
  }
}

/**
 * Inline strategies take precedence over catalog ids; a hit on `issue` means "dispatch
 * kind", otherwise "accept as complete". Only called for cards that have strategies.
 */
function acceptanceKindOf(
  deps: RouteDeps,
  summary: TaskSummary,
  catalog: readonly AcceptanceStrategy[] | undefined,
): 'close' | 'issue' | undefined {
  if (summary.acceptanceStrategyCount === undefined) return undefined
  const record = deps.tasks.get(summary.id)
  const inline = record?.acceptanceStrategies ?? []
  if (inline.some(strategy => strategy.type === 'issue')) return 'issue'
  const ids = record?.acceptanceStrategyIds ?? []
  if (ids.length === 0) return 'close'
  if (catalog === undefined) return 'close'
  return catalog.some(strategy => strategy.type === 'issue' && ids.includes(strategy.id)) ? 'issue' : 'close'
}

/**
 * Derive next run time, acceptance kind, and unread state on the fly; persisting them
 * would only create a copy that drifts.
 */
function projectTasks(
  deps: RouteDeps,
  summaries: readonly TaskSummary[],
  links: Record<string, IssueLink>,
  catalog: readonly AcceptanceStrategy[] | undefined,
): TaskSummary[] {
  const now = deps.now()
  return summaries.map((summary) => {
    let next = withNextRunAt(summary, now)
    const kind = acceptanceKindOf(deps, summary, catalog)
    if (kind !== undefined) next = { ...next, acceptanceKind: kind }
    // Compare link timestamps only; reading a jsonl per card is not viable on a five-second poll.
    const link = next.issueId === undefined ? undefined : links[next.issueId]
    if (link?.lastCommentAt !== undefined && link.lastCommentAt > (link.lastSeenAt ?? 0)) {
      next = { ...next, hasUnreadComments: true }
    }
    return next
  })
}

/** Only comment-bearing links are sent; almost every other row is just a session id. */
function unreadLinks(links: Record<string, IssueLink>): NonNullable<StateResponse['issueLinks']> {
  const out: NonNullable<StateResponse['issueLinks']> = {}
  for (const [issueId, link] of Object.entries(links)) {
    if (link.lastCommentAt === undefined) continue
    out[issueId] = {
      lastCommentAt: link.lastCommentAt,
      ...(link.lastSeenAt === undefined ? {} : { lastSeenAt: link.lastSeenAt }),
      hasUnread: link.lastCommentAt > (link.lastSeenAt ?? 0),
    }
  }
  return out
}

function canArchiveSessions(execution: unknown): boolean {
  return typeof (execution as { archiveSessions?: unknown } | null)?.archiveSessions === 'function'
}
