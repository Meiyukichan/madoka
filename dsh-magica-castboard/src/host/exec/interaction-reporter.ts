/**
 * Interaction reporter.
 *
 * Source-host side: turn a local spellbook pending into a `requested` control comment,
 * and turn its disappearance into `completed`. The reporter is deliberately separate
 * from the bridge (which applies remote answers) so each side owns one direction.
 *
 * @module dsh-magica-castboard/host/exec/interaction-reporter
 */
import type { BoardSettings } from '../model.ts'
import { commentsEnabled } from '../rules.ts'
import type { LinkStore } from '../ledger/link-store.ts'
import type { TaskStore } from '../ledger/task-store.ts'
import type { ThreadService } from '../pipeline/thread.ts'
import type { InteractionProjection } from './interaction-projection.ts'
import type { InteractionRefresh, InteractionService, PendingInteraction } from './interactions.ts'
import {
  INTERACTION_SCHEMA,
  encodeInteraction,
  type CompletedInteractionEvent,
  type InteractionApprovalRequest,
  type InteractionQuestion,
  type InteractionQuestionRequest,
  type InteractionOutcome,
  type RequestedApprovalEvent,
  type RequestedQuestionEvent,
} from '../../shared/interaction-protocol.ts'
import { interactionCommentId } from './interaction-id.ts'

export interface InteractionReporterDeps {
  readonly interactions: Pick<InteractionService, 'refreshResult' | 'outcomeOf' | 'takeOutcome'>
  readonly tasks: Pick<TaskStore, 'get' | 'taskIdOfSession' | 'summaries'>
  readonly links: Pick<LinkStore, 'get' | 'issueIds'>
  readonly thread: Pick<ThreadService, 'addControl'>
  readonly projection: Pick<InteractionProjection, 'of'>
  readonly settings: () => BoardSettings | undefined
  readonly instance: () => string
  readonly now: () => number
  readonly log?: (level: 'info' | 'warn', event: string, detail?: unknown) => void
}

interface Target {
  readonly issueId: string
  readonly taskId: string
}

interface Current {
  readonly item: PendingInteraction
  readonly target: Target
}

interface Known {
  readonly issueId: string
  readonly sessionId: string
  readonly kind: 'approval' | 'question'
  /** Adopted from projection rather than reported by this process (usually a restart). */
  readonly seeded: boolean
}

export class InteractionReporter {
  private readonly deps: InteractionReporterDeps
  /** interactionId -> the request this process has reported (or adopted at startup). */
  private readonly known = new Map<string, Known>()
  private seeded = false

  constructor(deps: InteractionReporterDeps) {
    this.deps = deps
  }

  /**
   * One pass: refresh local pending, seed ownership once, report new requests, close missing ones.
   *
   * @param applied - Interaction ids the bridge applied this tick; they are already gone
   *   from the source host's perspective and must not be reported as still pending.
   * @param refreshed - Optional snapshot the caller already read (avoids a second face call).
   */
  async tick(applied: ReadonlySet<string> = new Set(), refreshed?: InteractionRefresh): Promise<void> {
    const settings = this.deps.settings()
    // The comment channel is the transport. Skip the whole pass when it is off; `known`
    // survives, so re-enabling the channel resumes reporting/completion.
    if (!commentsEnabled(settings)) return

    const refresh = refreshed ?? await this.deps.interactions.refreshResult()
    if (!refresh.ok) return

    if (!this.seeded) await this.seed()

    const current = this.currentOf(refresh.items, applied)
    await this.report(current, settings?.interactionReportEnabled !== false)
    await this.completeMissing(current)
  }

  /** Whether the startup projection scan completed successfully. */
  get isSeeded(): boolean {
    return this.seeded
  }

  private currentOf(items: readonly PendingInteraction[], applied: ReadonlySet<string>): Map<string, Current> {
    const current = new Map<string, Current>()
    for (const item of items) {
      if (applied.has(item.id)) continue
      const target = this.reportable(item)
      if (target !== undefined) current.set(item.id, { item, target })
    }
    return current
  }

  private reportable(interaction: PendingInteraction): Target | undefined {
    const taskId = interaction.taskId
      ?? this.deps.tasks.taskIdOfSession(interaction.sessionId)
    if (taskId === undefined) return undefined
    const task = this.deps.tasks.get(taskId)
    if (task === undefined || task.trashedAt !== undefined) return undefined
    if (task.issueId === undefined || task.issueId === '') return undefined
    const link = this.deps.links.get(task.issueId)
    if (link?.assigneeSessionId !== interaction.sessionId) return undefined
    return { issueId: task.issueId, taskId }
  }

  private async report(current: ReadonlyMap<string, Current>, enabled: boolean): Promise<void> {
    if (!enabled) return
    for (const [interactionId, item] of current) {
      if (this.known.has(interactionId)) continue
      try {
        const event = requestedEventOf(item.item, item.target, this.deps.instance())
        await this.deps.thread.addControl(item.target.issueId, {
          id: interactionCommentId(event),
          role: 'assignee',
          threadId: item.item.sessionId,
          body: encodeInteraction(event),
          createdAt: event.at,
          systemKey: 'castboard.interaction.requested',
        })
        this.known.set(interactionId, {
          issueId: item.target.issueId,
          sessionId: item.item.sessionId,
          kind: item.item.kind,
          seeded: false,
        })
        this.log('info', 'interaction-requested', { interactionId, issueId: item.target.issueId })
      } catch (error) {
        // Do not mark it known: the next tick retries the same stable comment id.
        this.log('warn', 'interaction-report-requested-failed', { interactionId, error: errorText(error) })
      }
    }
  }

