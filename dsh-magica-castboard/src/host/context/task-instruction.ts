/**
 * One-off instruction for a manual task-dispatch turn.
 *
 * @module dsh-magica-castboard/host/context/task-instruction
 */
import type { TaskRecord } from '../model.ts'
import { escapeXml, escapeXmlAttr } from './xml-escape.ts'

export interface DispatchTarget {
  readonly text: string
  readonly projectId: string
  readonly assignee: string
  readonly assigneeInstance?: string
}

// One-off instruction from a person, unlike the strategy-driven acceptance round. Both
// forbid touching task state or closing the card.
export function taskDispatchInstruction(task: TaskRecord, target: DispatchTarget): string {
  const lines: string[] = ['<castboard_task_dispatch>']
  lines.push(`<task id="${escapeXmlAttr(task.id)}">`)
  lines.push(`  <title>${escapeXml(task.title)}</title>`)
  lines.push('</task>')
  const attrs = [
    `project="${escapeXmlAttr(target.projectId)}"`,
    `assignee="${escapeXmlAttr(target.assignee)}"`,
    target.assigneeInstance !== undefined ? `instance="${escapeXmlAttr(target.assigneeInstance)}"` : '',
  ].filter(part => part !== '').join(' ')
  lines.push(attrs === '' ? '<target/>' : `<target ${attrs}/>`)
  lines.push(`<request>${escapeXml(target.text)}</request>`)
  lines.push('<steps>')
  lines.push('  <step order="1">Call castboard_issue (capability="help") first; then verify the target with castboard_teamwork (capabilities: groups, group_members, workspaces).</step>')
  lines.push('  <step order="2">Split the request into one or more issues and create them with castboard_issue (capability="create"). Use dependsOn for ordering. Take the target fields as-is and do not ask again; for cwd and attachments follow the delegation guidance: ask when needed, omit when unavailable, never invent.</step>')
  lines.push('  <step order="3">Summarize the created issues (title and issueId) with castboard_comment (capability="add").</step>')
  lines.push('</steps>')
  lines.push('<constraints>Do not change this task\'s status, move it to done, or modify code.</constraints>')
  lines.push('</castboard_task_dispatch>')
  return lines.join('\n')
}
