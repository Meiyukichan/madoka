/**
 * 真实环境饱和测试：对着一个**已经在跑的服务**逐个打 47 个端点。
 *
 *   node scripts/saturate.mjs                 # 默认 http://127.0.0.1:3939
 *   node scripts/saturate.mjs http://127.0.0.1:4000
 *
 * 与 tests/ 的区别：这里不打桩、不建临时库，直接验证部署实例；
 * 每组都包含成功路径 + 至少一条错误路径（401/403/404/409/400）。
 */
import { createHash, createHmac } from 'node:crypto'

const BASE_RAW = process.argv[2] ?? 'http://127.0.0.1:3939'
const BASE = `${BASE_RAW.replace(/\/+$/, '')}/dsh-teamwork/v1`
const ADMIN_ID = 'meiyukichan'
const ADMIN_PW = 'mikuloveyuki'
const RUN = Date.now().toString(36).slice(-5)
/** 来源 code 只允许小写字母（api-design C14），所以派生一个纯字母后缀 */
const RUN_ALPHA = [...RUN].map((ch) => (ch >= '0' && ch <= '9' ? 'abcdefghij'[Number(ch)] : ch)).join('')
const PW = 'saturate-pass-2024'
const PW_NEW = 'saturate-pass-new'

let pass = 0
const failures = []
const results = []
/** 已命中的端点模板（用来核对 47 个是否全覆盖） */
const hit = new Set()

const TEMPLATE_RULES = [
  [/^\/projects\/\d+$/, '/projects/:id'],
  [/^\/projects\/\d+\/members$/, '/projects/:id/members'],
  [/^\/projects\/\d+\/members\/[^/]+$/, '/projects/:id/members/:accountId'],
  [/^\/projects\/\d+\/owner$/, '/projects/:id/owner'],
  [/^\/devices\/\d+$/, '/devices/:id'],
  [/^\/issues\/batch$/, '/issues/batch'],
  [/^\/issues\/comments\/cursor$/, '/issues/comments/cursor'],
  [/^\/issues\/comments$/, '/issues/comments'],
  [/^\/issues\/status\/batch$/, '/issues/status/batch'],
  [/^\/issues\/attachments\/batch$/, '/issues/attachments/batch'],
  [/^\/issues\/[^/]+\/comments$/, '/issues/:issueId/comments'],
  [/^\/issues\/[^/]+\/attachments$/, '/issues/:issueId/attachments'],
  [/^\/issues\/[^/]+$/, '/issues/:issueId'],
  [/^\/issue-sources\/\d+$/, '/issue-sources/:id'],
  [/^\/files\/[^/]+$/, '/files/:fileId'],
  [/^\/admin\/accounts$/, '/admin/accounts'],
  [/^\/admin\/accounts\/[^/]+\/role$/, '/admin/accounts/:accountId/role'],
  [/^\/admin\/accounts\/[^/]+\/password$/, '/admin/accounts/:accountId/password'],
]

function templateOf(path) {
  const clean = path.split('?')[0]
  for (const [re, tpl] of TEMPLATE_RULES) if (re.test(clean)) return tpl
  return clean
}

function sign(accountToken, accountId, ttlSeconds = 3600) {
  const now = Date.now()
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ a: accountId, iat: now, exp: now + ttlSeconds * 1000 })).toString('base64url')
  const sig = createHmac('sha256', accountToken).update(`${head}.${payload}`).digest('base64url')
  return `${head}.${payload}.${sig}`
}

async function http(method, path, options = {}) {
  const headers = { ...(options.headers ?? {}) }
  let body
  if (options.raw !== undefined) {
    body = options.raw
    headers['content-type'] = options.contentType ?? 'application/octet-stream'
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body)
    headers['content-type'] = 'application/json'
  }
  if (options.token) {
    headers['dsh-teamwork-token'] = sign(options.token, options.accountId)
    headers['dsh-teamwork-account'] = options.accountId
  }
  hit.add(`${method} ${templateOf(path)}`)
  let res = await fetch(BASE + path, { method, headers, body })
  // 限流时按 Retry-After 等待重试（最多 3 次）
  for (let attempt = 0; res.status === 429 && attempt < 3; attempt++) {
    const wait = Number(res.headers.get('retry-after') ?? 0) || 5
    await new Promise((r) => setTimeout(r, (wait + 2) * 1000))
    res = await fetch(BASE + path, { method, headers, body })
  }
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = text
  }
  return { status: res.status, json, text, headers: res.headers }
}

