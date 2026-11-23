/**
 * Direct path: issues with `urgency: 'direct'` skip planning and go straight to card creation.
 *
 * The normal path is "issue -> router session planning -> `castboard_issue_task` card creation"; its value is letting
 * the model add planning output (steps, acceptance checklist, cwd, execution notes). The dispatching side sometimes
 * writes all of that already, making planning an idle spin: an extra session and ten-plus seconds of waiting. Direct means "all of that is already there".
 *
 * Skipping planning also skips the step that catches mistakes, so every field is validated and **all problems
 * are reported at once** (not stopping at the first): a round trip to fix one item costs far more than one clear report.
 *
 * | Field | Requirement |
 * |---|---|
 * | `title` | non-empty after normalization |
 * | `detail` | non-empty after normalization (`assignerMeta.detail` also counts) |
 * | `cwd` | non-empty, absolute, <= 500 characters; create it when missing, fail only if creation fails |
 * | `urgency` | one of the five levels |
 * | `permission` | when present, one of the three modes |
 *
 * When validation fails: publish the reasons as comments on the issue, then mark the issue `abandoned`
 * (cloud-originated issues are written back remotely too). When dependencies are unmet, leave the status alone and retry next tick.
 *
 * @module dsh-magica-castboard/host/pipeline/direct
 */
import { eventLog } from '../shared/event-log.ts'
import { URGENCIES, type IssueRecord, type PermissionMode } from '../model.ts'
import { asPermission, asUrgency } from '../rules.ts'
import { normalizeIssueDetail, normalizeIssueTitle } from '../ledger/issue-validate.ts'
import type { IssueStore } from '../ledger/issue-store.ts'
import { isConverted, convertIssueToTask, type IssueTaskToolDeps } from '../tools/issue-task.ts'

const PERMISSION_VALUES: readonly PermissionMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/** Maximum `cwd` length in characters (matches the shared library's `cwd` column). */
const MAX_CWD_CHARS = 500

export interface DirectRouteDeps extends IssueTaskToolDeps {
  readonly issues: IssueStore
  /**
   * Make sure the directory exists; `false` means it could not be created (parent not writable / invalid path). Wired with recursive `mkdir`.
   */
  readonly ensureDir: (path: string) => Promise<boolean>
  /**
   * Write "abandoned" back to the shared library; only cloud-originated issues are called and failures are only logged.
   * The validation meta is sent in the same status update.
   */
  readonly issueAbandon?: (
    issueId: string,
    assigneeMeta?: Record<string, unknown>,
  ) => Promise<void>
}

export type DirectOutcome =
  | { readonly kind: 'converted'; readonly issueId: string; readonly taskId: string }
  | { readonly kind: 'rejected'; readonly issueId: string; readonly errors: readonly string[] }
  | { readonly kind: 'skipped'; readonly issueId: string; readonly reason: string }

