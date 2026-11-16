/**
 * 组合层：**24 个语义方法 + 1 个扩展（E1）**。这是协同插件真正会调的层。
 *
 * 三层纪律（与原子层的分界）：
 *  1. 每个方法只做"端点按固定顺序拼一次"，**不内部 sleep / 不重试到成功 / 不等远端变化**（D20）；
 *  2. 校验前置：能本地判的错一律**零请求**返回信封；
 *  3. 失败语义要可判：`status_conflict`（别重试）/ `update_rejected`（看 failed[]）/
 *     `read_back_failed`（已写入，带 `created`）。
 *
 * 与 raw 的 24 个方法一一对应；差异逐条记在 `docs/design/lattice-sdk-design.zh.md` §14。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'

import type { LatticeClient } from './client.js'
import { latticeFail, latticeOk, type LatticeErrorCode, type LatticeFail, type LatticeResult } from './result.js'
import {
  isLatticeIssueStatus,
  isLatticePermission,
  isLatticeUrgency,
  type LatticeAttachment,
  type LatticeAttachmentInput,
  type LatticeAttachmentType,
  type LatticeComment,
  type LatticeCommentAuthorType,
  type LatticeCommentIncrement,
  type LatticeCommentIncrementQuery,
  type LatticeCommentRole,
  type LatticeDevice,
  type LatticeDeviceWorkspace,
  type LatticeIssue,
  type LatticeIssueInput,
  type LatticeIssueStatus,
  type LatticeOs,
  type LatticePermission,
  type LatticeProject,
  type LatticeProjectMember,
  type LatticeSource,
  type LatticeSourceInput,
  type LatticeStatusFailure,
  type LatticeUrgency,
} from './types.js'
import { checkIssueId, toIsoLocal, toSourceCode } from './wire.js'
import { teamworkDefaultDevice, teamworkInstanceName, teamworkUserId } from './env.js'
import { mapLimit } from './net.js'

// ────────────────────────────────────────────────────────────────────────────
// 类型（对齐 raw 的组合层形状；见设计文档 §10.2）
// ────────────────────────────────────────────────────────────────────────────

export interface LatticeProjectMemberQuery {
  /** `true` = 只留能派活的角色（owner / manager） */
  manager?: boolean
}

export interface LatticeMyInstanceIssuesOptions {
  status?: LatticeIssueStatus
  pageSize?: number
  maxPages?: number
  os?: LatticeOs
  instance?: string
  userId?: string
}

export interface LatticeMyInstanceIssues {
  instance: string
  userId: string
  os: LatticeOs
  scanned: number
  pages: number
  truncated: boolean
  items: LatticeIssue[]
  unclaimed: LatticeIssue[]
  otherInstance: LatticeIssue[]
}

/** 附件规格：路径字符串，或带方向/描述的对象 */
export type LatticeIssueAttachmentSpec = string | { path: string; type?: LatticeAttachmentType; description?: string }

export interface LatticeIssueCreateInput {
  issueId?: string
  /** 顶层优先；缺省从 `assignerMeta.title` 兜底（D9） */
  title?: string
  detail?: string
  /** 兼容旧 API：**必须等于当前登录账号**（D18） */
  assigner?: string
  assignee: string
  /** 目标实例 `ip:port`（派给哪台机器；raw 的创建入参里有它） */
  assigneeInstance?: string
  assignerTask?: string
  assignerMeta?: string | Record<string, unknown> | unknown[]
  cwd?: string
  urgency?: LatticeUrgency
  permission?: LatticePermission | '' | null
  projectId?: number
  source?: string
  sourceInstance?: string
  dependsOn?: readonly string[] | null
  attachments?: readonly LatticeIssueAttachmentSpec[]
  /** 撞已有 `issueId` 时：默认 `skip`（读一次、一致就跳过，D13） */
  onExist?: 'skip' | 'overwrite'
}

export interface LatticeIssueCreateResult {
  issue: LatticeIssue
  attachments: LatticeAttachmentInput[]
  /** `true` = 命中已有记录被跳过（`onExist:'skip'`） */
  skipped: boolean
}

export interface LatticeIssueCreateManyResult {
  issues: LatticeIssue[]
  attachments: LatticeAttachmentInput[]
  skipped: string[]
}

export interface LatticeIssueUpdateStatusInput {
  issueId: string
  status: LatticeIssueStatus
  expectedStatus?: LatticeIssueStatus
  assigneeTask?: string
  assigneeInstance?: string
  assigneeMeta?: string | Record<string, unknown> | unknown[]
  assignedAt?: string
}

export interface LatticeIssueClaimResult {
  claimed: string[]
  failed: LatticeStatusFailure[]
  issues: LatticeIssue[]
}

export interface LatticeIssueAbandonResult {
  abandoned: string[]
  failed: LatticeStatusFailure[]
}

export interface LatticeIssueRoutingResult {
  routed: string[]
  failed: LatticeStatusFailure[]
}

export interface LatticeIssueFinalizeInput {
  status: 'success' | 'failed'
  assigneeMeta: string | Record<string, unknown> | unknown[]
  assigneeTask?: string
  attachments?: readonly LatticeIssueAttachmentSpec[]
}

export interface LatticeIssueFinalizeResult {
  issue: LatticeIssue
  attachments: LatticeAttachmentInput[]
}

export interface LatticeIssueRoutedInput {
  assigneeTask: string
  cwd: string
  assignerMeta: string | Record<string, unknown> | unknown[]
  urgency?: LatticeUrgency
  permission?: LatticePermission
  assignedAt?: string
}

export interface LatticeIssueAttachmentDownloadItem {
  attachment: LatticeAttachment
  path: string
  size: number
}

export interface LatticeIssueAttachmentDownloadFailure {
  fileId: string
  fileName: string
  code: LatticeErrorCode
  reason: string
}

export interface LatticeIssueAttachmentDownloadResult {
  outputDir: string
  downloaded: LatticeIssueAttachmentDownloadItem[]
  failed: LatticeIssueAttachmentDownloadFailure[]
}

export interface LatticeIssueAttachmentDownloadOptions {
  type?: LatticeAttachmentType
}

