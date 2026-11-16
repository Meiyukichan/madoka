/**
 * 线格式助手：**所有"写歪就是一类线上故障"的翻译都只在这里做一次**（INV-6/INV-9）。
 *
 * 三处必须翻译（违反就被服务端 400/500 或静默写错）：
 *  1. `*Meta` 只收 **JSON 字符串**（传对象 → 服务端 `unknown_field` / 类型错）；
 *  2. `dependsOn` 线上是 `TEXT`（JSON 文本，服务端**不解析**），读回要归一成 `string[]`；
 *  3. 附件类型门面 `input|output` ↔ 线上 `assigner|assignee`（DB CHECK 两值）。
 *
 * 另有入参校验：不合格一律返回 `LatticeFail`（**零请求**），不抛异常。
 */

import { latticeLog } from './log.js'
import { latticeFail, type LatticeErrorCode, type LatticeFail } from './result.js'
import {
  LATTICE_ISSUE_ID_PATTERN,
  isLatticeWireAttachmentType,
  type LatticeAttachmentType,
  type LatticeIssue,
  type LatticeMetaInput,
  type LatticeWireAttachmentType,
} from './types.js'

/** 失败信封里 `body` 的截断长度 */
export const LATTICE_BODY_LIMIT = 2048

/** 路径段编码 */
export function seg(value: string | number): string {
  return encodeURIComponent(String(value))
}

/** 永不抛的字符串化（`JSON.stringify` 会因循环引用 / BigInt 抛） */
export function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    if (text !== undefined) return text
  } catch {
    /* fallthrough */
  }
  try {
    return String(value)
  } catch {
    return '<unserializable>'
  }
}

/** 读响应体：失败给空串，不掩盖原始错误（调用方拿它做 `body`） */
export async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/** 把服务端错误响应压成一句话（优先 `message` / `errorMessage`） */
export function describeHttpFailure(status: number, text: string): string {
  const raw = text.trim()
  if (raw === '') return `HTTP ${status}`
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; errorMessage?: unknown; error?: unknown }
    const candidate = parsed.message ?? parsed.errorMessage ?? parsed.error
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return `HTTP ${status}：${candidate.trim()}`
    }
  } catch {
    /* 非 JSON：直接用文本 */
  }
  const compact = raw.replace(/\s+/g, ' ')
  return `HTTP ${status}：${compact.length > 200 ? `${compact.slice(0, 200)}…` : compact}`
}

/** `*Meta` 归一：`null` 保留（清空语义）、字符串原样、对象/数组序列化 */
export function asMetaString(meta: LatticeMetaInput | null | undefined): string | null {
  if (meta === null || meta === undefined) return null
  if (typeof meta === 'string') return meta
  try {
    return JSON.stringify(meta)
  } catch {
    return null
  }
}

/** `dependsOn` 上线：空清单 → `null`（**不发该字段**或显式清空，由调用方选择） */
export function asDependsOnString(dependsOn: readonly string[] | null | undefined): string | null {
  if (dependsOn === null || dependsOn === undefined) return null
  const ids = dependsOn.map((id) => id.trim()).filter((id) => id !== '')
  if (ids.length === 0) return null
  return JSON.stringify(ids)
}

function cleanDependsOnIds(raw: readonly unknown[]): string[] {
  const ids = raw
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((id) => id !== '')
  if (ids.length !== raw.length) {
    warnDependsOn('depends_on 里有非字符串或空值，已丢弃')
  }
  return ids
}

let dependsOnWarned = false

function warnDependsOn(message: string): void {
  if (dependsOnWarned) return
  dependsOnWarned = true
  // 服务端理论上不会产生脏数据；真的出现时只提醒一次，不刷日志
  latticeLog('warn', 'depends-on', `读回 depends_on 时做了归一：${message}`)
}

