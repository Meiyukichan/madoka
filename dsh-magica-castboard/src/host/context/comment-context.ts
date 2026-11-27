/**
 * The single renderer for `castboard-issue-comments`.
 *
 * The structure follows the raw host `lattice-issue-comments` shape, with only
 * the tool names adapted to this plugin:
 *
 * ```
 * <issue_comments count="N" issue_id="...">
 *   <reply role="assignee">...</reply>
 *   <comment role="..." by="..." at="..." author="...">body</comment>
 * </issue_comments>
 * ```
 *
 * @module dsh-magica-castboard/host/context/comment-context
 */
import type { ThreadComment } from '../model.ts'
import { interactionLinesForComment } from './interaction-context.ts'
import { escapeXml, escapeXmlAttr } from './xml-escape.ts'

export type CommentReplySide = 'assigner' | 'assignee'

/** One comment attachment that must be readable by the receiving session. */
export interface CommentAttachmentRef {
  readonly name: string
  readonly path: string
}

export type CommentAttachmentsOf = (commentId: string) => readonly CommentAttachmentRef[]

/**
 * Render a comment's attachment block. Kept in one place so the live comment context
 * and the task context cannot drift on path/name escaping or element shape.
 */
export function commentAttachmentLines(
  attachments: readonly CommentAttachmentRef[],
  indent = '    ',
): string[] {
  if (attachments.length === 0) return []
  return [
    `${indent}<attachments count="${attachments.length}">`,
    ...attachments.map(attachment =>
      `${indent}  <attachment name="${escapeXmlAttr(attachment.name)}" path="${escapeXmlAttr(attachment.path)}" />`,
    ),
    `${indent}</attachments>`,
  ]
}

export function commentsXml(
  anchorId: string,
  comments: readonly ThreadComment[],
  side: CommentReplySide = 'assignee',
  attachmentsOf?: CommentAttachmentsOf,
): string {
  const anchor = escapeXmlAttr(anchorId)
  const lines: string[] = [
    `<issue_comments count="${comments.length}" issue_id="${anchor}">`,
    `  <reply role="${side}">Reply with castboard_comment (capability="add"); this issue_id is the comment target.</reply>`,
  ]
  for (const comment of comments) {
    const interaction = interactionLinesForComment(comment, anchorId, side, '  ')
    if (interaction !== undefined) {
      lines.push(...interaction)
      continue
    }
    const attrs = [
      ...(comment.role === null ? [] : [`role="${comment.role}"`]),
      `by="${comment.authorType}"`,
      `at="${new Date(comment.createdAt).toISOString()}"`,
      ...(comment.author === undefined ? [] : [`author="${escapeXmlAttr(comment.author)}"`]),
    ].join(' ')
    const attachments = attachmentsOf?.(comment.id) ?? []
    if (attachments.length === 0) {
      lines.push(`  <comment ${attrs}>${escapeXml(comment.body)}</comment>`)
      continue
    }
    lines.push(`  <comment ${attrs}>${escapeXml(comment.body)}`)
    lines.push(...commentAttachmentLines(attachments))
    lines.push('  </comment>')
  }
  lines.push('</issue_comments>')
  return lines.join('\n')
}
