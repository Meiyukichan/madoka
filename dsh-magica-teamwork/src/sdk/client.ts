/**
 * `LatticeClient`：**总入口**。一个实例 = 一份会话 + 一个出站句柄 + 一个并发闸。
 *
 * 三层结构（别混）：
 *  - **原子层**（8 个分组，协议面 1:1）：`auth` / `project` / `issue` / `teamwork` / `device` / `file` / `ops` / `admin`
 *  - **组合层**（24 + E1）：直接挂在 client 上（`client.issueClaim(...)`）——这是插件真正调的层
 *  - **逃生口**：`client.request()` / `client.raw()`
 *
 * 构造是**同步、无 I/O**的（协议地址解析只读 env 与 config.json，最多一次 stat）。
 *
 * 文档：`docs/design/lattice-sdk-design.zh.md` §0 / §9 / §10
 */

import { LatticeAdminApi } from './admin.js'
import { LatticeAuth } from './auth.js'
import { LatticeAuthApi } from './auth-api.js'
import { LatticeDeviceApi } from './device.js'
import { teamworkBaseUrl, type BaseUrlOptions } from './env.js'
import { LatticeFileApi } from './file.js'
import { LatticeIssueApi } from './issue/index.js'
import { LatticeOpsApi } from './ops.js'
import { LatticeProjectApi } from './project.js'
import { latticeFail, latticeOk, type LatticeResult } from './result.js'
import { LatticeTeamworkApi } from './teamwork/index.js'
import {
  LATTICE_DEFAULT_MAX_CONCURRENCY,
  LATTICE_DEFAULT_RETRIES,
  LATTICE_DEFAULT_TIMEOUT_MS,
  LatticeTransport,
  type LatticeRawOptions,
  type LatticeRequestOptions,
} from './transport.js'
import type { LatticeEventLoggerLike } from './log.js'
import { setLatticeLogger } from './log.js'
import type { LatticeFetch, LatticeFetchOptions } from './net.js'
import type { LatticeGlobalRole, LatticeOs } from './types.js'
import * as composite from './sdk.js'
import type {
  LatticeIssueAbandonResult,
  LatticeIssueAddCommentsResult,
  LatticeIssueAttachmentDownloadOptions,
  LatticeIssueAttachmentDownloadResult,
  LatticeIssueClaimResult,
  LatticeIssueCommentInput,
  LatticeIssueCreateInput,
  LatticeIssueCreateManyResult,
  LatticeIssueCreateResult,
  LatticeIssueFinalizeInput,
  LatticeIssueFinalizeResult,
  LatticeIssueRoutedInput,
  LatticeIssueRoutingResult,
  LatticeIssueStatuses,
  LatticeIssueStatusesQuery,
  LatticeIssueUpdateStatusInput,
  LatticeMyInstanceIssues,
  LatticeMyInstanceIssuesOptions,
  LatticeProjectMemberQuery,
  LatticeWorkspaceIndexInput,
  LatticeWorkspacePortalInput,
  LatticeWorkspacePortalQuery,
} from './sdk.js'
import type {
  LatticeComment,
  LatticeCommentIncrement,
  LatticeCommentIncrementQuery,
  LatticeDevice,
  LatticeDeviceWorkspace,
  LatticeIssue,
  LatticeProject,
  LatticeProjectMember,
  LatticeSource,
  LatticeSourceInput,
} from './types.js'

export interface LatticeClientOptions extends BaseUrlOptions {
  // ── 会话 ──────────────────────────────────────────────────────────────
  /** 凭据目录；缺省 `~/.dsh/storages/teamwork` */
  home?: string
  /** `false` = 纯内存（不写任何凭据文件） */
  persist?: boolean
  /** 直接注入会话（CI / 测试）；优先于 `tokenProvider` */
  credentials?: { accountId: string; accountToken: string; ttlSeconds?: number; displayName?: string | null; globalRole?: LatticeGlobalRole }
  /** 异步解析会话（自定义凭据源） */
  tokenProvider?: () => Promise<{ accountId: string; accountToken: string; ttlSeconds?: number } | null>
  /** 401 时通知调用方清自己的缓存 */
  onTokenInvalid?: () => void
  // ── 身份兜底（组合层用）───────────────────────────────────────────────
  userId?: string
  instance?: string
  os?: LatticeOs
  // ── 传输 ──────────────────────────────────────────────────────────────
  timeoutMs?: number
  maxConcurrency?: number
  retries?: number
  fetchImpl?: LatticeFetch
  /** TLS / 代理（TLS 缺省严格校验） */
  tls?: LatticeFetchOptions
  onRequest?: (info: { method: string; path: string; status: number; ms: number }) => void
  // ── 能力 ──────────────────────────────────────────────────────────────
  /** 启动时探测 `/version`（默认 false：显式调 `ops.probe()` 或第一次业务请求前自行探测） */
  probe?: boolean
  strictProtocol?: boolean
  /** 诊断日志（宿主用发布包 `createEventLogger` 造一个传进来） */
  logger?: LatticeEventLoggerLike | null
}

