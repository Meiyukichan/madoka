/**
 * Runtime command worker: claims `urgency: 'runtime'` issues for this instance and runs
 * exactly one platform command (pwsh on Windows, bash elsewhere) without creating a board task.
 *
 * Sync already performs the cloud CAS `pending -> accepted`; this worker owns the
 * local `accepted -> routing` claim and the final local/remote status. It is a
 * single-flight polling loop so malformed payloads and shell failures never block
 * the router or dispatcher.
 *
 * @module dsh-magica-castboard/host/pipeline/runtime-worker
 */
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'

import type { IssueStore } from '../ledger/issue-store.ts'
import type { IssueRecord, IssueSummary } from '../model.ts'
import {
  RuntimeCommandRefusedError,
  createShellRuntimeExecutor,
  parseRuntimeCommand,
  runtimeCommandComment,
  runtimeCommandMeta,
  type RuntimeCommandExecutor,
  type RuntimeCommandRequest,
  type RuntimeCommandResult,
  type RuntimeShell,
  type ToolArgsValidator,
} from './runtime-command.ts'
import { platformRuntimeTool, RUNTIME_RESULT_SYSTEM_KEY } from '../runtime-contract.ts'

export interface RuntimeWorkerThread {
  addSystem(
    anchorId: string,
    draft: { readonly id?: string; readonly body: string; readonly systemKey?: string; readonly createdAt?: number },
  ): Promise<unknown>
}

export interface RuntimeWorkerDeps {
  readonly issues: IssueStore
  readonly instance: () => string
  readonly thread: RuntimeWorkerThread
  readonly execute?: RuntimeCommandExecutor
  /** Validate arguments against the live DSH tool schema; absent = fail closed. */
  readonly validateToolArgs?: ToolArgsValidator
  /** Resolve cwd to an existing DSH workspace; runtime commands never register a new one. */
  readonly resolveWorkspace?: (cwd: string) => Promise<{ readonly id: string; readonly path: string } | undefined>
  /** Direct cloud comment publish; local-only issues simply 404 and are ignored. */
  readonly publish?: (input: {
    readonly issueId: string
    readonly commentId: string
    readonly body: string
    readonly role: 'assignee'
    readonly authorType: 'system'
    readonly createdAt: number
  }) => Promise<void>
  readonly finalize?: (
    issueId: string,
    input: { readonly status: 'success' | 'failed' | 'abandoned'; readonly assigneeMeta: Record<string, unknown> },
  ) => Promise<void>
  readonly enabled?: () => boolean
  readonly isOwner?: () => boolean
  readonly allowCrossAccount?: () => boolean
  readonly now?: () => number
  readonly intervalMs?: number
  readonly log?: (level: 'info' | 'warn', event: string, detail: string) => void
}

const DEFAULT_INTERVAL_MS = 3_000
const MAX_PER_TICK = 5
const MAX_CONCURRENT = 4
const REMOTE_ATTEMPTS = 2
const REMOTE_RETRY_MS = 200
const IN_FLIGHT: readonly string[] = ['routing', 'running']

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function runtimeMetaOf(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const runtime = meta?.runtime
  return typeof runtime === 'object' && runtime !== null && !Array.isArray(runtime)
    ? runtime as Record<string, unknown>
    : {}
}

function withRuntimeMeta(
  meta: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(meta ?? {}),
    runtime: { ...runtimeMetaOf(meta), ...patch },
  }
}

