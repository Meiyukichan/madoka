/**
 * `castboard_issue_comment_add` — writes onto an issue's comment stream and delivers to the other
 * side's session.
 *
 * `castboard_comment_add` anchors on the card and only leaves a record; this tool anchors on the
 * issue and hands the comment to the **counterpart** session, so the assigner can follow up with
 * the executor and the executor can add context for the creator.
 *
 * Direction comes from the session identity rather than from the model's word: whatever the link
 * table recognizes wins, a mismatched `role` is corrected and explained in the receipt, and only an
 * unidentifiable caller falls back to its own value (default `assigner`). The model often does not
 * know which side it is on, and one hard error would make it abandon the whole task.
 *
 * No issue row is created here — assigner-side issues often exist only in the cloud and the link
 * table. Only the comment stream and `lastCommentAt` are touched.
 *
 * @module dsh-magica-castboard/host/tools/issue-comment
 */
import { isAbsolute, resolve } from 'node:path'

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { HttpFailure } from '../http/router.ts'
import type {
  CommentOrigin,
  ThreadComment,
} from '../ledger/comment-store.ts'
import type { LinkStore } from '../ledger/link-store.ts'
import { targetSessionId, type CommentSide } from '../ledger/link-types.ts'
import type { TaskStore } from '../ledger/task-store.ts'
import { normalizeBody } from '../rules.ts'
import type { ThreadService } from '../pipeline/thread.ts'
import { sessionIdOf } from './shared.ts'

const ISSUE_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CommentSideOf = 'assigner' | 'assignee' | 'both' | 'observer'

export interface CommentDeliveryFace {
  deliver(
    source: CommentOrigin,
    anchorId: string,
    comments: readonly ThreadComment[],
    options?: { readonly originSessionId?: string },
  ): Promise<void>
}

export interface RoleDeps {
  readonly links: Pick<LinkStore, 'get'>
  /** Confirms from execution history when the link table has no `assigneeSessionId` yet. */
  readonly tasks?: Pick<TaskStore, 'get'>
}

export interface IssueCommentToolDeps extends RoleDeps {
  readonly thread: Pick<ThreadService, 'add'>
  /** Absent = store only and let polling / re-delivery pick the comment up. */
  readonly deliverer?: CommentDeliveryFace
  /**
   * Upload files and attach them to the comment target. Called after the local
   * comment row has an id; failures must not lose the comment.
   */
  readonly uploadCommentAttachments?: (input: {
    readonly issueId: string
    readonly commentId: string
    readonly role: CommentSide
    readonly paths: readonly string[]
  }) => Promise<{ attached: number; failed: readonly { path: string; reason: string }[] }>
  /** Base directory for relative attachment paths; absent = process cwd. */
  readonly attachmentCwd?: (issueId: string) => string | undefined | Promise<string | undefined>
}

