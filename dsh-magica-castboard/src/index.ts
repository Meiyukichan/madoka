/**
 * Host-side entry point for the castboard plugin. All writes are gated by a single
 * storage lease, so the assembly order is fixed: paths, lease, ledgers, services,
 * routes. Owner-only services (scheduler, dispatcher, inbox, sync, router, portrait)
 * are created when the lease is acquired and disposed when it is lost.
 *
 * @module dsh-magica-castboard
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { mkdir, readFile, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ToolDefinition as HostToolDefinition } from '@deepseek-ai/dsh-tools'
import type { InteractionChangedEvent } from '@meiyukichan/dsh-magica-spellbook'

import {
  BOARD_PROMPT_ORDER_OFFSET,
  BOARD_PROMPT_SECTION,
  CASTBOARD_SYSTEM_PROMPT,
  PLUGIN_NAME,
  PORTRAIT_IDLE_PROMPT,
  PORTRAIT_MAX_LINES,
  PORTRAIT_ORDER,
  PORTRAIT_SECTION,
  PORTRAIT_REMINDER_SECTION,
  castboardIssueContext,
  castboardIssueRouterXml,
  castboardPortraitXml,
} from './host/context/index.ts'
import { DispatcherService } from './host/dispatch/dispatcher.ts'
import { SchedulerService } from './host/dispatch/scheduler.ts'
import { AcceptanceRunner } from './host/exec/acceptance-runner.ts'
import { ExecutionService, type SessionsFace } from './host/exec/engine.ts'
import { InteractionCoordinator } from './host/exec/interaction-coordinator.ts'
import { InteractionBridge } from './host/exec/interaction-bridge.ts'
import { InteractionProjection } from './host/exec/interaction-projection.ts'
import { InteractionReporter } from './host/exec/interaction-reporter.ts'
import { InteractionService, type InteractionFace, type InteractionOutcome, type PendingInteraction } from './host/exec/interactions.ts'
import { createSpellbookSessions } from './host/exec/spellbook-sessions.ts'
import { backfillTaskSources } from './host/exec/source-backfill.ts'
import { createRouter, type Route } from './host/http/router.ts'
import { createRoutes } from './host/http/routes/index.ts'
import { AcceptanceStrategyStore } from './host/ledger/config-stores.ts'
import { CommentStore } from './host/ledger/comment-store.ts'
import { PullCursorStore, PublishCursorStore } from './host/ledger/cursors.ts'
import { IssueStore } from './host/ledger/issue-store.ts'
import { StorageLease } from './host/ledger/lease.ts'
import { LinkStore } from './host/ledger/link-store.ts'
import { dshHome, castboardPaths } from './host/ledger/paths.ts'
import { SettingsStore } from './host/ledger/settings.ts'
import { normalizeStrategies, readStrategyCustom, writeStrategyCustom } from './host/ledger/strategy-custom.ts'
import { TaskStore } from './host/ledger/task-store.ts'
import { TemplateStore } from './host/ledger/template-store.ts'
import { normalizeNotes, readWorkspacesCustom, writeWorkspacesCustom } from './host/ledger/workspaces-custom.ts'
import {
  TaskAttachmentIndex,
  ATTACHMENTS_DIR,
  attachmentKind,
  type StoredAttachment,
} from './host/pipeline/attachments.ts'
import { AttachmentSync } from './host/pipeline/attachment-sync.ts'
import { CommentDeliverer } from './host/pipeline/deliver.ts'
import { directRoute, type DirectRouteDeps } from './host/pipeline/direct.ts'
import { IssueFinalizer } from './host/pipeline/finalize.ts'
import { IssueCommentInbox } from './host/pipeline/inbox.ts'
import { CommentPublisher } from './host/pipeline/publish.ts'
import { IssueRouterService } from './host/pipeline/router.ts'
import { createRouterSessionOpener, routerGuideSection } from './host/pipeline/router-runner.ts'
import { createSdkFaces, type CastboardClientLike, type SdkFaces, type SdkIssueComment } from './host/pipeline/sdk-face.ts'
import { IssueSyncService } from './host/pipeline/sync.ts'
import { RuntimeCommandWorker, shellExecutor } from './host/pipeline/runtime-worker.ts'
import { createToolArgsValidator, type RuntimeShell } from './host/pipeline/runtime-command.ts'
import { RUNTIME_COMMAND_ARGUMENTS_SCHEMA } from './host/runtime-contract.ts'
import { ThreadService } from './host/pipeline/thread.ts'
import { ArtifactUplink, type ArtifactAttachmentSpec } from './host/pipeline/uplink.ts'
import {
  dropContainerWorkspaces,
  ensureWorkspaceCatalog,
  isPortraitTarget,
  prepareWorklab,
  type WorklabComment,
} from './host/pipeline/worklab.ts'
import { openWorkSession, workSessionTtlMs } from './host/pipeline/work-session.ts'
import { PortraitService } from './host/portrait/service.ts'
import { batchDateOf, PortraitStore } from './host/portrait/store.ts'
import { portraitFileWritten } from './host/portrait/runner.ts'
import { resolveDefaultModel, type ResolvedModel } from './host/shared/default-model.ts'
import { eventLog } from './host/shared/event-log.ts'
import { ROUTE_PREFIX, ISSUE_SOURCE_DSH } from './shared/wire.ts'
import { commentsEnabled, maxConcurrentOf } from './host/rules.ts'
import type { CreateIssueBody, PendingInteractionRecord } from './host/model.ts'
import { buildTools, type CastboardToolDeps, type IssueStateAttachment, type UpstreamIssueComment } from './host/tools/index.ts'
import { tracePayload, workspaceFace, type ExecutionFace, type WorkspaceFace } from './host/tools/task-tools.ts'

export const name = '@meiyukichan/dsh-magica-castboard'

/** Host tools and the board/system prompt are required capabilities, not late options. */
export const inject = ['tools', 'systemPrompt'] as const

export { ROUTE_PREFIX }

// Read once at startup; omit when package.json is unavailable.
const PLUGIN_VERSION: string | undefined = (() => {
  try {
    const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : undefined
  } catch {
    return undefined
  }
})()

function note(level: 'info' | 'warn', event: string, detail?: string): void {
  eventLog(level, event, detail ?? '')
}

function noteAny(level: 'info' | 'warn', event: string, detail?: unknown): void {
  if (detail === undefined) {
    note(level, event)
    return
  }
  note(level, event, typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One synchronized manifest row in the tool's target-model shape (kind is derived, never stored). */
function issueStateAttachment(row: StoredAttachment): IssueStateAttachment {
  return {
    name: row.name,
    path: row.path,
    targetType: row.targetType,
    targetId: row.targetId,
    role: row.role,
    kind: attachmentKind(row),
    ...(row.state === undefined ? {} : { state: row.state }),
    ...(row.fileId === undefined ? {} : { fileId: row.fileId }),
    ...(row.size === undefined ? {} : { size: row.size }),
    ...(row.description === undefined ? {} : { description: row.description }),
  }
}

/** Shape the issue-state tool consumes: ready rows become attachments, pending rows become failures. */
function issueStateSyncResult(
  rows: readonly StoredAttachment[],
  outputDir: string,
): { attachments: IssueStateAttachment[]; failed: { fileName?: string; reason: string }[]; outputDir: string } {
  return {
    attachments: rows.filter(row => row.state !== 'pending').map(issueStateAttachment),
    failed: rows
      .filter(row => row.state === 'pending')
      .map(row => ({ fileName: row.name, reason: 'download pending' })),
    outputDir,
  }
}

// Fall back to the author type and then a placeholder when the account is missing.
function commentAuthor(comment: SdkIssueComment): string {
  const author = comment.author?.trim() ?? ''
  if (author !== '') return author
  const type = comment.authorType?.trim() ?? ''
  return type === '' ? '（未署名）' : type
}

// The shared library reports epoch milliseconds; the UI wants readable ISO timestamps.
function commentAt(comment: SdkIssueComment): string | undefined {
  const createdAt = comment.createdAt
  return typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0
    ? new Date(createdAt).toISOString()
    : undefined
}

function toReferenceComment(comment: SdkIssueComment): WorklabComment {
  const at = commentAt(comment)
  return {
    author: commentAuthor(comment),
    content: comment.body,
    ...(at === undefined ? {} : { at }),
  }
}

function toUpstreamComment(comment: SdkIssueComment): UpstreamIssueComment {
  const at = commentAt(comment)
  return {
    id: comment.id,
    author: commentAuthor(comment),
    content: comment.body,
    createdAt: comment.createdAt,
    ...(at === undefined ? {} : { at }),
    ...(comment.role === undefined ? {} : { role: comment.role }),
    ...(comment.authorType === undefined ? {} : { authorType: comment.authorType }),
  }
}

// Narrow structural faces, so the plugin never depends on full cordis types.

interface WebServerFace {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
  }): () => void
}

interface PromptSectionOptions {
  name: string
  order: number
  text: string
}

interface SystemPromptFace {
  section(options: PromptSectionOptions): () => void
  getSectionOrder?(slot: string): number
}

interface ToolsFace {
  register(definition: HostToolDefinition): () => void
  get?(name: string): { parameters?: Record<string, unknown> } | undefined
}

interface WorkspaceEntity {
  id: unknown
  path: string
  title: string
}

interface WorkspaceRegistryLike {
  get?: (id: string) => WorkspaceEntity | undefined
  list?: () => readonly WorkspaceEntity[]
  resolveByPath?: (path: string) => Promise<WorkspaceEntity | undefined>
  archiveSession?: (sessionId: string) => Promise<void>
}

interface InjectedScope extends ClientLike {
  webServer?: WebServerFace
  tools?: ToolsFace
  systemPrompt?: SystemPromptFace
  workspaceRegistry?: WorkspaceRegistryLike
}

interface ClientLike {
  effect(callback: () => () => void, label?: string): void
  inject(services: readonly string[], callback: (scope: InjectedScope) => void): unknown
}

export interface PluginConfig {
  root?: string
}

