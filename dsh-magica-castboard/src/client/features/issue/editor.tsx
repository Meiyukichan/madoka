/**
 * 待规划编辑器与讨论区。
 *
 * @module dsh-magica-castboard/client/features/issue/editor
 */
import { IconCloseOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'

import type { IssueSummary, Urgency } from '../../../shared/wire.ts'
import { ActionButton, Dropdown, Sheet } from '../../kit/index.ts'
import type { BoardStore } from '../../data/state/index.ts'
import { readLastWorkspace, saveLastWorkspace } from '../../data/state/index.ts'
import type { Translate } from '../../labels/index.ts'
import { stampTime } from '../../data/derive/index.ts'
import { Field, attachmentKind, attachmentName, urgencyChoices } from '../task/editor.tsx'

// ─── 待规划表单 ──────────────────────────────────────────────────────

/** 待规划的讨论区（编辑既有条目时出现）。 */
function Discussion({ store, issueId, t }: { store: BoardStore; issueId: string; t: Translate }) {
  const [rows, setRows] = useState<readonly { id: string; body: string; createdAt: number; role: string }[] | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void store.issueThread(issueId).then(comments => {
      if (live) setRows(comments as unknown as { id: string; body: string; createdAt: number; role: string }[])
    }).catch(() => { if (live) setRows([]) })
    return () => { live = false }
  }, [issueId, store])
  const send = (): void => {
    const body = draft.trim()
    if (body === '' || busy) return
    setBusy(true)
    void store.commentIssue(issueId, body).then(comment => {
      setRows(current => [...(current ?? []), { id: comment.id, body, createdAt: Date.now(), role: 'assigner' }])
      setDraft('')
    }).finally(() => { setBusy(false) })
  }
  return (
    <Field label={t('issue.discuss')} full>
      <div className="lt-discussion">
        {rows === undefined && <span className="lt-note">{t('common.loading')}</span>}
        {rows !== undefined && rows.length === 0 && <span className="lt-note">{t('issue.discussEmpty')}</span>}
        {(rows ?? []).map(row => (
          <div key={row.id} className="lt-discussion-row" data-role={row.role}>
            <div className="lt-discussion-head">
              <span className="lt-tag" data-tone={row.role}>
                {row.role === 'assignee' ? t('issue.byAssignee') : t('issue.byAssigner')}
              </span>
              <span className="lt-discussion-at">{stampTime(row.createdAt)}</span>
            </div>
            <div className="lt-discussion-body">{row.body}</div>
          </div>
        ))}
        <div className="lt-row">
          <Input className="lt-input" value={draft} placeholder={t('issue.discussPlaceholder')} maxLength={4000} onChange={event => { setDraft(event.target.value) }} onKeyDown={event => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            send()
          }} />
          <button type="button" className="lt-dashed" disabled={draft.trim() === '' || busy} onClick={send}>{t('issue.send')}</button>
        </div>
      </div>
    </Field>
  )
}

