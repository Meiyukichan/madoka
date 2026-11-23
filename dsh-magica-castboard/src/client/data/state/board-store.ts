/**
 * 面板状态机：唯一持有业务状态、轮询游标与全部写操作的地方。
 *
 * @module dsh-magica-castboard/client/data/state/board-store
 */
import {
  ApiError,
  apiAbandonIssue,
  apiAcceptanceStrategies,
  apiAnswerApproval,
  apiAnswerQuestion,
  apiCancel,
  apiCancelQuestion,
  apiChecklist,
  apiComment,
  apiCommentIssue,
  apiCreateIssue,
  apiCreateTask,
  apiCronPreview,
  apiDeleteTask,
  apiDeleteTemplate,
  apiDiagnostics,
  apiDispatch,
  apiDispatchedIssues,
  apiIssue,
  apiIssueState,
  apiIssues,
  apiIssueThread,
  apiMarkIssueRead,
  apiMoveTask,
  apiRefreshPortraits,
  apiRejectTask,
  apiRouterStrategies,
  apiRun,
  apiSettings,
  apiStartAcceptance,
  apiState,
  apiTargets,
  apiTask,
  apiTaskAttachments,
  apiTemplates,
  apiUpdateAcceptanceStrategies,
  apiUpdateRouterStrategies,
  apiUpdateSettings,
  apiUpdateTask,
  apiUpdateWorkspaceNotes,
  apiUpsertTemplate,
  apiWorkspaceNotes,
  type AcceptanceEntry,
  type CreateTaskInput,
  type DiagnosticsView,
  type DispatchedRow,
  type InteractionView,
  type IssueDetail,
  type IssueTargets,
  type ModelCatalogView,
  type PromptCompletions,
  type RouterStrategyEntry,
  type Snapshot,
  type TaskDetailResponse,
  type TaskAttachmentView,
  type TaskSummaryView,
  type TemplateView,
  type UpdateTaskInput,
  type WorkspaceNoteEntry,
  type WorkspaceRow,
} from '../index.ts'
import { translate } from '../../labels/index.ts'
import { isSessionId, taskSessionIds } from '../derive/index.ts'
import { initialState } from './initial.ts'
import { errorText, fingerprintOf, interactionKey, isHidden, isUnchanged, sameInteractionSet } from './helpers.ts'
import { persistView } from './persist.ts'
import type { AbandonTarget, BoardState, ComposerState, SessionArchiveResult, SortBy } from './types.ts'

/** 基轮询间隔（插件规范要求 ≥5s）。 */
export const POLL_MS = 5_000
/** 失败退避上限。 */
export const POLL_MAX_MS = 30_000

/** 看板状态机。 */
export class BoardStore {
  private state: BoardState = initialState()
  private readonly subscribers = new Set<() => void>()
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private failureCount = 0
  private cursors: { since?: number; issueSince?: number; linkSince?: string; ixSince?: string } = {}
  private inFlight: Promise<void> | undefined
  private queued = false
  private visibilityCleanup: (() => void) | undefined
  private readonly detailInFlight = new Map<string, Promise<TaskDetailResponse | undefined>>()
  private readonly issueInFlight = new Map<string, Promise<IssueDetail | undefined>>()
  private workspacesFace: (() => Promise<WorkspaceRow[]>) | undefined
  private modelCatalogFace: (() => Promise<ModelCatalogView>) | undefined
  private modelCatalogCache: ModelCatalogView | undefined
  private promptCompletionsFace: ((workspaceId?: string) => Promise<PromptCompletions>) | undefined
  private permissionPresetFace: (() => string | undefined) | undefined
  private sessionJumper: ((sessionId: string) => Promise<'opened' | 'archived' | 'missing' | 'unavailable'>) | undefined
  private sessionArchiver: ((sessionIds: readonly string[]) => Promise<SessionArchiveResult>) | undefined
  private pollError: string | undefined
  private settingsLoaded = false
  private notesLoaded = false
  private strategiesLoaded = false
  private acceptanceLoaded = false
  private answeredAt = new Map<string, number>()

  /** 当前快照。 */
  getSnapshot(): BoardState {
    return this.state
  }

