/**
 * 详情里的内容块：报告、清单、已分发 issue、评论气泡、执行行。
 *
 * @module dsh-magica-castboard/client/features/task/panels
 */
import {
  IconAgentPresetOutlineRegular,
  IconChecklistOutlineRegular,
  IconRightUpOutlineRegular,
  IconUserOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, type ReactNode } from 'react'

import type { ExecutionRecord, TaskRecord, ThreadComment } from '../../../shared/wire.ts'
import type { TaskDetailResponse } from '../../data/index.ts'
import type { BoardStore } from '../../data/state/index.ts'
import { ActionButton, MarkdownBody, Sheet } from '../../kit/index.ts'
import type { Translate } from '../../labels/index.ts'
import { OUTCOME_LABEL, TRIGGER_LABEL, durationText, shortSession, stampTime } from '../../data/derive/index.ts'

/** 一个带图标的小信息块。 */
export function Chip({ icon, children, tone, title }: { icon?: ReactNode; children: ReactNode; tone?: string; title?: string }) {
  return <span className="lt-chip" data-tone={tone} title={title}>{icon !== undefined && <span className="lt-chip-icon">{icon}</span>}{children}</span>
}

/** 执行报告块。 */
export function ReportBlock({ task, t }: { task: TaskRecord; t: Translate }) {
  const execution = [...task.executions].reverse().find(item => item.report !== undefined)
  const report = execution?.report
  if (execution === undefined || report === undefined) return null
  const section = (label: string, rows: readonly string[] | undefined): ReactNode => rows !== undefined && rows.length > 0
    ? (
        <div className="lt-report-section">
          <div className="lt-report-label">{label}</div>
          <ul className="lt-report-list">{rows.map((row, index) => <li key={`${label}-${String(index)}`}>{row}</li>)}</ul>
        </div>
      )
    : null
  return (
    <div className="lt-card-block" data-kind="report">
      <div className="lt-block-label">
        {t('detail.fieldReport')}
        <span className="lt-block-meta">{t('report.submitted', { time: stampTime(execution.endedAt ?? execution.startedAt) })}</span>
      </div>
      {report.summary !== undefined && <div className="lt-report-summary"><MarkdownBody text={report.summary} t={t} /></div>}
      {section(t('report.changedFiles'), report.changedFiles)}
      {section(t('report.checks'), report.checks)}
      {section(t('report.artifacts'), report.artifacts)}
      {report.risk !== undefined && report.risk !== '' && (
        <div className="lt-report-section">
          <div className="lt-report-label">{t('report.risk')}</div>
          <div className="lt-report-risk">{report.risk}</div>
        </div>
      )}
    </div>
  )
}

/** 清单块。 */
export function ChecklistBlock({ task, store, t }: { task: TaskRecord; store: BoardStore; t: Translate }) {
  const items = task.checklist ?? []
  if (items.length === 0) return null
  const done = items.filter(item => item.done).length
  const reviewing = task.status === 'in_review'
  const frozen = task.trashedAt !== undefined || task.status === 'archived'
  return (
    <div className="lt-card-block" data-kind="checklist">
      <div className="lt-block-label">
        {t('detail.fieldChecklist')}
        <span className="lt-block-meta" data-tone={reviewing && done < items.length ? 'bad' : undefined}>
          <IconChecklistOutlineRegular size={12} /> {done}/{items.length}
          {reviewing && done < items.length ? t('checklist.unchecked', { n: String(items.length - done) }) : done === items.length ? t('checklist.allDone') : ''}
        </span>
      </div>
      <div className="lt-checklist">
        {items.map((item, index) => (
          <label key={`${item.text}-${String(index)}`} className="lt-checklist-item" data-done={item.done ? 'true' : undefined} data-alert={reviewing && !item.done ? 'true' : undefined}>
            <input type="checkbox" checked={item.done} disabled={frozen} onChange={() => { void store.toggleChecklist(task, index) }} />
            <span className="lt-checklist-text">{item.text}</span>
            {item.note !== undefined && item.note !== '' && <span className="lt-checklist-note" title={item.note}>{t('checklist.evidence', { note: item.note })}</span>}
          </label>
        ))}
      </div>
    </div>
  )
}

