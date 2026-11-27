/**
 * Castboard interaction protocol v1.
 *
 * A control comment's body is a **plain JSON document**; there is no marker wrapper.
 * Discord is by the top-level `schema` field, and only `authorType === 'system'`
 * comments are interpreted at all. Ordinary comments stay ordinary text.
 *
 * This module is browser-safe: the client uses the same decoder for summaries, and
 * the host uses it for delivery/projection. It never imports `node:*`.
 *
 * @module dsh-magica-castboard/shared/interaction-protocol
 */

export const INTERACTION_SCHEMA = 'castboard.interaction/v1'
export const INTERACTION_SCHEMA_PREFIX = 'castboard.interaction/'

/** Mirrors the comment store's limit; keep the protocol inside one comment. */
export const MAX_INTERACTION_BODY = 4000

/** Field caps shared by encode and decode. */
export const INTERACTION_LIMITS = {
  body: MAX_INTERACTION_BODY,
  id: 200,
  instance: 200,
  session: 200,
  task: 200,
  question: 1000,
  header: 100,
  detail: 500,
  optionLabel: 100,
  optionDescription: 200,
  reason: 1000,
  argsPreview: 1000,
  custom: 1000,
  note: 1000,
  questions: 20,
  options: 20,
  answers: 20,
  selected: 20,
} as const

export type InteractionKind = 'approval' | 'question'
export type InteractionEventType = 'requested' | 'answered' | 'completed'
export type InteractionOutcome = 'answered' | 'cancelled' | 'expired' | 'reporting_disabled' | 'unknown'
export type InteractionActorRole = 'assigner' | 'assignee'
export type InteractionDecision = 'allowed-once' | 'rejected'

const KINDS: readonly InteractionKind[] = ['approval', 'question']
const EVENT_TYPES: readonly InteractionEventType[] = ['requested', 'answered', 'completed']
const OUTCOMES: readonly InteractionOutcome[] = ['answered', 'cancelled', 'expired', 'reporting_disabled', 'unknown']
const ROLES: readonly InteractionActorRole[] = ['assigner', 'assignee']
const DECISIONS: readonly InteractionDecision[] = ['allowed-once', 'rejected']

export interface InteractionQuestionOption {
  label: string
  description?: string
}

export interface InteractionQuestion {
  id: string
  question: string
  header?: string
  detail?: string
  options?: InteractionQuestionOption[]
  multiSelect?: true
}

export interface InteractionQuestionRequest {
  questions: InteractionQuestion[]
  /** Set when the encoder had to compact the payload. */
  truncated?: true
}

export interface InteractionApprovalRequest {
  toolName: string
  reason?: string
  callId?: string
  argsPreview?: string
  argsTruncated?: true
  truncated?: true
}

export type InteractionRequest = InteractionQuestionRequest | InteractionApprovalRequest

export interface InteractionQuestionAnswerItem {
  questionId: string
  selected?: string[]
  custom?: string
}

export interface InteractionQuestionAnswer {
  answers: InteractionQuestionAnswerItem[]
}

export interface InteractionApprovalAnswer {
  decision: InteractionDecision
  note?: string
}

export type InteractionAnswer = InteractionQuestionAnswer | InteractionApprovalAnswer

export interface InteractionActor {
  role: InteractionActorRole
  sessionId?: string
}

interface InteractionBase {
  schema: typeof INTERACTION_SCHEMA
  interactionId: string
  issueId: string
  sessionId: string
  kind: InteractionKind
  at: number
}

export type RequestedQuestionEvent = InteractionBase & {
  event: 'requested'
  kind: 'question'
  instance: string
  taskId?: string
  request: InteractionQuestionRequest
}

export type RequestedApprovalEvent = InteractionBase & {
  event: 'requested'
  kind: 'approval'
  instance: string
  taskId?: string
  request: InteractionApprovalRequest
}

export type AnsweredQuestionEvent = InteractionBase & {
  event: 'answered'
  kind: 'question'
  by: InteractionActor
  answer: InteractionQuestionAnswer
}

export type AnsweredApprovalEvent = InteractionBase & {
  event: 'answered'
  kind: 'approval'
  by: InteractionActor
  answer: InteractionApprovalAnswer
}

export type CompletedInteractionEvent = InteractionBase & {
  event: 'completed'
  outcome: InteractionOutcome
}

export type InteractionEvent =
  | RequestedQuestionEvent
  | RequestedApprovalEvent
  | AnsweredQuestionEvent
  | AnsweredApprovalEvent
  | CompletedInteractionEvent

