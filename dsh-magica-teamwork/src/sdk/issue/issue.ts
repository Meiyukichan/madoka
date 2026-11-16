/**
 * issue 本体（C1–C6）：提交 / 查询 / 覆盖 / 遗弃 / 批量状态 / 列表。
 *
 * 本层是**协议面 1:1**，只做三件事：
 *  1. 入口校验（`issueId` 形状、枚举），不合格**零请求**；
 *  2. 线格式翻译（`*Meta` → JSON 文本、`dependsOn` → JSON 文本、`permission: ''` → `null`）；
 *  3. 读回归一（`dependsOn` 恒为 `string[]`）。
 *
 * 不做：写后读回（D12）、跨端点组合（那是组合层 `sdk.ts`）。
 */

import type { LatticeTransport } from '../transport.js'
import { latticeOk, type LatticeResult } from '../result.js'
import {
  isLatticeIssueStatus,
  isLatticeUrgency,
  isLatticePermission,
  type LatticeIssue,
  type LatticeIssueInput,
  type LatticeIssuePage,
  type LatticeIssueQuery,
  type LatticeIssueStatus,
  type LatticeStatusBatchResult,
  type LatticeStatusUpdate,
} from '../types.js'
import {
  asDependsOnString,
  asMetaString,
  checkIssueId,
  normalizeIssue,
  normalizePermission,
  pick,
} from '../wire.js'
import { LatticeAttachmentApi } from './attachment.js'
import { LatticeCommentApi } from './comment.js'
import { LatticeSourceApi } from './source.js'
import { LatticeWorkspaceApi } from './workspaces.js'

/** C1 允许的键（**不含 `assigner`**：身份来自 token） */
const SUBMIT_KEYS = [
  'issueId',
  'title',
  'detail',
  'assignee',
  'projectId',
  'cwd',
  'urgency',
  'permission',
  'source',
  'sourceInstance',
  'assignerTask',
  'assignerMeta',
  'assigneeTask',
  'assigneeInstance',
  'assigneeMeta',
  'dependsOn',
  'assignedAt',
  'status',
] as const

/** C4 允许的键 = C1 去掉 `issueId`（`issueId` 在路径里） */
const REPLACE_KEYS = SUBMIT_KEYS.filter((key) => key !== 'issueId')

/** C6 允许的键 */
const STATUS_KEYS = ['issueId', 'status', 'expectedStatus', 'assigneeTask', 'assigneeInstance', 'assigneeMeta', 'assignedAt'] as const

/** 把门面入参翻成线上请求体（`*Meta` 序列化、`dependsOn` 序列化、`permission` 归一） */
function issueWireBody(
  input: LatticeIssueInput,
  allowed: readonly string[],
): { body: Record<string, unknown> } | { error: string; field: string } {
  const translated: Record<string, unknown> = { ...input }
  if ('assignerMeta' in input) translated['assignerMeta'] = asMetaString(input.assignerMeta)
  if ('assigneeMeta' in input) translated['assigneeMeta'] = asMetaString(input.assigneeMeta)
  if ('dependsOn' in input) translated['dependsOn'] = asDependsOnString(input.dependsOn)
  if ('permission' in input) translated['permission'] = normalizePermission(input.permission)
  return { body: pick(translated, allowed) }
}

export class LatticeIssueApi {
  readonly attachment: LatticeAttachmentApi
  readonly comment: LatticeCommentApi
  readonly source: LatticeSourceApi
  readonly workspace: LatticeWorkspaceApi

  constructor(private readonly transport: LatticeTransport) {
    this.attachment = new LatticeAttachmentApi(transport)
    this.comment = new LatticeCommentApi(transport)
    this.source = new LatticeSourceApi(transport)
    this.workspace = new LatticeWorkspaceApi(transport)
  }

