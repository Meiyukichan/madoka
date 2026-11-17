/**
 * 临时会话门面：跑一个一次性、未分组、跑完就丢的会话。
 *
 * 与正式会话的三处刻意差异：不 attach workspace；`cwd` 由调用方随便给；
 * 沙箱缺省**固定** `workspace-write`（不跟随 GUI 全局默认，才可预期）。
 *
 * @module dsh-magica-spellbook/sessions/ephemeral
 */

import {
  applyPermission,
  buildPluginMessage,
  buildUserMessage,
  composeAgentScope,
  emptyRunState,
  installContextDelivery,
  isTurnCompleted,
  pickModel,
  formatDuration,
  releaseRunState,
  resolveAgents,
  resolveAgentPresetId,
  resolvePermission,
  resolveResumeTarget,
  assertSessionNotLive,
  toResumeError,
  runTurnVerified,
  SessionResumeError,
  snapshotRunState,
  type ApprovalRecord,
  toMessages,
  warnLedgerWriteFailure,
  errorMessage,
  type ContextDeliveryHandle,
  type ObserverHooks,
  type PluginContextEntry,
  type ResolvedModel,
  type ResumeFailure,
  type SessionRunState,
  type TurnSettlement,
} from './core.ts'
import {
  getSessionStore,
  type SessionRecord,
  type SessionRecordStore,
} from './store.ts'
import { installFailFastAnswerer, snapshotPendingApprovals } from './approval.ts'
import { effectOf, asReasoningEffortId } from '../shared/dsh.ts'
import { installFailFastQuestionAnswerer, snapshotPendingQuestions } from './questions.ts'
import { noteMagicaSession } from '../interactions/ownership.ts'
import type {
  DshAgentHandleLike,
  DshAgentSetup,
  DshCancelCause,
  DshSandboxMode,
  DshTurnEndReason,
  DshUserMessageLike,
} from '../shared/dsh.ts'

/** 临时会话的模型路由（支持 `reasoningEffort`，正式会话刻意不支持）。 */
export interface EphemeralModel {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 权限名（= dsh 的 `SandboxMode`，从 `PresetSpec` 转出，不另抄一份联合）。 */
export type SessionPermission = DshSandboxMode

/** 默认沙箱。 */
export const DEFAULT_SANDBOX: SessionPermission = 'workspace-write'

/** 默认 TTL：30 分钟。 */
export const DEFAULT_TTL_MS = 30 * 60_000

/** `noInteraction` 默认注入的插件规则。 */
export const NO_INTERACTION_PREFIX = '禁止向用户提问，直接完成/回答。'

/** 默认上下文署名。 */
const DEFAULT_CONTEXT_PLUGIN = 'dsh-magica-spellbook'

/** 构造选项。 */
export interface RunEphemeralSessionOptions {
  sessionId?: string
  newSessionId?: () => string
  contextPlugin?: string
  cwd: string
  prompt: string | string[]
  context?: PluginContextEntry | readonly PluginContextEntry[]
  agentPresetId?: string | false
  setup?: DshAgentSetup
  model?: EphemeralModel
  sandbox?: SessionPermission
  onText?: (text: string) => void
  onTurnEnd?: (reason: DshTurnEndReason, turn: number) => void
  ttlMs?: number
  /** ★ 看门狗：`whenIdle()` 不收敛时的兜底（0.1.6 有能力但门面没传）。 */
  idleTimeoutMs?: number
  noInteraction?: boolean
  storeDir?: string
}

/** 对外状态。 */
export interface EphemeralSessionState {
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
  ledgerWriteFailed?: boolean
  /** 临时会话永远装 fail-fast，所以恒为空数组。 */
  pendingApprovals: readonly never[]
  pendingQuestions: readonly never[]
  /** 审批历史（与正式门面同形：看板两处读法一致）。 */
  approvals: ApprovalRecord[]
  approvalPolicy?: string
  sandboxMode?: string
  planMode?: boolean
}

/** 对外句柄。 */
export interface EphemeralSessionHandle {
  id: string
  resumed: boolean
  firstTurn: Promise<TurnSettlement>
  getState(): EphemeralSessionState
  followup(message: string | string[]): Promise<TurnSettlement>
  injectContext(entries: PluginContextEntry | readonly PluginContextEntry[]): boolean
  cancel(cause?: DshCancelCause): void
  dispose(): Promise<void>
  wake(): Promise<void>
}

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
 * 跑一个临时会话。
 * @param ctx - 宿主 context（库不 inject，全部走 `ctx.get`）。
 * @param options - 见类型。
 */
/** 时长文案（定义在 core，两个门面共用）。 */
/** 时长文案：小于 1 分钟说毫秒/秒，避免 `Math.round(120/60000)=0` 写成「0 分钟」。 */

export function runEphemeralSession(ctx: unknown, options: RunEphemeralSessionOptions): EphemeralSessionHandle {
  const store: SessionRecordStore | null = getSessionStore(ctx, options.storeDir)
  const target = resolveResumeTarget(store, options.sessionId, 'magica', 'ephemeral', options.newSessionId)
  const sessionId = target.sessionId
  const record: SessionRecord | undefined = target.record
  const resumed = target.resumed

  const contextPlugin = options.contextPlugin ?? DEFAULT_CONTEXT_PLUGIN
  const sandbox = options.sandbox ?? (record?.permission as SessionPermission | undefined) ?? DEFAULT_SANDBOX
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  // 模型：调用方显式 → 台账 → dsh 的 agentDefaultModel；都没有就同步抛（不要建出一个没模型的 agent）
  const model = pickModel(ctx, options.model, record)

  const state = emptyRunState()
  const contexts: DshUserMessageLike[] = [
    ...toMessages(contextPlugin, options.context),
    ...((options.noInteraction ?? true) ? [buildPluginMessage(contextPlugin, NO_INTERACTION_PREFIX)] : []),
  ]

  let handle: DshAgentHandleLike | null = null
  let unsubscribe: (() => void) | null = null
  let delivery: ContextDeliveryHandle | null = null
  let mountedPresetId: string | undefined
  const uninstall: Array<() => void> = []
  let disposed = false
  let reattached = false
  let disposing: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstResult: Promise<TurnSettlement> | null = null
  let turnDone: Promise<void> = Promise.resolve()

  const hooks: ObserverHooks = {
    ...(options.onText !== undefined ? { onText: options.onText } : {}),
    ...(options.onTurnEnd !== undefined ? { onTurnEnd: options.onTurnEnd } : {}),
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
      // 投递器必须**常驻安装**（D11-2 / 旧实现 `ephemeral.ts:461`）：wake 之后
      // `injectContext` 还要能用。早前用 `if (!reattached)` 跳过安装，结果 wake 过的
      // 临时会话 injectContext 恒 false。续跑/wake 时初始队列传空（context 已消费过）。
      if (delivery === null) {
        delivery = installContextDelivery(agentCtx, resumed || reattached ? [] : contexts)
      }
      return composition.commit
    }
  }