export type InteractionDecode =
  | { ok: true; event: InteractionEvent }
  | { ok: false; reason: 'not-interaction' }
  | { ok: false; reason: 'unsupported'; schema: string }
  | { ok: false; reason: 'malformed'; detail?: string }

/** A caller-facing encode error (bad shape or genuinely too large). */
export class InteractionProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InteractionProtocolError'
  }
}

/** Internal sentinel: always caught by `decodeInteraction`, never escapes it. */
class Malformed extends Error {}

function malformed(message: string): never {
  throw new Malformed(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    return malformed(`expected one of ${allowed.join(', ')}`)
  }
  return value as T
}

function requiredString(record: Record<string, unknown>, key: string, max: number): string {
  const value = record[key]
  if (typeof value !== 'string') return malformed(`${key} must be a string`)
  const text = value.trim()
  if (text === '') return malformed(`${key} must not be empty`)
  if (text.length > max) return malformed(`${key} is too long`)
  return text
}

function optionalString(record: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') return malformed(`${key} must be a string`)
  const text = value.trim()
  if (text === '') return undefined
  if (text.length > max) return malformed(`${key} is too long`)
  return text
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return malformed(`${key} must be a positive number`)
  }
  return value
}

function optionalTrue(record: Record<string, unknown>, key: string): true | undefined {
  const value = record[key]
  if (value === undefined || value === false) return undefined
  if (value !== true) return malformed(`${key} must be true`)
  return true
}

function optionalMultiSelect(record: Record<string, unknown>): true | undefined {
  const value = record.multiSelect
  if (value === undefined || value === false) return undefined
  if (value !== true) return malformed('multiSelect must be true')
  return true
}

function arrayOf(value: unknown, key: string): unknown[] {
  if (!Array.isArray(value)) return malformed(`${key} must be an array`)
  return value
}

function parseQuestionOption(value: unknown, index: number): InteractionQuestionOption {
  if (!isRecord(value)) return malformed(`options[${index}] must be an object`)
  const label = requiredString(value, 'label', INTERACTION_LIMITS.optionLabel)
  const description = optionalString(value, 'description', INTERACTION_LIMITS.optionDescription)
  return { label, ...(description === undefined ? {} : { description }) }
}

function parseQuestion(value: unknown, index: number): InteractionQuestion {
  if (!isRecord(value)) return malformed(`questions[${index}] must be an object`)
  const id = requiredString(value, 'id', INTERACTION_LIMITS.id)
  const question = requiredString(value, 'question', INTERACTION_LIMITS.question)
  const header = optionalString(value, 'header', INTERACTION_LIMITS.header)
  const detail = optionalString(value, 'detail', INTERACTION_LIMITS.detail)
  const multiSelect = optionalMultiSelect(value)
  const rawOptions = value.options
  let options: InteractionQuestionOption[] | undefined
  if (rawOptions !== undefined) {
    const list = arrayOf(rawOptions, 'options')
    if (list.length > INTERACTION_LIMITS.options) return malformed('too many options')
    options = list.map(parseQuestionOption)
  }
  return {
    id,
    question,
    ...(header === undefined ? {} : { header }),
    ...(detail === undefined ? {} : { detail }),
    ...(options === undefined ? {} : { options }),
    ...(multiSelect === undefined ? {} : { multiSelect }),
  }
}

function parseQuestionRequest(value: unknown): InteractionQuestionRequest {
  if (!isRecord(value)) return malformed('request must be an object')
  const list = arrayOf(value.questions, 'request.questions')
  if (list.length === 0) return malformed('request.questions must not be empty')
  if (list.length > INTERACTION_LIMITS.questions) return malformed('too many questions')
  return {
    questions: list.map(parseQuestion),
    ...(optionalTrue(value, 'truncated') === undefined ? {} : { truncated: true }),
  }
}

function parseApprovalRequest(value: unknown): InteractionApprovalRequest {
  if (!isRecord(value)) return malformed('request must be an object')
  const toolName = requiredString(value, 'toolName', INTERACTION_LIMITS.id)
  const reason = optionalString(value, 'reason', INTERACTION_LIMITS.reason)
  const callId = optionalString(value, 'callId', INTERACTION_LIMITS.id)
  const argsPreview = optionalString(value, 'argsPreview', INTERACTION_LIMITS.argsPreview)
  return {
    toolName,
    ...(reason === undefined ? {} : { reason }),
    ...(callId === undefined ? {} : { callId }),
    ...(argsPreview === undefined ? {} : { argsPreview }),
    ...(optionalTrue(value, 'argsTruncated') === undefined ? {} : { argsTruncated: true }),
    ...(optionalTrue(value, 'truncated') === undefined ? {} : { truncated: true }),
  }
}

