/**
 * Full capability schemas for the four castboard gateways.
 *
 * `defineTool` only accepts a flat property map, so the gateways register these
 * schemas through the raw ToolDefinition surface.
 *
 * @module dsh-magica-castboard/host/tools/gateway-schema
 */

type Schema = Record<string, unknown>

const string = (description: string): Schema => ({ type: 'string', description })
const boolean = (description: string): Schema => ({ type: 'boolean', description })
const integer = (description: string): Schema => ({ type: 'integer', description })
const stringArray = (description: string, itemDescription: string): Schema => ({
  type: 'array',
  description,
  items: string(itemDescription),
})
const capability = (name: string, description: string): Schema => ({ type: 'string', enum: [name], description })
const branch = (
  name: string,
  description: string,
  properties: Record<string, Schema>,
  required: readonly string[] = [],
): Schema => ({
  type: 'object',
  required: ['capability', ...required],
  additionalProperties: false,
  properties: { capability: capability(name, description), ...properties },
})
const tool = (branches: readonly Schema[]): Schema => ({ oneOf: [...branches] })

const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'canceled', 'archived', 'abandoned']
const URGENCIES = ['runtime', 'direct', 'urgent', 'normal', 'relaxed']
const PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access']

export const CASTBOARD_TASK_DESCRIPTION = [
  "Manage a castboard task's execution lifecycle.",
  '',
  'Capabilities:',
  '- list: list task summaries with optional project/status/urgency filters.',
  '- get: read one task, its checklist, execution history, and issueId.',
  '- move: move a task through its state machine; todo→in_progress claims it.',
  '- report: submit the execution report for the task bound to the current execution session.',
  '- checklist: add, replace, check, or uncheck acceptance checklist items.',
  '',
  'Tasks are created by issue conversion; this tool does not create or edit task metadata.',
].join('\n')

export const CASTBOARD_ISSUE_DESCRIPTION = [
  'Manage castboard issues.',
  '',
  'Capabilities:',
  '- help: inject the issue-creation guidance; call before create.',
  '- create: create 1..20 issues for other people / dsh instances.',
  '- state: read one issue record and its materialized attachments.',
  '- links: inspect the issue ↔ task ↔ session link and unread comment state.',
  '- convert: turn one accepted/routing issue into a task.',
].join('\n')

export const CASTBOARD_TEAMWORK_DESCRIPTION = [
  'Query castboard teamwork targets.',
  '',
  'Capabilities:',
  '- groups: list the projects/groups the current user belongs to.',
  '- group_members: list permission-filtered members of one project.',
  "- devices: list one account's online dsh devices.",
  '- workspaces: read project indexes or one workspace portrait.',
].join('\n')

export const CASTBOARD_COMMENT_DESCRIPTION = [
  'Issue-level discussion for castboard.',
  '',
  'Capabilities:',
  '- get: read recent comments on one issue.',
  '- add: add a comment to one issue and notify the opposite side. A session is never echoed its own comment.',
].join('\n')