export interface LatticeIssueCommentInput {
  commentId: string
  content: string
  commentAt?: string
  commentRole?: LatticeCommentRole | (string & {})
  commentAuthorType?: LatticeCommentAuthorType | (string & {})
}

export interface LatticeIssueCommentFailure {
  index: number
  content: string
  code: LatticeErrorCode
  reason: string
}

export interface LatticeIssueAddCommentsResult {
  issueId: string
  written: number
  failed: LatticeIssueCommentFailure[]
}

export interface LatticeWorkspaceIndexInput {
  detail: string
  userId?: string
  instance?: string
}

export interface LatticeWorkspacePortalInput {
  workspaceId: string
  cwd: string
  detail: string
  userId?: string
  instance?: string
}

export interface LatticeWorkspacePortalQuery {
  workspaceId: string
  instance: string
  userId?: string
}

/** E1（本协议扩展）：依赖门禁用的批量状态查询 */
export interface LatticeIssueStatusesQuery {
  issueIds: readonly string[]
  /** 并发上限，默认 4（底座闸也是 4） */
  concurrency?: number
}

export type LatticeIssueStatuses = Record<string, LatticeIssueStatus | null>

/** 依赖门禁用的 ISO-8601 校验（服务端只写不校验格式，这里先拦） */
const ISO_LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?$/

// ────────────────────────────────────────────────────────────────────────────
// 内部助手
// ────────────────────────────────────────────────────────────────────────────

/** 未预期异常兜底：折成 `status:0 / internal_error`，绝不让 reject 冒出去 */
export async function guard<T>(name: string, fn: () => Promise<LatticeResult<T>>): Promise<LatticeResult<T>> {
  try {
    return await fn()
  } catch (err) {
    return latticeFail({
      status: 0,
      code: 'internal_error',
      reason: `${name} 未预期异常：${(err as Error).message}`,
    })
  }
}

/** 校验 `*Meta` 里的 title/detail（D9 的兜底来源） */
function metaTitleDetail(meta: unknown): { title?: string; detail?: string } {
  if (meta === null || meta === undefined) return {}
  if (typeof meta === 'string') {
    try {
      return metaTitleDetail(JSON.parse(meta) as unknown)
    } catch {
      return {}
    }
  }
  if (typeof meta !== 'object' || Array.isArray(meta)) return {}
  const raw = meta as Record<string, unknown>
  return {
    ...(typeof raw['title'] === 'string' ? { title: raw['title'] } : {}),
    ...(typeof raw['detail'] === 'string' ? { detail: raw['detail'] } : {}),
  }
}

/** 附件读盘：0 字节拒收（服务端 S3 会 400）；返回可上传的字节与文件名 */
async function readAttachmentFile(path: string): Promise<{ name: string; bytes: Uint8Array } | { fail: LatticeFail }> {
  try {
    const info = await stat(path)
    if (info.isDirectory()) {
      return {
        fail: latticeFail({ status: 400, code: 'invalid_attachment', reason: `附件是目录，不能上传：${path}`, field: 'attachments' }),
      }
    }
    if (info.size === 0) {
      return {
        fail: latticeFail({
          status: 400,
          code: 'invalid_attachment',
          reason: `附件是 0 字节，会被服务端拒收：${path}`,
          field: 'attachments',
        }),
      }
    }
    const bytes = new Uint8Array(await readFile(path))
    return { name: basename(path), bytes }
  } catch (err) {
    return {
      fail: latticeFail({
        status: 400,
        code: 'invalid_attachment',
        reason: `附件读盘失败：${path}（${(err as Error).message}）`,
        field: 'attachments',
      }),
    }
  }
}

/** 输出文件名安全化：只取 basename、Windows 非法字符换 `_`、挡 `.` / `..` */
function toSafeFileName(raw: string, fallback: string): string {
  const base = String(raw).split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback
  return cleaned.slice(0, 180)
}

/** 本机平台默认值 */
function defaultOs(): LatticeOs {
  return process.platform === 'win32' ? 'windows' : 'linux'
}

/** E1 的并发夹取 */
function clampConcurrency(value: number | undefined): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 4
  return n < 1 ? 1 : n > 8 ? 8 : n
}

// ────────────────────────────────────────────────────────────────────────────
// 1–4：查询类
// ────────────────────────────────────────────────────────────────────────────

export async function queryMyProjects(client: LatticeClient): Promise<LatticeResult<LatticeProject[]>> {
  return guard('latticeMyProjects', () => client.project.list())
}

export async function queryProjectMembers(
  client: LatticeClient,
  projectId: number | string,
  options: LatticeProjectMemberQuery = {},
): Promise<LatticeResult<LatticeProjectMember[]>> {
  return guard('latticeProjectMembers', async () => {
    const result = await client.project.members(projectId)
    if (!result.ok) return result
    if (options.manager !== true) return result
    return latticeOk(
      result.status,
      result.data.filter((member) => member.role === 'owner' || member.role === 'manager'),
    )
  })
}

export async function queryUserDevices(client: LatticeClient, userId: string): Promise<LatticeResult<LatticeDevice[]>> {
  return guard('latticeUserDevices', () => client.device.list(userId))
}

export async function queryMyInstanceIssues(
  client: LatticeClient,
  options: LatticeMyInstanceIssuesOptions = {},
): Promise<LatticeResult<LatticeMyInstanceIssues>> {
  return guard('latticeMyInstanceIssues', async () => {
    const userId = options.userId ?? client.userId ?? teamworkUserId()
    const instance = options.instance ?? client.instance ?? teamworkInstanceName()
    const os = options.os ?? client.os ?? defaultOs()
    if (userId === undefined || userId === '') {
      return latticeFail({
        status: 400,
        code: 'invalid_user_id',
        reason: 'latticeMyInstanceIssues 需要账号：client 没有登录，也没有显式传 userId',
      })
    }
    const pageSize = Math.min(200, Math.max(1, Math.floor(options.pageSize ?? 200)))
    const maxPages = Math.max(1, Math.floor(options.maxPages ?? 1000))

    const items: LatticeIssue[] = []
    const unclaimed: LatticeIssue[] = []
    const otherInstance: LatticeIssue[] = []
    let scanned = 0
    let pages = 0
    let truncated = false

    for (;;) {
      if (pages >= maxPages) {
        truncated = true
        break
      }
      const page = await client.issue.list({ status: options.status, pageNum: pages + 1, pageSize })
      if (!page.ok) return page
      pages += 1
      const batch = page.data.items
      scanned += batch.length
      for (const issue of batch) {
        if (issue.assignee !== userId) continue
        const sameInstance =
          os === 'windows'
            ? issue.assigneeInstance === instance || issue.assigneeInstance === null
            : issue.assigneeInstance === instance
        if (sameInstance) {
          items.push(issue)
          if (issue.status === 'pending' && issue.assigneeInstance === null) unclaimed.push(issue)
        } else {
          otherInstance.push(issue)
        }
      }
      if (batch.length === 0) break
      if (scanned >= page.data.total) break
      if (batch.length < pageSize) break
    }

    return latticeOk(200, {
      instance,
      userId,
      os,
      scanned,
      pages,
      truncated,
      items,
      unclaimed,
      otherInstance,
    })
  })
}