function parseQuestionAnswerItem(value: unknown, index: number): InteractionQuestionAnswerItem {
  if (!isRecord(value)) return malformed(`answers[${index}] must be an object`)
  const questionId = requiredString(value, 'questionId', INTERACTION_LIMITS.id)
  const custom = optionalString(value, 'custom', INTERACTION_LIMITS.custom)
  let selected: string[] | undefined
  if (value.selected !== undefined) {
    const list = arrayOf(value.selected, 'answers[].selected')
    if (list.length > INTERACTION_LIMITS.selected) return malformed('too many selected labels')
    selected = list.map((item, position) => {
      if (typeof item !== 'string' || item.trim() === '' || item.length > INTERACTION_LIMITS.optionLabel) {
        return malformed(`answers[${index}].selected[${position}] is invalid`)
      }
      return item.trim()
    })
  }
  return {
    questionId,
    ...(selected === undefined ? {} : { selected }),
    ...(custom === undefined ? {} : { custom }),
  }
}

function parseQuestionAnswer(value: unknown): InteractionQuestionAnswer {
  if (!isRecord(value)) return malformed('answer must be an object')
  const list = arrayOf(value.answers, 'answer.answers')
  if (list.length === 0) return malformed('answer.answers must not be empty')
  if (list.length > INTERACTION_LIMITS.answers) return malformed('too many answers')
  return { answers: list.map(parseQuestionAnswerItem) }
}

function parseApprovalAnswer(value: unknown): InteractionApprovalAnswer {
  if (!isRecord(value)) return malformed('answer must be an object')
  const decision = oneOf(value.decision, DECISIONS)
  const note = optionalString(value, 'note', INTERACTION_LIMITS.note)
  return { decision, ...(note === undefined ? {} : { note }) }
}

function parseActor(value: unknown): InteractionActor {
  if (!isRecord(value)) return malformed('by must be an object')
  const role = oneOf(value.role, ROLES)
  const sessionId = optionalString(value, 'sessionId', INTERACTION_LIMITS.session)
  return { role, ...(sessionId === undefined ? {} : { sessionId }) }
}

function parseCommon(record: Record<string, unknown>): {
  interactionId: string
  issueId: string
  sessionId: string
  kind: InteractionKind
  event: InteractionEventType
  at: number
} {
  return {
    interactionId: requiredString(record, 'interactionId', INTERACTION_LIMITS.id),
    issueId: requiredString(record, 'issueId', INTERACTION_LIMITS.id),
    sessionId: requiredString(record, 'sessionId', INTERACTION_LIMITS.session),
    kind: oneOf(record.kind, KINDS),
    event: oneOf(record.event, EVENT_TYPES),
    at: requiredNumber(record, 'at'),
  }
}

function parseEvent(record: Record<string, unknown>): InteractionEvent {
  const common = parseCommon(record)
  const base = {
    schema: INTERACTION_SCHEMA,
    interactionId: common.interactionId,
    issueId: common.issueId,
    sessionId: common.sessionId,
    at: common.at,
  } as const
  if (common.event === 'requested') {
    const instance = requiredString(record, 'instance', INTERACTION_LIMITS.instance)
    const taskId = optionalString(record, 'taskId', INTERACTION_LIMITS.task)
    if (common.kind === 'question') {
      return {
        ...base,
        event: 'requested',
        kind: 'question',
        request: parseQuestionRequest(record.request),
        ...(taskId === undefined ? {} : { taskId }),
        instance,
      }
    }
    return {
      ...base,
      event: 'requested',
      kind: 'approval',
      request: parseApprovalRequest(record.request),
      ...(taskId === undefined ? {} : { taskId }),
      instance,
    }
  }
  if (common.event === 'answered') {
    const by = parseActor(record.by)
    if (common.kind === 'question') {
      return {
        ...base,
        event: 'answered',
        kind: 'question',
        by,
        answer: parseQuestionAnswer(record.answer),
      }
    }
    return {
      ...base,
      event: 'answered',
      kind: 'approval',
      by,
      answer: parseApprovalAnswer(record.answer),
    }
  }
  return { ...base, event: 'completed', kind: common.kind, outcome: oneOf(record.outcome, OUTCOMES) }
}