export interface RuntimeOptions {
  root?: string
  instanceId?: string
  /** Current device instance (`ipv4:3080`), resolved by the teamwork SDK. */
  deviceInstance?: string
  now?: () => number
  staleMs?: number
  ctx?: unknown
  sessions?: SessionsFace
  faces?: SdkFaces
  /** Data-plane startup result; surfaced to the panel so config errors are actionable. */
  dataPlaneIssue?: { reason: string; configPath?: string }
  model?: ResolvedModel
  routerModel?: ResolvedModel
  portraitModel?: ResolvedModel
  maxConcurrent?: () => number
  workspaces?: WorkspaceFace
  workspaceResolver?: (cwd: string) => Promise<string | undefined>
  workspacePathOf?: (workspaceId: string) => string | undefined
  listWorkspaces?: () => readonly { id: string; path: string; title: string }[]
  archiveSession?: (sessionId: string) => Promise<void>
  startOwner?: boolean
}

export interface CastboardRuntime {
  lease: StorageLease
  tasks: TaskStore
  issues: IssueStore
  links: LinkStore
  comments: CommentStore
  settings: SettingsStore
  templates: TemplateStore
  acceptanceStrategies: AcceptanceStrategyStore
  attachments: TaskAttachmentIndex
  attachmentSync: AttachmentSync
  thread: ThreadService
  deliverer: CommentDeliverer
  uplink: ArtifactUplink
  execution: ExecutionService
  acceptance: AcceptanceRunner
  interactions: InteractionService
  interactionProjection: InteractionProjection
  workspaces: WorkspaceFace
  routes: readonly Route[]
  now: () => number
  instance: () => string
  /** Device instance (`ipv4:3080`) for source_instance / issue dispatch. */
  deviceInstance: () => string
  resolveWorkspaceForTools: (cwd: string) => Promise<{ id: string; path: string } | undefined>
  injectContext: (sessionId: string, entries: readonly { name: string; text: string }[]) => boolean
  query?: SdkFaces['query']
  sources?: SdkFaces['sources']
  auth?: SdkFaces['auth']
  remoteCreate?: SdkFaces['issues']
  remoteIssue?: (issueId: string) => Promise<Record<string, unknown> | undefined>
  remoteRouted?: (
    issueId: string,
    input: {
      assigneeTask: string
      cwd: string
      urgency: string
      permission?: string
      assignerMeta: Record<string, unknown>
      assignedAt: number
    },
  ) => Promise<void>
  remoteAbandon?: (
    issueId: string,
    assigneeMeta?: Record<string, unknown>,
  ) => Promise<void>
  /**
   * Shared-library comments, copied into the local stream when an issue becomes a card.
   * Never falls back to the local stream: those comments would be ingested twice.
   */
  upstreamComments: (issueId: string) => Promise<readonly UpstreamIssueComment[]>
  /** Synchronize the issue target (both roles) into the local store for `castboard_issue_state`. */
  syncIssueAttachments?: NonNullable<CastboardToolDeps['syncIssueAttachments']>
  /** Synchronize one comment target for `castboard_issue_state`. */
  syncCommentAttachments?: NonNullable<CastboardToolDeps['syncCommentAttachments']>
  /** Upload files for a newly written comment (comment target, role preserved). */
  uploadCommentAttachments?: NonNullable<CastboardToolDeps['uploadCommentAttachments']>
  /** Base directory for relative comment attachments. */
  attachmentCwd?: NonNullable<CastboardToolDeps['attachmentCwd']>
  reload: () => Promise<void>
  get publisher(): CommentPublisher | undefined
  get inbox(): IssueCommentInbox | undefined
  get sync(): IssueSyncService | undefined
  get finalizer(): IssueFinalizer | undefined
  get router(): IssueRouterService | undefined
  get portrait(): PortraitService | undefined
  startOwnerServices(): void
  stopOwnerServices(): void
  dispose(): Promise<void>
}

interface OwnerServices {
  publisher?: CommentPublisher
  inbox?: IssueCommentInbox
  sync?: IssueSyncService
  finalizer?: IssueFinalizer
  router?: IssueRouterService
  portrait?: PortraitService
}

interface Disposable {
  dispose: () => void | Promise<void>
}

const EMPTY_WORKSPACES: WorkspaceFace = {
  resolveByPath: async () => undefined,
  get: () => undefined,
  list: () => [],
}

/**
 * The workspace registry arrives after construction, but stores and tools need a stable
 * dependency. Resolution is deferred to each call, so the same face starts working once
 * the registry appears.
 */
function lazyWorkspaceFace(registry: () => WorkspaceRegistryLike | undefined): WorkspaceFace {
  const current = (): WorkspaceFace => {
    const found = registry()
    return found === undefined ? EMPTY_WORKSPACES : workspaceFace(found as never)
  }
  return {
    resolveByPath: path => current().resolveByPath(path),
    get: id => current().get(id),
    list: () => current().list(),
  }
}

function modelOf(value: ResolvedModel | undefined): ResolvedModel | undefined {
  return value === undefined || value.provider === '' || value.model === '' ? undefined : value
}

/** Off switches accept the same spellings as raw (`off`/`0`/`false`/`no`). */
function envOff(...names: readonly string[]): boolean {
  for (const name of names) {
    const value = (process.env[name] ?? '').trim().toLowerCase()
    if (value !== '' && (value === 'off' || value === '0' || value === 'false' || value === 'no')) return true
  }
  return false
}

