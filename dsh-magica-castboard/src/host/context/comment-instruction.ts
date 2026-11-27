/**
 * Wake-up instructions for issue-comment delivery.
 *
 * Each side gets its own wording: the dispatcher has no card to protect.
 *
 * @module dsh-magica-castboard/host/context/comment-instruction
 */

export const WAKE_INSTRUCTION = 'The upstream issue has new comments; handle them as described in the injected context. Do not change task status.'

export const ASSIGNER_WAKE_INSTRUCTION = 'The issue you dispatched has new comments; handle them as described in the injected context.'
