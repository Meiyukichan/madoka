/**
 * 任务详情抽屉：头部动作、状态迁移、时间线与发言。
 *
 * @module dsh-magica-castboard/client/features/task/drawer
 */
import {
  IconAgentPresetOutlineRegular,
  IconAlarmClockOutlineRegular,
  IconChecklistOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconRightUpOutlineRegular,
  IconSparkleRegular,
  IconTrashOutlineRegular,
  IconWarningOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useMemo, useState } from 'react'

import { canTransition, type TaskStatus } from '../../../shared/wire.ts'
import type { AcceptanceEntry, TaskAttachmentView, TaskDetailResponse } from '../../data/index.ts'
import type { BoardStore } from '../../data/state/index.ts'
import { ActionButton, CloseButton, Dropdown, MarkdownBody, StatusOrb } from '../../kit/index.ts'
import { InteractionRow } from '../interactions/card.tsx'
import type { Translate } from '../../labels/index.ts'
import {
  COLUMN_LABEL,
  MOVE_LABEL,
  PILL_LABEL,
  URGENCY_LABEL,
  isSessionId,
  shortSession,
  stampTime,
  taskSessionIds,
} from '../../data/derive/index.ts'
import {
  AcceptanceBlock,
  ChecklistBlock,
  Chip,
  CommentBubble,
  DispatchedBlock,
  ExecutionLine,
  ReportBlock,
  type TimelineRow,
} from './panels.tsx'

