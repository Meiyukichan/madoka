/**
 * The shared library's narrow comment/artifact interfaces.
 *
 * @module dsh-magica-castboard/host/pipeline/remote
 */
import type { CommentRole } from '../../shared/wire.ts'

export interface RemoteComment {
  issueId: string
  commentId: string
  body: string
  createdAt: number
  /** Cloud role; `null` = unknown (web/history). */
  role: CommentRole | null
  /** Cloud author type (`user` / `agent` / `system`); unknown stays undefined. */
  authorType?: string
  author?: string
}

export interface RemoteCommentPage {
  items: RemoteComment[]
  nextSinceId?: string
}

export interface RemoteCommentsFace {
  /** Pull by ascending cursor (`sinceId` empty = from the start). */
  listSince: (input: { sinceId?: string; limit: number }) => Promise<RemoteCommentPage>
  /**
   * Publish one local comment (idempotent: republishing the same commentId does not error).
   *
   * The cloud columns are part of the protocol, not decoration: `commentAt` keeps the
   * original time (ordering across machines), `commentRole` is omitted when unknown, and
   * `commentAuthorType` lets the other side keep system messages out of sessions.
   */
  publish: (input: {
    issueId: string
    commentId: string
    body: string
    role: CommentRole | null
    authorType: string
    createdAt: number
  }) => Promise<void>
}

export interface RemoteArtifactsFace {
  upload: (input: { issueId: string; filePath: string }) => Promise<{ fileId: string }>
}


