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

// 我们自己的线上契约（路径 / 信封 / 请求体），不是 dsh 类型镜像。
export {
  INTERACTION_PATHS,
  INTERACTION_PREFIX,
  INTERACTION_TAG,
  WATERFALL_TAKEOVER,
} from '../shared/interaction.ts'

export type {
  AnswerApprovalBody,
  AnswerQuestionBody,
  CancelQuestionBody,
  InteractionAnswer,
  InteractionAnswerItem,
  InteractionAnswerValue,
  InteractionEnvelope,
  InteractionIntent,
  InteractionListValue,
  InteractionOption,
  InteractionQuestion,
  PendingInteractionRecord,
} from '../shared/interaction.ts'
