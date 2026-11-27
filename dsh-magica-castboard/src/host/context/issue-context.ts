/**
 * Renderer for the per-turn `castboard_issue_context` context.
 *
 * Static router guidance lives in `router-context.ts`; this module owns only the
 * issue data that changes from one router turn to the next.
 *
 * @module dsh-magica-castboard/host/context/issue-context
 */
import type { IssueRecord } from '../model.ts'
import { escapeXml, escapeXmlAttr } from './xml-escape.ts'

export interface IssueContextAttachment {
  readonly name: string
  readonly path: string
  readonly description?: string
}

export interface IssueContextComment {
  readonly author: string
  readonly content: string
  readonly at?: string
}

export interface IssueContextExtras {
  readonly attachments?: readonly IssueContextAttachment[]
  readonly comments?: readonly IssueContextComment[]
  /** Per-issue fallback cwd: `<castboard>/.cache/<issueId>`, already created by the host. */
  readonly fallbackCwd?: string
}

export function castboardIssueContext(
  issue: IssueRecord,
  extras: IssueContextExtras = {},
): string {
  const lines: string[] = ['<castboard_issue_context>']
  const push = (name: string, value: string | undefined): void => {
    if (value === undefined || value === '') return
    lines.push(`<${name}>${escapeXml(value)}</${name}>`)
  }
  push('issue_id', issue.id)
  push('title', issue.title)
  push('detail', issue.detail)
  push('urgency', issue.urgency)
  push('permission', issue.permission)
  push('cwd', issue.cwd)
  push('fallback_cwd', extras.fallbackCwd)
  push('workspace_id', issue.workspaceId)
  push('source', issue.source)
  push('assigner', issue.assigner)
  push('assigner_task', issue.assignerTask)
  push('route_attempts', issue.routeAttempts === undefined ? undefined : String(issue.routeAttempts))
  push('route_error', issue.routeError)
  if (issue.assignerMeta !== undefined) {
    // title and detail also live inside the meta and were printed above; emitting them
    // twice can duplicate a multi-thousand-character body.
    const rest: Record<string, unknown> = { ...issue.assignerMeta }
    delete rest.title
    delete rest.detail
    if (Object.keys(rest).length > 0) {
      lines.push('<assigner_meta>')
      lines.push(escapeXml(JSON.stringify(rest)))
      lines.push('</assigner_meta>')
    }
  }

  // Paths only: a body can be several megabytes, and the subagent can read the file.
  const attachments = extras.attachments ?? []
  if (attachments.length > 0) {
    // Each file carries its own absolute path; a shared `dir` would repeat the prefix
    // and could be wrong when attachments are not all under one directory.
    lines.push(`<input_attachments count="${attachments.length}">`)
    attachments.forEach((attachment, index) => {
      const attrs = [
        `index="${index + 1}"`,
        `name="${escapeXmlAttr(attachment.name)}"`,
        `path="${escapeXmlAttr(attachment.path)}"`,
      ].join(' ')
      const body = attachment.description === undefined || attachment.description === ''
        ? ''
        : escapeXml(attachment.description)
      lines.push(`  <input_attachment ${attrs}>${body}</input_attachment>`)
    })
    lines.push('</input_attachments>')
  }

  // Dropping these would produce a task missing requirements added in discussion.
  const comments = extras.comments ?? []
  if (comments.length > 0) {
    lines.push(`<comments count="${comments.length}">`)
    for (const comment of comments) {
      const at = comment.at === undefined || comment.at === '' ? '' : ` at="${escapeXmlAttr(comment.at)}"`
      lines.push(`  <comment by="${escapeXmlAttr(comment.author)}"${at}>${escapeXml(comment.content)}</comment>`)
    }
    lines.push('</comments>')
  }

  lines.push('</castboard_issue_context>')
  return lines.join('\n')
}
