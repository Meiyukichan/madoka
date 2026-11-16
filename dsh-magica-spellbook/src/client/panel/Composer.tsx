/**
 * 会话页 `conversation.composer` 槽位组件：读模块级 runtime，把卡片画在输入框位置。
 *
 * @module dsh-magica-spellbook/client/panel/Composer
 */

import { InteractionCard } from './Card.tsx'
import { interactionRuntime } from './runtime.ts'
import type { PendingInteractionRecord } from '../../shared/wire.ts'

/**
 * 槽位组件。
 *
 * `key` 是承重墙：dsh 的 chain 槽位按注册项做 key，不加这个显式 key 时，
 * 多题卡片翻到第 3 题后换成单题交互会整页卡死（React 复用实例、内部 state 停在第 3 题）。
 */
export function InteractionComposer({ matched }: { matched: unknown }): React.ReactElement | null {
  const view = matched as PendingInteractionRecord | undefined
  const runtime = interactionRuntime()
  if (view === undefined || runtime === undefined) return null
  return (
    <InteractionCard
      key={`${view.kind}:${view.id}`}
      view={view}
      t={runtime.t}
      actions={runtime.actions}
      variant="takeover"
    />
  )
}
