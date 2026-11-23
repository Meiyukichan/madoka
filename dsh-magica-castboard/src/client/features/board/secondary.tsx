/**
 * 次页签：已取消 / 已归档 / 已删除。
 *
 * @module dsh-magica-castboard/client/features/board/secondary
 */
import type { TaskSummaryView } from '../../data/index.ts'
import type { BoardStore } from '../../data/state/index.ts'
import type { Translate } from '../../labels/index.ts'
import { COLUMN_LABEL } from '../../data/derive/index.ts'
import { StatusOrb } from '../../kit/index.ts'
import { TaskTile } from './tiles.tsx'

/** 次页签：已取消 / 已归档 / 已删除。 */
export function SecondaryPage({ store, tasks, t, lang, onAlert }: {
  store: BoardStore
  tasks: readonly TaskSummaryView[]
  t: Translate
  lang: 'zh' | 'en'
  onAlert: (message: string) => void
}) {
  const trashed = tasks.filter(task => task.trashedAt !== undefined)
  const archived = tasks.filter(task => task.trashedAt === undefined && task.status === 'archived')
  const canceled = tasks.filter(task => task.trashedAt === undefined && task.status === 'canceled')
  const groups = [
    { label: t(COLUMN_LABEL.canceled), dot: 'canceled', rows: canceled },
    { label: t(COLUMN_LABEL.archived), dot: 'archived', rows: archived },
    { label: t('board.trashed'), dot: 'trashed', rows: trashed },
  ]
  if (canceled.length + archived.length + trashed.length === 0) {
    return <div className="lt-secondary"><div className="lt-empty">{t('board.secondaryEmpty')}</div></div>
  }
  return (
    <div className="lt-lanes">
      {groups.map(group => (
        <div className="lt-lane" key={group.label}>
          <div className="lt-lane-head">
            <StatusOrb status={group.dot} />
            {group.label}
            <span className="lt-count">{group.rows.length}</span>
          </div>
          <div className="lt-tiles">
            {group.rows.map(task => (
              <TaskTile key={task.id} task={task} store={store} t={t} lang={lang} draggable={false} onAlert={onAlert} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

