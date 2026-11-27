/**
 * Read model over the issue comment stream.
 *
 * The projection is the dispatcher's view of remote interactions: it is rebuilt from
 * comments, never persisted, and never trusts local pending state. The same fold is used
 * by the reporter at startup and by the `castboard_issue interactions` tool.
 *
 * @module dsh-magica-castboard/host/exec/interaction-projection
 */
import type { ThreadComment } from '../ledger/comment-store.ts'
import {
  decodeInteraction,
  type InteractionAnswer,
  type InteractionApprovalAnswer,
  type InteractionApprovalRequest,
  type InteractionEvent,
  type InteractionKind,
  type InteractionOutcome,
  type InteractionQuestionAnswer,
  type InteractionQuestionRequest,
  type InteractionRequest,
} from '../../shared/interaction-protocol.ts'

export type InteractionStatus = 'pending' | 'answered' | 'completed'

export interface InteractionViewBase {
  interactionId: string
  issueId: string
  sessionId: string
  status: InteractionStatus
  outcome?: InteractionOutcome
  requestedAt?: number
  answeredAt?: number
  completedAt?: number
  /** The request payload had to be compacted by the encoder. */
  truncated?: boolean
}

export type InteractionView =
  | (InteractionViewBase & {
    kind: 'question'
    request?: InteractionQuestionRequest
    answer?: InteractionQuestionAnswer
  })
  | (InteractionViewBase & {
    kind: 'approval'
    request?: InteractionApprovalRequest
    answer?: InteractionApprovalAnswer
  })

/** Mutable fold state; `request`/`answer` stay untyped until `toView` narrows by kind. */
interface Draft {
  interactionId: string
  issueId: string
  sessionId: string
  kind: InteractionKind
  status: InteractionStatus
  request?: InteractionRequest
  answer?: InteractionAnswer
  outcome?: InteractionOutcome
  requestedAt?: number
  answeredAt?: number
  completedAt?: number
  truncated?: boolean
}

export interface InteractionProjectionDeps {
  /** Usually `ThreadService.list`; echo de-duplication is already done there. */
  readonly commentsOf: (issueId: string) => Promise<readonly ThreadComment[]>
}

/**
 * Fold system comments into one view per interaction.
 *
 * Rules:
 * - only `system` comments with a valid v1 schema and matching `issueId`;
 * - `completed` is terminal; later events never reopen it;
 * - `answered` before `requested` keeps the answer and fills the request later;
 * - the first `requested` / `answered` wins; duplicates are ignored.
 */
export function projectInteractionEvents(
  comments: readonly ThreadComment[],
  issueId: string,
): InteractionView[] {
  const drafts = new Map<string, Draft>()
  for (const comment of comments) {
    if (comment.authorType !== 'system') continue
    const decoded = decodeInteraction(comment.body)
    if (!decoded.ok) continue
    const event = decoded.event
    if (event.issueId !== issueId) continue
    const expectedRole = event.event === 'answered' ? 'assigner' : 'assignee'
    if (comment.role !== expectedRole) continue
    applyEvent(drafts, event, comment.createdAt)
  }
  return [...drafts.values()]
    .map(toView)
    .sort(compareViews)
}

function compareViews(left: InteractionView, right: InteractionView): number {
  const leftAt = viewTime(left)
  const rightAt = viewTime(right)
  if (leftAt !== rightAt) return leftAt - rightAt
  if (left.interactionId === right.interactionId) return 0
  return left.interactionId < right.interactionId ? -1 : 1
}

function viewTime(view: InteractionView): number {
  return view.requestedAt ?? view.answeredAt ?? view.completedAt ?? 0
}

function applyEvent(drafts: Map<string, Draft>, event: InteractionEvent, at: number): void {
  let draft = drafts.get(event.interactionId)
  if (draft === undefined) {
    draft = {
      interactionId: event.interactionId,
      issueId: event.issueId,
      sessionId: event.sessionId,
      kind: event.kind,
      status: 'pending',
    }
    drafts.set(event.interactionId, draft)
  }
  if (draft.kind !== event.kind) return

  if (event.event === 'requested') {
    if (draft.request === undefined) {
      draft.request = event.request
      draft.truncated = event.request.truncated === true
    }
    draft.requestedAt ??= at
    return
  }
  if (event.event === 'answered') {
    if (draft.status === 'completed') return
    if (draft.answer === undefined) {
      draft.answer = event.answer
      draft.answeredAt ??= at
      draft.status = 'answered'
    }
    return
  }
  if (draft.status !== 'completed') {
    draft.status = 'completed'
    draft.outcome = event.outcome
    draft.completedAt = at
  }
}

function toView(draft: Draft): InteractionView {
  const base: InteractionViewBase = {
    interactionId: draft.interactionId,
    issueId: draft.issueId,
    sessionId: draft.sessionId,
    status: draft.status,
    ...(draft.outcome === undefined ? {} : { outcome: draft.outcome }),
    ...(draft.requestedAt === undefined ? {} : { requestedAt: draft.requestedAt }),
    ...(draft.answeredAt === undefined ? {} : { answeredAt: draft.answeredAt }),
    ...(draft.completedAt === undefined ? {} : { completedAt: draft.completedAt }),
    ...(draft.truncated === true ? { truncated: true } : {}),
  }
  if (draft.kind === 'question') {
    return {
      ...base,
      kind: 'question',
      ...(draft.request === undefined ? {} : { request: draft.request as InteractionQuestionRequest }),
      ...(draft.answer === undefined ? {} : { answer: draft.answer as InteractionQuestionAnswer }),
    }
  }
  return {
    ...base,
    kind: 'approval',
    ...(draft.request === undefined ? {} : { request: draft.request as InteractionApprovalRequest }),
    ...(draft.answer === undefined ? {} : { answer: draft.answer as InteractionApprovalAnswer }),
  }
}

/** Cached projection over one comment source; invalidated by a comment-stream signature. */
export class InteractionProjection {
  private readonly deps: InteractionProjectionDeps
  private readonly cache = new Map<string, { signature: string; views: readonly InteractionView[] }>()

  constructor(deps: InteractionProjectionDeps) {
    this.deps = deps
  }

  async of(issueId: string): Promise<readonly InteractionView[]> {
    const comments = await this.deps.commentsOf(issueId)
    const signature = commentSignature(comments)
    const cached = this.cache.get(issueId)
    if (cached?.signature === signature) return cached.views
    const views = projectInteractionEvents(comments, issueId)
    this.cache.set(issueId, { signature, views })
    return views
  }

  invalidate(issueId: string): void {
    this.cache.delete(issueId)
  }

  clear(): void {
    this.cache.clear()
  }
}

function commentSignature(comments: readonly ThreadComment[]): string {
  const last = comments[comments.length - 1]
  return `${comments.length}\u0000${last?.id ?? ''}\u0000${last?.createdAt ?? 0}`
}
