/**
 * 看板页：五列（主�?+ 次要可折叠）+ 筛�?+ 拖拽�? *
 * 组件�?*纯展�?*：数据与动作全部由宿主（castboard 面板）通过 props 注入�? *
 * @module dsh-magica-teamwork/client/pages/board
 */
import { useMemo, useState, type ReactNode } from 'react'

import { Badge, Button, Card, Column, Empty, Input } from '../components/index.js'
import {
  DRAG_TYPE,
  SECONDARY_COLUMNS,
  checklistDone,
  draggable,
  filterCards,
  groupIntoColumns,
  type BoardCard,
  type BoardFilter,
} from '../model/columns.js'
import { labelOf, type Lang } from '../model/labels.js'

/** props�?*/
export interface BoardPageProps {
  cards: readonly BoardCard[]
  lang?: Lang
  onCreate?: () => void
  onOpen?: (taskId: string) => void
  onMove?: (taskId: string, toStatus: string) => void
  /** 允许迁移的目标（宿主按状态机算好；空 = 本地拦截）�?*/
  allowedTargets?: (taskId: string, toStatus: string) => boolean
}

/** 看板页�?*/
export function BoardPage(props: BoardPageProps): ReactNode {
  const lang = props.lang ?? 'zh'
  const [filter, setFilter] = useState<BoardFilter>({})
  const [showSecondary, setShowSecondary] = useState(false)

  const columns = useMemo(() => groupIntoColumns(filterCards(props.cards, filter), lang), [props.cards, filter, lang])
  const visible = showSecondary ? columns : columns.filter(column => !(SECONDARY_COLUMNS as readonly string[]).includes(column.status))

  return (
    <div className="dsh-atw-root">
      <div className="dsh-atw-toolbar">
        <Input value={filter.text ?? ''} placeholder={lang === 'en' ? 'Filter cards' : '筛选卡片'} onChange={text => { setFilter(prev => ({ ...prev, text })) }} />
        <select
          className="dsh-atw-input"
          value={filter.urgency ?? ''}
          onChange={event => { setFilter(prev => ({ ...prev, urgency: event.target.value === '' ? undefined : event.target.value })) }}
        >
          <option value="">{lang === 'en' ? 'Any urgency' : '全部紧急度'}</option>
          {['urgent', 'high', 'normal', 'low', 'relaxed'].map(urgency => (
            <option key={urgency} value={urgency}>{labelOf('urgency', urgency, lang)}</option>
          ))}
        </select>
        <Button onClick={() => { setFilter(prev => ({ ...prev, onlyRunning: prev.onlyRunning === true ? undefined : true })) }}>
          {lang === 'en' ? 'Running only' : '只看执行中'}
        </Button>
        <Button onClick={() => { setShowSecondary(prev => !prev) }}>
          {showSecondary ? (lang === 'en' ? 'Hide done/canceled' : '收起已收卡') : (lang === 'en' ? 'Show done/canceled' : '展开已收卡')}
        </Button>
        <span className="dsh-atw-toolbar-spacer" />
        {props.onCreate === undefined ? null : (
          <Button variant="primary" onClick={props.onCreate}>{lang === 'en' ? 'New task' : '新建任务'}</Button>
        )}
      </div>

      <div className="dsh-atw-board">
        {visible.length === 0 ? <Empty text={lang === 'en' ? 'No cards' : '还没有卡片'} /> : null}
        {visible.map(column => (
          <Column
            key={column.status}
            status={column.status}
            label={column.label}
            count={column.items.length}
            onDropTask={taskId => {
              if (props.allowedTargets !== undefined && !props.allowedTargets(taskId, column.status)) return
              props.onMove?.(taskId, column.status)
            }}
          >
            {column.items.map(card => {
              const progress = checklistDone(card)
              return (
                <Card
                  key={card.id}
                  id={card.id}
                  title={card.title}
                  running={card.hasRunning === true}
                  draggable={draggable(card)}
                  onClick={() => { props.onOpen?.(card.id) }}
                  onDragStart={event => {
                    event.dataTransfer.setData(DRAG_TYPE, card.id)
                    event.dataTransfer.setData('text/plain', card.id)
                  }}
                  meta={(
                    <>
                      <Badge tone={card.urgency === 'urgent' ? 'urgent' : card.urgency === 'high' ? 'warn' : 'neutral'}>
                        {labelOf('urgency', card.urgency, lang)}
                      </Badge>
                      {card.issueId === undefined ? null : <Badge>{card.issueId}</Badge>}
                      {progress.total > 0 ? <Badge>{`${progress.done}/${progress.total}`}</Badge> : null}
                      {card.hasRunning === true ? <Badge tone="ok">{labelOf('outcome', 'running', lang)}</Badge> : null}
                    </>
                  )}
                />
              )
            })}
          </Column>
        ))}
      </div>
    </div>
  )
}
