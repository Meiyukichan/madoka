/**
 * Issue 模块（C1–C16）：issue / 评论 / 附件 / 来源字典。
 *
 * 分工（api-design §5）：服务端只做 ①认证 ②枚举与格式校验 ③落库；
 * 状态转移、谁能看谁的 issue，全部由 SDK/DSH 侧负责。
 */
import type { DatabaseSync } from 'node:sqlite'
import { errors, nowIso } from '../../errors.js'
import { row, rows } from '../../db/rows.js'
import type { CurrentUser } from '../../auth/guard.js'
import { normalizePage, normalizePageSize } from '../account/service.js'

export const STATUSES = ['pending', 'accepted', 'routing', 'running', 'success', 'failed', 'abandoned'] as const
export const URGENCIES = ['runtime', 'direct', 'urgent', 'normal', 'relaxed'] as const
export const PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const
/** 附件挂在哪类对象上（DB `ck_tw_attachment_target`） */
export const ATTACHMENT_TARGET_TYPES = ['issue', 'comment'] as const
/** 附件角色：下发方提供 / 执行方交付（DB `ck_tw_attachment_role`） */
export const ATTACHMENT_ROLES = ['assigner', 'assignee'] as const

export type IssueStatus = (typeof STATUSES)[number]
export type IssueUrgency = (typeof URGENCIES)[number]
export type IssuePermission = (typeof PERMISSIONS)[number]
export type AttachmentTargetType = (typeof ATTACHMENT_TARGET_TYPES)[number]
export type AttachmentRole = (typeof ATTACHMENT_ROLES)[number]

export interface IssueVo {
  id: number
  issueId: string
  projectId: number | null
  title: string
  detail: string | null
  assigner: string
  assignerTask: string | null
  assignerMeta: string | null
  cwd: string | null
  urgency: IssueUrgency
  permission: IssuePermission | null
  assignee: string
  assigneeTask: string | null
  assigneeInstance: string | null
  assigneeMeta: string | null
  status: IssueStatus
  source: string
  sourceInstance: string | null
  dependsOn: string | null
  createdAt: string
  assignedAt: string | null
  updatedAt: string
}

export interface CommentVo {
  id: number
  commentId: string
  issueId: string
  author: string | null
  content: string
  commentRole: string | null
  commentAuthorType: string | null
  commentAt: string
  createdAt: string
  updatedAt: string
}

export interface AttachmentVo {
  id: number
  targetType: AttachmentTargetType
  targetId: string
  fileId: string
  fileName: string | null
  role: AttachmentRole
  description: string | null
  createdAt: string
  updatedAt: string
}

export interface SourceVo {
  id: number
  code: string
  description: string | null
  pluginName: string | null
  createdAt: string
  updatedAt: string
}

const ISSUE_COLUMNS = `id, issue_id AS issueId, project_id AS projectId, title, detail,
  assigner, assigner_task AS assignerTask, assigner_meta AS assignerMeta, cwd, urgency, permission,
  assignee, assignee_task AS assigneeTask, assignee_instance AS assigneeInstance, assignee_meta AS assigneeMeta,
  status, source, source_instance AS sourceInstance, depends_on AS dependsOn,
  created_at AS createdAt, assigned_at AS assignedAt, updated_at AS updatedAt`

const COMMENT_COLUMNS = `id, comment_id AS commentId, issue_id AS issueId, author, content,
  comment_role AS commentRole, comment_author_type AS commentAuthorType,
  comment_at AS commentAt, created_at AS createdAt, updated_at AS updatedAt`

const ATTACHMENT_COLUMNS = `id, target_type AS targetType, target_id AS targetId, file_id AS fileId,
  file_name AS fileName, role, description, created_at AS createdAt, updated_at AS updatedAt`

const SOURCE_COLUMNS = `id, code, description, plugin_name AS pluginName, created_at AS createdAt, updated_at AS updatedAt`

const C1_ALLOWED = new Set([
  'issueId', 'title', 'detail', 'assignee', 'projectId', 'cwd', 'urgency', 'permission',
  'source', 'sourceInstance', 'assignerTask', 'assignerMeta', 'dependsOn', 'status',
  'assigneeTask', 'assigneeInstance', 'assigneeMeta', 'assignedAt',
])

