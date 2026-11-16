/**
 * 提问接管：与审批同构，但有三处关键差异（照抄审批必踩）：
 * ① **失败一律 reject**（审批是 resolve 闭集）—— 否则 `ask_user_question` 会把空答案当正常结果；
 * ② `request.agent` 是**可选**的 —— 认不出会话只能 `next()`；
 * ③ 提问**没有**审计事件 —— 所以自己记 `question.*` 诊断日志。
 *
 * @module dsh-magica-spellbook/sessions/questions
 */

import { randomUUID } from 'node:crypto'
import { createEventLogger, type EventLogger } from '../core/logger.ts'
import { manageWaterfallListener } from './core.ts'
import { serviceOf } from '../shared/dsh.ts'
import { WATERFALL_TAKEOVER, type InteractionAnswerItem, type InteractionQuestion } from '../shared/wire.ts'
import type { DshAgentLike, DshContextLike } from '../shared/dsh.ts'

/** 待决提问。 */
export interface PendingQuestion {
  id: string
  questions: InteractionQuestion[]
  since: number
}

/** 应答结果（没有 `invalid-outcome`：答案形状原样透传给 dsh）。 */
export type QuestionAnswerResult = 'answered' | 'cancelled' | 'not-found' | 'session-gone' | 'invalid-answer'

/** 错误码（dsh `UserQuestionError` 的子集）。 */
export type QuestionErrorCode = 'ASK_ABORTED' | 'ASK_CANCELLED' | 'NO_PROVIDER'

/** 接管选项。 */
export interface QuestionAnswererOptions {
  timeoutMs?: number
}

interface PendingEntry {
  readonly id: string
  readonly questions: InteractionQuestion[]
  readonly since: number
  settleAnswer: (answer: { answers: InteractionAnswerItem[] }) => void
  settleCancel: () => void
  settleAbort: () => void
}

interface Bridge {
  readonly sessionId: string
  readonly pending: Map<string, PendingEntry>
}

const bridges = new Map<string, Bridge>()

/** 日志目录名：单段包名（事件用 `question.*` 区分，不再另开子目录）。 */
const LOG_PLUGIN = 'dsh-magica-spellbook'

let sharedLogger: EventLogger | null = null
let loggerOverride: EventLogger | null = null
let activeAnswerers = 0

/** 用宿主的 `dshHomePath` 解析日志根目录；拿不到就交给 logger 的默认策略（`$DSH_HOME`）。 */
function logRootFrom(ctx: unknown): string | undefined {
  const home = serviceOf<(...segments: string[]) => string>(ctx, 'dshHomePath')
  if (typeof home !== 'function') return undefined
  try {
    const resolved = home('logs', LOG_PLUGIN)
    return typeof resolved === 'string' && resolved !== '' ? resolved : undefined
  } catch {
    return undefined
  }
}

/** 首次安装时把日志实例钉在宿主 home 下（而不是只依赖进程环境变量）。 */
function ensureLogger(ctx: unknown): void {
  if (loggerOverride !== null || sharedLogger !== null) return
  sharedLogger = createEventLogger(LOG_PLUGIN, logRootFrom(ctx))
}

function eventLog(): EventLogger {
  if (loggerOverride !== null) return loggerOverride
  sharedLogger ??= createEventLogger(LOG_PLUGIN)
  return sharedLogger
}

function logInteraction(event: string, detail: Record<string, unknown>): void {
  try {
    eventLog().logEvent('info', event, JSON.stringify(detail))
  } catch {
    // 日志不该影响主流程
  }
}

/** 覆盖日志实例（测试 / 宿主自定义）。 */
export function setInteractionLogger(logger: EventLogger | null): void {
  loggerOverride = logger
}

/** 回收共享日志实例（引用计数归零时自动调用）。 */
export function disposeInteractionLogger(): void {
  const current = sharedLogger
  sharedLogger = null
  if (current !== null) {
    try {
      current.dispose()
    } catch {
      // 已回收
    }
  }
}