/**
 * Decode a comment body.
 *
 * Never throws: bad JSON / bad fields return `malformed`, unknown versions return
 * `unsupported`, and ordinary JSON returns `not-interaction`.
 */
export function decodeInteraction(body: string): InteractionDecode {
  const trimmed = body.trim()
  if (!trimmed.startsWith('{')) return { ok: false, reason: 'not-interaction' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: 'malformed', detail: 'invalid JSON' }
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'not-interaction' }
  const schema = parsed.schema
  if (typeof schema !== 'string' || !schema.startsWith(INTERACTION_SCHEMA_PREFIX)) {
    return { ok: false, reason: 'not-interaction' }
  }
  if (schema !== INTERACTION_SCHEMA) return { ok: false, reason: 'unsupported', schema }
  try {
    return { ok: true, event: parseEvent(parsed) }
  } catch (error) {
    return {
      ok: false,
      reason: 'malformed',
      ...(error instanceof Error && error.message !== '' ? { detail: error.message } : {}),
    }
  }
}

/** Cheap pre-filter: avoid parsing every ordinary comment. */
export function isInteractionBody(body: string): boolean {
  const trimmed = body.trimStart()
  return trimmed.startsWith('{')
    && trimmed.includes('"schema"')
    && trimmed.includes(INTERACTION_SCHEMA_PREFIX)
}

/** A control comment must be system-authored; user/agent JSON is never protocol. */
export function isInteractionComment(comment: { authorType?: string; body: string }): boolean {
  return comment.authorType === 'system' && isInteractionBody(comment.body)
}

// ─────────────────────────────────────────────────────────────────────────────
// Encoding
// ─────────────────────────────────────────────────────────────────────────────

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new InteractionProtocolError(`${label} must be a string`)
  const trimmed = value.trim()
  if (trimmed === '') throw new InteractionProtocolError(`${label} must not be empty`)
  return clip(trimmed, max)
}

/** Like `text`, but never truncates: an answer must not be silently changed. */
function strictText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new InteractionProtocolError(`${label} must be a string`)
  const trimmed = value.trim()
  if (trimmed === '') throw new InteractionProtocolError(`${label} must not be empty`)
  if (trimmed.length > max) {
    throw new InteractionProtocolError(`${label} is too long (max ${max})`)
  }
  return trimmed
}

function strictOptionalText(value: string | undefined, label: string, max: number): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > max) {
    throw new InteractionProtocolError(`${label} is too long (max ${max})`)
  }
  return trimmed
}

/** Clip one optional field and report whether it was actually shortened. */
function clippedText(value: string | undefined, max: number): { text?: string; changed: boolean } {
  if (value === undefined) return { changed: false }
  const trimmed = value.trim()
  if (trimmed === '') return { changed: false }
  const clipped = clip(trimmed, max)
  return { text: clipped, changed: clipped.length !== trimmed.length }
}

function buildQuestionOption(
  option: InteractionQuestionOption,
  level: 0 | 1 | 2,
): { option: InteractionQuestionOption; changed: boolean } {
  // The label is the answer value. Never clip it: a clipped label would not match
  // the source host's pending option and the answer would be rejected.
  const label = strictText(option.label, 'option.label', INTERACTION_LIMITS.optionLabel)
  const description = level >= 1
    ? { text: undefined, changed: option.description !== undefined }
    : clippedText(option.description, INTERACTION_LIMITS.optionDescription)
  return {
    option: {
      label,
      ...(description.text === undefined ? {} : { description: description.text }),
    },
    changed: label !== option.label || description.changed,
  }
}

