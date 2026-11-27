/**
 * Interaction delivery gate.
 *
 * System comments are normally traces and wake no session. The only exception is a
 * `requested` / `completed` control comment (and a malformed control-like comment,
 * which falls back to plain text per the protocol's parse-failure rule).
 *
 * @module dsh-magica-castboard/host/pipeline/interaction-delivery
 */
import {
  decodeInteraction,
  isInteractionBody,
  type InteractionEvent,
} from '../../shared/interaction-protocol.ts'
import type { ThreadComment } from '../ledger/comment-store.ts'

/** A valid, deliverable control event: system + assignee + this issue + requested/completed. */
export function isDeliverableInteraction(comment: ThreadComment, anchorId: string): boolean {
  if (comment.authorType !== 'system') return false
  if (comment.role !== 'assignee') return false
  const decoded = decodeInteraction(comment.body)
  if (!decoded.ok) return false
  return isDeliverableEvent(decoded.event, anchorId)
}

/**
 * A system comment that looks like the interaction protocol but failed to decode.
 * It is delivered as ordinary text rather than dropped.
 */
export function isMalformedInteractionLike(comment: ThreadComment): boolean {
  if (comment.authorType !== 'system') return false
  if (comment.role !== 'assignee') return false
  if (!isInteractionBody(comment.body)) return false
  const decoded = decodeInteraction(comment.body)
  return !decoded.ok && decoded.reason === 'malformed'
}

/** The single narrow gate used by `deliver`, `retryPending` and `route`. */
export function isInteractionDeliverable(comment: ThreadComment, anchorId: string): boolean {
  return isDeliverableInteraction(comment, anchorId) || isMalformedInteractionLike(comment)
}

function isDeliverableEvent(event: InteractionEvent, anchorId: string): boolean {
  return event.issueId === anchorId
    && (event.event === 'requested' || event.event === 'completed')
}