function retainLogger(): void {
  activeAnswerers += 1
}

function releaseLogger(): void {
  activeAnswerers = Math.max(0, activeAnswerers - 1)
  if (activeAnswerers === 0) disposeInteractionLogger()
}

/** 鸭式构造 dsh 的 `UserQuestionError`（不 import 运行时类，保持零运行时依赖）。 */
function questionError(message: string, code: QuestionErrorCode): Error {
  const error = new Error(message) as Error & { code: string }
  error.name = 'UserQuestionError'
  error.code = code
  return error
}

/** 请求载荷里我们关心的字段。 */
interface QuestionRequestLike {
  readonly questions?: Array<{
    id?: unknown
    question?: unknown
    detail?: unknown
    header?: unknown
    options?: Array<{ label?: unknown; description?: unknown }>
    multiSelect?: unknown
    intent?: { kind?: unknown; approve?: unknown; callId?: unknown }
  }>
  readonly agent?: DshAgentLike
  readonly signal?: AbortSignal
  readonly wait?: { callId?: unknown; timed?: unknown }
}

interface AnswerLike {
  readonly answers?: unknown
}

function normalizeQuestions(request: QuestionRequestLike): InteractionQuestion[] {
  const waitCallId = request.wait?.callId === undefined ? undefined : String(request.wait.callId)
  const waitTimed = request.wait?.timed === true ? true : undefined
  const out: InteractionQuestion[] = []
  for (const item of request.questions ?? []) {
    const id = item.id === undefined ? '' : String(item.id)
    const question = typeof item.question === 'string' ? item.question : ''
    if (id === '' || question === '') continue
    const normalized: InteractionQuestion = { id, question }
    if (typeof item.detail === 'string') normalized.detail = item.detail
    if (typeof item.header === 'string') normalized.header = item.header
    if (Array.isArray(item.options)) {
      const options = item.options
        .filter((option): option is { label: string; description?: string } => typeof option.label === 'string')
        .map((option) => {
          const entry: { label: string; description?: string } = { label: option.label }
          if (typeof option.description === 'string') entry.description = option.description
          return entry
        })
      if (options.length > 0) normalized.options = options
    }
    // 三个取值都要保留：alse 丢掉会让挂住的请求与原文不再深等（m.md:193/215）
    if (typeof item.multiSelect === 'boolean') normalized.multiSelect = item.multiSelect
    if (item.intent !== undefined && typeof item.intent.kind === 'string' && typeof item.intent.approve === 'string') {
      normalized.intent = { kind: item.intent.kind, approve: item.intent.approve }
      if (item.intent.callId !== undefined) normalized.intent.callId = String(item.intent.callId)
    }
    if (waitCallId !== undefined) normalized.waitCallId = waitCallId
    if (waitTimed === true) normalized.waitTimed = true
    out.push(normalized)
  }
  return out
}

function toPending(entry: PendingEntry): PendingQuestion {
  // 逐项浅拷：只拷数组会让元素仍与挂住的请求共享
  return {
    id: entry.id,
    questions: entry.questions.map((question) => ({ ...question })),
    since: entry.since,
  }
}

function bridgeFor(sessionId: string): Bridge {
  let bridge = bridges.get(sessionId)
  if (bridge === undefined) {
    bridge = { sessionId, pending: new Map() }
    bridges.set(sessionId, bridge)
  }
  return bridge
}

