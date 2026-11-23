/**
 * 会话页接管：把看板已有的 pending interaction 发布到 `uiSession` 注册表，
 * 再通过 `conversation.composer` chain 在输入框上方渲染同一张交互卡。
 *
 * 数据源仍是看板 store 的 `/state` 轮询，不引入第二套 HTTP/轮询。
 *
 * @module dsh-magica-castboard/client/features/interactions/conversation
 */
import { createElement, type ReactElement } from 'react'

import type { InteractionView } from '../../data/index.ts'
import type { BoardStore } from '../../data/state/index.ts'

/** 只认本插件发布的载体，绝不抢 dsh / spellbook 自己的卡片。 */
const CARRIER_TAG = 'castboard-pending-interaction'

interface PendingBase {
  readonly key: string
  readonly kind: string
  readonly sessionId: string
}

class ConversationCarrier implements PendingBase {
  readonly tag = CARRIER_TAG
  readonly key: string
  readonly kind: 'question' | 'approval'
  readonly sessionId: string
  readonly view: InteractionView

  constructor(view: InteractionView) {
    this.view = view
    this.kind = view.kind
    this.sessionId = view.sessionId
    this.key = `${view.kind}:${view.id}`
  }
}

interface Publisher {
  (interaction: ConversationCarrier, delegate: () => Promise<void>): () => void
}

interface UiSessionFace {
  registerPendingInteraction?<T extends PendingBase>(precedence: (interaction: T) => number): Publisher
}

interface SlotsFace {
  inject?(key: string, callback: () => () => void): void
  register(options: Record<string, unknown>, component: unknown): () => void
}

interface Ctx {
  uiSession?: UiSessionFace
  slots: SlotsFace
}

interface ComposerOwner {
  pendingInteraction?: unknown
}

function isCarrier(value: unknown): value is ConversationCarrier {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { tag?: unknown; key?: unknown; view?: unknown; sessionId?: unknown }
  return candidate.tag === CARRIER_TAG
    && typeof candidate.key === 'string'
    && typeof candidate.sessionId === 'string'
    && typeof candidate.view === 'object'
    && candidate.view !== null
}

function earliestBySession(views: readonly InteractionView[]): Map<string, InteractionView> {
  const out = new Map<string, InteractionView>()
  for (const view of views) {
    if (view.sessionId === '') continue
    const previous = out.get(view.sessionId)
    if (previous === undefined || view.createdAt < previous.createdAt) out.set(view.sessionId, view)
  }
  return out
}

/**
 * 安装会话页接管。
 *
 * @returns disposer；`uiSession` / `conversation.composer` 不可用时什么都不做。
 */
export function installConversationInteractions(
  client: Ctx,
  store: BoardStore,
  render: (view: InteractionView) => ReactElement,
): () => void {
  const uiSession = client.uiSession
  const register = uiSession?.registerPendingInteraction?.bind(uiSession) as
    | ((precedence: (interaction: ConversationCarrier) => number) => Publisher)
    | undefined
  const publisher = register?.(() => 1)
  if (publisher === undefined) return () => {}

  const published = new Map<string, { dispose: () => void; key: string }>()

  const sync = (): void => {
    const wanted = earliestBySession(store.getSnapshot().interactions)
    for (const [sessionId, view] of wanted) {
      const key = `${view.kind}:${view.id}`
      const existing = published.get(sessionId)
      if (existing?.key === key) continue
      existing?.dispose()
      try {
        const dispose = publisher(new ConversationCarrier(view), async () => {})
        published.set(sessionId, { dispose, key })
      } catch {
        /* Publishing is best-effort; the sidebar inbox remains the fallback. */
      }
    }
    for (const [sessionId, entry] of published) {
      if (wanted.has(sessionId)) continue
      entry.dispose()
      published.delete(sessionId)
    }
  }

  const off = store.subscribe(sync)
  sync()

  const ConversationInteraction = ({ matched }: { matched?: unknown }): ReactElement | null => {
    if (!isCarrier(matched)) return null
    return createElement(
      'div',
      { className: 'lt-conversation-interaction' },
      render(matched.view),
    )
  }

  const slots = client.slots
  const disposeSlot = (() => {
    if (typeof slots.inject !== 'function') return undefined
    let dispose: (() => void) | undefined
    slots.inject('conversation.composer', () => {
      dispose = slots.register(
        {
          name: 'conversation.composer',
          // Only our tagged carrier wins this chain; dsh's own interaction stays intact.
          select: (owner: ComposerOwner) => (isCarrier(owner.pendingInteraction) ? owner.pendingInteraction : null),
        },
        ConversationInteraction,
      )
      return () => { dispose?.() }
    })
    return () => { dispose?.() }
  })()

  return () => {
    off()
    for (const entry of published.values()) entry.dispose()
    published.clear()
    disposeSlot?.()
  }
}