// ────────────────────────────────────────────────────────────────────────────
// 5：创建（单条 / 批量）
// ────────────────────────────────────────────────────────────────────────────

interface NormalizedCreate {
  issueId: string
  input: LatticeIssueInput
  attachments: readonly LatticeIssueAttachmentSpec[]
  onExist: 'skip' | 'overwrite'
  /** `true` = issueId 是本地现生成的（不会撞已有记录，省一次 GET） */
  generated: boolean
}

function validateCreateInput(
  raw: LatticeIssueCreateInput,
  index: number,
  currentAccountId: string | null,
): { ok: true; value: NormalizedCreate } | { ok: false; fail: LatticeFail } {
  const where = index < 0 ? 'issueCreate' : `issueCreateMany[${index}]`
  const meta = metaTitleDetail(raw.assignerMeta)
  const title = typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title : meta.title
  if (title === undefined || title.trim() === '') {
    return {
      ok: false,
      fail: latticeFail({
        status: 400,
        code: 'invalid_request',
        reason: `issueCreate 的 title 必填（可用顶层 title，或 assignerMeta.title）`,
        field: 'title',
      }),
    }
  }
  if (title.length > 200) {
    return { ok: false, fail: latticeFail({ status: 400, code: 'invalid_title', reason: 'title 最多 200 个字符', field: 'title' }) }
  }
  const assignee = typeof raw.assignee === 'string' ? raw.assignee.trim() : ''
  if (assignee === '') {
    return {
      ok: false,
      fail: latticeFail({
        status: 400,
        code: 'invalid_request',
        reason: 'issueCreate 的 assignee 必填（责任人账号）',
        field: 'assignee',
      }),
    }
  }
  if (raw.assigner !== undefined && currentAccountId !== null && raw.assigner !== currentAccountId) {
    return {
      ok: false,
      fail: latticeFail({
        status: 400,
        code: 'invalid_body',
        reason: `issueCreate 的 assigner 恒为当前登录账号（本协议身份只来自 token），收到 ${raw.assigner}`,
        field: 'assigner',
      }),
    }
  }
  if (raw.urgency !== undefined && !isLatticeUrgency(raw.urgency)) {
    return { ok: false, fail: latticeFail({ status: 400, code: 'invalid_urgency', reason: 'urgency 取值不合法', field: 'urgency' }) }
  }
  if (raw.permission !== undefined && raw.permission !== '' && raw.permission !== null && !isLatticePermission(raw.permission)) {
    return { ok: false, fail: latticeFail({ status: 400, code: 'invalid_permission', reason: 'permission 取值不合法', field: 'permission' }) }
  }
  if (raw.cwd !== undefined && raw.cwd !== null && raw.cwd.length > 500) {
    return {
      ok: false,
      fail: latticeFail({ status: 400, code: 'invalid_request', reason: 'issueCreate 的 cwd 最多 500 个字符', field: 'cwd' }),
    }
  }
  if (raw.source !== undefined) {
    const code = toSourceCode(raw.source)
    if (!code.ok) return { ok: false, fail: code.fail }
  }
  const issueId = raw.issueId ?? randomUUID()
  const checked = checkIssueId(issueId, where)
  if (checked !== null) return { ok: false, fail: checked }

  const input: LatticeIssueInput = {
    issueId,
    title,
    ...(raw.detail === undefined ? (meta.detail === undefined ? {} : { detail: meta.detail }) : { detail: raw.detail }),
    assignee,
    ...(raw.projectId === undefined ? {} : { projectId: raw.projectId }),
    ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
    ...(raw.urgency === undefined ? {} : { urgency: raw.urgency }),
    ...(raw.permission === undefined ? {} : { permission: raw.permission }),
    ...(raw.source === undefined ? {} : { source: raw.source }),
    ...(raw.sourceInstance === undefined ? {} : { sourceInstance: raw.sourceInstance }),
    ...(raw.assigneeInstance === undefined ? {} : { assigneeInstance: raw.assigneeInstance }),
    ...(raw.assignerTask === undefined ? {} : { assignerTask: raw.assignerTask }),
    ...(raw.assignerMeta === undefined ? {} : { assignerMeta: raw.assignerMeta }),
    ...(raw.dependsOn === undefined ? {} : { dependsOn: raw.dependsOn }),
    // 拒绝 status / assignedAt / assigneeTask：本协议创建时不该由调用方指定
  }
  return {
    ok: true,
    value: {
      issueId,
      input,
      attachments: raw.attachments ?? [],
      onExist: raw.onExist ?? 'skip',
      generated: raw.issueId === undefined,
    },
  }
}

/** 来源字典自愈：给定 code 不存在就注册一次，再读回 */
async function ensureSource(client: LatticeClient, code: string): Promise<LatticeResult<LatticeSource>> {
  const listed = await client.issue.source.list(code)
  if (!listed.ok) return listed
  const hit = listed.data.find((item) => item.code === code)
  if (hit !== undefined) return latticeOk(listed.status, hit)
  const registered = await client.issue.source.register([{ code }])
  if (!registered.ok) return registered
  const again = await client.issue.source.list(code)
  if (!again.ok) return again
  const created = again.data.find((item) => item.code === code)
  if (created === undefined) {
    return latticeFail({
      status: 200,
      code: 'read_back_failed',
      reason: `来源 ${code} 注册后仍读不到`,
    })
  }
  return latticeOk(200, created)
}

