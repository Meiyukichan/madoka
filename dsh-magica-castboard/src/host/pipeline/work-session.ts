/**
 * Common wrapper for resident temporary sessions: one host session handle plus a fixed "run one turn" posture.
 *
 * Two use cases share it:
 *
 * | Use | cwd | Sandbox | Static guidance |
 * |---|---|---|---|
 * | Pending issue to card | `worklabs` | `read-only` | `castboard-issue-routing` |
 * | Project portrait | `worklabs/workspaces` | `workspace-write` | `castboard-project-portrait` |
 *
 * ## Why static guidance travels on two legs
 *
 * 1. Injected when the session is created as named plugin context -- its name is visible in the GUI's "context injection" row;
 * 2. Registered in `setup` as an agent-scoped system prompt section -- it follows the system prompt and returns
 *    automatically when the prompt is rebuilt after compaction, which plugin context cannot do.
 *
 * The only cost is one extra copy on the first turn, in exchange for "visible + durable".
 *
 * ## Turn order (deliberate)
 *
 * 1. `followup(instruction)` pushes the user message to the agent synchronously -- it must not be awaited; its promise
 *    resolves only at this turn's `turn/end`, so an awaited push would miss this step;
 * 2. `injectContext(contexts)` immediately queues dynamic data at the end of the next step's message;
 * 3. Then await that turn's settlement.
 *
 * Session ids are minted by the host session facade (standard UUIDs); this module does not generate them or assume
 * any external naming shape.
 *
 * @module dsh-magica-castboard/host/pipeline/work-session
 */
import { eventLog } from '../shared/event-log.ts'
import { mkdir } from 'node:fs/promises'

import type {
  EphemeralSessionHandle,
  SessionPermission,
  SessionQuiescenceOptions,
  TurnSettlement,
} from '@meiyukichan/dsh-magica-spellbook'

import type { ResolvedModel } from '../shared/default-model.ts'
import { ISSUE_ROUTING_SECTION } from '../context/sections.ts'

export interface WorkContext {
  readonly name: string
  readonly text: string
}

export type WorkTurnResult = { ok: true } | { ok: false; error: string }

export interface WorkSessionFace {
  /** Session id, possibly different from the one passed in. */
  readonly id: string
  readonly resumed: boolean
  /**
   * Run one turn: send the instruction, queue contexts, then await settlement.
   */
  run(instruction: string, contexts?: readonly WorkContext[]): Promise<WorkTurnResult>
  dispose(): Promise<void>
}

/** Static guidance section: goes into both the system prompt section and the first turn's named context. */
export interface WorkSection extends WorkContext {
  /** System prompt section order (tool guidance convention uses 100-199). */
  readonly order: number
}

/**
 * Per-turn limit for resident sessions: 2 hours.
 *
 * These sessions do heavy work ("read a large repository, then produce output"), so a turn taking several minutes is
 * normal and a very large project can take longer; 30 minutes would cut a turn into a "timeout failure" and restarting
 * wastes more. The limit cannot stay fully off either: an unattended turn that hangs would silently hold a serial slot and stall the pipeline.
 */
export const DEFAULT_WORK_TTL_MS = 2 * 60 * 60_000

/** Value meaning "no limit" (the facade treats `<= 0` that way). */
export const NO_TTL = 0

export function workSessionTtlMs(envName: string, env: Record<string, string | undefined> = process.env): number {
  const value = env[envName]
  if (value === undefined || value.trim() === '') return DEFAULT_WORK_TTL_MS
  const text = value.trim().toLowerCase()
  if (text === 'off' || text === 'false' || text === 'no') return NO_TTL
  const parsed = Number(text)
  if (!Number.isFinite(parsed)) return DEFAULT_WORK_TTL_MS
  return parsed <= 0 ? NO_TTL : Math.floor(parsed)
}

export interface WorkSessionOptions {
  readonly label: string
  /** Session cwd (must really exist; this function will mkdir it). */
  readonly cwd: string
  readonly sandbox: SessionPermission
  readonly sessionId?: string
  /** Display title pinned on create and every resume; omitted = leave the DSH title untouched. */
  readonly title?: string
  readonly idlePrompt: string
  readonly sections?: readonly WorkSection[]
  /** Model route; `undefined` = omit it (the driver fails on persona interpolation, so always resolve it). */
  readonly model?: ResolvedModel
  readonly contextPlugin: string
  readonly ttlMs?: number
  /** Quiescence window after each turn; omitted = spellbook defaults (10 min, 5 s poll). */
  readonly quiescence?: SessionQuiescenceOptions
  /**
   * Callback for when this session compacts its context -- the caller uses it to replace the session (dispose the current one, create anew next time).
   *
   * The listener is mounted only on the session's own agent scope: host event dispatch sends only this agent's session
   * events there, so no sessionId filter is needed and another session cannot trigger it by mistake.
   */
  readonly onCompacted?: () => void
}

