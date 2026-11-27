/**
 * Session adapter: every session in castboard enters and leaves through here.
 *
 * Two paths:
 *
 * - `runWorkspaceSession` — regular session: attached to a workspace, listed in the
 *   GUI, can be taken over by approvals / questions; used for card execution;
 * - `runEphemeralSession` — ephemeral session: no workspace, fail-fast, discarded once
 *   the run ends; used by router card forwarding / project profiling.
 *
 * Constraints:
 * - castboard does not import `@deepseek-ai/dsh-agent` and does not assemble agent
 *   options itself;
 * - spellbook is obtained with a dynamic import; when unavailable, return `undefined`
 *   (the plugin degrades to "ledger only, no sessions");
 * - settlement recognizes only spellbook's `TurnSettlement`, narrowed here into the
 *   engine's `TurnSettlementLike`.
 *
 * @module dsh-magica-castboard/host/exec/spellbook-sessions
 */
import { randomUUID } from 'node:crypto'

import type {
  ContextEntry,
  SessionHandle,
  SessionModel,
  SessionStateLike,
  SessionsFace,
  StartSessionOptions,
} from './engine.ts'
import type { TurnEndKind, TurnSettlementLike } from '../model.ts'
import { PLUGIN_NAME } from '../context/sections.ts'
import { eventLog } from '../shared/event-log.ts'

interface SettlementLike {
  kind?: string
  completed: boolean
  texts: string[]
  timedOut?: boolean
  externallyDisposed?: boolean
}

interface HandleLike {
  id: string
  resumed?: boolean
  firstTurn: Promise<SettlementLike>
  followup: (message: string) => Promise<SettlementLike>
  followupNamedContext?: (entries: unknown) => Promise<SettlementLike>
  injectContext?: (entries: unknown) => boolean | void
  pushNamedContext?: (entries: unknown, options?: unknown) => string
  steer?: (message: string) => boolean
  wake?: () => Promise<void>
  cancel: (cause?: unknown) => void
  dispose: () => Promise<void>
  getState?: () => {
    running?: boolean
    disposed?: boolean
    error?: string | null
    errorCode?: string
    pendingApprovals?: readonly unknown[]
    pendingQuestions?: readonly unknown[]
  }
}

export interface SpellbookSessionsModule {
  runWorkspaceSession?: (ctx: unknown, options: Record<string, unknown>) => HandleLike
  runEphemeralSession?: (ctx: unknown, options: Record<string, unknown>) => HandleLike | Promise<HandleLike>
}

const KNOWN_KINDS: readonly TurnEndKind[] = [
  'completed',
  'aborted',
  'blocked',
  'error',
  'max-tokens',
  'interrupted',
  'forked',
]

/** Unknown kinds are dropped, which settlePlan treats as "not observed". */
export function toTurnResult(settlement: SettlementLike): TurnSettlementLike {
  const value = settlement.kind
  const kind = typeof value === 'string' && (KNOWN_KINDS as readonly string[]).includes(value)
    ? value as TurnEndKind
    : undefined
  return {
    ...(kind !== undefined ? { kind } : {}),
    completed: settlement.completed === true,
    texts: Array.isArray(settlement.texts) ? settlement.texts : [],
    ...(settlement.timedOut === true ? { timedOut: true } : {}),
    externallyDisposed: settlement.externallyDisposed === true,
  }
}

function makeSetup(
  sections: readonly (ContextEntry & { order?: number })[] | undefined,
): ((agentCtx: unknown) => void) | undefined {
  if (sections === undefined || sections.length === 0) return undefined
  return (agentCtx: unknown): void => {
    const systemPrompt = (agentCtx as {
      systemPrompt?: { section?: (input: { name: string; order?: number; text: string }) => unknown }
    }).systemPrompt
    if (systemPrompt?.section === undefined) return
    for (const section of sections) {
      try {
        systemPrompt.section({ name: section.name, order: section.order, text: section.text })
      } catch (error) {
        eventLog('warn', 'agent-section-register-failed', error instanceof Error ? error.message : String(error))
      }
    }
  }
}

function contextEvidence(entries: readonly ContextEntry[] | undefined): string {
  return (entries ?? [])
    .map(entry => {
      const tag = /<([a-z_][\w-]*)/i.exec(entry.text)?.[1] ?? ''
      return `${entry.name}:${String(entry.text.length)}${tag === '' ? '' : ':' + tag}`
    })
    .join(',')
}

