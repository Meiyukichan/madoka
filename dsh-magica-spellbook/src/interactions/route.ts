/**
 * host 侧 HTTP 面：1 条 GET + 3 条 POST，含请求体校验、错误码映射、跨站闸门。
 *
 * handler 顺序铁律（字段校验**先于**归属校验：坏请求拿 400 而不是 403，不泄漏会话归属）：
 * `requireString`（400）→ `allowSession`（403）→ 载荷校验（400）→ `settle`（200/404/409/400）。
 *
 * @module dsh-magica-spellbook/interactions/route
 */

import type { ServerResponse } from 'node:http'
import {
  createJsonRouter,
  HttpRouteError,
  type JsonRouterRoute,
} from '../core/router.ts'
import { answerApproval } from '../sessions/approval.ts'
import { answerQuestion, cancelQuestion } from '../sessions/questions.ts'
import { collectPendingInteractions } from './collect.ts'
import { isMagicaSession, type InteractionHostFace } from './ownership.ts'
import {
  INTERACTION_PREFIX,
  type AnswerApprovalBody,
  type InteractionAnswerItem,
  type InteractionEnvelope,
} from '../shared/wire.ts'

/** 请求体上限（一组答案或一个决定几百字节就够）。 */
export const MAX_BODY_BYTES = 64 * 1024

/** handler 选项。 */
export interface InteractionHandlerOptions {
  /** 挂载前缀，**必须与 `webServer.register` 的 `path` 一致**。 */
  prefix?: string
  /** 台账目录覆盖（必须与门面一致）。 */
  storeDir?: string
  /**
   * 变更类端点是否要求严格同源。
   *
   * **默认 `true`**：这台机器上的本机脚本若不带 Origin 就能 POST
   * `/interactions/approval/answer`，等于零凭证批准越权工具调用（同面 `GET` 还免费给出
   * sessionId 与待决 id，构成完整利用链）。确实要放行无 Origin 的本机工具时显式传 `false`。
   */
  strictMutations?: boolean
  /**
   * Host 头**额外**白名单（回环永远允许，见 `isTrustedHost`）。
   * 部署在域名/反代后面时把对外 Host 加进来即可。
   */
  trustedHosts?: readonly string[]
}

interface RouterContextLike {
  readonly request: { url?: string; headers: Record<string, string | string[] | undefined> }
  readonly response: ServerResponse
  query(key: string): string | null
  readonly body: Readonly<Record<string, unknown>>
}

function ok(response: ServerResponse, value: unknown, status = 200): void {
  // 与 fail() 一致：已发头就静默返回，绝不上浮 ERR_HTTP_HEADERS_SENT（真机上会中断请求）
  if (response.headersSent) return
  const envelope: InteractionEnvelope<unknown> = { ok: true, value }
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(envelope))
}

function fail(response: ServerResponse, status: number, code: string, message: string): void {
  if (response.headersSent) return
  const envelope: InteractionEnvelope<never> = { ok: false, error: { code, message } }
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(envelope))
}

function toFail(response: ServerResponse, error: unknown): void {
  if (error instanceof HttpRouteError) {
    fail(response, error.status, error.code, error.message)
    return
  }
  fail(response, 500, 'internal', `interaction route failed: ${error instanceof Error ? error.message : String(error)}`)
}

function requireString(
  context: RouterContextLike,
  key: string,
  label: string,
): string | null {
  const value = context.body[key]
  if (typeof value !== 'string' || value.trim() === '') {
    fail(context.response, 400, 'invalid_input', `${label} is required`)
    return null
  }
  return value
}

function readAnswers(context: RouterContextLike): InteractionAnswerItem[] | null {
  const raw = context.body['answers']
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(context.response, 400, 'invalid_input', 'answers must be a non-empty array')
    return null
  }
  const answers: InteractionAnswerItem[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      fail(context.response, 400, 'invalid_input', 'each answer must be an object')
      return null
    }
    const candidate = item as { id?: unknown; selected?: unknown; custom?: unknown }
    if (typeof candidate.id !== 'string' || candidate.id === '') {
      fail(context.response, 400, 'invalid_input', 'each answer needs a question id')
      return null
    }
    if (!Array.isArray(candidate.selected) || candidate.selected.some((entry) => typeof entry !== 'string')) {
      fail(context.response, 400, 'invalid_input', `answer "${candidate.id}": selected must be string[]`)
      return null
    }
    const answer: InteractionAnswerItem = {
      id: candidate.id,
      selected: candidate.selected as string[],
    }
    if (typeof candidate.custom === 'string' && candidate.custom.trim() !== '') answer.custom = candidate.custom
    answers.push(answer)
  }
  return answers
}

function allowSession(
  host: InteractionHostFace,
  context: RouterContextLike,
  sessionId: string,
  storeDir?: string,
): boolean {
  if (isMagicaSession(host, sessionId, storeDir)) return true
  fail(
    context.response,
    403,
    'forbidden',
    'this interaction surface only serves sessions created through this SDK',
  )
  return false
}

