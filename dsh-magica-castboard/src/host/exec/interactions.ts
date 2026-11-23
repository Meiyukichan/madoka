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

  constructor(deps: InteractionDeps) {
    this.deps = deps
  }

  /** Rides on `/state`; no polling of its own. */
  async refresh(): Promise<readonly PendingInteraction[]> {
    const face = this.deps.face
    if (face === undefined) {
      this.cache = []
      return this.cache
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
    } catch {
      // Keep the last snapshot on a failed read (do not blank the UI)
    }
    return this.cache
  }

  list(): readonly PendingInteraction[] {
    return this.cache
  }

  ofTask(taskId: string): readonly PendingInteraction[] {
    return this.cache.filter(item => item.taskId === taskId)
  }

  async answerApproval(id: string, approved: boolean, note?: string): Promise<boolean> {
    const target = this.cache.find(item => item.id === id && item.kind === 'approval')
    if (target === undefined) return false
    await this.deps.face?.answerApproval?.({ id, sessionId: target.sessionId, approved, note })
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
    this.cache = this.cache.filter(item => item.id !== id)
    return true
  }

  async cancelQuestion(id: string): Promise<boolean> {
    const target = this.cache.find(item => item.id === id && item.kind === 'question')
    if (target === undefined) return false
    await this.deps.face?.cancelQuestion?.({ id, sessionId: target.sessionId })
    this.cache = this.cache.filter(item => item.id !== id)
    return true
  }
}
