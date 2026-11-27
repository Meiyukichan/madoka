/**
 * `CastboardClient`：**总入口**。一个实例 = 一份会话 + 一个出站句柄 + 一个并发闸。
 *
 * 三层结构（别混）：
 *  - **原子层**（8 个分组，协议面 1:1）：`auth` / `project` / `issue` / `teamwork` / `device` / `file` / `ops` / `admin`
 *  - **组合层**（24 + E1）：直接挂在 client 上（`client.issueClaim(...)`）——这是插件真正调的层
 *  - **逃生口**：`client.request()` / `client.raw()`
 *
 * 构造是**同步、无 I/O**的（协议地址解析只读 env 与 config.json，最多一次 stat）。
 *
 * 文档：`docs/design/castboard-sdk-design.zh.md` §0 / §9 / §10
 */

import { CastboardAdminApi } from './admin.js'
import { CastboardAuth, type CastboardAuthDevice, type CastboardAuthGrant } from './auth.js'
import { CastboardAuthApi } from './auth-api.js'
import { CastboardDeviceApi } from './device.js'
import { mineInstance, teamworkBaseUrl, type BaseUrlOptions } from './env.js'
import { CastboardFileApi } from './file.js'
import { CastboardIssueApi } from './issue/index.js'
import { CastboardOpsApi } from './ops.js'
import { CastboardProjectApi } from './project.js'
import { castboardFail, castboardOk, type CastboardResult } from './result.js'
import { CastboardTeamworkApi } from './teamwork/index.js'
import {
  CASTBOARD_DEFAULT_MAX_CONCURRENCY,
  CASTBOARD_DEFAULT_RETRIES,
  CASTBOARD_DEFAULT_TIMEOUT_MS,
  CastboardTransport,
  type CastboardRawOptions,
  type CastboardRequestOptions,
} from './transport.js'
import type { CastboardEventLoggerLike } from './log.js'
import { setCastboardLogger } from './log.js'
import type { CastboardFetch, CastboardFetchOptions } from './net.js'
import type { CastboardGlobalRole, CastboardOs } from './types.js'
import * as composite from './sdk.js'
import type {
  CastboardIssueAbandonResult,
  CastboardIssueAddCommentsResult,
  CastboardIssueAttachmentDownloadOptions,
  CastboardIssueAttachmentDownloadResult,
  CastboardIssueClaimResult,
  CastboardIssueCommentInput,
  CastboardIssueCreateInput,
  CastboardIssueCreateManyResult,
  CastboardIssueCreateResult,
  CastboardIssueFinalizeInput,
  CastboardIssueFinalizeResult,
  CastboardIssueRoutedInput,
  CastboardIssueRoutingResult,
  CastboardIssueStatuses,
  CastboardIssueStatusesQuery,
  CastboardIssueUpdateStatusInput,
  CastboardMyInstanceIssues,
  CastboardMyInstanceIssuesOptions,
  CastboardProjectMemberQuery,
  CastboardWorkspaceIndexInput,
  CastboardWorkspacePortalInput,
  CastboardWorkspacePortalQuery,
} from './sdk.js'
import type {
  CastboardComment,
  CastboardCommentIncrement,
  CastboardCommentIncrementQuery,
  CastboardDevice,
  CastboardDeviceWorkspace,
  CastboardIssue,
  CastboardProject,
  CastboardProjectMember,
  CastboardSource,
  CastboardSourceInput,
} from './types.js'