  /**
   * C1 `POST /issues/batch`：批量提交（**整批原子**，返回 `issueId[]`，顺序与入参一致）。
   *
   * `dependsOn` 空清单会整字段剔除（不会写入 `"[]"`）。
   */
  async submit(issues: readonly LatticeIssueInput[]): Promise<LatticeResult<string[]>> {
    if (issues.length === 0) return latticeOk(200, [])
    const body: Record<string, unknown>[] = []
    for (const [index, item] of issues.entries()) {
      if (item.issueId !== undefined) {
        const checked = checkIssueId(item.issueId, `issue.submit[${index}]`)
        if (checked !== null) return checked
      }
      if (item.urgency !== undefined && !isLatticeUrgency(item.urgency)) {
        return {
          ok: false,
          status: 400,
          code: 'invalid_urgency',
          reason: `urgency 必须是 runtime / direct / urgent / normal / relaxed（第 ${index} 条）`,
          field: 'urgency',
        }
      }
      if (item.permission !== undefined && item.permission !== '' && item.permission !== null && !isLatticePermission(item.permission)) {
        return {
          ok: false,
          status: 400,
          code: 'invalid_permission',
          reason: `permission 必须是 read-only / workspace-write / danger-full-access（第 ${index} 条）`,
          field: 'permission',
        }
      }
      if (item.status !== undefined && !isLatticeIssueStatus(item.status)) {
        return {
          ok: false,
          status: 400,
          code: 'invalid_status',
          reason: `status 必须是 pending / accepted / routing / running / success / failed / abandoned（第 ${index} 条）`,
          field: 'status',
        }
      }
      const wire = issueWireBody(item, SUBMIT_KEYS)
      if ('error' in wire) return { ok: false, status: 400, code: 'invalid_body', reason: wire.error, field: wire.field }
      body.push(wire.body)
    }
    const result = await this.transport.call<string[]>('issueSubmit', {}, { body })
    if (!result.ok) return result
    return latticeOk(result.status, Array.isArray(result.data) ? result.data : [])
  }

  /** C3 `GET /issues/{issueId}`：单条（读回 `dependsOn` 归一成 `string[]`） */
  async get(issueId: string): Promise<LatticeResult<LatticeIssue>> {
    const checked = checkIssueId(issueId, 'issue.get')
    if (checked !== null) return checked
    const result = await this.transport.call<LatticeIssue>('issueGet', { issueId })
    if (!result.ok) return result
    return latticeOk(result.status, normalizeIssue(result.data))
  }

  /** C4 `PUT /issues/{issueId}`：全字段覆盖（**未传字段保留原值**；传 `null` 才清空） */
  async replace(issueId: string, patch: LatticeIssueInput): Promise<LatticeResult<LatticeIssue>> {
    const checked = checkIssueId(issueId, 'issue.replace')
    if (checked !== null) return checked
    if (patch.urgency !== undefined && !isLatticeUrgency(patch.urgency)) {
      return { ok: false, status: 400, code: 'invalid_urgency', reason: 'urgency 取值不合法', field: 'urgency' }
    }
    if (patch.status !== undefined && !isLatticeIssueStatus(patch.status)) {
      return { ok: false, status: 400, code: 'invalid_status', reason: 'status 取值不合法', field: 'status' }
    }
    const wire = issueWireBody(patch, REPLACE_KEYS)
    if ('error' in wire) return { ok: false, status: 400, code: 'invalid_body', reason: wire.error, field: wire.field }
    const result = await this.transport.call<LatticeIssue>('issueReplace', { issueId }, { body: wire.body })
    if (!result.ok) return result
    return latticeOk(result.status, normalizeIssue(result.data))
  }

  /** C5 `DELETE /issues/{issueId}`：遗弃（软删，置 `abandoned`） */
  async abandon(issueId: string): Promise<LatticeResult<void>> {
    const checked = checkIssueId(issueId, 'issue.abandon')
    if (checked !== null) return checked
    return this.transport.call<void>('issueAbandon', { issueId })
  }