export interface RoleResolution {
  readonly role: CommentSide
  /** What the session identity implied; `undefined` when it could not be inferred. */
  readonly inferred?: CommentSide
  /** The requested direction was replaced by the inferred one. */
  readonly corrected: boolean
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Reject the wrong kind of id before it becomes an anchor.
 *
 * Task ids (`t-…`) and session ids (`session-…`) are the usual slips: well-formed, path-safe, and
 * they would quietly park the comment on an anchor nobody reads while both sides think delivery
 * worked. The error names the tool that should have been used instead.
 */
export function assertIssueIdShape(issueId: string): void {
  if (/^t-/i.test(issueId)) {
    throw new HttpFailure(
      'invalid_input',
      `"${issueId}" 是任务 id，不能作为 issue 锚点；给卡片写评论请用 castboard_comment_add（参数 taskId）。`,
      400,
    )
  }
  if (/^session-/i.test(issueId)) {
    throw new HttpFailure(
      'invalid_input',
      `"${issueId}" 是会话 id，不是 issue id；请传 issue 的 UUID。`,
      400,
    )
  }
  if (!ISSUE_ID_SHAPE.test(issueId)) {
    throw new HttpFailure(
      'invalid_input',
      `"${issueId}" 不是合法的 issue id（应为 UUID，如 5732b9b5-6b0c-4b46-99ee-6c44e1abe9b8）。`,
      400,
    )
  }
}

/**
 * Which side the caller is on. The link table's two session columns win, then the card's execution
 * history, and anything else is an observer (routing sessions, sessions the user opened directly).
 */
export function sideOf(deps: RoleDeps, issueId: string, sessionId: string): CommentSideOf {
  if (sessionId === '') return 'observer'
  const link = deps.links.get(issueId)
  const isAssigner = link?.assignerSessionId === sessionId
  const isAssignee = link?.assigneeSessionId === sessionId
  if (isAssigner && isAssignee) return 'both'
  if (isAssigner) return 'assigner'
  if (isAssignee) return 'assignee'

  // The link table lags behind the run start, so fall back to the card's execution history.
  const taskId = link?.assigneeTaskId
  if (taskId !== undefined && deps.tasks !== undefined) {
    const task = deps.tasks.get(taskId)
    if (task !== undefined && task.executions.some(execution => execution.sessionId === sessionId)) {
      return 'assignee'
    }
  }
  return 'observer'
}

/**
 * Infer the direction to write in; `observer` yields `undefined` so the caller's own value stands.
 *
 * Self-dispatch (`both`) counts as the executor: one session that both created and executes the
 * issue is more likely writing a progress report than following up with itself.
 */
export function inferRole(deps: RoleDeps, issueId: string, sessionId: string): CommentSide | undefined {
  const side = sideOf(deps, issueId, sessionId)
  if (side === 'observer') return undefined
  return side === 'assigner' ? 'assigner' : 'assignee'
}

export function resolveRole(
  deps: RoleDeps,
  issueId: string,
  sessionId: string,
  requested: CommentSide | undefined,
): RoleResolution {
  const inferred = inferRole(deps, issueId, sessionId)
  if (inferred !== undefined) {
    return { role: inferred, inferred, corrected: requested !== undefined && requested !== inferred }
  }
  return { role: requested ?? 'assigner', corrected: false }
}

function asSide(value: unknown): CommentSide | undefined {
  return value === 'assigner' || value === 'assignee' ? value : undefined
}

function renderReceipt(value: unknown): string {
  const receipt = value as unknown as {
    id?: unknown
    role?: unknown
    corrected?: unknown
    delivered?: unknown
    target?: unknown
    deliveryError?: unknown
  }
  const id = typeof receipt.id === 'string' ? receipt.id : ''
  const role = typeof receipt.role === 'string' ? receipt.role : '?'
  const lines = [`评论 ${id} 已写入 issue（方向 ${role}）。`]
  if (receipt.corrected === true) {
    lines.push(`你给的方向与当前会话身份不符，已按会话身份纠正为 ${role}。`)
  }
  if (receipt.delivered === true) {
    lines.push(`已投递给对端会话 ${typeof receipt.target === 'string' ? receipt.target : ''}。`)
  } else if (typeof receipt.deliveryError === 'string') {
    lines.push(`评论已落盘，但投递失败（会按欠账重试）：${receipt.deliveryError}`)
  } else if (typeof receipt.target === 'string') {
    lines.push('评论已落盘；对端会话需要等到下一次轮询/续跑时才能读到。')
  } else {
    lines.push('对端不在本机（跨机）：对方轮询到之后会收到，本机不需要再做别的。')
  }
  return lines.join('\n')
}

/**
 * The `castboard_issue_comment_add` tool.
 *
 * @param deps - Comment service and link table, optionally the task ledger and a deliverer.
 */
export function issueCommentTools(deps: IssueCommentToolDeps): ToolDefinition[] {
  return [
    defineTool({
      name: 'castboard_issue_comment_add',
      description:
        '给一条 issue 写评论，并投递给对端会话。'
        + '创建 issue 的下发方用它追问执行方或回答问题；执行方用它向创建方补充上下文。'
        + '方向（role）可省略，工具会按当前会话身份推断，推断不出来时按 assigner；'
        + '推断与传入不一致时会纠正并在回执里说明。'
        + 'issueId 必须是 issue 的 UUID，不能用任务 id（t-…）或会话 id。',
      parameters: {
        issueId: {
          type: 'string',
          required: true,
          description: 'issue 的 UUID。',
        },
        body: {
          type: 'string',
          required: true,
          description: '评论正文（1..4000 字符）。',
        },
        role: {
          type: 'string',
          enum: ['assigner', 'assignee'],
          description: 'assigner = 你创建的这条 issue；assignee = 你在执行它。省略时按会话身份推断。',
        },
        commentRole: {
          type: 'string',
          enum: ['assigner', 'assignee'],
          description: 'role 的兼容别名（评论上下文里用这个字段名）。',
        },
        attachments: {
          type: 'array',
          description: '可选：随评论上传的本地文件路径（绝对路径，或相对 issue cwd；最多 10 个）。',
          items: { type: 'string' },
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderReceipt(value) }],
      },
      async execute(args, exec) {
        const issueId = typeof args.issueId === 'string' ? args.issueId.trim() : ''
        if (issueId === '') throw new HttpFailure('invalid_input', 'issueId 必填', 400)
        assertIssueIdShape(issueId)

        // `role` is the public argument; models sometimes reuse the field name from comment context, so both are read.
        const rawRole = args.role ?? asSide((args as unknown as Record<string, unknown>).commentRole)
        const requested = rawRole === undefined ? undefined : asSide(rawRole)
        if (rawRole !== undefined && requested === undefined) {
          throw new HttpFailure('invalid_input', 'role 只允许 assigner 或 assignee', 400)
        }

        let body: string
        try {
          body = normalizeBody(typeof args.body === 'string' ? args.body : '')
        } catch (error) {
          throw new HttpFailure('invalid_input', errorText(error), 400)
        }

        const rawAttachments = (args as { attachments?: unknown }).attachments
        if (rawAttachments !== undefined && !Array.isArray(rawAttachments)) {
          throw new HttpFailure('invalid_input', 'attachments 必须是文件路径数组', 400)
        }
        const attachmentBase = await deps.attachmentCwd?.(issueId)
        const attachments = (rawAttachments ?? []).map((value, index) => {
          if (typeof value !== 'string' || value.trim() === '') {
            throw new HttpFailure('invalid_input', `attachments[${index}] 必须是非空路径`, 400)
          }
          const path = value.trim()
          return isAbsolute(path)
            ? path
            : resolve(attachmentBase ?? process.cwd(), path)
        })
        if (attachments.length > 10) {
          throw new HttpFailure('invalid_input', '一条评论最多 10 个附件', 400)
        }

        const sessionId = sessionIdOf(exec) ?? ''
        const resolution = resolveRole(deps, issueId, sessionId, requested)

        const comment = await deps.thread.add(
          issueId,
          {
            body,
            role: resolution.role,
            authorType: 'agent',
            ...(sessionId === '' ? {} : { threadId: sessionId }),
          },
          { deliver: false },
        )
        if (comment === undefined) {
          throw new HttpFailure('conflict', '评论没有写入（评论 id 已存在）', 409)
        }

        let attachmentReceipt:
          | { attached: number; failed: readonly { path: string; reason: string }[] }
          | undefined
        if (attachments.length > 0 && deps.uploadCommentAttachments !== undefined) {
          try {
            attachmentReceipt = await deps.uploadCommentAttachments({
              issueId,
              commentId: comment.id,
              role: resolution.role,
              paths: attachments,
            })
          } catch (error) {
            // The comment is already persisted; only report the upload failure.
            attachmentReceipt = {
              attached: 0,
              failed: [{ path: attachments.join(', '), reason: errorText(error) }],
            }
          }
        } else if (attachments.length > 0) {
          attachmentReceipt = {
            attached: 0,
            failed: [{ path: attachments.join(', '), reason: '评论附件上传通道不可用' }],
          }
        }

        // The deliverer picks the target from the link table and records an outstanding comment when
        // that session is unavailable. It only needs the row just written, plus the writing session
        // as the echo guard.
        const target = targetSessionId(deps.links.get(issueId), resolution.role)
        let deliveryError: string | undefined
        if (deps.deliverer !== undefined) {
          try {
            await deps.deliverer.deliver(
              'local',
              issueId,
              [comment],
              sessionId === '' ? {} : { originSessionId: sessionId },
            )
          } catch (error) {
            // Already persisted; a delivery failure only delays the comment, it must not fail the write.
            deliveryError = errorText(error)
          }
        }

        const delivered = deliveryError === undefined
          && deps.deliverer !== undefined
          && target !== undefined
          && target !== sessionId

        return {
          id: comment.id,
          appended: true,
          role: resolution.role,
          ...(resolution.corrected ? { corrected: true } : {}),
          delivered,
          ...(target === undefined ? {} : { target }),
          ...(deliveryError === undefined ? {} : { deliveryError }),
          ...(attachmentReceipt === undefined ? {} : {
            attachments: {
              attached: attachmentReceipt.attached,
              failed: [...attachmentReceipt.failed],
            },
          }),
        }
      },
    }),
  ]
}