  private async completeMissing(current: ReadonlyMap<string, Current>): Promise<void> {
    for (const [interactionId, known] of this.known) {
      if (current.has(interactionId)) continue
      try {
        // Local apply proof wins; `seeded` only means "no proof in this process".
        const outcome: InteractionOutcome = this.deps.interactions.outcomeOf(interactionId)
          ?? (known.seeded ? 'expired' : 'unknown')
        const event: CompletedInteractionEvent = {
          schema: INTERACTION_SCHEMA,
          event: 'completed',
          interactionId,
          issueId: known.issueId,
          sessionId: known.sessionId,
          kind: known.kind,
          at: this.now(),
          outcome,
        }
        await this.deps.thread.addControl(known.issueId, {
          id: interactionCommentId(event),
          role: 'assignee',
          threadId: known.sessionId,
          body: encodeInteraction(event),
          createdAt: event.at,
          systemKey: 'castboard.interaction.completed',
        })
        this.known.delete(interactionId)
        this.deps.interactions.takeOutcome(interactionId)
        this.log('info', 'interaction-completed', { interactionId, issueId: known.issueId, outcome })
      } catch (error) {
        this.log('warn', 'interaction-report-completed-failed', { interactionId, error: errorText(error) })
      }
    }
  }

  private async seed(): Promise<void> {
    const issueIds = new Set<string>()
    try {
      for (const issueId of this.deps.links.issueIds()) issueIds.add(issueId)
    } catch (error) {
      this.log('warn', 'interaction-seed-links-failed', errorText(error))
      return
    }
    try {
      for (const summary of this.deps.tasks.summaries()) {
        if (summary.trashed === true) continue
        if (summary.issueId !== undefined && summary.issueId !== '') issueIds.add(summary.issueId)
      }
    } catch (error) {
      this.log('warn', 'interaction-seed-tasks-failed', errorText(error))
      return
    }

    let ok = true
    for (const issueId of issueIds) {
      try {
        const views = await this.deps.projection.of(issueId)
        for (const view of views) {
          if (view.status === 'completed') continue
          const taskId = this.deps.tasks.taskIdOfSession(view.sessionId)
          if (taskId === undefined) continue
          const task = this.deps.tasks.get(taskId)
          if (task?.issueId !== issueId) continue
          if (this.deps.links.get(issueId)?.assigneeSessionId !== view.sessionId) continue
          this.known.set(view.interactionId, {
            issueId,
            sessionId: view.sessionId,
            kind: view.kind,
            seeded: true,
          })
        }
      } catch (error) {
        ok = false
        this.log('warn', 'interaction-seed-projection-failed', { issueId, error: errorText(error) })
      }
    }
    // Only mark seeded when every issue was read; otherwise the next tick retries the scan.
    this.seeded = ok
  }

  private now(): number {
    const value = this.deps.now()
    return Number.isFinite(value) && value > 0 ? Math.round(value) : Date.now()
  }

  private log(level: 'info' | 'warn', event: string, detail?: unknown): void {
    this.deps.log?.(level, event, detail)
  }
}

function requestedEventOf(
  item: PendingInteraction,
  target: Target,
  instance: string,
): RequestedQuestionEvent | RequestedApprovalEvent {
  const base = {
    schema: INTERACTION_SCHEMA,
    event: 'requested' as const,
    interactionId: item.id,
    issueId: target.issueId,
    sessionId: item.sessionId,
    at: item.createdAt > 0 ? item.createdAt : 1,
    instance,
    taskId: target.taskId,
  } as const
  if (item.kind === 'question') {
    return { ...base, kind: 'question', request: questionRequestOf(item) }
  }
  return { ...base, kind: 'approval', request: approvalRequestOf(item) }
}

function questionRequestOf(item: PendingInteraction): InteractionQuestionRequest {
  const raw = item.raw
  if (raw?.kind === 'question' && raw.questions.length > 0) {
    const questions: InteractionQuestion[] = raw.questions.map(question => {
      const id = question.id !== undefined && question.id !== '' ? question.id : item.id
      const body = question.question !== undefined && question.question !== '' ? question.question : item.body
      const options = question.options?.map(option => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      }))
      return {
        id,
        question: body,
        ...(question.header === undefined ? {} : { header: question.header }),
        ...(question.detail === undefined ? {} : { detail: question.detail }),
        ...(options === undefined || options.length === 0 ? {} : { options }),
        ...(question.multiSelect === true || question.multi_select === true ? { multiSelect: true } : {}),
      }
    })
    return { questions }
  }

  const options = item.optionDetails !== undefined && item.optionDetails.length > 0
    ? item.optionDetails.map(option => ({
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    }))
    : item.options?.map(label => ({ label }))
  return {
    questions: [{
      id: item.id,
      question: item.body,
      ...(item.title === '' ? {} : { header: item.title }),
      ...(options === undefined || options.length === 0 ? {} : { options }),
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
    }],
  }
}

function approvalRequestOf(item: PendingInteraction): InteractionApprovalRequest {
  const raw = item.raw
  if (raw?.kind === 'approval') {
    const args = raw.args
    const fallbackTitle = item.title.trim() !== '' ? item.title : 'approval'
    return {
      toolName: raw.toolName.trim() !== '' ? raw.toolName : fallbackTitle,
      ...(raw.reason === undefined ? {} : { reason: raw.reason }),
      ...(raw.callId === undefined ? {} : { callId: raw.callId }),
      ...(args === undefined ? {} : { argsPreview: args }),
      ...(args !== undefined && args.length > 1_000 ? { argsTruncated: true } : {}),
    }
  }
  return {
    toolName: item.title.trim() !== '' ? item.title : 'approval',
    ...(item.body.trim() === '' ? {} : { reason: item.body }),
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