/** Positive integer override. */
function envInt(names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = Number.parseInt(process.env[name] ?? '', 10)
    if (Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

/** Build a runtime without registering it; exported so tests can drive ledgers and routes directly. */
export async function createRuntime(options: RuntimeOptions = {}): Promise<CastboardRuntime> {
  const paths = castboardPaths(options.root)
  const clock = options.now ?? (() => Date.now())
  const instanceId = options.instanceId ?? `${process.pid}-${randomUUID().slice(0, 8)}`
  const deviceInstance = options.deviceInstance ?? process.env.DSH_TEAMWORK_INSTANCE ?? '127.0.0.1:0'
  const model = modelOf(options.model)
  const routerModel = modelOf(options.routerModel) ?? model
  const portraitModel = modelOf(options.portraitModel) ?? model
  const maxConcurrentOption = options.maxConcurrent
    ?? (() => envInt(['DSH_CASTBOARD_MAX_CONCURRENT']))

  const owner: OwnerServices = {}
  const lifecycle: { start?: () => void; stop?: () => void } = {}
  const publisherRef: { current?: CommentPublisher } = {}
  const uplinkRef: { current?: ArtifactUplink } = {}
  const executionRef: { current?: ExecutionService } = {}

  // The lease decides whether any store may write.
  const lease = new StorageLease({
    file: paths.lease,
    instanceId,
    now: options.now,
    ...(options.staleMs === undefined ? {} : { staleMs: options.staleMs }),
    onDemoted: () => {
      note('warn', 'lease-demoted', 'storage lease lost; stopping owner-only services')
      lifecycle.stop?.()
    },
    onPromoted: () => {
      // Reload external writes before starting owner services, so stale memory never overwrites newer data.
      void (async () => {
        await tasks.reloadFromDisk()
        await issues.reloadFromDisk()
        await links.reloadFromDisk()
        if (!lease.isOwner()) return
        lifecycle.start?.()
      })().catch(error => {
        note('warn', 'lease-promote-failed', errorText(error))
      })
    },
  })
  lease.start()

  const tasks = new TaskStore({
    paths,
    canWrite: () => lease.isOwner(),
    now: clock,
    previousLedgerFile: join(dshHome(), 'dsh-taskboard.json'),
  })
  const issues = new IssueStore({ dir: paths.root, canWrite: () => lease.isOwner(), now: clock })
  const links = new LinkStore({ dir: paths.root, canWrite: () => lease.isOwner() })
  const comments = new CommentStore({ dir: paths.root, canWrite: () => lease.isOwner() })
  const settings = new SettingsStore({
    file: paths.settingsFile,
    canWrite: () => lease.isOwner(),
    // One-time migration source: the `settings` key the ledger used to carry.
    legacy: async () => {
      await tasks.load()
      return tasks.settings()
    },
  })
  const templateFile = join(paths.root, 'castboard-templates.json')
  const legacyTemplateFile = join(paths.root, 'task-templates.json')
  if (!existsSync(templateFile) && existsSync(legacyTemplateFile)) {
    try {
      renameSync(legacyTemplateFile, templateFile)
    } catch (error) {
      note('warn', 'template-file-migrate-failed', errorText(error))
    }
  }
  const templates = new TemplateStore(
    templateFile,
    join(dshHome(), 'dsh-taskboard-templates.json'),
  )
  const attachments = new TaskAttachmentIndex({
    dir: paths.root,
    now: clock,
    canWrite: () => lease.isOwner(),
    log: noteAny,
  })
  const attachmentSync = new AttachmentSync({
    index: attachments,
    ...(options.faces?.issueAttachmentList === undefined
      ? {}
      : { list: options.faces.issueAttachmentList }),
    ...(options.faces?.attachmentDownload === undefined
      ? {}
      : { download: options.faces.attachmentDownload }),
    log: noteAny,
  })
  const acceptanceStrategies = new AcceptanceStrategyStore(paths)
  const publishCursor = new PublishCursorStore(paths.root)
  const pullCursor = new PullCursorStore(paths.root)

  const worklabRoot = join(paths.root, 'worklabs')
  // The router worklab and per-issue fallback directories must exist before dispatch.
  const scratchRoot = join(paths.root, '.cache')
  mkdirSync(worklabRoot, { recursive: true })
  mkdirSync(scratchRoot, { recursive: true })
  const portraitDir = join(worklabRoot, 'workspaces')
  const portraitIndexFile = join(portraitDir, 'index.md')
  const portraitLedgerFile = join(worklabRoot, 'workspaces.json')
  const workspacesCustomFile = join(worklabRoot, 'workspaces-custom.json')
  const strategyCustomFile = join(worklabRoot, 'strategy-custom.json')
  const canonicalRoot = join(dshHome(), 'storages', 'castboard')
  const usesCanonicalRoot = resolve(paths.root) === resolve(canonicalRoot)
  // Keep this root in sync with `TaskAttachmentIndex`'s `<root>/attachments/<issueId>/`.
  const attachmentsRoot = join(paths.root, ATTACHMENTS_DIR)

  // A failed fetch is logged and returns an empty list; card creation still proceeds.
  const upstreamComments = async (issueId: string): Promise<readonly UpstreamIssueComment[]> => {
    const face = options.faces?.issueComments
    if (face === undefined) return []
    try {
      return (await face(issueId)).map(toUpstreamComment)
    } catch (error) {
      note('warn', 'issue-comments-failed', `${issueId}: ${errorText(error)}`)
      return []
    }
  }

  // The SDK wants `assignedAt` as an ISO string.
  const remoteRouted = options.faces?.routed === undefined
    ? undefined
    : async (
      issueId: string,
      input: {
        assigneeTask: string
        cwd: string
        urgency: string
        permission?: string
        assignerMeta: Record<string, unknown>
        assignedAt: number
      },
    ): Promise<void> => {
      await options.faces!.routed!(issueId, {
        assigneeTask: input.assigneeTask,
        cwd: input.cwd,
        urgency: input.urgency,
        ...(input.permission === undefined ? {} : { permission: input.permission }),
        assignerMeta: input.assignerMeta,
        assignedAt: new Date(input.assignedAt).toISOString(),
      })
    }

  const remoteIssue = options.faces?.issueGet === undefined
    ? undefined
    : (issueId: string) => options.faces!.issueGet!(issueId)

  const remoteAbandon = options.faces?.abandon === undefined
    ? undefined
    : async (issueId: string, assigneeMeta?: Record<string, unknown>): Promise<void> => {
      await options.faces!.abandon!([issueId], assigneeMeta)
    }

  await Promise.all([
    tasks.load(),
    issues.load(),
    links.load(),
    attachments.load(),
    publishCursor.load(),
    pullCursor.load(),
  ])

  if (lease.isOwner()) {
    // Issues live only in the shared library now; no task→local-issue migration.
    // Backfill card sources first, so cards with an unknown source are not counted as occupying slots.
    await backfillTaskSources({ store: tasks, issueSourceOf: id => issues.summary(id)?.source })
      .catch(error => note('warn', 'source-backfill-failed', errorText(error)))

    // Acceptance strategies are used as stored. No historical id migration.
  }

  const fallbackWorkspaces: WorkspaceFace = (() => {
    const list = (): readonly { id: string; path: string; title: string }[] => options.listWorkspaces?.() ?? []
    const normalize = (value: string): string => value.replace(/[\\/]+$/, '').toLowerCase()
    return {
      resolveByPath: async path => {
        const target = normalize(path)
        const hit = list().find(candidate => normalize(candidate.path) === target)
        return hit === undefined ? undefined : { id: hit.id }
      },
      get: id => {
        const hit = list().find(candidate => candidate.id === id)
        if (hit !== undefined) return { id: hit.id, path: hit.path, title: hit.title }
        const path = options.workspacePathOf?.(id)
        return path === undefined ? undefined : { id, path, title: id }
      },
      list: () => list().map(item => ({ ...item })),
    }
  })()
  const workspaces = options.workspaces ?? fallbackWorkspaces
  const resolveWorkspaceForTools = async (cwd: string): Promise<{ id: string; path: string } | undefined> => {
    const found = await workspaces.resolveByPath(cwd)
    if (found !== undefined) {
      const full = workspaces.get(found.id)
      if (full !== undefined) return { id: full.id, path: full.path }
    }
    // The directory exists but is not a dsh workspace yet, so the assembly layer registers it once.
    if (options.workspaceResolver === undefined) return undefined
    try {
      const id = await options.workspaceResolver(cwd)
      return id === undefined ? undefined : { id, path: cwd }
    } catch (error) {
      note('warn', 'workspace-ensure-failed', `${cwd}: ${errorText(error)}`)
      return undefined
    }
  }

  // The execution service is built after the deliverer, so live sessions are resolved through a reference at call time.
  // Comments use the same reference: both task context and redelivery must read through
  // ThreadService.list(), which owns echo deduplication.
  const threadRef: { current?: ThreadService } = {}
  const deliverer = new CommentDeliverer({
    links,
    commentsOf: anchorId => threadRef.current?.list(anchorId) ?? Promise.resolve([]),
    syncCommentAttachments: (issueId, commentId) => attachmentSync.syncComment(issueId, commentId),
    commentAttachments: (issueId, commentId) => attachments.list(issueId)
      .filter(row => row.targetType === 'comment' && row.targetId === commentId && row.state !== 'pending')
      .map(row => ({ name: row.name, path: row.path })),
    coveredUntil: anchorId => executionRef.current?.commentsSeededUntil(anchorId) ?? 0,
    liveSession: sessionId => {
      const live = executionRef.current?.liveAgentOf(sessionId)
      if (live === undefined) return undefined
      return {
        running: live.running,
        push: entries => {
          for (const entry of entries) {
            const result = live.push(entry)
            if (!result.ok) return false
          }
          return 'pushed'
        },
        inject: entries => live.inject(entries),
        followUp: text => live.followUp(text),
      }
    },
    canResume: sessionId => tasks.taskIdOfSession(sessionId) !== undefined,
    resume: (sessionId, input) => {
      const taskId = tasks.taskIdOfSession(sessionId)
      if (taskId === undefined) return false
      const text = input.context.map(entry => entry.text).join('\n\n')
      return executionRef.current
        ?.wakeForComment(taskId, text)
        .then(result => result.ok)
        .catch(() => false) ?? false
    },
    now: clock,
    log: noteAny,
  })

  const thread = new ThreadService({
    comments,
    links,
    now: clock,
    publish: anchorId => { publisherRef.current?.schedule(anchorId) },
    deliver: (source, anchorId, list) => deliverer.deliver(source, anchorId, list),
  })
  threadRef.current = thread

  const execution = new ExecutionService({
    ctx: options.ctx,
    tasks,
    thread,
    links,
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    workspaces: { get: id => workspaces.get(id) },
    ...(options.archiveSession === undefined ? {} : { archiveSession: options.archiveSession }),
    attachmentsFor: async issueId => attachments.list(issueId)
      .filter(row => row.state !== 'pending')
      .map(row => ({
        name: row.name,
        path: row.path,
        type: attachmentKind(row),
        targetType: row.targetType,
        targetId: row.targetId,
        ...(row.description === undefined ? {} : { description: row.description }),
      })),
    syncCommentAttachments: (issueId, commentId) => attachmentSync.syncComment(issueId, commentId),
    cacheDir: join(paths.root, '.cache'),
    acceptanceStrategies: () => acceptanceStrategies.list(),
    ...(model === undefined ? {} : { resolveDefaultModel: () => model }),
    onIssueRunning: issueId => {
      void (async () => {
        const issue = await issues.get(issueId)
        if (issue === undefined || issue.status !== 'routing') return
        await issues.update(issueId, draft => {
          if (draft.status === 'routing') draft.status = 'running'
        })
        if (options.faces?.running === undefined) return
        await options.faces.running(issueId).catch(error => {
          note('warn', 'issue-running-remote-failed', `${issueId}: ${errorText(error)}`)
        })
      })().catch(error => note('warn', 'issue-running-failed', errorText(error)))
    },
    onSettled: async ({ task, record }) => {
      const artifacts = record.report?.artifacts
      if (task.issueId === undefined || artifacts === undefined || artifacts.length === 0) return
      const uplink = uplinkRef.current
      if (uplink === undefined) return
      const result = await uplink.upload(task.issueId, [...artifacts], {
        ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
        ...(record.report?.summary === undefined ? {} : { description: record.report.summary }),
      })
      if (result.failed.length > 0) noteAny('warn', 'artifact-uplink-partial', result.failed)
    },
    now: clock,
    hostInstanceId: instanceId,
    maxConcurrent: () => maxConcurrentOf(settings.get(), maxConcurrentOption()),
  })
  executionRef.current = execution

  const acceptance = new AcceptanceRunner({ execution })

  const interactions = new InteractionService({
    now: clock,
    taskIdOfSession: sessionId => tasks.taskIdOfSession(sessionId),
    face: createInteractionFace(options.ctx),
  })

  // Interaction reporter: event-driven wake + safety tick from the coordinator below.
  const projection = new InteractionProjection({
    commentsOf: issueId => thread.list(issueId),
  })
  const reporter = new InteractionReporter({
    interactions,
    tasks,
    links,
    thread,
    projection,
    settings: () => settings.get(),
    instance: () => deviceInstance,
    now: clock,
    log: noteAny,
  })
  const bridge = new InteractionBridge({
    interactions,
    tasks,
    links,
    thread,
    enabled: () => commentsEnabled(settings.get()),
    log: noteAny,
  })
  const coordinator = new InteractionCoordinator({
    run: async () => {
      const refresh = await interactions.refreshResult()
      if (!refresh.ok) return
      const applied = await bridge.reconcile(refresh.items)
      await reporter.tick(applied, refresh)
    },
    log: (event, error) => note('warn', event, errorText(error)),
  })

  const hostEvents = options.ctx as {
    on?: (name: string, listener: (change: InteractionChangedEvent) => void) => (() => void) | void
    effect?: (callback: () => unknown, label?: string) => unknown
  } | undefined
  const offInteraction = hostEvents?.on?.('magica/interaction-changed', change => {
    if (change.action === 'removed') {
      interactions.noteOutcome(change.item.id, outcomeOfInteractionChange(change))
    }
    coordinator.wake(change.action)
  })
  if (offInteraction !== undefined && hostEvents?.effect !== undefined) {
    hostEvents.effect(() => offInteraction, 'castboard:interaction-changed')
  }

  const uplink = new ArtifactUplink({
    cursors: publishCursor,
    upload: (path, fileName) => uploadArtifact(options.faces?.client, path, fileName),
    attach: (issueId, spec) => attachArtifact(options.faces?.client, {
      targetType: 'issue',
      targetId: issueId,
    }, spec),
    isWritable: () => lease.isOwner(),
    log: noteAny,
  })
  uplinkRef.current = uplink

  const uploadCommentAttachments = async (input: {
    issueId: string
    commentId: string
    role: 'assigner' | 'assignee'
    paths: readonly string[]
  }): Promise<{ attached: number; failed: readonly { path: string; reason: string }[] }> => {
    const client = options.faces?.client
    const failed: Array<{ path: string; reason: string }> = []
    let attached = 0
    for (const raw of input.paths) {
      const path = resolve(raw)
      // Scope the idempotency key by comment/role; the same file may also be
      // attached to the issue as input/output without being skipped.
      const key = `comment:${input.commentId}:${input.role}:${path}`
      if (publishCursor.uploadedFileId(key) !== undefined) {
        attached += 1
        continue
      }
      try {
        const fileId = await uploadArtifact(client, path, basename(path))
        await attachArtifact(client, {
          targetType: 'comment',
          targetId: input.commentId,
        }, {
          fileId,
          fileName: basename(path),
          role: input.role,
        })
        await publishCursor.setUploadedFile(key, fileId)
        attached += 1
      } catch (error) {
        failed.push({ path, reason: errorText(error) })
      }
    }
    if (attached > 0) {
      void attachmentSync.syncComment(input.issueId, input.commentId, { wait: false })
        .catch((error: unknown) => {
          note('warn', 'comment-attachment-sync-failed', errorText(error))
        })
    }
    return { attached, failed }
  }

  const customWorkspaces = {
    read: () => readWorkspacesCustom(workspacesCustomFile),
    replace: async (raw: unknown) => writeWorkspacesCustom(workspacesCustomFile, normalizeNotes(raw)),
  }
  const customStrategies = {
    read: () => readStrategyCustom(strategyCustomFile),
    replace: async (raw: unknown) => writeStrategyCustom(strategyCustomFile, normalizeStrategies(raw)),
  }
  const settingsSignature = (): string => JSON.stringify(settings.stored())
  const settingsFace = {
    read: () => settings.read(),
    stored: () => settings.stored(),
    write: async (raw: unknown) => {
      const saved = await settings.write(raw)
      // Reporter/bridge re-read settings every tick; wake now so a toggle (especially
      // commentsEnabled) takes effect without waiting for the 30s safety tick.
      coordinator.wake('settings')
      return saved
    },
  }
  const reload = async (): Promise<void> => {
    await tasks.reloadIfChanged()
    await issues.reloadIfChanged()
    await links.reloadIfChanged()
    // Settings are hand-editable and tiny; re-read on every read request so an edit in an
    // editor takes effect on the next poll instead of at the next restart.
    const before = settingsSignature()
    await settings.read()
    if (settingsSignature() !== before) coordinator.wake('settings')
  }

  const routes = createRoutes({
    tasks,
    issues,
    links,
    comments,
    attachmentSync,
    settings: settingsFace,
    execution,
    thread,
    paths,
    templates,
    acceptanceStrategies,
    customWorkspaces,
    customStrategies,
    ...(options.faces?.auth === undefined ? {} : { auth: options.faces.auth }),
    ...(options.faces?.projects === undefined ? {} : { projects: options.faces.projects }),
    ...(options.faces?.devices === undefined ? {} : { devices: options.faces.devices }),
    instance: () => instanceId,
    deviceInstance: () => deviceInstance,
    now: clock,
    isWritable: () => lease.isOwner(),
    workspaces,
    taskExists: (id: string) => tasks.get(id) !== undefined,
    ...(remoteIssue === undefined
      ? {}
      : {
        issueState: (issueId: string) => remoteIssue(issueId),
        issueBrief: async (issueId: string) => {
          const row = await remoteIssue(issueId)
          if (row === undefined) return undefined
          return {
            ...(typeof row.title === 'string' ? { title: row.title } : {}),
            ...(typeof row.status === 'string' ? { status: row.status } : {}),
            ...(typeof row.urgency === 'string' ? { urgency: row.urgency } : {}),
            ...(typeof row.assignee === 'string' ? { assignee: row.assignee } : {}),
          }
        },
      }),
    ...(options.faces?.issueList === undefined ? {} : { issueList: options.faces.issueList }),
    ...(options.faces?.issueComments === undefined ? {} : { issueComments: options.faces.issueComments }),
    ...(options.faces?.comments === undefined ? {} : { commentPublish: options.faces.comments.publish }),
    ...(options.faces?.abandon === undefined
      ? {}
      : { abandonRemote: (issueIds: readonly string[]) => options.faces!.abandon!(issueIds) }),
    ...(options.faces?.issues === undefined
      ? {}
      : {
        createRemote: async (draft: CreateIssueBody) => {
          const result = await options.faces!.issues!.createMany([{
            assignerMeta: {
              ...(draft.assignerMeta ?? {}),
              title: draft.title,
              detail: draft.detail ?? '',
            },
            assignee: draft.assignee,
            assigneeInstance: draft.assigneeInstance ?? '',
            source: ISSUE_SOURCE_DSH,
            sourceInstance: deviceInstance,
            ...(draft.projectId === undefined ? {} : { projectId: draft.projectId }),
            ...(draft.cwd === undefined ? {} : { cwd: draft.cwd }),
            ...(draft.urgency === undefined ? {} : { urgency: draft.urgency }),
            ...(draft.permission === undefined ? {} : { permission: draft.permission }),
            ...(draft.attachments === undefined ? {} : { attachments: [...draft.attachments] }),
          }])
          const created = result.created[0]
          if (created === undefined) throw new Error('共享库没有返回新建 issue')
          return { issueId: created.issueId, assignee: draft.assignee }
        },
      }),
    interactions,
    acceptance,
    ...(options.faces?.query === undefined ? {} : { query: options.faces.query }),
    portrait: { refreshAll: async () => owner.portrait?.refreshAll() ?? { reset: 0 } },
    ownerHint: () => 'another dsh web owns the storage lease',
    dataPlane: options.dataPlaneIssue === undefined
      ? { ok: true }
      : { ok: false, reason: options.dataPlaneIssue.reason, ...(options.dataPlaneIssue.configPath === undefined ? {} : { configPath: options.dataPlaneIssue.configPath }) },
    reload,
    ...(PLUGIN_VERSION === undefined ? {} : { version: PLUGIN_VERSION }),
  })

  const ownerDisposers: Disposable[] = []
  const ownerDisposing = new Set<Promise<unknown>>()
  let ownerStarted = false

  const settle = (item: Disposable): void => {
    try {
      const result = item.dispose()
      if (result !== undefined && typeof (result as Promise<unknown>).then === 'function') {
        const pending = (result as Promise<unknown>)
          .catch(error => noteAny('warn', 'owner-dispose-failed', error))
          .finally(() => { ownerDisposing.delete(pending) })
        ownerDisposing.add(pending)
      }
    } catch (error) {
      noteAny('warn', 'owner-dispose-failed', error)
    }
  }

  const stopOwnerServices = (): void => {
    ownerStarted = false
    coordinator.stop()
    for (const item of ownerDisposers.splice(0).reverse()) settle(item)
    owner.publisher = undefined
    owner.inbox = undefined
    owner.sync = undefined
    owner.finalizer = undefined
    owner.router = undefined
    owner.portrait = undefined
    publisherRef.current = undefined
  }

  const startOwnerServices = (): void => {
    if (ownerStarted || !lease.isOwner()) return
    ownerStarted = true
    try {
      startOwnerCapabilities()
    } catch (error) {
      note('warn', 'owner-start-failed', errorText(error))
      stopOwnerServices()
    }
  }

  const startOwnerCapabilities = (): void => {
    const remoteEnabled = !envOff('DSH_CASTBOARD_SYNC')
    const routerEnabled = !envOff('DSH_CASTBOARD_ROUTER')
    const portraitEnabled = !envOff('DSH_CASTBOARD_PORTRAIT')
    // Publish only comments that the link table or ledger knows exist remotely.
    const publisher = new CommentPublisher({
      enabled: () => remoteEnabled,
      canPublish: () => lease.isOwner(),
      comments,
      links,
      cursor: publishCursor,
      publishComment: async pending => {
        const face = options.faces?.comments
        if (face === undefined) throw new Error('共享库评论通道不可用')
        await face.publish({
          issueId: pending.anchorId,
          commentId: pending.commentId,
          body: pending.body,
          role: pending.role,
          authorType: pending.authorType,
          createdAt: pending.createdAt,
        })
      },
      now: clock,
      log: noteAny,
    })
    owner.publisher = publisher
    publisherRef.current = publisher
    ownerDisposers.push({ dispose: () => publisher.dispose() })
    note('info', 'publisher-started')
    void publisher.recover().catch(error => noteAny('warn', 'publisher-recover-failed', error))

    // Poll comments for linked issues and in-flight issues only.
    const inbox = new IssueCommentInbox({
      interest: () => new Set([
        ...links.issueIds(),
        // Cards already bound to an issue are watched even when the relation table lags
        // behind (imported / restored cards): the executor must still receive its comments.
        ...tasks.summaries()
          .filter(task => task.issueId !== undefined && task.issueId !== '' && task.trashed !== true)
          .map(task => task.issueId as string),
        ...issues.summaries()
          .filter(issue => issue.status === 'accepted' || issue.status === 'routing')
          .map(issue => issue.id),
      ]),
      fetchPage: async query => {
        const face = options.faces?.comments
        if (face === undefined) return { items: [], nextSinceId: query.sinceId }
        const page = await face.listSince({
          ...(query.sinceId > 0 ? { sinceId: String(query.sinceId) } : {}),
          limit: query.limit,
        })
        return {
          items: page.items.map(item => ({
            commentId: item.commentId,
            issueId: item.issueId,
            body: item.body,
            createdAt: item.createdAt,
            role: item.role,
            ...(item.authorType === undefined ? {} : { authorType: item.authorType }),
            ...(item.author === undefined ? {} : { author: item.author }),
          })),
          nextSinceId: Number(page.nextSinceId ?? query.sinceId) || query.sinceId,
        }
      },
      thread,
      deliverer,
      cursor: pullCursor,
      onIngested: async anchorId => {
        projection.invalidate(anchorId)
        coordinator.wake('ingested')
      },
      enabled: () => remoteEnabled && settings.get().commentsEnabled !== false,
      canPoll: () => lease.isOwner(),
      now: clock,
      intervalOf: () => settings.get().commentPollMs
        ?? envInt(['DSH_CASTBOARD_COMMENT_POLL_MS']),
      log: noteAny,
    })
    owner.inbox = inbox
    ownerDisposers.push({ dispose: () => inbox.stop() })
    inbox.start()
    coordinator.start()

    const dispatcher = new DispatcherService({
      store: {
        load: () => tasks.load(),
        summaries: () => tasks.summaries(),
        settings: () => settings.get(),
        subscribe: listener => tasks.subscribe(() => { listener() }),
      },
      execution: { run: (taskId, trigger) => execution.run(taskId, trigger) },
      maxConcurrent: maxConcurrentOf(settings.get(), envInt(['DSH_CASTBOARD_MAX_CONCURRENT'])),
    })
    const scheduler = new SchedulerService({
      store: {
        load: () => tasks.load(),
        summaries: () => tasks.summaries(),
        subscribe: listener => tasks.subscribe(() => { listener() }),
        mutate: (kind, mutator) => tasks.mutate(kind as Parameters<TaskStore['mutate']>[0], mutator),
      },
      thread: { addSystem: (anchorId, input) => thread.addSystem(anchorId, input) },
      now: clock,
    })
    ownerDisposers.push(dispatcher, scheduler)
    void dispatcher.start().catch(error => noteAny('warn', 'dispatcher-start-failed', error))
    void scheduler.start().catch(error => noteAny('warn', 'scheduler-start-failed', error))

    // Pull only pending issues assigned to this machine.
    const sync = new IssueSyncService({
      issues,
      ...(options.faces?.sync === undefined ? {} : { face: options.faces.sync }),
      instance: () => deviceInstance,
      intervalMs: envInt(['DSH_CASTBOARD_SYNC_INTERVAL_MS']),
      os: () => process.platform === 'win32' ? 'windows' : 'linux',
      ...(options.workspaceResolver === undefined ? {} : { resolveWorkspace: options.workspaceResolver }),
      isOwner: () => lease.isOwner(),
      now: clock,
      log: note,
    })
    owner.sync = sync
    ownerDisposers.push(sync)
    if (remoteEnabled) sync.start()

    const finalizeFace = options.faces?.finalize
    const finalizer = new IssueFinalizer({
      issues,
      now: clock,
      ...(finalizeFace === undefined
        ? {}
        : {
          issueFinalize: (issueId, input) => finalizeFace.finalize({ issueId, ...input }),
        }),
      uploadArtifacts: async (issueId, artifacts, options) => {
        await uplink.upload(issueId, [...artifacts], {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.description === undefined ? {} : { description: options.description }),
        })
      },
      isOwner: () => lease.isOwner(),
    })
    owner.finalizer = finalizer
    ownerDisposers.push({ dispose: finalizer.attach(tasks) })

    // Startup compensation for reports whose immediate upload failed or whose
    // process exited before it finished. The report is the authority; this never
    // guesses workspace files.
    void (async () => {
      await tasks.load()
      for (const task of tasks.snapshot().tasks) {
        if (task.issueId === undefined || task.issueId === '') continue
        if (task.status !== 'done' && task.status !== 'canceled' && task.status !== 'abandoned') continue
        const report = [...task.executions].reverse().find(execution => execution.report !== undefined)?.report
        if (report === undefined || report.artifacts.length === 0) continue
        await uplink.upload(task.issueId, report.artifacts, {
          ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
          ...(report.summary === undefined ? {} : { description: report.summary }),
        }).catch((error: unknown) => {
          note('warn', 'artifact-recover-failed', `${task.id}: ${errorText(error)}`)
        })
      }
    })().catch((error: unknown) => {
      note('warn', 'artifact-recover-scan-failed', errorText(error))
    })

    // The router's long-lived session runs in the worklab.
    const directDeps: DirectRouteDeps = {
      issues,
      store: tasks,
      now: clock,
      resolveWorkspace: resolveWorkspaceForTools,
      thread,
      links,
      comments: upstreamComments,
      ...(remoteAbandon === undefined ? {} : { issueAbandon: remoteAbandon }),
      ...(remoteRouted === undefined ? {} : { issueRouted: remoteRouted }),
      ensureDir: async path => {
        try {
          await mkdir(path, { recursive: true })
          return true
        } catch {
          return false
        }
      },
    }
    const router = new IssueRouterService({
      issues,
      now: clock,
      openSession: createRouterSessionOpener({
        ctx: options.ctx,
        cwd: worklabRoot,
        sections: [routerGuideSection(castboardIssueRouterXml({
          workspacesCustom: workspacesCustomFile,
          strategyCustom: strategyCustomFile,
          tasksDir: paths.taskDir,
          workspaceIndex: portraitIndexFile,
          portraitDir,
        }))],
        ...(routerModel === undefined ? {} : { model: routerModel }),
        log: note,
      }),
      ...(options.faces?.routing === undefined
        ? {}
        : { issueRouting: (ids: readonly string[]) => options.faces!.routing!(ids) }),
      ...(options.faces?.abandon === undefined
        ? {}
        : { issueAbandoned: (issueId: string) => remoteAbandon!(issueId) }),
      isOwner: () => lease.isOwner(),
      enabled: () => routerEnabled && settings.get().autoRoute !== false,
      renderReferences: async issue => {
        try {
          // Each issue gets its own fallback cwd. The directory is created here,
          // before the turn, so castboard_issue_task can resolve it immediately.
          const fallbackCwd = join(scratchRoot, issue.id)
          await mkdir(fallbackCwd, { recursive: true }).catch(() => { /* tool reports real failures */ })
          const extras = await prepareWorklab({
            home: dshHome(),
            listWorkspaces: () => options.listWorkspaces?.() ?? [],
            // Downloads share the attachment index root, so input files are never stored twice.
            attachmentsRoot,
            downloadAttachments: async (issueId, _dir) => {
              const rows = await attachmentSync.syncIssue(issueId)
              const inputs = rows.filter(row => attachmentKind(row) === 'input')
              const downloaded = inputs
                .filter(row => row.state !== 'pending')
                .map(row => ({
                  name: row.name,
                  path: row.path,
                  ...(row.description === undefined ? {} : { description: row.description }),
                  ...(row.size === undefined ? {} : { size: row.size }),
                }))
              return {
                downloaded,
                failed: inputs.filter(row => row.state === 'pending').length,
              }
            },
            comments: async issueId => {
              const face = options.faces?.issueComments
              if (face === undefined) return []
              return (await face(issueId)).map(toReferenceComment)
            },
            // Register files after they land on disk; execution reads this index through `attachmentsFor`.
            // `put` replaces the issue target as a whole, so keep the already-known output rows
            // (assignee deliverables) while refreshing the input rows from this worklab pass.
            record: async (issueId, dir, files) => {
              const outputs = attachments.list(issueId)
                .filter(row => row.targetType === 'issue' && row.role === 'assignee')
              await attachments.put(issueId, dir, [
                ...files.map(file => ({
                  name: file.name,
                  path: file.path,
                  targetType: 'issue' as const,
                  targetId: issueId,
                  role: 'assigner' as const,
                  ...(file.description === undefined ? {} : { description: file.description }),
                  ...(file.size === undefined ? {} : { size: file.size }),
                })),
                ...outputs,
              ])
            },
            log: note,
          }, issue.id)
          return castboardIssueContext(issue, { ...extras, fallbackCwd })
        } catch (error) {
          // References are optional model material; a failure to prepare them must not block dispatch.
          note('warn', 'router-references-failed', `${issue.id}: ${errorText(error)}`)
          return castboardIssueContext(issue)
        }
      },
      dependsOnStatuses: async issueIds => {
        const face = options.faces?.status
        if (face === undefined) return issueIds.map(issueId => ({ issueId, found: false }))
        try {
          const statuses = await face.statuses(issueIds)
          return issueIds.map(issueId => {
            const status = statuses[issueId]
            return status === undefined || status === null
              ? { issueId, found: false }
              : { issueId, found: true, status }
          })
        } catch (error) {
          // A failed probe means "not found"; keep one log line so the branch is not silent.
          note('warn', 'issue-depends-on-probe-failed', errorText(error))
          return issueIds.map(issueId => ({ issueId, found: false }))
        }
      },
      commentBlocked: async (issueId, body) => {
        await thread.addSystem(issueId, { body, systemKey: 'sys.routeBlocked', createdAt: clock() })
      },
      syncAttachments: async issueId => {
        // Claim/route preparation needs both roles of the issue target; comment rows are untouched.
        await attachmentSync.syncIssue(issueId)
      },
      directRoute: issueId => directRoute(directDeps, issueId),
      log: note,
    })
    owner.router = router
    ownerDisposers.push(router)
    router.start()

    // Runtime commands sit beside the router: no card, no agent session. Sync already
    // claims the issue for this instance; this worker runs the command and settles it.
    const runtimeShell = (options.ctx as { get?: (name: string) => unknown }).get?.('shell') as RuntimeShell | undefined
    if (runtimeShell === undefined) {
      note('warn', 'runtime-command-disabled', 'DSH shell 服务不可用，runtime command 不会执行')
    } else {
      const toolsService = (options.ctx as { get?: (name: string) => unknown }).get?.('tools') as ToolsFace | undefined
      const validateToolArgs = createToolArgsValidator(
        name => toolsService?.get?.(name)?.parameters,
        name => (name === 'bash' || name === 'pwsh') ? RUNTIME_COMMAND_ARGUMENTS_SCHEMA : undefined,
      )
      const runtimeWorker = new RuntimeCommandWorker({
        issues,
        instance: () => deviceInstance,
        execute: shellExecutor(runtimeShell),
        validateToolArgs,
        resolveWorkspace: async cwd => {
          const found = await workspaces.resolveByPath(cwd)
          return found === undefined ? undefined : workspaces.get(found.id)
        },
        thread,
        ...(options.faces?.comments === undefined
          ? {}
          : {
            publish: input => options.faces!.comments!.publish({
              issueId: input.issueId,
              commentId: input.commentId,
              body: input.body,
              role: input.role,
              authorType: input.authorType,
              createdAt: input.createdAt,
            }),
          }),
        ...(finalizeFace === undefined
          ? {}
          : {
            finalize: (issueId, input) => finalizeFace.finalize({ issueId, ...input }),
          }),
        enabled: () => !envOff('DSH_CASTBOARD_RUNTIME'),
        allowCrossAccount: () => !envOff('DSH_CASTBOARD_RUNTIME_ALLOW_CROSS_ACCOUNT'),
        isOwner: () => lease.isOwner(),
        now: clock,
        log: noteAny,
      })
      ownerDisposers.push(runtimeWorker)
      runtimeWorker.start()
      note('info', 'runtime-command-started')
    }

    // Portrait scans every workspace on a fixed cadence, skipping the home directory and worklab.
    const portraitStore = new PortraitStore({
      file: portraitLedgerFile,
      now: clock,
      canWrite: () => lease.isOwner(),
      log: note,
    })
    const portraitFilter = {
      excludeSelf: [homedir()],
      excludeSubtrees: [worklabRoot],
    }
    const portraitFace = options.faces?.portrait
    const portrait = new PortraitService({
      entries: portraitStore,
      now: clock,
      batchOf: batchDateOf,
      listWorkspaces: () => dropContainerWorkspaces(
        (options.listWorkspaces?.() ?? []).filter(workspace => isPortraitTarget(workspace.path, portraitFilter)),
      ),
      openSession: async (sessionId, onCompacted) => openWorkSession(options.ctx, {
        label: 'portrait',
        cwd: portraitDir,
        title: 'DSH任务面板项目肖像',
        sandbox: 'workspace-write',
        ...(sessionId === undefined ? {} : { sessionId }),
        idlePrompt: PORTRAIT_IDLE_PROMPT,
        turnSection: PORTRAIT_REMINDER_SECTION,
        sections: [{
          name: PORTRAIT_SECTION,
          order: PORTRAIT_ORDER,
          text: castboardPortraitXml(PORTRAIT_MAX_LINES),
          form: 'instructions',
        }],
        ...(portraitModel === undefined ? {} : { model: portraitModel }),
        ttlMs: workSessionTtlMs('DSH_CASTBOARD_PORTRAIT_TTL_MS'),
        contextPlugin: PLUGIN_NAME,
        quiescence: { timeoutMs: 1_800_000 },
        ...(onCompacted === undefined ? {} : { onCompacted }),
      }),
      isOwner: () => lease.isOwner(),
      portraitWritten: workspaceId => portraitFileWritten(join(portraitDir, `${workspaceId}.md`)),
      outputFileFor: workspaceId => join(portraitDir, `${workspaceId}.md`),
      indexFile: portraitIndexFile,
      ...(portraitFace === undefined
        ? {}
        : {
            publishPortrait: async () => {
              // Reconcile from the ledger, not the directory: only active workspaces
              // are authoritative, and a file left by a removed workspace must not
              // keep being uploaded.
              const entries = portraitStore.ledger().workspaces.filter(entry => entry.disabled !== true)
              for (const entry of entries) {
                const file = join(portraitDir, `${entry.id}.md`)
                try {
                  const detail = await readFile(file, 'utf8')
                  if (detail.trim() === '') {
                    note('warn', 'portrait-publish-skipped', `${entry.id}: 肖像文件为空，跳过上报`)
                    continue
                  }
                  await portraitFace.upsertPortal({
                    workspaceId: entry.id,
                    cwd: entry.path,
                    detail,
                  })
                } catch (error) {
                  // Missing file is normal for a workspace still pending its first run.
                  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    note('warn', 'portrait-publish-failed', `${entry.id}: ${errorText(error)}`)
                  }
                }
              }
            },
            publishIndex: async () => {
              const detail = await readFile(portraitIndexFile, 'utf8').catch(() => '')
              if (detail.trim() === '') {
                note('warn', 'index-publish-skipped', '项目索引为空，跳过上报')
                return
              }
              await portraitFace.upsertIndex({ detail })
            },
          }),
      log: note,
    })
    owner.portrait = portrait
    ownerDisposers.push(portrait)
    if (portraitEnabled) {
      void settings.read()
        .then(current => { portrait.start({ runOnStart: current.portraitRunOnStart === true }) })
        .catch(error => {
          noteAny('warn', 'portrait-settings-read-failed', error)
          portrait.start()
        })
    }

    // Sessions are released when a card leaves in-progress or in-review; the sweep catches missed changes after a restart.
    ownerDisposers.push({ dispose: execution.watchReleases() })
    const sweep = setInterval(() => {
      void execution.sweepSessions().catch(error => noteAny('warn', 'session-sweep-failed', error))
    }, 30_000)
    sweep.unref?.()
    ownerDisposers.push({ dispose: () => { clearInterval(sweep) } })

    // Seed the workspace catalog only under the canonical root; a custom test root must not touch the real home directory.
    if (usesCanonicalRoot && (routerEnabled || portraitEnabled)) {
      void ensureWorkspaceCatalog(dshHome(), () => options.listWorkspaces?.() ?? [])
        .catch(error => noteAny('warn', 'workspace-catalog-failed', error))
    }

    // Repair executions still marked running after a host restart.
    void execution.reconcile()
      .then(repaired => {
        if (repaired > 0) note('warn', 'execution-reconciled', `${String(repaired)} stale running execution(s) repaired`)
      })
      .catch(error => noteAny('warn', 'execution-reconcile-failed', error))
  }
  lifecycle.start = startOwnerServices
  lifecycle.stop = stopOwnerServices

  const runtime: CastboardRuntime = {
    lease,
    tasks,
    issues,
    links,
    comments,
    settings,
    templates,
    acceptanceStrategies,
    attachments,
    attachmentSync,
    thread,
    deliverer,
    uplink,
    execution,
    acceptance,
    interactions,
    interactionProjection: projection,
    workspaces,
    routes,
    now: clock,
    instance: () => instanceId,
    deviceInstance: () => deviceInstance,
    ...(options.faces?.sources === undefined ? {} : { sources: options.faces.sources }),
    ...(options.faces?.issueAttachmentList === undefined ? {} : {
      syncIssueAttachments: async (issueId: string) => {
        const rows = await attachmentSync.syncIssue(issueId)
        return issueStateSyncResult(rows, attachments.dirOf(issueId))
      },
      syncCommentAttachments: async (issueId: string, commentId: string) => {
        const rows = await attachmentSync.syncComment(issueId, commentId)
        return issueStateSyncResult(rows, attachments.dirOf(issueId))
      },
      uploadCommentAttachments,
      attachmentCwd: async (issueId: string) => {
        const issue = await issues.get(issueId)
        if (issue === undefined) return undefined
        // Relative comment attachments follow the issue's working directory; fall
        // back to the assignee card when the cloud row has no cwd.
        return issue.cwd ?? (issue.assigneeTask === undefined
          ? undefined
          : tasks.get(issue.assigneeTask)?.cwd)
      },
    }),
    resolveWorkspaceForTools,
    upstreamComments,
    injectContext: (sessionId, entries) => {
      const live = execution.liveAgentOf(sessionId)
      if (live === undefined) return false
      for (const entry of entries) {
        if (!live.push({ name: entry.name, text: entry.text }).ok) return false
      }
      return true
    },
    ...(options.faces?.query === undefined ? {} : { query: options.faces.query }),
    ...(options.faces?.issues === undefined ? {} : { remoteCreate: options.faces.issues }),
    ...(remoteRouted === undefined ? {} : { remoteRouted }),
    ...(remoteAbandon === undefined ? {} : { remoteAbandon }),
    ...(remoteIssue === undefined ? {} : { remoteIssue }),
    reload,
    get publisher() { return owner.publisher },
    get inbox() { return owner.inbox },
    get sync() { return owner.sync },
    get finalizer() { return owner.finalizer },
    get router() { return owner.router },
    get portrait() { return owner.portrait },
    startOwnerServices,
    stopOwnerServices,
    dispose: async () => {
      stopOwnerServices()
      await Promise.allSettled([...ownerDisposing])
      try {
        await deliverer.dispose()
      } catch (error) {
        noteAny('warn', 'deliverer-dispose-failed', error)
      }
      execution.dispose()
      lease.dispose()
    },
  }

  if (options.startOwner !== false) startOwnerServices()
  return runtime
}