function wrapHandle(handle: HandleLike): SessionHandle {
  const state = (): SessionStateLike => {
    if (handle.getState === undefined) return {}
    try {
      const snapshot = handle.getState()
      return {
        ...(snapshot.running !== undefined ? { running: snapshot.running } : {}),
        ...(snapshot.disposed !== undefined ? { disposed: snapshot.disposed } : {}),
        ...(snapshot.errorCode !== undefined ? { errorCode: snapshot.errorCode } : {}),
        ...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
        ...(snapshot.pendingApprovals !== undefined ? { pendingApprovals: snapshot.pendingApprovals } : {}),
        ...(snapshot.pendingQuestions !== undefined ? { pendingQuestions: snapshot.pendingQuestions } : {}),
      }
    } catch {
      return {}
    }
  }
  return {
    id: handle.id,
    firstTurn: handle.firstTurn.then(toTurnResult),
    followUp: (text: string) => handle.followup(text).then(toTurnResult),
    followupNamedContext: (entries: readonly ContextEntry[]) => {
      const wake = handle.followupNamedContext
      if (typeof wake !== 'function') {
        // Required capability: fail loudly instead of silently degrading to a user follow-up.
        return Promise.reject(new Error('this spellbook session does not support named-context wake'))
      }
      return wake([...entries]).then(toTurnResult)
    },
    // Physical channel for named context: spellbook's `injectContext` (equivalent to agent.inject).
    injectContext: (entries: readonly ContextEntry[]) => {
      if (typeof handle.injectContext !== 'function') return false
      try {
        return handle.injectContext([...entries]) !== false
      } catch (error) {
        eventLog('warn', 'named-context-inject-failed', error instanceof Error ? error.message : String(error))
        return false
      }
    },
    pushNamedContext: (entries, options) => {
      if (typeof handle.pushNamedContext !== 'function') return 'skipped'
      try {
        return handle.pushNamedContext([...entries], options)
      } catch (error) {
        eventLog('warn', 'named-context-push-failed', error instanceof Error ? error.message : String(error))
        return 'skipped'
      }
    },
    steer: (text: string) => {
      if (typeof handle.steer !== 'function') return false
      try {
        return handle.steer(text)
      } catch (error) {
        eventLog('warn', 'steer-failed', error instanceof Error ? error.message : String(error))
        return false
      }
    },
    ...(handle.resumed !== undefined ? { resumed: handle.resumed } : {}),
    ...(handle.getState !== undefined ? { getState: state } : {}),
    cancel: (cause?: unknown) => {
      try {
        handle.cancel(cause)
      } catch {
        /* best-effort — settlement still lands */
      }
    },
    dispose: () => handle.dispose(),
  }
}

export interface SpellbookSessionsOptions {
  ctx: unknown
  kind?: 'workspace' | 'ephemeral'
  workspaceId?: string
  workspacePath?: string
  /** workspaceId → canonical path; defaults to the card's cwd. */
  resolveWorkspacePath?: (workspaceId: string) => Promise<string | undefined> | string | undefined
  cwd?: string
  /** Inject a loader in tests; defaults to a dynamic import of spellbook. */
  load?: () => Promise<SpellbookSessionsModule>
  log?: (level: 'info' | 'warn', event: string, detail?: unknown) => void
}

async function defaultLoad(): Promise<SpellbookSessionsModule> {
  const specifier = '@meiyukichan/dsh-magica-spellbook'
  try {
    return (await import(specifier)) as unknown as SpellbookSessionsModule
  } catch (error) {
    eventLog('warn', 'spellbook-missing', error instanceof Error ? error.message : String(error))
    return {}
  }
}

/** Explicit option wins, then the host registry, then the card cwd. */
async function resolvePath(
  workspaceId: string | undefined,
  options: SpellbookSessionsOptions,
  fallbackCwd: string | undefined,
): Promise<string | undefined> {
  if (options.workspacePath !== undefined) return options.workspacePath
  if (workspaceId === undefined) return fallbackCwd
  try {
    const resolved = await options.resolveWorkspacePath?.(workspaceId)
    if (resolved !== undefined && resolved !== '') return resolved
  } catch (error) {
    eventLog('warn', 'workspace-path-resolve-failed', error instanceof Error ? error.message : String(error))
  }
  return fallbackCwd
}

function applyStartOptions(
  base: Record<string, unknown>,
  input: StartSessionOptions,
): Record<string, unknown> {
  const model: SessionModel | undefined = input.model ?? input.task.model
  if (model !== undefined) base.model = model
  if (input.task.presetId !== undefined) base.agentPresetId = input.task.presetId
  const permission = input.permission ?? input.task.permission
  if (permission !== undefined) base.permission = permission
  return base
}

/**
 * `undefined` means this environment has no session face; callers should fall back to
 * ledger-only behavior.
 */
