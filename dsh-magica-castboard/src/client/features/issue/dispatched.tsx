/**
 * 我派出去的。
 *
 * @module dsh-magica-castboard/client/features/issue/dispatched
 */
/**
 * 五个独立弹窗：健康诊断、面板设置、我派出去的、分发、导入、模板库。
 *
 * 每个弹窗只读 store 快照、只调 store 的方法；打开时才拉它需要的那份数据，
 * 关掉即丢草稿（脏数据不跨会话延续）。
 *
 * @module dsh-magica-castboard/client/overlays
 */
import { IconChecklistOutlineRegular, IconTrashOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'

import type { BoardSettings, ThreadComment } from '../../../shared/wire.ts'
import { ActionButton, Dropdown, Sheet, Tip } from '../../kit/index.ts'
import type { AcceptanceEntry, DispatchedRow, IssueTargets, RouterStrategyEntry, WorkspaceNoteEntry } from '../../data/index.ts'
import type { BoardStore } from '../../data/state/index.ts'
import type { Translate } from '../../labels/index.ts'
import { stampTime, templateName } from '../../data/derive/index.ts'
import { controlCommentText } from '../interactions/control-comment.ts'

// ─── 我派出去的 ──────────────────────────────────────────────────────

type DiscussionComment = Pick<ThreadComment, 'id' | 'body' | 'createdAt' | 'role'> & {
  /** Local optimistic rows use `user`; server rows use `human`/`agent`/`system`. */
  authorType?: string
}

/** 已派发（本机有卡的 issue 关联任务）。 */
export function DispatchedSheet({ store, t }: { store: BoardStore; t: Translate }) {
  const [rows, setRows] = useState<readonly DispatchedRow[] | undefined>(undefined)
  const [truncated, setTruncated] = useState(false)
  const [offline, setOffline] = useState(false)
  const [open, setOpen] = useState<string | undefined>(undefined)
  const [thread, setThread] = useState<readonly DiscussionComment[] | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const links = store.getSnapshot().issueLinks

  useEffect(() => {
    let live = true
    void store.dispatchedIssues().then(result => {
      if (!live) return
      setRows(result.items)
      setTruncated(result.truncated)
    }).catch(() => { if (live) { setRows([]); setOffline(true) } })
    return () => { live = false }
  }, [store])

  useEffect(() => {
    if (open === undefined) { setThread(undefined); return }
    const anchor = open
    let live = true
    setThread(undefined)
    void store.issueThread(anchor).then(comments => {
      if (live) setThread(comments)
    }).catch(() => { if (live) setThread([]) })
    return () => { live = false }
  }, [open, store])

  const send = (issueId: string): void => {
    const body = draft.trim()
    if (body === '' || busy) return
    setBusy(true)
    void store.commentIssue(issueId, body).then(comment => {
      setThread(current => [...(current ?? []), { id: comment.id, body, createdAt: Date.now(), role: 'assigner', authorType: 'user' }])
      setDraft('')
    }).finally(() => { setBusy(false) })
  }

  return (
    <Sheet open onClose={() => { store.closeDispatched() }} title={t('dispatched.title')} hint={t('dispatched.subtitle')} width="md">
      <div className="lt-dispatched">
        {rows === undefined && <span className="lt-note">{t('dispatched.loading')}</span>}
        {offline && <span className="lt-note" data-tone="bad">{t('dispatched.offline')}</span>}
        {rows !== undefined && rows.length === 0 && <span className="lt-note">{t('dispatched.empty')}</span>}
        {truncated && <span className="lt-note">{t('dispatched.truncated')}</span>}
        {(rows ?? []).map(row => (
          <div className="lt-dispatched-row" key={row.id} data-open={open === row.id ? 'true' : undefined}>
            <div className="lt-dispatched-head">
              <span className="lt-dispatched-title"><Tip label={row.id} align="center"><span>{row.title === '' ? t('dispatched.untitled') : row.title}</span></Tip></span>
              {row.issueId !== undefined && links?.[row.issueId]?.hasUnread === true && <Tip label={t('card.unread')}><span className="lt-unread" role="status" /></Tip>}
              <span className="lt-tag" data-tone={row.status}>{row.status}</span>
              {row.claimedBy !== undefined && <Tip label={t('dispatched.assignee')}><span className="lt-note">{row.claimedBy}</span></Tip>}
              <button type="button" className="lt-textlink" onClick={() => { setOpen(open === row.id ? undefined : row.id) }}>
                {open === row.id ? t('dispatched.closeThread') : t('dispatched.openThread')}
              </button>
            </div>
            {open === row.id && (
              <div className="lt-discussion">
                {thread === undefined && <span className="lt-note">{t('dispatched.loading')}</span>}
                {thread !== undefined && thread.length === 0 && <span className="lt-note">{t('issue.discussEmpty')}</span>}
                {(thread ?? []).map(comment => {
                  const control = controlCommentText(comment, t)
                  return (
                    <div key={comment.id} className="lt-discussion-row" data-role={comment.role}>
                      <div className="lt-discussion-head">
                        <span className="lt-tag" data-tone={comment.role}>{comment.role === 'assignee' ? t('issue.byAssignee') : t('issue.byAssigner')}</span>
                        <span className="lt-discussion-at">{stampTime(comment.createdAt)}</span>
                      </div>
                      <div className="lt-discussion-body">{control ?? comment.body}</div>
                    </div>
                  )
                })}
                <div className="lt-row">
                  <Input className="lt-input" value={draft} placeholder={t('issue.discussPlaceholder')} maxLength={4000} onChange={event => { setDraft(event.target.value) }} onKeyDown={event => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    send(row.id)
                  }} />
                  <button type="button" className="lt-dashed" disabled={draft.trim() === '' || busy} onClick={() => { send(row.id) }}>{t('issue.send')}</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </Sheet>
  )
}