/**
 * Tools hold stable references: owner services can be rebuilt on promotion, so the
 * publisher, uplink, and deliverer are fetched from the runtime at call time.
 */
export function toolDepsFor(runtime: CastboardRuntime): CastboardToolDeps {
  const executionFace: ExecutionFace = {
    releaseTaskSessions: () => runtime.execution.sweepSessions(),
  }

  return {
    store: runtime.tasks,
    workspaces: runtime.workspaces,
    thread: runtime.thread,
    execution: executionFace,
    artifactUplink: (issueId, artifacts, options) => runtime.uplink.upload(issueId, [...artifacts], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.description === undefined ? {} : { description: options.description }),
    }),
    now: runtime.now,
    issues: runtime.issues,
    comments: runtime.comments,
    links: runtime.links,
    interactionProjection: runtime.interactionProjection,
    interactions: runtime.interactions,
    interactionEnabled: () => commentsEnabled(runtime.settings.get()),
    resolveWorkspace: runtime.resolveWorkspaceForTools,
    upstreamComments: runtime.upstreamComments,
    ...(runtime.remoteIssue === undefined ? {} : { remoteIssue: runtime.remoteIssue }),
    remoteComments: async issueId => (await runtime.upstreamComments(issueId)).map(comment => ({
      ...(comment.id === undefined ? {} : { id: comment.id }),
      body: comment.content,
      createdAt: comment.createdAt ?? (comment.at === undefined ? runtime.now() : Date.parse(comment.at)),
      ...(comment.role === undefined ? {} : { role: comment.role }),
      ...(comment.authorType === undefined ? {} : { authorType: comment.authorType }),
      ...(comment.author === '' ? {} : { author: comment.author }),
    })),
    ...(runtime.remoteRouted === undefined ? {} : { issueRouted: runtime.remoteRouted }),
    ...(runtime.remoteAbandon === undefined ? {} : { issueAbandon: runtime.remoteAbandon }),
    deliverer: {
      deliver: (source, anchorId, list, options) => runtime.deliverer.deliver(source, anchorId, list, options),
    },
    ...(runtime.query === undefined ? {} : { query: runtime.query }),
    ...(runtime.sources === undefined ? {} : { sources: runtime.sources }),
    ...(runtime.syncIssueAttachments === undefined ? {} : { syncIssueAttachments: runtime.syncIssueAttachments }),
    ...(runtime.syncCommentAttachments === undefined ? {} : { syncCommentAttachments: runtime.syncCommentAttachments }),
    ...(runtime.uploadCommentAttachments === undefined ? {} : { uploadCommentAttachments: runtime.uploadCommentAttachments }),
    ...(runtime.attachmentCwd === undefined ? {} : { attachmentCwd: runtime.attachmentCwd }),
    ...(runtime.remoteCreate === undefined ? {} : { remoteCreate: runtime.remoteCreate }),
    instance: () => runtime.deviceInstance(),
    inject: (sessionId, entries) => sessionId !== undefined && runtime.injectContext(sessionId, entries),
  }
}

