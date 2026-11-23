/**
 * 待处理交互卡（提问 / 审批）。
 *
 * 提问卡的结构、指标位（单选序号 / 多选勾选框）、自增高输入区与底栏，
 * 逐项对齐 dsh `QuestionComposer`（`packages/client/ui-user-questions`）；
 * 审批卡是另一套 strip + body + actions。
 *
 * @module dsh-magica-castboard/client/features/interactions/card
 */
import {
  IconCheckOutlineRegular,
  IconCloseOutlineRegular,
  IconEditOutlineRegular,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, type ChangeEvent, type KeyboardEvent } from 'react'

import { ActionButton, MarkdownBody, Tip } from '../../kit/index.ts'
import type { BoardStore } from '../../data/state/index.ts'
import type { InteractionView } from '../../data/index.ts'
import type { Translate } from '../../labels/index.ts'

/**
 * 自增高答案输入。
 *
 * 镜像层负责行高（比按 `\n` 数行更准，软换行也算），textarea 与它共用一格；
 * 镜像与 textarea 的字体、行高、内边距、换行规则必须完全一致。
 */
function AnswerField({ block, value, placeholder, disabled, onChange, onKeyDown }: {
  block: boolean
  value: string
  placeholder: string
  disabled: boolean
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}) {
  return (
    <div className={block ? 'lt-ix-field lt-ix-fieldBlock' : 'lt-ix-field lt-ix-fieldInline'}>
      <div aria-hidden className="lt-ix-fieldMirror">{`${value}\n`}</div>
      <textarea
        className="lt-ix-fieldInput"
        value={value}
        rows={1}
        placeholder={placeholder}
        disabled={disabled}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}

/** 一张交互卡。 */
export function InteractionRow({ view, store, t }: { view: InteractionView; store: BoardStore; t: Translate }) {
  const [answer, setAnswer] = useState('')
  const [selected, setSelected] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const multiSelect = view.multiSelect === true
  const settle = (pending: Promise<boolean>): void => {
    setBusy(true)
    setError(undefined)
    void pending.then(ok => {
      if (!ok) setError(t('interaction.unavailable'))
    }).finally(() => { setBusy(false) })
  }
  const submitQuestion = (): void => {
    const text = answer.trim()
    if (busy || (text === '' && selected.length === 0)) return
    settle(store.answerQuestion(view.id, text, selected))
  }
  const toggleOption = (option: string): void => {
    // 多选保留已填的自由文本（与 dsh `choose` 同口径）；单选清空它。
    if (!multiSelect) setAnswer('')
    setSelected(current => {
      if (!multiSelect) return current.includes(option) ? [] : [option]
      return current.includes(option)
        ? current.filter(item => item !== option)
        : [...current, option]
    })
  }
  const approve = (approved: boolean): void => {
    if (busy) return
    settle(store.answerApproval(view.id, approved))
  }
  const cancel = (): void => {
    if (busy) return
    settle(store.cancelQuestion(view.id))
  }

  if (view.kind === 'approval') {
    return (
      <section className="lt-ix-appr">
        <div className="lt-ix-strip">
          <StateDot state="warning" />
          <span>{t('interaction.waitingApproval')}</span>
        </div>
        <div className="lt-ix-apprbody" tabIndex={0} role="group" aria-label={t('interaction.titleApproval')}>
          <div className="lt-ix-headline">{view.body === '' ? view.title : view.body}</div>
          {view.args !== undefined && view.args !== ''
            ? <div className="lt-ix-command">{view.args}</div>
            : view.body !== '' && view.title !== view.body && <div className="lt-ix-command">{view.title}</div>}
          {error !== undefined && <div className="lt-ix-feedback" role="alert">{error}</div>}
        </div>
        <div className="lt-ix-appractions">
          <ActionButton tone="outline" disabled={busy} onClick={() => { approve(false) }}>{t('interaction.deny')}</ActionButton>
          <ActionButton tone="primary" disabled={busy} onClick={() => { approve(true) }}>{t('interaction.allow')}</ActionButton>
        </div>
      </section>
    )
  }

  const lines = view.body.split('\n')
  const question = lines[0] ?? ''
  const detail = lines.slice(1).join('\n').trim()
  const eyebrow = view.title !== '' && view.title !== 'Question' && view.title !== question ? view.title : ''
  const title = question === '' ? view.title : question
  const options = view.options ?? []
  const hasOptions = options.length > 0
  const draftActive = answer !== ''
  return (
    <section className="lt-ix-card">
      <header className="lt-ix-header">
        <div className="lt-ix-headingBlock">
          {eyebrow !== '' && <div className="lt-ix-eyebrow">{eyebrow}</div>}
          <h3 className="lt-ix-title">{title}</h3>
        </div>
        <div className="lt-ix-headerActions">
          <Tip label={t('interaction.cancel')}>
            <button
              type="button"
              className="lt-ix-icon"
              aria-label={t('interaction.cancel')}
              disabled={busy}
              onClick={cancel}
            ><IconCloseOutlineRegular /></button>
          </Tip>
        </div>
      </header>
      <div className="lt-ix-body">
        {detail !== '' && (
          <div className="lt-ix-detail">
            <MarkdownBody text={detail} t={t} />
          </div>
        )}
        <div className="lt-ix-options" role={multiSelect ? 'group' : 'radiogroup'} aria-label={title}>
          {options.map((option, index) => {
            const on = selected.includes(option)
            const description = view.optionDetails?.find(row => row.label === option)?.description
            return (
              <button
                key={option}
                type="button"
                role={multiSelect ? 'checkbox' : 'radio'}
                aria-checked={on}
                className={on && !multiSelect ? 'lt-ix-option lt-ix-optionSelected' : 'lt-ix-option'}
                disabled={busy}
                onClick={() => { toggleOption(option) }}
              >
                {multiSelect
                  ? (
                      <span className={on ? 'lt-ix-checkbox lt-ix-checkboxChecked' : 'lt-ix-checkbox'} aria-hidden>
                        {on && <IconCheckOutlineRegular size={12} />}
                      </span>
                    )
                  : <span className="lt-ix-number">{index + 1}</span>}
                <span className="lt-ix-optionCopy">
                  <span className="lt-ix-optionLine">
                    <span className="lt-ix-optionLabel">{option}</span>
                    {description === undefined || description === ''
                      ? null
                      : <span className="lt-ix-description">{description}</span>}
                  </span>
                </span>
              </button>
            )
          })}
          {hasOptions
            ? (
                <div className={[
                  'lt-ix-customrow',
                  draftActive ? 'lt-ix-customrow-active' : '',
                  !multiSelect && selected.length > 0 ? 'lt-ix-customrow-yielded' : '',
                ].filter(Boolean).join(' ')}>
                  {multiSelect
                    ? (
                        <span className={draftActive ? 'lt-ix-checkbox lt-ix-checkboxChecked' : 'lt-ix-checkbox'} aria-hidden>
                          {draftActive && <IconCheckOutlineRegular size={12} />}
                        </span>
                      )
                    : <span className="lt-ix-number" aria-hidden><IconEditOutlineRegular size={12} /></span>}
                  <AnswerField
                    block={false}
                    value={answer}
                    placeholder={t('interaction.customPlaceholder')}
                    disabled={busy}
                    onChange={event => {
                      setAnswer(event.target.value)
                      if (!multiSelect) setSelected([])
                    }}
                    onKeyDown={event => {
                      if (event.key !== 'Enter' || event.shiftKey) return
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return
                      event.preventDefault()
                      submitQuestion()
                    }}
                  />
                </div>
              )
            : (
                <AnswerField
                  block
                  value={answer}
                  placeholder={t('interaction.customPlaceholder')}
                  disabled={busy}
                  onChange={event => {
                    setAnswer(event.target.value)
                    if (!multiSelect) setSelected([])
                  }}
                  onKeyDown={event => {
                    if (event.key !== 'Enter' || event.shiftKey) return
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return
                    event.preventDefault()
                    submitQuestion()
                  }}
                />
              )}
        </div>
      </div>
      <footer className="lt-ix-footer">
        <div className="lt-ix-pager">
          <span className="lt-ix-progress">1 / 1</span>
        </div>
        <div className="lt-ix-feedback" role="status">{error ?? null}</div>
        <div className="lt-ix-footerActions">
          <ActionButton tone="outline" disabled={busy} onClick={cancel}>{t('interaction.cancel')}</ActionButton>
          <ActionButton
            tone="primary"
            disabled={busy || (answer.trim() === '' && selected.length === 0)}
            onClick={submitQuestion}
          >{t('interaction.answer')}</ActionButton>
        </div>
      </footer>
    </section>
  )
}