  /**
   * C6 `POST /issues/status/batch`：批量状态更新（**部分成功**，HTTP 恒 200）。
   *
   * 逐条失败进 `failed[]`；`status_conflict` 表示并发抢输了、**不要重试**。
   */
  async updateStatuses(updates: readonly LatticeStatusUpdate[]): Promise<LatticeResult<LatticeStatusBatchResult>> {
    if (updates.length === 0) return latticeOk(200, { success: 0, failed: [] })
    const body: Record<string, unknown>[] = []
    for (const [index, item] of updates.entries()) {
      const checked = checkIssueId(item.issueId, `issue.updateStatuses[${index}]`)
      if (checked !== null) return checked
      if (!isLatticeIssueStatus(item.status)) {
        return {
          ok: false,
          status: 400,
          code: 'invalid_status',
          reason: `status 必须是 pending / accepted / routing / running / success / failed / abandoned（第 ${index} 条）`,
          field: 'status',
        }
      }
      if (item.expectedStatus !== undefined && !isLatticeIssueStatus(item.expectedStatus)) {
        return {
          ok: false,
          status: 400,
          code: 'invalid_status',
          reason: `expectedStatus 取值不合法（第 ${index} 条）`,
          field: 'expectedStatus',
        }
      }
      body.push(
        pick(
          {
            ...item,
            assigneeMeta: item.assigneeMeta === undefined ? undefined : asMetaString(item.assigneeMeta),
          },
          STATUS_KEYS,
        ),
      )
    }
    const result = await this.transport.call<LatticeStatusBatchResult>('issueUpdateStatuses', {}, { body })
    if (!result.ok) return result
    const data = result.data
    return latticeOk(result.status, {
      success: typeof data?.success === 'number' ? data.success : 0,
      failed: Array.isArray(data?.failed) ? data.failed : [],
    })
  }

  /**
   * C2 `GET /issues`：分页查询。
   *
   * 入参同时接受 `page`（raw 写法）与 `pageNum`；出参**两者都给**且恒等（D11）。
   */
  async list(query: LatticeIssueQuery = {}): Promise<LatticeResult<LatticeIssuePage>> {
    const rawPage = query.pageNum ?? query.page
    const pageNum = typeof rawPage === 'number' && Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1
    const rawSize = typeof query.pageSize === 'number' && Number.isFinite(query.pageSize) ? Math.floor(query.pageSize) : 20
    const pageSize = rawSize < 1 ? 20 : rawSize > 200 ? 200 : rawSize
    if (query.status !== undefined && !isLatticeIssueStatus(query.status)) {
      return {
        ok: false,
        status: 400,
        code: 'invalid_status',
        reason: 'status 必须是 pending / accepted / routing / running / success / failed / abandoned',
        field: 'status',
      }
    }
    const result = await this.transport.call<{
      total?: number
      pageNum?: number
      pageSize?: number
      items?: LatticeIssue[]
    }>('issueList', {}, {
      query: {
        pageNum,
        pageSize,
        status: query.status,
        source: query.source,
        projectId: query.projectId,
        keyword: query.keyword,
      },
    })
    if (!result.ok) return result
    const data = result.data
    const items = Array.isArray(data?.items) ? data.items.map(normalizeIssue) : []
    const effectivePageNum = typeof data?.pageNum === 'number' && data.pageNum >= 1 ? data.pageNum : pageNum
    return latticeOk(result.status, {
      total: typeof data?.total === 'number' ? data.total : items.length,
      page: effectivePageNum,
      pageNum: effectivePageNum,
      pageSize: typeof data?.pageSize === 'number' ? data.pageSize : pageSize,
      items,
    })
  }

  /** 供组合层判状态用：`LatticeIssueStatus` 的守卫（避免组合层再 import 一次 types） */
  static isStatus(value: unknown): value is LatticeIssueStatus {
    return isLatticeIssueStatus(value)
  }
}
