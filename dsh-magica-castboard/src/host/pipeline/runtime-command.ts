/**
 * Runtime command: issue-as-RPC for `urgency: 'runtime'`.
 *
 * The issue carries a generic `assignerMeta.runtime` envelope; this module owns the
 * command-tool subset (bash/pwsh): the target resolves its own platform tool, validates
 * the arguments against the live DSH schema, executes through the shell executor, and
 * writes one system comment. The source/assigner platform is irrelevant.
 *
 * The shell adapter deliberately does not go through the model-facing tool: an
 * ownerless tool call cannot receive the issue's per-call cwd/permission policy, so
 * it would silently fall back to process defaults. `ctx.shell` is the same executor
 * the command tool wraps.
 *
 * @module dsh-magica-castboard/host/pipeline/runtime-command
 */
import { isAbsolute } from 'node:path'

import Ajv, { type ValidateFunction } from 'ajv'

import type { IssueMeta, PermissionMode } from '../model.ts'
import { isRuntimeTool, type RuntimeTool } from '../runtime-contract.ts'

export const RUNTIME_DEFAULT_TIMEOUT_MS = 120_000
export const RUNTIME_MAX_TIMEOUT_MS = 600_000
export const RUNTIME_MAX_COMMAND_CHARS = 10_000
export const RUNTIME_MAX_DESCRIPTION_CHARS = 200
export const RUNTIME_MAX_COMMENT_CHARS = 3_800
export const RUNTIME_STDOUT_BYTES = 64 * 1024

const PERMISSIONS: readonly PermissionMode[] = ['read-only', 'workspace-write', 'danger-full-access']
const ARGUMENT_KEYS = new Set(['command', 'description', 'workdir', 'timeoutMs'])

export interface RuntimeCommandSpec {
  readonly arguments: Record<string, unknown>
  /** Optional for future runtime tools; omitted = target's default command tool. */
  readonly requestedTool?: RuntimeTool
  readonly command: string
  readonly description: string
  readonly workdir: string
  readonly timeoutMs: number
  readonly permission: PermissionMode
}

export interface RuntimeCommandRequest extends RuntimeCommandSpec {
  /** Filled by the target worker from its own platform, never by the dispatcher. */
  readonly tool: RuntimeTool
}

export type RuntimeCommandParse =
  | { readonly ok: true; readonly request: RuntimeCommandSpec }
  | { readonly ok: false; readonly reason: string }

export interface RuntimeCommandResult {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly stdoutSpillPath?: string
  readonly stderrSpillPath?: string
  readonly sandboxMode?: string
  readonly sandboxDenied?: boolean
  readonly durationMs: number
}

export type RuntimeCommandExecutor = (
  request: RuntimeCommandRequest,
  signal?: AbortSignal,
) => Promise<RuntimeCommandResult>

/** Refused before execution (bad permission / no sandbox); never retried. */
export class RuntimeCommandRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeCommandRefusedError'
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export type ToolArgsValidator = (tool: string, args: Record<string, unknown>) => string | undefined

/**
 * Validate runtime arguments against the live DSH tool schema.
 *
 * The runtime must not invent a second schema: whatever the host registered for
 * `bash` is the contract. `schemaOf` comes from `ctx.tools.get(name)?.parameters`.
 * When the tool is only visible inside an agent scope, the registry's global view
 * returns nothing; `fallbackOf` supplies the runtime's conservative command schema.
 */