function note(level: 'info' | 'warn', event: string, detail: string): void {
  eventLog(level, event, detail)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Two sources for the body: top-level `detail`, and the copy the dispatching side often writes in `assignerMeta.detail`. */
function detailOf(issue: IssueRecord): string {
  if (issue.detail.length > 0) return issue.detail
  const metaDetail = issue.assignerMeta?.detail
  return typeof metaDetail === 'string' ? metaDetail : ''
}

/**
 * Validate direct card creation and collect every problem at once (pure function; directory checks happen later).
 */
export function directFieldErrors(issue: IssueRecord): string[] {
  const errors: string[] = []

  // Normalizers throw on empty or over-long values, but this function wants an error list, so each call is guarded.
  const normalized = (read: () => string): string => {
    try {
      return read()
    } catch {
      return ''
    }
  }

  if (normalized(() => normalizeIssueTitle(issue.title)) === '') {
    errors.push('`title` 为空或超过 200 字符 —— 建卡必须有 1~200 字符的标题。')
  }

  if (normalized(() => normalizeIssueDetail(detailOf(issue))) === '') {
    errors.push('`detail` 为空 —— 建卡必须有正文（也可以写在 `assignerMeta.detail`）。')
  }

  const cwd = (issue.cwd ?? '').trim()
  if (cwd === '') {
    errors.push('`cwd` 为空 —— 直通必须指定工作目录（否则不知道在哪个项目里干活）。')
  } else if (cwd.length > MAX_CWD_CHARS) {
    errors.push(`\`cwd\` 超过 ${MAX_CWD_CHARS} 字符（当前 ${cwd.length}）。`)
  } else if (!/^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(cwd)) {
    errors.push(`\`cwd\` 必须是绝对路径（当前 "${cwd}"）。`)
  }

  if (!(URGENCIES as readonly string[]).includes(issue.urgency)) {
    errors.push(`\`urgency\` 取值非法（当前 "${issue.urgency}"，合法值：${URGENCIES.join(' / ')}）。`)
  }

  if (issue.permission !== undefined && !(PERMISSION_VALUES as readonly string[]).includes(issue.permission)) {
    errors.push(
      `\`permission\` 取值非法（当前 "${issue.permission}"，合法值：${PERMISSION_VALUES.join(' / ')}）。`,
    )
  }

  return errors
}

/**
 * Dependencies that have not reached `success`; unfindable ones count as unfinished.
 */
function unmetDependencies(issues: IssueStore, issue: IssueRecord): string[] {
  const dependsOn = issue.dependsOn ?? []
  if (dependsOn.length === 0) return []
  const unmet: string[] = []
  for (const dependencyId of dependsOn) {
    const summary = issues.summary(dependencyId)
    if (summary === undefined || summary.status !== 'success') unmet.push(dependencyId)
  }
  return unmet
}

/**
 * Run the direct path: validate, check dependencies, then create the card.
 */
export async function directRoute(deps: DirectRouteDeps, issueId: string): Promise<DirectOutcome> {
  const issue = await deps.issues.get(issueId)
  if (issue === undefined) return { kind: 'skipped', issueId, reason: 'no such issue' }
  if (issue.urgency !== 'direct') {
    return { kind: 'skipped', issueId, reason: `urgency is "${issue.urgency}", not "direct"` }
  }
  if (issue.status !== 'pending' && issue.status !== 'accepted') {
    return { kind: 'skipped', issueId, reason: `status is "${issue.status}"` }
  }
  if (isConverted(issue)) {
    return { kind: 'skipped', issueId, reason: `already converted to ${issue.assigneeTask ?? ''}` }
  }

  const errors = directFieldErrors(issue)
  if (errors.length === 0) {
    // Create the directory when missing. Only creation failure counts as a field error: the path is valid but the parent is not writable.
    const cwd = (issue.cwd ?? '').trim()
    const ready = await deps.ensureDir(cwd).catch((error: unknown) => {
      note('warn', 'direct-cwd-create-failed', `${issueId}: ${cwd}: ${errorText(error)}`)
      return false
    })
    if (!ready) errors.push(`\`cwd\` 目录无法创建或访问：\`${cwd}\`（父路径不可写或路径非法）。`)
  }

  if (errors.length > 0) {
    await rejectDirect(deps, issue, errors)
    return { kind: 'rejected', issueId, errors }
  }

  // Dependencies unmet: do not create a card or change status, retry next tick. They will finish eventually, and abandoning would lose the work.
  const unmet = unmetDependencies(deps.issues, issue)
  if (unmet.length > 0) {
    note('info', 'direct-blocked-by-dependency', `${issueId}: 依赖未完成 ${unmet.join(', ')}，继续等待`)
    return { kind: 'skipped', issueId, reason: `dependencies not satisfied: ${unmet.join(', ')}` }
  }

  try {
    const title = normalizeIssueTitle(issue.title)
    const detail = normalizeIssueDetail(detailOf(issue))
    const urgency = asUrgency(issue.urgency)
    const permission: PermissionMode = issue.permission === undefined
      ? 'workspace-write'
      : asPermission(issue.permission)
    const tags = Array.isArray(issue.assignerMeta?.tags)
      ? issue.assignerMeta.tags.filter((tag): tag is string => typeof tag === 'string')
      : undefined

    const { task } = await convertIssueToTask(deps, { ...issue, status: 'routing' }, {
      title,
      detail,
      cwd: (issue.cwd ?? '').trim(),
      urgency,
      permission,
      ...(tags !== undefined ? { tags } : {}),
    })
    note('info', 'direct-routed', `${issueId} → task ${task.id}（urgency=direct，跳过 router 规划）`)
    return { kind: 'converted', issueId, taskId: task.id }
  } catch (error) {
    const reason = errorText(error)
    note('warn', 'direct-convert-failed', `${issueId}: ${reason}`)
    await rejectDirect(deps, issue, [`转换失败：${reason}`])
    return { kind: 'rejected', issueId, errors: [reason] }
  }
}

/**
 * Publish the failure reasons, mark the issue abandoned, and write back to the cloud when it came from there.
 */
async function rejectDirect(
  deps: DirectRouteDeps,
  issue: IssueRecord,
  errors: readonly string[],
): Promise<void> {
  const issueId = issue.id
  const body = [
    '【直通失败】这条 issue 的 `urgency` 是 `direct`（跳过规划直接建卡），但这次转换没有完成：',
    '',
    ...errors.map(line => `- ${line}`),
    '',
    '已把这条 issue 标记为「放弃」。修正上面的问题后重新下发即可。',
  ].join('\n')
  const assigneeMeta: Record<string, unknown> = {
    directValidation: {
      at: new Date(deps.now()).toISOString(),
      errors: [...errors],
      message: body,
    },
  }

  // A normal assignee comment, not a system note: it is visible to the
  // assignee and is published to the shared library by the thread service.
  try {
    await deps.thread?.add(issueId, {
      body,
      role: 'assignee',
      authorType: 'agent',
    })
  } catch (error) {
    note('warn', 'direct-reject-comment-failed', `${issueId}: ${errorText(error)}`)
  }

  // Cloud first: do not mark local abandoned if the shared library did not accept it.
  if (deps.issueAbandon === undefined) throw new Error('共享库不可用：不能放弃这条 issue')
  await deps.issueAbandon(issueId, assigneeMeta)
  const abandoned = await abandonIssue(deps, issue, assigneeMeta)
  if (abandoned) {
    note('warn', 'direct-rejected', `${issueId}: ${errors.length} 项校验不过，已标记 abandoned`)
  } else {
    note('warn', 'direct-rejected', `${issueId}: ${errors.length} 项校验不过（本地镜像放弃失败）`)
  }
}

/**
 * Mark abandoned, including issues already moved out of pending/accepted by `markRouting`.
 */
async function abandonIssue(
  deps: DirectRouteDeps,
  issue: IssueRecord,
  assigneeMeta: Record<string, unknown>,
): Promise<boolean> {
  try {
    const abandoned = await deps.issues.abandon(issue.id, assigneeMeta)
    if (abandoned !== undefined) return true
    const forced = await deps.issues.update(issue.id, draft => {
      if (draft.status !== 'pending' && draft.status !== 'accepted' && draft.status !== 'routing') return false
      draft.status = 'abandoned'
      draft.assigneeMeta = { ...(draft.assigneeMeta ?? {}), ...assigneeMeta }
    }, 'issue-abandoned')
    return forced !== undefined
  } catch (error) {
    note('warn', 'direct-abandon-failed', `${issue.id}: ${errorText(error)}`)
    return false
  }
}