/** `CASTBOARD_TRACE=1` wraps tool execution in sanitized logging. */
function traceTool(definition: HostToolDefinition, enabled: boolean): HostToolDefinition {
  if (!enabled) return definition
  const original = definition.execute
  return {
    ...definition,
    execute: async (args, exec) => {
      eventLog('info', 'trace-tool-call', `${definition.name} ${tracePayload(args)}`)
      try {
        const value = await original(args, exec)
        eventLog('info', 'trace-tool-result', `${definition.name} ${tracePayload(value)}`)
        return value
      } catch (error) {
        eventLog('info', 'trace-tool-error', `${definition.name} ${tracePayload(errorText(error))}`)
        throw error
      }
    },
  }
}

/**
 * Register tools once the `tools` service is ready. Sampling `ctx.get('tools')` during
 * apply would silently register nothing when the service arrives late.
 */
export function installTools(ctx: ClientLike, deps: () => Promise<CastboardToolDeps>): void {
  ctx.inject(['tools'], scope => {
    const tools = scope.tools
    if (tools === undefined) return
    const disposers: (() => void)[] = []
    let active = true
    scope.effect(() => {
      void deps()
        .then(current => {
          if (!active) return
          const traced = process.env.CASTBOARD_TRACE === '1'
          for (const definition of buildTools(current)) {
            try {
              disposers.push(tools.register(traceTool(definition, traced)))
            } catch (error) {
              note('warn', 'tool-register-failed', `${definition.name}: ${errorText(error)}`)
            }
          }
          note('info', 'tools-registered', String(disposers.length))
        })
        .catch(error => {
          note('warn', 'tool-register-skipped', errorText(error))
        })
      return () => {
        active = false
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch (error) {
            noteAny('warn', 'tool-unregister-failed', error)
          }
        }
      }
    }, 'dsh-magica-castboard: tools')
  })
}

