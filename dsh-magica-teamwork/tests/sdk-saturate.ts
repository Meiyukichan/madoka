/**
 * SDK 饱和测试（真机）：**起本地服务 → 用 SDK 打满每个端点 + 每个组合方法 + 各类失败场景**。
 *
 * 它不是单测的替代品，而是"上线前的总验收"：
 *  1. **端点覆盖**：49 条协议端点（端点表）逐条命中（用 `onRequest` 钩子把真实请求反查到端点名）；
 *  2. **方法覆盖**：8 个原子分组 + 24 个组合方法 + E1 全部调用；
 *  3. **场景覆盖**：成功路径 + 鉴权/校验/冲突/幂等/分页/归档/上限/降级等失败路径；
 *  4. **报告**：打印覆盖率与失败清单，有失败或未覆盖 → 进程退出码 1。
 *
 * 用法：
 *   node scripts/sdk-saturate.mjs                 # 自己起本地服务（随机端口 + 临时目录）
 *   node scripts/sdk-saturate.mjs --url <baseUrl> # 打已部署的服务（第三方实现验收）
 *   node scripts/sdk-saturate.mjs --verbose       # 逐步打印
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CASTBOARD_COMPOSITES,
  CASTBOARD_ENDPOINTS,
  CASTBOARD_EXTENSION_COMPOSITES,
  createCastboardClient,
  type CastboardClient,
  type CastboardClientOptions,
  type CastboardIssue,
} from '../src/sdk/index.js'
import { startServer } from '../src/server/main.js'

const PASSWORD = 'correct horse battery'
const PASSWORD2 = 'another good passphrase'
const PASSWORD_OLD = PASSWORD

// ────────────────────────────────────────────────────────────────────────────
// 结果收集
// ────────────────────────────────────────────────────────────────────────────

interface CheckResult {
  section: string
  name: string
  ok: boolean
  detail?: string
}

const results: CheckResult[] = []
let section = 'init'

function begin(next: string): void {
  section = next
}

function check(name: string, condition: boolean, detail?: string): void {
  results.push({ section, name, ok: condition, detail: condition ? undefined : detail })
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, ok ? undefined : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

function fail(name: string, fail_: { code?: string; status?: number; ok?: boolean }, code: string, status?: number): void {
  const ok = fail_.ok === false && fail_.code === code && (status === undefined || fail_.status === status)
  check(name, ok, ok ? undefined : `期望 code=${code}${status === undefined ? '' : ` status=${status}`}，实际 code=${fail_.code} status=${fail_.status}`)
}

// ────────────────────────────────────────────────────────────────────────────
// 端点覆盖：把真实请求反查到端点名
// ────────────────────────────────────────────────────────────────────────────

const ENDPOINT_MATCHERS: { name: string; method: string; re: RegExp }[] = Object.entries(CASTBOARD_ENDPOINTS).map(
  ([name, endpoint]) => {
    const pattern = endpoint.path
      .split('/')
      .map((seg) => (seg.startsWith('{') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')
    return { name, method: endpoint.method, re: new RegExp(`^${pattern}$`) }
  },
)

const covered = new Set<string>()

/** 端点表里的 path 是**相对前缀**的；`onRequest` 报的是完整 pathname，这里先剥前缀 */
let requestPrefix = ''

