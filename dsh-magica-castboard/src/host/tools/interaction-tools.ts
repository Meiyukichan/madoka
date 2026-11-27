/**
 * `castboard_issue interactions` / `answer_interaction`.
 *
 * The dispatcher does not own the pending interaction: its view comes from the issue
 * comment projection. Answering writes an `answered` control comment; the source host's
 * bridge applies it. When the source host is this process, the tool also takes the local
 * fast path through `InteractionService.answerRemote`.
 *
 * @module dsh-magica-castboard/host/tools/interaction-tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { eventLog } from '../shared/event-log.ts'
import { HttpFailure } from '../http/router.ts'
import type { InteractionProjection } from '../exec/interaction-projection.ts'
import type { InteractionService } from '../exec/interactions.ts'
import type { LinkStore } from '../ledger/link-store.ts'
import type { TaskStore } from '../ledger/task-store.ts'
import type { ThreadService } from '../pipeline/thread.ts'
import { interactionCommentId } from '../exec/interaction-id.ts'
import { sideOf } from './issue-comment.ts'
import { sessionIdOf } from './shared.ts'
import { JSON_OUT, json } from './task-tools.ts'
import {
  INTERACTION_LIMITS,
  INTERACTION_SCHEMA,
  encodeInteraction,
  type AnsweredApprovalEvent,
  type AnsweredQuestionEvent,
  type InteractionApprovalAnswer,
  type InteractionQuestion,
  type InteractionQuestionAnswerItem,
  type InteractionQuestionRequest,
} from '../../shared/interaction-protocol.ts'

export interface InteractionToolDeps {
  readonly projection: Pick<InteractionProjection, 'of' | 'invalidate'>
  readonly thread: Pick<ThreadService, 'addControl'>
  readonly interactions: Pick<InteractionService, 'list' | 'answerRemote'>
  readonly links: Pick<LinkStore, 'get'>
  readonly tasks: Pick<TaskStore, 'get'>
  /** Cross-machine answers are comments; absent = enabled. */
  readonly enabled?: () => boolean
  readonly now: () => number
}

interface AnswerInput {
  readonly issueId: string
  readonly interactionId: string
  readonly decision?: unknown
  readonly answers?: unknown
  readonly note?: unknown
}

export function interactionTools(deps: InteractionToolDeps): Array<ReturnType<typeof defineTool>> {
  return [
    defineTool({
      name: 'castboard_interactions_list',
      description:
        '列出一条 issue 的交互（approval / question）。'
        + '返回 requested、answered、completed 的结构化视图；默认只列未关闭的，includeClosed=true 时带历史。'
        + '跨机交互来自 issue 评论 projection，不要求本机有 pending。',
      parameters: {
        issueId: { type: 'string', required: true, description: 'issue 的 UUID。' },
        includeClosed: { type: 'boolean', description: '是否包含 completed（默认 false）。' },
        limit: { type: 'number', description: '最多返回多少条最近记录（默认 20，最大 100）。' },
      },
      output: { schema: JSON_OUT, render: fullJson },
      async execute(args) {
        const issueId = stringArg(args.issueId, 'issueId')
        const includeClosed = args.includeClosed === true
        const limit = Math.max(1, Math.min(100, Math.round(numberArg(args.limit, 20))))
        const views = await deps.projection.of(issueId)
        const filtered = views
          .filter(view => includeClosed || view.status !== 'completed')
          .slice(-limit)
        return json({
          issueId,
          interactions: filtered.map(view => ({
            interactionId: view.interactionId,
            kind: view.kind,
            status: view.status,
            sessionId: view.sessionId,
            ...(view.request === undefined ? {} : { request: view.request }),
            ...(view.answer === undefined ? {} : { answer: view.answer }),
            ...(view.outcome === undefined ? {} : { outcome: view.outcome }),
            ...(view.requestedAt === undefined ? {} : { requestedAt: view.requestedAt }),
            ...(view.answeredAt === undefined ? {} : { answeredAt: view.answeredAt }),
            ...(view.completedAt === undefined ? {} : { completedAt: view.completedAt }),
            ...(view.truncated === true ? { truncated: true } : {}),
          })),
        })
      },
    }),

    defineTool({
      name: 'castboard_interaction_answer',
      description:
        '回答一条 pending 的 approval / question。'
        + '工具会校验方向（只有 issue 的 assigner 会话能答）、request 形状和答案；'
        + '然后写 answered 控制评论，由 source host 的 bridge 解挂 dsh 交互。'
        + '已答/已关闭返回 stale，不要重试。',
      parameters: {
        issueId: { type: 'string', required: true, description: 'issue 的 UUID。' },
        interactionId: { type: 'string', required: true, description: '交互 id（来自 <interaction id="…">）。' },
        decision: {
          type: 'string',
          enum: ['allowed-once', 'rejected'],
          description: 'approval 的决策；question 不要传。',
        },
        answers: {
          type: 'array',
          description: 'question 的逐题答案；approval 不要传。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              questionId: { type: 'string', description: '问题 id。' },
              selected: { type: 'array', items: { type: 'string' }, description: '选中的 option label。' },
              custom: { type: 'string', description: '自由文本答案。' },
            },
          },
        },
        note: { type: 'string', description: 'approval 的可选备注。' },
      },
      output: { schema: JSON_OUT, render: fullJson },
      async execute(args, exec) {
        return answerInteraction(deps, args as unknown as AnswerInput, exec)
      },
    }),
  ]
}