export async function issueCreateMany(
  client: LatticeClient,
  inputs: readonly LatticeIssueCreateInput[],
): Promise<LatticeResult<LatticeIssueCreateManyResult>> {
  return guard('issueCreateMany', async () => {
    if (inputs.length === 0) return latticeOk(200, { issues: [], attachments: [], skipped: [] })

    // ① 本地校验：任一条不合格 → 整批不发
    const normalized: NormalizedCreate[] = []
    for (const [index, raw] of inputs.entries()) {
      const checked = validateCreateInput(raw, index, client.accountId)
      if (!checked.ok) return checked.fail
      normalized.push(checked.value)
    }

    // ② 撞已有 issueId：默认跳过（D13：C1 的 upsert 会把 status 打回 pending）。
    //    本地现生成的 issueId 不可能已存在，省一次 GET。
    const skipped: string[] = []
    const toSubmit: NormalizedCreate[] = []
    for (const item of normalized) {
      if (item.generated || item.onExist === 'overwrite') {
        toSubmit.push(item)
        continue
      }
      const existing = await client.issue.get(item.issueId)
      if (existing.ok) {
        skipped.push(item.issueId)
        continue
      }
      toSubmit.push(item)
    }

    // ③ 来源字典（去重后逐个 ensure）
    const sources = [...new Set(normalized.map((item) => item.input.source).filter((code): code is string => typeof code === 'string'))]
    for (const code of sources) {
      const ensured = await ensureSource(client, code)
      if (!ensured.ok) return ensured
    }

    // ④ 附件先上传（先传后建，避免"issue 存在但引用了不存在的文件"）
    const uploaded: { issueId: string; attachment: LatticeAttachmentInput }[] = []
    for (const item of toSubmit) {
      for (const spec of item.attachments) {
        const path = typeof spec === 'string' ? spec : spec.path
        const type: LatticeAttachmentType = typeof spec === 'string' ? 'input' : (spec.type ?? 'input')
        const description = typeof spec === 'string' ? undefined : spec.description
        const read = await readAttachmentFile(path)
        if ('fail' in read) return read.fail
        const up = await client.file.upload({ name: read.name, data: read.bytes })
        if (!up.ok) return up
        uploaded.push({
          issueId: item.issueId,
          attachment: {
            issueId: item.issueId,
            fileId: up.data.fileId,
            fileName: up.data.fileName,
            type,
            ...(description === undefined ? {} : { description }),
          },
        })
      }
    }

    // ⑤ 提交（只发未跳过的）
    const submitted = toSubmit.length === 0 ? latticeOk(200, [] as string[]) : await client.issue.submit(toSubmit.map((item) => item.input))
    if (!submitted.ok) return submitted
    const createdIds = submitted.data

    // ⑥ 挂附件关系
    if (uploaded.length > 0) {
      const attached = await client.issue.attachment.add(uploaded.map((item) => item.attachment))
      if (!attached.ok) {
        return latticeFail({
          status: attached.status,
          code: 'read_back_failed',
          reason: `issue 已创建但附件关联失败：${attached.code}: ${attached.reason}`,
          body: attached.body,
          created: [...createdIds, ...skipped],
        })
      }
    }

    // ⑦ 读回完整记录
    const issues: LatticeIssue[] = []
    for (const issueId of createdIds) {
      const got = await client.issue.get(issueId)
      if (!got.ok) {
        return latticeFail({
          status: got.status,
          code: 'read_back_failed',
          reason: `issue 已创建但读回失败：${got.code}: ${got.reason}`,
          created: createdIds,
        })
      }
      issues.push(got.data)
    }

    // 被跳过的也读回（调用方拿到的应当是完整记录）
    for (const issueId of skipped) {
      const got = await client.issue.get(issueId)
      if (got.ok) issues.push(got.data)
    }
    if (issues.length === 0 && createdIds.length === 0 && skipped.length > 0) {
      return latticeFail({ status: 200, code: 'read_back_failed', reason: 'issueCreate 提交成功但没拿到创建后的记录（服务端返回空数组）' })
    }

    return latticeOk(200, { issues, attachments: uploaded.map((item) => item.attachment), skipped })
  })
}

export async function issueCreate(
  client: LatticeClient,
  input: LatticeIssueCreateInput,
): Promise<LatticeResult<LatticeIssueCreateResult>> {
  return guard('issueCreate', async () => {
    const result = await issueCreateMany(client, [input])
    if (!result.ok) return result
    const issue = result.data.issues[0]
    if (issue === undefined) {
      return latticeFail({
        status: 200,
        code: 'read_back_failed',
        reason: 'issueCreate 提交成功但没拿到创建后的记录（服务端返回空数组）',
      })
    }
    return latticeOk(200, {
      issue,
      attachments: result.data.attachments,
      skipped: result.data.skipped.includes(issue.issueId),
    })
  })
}

// ────────────────────────────────────────────────────────────────────────────
// 6–9：状态推进
// ────────────────────────────────────────────────────────────────────────────

export async function issueUpdateStatus(
  client: LatticeClient,
  input: LatticeIssueUpdateStatusInput,
): Promise<LatticeResult<LatticeIssue>> {
  return guard('issueUpdateStatus', async () => {
    const checked = checkIssueId(input.issueId, 'issueUpdateStatus')
    if (checked !== null) return checked
    if (!isLatticeIssueStatus(input.status)) {
      return latticeFail({
        status: 400,
        code: 'invalid_status',
        reason: 'status 必须是 pending / accepted / routing / running / success / failed / abandoned',
        field: 'status',
      })
    }
    if (input.expectedStatus !== undefined && !isLatticeIssueStatus(input.expectedStatus)) {
      return latticeFail({ status: 400, code: 'invalid_status', reason: 'expectedStatus 取值不合法', field: 'expectedStatus' })
    }
    if (input.assignedAt !== undefined && !ISO_LOCAL_DATETIME.test(input.assignedAt)) {
      return latticeFail({
        status: 400,
        code: 'invalid_datetime',
        reason: 'issueUpdateStatus 的 assignedAt 必须是 ISO-8601 时间（如 2025-06-16T10:12:30）',
        field: 'assignedAt',
      })
    }
    const updated = await client.issue.updateStatuses([
      {
        issueId: input.issueId,
        status: input.status,
        ...(input.expectedStatus === undefined ? {} : { expectedStatus: input.expectedStatus }),
        ...(input.assigneeTask === undefined ? {} : { assigneeTask: input.assigneeTask }),
        ...(input.assigneeInstance === undefined ? {} : { assigneeInstance: input.assigneeInstance }),
        ...(input.assigneeMeta === undefined ? {} : { assigneeMeta: input.assigneeMeta }),
        ...(input.assignedAt === undefined ? {} : { assignedAt: input.assignedAt }),
      },
    ])
    if (!updated.ok) return updated
    if (updated.data.failed.length > 0) {
      const failure = updated.data.failed[0]!
      return latticeFail({
        status: updated.status,
        code: 'update_rejected',
        reason: `issueUpdateStatus 被拒（${failure.reason}）`,
        field: 'issueId',
      })
    }
    return client.issue.get(input.issueId)
  })
}