function buildQuestion(
  question: InteractionQuestion,
  level: 0 | 1 | 2,
): { question: InteractionQuestion; changed: boolean } {
  const maxQuestion = level === 0 ? INTERACTION_LIMITS.question : level === 1 ? 500 : 300
  const id = strictText(question.id, 'question.id', INTERACTION_LIMITS.id)
  const body = text(question.question, 'question.question', maxQuestion)
  const header = level >= 1
    ? { text: undefined, changed: question.header !== undefined }
    : clippedText(question.header, INTERACTION_LIMITS.header)
  const detail = level >= 1
    ? { text: undefined, changed: question.detail !== undefined }
    : clippedText(question.detail, INTERACTION_LIMITS.detail)
  let options: InteractionQuestionOption[] | undefined
  let changed = id !== question.id.trim()
    || body !== question.question.trim()
    || header.changed
    || detail.changed
  if (level < 2 && question.options !== undefined && question.options.length > 0) {
    const capped = question.options.slice(0, INTERACTION_LIMITS.options)
    if (capped.length !== question.options.length) changed = true
    options = capped.map(option => {
      const built = buildQuestionOption(option, level)
      if (built.changed) changed = true
      return built.option
    })
  }
  return {
    question: {
      id,
      question: body,
      ...(header.text === undefined ? {} : { header: header.text }),
      ...(detail.text === undefined ? {} : { detail: detail.text }),
      ...(options === undefined ? {} : { options }),
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
    },
    changed,
  }
}

function buildQuestionRequest(
  request: InteractionQuestionRequest,
  level: 0 | 1 | 2,
): { request: InteractionQuestionRequest; changed: boolean } {
  if (request.questions.length === 0) {
    throw new InteractionProtocolError('request.questions must not be empty')
  }
  const capped = request.questions.slice(0, INTERACTION_LIMITS.questions)
  let changed = capped.length !== request.questions.length || request.truncated === true
  const questions = capped.map(question => {
    const built = buildQuestion(question, level)
    if (built.changed) changed = true
    return built.question
  })
  return {
    request: {
      questions,
      ...(changed || level > 0 ? { truncated: true } : {}),
    },
    changed,
  }
}

function buildApprovalRequest(
  request: InteractionApprovalRequest,
  level: 0 | 1 | 2,
): { request: InteractionApprovalRequest; changed: boolean } {
  const toolName = text(request.toolName, 'request.toolName', INTERACTION_LIMITS.id)
  const reason = clippedText(request.reason, level >= 2 ? 300 : INTERACTION_LIMITS.reason)
  const callId = clippedText(request.callId, INTERACTION_LIMITS.id)
  const args = level >= 1
    ? { text: undefined, changed: request.argsPreview !== undefined }
    : clippedText(request.argsPreview, INTERACTION_LIMITS.argsPreview)
  const argsTruncated = request.argsTruncated === true || args.changed
  const changed = toolName !== request.toolName.trim()
    || reason.changed
    || callId.changed
    || args.changed
    || request.truncated === true
  return {
    request: {
      toolName,
      ...(reason.text === undefined ? {} : { reason: reason.text }),
      ...(callId.text === undefined ? {} : { callId: callId.text }),
      ...(args.text === undefined ? {} : { argsPreview: args.text }),
      ...(argsTruncated ? { argsTruncated: true } : {}),
      ...(changed || level > 0 ? { truncated: true } : {}),
    },
    changed,
  }
}

function buildAnswer(event: InteractionEvent): InteractionAnswer {
  if (event.event !== 'answered') throw new InteractionProtocolError('not an answered event')
  if (event.kind === 'approval') {
    const note = strictOptionalText(event.answer.note, 'answer.note', INTERACTION_LIMITS.note)
    return {
      decision: event.answer.decision,
      ...(note === undefined ? {} : { note }),
    }
  }
  if (event.answer.answers.length === 0 || event.answer.answers.length > INTERACTION_LIMITS.answers) {
    throw new InteractionProtocolError(`answer.answers must contain 1..${INTERACTION_LIMITS.answers} items`)
  }
  return {
    answers: event.answer.answers.map(item => {
      const questionId = strictText(item.questionId, 'answers[].questionId', INTERACTION_LIMITS.id)
      if (item.selected !== undefined && item.selected.length > INTERACTION_LIMITS.selected) {
        throw new InteractionProtocolError(`too many selected labels for ${questionId}`)
      }
      const selected = item.selected === undefined
        ? undefined
        : item.selected.map(label => strictText(label, 'answers[].selected[]', INTERACTION_LIMITS.optionLabel))
      const custom = strictOptionalText(item.custom, 'answers[].custom', INTERACTION_LIMITS.custom)
      return {
        questionId,
        ...(selected === undefined ? {} : { selected }),
        ...(custom === undefined ? {} : { custom }),
      }
    }),
  }
}

