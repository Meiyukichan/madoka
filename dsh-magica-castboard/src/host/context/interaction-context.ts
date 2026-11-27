/**
 * Shared XML renderer for interaction control events.
 *
 * Both the live comment context and the task context call this, so an executor's first
 * turn and a later injected comment see the same structured `<interaction>` block
 * instead of raw JSON.
 *
 * @module dsh-magica-castboard/host/context/interaction-context
 */
import {
  decodeInteraction,
  type InteractionApprovalAnswer,
  type InteractionApprovalRequest,
  type InteractionEvent,
  type InteractionQuestion,
  type InteractionQuestionAnswer,
} from '../../shared/interaction-protocol.ts'
import { escapeXml, escapeXmlAttr } from './xml-escape.ts'

export type InteractionReplySide = 'assigner' | 'assignee'

/**
 * Decode one comment for XML rendering.
 *
 * - valid event for this anchor -> `<interaction>` lines;
 * - unsupported / wrong anchor -> a short warning, never raw JSON;
 * - malformed / ordinary JSON -> `undefined`, so the caller keeps the normal
 *   `<comment>` path (the user's "parse failure = default text" rule).
 */
export function interactionLinesForComment(
  comment: { readonly authorType: string; readonly body: string; readonly role?: string | null },
  anchorId: string,
  side: InteractionReplySide,
  indent = '',
): string[] | undefined {
  if (comment.authorType !== 'system') return undefined
  const decoded = decodeInteraction(comment.body)
  if (!decoded.ok) {
    if (decoded.reason === 'unsupported') {
      return [`${indent}<interaction status="unsupported">Unsupported interaction event.</interaction>`]
    }
    return undefined
  }
  if (decoded.event.issueId !== anchorId) {
    return [`${indent}<interaction status="invalid">Interaction belongs to another issue.</interaction>`]
  }
  const expectedRole = decoded.event.event === 'answered' ? 'assigner' : 'assignee'
  if (comment.role !== expectedRole) {
    return [`${indent}<interaction status="invalid">Interaction has the wrong author role.</interaction>`]
  }
  return renderInteractionLines(decoded.event, side, indent)
}

/**
 * Render one interaction event.
 *
 * @param event - Decoded event.
 * @param side - Which side will read this XML (`assigner` gets the answer instruction).
 * @param indent - Prefix for every line (caller owns nesting).
 */
export function renderInteractionLines(
  event: InteractionEvent,
  side: InteractionReplySide,
  indent = '',
): string[] {
  const line = (text: string): string => `${indent}${text}`
  const status = event.event === 'requested' ? 'pending' : event.event
  const attrs = [
    `id="${escapeXmlAttr(event.interactionId)}"`,
    `kind="${event.kind}"`,
    `status="${status}"`,
    `at="${new Date(event.at).toISOString()}"`,
    ...(event.event === 'requested' && event.request.truncated === true ? ['truncated="true"'] : []),
  ].join(' ')
  const lines: string[] = [line(`<interaction ${attrs}>`)]

  if (event.event === 'requested') {
    if (event.kind === 'question') {
      renderQuestionRequest(event.request.questions, line, lines)
    } else {
      renderApprovalRequest(event.request, line, lines)
    }
    lines.push(line(`  <reply>${escapeXml(replyForRequest(event, side))}</reply>`))
  } else if (event.event === 'answered') {
    lines.push(line(`  <summary>${escapeXml(summaryForAnswer(event))}</summary>`))
    if (event.kind === 'question') {
      renderQuestionAnswer(event.answer, line, lines)
    } else {
      renderApprovalAnswer(event.answer, line, lines)
    }
    lines.push(line('  <reply>This interaction is already answered; do not answer it again.</reply>'))
  } else {
    lines.push(line(`  <summary>This interaction is closed (${event.outcome}). Do not answer it again.</summary>`))
  }

  lines.push(line('</interaction>'))
  return lines
}