export const CASTBOARD_TASK_SCHEMA = tool([
  branch('list', 'List task summaries.', {
    workspaceId: string('Filter by DSH workspace id.'),
    status: { type: 'string', enum: TASK_STATUSES, description: 'Filter by exact task status.' },
    urgency: { type: 'string', enum: URGENCIES, description: 'Filter by urgency.' },
    includeTrashed: boolean('Include soft-deleted cards. Default false.'),
  }),
  branch('get', 'Read one task with its checklist, execution history, and issueId.', {
    taskId: string('Task id from the board (t-…).'),
  }, ['taskId']),
  branch('move', 'Move a task through its state machine; todo→in_progress claims it.', {
    taskId: string('Task id.'),
    status: {
      type: 'string',
      enum: TASK_STATUSES,
      description: 'Target status. done and abandoned remain user-only actions.',
    },
    archiveSessions: boolean('When moving to archived, also archive associated execution sessions. Default false.'),
  }, ['taskId', 'status']),
  branch('report', 'Submit the execution report for the task bound to the current execution session.', {
    summary: string('What was done, 1..2000 characters.'),
    changedFiles: stringArray('Changed files, at most 50 entries.', 'Changed file path, absolute or relative to the task cwd.'),
    checks: stringArray('How the work was verified, at most 50 entries.', 'Verification command or check and its outcome.'),
    artifacts: stringArray(
      'Artifact file paths worth reviewing: build outputs, screenshots, generated documents. At most 30 entries.',
      'Artifact file path, absolute or relative to the task cwd.',
    ),
    risk: string('Known remaining risks or follow-ups, at most 2000 characters.'),
  }, ['summary']),
  branch('checklist', 'Add, replace, check, or uncheck acceptance checklist items.', {
    taskId: string('Task id.'),
    action: {
      type: 'string',
      enum: ['add', 'append', 'replace', 'check', 'uncheck'],
      description: 'Checklist operation.',
    },
    items: {
      type: 'array',
      description: 'Item texts or full item snapshots for add/append/replace. At most 30 items.',
      items: {
        oneOf: [
          string('Checklist item text.'),
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: string('Existing item id to keep.'),
              text: string('What must hold for this item.'),
              checked: boolean('Whether it is already checked.'),
              note: string('Evidence recorded with the check.'),
            },
          },
        ],
      },
    },
    itemId: string('Checklist item id for check/uncheck.'),
    note: string('Evidence note recorded with check, at most 400 characters.'),
  }, ['taskId', 'action']),
])

export const CASTBOARD_ISSUE_SCHEMA = tool([
  branch('help', 'Load the issue-creation guidance into the current session.', {}),
  branch('create', 'Create issues in the shared library. Call help first.', {
    issues: {
      type: 'array',
      description: 'Issues to create, 1..20 per call.',
      items: {
        type: 'object',
        required: ['projectId', 'title', 'detail', 'assignee', 'assigneeInstance'],
        additionalProperties: false,
        properties: {
          projectId: integer('Project id from teamwork.groups.'),
          title: string('Issue title, 1..200 characters.'),
          detail: string('Full requirement: what to do and the acceptance criteria.'),
          assignee: string('Responsible account; exactly one person per issue.'),
          assigneeInstance: string('Target instance ip:port from teamwork.devices.'),
          assignerMeta: {
            type: 'object',
            additionalProperties: true,
            properties: {
              acceptanceStrategies: {
                type: 'array',
                description: 'Full inline acceptance strategies; the host mints each id from type + title.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: string('Strategy title.'),
                    type: {
                      type: 'string',
                      enum: ['issue', 'close'],
                      description: 'issue = acceptance creates a new issue; close = acceptance closes the task.',
                    },
                    description: string('Decision criteria.'),
                  },
                },
              },
            },
            description: 'Planning metadata. Supports cron, checklist, acceptanceStrategies, and other registered keys.',
          },
          cwd: string('Absolute project path on the target machine. Omit to let the assignee choose.'),
          urgency: { type: 'string', enum: URGENCIES, description: 'Defaults to normal.' },
          permission: { type: 'string', enum: PERMISSIONS, description: 'Defaults to workspace-write.' },
          source: string('Defaults to dsh. External codes such as im must already exist in the source dictionary; self is normalized to dsh.'),
          attachments: stringArray('Input files handed to the assignee; absolute paths only.', 'Absolute local file path.'),
          ref: string('Short alias for this issue inside the batch.'),
          dependsOn: stringArray('Issues that must finish before this issue may enter planning.', 'A ref from this batch or an existing issue UUID.'),
        },
      },
    },
    taskId: string('Optional assigner task id; usually inferred from the calling session.'),
  }, ['issues']),
  branch('state', 'Read one issue record and its materialized issue attachments.', {
    issueId: string('Issue UUID.'),
  }, ['issueId']),
  branch('links', 'Inspect the issue ↔ task ↔ session link. Provide at least one id.', {
    issueId: string('Issue id.'),
    taskId: string("Task id; resolved through the task's issueId."),
    sessionId: string('Session id; scans both session columns.'),
  }),
  branch('convert', 'Convert one accepted or routing issue into a task.', {
    issueId: string('Issue UUID; must be accepted or routing.'),
    title: string('Task title; keep it identical to the issue title.'),
    detail: string('Task body; keep it identical to the issue detail.'),
    cwd: string('Absolute project path on the target machine.'),
    urgency: { type: 'string', enum: URGENCIES, description: 'Omit to inherit the issue urgency.' },
    permission: { type: 'string', enum: PERMISSIONS, description: 'Omit to inherit the issue permission.' },
    reference: {
      type: 'object',
      additionalProperties: false,
      description: 'Notes for the executor.',
      properties: {
        dag: string('Execution DAG code; omit for simple work.'),
        proposal: string('Recommended plan, extra context, and caveats.'),
      },
    },
    checklist: {
      type: 'array',
      description: 'Acceptance checklist. Omit to inherit issue.assignerMeta.checklist; [] clears it.',
      items: {
        oneOf: [
          string('Checklist text.'),
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: string('Optional item id.'),
              text: string('What counts as accepted.'),
              checked: boolean('Usually omitted (false).'),
            },
          },
        ],
      },
    },
    cron: string('Five-field cron. Omit to inherit issue.assignerMeta.cron; empty string forces queue.'),
    acceptanceStrategies: {
      type: 'array',
      description: 'Omit to inherit issue.assignerMeta.acceptanceStrategies; [] clears them.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: string('Strategy title.'),
          type: {
            type: 'string',
            enum: ['issue', 'close'],
            description: 'issue = acceptance creates a new issue; close = acceptance closes the task.',
          },
          description: string('Decision criteria.'),
        },
      },
    },
    tags: stringArray("Omit to inherit the issue's tags.", 'Classification tag.'),
  }, ['issueId', 'title', 'detail', 'cwd']),
])

