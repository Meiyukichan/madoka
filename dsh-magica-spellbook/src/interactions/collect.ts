/**
 * 采集：把两张内存待决表合并成一份可渲染、可传输的列表，并只保留台账里的会话。
 *
 * @module dsh-magica-spellbook/interactions/collect
 */

import { listPendingApprovals } from '../sessions/approval.ts'
import { listPendingQuestions } from '../sessions/questions.ts'
import { isMagicaSession, type InteractionHostFace } from './ownership.ts'
import type { PendingInteractionRecord } from '../shared/wire.ts'

/** 采集选项。 */
export interface CollectInteractionOptions {
  /** 只看某个会话。 */
  sessionId?: string
  /** 台账目录覆盖（必须与门面一致）。 */
  storeDir?: string
  /** 列表里 `args` 的最大字符数；不传 = 不截断。 */
  maxArgsChars?: number
}

/** 截断工具入参（截断后**不再是合法 JSON**，卡片必须容错）。 */
export function clipArgs(args: string, max?: number): string {
  if (max === undefined || !(max > 0) || args.length <= max) return args
  return `${args.slice(0, max)}…`
}

/**
 * 合并两张待决表 → 过滤 → 排序。
 * @param host - 宿主面（归属判定用）。
 * @param options - 过滤与截断。
 */
export function collectPendingInteractions(
  host: InteractionHostFace,
  options: CollectInteractionOptions = {},
): PendingInteractionRecord[] {
  const { sessionId, storeDir, maxArgsChars } = options
  const owned = (candidate: string): boolean => isMagicaSession(host, candidate, storeDir)
  const out: PendingInteractionRecord[] = []

  for (const question of listPendingQuestions(sessionId)) {
    if (!owned(question.sessionId)) continue
    out.push({
      kind: 'question',
      id: question.id,
      sessionId: question.sessionId,
      since: question.since,
      questions: question.questions,
    })
  }

  for (const approval of listPendingApprovals(sessionId)) {
    if (!owned(approval.sessionId)) continue
    out.push({
      kind: 'approval',
      id: approval.id,
      sessionId: approval.sessionId,
      since: approval.since,
      toolName: approval.toolName,
      ...(approval.callId !== undefined ? { callId: approval.callId } : {}),
      ...(approval.reason !== undefined ? { reason: approval.reason } : {}),
      ...(approval.displayReason !== undefined ? { displayReason: approval.displayReason } : {}),
      ...(approval.args !== undefined ? { args: clipArgs(approval.args, maxArgsChars) } : {}),
    })
  }

  // 两张表的 since 来自不同时钟序列，合并后必须重排
  return out.sort((a, b) => (a.since === b.since ? a.id.localeCompare(b.id) : a.since - b.since))
}