function renderQuestionRequest(
  questions: readonly InteractionQuestion[],
  line: (text: string) => string,
  lines: string[],
): void {
  const summary = questions.length === 1
    ? summaryOfQuestion(questions[0]!)
    : `${questions.length} questions`
  lines.push(line(`  <summary>${escapeXml(summary)}</summary>`))
  lines.push(line('  <questions>'))
  for (const question of questions) {
    lines.push(line(`    <question id="${escapeXmlAttr(question.id)}">`))
    if (question.header !== undefined) lines.push(line(`      <header>${escapeXml(question.header)}</header>`))
    lines.push(line(`      <text>${escapeXml(question.question)}</text>`))
    if (question.detail !== undefined) lines.push(line(`      <detail>${escapeXml(question.detail)}</detail>`))
    if (question.options !== undefined && question.options.length > 0) {
      lines.push(line(`      <options${question.multiSelect === true ? ' multi_select="true"' : ''}>`))
      for (const option of question.options) {
        const attrs = `label="${escapeXmlAttr(option.label)}"`
        lines.push(option.description === undefined
          ? line(`        <option ${attrs} />`)
          : line(`        <option ${attrs}>${escapeXml(option.description)}</option>`))
      }
      lines.push(line('      </options>'))
    }
    lines.push(line('    </question>'))
  }
  lines.push(line('  </questions>'))
}

function renderApprovalRequest(
  request: InteractionApprovalRequest,
  line: (text: string) => string,
  lines: string[],
): void {
  const summary = request.reason === undefined
    ? request.toolName
    : `${request.toolName}: ${request.reason}`
  lines.push(line(`  <summary>${escapeXml(summary)}</summary>`))
  const attrs = [
    `tool="${escapeXmlAttr(request.toolName)}"`,
    ...(request.callId === undefined ? [] : [`call_id="${escapeXmlAttr(request.callId)}"`]),
    ...(request.argsTruncated === true ? ['args_truncated="true"'] : []),
  ].join(' ')
  lines.push(line(`  <approval ${attrs}>`))
  if (request.reason !== undefined) lines.push(line(`    <reason>${escapeXml(request.reason)}</reason>`))
  if (request.argsPreview !== undefined) {
    lines.push(line(`    <args_preview>${escapeXml(request.argsPreview)}</args_preview>`))
  }
  lines.push(line('  </approval>'))
}

function renderQuestionAnswer(
  answer: InteractionQuestionAnswer,
  line: (text: string) => string,
  lines: string[],
): void {
  lines.push(line('  <answer>'))
  for (const item of answer.answers) {
    const selected = item.selected ?? []
    if (selected.length === 0 && item.custom === undefined) {
      lines.push(line(`    <question id="${escapeXmlAttr(item.questionId)}" />`))
      continue
    }
    lines.push(line(`    <question id="${escapeXmlAttr(item.questionId)}">`))
    if (selected.length > 0) {
      lines.push(line('      <selected>'))
      for (const label of selected) lines.push(line(`        <label>${escapeXml(label)}</label>`))
      lines.push(line('      </selected>'))
    }
    if (item.custom !== undefined) lines.push(line(`      <custom>${escapeXml(item.custom)}</custom>`))
    lines.push(line('    </question>'))
  }
  lines.push(line('  </answer>'))
}

function renderApprovalAnswer(
  answer: InteractionApprovalAnswer,
  line: (text: string) => string,
  lines: string[],
): void {
  const attrs = `decision="${escapeXmlAttr(answer.decision)}"`
  if (answer.note === undefined) {
    lines.push(line(`  <answer ${attrs} />`))
    return
  }
  lines.push(line(`  <answer ${attrs}>`))
  lines.push(line(`    <note>${escapeXml(answer.note)}</note>`))
  lines.push(line('  </answer>'))
}

function summaryOfQuestion(question: InteractionQuestion): string {
  return question.header === undefined
    ? question.question
    : `${question.header}: ${question.question}`
}

function summaryForAnswer(event: Extract<InteractionEvent, { event: 'answered' }>): string {
  if (event.kind === 'approval') return `Decision: ${event.answer.decision}`
  const first = event.answer.answers[0]
  if (first === undefined) return 'Answered'
  const selected = first.selected ?? []
  const text = selected.length > 0 ? selected.join(', ') : first.custom
  return text === undefined || text === '' ? 'Answered' : `Answered: ${text}`
}

function replyForRequest(
  event: Extract<InteractionEvent, { event: 'requested' }>,
  side: InteractionReplySide,
): string {
  const head = `castboard_issue capability="answer_interaction" issueId="${event.issueId}" interactionId="${event.interactionId}"`
  if (side === 'assignee') {
    return 'Waiting for the dispatcher to answer; do not answer this interaction yourself.'
  }
  if (event.kind === 'approval') {
    return `Use ${head} decision="allowed-once" or "rejected" to answer.`
  }
  return `Use ${head} answers="[{questionId, selected, custom}]" to answer.`
}