  /** 订阅。 */
  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener)
    return () => { this.subscribers.delete(listener) }
  }

  private emit(): void {
    if (this.disposed) return
    for (const listener of this.subscribers) listener()
  }

  private patchState(patch: Partial<BoardState>): void {
    this.state = { ...this.state, ...patch }
    this.emit()
  }

  private updateComposer(patch: Partial<ComposerState>): void {
    this.patchState({ composer: { ...this.state.composer, ...patch } })
  }

  private updateIssueComposer(patch: Partial<ComposerState>): void {
    this.patchState({ issueComposer: { ...this.state.issueComposer, ...patch } })
  }

  /** 启动轮询。 */
  start(): void {
    if (this.disposed) return
    this.watchVisibility()
    // 验收策略是全局的，详情里「哪些卡归自动验收」要看它；不打开设置页也要先知道。
    void this.loadAcceptance()
    void this.poll()
  }

  /** 停掉计时器、可见性监听与订阅。 */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
    this.visibilityCleanup?.()
    this.visibilityCleanup = undefined
    this.subscribers.clear()
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private watchVisibility(): void {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
    const onVisible = (): void => {
      if (this.disposed || isHidden()) return
      void this.poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    this.visibilityCleanup = () => {
      try { document.removeEventListener('visibilitychange', onVisible) } catch { /* document gone */ }
    }
  }

  private async poll(): Promise<void> {
    if (this.disposed) return
    if (isHidden()) {
      this.clearTimer()
      return
    }
    try {
      await this.pull()
      this.failureCount = this.pollError === undefined ? 0 : this.failureCount + 1
    } finally {
      if (!this.disposed) {
        this.clearTimer()
        this.timer = setTimeout(() => { void this.poll() }, this.delay())
      }
    }
  }

  private delay(): number {
    if (this.failureCount < 2) return POLL_MS
    return Math.min(POLL_MS * 2 ** Math.min(this.failureCount - 2, 3), POLL_MAX_MS)
  }

  /**
   * 拉一拍。正在飞的时候再来的调用只排一次「下一拍」——写完之后 `await refresh()`
   * 一定拿到的是写入后的快照，而不是在飞的那份（它可能发起于写入之前）。
   */
  async refresh(): Promise<void> {
    if (this.inFlight !== undefined) {
      this.queued = true
      return this.inFlight
    }
    this.inFlight = (async () => {
      try {
        let rounds = 0
        do {
          this.queued = false
          await this.pull()
          rounds += 1
        } while (this.queued && !this.disposed && rounds < 3)
      } finally {
        this.inFlight = undefined
      }
    })()
    return this.inFlight
  }

  private async pull(): Promise<void> {
    if (this.disposed) return
    try {
      const polled = await apiState(this.cursors)
      if (isUnchanged(polled)) {
        this.cursors = {
          since: polled.revision,
          issueSince: polled.issueRevision,
          linkSince: String(polled.linkRevision),
          ixSince: polled.interactionRevision ?? '',
        }
        this.clearPollError()
        // 快路径不换快照：只在首次 / 离线恢复时改一下状态，避免每 5s 一次空渲染。
        if (this.state.status !== 'ready') this.patchState({ status: 'ready' })
        return
      }
      const snapshot = polled as Snapshot
      const taskMoved = snapshot.revision !== this.state.revision || this.state.details.size === 0
      const issueMoved = snapshot.issueRevision !== this.state.issueRevision
      this.cursors = {
        since: snapshot.revision,
        issueSince: snapshot.issueRevision,
        linkSince: String(snapshot.linkRevision),
        ixSince: snapshot.interactions === undefined ? (this.cursors.ixSince ?? '') : fingerprintOf(snapshot.interactions),
      }
      // 设置与轮询解耦：`/state` 不带 settings，首次快照时拉一次；设置页每次打开再拉一次。
      let settings = this.state.settings
      if (!this.settingsLoaded || snapshot.settings !== undefined) {
        if (snapshot.settings !== undefined) {
          settings = snapshot.settings
          this.settingsLoaded = true
        } else {
          settings = await apiSettings().catch(() => settings)
          this.settingsLoaded = settings !== undefined
        }
      }
      const details = taskMoved ? await this.reloadDetails(snapshot.tasks) : this.state.details
      const issueDetails = issueMoved ? await this.reloadIssueDetails(snapshot.issues) : this.state.issueDetails
      const interactionMoved = snapshot.interactions !== undefined && !sameInteractionSet(snapshot.interactions, this.state.interactions)
      const selectedAlive = this.state.selectedId === undefined || snapshot.tasks.some(task => task.id === this.state.selectedId)
      const editingIssueAlive = this.state.issueComposer.editingId === undefined
        || snapshot.issues.some(issue => issue.issueId === this.state.issueComposer.editingId)
      this.patchState({
        status: 'ready',
        revision: snapshot.revision,
        issueRevision: snapshot.issueRevision,
        linkRevision: snapshot.linkRevision,
        tasks: snapshot.tasks,
        issues: snapshot.issues,
        issueLinks: snapshot.issueLinks,
        ...(snapshot.version === undefined ? {} : { version: snapshot.version }),
        details,
        issueDetails,
        ...(settings === undefined ? {} : { settings }),
        ...(selectedAlive ? {} : { selectedId: undefined }),
        ...(editingIssueAlive ? {} : { issueComposer: { open: false } }),
        ...(this.pollError === undefined ? {} : { error: undefined }),
      })
      if (snapshot.interactions !== undefined) this.setInteractions(snapshot.interactions)
      if (interactionMoved && this.state.interactionTarget !== undefined && this.interactionsFor(this.state.interactionTarget).length === 0) {
        this.patchState({ interactionTarget: undefined })
      }
      this.pollError = undefined
    } catch (error) {
      const message = errorText(error)
      if (error instanceof ApiError && error.code === 'network') {
        this.pollError = message
        this.patchState({ status: 'offline' })
        return
      }
      this.pollError = message
      this.patchState({ status: 'offline', error: message })
    }
  }

  private clearPollError(): void {
    if (this.pollError === undefined) return
    this.pollError = undefined
    if (this.state.error !== undefined) this.patchState({ error: undefined })
  }

  private async reloadDetails(tasks: readonly TaskSummaryView[]): Promise<ReadonlyMap<string, TaskDetailResponse>> {
    if (this.state.details.size === 0) return this.state.details
    const alive = new Set(tasks.map(task => task.id))
    const summary = new Map(tasks.map(task => [task.id, task]))
    const stale = [...this.state.details]
      .filter(([id, detail]) => alive.has(id) && summary.get(id)?.updatedAt !== detail.task.updatedAt)
      .map(([id]) => id)
    const next = new Map<string, TaskDetailResponse>()
    for (const [id, detail] of this.state.details) if (alive.has(id)) next.set(id, detail)
    for (const id of stale.slice(0, 4)) {
      const fresh = await apiTask(id).catch(() => undefined)
      if (fresh !== undefined) next.set(id, fresh)
    }
    return next
  }

  private async reloadIssueDetails(issues: readonly import('../../../shared/wire.ts').IssueSummary[]): Promise<ReadonlyMap<string, IssueDetail>> {
    if (this.state.issueDetails.size === 0) return this.state.issueDetails
    const alive = new Set(issues.map(issue => issue.issueId))
    const summary = new Map(issues.map(issue => [issue.issueId, issue]))
    const stale = [...this.state.issueDetails]
      .filter(([id, detail]) => alive.has(id) && summary.get(id)?.updatedAt !== detail.issue.updatedAt)
      .map(([id]) => id)
    const next = new Map<string, IssueDetail>()
    for (const [id, detail] of this.state.issueDetails) if (alive.has(id)) next.set(id, detail)
    for (const id of stale.slice(0, 4)) {
      const fresh = await apiIssue(id).catch(() => undefined)
      if (fresh !== undefined) next.set(id, fresh)
    }
    return next
  }

  // ── 视图 ───────────────────────────────────────────────────────────

  setSearch(search: string): void {
    this.patchState({ search })
  }

  setWorkspaceFilter(workspaceId?: string): void {
    this.patchState({ filters: { ...this.state.filters, ...(workspaceId === undefined ? {} : { workspaceId }) } })
    if (workspaceId === undefined) this.patchState({ filters: { urgencies: this.state.filters.urgencies } })
    persistView(this.state)
  }

  toggleUrgency(urgency: string): void {
    const set = new Set(this.state.filters.urgencies)
    if (set.has(urgency)) set.delete(urgency)
    else set.add(urgency)
    this.patchState({ filters: { ...this.state.filters, urgencies: [...set] } })
    persistView(this.state)
  }

  setSortBy(sortBy: SortBy): void {
    this.patchState({ sortBy })
    persistView(this.state)
  }

  toggleSecondary(): void {
    this.patchState({ secondaryOpen: !this.state.secondaryOpen })
  }

  // ── 详情 ───────────────────────────────────────────────────────────

  select(taskId?: string): void {
    if (taskId === undefined) {
      this.patchState({ selectedId: undefined })
      return
    }
    this.patchState({ selectedId: taskId })
    void this.ensureDetail(taskId)
    const issueId = this.state.tasks.find(task => task.id === taskId)?.issueId
    if (issueId !== undefined) void this.markIssueRead(issueId)
  }

  /** 取任务详情（缓存 / 并发放大）。 */
  async ensureDetail(taskId: string): Promise<TaskDetailResponse | undefined> {
    const cached = this.state.details.get(taskId)
    if (cached !== undefined) return cached
    const inFlight = this.detailInFlight.get(taskId)
    if (inFlight !== undefined) return inFlight
    const pending = (async (): Promise<TaskDetailResponse | undefined> => {
      try {
        const detail = await apiTask(taskId)
        this.patchState({ details: new Map(this.state.details).set(taskId, detail) })
        return detail
      } catch (error) {
        this.patchState({ error: errorText(error) })
        return undefined
      } finally {
        this.detailInFlight.delete(taskId)
      }
    })()
    this.detailInFlight.set(taskId, pending)
    return pending
  }

  /** Attachment metadata for the issue behind a card; no polling. */
  async taskAttachments(taskId: string): Promise<readonly TaskAttachmentView[]> {
    try {
      return (await apiTaskAttachments(taskId)).items
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return []
    }
  }

  openComposer(): void {
    this.updateComposer({ open: true, editingId: undefined, prefill: undefined })
  }

  closeComposer(): void {
    this.updateComposer({ open: false, editingId: undefined, prefill: undefined })
  }

  newFromTemplate(spec: TemplateView['spec']): void {
    this.updateComposer({ open: true, editingId: undefined, prefill: spec })
  }

  async openEditor(taskId: string): Promise<void> {
    const detail = await this.ensureDetail(taskId)
    if (detail === undefined) return
    this.updateComposer({ open: true, editingId: taskId, prefill: undefined })
  }

  // ── 待规划 ─────────────────────────────────────────────────────────

  async openIssueEditor(issueId: string): Promise<void> {
    const detail = await this.ensureIssueDetail(issueId)
    if (detail === undefined) return
    this.updateIssueComposer({ open: true, editingId: issueId })
    void this.markIssueRead(issueId)
  }

  closeIssueComposer(): void {
    this.updateIssueComposer({ open: false, editingId: undefined })
  }

  async ensureIssueDetail(issueId: string): Promise<IssueDetail | undefined> {
    const cached = this.state.issueDetails.get(issueId)
    if (cached !== undefined) return cached
    const inFlight = this.issueInFlight.get(issueId)
    if (inFlight !== undefined) return inFlight
    const pending = (async (): Promise<IssueDetail | undefined> => {
      try {
        const detail = await apiIssue(issueId)
        this.patchState({ issueDetails: new Map(this.state.issueDetails).set(issueId, detail) })
        return detail
      } catch (error) {
        this.patchState({ error: errorText(error) })
        return undefined
      } finally {
        this.issueInFlight.delete(issueId)
      }
    })()
    this.issueInFlight.set(issueId, pending)
    return pending
  }

  async issueThread(issueId: string): Promise<readonly import('../../../shared/wire.ts').ThreadComment[]> {
    return (await apiIssueThread(issueId)).comments
  }

  async commentIssue(issueId: string, body: string): Promise<{ id: string }> {
    const created = await apiCommentIssue(issueId, body)
    void this.markIssueRead(issueId)
    return created
  }

  async markIssueRead(issueId: string): Promise<void> {
    try {
      await apiMarkIssueRead(issueId)
    } catch { /* 尽力而为 */ }
  }

  async issueState(issueId: string): Promise<IssueDetail> {
    return apiIssueState(issueId)
  }

  /** 在线派发：直接进共享库，完成后刷新看板。 */
  async createIssue(input: import('../index.ts').CreateIssueInput): Promise<{ issueId: string; assignee: string } | undefined> {
    try {
      const created = await apiCreateIssue(input)
      this.closeIssueComposer()
      await this.refresh()
      return created
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return undefined
    }
  }

  async abandonIssue(issueId: string): Promise<boolean> {
    try {
      await apiAbandonIssue(issueId)
      const next = new Map(this.state.issueDetails)
      next.delete(issueId)
      this.patchState({
        issueDetails: next,
        ...(this.state.issueComposer.editingId === issueId ? { issueComposer: { open: false } } : {}),
      })
      await this.refresh()
      return true
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return false
    }
  }

  openDispatched(): void {
    this.patchState({ dispatchedOpen: true })
  }

  closeDispatched(): void {
    this.patchState({ dispatchedOpen: false })
  }

  async dispatchedIssues(): Promise<{ items: readonly DispatchedRow[]; truncated: boolean }> {
    return apiDispatchedIssues()
  }

  // ── 删除确认 ───────────────────────────────────────────────────────

  openAbandon(target: AbandonTarget): void {
    this.patchState({ abandonTarget: target })
  }

  closeAbandon(): void {
    if (this.state.abandonTarget === undefined) return
    this.patchState({ abandonTarget: undefined })
  }

  async confirmAbandon(): Promise<void> {
    const target = this.state.abandonTarget
    if (target === undefined) return
    this.patchState({ abandonTarget: undefined })
    if (target.kind === 'issue') {
      await this.abandonIssue(target.id)
      return
    }
    await this.abandon(target.id)
  }

  // ── 任务写操作 ─────────────────────────────────────────────────────

  async create(input: CreateTaskInput): Promise<string | undefined> {
    try {
      const created = await apiCreateTask(input)
      this.closeComposer()
      await this.refresh()
      return created.id
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return undefined
    }
  }

  async update(taskId: string, input: UpdateTaskInput): Promise<boolean> {
    try {
      await apiUpdateTask(taskId, input)
      this.closeComposer()
      await this.refresh()
      return true
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return false
    }
  }

  async move(taskId: string, to: import('../../../shared/wire.ts').TaskStatus, options?: { archiveSessions?: boolean }): Promise<boolean> {
    try {
      await apiMoveTask(taskId, to)
      await this.refresh()
      if (to === 'archived' && options?.archiveSessions === true) await this.archiveTaskSessions(taskId)
      return true
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return false
    }
  }

  async reject(taskId: string, note?: string): Promise<boolean> {
    try {
      await apiRejectTask(taskId, note)
      await this.refresh()
      return true
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return false
    }
  }

  async remove(taskId: string, purge: boolean): Promise<void> {
    try {
      await apiDeleteTask(taskId, purge)
      if (purge) this.patchState({ selectedId: undefined })
      await this.refresh()
    } catch (error) {
      this.patchState({ error: errorText(error) })
    }
  }

  async abandon(taskId: string): Promise<boolean> {
    return this.move(taskId, 'abandoned')
  }

  async toggleBlocked(task: import('../../../shared/wire.ts').TaskRecord): Promise<void> {
    try {
      await apiUpdateTask(task.id, { blocked: !task.blocked })
      await this.refresh()
    } catch (error) {
      this.patchState({ error: errorText(error) })
    }
  }

  async toggleChecklist(task: import('../../../shared/wire.ts').TaskRecord, index: number): Promise<void> {
    try {
      await apiChecklist(task.id, { index, checked: task.checklist?.[index]?.done !== true })
      await this.refresh()
    } catch (error) {
      this.patchState({ error: errorText(error) })
    }
  }

  async comment(taskId: string, body: string): Promise<boolean> {
    try {
      await apiComment(taskId, body)
      await this.refresh()
      // 评论不改任务的 updatedAt（只写评论流），所以摘要刷新不会重拉详情；
      // 这里显式补一次，让时间线立刻出现刚发的这条。
      const detail = await apiTask(taskId).catch(() => undefined)
      if (detail !== undefined) this.patchState({ details: new Map(this.state.details).set(taskId, detail) })
      return true
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return false
    }
  }

  async run(taskId: string): Promise<boolean> {
    try {
      const result = await apiRun(taskId)
      await this.refresh()
      // The host omits `started` on a fresh accepted run; only an explicit false means no run.
      const started = result.started !== false
      if (!started) this.patchState({ error: result.reason ?? '未启动' })
      return started
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return false
    }
  }

  async cancel(taskId: string): Promise<void> {
    try {
      await apiCancel(taskId)
      await this.refresh()
    } catch (error) {
      this.patchState({ error: errorText(error) })
    }
  }

  async startAcceptance(taskId: string): Promise<boolean> {
    try {
      await apiStartAcceptance(taskId)
      await this.refresh()
      return true
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return false
    }
  }

  async duplicate(task: import('../../../shared/wire.ts').TaskRecord): Promise<void> {
    try {
      await apiCreateTask({
        title: `${task.title.slice(0, 196)}${translate('task.duplicateSuffix')}`,
        detail: task.detail,
        urgency: task.urgency,
        workspaceId: task.workspaceId,
        ...(task.model === undefined ? {} : { model: task.model }),
        ...(task.permission === undefined ? {} : { permission: task.permission }),
        ...(task.cwd === undefined ? {} : { cwd: task.cwd }),
        ...(task.execution === undefined ? {} : { execution: task.execution }),
        ...(task.tags === undefined ? {} : { tags: task.tags }),
        ...(task.checklist === undefined ? {} : { checklist: task.checklist.map(item => item.text) }),
      })
      await this.refresh()
    } catch (error) {
      this.patchState({ error: errorText(error) })
    }
  }

  /**
   * 安装「归档执行会话」实现（0.2 的 `uiWorkspace.archiveSession`）。
   *
   * 不安装 = 当前宿主没有会话归档面，界面只给「仅归档卡片」。
   */
  installModelCatalog(load: (() => Promise<ModelCatalogView>) | undefined): void {
    this.modelCatalogFace = load
    this.modelCatalogCache = undefined
  }

  /** Host catalog is generational state: cache a non-empty result until explicitly refreshed. */
  async fetchModelCatalog(options?: { refresh?: boolean }): Promise<ModelCatalogView> {
    const cached = this.modelCatalogCache
    if (options?.refresh !== true && cached !== undefined && cached.models.length > 0) return cached
    if (this.modelCatalogFace === undefined) return { models: [] }
    try {
      const view = await this.modelCatalogFace()
      this.modelCatalogCache = view
      return view
    } catch {
      return { models: [] }
    }
  }

  installPromptCompletions(load: ((workspaceId?: string) => Promise<PromptCompletions>) | undefined): void {
    this.promptCompletionsFace = load
  }

  installPermissionPreset(read: (() => string | undefined) | undefined): void {
    this.permissionPresetFace = read
  }

  permissionPreset(): string | undefined {
    try {
      return this.permissionPresetFace?.()
    } catch {
      return undefined
    }
  }

  async fetchPromptCompletions(workspaceId?: string): Promise<PromptCompletions> {
    if (this.promptCompletionsFace === undefined) return { commands: [], skills: [] }
    try {
      return await this.promptCompletionsFace(workspaceId)
    } catch {
      return { commands: [], skills: [] }
    }
  }

  installSessionArchiver(archive: ((sessionIds: readonly string[]) => Promise<SessionArchiveResult>) | undefined): void {
    this.sessionArchiver = archive
    this.patchState({ archiveSessionsSupported: archive !== undefined })
  }

  /**
   * 把一张卡关联的执行会话全部归档，结果写进 `sessionArchive`。
   *
   * 逐会话记录成功 / 失败 / 不支持；没有会话或没有归档面时也写一条结果，
   * 让界面能如实说明发生了什么（而不是静默什么都不做）。
   */
  async archiveTaskSessions(taskId: string): Promise<SessionArchiveResult> {
    const detail = await this.ensureDetail(taskId)
    const ids = detail === undefined ? [] : taskSessionIds(detail.task)
    const empty: SessionArchiveResult = { archived: [], failed: [], unsupported: [] }
    if (ids.length === 0) {
      this.patchState({ sessionArchive: { taskId, result: empty } })
      return empty
    }
    if (this.sessionArchiver === undefined) {
      const result: SessionArchiveResult = { archived: [], failed: [], unsupported: ids }
      this.patchState({ sessionArchive: { taskId, result } })
      return result
    }
    try {
      const result = await this.sessionArchiver(ids)
      this.patchState({ sessionArchive: { taskId, result } })
      return result
    } catch (error) {
      const result: SessionArchiveResult = {
        archived: [],
        failed: ids.map(sessionId => ({ sessionId, error: errorText(error) })),
        unsupported: [],
      }
      this.patchState({ sessionArchive: { taskId, result } })
      return result
    }
  }

  /** 已归档的卡上「归档 / 重试归档执行会话」。 */
  async retryArchiveSessions(taskId: string): Promise<void> {
    await this.archiveTaskSessions(taskId)
  }

  // ── 会话跳转 ───────────────────────────────────────────────────────

  installSessionJumper(jump: (sessionId: string) => Promise<'opened' | 'archived' | 'missing' | 'unavailable'>): void {
    this.sessionJumper = jump
  }

  async openSession(sessionId: string): Promise<'opened' | 'archived' | 'missing' | 'unavailable'> {
    if (this.sessionJumper === undefined) return 'unavailable'
    try {
      return await this.sessionJumper(sessionId)
    } catch {
      return 'unavailable'
    }
  }

  installWorkspaces(load: () => Promise<WorkspaceRow[]>): void {
    this.workspacesFace = load
  }

  setWorkspaces(rows: readonly WorkspaceRow[]): void {
    this.patchState({ workspaces: rows })
  }

  // ── 待决交互 ───────────────────────────────────────────────────────

  setInteractions(list: readonly InteractionView[]): void {
    const now = Date.now()
    for (const [key, at] of this.answeredAt) if (now - at > 15_000) this.answeredAt.delete(key)
    const fresh = this.answeredAt.size === 0
      ? [...list]
      : list.filter(item => !this.answeredAt.has(interactionKey(item)))
    if (sameInteractionSet(fresh, this.state.interactions)) return
    this.patchState({ interactions: fresh })
    const target = this.state.interactionTarget
    if (target !== undefined && this.interactionsFor(target).length === 0) this.patchState({ interactionTarget: undefined })
  }

  interactionsFor(taskId: string): InteractionView[] {
    const task = this.state.tasks.find(item => item.id === taskId)
    if (task === undefined) return []
    const sessions = [task.lastSessionId, isSessionId(task.claimedBy) ? task.claimedBy : undefined]
      .filter((id): id is string => id !== undefined && id !== '')
    if (sessions.length === 0) return []
    return this.state.interactions.filter(item => sessions.includes(item.sessionId))
  }

  allInteractions(): readonly InteractionView[] {
    // 等得最久的在前（0.1.2 的列表就是 `since` 升序）。
    return [...this.state.interactions].sort((left, right) => left.createdAt - right.createdAt)
  }

  interactionCount(): number {
    return this.state.interactions.length
  }

  taskForSession(sessionId: string): TaskSummaryView | undefined {
    return this.state.tasks.find(task => task.lastSessionId === sessionId
      || (isSessionId(task.claimedBy) && task.claimedBy === sessionId))
  }

  openInteraction(taskId: string): void {
    this.patchState({ interactionTarget: taskId })
  }

  closeInteraction(): void {
    this.patchState({ interactionTarget: undefined })
  }

  openInteractionInbox(): void {
    this.patchState({ interactionInboxOpen: true })
  }

  closeInteractionInbox(): void {
    this.patchState({ interactionInboxOpen: false })
  }

  async answerApproval(id: string, approved: boolean): Promise<boolean> {
    const view = this.state.interactions.find(item => item.id === id && item.kind === 'approval')
    try {
      await apiAnswerApproval(id, approved)
      if (view !== undefined) {
        this.answeredAt.set(interactionKey(view), Date.now())
        this.setInteractions(this.state.interactions.filter(item => interactionKey(item) !== interactionKey(view)))
      }
      await this.refresh()
      return true
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return false
    }
  }

  async answerQuestion(id: string, answer: string, selected?: readonly string[]): Promise<boolean> {
    const view = this.state.interactions.find(item => item.id === id && item.kind === 'question')
    try {
      await apiAnswerQuestion(id, answer, selected)
      if (view !== undefined) {
        this.answeredAt.set(interactionKey(view), Date.now())
        this.setInteractions(this.state.interactions.filter(item => interactionKey(item) !== interactionKey(view)))
      }
      await this.refresh()
      return true
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return false
    }
  }

  async cancelQuestion(id: string): Promise<boolean> {
    const view = this.state.interactions.find(item => item.id === id && item.kind === 'question')
    try {
      await apiCancelQuestion(id)
      if (view !== undefined) {
        this.answeredAt.set(interactionKey(view), Date.now())
        this.setInteractions(this.state.interactions.filter(item => interactionKey(item) !== interactionKey(view)))
      }
      await this.refresh()
      return true
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return false
    }
  }

  // ── 分发 ───────────────────────────────────────────────────────────

  openDispatch(taskId: string): void {
    this.patchState({ dispatchTarget: taskId })
  }

  closeDispatch(): void {
    this.patchState({ dispatchTarget: undefined })
  }

  async fetchTargets(projectId?: string, userId?: string): Promise<IssueTargets> {
    try {
      return await apiTargets(projectId, userId)
    } catch (error) {
      // 网络失败也要让弹窗知道「共享库连不上」，不能伪装成「没有项目组」。
      return { projects: [], members: [], instances: [], degraded: true, reason: errorText(error) }
    }
  }

  async dispatch(taskId: string, input: import('../index.ts').DispatchInput): Promise<boolean> {
    try {
      await apiDispatch(taskId, input)
      this.patchState({ dispatchTarget: undefined })
      await this.refresh()
      return true
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return false
    }
  }

  // ── 设置 ───────────────────────────────────────────────────────────

  openSettings(): void {
    this.patchState({ settingsOpen: true })
    // 设置存在独立文件里（可手改、别的窗口也可能改过），打开设置页时重新读一次。
    void this.loadSettings()
    void this.loadNotes()
    void this.loadRouterStrategies()
    void this.loadAcceptance()
  }

  /** Read the effective board settings; a failure keeps the previous value. */
  async loadSettings(): Promise<void> {
    try {
      this.patchState({ settings: await apiSettings() })
      this.settingsLoaded = true
    } catch {
      // 读不到就沿用上一次的值，不能因为设置在打开弹窗时把整页打崩。
    }
  }

  closeSettings(): void {
    this.patchState({ settingsOpen: false })
  }

  async updateSettings(next: import('../../../shared/wire.ts').BoardSettings): Promise<boolean> {
    try {
      // 响应就是落盘后的有效值（含默认），直接采用，免得重开设置页看到旧数字。
      const saved = await apiUpdateSettings(next)
      this.settingsLoaded = true
      this.patchState({ settings: saved, error: undefined })
      await this.refresh()
      return true
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return false
    }
  }

  async loadNotes(): Promise<readonly WorkspaceNoteEntry[]> {
    try {
      const value = await apiWorkspaceNotes()
      this.notesLoaded = true
      this.patchState({ workspaceNotes: value.items })
      return value.items
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return []
    }
  }

  async updateNotes(items: readonly WorkspaceNoteEntry[]): Promise<boolean> {
    try {
      const value = await apiUpdateWorkspaceNotes(items)
      this.patchState({ workspaceNotes: value.items, error: undefined })
      return true
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return false
    }
  }

  async loadRouterStrategies(): Promise<readonly RouterStrategyEntry[]> {
    try {
      const value = await apiRouterStrategies()
      this.strategiesLoaded = true
      this.patchState({ routerStrategies: value.items })
      return value.items
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return []
    }
  }

  async updateRouterStrategies(items: readonly RouterStrategyEntry[]): Promise<boolean> {
    try {
      const value = await apiUpdateRouterStrategies(items)
      this.patchState({ routerStrategies: value.items, error: undefined })
      return true
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return false
    }
  }

  async loadAcceptance(): Promise<readonly AcceptanceEntry[]> {
    try {
      const value = await apiAcceptanceStrategies()
      this.acceptanceLoaded = true
      this.patchState({ acceptanceStrategies: value.strategies })
      return value.strategies
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return []
    }
  }

  async updateAcceptance(items: readonly AcceptanceEntry[]): Promise<boolean> {
    try {
      const value = await apiUpdateAcceptanceStrategies(items)
      this.patchState({ acceptanceStrategies: value.strategies, error: undefined })
      return true
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return false
    }
  }

  async refreshPortraits(): Promise<number | undefined> {
    try {
      const result = await apiRefreshPortraits()
      return result.reset
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return undefined
    }
  }

  // ── 诊断 ───────────────────────────────────────────────────────────

  openDiagnostics(): void {
    this.patchState({ diagOpen: true })
    void apiDiagnostics().then(diagnostics => { this.patchState({ diagnostics }) }).catch(error => {
      this.patchState({ error: errorText(error) })
    })
  }

  closeDiagnostics(): void {
    this.patchState({ diagOpen: false })
  }

  // ── 模板 ───────────────────────────────────────────────────────────

  async loadTemplates(): Promise<readonly TemplateView[]> {
    try {
      const value = await apiTemplates()
      this.patchState({ templates: value.templates, error: undefined })
      return value.templates
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return []
    }
  }

  prepareTemplateMenu(): void {
    if (this.state.templates.length === 0) void this.loadTemplates()
  }

  openTemplateManager(): void {
    this.patchState({ tplManagerOpen: true })
    void this.loadTemplates()
  }

  closeTemplateManager(): void {
    this.patchState({ tplManagerOpen: false })
  }

  async upsertTemplate(input: { id: string; name: { zh: string; en: string }; description?: { zh: string; en: string }; spec: TemplateView['spec'] }): Promise<boolean> {
    try {
      const value = await apiUpsertTemplate(input)
      this.patchState({ templates: value.templates, error: undefined })
      return true
    } catch (error) {
      this.patchState({ error: errorText(error) })
      return false
    }
  }

  async deleteTemplate(id: string): Promise<void> {
    try {
      await apiDeleteTemplate(id)
      await this.loadTemplates()
    } catch (error) {
      this.patchState({ error: errorText(error) })
    }
  }

  async saveAsTemplate(task: import('../../../shared/wire.ts').TaskRecord): Promise<boolean> {
    return this.upsertTemplate({
      id: `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: { zh: task.title.slice(0, 60), en: task.title.slice(0, 60) },
      spec: {
        title: task.title,
        ...(task.detail === undefined || task.detail === '' ? {} : { detail: task.detail }),
        urgency: task.urgency,
        ...(task.workspaceId === undefined ? {} : { workspaceId: task.workspaceId }),
        ...(task.model === undefined ? {} : { model: task.model }),
        ...(task.permission === undefined ? {} : { permission: task.permission }),
        ...(task.execution === undefined ? {} : { execution: task.execution }),
        ...(task.checklist === undefined ? {} : { checklist: task.checklist.map(item => item.text) }),
      },
    })
  }

  async previewCron(cron: string): Promise<number | undefined> {
    try {
      const result = await apiCronPreview(cron)
      return result.nextRunAt
    } catch {
      return undefined
    }
  }

}