/** 详情抽屉。 */
export function Inspector({ detail, store, t, tasks, lang, onAlert }: {
  detail: TaskDetailResponse
  store: BoardStore
  t: Translate
  tasks: readonly import('../../data/index.ts').TaskSummaryView[]
  lang: 'zh' | 'en'
  onAlert: (message: string) => void
}) {
  const task = detail.task
  const state = store.getSnapshot()
  const [comment, setComment] = useState('')
  const [confirmDone, setConfirmDone] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [confirmPurge, setConfirmPurge] = useState(false)
  const [busy, setBusy] = useState(false)
  const [attachments, setAttachments] = useState<readonly TaskAttachmentView[]>([])
  useEffect(() => {
    let current = true
    setAttachments([])
    void store.taskAttachments(task.id).then(items => {
      if (current) setAttachments(items)
    })
    return () => { current = false }
  }, [store, task.id])
  const notify = onAlert

  const frozen = task.trashedAt !== undefined || task.status === 'archived'
  const canRun = !frozen && task.status !== 'in_progress' && task.status !== 'done'
  const cardStrategies = (task.acceptanceStrategies as unknown as AcceptanceEntry[] | undefined) ?? []
  const autoAccept = cardStrategies.length > 0
  const running = task.executions.find(execution => execution.outcome === 'running')
  const holder = task.status === 'in_progress' ? task.claimedBy : undefined
  const unchecked = (task.checklist ?? []).filter(item => !item.done).length
  const sessionExecution = [...task.executions].reverse().find(execution => execution.sessionId !== undefined)
  const targetSession = running?.sessionId ?? sessionExecution?.sessionId ?? (isSessionId(task.claimedBy) ? task.claimedBy : undefined)
  /** 归档卡时「连同会话归档」的候选（执行史 + 当前持有者）。 */
  const associatedSessions = taskSessionIds(task)
  const archiveResult = state.sessionArchive?.taskId === task.id ? state.sessionArchive.result : undefined
  const lastExecution = task.executions[task.executions.length - 1]
  const acceptanceFailed = (task as unknown as { acceptanceFailed?: boolean }).acceptanceFailed === true
    || (lastExecution?.trigger === 'acceptance' && lastExecution.outcome === 'failed')
  const timeline = useMemo<TimelineRow[]>(() => [
    ...(detail.comments ?? []).map((item): TimelineRow => ({ kind: 'comment', at: item.createdAt, comment: item })),
    ...task.executions.map((item): TimelineRow => ({ kind: 'execution', at: item.startedAt || Number.MAX_SAFE_INTEGER, execution: item })),
  ].sort((left, right) => left.at - right.at), [detail.comments, task.executions])
  const interactions = store.interactionsFor(task.id)
  const pickerChoices = useMemo(() => {
    // 切换任务下拉：主列优先、abandoned 不列（除了当前这张），同列按标题。
    const rank: Record<TaskStatus, number> = { todo: 0, in_progress: 1, in_review: 2, done: 3, canceled: 4, archived: 5, abandoned: 6 }
    const candidates = tasks
      .filter(item => item.id === task.id || item.status !== 'abandoned')
      .slice()
      .sort((left, right) => (rank[left.status] - rank[right.status]) || left.title.localeCompare(right.title, undefined, { numeric: true }))
    const groups: string[] = []
    const choices = candidates.map(item => {
      const group = t(COLUMN_LABEL[item.status])
      if (!groups.includes(group)) groups.push(group)
      return { value: item.id, label: item.title, group }
    })
    if (!choices.some(choice => choice.value === task.id)) choices.push({ value: task.id, label: task.title, group: t(COLUMN_LABEL[task.status]) })
    return choices
  }, [tasks, t, task.id, task.status, task.title])

  const jump = (sessionId: string): void => {
    void store.openSession(sessionId).then(result => {
      if (result === 'missing') notify(t('card.sessionMissing', { id: shortSession(sessionId) }))
      else if (result === 'archived') notify(t('card.sessionArchived', { id: shortSession(sessionId) }))
      else if (result === 'unavailable') notify(t('card.sessionUnavailable', { id: sessionId }))
    })
  }

  const runAction = (action: () => Promise<unknown>): void => {
    if (busy) return
    setBusy(true)
    void action().catch(() => undefined).finally(() => { setBusy(false) })
  }

  const moveTargets = (['todo', 'in_progress', 'in_review', 'done', 'canceled', 'archived'] as TaskStatus[])
    .filter(to => canTransition(task.status, to))

  return (
    <div className="lt-detail" data-urgency={task.urgency}>
      <div className="lt-detail-head">
        <div className="lt-title-row">
          <div className="lt-title-bar">
            <span className="lt-statuspill" data-status={task.status}>{t(PILL_LABEL[task.status] ?? task.status)}</span>
            <h3>
              <Dropdown
                label={t('detail.picker')}
                dataId="task-picker"
                value={task.id}
                choices={pickerChoices}
                onChange={next => { if (next !== task.id) store.select(next) }}
                triggerTitle={task.title}
                triggerClass="lt-title-select"
              />
            </h3>
          </div>
          <div className="lt-top-buttons">
            {targetSession !== undefined && <button type="button" className="lt-mini" title={t('detail.jumpTitle', { id: targetSession })} onClick={() => { jump(targetSession) }}>{t('detail.jump')}</button>}
            {!frozen && <button type="button" className="lt-mini" onClick={() => { void store.openEditor(task.id) }}>{t('detail.edit')}</button>}
            <button type="button" className="lt-mini" title={t('detail.duplicateTitle')} disabled={busy} onClick={() => { runAction(() => store.duplicate(task)) }}>{t('detail.duplicate')}</button>
            <button type="button" className="lt-mini" title={t('detail.saveTplTitle')} disabled={busy} onClick={() => {
              runAction(async () => {
                if (await store.saveAsTemplate(task)) notify(t('detail.saveTplDone'))
              })
            }}>{t('detail.saveTpl')}</button>
            {canRun && <button type="button" className="lt-run" title={task.model === undefined ? t('detail.runTitleDefault') : t('detail.runTitleModel', { model: task.model })} disabled={busy} onClick={() => { runAction(() => store.run(task.id)) }}>{t('detail.run')}</button>}
            {running !== undefined && (confirmCancel
              ? (
                  <span className="lt-inline-confirm">
                    <span>{t('detail.stopConfirm')}</span>
                    <ActionButton tone="danger" onClick={() => { void store.cancel(task.id); setConfirmCancel(false) }}>{t('detail.stop')}</ActionButton>
                    <ActionButton onClick={() => { setConfirmCancel(false) }}>{t('common.cancel')}</ActionButton>
                  </span>
                )
              : <button type="button" className="lt-run" data-danger="true" title={t('detail.stopTitle', { id: running.sessionId ?? '' })} onClick={() => { setConfirmCancel(true) }}>{t('detail.stopExec')}</button>)}
            <CloseButton label={t('common.close')} onClick={() => { store.select(undefined) }} />
          </div>
        </div>
        <div className="lt-chips">
          <Chip icon={<span className="lt-dot" data-urgency={task.urgency} />} tone={task.urgency}>{t(URGENCY_LABEL[task.urgency])}</Chip>
          {task.workspaceId !== undefined && (
            <Chip icon={<IconFolderOpenOutlineRegular size={12} />}>{state.workspaces.find(workspace => workspace.id === task.workspaceId)?.title ?? task.workspaceId}</Chip>
          )}
          {task.model !== undefined && <Chip icon={<IconSparkleRegular size={12} />} title={t('card.model', { model: task.model })}>{task.model}</Chip>}
          {task.presetId !== undefined && <Chip icon={<IconAgentPresetOutlineRegular size={12} />}>{task.presetId}</Chip>}
          {task.execution?.mode === 'scheduled' && <Chip icon={<IconAlarmClockOutlineRegular size={12} />}>{t('detail.chipNextRun', { cron: task.execution.cron ?? '', time: stampTime(task.nextRunAt === undefined ? undefined : Date.parse(task.nextRunAt)) })}</Chip>}
          {task.blocked === true && <Chip icon={<IconWarningOutlineRegular size={12} />} tone="urgent">{t('common.blocked')}</Chip>}
          {acceptanceFailed && (
            <Chip icon={<IconWarningOutlineRegular size={12} />} tone="urgent" title={t('card.acceptanceFailedTitle')}>{t('card.acceptanceFailed')}</Chip>
          )}
          {task.checklist !== undefined && task.checklist.length > 0 && (
            <Chip icon={<IconChecklistOutlineRegular size={12} />} tone={unchecked > 0 && task.status === 'in_review' ? 'urgent' : undefined}>
              {t('detail.chipChecklist', { done: String(task.checklist.length - unchecked), total: String(task.checklist.length) })}
            </Chip>
          )}
          {task.permission === 'read-only' && <Chip icon={<IconWarningOutlineRegular size={12} />} tone="urgent">{t('detail.chipReadOnly')}</Chip>}
          {task.permission === 'danger-full-access' && <Chip icon={<IconWarningOutlineRegular size={12} />} tone="urgent">{t('detail.chipFull')}</Chip>}
          {(task.permission === 'workspace-write' || task.permission === undefined) && <Chip icon={<IconFolderOpenOutlineRegular size={12} />}>{t('detail.chipWrite')}</Chip>}
          {targetSession !== undefined && (
            <button type="button" className="lt-chip lt-chip-link" title={t('card.jump', { id: targetSession })} onClick={() => { jump(targetSession) }}>
              <span className="lt-chip-icon"><IconAgentPresetOutlineRegular size={12} /></span>
              {holder !== undefined ? `${t('detail.chipHolder')}${shortSession(holder)}${t('detail.chipHolderSuffix')}` : shortSession(targetSession)}
            </button>
          )}
          {task.trashedAt !== undefined && <Chip icon={<IconTrashOutlineRegular size={12} />} tone="urgent">{t('detail.chipTrashed')}</Chip>}
        </div>
        <div className="lt-detail-sub">
          {t('detail.sub', {
            time: stampTime(task.updatedAt),
            who: task.updatedBy?.kind === 'agent'
              ? t('detail.byAgent', { id: shortSession(task.updatedBy.sessionId) })
              : task.updatedBy?.kind === 'system' ? t('detail.bySystem') : t('detail.byUser'),
          })}
        </div>
      </div>

      {interactions.length > 0 && (
        <div className="lt-card-block" data-kind="interaction">
          <div className="lt-block-label">{t('detail.fieldInteractions')}</div>
          {interactions.map(view => <InteractionRow key={`${view.kind}:${view.id}`} view={view} store={store} t={t} />)}
        </div>
      )}

      {task.detail !== undefined && task.detail !== '' && (
        <div className="lt-card-block">
          <div className="lt-block-label">{t('detail.detail')}</div>
          <div className="lt-desc"><MarkdownBody text={task.detail} t={t} /></div>
        </div>
      )}

      <ReportBlock task={task} t={t} />
      {attachments.length > 0 && (
        <div className="lt-card-block" data-kind="attachments">
          <div className="lt-block-label">{t('detail.attachments')}</div>
          {attachments.filter(item => item.targetType === 'issue').map(item => {
            const ready = item.state === 'ready'
            return (
              <div className="lt-checklist-item" key={`${item.targetType}:${item.targetId}:${item.fileId ?? item.path}`}>
                <button
                  type="button"
                  className="lt-mini"
                  disabled={!ready}
                  title={ready ? item.path : t('detail.attachmentPending')}
                  onClick={() => {
                    void navigator.clipboard.writeText(item.path)
                      .then(() => { onAlert(t('detail.attachmentCopied')) })
                      .catch(() => { onAlert(item.path) })
                  }}
                >
                  {item.name}
                </button>
                <span className="lt-block-meta">
                  {t(item.kind === 'input'
                    ? 'detail.attachmentInput'
                    : item.kind === 'output'
                      ? 'detail.attachmentOutput'
                      : 'detail.attachmentComment')}
                </span>
                <span className="lt-block-meta" data-tone={ready ? undefined : 'bad'}>
                  {ready ? t('detail.attachmentReady') : t('detail.attachmentPending')}
                </span>
              </div>
            )
          })}
        </div>
      )}
      <ChecklistBlock task={task} store={store} t={t} />
      {cardStrategies.length > 0 && <AcceptanceBlock strategies={cardStrategies} t={t} />}
      <DispatchedBlock ids={task.derivedIssues ?? []} store={store} t={t} />

      {archiveResult !== undefined && (
        <div className="lt-card-block" data-kind="archive" role="status">
          <div className="lt-block-label">{t('detail.archiveResult', { n: String(archiveResult.archived.length) })}</div>
          {archiveResult.failed.map(item => (
            <span key={item.sessionId} className="lt-note" data-tone="bad">{shortSession(item.sessionId)}: {item.error}</span>
          ))}
          {archiveResult.unsupported.length > 0 && (
            <span className="lt-note">{t('detail.archiveUnsupported')} {archiveResult.unsupported.map(shortSession).join(', ')}</span>
          )}
        </div>
      )}

      {task.status === 'archived' && associatedSessions.length > 0 && state.archiveSessionsSupported && (
        <div className="lt-detail-actions">
          <ActionButton disabled={busy} onClick={() => { runAction(() => store.retryArchiveSessions(task.id)) }}>{t('detail.archiveRetry')}</ActionButton>
        </div>
      )}

      <div className="lt-detail-actions">
        {!frozen && (
          <div className="lt-move-buttons">
            {moveTargets
              .filter(to => !autoAccept || (to !== 'done' && to !== 'todo'))
              .map(to => {
                if (to === 'done') {
                  return confirmDone
                    ? (
                        <span key={to} className="lt-inline-confirm">
                          <span data-tone={unchecked > 0 ? 'bad' : undefined}>{unchecked > 0 ? t('detail.confirmDoneUnchecked', { n: String(unchecked) }) : t('detail.confirmDone')}</span>
                          <ActionButton tone="primary" onClick={() => { void store.move(task.id, 'done'); setConfirmDone(false) }}>{t('common.confirm')}</ActionButton>
                          <ActionButton onClick={() => { setConfirmDone(false) }}>{t('common.cancel')}</ActionButton>
                        </span>
                      )
                    : <button key={to} type="button" className="lt-move" data-to={to} onClick={() => { setConfirmDone(true); setConfirmArchive(false) }}>{t('detail.moveTo', { status: t(MOVE_LABEL[to]) })}</button>
                }
                if (to === 'archived') {
                  if (!confirmArchive) {
                    return <button key={to} type="button" className="lt-move" data-to={to} onClick={() => { setConfirmArchive(true); setConfirmDone(false) }}>{t('detail.moveTo', { status: t(MOVE_LABEL[to]) })}</button>
                  }
                  const count = associatedSessions.length
                  return (
                    <span key={to} className="lt-inline-confirm lt-archive-confirm">
                      <span>
                        {count === 1
                          ? t('detail.confirmArchiveSession', { id: shortSession(associatedSessions[0]) })
                          : count > 1
                            ? t('detail.confirmArchiveSessions', { n: String(count) })
                            : t('detail.confirmArchive')}
                      </span>
                      {count > 0 && <span className="lt-archive-session-list">{associatedSessions.map(shortSession).join(', ')}</span>}
                      {count > 0
                        ? (
                            <>
                              <ActionButton
                                disabled={!state.archiveSessionsSupported || busy}
                                title={state.archiveSessionsSupported ? undefined : t('detail.archiveUnsupported')}
                                onClick={() => {
                                  runAction(() => store.move(task.id, 'archived', { archiveSessions: true }))
                                  setConfirmArchive(false)
                                }}
                              >
                                {t('detail.archiveWithSession')}
                              </ActionButton>
                              <ActionButton onClick={() => {
                                runAction(() => store.move(task.id, 'archived', { archiveSessions: false }))
                                setConfirmArchive(false)
                              }}>{t('detail.archiveCardOnly')}</ActionButton>
                            </>
                          )
                        : (
                            <ActionButton tone="primary" onClick={() => {
                              void store.move(task.id, 'archived')
                              setConfirmArchive(false)
                            }}>{t('common.confirm')}</ActionButton>
                          )}
                      <ActionButton onClick={() => { setConfirmArchive(false) }}>{t('common.cancel')}</ActionButton>
                    </span>
                  )
                }
                return <button key={to} type="button" className="lt-move" data-to={to} onClick={() => { void store.move(task.id, to) }}>{t('detail.moveTo', { status: t(MOVE_LABEL[to]) })}</button>
              })}
            <button type="button" className="lt-move" data-to="blocked" onClick={() => { void store.toggleBlocked(task) }}>{task.blocked === true ? t('detail.unblock') : t('detail.block')}</button>
            {holder !== undefined && (
              <button type="button" className="lt-move" data-to="release" title={t('detail.releaseTitle', { id: holder })} onClick={() => { void store.move(task.id, 'todo') }}>{t('detail.release')}</button>
            )}
          </div>
        )}
      </div>

      <div className="lt-section">
        <h4>{t('detail.timeline')}{timeline.length > 0 && <span className="lt-counter">{timeline.length}</span>}</h4>
        {timeline.length === 0
          ? <div className="lt-empty-small">{t('detail.timelineEmpty')}</div>
          : (
              <div className="lt-timeline">
                {timeline.map(row => (
                  <div key={row.kind === 'comment' ? `c-${row.comment.id}` : `e-${row.execution.id}`} className="lt-timeline-row" data-kind={row.kind}>
                    {row.kind === 'comment' ? <CommentBubble comment={row.comment} t={t} /> : <ExecutionLine execution={row.execution} onJump={jump} t={t} />}
                  </div>
                ))}
              </div>
            )}
        <div className="lt-comment-box">
          <textarea
            className="lt-comment-input"
            value={comment}
            placeholder={t('detail.commentPlaceholder')}
            aria-label={t('detail.commentPlaceholder')}
            onChange={event => { setComment(event.target.value) }}
            onKeyDown={event => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && comment.trim() !== '') {
                void store.comment(task.id, comment).then(ok => { if (ok) setComment('') })
              }
            }}
          />
          <button type="button" className="lt-send" disabled={comment.trim() === ''} onClick={() => { void store.comment(task.id, comment).then(ok => { if (ok) setComment('') }) }}>{t('detail.commentSend')}</button>
        </div>
      </div>

      <div className="lt-danger-zone">
        {task.trashedAt === undefined
          ? <ActionButton tone="danger" onClick={() => { void store.remove(task.id, false) }}>{t('detail.delete')}</ActionButton>
          : confirmPurge
            ? (
                <span className="lt-inline-confirm">
                  <span>{t('detail.purgeConfirm')}</span>
                  <ActionButton tone="danger" onClick={() => { void store.remove(task.id, true); setConfirmPurge(false) }}>{t('detail.purgeGo')}</ActionButton>
                  <ActionButton onClick={() => { setConfirmPurge(false) }}>{t('common.cancel')}</ActionButton>
                </span>
              )
            : <ActionButton tone="danger" onClick={() => { setConfirmPurge(true) }}>{t('detail.purge')}</ActionButton>}
      </div>
    </div>
  )
}
