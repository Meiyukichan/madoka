/**
 * 待决交互（host 面）的公开出口。
 * @module dsh-magica-spellbook/interactions
 */

export { collectPendingInteractions, clipArgs } from './collect.ts'
export type { CollectInteractionOptions } from './collect.ts'

export {
  isMagicaSession,
  noteMagicaSession,
  noteMagicaSessionInMemory,
  resetMagicaSessionCache,
  sessionStoreAvailable,
} from './ownership.ts'
export type { InteractionHostFace } from './ownership.ts'

export { MAX_BODY_BYTES, createInteractionHandler, interactionRoutes } from './route.ts'
export type { InteractionHandlerOptions } from './route.ts'

export {
  INTERACTION_PATHS,
  INTERACTION_PREFIX,
  INTERACTION_TAG,
  WATERFALL_TAKEOVER,
} from '../shared/wire.ts'

export type {
  AnswerApprovalBody,
  AnswerQuestionBody,
  CancelQuestionBody,
  InteractionAnswerItem,
  InteractionAnswerValue,
  InteractionEnvelope,
  InteractionIntent,
  InteractionListValue,
  InteractionOption,
  InteractionQuestion,
  PendingInteractionRecord,
} from '../shared/wire.ts'
