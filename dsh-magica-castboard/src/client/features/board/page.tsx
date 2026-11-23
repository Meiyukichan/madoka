/**
 * 看板主视图：工具条、五列车道、次页签与详情抽屉挂载点。
 *
 * @module dsh-magica-castboard/client/features/board/page
 */
import {
  IconArchiveOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconPlusOutlineRegular,
  IconQuestionOutlineRegular,
  IconSettingsOutlineRegular,
  Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, useSyncExternalStore } from 'react'

import type { TaskStatus } from '../../../shared/wire.ts'
import { canTransition } from '../../../shared/wire.ts'
import type { TaskSummaryView } from '../../data/index.ts'
import type { BoardState, BoardStore } from '../../data/state/index.ts'
import type { Translate } from '../../labels/index.ts'
import {
  ActionButton,
  Confirm,
  Dropdown,
  StatusOrb,
  Tip,
  useAlert,
} from '../../kit/index.ts'
import {
  COLUMN_LABEL,
  URGENCY_LABEL,
  stampTime,
  visibleIssues,
  visibleTasks,
} from '../../data/derive/index.ts'
import { DRAG_MIME, TaskTile, IssueTile } from './tiles.tsx'
import { SecondaryPage } from './secondary.tsx'
import { Inspector } from '../task/drawer.tsx'
import { Composer } from '../task/editor.tsx'
import { IssueComposer } from '../issue/editor.tsx'
import { InteractionDialog } from '../interactions/dialogs.tsx'
import { DiagnosticsSheet } from './diagnostics.tsx'
import { SettingsSheet } from '../preferences/dialog.tsx'
import { DispatchedSheet } from '../issue/dispatched.tsx'
import { DispatchSheet } from '../dispatch/dialog.tsx'
import { TemplateSheet } from '../templates/dialog.tsx'

/** 面板 props。 */
export interface LanesProps {
  store: BoardStore
  t: Translate
  lang: 'zh' | 'en'
}

function useBoard(store: BoardStore): BoardState {
  return useSyncExternalStore(
    listener => store.subscribe(listener),
    () => store.getSnapshot(),
  )
}

