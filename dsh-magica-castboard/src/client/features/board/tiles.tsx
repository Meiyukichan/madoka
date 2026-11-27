/**
 * 任务卡与待规划卡。
 *
 * @module dsh-magica-castboard/client/features/board/tiles
 */
import {
  IconAgentPresetOutlineRegular,
  IconAlarmClockOutlineRegular,
  IconChecklistOutlineRegular,
  IconQuestionOutlineRegular,
  IconRightUpOutlineRegular,
  IconTrashOutlineRegular,
  IconUserOutlineRegular,
  Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'

import type { IssueSummary } from '../../../shared/wire.ts'
import { canTransition, normalizeIssueSource } from '../../../shared/wire.ts'
import type { TaskSummaryView } from '../../data/index.ts'
import type { BoardStore } from '../../data/state/index.ts'
import type { Translate } from '../../labels/index.ts'
import { Tip } from '../../kit/index.ts'
import { COLUMN_LABEL, OUTCOME_LABEL, URGENCY_LABEL, isSessionId, shortSession, stampTime } from '../../data/derive/index.ts'

/** 一条待决交互在卡片上的入口。 */
function CardInteraction({ count, onClick, t }: { count: number; onClick: () => void; t: Translate }) {
  return (
    <Tip label={t('card.interactionTitle', { n: String(count) })}>
      <button
        type="button"
        className="lt-card-pending"
        aria-label={t('card.interactionTitle', { n: String(count) })}
        onClick={event => { event.stopPropagation(); onClick() }}
      >
        <IconQuestionOutlineRegular size={12} />
        <span className="lt-card-pending-label">{t('card.interaction')}</span>
      </button>
    </Tip>
  )
}

const DRAG_MIME = 'application/x-castboard-task'

export { DRAG_MIME }

/** 任务卡。 */
export function TaskTile({ task, store, t, lang, draggable, onAlert }: {
  task: TaskSummaryView
  store: BoardStore
  t: Translate
  lang: 'zh' | 'en'
  draggable: boolean
  onAlert: (message: string) => void
}) {
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const snapshot = store.getSnapshot()
  const interactions = store.interactionsFor(task.id)
  const running = task.hasRunning === true
  const reviewing = task.status === 'in_review' && task.trashedAt === undefined
  /** 来源 issue 上有未读评论（`/state` 由关系表现算）。 */
  const unread = task.issueId !== undefined && snapshot.issueLinks?.[task.issueId]?.hasUnread === true
  /** This card has acceptance strategies: its review decides done vs back to todo. */
  const autoAccept = (task.acceptanceStrategyCount ?? 0) > 0
  const dispatching = task.dispatching === true
  const canAbandon = task.trashedAt === undefined && canTransition(task.status, 'abandoned')
  const unchecked = task.checklistProgress === undefined ? 0 : task.checklistProgress.total - task.checklistProgress.done
  const sessionId = task.lastSessionId ?? (isSessionId(task.claimedBy) ? task.claimedBy : undefined)
  const runKind = dispatching
    ? { label: t('card.dispatching'), title: t('card.dispatchingTitle'), tone: 'warn' as const }
    : task.accepting === true
      ? { label: t('card.accepting'), title: t('card.acceptingTitle'), tone: 'ok' as const }
      : task.runningTrigger === 'dispatch'
        ? { label: t('card.dispatching'), title: t('card.dispatchingTitle'), tone: 'warn' as const }
        : task.runningTrigger === 'acceptance'
          ? { label: t('card.accepting'), title: t('card.acceptingTitle'), tone: 'ok' as const }
          : undefined

  const jump = (): void => {
    if (sessionId === undefined) return
    void store.openSession(sessionId).then(result => {
      if (result === 'missing') onAlert(t('card.sessionMissing', { id: shortSession(sessionId) }))
      else if (result === 'archived') onAlert(t('card.sessionArchived', { id: shortSession(sessionId) }))
      else if (result === 'unavailable') onAlert(t('card.sessionUnavailable', { id: sessionId }))
    })
  }

  const submitReject = (): void => {
    void store.reject(task.id, note).then(ok => {
      if (ok) { setRejecting(false); setNote('') }
    })
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className="lt-tile"
      data-urgency={task.urgency}
      data-pending={interactions.length > 0 ? 'interaction' : undefined}
      draggable={draggable && !rejecting}
      onDragStart={event => {
        if (running) {
          event.preventDefault()
          onAlert(t('card.runningDrag', { title: task.title }))
          return
        }
        event.dataTransfer.setData(DRAG_MIME, task.id)
        event.dataTransfer.effectAllowed = 'move'
        event.currentTarget.dataset.dragging = 'true'
      }}
      onDragEnd={event => { delete event.currentTarget.dataset.dragging }}
      onClick={() => { store.select(task.id) }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          store.select(task.id)
        }
      }}
    >
      <div className="lt-tile-title"><Tip label={task.title} align="center"><span>{task.title}</span></Tip></div>
      {unread && <Tip label={t('card.unread')}><span className="lt-unread" role="status" /></Tip>}
      {canAbandon && (
        <Tip label={t('card.abandonTitle')}>
          <button
            type="button"
            className="lt-tile-remove"
            aria-label={t('card.abandonTitle')}
            onClick={event => {
              event.stopPropagation()
              store.openAbandon({ kind: 'task', id: task.id, title: task.title })
            }}
          >
            <IconTrashOutlineRegular size={14} />
          </button>
        </Tip>
      )}
      <div className="lt-tile-meta">
        <span className="lt-tag" data-urgency={task.urgency}>{t(URGENCY_LABEL[task.urgency])}</span>
        {task.blocked === true && <span className="lt-tag" data-tone="blocked">{t('common.blocked')}</span>}
        {task.execution?.mode === 'scheduled' && (
          <span className="lt-tag" data-tone="scheduled"><IconAlarmClockOutlineRegular size={12} /> {stampTime(task.nextRunAt === undefined ? undefined : Date.parse(task.nextRunAt))}</span>
        )}
        {task.model !== undefined && (
          <Tip label={t('card.model', { model: task.model })}>
            <span className="lt-tag">{task.model.split('/').pop() ?? task.model}</span>
          </Tip>
        )}
        {task.permission === 'read-only' && (
          <Tip label={t('card.permReadOnlyTitle')}><span className="lt-tag" data-tone="blocked">{t('card.permReadOnly')}</span></Tip>
        )}
        {task.permission === 'danger-full-access' && (
          <Tip label={t('card.permFullTitle')}><span className="lt-tag" data-tone="urgent">{t('card.permFull')}</span></Tip>
        )}
        {task.checklistProgress !== undefined && (
          <Tip label={reviewing && unchecked > 0 ? t('card.checklistReview') : t('card.checklist')}>
            <span className="lt-tag" data-tone={reviewing && unchecked > 0 ? 'blocked' : 'checklist'}>
              <IconChecklistOutlineRegular size={12} /> {task.checklistProgress.done}/{task.checklistProgress.total}
            </span>
          </Tip>
        )}
        {task.status === 'done' && <span className="lt-tag" data-tone="done">{t('status.pill.done')}</span>}
        {task.lastExecutionOutcome !== undefined && (
          <span className="lt-tag" data-tone={task.lastExecutionOutcome}>{t(OUTCOME_LABEL[task.lastExecutionOutcome] ?? task.lastExecutionOutcome)}</span>
        )}
        {sessionId !== undefined && (
          <Tip label={t('card.jump', { id: sessionId })}>
            <button
              type="button"
              className="lt-session"
              onClick={event => { event.stopPropagation(); jump() }}
            >
              <IconAgentPresetOutlineRegular size={12} /> {shortSession(sessionId)} <IconRightUpOutlineRegular size={12} />
            </button>
          </Tip>
        )}
        {task.acceptanceFailed === true && (
          <Tip label={t('card.acceptanceFailedTitle')}><span className="lt-tag" data-tone="failed">{t('card.acceptanceFailed')}</span></Tip>
        )}
        {task.trashedAt !== undefined && <span className="lt-tag" data-tone="trashed">{t('card.pendingPurge')}</span>}
        {task.status === 'done' && task.dispatchedIssueCount !== undefined && (
          <Tip label={t('card.dispatchedTitle', { n: String(task.dispatchedIssueCount) })}>
            <span className="lt-tag" data-tone="dispatched">{t('card.dispatched')}</span>
          </Tip>
        )}
        <span className="lt-tile-right">
          {interactions.length > 0 && <CardInteraction count={interactions.length} onClick={() => { store.openInteraction(task.id) }} t={t} />}
          {runKind !== undefined && (
            <Tip label={runKind.title}>
              <span className="lt-card-run" data-tone={runKind.tone}>
                <IconAlarmClockOutlineRegular size={12} />
                {runKind.tone === 'warn'
                  ? <span className="lt-card-run-label">{runKind.label}</span>
                  : <span>{runKind.label}</span>}
              </span>
            </Tip>
          )}
          <span>{stampTime(task.updatedAt)}</span>
        </span>
      </div>
      {reviewing && runKind === undefined && !autoAccept && (rejecting
        ? (
            <div className="lt-quick-reject" onClick={event => { event.stopPropagation() }}>
              <Input
                className="lt-input"
                value={note}
                placeholder={t('card.rejectPlaceholder')}
                onChange={event => { setNote(event.target.value) }}
                onKeyDown={event => {
                  if (event.key === 'Enter') submitReject()
                  else if (event.key === 'Escape') { setRejecting(false); setNote('') }
                }}
              />
              <button type="button" className="lt-quickbtn" data-act="confirm" onClick={submitReject}>{t('card.rejectConfirm')}</button>
              <button type="button" className="lt-quickbtn" data-act="cancel" onClick={() => { setRejecting(false); setNote('') }}>{t('common.cancel')}</button>
            </div>
          )
        : (
            <div className="lt-quick" onClick={event => { event.stopPropagation() }}>
              <Tip label={t('card.doneTitle')}><button type="button" className="lt-quickpill" data-tone="ok" onClick={() => { void store.move(task.id, 'done') }}>{t('card.done')}</button></Tip>
              <Tip label={t('card.dispatchTitle')}><button type="button" className="lt-quickpill" data-tone="dispatch" onClick={() => { store.openDispatch(task.id) }}>{t('card.dispatch')}</button></Tip>
              <Tip label={t('card.rejectTitle')}><button type="button" className="lt-quickpill" data-tone="muted" onClick={() => { setRejecting(true) }}>{t('card.reject')}</button></Tip>
            </div>
          ))}
    </div>
  )
}