export interface CastboardClientOptions extends BaseUrlOptions {
  // ── 会话 ──────────────────────────────────────────────────────────────
  /** 凭据目录；缺省 `~/.dsh/storages/teamwork`（始终持久化） */
  home?: string
  /** 直接注入会话（CI / 测试）；优先于 `tokenProvider` */
  credentials?: { accountId: string; accountToken: string; ttlSeconds?: number; displayName?: string | null; globalRole?: CastboardGlobalRole }
  /** 异步解析会话（自定义凭据源） */
  tokenProvider?: () => Promise<{ accountId: string; accountToken: string; ttlSeconds?: number } | null>
  /** `/auth/token` 的可选设备信息；函数形式每次刷新时取最新值。 */
  authDevice?: CastboardAuthDevice | (() => CastboardAuthDevice | undefined)
  /** 401 时通知调用方清自己的缓存 */
  onTokenInvalid?: () => void
  // ── 身份兜底（组合层用）───────────────────────────────────────────────
  userId?: string
  instance?: string
  os?: CastboardOs
  // ── 传输 ──────────────────────────────────────────────────────────────
  timeoutMs?: number
  maxConcurrency?: number
  retries?: number
  fetchImpl?: CastboardFetch
  /** TLS / 代理（TLS 缺省严格校验） */
  tls?: CastboardFetchOptions
  onRequest?: (info: { method: string; path: string; status: number; ms: number }) => void
  // ── 能力 ──────────────────────────────────────────────────────────────
  /** 启动时探测 `/version`（默认 false：显式调 `ops.probe()` 或第一次业务请求前自行探测） */
  probe?: boolean
  strictProtocol?: boolean
  /** 诊断日志（宿主用发布包 `createEventLogger` 造一个传进来） */
  logger?: CastboardEventLoggerLike | null
}

export class CastboardClient {
  readonly baseUrl: string
  readonly timeoutMs: number
  readonly maxConcurrency: number
  readonly maxRetries: number
  readonly userId: string | undefined
  readonly instance: string | undefined
  readonly os: CastboardOs | undefined

  readonly auth: CastboardAuthApi
  readonly project: CastboardProjectApi
  readonly issue: CastboardIssueApi
  readonly teamwork: CastboardTeamworkApi
  readonly device: CastboardDeviceApi
  readonly file: CastboardFileApi
  readonly ops: CastboardOpsApi
  readonly admin: CastboardAdminApi

  private readonly authSession: CastboardAuth
  private readonly transport: CastboardTransport
  private readonly options: CastboardClientOptions
  private readonly initFailure: CastboardResult<never> | null
  private disposed = false

  constructor(options: CastboardClientOptions = {}) {
    this.options = options
    if (options.logger !== undefined) setCastboardLogger(options.logger)

    this.timeoutMs = options.timeoutMs ?? CASTBOARD_DEFAULT_TIMEOUT_MS
    this.maxConcurrency = options.maxConcurrency ?? CASTBOARD_DEFAULT_MAX_CONCURRENCY
    this.maxRetries = options.retries ?? CASTBOARD_DEFAULT_RETRIES
    this.userId = options.userId
    this.instance = options.instance
    this.os = options.os

    const resolved = teamworkBaseUrl(options)
    // 解析失败时不做 I/O：所有方法统一返回同一个 invalid_host 信封
    this.baseUrl = resolved.ok ? resolved.value : ''
    this.initFailure = resolved.ok
      ? null
      : castboardFail({ status: 0, code: 'invalid_host', reason: resolved.reason, value: resolved.value })

    let transportRef: CastboardTransport | undefined
    this.authSession = new CastboardAuth({
      ...(options.home === undefined ? {} : { home: options.home }),
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
      authExchange: async (input) => {
        const transport = transportRef
        if (transport === undefined) throw new Error('auth transport is not ready')
        const result = await transport.call<CastboardAuthGrant>('authToken', {}, { body: input })
        if (!result.ok) {
          throw Object.assign(new Error(result.reason), { status: result.status, code: result.code })
        }
        if (result.data === null || typeof result.data !== 'object') {
          throw new Error('/auth/token 响应不是对象')
        }
        return result.data
      },
      ...(options.authDevice === undefined ? {} : { device: options.authDevice }),
      ...(options.onTokenInvalid === undefined ? {} : { onTokenInvalid: options.onTokenInvalid }),
      serverKey: this.baseUrl,
    })

    this.transport = new CastboardTransport({
      baseUrl: this.baseUrl === '' ? 'http://127.0.0.1:3939/dsh-teamwork/v1' : this.baseUrl,
      timeoutMs: this.timeoutMs,
      maxConcurrency: this.maxConcurrency,
      retries: this.maxRetries,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.tls === undefined ? {} : { fetchOptions: options.tls }),
      ...(options.onRequest === undefined ? {} : { onRequest: options.onRequest }),
      auth: this.authSession,
    })
    transportRef = this.transport