const C4_ALLOWED = new Set([
  'title', 'detail', 'projectId', 'cwd', 'urgency', 'permission', 'assignee',
  'assignerTask', 'assignerMeta', 'assigneeTask', 'assigneeInstance', 'assigneeMeta',
  'status', 'source', 'sourceInstance', 'dependsOn', 'assignedAt',
])

export class IssueService {
  constructor(private readonly deps: { db: DatabaseSync; privateMemberLimit: number }) {}

  private get db(): DatabaseSync {
    return this.deps.db
  }

  // ── C1 批量提交（整批原子）────────────────────────────────
  batchCreate(user: CurrentUser, items: unknown[]): string[] {
    if (items.length > 100) throw errors.invalidRequest('一次最多 100 条')
    const ids: string[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const raw of items) {
        const id = this.upsertOne(user, raw)
        ids.push(id)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return ids
  }

  private upsertOne(user: CurrentUser, raw: unknown): string {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw errors.invalidRequest('每个元素必须是对象')
    const body = raw as Record<string, unknown>
    for (const key of Object.keys(body)) {
      if (!C1_ALLOWED.has(key)) throw errors.unknownField(key)
    }

    const issueId = typeof body.issueId === 'string' && body.issueId.trim() ? body.issueId.trim() : cryptoRandomId()
    if (issueId.length > 100) throw errors.invalidRequest('issueId 最多 100 个字符')

    const title = requireTitle(body.title)
    const assignee = requireString(body.assignee, 'assignee', 1, 64)
    if (!this.accountExists(assignee)) throw errors.accountNotFound(assignee)

    const projectId = optionalInt(body.projectId, 'projectId')
    if (projectId !== null) {
      const project = row<{ visibility: string; status: string }>(
        this.db.prepare('SELECT visibility, status FROM dsh_teamwork_project WHERE id = ?').get(projectId),
      )
      if (!project) throw errors.projectNotFound(projectId)
      if (project.status === 'archived') throw errors.projectArchived()
      if (!this.isProjectMember(projectId, user.accountId)) throw errors.notProjectMember(projectId)
    }

    const status = body.status === undefined || body.status === null ? 'pending' : requireEnum(body.status, 'status', STATUSES)
    const urgency = body.urgency === undefined || body.urgency === null ? 'normal' : requireEnum(body.urgency, 'urgency', URGENCIES)
    const permission = body.permission === undefined || body.permission === null ? null : requireEnum(body.permission, 'permission', PERMISSIONS)

    const at = nowIso()
    const exists = row<{ status: IssueStatus }>(this.db.prepare('SELECT status FROM dsh_teamwork_issue WHERE issue_id = ?').get(issueId))

    if (!exists) {
      this.db
        .prepare(
          `INSERT INTO dsh_teamwork_issue(
             issue_id, project_id, title, detail, assigner, assigner_task, assigner_meta, cwd, urgency, permission,
             assignee, assignee_task, assignee_instance, assignee_meta, status, source, source_instance, depends_on,
             created_at, assigned_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          issueId, projectId, title, optionalString(body.detail, 'detail'),
          user.accountId, optionalString(body.assignerTask, 'assignerTask'), optionalString(body.assignerMeta, 'assignerMeta'),
          optionalString(body.cwd, 'cwd', 500), urgency, permission,
          assignee, optionalString(body.assigneeTask, 'assigneeTask'), optionalString(body.assigneeInstance, 'assigneeInstance'),
          optionalString(body.assigneeMeta, 'assigneeMeta'), status,
          body.source === undefined || body.source === null ? 'self' : requireString(body.source, 'source', 1, 64),
          optionalString(body.sourceInstance, 'sourceInstance'), optionalString(body.dependsOn, 'dependsOn'),
          at, optionalString(body.assignedAt, 'assignedAt'), at,
        )
      return issueId
    }

    // 已存在：发布方字段整体覆盖（服务端不做状态机判定）
    this.db
      .prepare(
        `UPDATE dsh_teamwork_issue SET
           project_id = ?, title = ?, detail = ?, assigner = ?, assigner_task = ?, assigner_meta = ?,
           cwd = ?, urgency = ?, permission = ?, assignee = ?, assignee_task = ?, assignee_instance = ?,
           assignee_meta = ?, status = ?, source = ?, source_instance = ?, depends_on = ?, assigned_at = ?, updated_at = ?
         WHERE issue_id = ?`,
      )
      .run(
        projectId, title, optionalString(body.detail, 'detail'), user.accountId,
        optionalString(body.assignerTask, 'assignerTask'), optionalString(body.assignerMeta, 'assignerMeta'),
        optionalString(body.cwd, 'cwd', 500), urgency, permission, assignee,
        optionalString(body.assigneeTask, 'assigneeTask'), optionalString(body.assigneeInstance, 'assigneeInstance'),
        optionalString(body.assigneeMeta, 'assigneeMeta'), status,
        body.source === undefined || body.source === null ? 'self' : requireString(body.source, 'source', 1, 64),
        optionalString(body.sourceInstance, 'sourceInstance'), optionalString(body.dependsOn, 'dependsOn'),
        optionalString(body.assignedAt, 'assignedAt'), at, issueId,
      )
    return issueId
  }

  // ── C2 列表（不过滤可见性）────────────────────────────────
  list(query: Record<string, unknown>): { total: number; pageNum: number; pageSize: number; items: IssueVo[] } {
    const pageNum = normalizePage(query.pageNum)
    const pageSize = normalizePageSize(query.pageSize)
    const where: string[] = []
    const args: unknown[] = []
    if (query.status !== undefined && query.status !== null && query.status !== '') {
      where.push('status = ?')
      args.push(requireEnum(query.status, 'status', STATUSES))
    }
    if (query.source !== undefined && query.source !== null && query.source !== '') { where.push('source = ?'); args.push(String(query.source)) }
    const projectId = optionalInt(query.projectId, 'projectId')
    if (projectId !== null) { where.push('project_id = ?'); args.push(projectId) }
    if (typeof query.keyword === 'string' && query.keyword.trim()) { where.push('title LIKE ?'); args.push(`%${query.keyword.trim()}%`) }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = row<{ c: number }>(this.db.prepare(`SELECT count(*) AS c FROM dsh_teamwork_issue ${whereSql}`).get(...(args as never[])))!.c
    const items = rows<IssueVo>(
      this.db
        .prepare(`SELECT ${ISSUE_COLUMNS} FROM dsh_teamwork_issue ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...(args as never[]), pageSize, (pageNum - 1) * pageSize),
    )
    return { total, pageNum, pageSize, items }
  }

  // ── C3 单条 ────────────────────────────────────────────────
  get(issueId: string): IssueVo {
    const found = row<IssueVo>(this.db.prepare(`SELECT ${ISSUE_COLUMNS} FROM dsh_teamwork_issue WHERE issue_id = ?`).get(issueId))
    if (!found) throw errors.issueNotFound(issueId)
    return found
  }

  // ── C4 全字段覆盖 ──────────────────────────────────────────
  overwrite(user: CurrentUser, issueId: string, raw: unknown): IssueVo {
    const existing = this.get(issueId)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw errors.invalidRequest('请求体必须是对象')
    const body = raw as Record<string, unknown>
    for (const key of Object.keys(body)) {
      if (!C4_ALLOWED.has(key)) throw errors.unknownField(key)
    }

    const title = body.title === undefined ? existing.title : requireTitle(body.title)
    const projectId = body.projectId === undefined ? existing.projectId : optionalInt(body.projectId, 'projectId')
    if (projectId !== null && projectId !== existing.projectId) {
      if (!row(this.db.prepare('SELECT 1 AS ok FROM dsh_teamwork_project WHERE id = ?').get(projectId))) throw errors.projectNotFound(projectId)
      if (!this.isProjectMember(projectId, user.accountId)) throw errors.notProjectMember(projectId)
    }
    if (body.assignee !== undefined && !this.accountExists(String(body.assignee))) throw errors.accountNotFound(String(body.assignee))

    const status = body.status === undefined || body.status === null ? existing.status : requireEnum(body.status, 'status', STATUSES)
    const urgency = body.urgency === undefined || body.urgency === null ? existing.urgency : requireEnum(body.urgency, 'urgency', URGENCIES)
    const permission =
      body.permission === undefined ? existing.permission : body.permission === null ? null : requireEnum(body.permission, 'permission', PERMISSIONS)

    this.db
      .prepare(
        `UPDATE dsh_teamwork_issue SET
           project_id = ?, title = ?, detail = ?, assignee_task = ?, assigner_task = ?, assigner_meta = ?, cwd = ?,
           urgency = ?, permission = ?, assignee = ?, assignee_instance = ?, assignee_meta = ?, status = ?,
           source = ?, source_instance = ?, depends_on = ?, assigned_at = ?, updated_at = ?
         WHERE issue_id = ?`,
      )
      .run(
        projectId, title,
        body.detail === undefined ? existing.detail : optionalString(body.detail, 'detail'),
        body.assigneeTask === undefined ? existing.assigneeTask : optionalString(body.assigneeTask, 'assigneeTask'),
        body.assignerTask === undefined ? existing.assignerTask : optionalString(body.assignerTask, 'assignerTask'),
        body.assignerMeta === undefined ? existing.assignerMeta : optionalString(body.assignerMeta, 'assignerMeta'),
        body.cwd === undefined ? existing.cwd : optionalString(body.cwd, 'cwd', 500),
        urgency, permission,
        body.assignee === undefined ? existing.assignee : String(body.assignee),
        body.assigneeInstance === undefined ? existing.assigneeInstance : optionalString(body.assigneeInstance, 'assigneeInstance'),
        body.assigneeMeta === undefined ? existing.assigneeMeta : optionalString(body.assigneeMeta, 'assigneeMeta'),
        status,
        body.source === undefined ? existing.source : requireString(body.source, 'source', 1, 64),
        body.sourceInstance === undefined ? existing.sourceInstance : optionalString(body.sourceInstance, 'sourceInstance'),
        body.dependsOn === undefined ? existing.dependsOn : optionalString(body.dependsOn, 'dependsOn'),
        body.assignedAt === undefined ? existing.assignedAt : optionalString(body.assignedAt, 'assignedAt'),
        nowIso(), issueId,
      )
    return this.get(issueId)
  }

  // ── C5 遗弃 ────────────────────────────────────────────────
  abandon(issueId: string): void {
    this.get(issueId)
    this.db.prepare("UPDATE dsh_teamwork_issue SET status = 'abandoned', updated_at = ? WHERE issue_id = ?").run(nowIso(), issueId)
  }

  // ── C6 状态批量（部分成功）─────────────────────────────────
  statusBatch(items: unknown[]): { success: number; failed: Array<{ issueId: string; reason: string }> } {
    if (items.length > 200) throw errors.invalidRequest('一次最多 200 条')
    let success = 0
    const failed: Array<{ issueId: string; reason: string }> = []

    for (const raw of items) {
      const item = raw as Record<string, unknown>
      const issueId = typeof item?.issueId === 'string' ? item.issueId : ''
      if (!issueId) { failed.push({ issueId: '', reason: 'issue_id_required' }); continue }
      if (!STATUSES.includes(item.status as never)) { failed.push({ issueId, reason: 'invalid_status' }); continue }
      const expected = item.expectedStatus
      if (expected !== undefined && expected !== null && expected !== '' && !STATUSES.includes(expected as never)) {
        failed.push({ issueId, reason: 'invalid_expected_status' })
        continue
      }

      const sets = ['status = ?', 'updated_at = ?']
      const args: unknown[] = [item.status, nowIso()]
      for (const [field, col] of [
        ['assigneeTask', 'assignee_task'],
        ['assigneeInstance', 'assignee_instance'],
        ['assigneeMeta', 'assignee_meta'],
      ] as const) {
        const v = item[field]
        if (v !== undefined && v !== null && v !== '') { sets.push(`${col} = ?`); args.push(String(v)) }
      }
      if (item.assignedAt !== undefined && item.assignedAt !== null && item.assignedAt !== '') {
        sets.push('assigned_at = ?')
        args.push(String(item.assignedAt))
      }

      const where = ['issue_id = ?']
      args.push(issueId)
      if (expected !== undefined && expected !== null && expected !== '') { where.push('status = ?'); args.push(expected) }

      const changed = this.db
        .prepare(`UPDATE dsh_teamwork_issue SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`)
        .run(...(args as never[]))
      const changes = Number((changed as { changes?: number }).changes ?? 0)
      if (changes > 0) { success++; continue }

      const current = row<{ status: string }>(this.db.prepare('SELECT status FROM dsh_teamwork_issue WHERE issue_id = ?').get(issueId))
      if (!current) failed.push({ issueId, reason: 'not_found' })
      else if (expected !== undefined && expected !== null && expected !== '' && current.status !== expected) {
        failed.push({ issueId, reason: 'status_conflict' })
      } else failed.push({ issueId, reason: 'update_conflict' })
    }
    return { success, failed }
  }

  // ── C7 / C8 评论增量 ───────────────────────────────────────
  commentsDelta(sinceIdRaw: unknown, limitRaw: unknown): { items: CommentVo[]; nextSinceId: number; hasMore: boolean } {
    const cursor = Math.max(0, Number(sinceIdRaw ?? 0) || 0)
    const limit = Math.min(2000, Math.max(1, Number(limitRaw ?? 500) || 500))
    const items = rows<CommentVo>(
      this.db.prepare(`SELECT ${COMMENT_COLUMNS} FROM dsh_teamwork_issue_comment WHERE id > ? ORDER BY id ASC LIMIT ?`).all(cursor, limit),
    )
    const nextSinceId = items.length ? items[items.length - 1]!.id : cursor
    return { items, nextSinceId, hasMore: items.length >= limit }
  }

  commentsCursor(): { maxId: number } {
    return { maxId: row<{ m: number | null }>(this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM dsh_teamwork_issue_comment').get())!.m ?? 0 }
  }

  // ── C9 追加评论（幂等）─────────────────────────────────────
  addComment(user: CurrentUser, issueId: string, raw: unknown): { comment: CommentVo; created: boolean } {
    this.get(issueId)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw errors.invalidRequest('请求体必须是对象')
    const body = raw as Record<string, unknown>
    for (const key of Object.keys(body)) {
      if (!['content', 'commentId', 'commentAt', 'commentRole', 'commentAuthorType'].includes(key)) throw errors.unknownField(key)
    }
    const content = requireString(body.content, 'content', 1, 10000)
    const commentId = typeof body.commentId === 'string' && body.commentId.trim() ? body.commentId.trim() : cryptoRandomId()

    const existing = row<CommentVo>(this.db.prepare(`SELECT ${COMMENT_COLUMNS} FROM dsh_teamwork_issue_comment WHERE comment_id = ?`).get(commentId))
    if (existing) return { comment: existing, created: false }

    this.db
      .prepare(
        `INSERT INTO dsh_teamwork_issue_comment(comment_id, issue_id, author, content, comment_role, comment_author_type, comment_at, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(comment_id) DO NOTHING`,
      )
      .run(
        commentId, issueId, user.accountId, content,
        optionalString(body.commentRole, 'commentRole'), optionalString(body.commentAuthorType, 'commentAuthorType'),
        body.commentAt === undefined || body.commentAt === null ? nowIso() : requireString(body.commentAt, 'commentAt', 1, 40),
        nowIso(), nowIso(),
      )
    const saved = row<CommentVo>(this.db.prepare(`SELECT ${COMMENT_COLUMNS} FROM dsh_teamwork_issue_comment WHERE comment_id = ?`).get(commentId))!
    return { comment: saved, created: true }
  }

  // ── C10 查评论 ─────────────────────────────────────────────
  listComments(issueId: string): CommentVo[] {
    this.get(issueId)
    return rows<CommentVo>(this.db.prepare(`SELECT ${COMMENT_COLUMNS} FROM dsh_teamwork_issue_comment WHERE issue_id = ? ORDER BY created_at ASC, id ASC`).all(issueId))
  }

  // ── C11 批量挂附件 ─────────────────────────────────────────
  addAttachments(items: unknown[]): { count: number } {
    if (items.length > 50) throw errors.invalidRequest('一次最多 50 条')
    let count = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const raw of items) {
        const item = raw as Record<string, unknown>
        const targetType = requireEnum(item.targetType, 'targetType', ATTACHMENT_TARGET_TYPES)
        const targetId = requireString(item.targetId, 'targetId', 1, 100)
        const role = requireEnum(item.role, 'role', ATTACHMENT_ROLES)
        const fileId = requireString(item.fileId, 'fileId', 1, 36)
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(fileId)) throw errors.invalidFileId()
        // issue 强引用必须存在；comment 只做弱引用（本地评论可能先于云端评论行上传，不能要求行已存在）
        if (targetType === 'issue') this.get(targetId)
        const fileName = optionalString(item.fileName, 'fileName', 255) ?? fileId
        const description = optionalString(item.description, 'description', 500)
        this.db
          .prepare(
            `INSERT INTO dsh_teamwork_issue_attachment(target_type, target_id, file_id, file_name, role, description, created_at, updated_at)
             VALUES(?,?,?,?,?,?,?,?)
             ON CONFLICT(target_type, target_id, file_id) DO UPDATE SET
               file_name = excluded.file_name, role = excluded.role,
               description = COALESCE(excluded.description, description), updated_at = excluded.updated_at`,
          )
          .run(targetType, targetId, fileId, fileName, role, description, nowIso(), nowIso())
        count++
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return { count }
  }

  // ── C12 查附件 ─────────────────────────────────────────────
  listAttachments(targetTypeRaw: unknown, targetIdRaw: unknown, roleRaw: unknown): AttachmentVo[] {
    const targetType = requireEnum(targetTypeRaw, 'targetType', ATTACHMENT_TARGET_TYPES)
    const targetId = requireString(targetIdRaw, 'targetId', 1, 100)
    // issue 必须存在；comment 允许「附件先于评论行」（弱引用），不过滤
    if (targetType === 'issue') this.get(targetId)
    const role = roleRaw === undefined || roleRaw === null || roleRaw === '' ? null : requireEnum(roleRaw, 'role', ATTACHMENT_ROLES)
    const sql = `SELECT ${ATTACHMENT_COLUMNS} FROM dsh_teamwork_issue_attachment
      WHERE target_type = ? AND target_id = ?${role ? ' AND role = ?' : ''}
      ORDER BY created_at ASC, id ASC`
    const args = role ? [targetType, targetId, role] : [targetType, targetId]
    return rows<AttachmentVo>(this.db.prepare(sql).all(...(args as never[])))
  }

  // ── C13 / C14 来源字典 ─────────────────────────────────────
  listSources(q: unknown): SourceVo[] {
    const keyword = typeof q === 'string' && q.trim() ? `%${q.trim()}%` : null
    const sql = keyword
      ? `SELECT ${SOURCE_COLUMNS} FROM dsh_teamwork_issue_source WHERE code LIKE ? OR coalesce(description,'') LIKE ? ORDER BY code ASC`
      : `SELECT ${SOURCE_COLUMNS} FROM dsh_teamwork_issue_source ORDER BY code ASC`
    return rows<SourceVo>(keyword ? this.db.prepare(sql).all(keyword, keyword) : this.db.prepare(sql).all())
  }

  registerSources(items: unknown[]): { count: number } {
    if (items.length > 100) throw errors.invalidRequest('一次最多 100 条')
    // 应用层先按 code 去重（保留最后一条）
    const byCode = new Map<string, { description: string | null; pluginName: string | null }>()
    for (const raw of items) {
      const item = raw as Record<string, unknown>
      const code = requireString(item.code, 'code', 1, 64)
      if (!/^[a-z]+(-[a-z]+)*$/.test(code)) throw errors.invalidSourceCode('只能是小写字母与中划线')
      byCode.set(code, {
        description: optionalString(item.description, 'description', 500) ?? null,
        pluginName: optionalString(item.pluginName, 'pluginName', 100) ?? null,
      })
    }
    let count = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const [code, v] of byCode) {
        this.db
          .prepare(
            `INSERT INTO dsh_teamwork_issue_source(code, description, plugin_name, created_at, updated_at)
             VALUES(?,?,?,?,?)
             ON CONFLICT(code) DO UPDATE SET
               description = COALESCE(excluded.description, description),
               plugin_name = COALESCE(excluded.plugin_name, plugin_name),
               updated_at = excluded.updated_at`,
          )
          .run(code, v.description, v.pluginName, nowIso(), nowIso())
        count++
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return { count }
  }

  updateSource(id: number, raw: unknown): SourceVo {
    const body = (raw ?? {}) as Record<string, unknown>
    for (const key of Object.keys(body)) {
      if (!['description', 'pluginName'].includes(key)) throw errors.unknownField(key)
    }
    const existing = row<SourceVo>(this.db.prepare(`SELECT ${SOURCE_COLUMNS} FROM dsh_teamwork_issue_source WHERE id = ?`).get(id))
    if (!existing) throw errors.sourceNotFound(id)
    this.db
      .prepare('UPDATE dsh_teamwork_issue_source SET description = ?, plugin_name = ?, updated_at = ? WHERE id = ?')
      .run(
        body.description === undefined ? existing.description : optionalString(body.description, 'description', 500) ?? null,
        body.pluginName === undefined ? existing.pluginName : optionalString(body.pluginName, 'pluginName', 100) ?? null,
        nowIso(), id,
      )
    return row<SourceVo>(this.db.prepare(`SELECT ${SOURCE_COLUMNS} FROM dsh_teamwork_issue_source WHERE id = ?`).get(id))!
  }

  deleteSource(id: number): void {
    const existing = row<{ id: number }>(this.db.prepare('SELECT id FROM dsh_teamwork_issue_source WHERE id = ?').get(id))
    if (!existing) throw errors.sourceNotFound(id)
    this.db.prepare('DELETE FROM dsh_teamwork_issue_source WHERE id = ?').run(id)
  }

  // ── 辅助 ──────────────────────────────────────────────────
  private accountExists(accountId: string): boolean {
    return row(this.db.prepare('SELECT 1 AS ok FROM dsh_teamwork_account WHERE account_id = ?').get(accountId)) !== undefined
  }

  private isProjectMember(projectId: number, accountId: string): boolean {
    return row(this.db.prepare('SELECT 1 AS ok FROM dsh_teamwork_project_member WHERE project_id = ? AND account_id = ?').get(projectId, accountId)) !== undefined
  }
}

// ── 校验小工具 ──────────────────────────────────────────────
function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID()
}

function requireTitle(v: unknown): string {
  if (typeof v !== 'string') throw errors.invalidTitle('必须是字符串')
  const t = v.trim()
  if (t.length < 1 || t.length > 200) throw errors.invalidTitle('长度必须是 1..200')
  return t
}

function requireString(v: unknown, field: string, min = 1, max = 0): string {
  if (typeof v !== 'string') throw errors.invalidRequest(`${field} 必须是字符串`, { field })
  const t = v
  if (t.length < min) throw errors.invalidRequest(`${field} 至少 ${min} 个字符`, { field })
  if (max > 0 && t.length > max) throw errors.invalidRequest(`${field} 最多 ${max} 个字符`, { field })
  return t
}

function optionalString(v: unknown, field: string, max = 0): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw errors.invalidRequest(`${field} 必须是字符串`, { field })
  if (max > 0 && v.length > max) throw errors.invalidRequest(`${field} 最多 ${max} 个字符`, { field })
  return v
}

function optionalInt(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) throw errors.invalidRequest(`${field} 必须是正整数`, { field })
  return n
}

function requireEnum<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    if (field === 'status') throw errors.invalidStatus(field)
    if (field === 'urgency') throw errors.invalidUrgency()
    if (field === 'permission') throw errors.invalidPermission()
    if (field === 'type') throw errors.invalidType(field)
    if (field === 'targetType') throw errors.invalidRequest('targetType 只能是 issue / comment', { field })
    if (field === 'role') throw errors.invalidRequest('role 只能是 assigner / assignee', { field })
    throw errors.invalidRequest(`${field} 取值不合法`, { field })
  }
  return v as T
}