export function createToolArgsValidator(
  schemaOf: (tool: string) => Record<string, unknown> | undefined,
  fallbackOf?: (tool: string) => Record<string, unknown> | undefined,
): ToolArgsValidator {
  const ajv = new Ajv({ allErrors: true, strict: false })
  const cache = new WeakMap<object, ValidateFunction>()
  return (tool, args) => {
    const schema = schemaOf(tool) ?? fallbackOf?.(tool)
    if (schema === undefined) return `DSH tool schema is unavailable for "${tool}"`
    let validate = cache.get(schema)
    if (validate === undefined) {
      try {
        validate = ajv.compile(schema)
        cache.set(schema, validate)
      } catch (error) {
        return `invalid DSH tool schema for "${tool}": ${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (validate(args)) return undefined
    const errors = (validate.errors ?? []).map(error =>
      `${error.instancePath === '' ? '/' : error.instancePath} ${error.message ?? 'is invalid'}`)
    return `arguments do not satisfy the DSH "${tool}" tool schema: ${errors.join('; ')}`
  }
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Parse and validate the command-tool payload carried by a runtime issue.
 *
 * @param record - Issue fields needed for defaults (`cwd`, `permission`, `assignerMeta`).
 * @returns A normalized request, or a human-readable rejection.
 */
export function parseRuntimeCommand(record: {
  readonly cwd?: string
  readonly permission?: PermissionMode
  readonly assignerMeta?: IssueMeta
}): RuntimeCommandParse {
  const meta = plainObject(record.assignerMeta)
  const runtime = plainObject(meta?.runtime)
  if (runtime === undefined) return { ok: false, reason: 'missing assignerMeta.runtime' }
  const rawTool = nonEmpty(runtime.tool)
  if (rawTool !== undefined && !isRuntimeTool(rawTool)) {
    return { ok: false, reason: `unsupported runtime tool: ${rawTool}` }
  }
  const requestedTool = rawTool
  const args = plainObject(runtime.arguments)
  if (args === undefined) return { ok: false, reason: 'runtime.arguments must be an object' }
  for (const key of Object.keys(args)) {
    if (!ARGUMENT_KEYS.has(key)) return { ok: false, reason: `unsupported runtime argument: ${key}` }
  }

  const command = nonEmpty(args.command)
  if (command === undefined) return { ok: false, reason: 'runtime.arguments.command must be a non-empty string' }
  if (command.length > RUNTIME_MAX_COMMAND_CHARS) {
    return { ok: false, reason: `runtime.arguments.command exceeds ${String(RUNTIME_MAX_COMMAND_CHARS)} characters` }
  }

  const description = nonEmpty(args.description)
  if (description === undefined) {
    return { ok: false, reason: 'runtime.arguments.description is required by the target command tool schema' }
  }
  if (description.length > RUNTIME_MAX_DESCRIPTION_CHARS) {
    return { ok: false, reason: `runtime.arguments.description exceeds ${String(RUNTIME_MAX_DESCRIPTION_CHARS)} characters` }
  }

  const rawWorkdir = args.workdir ?? record.cwd
  const workdir = nonEmpty(rawWorkdir)
  if (workdir === undefined) return { ok: false, reason: 'missing workdir (issue.cwd is also empty)' }
  if (!isAbsolute(workdir)) return { ok: false, reason: `workdir must be an absolute path: ${workdir}` }

  const timeoutMs = args.timeoutMs === undefined ? RUNTIME_DEFAULT_TIMEOUT_MS : args.timeoutMs
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1_000 || timeoutMs > RUNTIME_MAX_TIMEOUT_MS) {
    return {
      ok: false,
      reason: `runtime.arguments.timeoutMs must be an integer between ${String(1_000)} and ${String(RUNTIME_MAX_TIMEOUT_MS)}`,
    }
  }

  const permission = record.permission
  if (permission === undefined) {
    return { ok: false, reason: 'missing permission (runtime issues must be explicit)' }
  }
  if (!PERMISSIONS.includes(permission)) {
    return { ok: false, reason: `unsupported permission: ${String(permission)}` }
  }

  return {
    ok: true,
    request: {
      arguments: args,
      ...(requestedTool === undefined ? {} : { requestedTool }),
      command,
      description,
      workdir,
      timeoutMs,
      permission,
    },
  }
}

export interface RuntimeShellRun {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly stdout: { readonly text: string; readonly truncated: boolean; readonly spillPath?: string }
  readonly stderr: { readonly text: string; readonly truncated: boolean; readonly spillPath?: string }
  readonly sandbox?: { readonly mode: string; readonly denied?: boolean }
}

export interface RuntimeShellExecution {
  result(): Promise<RuntimeShellRun>
}

/** Structural subset of `@deepseek-ai/dsh-shell`; keeps the host bundle dependency-free. */
export interface RuntimeShell {
  readonly sandboxMode?: string
  resolve(request: {
    command: string
    workdir: string
    timeoutMs: number
    onExpiry: 'kill'
    stdoutMaxBytes: number
    sandboxPolicy: { mode: PermissionMode; workspaceRoot: string }
    signal?: AbortSignal
  }): unknown
  execute(spec: unknown): Promise<RuntimeShellExecution>
}

const PERMISSION_RANK: Readonly<Record<PermissionMode, number>> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
}

/**
 * Adapt DSH's shell executor with the issue's permission and cwd.
 *
 * Confined modes fail closed when this host's executor does not advertise a sandbox;
 * running a read-only / workspace-write request unconfined is never an acceptable
 * fallback. A request wider than the executor's advertised sandbox capability is
 * refused before spawning anything.
 */
export function createShellRuntimeExecutor(shell: RuntimeShell): RuntimeCommandExecutor {
  return async (request, signal) => {
    if (request.permission !== 'danger-full-access' && shell.sandboxMode === undefined) {
      throw new RuntimeCommandRefusedError(
        `this instance's shell has no sandbox; refusing ${request.permission} runtime command. `
        + 'Install a sandbox backend or explicitly use danger-full-access',
      )
    }
    const maximum = shell.sandboxMode as PermissionMode | undefined
    if (maximum !== undefined && PERMISSION_RANK[request.permission] > (PERMISSION_RANK[maximum] ?? -1)) {
      throw new RuntimeCommandRefusedError(
        `permission ${request.permission} exceeds the instance sandbox maximum ${maximum}; refusing to execute`,
      )
    }
    const spec = shell.resolve({
      command: request.command,
      workdir: request.workdir,
      timeoutMs: request.timeoutMs,
      onExpiry: 'kill',
      stdoutMaxBytes: RUNTIME_STDOUT_BYTES,
      sandboxPolicy: {
        mode: request.permission,
        workspaceRoot: request.workdir,
      },
      ...(signal === undefined ? {} : { signal }),
    })
    const startedAt = Date.now()
    const execution = await shell.execute(spec)
    const result = await execution.result()
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      aborted: result.aborted,
      stdout: result.stdout.text,
      stderr: result.stderr.text,
      stdoutTruncated: result.stdout.truncated,
      stderrTruncated: result.stderr.truncated,
      ...(result.stdout.spillPath === undefined ? {} : { stdoutSpillPath: result.stdout.spillPath }),
      ...(result.stderr.spillPath === undefined ? {} : { stderrSpillPath: result.stderr.spillPath }),
      ...(result.sandbox === undefined && shell.sandboxMode === undefined
        ? {}
        : { sandboxMode: result.sandbox?.mode ?? shell.sandboxMode }),
      ...(result.sandbox?.denied === true ? { sandboxDenied: true } : {}),
      durationMs: Date.now() - startedAt,
    }
  }
}

