/**
 * issue.comment（C7–C10）：追加 / 列表 / 全局增量 / 游标。
 *
 * 两个"必须由本层做的事"：
 *  - `cursor()` 把协议形状 `{ maxId }` 折成 `number`（组合层与调用方都按数字用）；
 *  - `listSince()` 的 `limit` 夹到 `[1, 2000]`、默认 500（与服务端一致）。
 */

import type { CastboardTransport } from '../transport.js'
import { castboardOk, type CastboardResult } from '../result.js'
import type { CastboardComment, CastboardCommentIncrement, CastboardCommentIncrementQuery, CastboardCommentInput } from '../types.js'
import { checkIssueId, pick } from '../wire.js'

/** 增量评论默认条数（与服务端 `api-design` §5.7 一致） */
export const CASTBOARD_COMMENT_INCREMENT_DEFAULT_LIMIT = 500
/** 增量评论上限 */
export const CASTBOARD_COMMENT_INCREMENT_MAX_LIMIT = 2000

/** C9 允许的键（**没有 `author`**：它由 token 决定） */
const COMMENT_KEYS = ['content', 'commentId', 'commentAt', 'commentRole', 'commentAuthorType'] as const

export class CastboardCommentApi {
  constructor(private readonly transport: CastboardTransport) {}

  /**
   * C9 `POST /issues/{issueId}/comments`：追加一条评论。
   *
   * **同 `commentId` 幂等**（服务端返回已存在的那条，HTTP 200 而不是 201）。
   * 重试必须复用同一个 `commentId`。
   */
  async add(issueId: string, comment: CastboardCommentInput): Promise<CastboardResult<CastboardComment>> {
    const checked = checkIssueId(issueId, 'issue.comment.add')
    if (checked !== null) return checked
    const content = typeof comment.content === 'string' ? comment.content : ''
    if (content.length < 1 || content.length > 10000) {
      return {
        ok: false,
        status: 400,
        code: 'invalid_content',
        reason: '评论内容必须是 1..10000 个字符',
        field: 'content',
      }
    }
    const body = pick(comment as unknown as Record<string, unknown>, COMMENT_KEYS)
    return this.transport.call<CastboardComment>('issueCommentAdd', { issueId }, { body })
  }

  /** C10 `GET /issues/{issueId}/comments`：某条 issue 的全部评论（不分页，`created_at ASC`） */
  async list(issueId: string): Promise<CastboardResult<CastboardComment[]>> {
    const checked = checkIssueId(issueId, 'issue.comment.list')
    if (checked !== null) return checked
    const result = await this.transport.call<CastboardComment[] | null>('issueCommentList', { issueId })
    if (!result.ok) return result
    return castboardOk(result.status, Array.isArray(result.data) ? result.data : [])
  }

  /** C7 `GET /issues/comments`：全局增量（自增 id 游标；`limit` 默认 500、上限 2000） */
  async listSince(query: CastboardCommentIncrementQuery = {}): Promise<CastboardResult<CastboardCommentIncrement>> {
    const rawLimit = typeof query.limit === 'number' && Number.isFinite(query.limit) ? Math.floor(query.limit) : CASTBOARD_COMMENT_INCREMENT_DEFAULT_LIMIT
    const limit = rawLimit < 1 ? CASTBOARD_COMMENT_INCREMENT_DEFAULT_LIMIT : rawLimit > CASTBOARD_COMMENT_INCREMENT_MAX_LIMIT ? CASTBOARD_COMMENT_INCREMENT_MAX_LIMIT : rawLimit
    const sinceId = typeof query.sinceId === 'number' && Number.isFinite(query.sinceId) && query.sinceId > 0 ? Math.floor(query.sinceId) : 0
    const result = await this.transport.call<CastboardCommentIncrement | CastboardComment[] | null>('issueCommentListSince', {}, {
      query: { sinceId, limit },
    })
    if (!result.ok) return result
    // 兼容 `{items,nextSinceId,hasMore}` 与裸数组两种形状（旧实现的经验）
    if (Array.isArray(result.data)) {
      const items = result.data
      const nextSinceId = items.length === 0 ? sinceId : items[items.length - 1]!.id
      return castboardOk(result.status, { items, nextSinceId, hasMore: items.length >= limit })
    }
    const data = result.data
    const items = Array.isArray(data?.items) ? data.items : []
    return castboardOk(result.status, {
      items,
      nextSinceId: typeof data?.nextSinceId === 'number' ? data.nextSinceId : sinceId,
      hasMore: data?.hasMore === true,
    })
  }

  /**
   * C8 `GET /issues/comments/cursor`：当前最大评论 id。
   *
   * **协议回 `{ maxId }`，这里折成 `number`**（首次运行 / 本地游标丢失时用它当起点，
   * 避免 `sinceId=0` 扫全表）。
   */
  async cursor(): Promise<CastboardResult<number>> {
    const result = await this.transport.call<{ maxId?: number } | number>('issueCommentCursor')
    if (!result.ok) return result
    const raw = typeof result.data === 'number' ? result.data : result.data?.maxId
    const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0
    return castboardOk(result.status, value)
  }
}