export async function issueClaim(client: LatticeClient, issueIds: readonly string[]): Promise<LatticeResult<LatticeIssueClaimResult>> {
  return guard('issueClaim', async () => {
    if (issueIds.length === 0) return latticeOk(200, { claimed: [], failed: [], issues: [] })
    for (const [index, issueId] of issueIds.entries()) {
      const checked = checkIssueId(issueId, `issueClaim[${index}]`)
      if (checked !== null) return checked
    }
    const instance = client.instance ?? teamworkInstanceName()
    if (instance === '') {
      return latticeFail({
        status: 400,
        code: 'invalid_user_id',
        reason: '解析不到 instance（ip:port）：没传，也没解析到本机实例标识',
      })
    }
    const updated = await client.issue.updateStatuses(
      issueIds.map((issueId) => ({
        issueId,
        status: 'accepted' as const,
        expectedStatus: 'pending' as const,
        assigneeInstance: instance,
      })),
    )
    if (!updated.ok) return updated
    const failedIds = new Set(updated.data.failed.map((item) => item.issueId))
    const claimed = issueIds.filter((issueId) => !failedIds.has(issueId))
    const issues: LatticeIssue[] = []
    for (const issueId of claimed) {
      const got = await client.issue.get(issueId)
      if (got.ok) issues.push(got.data)
    }
    return latticeOk(200, { claimed, failed: updated.data.failed, issues })
  })
}

export async function issueAbandon(client: LatticeClient, issueIds: readonly string[]): Promise<LatticeResult<LatticeIssueAbandonResult>> {
  return guard('issueAbandon', async () => {
    if (issueIds.length === 0) return latticeOk(200, { abandoned: [], failed: [] })
    for (const [index, issueId] of issueIds.entries()) {
      const checked = checkIssueId(issueId, `issueAbandon[${index}]`)
      if (checked !== null) return checked
    }
    const updated = await client.issue.updateStatuses(issueIds.map((issueId) => ({ issueId, status: 'abandoned' as const })))
    if (!updated.ok) return updated
    const failedIds = new Set(updated.data.failed.map((item) => item.issueId))
    return latticeOk(200, { abandoned: issueIds.filter((issueId) => !failedIds.has(issueId)), failed: updated.data.failed })
  })
}

export async function issueRouting(client: LatticeClient, issueIds: readonly string[]): Promise<LatticeResult<LatticeIssueRoutingResult>> {
  return guard('issueRouting', async () => {
    if (issueIds.length === 0) return latticeOk(200, { routed: [], failed: [] })
    for (const [index, issueId] of issueIds.entries()) {
      const checked = checkIssueId(issueId, `issueRouting[${index}]`)
      if (checked !== null) return checked
    }
    const assignedAt = new Date().toISOString()
    const updated = await client.issue.updateStatuses(
      issueIds.map((issueId) => ({ issueId, status: 'routing' as const, assignedAt })),
    )
    if (!updated.ok) return updated
    const failedIds = new Set(updated.data.failed.map((item) => item.issueId))
    return latticeOk(200, { routed: issueIds.filter((issueId) => !failedIds.has(issueId)), failed: updated.data.failed })
  })
}

export async function issueRunning(client: LatticeClient, issueId: string): Promise<LatticeResult<LatticeIssue>> {
  return guard('issueRunning', () => issueUpdateStatus(client, { issueId, status: 'running' }))
}

export async function issueFinalize(
  client: LatticeClient,
  issueId: string,
  input: LatticeIssueFinalizeInput,
): Promise<LatticeResult<LatticeIssueFinalizeResult>> {
  return guard('issueFinalize', async () => {
    const checked = checkIssueId(issueId, 'issueFinalize')
    if (checked !== null) return checked
    if (input.status !== 'success' && input.status !== 'failed') {
      return latticeFail({ status: 400, code: 'invalid_status', reason: 'issueFinalize 的 status 只能是 success / failed', field: 'status' })
    }
    if (input.assigneeMeta === undefined || input.assigneeMeta === null) {
      return latticeFail({
        status: 400,
        code: 'invalid_meta',
        reason: 'issueFinalize 的 assigneeMeta 必填（执行结果 JSON）',
        field: 'assigneeMeta',
      })
    }

    // ① 产物先上传（先传再改状态：状态一变就可能被展示，此时不该缺产物）
    const attachments: LatticeAttachmentInput[] = []
    for (const spec of input.attachments ?? []) {
      const path = typeof spec === 'string' ? spec : spec.path
      const description = typeof spec === 'string' ? undefined : spec.description
      const read = await readAttachmentFile(path)
      if ('fail' in read) return read.fail
      const up = await client.file.upload({ name: read.name, data: read.bytes })
      if (!up.ok) return up
      attachments.push({
        issueId,
        fileId: up.data.fileId,
        fileName: up.data.fileName,
        type: typeof spec === 'string' ? 'output' : (spec.type ?? 'output'),
        ...(description === undefined ? {} : { description }),
      })
    }

    // ② 改状态（失败则整条失败，状态不变）
    const statusInput: LatticeIssueUpdateStatusInput = {
      issueId,
      status: input.status,
      assigneeMeta: input.assigneeMeta,
      assignedAt: new Date().toISOString(),
      ...(input.assigneeTask === undefined ? {} : { assigneeTask: input.assigneeTask }),
    }
    const updated = await issueUpdateStatus(client, statusInput)
    if (!updated.ok) return updated

    // ③ 挂产物
    if (attachments.length > 0) {
      const attached = await client.issue.attachment.add(attachments)
      if (!attached.ok) {
        return latticeFail({
          status: attached.status,
          code: 'read_back_failed',
          reason: `issue 状态已改但产物挂载失败：${attached.code}: ${attached.reason}`,
          created: [issueId],
        })
      }
    }

    // ④ 读回
    const got = await client.issue.get(issueId)
    if (!got.ok) {
      return latticeFail({
        status: got.status,
        code: 'read_back_failed',
        reason: `issue 已收尾但读回失败：${got.code}: ${got.reason}`,
        created: [issueId],
      })
    }
    return latticeOk(200, { issue: got.data, attachments })
  })
}

