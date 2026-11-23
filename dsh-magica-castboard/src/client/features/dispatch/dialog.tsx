/**
 * 分发弹窗。
 *
 * @module dsh-magica-castboard/client/features/dispatch/dialog
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

import type { BoardSettings } from '../../../shared/wire.ts'
import { ActionButton, Dropdown, Sheet } from '../../kit/index.ts'
import type { AcceptanceEntry, DispatchedRow, IssueTargets, RouterStrategyEntry, WorkspaceNoteEntry } from '../../data/index.ts'
import type { BoardStore } from '../../data/state/index.ts'
import type { Translate } from '../../labels/index.ts'
import { stampTime, templateName } from '../../data/derive/index.ts'

// ─── 分发 ────────────────────────────────────────────────────────────

/** 分发说明 + 目标。 */
export function DispatchSheet({ store, task, t, onAlert }: { store: BoardStore; task: { id: string; title: string }; t: Translate; onAlert?: (message: string) => void }) {
  const [text, setText] = useState('')
  const [projectId, setProjectId] = useState('')
  const [assignee, setAssignee] = useState('')
  const [instance, setInstance] = useState('')
  const [targets, setTargets] = useState<IssueTargets>({ projects: [], members: [], instances: [] })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void store.fetchTargets(projectId === '' ? undefined : projectId, assignee === '' ? undefined : assignee).then(next => {
      if (live) setTargets(next)
    })
    return () => { live = false }
  }, [assignee, projectId, store])

  const valid = text.trim() !== '' && projectId !== '' && assignee !== ''
  const hint = text.trim() === ''
    ? t('dispatch.needText')
    : projectId === ''
      ? t('dispatch.needProject')
      : assignee === ''
        ? t('dispatch.needAssignee')
        : t('dispatch.footHint')
  const offline = targets.degraded === true
  const submit = (): void => {
    if (!valid || busy) return
    setBusy(true)
    void store.dispatch(task.id, {
      text: text.trim(),
      projectId,
      assignee,
      ...(instance === '' ? {} : { assigneeInstance: instance }),
    }).then(ok => { if (ok) onAlert?.(t('dispatch.started')) }).finally(() => { setBusy(false) })
  }

  return (
    <Sheet
      open
      onClose={() => { store.closeDispatch() }}
      title={t('dispatch.title')}
      hint={t('dispatch.subtitle', { title: task.title })}
      width="md"
      footer={(
        <span className="lt-sheet-foot">
          <span className="lt-sheet-hint" data-tone={valid ? undefined : 'bad'}>{hint}</span>
          <span className="lt-sheet-buttons">
            <ActionButton onClick={() => { store.closeDispatch() }}>{t('common.cancel')}</ActionButton>
            <ActionButton tone="primary" disabled={!valid || busy} onClick={submit}>{t('dispatch.confirm')}</ActionButton>
          </span>
        </span>
      )}
    >
      <div className="lt-sheet-body lt-dispatch">
        <label className="lt-field" data-full="true">
          <span className="lt-field-label">{t('dispatch.text')}</span>
          <textarea className="lt-textarea" rows={5} value={text} maxLength={4000} placeholder={t('dispatch.textPlaceholder')} onChange={event => { setText(event.target.value) }} />
        </label>
        {offline && <span className="lt-note">{t('dispatch.offline')}</span>}
        <div className="lt-dispatch-targets">
          <div className="lt-field">
            <span className="lt-field-label">{t('dispatch.project')}<i className="lt-req">*</i></span>
            <Dropdown
              label={t('dispatch.project')}
              dataId="dispatch-project"
              value={projectId}
              choices={targets.projects.map(project => ({ value: project.id, label: project.label }))}
              emptyLabel={t('dispatch.emptyProjects')}
              onChange={value => { setProjectId(value); setAssignee('') }}
            />
          </div>
          <div className="lt-field">
            <span className="lt-field-label">{t('dispatch.assignee')}<i className="lt-req">*</i></span>
            <Dropdown
              label={t('dispatch.assignee')}
              dataId="dispatch-assignee"
              value={assignee}
              choices={targets.members.map(member => ({ value: member.id, label: member.label }))}
              emptyLabel={projectId === '' ? t('dispatch.emptyPickProject') : t('dispatch.emptyMembers')}
              onChange={value => { setAssignee(value); setInstance('') }}
            />
          </div>
          <div className="lt-field">
            <span className="lt-field-label">{t('dispatch.instance')}</span>
            <Dropdown
              label={t('dispatch.instance')}
              dataId="dispatch-instance"
              value={instance}
              choices={[{ value: '', label: t('dispatch.any') }, ...targets.instances.map(row => ({ value: row.id, label: row.label }))]}
              onChange={setInstance}
            />
          </div>
        </div>
      </div>
    </Sheet>
  )
}

