/**
 * The single renderer for `castboard-issue-comments`.
 *
 * The structure is byte-for-byte the raw host `lattice-issue-comments` shape, with only
 * the tool names adapted to this plugin:
 *
 * ```
 * <issue_comments count="N" issue="...">
 *   <!-- reply hint -->
 *   <!-- anchor hint -->
 *   <comment role="..." by="..." at="..." author="...">body</comment>
 * </issue_comments>
 * ```
 *
 * @module dsh-magica-castboard/host/context/comment-xml
 */
import type { ThreadComment } from '../model.ts'

export function commentsXml(anchorId: string, comments: readonly ThreadComment[]): string {
  const anchor = escapeAttribute(anchorId)
  const lines: string[] = [
    `<issue_comments count="${comments.length}" issue="${anchor}">`,
    `  <!-- 回复本 issue 用：castboard_issue_comment_add { issueId: "${anchor}", commentRole: "assignee", body: "…" } -->`,
    '  <!-- 这个 issue id 才是 issue 评论的目标；任务 id（t-…）只能配 castboard_comment_add / castboard_move / castboard_execution_report。 -->',
  ]
  for (const comment of comments) {
    const attrs = [
      `role="${comment.role ?? 'assigner'}"`,
      `by="${comment.authorType}"`,
      `at="${new Date(comment.createdAt).toISOString()}"`,
      ...(comment.author === undefined ? [] : [`author="${escapeAttribute(comment.author)}"`]),
    ].join(' ')
    lines.push(`  <comment ${attrs}>${escapeText(comment.body)}</comment>`)
  }
  lines.push('</issue_comments>')
  return lines.join('\n')
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttribute(text: string): string {
  return escapeText(text)
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, '&#10;')
}
