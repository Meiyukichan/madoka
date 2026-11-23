/**
 * 待决交互卡片：提问流 + 审批流。
 *
 * 全受控：数据与回调都由 props 进来（`t` / `actions`），组件本身不碰 `ctx`。
 *
 * 提问卡的结构、指标位（单选序号 / 多选勾选框）、自增高输入区与底栏，
 * 逐项对齐 dsh `QuestionComposer`（`packages/client/ui-user-questions`）。
 *
 * @module dsh-magica-spellbook/client/panel/Card
 */

import { useMemo, useState } from 'react'
import { Button, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
// 图标全部来自 primitives 的真实组件（见 ./icons.tsx 头注释）
import {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconChevronUpOutlineRegular,
  IconCloseOutlineRegular,
  IconEditOutlineRegular,
} from './icons.tsx'
import { currentLang, pickDisplayText } from './display-text.ts'
import { parseRecommended } from './recommended.ts'
import type { InteractionActions } from './carrier.ts'
import type { InteractionTranslate } from './locales.ts'
import type {
  InteractionAnswerItem,
  InteractionQuestion,
  PendingInteractionRecord,
} from '../../shared/interaction.ts'

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

/**
 * 自增高答案输入（同 dsh `AnswerField`）。
 *
 * 镜像层负责行高（软换行也算），textarea 与它共用一格；镜像与 textarea 的
 * 字体、行高、内边距、换行规则必须完全一致，否则两边高度会分叉。
 */
function AnswerField({ block, value, placeholder, disabled, onChange, onKeyDown }: {
  block: boolean
  value: string
  placeholder: string
  disabled: boolean
  onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
}): React.ReactElement {
  return (
    <div className={block ? 'magica-ix-field magica-ix-fieldBlock' : 'magica-ix-field magica-ix-fieldInline'}>
      <div aria-hidden className="magica-ix-fieldMirror">{`${value}\n`}</div>
      <textarea
        className="magica-ix-fieldInput"
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

interface QuestionFlowProps {
  view: PendingInteractionRecord
  questions: InteractionQuestion[]
  t: InteractionTranslate
  actions: InteractionActions
  onAnswered?: () => void
}

function QuestionFlow({ view, questions, t, actions, onAnswered, takeover = true }: QuestionFlowProps & { takeover?: boolean }): React.ReactElement {
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => emptyDraft()))
  // 三态 busy（D4）：只有 answer 态显示「提交中…」，cancel 态不该这么写
  const [busy, setBusy] = useState<'answer' | 'cancel' | null>(null)
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
    // 单选选定后自动进下一题（diff D1，旧实现 `Card.tsx:192` 同款）：末题不动，
    // 多选不自动翻页（用户还在勾）。想回头改可以用「上一题」。
    if (!isLast) setIndex((at) => Math.min(total - 1, at + 1))
  }

  function skip(): void {
    // 末题跳过要提交**整组**草稿（D3）：早前只提交当前一题，多题时前面
    // 已答的草稿会被丢弃——那是退步，不是设计。
    patch({ skipped: true, selected: [], custom: '' })
    if (!isLast) {
      setIndex((at) => Math.min(total - 1, at + 1))
      return
    }
    const next = drafts.map((item, at) =>
      at === index ? { ...item, skipped: true, selected: [], custom: '' } : item,
    )
    void submit(questions.map((item, at) => toAnswer(item, next[at] ?? emptyDraft())))
  }

  async function advance(): Promise<void> {
    if (question === undefined) return
    // 末题提交做**整组**校验并跳到第一条缺答题（D2，`ix.error.incomplete` 不再是死键）
    if (isLast) {
      const missing = questions.findIndex((item, at) => !hasAnswer(drafts[at] ?? emptyDraft(), item))
      if (missing >= 0) {
        setIndex(missing)
        setError(t('ix.error.incomplete'))
        return
      }
      await submit(questions.map((item, at) => toAnswer(item, drafts[at] ?? emptyDraft())))
      return
    }
    if (!hasAnswer(draft, question)) {
      setError(t('ix.error.unanswered'))
      return
    }
    setIndex((at) => Math.min(total - 1, at + 1))
  }

  async function submit(answers: InteractionAnswerItem[]): Promise<void> {
    setBusy('answer')
    try {
      const result = await actions.answerQuestion(view, answers)
      if (!result.ok) {
        setError(result.error)
        return
      }
      onAnswered?.()
    } catch (error) {
      // actions reject（网络/装配异常）绝不能变成未处理 rejection + busy 永卡（D4）
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  async function cancel(): Promise<void> {
    setBusy('cancel')
    try {
      const result = await actions.cancelQuestion(view)
      if (!result.ok) {
        setError(result.error)
        return
      }
      onAnswered?.()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  if (question === undefined) return <div className="magica-ix-frame" />

  // 引用必须稳定：dsh 的 `MarkdownText` 按**引用**判断 labels 是否变化，
  // 每次渲染新建对象会让它每次按键都重新解析整段 markdown（A-264）
  const labels = useMemo(
    () => ({ code: { copyLabel: t('ix.copy'), copiedLabel: t('ix.copied') }, footnotes: t('ix.footnotes') }),
    [t],
  )

  const hasOptions = (question.options ?? []).length > 0
  const planReview = question.intent?.kind === 'plan-review'
  const showEyebrow = (question.header !== undefined && question.header !== '') || planReview
  const card = (
      <section className="magica-ix-card">
        <header className="magica-ix-header">
          <div className="magica-ix-headingBlock">
            {showEyebrow ? (
              <div className="magica-ix-eyebrow">
                {question.header === undefined || question.header === '' ? null : question.header}
                {/* 0.2 新增：计划评审走同一张卡，但语义是"批准/拒绝整份计划" */}
                {planReview ? <span className="magica-ix-badge">{t('ix.planReview')}</span> : null}
              </div>
            ) : null}
            <h3 className="magica-ix-title">{question.question}</h3>
          </div>
          <div className="magica-ix-headerActions">
            {/* 收起按钮只在 takeover 形态有意义（D5）：plain 卡由宿主控制显隐 */}
            {takeover ? (
              <button
                type="button"
                className="magica-ix-icon"
                aria-label={minimized ? t('ix.expand') : t('ix.minimize')}
                title={minimized ? t('ix.expand') : t('ix.minimize')}
                onClick={() => setMinimized((value) => !value)}
              >
                {minimized ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}
              </button>
            ) : null}
            <button
              type="button"
              className="magica-ix-icon"
              aria-label={t('ix.cancel')}
              title={t('ix.cancel')}
              disabled={busy !== null}
              onClick={() => void cancel()}
            >
              <IconCloseOutlineRegular />
            </button>
          </div>
        </header>

        {minimized ? null : (
          <>
            <div className="magica-ix-body">
              {question.detail === undefined ? null : (
                <div className="magica-ix-detail">
                  <MarkdownText text={question.detail} labels={labels} />
                </div>
              )}
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
                        on && question.multiSelect !== true ? 'magica-ix-optionSelected' : '',
                      ].filter(Boolean).join(' ')}
                      disabled={busy !== null}
                      onClick={() => toggle(option.label)}
                    >
                      {question.multiSelect === true ? (
                        <span
                          className={on ? 'magica-ix-checkbox magica-ix-checkboxChecked' : 'magica-ix-checkbox'}
                          aria-hidden="true"
                        >
                          {on ? <IconCheckOutlineRegular size={12} /> : null}
                        </span>
                      ) : <span className="magica-ix-number">{at + 1}</span>}
                      <span className="magica-ix-optionCopy">
                        <span className="magica-ix-optionLine">
                          <span className="magica-ix-optionLabel">{parsed.clean}</span>
                          {recommended ? <span className="magica-ix-badge">{t('ix.recommended')}</span> : null}
                          {option.description === undefined ? null : (
                            <span className="magica-ix-description">{option.description}</span>
                          )}
                        </span>
                      </span>
                    </button>
                  )
                })}
                {hasOptions ? (
                  <div
                    className={[
                      'magica-ix-customrow',
                      draft.custom !== '' ? 'magica-ix-customrow-active' : '',
                      question.multiSelect !== true && draft.selected.length > 0 ? 'magica-ix-customrow-yielded' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    {question.multiSelect === true ? (
                      <span
                        className={draft.custom !== '' ? 'magica-ix-checkbox magica-ix-checkboxChecked' : 'magica-ix-checkbox'}
                        aria-hidden="true"
                      >
                        {draft.custom === '' ? null : <IconCheckOutlineRegular size={12} />}
                      </span>
                    ) : (
                      <span className="magica-ix-number" aria-hidden="true">
                        <IconEditOutlineRegular size={12} />
                      </span>
                    )}
                    <AnswerField
                      block={false}
                      value={draft.custom}
                      placeholder={t('ix.custom')}
                      disabled={busy !== null}
                      onChange={(event) => {
                        patch({ custom: event.target.value, skipped: false })
                        if (question.multiSelect !== true) patch({ selected: [] })
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' || event.shiftKey) return
                        if (event.nativeEvent.isComposing || event.keyCode === 229) return
                        event.preventDefault()
                        void advance()
                      }}
                    />
                  </div>
                ) : (
                  <AnswerField
                    block
                    value={draft.custom}
                    placeholder={t('ix.custom')}
                    disabled={busy !== null}
                    onChange={(event) => {
                      patch({ custom: event.target.value, skipped: false })
                      if (question.multiSelect !== true) patch({ selected: [] })
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' || event.shiftKey) return
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return
                      event.preventDefault()
                      void advance()
                    }}
                  />
                )}
              </div>
            </div>

            <footer className="magica-ix-footer">
              <div className="magica-ix-pager">
                <button
                  type="button"
                  className="magica-ix-icon"
                  aria-label={t('ix.prev')}
                  disabled={index === 0 || busy !== null}
                  onClick={() => setIndex((at) => Math.max(0, at - 1))}
                >
                  <IconChevronLeftOutlineRegular />
                </button>
                <span className="magica-ix-progress">
                  {t('ix.progress', { current: String(index + 1), total: String(total) })}
                </span>
                <button
                  type="button"
                  className="magica-ix-icon"
                  aria-label={t('ix.next')}
                  disabled={isLast || busy !== null}
                  onClick={() => setIndex((at) => Math.min(total - 1, at + 1))}
                >
                  <IconChevronRightOutlineRegular />
                </button>
              </div>
              <div className="magica-ix-feedback" role="status">{error === null ? null : error}</div>
              <div className="magica-ix-footerActions">
                <Button variant="outline" disabled={busy !== null} onClick={skip}>
                  {t('ix.skip')}
                </Button>
                <Button
                  variant="primary"
                  // 末题（提交）**不能**因为"当前题没答"就禁用：整组校验要能点下去，
                  // 才会跳到缺答的那题并提示（D2）；中间题仍然要求先答完才放行。
                  disabled={busy !== null || (!isLast && !hasAnswer(draft, question))}
                  onClick={() => void advance()}
                >
                  {busy === 'answer' ? t('ix.submitting') : isLast ? t('ix.submit') : t('ix.next')}
                </Button>
              </div>
            </footer>
          </>
        )}
      </section>
  )
  // `plain`：只出裸卡，浮层外壳交给宿主（D5；官方卡片就是这样嵌在 composer 里）
  return takeover ? <div className="magica-ix-frame">{card}</div> : card
}