/** 待规划卡。 */
export function IssueTile({ issue, store, t }: { issue: IssueSummary; store: BoardStore; t: Translate }) {
  const unread = store.getSnapshot().issueLinks?.[issue.issueId]?.hasUnread === true
  const open = (): void => { void store.openIssueEditor(issue.issueId) }
  return (
    <div
      role="button"
      tabIndex={0}
      className="lt-tile"
      data-urgency={issue.urgency}
      onClick={open}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      }}
    >
      <div className="lt-tile-title"><Tip label={issue.title} align="center"><span>{issue.title}</span></Tip></div>
      {unread && <Tip label={t('card.unread')}><span className="lt-unread" role="status" /></Tip>}
      <Tip label={t('issue.abandonTitle')}>
        <button
          type="button"
          className="lt-tile-remove"
          aria-label={t('issue.abandonTitle')}
          onClick={event => {
            event.stopPropagation()
            store.openAbandon({ kind: 'issue', id: issue.issueId, title: issue.title })
          }}
        >
          <IconTrashOutlineRegular size={14} />
        </button>
      </Tip>
      <div className="lt-tile-meta">
        <span className="lt-tag" data-urgency={issue.urgency}>{t(URGENCY_LABEL[issue.urgency])}</span>
        <Tip label={t('issue.source')}>
          <span className="lt-tag" data-tone="source">{normalizeIssueSource(issue.source)}</span>
        </Tip>
        {issue.assignee !== undefined && issue.assignee !== '' && (
          <Tip label={t('issue.assigner')}>
            <span className="lt-tag" data-tone="assigner">
              <IconUserOutlineRegular size={12} /> {issue.assignee}
            </span>
          </Tip>
        )}
        <span className="lt-tile-right">
          {issue.status === 'routing' && (
            <Tip label={t('issue.routingTitle')}>
              <span className="lt-card-planning">
                <IconAgentPresetOutlineRegular size={12} />
                <span>{t('issue.routing')}</span>
              </span>
            </Tip>
          )}
          <span>{stampTime(issue.updatedAt)}</span>
        </span>
      </div>
    </div>
  )
}