/**
 * Install the board prompt section. `systemPrompt` is agent-scoped, so the plugin root
 * context may not see it; skip quietly in that case.
 */
export function installPromptSection(ctx: ClientLike): void {
  ctx.inject(['systemPrompt'], scope => {
    const systemPrompt = scope.systemPrompt
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return
    try {
      // `section()` already returns a fiber-tracked disposer (raw/57 warns that wrapping it in
      // another `ctx.effect` would give one resource two lifecycle owners).
      systemPrompt.section({
        name: BOARD_PROMPT_SECTION,
        order: (systemPrompt.getSectionOrder?.('TOOLS_SDK') ?? 0) + BOARD_PROMPT_ORDER_OFFSET,
        text: CASTBOARD_SYSTEM_PROMPT,
      })
    } catch (error) {
      note('warn', 'prompt-section-failed', errorText(error))
    }
  })
}

/** SDK calls may return `{ ok, data }` or a direct value. */
function unwrapSdk<T>(value: unknown): T | undefined {
  if (value === null || typeof value !== 'object') return value as T | undefined
  if ('ok' in value) {
    const envelope = value as { ok: boolean; data?: T }
    return envelope.ok ? envelope.data : undefined
  }
  return value as T
}

/** Upload an artifact and return its remote file id; attaching to the issue is separate. */
async function uploadArtifact(client: CastboardClientLike | undefined, path: string, fileName: string): Promise<string> {
  const upload = client?.file?.upload as ((input: { name: string; data: Uint8Array }) => Promise<unknown>) | undefined
  if (upload === undefined) throw new Error('产物上传通道不可用（缺少 file.upload）')
  const data = await readFile(path)
  const payload = unwrapSdk<{ fileId?: unknown }>(await upload({ name: fileName, data }))
  const fileId = payload?.fileId
  if (typeof fileId !== 'string' || fileId === '') throw new Error('file.upload 未返回 fileId')
  return fileId
}

