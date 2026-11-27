/**
 * Interaction answer bridge (source-host side).
 *
 * Remote answers arrive as ordinary issue comments. The bridge reads the local comment
 * stream, matches `answered` events to the local pending list, and calls
 * `InteractionService.answerRemote` (the only place that touches the host runtime).
 *
 * It is intentionally not driven by inbox "new row" callbacks alone: a local fast-path
 * answer may already be in the stream, and a restart may need a full reconcile.
 *
 * @module dsh-magica-castboard/host/exec/interaction-bridge
 */
import type { LinkStore } from '../ledger/link-store.ts'
import type { TaskStore } from '../ledger/task-store.ts'
import type { ThreadService } from '../pipeline/thread.ts'
import type { InteractionService, PendingInteraction } from './interactions.ts'
import { decodeInteraction, type AnsweredApprovalEvent, type AnsweredQuestionEvent } from '../../shared/interaction-protocol.ts'

export interface InteractionBridgeDeps {
  readonly interactions: Pick<InteractionService, 'answerRemote'>
  readonly tasks: Pick<TaskStore, 'get' | 'taskIdOfSession'>
  readonly links: Pick<LinkStore, 'get'>
  readonly thread: Pick<ThreadService, 'list'>
  /** Cross-machine answers are comments; absent = enabled. */
  readonly enabled?: () => boolean
  readonly log?: (level: 'info' | 'warn', event: string, detail?: unknown) => void
}

export class InteractionBridge {
  private readonly deps: InteractionBridgeDeps

  constructor(deps: InteractionBridgeDeps) {
    this.deps = deps
  }

  /**
   * Apply the first matching `answered` event for each pending interaction.
   *
   * @returns Interaction ids the host face accepted this tick; the reporter excludes
   *   them from `current` so it can write `completed` in the same pass.
   */
  async reconcile(pending: readonly PendingInteraction[]): Promise<ReadonlySet<string>> {
    const applied = new Set<string>()
    if (this.deps.enabled?.() === false) return applied
    const commentsByIssue = new Map<string, Awaited<ReturnType<ThreadService['list']>>>()

    for (const item of pending) {
      if (applied.has(item.id)) continue
      const taskId = item.taskId ?? this.deps.tasks.taskIdOfSession(item.sessionId)
      if (taskId === undefined) continue
      const task = this.deps.tasks.get(taskId)
      if (task === undefined || task.trashedAt !== undefined) continue
      if (task.issueId === undefined || task.issueId === '') continue
      const issueId = task.issueId
      if (this.deps.links.get(issueId)?.assigneeSessionId !== item.sessionId) continue

      let comments = commentsByIssue.get(issueId)
      if (comments === undefined) {
        try {
          comments = await this.deps.thread.list(issueId)
        } catch (error) {
          this.log('warn', 'interaction-bridge-comments-failed', { issueId, error: errorText(error) })
          continue
        }
        commentsByIssue.set(issueId, comments)
      }

      const answer = findAnswer(comments, item, issueId)
      if (answer === undefined) continue
      try {
        const ok = answer.event === 'approval'
          ? await this.deps.interactions.answerRemote({
            interactionId: item.id,
            sessionId: item.sessionId,
            kind: 'approval',
            decision: answer.decision,
            ...(answer.note === undefined ? {} : { note: answer.note }),
          })
          : await this.deps.interactions.answerRemote({
            interactionId: item.id,
            sessionId: item.sessionId,
            kind: 'question',
            answers: answer.answers,
          })
        if (ok) {
          applied.add(item.id)
          this.log('info', 'interaction-bridge-applied', { interactionId: item.id, issueId })
        }
      } catch (error) {
        // Leave it pending; the next tick retries the same comment.
        this.log('warn', 'interaction-bridge-apply-failed', { interactionId: item.id, error: errorText(error) })
      }
    }
    return applied
  }

  private log(level: 'info' | 'warn', event: string, detail?: unknown): void {
    this.deps.log?.(level, event, detail)
  }
}

type Answer =
  | { event: 'approval'; decision: AnsweredApprovalEvent['answer']['decision']; note?: string }
  | { event: 'question'; answers: AnsweredQuestionEvent['answer']['answers'] }

function findAnswer(
  comments: readonly { readonly authorType: string; readonly body: string; readonly role?: string | null }[],
  item: PendingInteraction,
  issueId: string,
): Answer | undefined {
  for (const comment of comments) {
    if (comment.authorType !== 'system' || comment.role !== 'assigner') continue
    const decoded = decodeInteraction(comment.body)
    if (!decoded.ok || decoded.event.event !== 'answered') continue
    const event = decoded.event
    if (event.issueId !== issueId || event.interactionId !== item.id || event.sessionId !== item.sessionId) continue
    if (event.kind !== item.kind) continue
    if (event.kind === 'approval') {
      return {
        event: 'approval',
        decision: event.answer.decision,
        ...(event.answer.note === undefined ? {} : { note: event.answer.note }),
      }
    }
    return { event: 'question', answers: event.answer.answers }
  }
  return undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
