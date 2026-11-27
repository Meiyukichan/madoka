/**
 * spellbook **自己的**待决交互 HTTP / 载体契约。
 *
 * 这个文件里**没有** dsh 类型镜像：
 * - dsh 已有的形状一律从真实包转出（`AskUserQuestion*` / `ApprovalRequestEvent` / `ApprovalOutcome`）；
 * - 剩下的是我们**线上契约**（路径、载体标记、信封、请求体），它们不是 dsh 的概念，
 *   所以只能由我们自己定义——但每个字段的类型仍然指向 dsh 的真实类型，不重写一遍。
 *
 * 为什么路径常量和类型要放一处：host 路由（`interactions/route.ts`）与浏览器传输
 * （`client/panel/transport.ts`）共用同一份，永不打两边各写一份而漂移。
 *
 * @module dsh-magica-spellbook/shared/interaction
 */

import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'

// ── dsh 真实类型的纯转出（不重写字段）─────────────────────────────

export type {
  AskUserQuestionAnswer as InteractionAnswer,
  AskUserQuestionAnswerItem as InteractionAnswerItem,
  AskUserQuestionIntent as InteractionIntent,
  AskUserQuestionOption as InteractionOption,
} from '@deepseek-ai/dsh-user-questions/types'

/**
 * 一条待决提问：dsh 的 `AskUserQuestionItem` + 我们下发的两个派生字段。
 *
 * `wait` 在 dsh 的请求上是**整个请求**的（`AskUserQuestionRequestEvent.wait`），
 * 而我们的列表按问题下发，所以把它摊到每个问题上（`&` 明确表达派生，不重抄 dsh 的字段）。
 */
export type InteractionQuestion = AskUserQuestionItem & {
  /** 限时提问的 tool call id（来自 `request.wait.callId`）。 */
  waitCallId?: string
  /** 是否是前台限时等待（来自 `request.wait.timed`）。 */
  waitTimed?: boolean
}

/**
 * 列表下发的一条待决项。
 *
 * - `kind` / `id` / `since` / `sessionId` 是**我们的**线上判别与派生字段（JSON 里没有 brand，
 *   所以 `sessionId` 是 `string`；进入浏览器侧载体时才认作 `SessionId`）；
 * - 审批的业务字段从 dsh 的 `ApprovalRequestEvent` `Pick` 出来；
 * - `callId` 在线上是字符串（dsh 的 `ToolCallId` brand 不过 JSON）。
 */
export type PendingInteractionRecord =
  | {
      kind: 'question'
      id: string
      sessionId: string
      since: number
      questions: InteractionQuestion[]
    }
  | ({
      kind: 'approval'
      id: string
      sessionId: string
      since: number
      /** 原始工具入参 JSON（可能被截断，截断后不再是合法 JSON）。 */
      args?: string
      /** dsh 的 `ToolCallId`，线上摊平成字符串。 */
      callId?: string
    } & Pick<ApprovalRequestEvent, 'toolName' | 'reason' | 'displayReason'>)

// ── 我们自己的 HTTP 请求体 ────────────────────────────────────────

/** `POST /interactions/question/answer` 请求体。 */
export interface AnswerQuestionBody {
  sessionId: string
  questionId: string
  answers: AskUserQuestionAnswerItem[]
}

/** `POST /interactions/question/cancel` 请求体。 */
export interface CancelQuestionBody {
  sessionId: string
  questionId: string
}

/** `POST /interactions/approval/answer` 请求体（用户只能选这两个值）。 */
export interface AnswerApprovalBody {
  sessionId: string
  approvalId: string
  decision: Extract<ApprovalOutcome, 'allowed-once' | 'rejected'>
}

/** 列表成功值。 */
export interface InteractionListValue {
  items: PendingInteractionRecord[]
}

/** 三个应答端点的成功值（这是我们的 HTTP 返回，不是 dsh 的 `AskUserQuestionAnswer`）。 */
export interface InteractionAnswerValue {
  result: string
}

/** 统一响应信封：浏览器侧一个解包函数通吃。 */
export type InteractionEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

// ── 路径 / 载体常量 ────────────────────────────────────────────

/** 挂载前缀，必须与 `webServer.register` 的 `path` 逐字一致。 */
export const INTERACTION_PREFIX = '/magica'

/** 四个端点在前缀之后的路径（host 路由表与浏览器传输共用）。 */
export const INTERACTION_PATHS = {
  list: '/interactions',
  answerQuestion: '/interactions/question/answer',
  cancelQuestion: '/interactions/question/cancel',
  answerApproval: '/interactions/approval/answer',
} as const

/** 浏览器侧载体认领用的标记值（不用 `instanceof`：热重载后类身份会失效）。 */
export const INTERACTION_TAG = 'dsh-magica-spellbook/interaction'

/** 排他式瀑布监听选项 —— 抢在 `api/remotes` 转发器之前的唯一办法。 */
export const WATERFALL_TAKEOVER = { prepend: true, global: true } as const

// ── 待决交互变更事件（跨插件观察）────────────────────────────────

/** `magica/interaction-changed` 的事件名；两端共用同一份契约。 */
export const INTERACTION_CHANGED_EVENT = 'magica/interaction-changed' as const

/**
 * 待决交互的 added / removed 通知。
 *
 * 事件只做**观察**：listener 抛错不能影响审批/提问本身；真正的结算仍走
 * `answerApproval` / `answerQuestion` / `cancelQuestion`。
 */
export interface InteractionChangedEvent {
  action: 'added' | 'removed'
  item: PendingInteractionRecord
  /**
   * removed 时的原始原因：
   * - approval：`allowed-once` / `rejected` / `cancelled` / `unavailable`
   * - question：`answered` / `cancelled` / `aborted`
   */
  outcome?: string
}

/**
 * 发一条变更事件。ctx 可能是测试 mock / 非 cordis 环境，所以用鸭子类型 + try/catch。
 * @param ctx - 宿主 context（只需要 `emit`）。
 * @param change - 变更内容。
 */
export function emitInteractionChanged(ctx: unknown, change: InteractionChangedEvent): void {
  try {
    const scope = ctx as { emit?: (name: string, payload: InteractionChangedEvent) => void }
    scope.emit?.(INTERACTION_CHANGED_EVENT, change)
  } catch {
    // 观察者失败不能影响审批/提问本身
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 待决交互出现/消失的通知。
     * @param change - added/removed 与待决项快照。
     */
    'magica/interaction-changed'(change: InteractionChangedEvent): void
  }
}