function buildEvent(event: InteractionEvent, level: 0 | 1 | 2): Record<string, unknown> {
  if (event.schema !== INTERACTION_SCHEMA) {
    throw new InteractionProtocolError(`schema must be ${INTERACTION_SCHEMA}`)
  }
  const base: Record<string, unknown> = {
    schema: INTERACTION_SCHEMA,
    event: event.event,
    interactionId: strictText(event.interactionId, 'interactionId', INTERACTION_LIMITS.id),
    issueId: strictText(event.issueId, 'issueId', INTERACTION_LIMITS.id),
    sessionId: strictText(event.sessionId, 'sessionId', INTERACTION_LIMITS.session),
    kind: event.kind,
    at: event.at,
  }
  if (!Number.isFinite(event.at) || event.at <= 0) {
    throw new InteractionProtocolError('at must be a positive number')
  }
  if (event.event === 'requested') {
    const taskId = strictOptionalText(event.taskId, 'taskId', INTERACTION_LIMITS.task)
    if (event.kind === 'question') {
      const built = buildQuestionRequest(event.request, level)
      return {
        ...base,
        ...(taskId === undefined ? {} : { taskId }),
        instance: strictText(event.instance, 'instance', INTERACTION_LIMITS.instance),
        request: built.request,
      }
    }
    const built = buildApprovalRequest(event.request, level)
    return {
      ...base,
      ...(taskId === undefined ? {} : { taskId }),
      instance: strictText(event.instance, 'instance', INTERACTION_LIMITS.instance),
      request: built.request,
    }
  }
  if (event.event === 'answered') {
    const bySession = strictOptionalText(event.by.sessionId, 'by.sessionId', INTERACTION_LIMITS.session)
    return {
      ...base,
      by: {
        role: event.by.role,
        ...(bySession === undefined ? {} : { sessionId: bySession }),
      },
      answer: buildAnswer(event),
    }
  }
  return { ...base, outcome: event.outcome }
}

/**
 * Encode one interaction event.
 *
 * Always returns a body that fits `MAX_INTERACTION_BODY`; progressively compacts
 * request payloads (and marks `truncated`) rather than letting `ThreadService` clip
 * the JSON into something undecodable.
 */
export function encodeInteraction(event: InteractionEvent): string {
  if (event.event !== 'requested') {
    const body = JSON.stringify(buildEvent(event, 0))
    if (body.length <= MAX_INTERACTION_BODY) return body
    throw new InteractionProtocolError('interaction body exceeds the comment limit')
  }
  for (const level of [0, 1, 2] as const) {
    const body = JSON.stringify(buildEvent(event, level))
    if (body.length <= MAX_INTERACTION_BODY) return body
  }
  if (event.event === 'requested' && event.kind === 'question') {
    const questions = event.request.questions
    for (let keep = Math.min(questions.length, INTERACTION_LIMITS.questions) - 1; keep >= 1; keep -= 1) {
      const compact: InteractionEvent = {
        ...event,
        request: { ...event.request, questions: questions.slice(0, keep) },
      }
      const body = JSON.stringify(buildEvent(compact, 2))
      if (body.length <= MAX_INTERACTION_BODY) return body
    }
  }
  throw new InteractionProtocolError('interaction body exceeds the comment limit')
}

/**
 * Stable discriminator for `answered` events; `requested`/`completed` need no payload
 * because one interaction has one of each.
 */
export function canonicalInteractionAnswer(event: InteractionEvent): string {
  if (event.event !== 'answered') throw new InteractionProtocolError('not an answered event')
  if (event.kind === 'approval') {
    return ['approval', event.answer.decision, event.answer.note ?? ''].join('\u0000')
  }
  const answers = [...event.answer.answers]
    .sort((left, right) => compareText(left.questionId, right.questionId))
    .map(item => [
      item.questionId,
      [...(item.selected ?? [])].sort(compareText).join('\u0001'),
      item.custom ?? '',
    ].join('\u0000'))
  return ['question', ...answers].join('\u0002')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Small, i18n-free label used by client summaries and logs. */
export function interactionSummary(event: InteractionEvent): { title: string } {
  if (event.event === 'requested') {
    if (event.kind === 'question') {
      const first = event.request.questions[0]
      return { title: first?.header ?? first?.question ?? 'Question' }
    }
    return { title: event.request.toolName }
  }
  if (event.event === 'answered') {
    if (event.kind === 'approval') return { title: event.answer.decision }
    const first = event.answer.answers[0]
    if (first === undefined) return { title: 'answered' }
    const selected = first.selected ?? []
    const text = selected.length > 0 ? selected.join(', ') : first.custom
    return { title: text === undefined || text === '' ? 'answered' : text }
  }
  return { title: event.outcome }
}