async function answerInteraction(
  deps: InteractionToolDeps,
  input: AnswerInput,
  exec: unknown,
): Promise<ReturnType<typeof json>> {
  if (deps.enabled?.() === false) {
    throw new HttpFailure('conflict', '评论通道已关闭，交互应答已停用', 409)
  }
  const issueId = stringArg(input.issueId, 'issueId')
  const interactionId = stringArg(input.interactionId, 'interactionId')
  const callerSession = sessionIdOf(exec) ?? ''
  const side = sideOf({ links: deps.links, tasks: deps.tasks }, issueId, callerSession)
  if (side !== 'assigner') {
    throw new HttpFailure('forbidden', '只有 issue 的 assigner 会话能回答这条交互', 403)
  }

  const views = await deps.projection.of(issueId)
  const view = views.find(item => item.interactionId === interactionId)
  if (view === undefined || view.status !== 'pending') {
    return json({ ok: false, status: 'stale', interactionId, message: '交互不存在、已应答或已关闭' })
  }
  if (view.request === undefined) {
    return json({ ok: false, status: 'stale', interactionId, message: '交互请求尚未到达，稍后再试' })
  }

  const now = deps.now()
  const at = Number.isFinite(now) && now > 0 ? Math.round(now) : Date.now()
  const event = view.kind === 'approval'
    ? buildApprovalAnswer(view.sessionId, issueId, interactionId, input, callerSession, at)
    : buildQuestionAnswer(view.sessionId, issueId, interactionId, view.request, input, callerSession, at)

  let body: string
  try {
    body = encodeInteraction(event)
  } catch (error) {
    throw new HttpFailure('invalid_input', `答案无法编码：${errorText(error)}`, 400)
  }
  await deps.thread.addControl(issueId, {
    id: interactionCommentId(event),
    role: 'assigner',
    ...(callerSession === '' ? {} : { threadId: callerSession }),
    body,
    createdAt: event.at,
    systemKey: 'castboard.interaction.answered',
  })
  deps.projection.invalidate(issueId)

  // Same host as the source: apply immediately; the coordinator's reconcile is the safety net.
  if (deps.interactions.list().some(item => item.id === interactionId && item.sessionId === view.sessionId)) {
    try {
      await deps.interactions.answerRemote(event.kind === 'approval'
        ? {
          interactionId,
          sessionId: view.sessionId,
          kind: 'approval',
          decision: event.answer.decision,
          ...(event.answer.note === undefined ? {} : { note: event.answer.note }),
        }
        : {
          interactionId,
          sessionId: view.sessionId,
          kind: 'question',
          answers: event.answer.answers,
        })
    } catch (error) {
      // The comment is already persisted; the bridge retries.
      eventLog('warn', 'interaction-tool-local-apply-failed', `${interactionId}: ${errorText(error)}`)
    }
  }

  return json({ ok: true, status: 'accepted', interactionId })
}

function buildApprovalAnswer(
  sessionId: string,
  issueId: string,
  interactionId: string,
  input: AnswerInput,
  callerSession: string,
  at: number,
): AnsweredApprovalEvent {
  const decision = input.decision
  if (decision !== 'allowed-once' && decision !== 'rejected') {
    throw new HttpFailure('invalid_input', 'approval 必须给 decision：allowed-once 或 rejected', 400)
  }
  if (input.answers !== undefined && (!Array.isArray(input.answers) || input.answers.length > 0)) {
    throw new HttpFailure('invalid_input', 'approval 不能带 answers', 400)
  }
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (note.length > INTERACTION_LIMITS.note) {
    throw new HttpFailure('invalid_input', `note 最多 ${INTERACTION_LIMITS.note} 字符`, 400)
  }
  const answer: InteractionApprovalAnswer = {
    decision,
    ...(note === '' ? {} : { note }),
  }
  return {
    schema: INTERACTION_SCHEMA,
    event: 'answered',
    interactionId,
    issueId,
    sessionId,
    kind: 'approval',
    at,
    by: { role: 'assigner', ...(callerSession === '' ? {} : { sessionId: callerSession }) },
    answer,
  }
}

