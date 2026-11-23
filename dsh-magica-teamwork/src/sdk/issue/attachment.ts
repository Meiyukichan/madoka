/**
 * issue.attachment（C11 / C12）：挂附件关系与查询。
 *
 * 身份 = `targetType(issue|comment) + targetId + role(assigner|assignee)`；
 * **不做任何门面值翻译**（线上值就是对外值），输入/输出之类的语义由调用方自己解释。
 */

import type { CastboardTransport } from '../transport.js'
import { castboardFail, castboardOk, type CastboardFail, type CastboardResult } from '../result.js'
import {
  isCastboardAttachmentRole,
  isCastboardAttachmentTargetType,
  type CastboardAttachment,
  type CastboardAttachmentInput,
  type CastboardAttachmentRole,
  type CastboardAttachmentTargetType,
} from '../types.js'
import { checkIssueId, pick } from '../wire.js'

const ATTACHMENT_KEYS = ['targetType', 'targetId', 'fileId', 'role', 'fileName', 'description'] as const

/** 查附件入参：`role` 省略 = 两种角色都要 */
export interface CastboardAttachmentListInput {
  targetType: CastboardAttachmentTargetType
  targetId: string
  role?: CastboardAttachmentRole
}

/**
 * `targetId` 校验：
 *  - `issue` 复用 issueId 规则（1..100，不含控制字符，不允许首尾空白）；
 *  - `comment` 是评论幂等键，只要求非空且 ≤100（与 DB 无长度约束对齐）。
 */
function checkTargetId(
  targetType: CastboardAttachmentTargetType,
  targetId: unknown,
  where: string,
): CastboardFail | null {
  if (targetType === 'issue') return checkIssueId(targetId, where)
  if (typeof targetId !== 'string' || targetId.trim() === '' || targetId.length > 100) {
    return castboardFail({
      status: 400,
      code: 'invalid_request',
      reason: `${where} 的 targetId 必须是 1..100 个字符的评论 id`,
      field: 'targetId',
      value: typeof targetId === 'string' ? targetId : String(targetId),
    })
  }
  return null
}

export class CastboardAttachmentApi {
  constructor(private readonly transport: CastboardTransport) {}

  /** C11 `POST /issues/attachments/batch`：批量挂附件（整批原子，按 `(targetType,targetId,fileId)` upsert） */
  async add(batch: readonly CastboardAttachmentInput[]): Promise<CastboardResult<{ count: number }>> {
    if (batch.length === 0) return castboardOk(200, { count: 0 })
    const body: Record<string, unknown>[] = []
    for (const [index, item] of batch.entries()) {
      const where = `issue.attachment.add[${index}]`
      if (!isCastboardAttachmentTargetType(item.targetType)) {
        return castboardFail({
          status: 400,
          code: 'invalid_request',
          reason: `${where} 的 targetType 只能是 issue / comment`,
          field: 'targetType',
          value: String(item.targetType),
        })
      }
      if (!isCastboardAttachmentRole(item.role)) {
        return castboardFail({
          status: 400,
          code: 'invalid_role',
          reason: `${where} 的 role 只能是 assigner / assignee`,
          field: 'role',
          value: String(item.role),
        })
      }
      const checked = checkTargetId(item.targetType, item.targetId, where)
      if (checked !== null) return checked
      if (typeof item.fileId !== 'string' || item.fileId.trim() === '') {
        return {
          ok: false,
          status: 400,
          code: 'invalid_file_id',
          reason: `fileId 必须是非空字符串（第 ${index} 条）`,
          field: 'fileId',
        }
      }
      body.push(pick({ ...item }, ATTACHMENT_KEYS))
    }
    const result = await this.transport.call<{ count?: number }>('issueAttachmentAdd', {}, { body })
    if (!result.ok) return result
    return castboardOk(result.status, { count: typeof result.data?.count === 'number' ? result.data.count : 0 })
  }

  /** C12b `GET /attachments?targetType=&targetId=&role=`：按目标查附件（行原样返回） */
  async list(input: CastboardAttachmentListInput): Promise<CastboardResult<CastboardAttachment[]>> {
    if (!isCastboardAttachmentTargetType(input.targetType)) {
      return castboardFail({
        status: 400,
        code: 'invalid_request',
        reason: 'issue.attachment.list 的 targetType 只能是 issue / comment',
        field: 'targetType',
        value: String(input.targetType),
      })
    }
    const checked = checkTargetId(input.targetType, input.targetId, 'issue.attachment.list')
    if (checked !== null) return checked
    if (input.role !== undefined && !isCastboardAttachmentRole(input.role)) {
      return castboardFail({
        status: 400,
        code: 'invalid_role',
        reason: 'issue.attachment.list 的 role 只能是 assigner / assignee',
        field: 'role',
        value: String(input.role),
      })
    }
    const result = await this.transport.call<CastboardAttachment[] | null>('issueAttachmentListByTarget', {}, {
      query: {
        targetType: input.targetType,
        targetId: input.targetId,
        ...(input.role === undefined ? {} : { role: input.role }),
      },
    })
    if (!result.ok) return result
    const items = Array.isArray(result.data) ? result.data : []
    return castboardOk(result.status, items)
  }
}
