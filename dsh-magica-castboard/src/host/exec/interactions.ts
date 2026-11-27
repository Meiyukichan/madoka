/**
 * Pending interactions (approvals / questions): expose spellbook's pending interactions
 * to the board and accept answers.
 *
 * Ownership rule: **the session ledger is the only credential**; no in-process shadow
 * table is built — pending interactions survive a process restart and are rediscovered
 * through `listPending*`. No timeout is applied (the user handles them in the UI).
 *
 * @module dsh-magica-castboard/host/exec/interactions
 */
import type { PendingInteractionRecord } from '../model.ts'

export type InteractionKind = 'approval' | 'question'

/** 关闭结果；`answered` 表示有人答过，具体是否 apply 仍以 source host 为准。 */
export type InteractionOutcome = 'answered' | 'cancelled' | 'expired' | 'reporting_disabled' | 'unknown'

/** `refresh` 的成败；`ok:false` 时调用方必须整拍跳过，不能把旧 cache 当“没有 pending”。 */
export interface InteractionRefresh {
  items: readonly PendingInteraction[]
  ok: boolean
}

export interface PendingInteraction {
  id: string
  kind: InteractionKind
  sessionId: string
  /** Optional card the interaction is attached to. */
  taskId?: string
  title: string
  /** Approvals: what would run; questions: the question body. */
  body: string
  options?: readonly string[]
  /** Full option rows, including descriptions. */
  optionDetails?: readonly { label: string; description?: string }[]
  /** Multiple option labels may be selected at once. */
  multiSelect?: boolean
  createdAt: number
  /**
   * The untouched spellbook record. `/state` returns this directly instead of
   * re-projecting it, so flags such as `multiSelect` and option descriptions survive.
   */
  raw?: PendingInteractionRecord
}

/** Spellbook-injected face; absent means the board degrades to empty. */
export interface InteractionFace {
  listPendingApprovals?: () => Promise<readonly PendingInteraction[]>
  listPendingQuestions?: () => Promise<readonly PendingInteraction[]>
  // sessionId is part of the wire input: the bridge indexes pending work by session.
  answerApproval?: (input: { id: string; sessionId: string; approved: boolean; note?: string }) => Promise<void>
  answerQuestion?: (input: { id: string; sessionId: string; answer: string; selected?: readonly string[] }) => Promise<void>
  cancelQuestion?: (input: { id: string; sessionId: string }) => Promise<void>
}

export interface InteractionDeps {
  face?: InteractionFace
  now: () => number
  /** Fallback used to attach interactions to cards when they carry no taskId. */
  taskIdOfSession?: (sessionId: string) => string | undefined
}

export class InteractionService {
  private readonly deps: InteractionDeps
  private cache: PendingInteraction[] = []
  /** 本地已观察到的关闭结果；只写第一次，重启后丢失，由 projection 兜底。 */
  private readonly outcomes = new Map<string, InteractionOutcome>()

  constructor(deps: InteractionDeps) {
    this.deps = deps
  }

  /** Rides on `/state`; no polling of its own. */
  async refresh(): Promise<readonly PendingInteraction[]> {
    return (await this.refreshResult()).items
  }

  /**
   * 带成败的刷新：reporter/coordinator 只能在这返回 `ok:true` 时做 diff，
   * 否则一次读失败会把全部 pending 误判成 completed。
   */
  async refreshResult(): Promise<InteractionRefresh> {
    const face = this.deps.face
    if (face === undefined) {
      // No authority at all: do not keep showing a snapshot nobody can answer.
      this.cache = []
      return { items: this.cache, ok: false }
    }
    try {
      const [approvals, questions] = await Promise.all([
        face.listPendingApprovals?.() ?? Promise.resolve([]),
        face.listPendingQuestions?.() ?? Promise.resolve([]),
      ])
      this.cache = [...approvals, ...questions].map(item => ({
        ...item,
        taskId: item.taskId ?? this.deps.taskIdOfSession?.(item.sessionId),
      }))
      return { items: this.cache, ok: true }
    } catch {
      // Keep the last snapshot on a failed read (do not blank the UI), but report failure.
      return { items: this.cache, ok: false }
    }
  }

  list(): readonly PendingInteraction[] {
    return this.cache
  }

  /** 记录一次关闭结果；先到先得，不覆盖 `answerRemote` 写入的 answered。 */
  noteOutcome(id: string, outcome: InteractionOutcome): void {
    if (id === '' || this.outcomes.has(id)) return
    this.outcomes.set(id, outcome)
  }

  outcomeOf(id: string): InteractionOutcome | undefined {
    return this.outcomes.get(id)
  }

  /** 取走结果（Coordinator 发 completed 后调用）。 */
  takeOutcome(id: string): InteractionOutcome | undefined {
    const outcome = this.outcomes.get(id)
    this.outcomes.delete(id)
    return outcome
  }

  ofTask(taskId: string): readonly PendingInteraction[] {
    return this.cache.filter(item => item.taskId === taskId)
  }

  async answerApproval(id: string, approved: boolean, note?: string): Promise<boolean> {
    const target = this.cache.find(item => item.id === id && item.kind === 'approval')
    if (target === undefined) return false
    await this.deps.face?.answerApproval?.({ id, sessionId: target.sessionId, approved, note })
    this.noteOutcome(id, 'answered')
    this.cache = this.cache.filter(item => item.id !== id)
    return true
  }

  async answerQuestion(id: string, answer: string, selected?: readonly string[]): Promise<boolean> {
    const target = this.cache.find(item => item.id === id && item.kind === 'question')
    if (target === undefined) return false
    await this.deps.face?.answerQuestion?.({
      id,
      sessionId: target.sessionId,
      answer,
      ...(selected === undefined ? {} : { selected }),
    })
    this.noteOutcome(id, 'answered')
    this.cache = this.cache.filter(item => item.id !== id)
    return true
  }

  async cancelQuestion(id: string): Promise<boolean> {
    const target = this.cache.find(item => item.id === id && item.kind === 'question')
    if (target === undefined) return false
    await this.deps.face?.cancelQuestion?.({ id, sessionId: target.sessionId })
    this.noteOutcome(id, 'cancelled')
    this.cache = this.cache.filter(item => item.id !== id)
    return true
  }
}
