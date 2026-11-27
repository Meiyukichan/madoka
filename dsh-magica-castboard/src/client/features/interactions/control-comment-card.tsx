/**
 * Rich, collapsible rendering for control comments in the teamwork issue drawer.
 *
 * The protocol is owned by castboard; the teamwork package only receives the already
 * decoded node plus a semantic key. That keeps one decoder and lets local/cloud copies
 * of the same interaction collapse even when their storage ids differ.
 *
 * @module dsh-magica-castboard/client/features/interactions/control-comment-card
 */
import type { ReactNode } from 'react'

import {
  canonicalInteractionAnswer,
  decodeInteraction,
  type InteractionEvent,
  type InteractionOutcome,
  type InteractionQuestion,
} from '../../../shared/interaction-protocol.ts'
import type { Translate } from '../../labels/index.ts'

export interface InteractionCommentView {
  /** Stable across local/cloud copies of the same logical event. */
  key: string
  node: ReactNode
}

export function interactionCommentView(
  comment: { readonly authorType?: string; readonly body: string },
  t: Translate,
): InteractionCommentView | undefined {
  if (comment.authorType !== 'system') return undefined
  const decoded = decodeInteraction(comment.body)
  if (!decoded.ok) {
    if (decoded.reason !== 'unsupported') return undefined
    return {
      key: `interaction:unsupported:${comment.body}`,
      node: <div className="dsh-atw-interaction-unsupported">{t('interaction.unsupported')}</div>,
    }
  }
  return {
    key: interactionKey(decoded.event),
    node: <InteractionCommentCard event={decoded.event} t={t} />,
  }
}

function interactionKey(event: InteractionEvent): string {
  const base = `${event.event}:${event.issueId}:${event.interactionId}`
  if (event.event === 'answered') return `${base}:${canonicalInteractionAnswer(event)}`
  if (event.event === 'completed') return `${base}:${event.outcome}`
  return base
}

function summaryOf(event: InteractionEvent, t: Translate): string {
  if (event.event === 'requested') {
    if (event.kind === 'approval') return event.request.toolName
    const first = event.request.questions[0]
    const title = first?.header ?? first?.question ?? t('interaction.kind.question')
    return event.request.questions.length > 1
      ? `${title} (+${String(event.request.questions.length - 1)})`
      : title
  }
  if (event.event === 'answered') {
    if (event.kind === 'approval') return decisionLabel(event.answer.decision, t)
    const first = event.answer.answers[0]
    if (first === undefined) return t('interaction.answerTitle')
    const selected = first.selected ?? []
    if (selected.length > 0) return selected.join(', ')
    return first.custom === undefined || first.custom === '' ? t('interaction.answerTitle') : first.custom
  }
  return outcomeLabel(event.outcome, t)
}

function titleOf(event: InteractionEvent, t: Translate): string {
  if (event.event === 'requested') return t('interaction.requestTitle')
  if (event.event === 'answered') return t('interaction.answerTitle')
  return t('interaction.completeTitle')
}

function decisionLabel(decision: 'allowed-once' | 'rejected', t: Translate): string {
  return t(decision === 'allowed-once' ? 'interaction.decision.allowedOnce' : 'interaction.decision.rejected')
}

function outcomeLabel(outcome: InteractionOutcome, t: Translate): string {
  switch (outcome) {
    case 'answered': return t('interaction.outcome.answered')
    case 'cancelled': return t('interaction.outcome.cancelled')
    case 'expired': return t('interaction.outcome.expired')
    case 'reporting_disabled': return t('interaction.outcome.reportingDisabled')
    default: return t('interaction.outcome.unknown')
  }
}

