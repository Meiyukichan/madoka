/**
 * 交互弹窗：卡片级与总览。
 *
 * @module dsh-magica-castboard/client/features/interactions/dialogs
 */
import type { InteractionView } from '../../data/index.ts'
import type { BoardStore } from '../../data/state/index.ts'
import type { Translate } from '../../labels/index.ts'
import { ActionButton, Sheet, Tip } from '../../kit/index.ts'
import { waitedText } from '../../data/derive/index.ts'
import { InteractionRow } from './card.tsx'

/** 单卡弹窗。 */
export function InteractionDialog({ views, taskTitle, store, t, onClose }: {
  views: readonly InteractionView[]
  taskTitle?: string
  store: BoardStore
  t: Translate
  onClose: () => void
}) {
  return (
    <Sheet
      open
      onClose={onClose}
      title={t('interaction.modalTitle')}
      hint={taskTitle === undefined ? t('interaction.modalSubtitle') : t('interaction.modalSubtitleTask', { title: taskTitle })}
      width="md"
      footer={<ActionButton tone="outline" onClick={onClose}>{t('common.close')}</ActionButton>}
    >
      <div className="lt-interaction-list">
        {views.map(view => <InteractionRow key={`${view.kind}:${view.id}`} view={view} store={store} t={t} />)}
      </div>
    </Sheet>
  )
}

/** 总览弹窗。 */
export function InteractionInbox({ views, taskTitleOf, store, t, onClose }: {
  views: readonly InteractionView[]
  taskTitleOf: (sessionId: string) => string | undefined
  store: BoardStore
  t: Translate
  onClose: () => void
}) {
  return (
    <Sheet
      open
      onClose={onClose}
      title={t('interaction.inboxTitle')}
      width="lg"
      footer={<ActionButton tone="outline" onClick={onClose}>{t('common.close')}</ActionButton>}
    >
      {views.length === 0
        ? <div className="lt-empty">{t('interaction.inboxEmpty')}</div>
        : (
            <div className="lt-inbox">
              {views.map(view => {
                const title = taskTitleOf(view.sessionId)
                return (
                  <div className="lt-inbox-row" key={`${view.kind}:${view.id}`}>
                    <div className="lt-inbox-head">
                      <div className="lt-inbox-title"><Tip label={title ?? t('interaction.orphan')} align="center"><span>{title ?? t('interaction.orphan')}</span></Tip></div>
                      <div className="lt-inbox-meta">
                        <span className="lt-inbox-kind" data-kind={view.kind}>{t(`interaction.kind${view.kind === 'approval' ? 'Approval' : 'Question'}`)}</span>
                        <Tip label={t('interaction.waitTitle')}><span>{t('interaction.waited', { time: waitedText(t, view.createdAt) })}</span></Tip>
                      </div>
                    </div>
                    <InteractionRow view={view} store={store} t={t} />
                  </div>
                )
              })}
            </div>
          )}
    </Sheet>
  )
}
