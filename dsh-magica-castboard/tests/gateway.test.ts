import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import { buildGatewayTools } from '../src/host/tools/gateway.ts'
import type { ToolDefinition } from '../src/host/tools/shared.ts'
import { INTERACTION_SCHEMA, encodeInteraction } from '../src/shared/interaction-protocol.ts'

const LEGACY_NAMES = [
  'castboard_list',
  'castboard_get',
  'castboard_move',
  'castboard_execution_report',
  'castboard_checklist',
  'castboard_issues_help',
  'castboard_issues_create',
  'castboard_issue_state',
  'castboard_issue_links',
  'castboard_issue_task',
  'castboard_issue_groups',
  'castboard_issue_group_members',
  'castboard_issue_devices',
  'castboard_issue_workspaces',
  'castboard_issue_comment_add',
] as const

function legacyTools(calls: Array<{ name: string; args: Record<string, unknown> }>): ToolDefinition[] {
  return LEGACY_NAMES.map(name => ({
    name,
    description: name,
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      calls.push({ name, args })
      if (name === 'castboard_get') return { task: { id: args.id } }
      if (name === 'castboard_issue_state') {
        if (args.issueId === 'i-2') {
          return {
            issue: { id: args.issueId },
            comments: [{
              id: 'c-control',
              authorType: 'system',
              body: encodeInteraction({
                schema: INTERACTION_SCHEMA,
                event: 'requested',
                interactionId: 'i-1',
                issueId: 'i-2',
                sessionId: 's-1',
                kind: 'question',
                at: 1,
                instance: '127.0.0.1:3080',
                request: { questions: [{ id: 'q-1', question: '选哪个？' }] },
              }),
            }],
            attachments: [],
          }
        }
        return { issue: { id: args.issueId }, comments: [{ id: 'c-1' }, { id: 'c-2' }], attachments: [] }
      }
      return { ok: true, name, args }
    },
  }))
}

test('gateway：只暴露四个工具，schema 可被 DSH 接受', () => {
  const tools = buildGatewayTools(legacyTools([]))
  assert.deepEqual(tools.map(tool => tool.name), [
    'castboard_task',
    'castboard_issue',
    'castboard_teamwork',
    'castboard_comment',
  ])
  for (const tool of tools) {
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.parameters as never))
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema as never))
    const oneOf = (tool.parameters as { oneOf?: unknown[] }).oneOf
    assert.ok(Array.isArray(oneOf) && oneOf.length > 0)
  }
  const task = tools.find(tool => tool.name === 'castboard_task')
  assert.ok(task !== undefined)
  assert.deepEqual(validateJsonSchemaValue(task.parameters as never, { capability: 'get', taskId: 't-1' }, ''), [])
  assert.notDeepEqual(validateJsonSchemaValue(task.parameters as never, { capability: 'get' }, ''), [])
  const teamwork = tools.find(tool => tool.name === 'castboard_teamwork')
  assert.ok(teamwork !== undefined)
  assert.deepEqual(validateJsonSchemaValue(teamwork.parameters as never, {
    capability: 'workspaces',
    type: 'portal',
    instance: '127.0.0.1:3080',
    workspaceId: 'ws-1',
  }, ''), [])
  assert.notDeepEqual(validateJsonSchemaValue(teamwork.parameters as never, {
    capability: 'workspaces',
    type: 'portal',
    instance: '127.0.0.1:3080',
  }, ''), [])
})

test('gateway：task 参数改名并裁掉评论', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const tools = buildGatewayTools(legacyTools(calls))
  const task = tools.find(tool => tool.name === 'castboard_task')
  assert.ok(task !== undefined)
  const value = await task.execute({ capability: 'get', taskId: 't-1' }, {} as never) as Record<string, unknown>
  assert.equal(value.comments, undefined)
  assert.deepEqual(calls.at(-1), { name: 'castboard_get', args: { id: 't-1' } })
})

test('gateway：comment.get 走 issue state 并截断评论', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const tools = buildGatewayTools(legacyTools(calls))
  const comment = tools.find(tool => tool.name === 'castboard_comment')
  assert.ok(comment !== undefined)
  const value = await comment.execute({ capability: 'get', issueId: 'i-1', limit: 1 }, {} as never) as {
    comments: Array<{ id: string }>
  }
  assert.deepEqual(value.comments.map(item => item.id), ['c-2'])
  assert.deepEqual(calls.at(-1), { name: 'castboard_issue_state', args: { issueId: 'i-1' } })
})

test('gateway：comment.get 过滤合法控制评论，不把 raw JSON 交给模型', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const tools = buildGatewayTools(legacyTools(calls))
  const comment = tools.find(tool => tool.name === 'castboard_comment')
  assert.ok(comment !== undefined)
  const value = await comment.execute({ capability: 'get', issueId: 'i-2' }, {} as never) as {
    comments: Array<{ id: string }>
  }
  assert.deepEqual(value.comments, [])
})
