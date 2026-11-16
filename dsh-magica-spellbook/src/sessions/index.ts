/**
 * 会话运行内核门面（`sessions` 一级模块的公开出口）。
 * @module dsh-magica-spellbook/sessions
 */

export {
  TURN_END_KINDS,
  DEFAULT_PERMISSION_PRESET,
  SESSION_ID_SAFE,
  SessionResumeError,
  applyPermission,
  asSessionId,
  assertSessionNotLive,
  buildPluginMessage,
  buildUserMessage,
  composeAgentScope,
  describeTurnEnd,
  emptyRunState,
  errorMessage,
  extractAssistantText,
  installContextDelivery,
  installObservers,
  isTurnCompleted,
  manageWaterfallListener,
  mintMessageId,
  mintSessionId,
  pickModel,
  resolveDefaultModel,
  releaseRunState,
  resolveAgentPresetId,
  resolveAgents,
  resolvePermission,
  resolveResumeTarget,
  runTurnVerified,
  snapshotRunState,
  toContextEntries,
  toMessages,
  toResumeError,
  warnLedgerWriteFailure,
  TAKEOVER_OPTIONS,
} from './core.ts'

export type {
  AgentScopeComposition,
  ApprovalRecord,
  ContextDeliveryHandle,
  ObserverHooks,
  PluginContextEntry,
  ResolvedModel,
  ResumeFailure,
  ResumeTarget,
  SessionRunState,
  TurnSettlement,
} from './core.ts'

export {
  STORE_SUBDIR,
  STORE_VERSION,
  SAFE_ID,
  SessionRecordStore,
  deleteSessionRecord,
  getSessionRecord,
  getSessionStore,
  listSessionRecords,
  recordFileName,
  resetSessionStores,
  resolveStoreDir,
} from './store.ts'

export type { SessionKind, SessionRecord, SessionRecordLoadError, SessionRecordModel } from './store.ts'

export {
  DEFAULT_SANDBOX,
  DEFAULT_TTL_MS,
  NO_INTERACTION_PREFIX,
  runEphemeralSession,
} from './ephemeral.ts'

export type {
  EphemeralModel,
  EphemeralSessionHandle,
  EphemeralSessionState,
  RunEphemeralSessionOptions,
  SessionPermission,
} from './ephemeral.ts'

export { runWorkspaceSession, ensureWorkspaceForSession } from './workspace.ts'

export type {
  HumanInteractionOptions,
  RunWorkspaceSessionOptions,
  WorkspaceSessionHandle,
  WorkspaceSessionState,
} from './workspace.ts'

export {
  APPROVAL_OUTCOMES,
  answerApproval,
  installApprovalAnswerer,
  installFailFastAnswerer,
  isApprovalOutcome,
  listPendingApprovals,
  resetApprovals,
  snapshotPendingApprovals,
} from './approval.ts'

export type { ApprovalAnswererOptions, ApprovalAnswerResult, PendingApproval } from './approval.ts'

export {
  answerQuestion,
  cancelQuestion,
  disposeInteractionLogger,
  installFailFastQuestionAnswerer,
  installQuestionAnswerer,
  listPendingQuestions,
  resetQuestions,
  setInteractionLogger,
  snapshotPendingQuestions,
} from './questions.ts'

export type {
  PendingQuestion,
  QuestionAnswerResult,
  QuestionAnswererOptions,
  QuestionErrorCode,
} from './questions.ts'

export {
  createWorkspace,
  ensureWorkspace,
  findWorkspace,
  getWorkspaceRegistry,
  normalizeProjectPath,
} from './ensure-workspace.ts'

export type { EnsureWorkspaceOptions } from './ensure-workspace.ts'
