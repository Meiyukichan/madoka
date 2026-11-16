/**
 * issue.attachment（C11 / C12）：挂附件关系与查询。
 *
 * **门面类型 `input`/`output` ↔ 线上 `assigner`/`assignee`** 的映射就在这里
 * （DB `ck_tw_attachment_type CHECK (type IN ('assigner','assignee'))`，D8）。
 */

import type { LatticeTransport } from '../transport.js'
import { latticeOk, type LatticeResult } from '../result.js'
import type { LatticeAttachment, LatticeAttachmentInput, LatticeAttachmentType } from '../types.js'
import { checkIssueId, fromWireAttachmentType, pick, toWireAttachmentType } from '../wire.js'

const ATTACHMENT_KEYS = ['issueId', 'fileId', 'type', 'fileName', 'description'] as const

export class LatticeAttachmentApi {
  constructor(private readonly transport: LatticeTransport) {}

  /** C11 `POST /issues/attachments/batch`：批量挂附件（整批原子，按 `(issueId,fileId)` upsert） */
  async add(batch: readonly LatticeAttachmentInput[]): Promise<LatticeResult<{ count: number }>> {
    if (batch.length === 0) return latticeOk(200, { count: 0 })
    const body: Record<string, unknown>[] = []
    for (const [index, item] of batch.entries()) {
      const checked = checkIssueId(item.issueId, `issue.attachment.add[${index}]`)
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
      body.push(
        pick(
          {
            ...item,
            // 门面值 → 线上值；已经是 assigner/assignee 的直接透传
            type: toWireAttachmentType(item.type),
          },
          ATTACHMENT_KEYS,
        ),
      )
    }
    const result = await this.transport.call<{ count?: number }>('issueAttachmentAdd', {}, { body })
    if (!result.ok) return result
    return latticeOk(result.status, { count: typeof result.data?.count === 'number' ? result.data.count : 0 })
  }

  /** C12 `GET /issues/{issueId}/attachments`：查附件（`type` 省略 = 全部；线上值映射回门面值） */
  async list(issueId: string, type?: LatticeAttachmentType): Promise<LatticeResult<LatticeAttachment[]>> {
    const checked = checkIssueId(issueId, 'issue.attachment.list')
    if (checked !== null) return checked
    const result = await this.transport.call<LatticeAttachment[] | null>('issueAttachmentList', { issueId }, {
      query: type === undefined ? {} : { type: toWireAttachmentType(type) },
    })
    if (!result.ok) return result
    const items = Array.isArray(result.data) ? result.data : []
    return latticeOk(
      result.status,
      items.map((item) => ({ ...item, type: fromWireAttachmentType(item.type) })),
    )
  }
}
