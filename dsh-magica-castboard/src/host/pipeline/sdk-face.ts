/**
 * SDK face adapter: wraps `dsh-magica-teamwork`'s `createCastboardClient` into the four narrow interfaces the pipeline needs.
 *
 * Why this layer exists:
 * - pipeline modules depend only on **narrow interfaces** (unit-testable) and are not coupled to SDK method names;
 * - when the package or a method is missing, **the whole channel degrades to local-only** (never blocks the ledger);
 * - dynamic import: deployments without teamwork installed can still start the plugin.
 *
 * @module dsh-magica-castboard/host/sdk-face
 */
import { createEventLogger } from '@meiyukichan/dsh-magica-spellbook'

import { eventLog } from '../shared/event-log.ts'

/** Registered owner of the `dsh` source code. */
const ISSUE_SOURCE_PLUGIN_NAME = '@meiyukichan/dsh-magica-castboard'

/** Shared teamwork SDK logger: same spellbook NDJSON stream, separate plugin directory. */
const teamworkLogger = createEventLogger('dsh-magica-teamwork')

/** Face for batch-looking up issue status by id (dependency gate / issue tools). */
export interface IssueStatusFace {
  statuses: (issueIds: readonly string[]) => Promise<Readonly<Record<string, string | null>>>
}
import type { IssueQueryFace } from './sdk-query.ts'
import type { RemoteArtifactsFace } from './remote.ts'
import type { FinalizeRemoteInput } from './finalize.ts'
import type { RemoteComment, RemoteCommentsFace } from './remote.ts'
import type { IssueSyncFace } from './sync.ts'
import type { RemoteIssue } from './merge.ts'

/** The small slice of the SDK we use (typed as `any` so SDK types stay out of the host bundle). */
type AnyFn = (...args: never[]) => unknown

export interface CastboardClientLike {
  baseUrl?: string
  /** SDK client 自身的会话状态（不是 `client.auth.*` API 面）。 */
  state?: unknown
  accountId?: string | null
  accountDisplayName?: string | null
  globalRole?: unknown
  project?: {
    list?: AnyFn
    mine?: AnyFn
    members?: AnyFn
  }
  device?: { mine?: AnyFn; list?: AnyFn; sync?: AnyFn }
  teamwork?: {
    project?: Record<string, AnyFn>
    device?: Record<string, AnyFn>
  }
  auth?: {
    me?: AnyFn
    state?: unknown
    accountId?: string | null
    accountDisplayName?: string | null
    login?: AnyFn
    logout?: AnyFn
  }
  file?: { upload?: AnyFn; download?: AnyFn }
  issueAttachmentAdd?: AnyFn
  issue?: {
    get?: AnyFn
    list?: AnyFn
    workspaces?: { list?: AnyFn }
    attachments?: { add?: AnyFn; list?: AnyFn }
    attachment?: { add?: AnyFn; list?: AnyFn }
    comment?: { listSince?: AnyFn }
    updateStatuses?: AnyFn
  }
  castboardMyInstanceIssues?: AnyFn
  castboardWorkspaceIndexes?: AnyFn
  castboardWorkspacePortal?: AnyFn
  issueClaim?: AnyFn
  issueFinalize?: AnyFn
  issueRouting?: AnyFn
  issueAbandon?: AnyFn
  issueRunning?: AnyFn
  issueRouted?: AnyFn
  castboardIssueStatuses?: AnyFn
  castboardAddIssueComments?: AnyFn
  castboardIssueComments?: AnyFn
  castboardIssueSources?: AnyFn
  castboardAddIssueSource?: AnyFn
  ops?: { probe?: AnyFn }
  probe?: AnyFn
}

export type SdkLoader = () => Promise<{
  createCastboardClient?: (options?: Record<string, unknown>) => CastboardClientLike
  CastboardClient?: new (options?: Record<string, unknown>) => CastboardClientLike
  getLocalIp?: () => string
  mineInstance?: () => string
}>

export interface RemoteFinalizeFace {
  finalize: (input: { issueId: string } & FinalizeRemoteInput) => Promise<void>
}

/** A comment in the shared library (moved into the local stream on conversion). */
export interface SdkIssueComment {
  id: string
  body: string
  createdAt: number
  role?: string
  authorType?: string
  author?: string
}

/** One cloud attachment row (metadata only; no local path). */
export interface SdkIssueAttachmentMeta {
  fileId: string
  fileName: string
  targetType: 'issue' | 'comment'
  targetId: string
  role: 'assigner' | 'assignee'
  description?: string
}

export type AuthState = 'authenticated' | 'login_required' | 'anonymous'

/** Project CRUD/member operations used by the teamwork project page. */
export interface ProjectsFace {
  list(query: {
    pageNum?: number
    pageSize?: number
    keyword?: string
    includeArchived?: boolean
  }): Promise<{ total: number; pageNum: number; pageSize: number; items: readonly Record<string, unknown>[] }>
  mine(query?: { includeArchived?: boolean }): Promise<readonly Record<string, unknown>[]>
  detail(id: number): Promise<Record<string, unknown>>
  create(input: {
    name: string
    visibility?: string
    description?: string
    owner?: string
  }): Promise<Record<string, unknown>>
  update(id: number, input: {
    name?: string
    description?: string | null
    visibility?: string
    status?: string
  }): Promise<Record<string, unknown>>
  remove(id: number): Promise<void>
  members(id: number): Promise<readonly Record<string, unknown>[]>
  searchAccounts(id: number, keyword: string): Promise<readonly Record<string, unknown>[]>
  memberAdd(id: number, input: { accountId: string; role?: string }): Promise<void>
  memberRemove(id: number, accountId: string): Promise<void>
  transferOwner(id: number, accountId: string): Promise<void>
}

/** Device operations used by the device page. */
export interface DevicesFace {
  mine(query?: { pageNum?: number; pageSize?: number }): Promise<{
    total: number
    pageNum: number
    pageSize: number
    items: readonly Record<string, unknown>[]
  }>
  create(input: { host: string; port?: number; os?: string }): Promise<void>
  remove(id: number | string): Promise<void>
}

export interface AuthSnapshot {
  state: AuthState
  accountId?: string
  displayName?: string
}

/** Login/logout/state over the shared library's auth API. */
export interface AuthFace {
  status(): AuthSnapshot
  /** Refresh live account metadata (notably `globalRole`) from the server. */
  refresh?(): Promise<void>
  login(input: { accountId: string; password: string }): Promise<AuthSnapshot>
  register?(input: {
    accountId: string
    password: string
    displayName?: string
  }): Promise<AuthSnapshot>
  logout(): Promise<AuthSnapshot>
}