  async function createAgent(agents: ReturnType<typeof resolveAgents>): Promise<DshAgentHandleLike> {
    let presetId = options.agentPresetId
    if (presetId !== false) presetId = await resolveAgentPresetId(ctx, presetId)
    const created = await agents.create({
      sessionId,
      meta: {
        cwd: options.cwd,
        ...(typeof presetId === 'string' ? { agentPreset: presetId } : {}),
      },
      agentOptions: {
        provider: model.provider,
        model: model.model,
        ...(model.reasoningEffort !== undefined
          ? { reasoningEffort: asReasoningEffortId(model.reasoningEffort) }
          : {}),
      },
      setup: makeSetup(),
    })
    return created
  }

  async function resumeAgent(agents: ReturnType<typeof resolveAgents>): Promise<DshAgentHandleLike> {
    if (record?.customSetup === true && options.setup === undefined) {
      throw new SessionResumeError(
        'SESSION_SETUP_REQUIRED',
        `${sessionId} was created with a custom setup; pass the same \`setup\` again to resume `
          + '(closures cannot be stored in the ledger)',
      )
    }
    // 早期预检（C22）：会话还活着就直接给 `SESSION_LIVE`，别等 dsh 抛出再归一
    assertSessionNotLive(agents, sessionId)
    try {
      return await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: {
          provider: model.provider,
          model: model.model,
          ...(model.reasoningEffort !== undefined
            ? { reasoningEffort: asReasoningEffortId(model.reasoningEffort) }
            : {}),
        },
        setup: makeSetup(),
      })
    } catch (error) {
      // 归一化：dsh 抛的 "already owned by an active write handle" 之类要带上结构化 code，
      // 否则调用方只能读字符串（真机回归：曾经 errorCode 恒为 undefined）
      throw toResumeError(error, sessionId)
    }
  }

  function writeRecord(mountedPresetId?: string): void {
    if (store === null) return
    try {
      store.put({
        sessionId,
        kind: 'ephemeral',
        createdAt: record?.createdAt ?? Date.now(),
        model,
        // 调用方显式传的优先（l.md:488-489「options 优先」）；没传才沿用台账原值。
        // 早前是台账优先：续跑传了 sandbox 会真应用到会话，但台账写旧值 → 长期漂移。
        permission: sandbox ?? (resumed ? record?.permission : undefined),
        cwd: options.cwd ?? (resumed ? record?.cwd : undefined),
        ...(mountedPresetId !== undefined
          ? { agentPresetId: mountedPresetId }
          : typeof options.agentPresetId === 'string'
            ? { agentPresetId: options.agentPresetId }
            : record?.agentPresetId !== undefined
              ? { agentPresetId: record.agentPresetId }
              : {}),
        ...(options.setup !== undefined ? { customSetup: true } : {}),
      })
      noteMagicaSession(sessionId, options.storeDir)
    } catch (error) {
      state.ledgerWriteFailed = true
      warnLedgerWriteFailure(ctx, `ledger write failed for ${sessionId}: ${errorMessage(error)}`)
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
    if (!(ttlMs > 0)) return
    timer = setTimeout(() => {
      timer = null
      if (disposed) return
      state.running = false
      state.done = true
      state.error = `临时会话超时（${formatDuration(ttlMs)}未完成）`
      void dispose()
    }, ttlMs)
    timer.unref?.()
  }

  async function runOneTurn(message: DshUserMessageLike | undefined, alreadyDelivered: boolean): Promise<TurnSettlement> {
    if (disposed || handle === null) throw new Error('session disposed or agent not ready')
    startTimer()
    try {
      return await runTurnVerified(handle, state, message, alreadyDelivered, options.idleTimeoutMs)
    } finally {
      stopTimer()
    }
  }

  /**
   * 装 fail-fast 应答器。
   *
   * ⚠️ 只有 `noInteraction !== false` 时才装：调用方显式要「人类在环」（`noInteraction: false`）
   * 时自动答否会**吞掉**本该交给上层（GUI / 插件自己的 HTTP 面）的提问与审批——
   * 真机表现为 `question.fail-fast` 抢答，接管端永远等不到待决项。
   */
  function installInteractionHandlers(): void {
    if (options.noInteraction === false) return
    uninstall.push(installFailFastAnswerer(ctx, sessionId))
    uninstall.push(installFailFastQuestionAnswerer(ctx, sessionId))
  }

  async function startFirstTurn(): Promise<TurnSettlement> {
    const agents = resolveAgents(ctx)
    handle = resumed ? await resumeAgent(agents) : await createAgent(agents)
    if (disposed) {
      try {
        await handle.dispose()
      } catch {
        // 已释放
      }
      return emptySettlement()
    }
    installInteractionHandlers()
    if (!resumed || options.sandbox !== undefined) {
      const applied = applyPermission(ctx, handle.agent.session, resolvePermission(ctx, sandbox))
      if (applied === 'none') {
        warnLedgerWriteFailure(ctx, `permission "${sandbox}" was not applied to ${sessionId}`)
      }
    }
    writeRecord(mountedPresetId)
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
    // 先拆交互接管：它会把挂着的审批/提问全部结算，否则 turn 永远卡着
    for (const off of uninstall.splice(0, uninstall.length)) {
      try {
        off()
      } catch {
        // 已注销
      }
    }
    try {
      unsubscribe?.()
    } catch {
      // 已注销
    }
    delivery?.dispose()
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
    writeRecord()
  }

  function followup(message: string | string[]): Promise<TurnSettlement> {
    const previous = turnDone
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

  // 插件卸载（fiber inactive）时自动 dispose：否则 agent handle / observers / 上下文投递器会泄漏。
  effectOf(ctx, () => () => {
    void dispose()
  }, 'magica:ephemeral:dispose')

  return {
    id: sessionId,
    resumed,
    firstTurn,
    getState(): EphemeralSessionState {
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
        ...(snapshot.ledgerWriteFailed !== undefined ? { ledgerWriteFailed: snapshot.ledgerWriteFailed } : {}),
        pendingApprovals: [],
        pendingQuestions: [],
        // 字段必须存在：看板对两种门面的读法要一致（临时会话恒为 fail-fast，数组通常为空）
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

/** 供门面外部读取待决项的只读入口（临时会话恒为空，但保留给统一形状）。 */
export function ephemeralPending(sessionId: string): {
  approvals: ReturnType<typeof snapshotPendingApprovals>
  questions: ReturnType<typeof snapshotPendingQuestions>
} {
  return {
    approvals: snapshotPendingApprovals(sessionId),
    questions: snapshotPendingQuestions(sessionId),
  }
}