/** `dependsOn` 读回：非法 JSON / 顶层非数组 / 空 → `[]`（INV-12） */
export function parseDependsOn(raw: unknown): string[] {
  if (raw === null || raw === undefined) return []
  if (Array.isArray(raw)) return cleanDependsOnIds(raw)
  if (typeof raw !== 'string') return []
  const text = raw.trim()
  if (text === '') return []
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) {
      warnDependsOn('JSON 顶层不是数组')
      return []
    }
    return cleanDependsOnIds(parsed)
  } catch {
    warnDependsOn('不是合法 JSON')
    return []
  }
}

/** 读回归一：只动 `dependsOn`，其它字段原样 */
export function normalizeIssue(issue: LatticeIssue): LatticeIssue {
  if (issue === null || typeof issue !== 'object') return issue
  return { ...issue, dependsOn: parseDependsOn(issue.dependsOn) }
}

/** 附件类型：门面值 → 线上值（已经是线上值时原样返回，便于旧调用方直接传） */
export function toWireAttachmentType(type: LatticeAttachmentType | LatticeWireAttachmentType): LatticeWireAttachmentType {
  if (type === 'assigner' || type === 'assignee') return type
  return type === 'input' ? 'assigner' : 'assignee'
}

/** 附件类型：线上值 → 门面值 */
export function fromWireAttachmentType(type: unknown): LatticeAttachmentType {
  if (isLatticeWireAttachmentType(type)) return type === 'assigner' ? 'input' : 'output'
  // 兜底：已经是门面值（服务端未来换了取值也不至于崩）
  return type === 'output' ? 'output' : 'input'
}

/** `permission`：`''` → `null`（DB CHECK 只认 3 值或 NULL；D10） */
export function normalizePermission(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  return typeof value === 'string' ? value : null
}

/** `issueId` 校验：合格返回 `null`，否则 `400 invalid_issue_id`（零请求，INV-5） */
export function checkIssueId(issueId: unknown, where: string): LatticeFail | null {
  if (typeof issueId !== 'string') {
    return latticeFail({
      status: 400,
      code: 'invalid_issue_id',
      reason: `${where} 的 issueId 必须是字符串（收到 ${safeJson(issueId)}）；issueId 是幂等键（1..100，不含控制字符），形状不一致会让同一次诉求在库里变成多条。`,
      field: 'issueId',
      value: safeJson(issueId),
    })
  }
  const trimmed = issueId.trim()
  if (trimmed === '' || trimmed.length !== issueId.length || !LATTICE_ISSUE_ID_PATTERN.test(issueId)) {
    return latticeFail({
      status: 400,
      code: 'invalid_issue_id',
      reason: `${where} 的 issueId 是幂等键（1..100，不含控制字符，不能有首尾空白）；收到 ${safeJson(issueId)}。形状不一致会让同一次诉求在库里变成多条。`,
      field: 'issueId',
      value: safeJson(issueId),
    })
  }
  return null
}

/** 主键归一：正整数（数字或纯数字串） */
export function toPositiveIntId(
  value: number | string,
  field: string,
  code: LatticeErrorCode,
  label: string,
  hint: string,
): { ok: true; value: number } | { ok: false; fail: LatticeFail } {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n <= 0) {
    return {
      ok: false,
      fail: latticeFail({
        status: 400,
        code,
        reason: `${label} 必须是正整数${hint === '' ? '' : `；${hint}`}。收到 ${safeJson(value)}`,
        field,
        value: safeJson(value),
      }),
    }
  }
  return { ok: true, value: n }
}

export function toProjectId(
  value: number | string,
): { ok: true; value: number } | { ok: false; fail: LatticeFail } {
  return toPositiveIntId(value, 'projectId', 'invalid_project_id', 'projectId', '若手上是项目名，请先 project.list() 换成 id 再查成员')
}

export function toDeviceId(
  value: number | string,
): { ok: true; value: number } | { ok: false; fail: LatticeFail } {
  return toPositiveIntId(value, 'id', 'invalid_device_id', '设备 id', '若手上是 host/port，请先 teamwork.device.mine() 查出设备 id')
}

