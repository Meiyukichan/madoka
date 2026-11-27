/**
 * Task references handed to one execution session.
 *
 * Every function here is pure: task data goes in, escaped XML/messages come out.
 * User-controlled strings are always escaped; empty blocks are omitted except the
 * checklist, where "no checklist" is explicit so a missing dependency is not suspected.
 *
 * @module dsh-magica-castboard/host/context/task-context
 */
import { normalizeIssueSource } from '../../shared/wire.ts'
import type { TaskRecord, ThreadComment } from '../model.ts'
import { effectivePrompt } from '../ledger/task-derive.ts'
import { TASK_CONTEXT_SECTION, TASK_PROTOCOL_SECTION } from './sections.ts'
import { escapeXml, escapeXmlAttr } from './xml-escape.ts'
import { commentAttachmentLines, type CommentAttachmentRef } from './comment-context.ts'

/** Read the card before acting. */
export const TASK_BEFORE_START_XML = `<before_start>
  <step order="1" tool="castboard_task" capability="get">Read the full task: description, the proposal in reference, the checklist, and the last execution. The issueId in the response is the card's issue.</step>
</before_start>`

/** Close the card out after the work. */
export const TASK_HANDOFF_XML = `<handoff>
  <step order="1" tool="castboard_task" capability="get">Read the task again to confirm its current status and content.</step>
  <step order="2" tool="castboard_task" capability="report">Submit a structured report: what changed, which files changed, how it was verified, and remaining risks.</step>
  <step order="3" tool="castboard_comment" capability="add">If the task has an issueId, add the same summary as a comment on that issue.</step>
  <step order="4" tool="castboard_task" capability="move">Move the task to in_review.</step>
</handoff>`

/** Checklist operations, present even when the card has no checklist. */
export const TASK_CHECKLIST_XML = `<checklist_rules>
  <rule tool="castboard_task" capability="checklist" action="check">Check each item as it is completed and put the evidence in note.</rule>
  <rule tool="castboard_task" capability="checklist" action="add">Add an item when more acceptance work is discovered.</rule>
  <rule>Incomplete items are highlighted during acceptance.</rule>
</checklist_rules>`

/** Hard boundaries of a board-started execution session. */
export function taskBoundariesXml(hasAcceptance: boolean): string {
  const rules = [
    'This session was started by the castboard service; the task is already in progress, so do not claim it.',
    ...(hasAcceptance
      ? []
      : ['Only the user can move a card to done; the API rejects a session attempt.']),
    'Checking every checklist item is not the same as completing the task; finish the work before moving to review.',
  ]
  return `<boundaries>\n${rules.map(rule => `  <rule>${rule}</rule>`).join('\n')}\n</boundaries>`
}

/** Failure path. */
export const TASK_ON_FAILURE_XML = '<on_failure>If you cannot finish, leave a comment on the issue when the task has an issueId, explaining why; then move the task back to todo.</on_failure>'

/** Ordered execution protocol blocks. */
export function taskProtocolBlocks(hasAcceptance = false): string[] {
  return [
    TASK_BEFORE_START_XML,
    TASK_HANDOFF_XML,
    TASK_CHECKLIST_XML,
    taskBoundariesXml(hasAcceptance),
    TASK_ON_FAILURE_XML,
  ]
}

/** Render the complete `castboard-task-protocol` XML. */
export function castboardTaskProtocolXml(hasAcceptance = false): string {
  return ['<castboard_task_protocol>', ...taskProtocolBlocks(hasAcceptance), '</castboard_task_protocol>'].join('\n')
}

export const CASTBOARD_TASK_PROTOCOL_XML: string = castboardTaskProtocolXml()

/**
 * One attachment visible to the executor. `type` follows the attachment table's
 * derived kind; `role` records which side produced it.
 */
export interface TaskAttachment {
  readonly name: string
  readonly path: string
  readonly type: 'input' | 'output' | 'comment'
  readonly description?: string
  /** Target model: `comment` rows belong to one comment, not the issue header. */
  readonly targetType?: 'issue' | 'comment'
  readonly targetId?: string
}

// Sources whose peer is an agent reachable through issue comments: `dsh` (any dsh
// instance, local or remote). `self` is folded into `dsh` while reading, so old rows
// keep working without a separate branch.
const AGENT_UPSTREAM_SOURCES: readonly string[] = ['dsh']