function section(text: string): string {
  const trimmed = text.replace(/\r\n/g, '\n')
  return trimmed === '' ? '(empty)' : trimmed
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated)`
}

/** Human-readable result for the issue comment; kept under the comment body limit. */
export function runtimeCommandComment(request: RuntimeCommandRequest, result: RuntimeCommandResult): string {
  const outcome = result.sandboxDenied === true
    ? 'sandbox-denied'
    : result.aborted
      ? 'aborted'
      : result.timedOut
        ? 'timeout'
        : result.exitCode === 0
          ? 'success'
          : 'failed'
  const header = [
    `runtime ${request.tool}`,
    `$ ${request.command}`,
    `outcome: ${outcome}`,
    `exit code: ${result.exitCode === null ? 'null' : String(result.exitCode)}`
      + (result.signal === null ? '' : ` · signal: ${result.signal}`),
    `duration: ${String(result.durationMs)} ms`,
    `cwd: ${request.workdir}`,
    `permission: ${request.permission}`,
    ...(result.sandboxMode === undefined ? [] : [`sandbox: ${result.sandboxMode}`]),
  ].join('\n')

  const tail = [
    '',
    '[stdout]',
    section(result.stdout),
    '',
    '[stderr]',
    section(result.stderr),
  ].join('\n')
  const notes: string[] = []
  if (result.stdoutTruncated) {
    notes.push(result.stdoutSpillPath === undefined
      ? '[stdout truncated]'
      : `[stdout truncated; full output: ${result.stdoutSpillPath}]`)
  }
  if (result.stderrTruncated) {
    notes.push(result.stderrSpillPath === undefined
      ? '[stderr truncated]'
      : `[stderr truncated; full output: ${result.stderrSpillPath}]`)
  }
  const suffix = notes.length === 0 ? '' : `\n${notes.join('\n')}`
  const available = RUNTIME_MAX_COMMENT_CHARS - header.length - suffix.length - tail.length - 2
  if (available <= 0) return clip(header + suffix, RUNTIME_MAX_COMMENT_CHARS)
  const body = header + '\n' + clip(tail, available) + suffix
  return body.length <= RUNTIME_MAX_COMMENT_CHARS ? body : clip(body, RUNTIME_MAX_COMMENT_CHARS)
}

/** Compact result persisted in `assigneeMeta.runtime`. */
export function runtimeCommandMeta(request: RuntimeCommandRequest, result: RuntimeCommandResult): Record<string, unknown> {
  return {
    tool: request.tool,
    command: request.command,
    description: request.description,
    cwd: request.workdir,
    permission: request.permission,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    durationMs: result.durationMs,
    ...(result.sandboxMode === undefined ? {} : { sandboxMode: result.sandboxMode }),
    ...(result.sandboxDenied === true ? { sandboxDenied: true } : {}),
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  }
}