export async function issueRouted(
  client: LatticeClient,
  issueId: string,
  input: LatticeIssueRoutedInput,
): Promise<LatticeResult<LatticeIssue>> {
  return guard('issueRouted', async () => {
    const checked = checkIssueId(issueId, 'issueRouted')
    if (checked !== null) return checked
    if (typeof input.assigneeTask !== 'string' || input.assigneeTask.trim() === '') {
      return latticeFail({
        status: 400,
        code: 'invalid_request',
        reason: 'issueRouted 的 assigneeTask 必填（这个 issue 最终转成了哪个 task）',
        field: 'assigneeTask',
      })
    }
    if (typeof input.cwd !== 'string' || input.cwd.trim() === '' || input.cwd.length > 500) {
      return latticeFail({ status: 400, code: 'invalid_request', reason: 'issueRouted 的 cwd 必填（≤500）', field: 'cwd' })
    }
    if (input.urgency !== undefined && !isLatticeUrgency(input.urgency)) {
      return latticeFail({ status: 400, code: 'invalid_urgency', reason: 'urgency 取值不合法', field: 'urgency' })
    }
    if (input.permission !== undefined && !isLatticePermission(input.permission)) {
      return latticeFail({
        status: 400,
        code: 'invalid_permission',
        reason: 'permission 必须是 read-only / workspace-write / danger-full-access',
        field: 'permission',
      })
    }
    if (input.assignerMeta === undefined || input.assignerMeta === null) {
      return latticeFail({
        status: 400,
        code: 'invalid_meta',
        reason: 'issueRouted 的 assignerMeta 必填（诉求内容 JSON）',
        field: 'assignerMeta',
      })
    }
    if (input.assignedAt !== undefined && !ISO_LOCAL_DATETIME.test(input.assignedAt)) {
      return latticeFail({
        status: 400,
        code: 'invalid_datetime',
        reason: 'issueRouted 的 assignedAt 必须是 ISO-8601 时间（如 2025-06-16T10:12:30）',
        field: 'assignedAt',
      })
    }

    // ① 状态门：只允许 accepted / routing
    const current = await client.issue.get(issueId)
    if (!current.ok) return current
    if (current.data.status !== 'accepted' && current.data.status !== 'routing') {
      return latticeFail({
        status: 400,
        code: 'invalid_request',
        reason: `issueRouted 只能在 accepted / routing 状态下调用，当前 ${current.data.status}`,
        field: 'status',
      })
    }

    // ② 只发改动字段（本协议 PUT 是 undefined→保留，不需要旧实现那种"原值回填"）
    const patch: LatticeIssueInput = {
      assigneeTask: input.assigneeTask,
      cwd: input.cwd,
      assignerMeta: input.assignerMeta,
      ...(input.urgency === undefined ? {} : { urgency: input.urgency }),
      ...(input.permission === undefined ? {} : { permission: input.permission }),
      ...(input.assignedAt === undefined ? {} : { assignedAt: input.assignedAt }),
    }
    const replaced = await client.issue.replace(issueId, patch)
    if (!replaced.ok) return replaced
    return replaced
  })
}

// ────────────────────────────────────────────────────────────────────────────
// 10：来源字典
// ────────────────────────────────────────────────────────────────────────────

export async function latticeIssueSources(client: LatticeClient, code?: string): Promise<LatticeResult<LatticeSource[]>> {
  return guard('latticeIssueSources', () => client.issue.source.list(code))
}

export async function latticeAddIssueSource(client: LatticeClient, input: LatticeSourceInput): Promise<LatticeResult<LatticeSource>> {
  return guard('latticeAddIssueSource', () => ensureSource(client, input.code))
}

// ────────────────────────────────────────────────────────────────────────────
// 11：附件下载
// ────────────────────────────────────────────────────────────────────────────

export async function latticeDownloadIssueAttachments(
  client: LatticeClient,
  issueId: string,
  outputDir: string,
  options: LatticeIssueAttachmentDownloadOptions = {},
): Promise<LatticeResult<LatticeIssueAttachmentDownloadResult>> {
  return guard('latticeDownloadIssueAttachments', async () => {
    const checked = checkIssueId(issueId, 'latticeDownloadIssueAttachments')
    if (checked !== null) return checked
    const listed = await client.issue.attachment.list(issueId, options.type)
    if (!listed.ok) return listed
    try {
      await mkdir(outputDir, { recursive: true })
    } catch (err) {
      return latticeFail({ status: 400, code: 'invalid_path', reason: `输出目录不合法：${outputDir}`, field: 'outputDir' })
    }

    const downloaded: LatticeIssueAttachmentDownloadItem[] = []
    const failed: LatticeIssueAttachmentDownloadFailure[] = []
    const usedNames = new Set<string>()

    for (const attachment of listed.data) {
      const got = await client.file.download(attachment.fileId)
      if (!got.ok) {
        failed.push({ fileId: attachment.fileId, fileName: attachment.fileName ?? attachment.fileId, code: got.code, reason: got.reason })
        continue
      }
      const fallback = attachment.fileId
      let name = toSafeFileName(attachment.fileName ?? fallback, fallback)
      if (usedNames.has(name)) {
        const dot = name.lastIndexOf('.')
        const stem = dot > 0 ? name.slice(0, dot) : name
        const ext = dot > 0 ? name.slice(dot) : ''
        let suffix = 2
        while (usedNames.has(`${stem}-${suffix}${ext}`)) suffix += 1
        name = `${stem}-${suffix}${ext}`
      }
      usedNames.add(name)
      const path = join(outputDir, name)
      try {
        await writeFile(path, got.data)
      } catch (err) {
        failed.push({
          fileId: attachment.fileId,
          fileName: name,
          code: 'invalid_path',
          reason: `附件落盘失败：${path}（${(err as Error).message}）`,
        })
        continue
      }
      downloaded.push({ attachment, path, size: got.data.byteLength })
    }

    return latticeOk(200, { outputDir, downloaded, failed })
  })
}

