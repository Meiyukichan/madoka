/**
 * issue 子系统出口：5 个原子客户端（本体 + 附件 / 评论 / 来源 / 工作区）。
 */

export { CastboardIssueApi } from './issue.js'
export { CastboardAttachmentApi, type CastboardAttachmentListInput } from './attachment.js'
export {
  CastboardCommentApi,
  CASTBOARD_COMMENT_INCREMENT_DEFAULT_LIMIT,
  CASTBOARD_COMMENT_INCREMENT_MAX_LIMIT,
} from './comment.js'
export { CastboardSourceApi } from './source.js'
export { CastboardWorkspaceApi } from './workspaces.js'
