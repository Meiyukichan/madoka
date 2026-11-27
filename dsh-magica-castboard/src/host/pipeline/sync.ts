/**
 * Polling for pending issues online: merge "issues still `pending` under this machine's name" into the local ledger.
 *
 * A round has only four steps:
 *
 * ```
 * pull (local pending) -> pre-filter -> CAS claim -> cwd resolution -> normalize -> mergeRemote
 * ```
 *
 * Three rules:
 *
 * 1. **Filter before claiming**: claiming pushes the online status from `pending` to `accepted`. If a record is
 *    bound to be skipped during merge (tombstone, invalid id, already settled locally), claiming it early would
 *    needlessly corrupt the online status and hide it from other instances.
 * 2. **Schedule the next round only after the current one finishes**: no overlapping runs or pile-up; a slow round costs only that tick.
 * 3. **Log failures once**: a broken network emitting a warn every 3 seconds would drown the log, so log only at the
 *    "healthy -> failed" transition and at recovery.
 *
 * Only the storage lease holder should start it; read-only processes cannot write the ledger and catch up with the
 * holder's results from disk via `IssueStore.reloadIfChanged()`.
 *
 * @module dsh-magica-castboard/host/pipeline/sync
 */
import { normalizeIssueSource } from '../../shared/wire.ts'
import { mapLimit } from '../shared/async.ts'
import { eventLog } from '../shared/event-log.ts'
import { MAX_TITLE } from '../rules.ts'
import {
  type IssueMeta,
  type PermissionMode,
  type RemoteIssueDraft,
  type RemoteMergeReport,
  type Urgency,
} from '../model.ts'
import type { IssueStore } from '../ledger/issue-store.ts'
import { normalizeTimestamp, normalizeUrgency, type RemoteIssue } from './merge.ts'

export const DEFAULT_SYNC_INTERVAL_MS = 3_000

/** How long to wait before retrying a failed `cwd` resolution (ms). */
const PROJECT_RETRY_MS = 5 * 60_000

/** How many ticks between title refreshes (`3s x 20 ~ 60s`). */
const TITLE_REFRESH_EVERY = 20

/** Concurrency limit for `cwd -> project` resolution (the libuv thread pool has only 4 slots). */
const PROJECT_CONCURRENCY = 4

const PERMISSION_MODES: readonly PermissionMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * Shared-library issue fields visible to the sync layer; project/lineage/meta columns are only used for local persistence.
 */
export interface RemoteIssueView extends RemoteIssue {
  /** Project path (the only field that can locate a project across instances). */
  cwd?: string
  /** Permission value as received (`''` / `null` = follow this machine). */
  permission?: string
  assigner?: string
  /** Dispatcher lineage. */
  assignerTask?: string
  /** Assignee lineage. */
  assigneeTask?: string
  sourceInstance?: string
  assignerMeta?: IssueMeta | string | null
  assigneeMeta?: IssueMeta | string | null
  /** Dependency list value: array, JSON string or `null` (the server stores it without judging). */
  dependsOn?: readonly string[] | string | null
}

export interface IssueClaimOutcome {
  claimed: readonly string[]
  failed: readonly { issueId: string; reason: string }[]
}

/** Pull and claim face (injected by the SDK; when absent the whole channel degrades to local-only). */
export interface IssueSyncFace {
  /** Issues still `pending` under this machine's name. */
  myInstanceIssues: (input: { status: 'pending'; instance: string; os?: string }) => Promise<readonly RemoteIssueView[]>
  /** Online CAS claim (`pending -> accepted`). */
  claim: (input: { issueIds: readonly string[]; expectedStatus: 'pending' }) => Promise<IssueClaimOutcome>
  /**
   * Latest titles of started issues (cloud is authoritative).
   *
   * The teamwork SDK has no combined method for this, so the face can stay empty: absent = do not refresh titles.
   */
  refreshTitles?: () => Promise<readonly { id: string; title: string }[]>
}

export interface SyncDeps {
  /** Issue ledger (the only merge outlet). */
  issues: IssueStore
  face?: IssueSyncFace
  /** This machine's instance id (`ip:port`). */
  instance: () => string
  /** Operating system id (needed by some shared-library queries). */
  os?: () => string | undefined
  /**
   * `cwd -> local workspaceId`; absent = leave all empty.
   *
   * A failed resolution (path missing / registry unavailable) is cached per cwd for {@link PROJECT_RETRY_MS},
   * so one remote path is not retried every 3 seconds.
   */
  resolveWorkspace?: (cwd: string) => Promise<string | undefined>
  refreshTitles?: () => Promise<readonly { id: string; title: string }[]>
  /** Whether this process holds the storage lease; checked every tick so a demotion between ticks is caught. */
  isOwner?: () => boolean
  /** Current time (epoch ms, injected in tests). */
  now?: () => number
  intervalMs?: number
  timers?: { set: (callback: () => void, delayMs: number) => unknown; clear: (handle: unknown) => void }
  log?: (level: 'info' | 'warn', event: string, detail?: string) => void
}

