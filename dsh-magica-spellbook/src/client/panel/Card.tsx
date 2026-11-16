/**
 * 待决交互卡片：提问流 + 审批流。
 *
 * 全受控：数据与回调都由 props 进来（`t` / `actions`），组件本身不碰 `ctx`。
 *
 * @module dsh-magica-spellbook/client/panel/Card
 */

import { useMemo, useState } from 'react'
import { Button, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
// 0.2 的 primitives 不再导出 Icon*（真机表现为 React #130），图标自带
import {
  IconCheckOutline14,
  IconChevronDownOutline14,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconChevronUpOutline14,
  IconCloseOutline16,
  IconEditOutline16,
} from './icons.tsx'
import { currentLang, pickDisplayText } from './display-text.ts'
import { parseRecommended } from './recommended.ts'
import type { InteractionActions } from './carrier.ts'
import type { InteractionTranslate } from './locales.ts'
import type {
  InteractionAnswerItem,
  InteractionQuestion,
  PendingInteractionRecord,
} from '../../shared/wire.ts'

/** 卡片入参。 */
export interface InteractionCardProps {
  view: PendingInteractionRecord
  t: InteractionTranslate
  actions: InteractionActions
  variant?: 'takeover' | 'plain'
  onAnswered?: () => void
}

interface Draft {
  selected: string[]
  custom: string
  skipped: boolean
}

function emptyDraft(): Draft {
  return { selected: [], custom: '', skipped: false }
}

function hasAnswer(draft: Draft, question: InteractionQuestion): boolean {
  if (draft.skipped) return true
  if (draft.custom.trim() !== '') return true
  if (question.multiSelect === true) return draft.selected.length > 0
  return draft.selected.length > 0
}

function toAnswer(question: InteractionQuestion, draft: Draft): InteractionAnswerItem {
  if (draft.skipped) return { id: question.id, selected: [] }
  const answer: InteractionAnswerItem = { id: question.id, selected: draft.selected }
  const custom = draft.custom.trim()
  if (custom !== '') {
    answer.custom = custom
    // 单选且填了自由文本：选项清空（与 dsh 的 submitDrafts 同口径）
    if (question.multiSelect !== true) answer.selected = []
  }
  return answer
}

interface QuestionFlowProps {
  view: PendingInteractionRecord
  questions: InteractionQuestion[]
  t: InteractionTranslate
  actions: InteractionActions
  onAnswered?: () => void
}

function QuestionFlow({ view, questions, t, actions, onAnswered }: QuestionFlowProps): React.ReactElement {
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => emptyDraft()))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [minimized, setMinimized] = useState(false)

  const question = questions[index]
  const draft = drafts[index] ?? emptyDraft()
  const total = questions.length
  const isLast = index >= total - 1

  function patch(next: Partial<Draft>): void {
    setDrafts((current) => current.map((item, at) => (at === index ? { ...item, ...next } : item)))
    setError(null)
  }

  function toggle(option: string): void {
    if (question === undefined) return
    if (question.multiSelect === true) {
      const selected = draft.selected.includes(option)
        ? draft.selected.filter((item) => item !== option)
        : [...draft.selected, option]
      patch({ selected, skipped: false })
      return
    }
    patch({ selected: [option], custom: '' })
  }

  function skip(): void {
    patch({ skipped: true, selected: [], custom: '' })
    if (isLast) void submit([{ id: question?.id ?? '', selected: [] }])
    else setIndex((at) => Math.min(total - 1, at + 1))
  }

  async function advance(): Promise<void> {
    if (question === undefined) return
    if (!hasAnswer(draft, question)) {
      setError(t('ix.error.unanswered'))
      return
    }
    if (!isLast) {
      setIndex((at) => Math.min(total - 1, at + 1))
      return
    }
    const answers = questions.map((item, at) => toAnswer(item, drafts[at] ?? emptyDraft()))
    await submit(answers)
  }

  async function submit(answers: InteractionAnswerItem[]): Promise<void> {
    setBusy(true)
    const result = await actions.answerQuestion(view, answers)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onAnswered?.()
  }

  async function cancel(): Promise<void> {
    setBusy(true)
    const result = await actions.cancelQuestion(view)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onAnswered?.()
  }

  if (question === undefined) return <div className="magica-ix-frame" />

  // 引用必须稳定：dsh 的 `MarkdownText` 按**引用**判断 labels 是否变化，
  // 每次渲染新建对象会让它每次按键都重新解析整段 markdown（A-264）
  const labels = useMemo(
    () => ({ code: { copyLabel: t('ix.copy'), copiedLabel: t('ix.copied') }, footnotes: t('ix.footnotes') }),
    [t],
  )

  return (
    <div className="magica-ix-frame">
      <section className="magica-ix-card">
        <header className="magica-ix-header">
          <div className="magica-ix-headings">
            <span className="magica-ix-eyebrow">
              {/* 没有 header 时**不显示**眉标：早前拿 `ix.recommended` 兜底，
                  结果每张没 header 的卡片都写着"推荐"（A-114） */}
              {question.header === undefined || question.header === '' ? null : question.header}
              {/* 0.2 新增：计划评审走同一张卡，但语义是"批准/拒绝整份计划" */}
              {question.intent?.kind === 'plan-review' ? (
                <span className="magica-ix-badge">{t('ix.planReview')}</span>
              ) : null}
            </span>
            <h3 className="magica-ix-title">{question.question}</h3>
          </div>
          <div className="magica-ix-actions">
            <button
              type="button"
              className="magica-ix-icon"
              title={minimized ? t('ix.expand') : t('ix.minimize')}
              onClick={() => setMinimized((value) => !value)}
            >
              {minimized ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
            </button>
            <button
              type="button"
              className="magica-ix-icon"
              title={t('ix.cancel')}
              disabled={busy}
              onClick={() => void cancel()}
            >
              <IconCloseOutline16 />
            </button>
          </div>
        </header>

        {minimized ? null : (
          <>
            {question.detail === undefined ? null : (
              <div className="magica-ix-detail">
                <MarkdownText text={question.detail} labels={labels} variant="compact" />
              </div>
            )}
            <div className="magica-ix-body">
              <div
                className="magica-ix-options"
                // 读屏可作答：多选是 group，单选是 radiogroup（A-269）
                role={question.multiSelect === true ? 'group' : 'radiogroup'}
                aria-label={question.question}
              >
                {(question.options ?? []).map((option, at) => {
                  const on = draft.selected.includes(option.label)
                  // 计划评审：`intent.approve` 指明哪个选项是"批准"（名字匹配，不靠顺序推断）
                  const approves = question.intent?.kind === 'plan-review' && question.intent.approve === option.label
                  // 推荐标记写在标签里（宿主约定）：拆出来单独渲染，答回去仍然用**纯标签**
                  const parsed = parseRecommended(option.label)
                  const recommended = approves || parsed.recommended
                  return (
                    <button
                      key={option.label}
                      type="button"
                      role={question.multiSelect === true ? 'checkbox' : 'radio'}
                      aria-checked={on}
                      className={[
                        'magica-ix-option',
                        on ? 'magica-ix-on' : '',
                        recommended ? 'magica-ix-approve' : '',
                      ].filter(Boolean).join(' ')}
                      disabled={busy}
                      onClick={() => toggle(option.label)}
                    >
                      <span className="magica-ix-num">{at + 1}</span>
                      <span className={on ? 'magica-ix-check magica-ix-checkon' : 'magica-ix-check'}>
                        {on ? <IconCheckOutline14 size={12} /> : null}
                      </span>
                      <span className="magica-ix-copy">
                        <span className="magica-ix-label">
                          {parsed.clean}
                          {recommended ? <span className="magica-ix-recommend">{t('ix.recommended')}</span> : null}
                        </span>
                        {option.description === undefined ? null : (
                          <span className="magica-ix-desc">{option.description}</span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
              <div className={question.options === undefined || question.options.length === 0 ? 'magica-ix-block' : 'magica-ix-customrow'}>
                <IconEditOutline16 size={12} />
                {/* 自增高 textarea（B-161/B-162）：`rows={1}` + 输入时同步高度，
                    长答案不再被单行输入框截断 */}
                <textarea
                  className="magica-ix-input"
                  rows={1}
                  value={draft.custom}
                  placeholder={t('ix.custom')}
                  disabled={busy}
                  onChange={(event) => {
                    patch({ custom: event.target.value, skipped: false })
                    const field = event.currentTarget
                    field.style.height = 'auto'
                    field.style.height = `${field.scrollHeight}px`
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || event.shiftKey) return
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return
                    event.preventDefault()
                    void advance()
                  }}
                />
              </div>
            </div>

            <footer className="magica-ix-footer">
              <span className="magica-ix-progress">
                {t('ix.progress', { current: String(index + 1), total: String(total) })}
              </span>
              <div className="magica-ix-footerbtns">
                <Button variant="outline" disabled={index === 0 || busy} onClick={() => setIndex((at) => Math.max(0, at - 1))}>
                  <IconChevronLeftOutline14 /> {t('ix.prev')}
                </Button>
                <Button variant="outline" disabled={busy} onClick={skip}>
                  {t('ix.skip')}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || !hasAnswer(draft, question)}
                  onClick={() => void advance()}
                >
                  {busy ? t('ix.submitting') : isLast ? t('ix.submit') : t('ix.next')}
                  {isLast ? null : <IconChevronRightOutline14 />}
                </Button>
              </div>
            </footer>
            {error === null ? null : <div className="magica-ix-feedback" role="status">{error}</div>}
          </>
        )}
      </section>
    </div>
  )
}

interface ApprovalFlowProps {
  view: PendingInteractionRecord
  t: InteractionTranslate
  actions: InteractionActions
  onAnswered?: () => void
}

function ApprovalFlow({ view, t, actions, onAnswered }: ApprovalFlowProps): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toolName = view.kind === 'approval' ? view.toolName : ''
  const reason = view.kind === 'approval' ? view.reason : undefined
  const displayReason = view.kind === 'approval' ? view.displayReason : undefined
  const args = view.kind === 'approval' ? view.args : undefined

  const command = useMemo(() => {
    if (args === undefined) return ''
    try {
      const parsed = JSON.parse(args) as unknown
      return JSON.stringify(parsed, null, 2)
    } catch {
      // 截断后不再是合法 JSON：原样展示
      return args
    }
  }, [args])

  async function settle(decision: 'allowed-once' | 'rejected'): Promise<void> {
    setBusy(true)
    const result = await actions.answerApproval(view, decision)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    onAnswered?.()
  }

  // 按当前界面语言取（a.md:788）：英文界面不该显示中文标题
  const heading = pickDisplayText(displayReason, currentLang(), reason ?? toolName)

  return (
    <div className="magica-ix-apprroot">
      <section className="magica-ix-appr">
        <div className="magica-ix-strip">
          <span className="magica-ix-dot" />
          <span>{t('ix.approval.waiting')}</span>
          {args !== undefined && args.includes('sandbox_permissions') ? (
            <span>{t('ix.approval.escalation')}</span>
          ) : null}
        </div>
        <div className="magica-ix-apprbody" aria-label={t('ix.approval.detailAria')}>
          <h3 className="magica-ix-headline">{heading}</h3>
          {command === '' ? null : <pre className="magica-ix-command">{command}</pre>}
        </div>
        <div className="magica-ix-appractions">
          <Button variant="outline" className="magica-ix-reject" disabled={busy} onClick={() => void settle('rejected')}>
            {t('ix.approval.reject')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void settle('allowed-once')}>
            {t('ix.approval.allow')}
          </Button>
        </div>
        {error === null ? null : <div className="magica-ix-feedback" role="status">{error}</div>}
      </section>
    </div>
  )
}

/** 一条待决交互的卡片。 */
export function InteractionCard({ view, t, actions, onAnswered }: InteractionCardProps): React.ReactElement {
  if (view.kind === 'approval') {
    return <ApprovalFlow view={view} t={t} actions={actions} onAnswered={onAnswered} />
  }
  return (
    <QuestionFlow view={view} questions={view.questions} t={t} actions={actions} onAnswered={onAnswered} />
  )
}
