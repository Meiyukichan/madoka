/**
 * Shared route layer: the dependency surface, endpoint catalog, request unpacking, and
 * error mapping. Dependencies are narrow interfaces, so routes cannot reach into store
 * internals; optional capabilities degrade honestly (501 or an empty collection) instead
 * of fabricating data.
 *
 * @module dsh-magica-castboard/host/http/routes/shared
 */
import { HttpFailure, type RouteContext } from '../router.ts'
import { isValidTaskId } from '../../rules.ts'
import type { AcceptanceRunner } from '../../exec/acceptance-runner.ts'
import type { ExecutionService } from '../../exec/engine.ts'
import type { InteractionService, PendingInteraction } from '../../exec/interactions.ts'
import type { CommentStore } from '../../ledger/comment-store.ts'
import type { IssueStore } from '../../ledger/issue-store.ts'
import type { LinkStore } from '../../ledger/link-store.ts'
import type { CastboardPaths } from '../../ledger/paths.ts'
import type { TaskStore } from '../../ledger/task-store.ts'
import type { StoredAttachment } from '../../pipeline/attachments.ts'
import type { TemplateStore } from '../../ledger/template-store.ts'
import type { IssueQueryFace } from '../../pipeline/sdk-query.ts'
import type { AuthFace, DevicesFace, ProjectsFace } from '../../pipeline/sdk-face.ts'
import type { ThreadService } from '../../pipeline/thread.ts'
import type {
  AcceptanceStrategy,
  ApiErrorCode,
  BoardSettings,
  PendingInteractionRecord,
  StrategyCustom,
  WorkspacesCustom,
} from '../../model.ts'

/**
 * Board settings live in `castboard.settings.yaml` (see `ledger/settings.ts`); defaults
 * are applied by the rules layer, so `read()` always returns a complete object.
 */
export interface BoardSettingsFace {
  read(): Promise<BoardSettings>
  /** Only the explicitly set fields — what a ledger export carries. */
  stored(): BoardSettings
  write(input: unknown): Promise<BoardSettings>
}

export interface WorkspacesCustomFace {
  read(): Promise<WorkspacesCustom>
  replace(input: unknown): Promise<WorkspacesCustom>
}

export interface StrategyCustomFace {
  read(): Promise<StrategyCustom>
  replace(input: unknown): Promise<StrategyCustom>
}

export interface AcceptanceStrategiesFace {
  list(): Promise<readonly AcceptanceStrategy[]>
  replace(input: unknown): Promise<readonly AcceptanceStrategy[]>
}

export interface PortraitRefreshFace {
  refreshAll(): Promise<{ reset: number }>
}

export interface RouteDeps {
  tasks: TaskStore
  issues: IssueStore
  links: LinkStore
  comments: CommentStore
  /** Unified attachment synchronizer (undefined = no cloud attachment view). */
  attachmentSync?: {
    /** Issue-target rows only (both roles); comment rows are handled by `castboard_issue_state`. */
    listIssue(issueId: string): Promise<readonly StoredAttachment[]>
    syncIssue(issueId: string, options?: { wait?: boolean }): Promise<readonly StoredAttachment[]>
  }
  settings: BoardSettingsFace
  execution: ExecutionService
  thread: ThreadService
  paths: CastboardPaths
  templates: TemplateStore
  acceptanceStrategies: AcceptanceStrategiesFace
  customWorkspaces: WorkspacesCustomFace
  customStrategies: StrategyCustomFace
  instance: () => string
  /** SDK device instance (`mineInstance`, `${host}:${port}`), not the internal lease id. */
  deviceInstance?: () => string
  now: () => number
  isWritable: () => boolean
  interactions?: InteractionService
  acceptance: AcceptanceRunner
  query?: IssueQueryFace
  /** Shared-library login/logout/state; absent = no auth face (local-only). */
  auth?: AuthFace
  projects?: ProjectsFace
  devices?: DevicesFace
  portrait?: PortraitRefreshFace
  ownerHint: () => string
  /** Data-plane startup status; `ok:false` carries an actionable reason for the panel. */
  dataPlane?: { ok: boolean; reason?: string; configPath?: string }
  reload: () => Promise<void>
  version?: string
}