/** 主视图。 */
export function Lanes({ store, t, lang }: LanesProps) {
  const state = useBoard(store)
  const [newMenu, setNewMenu] = useState(false)

  const [newMenuTimer, setNewMenuTimer] = useState<number | undefined>(undefined)
  const { alert, node: alertNode } = useAlert(t)
  const detail = state.selectedId === undefined ? undefined : state.details.get(state.selectedId)
  const interactions = state.interactionTarget === undefined ? [] : store.interactionsFor(state.interactionTarget)
  const interactionTask = state.interactionTarget === undefined ? undefined : state.tasks.find(task => task.id === state.interactionTarget)
  const dispatchTask = state.dispatchTarget === undefined ? undefined : state.tasks.find(task => task.id === state.dispatchTarget)
  const editingTask = state.composer.editingId === undefined ? undefined : state.details.get(state.composer.editingId)
  const editingIssue = state.issueComposer.editingId === undefined ? undefined : state.issueDetails.get(state.issueComposer.editingId)

  useEffect(() => {
    if (state.error === undefined || state.error === '') return
    alert(state.error)
  }, [alert, state.error])

  useEffect(() => {
    if (state.selectedId === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') store.select(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [store, state.selectedId])

  useEffect(() => () => {
    if (newMenuTimer !== undefined) window.clearTimeout(newMenuTimer)
  }, [newMenuTimer])

  const live = visibleTasks(state, state.tasks.filter(task => task.trashedAt === undefined))
  const issues = visibleIssues(state, state.issues)
  const pickerTasks = live

  const startDrop = (status: TaskStatus) => ({
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes(DRAG_MIME)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      event.currentTarget.dataset.over = 'true'
    },
    onDragLeave: (event: React.DragEvent<HTMLDivElement>) => { delete event.currentTarget.dataset.over },
    onDrop: (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      delete event.currentTarget.dataset.over
      const id = event.dataTransfer.getData(DRAG_MIME)
      if (id === '') return
      const task = state.tasks.find(item => item.id === id)
      if (task === undefined || task.status === status) return
      if (!canTransition(task.status, status)) {
        alert(t('board.dragForbidden', { from: t(COLUMN_LABEL[task.status]), to: t(COLUMN_LABEL[status]) }))
        return
      }
      void store.move(id, status)
    },
  })

  return (
    <section className="lt-page" data-castboard-board="" data-status={state.status}>
      <header className="lt-bar">
        <div className="lt-title-group">
          <h2 className="lt-heading">{t('board.title')}</h2>
          {state.version !== undefined && (
            <Tip label={t('board.version')}><span className="lt-version">· v{state.version}</span></Tip>
          )}
        </div>
        {state.status !== 'ready' && (
          <Tip label={state.error ?? t(state.status === 'offline' ? 'state.offline' : 'state.loading')}>
            <span className="lt-conn" data-status={state.status}>
              <span className="lt-conn-dot" data-status={state.status} />
              {t(state.status === 'offline' ? 'state.offline' : 'state.loading')}
            </span>
          </Tip>
        )}
        {state.status === 'offline' && (
          <button type="button" className="lt-textlink" onClick={() => { void store.refresh() }}>{t('common.retry')}</button>
        )}
        <div className="lt-split-wrap">
          <span className="lt-split">
            <ActionButton tone="primary" onClick={() => { store.openComposer() }}>{t('board.new')}</ActionButton>
            <ActionButton
              tone="primary"
              className="lt-split-caret"
              aria-haspopup="menu"
              aria-expanded={newMenu}
              aria-label={t('board.newMenu')}
              tooltip={t('board.newMenu')}
              onClick={() => {
                const next = !newMenu
                setNewMenu(next)
                if (next) store.prepareTemplateMenu()
              }}
            >
              <IconChevronDownOutlineRegular size={12} />
            </ActionButton>
          </span>
          {newMenu && (
            <>
              <div className="lt-menu-backdrop" onClick={() => { setNewMenu(false) }} />
              <div className="lt-menu" role="menu">
                {state.templates.map(template => (
                  <button
                    key={template.id}
                    type="button"
                    className="lt-menu-item"
                    onClick={() => {
                      setNewMenu(false)
                      store.newFromTemplate(template.spec)
                    }}
                  >
                    <Tip label={(template.spec.detail ?? template.name[lang] ?? template.name.zh).slice(0, 120)}>
                      <span>{template.name[lang] ?? template.name.zh}</span>
                    </Tip>
                  </button>
                ))}
                {state.templates.length > 0 && <div className="lt-menu-sep" />}
                <button type="button" className="lt-menu-item" onClick={() => { setNewMenu(false); store.openTemplateManager() }}>{t('board.manageTemplates')}</button>
              </div>
            </>
          )}
        </div>
        <div className="lt-flex" />
        <Input
          className="lt-input lt-search"
          value={state.search}
          placeholder={t('board.search')}
          aria-label={t('board.search')}
          spellCheck={false}
          onChange={event => { store.setSearch(event.target.value) }}
        />
        <Dropdown
          label={t('board.allProjects')}
          value={state.filters.workspaceId ?? ''}
          choices={[
            { value: '', label: t('board.allProjects') },
            ...state.workspaces.map(workspace => ({ value: workspace.id, label: workspace.title || workspace.path })),
          ]}
          onChange={value => { store.setWorkspaceFilter(value === '' ? undefined : value) }}
        />
        <Dropdown
          label={t('board.sort')}
          value={state.sortBy}
          choices={[
            { value: 'default', label: t('board.sort.default') },
            { value: 'updated', label: t('board.sort.updated') },
            { value: 'urgency', label: t('board.sort.urgency') },
            { value: 'created', label: t('board.sort.created') },
            { value: 'title', label: t('board.sort.title') },
          ]}
          onChange={value => { store.setSortBy(value as typeof state.sortBy) }}
        />
        {(['urgent', 'normal', 'relaxed'] as const).map(urgency => (
          <button
            key={urgency}
            type="button"
            className="lt-filter"
            data-urgency={urgency}
            data-on={state.filters.urgencies.includes(urgency)}
            onClick={() => { store.toggleUrgency(urgency) }}
          >
            <span className="lt-dot" data-urgency={urgency} />
            {t(URGENCY_LABEL[urgency])}
          </button>
        ))}
        <div className="lt-icon-group">
          <ActionButton
            size="sm"
            className="lt-iconbtn"
            icon={state.secondaryOpen ? <IconChevronLeftOutlineRegular /> : <IconArchiveOutlineRegular />}
            tooltip={state.secondaryOpen ? t('board.back') : t('board.otherTasks')}
            aria-label={state.secondaryOpen ? t('board.back') : t('board.otherTasks')}
            aria-pressed={state.secondaryOpen}
            onClick={() => { store.toggleSecondary() }}
          />
          <ActionButton size="sm" className="lt-iconbtn" icon={<IconSettingsOutlineRegular />} tooltip={t('board.settingsTitle')} aria-label={t('board.settings')} onClick={() => { store.openSettings() }} />
        </div>
      </header>

      <div
        className="lt-stage"
        onClick={event => {
          if (detail === undefined) return
          const target = event.target as HTMLElement
          if (target.closest('.lt-drawer') !== null) return
          if (target.closest('.lt-tile') !== null) return
          store.select(undefined)
        }}
      >
        {state.secondaryOpen
          ? <SecondaryPage store={store} tasks={state.tasks} t={t} lang={lang} onAlert={alert} />
          : (
              <div className="lt-lanes">
                <div className="lt-lane lt-lane-issue" key="issue">
                  <div className="lt-lane-head">
                    <StatusOrb status="issue" />
                    {t('issue.column')}
                    <span className="lt-count">{issues.length}</span>
                    <Tip label={t('issue.dispatchedTitle')}><button type="button" className="lt-textlink" onClick={() => { store.openDispatched() }}>{t('issue.dispatched')}</button></Tip>
                  </div>
                  <div className="lt-tiles">
                    {issues.map(issue => <IssueTile key={issue.issueId} issue={issue} store={store} t={t} />)}
                  </div>
                </div>
                {(['todo', 'in_progress', 'in_review', 'done'] as const).map(status => {
                  const columnTasks = live.filter(task => task.status === status)
                  return (
                    <div className="lt-lane" key={status} data-status={status} {...startDrop(status)}>
                      <div className="lt-lane-head">
                        <StatusOrb status={status} />
                        {t(COLUMN_LABEL[status])}
                        <span className="lt-count">{columnTasks.length}</span>
                        {status === 'in_progress' && (
                          <Tip label={t('interaction.openTitle', { n: String(store.interactionCount()) })}>
                            <button
                              type="button"
                              className="lt-inbox-entry"
                              data-on={store.interactionCount() > 0 ? 'true' : undefined}
                              aria-label={t('interaction.openTitle', { n: String(store.interactionCount()) })}
                              onClick={event => { event.stopPropagation(); store.openInteractionInbox() }}
                            >
                              <IconQuestionOutlineRegular size={12} />
                              <span>{t('interaction.open')}</span>
                              {store.interactionCount() > 0 && <span className="lt-inbox-count">{store.interactionCount()}</span>}
                            </button>
                          </Tip>
                        )}
                      </div>
                      <div className="lt-tiles">
                        {columnTasks.map(task => (
                          <TaskTile key={task.id} task={task} store={store} t={t} lang={lang} draggable onAlert={alert} />
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

        {detail !== undefined && (
          <aside className="lt-drawer" role="dialog" aria-label={t('detail.drawer')}>
            <Inspector key={detail.task.id} detail={detail} store={store} t={t} tasks={pickerTasks} lang={lang} onAlert={alert} />
          </aside>
        )}
      </div>

      {state.composer.open && (state.composer.editingId === undefined || editingTask !== undefined) && (
        <Composer store={store} t={t} lang={lang} task={editingTask?.task} prefill={state.composer.prefill} />
      )}
      {state.issueComposer.open && (state.issueComposer.editingId === undefined || editingIssue !== undefined) && (
        <IssueComposer store={store} t={t} issue={editingIssue?.issue} />
      )}

      {state.abandonTarget !== undefined && (
        <Confirm
          title={t('delete.title')}
          body={t(state.abandonTarget.kind === 'task' ? 'delete.task' : 'delete.issue', { title: state.abandonTarget.title })}
          confirmLabel={t('delete.action')}
          cancelLabel={t('common.cancel')}
          onCancel={() => { store.closeAbandon() }}
          onConfirm={() => { void store.confirmAbandon() }}
        />
      )}

      {interactions.length > 0 && (
        <InteractionDialog
          views={interactions}
          {...(interactionTask === undefined ? {} : { taskTitle: interactionTask.title })}
          store={store}
          t={t}
          onClose={() => { store.closeInteraction() }}
        />
      )}

      {state.diagOpen && <DiagnosticsSheet store={store} t={t} />}
      {state.settingsOpen && <SettingsSheet store={store} t={t} lang={lang} />}
      {state.dispatchedOpen && <DispatchedSheet store={store} t={t} />}
      {dispatchTask !== undefined && <DispatchSheet store={store} task={dispatchTask} t={t} onAlert={alert} />}
      {state.tplManagerOpen && <TemplateSheet store={store} t={t} lang={lang} />}
      {alertNode}
    </section>
  )
}