// ────────────────────────────────────────────────────────────────────────────
// 12：评论
// ────────────────────────────────────────────────────────────────────────────

export async function latticeIssueComments(client: LatticeClient, issueId: string): Promise<LatticeResult<LatticeComment[]>> {
  return guard('latticeIssueComments', () => client.issue.comment.list(issueId))
}

export async function latticeAddIssueComments(
  client: LatticeClient,
  issueId: string,
  comments: readonly LatticeIssueCommentInput[],
): Promise<LatticeResult<LatticeIssueAddCommentsResult>> {
  return guard('latticeAddIssueComments', async () => {
    const checked = checkIssueId(issueId, 'latticeAddIssueComments')
    if (checked !== null) return checked
    if (comments.length === 0) return latticeOk(200, { issueId, written: 0, failed: [] })

    // 整批校验：任一条不合格 → 一条都不发
    for (const [index, comment] of comments.entries()) {
      if (typeof comment.commentId !== 'string' || comment.commentId.trim() === '' || comment.commentId.length > 100) {
        return latticeFail({
          status: 400,
          code: 'invalid_request',
          reason: `评论 ${index} 的 commentId 必填（幂等键，重试必须复用）`,
          field: 'commentId',
        })
      }
      if (typeof comment.content !== 'string' || comment.content.length < 1 || comment.content.length > 10000) {
        return latticeFail({ status: 400, code: 'invalid_content', reason: '评论内容必须是 1..10000 个字符', field: 'content' })
      }
      if (comment.commentAt !== undefined && !ISO_LOCAL_DATETIME.test(comment.commentAt)) {
        return latticeFail({
          status: 400,
          code: 'invalid_datetime',
          reason: 'commentAt 必须是 ISO-8601 时间（如 2025-06-16T10:12:30）',
          field: 'commentAt',
        })
      }
    }

    // 逐条发送：单条失败只进 failed[]
    let written = 0
    const failed: LatticeIssueCommentFailure[] = []
    for (const [index, comment] of comments.entries()) {
      const result = await client.issue.comment.add(issueId, {
        commentId: comment.commentId,
        content: comment.content,
        ...(comment.commentAt === undefined ? {} : { commentAt: comment.commentAt }),
        ...(comment.commentRole === undefined ? {} : { commentRole: comment.commentRole }),
        ...(comment.commentAuthorType === undefined ? {} : { commentAuthorType: comment.commentAuthorType }),
      })
      if (result.ok) {
        written += 1
        continue
      }
      failed.push({ index, content: comment.content, code: result.code, reason: result.reason })
    }
    return latticeOk(200, { issueId, written, failed })
  })
}

export async function latticeCommentsSince(
  client: LatticeClient,
  query: LatticeCommentIncrementQuery = {},
): Promise<LatticeResult<LatticeCommentIncrement>> {
  return guard('latticeCommentsSince', () => client.issue.comment.listSince(query))
}

export async function latticeCommentCursor(client: LatticeClient): Promise<LatticeResult<number>> {
  return guard('latticeCommentCursor', () => client.issue.comment.cursor())
}

// ────────────────────────────────────────────────────────────────────────────
// 13：工作区肖像
// ────────────────────────────────────────────────────────────────────────────

function resolveWorkspaceUser(client: LatticeClient, userId?: string): string | null {
  const resolved = userId ?? client.userId ?? teamworkUserId()
  return resolved === undefined || resolved === '' ? null : resolved
}

function resolveWorkspaceInstance(client: LatticeClient, instance?: string): string | null {
  const resolved = instance ?? client.instance ?? teamworkInstanceName()
  return resolved === '' ? null : resolved
}

/** 上报后读回那一条（`index` 用 `workspaceId === null` 定位） */
async function readBackWorkspace(
  client: LatticeClient,
  query: { accountId: string; instance: string; workspaceId?: string; type: 'index' | 'portal' },
): Promise<LatticeResult<LatticeDeviceWorkspace>> {
  const listed = await client.issue.workspace.list({
    accountId: query.accountId,
    instance: query.instance,
    type: query.type,
    ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }),
  })
  if (!listed.ok) return listed
  const hit = listed.data.find(
    (row) =>
      row.instance === query.instance &&
      (query.workspaceId === undefined ? row.workspaceId === null : row.workspaceId === query.workspaceId),
  )
  if (hit === undefined) {
    return latticeFail({ status: 200, code: 'read_back_failed', reason: '工作区上报后读不到那一条记录' })
  }
  return latticeOk(200, hit)
}

export async function latticeWorkspaceIndexes(
  client: LatticeClient,
  userId?: string,
): Promise<LatticeResult<LatticeDeviceWorkspace[]>> {
  return guard('latticeWorkspaceIndexes', async () => {
    const user = resolveWorkspaceUser(client, userId)
    if (user === null) {
      return latticeFail({
        status: 400,
        code: 'invalid_user_id',
        reason: 'latticeWorkspaceIndexes 解析不到 userId：没传，也没从登录会话/环境解析到账号',
      })
    }
    return client.issue.workspace.list({ accountId: user, type: 'index' })
  })
}