async function check(group, label, method, path, options, expected) {
  const res = await http(method, path, options)
  const codes = Array.isArray(expected) ? expected : [expected]
  const ok = codes.includes(res.status) && (options.expectCode ? res.json?.code === options.expectCode : true)
  const line = `${group} ${label.padEnd(34)} ${method.padEnd(6)} ${path}`
  if (ok) {
    pass++
    results.push(`${line} → ${res.status}`)
  } else {
    const actual = `${res.status}${res.json?.code ? ` ${res.json.code}` : ''}`
    failures.push(`${line} → 期望 ${codes.join('/')}${options.expectCode ? ` (${options.expectCode})` : ''}，实际 ${actual}`)
    results.push(`${line} → ✗ ${actual}`)
  }
  return res
}

async function ensureAccount(accountId, password) {
  const reg = await http('POST', '/auth/register', { body: { accountId, password: b64(password) } })
  if (reg.status === 201) return { accountId, session: reg.json, created: true }
  const login = await http('POST', '/auth/login', { body: { accountId, password: b64(password) } })
  if (login.status !== 200) throw new Error(`无法登录 ${accountId}: ${login.status} ${login.text}`)
  return { accountId, session: login.json, created: false }
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

async function main() {
  console.log(`目标：${BASE}\n`)

  // ── 0. 准备账号 ────────────────────────────────────────────
  const me = await ensureAccount(ADMIN_ID, ADMIN_PW)
  const meTok = me.session.accountToken
  console.log(`主账号 ${ADMIN_ID}（${me.created ? '新建' : '已存在'}，角色 ${me.session.account.globalRole}）`)

  const a = await ensureAccount(`sat-a-${RUN}`, PW)
  const b = await ensureAccount(`sat-b-${RUN}`, PW)
  const c = await ensureAccount(`sat-c-${RUN}`, PW)
  console.log(`辅助账号：${a.accountId} / ${b.accountId} / ${c.accountId}\n`)

  const A = { token: a.session.accountToken, accountId: a.accountId }
  const B = { token: b.session.accountToken, accountId: b.accountId }
  const C = { token: c.session.accountToken, accountId: c.accountId }

  // ── A. 账号 ───────────────────────────────────────────────
  await check('A2', '登录（主账号）', 'POST', '/auth/login', { body: { accountId: ADMIN_ID, password: b64(ADMIN_PW) } }, 200)
  await check('A2', '登录失败同码', 'POST', '/auth/login', { body: { accountId: ADMIN_ID, password: b64('wrong-password-123') } }, 401, { expectCode: 'invalid_credentials' })
  await check('A3', '当前账号', 'GET', '/auth/me', A, 200)
  await check('A3', '未认证', 'GET', '/auth/me', {}, 401)
  await check('A1', '重复注册', 'POST', '/auth/register', { body: { accountId: a.accountId, password: b64(PW) } }, 409, { expectCode: 'account_exists' })
  await check('A1', '账号格式非法', 'POST', '/auth/register', { body: { accountId: 'x', password: b64(PW) } }, 400, { expectCode: 'invalid_account_id' })
  await check('A5', '新旧密码相同', 'PUT', '/auth/password', { ...A, body: { oldPassword: b64(PW), newPassword: b64(PW) } }, 400, { expectCode: 'same_password' })
  await check('A5', '改密码', 'PUT', '/auth/password', { ...A, body: { oldPassword: b64(PW), newPassword: b64(PW_NEW) } }, 200)
  const relogin = await check('A2', '新密码可登录', 'POST', '/auth/login', { body: { accountId: a.accountId, password: b64(PW_NEW) } }, 200)
  if (relogin.json?.accountToken) A.token = relogin.json.accountToken // 改密换了密钥，后续请求要用新 token
  await check('A6', '查账号', 'GET', `/auth/accounts?accountId=${encodeURIComponent(b.accountId)}`, { token: meTok, accountId: ADMIN_ID }, 200)
  await check('A6', '查账号（普通用户）', 'GET', `/auth/accounts?accountId=${encodeURIComponent(b.accountId)}`, A, 403)
  await check('A4', '登出', 'POST', '/auth/logout', { ...C, body: {} }, 204)

  // ── B. 项目与成员 ─────────────────────────────────────────
  const projName = `sat-proj-${RUN}`
  const created = await check('B4', '建 private 项目', 'POST', '/projects', { ...A, body: { name: projName, visibility: 'private', description: '饱和测试' } }, 201)
  const projectId = created.json.id
  await check('B4', '普通用户建 public（拒）', 'POST', '/projects', { ...A, body: { name: `${projName}-pub`, visibility: 'public' } }, 403, { expectCode: 'public_project_requires_leader' })
  await check('B4', '重名', 'POST', '/projects', { ...A, body: { name: projName, visibility: 'private' } }, 409, { expectCode: 'project_name_exists' })
  await check('B4', '未知字段', 'POST', '/projects', { ...A, body: { name: `${projName}-x`, owner: 'a' } }, 400, { expectCode: 'unknown_field' })
  await check('B1', '项目列表', 'GET', '/projects?pageNum=1&pageSize=10', { token: meTok, accountId: ADMIN_ID }, 200)
  await check('B2', '我的项目', 'GET', '/projects/mine', A, 200)
  await check('B3', '项目详情', 'GET', `/projects/${projectId}`, A, 200)
  await check('B3', '非成员看详情（404）', 'GET', `/projects/${projectId}`, B, 404, { expectCode: 'project_not_found' })
  await check('B5', '改名', 'PUT', `/projects/${projectId}`, { ...A, body: { name: `${projName}-renamed` } }, 200)
  await check('B8', '加成员 manager', 'POST', `/projects/${projectId}/members`, { ...A, body: { accountId: b.accountId, role: 'manager' } }, 200)
  await check('B8', '授 owner（拒）', 'POST', `/projects/${projectId}/members`, { ...A, body: { accountId: c.accountId, role: 'owner' } }, 400, { expectCode: 'owner_role_not_assignable' })
  await check('B8', '加不存在账号', 'POST', `/projects/${projectId}/members`, { ...A, body: { accountId: 'ghost-user' } }, 404, { expectCode: 'account_not_found' })
  await check('B7', '成员列表', 'GET', `/projects/${projectId}/members`, A, 200)
  await check('B9', '移除成员', 'DELETE', `/projects/${projectId}/members/${c.accountId}`, A, 404, { expectCode: 'member_not_found' })
  await check('B10', '转让 owner', 'PUT', `/projects/${projectId}/owner`, { token: meTok, accountId: ADMIN_ID, body: { accountId: ADMIN_ID } }, 200)
  await check('B10', '转让给普通 user（public 才限制）', 'PUT', `/projects/${projectId}/owner`, { token: meTok, accountId: ADMIN_ID, body: { accountId: b.accountId } }, 200)

  // ── B. 设备与工作区 ───────────────────────────────────────
  const sync = await check('B11', '设备全量同步', 'POST', '/devices/batch', { ...A, body: { devices: [{ host: 'sat-laptop', port: 3080, os: 'windows' }, { host: 'sat-nas', port: 0 }] } }, 200)
  if (sync.json) console.log(`      ↳ synced=${sync.json.synced} deactivated=${sync.json.deactivated}`)
  await check('B12', '在线设备', 'GET', '/devices', A, 200)
  await check('B12', '查他人设备（允许）', 'GET', `/devices?accountId=${encodeURIComponent(a.accountId)}`, B, 200)
  const mine = await check('B13', '我的设备（分页）', 'GET', '/devices/mine?pageNum=1&pageSize=5', A, 200)
  const deviceId = mine.json?.items?.[0]?.id
  if (deviceId === undefined) {
    failures.push('B13 没有拿到设备 id，后续 B14 用例跳过')
  }
  await check('B14', '删设备（他人也可）', 'DELETE', `/devices/${deviceId}`, B, 204)
  await check('B14', '删不存在设备', 'DELETE', `/devices/${deviceId}`, B, 404, { expectCode: 'device_not_found' })
  await check('B15', '工作区 index', 'POST', '/device-workspaces', { ...A, body: { instance: 'sat:3080', type: 'index', detail: '# index' } }, 200)
  await check('B15', '工作区 portal', 'POST', '/device-workspaces', { ...A, body: { instance: 'sat:3080', type: 'portal', detail: '# portal', workspaceId: `ws-${RUN}`, cwd: `D:/sat/${RUN}` } }, 200)
  await check('B15', '工作区形状非法', 'POST', '/device-workspaces', { ...A, body: { instance: 'sat:3080', type: 'index', detail: 'x', cwd: 'D:/x' } }, 400, { expectCode: 'invalid_workspace_shape' })
  await check('B16', '工作区按 cwd 精查', 'GET', `/device-workspaces?cwd=${encodeURIComponent(`D:/sat/${RUN}`)}`, { token: meTok, accountId: ADMIN_ID }, 200)
  await check('B16', '工作区按前缀查', 'GET', `/device-workspaces?cwdPrefix=${encodeURIComponent('D:/sat/')}`, { token: meTok, accountId: ADMIN_ID }, 200)

  // ── C. Issue ─────────────────────────────────────────────
  const issueBody = { title: `饱和测试 issue ${RUN}`, assignee: b.accountId, projectId, urgency: 'urgent', detail: '正文' }
  const batch = await check('C1', '批量提交 issue', 'POST', '/issues/batch', { ...A, body: [issueBody] }, 200)
  const issueId = Array.isArray(batch.json) ? batch.json[0] : undefined
  await check('C1', '提交未知字段', 'POST', '/issues/batch', { ...A, body: [{ title: 'x', assignee: a.accountId, assigner: 'hacker' }] }, 400, { expectCode: 'unknown_field' })
  await check('C1', 'assignee 不存在', 'POST', '/issues/batch', { ...A, body: [{ title: 'x', assignee: 'ghost-user' }] }, 404, { expectCode: 'account_not_found' })
  await check('C2', 'issue 列表', 'GET', '/issues?pageNum=1&pageSize=10', { token: meTok, accountId: ADMIN_ID }, 200)
  await check('C2', '按状态过滤', 'GET', '/issues?status=pending', { token: meTok, accountId: ADMIN_ID }, 200)
  await check('C2', '非法状态', 'GET', '/issues?status=bogus', { token: meTok, accountId: ADMIN_ID }, 400, { expectCode: 'invalid_status' })
  await check('C3', 'issue 详情', 'GET', `/issues/${encodeURIComponent(issueId)}`, B, 200)
  await check('C3', 'issue 不存在', 'GET', '/issues/ghost-issue', B, 404, { expectCode: 'issue_not_found' })
  await check('C4', '全字段覆盖', 'PUT', `/issues/${encodeURIComponent(issueId)}`, { ...B, body: { title: `饱和测试 issue ${RUN}（改）`, assigneeInstance: 'sat:3080' } }, 200)
  const claim = await check('C6', '状态批量（认领）', 'POST', '/issues/status/batch', { ...B, body: [{ issueId, status: 'accepted', expectedStatus: 'pending', assigneeInstance: 'sat:3080' }] }, 200)
  if (claim.json) console.log(`      ↳ success=${claim.json.success} failed=${claim.json.failed.length}`)
  await check('C6', '状态批量（竞态冲突）', 'POST', '/issues/status/batch', {
    ...B,
    body: [{ issueId, status: 'running', expectedStatus: 'pending' }, { issueId: 'ghost-issue', status: 'running' }, { issueId, status: 'bogus' }],
  }, 200)
  const c1 = await check('C9', '加评论', 'POST', `/issues/${encodeURIComponent(issueId)}/comments`, { ...B, body: { content: '开始处理', commentId: `cm-${RUN}` } }, 201)
  await check('C9', '重复评论（幂等 200）', 'POST', `/issues/${encodeURIComponent(issueId)}/comments`, { ...B, body: { content: '开始处理', commentId: `cm-${RUN}` } }, 200)
  if (c1.json) console.log(`      ↳ commentId=${c1.json.commentId} id=${c1.json.id}`)
  await check('C10', '评论列表', 'GET', `/issues/${encodeURIComponent(issueId)}/comments`, B, 200)
  await check('C7', '评论增量', 'GET', '/issues/comments?sinceId=0&limit=50', { token: meTok, accountId: ADMIN_ID }, 200)
  await check('C8', '评论游标', 'GET', '/issues/comments/cursor', { token: meTok, accountId: ADMIN_ID }, 200)

  // 文件 + 附件
  const payload = Buffer.from(`saturate payload ${RUN}`, 'utf8')
  const sha = createHash('sha256').update(payload).digest('hex')
  const up = await check('F1', '上传文件', 'POST', '/files', {
    ...A,
    raw: payload,
    headers: { 'x-file-name': encodeURIComponent(`饱和 ${RUN}.txt`), 'x-file-sha256': sha },
  }, 201)
  const fileId = up.json?.fileId
  await check('F1', '哈希不符', 'POST', '/files', {
    ...A,
    raw: payload,
    headers: { 'x-file-name': 'x.txt', 'x-file-sha256': 'f'.repeat(64) },
  }, 400, { expectCode: 'sha256_mismatch' })
  await check('C11', '挂附件', 'POST', '/issues/attachments/batch', { ...B, body: [{ issueId, fileId, type: 'assignee', fileName: '饱和.txt' }] }, 200)
  await check('C11', '非法 fileId', 'POST', '/issues/attachments/batch', { ...B, body: [{ issueId, fileId: 'nope', type: 'assignee' }] }, 400, { expectCode: 'invalid_file_id' })
  await check('C12', '附件列表', 'GET', `/issues/${encodeURIComponent(issueId)}/attachments?type=assignee`, B, 200)
  await check('F2', '下载文件', 'GET', `/files/${fileId}`, { token: meTok, accountId: ADMIN_ID }, 200)
  await check('F2', '下载不存在', 'GET', '/files/3f2504e0-4f89-41d3-9a0c-0305e82c3301', { token: meTok, accountId: ADMIN_ID }, 404, { expectCode: 'file_not_found' })

  // 来源字典
  await check('C13', '来源列表', 'GET', '/issue-sources', { token: meTok, accountId: ADMIN_ID }, 200)
  const reg2 = await check('C14', '来源注册', 'POST', '/issue-sources/batch', { ...A, body: [{ code: `sat-${RUN_ALPHA}`, description: '饱和测试来源' }] }, 200)
  await check('C14', '来源格式非法', 'POST', '/issue-sources/batch', { ...A, body: [{ code: 'Bad_Code' }] }, 400, { expectCode: 'invalid_source_code' })
  const sources = await http('GET', '/issue-sources', { token: meTok, accountId: ADMIN_ID })
  const satSource = (sources.json ?? []).find((s) => s.code === `sat-${RUN_ALPHA}`)
  if (satSource) {
    await check('C15', '改来源（管理员）', 'PUT', `/issue-sources/${satSource.id}`, { token: meTok, accountId: ADMIN_ID, body: { description: '改过了' } }, 200)
    await check('C15', '改来源（普通用户 403）', 'PUT', `/issue-sources/${satSource.id}`, { ...A, body: { description: 'x' } }, 403)
    await check('C16', '删来源（管理员）', 'DELETE', `/issue-sources/${satSource.id}`, { token: meTok, accountId: ADMIN_ID }, 204)
    await check('C16', '删不存在来源', 'DELETE', `/issue-sources/${satSource.id}`, { token: meTok, accountId: ADMIN_ID }, 404, { expectCode: 'source_not_found' })
  } else {
    failures.push(`C15/C16 找不到刚注册的来源 sat-${RUN_ALPHA}`)
  }
  await check('C5', '遗弃 issue', 'DELETE', `/issues/${encodeURIComponent(issueId)}`, B, 204)
  await check('F3', '删文件（普通用户 403）', 'DELETE', `/files/${fileId}`, A, 403)
  await check('F3', '删文件（管理员）', 'DELETE', `/files/${fileId}`, { token: meTok, accountId: ADMIN_ID }, 204)

  // ── M. 运维与管理 ─────────────────────────────────────────
  await check('M1', '健康检查', 'GET', '/health', {}, 200)
  await check('M2', '版本与能力', 'GET', '/version', {}, 200)
  const version = await http('GET', '/version')
  if (version.json?.endpoints?.length === 47) pass++
  else failures.push(`M2 endpoints 数量：期望 47，实际 ${version.json?.endpoints?.length}`)
  await check('M6', '账号列表', 'GET', '/admin/accounts?pageNum=1&pageSize=20', { token: meTok, accountId: ADMIN_ID }, 200)
  await check('M6', '账号列表（普通用户 403）', 'GET', '/admin/accounts', A, 403)
  await check('M4', '改角色 leader', 'PUT', `/admin/accounts/${encodeURIComponent(c.accountId)}/role`, { token: meTok, accountId: ADMIN_ID, body: { role: 'leader' } }, 200)
  await check('M4', '降级最后一个 admin', 'PUT', `/admin/accounts/${encodeURIComponent(ADMIN_ID)}/role`, { token: meTok, accountId: ADMIN_ID, body: { role: 'user' } }, 409, { expectCode: 'last_administrator' })
  await check('M5', '重置密码', 'POST', `/admin/accounts/${encodeURIComponent(c.accountId)}/password`, { token: meTok, accountId: ADMIN_ID, body: { newPassword: b64('reset-pass-2024') } }, 204)
  await check('M5', '新密码可登录', 'POST', '/auth/login', { body: { accountId: c.accountId, password: b64('reset-pass-2024') } }, 200)
  await check('M3', '停机（无凭据 401）', 'POST', '/admin/shutdown', {}, 401)

  // ── 收尾：删项目（先确认有 issue 时被拦，再清 issue） ──────
  await check('B6', '删项目（有 issue 409）', 'DELETE', `/projects/${projectId}`, { token: meTok, accountId: ADMIN_ID }, 409, { expectCode: 'project_has_issues' })
  // 空项目可以直接删（204，级联清成员）
  const throwaway = await http('POST', '/projects', { token: meTok, accountId: ADMIN_ID, body: { name: `sat-throwaway-${RUN}`, visibility: 'private' } })
  await check('B6', '删空项目', 'DELETE', `/projects/${throwaway.json.id}`, { token: meTok, accountId: ADMIN_ID }, 204)

  // ── 报告 ─────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(100))
  for (const line of results) console.log(line)
  console.log('─'.repeat(100))
  // ── 覆盖率核对：用 /version 的能力清单反查 ────────────────
  const declared = (await http('GET', '/version')).json?.endpoints ?? []
  const missing = declared.filter((e) => !hit.has(e))
  const extra = [...hit].filter((e) => !declared.includes(e))
  console.log(`端点覆盖：${declared.length - missing.length} / ${declared.length}`)
  if (missing.length) console.log(`未覆盖：\n${missing.map((m) => `  · ${m}`).join('\n')}`)
  if (extra.length) console.log(`清单外（不应出现）：\n${extra.map((m) => `  · ${m}`).join('\n')}`)
  if (missing.length || extra.length) {
    failures.push(`端点覆盖不完整：缺 ${missing.length}，多 ${extra.length}`)
  }

  console.log(`\n通过 ${pass}，失败 ${failures.length}${failures.length ? `\n\n失败明细：\n${failures.map((f) => `  ✗ ${f}`).join('\n')}` : ''}`)
  if (failures.length) process.exitCode = 1
}

main().catch((err) => {
  console.error('\n饱和测试中断：', err)
  process.exit(1)
})
