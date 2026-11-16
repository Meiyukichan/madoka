/**
 * 浏览器侧入口（`dsh-magica-spellbook/client`）。
 *
 * 注意：spellbook 是**库**不是插件，所以这里不导出 `apply` / `inject`；
 * 消费插件的 client 半自己写 `apply(ctx)`，在里面调 `createInteractionSurface` 并把
 * `DirectoryBrowser` 渲染进自己的设置面板。
 *
 * @module dsh-magica-spellbook/client
 */

export * from './panel/index.ts'
export {
  INTERACTION_PATHS,
  INTERACTION_PREFIX,
  INTERACTION_TAG,
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