function InteractionCommentCard({ event, t }: { event: InteractionEvent; t: Translate }): ReactNode {
  return (
    <details className="dsh-atw-interaction">
      <summary className="dsh-atw-interaction-summary">
        <span className="dsh-atw-interaction-kind">{titleOf(event, t)}</span>
        <span className="dsh-atw-interaction-name">{summaryOf(event, t)}</span>
        <span className="dsh-atw-interaction-id">{event.interactionId.slice(0, 8)}</span>
      </summary>
      <div className="dsh-atw-interaction-body">
        {event.event === 'requested' ? (
          event.kind === 'approval'
            ? <ApprovalRequest event={event} t={t} />
            : <QuestionRequest questions={event.request.questions} truncated={event.request.truncated === true} t={t} />
        ) : event.event === 'answered' ? (
          event.kind === 'approval'
            ? (
                <div className="dsh-atw-interaction-fields">
                  <Field label={t('interaction.decision')} value={decisionLabel(event.answer.decision, t)} />
                  {event.answer.note === undefined ? null : <Field label={t('interaction.note')} value={event.answer.note} />}
                </div>
              )
            : (
                <div className="dsh-atw-interaction-answers">
                  {event.answer.answers.map(answer => (
                    <div className="dsh-atw-interaction-answer" key={answer.questionId}>
                      <div className="dsh-atw-interaction-answer-id">{answer.questionId}</div>
                      {answer.selected === undefined || answer.selected.length === 0 ? null : (
                        <div className="dsh-atw-interaction-options">
                          {answer.selected.map(label => <span className="dsh-atw-interaction-option" key={label}>{label}</span>)}
                        </div>
                      )}
                      {answer.custom === undefined || answer.custom === '' ? null : (
                        <div className="dsh-atw-interaction-custom">{answer.custom}</div>
                      )}
                    </div>
                  ))}
                </div>
              )
        ) : (
          <div className="dsh-atw-interaction-fields">
            <Field label={t('interaction.outcome')} value={outcomeLabel(event.outcome, t)} />
            <Field label={t('interaction.id')} value={event.interactionId} />
          </div>
        )}
      </div>
    </details>
  )
}

function ApprovalRequest({
  event,
  t,
}: {
  event: Extract<InteractionEvent, { event: 'requested'; kind: 'approval' }>
  t: Translate
}): ReactNode {
  return (
    <div className="dsh-atw-interaction-fields">
      <Field label={t('interaction.tool')} value={event.request.toolName} />
      {event.request.reason === undefined ? null : <Field label={t('interaction.reason')} value={event.request.reason} />}
      {event.request.argsPreview === undefined ? null : (
        <div className="dsh-atw-interaction-field">
          <span>{t('interaction.args')}</span>
          <pre className="dsh-atw-interaction-pre">{event.request.argsPreview}</pre>
        </div>
      )}
      {event.request.argsTruncated === true ? <div className="dsh-atw-interaction-note">{t('interaction.truncated')}</div> : null}
    </div>
  )
}

function QuestionRequest({
  questions,
  truncated,
  t,
}: {
  questions: readonly InteractionQuestion[]
  truncated: boolean
  t: Translate
}): ReactNode {
  return (
    <div className="dsh-atw-interaction-questions">
      {questions.map(question => (
        <div className="dsh-atw-interaction-question" key={question.id}>
          {question.header === undefined ? null : <div className="dsh-atw-interaction-question-header">{question.header}</div>}
          <div className="dsh-atw-interaction-question-text">{question.question}</div>
          {question.detail === undefined ? null : <div className="dsh-atw-interaction-question-detail">{question.detail}</div>}
          {question.options === undefined || question.options.length === 0 ? null : (
            <div className="dsh-atw-interaction-options">
              {question.options.map(option => (
                <span className="dsh-atw-interaction-option" key={option.label} title={option.description}>
                  {option.label}
                </span>
              ))}
              {question.multiSelect === true ? <span className="dsh-atw-interaction-multi">{t('interaction.multiSelect')}</span> : null}
            </div>
          )}
        </div>
      ))}
      {truncated ? <div className="dsh-atw-interaction-note">{t('interaction.truncated')}</div> : null}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="dsh-atw-interaction-field">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  )
}