/** Source dictionary healing + registration. */
export interface IssueSourcesFace {
  /** Make sure the `dsh` source exists with this plugin's `pluginName`. */
  ensure(): Promise<void>
  /** Whether the shared library already knows this code (never registers it). */
  isRegistered(code: string): Promise<boolean>
}

export interface SdkIssueSummary {
  issueId: string
  title: string
  status: string
  urgency?: string
  assignee?: string
  assigner?: string
  updatedAt?: number
}

export interface SdkFaces {
  /** Data-plane reachability failure (remote domain down, DNS, timeout, invalid domain). */
  connectionIssue?: string
  /** Current device instance (`ipv4:3080`) resolved by the SDK. */
  mineInstance?: string
  projects?: ProjectsFace
  devices?: DevicesFace
  comments?: RemoteCommentsFace
  sources?: IssueSourcesFace
  sync?: IssueSyncFace
  finalize?: RemoteFinalizeFace
  status?: IssueStatusFace
  /** Advance the remote side to `routing` (`pending/accepted -> routing`). */
  routing?: (ids: readonly string[]) => Promise<void>
  /** Remote abandon (`-> abandoned`), optionally carrying assigneeMeta in the same update. */
  abandon?: (
    ids: readonly string[],
    assigneeMeta?: Record<string, unknown>,
  ) => Promise<void>
  /** Advance the remote side to `running` (when a card starts). */
  running?: (id: string) => Promise<void>
  /** Remote "converted to task" write-back (assigneeTask / cwd / meta / time). */
  routed?: (id: string, input: {
    assigneeTask: string
    cwd: string
    assignerMeta: Record<string, unknown>
    urgency?: string
    permission?: string
    assignedAt?: string
  }) => Promise<void>
  /** Cloud record of one issue (used when local has none). */
  issueGet?: (id: string) => Promise<Record<string, unknown> | undefined>
  /** Cloud issue list (teamwork project-management view). */
  issueList?: (query: {
    pageNum?: number
    pageSize?: number
    status?: string
    projectId?: number
    keyword?: string
  }) => Promise<readonly SdkIssueSummary[]>
  /** Comments of one issue (ascending time). */
  issueComments?: (id: string) => Promise<readonly SdkIssueComment[]>
  /** Cloud attachment metadata for one target (`role` omitted = both roles). */
  issueAttachmentList?: (
    targetType: 'issue' | 'comment',
    targetId: string,
    role?: 'assigner' | 'assignee',
  ) => Promise<readonly SdkIssueAttachmentMeta[]>
  /** Download one cloud file by fileId. */
  attachmentDownload?: (fileId: string) => Promise<Uint8Array>
  auth?: AuthFace
  query?: IssueQueryFace
  artifacts?: RemoteArtifactsFace
  /** Create issues remotely: the SDK's issueCreateMany. */
  issues?: { createMany: (inputs: readonly Record<string, unknown>[]) => Promise<{ created: { issueId: string; title: string }[]; skipped: readonly string[] }> }
  /** Workspace portrait upload (device-workspaces). */
  portrait?: {
    upsertIndex: (input: { detail: string }) => Promise<void>
    upsertPortal: (input: { workspaceId: string; cwd: string; detail: string }) => Promise<void>
  }
  /** Project -> absolute path (authoritative cwd for a portrait target). */
  projectCwd?: (projectId: number) => string | undefined
  client?: CastboardClientLike
  /** What is missing (for diagnostics). */
  missing: string[]
}

/**
 * Wrap one SDK call and unwrap its envelope into `value`, or throw.
 *
 * SDK combined methods have two signatures: single-argument (`f(input)`) and coordinate-style (`f(issueId, input)`),
 * so arguments are forwarded variadically; a single argument behaves exactly like a plain call.
 */
async function call<T>(fn: AnyFn | undefined, ...args: unknown[]): Promise<T> {
  if (fn === undefined) throw new Error('SDK 方法缺失')
  const result = (await (fn as unknown as (...input: unknown[]) => Promise<unknown>)(...args)) as
    | { ok: true; data: T }
    | { ok: false; code: string; reason: string }
  if (result !== null && typeof result === 'object' && 'ok' in result) {
    if (result.ok === true) return result.data
    throw new Error(`${result.code}: ${result.reason}`)
  }
  return result as T
}

/** The attachment-list call rejected our argument shape; retrying with the other form is safe. */
class AttachmentListShapeError extends Error {}

function attachmentListRows(result: unknown): readonly Record<string, unknown>[] {
  if (result !== null && typeof result === 'object' && 'ok' in result) {
    const envelope = result as { ok: boolean; data?: unknown; code?: string; reason?: string }
    if (!envelope.ok) {
      const message = `${envelope.code ?? 'error'}: ${envelope.reason ?? 'issue.attachment.list failed'}`
      // Validation runs before any HTTP call; only these codes mean "wrong call shape".
      if (envelope.code === 'invalid_request' || envelope.code === 'invalid_role')
        throw new AttachmentListShapeError(message)
      throw new Error(message)
    }
    return Array.isArray(envelope.data) ? envelope.data as readonly Record<string, unknown>[] : []
  }
  return Array.isArray(result) ? result as readonly Record<string, unknown>[] : []
}

/**
 * Call `issue.attachment.list` across SDK generations.
 *
 * The current teamwork SDK takes one object (`{ targetType, targetId, role? }`); the older
 * plan used positional `(targetType, targetId, role?)`. Pick by arity, and if the call is
 * rejected for its argument shape (validation happens before any HTTP request), retry with
 * the other form exactly once.
 */
async function callAttachmentList(
  fn: AnyFn,
  targetType: 'issue' | 'comment',
  targetId: string,
  role?: 'assigner' | 'assignee',
): Promise<readonly Record<string, unknown>[]> {
  const invoke = fn as unknown as (...args: unknown[]) => Promise<unknown>
  const positional = (): Promise<unknown> =>
    invoke(targetType, targetId, ...(role === undefined ? [] : [role]))
  const objectInput = (): Promise<unknown> =>
    invoke({ targetType, targetId, ...(role === undefined ? {} : { role }) })
  const attempts = fn.length === 1 ? [objectInput, positional] : [positional, objectInput]
  let shapeError: unknown
  for (const attempt of attempts) {
    try {
      return attachmentListRows(await attempt())
    } catch (error) {
      if (error instanceof AttachmentListShapeError) {
        shapeError ??= error
        continue
      }
      throw error
    }
  }
  throw shapeError instanceof Error ? shapeError : new Error('issue.attachment.list 参数形态不兼容')
}