export async function createSpellbookSessions(options: SpellbookSessionsOptions): Promise<SessionsFace | undefined> {
  const module = await (options.load ?? defaultLoad)()
  const log = options.log ?? ((): void => {})
  const kind = options.kind ?? 'workspace'
  const runner = kind === 'workspace' ? module.runWorkspaceSession : module.runEphemeralSession
  if (typeof runner !== 'function') {
    log('warn', 'spellbook.session-facade-missing', { kind })
    return undefined
  }

  return {
    /** Ephemeral only: one turn, take the text, discard (router / profiling). */
    startDetached: async input => {
      if (kind !== 'ephemeral') throw new Error('startDetached 只支持临时会话')
      const detached: Record<string, unknown> = {
        prompt: input.prompt,
        title: input.title ?? 'castboard-ephemeral',
        cwd: input.cwd ?? options.cwd,
        contextPlugin: PLUGIN_NAME,
      }
      if (input.sandbox !== undefined) detached.sandbox = input.sandbox
      if (input.context !== undefined && input.context.length > 0) detached.context = [...input.context]
      if (input.sections !== undefined) {
        const setup = makeSetup(input.sections)
        if (setup !== undefined) detached.setup = setup
      }
      const handle = await runner(options.ctx, detached) as HandleLike
      try {
        const settlement = await handle.firstTurn
        return {
          texts: Array.isArray(settlement.texts) ? settlement.texts : [],
          kind: typeof settlement.kind === 'string' ? settlement.kind : (settlement.completed ? 'completed' : 'error'),
        }
      } finally {
        await handle.dispose().catch(() => { /* discarded */ })
      }
    },

    /** Reloads the same sessionId; spellbook uses agents.resume internally. */
    resume: async input => {
      if (kind !== 'workspace') throw new Error('resume 只支持正式会话')
      const workspaceId = options.workspaceId ?? input.task.workspaceId
      const workspacePath = await resolvePath(workspaceId, options, input.task.cwd)
      if (workspaceId === undefined || workspacePath === undefined) {
        throw new Error('续跑正式会话需要 workspaceId / workspacePath')
      }
      const base: Record<string, unknown> = {
        sessionId: input.sessionId,
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        contextPlugin: PLUGIN_NAME,
        workspaceId,
        workspacePath,
        title: input.task.title,
        humanInteraction: {},
      }
      applyStartOptions(base, input)
      if (input.context !== undefined && input.context.length > 0) base.context = [...input.context]
      if (input.sections !== undefined) {
        const setup = makeSetup(input.sections)
        if (setup !== undefined) base.setup = setup
      }
      log('info', 'spellbook.session-resume', {
        task: input.task.id,
        sessionId: input.sessionId,
        context: contextEvidence(input.context),
      })
      const produced = await runner(options.ctx, base)
      return wrapHandle(produced as HandleLike)
    },

    start: async input => {
      const base: Record<string, unknown> = {
        prompt: input.prompt,
        // Context rows must be attributed to this plugin, otherwise the GUI would show
        // another package.
        contextPlugin: PLUGIN_NAME,
        title: input.task.title,
        newSessionId: () => randomUUID(),
      }
      if (input.context !== undefined && input.context.length > 0) base.context = [...input.context]
      if (input.sections !== undefined) {
        const setup = makeSetup(input.sections)
        if (setup !== undefined) base.setup = setup
      }

      let produced: HandleLike
      if (kind === 'workspace') {
        const workspaceId = options.workspaceId ?? input.task.workspaceId
        const workspacePath = await resolvePath(workspaceId, options, input.task.cwd)
        if (workspaceId === undefined || workspacePath === undefined) {
          // A card with no workspace falls back to an ephemeral session: cwd comes from
          // the card directory, then the process cwd. The execution record still lands
          // on the same card; it just does not appear in the GUI session list.
          if (typeof module.runEphemeralSession !== 'function') {
            throw new Error('正式会话需要 workspaceId / workspacePath')
          }
          delete base.workspaceId
          delete base.workspacePath
          delete base.permission
          base.cwd = options.cwd ?? input.task.cwd ?? process.cwd()
          base.sandbox = input.permission ?? input.task.permission ?? 'workspace-write'
          if (input.model !== undefined) base.model = input.model
          else if (input.task.model !== undefined) base.model = input.task.model
          if (input.task.presetId !== undefined) base.agentPresetId = input.task.presetId
          log('warn', 'spellbook.workspace-fallback', { task: input.task.id, cwd: base.cwd })
          produced = await module.runEphemeralSession(options.ctx, base) as HandleLike
          return wrapHandle(produced)
        }
        base.workspaceId = workspaceId
        base.workspacePath = workspacePath
        // The board answers approvals and questions, so let them hang instead of
        // resolving inside the session.
        base.humanInteraction = {}
        applyStartOptions(base, input)
      } else {
        if (input.model !== undefined) base.model = input.model
        else if (input.task.model !== undefined) base.model = input.task.model
        if (input.task.presetId !== undefined) base.agentPresetId = input.task.presetId
        base.cwd = options.cwd ?? input.task.cwd
        base.sandbox = input.permission ?? input.task.permission
        if (base.cwd === undefined) throw new Error('临时会话需要 cwd')
      }
      log('info', 'spellbook.session-start', {
        kind,
        task: input.task.id,
        context: contextEvidence(input.context),
      })
      produced = await runner(options.ctx, base) as HandleLike
      return wrapHandle(produced)
    },
  }
}