export interface SyncTickResult {
  fetched: number
  /** Count that passed local pre-filtering and are worth claiming. */
  claimable: number
  claimed: number
  inserted: number
  updated: number
  skipped: number
  unchanged: number
  rejected: number
  error?: string
}

function emptyTick(): SyncTickResult {
  return { fetched: 0, claimable: 0, claimed: 0, inserted: 0, updated: 0, skipped: 0, unchanged: 0, rejected: 0 }
}

function applyReport(base: SyncTickResult, report: RemoteMergeReport): SyncTickResult {
  return {
    ...base,
    inserted: report.inserted.length,
    updated: report.updated.length,
    skipped: report.skipped.length,
    unchanged: report.unchanged.length,
    rejected: report.rejected.length,
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A value exists only when non-empty after trim (a nullable online column may be `null` or `''`). */
function text(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  return value.length > 0 ? value : undefined
}

function clampTitle(raw: string): string {
  const title = raw.trim()
  return title.length > MAX_TITLE ? title.slice(0, MAX_TITLE) : title
}

function metaText(meta: IssueMeta | undefined, key: string): string | undefined {
  if (meta === undefined) return undefined
  const value = meta[key]
  return typeof value === 'string' ? text(value) : undefined
}

/**
 * Parse an online meta column.
 *
 * The convention is a JSON object string, but the server stores it as plain text: bad JSON, arrays and plain text all
 * count as absent, so downstream only needs to handle "object" and "absent".
 */
function parseMeta(raw: IssueMeta | string | null | undefined): IssueMeta | undefined {
  if (typeof raw === 'string') {
    const value = text(raw)
    if (value === undefined) return undefined
    try {
      const parsed = JSON.parse(value) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      return parsed as IssueMeta
    } catch {
      return undefined
    }
  }
  if (raw === null || raw === undefined || Array.isArray(raw)) return undefined
  return raw
}

/**
 * Normalize the dependency list: always `string[]`.
 *
 * The wire value may be an array, a JSON string or `null`; a bad shape counts as "no dependencies" (the server only stores it).
 */
function parseDependsOn(raw: readonly string[] | string | null | undefined): string[] {
  let rows: readonly unknown[] = []
  if (Array.isArray(raw)) {
    rows = raw
  } else if (typeof raw === 'string') {
    const value = raw.trim()
    if (value === '') return []
    try {
      const parsed = JSON.parse(value) as unknown
      if (Array.isArray(parsed)) rows = parsed
    } catch {
      return []
    }
  }
  const ids: string[] = []
  for (const item of rows) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id !== '' && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function parsePermission(raw: string | null | undefined): PermissionMode | undefined {
  const value = text(raw)
  return value !== undefined && (PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as PermissionMode)
    : undefined
}

/**
 * Online request -> ledger title, **always non-empty**.
 *
 * Title is a required field of the creation API and is normally available; `summary`, the first body line and the
 * first 8 characters of the id are fallbacks for rows written before the convention existed and external sources that
 * do not write meta as agreed. The ledger requires a non-empty title, so this fallback chain is mandatory.
 */
function titleOf(id: string, meta: IssueMeta | undefined, view: RemoteIssueView): string {
  const explicit = metaText(meta, 'title') ?? metaText(meta, 'summary') ?? text(view.title)
  if (explicit !== undefined) return clampTitle(explicit)
  const body = metaText(meta, 'detail') ?? metaText(meta, 'description') ?? text(view.detail)
  if (body !== undefined) {
    const firstLine = text(body.split(/\r?\n/, 1)[0])
    if (firstLine !== undefined) return clampTitle(firstLine)
  }
  return id.slice(0, 8)
}

/**
 * Online request -> ledger body: `detail`, then `description`, then unformatted meta text, so information is not lost.
 */
function detailOf(meta: IssueMeta | undefined, view: RemoteIssueView): string {
  const structured = metaText(meta, 'detail') ?? metaText(meta, 'description') ?? text(view.detail)
  if (structured !== undefined) return structured
  return text(typeof view.assignerMeta === 'string' ? view.assignerMeta : undefined) ?? ''
}

/** Pull polling. One instance = one pending timer; after `dispose()` there are no further side effects. */
export class IssueSyncService {
  private readonly deps: SyncDeps
  private handle: unknown
  private disposed = false
  private started = false
  /** The last round is still in flight (this stops an external manual trigger from overlapping). */
  private inFlight = false
  /** Whether the last round failed (used only to debounce logging). */
  private failing = false
  private ticks = 0
  private skippedRounds = 0
  /** Cross-tick cache for `cwd -> project` (`''` = failed resolution; `at` is used to compute the retry interval). */
  private readonly projects = new Map<string, { id: string; at: number }>()

  constructor(deps: SyncDeps) {
    this.deps = deps
  }

  private get intervalMs(): number {
    const raw = this.deps.intervalMs
    return raw !== undefined && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SYNC_INTERVAL_MS
  }

  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    this.arm(0)
  }

  /** Stop the timer. An in-flight round finishes on its own (it writes the complete ledger, never half a record). */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  async tick(): Promise<SyncTickResult> {
    const base = emptyTick()
    if (this.disposed) return base
    const face = this.deps.face
    if (face === undefined) return base
    if (!this.safeOwner()) return { ...base, error: 'not-owner' }
    if (this.inFlight) {
      this.skippedRounds += 1
      if (this.skippedRounds % 10 === 1) {
        this.log('info', 'issue-sync-skip', `上一轮还没走完，跳过第 ${String(this.skippedRounds)} 拍`)
      }
      return { ...base, error: 'busy' }
    }

    this.inFlight = true
    this.skippedRounds = 0
    const startedAt = this.now()
    try {
      await this.deps.issues.load()
      if (this.disposed) return base

      await this.refreshTitlesIfDue()
      if (this.disposed) return base

      const views = await face.myInstanceIssues({
        status: 'pending',
        instance: this.deps.instance(),
        ...(this.deps.os?.() === undefined ? {} : { os: this.deps.os?.() }),
      })
      if (this.disposed) return base

      const { targets, claimable } = await this.claimableViews(views)
      const claimed = await this.claimAll(targets)
      if (claimed.length === 0) {
        if (views.length > 0) {
          this.log('info', 'issue-sync-nothing-claimed', `拉到 ${String(views.length)} 条，但没有一条可以落到本地`)
        }
        this.recoverLog()
        return { ...base, fetched: views.length, claimable }
      }

      // The online CAS claim already moved pending -> accepted. Mirror that immediately
      // into the local index/detail before the slower merge, so the panel and router
      // never observe a claimed issue as still pending.
      await this.markClaimedAccepted(claimed)

      const projects = await this.resolveProjects(claimed)
      const drafts = this.toDrafts(claimed, projects)
      const report = await this.deps.issues.mergeRemote(drafts, this.now())
      const result = applyReport({ ...base, fetched: views.length, claimable, claimed: claimed.length }, report)
      this.log(
        'info',
        'issue-sync-applied',
        `fetched=${String(result.fetched)} claimed=${String(result.claimed)}`
        + ` inserted=${String(result.inserted)} updated=${String(result.updated)}`
        + ` skipped=${String(result.skipped)} unchanged=${String(result.unchanged)}`
        + ` rejected=${String(result.rejected)}`,
      )
      const elapsed = this.now() - startedAt
      if (elapsed > this.intervalMs) {
        this.log('warn', 'issue-sync-slow', `本轮耗时 ${String(elapsed)}ms，超过间隔 ${String(this.intervalMs)}ms`)
      }
      this.recoverLog()
      return result
    } catch (error) {
      const message = errorText(error)
      if (!this.failing) {
        this.failing = true
        this.log('warn', 'issue-sync-failed', message)
      }
      return { ...base, error: message }
    } finally {
      this.inFlight = false
    }
  }

  /**
   * Pre-filter: keep only the ids that would really be persisted during merge.
   *
   * The order is "pull -> claim -> merge", and claiming pushes the online status to `accepted`. Removing tombstones,
   * invalid ids and locally settled records first prevents the online status from being needlessly corrupted.
   */
  private async markClaimedAccepted(views: readonly RemoteIssueView[]): Promise<void> {
    for (const view of views) {
      const id = text(view.issueId)
      if (id === undefined) continue
      await this.deps.issues.update(id, draft => {
        if (draft.status === 'pending') draft.status = 'accepted'
      }).catch(error => {
        this.log('warn', 'issue-claim-local-status-failed', `${id}: ${errorText(error)}`)
      })
    }
  }

  private async claimableViews(
    views: readonly RemoteIssueView[],
  ): Promise<{ targets: RemoteIssueView[]; claimable: number }> {
    const byId = new Map<string, RemoteIssueView>()
    for (const view of views) {
      const id = text(view.issueId)
      if (id === undefined) continue
      byId.set(id, { ...view, issueId: id })
    }
    if (byId.size === 0) return { targets: [], claimable: 0 }
    const ids = [...byId.keys()]
    const claimable = await this.deps.issues.claimable(ids)
    const allowed = new Set(claimable)
    const targets = ids.filter(id => allowed.has(id)).map(id => byId.get(id)!)
    if (targets.length < ids.length) {
      this.log(
        'info',
        'issue-claim-skipped',
        `跳过 ${String(ids.length - targets.length)} 条不值得认领的（墓碑 / 本地已决），线上状态保持不动`,
      )
    }
    return { targets, claimable: claimable.length }
  }

  /**
   * Claim this round's targets and return those actually won (input order is preserved).
   *
   * - no claim face configured (tests / offline) -> return as-is and persist as `pending`;
   * - the whole claim fails -> rethrow to {@link tick} and write nothing locally this round (rather wait for the next
   *   round than write a record that "local thinks it claimed but the cloud has not");
   * - accept only the `claimed` list: the `failed` ones belong to other instances.
   */
  private async claimAll(targets: readonly RemoteIssueView[]): Promise<RemoteIssueView[]> {
    if (targets.length === 0) return []
    const claim = this.deps.face?.claim
    if (claim === undefined) return [...targets]
    const outcome = await claim({
      issueIds: targets.map(view => view.issueId),
      expectedStatus: 'pending',
    })
    if (outcome.failed.length > 0) {
      const reasons = [...new Set(outcome.failed.map(item => item.reason))].join(',')
      this.log(
        'info',
        'issue-claim-partial',
        `${String(outcome.claimed.length)} 条认领成功，${String(outcome.failed.length)} 条没抢到（${reasons}）`,
      )
    }
    const won = new Set(outcome.claimed)
    return targets.filter(view => won.has(view.issueId))
  }

  /**
   * Resolve every `cwd` seen in this round as a batch.
   *
   * A path is resolved once per round, and fields are mapped only after all resolutions finish; successful results
   * are cached across rounds, failures for {@link PROJECT_RETRY_MS}.
   */
  private async resolveProjects(views: readonly RemoteIssueView[]): Promise<Map<string, string>> {
    const now = this.now()
    const paths = new Set<string>()
    for (const view of views) {
      const cwd = text(view.cwd)
      if (cwd !== undefined) paths.add(cwd)
    }

    const resolved = new Map<string, string>()
    const pending: string[] = []
    for (const cwd of paths) {
      const cached = this.projects.get(cwd)
      if (cached !== undefined && (cached.id !== '' || now - cached.at < PROJECT_RETRY_MS)) {
        resolved.set(cwd, cached.id)
        continue
      }
      pending.push(cwd)
    }

    const resolver = this.deps.resolveWorkspace
    if (resolver !== undefined && pending.length > 0) {
      const ids = await mapLimit(pending, PROJECT_CONCURRENCY, async (cwd) => {
        try {
          return (await resolver(cwd)) ?? ''
        } catch (error) {
          this.log('warn', 'issue-workspace-resolve-failed', `${cwd}: ${errorText(error)}`)
          return ''
        }
      })
      pending.forEach((cwd, index) => {
        const id = ids[index] ?? ''
        resolved.set(cwd, id)
        this.projects.set(cwd, { id, at: now })
      })
    } else {
      for (const cwd of pending) resolved.set(cwd, '')
    }

    if (paths.size > 0) {
      let missing = 0
      for (const id of resolved.values()) if (id === '') missing += 1
      this.log(
        'info',
        'issue-projects-resolved',
        `${String(paths.size)} 个 cwd（去重后）：${String(paths.size - missing)} 个落到本机项目，${String(missing)} 个不存在或解析失败`,
      )
    }
    return resolved
  }

  private toDrafts(
    views: readonly RemoteIssueView[],
    projects: ReadonlyMap<string, string>,
  ): RemoteIssueDraft[] {
    const drafts: RemoteIssueDraft[] = []
    for (const view of views) {
      const id = text(view.issueId)
      if (id === undefined) continue
      const cwd = text(view.cwd)
      const meta = parseMeta(view.assignerMeta)
      const assigneeMeta = parseMeta(view.assigneeMeta)
      const permission = parsePermission(view.permission)
      const dependsOn = parseDependsOn(view.dependsOn)
      const urgency: Urgency = normalizeUrgency(view.urgency)
      const assigner = text(view.assigner)
      const assignerTask = text(view.assignerTask)
      const assignee = text(view.assignee)
      const assigneeTask = text(view.assigneeTask)
      const assigneeInstance = text(view.assigneeInstance)
      const source = normalizeIssueSource(text(view.source))
      const sourceInstance = text(view.sourceInstance)
      const projectId = typeof view.projectId === 'number' && Number.isInteger(view.projectId)
        ? view.projectId
        : undefined
      drafts.push({
        id,
        ...(projectId === undefined ? {} : { projectId }),
        title: titleOf(id, meta, view),
        detail: detailOf(meta, view),
        workspaceId: cwd === undefined ? '' : (projects.get(cwd) ?? ''),
        urgency,
        // Claimed -> accepted; no claim face (tests / offline) -> pending.
        ...(this.deps.face?.claim === undefined ? {} : { status: 'accepted' as const }),
        ...(meta === undefined ? {} : { assignerMeta: meta }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(permission === undefined ? {} : { permission }),
        ...(assigner === undefined ? {} : { assigner }),
        ...(assignerTask === undefined ? {} : { assignerTask }),
        ...(assignee === undefined ? {} : { assignee }),
        ...(assigneeTask === undefined ? {} : { assigneeTask }),
        ...(assigneeInstance === undefined ? {} : { assigneeInstance }),
        ...(assigneeMeta === undefined ? {} : { assigneeMeta }),
        ...(source === undefined ? {} : { source }),
        ...(sourceInstance === undefined ? {} : { sourceInstance }),
        ...(dependsOn.length === 0 ? {} : { dependsOn }),
        ...(view.createdAt === undefined ? {} : { createdAt: normalizeTimestamp(view.createdAt, this.now()) }),
      })
    }
    return drafts
  }

  /**
   * Low-frequency refresh of started issues' titles.
   *
   * The main pull only fetches `pending`, so started records never enter the merge; yet titles are cloud-authoritative
   * (the dispatcher renames them after they run). Throttled by tick count, display fields only, and failure does not affect the main flow.
   */
  private async refreshTitlesIfDue(): Promise<void> {
    this.ticks += 1
    const due = this.ticks === 1 || this.ticks % TITLE_REFRESH_EVERY === 0
    const refresh = this.deps.refreshTitles
    if (!due || refresh === undefined || this.disposed) return
    try {
      const entries = await refresh()
      if (entries.length === 0 || this.disposed) return
      const changed = await this.deps.issues.refreshTitles(entries, this.now())
      if (changed > 0) this.log('info', 'issue-titles-refreshed', `${String(changed)} 条标题按云端刷新`)
    } catch (error) {
      this.log('warn', 'issue-title-refresh-failed', errorText(error))
    }
  }

  private recoverLog(): void {
    if (!this.failing) return
    this.failing = false
    this.log('info', 'issue-sync-recovered', '线上待规划拉取已恢复')
  }

  /** The `isOwner` implementation may throw (failed lease-file read); fold that to false here. */
  private safeOwner(): boolean {
    try {
      return this.deps.isOwner?.() !== false
    } catch {
      return false
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Schedule the next round; this runs only after the last one finished, so the period is roughly interval + one round. */
  private arm(delayMs: number): void {
    if (this.disposed) return
    this.clearTimer()
    const set = this.deps.timers?.set ?? ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms)
      // Without unref, a short-lived host process would be held open and could not exit.
      timer.unref?.()
      return timer
    })
    this.handle = set(() => {
      this.handle = undefined
      void this.tick()
        .catch((error: unknown) => { this.log('warn', 'issue-sync-tick-failed', errorText(error)) })
        .finally(() => { this.arm(this.intervalMs) })
    }, delayMs)
  }

  private clearTimer(): void {
    if (this.handle === undefined) return
    const clear = this.deps.timers?.clear ?? ((handle: unknown) => { clearTimeout(handle as Parameters<typeof clearTimeout>[0]) })
    clear(this.handle)
    this.handle = undefined
  }

  private log(level: 'info' | 'warn', event: string, detail?: string): void {
    const sink = this.deps.log
    if (sink !== undefined) {
      try {
        sink(level, event, detail)
        return
      } catch {
        // A broken logging face must not affect sync.
      }
    }
    eventLog(level, event, detail ?? '')
  }
}