/** 待规划表单。 */
export function IssueComposer({ store, t, issue }: { store: BoardStore; t: Translate; issue?: IssueSummary }) {
  const state = store.getSnapshot()
  const editing = issue !== undefined
  const online = !editing
  const [title, setTitle] = useState(issue?.title ?? '')
  const [detail, setDetail] = useState(issue?.detail ?? '')
  const [workspaceId, setWorkspaceId] = useState(issue?.workspaceId ?? readLastWorkspace() ?? state.filters.workspaceId ?? state.workspaces[0]?.id ?? '')
  const [urgency, setUrgency] = useState<Urgency>(issue?.urgency ?? 'relaxed')
  const [busy, setBusy] = useState(false)
  const [targets, setTargets] = useState<import('../../data/index.ts').IssueTargets | undefined>(undefined)
  const [projectId, setProjectId] = useState('')
  const [assignee, setAssignee] = useState('')
  const [instance, setInstance] = useState('')
  const [attachments, setAttachments] = useState<readonly string[]>([])
  const [draftPath, setDraftPath] = useState('')
  const titleRef = useRef<HTMLInputElement>(null)
  useEffect(() => { titleRef.current?.focus() }, [])

  // 项目列表异步到达后回填：默认项目失效时退回记住的 / 筛选的 / 第一项。
  useEffect(() => {
    if (state.workspaces.length === 0) return
    if (workspaceId !== '' && state.workspaces.some(workspace => workspace.id === workspaceId)) return
    const next = readLastWorkspace() ?? state.filters.workspaceId ?? state.workspaces[0]?.id ?? ''
    if (next !== '' && next !== workspaceId) setWorkspaceId(next)
  }, [state.workspaces, state.filters.workspaceId, workspaceId])

  // 在线模式：项目组 / 责任人 / 实例与离线状态都从共享库拉。
  useEffect(() => {
    if (!online) return
    let live = true
    void store.fetchTargets(projectId === '' ? undefined : projectId).then(rows => {
      if (live) setTargets(rows)
    })
    return () => { live = false }
  }, [online, projectId, store])

  // 责任人默认是当前账号；用户改过就不动。
  useEffect(() => {
    const self = targets?.selfAccount
    if (self === undefined || self === '') return
    setAssignee(current => (current === '' ? self : current))
  }, [targets?.selfAccount])

  const valid = title.trim() !== '' && (online ? assignee.trim() !== '' : workspaceId !== '')
  const hint = !valid
    ? (title.trim() === '' ? t('issue.needTitle') : online ? t('dispatch.needAssignee') : t('issue.needProject'))
    : online && targets?.online === false ? t('dispatch.offline') : ''

  const addPath = (): void => {
    const path = draftPath.trim()
    if (path === '') return
    setAttachments(current => (current.includes(path) ? current : [...current, path]))
    setDraftPath('')
  }

  const submit = (): void => {
    if (!valid || busy || editing) return
    setBusy(true)
    const cwd = state.workspaces.find(workspace => workspace.id === workspaceId)?.path
    void store.createIssue({
      ...(projectId === '' ? {} : { projectId: Number(projectId) }),
      title: title.trim(),
      assignee: assignee.trim(),
      urgency,
      ...(detail.trim() === '' ? {} : { detail: detail.trim() }),
      ...(instance === '' ? {} : { assigneeInstance: instance }),
      ...(cwd === undefined || cwd === '' ? {} : { cwd }),
      ...(attachments.length === 0 ? {} : { attachments }),
    }).finally(() => { setBusy(false) })
  }

  return (
    <Sheet
      open
      onClose={() => { store.closeIssueComposer() }}
      title={editing ? t('issue.editTitle') : t('issue.createTitle')}
      hint={t('issue.formSubtitle')}
      width="md"
      footer={(
        <span className="lt-sheet-foot">
          <span className="lt-sheet-hint" data-tone={!editing && !valid ? 'bad' : undefined}>{editing ? '' : hint}</span>
          <span className="lt-sheet-buttons">
            <ActionButton onClick={() => { store.closeIssueComposer() }}>{t('common.cancel')}</ActionButton>
            {editing && <ActionButton disabled={busy} onClick={() => { store.openAbandon({ kind: 'issue', id: issue.issueId, title: issue.title }) }}>{t('issue.actionAbandon')}</ActionButton>}
            {!editing && <ActionButton tone="primary" disabled={!valid || busy} onClick={submit}>{t('issue.actionCreate')}</ActionButton>}
          </span>
        </span>
      )}
    >
      <div className="lt-sheet-body lt-issue-form">
        <Field label={t('form.title')} required full>
          <input ref={titleRef} className="lt-native" value={title} maxLength={200} readOnly={editing} placeholder={t('form.titlePlaceholder')} onChange={event => { setTitle(event.target.value) }} />
        </Field>
        <div className="lt-form-row">
          <Field label={t('form.project')} required={!online}>
            <Dropdown
              label={t('form.project')}
              dataId="issue-workspace"
              disabled={editing}
              value={workspaceId}
              choices={state.workspaces.map(workspace => ({ value: workspace.id, label: workspace.title || workspace.path }))}
              onChange={value => { setWorkspaceId(value); saveLastWorkspace(value) }}
              emptyLabel={t('form.projectEmpty')}
            />
          </Field>
          <Field label={t('form.urgency')}>
            <Dropdown label={t('form.urgency')} dataId="issue-urgency" disabled={editing} value={urgency} choices={urgencyChoices(t)} onChange={value => { setUrgency(value as Urgency) }} />
          </Field>
        </div>
        {online && (
          <>
            <div className="lt-form-row">
              <Field label={t('dispatch.project')}>
                <Dropdown
                  label={t('dispatch.project')}
                  dataId="issue-online-project"
                  value={projectId}
                  choices={(targets?.projects ?? []).map(row => ({ value: row.id, label: row.label }))}
                  onChange={setProjectId}
                  emptyLabel={targets === undefined ? t('form.acceptLoading') : targets.online === false ? t('dispatch.offline') : t('dispatch.emptyProjects')}
                />
              </Field>
              <Field label={t('dispatch.assignee')} required>
                <Dropdown
                  label={t('dispatch.assignee')}
                  dataId="issue-online-assignee"
                  value={assignee}
                  choices={(targets?.members ?? []).map(row => ({ value: row.id, label: row.label }))}
                  onChange={setAssignee}
                  emptyLabel={targets === undefined ? t('form.acceptLoading') : targets.online === false ? t('dispatch.offline') : t('dispatch.emptyMembers')}
                />
              </Field>
            </div>
            <Field label={t('dispatch.instance')} full>
              <Dropdown
                label={t('dispatch.instance')}
                dataId="issue-online-instance"
                value={instance}
                choices={(targets?.instances ?? []).map(row => ({ value: row.id, label: row.label }))}
                onChange={setInstance}
                emptyLabel={t('dispatch.any')}
              />
            </Field>
            <Field label={t('issue.onlineAttachments')} full>
              <div className="lt-attachments">
                {attachments.length === 0 && <span className="lt-note">{t('issue.onlineAttachEmpty')}</span>}
                {attachments.map(path => (
                  <div className="lt-attach-row" key={path}>
                    <span className="lt-attach-icon">{attachmentKind(path)}</span>
                    <span className="lt-attach-main">
                      <span className="lt-attach-name">{attachmentName(path)}</span>
                      <span className="lt-attach-path">{path}</span>
                    </span>
                    <button type="button" className="lt-attach-remove" aria-label={t('issue.onlineAttachRemove')} title={t('issue.onlineAttachRemove')} onClick={() => { setAttachments(current => current.filter(item => item !== path)) }}>
                      <IconCloseOutlineRegular size={12} />
                    </button>
                  </div>
                ))}
                <div className="lt-row">
                  <Input className="lt-input" value={draftPath} placeholder={t('issue.onlineAttachPath')} spellCheck={false} onChange={event => { setDraftPath(event.target.value) }} onKeyDown={event => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    addPath()
                  }} />
                  <button type="button" className="lt-attach-add" disabled={draftPath.trim() === ''} onClick={addPath}>{t('issue.onlineAttachAdd')}</button>
                </div>
              </div>
            </Field>
          </>
        )}
        <Field label={t('issue.detail')} full>
          <textarea className="lt-textarea" rows={6} value={detail} maxLength={20000} readOnly={editing} placeholder={t('issue.detailPlaceholder')} onChange={event => { setDetail(event.target.value) }} />
        </Field>
        {editing && <Discussion store={store} issueId={issue.issueId} t={t} />}
      </div>
    </Sheet>
  )
}

