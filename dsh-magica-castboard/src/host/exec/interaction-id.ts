/**
 * Stable comment id for a control event.
 *
 * The id is the idempotency key: re-emitting the same event (retry, restart, the same
 * answer twice) must not add a second comment. `requested` / `completed` have one event
 * per interaction, so their payload is deliberately excluded; `answered` includes the
 * canonical answer so a different answer gets a different row.
 *
 * @module dsh-magica-castboard/host/exec/interaction-id
 */
import { createHash } from 'node:crypto'

import { canonicalInteractionAnswer, type InteractionEvent } from '../../shared/interaction-protocol.ts'

/** Derive the UUID-shaped comment id for one event. */
export function interactionCommentId(event: InteractionEvent): string {
  const key = event.event === 'answered'
    ? `${event.issueId}\u0000${event.interactionId}\u0000answered\u0000${canonicalInteractionAnswer(event)}`
    : `${event.issueId}\u0000${event.interactionId}\u0000${event.event}`
  return uuidFromSha256(key)
}

function uuidFromSha256(value: string): string {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