async function defaultLoader(): Promise<{
  createCastboardClient?: (options?: Record<string, unknown>) => CastboardClientLike
  CastboardClient?: new (options?: Record<string, unknown>) => CastboardClientLike
  getLocalIp?: () => string
  mineInstance?: () => string
}> {
  const specifier = '@meiyukichan/dsh-magica-teamwork'
  try {
    return (await import(specifier)) as unknown as {
      createCastboardClient?: (options?: Record<string, unknown>) => CastboardClientLike
      CastboardClient?: new (options?: Record<string, unknown>) => CastboardClientLike
      getLocalIp?: () => string
      mineInstance?: () => string
    }
  } catch (error) {
    eventLog('warn', 'sdk-missing', error instanceof Error ? error.message : String(error))
    return {}
  }
}

export async function createSdkFaces(options: {
  load?: SdkLoader
  clientOptions?: Record<string, unknown>
  instance: string
  os?: string
  /** Shared-library address (default local 3939). */
  baseUrl?: string
}): Promise<SdkFaces> {
  const module = await (options.load ?? defaultLoader)()
  const missing: string[] = []
  // `mineInstance()` is the SDK's authoritative `${ip}:${port}`. Without this,
  // the client falls back to a bare host and workspace rows lose their port.
  let resolvedInstance = options.instance
  if (typeof module.mineInstance === 'function') {
    try {
      resolvedInstance = module.mineInstance()
    } catch { /* keep the configured fallback */ }
  }
  // The SDK may be older or the env may omit the port; every castboard identity
  // is `ip:port`, and the local host always listens on 3080.
  if (!/:\d+$/.test(resolvedInstance) || /:0$/.test(resolvedInstance)) {
    resolvedInstance = `${resolvedInstance.replace(/:0$/, '')}:3080`
  }
  let client: CastboardClientLike | undefined
  if (typeof module.createCastboardClient === 'function') {
    client = module.createCastboardClient({
      logger: teamworkLogger,
      instance: resolvedInstance,
      os: options.os,
      baseUrl: options.baseUrl ?? 'http://127.0.0.1:3939',
      ...options.clientOptions,
    })
  } else if (typeof module.CastboardClient === 'function') {
    // Published form: `new CastboardClient({ baseUrl, instance, os })`
    client = new module.CastboardClient({
      logger: teamworkLogger,
      instance: resolvedInstance,
      os: options.os,
      baseUrl: options.baseUrl ?? 'http://127.0.0.1:3939',
      ...options.clientOptions,
    })
  }
  if (client === undefined) return { missing: ['createCastboardClient / CastboardClient'] }

  /**
   * Bind class methods back to their instance.
   *
   * The SDK API consists of class instance methods (using `this.transport` internally), but they are called here as free
   * functions `fn(args)`, which loses `this` and makes the real SDK throw `reading 'transport'` (unit tests with plain functions did not expose it).
   */
  const bindAll = (target: unknown, depth = 0, seen = new WeakSet<object>()): void => {
    if (target === null || typeof target !== 'object' || depth > 4 || seen.has(target as object)) return
    seen.add(target as object)
    // 1. Methods on the prototype chain (class instance methods)
    let proto = Object.getPrototypeOf(target) as object | null
    while (proto !== null && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === 'constructor') continue
        const descriptor = Object.getOwnPropertyDescriptor(proto, key)
        if (descriptor === undefined || typeof descriptor.value !== 'function') continue
        ;(target as Record<string, unknown>)[key] = (descriptor.value as (...args: unknown[]) => unknown).bind(target)
      }
      proto = Object.getPrototypeOf(proto) as object | null
    }
    // 2. Own functions (object-literal methods such as `issue.comment.listSince`)
    for (const key of Object.getOwnPropertyNames(target)) {
      const value = (target as Record<string, unknown>)[key]
      if (typeof value === 'function') {
        ;(target as Record<string, unknown>)[key] = (value as (...args: unknown[]) => unknown).bind(target)
      } else if (value !== null && typeof value === 'object') {
        bindAll(value, depth + 1, seen)
      }
    }
  }

  // The client's own combined methods (castboardProjectList etc.) + its API namespaces
  bindAll(client)
  for (const namespace of ['auth', 'project', 'issue', 'teamwork', 'device', 'file', 'ops', 'admin'] as const) {
    bindAll((client as unknown as Record<string, unknown>)[namespace])
  }

  // A constructible client is not necessarily usable. Probe /auth/me once: a `login_required`
  // result is a state, not a missing capability — the panel still needs the auth face so it can
  // show the login dialog. Only a broken/missing probe degrades the face list.
  const faces: SdkFaces = { client, missing, mineInstance: resolvedInstance }
  let authUnavailable = false
  /** Live `auth.me()` role for the current process (never read from credentials). */
  let roleCache: string | undefined
  /** Host-internal device auto-report; no HTTP surface. */
  const reportCurrentDevice = async (): Promise<void> => {
    const deviceApi = client.teamwork?.device
    const deviceSync = client.device?.sync
    if (typeof deviceApi?.mine !== 'function' || typeof deviceSync !== 'function') return
    const authMeFn = client.auth?.me
    if (typeof authMeFn !== 'function') return
    const account = await call<{ accountId?: unknown }>(authMeFn)
    if (typeof account?.accountId !== 'string' || account.accountId === '') return
    const host = typeof module.getLocalIp === 'function' ? module.getLocalIp() : '127.0.0.1'
    const port = 3080
    const os = process.platform === 'win32' ? 'windows' : process.platform
    const page = await call<{ items?: readonly Record<string, unknown>[] }>(deviceApi.mine, { pageNum: 1, pageSize: 1000 })
    const existing = (Array.isArray(page?.items) ? page.items : []).flatMap(item => {
      const itemHost = typeof item['host'] === 'string' ? item['host'] : ''
      const itemPort = typeof item['port'] === 'number' ? item['port'] : 0
      if (itemHost === '') return []
      return [{ host: itemHost, port: itemPort, ...(typeof item['os'] === 'string' ? { os: item['os'] } : {}) }]
    }).filter(item => !(item.host === host && item.port === port))
    await call(deviceSync, [...existing, { host, port, os }])
  }
  let deviceReportAttempted = false
  const ensureDeviceReported = async (): Promise<void> => {
    if (deviceReportAttempted) return
    if (client?.state !== 'authenticated') return
    deviceReportAttempted = true
    try {
      await reportCurrentDevice()
      eventLog('info', 'device-auto-report-ok', JSON.stringify({ accountId: client.accountId }))
    } catch (error) {
      eventLog('warn', 'device-auto-report-failed', error instanceof Error ? error.message : String(error))
    }
  }
  const domainLabel = ((): string => {
    try {
      return client.baseUrl === undefined || client.baseUrl === '' ? 'DSH Teamwork' : new URL(client.baseUrl).host
    } catch {
      return client.baseUrl === undefined || client.baseUrl === '' ? 'DSH Teamwork' : client.baseUrl
    }
  })()
  const connectionReason = (code: string, reason?: string): string => {
    const detail = reason === undefined || reason === '' ? code : `${code}: ${reason}`
    return `${domainLabel} 不可用：${detail}`
  }
  // `auth.me` short-circuits to `login_required` when there is no local session, without
  // touching the network. Probe a public endpoint first so a dead remote domain is reported
  // as a connection error instead of the login dialog.
  const reachabilityProbe = client.ops?.probe ?? client.probe
  if (typeof reachabilityProbe === 'function') {
    try {
      const reach = (await (reachabilityProbe as unknown as () => Promise<unknown>)()) as
        | { ok?: boolean; code?: string; reason?: string }
        | undefined
      if (reach !== undefined && reach.ok !== true) {
        authUnavailable = true
        const reason = connectionReason(reach.code ?? 'network_error', reach.reason)
        faces.connectionIssue = reason
        missing.push(`共享库不可达（${reach.code ?? 'network_error'}）`)
        eventLog('warn', 'sdk-auth-unavailable', reason)
      }
    } catch (error) {
      authUnavailable = true
      const reason = connectionReason('network_error', error instanceof Error ? error.message : String(error))
      faces.connectionIssue = reason
      missing.push(`共享库不可达（${error instanceof Error ? error.message : String(error)}）`)
      eventLog('warn', 'sdk-auth-probe-failed', reason)
    }
  }
  const authMe = client.auth?.me as AnyFn | undefined
  if (!authUnavailable && typeof authMe === 'function') {
    try {
      let probe = (await (authMe as unknown as () => Promise<unknown>)()) as { ok?: boolean; reason?: string; code?: string; data?: { globalRole?: unknown } } | undefined
      if (probe?.ok === true && typeof probe.data?.globalRole === 'string') roleCache = probe.data.globalRole
      // With no local login, automatically log in using environment credentials when present (optional bootstrap, never forced)
      if (probe !== undefined && probe.ok !== true) {
        const account = process.env['DSH_TEAMWORK_ACCOUNT']
        const password = process.env['DSH_TEAMWORK_PASSWORD']
        const auth = client.auth as { login?: AnyFn; register?: AnyFn } | undefined
        if (account !== undefined && password !== undefined && typeof auth?.login === 'function') {
          try {
            const login = await call<{ ok?: boolean }>(auth.login, { accountId: account, password })
            void login
            probe = (await (authMe as unknown as () => Promise<unknown>)()) as { ok?: boolean; reason?: string; code?: string; data?: { globalRole?: unknown } } | undefined
            if (probe?.ok === true && typeof probe.data?.globalRole === 'string') roleCache = probe.data.globalRole
          } catch (error) {
            eventLog('warn', 'shared-login-failed', error instanceof Error ? error.message : String(error))
          }
        }
      }
      if (probe !== undefined && probe.ok !== true) {
        const code = probe.code ?? 'unauthorized'
        if (code === 'network_error' || code === 'invalid_host' || code === 'timeout' || code === 'unsupported') {
          authUnavailable = true
          const reason = connectionReason(code, probe.reason)
          faces.connectionIssue = reason
          missing.push(`共享库不可达（${code}）`)
          eventLog('warn', 'sdk-auth-unavailable', reason)
        } else {
          eventLog('info', 'sdk-login-required', `${code}${probe.reason === undefined ? '' : `: ${probe.reason}`}`)
        }
      }
    } catch (error) {
      authUnavailable = true
      const reason = connectionReason('network_error', error instanceof Error ? error.message : String(error))
      faces.connectionIssue = reason
      missing.push(`共享库不可达（${error instanceof Error ? error.message : String(error)}）`)
      eventLog('warn', 'sdk-auth-probe-failed', reason)
    }
  } else {
    missing.push('auth.me（无法探测登录态）')
  }

  const projectPaths = new Map<number, string>()

  if (typeof client.castboardAddIssueComments === 'function' && typeof client.issue?.comment?.listSince === 'function') {
    faces.comments = {
      listSince: async input => {
        const page = await call<{
          items: readonly {
            id: string
            content: string
            createdAt?: string
            commentAt?: string
            commentRole?: string | null
            commentAuthorType?: string | null
            author?: string
            issueId?: string
          }[]
          nextSinceId?: string
        }>(
          client.issue?.comment?.listSince,
          { sinceId: input.sinceId, limit: input.limit },
        )
        const items: RemoteComment[] = page.items.map(item => ({
          issueId: item.issueId ?? '',
          commentId: String(item.id),
          body: item.content,
          // `commentAt` is when the comment happened; `createdAt` is when the row landed.
          createdAt: parseCloudTime(item.commentAt) ?? parseCloudTime(item.createdAt) ?? Date.now(),
          role: item.commentRole === 'assignee' || item.commentRole === 'assigner' ? item.commentRole : null,
          ...(typeof item.commentAuthorType === 'string' && item.commentAuthorType !== ''
            ? { authorType: item.commentAuthorType }
            : {}),
          ...(typeof item.author === 'string' && item.author !== '' ? { author: item.author } : {}),
        }))
        return { items, nextSinceId: page.nextSinceId }
      },
      publish: async input => {
        // SDK signature is coordinate-style `castboardAddIssueComments(issueId, comments)`.
        await call(client.castboardAddIssueComments, input.issueId, [{
          commentId: input.commentId,
          content: input.body,
          // Local datetime (no zone), exactly the shape the shared library expects.
          commentAt: isoLocal(input.createdAt),
          // Unknown direction stays NULL in the cloud; forcing `assigner` would rewrite history.
          ...(input.role === null ? {} : { commentRole: input.role }),
          commentAuthorType: input.authorType,
        }])
      },
    }
  } else {
    missing.push('comments')
  }

  if (typeof client.castboardIssueSources === 'function' && typeof client.castboardAddIssueSource === 'function') {
    const list = client.castboardIssueSources
    const add = client.castboardAddIssueSource
    const confirmed = new Set<string>()
    const rowsOf = async (code?: string): Promise<readonly { code?: string; pluginName?: string | null }[]> => {
      const rows = await call<readonly { code?: string; pluginName?: string | null }[]>(list, code)
      return Array.isArray(rows) ? rows : []
    }
    faces.sources = {
      ensure: async () => {
        // Only `dsh` is the scheduling source this plugin owns now.
        // An existing row whose `pluginName` is already ours needs no request at all.
        for (const code of ['dsh']) {
          if (confirmed.has(code)) continue
          const rows = await rowsOf()
          const existing = rows.find(row => row.code === code)
          if (existing?.pluginName === ISSUE_SOURCE_PLUGIN_NAME) {
            confirmed.add(code)
            continue
          }
          await call(add, { code })
          confirmed.add(code)
        }
      },
      isRegistered: async code => {
        if (confirmed.has(code)) return true
        try {
          const rows = await rowsOf(code)
          // The server filters by ILIKE, so an exact code comparison is required.
          if (!rows.some(row => row.code === code)) return false
          confirmed.add(code)
          return true
        } catch (error) {
          eventLog('warn', 'issue-source-lookup-failed', `${code}: ${error instanceof Error ? error.message : String(error)}`)
          return false
        }
      },
    }
  } else {
    missing.push('sources')
  }

  if (typeof client.castboardMyInstanceIssues === 'function' && typeof client.issueClaim === 'function') {
    faces.sync = {
      myInstanceIssues: async input => {
        const userId = typeof client.accountId === 'string' && client.accountId !== ''
          ? client.accountId
          : undefined
        const page = await call<{ items: readonly RemoteIssue[] }>(client.castboardMyInstanceIssues, {
          status: input.status,
          instance: input.instance,
          ...(input.os === undefined ? {} : { os: input.os }),
          ...(userId === undefined ? {} : { userId }),
        })
        return page.items
      },
      claim: async input => {
        const result = await call<{ claimed?: readonly string[]; failed?: readonly { issueId: string; reason: string }[] }>(
          client.issueClaim,
          [...input.issueIds],
        )
        return { claimed: result.claimed ?? [], failed: result.failed ?? [] }
      },
    }
  } else {
    missing.push('sync')
  }

  if (typeof client.issueFinalize === 'function') {
    faces.finalize = {
      finalize: async (input: { issueId: string } & FinalizeRemoteInput) => {
        // SDK signature is coordinate-style `issueFinalize(issueId, input)`.
        await call(client.issueFinalize, input.issueId, {
          status: input.status,
          assigneeMeta: input.assigneeMeta,
        })
      },
    }
  } else {
    missing.push('finalize')
  }

  // Shared-library query face: groups = my projects; members = project members; devices = my devices; workspaces = device workspaces
  if (typeof client.project?.mine === 'function' || typeof client.project?.list === 'function') {
    faces.query = {
      groups: async () => {
        const page = await call<Record<string, unknown>>(
          (client.project?.mine ?? client.project?.list) as AnyFn,
          {},
        )
        const rows = (Array.isArray(page) ? page : ((page.items ?? []) as readonly Record<string, unknown>[]))
        return rows.map(row => {
          // The shared-library project key is `id`; some records use `projectId`, so accept both.
          const raw = row.id ?? row.projectId
          const id = typeof raw === 'number' ? String(raw) : String(raw ?? '')
          const numeric = Number(raw)
          const path = [row.path, row.cwd, row.localPath, row.workspacePath].find(value => typeof value === 'string' && value !== '')
          if (Number.isInteger(numeric) && numeric > 0 && typeof path === 'string') projectPaths.set(numeric, path)
          return {
            id,
            label: String(row.name ?? row.title ?? id),
            ...(typeof path === 'string' ? { cwd: path } : {}),
            detail: typeof row.description === 'string' ? row.description : undefined,
          }
        })
      },
      groupMembers: async projectId => {
        const rows = await call<readonly Record<string, unknown>[]>(client.project?.members as AnyFn, projectId)
        return (Array.isArray(rows) ? rows : []).map(row => {
          const account = String(row.accountId ?? row.account ?? '')
          const displayName = String(row.displayName ?? row.name ?? account)
          return {
            id: account,
            label: displayName,
            account,
            displayName,
            restricted: row.restricted === true,
            detail: typeof row.description === 'string' ? row.description : undefined,
          }
        })
      },
      devices: async userId => {
        // Omitting accountId = query myself
        const rows = await call<readonly Record<string, unknown>[]>(
          (client.device?.list ?? client.device?.mine) as AnyFn,
          userId === '' ? undefined : userId,
        )
        const list = Array.isArray(rows) ? rows : ((rows as { items?: readonly Record<string, unknown>[] }).items ?? [])
        return list.map(row => {
          const host = typeof row.host === 'string' ? row.host : ''
          const port = typeof row.port === 'number' ? String(row.port) : (typeof row.port === 'string' ? row.port : '')
          const endpoint = host !== '' && port !== '' ? `${host}:${port}` : (typeof row.instance === 'string' ? row.instance : host)
          return {
            id: endpoint,
            label: endpoint,
            instance: endpoint,
            detail: typeof row.accountId === 'string' ? row.accountId : undefined,
          }
        })
      },
      workspaces: async query => {
        let rows: readonly Record<string, unknown>[]
        if (query.type === 'portal') {
          const row = await call<Record<string, unknown> | null>(client.castboardWorkspacePortal as AnyFn, {
            workspaceId: query.workspaceId,
            instance: query.instance,
            ...(query.userId === undefined || query.userId === '' ? {} : { userId: query.userId }),
          })
          rows = row === null || row === undefined ? [] : [row]
        } else {
          const all = await call<readonly Record<string, unknown>[]>(
            client.castboardWorkspaceIndexes as AnyFn,
            query.userId === undefined || query.userId === '' ? undefined : query.userId,
          )
          rows = (Array.isArray(all) ? all : []).filter(row =>
            query.instance === undefined || query.instance === '' || row['instance'] === query.instance)
        }
        return rows.map(row => {
          const id = String(row['workspaceId'] ?? row['id'] ?? '')
          // A shared-library workspace record uses `cwd` for the project path; `path` is an alternate field name.
          const path = String(row['cwd'] ?? row['path'] ?? '')
          const instance = typeof row['instance'] === 'string' ? row['instance'] : undefined
          return {
            id,
            label: path !== '' ? path : id,
            ...(path !== '' ? { cwd: path } : {}),
            ...(instance === undefined ? {} : { instance }),
            detail: typeof row['detail'] === 'string' ? row['detail'] : (typeof row['description'] === 'string' ? row['description'] : instance),
          }
        })
      },
    }
  } else {
    missing.push('query')
  }

  // Two-step upload: file.upload first for the real fileId, then attachments.add to attach it to the issue
  const fileUpload = client.file?.upload as AnyFn | undefined
  const attachmentAdd = (client.issue?.attachments?.add ?? client.issueAttachmentAdd) as AnyFn | undefined
  if (typeof fileUpload === 'function' && typeof attachmentAdd === 'function') {
    faces.artifacts = {
      upload: async input => {
        const fs = await import('node:fs')
        const path = await import('node:path')
        const data = fs.readFileSync(input.filePath)
        const uploaded = await call<{ fileId?: string }>(fileUpload, { name: path.basename(input.filePath), data })
        const fileId = typeof uploaded?.fileId === 'string' ? uploaded.fileId : undefined
        if (fileId === undefined) throw new Error('file.upload 未返回 fileId')
        await call(attachmentAdd, [{
          targetType: 'issue',
          targetId: input.issueId,
          fileId,
          role: 'assignee',
        }])
        return { fileId }
      },
    }
  } else {
    missing.push('artifacts')
  }

  // Create issues remotely (issueCreateMany)
  const issueCreateMany = (client as { issueCreateMany?: AnyFn }).issueCreateMany
  if (typeof issueCreateMany === 'function') {
    faces.issues = {
      createMany: async inputs => {
        // Do not use `call`: a failure envelope may still carry `created` (partial success). Dropping it would make the caller
        // think the whole batch failed and create everything locally again.
        const result = (await (issueCreateMany as unknown as (
          input: readonly Record<string, unknown>[],
        ) => Promise<unknown>)(inputs)) as
          | { ok: true; data?: { issues?: readonly Record<string, unknown>[]; skipped?: readonly string[] } }
          | { ok: false; code?: string; reason?: string; created?: readonly string[] }
        if (result !== null && typeof result === 'object' && result.ok === false) {
          const created = (result.created ?? []).map(issueId => ({ issueId, title: '' }))
          if (created.length > 0) return { created, skipped: [] }
          throw new Error(`${result.code ?? 'error'}: ${result.reason ?? 'issueCreateMany failed'}`)
        }
        const data = result !== null && typeof result === 'object' && result.ok === true ? result.data : undefined
        const created = (data?.issues ?? [])
          .map(issue => ({
            issueId: String(issue.issueId ?? issue.id ?? ''),
            title: String(issue.title ?? ''),
          }))
          .filter(item => item.issueId !== '')
        return { created, skipped: data?.skipped ?? [] }
      },
    }
  } else {
    missing.push('issues')
  }

  // Workspace portraits (the endpoint is device-workspaces, aliases publishWorkspacePortrait/Index)
  const upsertPortal = (client as { publishWorkspacePortrait?: AnyFn }).publishWorkspacePortrait
    ?? (client as { castboardUpsertWorkspacePortal?: AnyFn }).castboardUpsertWorkspacePortal
  const upsertIndex = (client as { publishWorkspaceIndex?: AnyFn }).publishWorkspaceIndex
    ?? (client as { castboardUpsertWorkspaceIndex?: AnyFn }).castboardUpsertWorkspaceIndex
  if (typeof upsertPortal === 'function' && typeof upsertIndex === 'function') {
    const userId = typeof client.accountId === 'string' && client.accountId !== ''
      ? client.accountId
      : undefined
    faces.portrait = {
      upsertIndex: async input => {
        await call(upsertIndex, {
          detail: input.detail,
          ...(userId === undefined ? {} : { userId }),
        })
      },
      upsertPortal: async input => {
        await call(upsertPortal, {
          workspaceId: input.workspaceId,
          cwd: input.cwd,
          detail: input.detail,
          ...(userId === undefined ? {} : { userId }),
        })
      },
    }
  } else {
    missing.push('portrait')
  }

  faces.projectCwd = projectId => projectPaths.get(projectId)

  if (typeof client.castboardIssueStatuses === 'function') {
    faces.status = {
      statuses: async issueIds => {
        const map = await call<Record<string, string | null>>(client.castboardIssueStatuses, { issueIds: [...issueIds], includeCompleted: true })
        return map
      },
    }
  } else {
    missing.push('status')
  }

  // ── Status transitions: routing / abandon / running / routed ──────────────
  // These four are the shared library's "handoff" actions: the local ledger settles first, then the remote side catches up best effort; the caller catches failures.
  if (typeof client.issueRouting === 'function') {
    faces.routing = async ids => {
      await call(client.issueRouting, [...ids])
    }
  } else {
    missing.push('routing')
  }

  const updateStatuses = client.issue?.updateStatuses
  if (typeof client.issueAbandon === 'function' || typeof updateStatuses === 'function') {
    faces.abandon = async (ids, assigneeMeta) => {
      if (assigneeMeta !== undefined && typeof updateStatuses === 'function') {
        // The composite `issueAbandon` only accepts ids; the status API carries
        // assigneeMeta in the same abandoned update.
        const result = await call<{
          failed?: readonly { issueId?: string; reason?: string }[]
        }>(updateStatuses, ids.map(issueId => ({
          issueId,
          status: 'abandoned',
          assigneeMeta,
        })))
        const failed = Array.isArray(result?.failed) ? result.failed : []
        if (failed.length > 0) {
          throw new Error(`issueUpdateStatus 被拒：${failed[0]?.reason ?? 'unknown'}`)
        }
        return
      }
      if (typeof client.issueAbandon === 'function') {
        await call(client.issueAbandon, [...ids])
        return
      }
      if (typeof updateStatuses === 'function') {
        await call(updateStatuses, ids.map(issueId => ({ issueId, status: 'abandoned' })))
        return
      }
    }
  } else {
    missing.push('abandon')
  }

  if (typeof client.issueRunning === 'function') {
    faces.running = async id => {
      await call(client.issueRunning, id)
    }
  } else {
    missing.push('running')
  }

  if (typeof client.issueRouted === 'function') {
    faces.routed = async (id, input) => {
      // The SDK signature is coordinate-style `issueRouted(issueId, input)`; times are normalized to ISO-8601.
      await call(client.issueRouted, id, {
        assigneeTask: input.assigneeTask,
        cwd: input.cwd,
        assignerMeta: input.assignerMeta,
        ...(input.urgency === undefined ? {} : { urgency: input.urgency }),
        ...(input.permission === undefined ? {} : { permission: input.permission }),
        ...(input.assignedAt === undefined ? {} : { assignedAt: input.assignedAt }),
      })
    }
  } else {
    missing.push('routed')
  }

  // ── One issue's comments / attachments (move comments on conversion, prepare reference inputs) ──
  if (typeof client.issue?.get === 'function') {
    faces.issueGet = async id => {
      const row = await call<Record<string, unknown> | undefined>(client.issue?.get, id)
      return row === null || typeof row !== 'object' ? undefined : row
    }
  } else {
    missing.push('issueGet')
  }

  if (typeof client.issue?.list === 'function') {
    faces.issueList = async query => {
      const page = await call<{ items?: readonly Record<string, unknown>[] } | undefined>(
        client.issue?.list as AnyFn,
        query,
      )
      const rows = Array.isArray(page) ? page : Array.isArray(page?.items) ? page.items : []
      return rows.flatMap((row): SdkIssueSummary[] => {
        const issueId = typeof row.issueId === 'string'
          ? row.issueId
          : typeof row.id === 'string' ? row.id : ''
        if (issueId === '') return []
        const updatedAt = typeof row.updatedAt === 'string'
          ? Date.parse(row.updatedAt)
          : typeof row.updatedAt === 'number' ? row.updatedAt : undefined
        return [{
          issueId,
          title: String(row.title ?? ''),
          status: String(row.status ?? ''),
          ...(typeof row.urgency === 'string' ? { urgency: row.urgency } : {}),
          ...(typeof row.assignee === 'string' ? { assignee: row.assignee } : {}),
          ...(typeof row.assigner === 'string' ? { assigner: row.assigner } : {}),
          ...(updatedAt !== undefined && Number.isFinite(updatedAt) ? { updatedAt } : {}),
        }]
      })
    }
  } else {
    missing.push('issueList')
  }

  if (typeof client.castboardIssueComments === 'function') {
    faces.issueComments = async id => {
      const rows = await call<readonly Record<string, unknown>[]>(client.castboardIssueComments, id)
      return (Array.isArray(rows) ? rows : []).flatMap((row): SdkIssueComment[] => {
        const commentId = String(row.id ?? row.commentId ?? '')
        if (commentId === '') return []
        const createdAt = commentTime(row)
        return [{
          id: commentId,
          body: String(row.content ?? row.body ?? ''),
          createdAt,
          ...(typeof row.commentRole === 'string' ? { role: row.commentRole } : {}),
          ...(typeof row.commentAuthorType === 'string' ? { authorType: row.commentAuthorType } : {}),
          ...(typeof row.author === 'string' ? { author: row.author } : {}),
        }]
      })
    }
  } else {
    missing.push('issueComments')
  }

  const listAttachments = client.issue?.attachment?.list ?? client.issue?.attachments?.list
  if (typeof listAttachments === 'function') {
    faces.issueAttachmentList = async (targetType, targetId, role) => {
      const rows = await callAttachmentList(listAttachments, targetType, targetId, role)
      return rows.flatMap((row): SdkIssueAttachmentMeta[] => {
        const fileId = typeof row.fileId === 'string' ? row.fileId : ''
        if (fileId === '') return []
        const rowTargetType: 'issue' | 'comment' = row.targetType === 'comment' ? 'comment' : 'issue'
        const rowTargetId = typeof row.targetId === 'string' && row.targetId !== ''
          ? row.targetId
          : rowTargetType === 'issue' && typeof row.issueId === 'string' && row.issueId !== ''
            ? row.issueId
            : targetId
        // New rows carry `role`; legacy rows carry `type` with wire values assigner/assignee.
        const rawRole = row.role ?? row.type
        const rowRole: 'assigner' | 'assignee' =
          rawRole === 'assignee' || rawRole === 'output' ? 'assignee' : 'assigner'
        if (rowTargetType !== targetType || rowTargetId !== targetId) return []
        if (role !== undefined && rowRole !== role) return []
        const fileName = typeof row.fileName === 'string' && row.fileName !== ''
          ? row.fileName
          : fileId
        const description = row.description
        return [{
          fileId,
          fileName,
          targetType: rowTargetType,
          targetId: rowTargetId,
          role: rowRole,
          ...(typeof description === 'string' && description !== '' ? { description } : {}),
        }]
      })
    }
  } else {
    missing.push('issueAttachmentList')
  }

  if (typeof client.file?.download === 'function') {
    faces.attachmentDownload = async fileId => {
      const data = await call<Uint8Array>(client.file?.download, fileId)
      return data instanceof Uint8Array ? data : new Uint8Array(data)
    }
  } else {
    missing.push('attachmentDownload')
  }

  // Auth is a separate capability: the local service can be reachable while the SDK has no
  // auth face (older build). Without it the panel stays local-only and the login dialog is hidden.
  const auth = (client as unknown as {
    auth?: {
      state?: AuthState
      accountId?: string | null
      accountDisplayName?: string | null
      globalRole?: unknown
      login?: AnyFn
      register?: AnyFn
      logout?: AnyFn
    }
  }).auth
  if (!authUnavailable && auth !== undefined && typeof auth.login === 'function' && typeof auth.logout === 'function') {
    const snapshot = (): AuthSnapshot => {
      // `client.auth` is the login/register API surface; session state lives on the client.
      const stateValue = client.state ?? auth.state
      const state = stateValue === 'authenticated' || stateValue === 'login_required' ? stateValue : 'anonymous'
      const rawAccountId = client.accountId ?? auth.accountId
      const rawDisplayName = client.accountDisplayName ?? auth.accountDisplayName
      const rawRole = roleCache ?? client.globalRole ?? auth.globalRole
      const accountId = typeof rawAccountId === 'string' && rawAccountId !== '' ? rawAccountId : undefined
      const displayName = typeof rawDisplayName === 'string' && rawDisplayName !== ''
        ? rawDisplayName
        : undefined
      return {
        state,
        ...(accountId === undefined ? {} : { accountId }),
        ...(displayName === undefined ? {} : { displayName }),
        ...(typeof rawRole === 'string' && rawRole !== '' ? { globalRole: rawRole } : {}),
      }
    }
    const refreshRole = async (): Promise<void> => {
      try {
        const me = (await (authMe as unknown as () => Promise<unknown>)()) as
          | { ok?: boolean; data?: { globalRole?: unknown } }
          | undefined
        if (me?.ok === true && typeof me.data?.globalRole === 'string') roleCache = me.data.globalRole
      } catch {
        /* keep the previous live role; never fall back to the credential file */
      }
    }
    faces.auth = {
      status: snapshot,
      refresh: async () => {
        await refreshRole()
        await ensureDeviceReported()
      },
      login: async input => {
        await call(auth.login, input)
        await refreshRole()
        await ensureDeviceReported()
        return snapshot()
      },
      ...(typeof auth.register === 'function'
        ? {
            register: async (input: {
              accountId: string
              password: string
              displayName?: string
            }) => {
              await call(auth.register, input)
              await refreshRole()
              await ensureDeviceReported()
              return snapshot()
            },
          }
        : {}),
      logout: async () => {
        await call(auth.logout, {})
        roleCache = undefined
        return snapshot()
      },
    }
  } else {
    missing.push('auth')
  }

  const projectApi = client.teamwork?.project
  if (projectApi !== undefined
    && typeof projectApi.list === 'function'
    && typeof projectApi.detail === 'function'
    && typeof projectApi.create === 'function') {
    const projectMembers = async (id: number): Promise<readonly Record<string, unknown>[]> =>
      await call<readonly Record<string, unknown>[]>(projectApi.members, id)
    faces.projects = {
      list: async query => {
        const page = await call<{
          total?: number
          pageNum?: number
          pageSize?: number
          items?: readonly Record<string, unknown>[]
        }>(projectApi.list, query)
        return {
          total: typeof page?.total === 'number' ? page.total : 0,
          pageNum: typeof page?.pageNum === 'number' ? page.pageNum : query.pageNum ?? 1,
          pageSize: typeof page?.pageSize === 'number' ? page.pageSize : query.pageSize ?? 20,
          items: Array.isArray(page?.items) ? page.items : [],
        }
      },
      mine: async query => {
        const page = await call<
          | readonly Record<string, unknown>[]
          | { items?: readonly Record<string, unknown>[] }
        >(projectApi.mine, query ?? {})
        if (Array.isArray(page)) return page
        const items = (page as { items?: readonly Record<string, unknown>[] } | undefined)?.items
        return Array.isArray(items) ? items : []
      },
      detail: async id => await call<Record<string, unknown>>(projectApi.detail, id),
      create: async input => await call<Record<string, unknown>>(projectApi.create, input),
      update: async (id, input) => await call<Record<string, unknown>>(projectApi.update, id, input),
      remove: async id => { await call(projectApi.remove, id) },
      members: projectMembers,
      searchAccounts: async (id, keyword) => {
        const items = await call<readonly Record<string, unknown>[]>(projectApi.searchAccounts, id, keyword)
        return Array.isArray(items) ? items : []
      },
      memberAdd: async (id, input) => { await call(projectApi.memberAdd, id, input) },
      memberRemove: async (id, accountId) => { await call(projectApi.memberRemove, id, accountId) },
      transferOwner: async (id, accountId) => { await call(projectApi.transferOwner, id, accountId) },
    }
  } else {
    missing.push('projects')
  }

  const teamworkDeviceApi = client.teamwork?.device
  if (teamworkDeviceApi !== undefined && typeof teamworkDeviceApi.mine === 'function') {
    faces.devices = {
      mine: async query => {
        const page = await call<{
          total?: number
          pageNum?: number
          pageSize?: number
          items?: readonly Record<string, unknown>[]
        }>(teamworkDeviceApi.mine, query ?? {})
        return {
          total: typeof page?.total === 'number' ? page.total : 0,
          pageNum: typeof page?.pageNum === 'number' ? page.pageNum : query?.pageNum ?? 1,
          pageSize: typeof page?.pageSize === 'number' ? page.pageSize : query?.pageSize ?? 20,
          items: Array.isArray(page?.items) ? page.items : [],
        }
      },
      create: async input => {
        const deviceSync = client.device?.sync
        if (typeof deviceSync !== 'function') throw new Error('SDK 缺少 device.sync')
        const page = await call<{ items?: readonly Record<string, unknown>[] }>(
          teamworkDeviceApi.mine,
          { pageNum: 1, pageSize: 1000 },
        )
        const existing = (Array.isArray(page?.items) ? page.items : []).flatMap(item => {
          const host = typeof item['host'] === 'string' ? item['host'] : ''
          const port = typeof item['port'] === 'number' ? item['port'] : 0
          if (host === '') return []
          return [{ host, port, ...(typeof item['os'] === 'string' ? { os: item['os'] } : {}) }]
        })
        await call(deviceSync, [
          ...existing,
          { host: input.host, port: input.port ?? 0, ...(input.os === undefined ? {} : { os: input.os }) },
        ])
      },
      remove: async id => { await call(teamworkDeviceApi.remove, id) },
    }
  } else {
    missing.push('devices')
  }

  // Startup may race credential restore; the /auth refresh path retries this once.
  void ensureDeviceReported()

  return faces
}

/** Cloud comment time -> epoch ms (`commentAt` first: it is when the comment happened; `createdAt` is when the row landed). */
function commentTime(row: Record<string, unknown>): number {
  return parseCloudTime(row.commentAt) ?? parseCloudTime(row.createdAt) ?? Date.now()
}

/**
 * Parse the shared library's time strings.
 *
 * Columns without a zone are Beijing time by contract, so `+08:00` is appended explicitly
 * rather than letting `Date.parse` guess from the host's local zone (a machine in another
 * timezone would otherwise shift every comment by hours).
 */
function parseCloudTime(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const isoish = trimmed.replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T')
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(isoish) ? isoish : `${isoish}+08:00`
  const at = Date.parse(zoned)
  return Number.isFinite(at) ? at : undefined
}

/** epoch ms -> ISO-8601 local datetime without zone (`2025-06-16T10:12:30`), the SDK's `commentAt` shape. */
function isoLocal(epochMs: number): string {
  const at = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}