/** 验收策略块：这张卡进待验收后，自动验收轮按哪些标准收。 */
export function AcceptanceBlock({ strategies, t }: { strategies: readonly { id: string; title: string; type: 'issue' | 'close'; description: string }[]; t: Translate }) {
  if (strategies.length === 0) return null
  return (
    <div className="lt-card-block" data-kind="acceptance">
      <div className="lt-block-label">{t('detail.fieldAcceptance')}<span className="lt-block-meta">{strategies.length}</span></div>
      <div className="lt-accept-list">
        {strategies.map(strategy => (
          <div className="lt-accept-row" key={strategy.id}>
            <div className="lt-accept-head">
              <b>{strategy.title}</b>
              <span className="lt-tag" data-tone={strategy.type}>{t(strategy.type === 'issue' ? 'settings.acceptTypeIssue' : 'settings.acceptTypeClose')}</span>
            </div>
            <p className="lt-accept-text">{strategy.description}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 已分发的 issue（按 derivedIssues 拉状态）。 */export function DispatchedBlock({ ids, store, t }: { ids: readonly string[]; store: BoardStore; t: Translate }) {
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  if (ids.length === 0) return null
  return (
    <div className="lt-card-block" data-kind="dispatched">
      <div className="lt-block-label">{t('detail.fieldDispatched')}<span className="lt-block-meta">{ids.length}</span></div>
      <div className="lt-checklist">
        {ids.map(id => (
          <button key={id} type="button" className="lt-checklist-item lt-issuetag" title={t('detail.issueStateOpen')} onClick={() => { setOpenId(id) }}>
            <span className="lt-checklist-text">{id}</span>
          </button>
        ))}
      </div>
      {openId !== undefined && <IssueStateSheet id={openId} store={store} t={t} onClose={() => { setOpenId(undefined) }} />}
    </div>
  )
}

/** 子 issue 状态弹窗。 */
function IssueStateSheet({ id, store, t, onClose }: { id: string; store: BoardStore; t: Translate; onClose: () => void }) {
  const [state, setState] = useState<{ loading: boolean; error?: string; value?: { title?: string; status?: string; urgency?: string; detail?: string; comments?: readonly ThreadComment[] } }>({ loading: true })
  useEffect(() => {
    let live = true
    void store.issueState(id).then(value => {
      if (live) setState({ loading: false, value: { title: value.issue.title, status: value.issue.status, urgency: value.issue.urgency, ...(value.issue.detail === undefined ? {} : { detail: value.issue.detail }), comments: value.comments } })
    }).catch(error => {
      if (live) setState({ loading: false, error: error instanceof Error ? error.message : String(error) })
    })
    return () => { live = false }
  }, [id, store])
  return (
    <Sheet open onClose={onClose} title={state.value?.title ?? id} width="md" footer={<ActionButton onClick={onClose}>{t('common.close')}</ActionButton>}>
      {state.loading && <div className="lt-card-block">{t('detail.issueStateLoading')}</div>}
      {state.error !== undefined && (
        <div className="lt-card-block" data-tone="bad">
          <span>{t('detail.issueStateFailed', { error: state.error })}</span>
          <span className="lt-note">{t('detail.unsynced')}</span>
        </div>
      )}
      {state.value !== undefined && (
        <>
          <div className="lt-card-block">
            <div className="lt-block-label">{t('detail.issueStateMeta')}</div>
            <div className="lt-checklist">
              <div className="lt-checklist-item" data-done="true"><span className="lt-checklist-text">{id}</span></div>
              {state.value.status !== undefined && <div className="lt-checklist-item" data-done="true"><span className="lt-checklist-text">{t('detail.issueStateStatus', { status: state.value.status })}</span></div>}
              {state.value.urgency !== undefined && <div className="lt-checklist-item" data-done="true"><span className="lt-checklist-text">{t('detail.issueStateUrgency', { urgency: state.value.urgency })}</span></div>}
            </div>
          </div>
          {state.value.detail !== undefined && state.value.detail !== '' && (
            <div className="lt-card-block"><div className="lt-block-label">{t('detail.issueStateDetail')}</div><MarkdownBody text={state.value.detail} t={t} /></div>
          )}
          {(state.value.comments ?? []).length > 0 && (
            <div className="lt-card-block">
              <div className="lt-block-label">{t('detail.issueStateComments')}<span className="lt-block-meta">{state.value.comments?.length ?? 0}</span></div>
              <div className="lt-checklist">
                {(state.value.comments ?? []).map(comment => (
                  <div className="lt-checklist-item" key={comment.id} data-done="true"><span className="lt-checklist-text">{comment.body}</span></div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Sheet>
  )
}

export function CommentBubble({ comment, t }: { comment: ThreadComment; t: Translate }) {
  const byAgent = comment.authorType === 'agent'
  return (
    <div className="lt-bubble" data-from={byAgent ? 'agent' : 'user'}>
      <div className="lt-bubble-avatar">{byAgent ? <IconAgentPresetOutlineRegular size={12} /> : <IconUserOutlineRegular size={12} />}</div>
      <div className="lt-bubble-main">
        <div className="lt-bubble-meta">
          <b>{byAgent ? `agent ${shortSession(comment.threadId ?? comment.sessionId)}` : t('detail.comments.user')}</b>
          <span>{stampTime(comment.createdAt)}</span>
        </div>
        <div className="lt-bubble-body"><MarkdownBody text={comment.body} t={t} /></div>
      </div>
    </div>
  )
}

export function ExecutionLine({ execution, onJump, t }: { execution: ExecutionRecord; onJump: (sessionId: string) => void; t: Translate }) {
  const sessionId = execution.sessionId
  return (
    <div className="lt-exec">
      <span className="lt-exec-dot" data-outcome={execution.outcome} />
      <span className="lt-exec-trigger">{t(TRIGGER_LABEL[execution.trigger] ?? 'trigger.user')}</span>
      <span className="lt-exec-outcome" data-outcome={execution.outcome}>{t(OUTCOME_LABEL[execution.outcome] ?? execution.outcome)}</span>
      <span className="lt-exec-time">{stampTime(execution.startedAt)}{execution.endedAt !== undefined ? ` · ${durationText(execution.startedAt, execution.endedAt)}` : ''}</span>
      {sessionId !== undefined && (
        <button type="button" className="lt-exec-session" title={t('detail.execOpen', { id: sessionId })} onClick={() => { onJump(sessionId) }}>
          <IconAgentPresetOutlineRegular size={12} /> {shortSession(sessionId)} <IconRightUpOutlineRegular size={12} />
        </button>
      )}
      {execution.error !== undefined && <span className="lt-exec-error" title={execution.error}>{execution.error.slice(0, 80)}{execution.error.length > 80 ? '…' : ''}</span>}
    </div>
  )
}

export type TimelineRow =
  | { kind: 'comment'; at: number; comment: ThreadComment }
  | { kind: 'execution'; at: number; execution: ExecutionRecord }

