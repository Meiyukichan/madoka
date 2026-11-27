/**
 * Human-readable line for a control comment in the board UI.
 *
 * Ordinary comments return `undefined` and keep their existing bubble/Markdown path.
 * Malformed control comments also return `undefined` (the user's "parse failure =
 * default text" rule); an unsupported version shows a short warning instead of raw JSON.
 *
 * @module dsh-magica-castboard/client/features/interactions/control-comment
 */
import {
  decodeInteraction,
  interactionSummary,
  isInteractionComment,
} from '../../../shared/interaction-protocol.ts'
import type { Translate } from '../../labels/index.ts'

export function controlCommentText(
  comment: { readonly authorType?: string; readonly body: string },
  t: Translate,
): string | undefined {
  if (!isInteractionComment(comment)) return undefined
  const decoded = decodeInteraction(comment.body)
  if (!decoded.ok) {
    return decoded.reason === 'unsupported' ? t('interaction.unsupported') : undefined
  }
  const summary = interactionSummary(decoded.event)
  if (decoded.event.event === 'requested') {
    return t('interaction.summaryRequested', { title: summary.title })
  }
  if (decoded.event.event === 'answered') {
    return t('interaction.summaryAnswered', { title: summary.title })
  }
  return t('interaction.summaryCompleted', { outcome: decoded.event.outcome })
}
