/**
 * 模板库。
 *
 * @module dsh-magica-castboard/client/features/templates/dialog
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
import { ActionButton, Dropdown, Sheet, useAlert } from '../../kit/index.ts'
import type { AcceptanceEntry, DispatchedRow, IssueTargets, RouterStrategyEntry, WorkspaceNoteEntry } from '../../data/index.ts'
import type { BoardStore } from '../../data/state/index.ts'
import type { Translate } from '../../labels/index.ts'
import { stampTime, templateName } from '../../data/derive/index.ts'

// ─── 模板库 ──────────────────────────────────────────────────────────

/** 模板管理。 */
export function TemplateSheet({ store, t, lang }: { store: BoardStore; t: Translate; lang: 'zh' | 'en' }) {
  const state = store.getSnapshot()
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [confirmId, setConfirmId] = useState<string | undefined>(undefined)
  const { alert, node: alertNode } = useAlert(t)
  const nameOf = (template: (typeof state.templates)[number]): string => edits[template.id] ?? templateName(template, lang)

  const save = (id: string, name: string): void => {
    const template = state.templates.find(item => item.id === id)
    if (template === undefined || name.trim() === '' || name === templateName(template, lang)) return
    void store.upsertTemplate({
      id: template.id,
      name: { zh: name.trim(), en: name.trim() },
      ...(template.description === undefined ? {} : { description: template.description }),
      spec: template.spec,
    }).then(ok => {
      if (!ok) return
      setEdits(current => { const next = { ...current }; delete next[id]; return next })
      alert(t('tpl.renamed'))
    })
  }

  return (
    <>
    <Sheet
      open
      onClose={() => { store.closeTemplateManager() }}
      title={t('tpl.title')}
      hint={t('tpl.subtitle')}
      width="md"
      footer={(
        <span className="lt-sheet-foot">
          <span className="lt-sheet-hint">{t('tpl.foot')}</span>
          <span className="lt-sheet-buttons"><ActionButton onClick={() => { store.closeTemplateManager() }}>{t('common.close')}</ActionButton></span>
        </span>
      )}
    >
      <div className="lt-sheet-body lt-templates">
        {state.templates.length === 0
          ? <div className="lt-empty-small">{t('tpl.empty')}</div>
          : (
              <div className="lt-template-list">
                {state.templates.map(template => (
                  <div className="lt-template-row" key={template.id}>
                    <Input
                      className="lt-input"
                      value={nameOf(template)}
                      maxLength={60}
                      aria-label={t('tpl.name', { name: templateName(template, lang) })}
                      onChange={event => { setEdits(current => ({ ...current, [template.id]: event.target.value })) }}
                      onKeyDown={event => { if (event.key === 'Enter') save(template.id, nameOf(template)) }}
                    />
                    <span className="lt-template-meta">
                      {template.builtin === true ? t('tpl.builtin') : t('tpl.custom')}
                      {template.spec.checklist !== undefined && template.spec.checklist.length > 0 ? t('tpl.metaChecklist', { n: String(template.spec.checklist.length) }) : ''}
                      {template.spec.urgency !== undefined ? ` · ${t(`urgency.${template.spec.urgency}`)}` : ''}
                      {template.spec.permission === 'read-only' ? ` · ${t('form.permReadOnly')}` : template.spec.permission === 'danger-full-access' ? ` · ${t('form.permFull')}` : ''}
                    </span>
                    <span className="lt-template-buttons">
                      <ActionButton
                        disabled={nameOf(template) === templateName(template, lang) || nameOf(template).trim() === ''}
                        tooltip={t('tpl.renameTitle')}
                        onClick={() => { save(template.id, nameOf(template)) }}
                      >
                        {t('tpl.rename')}
                      </ActionButton>
                      <ActionButton tooltip={t('tpl.useTitle')} onClick={() => { store.closeTemplateManager(); store.newFromTemplate(template.spec) }}>{t('tpl.use')}</ActionButton>
                      {confirmId === template.id
                        ? (
                            <>
                              <ActionButton tone="danger" onClick={() => { void store.deleteTemplate(template.id); setConfirmId(undefined) }}>{t('common.delete')}</ActionButton>
                              <ActionButton onClick={() => { setConfirmId(undefined) }}>{t('common.cancel')}</ActionButton>
                            </>
                          )
                        : (
                            <ActionButton tone="danger" tooltip={t('tpl.deleteTitle')} disabled={template.builtin === true} onClick={() => { setConfirmId(template.id) }}>
                              <IconTrashOutlineRegular size={14} />
                            </ActionButton>
                          )}
                    </span>
                  </div>
                ))}
              </div>
            )}
      </div>
    </Sheet>
    {alertNode}
    </>
  )
}

/** 模板库里的一个只读计数（供测试/外部复用）。 */
export function templateCount(): number {
  return 0
}