export const PROTOCOL = 'dsh-castboard/1'

/**
 * Keep in sync with the route table. `/magica` is mounted separately.
 */
export const ENDPOINTS: readonly string[] = [
  'GET /version',
  'GET /health',
  'GET /data-plane',
  'GET /projects',
  'GET /projects/mine',
  'POST /projects',
  'GET /projects/:id',
  'PUT /projects/:id',
  'DELETE /projects/:id',
  'GET /projects/:id/members',
  'GET /projects/:id/accounts',
  'POST /projects/:id/members',
  'DELETE /projects/:id/members/:accountId',
  'PUT /projects/:id/owner',
  'GET /devices/mine',
  'POST /devices',
  'DELETE /devices/:id',
  'GET /diagnostics',
  'POST /backup',
  'GET /state',
  'GET /settings',
  'POST /settings/update',
  'GET /templates',
  'POST /templates',
  'POST /templates/delete',
  'GET /acceptance-strategy',
  'POST /acceptance-strategy/update',
  'GET /workspaces-custom',
  'POST /workspaces-custom/update',
  'GET /strategy-custom',
  'POST /strategy-custom/update',
  'POST /portrait/refresh',
  'GET /issue-targets',
  'POST /cron/preview',
  'GET /tasks',
  'POST /tasks',
  'GET /tasks/:id',
  'GET /tasks/:id/attachments',
  'POST /tasks/:id/update',
  'POST /tasks/:id/move',
  'POST /tasks/:id/reject',
  'POST /tasks/:id/checklist',
  'POST /tasks/:id/comment',
  'POST /tasks/:id/read',
  'POST /tasks/:id/run',
  'POST /tasks/:id/cancel',
  'POST /tasks/:id/dispatch',
  'POST /tasks/:id/acceptance',
  'POST /tasks/:id/archive-sessions',
  'POST /tasks/:id/delete',
  'GET /issues',
  'GET /issues/dispatched',
  'POST /issues',
  'GET /issues/:id',
  'GET /issues/:id/state',
  'GET /issues/:id/thread',
  'POST /issues/:id/abandon',
  'POST /issues/:id/comment',
  'POST /issues/:id/mark-read',
  'POST /issues/:id/read',
  'POST /issues/:id/delete',
  'DELETE /issues/:id',
]

/**
 * `null` means the key was not sent; `''` means it was sent empty. Fingerprint and
 * revision cursors may legitimately be empty, so the two states stay distinct.
 */
export function queryCursor(context: RouteContext, key: string): string | null {
  return context.query.get(key)
}

export function queryValue(context: RouteContext, key: string): string | undefined {
  const value = context.query.get(key)
  return value === null || value === '' ? undefined : value
}

/**
 * A corrupted cursor costs at most one full snapshot; returning 400 would stall polling.
 */
export function queryNumber(context: RouteContext, key: string): number | undefined {
  const text = context.query.get(key)
  if (text === null || text.trim() === '') return undefined
  const value = Number.parseInt(text, 10)
  return Number.isFinite(value) ? value : undefined
}

export function objectBody(context: RouteContext): Record<string, unknown> {
  if (context.body === undefined || context.body === null || typeof context.body !== 'object') {
    throw fail('invalid_input', '请求体必须是 JSON 对象')
  }
  if (Array.isArray(context.body)) throw fail('invalid_input', '请求体必须是 JSON 对象')
  return context.body as Record<string, unknown>
}

/**
 * Returns `null` when absent or not a string; callers decide whether empty is valid.
 */
export function str(body: Record<string, unknown>, key: string): string | null {
  const value = body[key]
  return typeof value === 'string' ? value : null
}

/**
 * `undefined` when absent, `null` when malformed. No `Number(...)` coercion: `"3"` is
 * not 3, so a string-typed value cannot quietly become a valid parameter.
 */