interface AttachmentTarget {
  readonly targetType: 'issue' | 'comment'
  readonly targetId: string
}

async function attachArtifact(
  client: CastboardClientLike | undefined,
  target: AttachmentTarget,
  spec: ArtifactAttachmentSpec,
): Promise<void> {
  const add = (client?.issue?.attachment?.add
    ?? client?.issue?.attachments?.add
    ?? client?.issueAttachmentAdd) as
    | ((items: readonly Record<string, unknown>[]) => Promise<unknown>)
    | undefined
  if (add === undefined) throw new Error('产物挂载通道不可用（缺少 attachments.add）')
  await add([{
    targetType: target.targetType,
    targetId: target.targetId,
    fileId: spec.fileId,
    fileName: spec.fileName,
    role: spec.role,
    ...(spec.description === undefined ? {} : { description: spec.description }),
  }])
}

interface SpellbookInteractionBridge {
  collectPendingInteractions?: (
    host: unknown,
    options?: { sessionId?: string; maxArgsChars?: number },
  ) => readonly {
    kind: 'approval' | 'question'
    id: string
    sessionId: string
    since: number
    toolName?: string
    reason?: string
    displayReason?: string
    args?: string
    callId?: string
    questions?: readonly {
      id?: string
      header?: string
      question?: string
      options?: readonly { label: string; description?: string }[]
      multiSelect?: boolean
      /** The raw dsh tool payload uses `multi_select`; older hosts may expose it as-is. */
      multi_select?: boolean
    }[]
  }[]
  answerApproval?: (sessionId: string, approvalId: string, outcome: string) => string
  answerQuestion?: (sessionId: string, questionId: string, answer: unknown) => string
  cancelQuestion?: (sessionId: string, questionId: string) => string
}

let spellbookBridge: SpellbookInteractionBridge | null | undefined

/** Load the spellbook bridge lazily; null means the package is missing and the UI stays read-only. */
async function loadSpellbookBridge(): Promise<SpellbookInteractionBridge | null> {
  if (spellbookBridge !== undefined) return spellbookBridge
  try {
    spellbookBridge = (await import('@meiyukichan/dsh-magica-spellbook')) as SpellbookInteractionBridge
  } catch (error) {
    note('warn', 'interaction-bridge-unavailable', errorText(error))
    spellbookBridge = null
  }
  return spellbookBridge
}

/**
 * Map spellbook's raw removal reason to the protocol outcome.
 *
 * Approval values are `ApprovalOutcome`; question values are the event suffix
 * (`answered` / `cancelled` / `aborted`).
 */
function outcomeOfInteractionChange(change: InteractionChangedEvent): InteractionOutcome {
  if (change.action !== 'removed') return 'unknown'
  const raw = change.outcome
  if (change.item.kind === 'approval') {
    if (raw === 'allowed-once' || raw === 'rejected') return 'answered'
    if (raw === 'cancelled' || raw === 'unavailable') return 'cancelled'
    return 'unknown'
  }
  if (raw === 'answered') return 'answered'
  if (raw === 'cancelled' || raw === 'aborted') return 'cancelled'
  return 'unknown'
}

/**
 * Forward board actions to spellbook's per-session index. The host agent owns the
 * pending list; this layer only relays approve/answer/cancel.
 */
function createInteractionFace(host?: unknown): InteractionFace {
  const bridgeOf = async (missing: string): Promise<SpellbookInteractionBridge> => {
    const bridge = await loadSpellbookBridge()
    if (bridge === null) throw new Error(missing)
    return bridge
  }
  const pending = async (kind: 'approval' | 'question'): Promise<readonly PendingInteraction[]> => {
    const bridge = await loadSpellbookBridge()
    if (bridge?.collectPendingInteractions === undefined) return []
    return bridge.collectPendingInteractions(host, { maxArgsChars: 4000 })
      .filter(item => item.kind === kind)
      .map(item => {
        const first = item.questions?.[0]
        const raw: PendingInteractionRecord | undefined = kind === 'question'
          ? {
              kind: 'question',
              id: item.id,
              sessionId: item.sessionId,
              since: item.since,
              // Pass spellbook's question objects through untouched. This is the
              // authoritative shape for `multiSelect`, option descriptions, etc.
              questions: (item.questions ?? []).map(question => ({
                id: question.id ?? item.id,
                question: question.question ?? '',
                ...(question.header === undefined ? {} : { header: question.header }),
                ...(question.options === undefined ? {} : { options: question.options }),
                ...(question.multiSelect === true || question.multi_select === true ? { multiSelect: true } : {}),
              })),
            }
          : {
              kind: 'approval',
              id: item.id,
              sessionId: item.sessionId,
              since: item.since,
              toolName: item.toolName ?? '审批',
              ...(item.reason === undefined ? {} : { reason: item.reason }),
              ...(item.args === undefined ? {} : { args: item.args }),
              ...(item.callId === undefined ? {} : { callId: item.callId }),
              ...(item.displayReason === undefined
                ? {}
                : { displayReason: { zh: item.displayReason, en: item.displayReason } }),
            }
        return {
          id: item.id,
          kind,
          sessionId: item.sessionId,
          createdAt: item.since,
          title: kind === 'approval' ? (item.toolName ?? '审批') : (first?.header ?? '提问'),
          body: kind === 'approval'
            ? (item.displayReason ?? item.reason ?? '等待审批')
            : (first?.question ?? '等待回答'),
          ...(first?.options === undefined || first.options.length === 0
            ? {}
            : {
                options: first.options.map(option => option.label),
                optionDetails: first.options.map(option => ({
                  label: option.label,
                  ...(option.description === undefined ? {} : { description: option.description }),
                })),
              }),
          ...(first?.multiSelect === true || first?.multi_select === true ? { multiSelect: true } : {}),
          ...(raw === undefined ? {} : { raw }),
        }
      })
  }
  return {
    listPendingApprovals: () => pending('approval'),
    listPendingQuestions: () => pending('question'),
    answerApproval: async input => {
      const bridge = await bridgeOf('交互应答不可用（缺 spellbook）')
      const result = bridge.answerApproval?.(input.sessionId, input.id, input.approved ? 'allowed-once' : 'rejected')
      if (result === undefined) throw new Error('spellbook 未提供 answerApproval')
      if (result !== 'answered') throw new Error(`审批应答失败：${result}`)
    },
    answerQuestion: async input => {
      const bridge = await bridgeOf('交互应答不可用（缺 spellbook）')
      // The answer envelope is keyed by **question id**, not by the pending-request id.
      // Re-read the pending record so a single free-text/selected value can be shaped
      // into spellbook's `{ answers: [{ id, selected, custom }] }`.
      const record = bridge.collectPendingInteractions?.(host, { maxArgsChars: 4000 })
        .find(item => item.id === input.id && item.kind === 'question')
      const questions = record?.questions ?? []
      if (questions.length === 0 || questions.some(question => question.id === undefined)) {
        throw new Error('提问已失效：找不到对应的问题 id')
      }
      const answers = questions.map(question => {
        const id = question.id ?? ''
        const picked = new Set(input.selected ?? [])
        const selected = (question.options ?? [])
          .map(option => option.label)
          .filter(label => picked.has(label) || (picked.size === 0 && label === input.answer))
        const custom = input.answer.trim()
        return {
          id,
          selected,
          ...(custom === '' || selected.includes(custom) ? {} : { custom }),
        }
      })
      const result = bridge.answerQuestion?.(input.sessionId, input.id, { answers })
      if (result === undefined) throw new Error('spellbook 未提供 answerQuestion')
      if (result !== 'answered') throw new Error(`提问应答失败：${result}`)
    },
    answerQuestionFull: async input => {
      const bridge = await bridgeOf('交互应答不可用（缺 spellbook）')
      const answers = input.answers.map(item => ({
        id: item.questionId,
        selected: [...(item.selected ?? [])],
        ...(item.custom === undefined || item.custom === '' ? {} : { custom: item.custom }),
      }))
      const result = bridge.answerQuestion?.(input.sessionId, input.id, { answers })
      if (result === undefined) throw new Error('spellbook 未提供 answerQuestion')
      if (result !== 'answered') throw new Error(`提问应答失败：${result}`)
    },
    cancelQuestion: async input => {
      const bridge = await bridgeOf('交互应答不可用（缺 spellbook）')
      const result = bridge.cancelQuestion?.(input.sessionId, input.id)
      if (result === undefined) throw new Error('spellbook 未提供 cancelQuestion')
      if (result !== 'cancelled') throw new Error(`取消失败：${result}`)
    },
  }
}

