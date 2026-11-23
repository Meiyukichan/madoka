/**
 * 交互总览的全局浮层。
 *
 * `shell.overlay` 是 root scope 的常驻槽位：侧栏入口（`sidebar.panellist`）在
 * 任何页面都能点到，弹窗不能只在看板面板页里渲染，否则点侧栏「待交互」只会
 * 改 state、界面毫无反应，必须切回看板才突然弹出来。
 *
 * @module dsh-magica-castboard/client/features/interactions/overlay
 */
import { useSyncExternalStore } from 'react'

import { InteractionInbox } from './dialogs.tsx'
import type { BoardStore } from '../../data/state/index.ts'
import type { Translate } from '../../labels/index.ts'

/** 全局交互总览：`interactionInboxOpen` 一开就出现，与当前主页面无关。 */
export function InteractionOverlay({ store, t }: { store: BoardStore; t: Translate }) {
  const state = useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())
  if (!state.interactionInboxOpen) return null
  return (
    <InteractionInbox
      views={store.allInteractions()}
      taskTitleOf={sessionId => store.taskForSession(sessionId)?.title}
      store={store}
      t={t}
      onClose={() => { store.closeInteractionInbox() }}
    />
  )
}
