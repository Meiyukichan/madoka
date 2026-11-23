/**
 * 任务编辑器：字段、执行方式、清单与两种提交路径。
 *
 * @module dsh-magica-castboard/client/features/task/editor
 */
/**
 * 建卡 / 改卡与待规划表单。
 *
 * 表单只负责收集字段并调 store；写入的串行、状态机、清单覆盖语义都在宿主侧。
 * 模型是自由文本（`provider/model`），留空 = 用宿主默认模型。
 *
 * @module dsh-magica-castboard/client/composer
 */
import { IconCloseOutlineRegular, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { IssueSummary, Permission, TaskRecord, Urgency } from '../../../shared/wire.ts'
import { ActionButton, Dropdown, Sheet, SlashPromptInput, type Choice } from '../../kit/index.ts'
import type { AcceptanceEntry, IssueTargets, ModelCatalogView } from '../../data/index.ts'
import type { BoardStore } from '../../data/state/index.ts'
import { readLastModel, readLastWorkspace, saveLastModel, saveLastWorkspace } from '../../data/state/index.ts'
import type { TemplateView } from '../../data/index.ts'
import type { Translate } from '../../labels/index.ts'
import { stampTime, templateName } from '../../data/derive/index.ts'

/** 一个表单字段。 */
export function Field({ label, required = false, full = false, children }: { label: string; required?: boolean; full?: boolean; children: ReactNode }) {
  return (
    <div className="lt-field" data-full={full ? 'true' : undefined}>
      <span className="lt-field-label">
        {label}
        {required && <i className="lt-req">*</i>}
      </span>
      {children}
    </div>
  )
}

const URGENCIES: readonly Urgency[] = ['runtime', 'direct', 'urgent', 'normal', 'relaxed']

export function urgencyChoices(t: Translate): Choice[] {
  return URGENCIES.map(value => ({
    value,
    label: t(`urgency.${value}`),
    icon: <span className="lt-dot" data-urgency={value} />,
  }))
}

function permissionChoices(t: Translate): Choice[] {
  return [
    { value: 'read-only', label: t('form.permReadOnly') },
    { value: 'workspace-write', label: t('form.permWrite') },
    { value: 'danger-full-access', label: t('form.permFull') },
  ]
}

const PROJECT_EMPTY = '没有可用项目'

interface ChecklistRow {
  id?: string
  text: string
  done: boolean
  checkedBy?: string
  checkedAt?: number
  /** 勾选证据（agent 提交的 note）；编辑时原样带回，不能丢。 */
  note?: string
}

/** 清单编辑器。 */
function ChecklistEditor({ rows, onChange, t, editing }: { rows: readonly ChecklistRow[]; onChange: (rows: ChecklistRow[]) => void; t: Translate; editing: boolean }) {
  const done = rows.filter(row => row.done).length
  const update = (index: number, patch: Partial<ChecklistRow>): void => {
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  }
  return (
    <div className="lt-checklist-editor">
      {rows.map((row, index) => (
        <div className="lt-checklist-row" key={`row-${String(index)}`}>
          {editing && (
            <input
              type="checkbox"
              className="lt-check"
              checked={row.done}
              onChange={event => { update(index, { done: event.target.checked }) }}
            />
          )}
          <Input
            className="lt-input"
            value={row.text}
            maxLength={200}
            placeholder={t('form.checkItem', { n: String(index + 1) })}
            spellCheck={false}
            onChange={event => { update(index, { text: event.target.value }) }}
          />
          <button type="button" className="lt-icon-remove" title={t('form.checkRemove')} onClick={() => { onChange(rows.filter((_, at) => at !== index)) }}>
            <IconCloseOutlineRegular size={14} />
          </button>
        </div>
      ))}
      {rows.length < 30 && (
        <button type="button" className="lt-dashed" onClick={() => { onChange([...rows, { text: '', done: false }]) }}>{t('form.checkAdd')}</button>
      )}
      {rows.length > 0 && (
        <span className="lt-note">
          {editing
            ? t('form.checkHintEdit', { checked: String(done), total: String(rows.length) })
            : t('form.checkHintCreate', { n: String(rows.length) })}
        </span>
      )}
    </div>
  )
}

type AcceptanceDraft = {
  id?: string
  title: string
  type: 'issue' | 'close'
  description: string
}

const MAX_ACCEPTANCE_PER_TASK = 10

function AcceptancePicker({ list, onChange, strategies, t }: {
  list: readonly AcceptanceDraft[]
  onChange: (next: AcceptanceDraft[]) => void
  strategies: readonly AcceptanceEntry[] | undefined
  t: Translate
}) {
  const [composing, setComposing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftType, setDraftType] = useState<'issue' | 'close'>('close')
  const [draftDesc, setDraftDesc] = useState('')
  const known = strategies ?? []
  const typeLabel = (type: 'issue' | 'close'): string => t(type === 'issue' ? 'form.acceptTypeIssue' : 'form.acceptTypeClose')
  const canAdd = draftTitle.trim() !== '' && draftDesc.trim() !== ''

  const addFromLibrary = (): void => {
    const next = known.find(entry => !list.some(current => current.id === entry.id)) ?? known[0]
    if (next === undefined) return
    onChange([...list, next])
  }

  return (
    <div className="lt-accept">
      {list.map((entry, index) => {
        const fromLibrary = entry.id !== undefined && known.some(item => item.id === entry.id)
        return (
          <div className="lt-accept-row" key={entry.id ?? `${entry.title}-${String(index)}`}>
            {fromLibrary
              ? (
                <Dropdown
                  label={t('form.accept')}
                  dataId={`accept-${String(index)}`}
                  value={entry.id ?? ''}
                  choices={known.map(item => ({ value: item.id, label: `${item.title} · ${typeLabel(item.type)}` }))}
                  onChange={value => {
                    const picked = known.find(item => item.id === value)
                    if (picked !== undefined) onChange(list.map((row, at) => (at === index ? picked : row)))
                  }}
                />
              )
              : (
                <span className="lt-accept-inline">
                  <span>{entry.title}</span>
                  <span className="lt-note">{typeLabel(entry.type)}</span>
                </span>
              )}
            <button type="button" className="lt-icon-remove" title={t('form.acceptRemove')} onClick={() => { onChange(list.filter((_, at) => at !== index)) }}>
              <IconCloseOutlineRegular size={14} />
            </button>
          </div>
        )
      })}
      {composing && (
        <div className="lt-accept-new">
          <Input className="lt-input" value={draftTitle} placeholder={t('form.acceptNewTitle')} onChange={event => { setDraftTitle(event.target.value) }} />
          <Dropdown
            label={t('form.acceptNewTitle')}
            dataId="accept-new-type"
            value={draftType}
            choices={[{ value: 'close', label: typeLabel('close') }, { value: 'issue', label: typeLabel('issue') }]}
            onChange={value => { setDraftType(value === 'issue' ? 'issue' : 'close') }}
          />
          <textarea className="lt-textarea" rows={3} value={draftDesc} placeholder={t('form.acceptNewDesc')} onChange={event => { setDraftDesc(event.target.value) }} />
          <div className="lt-accept-actions">
            <button type="button" className="lt-dashed" disabled={!canAdd} onClick={() => {
              if (!canAdd) return
              onChange([...list, { title: draftTitle.trim(), type: draftType, description: draftDesc.trim() }])
              setDraftTitle('')
              setDraftDesc('')
              setComposing(false)
            }}>{t('form.acceptNewAdd')}</button>
            <button type="button" className="lt-dashed" onClick={() => { setComposing(false); setDraftTitle(''); setDraftDesc('') }}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
      {strategies === undefined && <span className="lt-note">{t('form.acceptLoading')}</span>}
      {strategies !== undefined && known.length === 0 && list.length === 0 && <span className="lt-note">{t('form.acceptEmpty')}</span>}
      {list.length < MAX_ACCEPTANCE_PER_TASK && (
        <div className="lt-accept-actions">
          {known.length > 0 && <button type="button" className="lt-dashed" onClick={addFromLibrary}>{t('form.acceptAdd')}</button>}
          {!composing && <button type="button" className="lt-dashed" onClick={() => { setComposing(true) }}>{t('form.acceptNew')}</button>}
        </div>
      )}
      {list.length > 0 && <span className="lt-note">{t('form.acceptHint', { n: String(list.length) })}</span>}
    </div>
  )
}

function serializeModel(model: string | undefined): string {
  if (model === undefined || model.trim() === '') return ''
  const cut = model.indexOf('/')
  if (cut <= 0 || cut === model.length - 1) return ''
  return JSON.stringify({ provider: model.slice(0, cut), model: model.slice(cut + 1) })
}

function parseModel(value: string): string | undefined {
  if (value === '') return undefined
  try {
    const parsed = JSON.parse(value) as { provider?: unknown; model?: unknown }
    if (typeof parsed.provider !== 'string' || typeof parsed.model !== 'string') return undefined
    return `${parsed.provider}/${parsed.model}`
  } catch {
    return undefined
  }
}

function modelObject(value: string): { provider: string; model: string } | undefined {
  if (value === '') return undefined
  try {
    const parsed = JSON.parse(value) as { provider?: unknown; model?: unknown }
    if (typeof parsed.provider !== 'string' || typeof parsed.model !== 'string') return undefined
    if (parsed.provider.trim() === '' || parsed.model.trim() === '') return undefined
    return { provider: parsed.provider.trim(), model: parsed.model.trim() }
  } catch {
    return undefined
  }
}

function modelChoices(catalog: ModelCatalogView, current: string, t: Translate): Choice[] {
  const choices: Choice[] = catalog.models.map(model => ({
    value: JSON.stringify({ provider: model.provider, model: model.model }),
    label: model.name,
    group: model.groupName,
  }))
  if (current !== '' && !choices.some(choice => choice.value === current)) {
    try {
      const parsed = JSON.parse(current) as { provider?: string; model?: string }
      choices.unshift({ value: current, label: `${parsed.provider ?? ''}/${parsed.model ?? ''}`, group: t('form.modelUnavailable') })
    } catch { /* ignore malformed remembered value */ }
  }
  return choices
}

const CRON_PRESETS = [
  { key: 'form.cronDaily', cron: '0 9 * * *' },
  { key: 'form.cronHourly', cron: '0 * * * *' },
  { key: 'form.cronEvery10', cron: '*/10 * * * *' },
  { key: 'form.cronWeekly', cron: '0 9 * * 1' },
] as const

/** 建卡 / 改卡表单。 */
export function Composer({ store, t, lang, task, prefill }: {
  store: BoardStore
  t: Translate
  lang: 'zh' | 'en'
  task?: TaskRecord
  prefill?: TemplateView['spec']
}) {
  const state = store.getSnapshot()
  const editing = task !== undefined
  const [title, setTitle] = useState(task?.title ?? prefill?.title ?? '')
  const [detail, setDetail] = useState(task?.detail ?? prefill?.detail ?? '')
  const [workspaceId, setWorkspaceId] = useState(task?.workspaceId ?? prefill?.workspaceId ?? readLastWorkspace() ?? state.filters.workspaceId ?? state.workspaces[0]?.id ?? '')
  const [urgency, setUrgency] = useState<Urgency>(task?.urgency ?? (editing ? 'normal' : 'direct'))
  const [mode, setMode] = useState<'queue' | 'scheduled'>(task?.execution?.mode === 'scheduled' || prefill?.execution?.mode === 'scheduled' ? 'scheduled' : 'queue')
  const [cron, setCron] = useState(task?.execution?.cron ?? prefill?.execution?.cron ?? '0 9 * * *')
  const [model, setModel] = useState(() => serializeModel(task?.model ?? prefill?.model ?? (editing ? undefined : readLastModel())))
  const [catalog, setCatalog] = useState<ModelCatalogView>({ models: [] })
  const [permission, setPermission] = useState<Permission>(() => {
    const current = store.permissionPreset()
    const live = current === 'read-only' || current === 'danger-full-access' || current === 'workspace-write'
      ? current
      : undefined
    return task?.permission
      ?? (prefill?.permission === 'read-only' || prefill?.permission === 'danger-full-access' || prefill?.permission === 'workspace-write' ? prefill.permission : undefined)
      ?? live
      ?? state.settings?.defaultPermission
      ?? 'workspace-write'
  })
  const [rows, setRows] = useState<ChecklistRow[]>(
    task?.checklist !== undefined && task.checklist.length > 0
      ? task.checklist.map(item => ({
        ...(item.id === undefined ? {} : { id: item.id }),
        text: item.text,
        done: item.done,
        ...(item.checkedBy === undefined ? {} : { checkedBy: item.checkedBy }),
        ...(item.checkedAt === undefined ? {} : { checkedAt: item.checkedAt }),
        ...(item.note === undefined ? {} : { note: item.note }),
      }))
      : (prefill?.checklist ?? []).map(text => ({ text, done: false })),
  )
  const [acceptList, setAcceptList] = useState<AcceptanceDraft[]>(
    ((task?.acceptanceStrategies ?? []) as unknown as AcceptanceEntry[]).filter(entry => typeof entry === 'object' && entry !== null),
  )
  const [strategies, setStrategies] = useState<AcceptanceEntry[] | undefined>(state.acceptanceStrategies as AcceptanceEntry[] | undefined)
  const [cronCheck, setCronCheck] = useState<{ cron: string; next?: number } | undefined>(undefined)
  const [targets, setTargets] = useState<IssueTargets | undefined>(undefined)
  const [projectId, setProjectId] = useState('')
  const [assignee, setAssignee] = useState('')
  const [instance, setInstance] = useState('')
  const [attachments, setAttachments] = useState<readonly string[]>([])
  const [draftPath, setDraftPath] = useState('')
  const [busy, setBusy] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => { titleRef.current?.focus() }, [])

  // 项目列表是异步到的：默认项目失效（或被另一个窗口改了）时回落到记住的 / 筛选的 / 第一项。
  useEffect(() => {
    if (state.workspaces.length === 0) return
    if (workspaceId !== '' && state.workspaces.some(workspace => workspace.id === workspaceId)) return
    const next = readLastWorkspace() ?? state.filters.workspaceId ?? state.workspaces[0]?.id ?? ''
    if (next !== '' && next !== workspaceId) setWorkspaceId(next)
  }, [state.workspaces, state.filters.workspaceId, workspaceId])

  useEffect(() => {
    void store.fetchModelCatalog().then(view => {
      setCatalog(view)
      if (view.defaultModel === undefined) return
      const fallback = JSON.stringify(view.defaultModel)
      setModel(current => (current === '' ? fallback : current))
    })
  }, [store])

  useEffect(() => {
    if (state.acceptanceStrategies !== undefined) {
      setStrategies(state.acceptanceStrategies as AcceptanceEntry[])
      return
    }
    let live = true
    void store.loadAcceptance().then(list => { if (live) setStrategies(list as AcceptanceEntry[]) })
    return () => { live = false }
  }, [store, state.acceptanceStrategies])

  useEffect(() => {
    if (editing) return
    let live = true
    void store.fetchTargets(projectId === '' ? undefined : projectId).then(rows => {
      if (live) setTargets(rows)
    })
    return () => { live = false }
  }, [editing, projectId, store])

  useEffect(() => {
    const self = targets?.selfAccount
    if (self === undefined || self === '') return
    setAssignee(current => (current === '' ? self : current))
  }, [targets?.selfAccount])

  useEffect(() => {
    if (editing) return
    const preferred = targets?.localInstance
    if (preferred !== undefined && preferred !== '' && targets?.instances.some(row => row.id === preferred)) {
      setInstance(current => (current === '' ? preferred : current))
      return
    }
    if (instance !== '' && targets?.instances.some(row => row.id === instance)) return
    setInstance(targets?.localInstance ?? targets?.instances[0]?.id ?? '')
  }, [editing, instance, targets?.instances, targets?.localInstance])

  useEffect(() => {
    if (mode !== 'scheduled') return
    let live = true
    const timer = setTimeout(() => {
      void store.previewCron(cron.trim()).then(next => {
        if (live) setCronCheck({ cron: cron.trim(), ...(next === undefined ? {} : { next }) })
      })
    }, 300)
    return () => { live = false; clearTimeout(timer) }
  }, [cron, mode, store])

  const checked = cronCheck !== undefined && cronCheck.cron === cron.trim()
  const cronBad = mode === 'scheduled' && checked && cronCheck.next === undefined
  const valid = title.trim() !== ''
    && workspaceId !== ''
    && detail.trim() !== ''
    && (editing || (assignee.trim() !== '' && instance !== ''))
    && !cronBad
  const runBlocked = editing && task.status === 'in_progress'

  const rowItems = (): ChecklistRow[] => rows
    .map(row => ({ ...row, text: row.text.trim() }))
    .filter(row => row.text !== '')
  const hint = !valid
    ? (title.trim() === ''
        ? t('form.needTitle')
        : workspaceId === ''
          ? t('form.needProject')
          : detail.trim() === ''
            ? t('form.needDetail')
            : !editing && assignee.trim() === ''
              ? t('dispatch.needAssignee')
              : !editing && instance === ''
                ? t('dispatch.needInstance')
                : t('form.cronBad'))
    : mode === 'scheduled' && cronCheck?.next !== undefined
      ? t('form.nextRun', { time: stampTime(cronCheck.next) })
      : editing ? t('form.saveHint') : ''

  const pickedModel = parseModel(model)

  const memberChoices = (() => {
    const choices = (targets?.members ?? []).map(row => ({ value: row.id, label: row.label }))
    if (assignee !== '' && !choices.some(choice => choice.value === assignee)) {
      choices.unshift({ value: assignee, label: assignee })
    }
    return choices
  })()

  const instanceChoices = (() => {
    const choices = (targets?.instances ?? []).map(row => ({ value: row.id, label: row.label }))
    if (instance !== '' && !choices.some(choice => choice.value === instance)) {
      choices.unshift({ value: instance, label: instance })
    }
    return choices
  })()

  const addAttachment = (): void => {
    const path = draftPath.trim()
    if (path === '') return
    setAttachments(current => (current.includes(path) ? current : [...current, path]))
    setDraftPath('')
  }

  const issueMeta = (): Record<string, unknown> | undefined => {
    const checklist = rowItems().map(item => item.text)
    const parsedModel = modelObject(model)
    const meta: Record<string, unknown> = {
      ...(mode === 'scheduled' ? { cron: cron.trim() } : {}),
      ...(checklist.length === 0 ? {} : { checklist }),
      ...(acceptList.length === 0 ? {} : { acceptanceStrategies: acceptList }),
      ...(parsedModel === undefined ? {} : { model: parsedModel }),
    }
    return Object.keys(meta).length === 0 ? undefined : meta
  }

  const payload = () => {
    return {
      title: title.trim(),
      detail: detail.trim(),
      urgency,
      workspaceId,
      ...(pickedModel === undefined ? {} : { model: pickedModel }),
      permission,
      execution: mode === 'scheduled' ? { mode, cron: cron.trim() } as const : { mode } as const,
      ...(acceptList.length === 0 ? {} : { acceptanceStrategies: acceptList }),
    }
  }

  const submit = (runAfter: boolean): void => {
    if (!valid || busy || (runAfter && runBlocked)) return
    setBusy(true)
    void (async () => {
      const items = rowItems()
      if (editing) {
        const ok = await store.update(task.id, {
          ...payload(),
          model: pickedModel ?? null,
          checklist: itemsEmpty(rows) ? null : items,
          acceptanceStrategies: acceptList.length === 0 ? null : acceptList,
        })
        if (ok && runAfter) await store.run(task.id)
        return
      }
      const cwd = state.workspaces.find(workspace => workspace.id === workspaceId)?.path
      const created = await store.createIssue({
        ...(projectId === '' ? {} : { projectId: Number(projectId) }),
        title: title.trim(),
        detail: detail.trim(),
        assignee: assignee.trim(),
        urgency,
        ...(instance === '' ? {} : { assigneeInstance: instance }),
        ...(cwd === undefined || cwd === '' ? {} : { cwd }),
        permission,
        ...(attachments.length === 0 ? {} : { attachments: [...attachments] }),
        ...(issueMeta() === undefined ? {} : { assignerMeta: issueMeta() }),
      })
      if (created !== undefined) {
        store.closeComposer()
        saveLastWorkspace(workspaceId)
        saveLastModel(pickedModel)
      }
    })().finally(() => { setBusy(false) })
  }

  const modelEmpty = catalog.failures !== undefined && catalog.failures.length > 0
    ? t('form.modelEmptyFailures', { providers: catalog.failures.map(failure => failure.message === '' ? failure.name : `${failure.name}: ${failure.message}`).join(', ') })
    : t('form.modelEmpty')

  return (
    <Sheet
      open
      onClose={() => { store.closeComposer() }}
      title={editing ? t('form.edit') : t('form.create')}
      {...(editing ? { hint: t('form.editSubtitle') } : {})}
      width="lg"
      footer={(
        <span className="lt-sheet-foot">
          <span className="lt-sheet-hint" data-tone={valid ? undefined : 'bad'}>{hint}</span>
          <span className="lt-sheet-buttons">
            <ActionButton onClick={() => { store.closeComposer() }}>{t('common.cancel')}</ActionButton>
            {editing && (
              <ActionButton
                disabled={!valid || runBlocked || busy}
                title={runBlocked ? t('form.runBlocked') : busy ? t('form.runBusy') : t('form.runTitle')}
                onClick={() => { submit(true) }}
              >
                {t('form.run')}
              </ActionButton>
            )}
            <ActionButton tone="primary" disabled={!valid || busy} onClick={() => { submit(false) }}>
              {editing ? t('form.save') : t('form.submitCreate')}
            </ActionButton>
          </span>
        </span>
      )}
    >
      <div className="lt-sheet-body lt-composer-grid">
        <div className="lt-composer-col lt-composer-left">
          <section className="lt-form-card">
          <Field label={t('form.title')} required full>
            <input ref={titleRef} className="lt-native" data-input="task-title" value={title} maxLength={200} placeholder={t('form.titlePlaceholder')} onChange={event => { setTitle(event.target.value) }} />
          </Field>
          <div className="lt-form-row">
            <Field label={t('form.project')} required>
              <Dropdown
                label={t('form.project')}
                dataId="workspace"
                value={workspaceId}
                choices={state.workspaces.map(workspace => ({ value: workspace.id, label: workspace.title || workspace.path }))}
                onChange={setWorkspaceId}
                emptyLabel={t('form.projectEmpty')}
              />
            </Field>
            {editing
              ? (
                <Field label={t('form.model')}>
                  <Dropdown
                    label={t('form.model')}
                    dataId="model"
                    value={model}
                    choices={modelChoices(catalog, model, t)}
                    onChange={setModel}
                    emptyLabel={modelEmpty}
                  />
                </Field>
                )
              : (
                <Field label={t('dispatch.project')}>
                  <Dropdown
                    label={t('dispatch.project')}
                    dataId="task-issue-project"
                    value={projectId}
                    choices={[
                      { value: '', label: t('dispatch.noProject') },
                      ...(targets?.projects ?? []).map(row => ({ value: row.id, label: row.label })),
                    ]}
                    onChange={value => { setProjectId(value); setAssignee(''); setInstance('') }}
                    emptyLabel={targets === undefined ? t('form.acceptLoading') : targets.online === false ? t('dispatch.offline') : t('dispatch.emptyProjects')}
                  />
                </Field>
                )}
          </div>
          {!editing && (
            <div className="lt-form-row">
              <Field label={t('dispatch.assignee')} required>
                <Dropdown
                  label={t('dispatch.assignee')}
                  dataId="task-issue-assignee"
                  value={assignee}
                  choices={memberChoices}
                  onChange={value => { setAssignee(value); setInstance('') }}
                  emptyLabel={targets === undefined ? t('form.acceptLoading') : targets.online === false ? t('dispatch.offline') : t('dispatch.emptyMembers')}
                />
              </Field>
              <Field label={t('dispatch.instance')}>
                <Dropdown
                  label={t('dispatch.instance')}
                  dataId="task-issue-instance"
                  value={instance}
                  choices={instanceChoices}
                  onChange={setInstance}
                  emptyLabel={targets === undefined ? t('form.acceptLoading') : targets.online === false ? t('dispatch.offline') : t('dispatch.emptyInstances')}
                />
              </Field>
            </div>
          )}
          </section>
          <section className="lt-form-card lt-detail-card">
          <Field label={t('form.detail')} required full>
            <SlashPromptInput
              store={store}
              workspaceId={workspaceId}
              value={detail}
              onChange={setDetail}
              rows={6}
              maxLength={20000}
              placeholder={t('form.detailPlaceholder')}
              ariaLabel={t('form.detail')}
            />
          </Field>
          </section>
          {!editing && (
            <section className="lt-form-card lt-attachment-card">
              <div className="lt-form-card-title">{t('form.inputAttachments')} <span className="lt-form-card-hint">{t('form.inputAttachmentsHint')}</span></div>
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
                  <Input
                    className="lt-input"
                    value={draftPath}
                    placeholder={t('issue.onlineAttachPath')}
                    spellCheck={false}
                    onChange={event => { setDraftPath(event.target.value) }}
                    onKeyDown={event => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      addAttachment()
                    }}
                  />
                  <button type="button" className="lt-attach-add" disabled={draftPath.trim() === ''} onClick={addAttachment}>{t('issue.onlineAttachAdd')}</button>
                </div>
              </div>
            </section>
          )}
        </div>
        <div className="lt-composer-col lt-composer-right">
          <section className="lt-form-card lt-exec-card">
            <Field label={t(editing ? 'form.urgency' : 'form.executionMode')} full>
              <Dropdown label={t(editing ? 'form.urgency' : 'form.executionMode')} dataId="urgency" value={urgency} choices={urgencyChoices(t).filter(choice => editing || choice.value !== 'runtime')} onChange={value => { setUrgency(value as Urgency) }} />
            </Field>
            <div className="lt-exec-summary">
              <span className="lt-exec-dot" data-urgency={urgency} />
              <span className="lt-exec-hint">{t('form.executionHint')}</span>
              <span className="lt-exec-pill">{urgency}</span>
            </div>
          </section>
          <section className="lt-form-card">
            <div className="lt-form-card-title">{t('form.executionSettings')}</div>
            <Field label={t('form.permission')} full>
              <Dropdown label={t('form.permission')} dataId="permission" value={permission} choices={permissionChoices(t)} onChange={value => { setPermission(value as Permission) }} />
            </Field>
            {!editing && (
              <Field label={t('form.model')} full>
                <Dropdown
                  label={t('form.model')}
                  dataId="model"
                  value={model}
                  choices={modelChoices(catalog, model, t)}
                  onChange={setModel}
                  emptyLabel={modelEmpty}
                />
              </Field>
            )}
            <div className="lt-schedule-row">
              <Switch
                checked={mode === 'scheduled'}
                onChange={next => { setMode(next ? 'scheduled' : 'queue') }}
                label={t('form.schedule')}
                className="lt-schedule-switch"
              />
              <span className="lt-schedule-label">{t('form.schedule')}</span>
            </div>
            {mode === 'scheduled' && (
              <Field label={t('form.cron')} required full>
                <Input className={cronBad ? 'lt-input lt-input-bad' : 'lt-input'} value={cron} placeholder={t('form.cronPlaceholder')} spellCheck={false} onChange={event => { setCron(event.target.value) }} />
                <span className="lt-cron-presets">
                  {CRON_PRESETS.map(preset => (
                    <button key={preset.cron} type="button" className="lt-cron" data-on={cron.trim() === preset.cron} onClick={() => { setCron(preset.cron) }}>
                      {t(preset.key)}
                    </button>
                  ))}
                  <span className="lt-cron-next">
                    {cronCheck?.next !== undefined
                      ? t('form.cronNext', { time: stampTime(cronCheck.next) })
                      : cronCheck === undefined ? t('form.cronPending') : ''}
                  </span>
                </span>
              </Field>
            )}
          </section>
          <section className="lt-form-card">
            <div className="lt-form-card-title">{editing ? t('form.checklist') : t('form.checklistOptional')}</div>
            <ChecklistEditor rows={rows} onChange={setRows} t={t} editing={editing} />
          </section>
          <section className="lt-form-card">
            <div className="lt-form-card-title">{t('form.accept')}</div>
            <AcceptancePicker list={acceptList} onChange={setAcceptList} strategies={strategies} t={t} />
          </section>
        </div>
      </div>
    </Sheet>
  )
}

function itemsEmpty(rows: readonly ChecklistRow[]): boolean {
  return rows.every(row => row.text.trim() === '')
}

export function attachmentName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function attachmentKind(path: string): string {
  const name = attachmentName(path)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1) : ''
  return ext === '' ? 'FILE' : ext.toUpperCase().slice(0, 4)
}