interface TeamworkFacade {
  teamworkBaseUrl?: () => { ok: boolean; reason?: string }
  ensureLocalService?: (options: Record<string, unknown>) => Promise<{
    ok: boolean
    data?: { action: string; baseUrl: string; port: number; waitedMs: number }
    reason?: string
  }>
}

/**
 * Start the local shared-library service only for loopback domains. Missing packages or
 * start failures log a line and never affect the ledgers.
 */
function teamworkConfigPath(): string {
  return join(
    process.env.DSH_TEAMWORK_DATA ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'teamwork'),
    'config.json',
  )
}

/** Reject unsafe bind addresses before any SDK/probe/spawn work. */
function unsafeConfiguredDomain(configPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    const domain = typeof parsed['domain'] === 'string' ? parsed['domain'].trim() : ''
    const legacyHost = typeof parsed['host'] === 'string' ? parsed['host'].trim() : ''
    const raw = domain !== '' ? domain : legacyHost
    if (raw === '') return undefined
    const authority = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0] ?? ''
    const host = authority.startsWith('[')
      ? authority.slice(0, authority.indexOf(']') + 1)
      : authority.replace(/:\d+$/, '')
    if (['0.0.0.0', '::', '[::]'].includes(host.toLowerCase())) {
      return `config.json 的 domain 不能是 ${host}：禁止使用不安全的本地 host；请写 127.0.0.1:端口，或线上域名（不带端口）`
    }
    return undefined
  } catch {
    // Missing or malformed files are handled by the SDK (which has the full parser).
    return undefined
  }
}

async function ensureDataPlane(): Promise<{ reason: string; configPath?: string } | undefined> {
  if (process.env.DSH_TEAMWORK_AUTOSTART === '0') return undefined
  const configPath = teamworkConfigPath()
  const unsafe = unsafeConfiguredDomain(configPath)
  if (unsafe !== undefined) {
    note('warn', 'data-plane-invalid-domain', unsafe)
    return { reason: unsafe, configPath }
  }
  try {
    const module = (await import('@meiyukichan/dsh-magica-teamwork')) as unknown as TeamworkFacade
    // Resolve the address before touching the service: invalid/unsafe domains
    // (`0.0.0.0`, malformed values) must be an explicit refusal, not a 15s timeout.
    const resolved = module.teamworkBaseUrl?.()
    if (resolved !== undefined && !resolved.ok) {
      const reason = resolved.reason ?? 'domain 配置不合法'
      note('warn', 'data-plane-invalid-domain', reason)
      return { reason, configPath }
    }
    if (module.ensureLocalService === undefined) {
      return { reason: '共享库不支持 ensureLocalService（请更新 @meiyukichan/dsh-magica-teamwork）' }
    }
    // teamwork resolves its own base URL and data directory. The host only asks it
    // to autostart and keeps the spawn error from escaping.
    const outcome = await module.ensureLocalService({
      autostart: true,
      // No dataDir override: teamwork owns its default storage layout
      // (`~/.dsh/storages/teamwork/server`).
      // Catch spawn errors locally: an unhandled `error` event would crash dsh.
      spawnImpl: (bin: string, args: readonly string[]) => {
        const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true })
        child.on('error', error => {
          note('warn', 'data-plane-spawn-failed', errorText(error))
        })
        child.unref()
        return child.pid
      },
      log: (level: 'info' | 'warn', event: string, detail?: unknown) => noteAny(level, event, detail),
    })
    if (outcome.ok) {
      note('info', 'data-plane-ready', outcome.data?.action ?? 'ok')
      return undefined
    }
    note('warn', 'data-plane-unavailable', outcome.reason)
    return { reason: outcome.reason ?? '本地服务不可用', configPath }
  } catch (error) {
    const reason = errorText(error)
    note('warn', 'data-plane-skipped', reason)
    return { reason, configPath }
  }
}

/**
 * Register the route shell synchronously, then build the runtime asynchronously. Routes
 * must exist during composition, but their table is a getter that waits for the runtime.
 */
export function apply(ctx: ClientLike, config: PluginConfig = {}): void {
  let runtime: CastboardRuntime | undefined
  let workspaceRegistry: WorkspaceRegistryLike | undefined
  const routeDisposers: (() => void)[] = []

  try {
    ctx.inject(['workspaceRegistry'], scope => {
      workspaceRegistry = scope.workspaceRegistry
      scope.effect(() => () => { workspaceRegistry = undefined }, 'dsh-magica-castboard: workspace registry')
    })
  } catch (error) {
    note('warn', 'workspace-registry-wait-failed', errorText(error))
  }

  const ready = (async (): Promise<CastboardRuntime> => {
    if (runtime !== undefined) return runtime
    // Probe/start the shared library before SDK faces: the faces resolve their base URL
    // once, so a later autostart would leave them pointing at a dead service.
    const dataPlaneIssue = await ensureDataPlane()
    const sessions = await createSpellbookSessions({
      ctx,
      resolveWorkspacePath: id => workspaceRegistry?.get?.(id)?.path,
    })
    let faces: SdkFaces | undefined
    try {
      faces = await createSdkFaces({ instance: process.env.DSH_TEAMWORK_INSTANCE ?? '127.0.0.1:3080' })
      if (faces.missing.length > 0) note('warn', 'sdk-faces-missing', faces.missing.join(', '))
    } catch (error) {
      note('warn', 'sdk-faces-failed', errorText(error))
    }
    const connectionIssue = faces?.connectionIssue
    const effectiveDataPlaneIssue = dataPlaneIssue ?? (connectionIssue === undefined
      ? undefined
      : { reason: connectionIssue, configPath: teamworkConfigPath() })
    runtime = await createRuntime({
      ...(config.root === undefined ? {} : { root: config.root }),
      ctx,
      ...(sessions === undefined ? {} : { sessions }),
      ...(faces === undefined ? {} : { faces }),
      ...(faces?.mineInstance === undefined ? {} : { deviceInstance: faces.mineInstance }),
      ...(effectiveDataPlaneIssue === undefined ? {} : { dataPlaneIssue: effectiveDataPlaneIssue }),
      model: resolveDefaultModel(ctx),
      routerModel: resolveDefaultModel(ctx, 'DSH_CASTBOARD_ROUTER_MODEL')
        ?? resolveDefaultModel(ctx, 'DSH_CASTBOARD_ROUTER_MODEL'),
      portraitModel: resolveDefaultModel(ctx, 'DSH_CASTBOARD_PORTRAIT_MODEL')
        ?? resolveDefaultModel(ctx, 'DSH_CASTBOARD_PORTRAIT_MODEL'),
      workspaces: lazyWorkspaceFace(() => workspaceRegistry),
      workspaceResolver: async cwd => {
        const spellbook = await import('@meiyukichan/dsh-magica-spellbook')
        const workspace = await spellbook.ensureWorkspace?.(ctx, cwd)
        return workspace?.id
      },
      workspacePathOf: id => workspaceRegistry?.get?.(id)?.path,
      archiveSession: async sessionId => {
        if (workspaceRegistry?.archiveSession === undefined) throw new Error('宿主不支持会话归档')
        await workspaceRegistry.archiveSession(sessionId)
      },
      listWorkspaces: () => (workspaceRegistry?.list?.() ?? []).map(workspace => ({
        id: String(workspace.id),
        path: workspace.path,
        title: workspace.title,
      })),
    })
    runtime.startOwnerServices()
    return runtime
  })()

  installTools(ctx, async () => toolDepsFor(await ready))

  // Tear down routes before the runtime; the runtime releases services and the lease.
  ctx.effect(() => {
    void ready.catch(() => undefined)
    return () => {
      for (const dispose of routeDisposers.splice(0)) {
        try {
          dispose()
        } catch (error) {
          noteAny('warn', 'route-dispose-failed', error)
        }
      }
      void ready
        .then(current => current.dispose())
        .catch(() => undefined)
    }
  }, 'dsh-magica-castboard: lifecycle')

  installPromptSection(ctx)

  ctx.inject(['webServer'], scope => {
    const webServer = scope.webServer
    if (webServer === undefined) return
    try {
      const dispose = webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: createRouter({
          routes: () => runtime?.routes ?? [],
          stripPrefix: ROUTE_PREFIX,
          awaitReady: async () => { await ready },
          isWritable: () => runtime?.lease.isOwner() ?? false,
          ownerHint: () => 'another dsh web owns the storage lease',
          onRead: async () => {
            if (runtime === undefined) return
            await runtime.reload()
          },
        }),
      })
      routeDisposers.push(dispose)
    } catch (error) {
      note('warn', 'route-register-failed', errorText(error))
    }
  })
}