/** 安装人工接管（重复安装会先把旧 bridge 的待决项全部 `ASK_ABORTED`）。 */
export function installQuestionAnswerer(
  ctx: unknown,
  sessionId: string,
  options: QuestionAnswererOptions = {},
): () => void {
  const key = String(sessionId)
  const previous = bridges.get(key)
  if (previous !== undefined) {
    for (const entry of [...previous.pending.values()]) entry.settleAbort()
    previous.pending.clear()
  }
  const bridge = bridgeFor(key)
  let uninstalled = false
  ensureLogger(ctx)
  retainLogger()

  const hold = (request: QuestionRequestLike): Promise<{ answers: InteractionAnswerItem[] }> => {
    const questions = normalizeQuestions(request)
    const signal = request.signal
    const id = randomUUID()
    const since = Date.now()
    logInteraction('question.asked', {
      sessionId: key,
      id,
      questions: questions.map((question) => ({
        id: question.id,
        question: question.question,
        options: question.options?.map((option) => option.label),
        multiSelect: question.multiSelect,
        intent: question.intent?.kind,
      })),
    })

    if (signal?.aborted === true) {
      logInteraction('question.aborted', { sessionId: key, id, reason: 'already-aborted' })
      return Promise.reject(questionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
    }

    return new Promise<{ answers: InteractionAnswerItem[] }>((resolve, reject) => {
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const settle = (finish: () => void, event: string): void => {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        try {
          signal?.removeEventListener('abort', onAbort)
        } catch {
          // 已移除
        }
        bridge.pending.delete(id)
        logInteraction(event, { sessionId: key, id, waitedMs: Date.now() - since })
        finish()
      }

      const onAbort = (): void => {
        settle(
          () => reject(questionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')),
          'question.aborted',
        )
      }

      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(onAbort, options.timeoutMs)
        timer.unref?.()
      }
      try {
        signal?.addEventListener('abort', onAbort, { once: true })
      } catch {
        // 只能靠超时 / 注销
      }

      bridge.pending.set(id, {
        id,
        questions,
        since,
        settleAnswer: (answer) => {
          settle(() => resolve({ answers: answer.answers ?? [] }), 'question.answered')
        },
        settleCancel: () => {
          settle(
            () => reject(questionError('the user cancelled ask_user_question', 'ASK_CANCELLED')),
            'question.cancelled',
          )
        },
        settleAbort: onAbort,
      })
    })
  }

  return withLoggerRef(
    manageWaterfallListener(
      ctx,
      `magica:questions(${key})`,
      () =>
        (ctx as DshContextLike).on(
          'user-questions/request',
          (request: QuestionRequestLike, next: () => Promise<{ answers: InteractionAnswerItem[] }>) => {
            if (uninstalled) return next()
            const owner = request.agent?.session?.id
            if (owner === undefined || String(owner) !== key) return next()
            return hold(request)
          },
          WATERFALL_TAKEOVER,
        ),
      () => {
        uninstalled = true
        for (const entry of [...bridge.pending.values()]) entry.settleAbort()
        if (bridges.get(key) === bridge) bridges.delete(key)
      },
    ),
  )
}

/**
 * fail-fast 接管：恒 reject `NO_PROVIDER`。
 *
 * 为什么不能 `return next()`：`next()` 之后请求会被 remote 桥 hold 住等浏览器，
 * 根本走不到 dsh 内置的 `noAnswerer`。
 */
export function installFailFastQuestionAnswerer(ctx: unknown, sessionId: string): () => void {
  const key = String(sessionId)
  let uninstalled = false
  ensureLogger(ctx)
  retainLogger()
  return withLoggerRef(
    manageWaterfallListener(
      ctx,
      `magica:questions(${key})`,
      () =>
        (ctx as DshContextLike).on(
          'user-questions/request',
          (request: QuestionRequestLike, next: () => Promise<{ answers: InteractionAnswerItem[] }>) => {
            if (uninstalled) return next()
            const owner = request.agent?.session?.id
            if (owner === undefined || String(owner) !== key) return next()
            logInteraction('question.fail-fast', {
              sessionId: key,
              questions: (request.questions ?? []).map((item) => item.id),
            })
            return Promise.reject(
              questionError(
                'no user-questions answerer accepted the request (this session does not accept human input)',
                'NO_PROVIDER',
              ),
            )
          },
          WATERFALL_TAKEOVER,
        ),
      () => {
        uninstalled = true
      },
    ),
  )
}

function withLoggerRef(uninstall: () => void): () => void {
  let released = false
  return () => {
    if (!released) {
      released = true
      releaseLogger()
    }
    uninstall()
  }
}

/**
 * 校验答案形状，返回错误文案（`null` = 合法）。
 *
 * 为什么在库层校验（而不是只信 HTTP 层）：`answerQuestion` 是公开 API，
 * 结算会直接把对象交给挂住的工具。形状错了以后，错误会以"模型收到畸形答案"的形式
 * 出现在很久之后，极难定位；这里当场拒掉，HTTP 层再映射成 400 `invalid_input`。
 */
function validateAnswers(
  questions: readonly InteractionQuestion[],
  answer: unknown,
): string | null {
  if (typeof answer !== 'object' || answer === null) return 'answer must be an object'
  const answers = (answer as { answers?: unknown }).answers
  if (!Array.isArray(answers)) return 'answers must be an array'
  const known = new Set(questions.map((question) => question.id))
  const seen = new Set<string>()
  for (const [index, item] of answers.entries()) {
    if (typeof item !== 'object' || item === null) return `answers[${index}] must be an object`
    const candidate = item as { id?: unknown; selected?: unknown; custom?: unknown }
    if (typeof candidate.id !== 'string' || candidate.id === '') {
      return `answers[${index}].id must be a non-empty string`
    }
    if (!known.has(candidate.id)) return `answers[${index}].id "${candidate.id}" is not one of the pending questions`
    if (seen.has(candidate.id)) return `answers[${index}].id "${candidate.id}" is answered twice`
    seen.add(candidate.id)
    if (!Array.isArray(candidate.selected) || candidate.selected.some((value) => typeof value !== 'string' || value === '')) {
      return `answers[${index}].selected must be an array of non-empty strings`
    }
    if (candidate.custom !== undefined && typeof candidate.custom !== 'string') {
      return `answers[${index}].custom must be a string`
    }
  }
  return null
}

/** 结算一条提问（整份答案一次交回）。 */
export function answerQuestion(
  sessionId: string,
  questionId: string,
  answer: { answers: InteractionAnswerItem[] },
): QuestionAnswerResult {
  const bridge = bridges.get(String(sessionId))
  if (bridge === undefined) return 'session-gone'
  const entry = bridge.pending.get(questionId)
  if (entry === undefined) return 'not-found'
  if (validateAnswers(entry.questions, answer) !== null) return 'invalid-answer'
  entry.settleAnswer(answer as { answers: InteractionAnswerItem[] })
  return 'answered'
}

/** 用户主动不回答（reject `ASK_CANCELLED`，**不是** resolve 空答案）。 */
export function cancelQuestion(sessionId: string, questionId: string): QuestionAnswerResult {
  const bridge = bridges.get(String(sessionId))
  if (bridge === undefined) return 'session-gone'
  const entry = bridge.pending.get(questionId)
  if (entry === undefined) return 'not-found'
  entry.settleCancel()
  return 'cancelled'
}

/** 列出全部待决提问（按 `since` 升序）。 */
export function listPendingQuestions(sessionId?: string): Array<PendingQuestion & { sessionId: string }> {
  const out: Array<PendingQuestion & { sessionId: string }> = []
  for (const [key, bridge] of bridges) {
    if (sessionId !== undefined && key !== String(sessionId)) continue
    for (const entry of bridge.pending.values()) out.push({ ...toPending(entry), sessionId: key })
  }
  return out.sort((a, b) => a.since - b.since)
}

/** 单个会话的待决提问快照。 */
export function snapshotPendingQuestions(sessionId: string): PendingQuestion[] {
  const bridge = bridges.get(String(sessionId))
  if (bridge === undefined) return []
  return [...bridge.pending.values()].map(toPending).sort((a, b) => a.since - b.since)
}

/** 丢掉全部接管状态（测试 / 诊断用）。 */
export function resetQuestions(): void {
  for (const bridge of bridges.values()) {
    for (const entry of [...bridge.pending.values()]) entry.settleAbort()
  }
  bridges.clear()
  activeAnswerers = 0
  disposeInteractionLogger()
}

export type { AnswerLike }
