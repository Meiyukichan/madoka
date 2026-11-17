/**
 * 浏览器侧载体：把一条待决项发布进 `uiSession` 的 pending-interaction 注册表。
 *
 * 认领靠**标记字段**（`tag`）而不是 `instanceof`：热重载后旧实例仍在注册表里，
 * 类身份会失效，标记不会。
 *
 * 基类形状直接取 dsh 的 `SessionPendingInteractionBase`
 * （`@deepseek-ai/dsh-client-ui-session/client`）——`registerPendingInteraction<T>` 的约束就是它。
 * 我们只额外加"标记 + 视图"两个自有字段。
 *
 * @module dsh-magica-spellbook/client/panel/carrier
 */

import {
  INTERACTION_TAG,
  type InteractionAnswerItem,
  type PendingInteractionRecord,
} from '../../shared/interaction.ts'
import { asSessionId } from '../../shared/dsh.ts'
import type { SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'

export { INTERACTION_TAG }

/** dsh 的待决交互基类（我们发布的载体必须满足它；形状直接来自 dsh）。 */
export type { SessionPendingInteractionBase }

/** 一条待决项的浏览器侧载体（dsh 待决项基类 + 我们自己的标记与视图）。 */
export class PendingInteractionCarrier implements SessionPendingInteractionBase {
  readonly tag = INTERACTION_TAG
  readonly key: string
  readonly kind: 'question' | 'approval'
  readonly sessionId: SessionPendingInteractionBase['sessionId']
  readonly view: PendingInteractionRecord

  constructor(view: PendingInteractionRecord) {
    this.view = view
    this.kind = view.kind
    this.sessionId = asSessionId(view.sessionId)
    this.key = `${view.kind}:${view.id}`
  }
}

/** 判「是不是本 SDK 发布的载体」。 */
export function isInteractionCarrier(value: unknown): value is PendingInteractionCarrier {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { tag?: unknown; key?: unknown; kind?: unknown; sessionId?: unknown }
  return (
    candidate.tag === INTERACTION_TAG
    && typeof candidate.key === 'string'
    && typeof candidate.kind === 'string'
    && typeof candidate.sessionId === 'string'
  )
}

/** 一次应答的结果（失败带消息，供就地显示）。 */
export type InteractionResult = { ok: true } | { ok: false; error: string }

/** 卡片与看板共用的应答入口。 */
export interface InteractionActions {
  answerQuestion(view: PendingInteractionRecord, answers: InteractionAnswerItem[]): Promise<InteractionResult>
  cancelQuestion(view: PendingInteractionRecord): Promise<InteractionResult>
  answerApproval(view: PendingInteractionRecord, decision: 'allowed-once' | 'rejected'): Promise<InteractionResult>
}

/** 从 `uiSession.pendingInteractions` 快照里挑出本 SDK 的待决项（按 `since` 升序）。 */
export function interactionRecords(snapshot: ReadonlyMap<string, unknown>): PendingInteractionRecord[] {
  const out: PendingInteractionRecord[] = []
  for (const value of snapshot.values()) {
    if (!isInteractionCarrier(value)) continue
    out.push(value.view)
  }
  return out.sort((a, b) => (a.since === b.since ? a.id.localeCompare(b.id) : a.since - b.since))
}