export function num(body: Record<string, unknown>, key: string): number | null | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function bool(body: Record<string, unknown>, key: string): boolean | null {
  const value = body[key]
  return typeof value === 'boolean' ? value : null
}

export function requireString(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') throw fail('invalid_input', `${key} 必填`)
  if (value.length > max) throw fail('invalid_input', `${key} 超长（最大 ${max}）`)
  return value
}

export function optionalString(body: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw fail('invalid_input', `${key} 必须是字符串`)
  if (value.length > max) throw fail('invalid_input', `${key} 超长（最大 ${max}）`)
  return value
}

export function requireEnum<T extends string>(body: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = body[key]
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw fail('invalid_input', `${key} 只允许 ${allowed.join(' / ')}`)
  }
  return value as T
}

/**
 * The id is interpolated into `<tasksDir>/<id>.json`, so this is a filesystem safety
 * boundary, not just a format check.
 */
export function requireTaskId(context: RouteContext): string {
  const id = context.params.id ?? ''
  if (!isValidTaskId(id)) throw fail('invalid_input', '无效的任务 id')
  return id
}

const STATUS_OF: Readonly<Record<ApiErrorCode, number>> = {
  invalid_input: 400,
  invalid_transition: 400,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
  internal: 500,
}

export function fail(code: ApiErrorCode, message: string, status: number = STATUS_OF[code]): HttpFailure {
  return new HttpFailure(code, message, status)
}

/**
 * 501 reuses `invalid_input`: the six codes are a stable contract, and a missing
 * capability means "this request cannot be handled" without adding a seventh code.
 */
export function unavailable(message: string): HttpFailure {
  return fail('invalid_input', message, 501)
}

export function invalidInput(error: unknown): HttpFailure {
  return fail('invalid_input', error instanceof Error ? error.message : String(error), 400)
}

export function created<T>(value: T): { status: number; value: T } {
  return { status: 201, value }
}

export function accepted<T>(value: T): { status: number; value: T } {
  return { status: 202, value }
}

/**
 * Runtime records feed the in-process answer routes; the payload feeds rendering and
 * needs a stable `since` plus expanded question options.
 */
export function interactionRecords(items: readonly PendingInteraction[]): PendingInteractionRecord[] {
  const records: PendingInteractionRecord[] = []
  for (const item of items) {
    // Prefer spellbook's own record: re-projecting it through the board's narrow
    // fields is what dropped `multiSelect` and option descriptions.
    if (item.raw !== undefined) {
      records.push(item.raw)
      continue
    }
    if (item.kind === 'approval') {
      records.push({
        kind: 'approval',
        id: item.id,
        sessionId: item.sessionId,
        since: item.createdAt,
        toolName: item.title,
        ...(item.body.trim() === '' ? {} : { reason: item.body }),
      })
      continue
    }
    records.push({
      kind: 'question',
      id: item.id,
      sessionId: item.sessionId,
      since: item.createdAt,
      questions: [{
        id: item.id,
        ...(item.title.trim() === '' ? {} : { header: item.title }),
        question: item.body,
        ...(item.multiSelect === true ? { multiSelect: true } : {}),
        ...(item.options === undefined || item.options.length === 0
          ? {}
          : {
              options: item.options.map(label => {
                const description = item.optionDetails?.find(option => option.label === label)?.description
                return {
                  label,
                  ...(description === undefined || description === '' ? {} : { description }),
                }
              }),
            }),
      }],
    })
  }
  return records
}

/** Poll-path data: a missing service or a failed fetch becomes an empty list, never a 500. */
export async function pendingInteractionRecords(
  service: InteractionService | undefined,
): Promise<PendingInteractionRecord[]> {
  if (service === undefined) return []
  try {
    return interactionRecords(await service.refresh())
  } catch {
    return []
  }
}

/**
 * A readable fingerprint avoids hash collisions; the set is tiny, so joining entries is
 * both shorter and safer than hashing.
 */
export function interactionFingerprint(records: readonly PendingInteractionRecord[]): string {
  return records
    .map(record => `${record.kind}:${record.id}@${String(record.since)}`)
    .sort()
    .join(',')
}