export const CASTBOARD_TEAMWORK_SCHEMA = tool([
  branch('groups', 'List projects/groups the current user belongs to.', {}),
  branch('group_members', 'List permission-filtered members of one project.', {
    projectId: {
      oneOf: [integer('Numeric project id.'), string('Project id in string form.')],
      description: 'Project id from castboard_teamwork groups.',
    },
  }, ['projectId']),
  branch('devices', "List one account's online dsh devices.", {
    userId: string('Account whose devices to list; omit for the local user.'),
  }),
  branch('workspaces', 'Read project indexes.', {
    type: { type: 'string', enum: ['index'], description: 'Read project indexes.' },
    userId: string('Account whose indexes to read; omit for the local user.'),
    instance: string('Optional ip:port filter; pass it to read one machine.'),
  }, ['type']),
  branch('workspaces', 'Read one workspace portrait.', {
    type: { type: 'string', enum: ['portal'], description: 'Read one workspace portrait.' },
    instance: string('Machine that owns the workspace, ip:port.'),
    workspaceId: string("Workspace id from that machine's index."),
    userId: string('Optional account context.'),
  }, ['type', 'instance', 'workspaceId']),
])

export const CASTBOARD_COMMENT_SCHEMA = tool([
  branch('get', 'Read recent comments on one issue.', {
    issueId: string('Issue UUID, not a task id.'),
    limit: integer('How many recent comments to return, 1..200. Default 50.'),
  }, ['issueId']),
  branch('add', 'Add a comment to one issue and notify the opposite side.', {
    issueId: string('Issue UUID, not a task id.'),
    body: string('Comment text, 1..4000 characters.'),
    role: {
      type: 'string',
      enum: ['assigner', 'assignee'],
      description: 'Comment side. Omit to infer it from the issue link and caller session.',
    },
    attachments: stringArray('Files uploaded with the comment, at most 10.', 'Local file path, absolute or relative to the issue cwd.'),
  }, ['issueId', 'body']),
])
