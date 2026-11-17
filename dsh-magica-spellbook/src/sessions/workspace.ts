/**
 * 正式会话门面：挂到 workspace、进 GUI 列表、可选接管人工交互。
 *
 * 与临时会话的差异只在**创建参数**与**生命周期策略**（内核完全共用）。
 *
 * @module dsh-magica-spellbook/sessions/workspace
 */

import {
  applyPermission,
  assertSessionNotLive,
  buildUserMessage,
  composeAgentScope,
  emptyRunState,
  errorMessage,
  installContextDelivery,
  isTurnCompleted,
  pickModel,
  formatDuration,
  releaseRunState,
  resolveAgents,
  resolveAgentPresetId,
  resolvePermission,
  resolveResumeTarget,
  toResumeError,
  runTurnVerified,
  SessionResumeError,
  snapshotRunState,
  type ApprovalRecord,
  toMessages,
  warnLedgerWriteFailure,
  type ContextDeliveryHandle,
  type ObserverHooks,
  type PluginContextEntry,
  type ResumeFailure,
  type SessionRunState,
  type TurnSettlement,
} from './core.ts'
import { getSessionStore, type SessionRecord, type SessionRecordStore } from './store.ts'
import { installApprovalAnswerer, snapshotPendingApprovals, type PendingApproval } from './approval.ts'
import { installQuestionAnswerer, snapshotPendingQuestions, type PendingQuestion } from './questions.ts'
import { getWorkspaceRegistry, normalizeProjectPath, type EnsureWorkspaceOptions } from './ensure-workspace.ts'
import { noteMagicaSession } from '../interactions/ownership.ts'
import { effectOf, serviceOf, asReasoningEffortId, asWorkspaceId } from '../shared/dsh.ts'
import type {
  DshAgentHandleLike,
  DshAgentSetup,
  DshCancelCause,
  DshSessionTitleLike,
  DshTurnEndReason,
  DshUserMessageLike,
} from '../shared/dsh.ts'
import type { SessionPermission } from './ephemeral.ts'

/** 人工交互接管选项。 */
export interface HumanInteractionOptions {
  approvalTimeoutMs?: number
  questionTimeoutMs?: number
}

/** 构造选项。 */
export interface RunWorkspaceSessionOptions {
  sessionId?: string
  newSessionId?: () => string
  workspaceId: string
  /** 必须等于 workspace 的 canonical path（attach 会严格比对会话头 cwd）。 */
  workspacePath: string
  prompt: string | string[]
  title?: string
  contextPlugin?: string
  context?: PluginContextEntry | readonly PluginContextEntry[]
  agentPresetId?: string | false
  setup?: DshAgentSetup
  /** ⚠️ 刻意不支持 `reasoningEffort`（与临时会话不同）。 */
  model?: { provider: string; model: string }
  permission?: SessionPermission
  humanInteraction?: HumanInteractionOptions
  onText?: (text: string) => void
  onTurnEnd?: (reason: DshTurnEndReason, turn: number) => void
  ttlMs?: number
  /** ★ 看门狗：`whenIdle()` 不收敛时的兜底。 */
  idleTimeoutMs?: number
  storeDir?: string
}

/** 对外状态。 */
export interface WorkspaceSessionState {
  running: boolean
  messages: string[]
  done: boolean
  error: string | null
  errorCode?: ResumeFailure
  turnEnds: DshTurnEndReason[]
  outcome?: string
  externallyDisposed: boolean
  disposed: boolean
  resumed: boolean
  attachError?: string
  workspaceAttached: boolean
  ledgerWriteFailed?: boolean
  pendingApprovals: PendingApproval[]
  pendingQuestions: PendingQuestion[]
  /** 审批历史（m.md §13.5：看板要读 `waitedMs` 等，不能只有"待决"）。 */
  approvals: ApprovalRecord[]
  /** 运行期策略/模式快照（l.md:38 明确看板读 `state.sandboxMode`）。 */
  approvalPolicy?: string
  sandboxMode?: string
  planMode?: boolean
}

/** 对外句柄。 */
export type PushMode = 'followup' | 'steer' | 'inject' | 'skipped'

export interface WorkspaceSessionHandle {
  id: string
  resumed: boolean
  firstTurn: Promise<TurnSettlement>
  getState(): WorkspaceSessionState
  followup(message: string | string[]): Promise<TurnSettlement>
  injectContext(entries: PluginContextEntry | readonly PluginContextEntry[]): boolean
  /** 三档投递：idle→followup / running→steer / 其余 inject（S2）。 */
  pushNamedContext(entries: PluginContextEntry | readonly PluginContextEntry[], options?: { wake?: 'idle' | 'always' }): PushMode
  /** 直接插话（不等下一轮，S1）。 */
  steer(message: string | string[]): boolean
  cancel(cause?: DshCancelCause): void
  dispose(): Promise<void>
  wake(): Promise<void>
}