export class LatticeClient {
  readonly baseUrl: string
  readonly timeoutMs: number
  readonly maxConcurrency: number
  readonly maxRetries: number
  readonly userId: string | undefined
  readonly instance: string | undefined
  readonly os: LatticeOs | undefined

  readonly auth: LatticeAuthApi
  readonly project: LatticeProjectApi
  readonly issue: LatticeIssueApi
  readonly teamwork: LatticeTeamworkApi
  readonly device: LatticeDeviceApi
  readonly file: LatticeFileApi
  readonly ops: LatticeOpsApi
  readonly admin: LatticeAdminApi

  private readonly authSession: LatticeAuth
  private readonly transport: LatticeTransport
  private readonly options: LatticeClientOptions
  private readonly initFailure: LatticeResult<never> | null
  private disposed = false

  constructor(options: LatticeClientOptions = {}) {
    this.options = options
    if (options.logger !== undefined) setLatticeLogger(options.logger)

    this.timeoutMs = options.timeoutMs ?? LATTICE_DEFAULT_TIMEOUT_MS
    this.maxConcurrency = options.maxConcurrency ?? LATTICE_DEFAULT_MAX_CONCURRENCY
    this.maxRetries = options.retries ?? LATTICE_DEFAULT_RETRIES
    this.userId = options.userId
    this.instance = options.instance
    this.os = options.os

    const resolved = teamworkBaseUrl(options)
    // 解析失败时不做 I/O：所有方法统一返回同一个 invalid_host 信封
    this.baseUrl = resolved.ok ? resolved.value : ''
    this.initFailure = resolved.ok
      ? null
      : latticeFail({ status: 0, code: 'invalid_host', reason: resolved.reason, value: resolved.value })

    this.authSession = new LatticeAuth({
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.persist === undefined ? {} : { persist: options.persist }),
      ...(options.credentials === undefined
        ? {}
        : {
            credentials: {
              accountId: options.credentials.accountId,
              accountToken: options.credentials.accountToken,
              ttlSeconds: options.credentials.ttlSeconds ?? 259_200,
              displayName: options.credentials.displayName ?? null,
              ...(options.credentials.globalRole === undefined ? {} : { globalRole: options.credentials.globalRole }),
            },
          }),
      ...(options.tokenProvider === undefined
        ? {}
        : {
            tokenProvider: async () => {
              const found = await options.tokenProvider!()
              return found === null
                ? null
                : { accountId: found.accountId, accountToken: found.accountToken, ttlSeconds: found.ttlSeconds ?? 259_200 }
            },
          }),
      ...(options.onTokenInvalid === undefined ? {} : { onTokenInvalid: options.onTokenInvalid }),
      serverKey: this.baseUrl,
    })

