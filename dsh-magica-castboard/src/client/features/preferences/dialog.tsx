/**
 * 面板设置（五页）。
 *
 * @module dsh-magica-castboard/client/features/preferences/dialog
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

// ─── 设置 ────────────────────────────────────────────────────────────

type TabId = 'exec' | 'plan' | 'workspaces' | 'strategy' | 'accept'

interface NoteRow { key: number; workspaceId: string; description: string }
interface StrategyRow { key: number; id: string; name: string; text: string }
interface AcceptRow { key: number; id: string; title: string; type: 'issue' | 'close'; description: string }

let rowSeq = 1

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

function normTitle(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

function duplicateTitles(rows: readonly { title: string }[]): Set<string> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = normTitle(row.title.trim())
    if (key === '') continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const result = new Set<string>()
  for (const [key, count] of counts) if (count > 1) result.add(key)
  return result
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(key => a[key] === b[key])
}

/** 面板设置（左导航 + 右内容，五页）。 */
export function SettingsSheet({ store, t, lang }: { store: BoardStore; t: Translate; lang: 'zh' | 'en' }) {
  const state = store.getSnapshot()
  const [tab, setTab] = useState<TabId>('exec')
  const settings: BoardSettings = state.settings ?? {
    defaultPermission: 'workspace-write',
    maxConcurrent: 3,
    autoRoute: true,
    portraitRunOnStart: false,
    commentsEnabled: true,
    commentPollMs: 5000,
  }
  const [conc, setConc] = useState(String(settings.maxConcurrent))
  const [auto, setAuto] = useState(settings.autoRoute)
  const [portraitOnStart, setPortraitOnStart] = useState(settings.portraitRunOnStart)
  const [comments, setComments] = useState(settings.commentsEnabled)
  const [poll, setPoll] = useState(String(settings.commentPollMs))
  const [notes, setNotes] = useState<NoteRow[]>([])
  const [strategies, setStrategies] = useState<StrategyRow[]>([])
  const [accepts, setAccepts] = useState<AcceptRow[]>([])
  const [portraitBusy, setPortraitBusy] = useState(false)
  const [portraitNote, setPortraitNote] = useState('')

  useEffect(() => {
    setNotes((state.workspaceNotes ?? []).map(entry => ({ key: rowSeq++, workspaceId: entry.workspaceId, description: entry.description ?? '' })))
  }, [state.workspaceNotes])
  useEffect(() => {
    setStrategies((state.routerStrategies ?? []).map(entry => ({ key: rowSeq++, id: entry.id ?? newId('s'), name: entry.name, text: entry.text })))
  }, [state.routerStrategies])
  useEffect(() => {
    setAccepts((state.acceptanceStrategies ?? []).map(entry => ({ key: rowSeq++, id: entry.id, title: entry.title, type: entry.type, description: entry.description })))
  }, [state.acceptanceStrategies])

  const parsedConc = Number.parseInt(conc, 10)
  const concValid = Number.isInteger(parsedConc) && parsedConc >= 1 && parsedConc <= 20
  const parsedPoll = Number.parseInt(poll, 10)
  const pollValid = Number.isInteger(parsedPoll) && parsedPoll >= 1000 && parsedPoll <= 3_600_000
  const dupStrategy = duplicateTitles(strategies.map(row => ({ title: row.name })))
  const dupAccept = duplicateTitles(accepts.map(row => ({ title: row.title })))
  const baseDirty = !concValid ? false : parsedConc !== settings.maxConcurrent || auto !== settings.autoRoute || portraitOnStart !== settings.portraitRunOnStart || comments !== settings.commentsEnabled || parsedPoll !== settings.commentPollMs
  const notesDirty = state.workspaceNotes !== undefined && !sameRecord(
    Object.fromEntries(notes.filter(row => row.workspaceId !== '' && row.description.trim() !== '').map(row => [row.workspaceId, row.description.trim()])),
    Object.fromEntries((state.workspaceNotes ?? []).map(row => [row.workspaceId, row.description ?? ''])),
  )
  const strategyDirty = state.routerStrategies !== undefined && JSON.stringify(strategies.filter(row => row.name.trim() !== '' && row.text.trim() !== '').map(row => ({ id: row.id, name: row.name.trim(), text: row.text.trim() })))
    !== JSON.stringify((state.routerStrategies ?? []).map(row => ({ id: row.id, name: row.name, text: row.text })))
  const acceptDirty = state.acceptanceStrategies !== undefined && JSON.stringify(accepts.filter(row => row.title.trim() !== '' && row.description.trim() !== '').map(row => ({ id: row.id, type: row.type, title: row.title.trim(), description: row.description.trim() })))
    !== JSON.stringify((state.acceptanceStrategies ?? []).map(row => ({ id: row.id, type: row.type, title: row.title, description: row.description })))
  const dirty = concValid && pollValid && dupStrategy.size === 0 && dupAccept.size === 0 && (baseDirty || notesDirty || strategyDirty || acceptDirty)

  const workspaceChoices = state.workspaces.map(workspace => ({ value: workspace.id, label: workspace.title || workspace.path }))
  const unusedWorkspace = state.workspaces.find(workspace => !notes.some(row => row.workspaceId === workspace.id))?.id ?? ''

  const save = (): void => {
    if (!dirty) return
    void (async () => {
      let ok = true
      if (baseDirty) {
        ok = await store.updateSettings({
          ...settings,
          maxConcurrent: parsedConc,
          autoRoute: auto,
          portraitRunOnStart: portraitOnStart,
          commentsEnabled: comments,
          commentPollMs: parsedPoll,
        }) && ok
      }
      if (notesDirty) {
        ok = await store.updateNotes(notes
          .filter(row => row.workspaceId !== '' && row.description.trim() !== '')
          .map(row => ({ workspaceId: row.workspaceId, description: row.description.trim() }))) && ok
      }
      if (strategyDirty) {
        ok = await store.updateRouterStrategies(strategies
          .filter(row => row.name.trim() !== '' && row.text.trim() !== '')
          .map(row => ({ id: row.id, name: row.name.trim(), text: row.text.trim() }))) && ok
      }
      if (acceptDirty) {
        ok = await store.updateAcceptance(accepts
          .filter(row => row.title.trim() !== '' && row.description.trim() !== '')
          .map(row => ({ id: row.id, type: row.type, title: row.title.trim(), description: row.description.trim() }))) && ok
      }
      if (ok) store.closeSettings()
    })()
  }

  return (
    <Sheet
      open
      onClose={() => { store.closeSettings() }}
      title={t('settings.title')}
      width="wide"
      className="lt-settings"
      footer={(
        <span className="lt-sheet-foot">
          {dirty && <span className="lt-sheet-hint">{t('settings.dirty')}</span>}
          <span className="lt-sheet-buttons">
            <ActionButton onClick={() => { store.closeSettings() }}>{t('common.cancel')}</ActionButton>
            <ActionButton tone="primary" disabled={!dirty} onClick={save}>{t('settings.save')}</ActionButton>
          </span>
        </span>
      )}
    >
      <div className="lt-sheet-body lt-settings-body">
        <nav className="lt-settings-nav">
          {(['exec', 'plan', 'workspaces', 'strategy', 'accept'] as const).map(id => (
            <button
              key={id}
              type="button"
              className="lt-settings-tab"
              data-on={tab === id}
              aria-current={tab === id ? 'true' : undefined}
              onClick={() => { setTab(id) }}
            >
              {t(id === 'exec' ? 'settings.tabExec' : id === 'plan' ? 'settings.tabPlan' : id === 'workspaces' ? 'settings.tabWorkspaces' : id === 'strategy' ? 'settings.tabStrategy' : 'settings.tabAccept')}
            </button>
          ))}
        </nav>
        <div className="lt-settings-pane">
          <section className="lt-settings-section" hidden={tab !== 'exec'}>
            <h4>{t('settings.concHeading')}</h4>
            <div className="lt-conc-row">
              <input
                className="lt-conc"
                type="number"
                min={1}
                max={20}
                step={1}
                value={conc}
                aria-label={t('settings.concHeading')}
                data-invalid={concValid ? undefined : 'true'}
                onChange={event => { setConc(event.target.value) }}
              />
              <span className="lt-conc-hint">
                {concValid ? t('settings.concHint', { min: '1', max: '20', def: '3' }) : t('settings.concInvalid', { min: '1', max: '20' })}
              </span>
            </div>
            <span className="lt-note">{t('settings.concCurrent', { current: String(settings.maxConcurrent) })}</span>
          </section>

          <section className="lt-settings-section" hidden={tab !== 'plan'}>
            <h4>{t('settings.autoHeading')}</h4>
            <label className="lt-toggle">
              <input type="checkbox" checked={auto} onChange={event => { setAuto(event.target.checked) }} />
              <span>{auto ? t('settings.autoOn') : t('settings.autoOff')}</span>
            </label>
            <span className="lt-note">{t('settings.autoHint')}</span>

            <h4>{t('settings.commentsHeading')}</h4>
            <label className="lt-toggle">
              <input type="checkbox" checked={comments} onChange={event => { setComments(event.target.checked) }} />
              <span>{comments ? t('settings.commentsOn') : t('settings.commentsOff')}</span>
            </label>
            <span className="lt-note">{t('settings.commentsHint')}</span>
            <div className="lt-inline-field">
              <label htmlFor="lt-comment-poll">{t('settings.commentsInterval')}</label>
              <Input id="lt-comment-poll" className="lt-input" value={poll} disabled={!comments} onChange={event => { setPoll(event.target.value) }} />
              <span className="lt-note" data-tone={pollValid ? undefined : 'bad'}>
                {pollValid ? t('settings.commentsIntervalNote', { ms: String(parsedPoll) }) : t('settings.commentsIntervalInvalid', { min: '1000', max: '3600000' })}
              </span>
            </div>
          </section>

          <section className="lt-settings-section" hidden={tab !== 'workspaces'}>
            <h4>{t('settings.wsHeading')}</h4>
            <span className="lt-note">{t('settings.wsHint')}</span>
            {state.workspaceNotes === undefined
              ? <span className="lt-note">{t('settings.wsLoading')}</span>
              : (
                  <>
                    <div className="lt-settings-rows">
                      {notes.length === 0
                        ? <span className="lt-note">{t('settings.wsEmpty')}</span>
                        : notes.map((row, index) => (
                            <div className="lt-settings-row" key={row.key}>
                              <Dropdown
                                label={t('settings.wsProject')}
                                dataId={`workspace-note-${String(index)}`}
                                value={row.workspaceId}
                                choices={workspaceChoices}
                                onChange={value => { setNotes(current => current.map(item => (item.key === row.key ? { ...item, workspaceId: value } : item))) }}
                                emptyLabel={t('form.projectEmpty')}
                              />
                              <input
                                className="lt-native lt-settings-desc"
                                value={row.description}
                                maxLength={2000}
                                placeholder={t('settings.wsDesc')}
                                aria-label={t('settings.wsDescAria')}
                                onChange={event => { setNotes(current => current.map(item => (item.key === row.key ? { ...item, description: event.target.value } : item))) }}
                              />
                              <ActionButton tone="danger" tooltip={t('settings.rowRemove')} onClick={() => { setNotes(current => current.filter(item => item.key !== row.key)) }}>
                                <IconTrashOutlineRegular size={14} />
                              </ActionButton>
                            </div>
                          ))}
                    </div>
                    <span className="lt-add-row">
                      <ActionButton tooltip={t('settings.rowAddTitle')} onClick={() => { setNotes(current => [...current, { key: rowSeq++, workspaceId: unusedWorkspace, description: '' }]) }}>{t('settings.rowAdd')}</ActionButton>
                    </span>
                  </>
                )}

            <h4>{t('settings.portraitHeading')}</h4>
            <label className="lt-toggle">
              <input type="checkbox" checked={portraitOnStart} onChange={event => { setPortraitOnStart(event.target.checked) }} />
              <span>{portraitOnStart ? t('settings.portraitOnStartOn') : t('settings.portraitOnStartOff')}</span>
            </label>
            <span className="lt-note">{t('settings.portraitOnStartHint')}</span>
            <span className="lt-note">{t('settings.portraitHint')}</span>
            <span className="lt-inline-field">
              <ActionButton
                tooltip={t('settings.portraitRefreshTitle')}
                disabled={portraitBusy}
                onClick={() => {
                  setPortraitBusy(true)
                  setPortraitNote('')
                  void store.refreshPortraits().then(reset => {
                    setPortraitNote(reset === undefined ? t('settings.portraitFailed') : t('settings.portraitDone'))
                  }).finally(() => { setPortraitBusy(false) })
                }}
              >
                {portraitBusy ? t('settings.portraitBusy') : t('settings.portraitRefresh')}
              </ActionButton>
              {portraitNote !== '' && <span className="lt-note">{portraitNote}</span>}
            </span>
          </section>

          <section className="lt-settings-section" hidden={tab !== 'strategy'}>
            <h4>{t('settings.strategyHeading')}</h4>
            <span className="lt-note">{t('settings.strategyHint')}</span>
            {state.routerStrategies === undefined
              ? <span className="lt-note">{t('settings.strategyLoading')}</span>
              : (
                  <>
                    <div className="lt-settings-rows">
                      {strategies.length === 0
                        ? <span className="lt-note">{t('settings.strategyEmpty')}</span>
                        : strategies.map(row => (
                            <div className="lt-settings-row lt-settings-row-text" key={row.key}>
                              <input
                                className="lt-native lt-settings-title"
                                value={row.name}
                                maxLength={120}
                                placeholder={t('settings.strategyTitle')}
                                aria-label={t('settings.strategyTitleAria')}
                                data-invalid={dupStrategy.has(normTitle(row.name.trim())) ? 'true' : undefined}
                                onChange={event => { setStrategies(current => current.map(item => (item.key === row.key ? { ...item, name: event.target.value } : item))) }}
                              />
                              <textarea
                                className="lt-textarea lt-settings-text"
                                rows={3}
                                value={row.text}
                                maxLength={2000}
                                placeholder={t('settings.strategyDesc')}
                                aria-label={t('settings.strategyDescAria')}
                                onChange={event => { setStrategies(current => current.map(item => (item.key === row.key ? { ...item, text: event.target.value } : item))) }}
                              />
                              <ActionButton tone="danger" tooltip={t('settings.rowRemove')} onClick={() => { setStrategies(current => current.filter(item => item.key !== row.key)) }}>
                                <IconTrashOutlineRegular size={14} />
                              </ActionButton>
                            </div>
                          ))}
                    </div>
                    {dupStrategy.size > 0 && <span className="lt-note" data-tone="bad">{t('settings.strategyDup')}</span>}
                    <span className="lt-add-row">
                      <ActionButton tooltip={t('settings.rowAddTitle')} onClick={() => { setStrategies(current => [...current, { key: rowSeq++, id: newId('s'), name: '', text: '' }]) }}>{t('settings.rowAdd')}</ActionButton>
                    </span>
                  </>
                )}
          </section>

          <section className="lt-settings-section" hidden={tab !== 'accept'}>
            <h4>{t('settings.acceptHeading')}</h4>
            <span className="lt-note">{t('settings.acceptHint')}</span>
            {state.acceptanceStrategies === undefined
              ? <span className="lt-note">{t('settings.acceptLoading')}</span>
              : (
                  <>
                    <div className="lt-settings-rows">
                      {accepts.length === 0
                        ? <span className="lt-note">{t('settings.acceptEmpty')}</span>
                        : accepts.map((row, index) => (
                            <div className="lt-settings-row" key={row.key}>
                              <input
                                className="lt-native lt-settings-title"
                                value={row.title}
                                maxLength={80}
                                placeholder={t('settings.acceptTitle')}
                                aria-label={t('settings.acceptTitleAria')}
                                data-invalid={dupAccept.has(normTitle(row.title.trim())) ? 'true' : undefined}
                                onChange={event => { setAccepts(current => current.map(item => (item.key === row.key ? { ...item, title: event.target.value } : item))) }}
                              />
                              <Dropdown
                                label={t('settings.acceptTypeAria')}
                                dataId={`accept-type-${String(index)}`}
                                triggerClass="lt-settings-kind"
                                value={row.type}
                                choices={[
                                  { value: 'close', label: t('settings.acceptTypeClose') },
                                  { value: 'issue', label: t('settings.acceptTypeIssue') },
                                ]}
                                onChange={value => { setAccepts(current => current.map(item => (item.key === row.key ? { ...item, type: value as 'issue' | 'close' } : item))) }}
                              />
                              <input
                                className="lt-native lt-settings-desc"
                                value={row.description}
                                maxLength={4000}
                                placeholder={t('settings.acceptDesc')}
                                aria-label={t('settings.acceptDescAria')}
                                onChange={event => { setAccepts(current => current.map(item => (item.key === row.key ? { ...item, description: event.target.value } : item))) }}
                              />
                              <ActionButton tone="danger" tooltip={t('settings.rowRemove')} onClick={() => { setAccepts(current => current.filter(item => item.key !== row.key)) }}>
                                <IconTrashOutlineRegular size={14} />
                              </ActionButton>
                            </div>
                          ))}
                    </div>
                    {dupAccept.size > 0 && <span className="lt-note" data-tone="bad">{t('settings.strategyDup')}</span>}
                    <span className="lt-add-row">
                      <ActionButton tooltip={t('settings.rowAddTitle')} onClick={() => { setAccepts(current => [...current, { key: rowSeq++, id: newId('a'), title: '', type: 'close', description: '' }]) }}>{t('settings.rowAdd')}</ActionButton>
                    </span>
                  </>
                )}
          </section>
        </div>
      </div>
      {/* lang 只用于将来本地化策略标题；保持引用避免未使用告警。 */}
      <span hidden>{lang}</span>
    </Sheet>
  )
}

