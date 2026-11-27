/**
 * Shared runtime-issue contract: platform mapping, schema text, and policy.
 *
 * The model sees the same schema through castboard_issues_help and through a
 * failed runtime creation. Keep it schema-only — no concrete command examples.
 *
 * @module dsh-magica-castboard/host/runtime-contract
 */

/** Runtime tools this build implements. Windows uses pwsh; Linux/macOS uses bash. */
export const RUNTIME_TOOL_NAMES = ['bash', 'pwsh'] as const
export type RuntimeTool = (typeof RUNTIME_TOOL_NAMES)[number]

export function isRuntimeTool(value: string | undefined): value is RuntimeTool {
  return value !== undefined && (RUNTIME_TOOL_NAMES as readonly string[]).includes(value)
}

/** The only command tool a target host is expected to expose. */
export function platformRuntimeTool(platform: NodeJS.Platform = process.platform): RuntimeTool {
  return platform === 'win32' ? 'pwsh' : 'bash'
}

/** Map the shared library's device.os value to a target runtime tool. */
export function runtimeToolForOs(os: string | undefined): RuntimeTool | undefined {
  switch (os?.trim().toLowerCase()) {
    case 'windows':
    case 'win32':
      return 'pwsh'
    case 'linux':
    case 'darwin':
    case 'macos':
    case 'mac':
      return 'bash'
    default:
      return undefined
  }
}

export const RUNTIME_POLICY =
  'Runtime is a user-triggered active channel: create a runtime issue only when the user '
  + 'explicitly asks to execute a command on a specific target instance. Never create one '
  + 'proactively for retries, health checks, sync, or convenience.'

/** Stable system-comment identity shared by the worker and the comment deliverer. */
export const RUNTIME_RESULT_SYSTEM_KEY = 'sys.runtimeCommand'

/** Worker result headers always start with this prefix; cloud comments lose systemKey. */
export const RUNTIME_COMMENT_PREFIX = 'runtime '

export const RUNTIME_ARGS_SCHEMA =
  'arguments: object (required; must match the selected runtime tool\'s DSH schema). '
  + 'For the default command tool: { command: string (required), description: string (required), '
  + 'workdir?: string (absolute path), timeoutMs?: integer (1000..600000) }'

/**
 * Conservative command-tool schema used when the host registry is scoped to agents
 * and has no global definition to sample. It mirrors the foreground subset both
 * `bash` and `pwsh` expose; the target still validates through this schema before spawn.
 */
export const RUNTIME_COMMAND_ARGUMENTS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['command', 'description'],
  properties: {
    command: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    workdir: { type: 'string' },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 600_000 },
  },
}

export const RUNTIME_DEFAULT_TOOL_NOTE =
  'Runtime executes one implemented tool on the target. Omit runtime.tool for the target platform\'s '
  + 'default command tool (pwsh on Windows, bash on Linux/macOS); other implemented runtime tools '
  + 'may be named explicitly.'

/** Per-tool help. Add an entry when a new runtime tool is implemented. */
export interface RuntimeToolSpec {
  readonly name: RuntimeTool
  readonly platform: string
  readonly description: string
  readonly argumentsSchema: string
}

export const RUNTIME_TOOL_CATALOG: readonly RuntimeToolSpec[] = [
  {
    name: 'pwsh',
    platform: 'windows',
    description: 'Default command tool on Windows targets. Foreground PowerShell; no background jobs.',
    argumentsSchema: RUNTIME_ARGS_SCHEMA,
  },
  {
    name: 'bash',
    platform: 'linux/macOS',
    description: 'Default command tool on Linux/macOS targets. Foreground shell; no background jobs.',
    argumentsSchema: RUNTIME_ARGS_SCHEMA,
  },
]

/** Schema-only contract; no sample values that a model could copy blindly. */
export function runtimeIssueSchema(): string {
  return `{
  "urgency": "runtime",
  "assigneeInstance": "string (target ip:port)",
  "cwd": "string (absolute path inside a registered workspace)",
  "permission": "read-only | workspace-write | danger-full-access",
  "assignerMeta": {
    "runtime": {
      "tool": "string (optional; omit for the target's default command tool)",
      "arguments": "object (required; must match the selected tool's DSH schema)"
    }
  }
}`
}

export function runtimeContractError(where: string, reason: string): string {
  return `${where}: runtime contract invalid: ${reason}\n\n`
    + `Required runtime issue schema:\n${runtimeIssueSchema()}\n\n`
    + `${RUNTIME_ARGS_SCHEMA}\n\n${RUNTIME_DEFAULT_TOOL_NOTE}\n\n${RUNTIME_POLICY}`
}