    this.transport = new LatticeTransport({
      baseUrl: this.baseUrl === '' ? 'http://127.0.0.1:3939/dsh-teamwork/v1' : this.baseUrl,
      timeoutMs: this.timeoutMs,
      maxConcurrency: this.maxConcurrency,
      retries: this.maxRetries,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.tls === undefined ? {} : { fetchOptions: options.tls }),
      ...(options.onRequest === undefined ? {} : { onRequest: options.onRequest }),
      auth: this.authSession,
    })

    this.auth = new LatticeAuthApi(this.transport, this.authSession)
    this.project = new LatticeProjectApi(this.transport)
    this.issue = new LatticeIssueApi(this.transport)
    this.teamwork = new LatticeTeamworkApi(this.transport)
    this.device = new LatticeDeviceApi(this.transport)
    this.file = new LatticeFileApi(this.transport)
    this.ops = new LatticeOpsApi(this.transport, {
      ...(options.strictProtocol === undefined ? {} : { strictProtocol: options.strictProtocol }),
    })
    this.admin = new LatticeAdminApi(this.transport)

    if (options.probe === true && this.initFailure === null) {
      // 构造保持同步：探测放到微任务里，失败只记日志（能力闸缺省不拦）
      void Promise.resolve().then(() => this.ops.probe())
    }
  }

  // ── 会话状态 ──────────────────────────────────────────────────────────────

  get state(): 'authenticated' | 'login_required' | 'anonymous' {
    return this.authSession.state
  }

  get accountId(): string | null {
    return this.authSession.accountId
  }

  get accountToken(): string | null {
    return this.authSession.accountToken
  }

  get globalRole(): LatticeGlobalRole | undefined {
    return this.authSession.globalRole()
  }

  /** 清内存会话（保留凭据文件） */
  clearSession(): void {
    this.authSession.clearMemory()
  }

  /** 清凭据文件（`alsoKey` 连密钥一起删） */
  resetCredentials(alsoKey = false): void {
    this.authSession.clearStored(alsoKey)
  }

  // ── 逃生口 ────────────────────────────────────────────────────────────────

  /** 按裸路径发 JSON（端点表之外，同 host；走同一条管线） */
  async request<T>(path: string, options: LatticeRequestOptions = {}): Promise<LatticeResult<T>> {
    if (this.initFailure !== null) return this.initFailure
    return this.transport.request<T>(path, options)
  }

  /** 按裸路径发原始请求 */
  async raw(path: string, options: LatticeRawOptions = {}): Promise<LatticeResult<Response>> {
    if (this.initFailure !== null) return this.initFailure
    return this.transport.raw(path, options)
  }

  /** 能力探测（把 `/version.endpoints[]` 装进闸） */
  async probe(): Promise<LatticeResult<{ protocol: string; endpoints: string[] }>> {
    if (this.initFailure !== null) return this.initFailure
    return this.ops.probe()
  }

  /**
   * 直接设定能力清单（`null` = 关闭能力闸）。
   *
   * 正常用法是 `probe()`；这里是给**验收脚本 / 灰度降级**准备的显式入口：
   * 想验证"服务端缺某端点时 SDK 怎么表现"，就把它设成只含部分端点。
   */
  setCapabilities(endpoints: readonly string[] | null): void {
    this.transport.setCapabilities(endpoints)
  }

  // ── 组合层（24 + E1）──────────────────────────────────────────────────────

  /** 1：我参与的项目（裸数组） */
  latticeMyProjects(): Promise<LatticeResult<LatticeProject[]>> {
    return this.withReady(() => composite.queryMyProjects(this))
  }

  /** 2：项目成员（`manager:true` 只留能派活的角色） */
  latticeProjectMembers(projectId: number | string, options?: LatticeProjectMemberQuery): Promise<LatticeResult<LatticeProjectMember[]>> {
    return this.withReady(() => composite.queryProjectMembers(this, projectId, options))
  }

  /** 3：指定用户的在线设备 */
  latticeUserDevices(userId: string): Promise<LatticeResult<LatticeDevice[]>> {
    return this.withReady(() => composite.queryUserDevices(this, userId))
  }

  /** 4：本机名下 issue（翻页 + 本地判据） */
  latticeMyInstanceIssues(options?: LatticeMyInstanceIssuesOptions): Promise<LatticeResult<LatticeMyInstanceIssues>> {
    return this.withReady(() => composite.queryMyInstanceIssues(this, options))
  }

  /** 5a：创建单条 */
  issueCreate(input: LatticeIssueCreateInput): Promise<LatticeResult<LatticeIssueCreateResult>> {
    return this.withReady(() => composite.issueCreate(this, input))
  }

  /** 5b：批量创建 */
  issueCreateMany(inputs: readonly LatticeIssueCreateInput[]): Promise<LatticeResult<LatticeIssueCreateManyResult>> {
    return this.withReady(() => composite.issueCreateMany(this, inputs))
  }

  /** 6：单条状态更新 */
  issueUpdateStatus(input: LatticeIssueUpdateStatusInput): Promise<LatticeResult<LatticeIssue>> {
    return this.withReady(() => composite.issueUpdateStatus(this, input))
  }

  /** 7：认领（`expectedStatus:'pending'` CAS；`status_conflict` 不要重试） */
  issueClaim(issueIds: readonly string[]): Promise<LatticeResult<LatticeIssueClaimResult>> {
    return this.withReady(() => composite.issueClaim(this, issueIds))
  }

  /** 8：批量放弃 */
  issueAbandon(issueIds: readonly string[]): Promise<LatticeResult<LatticeIssueAbandonResult>> {
    return this.withReady(() => composite.issueAbandon(this, issueIds))
  }

  /** 8b：批量进规划 */
  issueRouting(issueIds: readonly string[]): Promise<LatticeResult<LatticeIssueRoutingResult>> {
    return this.withReady(() => composite.issueRouting(this, issueIds))
  }

  /** 8c：开始执行 */
  issueRunning(issueId: string): Promise<LatticeResult<LatticeIssue>> {
    return this.withReady(() => composite.issueRunning(this, issueId))
  }

  /** 8d：收尾 + 挂产物（先上传再改状态） */
  issueFinalize(issueId: string, input: LatticeIssueFinalizeInput): Promise<LatticeResult<LatticeIssueFinalizeResult>> {
    return this.withReady(() => composite.issueFinalize(this, issueId, input))
  }

  /** 9：规划回填（只允许 accepted / routing） */
  issueRouted(issueId: string, input: LatticeIssueRoutedInput): Promise<LatticeResult<LatticeIssue>> {
    return this.withReady(() => composite.issueRouted(this, issueId, input))
  }

  /** 10a：查来源字典 */
  latticeIssueSources(code?: string): Promise<LatticeResult<LatticeSource[]>> {
    return this.withReady(() => composite.latticeIssueSources(this, code))
  }

  /** 10b：注册 / 更新来源 */
  latticeAddIssueSource(input: LatticeSourceInput): Promise<LatticeResult<LatticeSource>> {
    return this.withReady(() => composite.latticeAddIssueSource(this, input))
  }

  /** 11：附件下载到本地目录 */
  latticeDownloadIssueAttachments(
    issueId: string,
    outputDir: string,
    options?: LatticeIssueAttachmentDownloadOptions,
  ): Promise<LatticeResult<LatticeIssueAttachmentDownloadResult>> {
    return this.withReady(() => composite.latticeDownloadIssueAttachments(this, issueId, outputDir, options))
  }

  /** 12a：查一条 issue 的评论 */
  latticeIssueComments(issueId: string): Promise<LatticeResult<LatticeComment[]>> {
    return this.withReady(() => composite.latticeIssueComments(this, issueId))
  }

  /** 12b：批量追加评论（同 `commentId` 幂等） */
  latticeAddIssueComments(issueId: string, comments: readonly LatticeIssueCommentInput[]): Promise<LatticeResult<LatticeIssueAddCommentsResult>> {
    return this.withReady(() => composite.latticeAddIssueComments(this, issueId, comments))
  }

  /** 12c：全局增量评论 */
  latticeCommentsSince(query?: LatticeCommentIncrementQuery): Promise<LatticeResult<LatticeCommentIncrement>> {
    return this.withReady(() => composite.latticeCommentsSince(this, query))
  }

  /** 12d：评论游标 */
  latticeCommentCursor(): Promise<LatticeResult<number>> {
    return this.withReady(() => composite.latticeCommentCursor(this))
  }

  /** 13a：各实例的项目索引 */
  latticeWorkspaceIndexes(userId?: string): Promise<LatticeResult<LatticeDeviceWorkspace[]>> {
    return this.withReady(() => composite.latticeWorkspaceIndexes(this, userId))
  }

  /** 13b：单个工作区肖像 */
  latticeWorkspacePortal(query: LatticeWorkspacePortalQuery): Promise<LatticeResult<LatticeDeviceWorkspace | null>> {
    return this.withReady(() => composite.latticeWorkspacePortal(this, query))
  }

  /** 13c：上报本机索引 */
  latticeUpsertWorkspaceIndex(input: LatticeWorkspaceIndexInput): Promise<LatticeResult<LatticeDeviceWorkspace>> {
    return this.withReady(() => composite.latticeUpsertWorkspaceIndex(this, input))
  }

  /** 13d：上报工作区肖像 */
  latticeUpsertWorkspacePortal(input: LatticeWorkspacePortalInput): Promise<LatticeResult<LatticeDeviceWorkspace>> {
    return this.withReady(() => composite.latticeUpsertWorkspacePortal(this, input))
  }

  /** **E1（扩展）**：批量取状态，`not_found` 折 `null`（依赖门禁用） */
  latticeIssueStatuses(query: LatticeIssueStatusesQuery): Promise<LatticeResult<LatticeIssueStatuses>> {
    return this.withReady(() => composite.latticeIssueStatuses(this, query))
  }

  /** 释放出站句柄（幂等、不抛）；不删凭据文件 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try {
      await this.transport.dispose()
    } catch {
      /* best-effort */
    }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  /** 地址解析失败时，所有方法统一返回同一个信封（零请求） */
  private withReady<T>(fn: () => Promise<LatticeResult<T>>): Promise<LatticeResult<T>> {
    if (this.initFailure !== null) return Promise.resolve(this.initFailure)
    if (this.disposed) {
      return Promise.resolve(latticeFail({ status: 0, code: 'internal_error', reason: 'client 已 dispose，不能再发请求' }))
    }
    return fn()
  }

  /** 让组合层能拿到当前会话账号（不暴露 session 对象） */
  get currentUserId(): string | null {
    return this.authSession.accountId
  }

  /** 组合层内部用：把 200 + data 包成信封（保持类型统一） */
  static ok<T>(data: T): LatticeResult<T> {
    return latticeOk(200, data)
  }
}