function logWork(level: 'info' | 'warn', event: string, detail: string): void {
  eventLog(level, event, detail)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Best-effort session title pin; title is cosmetic and must never fail session startup. */
function pinSessionTitle(ctx: unknown, sessionId: string, title: string | undefined): void {
  if (title === undefined || title === '') return
  try {
    const scope = ctx as { get?: (name: string) => unknown }
    const sessions = scope.get?.('sessions') as { get?: (id: string) => unknown } | undefined
    const session = sessions?.get?.(sessionId)
    const titles = scope.get?.('sessionTitle') as
      | { rename?: (session: unknown, title: string) => void }
      | undefined
    if (session !== undefined && titles?.rename !== undefined) titles.rename(session, title)
  } catch {
    // Session title is presentation-only; ignore capability or version mismatches.
  }
}

/** Narrow face of an agent scope: just enough to mount system prompt sections and session events. */
interface AgentScopeLike {
  get?: (name: string) => unknown
  on?: (name: string, listener: (session: unknown, event: unknown) => void) => unknown
}

interface SystemPromptLike {
  section?: (section: { name: string; order: number; text: string }) => unknown
}

interface SpawnOptions {
  sessionId?: string
  cwd: string
  prompt?: string
  sandbox: SessionPermission
  contextPlugin: string
  ttlMs: number
  model?: ResolvedModel
  context?: readonly WorkContext[]
  setup: (agentCtx: unknown) => Promise<undefined>
}

/**
 * Get the host session facade and create a session.
 *
 * The module is loaded at call time: without a host session SDK the plugin still starts and only session creation
 * fails (the caller applies its own backoff), instead of the entire plugin failing to load.
 */
async function spawnSession(ctx: unknown, options: SpawnOptions): Promise<EphemeralSessionHandle> {
  const module = await import('@meiyukichan/dsh-magica-spellbook')
  const spawn = module.runEphemeralSession as unknown as
    | ((context: unknown, input: SpawnOptions) => EphemeralSessionHandle)
    | undefined
  if (typeof spawn !== 'function') throw new Error('宿主会话门面不可用：缺少临时会话入口')
  return spawn(ctx, options)
}

export async function openWorkSession(ctx: unknown, options: WorkSessionOptions): Promise<WorkSessionFace> {
  const { label } = options
  await mkdir(options.cwd, { recursive: true }).catch(() => { /* If creation fails, the session facade reports it */ })
  const sections = options.sections ?? []
  const model = options.model
  logWork('info', `${label}-session-opening`,
    `${options.sessionId === undefined ? '新建' : `续跑 ${options.sessionId}`}`
    + `，cwd=${options.cwd}，sandbox=${options.sandbox}`
    + `，model=${model === undefined ? '（未解析到，将不带模型）' : `${model.provider}/${model.model}`}`)

  /**
   * Deregister function for the "this session finished compacting" listener.
   *
   * The listener is mounted on the agent scope (not the host's global session events); `setup` runs again when
   * resuming, so the existing one is removed before installing a new one. `dispose()` removes it again regardless.
   */
  let offCompaction: () => void = () => { /* not installed yet */ }

  const handle: EphemeralSessionHandle = await spawnSession(ctx, {
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    cwd: options.cwd,
    prompt: options.idlePrompt,
    sandbox: options.sandbox,
    contextPlugin: options.contextPlugin,
    ttlMs: options.ttlMs ?? DEFAULT_WORK_TTL_MS,
    // The model is mandatory: the session facade does not fill in a default, and without it the system prompt's
    // model interpolation throws and the agent cannot be created at all.
    ...(model !== undefined ? { model } : {}),
    // First leg of static guidance: named plugin context (visible in the GUI).
    ...(sections.length > 0 ? { context: sections.map(section => ({ name: section.name, text: section.text })) } : {}),
    // Second leg of static guidance: agent-scoped system prompt section (survives a post-compaction rebuild).
    setup: async (agentCtx): Promise<undefined> => {
      const scope = agentCtx as unknown as AgentScopeLike
      try {
        const prompt = scope.get?.('systemPrompt') as SystemPromptLike | undefined
        if (prompt?.section === undefined) {
          logWork('warn', `${label}-section-unavailable`, 'agent scope 里取不到 systemPrompt.section，静态指导未注入')
        } else {
          for (const section of sections) {
            prompt.section({ name: section.name, order: section.order, text: section.text })
          }
          logWork('info', `${label}-section-mounted`,
            sections.map(section => `${section.name} @order ${String(section.order)}`).join('、'))
        }
      } catch (error) {
        // A failed registration must not block the session: it can run without guidance instead of dispatching nothing.
        logWork('warn', `${label}-section-failed`, `注册静态指导失败（会话照常跑）：${errorText(error)}`)
      }
      if (options.onCompacted !== undefined) {
        offCompaction()
        offCompaction = () => { /* fall back to a no-op if the new mount fails */ }
        try {
          if (typeof scope.on !== 'function') {
            logWork('warn', `${label}-compaction-watch-unavailable`,
              'agent scope 不支持 on()，压缩后不会自动换会话（长跑可能累积内存）')
          } else {
            const off = scope.on('session/event', (_session, event) => {
              // Use only the "compaction ended" point: swapping sessions during start/summary would interrupt compaction.
              if ((event as { type?: unknown } | undefined)?.type !== 'compaction/end') return
              logWork('info', `${label}-compaction-detected`, '本会话的上下文压缩已完成，通知调用方换会话')
              options.onCompacted?.()
            })
            offCompaction = () => {
              try {
                if (typeof off === 'function') (off as () => void)()
              } catch { /* already removed */ }
            }
            logWork('info', `${label}-compaction-watched`, '压缩落地后换新会话（监听装在本会话的 agent scope 上）')
          }
        } catch (error) {
          logWork('warn', `${label}-compaction-watch-failed`, `装压缩监听失败（会话照常跑）：${errorText(error)}`)
        }
      }
      // Return nothing: the host setup contract is `void | commit`, and there is nothing to commit here.
      return undefined
    },
  })

  // Warm-up turn: only brings the session up. Failure is not fatal -- the real failure will surface in the dispatch
  // turn, which carries this turn's target and therefore more useful information.
  const first: TurnSettlement = await handle.firstTurn
  if (!first.completed) {
    const state = handle.getState()
    logWork('warn', `${label}-warmup-incomplete`,
      `reason=${JSON.stringify(first.reason ?? null).slice(0, 400)}`
      + `，errorCode=${state.errorCode ?? 'none'}，error=${state.error ?? 'none'}`)
    if (state.errorCode === 'SESSION_LIVE') {
      // A live session cannot be taken over by this process; the caller drops the
      // saved id and creates a fresh session on the next tick.
      await handle.dispose().catch(() => { /* best-effort */ })
      const error = new Error(`session "${handle.id}" is still live; retry resume after it is released`)
      Object.assign(error, { code: 'SESSION_LIVE' })
      throw error
    }
  }
  pinSessionTitle(ctx, handle.id, options.title)
  logWork('info', `${label}-session-ready`, `${handle.id}（${handle.resumed ? '续跑' : '新建'}）`)

  return {
    id: handle.id,
    resumed: handle.resumed,
    async run(instruction, contexts) {
      // Combine the router instruction and its references into one named-context wake,
      // the same shape as a task acceptance round: one "收到执行请求" event, no separate
      // user bubble plus injected context.
      const entries = [
        { name: ISSUE_ROUTING_SECTION, text: instruction },
        ...(contexts ?? []).map(entry => ({ name: entry.name, text: entry.text })),
      ]
      // One named-context message, not one per section: the GUI shows a single
      // "收到执行请求" event and the model still receives instruction + references.
      const combined = {
        name: ISSUE_ROUTING_SECTION,
        text: entries.map(entry => entry.text).join('\n\n'),
      }
      const settlement = await handle.followupNamedContext([combined])
      if (settlement.completed && typeof handle.waitForQuiescence === 'function') {
        // The parent turn may settle while a reading subagent is still running.
        // Wait for the whole descendant tree to go quiet before the caller injects
        // the next project/issue into this same session.
        const quiet = await handle.waitForQuiescence(options.quiescence)
        if (!quiet) {
          logWork('warn', `${label}-quiescence-timeout`, '主 turn 已结束，但子代理在超时内仍未全部静默')
        }
      }
      if (!settlement.completed) {
        const state = handle.getState()
        return {
          ok: false as const,
          error: `本轮未正常结束：reason=${JSON.stringify(settlement.reason ?? null).slice(0, 400)}`
            + `，error=${state.error ?? 'none'}`,
        }
      }
      return { ok: true as const }
    },
    async dispose() {
      offCompaction()
      await handle.dispose()
    },
  }
}