function insideWorkspace(workdir: string, workspaceRoot: string): boolean {
  const rel = relative(workspaceRoot, workdir)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export class RuntimeCommandWorker {
  private readonly deps: RuntimeWorkerDeps
  private timer: ReturnType<typeof setTimeout> | undefined
  private started = false
  private disposed = false
  private inFlight = false
  private readonly active = new Set<string>()
  private readonly running = new Set<Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()

  constructor(deps: RuntimeWorkerDeps) {
    this.deps = deps
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    void this.recover()
      .catch(error => this.log('warn', 'runtime-recover-failed', reasonOf(error)))
      .finally(() => { this.arm() })
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
  }

  /** One polling round; public for tests and the owner lifecycle. */
  async tick(): Promise<void> {
    if (this.disposed || this.inFlight) return
    if (this.deps.enabled !== undefined && !this.deps.enabled()) return
    if (this.deps.isOwner !== undefined && !this.deps.isOwner()) return
    if (this.deps.execute === undefined) return
    this.inFlight = true
    try {
      await this.drain()
    } finally {
      this.inFlight = false
    }
  }

  private async drain(): Promise<void> {
    const candidates = this.deps.issues.summaries()
      .filter(row => row.urgency === 'runtime' && (row.status === 'accepted' || row.status === 'pending'))
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, MAX_PER_TICK)
    for (const candidate of candidates) {
      if (this.disposed || this.active.size >= MAX_CONCURRENT) return
      this.launch(candidate)
    }
  }

  /** Fire-and-forget: the polling loop never waits for a command to finish. */
  private launch(summary: IssueSummary): void {
    if (this.active.has(summary.id) || this.active.size >= MAX_CONCURRENT) return
    this.active.add(summary.id)
    const controller = new AbortController()
    this.controllers.set(summary.id, controller)
    const task = this.runOne(summary, controller.signal)
      .catch(async error => {
        this.log('warn', 'runtime-task-failed', `${summary.id}: ${reasonOf(error)}`)
        await this.settleUnexpected(summary.id, error)
      })
      .finally(() => {
        this.active.delete(summary.id)
        this.running.delete(task)
        this.controllers.delete(summary.id)
      })
    this.running.add(task)
  }

  /** An unexpected throw must not leave a claimed runtime issue in routing forever. */
  private async settleUnexpected(id: string, error: unknown): Promise<void> {
    try {
      const record = await this.deps.issues.get(id)
      if (record === undefined || !IN_FLIGHT.includes(record.status)) return
      await this.finish(record, 'failed', [
        'runtime command',
        'outcome: internal error',
        '',
        reasonOf(error),
      ].join('\n'), { error: reasonOf(error) })
    } catch (settleError) {
      this.log('warn', 'runtime-settle-failed', `${id}: ${reasonOf(settleError)}`)
    }
  }

  /** Wait for all currently running commands (tests / orderly shutdown). */
  async settled(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running])
    }
  }

  private async runOne(summary: IssueSummary, signal: AbortSignal): Promise<void> {
    const record = await this.deps.issues.get(summary.id)
    if (record === undefined) return
    if (record.urgency !== 'runtime') return
    if (record.status !== 'accepted' && record.status !== 'pending') return
    const targetInstance = record.assigneeInstance?.trim() ?? ''
    if (targetInstance !== '' && targetInstance !== this.deps.instance()) return

    const assigner = record.assigner ?? ''
    const assignee = record.assignee ?? ''
    const sameAccount = assigner !== '' && assigner === assignee
    const crossAccount = !sameAccount

    const claimed = await this.deps.issues.update(record.id, draft => {
      if (draft.status !== 'accepted' && draft.status !== 'pending') return false
      draft.status = 'routing'
      draft.routeError = undefined
      return true
    })
    if (claimed === undefined) return
    if (targetInstance === '') {
      await this.abandon(claimed, 'runtime command requires assigneeInstance to select a target instance')
      return
    }
    if (crossAccount && this.deps.allowCrossAccount?.() !== true) {
      await this.abandon(claimed, 'runtime command only runs on the same account\'s own instance by default; '
        + 'set DSH_CASTBOARD_RUNTIME_ALLOW_CROSS_ACCOUNT=1 to allow cross-account execution')
      return
    }

    const parsed = parseRuntimeCommand(claimed)
    if (!parsed.ok) {
      await this.finish(claimed, 'abandoned', `runtime command\ninvalid payload\n\n${parsed.reason}`, {
        error: parsed.reason,
      })
      return
    }
    const platformTool = platformRuntimeTool()
    const requestedTool = parsed.request.requestedTool
    if (requestedTool !== undefined && requestedTool !== platformTool) {
      await this.abandon(claimed,
        `target platform uses "${platformTool}", not requested "${requestedTool}"`)
      return
    }
    const tool = requestedTool ?? platformTool
    const request: RuntimeCommandRequest = { ...parsed.request, tool }
    if (this.deps.validateToolArgs === undefined) {
      await this.finish(claimed, 'abandoned',
        `runtime ${tool}\ntool schema validation unavailable on this host`, {
          tool,
          error: 'DSH tool schema validator unavailable',
        })
      return
    }
    const schemaError = this.deps.validateToolArgs(tool, request.arguments)
    if (schemaError !== undefined) {
      await this.finish(claimed, 'abandoned', `runtime ${tool}\ninvalid payload\n\n${schemaError}`, {
        tool,
        error: schemaError,
      })
      return
    }

    if (this.deps.resolveWorkspace === undefined) {
      await this.finish(claimed, 'abandoned',
        `runtime ${tool}\ncwd validation unavailable: the host has no workspace registry`, {
          tool,
          error: 'workspace resolver unavailable',
        })
      return
    }
    let workspace: { readonly id: string; readonly path: string } | undefined
    try {
      workspace = await this.deps.resolveWorkspace(request.workdir)
    } catch (error) {
      await this.finish(claimed, 'failed', this.executionErrorComment(request, error), {
        tool,
        error: reasonOf(error),
      })
      return
    }
    if (workspace === undefined) {
      await this.finish(claimed, 'abandoned',
        `runtime ${tool}\ncwd is not a registered workspace: ${request.workdir}`, {
          tool,
          error: 'cwd is not a registered workspace',
        })
      return
    }
    if (!insideWorkspace(request.workdir, workspace.path)) {
      await this.finish(claimed, 'abandoned',
        `runtime ${tool}\ncwd is outside the resolved workspace: ${request.workdir} (workspace: ${workspace.path})`, {
          tool,
          error: 'cwd escapes the resolved workspace',
        })
      return
    }

    let result: RuntimeCommandResult
    try {
      result = await this.deps.execute!(request, signal)
    } catch (error) {
      if (error instanceof RuntimeCommandRefusedError) {
        await this.finish(claimed, 'abandoned', `runtime ${tool}\nrefused\n\n${reasonOf(error)}`, {
          tool,
          error: reasonOf(error),
        })
        return
      }
      await this.finish(claimed, 'failed', this.executionErrorComment(request, error),
        this.failureMeta(request, error))
      return
    }

    const status = result.exitCode === 0 && !result.timedOut && !result.aborted && result.sandboxDenied !== true
      ? 'success'
      : 'failed'
    await this.finish(claimed, status, runtimeCommandComment(request, result), runtimeCommandMeta(request, result))
  }

  private executionErrorComment(request: RuntimeCommandRequest, error: unknown): string {
    return [
      `runtime ${request.tool}`,
      `$ ${request.command}`,
      'outcome: executor error',
      `cwd: ${request.workdir}`,
      `permission: ${request.permission}`,
      '',
      reasonOf(error),
    ].join('\n')
  }

  private failureMeta(request: RuntimeCommandRequest, error: unknown): Record<string, unknown> {
    return {
      tool: request.tool,
      command: request.command,
      cwd: request.workdir,
      permission: request.permission,
      error: reasonOf(error),
    }
  }

  private async abandon(record: IssueRecord, reason: string, tool?: string): Promise<void> {
    await this.finish(record, 'abandoned', `runtime ${tool ?? 'command'}\nabandoned\n\n${reason}`, {
      ...(tool === undefined ? {} : { tool }),
      error: reason,
    })
  }

  /**
   * Best-effort remote call with one bounded retry.
   *
   * The local result is already settled at this point; a remote failure must not
   * undo it, but a transient network error should not lose the result either.
   */
  private async retryRemote(event: string, detail: string, action: () => Promise<void>): Promise<void> {
    let last: unknown
    for (let attempt = 1; attempt <= REMOTE_ATTEMPTS; attempt += 1) {
      try {
        await action()
        return
      } catch (error) {
        last = error
        if (attempt < REMOTE_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, REMOTE_RETRY_MS))
        }
      }
    }
    this.log('warn', event, `${detail}: ${reasonOf(last)}`)
  }

  private async finish(
    record: IssueRecord,
    status: 'success' | 'failed' | 'abandoned',
    body: string,
    runtimeMeta: Record<string, unknown>,
  ): Promise<void> {
    // Settle the local claim first. If another owner already moved the issue
    // (router recovery, duplicate worker, manual edit), do not publish a second
    // result comment: the execution is no longer ours to report.
    const updated = await this.deps.issues.update(record.id, draft => {
      if (draft.status !== 'routing' && draft.status !== 'running') return false
      draft.status = status
      draft.assigneeMeta = withRuntimeMeta(draft.assigneeMeta, runtimeMeta)
      draft.routeError = status === 'success' ? undefined : (runtimeMeta.error as string | undefined)
      return true
    }, status === 'abandoned' ? 'issue-abandoned' : 'issue-updated')
    if (updated === undefined) {
      this.log('warn', 'runtime-finalize-local-missed', `${record.id}: status is no longer in flight`)
      return
    }

    const createdAt = this.deps.now?.() ?? Date.now()
    const commentId = randomUUID()
    try {
      await this.deps.thread.addSystem(record.id, {
        id: commentId,
        body,
        systemKey: RUNTIME_RESULT_SYSTEM_KEY,
        createdAt,
      })
    } catch (error) {
      this.log('warn', 'runtime-comment-failed', `${record.id}: ${reasonOf(error)}`)
    }
    const publish = this.deps.publish
    if (publish !== undefined) {
      await this.retryRemote(
        'runtime-comment-publish-failed',
        record.id,
        () => publish({
          issueId: record.id,
          commentId,
          body,
          role: 'assignee',
          authorType: 'system',
          createdAt,
        }),
      )
    }

    const finalize = this.deps.finalize
    if (finalize !== undefined) {
      await this.retryRemote(
        'runtime-finalize-remote-failed',
        record.id,
        () => finalize(record.id, {
          status,
          assigneeMeta: updated.assigneeMeta ?? withRuntimeMeta(record.assigneeMeta, runtimeMeta),
        }),
      )
    }
    this.log('info', 'runtime-finished', `${record.id} → ${status}`)
  }

  private async recover(): Promise<void> {
    if (this.deps.execute === undefined) return
    const stale = this.deps.issues.summaries()
      .filter(row => row.urgency === 'runtime' && IN_FLIGHT.includes(row.status))
    for (const row of stale) {
      const record = await this.deps.issues.get(row.id)
      if (record === undefined || !IN_FLIGHT.includes(record.status)) continue
      await this.finish(record, 'failed', [
        'runtime command',
        'outcome: interrupted',
        '',
        'The previous runtime execution was interrupted before settlement; the command may have side effects, '
        + 'so it is not retried automatically.',
      ].join('\n'), {
        error: 'runtime interrupted before settlement; not retried',
      })
    }
  }

  private arm(): void {
    if (this.disposed) return
    this.clearTimer()
    const handle = setTimeout(() => {
      this.timer = undefined
      void this.tick()
        .catch(error => this.log('warn', 'runtime-tick-failed', reasonOf(error)))
        .finally(() => { this.arm() })
    }, this.deps.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.timer = handle
    if (typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as { unref: () => void }).unref()
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private log(level: 'info' | 'warn', event: string, detail: string): void {
    this.deps.log?.(level, event, detail)
  }
}

/** Production adapter: DSH `ctx.shell` -> RuntimeCommandExecutor. */
export function shellExecutor(shell: RuntimeShell | undefined): RuntimeCommandExecutor | undefined {
  return shell === undefined ? undefined : createShellRuntimeExecutor(shell)
}