const DEFAULT_CONTEXT_PLUGIN = 'dsh-magica-spellbook'
const MAX_APPROVAL_ARGS_CHARS = 2000

function emptySettlement(): TurnSettlement {
  return { completed: false, texts: [], externallyDisposed: true }
}

function lastSettlement(state: SessionRunState): TurnSettlement {
  const reason = state.turnEnds.length === 0 ? undefined : state.turnEnds[state.turnEnds.length - 1]
  return {
    ...(reason !== undefined ? { reason, kind: reason.kind } : {}),
    completed: isTurnCompleted(reason),
    texts: [],
    externallyDisposed: state.externallyDisposed,
  }
}

/**
 * 跑一个正式会话。
 * @param ctx - 宿主 context。
 * @param options - 见类型。
 */


export function runWorkspaceSession(
  ctx: unknown,
  options: RunWorkspaceSessionOptions,
): WorkspaceSessionHandle {
  const store: SessionRecordStore | null = getSessionStore(ctx, options.storeDir)
  const target = resolveResumeTarget(store, options.sessionId, 'magica-ws', 'workspace', options.newSessionId)
  const sessionId = target.sessionId
  const record: SessionRecord | undefined = target.record
  const resumed = target.resumed
  const workspacePath = normalizeProjectPath(options.workspacePath)

  const contextPlugin = options.contextPlugin ?? DEFAULT_CONTEXT_PLUGIN
  // 模型：调用方显式 → 台账 → dsh 的 agentDefaultModel；都没有就同步抛（不要建出一个没模型的 agent）
  const model = pickModel(ctx, options.model, record)
  const ttlMs = options.ttlMs
  const state = emptyRunState()
  const contexts = toMessages(contextPlugin, options.context)

  let handle: DshAgentHandleLike | null = null

/** 一条具名上下文 → 投递档位。 */

/**
 * 三档投递（把复核报告 §7-S2 收敛进 SDK）。
 *
 * - 会话空闲 → `followup`（起一轮）；
 * - 正在跑 → `steer`（插进最近的 step，不排队等下一轮）；
 * - 状态取不到/已结束 → `inject`（挂进收件箱，等下一次唤醒）。
 */
function pushNamedContextImpl(
  entries: PluginContextEntry | readonly PluginContextEntry[],
  options?: { wake?: 'idle' | 'always' },
): PushMode {
  const messages = toMessages(contextPlugin, entries)
  if (messages.length === 0 || handle === null || disposed) return 'skipped'
  const agent = handle.agent
  const status = agent.status
  if ((options?.wake ?? 'idle') === 'always' || status === 'running') {
    for (const message of messages) agent.steer(message)
    return 'steer'
  }
  if (status === 'idle') {
    for (const message of messages) agent.followup(message)
    return 'followup'
  }
  for (const message of messages) agent.inject(message)
  return 'inject'
}

/** 直接插话（不排队）。 */
function steerImpl(message: string | string[]): boolean {
  if (disposed || handle === null) return false
  const blocks = Array.isArray(message) ? message : [message]
  for (const block of blocks) handle.agent.steer(buildUserMessage(block))
  return true
}

  let unsubscribe: (() => void) | null = null
  let delivery: ContextDeliveryHandle | null = null
  const uninstall: Array<() => void> = []
  const toolCallArgs = new Map<string, string>()
  let mountedPresetId: string | undefined
  let workspaceAttached = false
  let attachError: string | undefined
  let disposed = false
  let disposing: Promise<void> | undefined
  let reattached = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstResult: Promise<TurnSettlement> | null = null
  let turnDone: Promise<void> = Promise.resolve()

  const hooks: ObserverHooks = {
    ...(options.onText !== undefined ? { onText: options.onText } : {}),
    ...(options.onTurnEnd !== undefined ? { onTurnEnd: options.onTurnEnd } : {}),
    // 只在需要人机交互时才记工具入参（否则白占内存）
    ...(options.humanInteraction !== undefined
      ? {
          onToolCall: (callId: string, _toolName: string, args: string) => {
            toolCallArgs.set(callId, args.length > MAX_APPROVAL_ARGS_CHARS ? `${args.slice(0, MAX_APPROVAL_ARGS_CHARS)}…` : args)
          },
          onToolResult: (callId: string) => {
            toolCallArgs.delete(callId)
          },
        }
      : {}),
  }

  function makeSetup(): DshAgentSetup {
    return async (agentCtx) => {
      const composition = await composeAgentScope({
        ctx,
        agentCtx,
        sessionId,
        state,
        hooks,
        presetId: options.agentPresetId,
        userSetup: options.setup,
      })
      unsubscribe = composition.unsubscribe
      if (composition.presetId !== undefined) mountedPresetId = composition.presetId
      if (!reattached) {
        // 续跑也要投调用方 context（D14）：旧实现 `workspace.ts:566` 是总投——
        // "续跑传 context" 的语义就是"给唤醒轮一批新上下文"，丢掉等于调用方白传。
        delivery = installContextDelivery(agentCtx, contexts)
      }
      return composition.commit
    }
  }

  async function createAgent(agents: ReturnType<typeof resolveAgents>): Promise<DshAgentHandleLike> {
    // 续跑优先沿用台账里的 preset（D15）：旧实现 `workspace.ts:452` 的设计约束是
    // 「默认 preset 后来被改了，不该把老会话的工具集换掉」。
    const remembered =
      options.agentPresetId === undefined && resumed && record?.agentPresetId !== undefined
        ? (record.agentPresetId as string)
        : undefined
    let presetId = options.agentPresetId ?? remembered
    if (presetId !== false) presetId = await resolveAgentPresetId(ctx, presetId)
    return agents.create({
      sessionId,
      meta: {
        cwd: workspacePath,
        ...(typeof presetId === 'string' ? { agentPreset: presetId } : {}),
      },
      agentOptions: {
        provider: model.provider,
        model: model.model,
        // 公开选项不暴露 reasoningEffort，但 dsh 默认选择里的值要透传下去
        ...(model.reasoningEffort !== undefined
          ? { reasoningEffort: asReasoningEffortId(model.reasoningEffort) }
          : {}),
      },
      setup: makeSetup(),
    })
  }

  async function resumeAgent(agents: ReturnType<typeof resolveAgents>): Promise<DshAgentHandleLike> {
    assertSessionNotLive(agents, sessionId)
    if (record?.customSetup === true && options.setup === undefined) {
      throw new SessionResumeError(
        'SESSION_SETUP_REQUIRED',
        `${sessionId} was created with a custom setup; pass the same \`setup\` again to resume `
          + '(closures cannot be stored in the ledger)',
      )
    }
    return agents.resume({
      resumeSessionId: sessionId,
      agentOptions: {
        provider: model.provider,
        model: model.model,
        ...(model.reasoningEffort !== undefined
          ? { reasoningEffort: asReasoningEffortId(model.reasoningEffort) }
          : {}),
      },
      setup: makeSetup(),
    }).catch((error: unknown) => {
      // 与临时门面一致：把 "already owned by an active write handle" 之类归一成结构化 code
      throw toResumeError(error, sessionId)
    })
  }

  async function attachToWorkspace(): Promise<void> {
    const registry = getWorkspaceRegistry(ctx)
    if (registry === undefined) {
      attachError = 'workspaceRegistry service unavailable'
      return
    }
    const workspace = registry.get(asWorkspaceId(options.workspaceId))
    if (workspace === undefined) {
      attachError = `workspace "${options.workspaceId}" not found in registry`
      return
    }
    if (typeof workspace.attachSession !== 'function') {
      // 没有 attach 能力就别谎报"已挂进 GUI 列表"（l.md:292 只在成功后置位）
      attachError = 'workspace has no attachSession()'
      return
    }
    try {
      await workspace.attachSession(sessionId)
      workspaceAttached = true
      attachError = undefined
    } catch (error) {
      attachError = errorMessage(error)
    }
  }

  function writeRecord(): void {
    if (store === null) return
    try {
      store.put({
        sessionId,
        kind: 'workspace',
        createdAt: record?.createdAt ?? Date.now(),
        model,
        ...(options.permission !== undefined
          ? { permission: options.permission }
          : record?.permission !== undefined
            ? { permission: record.permission }
            : {}),
        workspaceId: options.workspaceId,
        workspacePath,
        ...(mountedPresetId !== undefined
          ? { agentPresetId: mountedPresetId }
          : typeof options.agentPresetId === 'string'
            ? { agentPresetId: options.agentPresetId }
            : {}),
        ...(options.title !== undefined
          ? { title: options.title }
          : record?.title !== undefined
            ? { title: record.title }
            : {}),
        ...(options.setup !== undefined ? { customSetup: true } : {}),
      })
      noteMagicaSession(sessionId, options.storeDir)
    } catch (error) {
      state.ledgerWriteFailed = true
      warnLedgerWriteFailure(ctx, `ledger write failed for ${sessionId}: ${errorMessage(error)}`)
    }
  }

  function installInteractionHandlers(): void {
    if (options.humanInteraction === undefined) return
    const { approvalTimeoutMs, questionTimeoutMs } = options.humanInteraction
    uninstall.push(
      installApprovalAnswerer(
        ctx,
        sessionId,
        approvalTimeoutMs === undefined ? {} : { timeoutMs: approvalTimeoutMs },
        (callId) => (callId === undefined ? undefined : toolCallArgs.get(callId)),
      ),
      installQuestionAnswerer(
        ctx,
        sessionId,
        questionTimeoutMs === undefined ? {} : { timeoutMs: questionTimeoutMs },
      ),
    )
  }

  function pinTitle(): void {
    if (options.title === undefined || handle === null) return
    const titles = serviceOf<DshSessionTitleLike>(ctx, 'sessionTitle')
    try {
      titles?.rename?.(handle.agent.session, options.title)
    } catch {
      // cosmetic：标题钉不住不影响任务
    }
  }

  function stopTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function startTimer(): void {
    stopTimer()
    if (ttlMs === undefined || !(ttlMs > 0)) return
    timer = setTimeout(() => {
      timer = null
      if (disposed) return
      state.running = false
      state.done = true
      state.error = `会话超时（${formatDuration(ttlMs)}未完成）`
      void dispose()
    }, ttlMs)
    timer.unref?.()
  }

  async function runOneTurn(
    message: DshUserMessageLike | undefined,
    alreadyDelivered: boolean,
  ): Promise<TurnSettlement> {
    if (disposed || handle === null) throw new Error('session disposed or agent not ready')
    startTimer()
    try {
      return await runTurnVerified(handle, state, message, alreadyDelivered, options.idleTimeoutMs)
    } finally {
      stopTimer()
    }
  }

  async function startFirstTurn(): Promise<TurnSettlement> {
    const agents = resolveAgents(ctx)
    handle = resumed ? await resumeAgent(agents) : await createAgent(agents)
    if (disposed) {
      try {
        await (handle as DshAgentHandleLike).dispose()
      } catch {
        // 已释放
      }
      return emptySettlement()
    }
    const agent = handle.agent
    installInteractionHandlers()
    await attachToWorkspace()
    if (!resumed || options.permission !== undefined) {
      const applied = applyPermission(ctx, agent.session, resolvePermission(ctx, options.permission))
      if (applied === 'none') {
        warnLedgerWriteFailure(
          ctx,
          `permission "${options.permission ?? ''}" was not applied to ${sessionId}; `
            + 'the session runs with the composition default sandbox',
        )
      }
    }
    pinTitle()
    writeRecord()
    const settlement = await runOneTurn(buildUserMessage(options.prompt), false)
    if (!disposed) {
      state.running = false
      state.done = true
    }
    return settlement
  }

  function ensureFirstTurn(): Promise<TurnSettlement> {
    firstResult ??= startFirstTurn().catch((error: unknown) => {
      state.running = false
      state.done = true
      state.error = errorMessage(error)
      if (error instanceof SessionResumeError) state.errorCode = error.code
      return lastSettlement(state)
    })
    return firstResult
  }

  async function runDispose(): Promise<void> {
    disposed = true
    stopTimer()
    for (const off of uninstall.splice(0, uninstall.length)) {
      try {
        off()
      } catch {
        // 已注销
      }
    }
    toolCallArgs.clear()
    try {
      unsubscribe?.()
    } catch {
      // 已注销
    }
    // 投递器 dispose 也要容错（D16）：它抛错会中断 runDispose 后面的
    // unsubscribe / handle.dispose，表现为"会话关不干净"
    try {
      delivery?.dispose()
    } catch {
      // best-effort
    }
    delivery = null
    state.running = false
    state.done = true
    const current = handle
    handle = null
    if (current !== null) {
      try {
        await current.dispose()
      } catch {
        // best-effort
      }
    }
    releaseRunState(state)
  }

  async function dispose(): Promise<void> {
    if (disposed) {
      if (disposing !== undefined) await disposing
      return
    }
    disposing = runDispose()
    try {
      await disposing
    } finally {
      disposing = undefined
    }
  }

  async function wake(): Promise<void> {
    if (!disposed) return
    if (disposing !== undefined) await disposing
    const agents = resolveAgents(ctx)
    reattached = true
    disposed = false
    let revived: DshAgentHandleLike
    try {
      revived = await resumeAgent(agents)
    } catch (error) {
      disposed = true
      throw error
    }
    if (disposed) {
      try {
        await revived.dispose()
      } catch {
        // 已释放
      }
      return
    }
    handle = revived
    state.disposed = false
    state.done = false
    state.error = null
    installInteractionHandlers()
    await attachToWorkspace()
    writeRecord()
  }

  function followup(message: string | string[]): Promise<TurnSettlement> {
    // 首轮必须先落定（D13）：早前 `turnDone` 初值是已 resolve 的空 Promise，
    // firstTurn 又从不接进来 → "建会话后不 await 直接 followup" 会并发跑两个 turn。
    // 旧实现 `workspace.ts:767` 是把 turnDone 挂在 firstTurn 之后，这里等价地先等首轮。
    const previous = turnDone.then(() => ensureFirstTurn().then(() => undefined, () => undefined))
    const mine = previous.then(async () => {
      if (disposed) throw new Error('session disposed')
      if (handle === null) throw new Error('agent handle not created yet')
      if (state.error !== null) throw new Error(`previous turn errored: ${state.error}`)
      state.running = true
      state.done = false
      try {
        return await runOneTurn(buildUserMessage(message), false)
      } catch (error) {
        if (!disposed) {
          state.running = false
          state.done = true
          state.error = errorMessage(error)
        }
        throw error
      } finally {
        if (!disposed) {
          state.running = false
          state.done = true
        }
      }
    })
    turnDone = mine.then(
      () => undefined,
      () => undefined,
    )
    return mine
  }

  const firstTurn = ensureFirstTurn()

  // 插件卸载（fiber inactive）时自动 dispose：否则 agent handle / observers / 投递器 / workspace 挂载全泄漏。
  effectOf(ctx, () => () => {
    void dispose()
  }, 'magica:workspace:dispose')

  return {
    id: sessionId,
    resumed,
    firstTurn,
    getState(): WorkspaceSessionState {
      const snapshot = snapshotRunState(state)
      return {
        running: snapshot.running,
        messages: snapshot.messages,
        done: snapshot.done,
        error: snapshot.error,
        ...(snapshot.errorCode !== undefined ? { errorCode: snapshot.errorCode } : {}),
        turnEnds: snapshot.turnEnds,
        ...(snapshot.outcome !== undefined ? { outcome: snapshot.outcome } : {}),
        externallyDisposed: snapshot.externallyDisposed,
        disposed: snapshot.disposed,
        resumed,
        workspaceAttached,
        ...(attachError !== undefined ? { attachError } : {}),
        ...(snapshot.ledgerWriteFailed !== undefined ? { ledgerWriteFailed: snapshot.ledgerWriteFailed } : {}),
        pendingApprovals: snapshotPendingApprovals(sessionId),
        pendingQuestions: snapshotPendingQuestions(sessionId),
        approvals: snapshot.approvals,
        ...(snapshot.approvalPolicy !== undefined ? { approvalPolicy: snapshot.approvalPolicy } : {}),
        ...(snapshot.sandboxMode !== undefined ? { sandboxMode: snapshot.sandboxMode } : {}),
        ...(snapshot.planMode !== undefined ? { planMode: snapshot.planMode } : {}),
      }
    },
    followup,
    injectContext(entries) {
      const messages = toMessages(contextPlugin, entries)
      if (delivery === null || messages.length === 0) return false
      delivery.push(messages)
      return true
    },
    pushNamedContext(entries, options) {
      return pushNamedContextImpl(entries, options)
    },
    steer(message) {
      return steerImpl(message)
    },
    cancel(cause: DshCancelCause = { kind: 'hook', reason: 'magica:cancel' }) {
      if (disposed || handle === null) return
      try {
        handle.agent.cancel(cause, { keepInbox: true })
      } catch {
        // 已结束
      }
    },
    dispose,
    wake,
  }
}

/** 供调用方在挂载前确保 workspace 存在（薄包装，便于一处 import）。 */
export async function ensureWorkspaceForSession(
  ctx: unknown,
  projectPath: string,
  options?: EnsureWorkspaceOptions,
): Promise<string | undefined> {
  const { ensureWorkspace } = await import('./ensure-workspace.ts')
  const workspace = await ensureWorkspace(ctx, projectPath, options)
  return workspace?.id
}