// `source` is a free-form string (the dictionary can add codes), so normalize before
// matching; otherwise `'DSH'` or `'self '` would slip through.
function hasAgentUpstream(source: string | undefined): boolean {
  if (source === undefined) return false
  const normalized = normalizeIssueSource(source).toLowerCase()
  return normalized !== '' && AGENT_UPSTREAM_SOURCES.includes(normalized)
}

export function castboardTaskContext(
  task: TaskRecord,
  workspacePath: string,
  attachments: readonly TaskAttachment[] = [],
  comments: readonly ThreadComment[] = [],
): string {
  const lines: string[] = ['<castboard_task_context>']
  const issueAttachments = attachments.filter(attachment => attachment.targetType !== 'comment')

  lines.push(`<task id="${escapeXmlAttr(task.id)}" source="castboard">`)
  lines.push(`  <title>${escapeXml(task.title)}</title>`)
  lines.push(`  <workspace id="${escapeXmlAttr(task.workspaceId)}">${escapeXml(workspacePath)}</workspace>`)
  lines.push('</task>')

  // Keep both ids side by side and label each with its tool. An execution session
  // normally sees only the task id and passes it to the issue-comment tool, which then
  // writes to a nonexistent anchor and still reports success. `source` picks who to
  // ask: an agent peer answers through comments, a session-less peer needs the user.
  if (task.issueId !== undefined && task.issueId !== '') {
    const source = task.source === undefined || task.source.trim() === ''
      ? undefined
      : normalizeIssueSource(task.source)
    const sourceAttr = source === undefined || source.trim() === ''
      ? ''
      : ` source="${escapeXmlAttr(source)}"`
    lines.push(`<issue id="${escapeXmlAttr(task.issueId)}"${sourceAttr}>`)
    lines.push('  The issue id above is the comment target; the task id is not.')
    lines.push('  Comment with castboard_comment (capability: "add", role: "assignee").')
    lines.push('  Ask early when context is missing; do not wait.')
    if (hasAgentUpstream(source)) {
      lines.push('  Your direct upstream is the dispatcher (an agent), not the user. Ask the dispatcher through this issue; do not use ask_user_question for the user.')
      lines.push('  Comments are delivered to the dispatcher\'s session; replies arrive as castboard-issue-comments. Answer with castboard_comment (capability: "add", role: "assignee").')
    } else {
      lines.push('  The upstream has no session; ask the user with ask_user_question. Comments still sync to the cloud.')
    }
    lines.push('  role must be assignee; the tool validates it against the session identity.')
    lines.push('</issue>')
  }

  if (issueAttachments.length > 0) {
    // Each file carries its own absolute path; a shared `dir` would repeat the prefix
    // and could be wrong when attachments are not all under one directory.
    lines.push(`<attachments count="${issueAttachments.length}">`)
    issueAttachments.forEach((attachment, index) => {
      const attrs = [
        `index="${index + 1}"`,
        `type="${attachment.type}"`,
        `name="${escapeXmlAttr(attachment.name)}"`,
        `path="${escapeXmlAttr(attachment.path)}"`,
      ].join(' ')
      const body = attachment.description === undefined ? '' : escapeXml(attachment.description)
      lines.push(`  <attachment ${attrs}>${body}</attachment>`)
    })
    lines.push('</attachments>')
  }

  // Skip the running entry: that is this round, not the last one.
  const lastExecution = [...task.executions].reverse().find(entry => entry.outcome !== 'running')
  if (lastExecution !== undefined) {
    const attrs = [
      `trigger="${escapeXmlAttr(lastExecution.trigger)}"`,
      `outcome="${escapeXmlAttr(lastExecution.outcome)}"`,
      ...(lastExecution.startedAt !== undefined ? [`started_at="${new Date(lastExecution.startedAt).toISOString()}"`] : []),
      ...(lastExecution.endedAt !== undefined ? [`ended_at="${new Date(lastExecution.endedAt).toISOString()}"`] : []),
    ].join(' ')
    if (lastExecution.error === undefined || lastExecution.error === '') {
      lines.push(`<last_execution ${attrs}></last_execution>`)
    } else {
      lines.push(`<last_execution ${attrs}>`)
      lines.push(`  <error>${escapeXml(lastExecution.error)}</error>`)
      lines.push('</last_execution>')
    }
  }

  // Every comment on the originating issue, not just the ones after the last
  // execution: a fresh execution session must be able to read the whole
  // discussion. Comments that arrive later still use the separate comment context.
  if (comments.length > 0) {
    lines.push(`<comments count="${comments.length}">`)
    for (const comment of comments) {
      // `authorType` is the source of truth; `threadId` is delivery bookkeeping, not context.
      const by = comment.authorType
      // Dispatcher vs executor changes what the same sentence means; rows written
      // before this column existed simply omit the attribute.
      const roleAttr = comment.role === null ? '' : ` role="${comment.role}"`
      // The cloud account, without which `by` cannot name the person.
      const authorAttr = comment.author !== undefined && comment.author !== ''
        ? ` author="${escapeXmlAttr(comment.author)}"`
        : ''
      const commentFiles: CommentAttachmentRef[] = attachments
        .filter(attachment => attachment.targetType === 'comment' && attachment.targetId === comment.id)
        .map(attachment => ({ name: attachment.name, path: attachment.path }))
      if (commentFiles.length === 0) {
        lines.push(`  <comment by="${by}"${roleAttr}${authorAttr} at="${new Date(comment.createdAt).toISOString()}">${escapeXml(comment.body)}</comment>`)
      } else {
        lines.push(`  <comment by="${by}"${roleAttr}${authorAttr} at="${new Date(comment.createdAt).toISOString()}">${escapeXml(comment.body)}`)
        lines.push(...commentAttachmentLines(commentFiles, '    '))
        lines.push('  </comment>')
      }
    }
    lines.push('</comments>')
  }

  const reference = task.reference
  if (reference !== undefined && (reference.dag !== undefined || reference.proposal !== undefined)) {
    lines.push('<reference>')
    if (reference.dag !== undefined && reference.dag !== '') {
      lines.push(`  <dag>${escapeXml(reference.dag)}</dag>`)
    }
    if (reference.proposal !== undefined && reference.proposal !== '') {
      lines.push(`  <proposal>${escapeXml(reference.proposal)}</proposal>`)
    }
    lines.push('</reference>')
  }

  const tags = task.tags ?? []
  if (tags.length > 0) {
    lines.push(`<tags count="${tags.length}">`)
    for (const tag of tags) lines.push(`  <tag>${escapeXml(tag)}</tag>`)
    lines.push('</tags>')
  }

  const items = task.checklist ?? []
  if (items.length === 0) {
    lines.push('<checklist progress="0/0"></checklist>')
  } else {
    const done = items.filter(item => item.checked).length
    lines.push(`<checklist progress="${done}/${items.length}">`)
    items.forEach((item, index) => {
      const attrs = [
        `index="${index + 1}"`,
        `checked="${item.checked ? 'true' : 'false'}"`,
        ...(item.note !== undefined && item.note !== '' ? [`evidence="${escapeXmlAttr(item.note)}"`] : []),
      ].join(' ')
      lines.push(`  <item ${attrs}>${escapeXml(item.text)}</item>`)
    })
    lines.push('</checklist>')
  }

  lines.push('</castboard_task_context>')
  return lines.join('\n')
}

export interface NamedContext {
  readonly name: string
  readonly text: string
  readonly form?: 'snapshot' | 'instructions' | 'notice'
  readonly summary?: string
}

// Return order is injection order. Instructions are constant while data is re-rendered
// from the card, so a missing checklist never hides the checklist instructions.
export function buildContexts(
  task: TaskRecord,
  workspacePath: string,
  attachments: readonly TaskAttachment[] = [],
  comments: readonly ThreadComment[] = [],
): NamedContext[] {
  const hasAcceptance = (task.acceptanceStrategies?.length ?? 0) > 0
    || (task.acceptanceStrategyIds?.length ?? 0) > 0
  return [
    {
      name: TASK_PROTOCOL_SECTION,
      text: castboardTaskProtocolXml(hasAcceptance),
      form: 'instructions',
    },
    {
      name: TASK_CONTEXT_SECTION,
      text: castboardTaskContext(task, workspacePath, attachments, comments),
      form: 'snapshot',
    },
  ]
}

// Same function the tool uses to show the execution prompt; a second implementation
// would let what the tool shows and what the session receives diverge. An empty body
// falls back to the title inside `effectivePrompt`.
export function userInstruction(task: TaskRecord): string {
  return effectivePrompt(task)
}