function observe(method: string, fullPath: string): void {
  const path = requestPrefix !== '' && fullPath.startsWith(requestPrefix) ? fullPath.slice(requestPrefix.length) : fullPath
  for (const matcher of ENDPOINT_MATCHERS) {
    if (matcher.method !== method) continue
    if (matcher.re.test(path)) covered.add(matcher.name)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 环境
// ────────────────────────────────────────────────────────────────────────────

interface Harness {
  baseUrl: string
  dataDir: string
  server?: Awaited<ReturnType<typeof startServer>>
  close: () => Promise<void>
}

async function boot(targetUrl: string | undefined, verbose: boolean): Promise<Harness> {
  if (targetUrl !== undefined && targetUrl !== '') {
    return { baseUrl: targetUrl, dataDir: '', close: async () => {} }
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-teamwork-saturate-'))
  const server = await startServer({ dataDir, port: 0, log: () => {}, rateLimit: false })
  if (verbose) console.log(`  服务已启动：http://127.0.0.1:${server.port}`)
  return {
    baseUrl: `http://127.0.0.1:${server.port}/dsh-teamwork/v1`,
    dataDir,
    server,
    close: async () => {
      await server.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

function client(baseUrl: string, extra: CastboardClientOptions = {}): CastboardClient {
  return createCastboardClient({
    baseUrl,
    home: mkdtempSync(join(tmpdir(), 'dsh-teamwork-saturate-client-')),
    onRequest: (info) => observe(info.method, info.path),
    ...extra,
  })
}

// ────────────────────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────────────────────

export interface SaturationReport {
  checks: CheckResult[]
  coveredEndpoints: string[]
  uncoveredEndpoints: string[]
  skippedInExternal: string[]
  failed: CheckResult[]
  ok: boolean
}

export async function runSaturation(options: { baseUrl?: string; verbose?: boolean } = {}): Promise<SaturationReport> {
  const verbose = options.verbose === true
  const external = options.baseUrl !== undefined && options.baseUrl !== ''
  const harness = await boot(options.baseUrl, verbose)
  const { baseUrl } = harness
  requestPrefix = new URL(baseUrl).pathname.replace(/\/+$/, '')
  const clients: CastboardClient[] = []
  const files: string[] = []
  const track = (c: CastboardClient): CastboardClient => {
    clients.push(c)
    return c
  }
  let home = ''

  try {
    // ════════════════════════════════════════════════════════════════════
    begin('认证')
    // ════════════════════════════════════════════════════════════════════
    const alice = track(client(baseUrl))
    const regA = await alice.auth.register({ accountId: 'sat-alice', password: PASSWORD, displayName: '饱和 Alice' })
    check('register 首账号为 administrator', regA.ok && regA.data.account.globalRole === 'administrator')
    eq('auth.state = authenticated', alice.state, 'authenticated')
    eq('accountToken 长度 64', (alice.accountToken ?? '').length, 64)

    const bob = track(client(baseUrl))
    const regB = await bob.auth.register({ accountId: 'sat-bob', password: PASSWORD, displayName: '饱和 Bob' })
    check('register 第二账号为 user', regB.ok && regB.data.account.globalRole === 'user')

    const meA = await alice.auth.me()
    eq('me.accountId', meA.ok ? meA.data.accountId : '(fail)', 'sat-alice')

    // 重复注册 → 409
    const dup = await track(client(baseUrl)).auth.register({ accountId: 'sat-alice', password: PASSWORD })
    fail('重复注册 → account_exists', dup, 'account_exists', 409)

    // 错密码 → 401 invalid_credentials
    const badLogin = await track(client(baseUrl)).auth.login({ accountId: 'sat-alice', password: 'wrong password!!' })
    fail('错密码 → invalid_credentials', badLogin, 'invalid_credentials', 401)

    // 登录既有账号
    const relogin = track(client(baseUrl))
    const loginOk = await relogin.auth.login({ accountId: 'sat-alice', password: PASSWORD })
    check('login 成功', loginOk.ok)
    eq('登录返回同一 accountToken', loginOk.ok ? loginOk.data.accountToken : '', alice.accountToken ?? '')

    // 查账号（administrator）
    const lookup = await alice.auth.lookupAccount('sat-bob')
    check('lookupAccount 存在', lookup.ok && lookup.data.exists === true)
    const lookupMissing = await alice.auth.lookupAccount('no-such-account')
    check('lookupAccount 不存在', lookupMissing.ok && lookupMissing.data.exists === false)

    // 非管理员调用 admin 端点 → 403（本地拦，零请求）
    const bobAdmin = await bob.admin.accounts()
    fail('非管理员 admin 端点 → forbidden', bobAdmin, 'forbidden', 403)

    // 未登录 client → login_required（本地，零请求）
    const anon = track(client(baseUrl))
    const anonCall = await anon.castboardMyProjects()
    fail('未登录 → login_required', anonCall, 'login_required', 401)

    // 错密钥 → 401 unauthorized → login_required，并且内存会话被清
    const forged = track(client(baseUrl, { credentials: { accountId: 'sat-alice', accountToken: 'f'.repeat(64), ttlSeconds: 3600 } }))
    const forgedMe = await forged.auth.me()
    fail('伪造密钥 → login_required', forgedMe, 'login_required', 401)
    check('伪造密钥后内存会话被清', forged.accountToken === null)

    // 改密码 → 拿新密钥 → 旧密钥失效
    const oldToken = alice.accountToken ?? ''
    const changed = await alice.auth.changePassword({ oldPassword: PASSWORD_OLD, newPassword: PASSWORD2 })
    check('changePassword 成功', changed.ok)
    check('changePassword 换掉了密钥', (alice.accountToken ?? '') !== oldToken)
    const staleClient = track(client(baseUrl, { credentials: { accountId: 'sat-alice', accountToken: oldToken, ttlSeconds: 3600 } }))
    const stale = await staleClient.auth.me()
    fail('旧密钥失效 → login_required', stale, 'login_required', 401)
    const reChanged = await alice.auth.changePassword({ oldPassword: PASSWORD2, newPassword: PASSWORD })
    check('改回原密码', reChanged.ok)

    // 登出（清本地会话）→ 后续调用 login_required
    const logoutClient = track(client(baseUrl))
    await logoutClient.auth.login({ accountId: 'sat-bob', password: PASSWORD })
    const loggedOut = await logoutClient.auth.logout()
    check('logout 成功', loggedOut.ok)
    check('logout 后不再是 authenticated', logoutClient.state !== 'authenticated', `state=${logoutClient.state}`)

    if (harness.server !== undefined) {
      // 凭据文件持久化：写盘 → 新 client 复用 → 换 serverKey 不复用
      home = mkdtempSync(join(tmpdir(), 'dsh-teamwork-creds-'))
      const persisted = createCastboardClient({
        baseUrl,
        home,
        onRequest: (info) => observe(info.method, info.path),
      })
      const persistedLogin = await persisted.auth.login({ accountId: 'sat-bob', password: PASSWORD })
      check('persist 模式登录成功', persistedLogin.ok)
      check('凭据文件已落盘', existsSync(join(home, '.credentials.json')) && existsSync(join(home, '.credentials.key')))
      const raw = readFileSync(join(home, '.credentials.json'), 'utf8')
      check('凭据文件是 AES-GCM 信封（不含明文 token）', !raw.includes('sat-bob') && raw.includes('"alg": "aes-256-gcm"'))
      const restored = createCastboardClient({ baseUrl, home, onRequest: (info) => observe(info.method, info.path) })
      eq('新 client 从凭据文件恢复会话', restored.state, 'authenticated')
      const restoredMe = await restored.auth.me()
      check('恢复后的会话可用', restoredMe.ok)
      // 端口不同的 baseUrl → 不复用
      const otherServerKey = createCastboardClient({ baseUrl: `${baseUrl}-other`, home })
      check('serverKey 不匹配 → 不复用凭据', otherServerKey.state !== 'authenticated')
      await persisted.dispose()
      await restored.dispose()
      await otherServerKey.dispose()
    }

    // ════════════════════════════════════════════════════════════════════
    begin('项目与成员')
    // ════════════════════════════════════════════════════════════════════
    const project = await alice.teamwork.project.create({ name: '饱和项目', visibility: 'private', description: 'dd' })
    check('project.create 成功', project.ok, project.ok ? '' : `${project.code}: ${project.reason}`)
    const projectId = project.ok ? project.data.id : 0
    check('project.owner = 创建人', project.ok && project.data.owner === 'sat-alice')

    // 项目名重复 → 409
    const dupProject = await alice.teamwork.project.create({ name: '饱和项目' })
    fail('重名 → project_name_exists', dupProject, 'project_name_exists', 409)

    // 非法 visibility → 本地 400
    // @ts-expect-error 故意传非法值
    const badVisibility = await alice.teamwork.project.create({ name: 'x1', visibility: 'secret' })
    fail('非法 visibility → invalid_visibility', badVisibility, 'invalid_visibility', 400)

    // owner 不可指定 → 本地 400
    const withOwner = await alice.teamwork.project.create({ name: 'x2', owner: 'sat-bob' })
    fail('指定 owner → invalid_body', withOwner, 'invalid_body', 400)

    const projectList = await alice.teamwork.project.list({ pageNum: 1, pageSize: 10 })
    check('project.list 分页', projectList.ok && projectList.data.pageNum === 1)
    const projectMine = await alice.project.list()
    check('project.mine 裸数组', projectMine.ok && Array.isArray(projectMine.data))
    const projectDetail = await alice.teamwork.project.detail(projectId)
    check('project.detail 含 members', projectDetail.ok && projectDetail.data.members.length === 1)

    // 成员：加 manager / 加 owner 被拒 / 非法角色 / 移除 owner 被拒
    const addBob = await alice.teamwork.project.memberAdd(projectId, { accountId: 'sat-bob', role: 'manager' })
    check('memberAdd manager 成功', addBob.ok, addBob.ok ? '' : `${addBob.code}: ${addBob.reason}`)
    const addOwner = await alice.teamwork.project.memberAdd(projectId, { accountId: 'sat-bob', role: 'owner' as never })
    fail('授予 owner → owner_role_not_assignable', addOwner, 'owner_role_not_assignable', 400)
    const addBadRole = await alice.teamwork.project.memberAdd(projectId, { accountId: 'sat-bob', role: 'boss' as never })
    fail('非法角色 → invalid_role', addBadRole, 'invalid_role', 400)
    const removeOwner = await alice.teamwork.project.memberRemove(projectId, 'sat-alice')
    fail('移除 owner → owner_cannot_be_removed', removeOwner, 'owner_cannot_be_removed', 409)

    const members = await alice.project.members(projectId)
    check('project.members 2 人', members.ok && members.data.length === 2)
    const managerOnly = await alice.castboardProjectMembers(projectId, { manager: true })
    check('castboardProjectMembers({manager}) 过滤', managerOnly.ok && managerOnly.data.length === 2)

    // 归档 → 只读
    const archived = await alice.teamwork.project.update(projectId, { status: 'archived' })
    check('project.update → archived', archived.ok && archived.data.status === 'archived')
    const archWrite = await alice.teamwork.project.update(projectId, { description: '不许改' })
    fail('归档后写其它字段 → project_archived', archWrite, 'project_archived', 409)
    const unarchived = await alice.teamwork.project.update(projectId, { status: 'active' })
    check('project.update → active（可还原）', unarchived.ok)

    // 转让 owner（Bob 先升 leader 才能接 public；此处 private 不限）
    const transfer = await alice.teamwork.project.transferOwner(projectId, 'sat-bob')
    check('transferOwner → sat-bob', transfer.ok && transfer.data.owner === 'sat-bob')
    const transferBack = await bob.teamwork.project.transferOwner(projectId, 'sat-alice')
    check('transferOwner 回退给 sat-alice', transferBack.ok)

    // 有 issue 的项目不能删（放在创建 issue 之后测）

    // ════════════════════════════════════════════════════════════════════
    begin('设备与工作区')
    // ════════════════════════════════════════════════════════════════════
    const sync = await alice.device.sync([{ host: '10.5.5.5', port: 3080, os: 'linux' }])
    check('device.sync 成功', sync.ok && sync.data.synced >= 1)
    const devices = await alice.device.list()
    check('device.list 只含 active', devices.ok && devices.data.every((d) => d.status === 'active'))
    const devMine = await alice.teamwork.device.mine({ pageNum: 1, pageSize: 10 })
    check('teamwork.device.mine 分页', devMine.ok && devMine.data.pageNum === 1)
    // 空同步 = 全部下线
    const emptySync = await alice.device.sync([])
    check('device.sync([]) 把设备下线', emptySync.ok && emptySync.data.deactivated >= 1)
    const afterDown = await alice.device.list()
    check('下线后在线列表为空', afterDown.ok && afterDown.data.length === 0)
    const resync = await alice.device.sync([{ host: '10.5.5.5', port: 3080, os: 'linux' }])
    check('重新上线成功', resync.ok && resync.data.synced >= 1)
    const badDevice = await alice.device.sync([{ host: '' }])
    fail('空 host → invalid_body', badDevice, 'invalid_body', 400)
    // 删设备（自己刚上报的 + 不存在的）
    const mineAll = await alice.teamwork.device.mine({ pageNum: 1, pageSize: 50 })
    const ownDevice = mineAll.ok ? mineAll.data.items.find((d) => d.host === '10.5.5.5') : undefined
    if (ownDevice !== undefined) {
      const removedDevice = await alice.teamwork.device.remove(ownDevice.id)
      check('teamwork.device.remove', removedDevice.ok)
    }
    const removedMissing = await alice.teamwork.device.remove(999999)
    fail('删不存在的设备 → device_not_found', removedMissing, 'device_not_found', 404)
    await alice.device.sync([{ host: '10.5.5.5', port: 3080, os: 'linux' }])
    const devList = await alice.teamwork.device.mine({ pageNum: 2, pageSize: 1 })
    check('设备分页第 2 页', devList.ok && devList.data.pageNum === 2)

    const idx = await alice.issue.workspace.upsert({ instance: '10.5.5.5:3080', type: 'index', detail: '# 索引' })
    check('workspace.upsert index', idx.ok && idx.data.workspaceId === null)
    const portal = await alice.issue.workspace.upsert({
      instance: '10.5.5.5:3080',
      workspaceId: 'ws-sat',
      cwd: 'D:/sat',
      type: 'portal',
      detail: '# 门户',
    })
    check('workspace.upsert portal', portal.ok && portal.data.workspaceId === 'ws-sat')
    const badIndex = await alice.issue.workspace.upsert({ instance: '10.5.5.5:3080', type: 'index', detail: 'x', workspaceId: 'w' } as never)
    fail('index 带 workspaceId → invalid_workspace_shape', badIndex, 'invalid_workspace_shape', 400)
    const badPortal = await alice.issue.workspace.upsert({ instance: '10.5.5.5:3080', type: 'portal', detail: 'x' } as never)
    fail('portal 缺 workspaceId → invalid_workspace_shape', badPortal, 'invalid_workspace_shape', 400)
    const both = await alice.issue.workspace.list({ cwd: 'a', cwdPrefix: 'b' })
    fail('cwd+cwdPrefix 同传 → invalid_request', both, 'invalid_request', 400)
    const wsList = await alice.issue.workspace.list({ instance: '10.5.5.5:3080', type: 'portal' })
    check('workspace.list 精确匹配', wsList.ok && wsList.data.length === 1)
    const wsPrefix = await alice.issue.workspace.list({ cwdPrefix: 'D:/sa' })
    check('workspace.list 前缀匹配', wsPrefix.ok && wsPrefix.data.length === 1)

    // ════════════════════════════════════════════════════════════════════
    begin('来源字典')
    // ════════════════════════════════════════════════════════════════════
    const regSource = await alice.issue.source.register([{ code: 'sat-source', description: '饱和', pluginName: 'sat' }])
    check('source.register', regSource.ok)
    const badSource = await alice.issue.source.register([{ code: 'Bad Code' }])
    fail('非法 code → invalid_source_code', badSource, 'invalid_source_code', 400)
    const sources = await alice.issue.source.list('sat-source')
    check('source.list 命中', sources.ok && sources.data.length === 1)
    const sourceRow = sources.ok ? sources.data[0] : undefined
    const updSource = await alice.issue.source.update(sourceRow?.id ?? 0, { description: '改过' })
    check('source.update', updSource.ok && updSource.data.description === '改过')
    const delSource = await alice.issue.source.remove(sourceRow?.id ?? 0)
    check('source.remove', delSource.ok)
    const delAgain = await alice.issue.source.remove(sourceRow?.id ?? 0)
    fail('删不存在的来源 → source_not_found', delAgain, 'source_not_found', 404)

    // ════════════════════════════════════════════════════════════════════
    begin('Issue 原子面')
    // ════════════════════════════════════════════════════════════════════
    const issueId = `sat-${Date.now()}`
    const submit = await alice.issue.submit([
      {
        issueId,
        title: '饱和 issue',
        detail: '正文',
        assignee: 'sat-bob',
        projectId,
        urgency: 'urgent',
        permission: '',
        dependsOn: ['dep-1', 'dep-2'],
        assignerMeta: { title: '兜底标题', detail: '兜底正文', extra: 1 },
        source: 'self',
      },
      { title: '批量第二条', assignee: 'sat-alice' },
    ])
    check('issue.submit 批量 2 条', submit.ok && submit.data.length === 2)

    const got = await alice.issue.get(issueId)
    check('issue.get', got.ok)
    if (got.ok) {
      eq('dependsOn 归一为 string[]', got.data.dependsOn, ['dep-1', 'dep-2'])
      eq('permission "" → null', got.data.permission, null)
      check('assignerMeta 原样保留', typeof got.data.assignerMeta === 'string')
    }

    const badId = await alice.issue.get('x'.repeat(101))
    fail('issueId 过长 → invalid_issue_id', badId, 'invalid_issue_id', 400)
    const miss = await alice.issue.get('sat-no-such-issue')
    fail('不存在 → issue_not_found', miss, 'issue_not_found', 404)

    // 列表过滤 + 分页夹取
    const byStatus = await alice.issue.list({ status: 'pending', pageSize: 1000 })
    check('issue.list pageSize 夹到 200', byStatus.ok && byStatus.data.pageSize === 200)
    const byProject = await alice.issue.list({ projectId, pageNum: 1, pageSize: 5 })
    check('issue.list projectId 过滤', byProject.ok && byProject.data.items.every((i) => i.projectId === projectId))
    const byKeyword = await alice.issue.list({ keyword: '饱和' })
    check('issue.list keyword 过滤', byKeyword.ok && byKeyword.data.items.length >= 1)
    const bySource = await alice.issue.list({ source: 'self' })
    check('issue.list source 过滤', bySource.ok)
    const badStatus = await alice.issue.list({ status: 'nope' as never })
    fail('非法 status → invalid_status', badStatus, 'invalid_status', 400)

    // 覆盖（部分字段 + 清空 detail）
    const replaced = await alice.issue.replace(issueId, { urgency: 'relaxed' })
    check('issue.replace 只改 urgency', replaced.ok && replaced.data.urgency === 'relaxed')
    const cleared = await alice.issue.replace(issueId, { detail: null })
    check('issue.replace detail=null 清空', cleared.ok && cleared.data.detail === null)
    const restSet = await alice.issue.replace(issueId, { detail: '又写回来' })
    check('issue.replace detail 写回', restSet.ok && restSet.data.detail === '又写回来')

    // 状态批量：部分成功（服务端 200 + failed[]）
    const st1 = await alice.issue.updateStatuses([
      { issueId, status: 'accepted', expectedStatus: 'pending', assigneeInstance: '10.5.5.5:3080' },
      { issueId: 'sat-missing', status: 'accepted' },
    ])
    check('updateStatuses 部分成功（success=1）', st1.ok && st1.data.success === 1)
    if (st1.ok) check('逐条失败原因 not_found', st1.data.failed.some((f) => f.reason === 'not_found'))
    const st2 = await alice.issue.updateStatuses([{ issueId, status: 'accepted', expectedStatus: 'pending' }])
    check('并发抢 → status_conflict', st2.ok && st2.data.failed[0]?.reason === 'status_conflict')
    // 非法 status / 空 issueId 在客户端就拦下（零请求），不会走到服务端
    const st3 = await alice.issue.updateStatuses([{ issueId: '', status: 'accepted' }])
    fail('空 issueId → invalid_issue_id（本地）', st3, 'invalid_issue_id', 400)
    const st4 = await alice.issue.updateStatuses([{ issueId, status: 'bogus' as never }])
    fail('非法 status → invalid_status（本地）', st4, 'invalid_status', 400)

    // 附件 + 评论
    const fileBytes = Buffer.from('sat file payload', 'utf8')
    const uploaded = await alice.file.upload({ name: '饱和 输入.txt', data: fileBytes })
    check('file.upload', uploaded.ok, uploaded.ok ? '' : `${uploaded.code}: ${uploaded.reason}`)
    const fileId = uploaded.ok ? uploaded.data.fileId : ''
    const emptyUpload = await alice.file.upload({ name: 'empty.txt', data: Buffer.alloc(0) })
    fail('0 字节上传 → invalid_file_name', emptyUpload, 'invalid_file_name', 400)
    const attachIn = await alice.issue.attachment.add([
      { targetType: 'issue', targetId: issueId, fileId, role: 'assigner', description: '输入' },
    ])
    check('attachment.add（issue/assigner）', attachIn.ok && attachIn.data.count === 1)
    const attachUpsert = await alice.issue.attachment.add([
      { targetType: 'issue', targetId: issueId, fileId, role: 'assignee', fileName: '饱和 产物.txt' },
    ])
    check('attachment.add 同 target+file upsert（角色覆盖）', attachUpsert.ok)
    const attachList = await alice.issue.attachment.list({ targetType: 'issue', targetId: issueId })
    check('attachment.list 只有 1 行（upsert）', attachList.ok && attachList.data.length === 1)
    if (attachList.ok) eq('attachment.list 角色已覆盖', attachList.data[0]?.role, 'assignee')
    const attachByRole = await alice.issue.attachment.list({ targetType: 'issue', targetId: issueId, role: 'assigner' })
    check('attachment.list(role=assigner) 为空', attachByRole.ok && attachByRole.data.length === 0)
    // 保留路径（GET /issues/{issueId}/attachments）仍要覆盖
    const legacyAttachList = await alice.raw(`/issues/${encodeURIComponent(issueId)}/attachments?role=assignee`)
    check('legacy issue 附件列表仍可用', legacyAttachList.ok)
    const badAttach = await alice.issue.attachment.add([
      { targetType: 'issue', targetId: 'x'.repeat(101), fileId, role: 'assigner' },
    ])
    fail('附件 targetId 非法 → invalid_issue_id', badAttach, 'invalid_issue_id', 400)
    const badRole = await alice.issue.attachment.add([
      { targetType: 'issue', targetId: issueId, fileId, role: 'output' as never },
    ])
    fail('附件 role 非法 → invalid_role（本地）', badRole, 'invalid_role', 400)

    const commentId = `sat-c-${Date.now()}`
    const c1 = await alice.issue.comment.add(issueId, { content: '第一条', commentId, commentRole: 'assigner' })
    check('comment.add', c1.ok)
    const c2 = await alice.issue.comment.add(issueId, { content: '第一条', commentId })
    check('comment.add 同 id 幂等', c2.ok && c1.ok && c2.data.id === c1.data.id)
    const cBad = await alice.issue.comment.add(issueId, { content: '' })
    fail('空评论 → invalid_content', cBad, 'invalid_content', 400)
    const cList = await alice.issue.comment.list(issueId)
    check('comment.list 只有 1 条', cList.ok && cList.data.length === 1)
    const cursor = await alice.issue.comment.cursor()
    check('comment.cursor 是 number > 0', cursor.ok && typeof cursor.data === 'number' && cursor.data > 0)
    const since = await alice.issue.comment.listSince({ sinceId: 0, limit: 99999 })
    check('comment.listSince 夹取 limit', since.ok && since.data.items.length >= 1)
    const sinceTail = await alice.issue.comment.listSince({ sinceId: cursor.ok ? cursor.data : 0 })
    check('comment.listSince 空批 nextSinceId 不倒退', sinceTail.ok && sinceTail.data.nextSinceId >= (cursor.ok ? cursor.data : 0))

    // 文件下载 / 别名 / 非法 id / 删除
    const dl = await alice.file.download(fileId)
    check('file.download 字节一致', dl.ok && Buffer.compare(dl.data, fileBytes) === 0)
    const dlPublic = await alice.file.downloadPublic(fileId)
    check('file.downloadPublic 别名可用', dlPublic.ok)
    const dlBad = await alice.file.download('not-uuid')
    fail('非法 fileId → invalid_file_id', dlBad, 'invalid_file_id', 400)
    const dlMissing = await alice.file.download('11111111-1111-4111-8111-111111111111')
    fail('不存在的文件 → file_not_found', dlMissing, 'file_not_found', 404)
    // 删文件（administrator）：会先清附件引用，幂等
    const fileRemoved = await alice.file.remove(fileId)
    check('file.remove', fileRemoved.ok, fileRemoved.ok ? '' : `${fileRemoved.code}: ${fileRemoved.reason}`)
    const fileRemovedAgain = await alice.file.remove(fileId)
    check('file.remove 幂等（再删仍 204）', fileRemovedAgain.ok)
    const dlDeleted = await alice.file.download(fileId)
    fail('删后下载 → file_not_found', dlDeleted, 'file_not_found', 404)

    // 遗弃
    const abandoned = await alice.issue.abandon(issueId)
    check('issue.abandon', abandoned.ok)
    const afterAbandon = await alice.issue.get(issueId)
    check('遗弃后状态 abandoned', afterAbandon.ok && afterAbandon.data.status === 'abandoned')

    // 有 issue 的项目不能删
    const delProject = await alice.teamwork.project.remove(projectId)
    fail('有 issue 的项目 → project_has_issues', delProject, 'project_has_issues', 409)

    // ════════════════════════════════════════════════════════════════════
    begin('组合层')
    // ════════════════════════════════════════════════════════════════════
    const bobC = track(
      client(baseUrl, { instance: '10.6.6.6:3090', userId: 'sat-bob' }),
    )
    await bobC.auth.login({ accountId: 'sat-bob', password: PASSWORD })
    const aliceC = track(client(baseUrl, { instance: '10.5.5.5:3080', userId: 'sat-alice' }))
    const aliceCLogin = await aliceC.auth.login({ accountId: 'sat-alice', password: PASSWORD })
    check('组合层 alice 重新登录', aliceCLogin.ok, aliceCLogin.ok ? '' : `${aliceCLogin.code}: ${aliceCLogin.reason}`)

    // 新项目 + 新 issue 走完整链路
    const project2 = await aliceC.teamwork.project.create({ name: '组合项目', visibility: 'private' })
    const project2Id = project2.ok ? project2.data.id : 0
    await aliceC.teamwork.project.memberAdd(project2Id, { accountId: 'sat-bob', role: 'manager' })

    const src = await aliceC.castboardAddIssueSource({ code: 'sat-comp-source', pluginName: 'saturate' })
    check('castboardAddIssueSource', src.ok)
    const srcList = await aliceC.castboardIssueSources('sat-comp-source')
    check('castboardIssueSources', srcList.ok && srcList.data.length === 1)

    const compId = `sat-comp-${Date.now()}`
    const workdir = mkdtempSync(join(tmpdir(), 'dsh-teamwork-satfiles-'))
    files.push(workdir)
    const inputFile = join(workdir, 'in.txt')
    const outputFile = join(workdir, 'out.txt')
    writeFileSync(inputFile, '输入材料', 'utf8')
    writeFileSync(outputFile, '执行产物', 'utf8')

    const created = await aliceC.issueCreate({
      issueId: compId,
      title: '组合 issue',
      detail: '组合正文',
      assignee: 'sat-bob',
      projectId: project2Id,
      source: 'sat-comp-source',
      dependsOn: ['dep-x'],
      attachments: [{ path: inputFile, role: 'assigner', description: '输入件' }],
    })
    check('issueCreate（带附件/来源/dependsOn）', created.ok, created.ok ? '' : `${created.code}: ${created.reason}`)
    if (created.ok) {
      eq('issueCreate 附件 1 条', created.data.attachments.length, 1)
      eq('issueCreate dependsOn', created.data.issue.dependsOn, ['dep-x'])
    }
    const skip = await aliceC.issueCreate({ issueId: compId, title: '组合 issue', assignee: 'sat-bob' })
    check('issueCreate 撞 id 默认 skip', skip.ok && skip.data.skipped === true)

    const badCreate = await aliceC.issueCreate({ assignee: 'sat-bob' })
    fail('issueCreate 缺 title → invalid_request', badCreate, 'invalid_request', 400)
    const badAssignee = await aliceC.issueCreate({ title: 't', assignee: '', })
    fail('issueCreate 缺 assignee → invalid_request', badAssignee, 'invalid_request', 400)
    const badAssigner = await aliceC.issueCreate({ title: 't', assignee: 'sat-bob', assigner: 'sat-bob' })
    fail('issueCreate assigner 不符 → invalid_body', badAssigner, 'invalid_body', 400)
    const badCwd = await aliceC.issueCreate({ title: 't', assignee: 'sat-bob', cwd: 'x'.repeat(501) })
    fail('issueCreate cwd 过长 → invalid_request', badCwd, 'invalid_request', 400)
    const badUrgency = await aliceC.issueCreate({ title: 't', assignee: 'sat-bob', urgency: 'nope' as never })
    fail('issueCreate 非法 urgency → invalid_urgency', badUrgency, 'invalid_urgency', 400)
    const missingFile = await aliceC.issueCreate({ title: 't', assignee: 'sat-bob', attachments: [join(workdir, 'nope.txt')] })
    fail('附件不存在 → invalid_attachment', missingFile, 'invalid_attachment', 400)

    // 派活四步
    const myProjects = await aliceC.castboardMyProjects()
    check('castboardMyProjects', myProjects.ok && myProjects.data.some((p) => p.id === project2Id))
    const bobDeviceSync = await bobC.device.sync([{ host: '10.6.6.6', port: 3090, os: 'linux' }])
    check('bob 上报设备', bobDeviceSync.ok)
    const bobDevices = await aliceC.castboardUserDevices('sat-bob')
    check('castboardUserDevices', bobDevices.ok && bobDevices.data.some((d) => `${d.host}:${d.port}` === '10.6.6.6:3090'))
    const bobIndex = await bobC.castboardUpsertWorkspaceIndex({ detail: '# bob 索引' })
    check('castboardUpsertWorkspaceIndex', bobIndex.ok && bobIndex.data.type === 'index')
    const bobIndexes = await aliceC.castboardWorkspaceIndexes('sat-bob')
    check('castboardWorkspaceIndexes', bobIndexes.ok && bobIndexes.data.some((w) => w.instance === '10.6.6.6:3090'))
    const bobPortal = await bobC.castboardUpsertWorkspacePortal({ workspaceId: 'ws-bob', cwd: 'D:/bob', detail: '# bob 门户' })
    check('castboardUpsertWorkspacePortal', bobPortal.ok)
    const foundPortal = await aliceC.castboardWorkspacePortal({ workspaceId: 'ws-bob', instance: '10.6.6.6:3090', userId: 'sat-bob' })
    check('castboardWorkspacePortal 查到', foundPortal.ok && foundPortal.data !== null)
    const noPortal = await aliceC.castboardWorkspacePortal({ workspaceId: 'ws-none', instance: '10.6.6.6:3090', userId: 'sat-bob' })
    check('castboardWorkspacePortal 查不到 → null', noPortal.ok && noPortal.data === null)
    const noInstance = await aliceC.castboardWorkspacePortal({ workspaceId: 'ws-bob', instance: '' })
    fail('缺 instance → invalid_body', noInstance, 'invalid_body', 400)

    // 本机待办
    const pending = await bobC.castboardMyInstanceIssues({ status: 'pending' })
    check('castboardMyInstanceIssues 命中', pending.ok && pending.data.items.some((i) => i.issueId === compId))
    if (pending.ok) {
      check('unclaimed 归类', pending.data.unclaimed.some((i) => i.issueId === compId))
      eq('instance 回显', pending.data.instance, '10.6.6.6:3090')
    }
    const truncated = await bobC.castboardMyInstanceIssues({ maxPages: 1, pageSize: 1 })
    check('castboardMyInstanceIssues maxPages 生效', truncated.ok && truncated.data.pages <= 1)

    // 认领仲裁（并发）
    const [claimA, claimB] = await Promise.all([aliceC.issueClaim([compId]), bobC.issueClaim([compId])])
    const claimedTotal = (claimA.ok ? claimA.data.claimed.length : 0) + (claimB.ok ? claimB.data.claimed.length : 0)
    eq('并发认领恰好一个成功', claimedTotal, 1)
    const winner = claimA.ok && claimA.data.claimed.length === 1 ? aliceC : bobC
    const winnerInstance = winner === aliceC ? '10.5.5.5:3080' : '10.6.6.6:3090'

    // 状态推进
    const routing = await winner.issueRouting([compId])
    check('issueRouting', routing.ok && routing.data.routed.length === 1)
    const routed = await winner.issueRouted(compId, {
      assigneeTask: 'sat-task-1',
      cwd: 'D:/sat-proj',
      urgency: 'direct',
      permission: 'workspace-write',
      assignerMeta: { title: '组合 issue', detail: '回填' },
    })
    check('issueRouted', routed.ok, routed.ok ? '' : `${routed.code}: ${routed.reason}`)
    if (routed.ok) {
      eq('回填后 title 未丢', routed.data.title, '组合 issue')
      eq('回填后 dependsOn 未丢', routed.data.dependsOn, ['dep-x'])
      eq('回填后 assigneeTask', routed.data.assigneeTask, 'sat-task-1')
    }
    const running = await winner.issueRunning(compId)
    check('issueRunning', running.ok && running.data.status === 'running')
    const routeAfterRunning = await winner.issueRouted(compId, { assigneeTask: 'x', cwd: 'D:/x', assignerMeta: { title: 'a', detail: 'b' } })
    fail('running 后回填 → invalid_request', routeAfterRunning, 'invalid_request', 400)
    const badDatetime = await winner.issueUpdateStatus({ issueId: compId, status: 'routing', assignedAt: '2025-01-01 00:00:00' })
    fail('assignedAt 非 ISO → invalid_datetime', badDatetime, 'invalid_datetime', 400)

    const finalized = await winner.issueFinalize(compId, {
      status: 'success',
      assigneeMeta: { summary: '完成', changedFiles: ['a.ts'] },
      attachments: [{ path: outputFile, role: 'assignee' }],
    })
    check('issueFinalize', finalized.ok, finalized.ok ? '' : `${finalized.code}: ${finalized.reason}`)
    if (finalized.ok) {
      eq('finalize 后状态 success', finalized.data.issue.status, 'success')
      eq('finalize 产物 1 条', finalized.data.attachments.length, 1)
    }
    const noMeta = await winner.issueFinalize(compId, { status: 'success' } as never)
    fail('finalize 缺 assigneeMeta → invalid_meta', noMeta, 'invalid_meta', 400)
    const badFinalizeStatus = await winner.issueFinalize(compId, { status: 'running' as never, assigneeMeta: {} })
    fail('finalize 非法 status → invalid_status', badFinalizeStatus, 'invalid_status', 400)

    // 评论（组合层）
    const cid = `sat-comp-c-${Date.now()}`
    const added = await winner.castboardAddIssueComments(compId, [
      { commentId: cid, content: '执行完成', commentRole: 'assignee', commentAuthorType: 'agent' },
    ])
    check('castboardAddIssueComments', added.ok && added.data.written === 1)
    const addedAgain = await winner.castboardAddIssueComments(compId, [
      { commentId: cid, content: '执行完成', commentRole: 'assignee' },
    ])
    check('同 commentId 重放幂等', addedAgain.ok && addedAgain.data.written === 1)
    const compComments = await aliceC.castboardIssueComments(compId)
    check('castboardIssueComments 仍只有 1 条', compComments.ok && compComments.data.length === 1)
    const badComments = await winner.castboardAddIssueComments(compId, [{ commentId: '', content: 'x' }])
    fail('缺 commentId → invalid_request', badComments, 'invalid_request', 400)
    const sinceComp = await aliceC.castboardCommentsSince({ sinceId: 0, limit: 10 })
    check('castboardCommentsSince', sinceComp.ok && sinceComp.data.items.length >= 1)
    const cursorComp = await aliceC.castboardCommentCursor()
    check('castboardCommentCursor', cursorComp.ok && cursorComp.data > 0)

    // 产物下载（只取 output）
    const outDir = join(workdir, 'products')
    mkdirSync(outDir, { recursive: true })
    const downloaded = await aliceC.castboardDownloadIssueAttachments(compId, outDir, { role: 'assignee' })
    check('castboardDownloadIssueAttachments', downloaded.ok && downloaded.data.downloaded.length === 1)
    if (downloaded.ok) eq('下载失败列表为空', downloaded.data.failed.length, 0)
    // 部分失败：删掉文件后再下载
    // 部分失败：服务端允许挂一个"磁盘上不存在"的 fileId（死链），下载时进 failed[]
    const deadFileId = '22222222-2222-4222-8222-222222222222'
    const deadAttach = await aliceC.issue.attachment.add([
      { targetType: 'issue', targetId: compId, fileId: deadFileId, role: 'assignee', fileName: '死链.bin' },
    ])
    check('允许挂死链（协议取舍）', deadAttach.ok)
    const partial = await aliceC.castboardDownloadIssueAttachments(compId, outDir, { role: 'assignee' })
    check(
      '部分失败仍 ok，失败进 failed[]',
      partial.ok && partial.data.failed.length === 1 && partial.data.downloaded.length >= 1,
      partial.ok
        ? `downloaded=${partial.data.downloaded.length} failed=${partial.data.failed.length}`
        : `${partial.code}: ${partial.reason}`,
    )

    // E1 依赖门禁
    const statuses = await aliceC.castboardIssueStatuses({ issueIds: [compId, 'sat-missing', compId] })
    check('castboardIssueStatuses 去重 + null', statuses.ok && statuses.data[compId] === 'success' && statuses.data['sat-missing'] === null)
    const badE1 = await aliceC.castboardIssueStatuses({ issueIds: ['x'.repeat(101)] })
    fail('E1 非法 id → invalid_issue_id', badE1, 'invalid_issue_id', 400)

    // 单条状态更新（组合层）
    const one = await aliceC.issueUpdateStatus({ issueId: compId, status: 'failed' })
    check('issueUpdateStatus（success → failed 服务端不拦）', one.ok && one.data.status === 'failed')

    // 放弃
    const abandonComp = await aliceC.issueAbandon([compId])
    check('issueAbandon', abandonComp.ok && abandonComp.data.abandoned.length === 1)

    // ════════════════════════════════════════════════════════════════════
    begin('运维与管理')
    // ════════════════════════════════════════════════════════════════════
    const version = await aliceC.ops.version()
    check('ops.version', version.ok && version.data.protocol === 'dsh-teamwork/1')
    const health = await aliceC.ops.health()
    check('ops.health', health.ok && health.data.ok === true)
    const probe = await aliceC.probe()
    check('probe 装入能力清单', probe.ok && probe.data.endpoints.length >= 47)
    const accounts = await aliceC.admin.accounts({ pageNum: 1, pageSize: 10 })
    check('admin.accounts', accounts.ok && accounts.data.items.length >= 2)
    const setRole = await aliceC.admin.setRole('sat-bob', 'leader')
    check('admin.setRole', setRole.ok && setRole.data.globalRole === 'leader')
    const demoteLast = await aliceC.admin.setRole('sat-alice', 'user')
    fail('降级最后一个管理员 → last_administrator', demoteLast, 'last_administrator', 409)
    const resetPwd = await aliceC.admin.resetPassword('sat-bob', PASSWORD2)
    check('admin.resetPassword', resetPwd.ok)
    const afterReset = await track(client(baseUrl)).auth.login({ accountId: 'sat-bob', password: PASSWORD2 })
    check('重置后用新密码登录', afterReset.ok)

    // 能力闸：清单里只留一个端点
    const gated = track(client(baseUrl))
    await gated.auth.login({ accountId: 'sat-alice', password: PASSWORD })
    gated.setCapabilities(['GET /projects/mine'])
    const gatedResult = await gated.issue.get(compId)
    fail('能力闸未声明 → unsupported', gatedResult, 'unsupported')
    const gatedOk = await gated.castboardMyProjects()
    check('能力闸放行已声明端点', gatedOk.ok)

    // 逃生口
    const rawVersion = await aliceC.request<{ protocol: string }>('/version', { auth: 'public' })
    check('client.request 逃生口', rawVersion.ok && rawVersion.data.protocol === 'dsh-teamwork/1')
    const rawHealth = await aliceC.raw('/health', { auth: 'public' })
    check('client.raw 逃生口', rawHealth.ok)
    const unmatched = await aliceC.request('/no-such-route', { method: 'GET' })
    check('未知路径 → http 错误（不抛）', unmatched.ok === false)

    // 空项目可删（新项目，无 issue）
    const emptyProject = await aliceC.teamwork.project.create({ name: '可删项目', visibility: 'private' })
    if (emptyProject.ok) {
      const removed = await aliceC.teamwork.project.remove(emptyProject.data.id)
      check('空项目可删', removed.ok)
    }

    // 停机（最后）：X-Shutdown-Token 需要回环 + 锁文件 token；这里用 administrator 双头
    if (harness.server !== undefined) {
      const shutdown = await aliceC.admin.shutdown()
      check('admin.shutdown 走 administrator 头', shutdown.ok)
      // 停机后 health 应 503 / 失败
      const afterShutdown = await aliceC.ops.health()
      check('停机后 health 失败或 503', afterShutdown.ok === false || afterShutdown.status === 503)
    }
  } finally {
    for (const c of clients) {
      try {
        await c.dispose()
      } catch {
        /* best-effort */
      }
    }
    for (const dir of files) rmSync(dir, { recursive: true, force: true })
    if (home !== '') rmSync(home, { recursive: true, force: true })
    try {
      await harness.close()
    } catch {
      /* 已停机 */
    }
  }

  const coveredEndpoints = [...covered].sort()
  // 外部模式不碰别人的进程：`shutdown` 不计入必须覆盖（也真的没调）
  const skippedInExternal = external ? ['shutdown'] : []
  const uncoveredEndpoints = Object.keys(CASTBOARD_ENDPOINTS)
    .filter((name) => !covered.has(name) && !skippedInExternal.includes(name))
    .sort()
  const failed = results.filter((r) => !r.ok)

  return {
    checks: results,
    coveredEndpoints,
    uncoveredEndpoints,
    skippedInExternal,
    failed,
    ok: failed.length === 0 && uncoveredEndpoints.length === 0,
  }
}

/** 报告打印（CLI 用；测试也能直接调） */
export function formatReport(report: SaturationReport, verbose = false): string {
  const lines: string[] = []
  const sections = [...new Set(report.checks.map((r) => r.section))]
  for (const name of sections) {
    const rows = report.checks.filter((r) => r.section === name)
    const bad = rows.filter((r) => !r.ok)
    lines.push(`■ ${name}：${rows.length - bad.length}/${rows.length} 通过`)
    if (verbose || bad.length > 0) {
      for (const row of rows) lines.push(`   ${row.ok ? '✔' : '✖'} ${row.name}${row.detail === undefined ? '' : ` — ${row.detail}`}`)
    }
  }
  const total = report.checks.length
  const pass = total - report.failed.length
  lines.push('')
  lines.push(`■ 端点覆盖：${report.coveredEndpoints.length}/${Object.keys(CASTBOARD_ENDPOINTS).length}`)
  if (report.skippedInExternal.length > 0) {
    lines.push(`   外部模式跳过：${report.skippedInExternal.join(', ')}（不碰别人的进程）`)
  }
  if (report.uncoveredEndpoints.length > 0) lines.push(`   未覆盖：${report.uncoveredEndpoints.join(', ')}`)
  lines.push(`■ 组合方法：${CASTBOARD_COMPOSITES.length} 个 + E1 ${CASTBOARD_EXTENSION_COMPOSITES.length} 个（清单见 sdk.ts）`)
  lines.push(`■ 断言：${pass}/${total} 通过；失败 ${report.failed.length}`)
  lines.push('')
  lines.push(report.ok ? '✅ 饱和测试全部通过' : '❌ 饱和测试未通过')
  return lines.join('\n')
}

/** 判断一条 issue 是否终态（内部用，避免未使用告警） */
export function isTerminal(issue: CastboardIssue): boolean {
  return issue.status === 'success' || issue.status === 'failed' || issue.status === 'abandoned'
}