export async function latticeWorkspacePortal(
  client: LatticeClient,
  query: LatticeWorkspacePortalQuery,
): Promise<LatticeResult<LatticeDeviceWorkspace | null>> {
  return guard('latticeWorkspacePortal', async () => {
    if (typeof query.instance !== 'string' || query.instance.trim() === '') {
      return latticeFail({
        status: 400,
        code: 'invalid_body',
        reason: 'latticeWorkspacePortal 的 instance 必填（ip:port）—— 要查的是哪台机器上的工作区',
        field: 'instance',
      })
    }
    if (typeof query.workspaceId !== 'string' || query.workspaceId.trim() === '') {
      return latticeFail({
        status: 400,
        code: 'invalid_body',
        reason: 'latticeWorkspacePortal 的 workspaceId 必填',
        field: 'workspaceId',
      })
    }
    const user = resolveWorkspaceUser(client, query.userId)
    if (user === null) {
      return latticeFail({
        status: 400,
        code: 'invalid_user_id',
        reason: 'latticeWorkspacePortal 解析不到 userId：没传，也没从登录会话/环境解析到账号',
      })
    }
    const listed = await client.issue.workspace.list({
      accountId: user,
      instance: query.instance,
      workspaceId: query.workspaceId,
      type: 'portal',
    })
    if (!listed.ok) return listed
    const hit = listed.data.find((row) => row.workspaceId === query.workspaceId)
    return latticeOk(200, hit ?? null)
  })
}

export async function latticeUpsertWorkspaceIndex(
  client: LatticeClient,
  input: LatticeWorkspaceIndexInput,
): Promise<LatticeResult<LatticeDeviceWorkspace>> {
  return guard('latticeUpsertWorkspaceIndex', async () => {
    const user = resolveWorkspaceUser(client, input.userId)
    if (user === null) {
      return latticeFail({
        status: 400,
        code: 'invalid_user_id',
        reason: '解析不到 userId：没传，也没从登录会话/环境解析到账号',
      })
    }
    const instance = resolveWorkspaceInstance(client, input.instance)
    if (instance === null) {
      return latticeFail({
        status: 400,
        code: 'invalid_body',
        reason: '解析不到 instance（ip:port）：没传，也没解析到本机实例标识',
      })
    }
    const upserted = await client.issue.workspace.upsert({ instance, type: 'index', detail: input.detail })
    if (!upserted.ok) return upserted
    return readBackWorkspace(client, { accountId: user, instance, type: 'index' })
  })
}

export async function latticeUpsertWorkspacePortal(
  client: LatticeClient,
  input: LatticeWorkspacePortalInput,
): Promise<LatticeResult<LatticeDeviceWorkspace>> {
  return guard('latticeUpsertWorkspacePortal', async () => {
    if (typeof input.workspaceId !== 'string' || input.workspaceId.trim() === '') {
      return latticeFail({
        status: 400,
        code: 'invalid_workspace_shape',
        reason: 'latticeUpsertWorkspacePortal 需要 workspaceId 与 cwd（portal 形状）',
        field: 'workspaceId',
      })
    }
    const user = resolveWorkspaceUser(client, input.userId)
    if (user === null) {
      return latticeFail({
        status: 400,
        code: 'invalid_user_id',
        reason: '解析不到 userId：没传，也没从登录会话/环境解析到账号',
      })
    }
    const instance = resolveWorkspaceInstance(client, input.instance)
    if (instance === null) {
      return latticeFail({
        status: 400,
        code: 'invalid_body',
        reason: '解析不到 instance（ip:port）：没传，也没解析到本机实例标识',
      })
    }
    const upserted = await client.issue.workspace.upsert({
      instance,
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      type: 'portal',
      detail: input.detail,
    })
    if (!upserted.ok) return upserted
    return readBackWorkspace(client, { accountId: user, instance, type: 'portal', workspaceId: input.workspaceId })
  })
}

// ────────────────────────────────────────────────────────────────────────────
// E1（扩展）：依赖门禁
// ────────────────────────────────────────────────────────────────────────────

export async function latticeIssueStatuses(
  client: LatticeClient,
  query: LatticeIssueStatusesQuery,
): Promise<LatticeResult<LatticeIssueStatuses>> {
  return guard('latticeIssueStatuses', async () => {
    const unique = [...new Set(query.issueIds)]
    if (unique.length === 0) return latticeOk(200, {})
    for (const [index, issueId] of unique.entries()) {
      const checked = checkIssueId(issueId, `latticeIssueStatuses[${index}]`)
      if (checked !== null) return checked
    }
    const concurrency = clampConcurrency(query.concurrency)
    const results = await mapLimit(unique, concurrency, async (issueId) => ({ issueId, result: await client.issue.get(issueId) }))
    const map: LatticeIssueStatuses = {}
    for (const { issueId, result } of results) {
      if (result.ok) {
        map[issueId] = result.data.status
        continue
      }
      if (result.status === 404 || result.code === 'issue_not_found') {
        map[issueId] = null
        continue
      }
      // 其它失败：整体失败（code 透传），避免"把网络错误当成未满足"
      return latticeFail({
        status: result.status,
        code: result.code,
        reason: `latticeIssueStatuses 查询 ${issueId} 失败：${result.reason}`,
      })
    }
    return latticeOk(200, map)
  })
}

/** 组合方法名清单（测试对账用；E1 用 `E:` 前缀单列） */
export const LATTICE_COMPOSITES = [
  'latticeMyProjects',
  'latticeProjectMembers',
  'latticeUserDevices',
  'latticeMyInstanceIssues',
  'issueCreate',
  'issueCreateMany',
  'issueUpdateStatus',
  'issueClaim',
  'issueAbandon',
  'issueRouting',
  'issueRunning',
  'issueFinalize',
  'issueRouted',
  'latticeIssueSources',
  'latticeAddIssueSource',
  'latticeDownloadIssueAttachments',
  'latticeIssueComments',
  'latticeAddIssueComments',
  'latticeCommentsSince',
  'latticeCommentCursor',
  'latticeWorkspaceIndexes',
  'latticeWorkspacePortal',
  'latticeUpsertWorkspaceIndex',
  'latticeUpsertWorkspacePortal',
] as const

/** 扩展组合方法（不计入 raw 的 24） */
export const LATTICE_EXTENSION_COMPOSITES = ['latticeIssueStatuses'] as const

/** 便于诊断/日志用的默认设备信息 */
export function defaultDeviceInfo(): { host: string; os: string; port?: number } {
  return teamworkDefaultDevice()
}

/** 只用一次的工具：给外部拼 `LatticeIssueCommentInput` 时省一次 UUID 生成 */
export function newCommentId(): string {
  return randomUUID()
}