/** 账号归一：非空字符串（≤64，与 DB 一致） */
export function toAccount(
  value: unknown,
  field: string,
  hint: string,
): { ok: true; value: string } | { ok: false; fail: LatticeFail } {
  if (typeof value !== 'string' || value.trim() === '') {
    return {
      ok: false,
      fail: latticeFail({
        status: 400,
        code: 'invalid_user_id',
        reason: `${field} 必须是非空字符串${hint === '' ? '' : `；${hint}`}。收到 ${safeJson(value)}`,
        field,
        value: safeJson(value),
      }),
    }
  }
  const trimmed = value.trim()
  if (trimmed.length > 64) {
    return {
      ok: false,
      fail: latticeFail({
        status: 400,
        code: 'invalid_user_id',
        reason: `${field} 最多 64 个字符（DB 约束）。收到 ${trimmed.length} 个`,
        field,
        value: safeJson(value),
      }),
    }
  }
  return { ok: true, value: trimmed }
}

/** 来源 code 归一：`^[a-z]+(-[a-z]+)*$`，1..64（DB `ck_tw_source_code`） */
export function toSourceCode(
  value: unknown,
): { ok: true; value: string } | { ok: false; fail: LatticeFail } {
  const pattern = /^[a-z]+(-[a-z]+)*$/
  if (typeof value !== 'string' || !pattern.test(value) || value.length > 64) {
    return {
      ok: false,
      fail: latticeFail({
        status: 400,
        code: 'invalid_source_code',
        reason: `来源 code 必须匹配 ^[a-z]+(-[a-z]+)*$ 且 1..64 个字符（小写字母 + 单中划线）。收到 ${safeJson(value)}`,
        field: 'code',
        value: safeJson(value),
      }),
    }
  }
  return { ok: true, value }
}

/**
 * `assignedAt` / `commentAt` 的 ISO-8601 本地时间校验。
 * 接受带 `Z` 或不带时区的 `YYYY-MM-DDTHH:mm:ss[.fff]`。
 */
export function toIsoLocal(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; fail: LatticeFail } {
  const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?$/
  if (typeof value !== 'string' || !pattern.test(value)) {
    return {
      ok: false,
      fail: latticeFail({
        status: 400,
        code: 'invalid_datetime',
        reason: `${field} 必须是 ISO-8601 时间（如 2025-06-16T10:12:30）。收到 ${safeJson(value)}`,
        field,
        value: safeJson(value),
      }),
    }
  }
  return { ok: true, value }
}

/**
 * 请求体白名单投影：只保留协议允许的键，`undefined` 直接剔除
 * （服务端是 strict schema，多一个键就 400 `unknown_field`，D26）。
 */
export function pick<T extends Record<string, unknown>>(
  source: T | Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of allowed) {
    const value = (source as Record<string, unknown>)[key]
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/** 输出文件名安全化：只取 basename，Windows 非法字符换 `_`，挡 `.` / `..` */
export function safeFileName(raw: string, fallback: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  let name = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim()
  if (name === '' || name === '.' || name === '..') name = fallback
  return name.slice(0, 180)
}

/** 分页参数归一（与 `api-design` §0.5 一致；非法值回落而不是报错） */
export function pageParams(query: { pageNum?: number; pageSize?: number } = {}): {
  pageNum: number
  pageSize: number
} {
  const pageNum = typeof query.pageNum === 'number' && Number.isFinite(query.pageNum) && query.pageNum >= 1
    ? Math.floor(query.pageNum)
    : 1
  const rawSize = typeof query.pageSize === 'number' && Number.isFinite(query.pageSize) ? Math.floor(query.pageSize) : 20
  const pageSize = rawSize < 1 ? 20 : rawSize > 200 ? 200 : rawSize
  return { pageNum, pageSize }
}

export type { LatticeMetaInput }