    this.auth = new CastboardAuthApi(this.transport, this.authSession)
    this.project = new CastboardProjectApi(this.transport)
    this.issue = new CastboardIssueApi(this.transport)
    this.teamwork = new CastboardTeamworkApi(this.transport)
    this.device = new CastboardDeviceApi(this.transport)
    this.file = new CastboardFileApi(this.transport)
    this.ops = new CastboardOpsApi(this.transport, {
      ...(options.strictProtocol === undefined ? {} : { strictProtocol: options.strictProtocol }),
    })
    this.admin = new CastboardAdminApi(this.transport)

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

  /** 当前设备实例（本机 IPv4:3080）。 */
  get mineInstance(): string {
    return mineInstance()
  }

  get accountToken(): string | null {
    return this.authSession.accountToken
  }

  get globalRole(): CastboardGlobalRole | undefined {
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
  async request<T>(path: string, options: CastboardRequestOptions = {}): Promise<CastboardResult<T>> {
    if (this.initFailure !== null) return this.initFailure
    return this.transport.request<T>(path, options)
  }

  /** 按裸路径发原始请求 */
  async raw(path: string, options: CastboardRawOptions = {}): Promise<CastboardResult<Response>> {
    if (this.initFailure !== null) return this.initFailure
    return this.transport.raw(path, options)
  }

  /** 能力探测（把 `/version.endpoints[]` 装进闸） */
  async probe(): Promise<CastboardResult<{ protocol: string; endpoints: string[] }>> {
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
  castboardMyProjects(): Promise<CastboardResult<CastboardProject[]>> {
    return this.withReady(() => composite.queryMyProjects(this))
  }

  /** 2：项目成员（`manager:true` 只留能派活的角色） */
  castboardProjectMembers(projectId: number | string, options?: CastboardProjectMemberQuery): Promise<CastboardResult<CastboardProjectMember[]>> {
    return this.withReady(() => composite.queryProjectMembers(this, projectId, options))
  }

  /** 3：指定用户的在线设备 */
  castboardUserDevices(userId: string): Promise<CastboardResult<CastboardDevice[]>> {
    return this.withReady(() => composite.queryUserDevices(this, userId))
  }

  /** 4：本机名下 issue（翻页 + 本地判据） */
  castboardMyInstanceIssues(options?: CastboardMyInstanceIssuesOptions): Promise<CastboardResult<CastboardMyInstanceIssues>> {
    return this.withReady(() => composite.queryMyInstanceIssues(this, options))
  }

  /** 5a：创建单条 */
  issueCreate(input: CastboardIssueCreateInput): Promise<CastboardResult<CastboardIssueCreateResult>> {
    return this.withReady(() => composite.issueCreate(this, input))
  }

  /** 5b：批量创建 */
  issueCreateMany(inputs: readonly CastboardIssueCreateInput[]): Promise<CastboardResult<CastboardIssueCreateManyResult>> {
    return this.withReady(() => composite.issueCreateMany(this, inputs))
  }

  /** 6：单条状态更新 */
  issueUpdateStatus(input: CastboardIssueUpdateStatusInput): Promise<CastboardResult<CastboardIssue>> {
    return this.withReady(() => composite.issueUpdateStatus(this, input))
  }

  /** 7：认领（`expectedStatus:'pending'` CAS；`status_conflict` 不要重试） */
  issueClaim(issueIds: readonly string[]): Promise<CastboardResult<CastboardIssueClaimResult>> {
    return this.withReady(() => composite.issueClaim(this, issueIds))
  }

  /** 8：批量放弃 */
  issueAbandon(issueIds: readonly string[]): Promise<CastboardResult<CastboardIssueAbandonResult>> {
    return this.withReady(() => composite.issueAbandon(this, issueIds))
  }

  /** 8b：批量进规划 */
  issueRouting(issueIds: readonly string[]): Promise<CastboardResult<CastboardIssueRoutingResult>> {
    return this.withReady(() => composite.issueRouting(this, issueIds))
  }

  /** 8c：开始执行 */
  issueRunning(issueId: string): Promise<CastboardResult<CastboardIssue>> {
    return this.withReady(() => composite.issueRunning(this, issueId))
  }

  /** 8d：收尾 + 挂产物（先上传再改状态） */
  issueFinalize(issueId: string, input: CastboardIssueFinalizeInput): Promise<CastboardResult<CastboardIssueFinalizeResult>> {
    return this.withReady(() => composite.issueFinalize(this, issueId, input))
  }

  /** 9：规划回填（只允许 accepted / routing） */
  issueRouted(issueId: string, input: CastboardIssueRoutedInput): Promise<CastboardResult<CastboardIssue>> {
    return this.withReady(() => composite.issueRouted(this, issueId, input))
  }

  /** 10a：查来源字典 */
  castboardIssueSources(code?: string): Promise<CastboardResult<CastboardSource[]>> {
    return this.withReady(() => composite.castboardIssueSources(this, code))
  }

  /** 10b：注册 / 更新来源 */
  castboardAddIssueSource(input: CastboardSourceInput): Promise<CastboardResult<CastboardSource>> {
    return this.withReady(() => composite.castboardAddIssueSource(this, input))
  }

  /** 11：附件下载到本地目录（`options.role` 省略 = assigner / assignee 两种角色都要） */
  castboardDownloadIssueAttachments(
    issueId: string,
    outputDir: string,
    options?: CastboardIssueAttachmentDownloadOptions,
  ): Promise<CastboardResult<CastboardIssueAttachmentDownloadResult>> {
    return this.withReady(() => composite.castboardDownloadIssueAttachments(this, issueId, outputDir, options))
  }

  /** 12a：查一条 issue 的评论 */
  castboardIssueComments(issueId: string): Promise<CastboardResult<CastboardComment[]>> {
    return this.withReady(() => composite.castboardIssueComments(this, issueId))
  }

  /** 12b：批量追加评论（同 `commentId` 幂等） */
  castboardAddIssueComments(issueId: string, comments: readonly CastboardIssueCommentInput[]): Promise<CastboardResult<CastboardIssueAddCommentsResult>> {
    return this.withReady(() => composite.castboardAddIssueComments(this, issueId, comments))
  }

  /** 12c：全局增量评论 */
  castboardCommentsSince(query?: CastboardCommentIncrementQuery): Promise<CastboardResult<CastboardCommentIncrement>> {
    return this.withReady(() => composite.castboardCommentsSince(this, query))
  }

  /** 12d：评论游标 */
  castboardCommentCursor(): Promise<CastboardResult<number>> {
    return this.withReady(() => composite.castboardCommentCursor(this))
  }

  /** 13a：各实例的项目索引 */
  castboardWorkspaceIndexes(userId?: string): Promise<CastboardResult<CastboardDeviceWorkspace[]>> {
    return this.withReady(() => composite.castboardWorkspaceIndexes(this, userId))
  }

  /** 13b：单个工作区肖像 */
  castboardWorkspacePortal(query: CastboardWorkspacePortalQuery): Promise<CastboardResult<CastboardDeviceWorkspace | null>> {
    return this.withReady(() => composite.castboardWorkspacePortal(this, query))
  }

  /** 13c：上报本机索引 */
  castboardUpsertWorkspaceIndex(input: CastboardWorkspaceIndexInput): Promise<CastboardResult<CastboardDeviceWorkspace>> {
    return this.withReady(() => composite.castboardUpsertWorkspaceIndex(this, input))
  }

  /** 13d：上报工作区肖像 */
  castboardUpsertWorkspacePortal(input: CastboardWorkspacePortalInput): Promise<CastboardResult<CastboardDeviceWorkspace>> {
    return this.withReady(() => composite.castboardUpsertWorkspacePortal(this, input))
  }

  /** **E1（扩展）**：批量取状态，`not_found` 折 `null`（依赖门禁用） */
  castboardIssueStatuses(query: CastboardIssueStatusesQuery): Promise<CastboardResult<CastboardIssueStatuses>> {
    return this.withReady(() => composite.castboardIssueStatuses(this, query))
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
  private withReady<T>(fn: () => Promise<CastboardResult<T>>): Promise<CastboardResult<T>> {
    if (this.initFailure !== null) return Promise.resolve(this.initFailure)
    if (this.disposed) {
      return Promise.resolve(castboardFail({ status: 0, code: 'internal_error', reason: 'client 已 dispose，不能再发请求' }))
    }
    return fn()
  }

  /** 让组合层能拿到当前会话账号（不暴露 session 对象） */
  get currentUserId(): string | null {
    return this.authSession.accountId
  }

  /** 组合层内部用：把 200 + data 包成信封（保持类型统一） */
  static ok<T>(data: T): CastboardResult<T> {
    return castboardOk(200, data)
  }
}
