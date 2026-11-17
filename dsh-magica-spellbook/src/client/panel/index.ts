/**
 * 卡片与接管（浏览器侧）的公开出口。
 * @module dsh-magica-spellbook/client/panel
 */

export { InteractionCard } from './Card.tsx'
export type { InteractionCardProps } from './Card.tsx'

export { InteractionComposer } from './Composer.tsx'

export {
  INTERACTION_TAG,
  PendingInteractionCarrier,
  interactionRecords,
  isInteractionCarrier,
} from './carrier.ts'
export type { InteractionActions, InteractionResult, SessionPendingInteractionBase } from './carrier.ts'

export { INTERACTION_LOCALE_NS, en, makeTranslate, zh } from './locales.ts'
export type { InteractionKey, InteractionTranslate } from './locales.ts'

export { INTERACTION_STYLE_ID, INTERACTION_STYLES, injectInteractionStyles } from './styles.ts'

export { createInteractionTransport } from './transport.ts'
export type { InteractionTransport } from './transport.ts'

export { INTERACTION_POLL_MS, createInteractionSurface } from './surface.ts'
export type { InteractionScopeFace, InteractionSurface, InteractionSurfaceOptions } from './surface.ts'

export { interactionRuntime } from './runtime.ts'
export type { InteractionRuntime } from './runtime.ts'

// ── 纯函数/装配模块也对外导出（diff「幽灵声明」十条）────────────────
// d.ts 早就声明了这些符号，但产物导出表里没有 → 按 d.ts import 会拿到 undefined。
export { currentLang, pickDisplayText } from './display-text.ts'
export type { LocalizedReason } from './display-text.ts'

export { parseRecommended } from './recommended.ts'

export { InteractionRegistry, carrierKey, claim } from './registry.ts'
export type { PublishFn } from './registry.ts'

export { serviceOf } from './services.ts'
export type { SlotsFace, UiSessionFace } from './services.ts'
