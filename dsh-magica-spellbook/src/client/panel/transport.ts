/**
 * 同源 `fetch` 传输：列表 + 三种应答，统一信封解包。
 *
 * 路径常量与 host 路由**同源**（都来自 `shared/interaction.ts`），不会两边各写一份而漂移。
 *
 * @module dsh-magica-spellbook/client/panel/transport
 */

import {
  INTERACTION_PATHS,
  INTERACTION_PREFIX,
  type InteractionAnswerItem,
  type InteractionEnvelope,
  type PendingInteractionRecord,
} from '../../shared/interaction.ts'
import type { InteractionActions, InteractionResult } from './carrier.ts'

/** 请求超时。 */
const TIMEOUT_MS = 10_000

/** 浏览器侧传输面。 */
export interface InteractionTransport extends InteractionActions {
  /** 拉取列表；失败**抛错**（读操作不折成 Result）。 */
  list(): Promise<PendingInteractionRecord[]>
}

interface TransportOptions {
  prefix?: string
}

function urlOf(prefix: string, path: string): string {
  return `${prefix}${path}`
}

async function unwrap<T>(response: Response): Promise<T> {
  // 一个解包函数通吃（d.md:86）：**先看信封**——4xx/5xx 也可能带完整信封
  // （`forbidden: nope` 比 `HTTP 403` 有用得多）；只有拿不到信封时才退回状态码文案，
  // 这样 405 / 宿主裸 400 不会变成 `Unexpected end of JSON input`
  const text = await response.text()
  let envelope: InteractionEnvelope<T> | undefined
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed === 'object' && parsed !== null && 'ok' in parsed) {
      envelope = parsed as InteractionEnvelope<T>
    }
  } catch {
    envelope = undefined
  }
  if (envelope !== undefined) {
    if (envelope.ok) return envelope.value
    throw new Error(`${envelope.error.code}: ${envelope.error.message}`)
  }
  const detail = text.trim().slice(0, 200)
  if (!response.ok) throw new Error(`HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`)
  throw new Error(`HTTP ${response.status}: malformed JSON response`)
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  return unwrap<T>(response)
}

/**
 * 造浏览器侧传输。
 * @param options - 前缀（必须与 host 注册路径一致）。
 */
export function createInteractionTransport(options: TransportOptions = {}): InteractionTransport {
  const prefix = options.prefix ?? INTERACTION_PREFIX

  async function settle(run: () => Promise<unknown>): Promise<InteractionResult> {
    try {
      await run()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    async list() {
      const response = await fetch(urlOf(prefix, INTERACTION_PATHS.list), {
        method: 'GET',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const value = await unwrap<{ items?: PendingInteractionRecord[] }>(response)
      // 形状容错：老版本/降级响应可能没有 items，缺它就当空列表（不要抛进轮询循环）
      return Array.isArray(value.items) ? value.items : []
    },
    answerQuestion(view, answers: InteractionAnswerItem[]) {
      return settle(() =>
        post(urlOf(prefix, INTERACTION_PATHS.answerQuestion), {
          sessionId: view.sessionId,
          questionId: view.id,
          answers,
        }),
      )
    },
    cancelQuestion(view) {
      return settle(() =>
        post(urlOf(prefix, INTERACTION_PATHS.cancelQuestion), {
          sessionId: view.sessionId,
          questionId: view.id,
        }),
      )
    },
    answerApproval(view, decision) {
      return settle(() =>
        post(urlOf(prefix, INTERACTION_PATHS.answerApproval), {
          sessionId: view.sessionId,
          approvalId: view.id,
          decision,
        }),
      )
    },
  }
}