function settle(context: RouterContextLike, result: string): void {
  switch (result) {
    case 'answered':
    case 'cancelled':
      ok(context.response, { result })
      return
    case 'not-found':
      fail(
        context.response,
        404,
        'not_found',
        'this interaction is already settled, timed out, or its session ended',
      )
      return
    case 'session-gone':
      fail(
        context.response,
        409,
        'invalid_transition',
        'the session holding this interaction is no longer answerable',
      )
      return
    case 'invalid-answer':
      // 形状不对（缺 id / id 不属于本次请求 / selected 不是字符串数组）：给用户能读懂的文案，
      // 而不是把内部结果码原样拼进消息（d.md:437-443 的消息阶梯）
      fail(
        context.response,
        400,
        'invalid_input',
        'answers do not match the pending questions: each answer needs a known id and a string array `selected`',
      )
      return
    default:
      fail(context.response, 400, 'invalid_input', `the interaction was not answered: ${result}`)
  }
}

/**
 * 四行路由表（供直接组装或交给路由器）。
 * @param host - 宿主面。
 * @param options - 前缀 / 台账 / 严格同源。
 */
export function interactionRoutes(
  host: InteractionHostFace,
  options: InteractionHandlerOptions = {},
): JsonRouterRoute[] {
  const storeDir = options.storeDir
  const strict = options.strictMutations !== false

  const list = (context: RouterContextLike): void => {
    const raw = context.query('sessionId')
    const sessionId = raw === null || raw === '' ? undefined : raw
    const items = collectPendingInteractions(host, {
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(storeDir !== undefined ? { storeDir } : {}),
    })
    ok(context.response, { items })
  }

  const answer = (context: RouterContextLike): void => {
    const sessionId = requireString(context, 'sessionId', 'sessionId')
    if (sessionId === null) return
    const questionId = requireString(context, 'questionId', 'questionId')
    if (questionId === null) return
    if (!allowSession(host, context, sessionId, storeDir)) return
    const answers = readAnswers(context)
    if (answers === null) return
    settle(context, answerQuestion(sessionId, questionId, { answers }))
  }

  const cancel = (context: RouterContextLike): void => {
    const sessionId = requireString(context, 'sessionId', 'sessionId')
    if (sessionId === null) return
    const questionId = requireString(context, 'questionId', 'questionId')
    if (questionId === null) return
    if (!allowSession(host, context, sessionId, storeDir)) return
    settle(context, cancelQuestion(sessionId, questionId))
  }

  const decide = (context: RouterContextLike): void => {
    const sessionId = requireString(context, 'sessionId', 'sessionId')
    if (sessionId === null) return
    const approvalId = requireString(context, 'approvalId', 'approvalId')
    if (approvalId === null) return
    if (!allowSession(host, context, sessionId, storeDir)) return
    const decision = context.body['decision']
    if (decision !== 'allowed-once' && decision !== 'rejected') {
      fail(context.response, 400, 'invalid_input', "decision must be 'allowed-once' or 'rejected'")
      return
    }
    settle(context, answerApproval(sessionId, approvalId, decision))
  }

  const guard = (handler: (context: RouterContextLike) => void) => (context: RouterContextLike): void => {
    if (!strict) {
      handler(context)
      return
    }
    // 严格同源：浏览器 POST 一定带 Origin，所以打开这个开关不破坏页面
    const origin = context.request.headers['origin']
    const hostHeader = context.request.headers['host']
    if (typeof origin !== 'string' || typeof hostHeader !== 'string') {
      fail(context.response, 403, 'forbidden', 'same-origin request required')
      return
    }
    let sameByHost = false
    try {
      sameByHost = new URL(origin).host === hostHeader
    } catch {
      sameByHost = false
    }
    if (!sameByHost) {
      fail(context.response, 403, 'forbidden', 'same-origin request required')
      return
    }
    handler(context)
  }

  return [
    { method: 'GET', path: '/interactions', handler: (context) => list(context) },
    { method: 'POST', path: '/interactions/question/answer', handler: guard(answer) },
    { method: 'POST', path: '/interactions/question/cancel', handler: guard(cancel) },
    { method: 'POST', path: '/interactions/approval/answer', handler: guard(decide) },
  ]
}

/**
 * 造一个可交给 `webServer.register({ kind: 'prefix', path, handler })` 的处理器。
 * @param host - 宿主面。
 * @param options - 前缀 / 台账 / 严格同源。
 */
export function createInteractionHandler(
  host: InteractionHostFace,
  options: InteractionHandlerOptions = {},
): (request: never, response: ServerResponse) => Promise<void> {
  return createJsonRouter({
    prefix: options.prefix ?? INTERACTION_PREFIX,
    trust: 'browser',
    maxBytes: MAX_BODY_BYTES,
    onError: toFail,
    onNotFound: (response) => {
      fail(response, 404, 'not_found', 'no such interaction endpoint')
    },
    ...(options.trustedHosts !== undefined ? { trustedHosts: options.trustedHosts } : {}),
    routes: interactionRoutes(host, options),
  }) as unknown as (request: never, response: ServerResponse) => Promise<void>
}

export type { AnswerApprovalBody }