function buildQuestionAnswer(
  sessionId: string,
  issueId: string,
  interactionId: string,
  request: InteractionQuestionRequest,
  input: AnswerInput,
  callerSession: string,
  at: number,
): AnsweredQuestionEvent {
  if (input.decision !== undefined) {
    throw new HttpFailure('invalid_input', 'question 不能带 decision', 400)
  }
  const answers = parseAnswers(input.answers)
  const questions = new Map(request.questions.map(question => [question.id, question]))
  if (answers.length !== questions.size) {
    throw new HttpFailure('invalid_input', `每个问题都要回答（${questions.size} 题）`, 400)
  }
  const seen = new Set<string>()
  for (const answer of answers) {
    if (seen.has(answer.questionId)) throw new HttpFailure('invalid_input', `问题 ${answer.questionId} 重复回答`, 400)
    seen.add(answer.questionId)
    const question = questions.get(answer.questionId)
    if (question === undefined) throw new HttpFailure('invalid_input', `问题 ${answer.questionId} 不属于这条交互`, 400)
    validateQuestionAnswer(question, answer)
  }
  return {
    schema: INTERACTION_SCHEMA,
    event: 'answered',
    interactionId,
    issueId,
    sessionId,
    kind: 'question',
    at,
    by: { role: 'assigner', ...(callerSession === '' ? {} : { sessionId: callerSession }) },
    answer: { answers },
  }
}

function validateQuestionAnswer(question: InteractionQuestion, answer: InteractionQuestionAnswerItem): void {
  const selected = answer.selected ?? []
  const custom = answer.custom?.trim() ?? ''
  if (selected.length === 0 && custom === '') {
    throw new HttpFailure('invalid_input', `问题 ${question.id} 需要 selected 或 custom`, 400)
  }
  if (question.multiSelect !== true && selected.length > 1) {
    throw new HttpFailure('invalid_input', `问题 ${question.id} 是单选`, 400)
  }
  const options = new Set((question.options ?? []).map(option => option.label))
  for (const label of selected) {
    if (!options.has(label)) {
      throw new HttpFailure('invalid_input', `问题 ${question.id} 没有选项 ${label}`, 400)
    }
  }
}

function parseAnswers(raw: unknown): InteractionQuestionAnswerItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpFailure('invalid_input', 'question 必须给 answers', 400)
  }
  if (raw.length > INTERACTION_LIMITS.answers) {
    throw new HttpFailure('invalid_input', `answers 最多 ${INTERACTION_LIMITS.answers} 条`, 400)
  }
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new HttpFailure('invalid_input', `answers[${index}] 必须是对象`, 400)
    }
    const record = item as Record<string, unknown>
    const questionId = typeof record.questionId === 'string' ? record.questionId.trim() : ''
    if (questionId === '') throw new HttpFailure('invalid_input', `answers[${index}].questionId 必填`, 400)
    if (questionId.length > INTERACTION_LIMITS.id) {
      throw new HttpFailure('invalid_input', `answers[${index}].questionId 最多 ${INTERACTION_LIMITS.id} 字符`, 400)
    }
    const rawSelected = record.selected
    if (rawSelected !== undefined && !Array.isArray(rawSelected)) {
      throw new HttpFailure('invalid_input', `answers[${index}].selected 必须是字符串数组`, 400)
    }
    if (Array.isArray(rawSelected) && rawSelected.length > INTERACTION_LIMITS.selected) {
      throw new HttpFailure('invalid_input', `answers[${index}].selected 最多 ${INTERACTION_LIMITS.selected} 项`, 400)
    }
    const selected = rawSelected === undefined
      ? undefined
      : rawSelected.map((label, position) => {
        if (typeof label !== 'string' || label.trim() === '') {
          throw new HttpFailure('invalid_input', `answers[${index}].selected[${position}] 必须是非空字符串`, 400)
        }
        const text = label.trim()
        if (text.length > INTERACTION_LIMITS.optionLabel) {
          throw new HttpFailure('invalid_input', `answers[${index}].selected[${position}] 最多 ${INTERACTION_LIMITS.optionLabel} 字符`, 400)
        }
        return text
      })
    const custom = typeof record.custom === 'string' ? record.custom.trim() : ''
    if (custom.length > INTERACTION_LIMITS.custom) {
      throw new HttpFailure('invalid_input', `answers[${index}].custom 最多 ${INTERACTION_LIMITS.custom} 字符`, 400)
    }
    return {
      questionId,
      ...(selected === undefined ? {} : { selected }),
      ...(custom === '' ? {} : { custom }),
    }
  })
}

function fullJson(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function stringArg(value: unknown, name: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') throw new HttpFailure('invalid_input', `${name} 必填`, 400)
  return text
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
