/**
 * 待决交互的**线上契约**。
 *
 * 本文件是叶子节点：**零 import**（无 node / DOM / dsh 依赖），host 路由与浏览器 transport 共用同一份，
 * 所以路径常量只写一处，永不打两边各写一份而漂移。
 *
 * @module dsh-magica-spellbook/shared/wire
 */

/** 一个问题里的一个选项。`label` 是答案回传的原文。 */
export interface InteractionOption {
  label: string
  description?: string
}

/** 展示意图（dsh 的 `plan-review` 是唯一已定义分支；这里放宽成 string 以便前向兼容）。 */
export interface InteractionIntent {
  kind: string
  approve: string
  callId?: string
}

/** 一条待决提问。 */
export interface InteractionQuestion {
  id: string
  question: string
  detail?: string
  header?: string
  options?: InteractionOption[]
  multiSelect?: boolean
  intent?: InteractionIntent
  /** 0.2 新增：限时提问的 tool call id（`AskUserQuestionRequestEvent.wait.callId`）。 */
  waitCallId?: string
  /** 0.2 新增：是否是前台限时等待。 */
  waitTimed?: boolean
}

/** 一条答案。`selected` 是选项 label 原文；自由文本题可以是空数组 + `custom`。 */
export interface InteractionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/** 列表下发的一条待决项（`kind` 是判别位）。 */
export type PendingInteractionRecord =
  | {
      kind: 'question'
      id: string
      sessionId: string
      since: number
      questions: InteractionQuestion[]
    }
  | {
      kind: 'approval'
      id: string
      sessionId: string
      since: number
      toolName: string
      callId?: string
      reason?: string
      args?: string
      /** 0.2 新增：本地化展示用，**不持久化**。 */
      displayReason?: Record<string, string>
    }

/** `POST /interactions/question/answer` 请求体。 */
export interface AnswerQuestionBody {
  sessionId: string
  questionId: string
  answers: InteractionAnswerItem[]
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
  decision: 'allowed-once' | 'rejected'
}

/** 列表成功值。 */
export interface InteractionListValue {
  items: PendingInteractionRecord[]
}

/** 三个应答端点的成功值。 */
export interface InteractionAnswerValue {
  result: string
}

/** 统一响应信封：浏览器侧一个解包函数通吃。 */
export type InteractionEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

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
