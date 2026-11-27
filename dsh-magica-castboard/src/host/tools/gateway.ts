/**
 * Four capability gateways over the domain tool handlers.
 *
 * Domain definitions stay as the implementation layer. Gateways reuse their
 * execute/render functions, strip the gateway-only `capability` key, and adapt
 * the outputs that moved (comments out of task/issue reads).
 *
 * @module dsh-magica-castboard/host/tools/gateway
 */
import type { ToolDefinition as HostToolDefinition } from '@deepseek-ai/dsh-tools'

import type { ToolDefinition as HandlerDefinition } from './shared.ts'
import {
  CASTBOARD_COMMENT_DESCRIPTION,
  CASTBOARD_COMMENT_SCHEMA,
  CASTBOARD_ISSUE_DESCRIPTION,
  CASTBOARD_ISSUE_SCHEMA,
  CASTBOARD_TASK_DESCRIPTION,
  CASTBOARD_TASK_SCHEMA,
  CASTBOARD_TEAMWORK_DESCRIPTION,
  CASTBOARD_TEAMWORK_SCHEMA,
} from './gateway-schema.ts'

type Args = Record<string, unknown>

interface GatewayCapability {
  readonly capability: string
  readonly handler: string
  readonly rename?: Readonly<Record<string, string>>
  readonly stripComments?: boolean
}

interface GatewaySpec {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly capabilities: readonly GatewayCapability[]
}

const TASK_CAPABILITIES: readonly GatewayCapability[] = [
  { capability: 'list', handler: 'castboard_list' },
  { capability: 'get', handler: 'castboard_get', rename: { taskId: 'id' } },
  { capability: 'move', handler: 'castboard_move', rename: { taskId: 'id' } },
  { capability: 'report', handler: 'castboard_execution_report' },
  { capability: 'checklist', handler: 'castboard_checklist', rename: { taskId: 'id' } },
]

const ISSUE_CAPABILITIES: readonly GatewayCapability[] = [
  { capability: 'help', handler: 'castboard_issues_help' },
  { capability: 'create', handler: 'castboard_issues_create' },
  { capability: 'state', handler: 'castboard_issue_state', stripComments: true },
  { capability: 'links', handler: 'castboard_issue_links' },
  { capability: 'convert', handler: 'castboard_issue_task' },
]

const TEAMWORK_CAPABILITIES: readonly GatewayCapability[] = [
  { capability: 'groups', handler: 'castboard_issue_groups' },
  { capability: 'group_members', handler: 'castboard_issue_group_members' },
  { capability: 'devices', handler: 'castboard_issue_devices' },
  { capability: 'workspaces', handler: 'castboard_issue_workspaces' },
]

const COMMENT_CAPABILITIES: readonly GatewayCapability[] = [
  { capability: 'get', handler: 'castboard_issue_state' },
  { capability: 'add', handler: 'castboard_issue_comment_add' },
]

const GATEWAYS: readonly GatewaySpec[] = [
  {
    name: 'castboard_task',
    description: CASTBOARD_TASK_DESCRIPTION,
    parameters: CASTBOARD_TASK_SCHEMA,
    capabilities: TASK_CAPABILITIES,
  },
  {
    name: 'castboard_issue',
    description: CASTBOARD_ISSUE_DESCRIPTION,
    parameters: CASTBOARD_ISSUE_SCHEMA,
    capabilities: ISSUE_CAPABILITIES,
  },
  {
    name: 'castboard_teamwork',
    description: CASTBOARD_TEAMWORK_DESCRIPTION,
    parameters: CASTBOARD_TEAMWORK_SCHEMA,
    capabilities: TEAMWORK_CAPABILITIES,
  },
  {
    name: 'castboard_comment',
    description: CASTBOARD_COMMENT_DESCRIPTION,
    parameters: CASTBOARD_COMMENT_SCHEMA,
    capabilities: COMMENT_CAPABILITIES,
  },
]

function argsOf(raw: unknown): Args {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('arguments must be an object')
  }
  return raw as Args
}

function capabilityOf(args: Args): string {
  const value = args.capability
  if (typeof value !== 'string' || value === '') throw new Error('capability is required')
  return value
}

function handlerArgs(args: Args, rename: Readonly<Record<string, string>> | undefined): Args {
  const { capability: _capability, ...rest } = args
  if (rename === undefined) return rest
  const out: Args = {}
  for (const [key, value] of Object.entries(rest)) out[rename[key] ?? key] = value
  return out
}

function commentRead(value: unknown, limit: unknown): unknown {
  const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const all = Array.isArray(record.comments) ? record.comments : []
  const max = typeof limit === 'number' && Number.isFinite(limit)
    ? Math.max(1, Math.min(200, Math.floor(limit)))
    : 50
  return { comments: all.slice(-max), attachments: record.attachments ?? [] }
}

function stripComments(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const record = { ...(value as Record<string, unknown>) }
  delete record.comments
  return record
}

function genericRender(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Build the four registered gateways from the domain tool definitions.
 *
 * @param handlers - Complete domain tool set; it is not exposed as-is.
 * @returns Four raw DSH tool definitions.
 */
export function buildGatewayTools(handlers: readonly HandlerDefinition[]): readonly HostToolDefinition[] {
  const byName = new Map(handlers.map(item => [item.name, item]))

  return GATEWAYS.map((gateway): HostToolDefinition => {
    const selected = new Map(gateway.capabilities.map(item => [item.capability, item]))

    return {
      name: gateway.name,
      description: gateway.description,
      parameters: gateway.parameters as never,
      output: {
        schema: {} as never,
        render: (rawArgs, value) => {
          const args = rawArgs as Args
          const capability = selected.get(capabilityOf(args))
          if (capability === undefined) return genericRender(value)
          if (gateway.name === 'castboard_comment' && capability.capability === 'get') return genericRender(value)
          const target = byName.get(capability.handler)
          if (target === undefined) return genericRender(value)
          const render = target.output.render as unknown as (args: unknown, value: unknown) => unknown
          return render(args, value) as never
        },
      },
      async execute(rawArgs, exec) {
        const args = argsOf(rawArgs)
        const capability = selected.get(capabilityOf(args))
        if (capability === undefined) throw new Error(`unsupported capability: ${capabilityOf(args)}`)
        if (gateway.name === 'castboard_comment' && capability.capability === 'get') {
          const target = byName.get(capability.handler)
          if (target === undefined) throw new Error('comment state handler is unavailable')
          const state = await target.execute({ issueId: args.issueId }, exec)
          return commentRead(state, args.limit) as never
        }
        const target = byName.get(capability.handler)
        if (target === undefined) throw new Error(`handler unavailable: ${capability.handler}`)
        const value = await target.execute(handlerArgs(args, capability.rename), exec)
        return (capability.stripComments === true ? stripComments(value) : value) as never
      },
    } as HostToolDefinition
  })
}