interface ApprovalFlowProps {
  view: PendingInteractionRecord
  t: InteractionTranslate
  actions: InteractionActions
  onAnswered?: () => void
}

function ApprovalFlow({ view, t, actions, onAnswered, takeover = true }: ApprovalFlowProps & { takeover?: boolean }): React.ReactElement {
  // 三态 busy（D4）：只有 answer 态显示「提交中…」，cancel 态不该这么写
  const [busy, setBusy] = useState<'answer' | 'cancel' | null>(null)
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
    // 与提问流同一套兜底（D4）：reject 既不能变成未处理 rejection，也不能把 busy 卡死
    setBusy('answer')
    try {
      const result = await actions.answerApproval(view, decision)
      if (!result.ok) {
        setError(result.error)
        return
      }
      onAnswered?.()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  // 按当前界面语言取（a.md:788）：英文界面不该显示中文标题
  const heading = pickDisplayText(displayReason, currentLang(), reason ?? toolName)

  const card = (
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
          <Button variant="outline" className="magica-ix-reject" disabled={busy !== null} onClick={() => void settle('rejected')}>
            {t('ix.approval.reject')}
          </Button>
          <Button variant="primary" disabled={busy !== null} onClick={() => void settle('allowed-once')}>
            {t('ix.approval.allow')}
          </Button>
        </div>
        {error === null ? null : <div className="magica-ix-feedback" role="alert">{error}</div>}
      </section>
  )
  return takeover ? <div className="magica-ix-apprroot">{card}</div> : card
}

/**
 * 一条待决交互的卡片。
 *
 *  + 'variant' + @ 是真参数（D5）： + 'takeover' + @（缺省）= 接管形态，自带浮层外壳与收起按钮；
 *  + 'plain' + @ = 裸卡，交给宿主自己套壳（官方卡片就是这样嵌在 composer 里的）。
 */
export function InteractionCard({
  view,
  t,
  actions,
  variant = 'takeover',
  onAnswered,
}: InteractionCardProps): React.ReactElement {
  const takeover = variant !== 'plain'
  if (view.kind === 'approval') {
    return <ApprovalFlow view={view} t={t} actions={actions} onAnswered={onAnswered} takeover={takeover} />
  }
  return (
    <QuestionFlow
      view={view}
      questions={view.questions}
      t={t}
      actions={actions}
      onAnswered={onAnswered}
      takeover={takeover}
    />
  )
}
