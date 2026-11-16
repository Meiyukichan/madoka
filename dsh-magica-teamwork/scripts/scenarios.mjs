/**
 * 场景矩阵：对**正在运行的真实服务**逐端点穷举场景（成功 + 所有已知错误分支 + 边界）。
 *
 *   node scripts/scenarios.mjs                      # 打 http://127.0.0.1:3939
 *   node scripts/scenarios.mjs http://127.0.0.1:4000
 *
 * 与 saturate.mjs 的分工：
 *   saturate.mjs  = 冒烟 + 覆盖率自检（每个端点至少一次成功）
 *   scenarios.mjs = 深水区（枚举值、长度边界、状态机、幂等、批量上限、限流）
 *
 * 结尾按端点汇总场景数，并列出**无法通过 HTTP 验证**的项。
 */
import { createHash, createHmac } from 'node:crypto'

const RAW_BASE = process.argv[2] ?? 'http://127.0.0.1:3939'
const BASE = `${RAW_BASE.replace(/\/+$/, '')}/dsh-teamwork/v1`
const ADMIN_ID = 'meiyukichan'
const ADMIN_PW = 'mikuloveyuki'
const RUN = Date.now().toString(36).slice(-6)
const PW = 'scenario-pass-1234'
/** 来源 code 只允许小写字母（api-design C14），派生纯字母后缀 */
const RUN_ALPHA = [...RUN].map((c) => (c >= '0' && c <= '9' ? 'abcdefghij'[Number(c)] : c)).join('')

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const J = (o) => JSON.stringify(o)

let pass = 0
const failures = []
const perEndpoint = new Map()

function sign(token, accountId, ttl = 3600) {
  const now = Date.now()
  const h = Buffer.from(J({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const p = Buffer.from(J({ a: accountId, iat: now, exp: now + ttl * 1000 })).toString('base64url')
  return `${h}.${p}.${createHmac('sha256', token).update(`${h}.${p}`).digest('base64url')}`
}

/** endpooint 标签：METHOD /path/{x} → 模板 */
function label(method, path) {
  return `${method} ${path.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/{id}')}`
}

async function call(method, path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) }
  let body
  if (opts.raw !== undefined) {
    body = opts.raw
    headers['content-type'] = opts.contentType ?? 'application/octet-stream'
  } else if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : J(opts.body)
    headers['content-type'] = 'application/json'
  }
  if (opts.token) {
    headers['dsh-teamwork-token'] = opts.rawToken ? opts.token : sign(opts.token, opts.accountId)
    headers['dsh-teamwork-account'] = opts.accountId
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, { method, headers, body })
    if (res.status === 429 && attempt < 2 && !opts.noRetry) {
      const wait = Number(res.headers.get('retry-after') ?? 5) || 5
      await new Promise((r) => setTimeout(r, (wait + 2) * 1000))
      continue
    }
    const text = await res.text()
    let json
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = text
    }
    return { status: res.status, json, headers: res.headers }
  }
}

/** 一条场景断言 */
async function expect(ep, name, method, path, opts, want) {
  const res = await call(method, path, opts)
  const wantStatus = Array.isArray(want.status) ? want.status : [want.status]
  const okStatus = wantStatus.includes(res.status)
  const okCode = want.code ? res.json?.code === want.code : true
  const ok =
    okStatus &&
    okCode &&
    (want.assert ? safe(() => want.assert(res)) : true) &&
    (want.check ? safe(() => want.check(res)) : true)

  const key = ep ?? label(method, path)
  const stat = perEndpoint.get(key) ?? { total: 0, bad: 0 }
  stat.total++
  if (ok) {
    pass++
  } else {
    stat.bad++
    failures.push(
      `${key} · ${name} → 期望 ${wantStatus.join('/')}${want.code ? ` (${want.code})` : ''}，实际 ${res.status}${res.json?.code ? ` ${res.json.code}` : ''}`,
    )
  }
  perEndpoint.set(key, stat)
  return res
}

function safe(fn) {
  try {
    return fn() !== false
  } catch {
    return false
  }
}

/**
 * 登录优先（少打一次注册请求，避免触发限流）。
 * 返回 { accountId, accountToken, globalRole, password }。
 */
async function ensure(accountId, ...passwords) {
  for (const pw of passwords) {
    const l = await call('POST', '/auth/login', { body: { accountId, password: b64(pw) } })
    if (l.status === 200) return { accountId, accountToken: l.json.accountToken, globalRole: l.json.account.globalRole, password: pw }
  }
  const reg = await call('POST', '/auth/register', { body: { accountId, password: b64(passwords[0]) } })
  if (reg.status !== 201) throw new Error(`无法创建/登录 ${accountId}: ${reg.status} ${J(reg.json)}`)
  return { accountId, accountToken: reg.json.accountToken, globalRole: reg.json.account.globalRole, password: passwords[0] }
}

async function main() {
  console.log(`场景矩阵目标：${BASE}\n`)

  const admin = await ensure(ADMIN_ID, ADMIN_PW)
  const owner = await ensure('sc-owner', PW)
  const helper = await ensure('sc-helper', PW)
  const other = await ensure('sc-other', PW, 'scenario-pass-new')
  const adminTok = { token: admin.accountToken, accountId: ADMIN_ID }
  const ownerTok = { token: owner.accountToken, accountId: owner.accountId }
  const helperTok = { token: helper.accountToken, accountId: helper.accountId }
  const otherTok = { token: other.accountToken, accountId: other.accountId }

  // ══════════ A. 账号 ══════════
  await expect('A1 POST /auth/register', '密码过短', 'POST', '/auth/register', { body: { accountId: `sc-short-${RUN}`, password: b64('12345678901') } }, { status: 400, code: 'invalid_password' })
  await expect('A1 POST /auth/register', '密码过长(129)', 'POST', '/auth/register', { body: { accountId: `sc-long-${RUN}`, password: b64('a'.repeat(129)) } }, { status: 400, code: 'invalid_password' })
  await expect('A1 POST /auth/register', '首尾空白', 'POST', '/auth/register', { body: { accountId: `sc-space-${RUN}`, password: b64(' padded password ') } }, { status: 400, code: 'invalid_password' })
  await expect('A1 POST /auth/register', '弱口令', 'POST', '/auth/register', { body: { accountId: `sc-weak-${RUN}`, password: b64('password1234') } }, { status: 400, code: 'weak_password' })
  await expect('A1 POST /auth/register', 'base64 解码失败', 'POST', '/auth/register', { body: { accountId: `sc-b64-${RUN}`, password: '!!!not base64!!!' } }, { status: 400, code: 'invalid_password_encoding' })
  await expect('A1 POST /auth/register', '非 UTF-8 字节', 'POST', '/auth/register', { body: { accountId: `sc-u8-${RUN}`, password: Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8, 0xf7, 0xf6, 0xf5, 0xf4]).toString('base64') } }, { status: 400, code: 'invalid_password_encoding' })
  await expect('A1 POST /auth/register', '账号 2 字符', 'POST', '/auth/register', { body: { accountId: 'ab', password: b64(PW) } }, { status: 400, code: 'invalid_account_id' })
  await expect('A1 POST /auth/register', '账号 65 字符', 'POST', '/auth/register', { body: { accountId: 'a'.repeat(65), password: b64(PW) } }, { status: 400, code: 'invalid_account_id' })
  await expect('A1 POST /auth/register', '账号含空格', 'POST', '/auth/register', { body: { accountId: 'sc space', password: b64(PW) } }, { status: 400, code: 'invalid_account_id' })
  await expect('A1 POST /auth/register', '账号含冒号', 'POST', '/auth/register', { body: { accountId: 'sc:colon', password: b64(PW) } }, { status: 400, code: 'invalid_account_id' })
  await expect('A1 POST /auth/register', 'displayName>64', 'POST', '/auth/register', { body: { accountId: `sc-dn-${RUN}`, password: b64(PW), displayName: 'x'.repeat(65) } }, { status: 400, code: 'invalid_request' })
  await expect('A1 POST /auth/register', 'displayName 仅空白→null', 'POST', '/auth/register', { body: { accountId: `sc-dn2-${RUN}`, password: b64(PW), displayName: '   ' } }, { status: 201, assert: (r) => r.json.account.displayName === null })
  await expect('A1 POST /auth/register', 'URL-safe base64 也可', 'POST', '/auth/register', { body: { accountId: `sc-url-${RUN}`, password: b64('url safe password!!').replace(/\+/g, '-').replace(/\//g, '_') } }, { status: 201 })
  await expect('A1 POST /auth/register', '未知字段', 'POST', '/auth/register', { body: { accountId: `sc-uf-${RUN}`, password: b64(PW), globalRole: 'administrator' } }, { status: 400, code: 'unknown_field' })
  await expect('A1 POST /auth/register', '非对象 body', 'POST', '/auth/register', { body: '[1,2,3]' }, { status: 400 })

  await expect('A2 POST /auth/login', '错误密码', 'POST', '/auth/login', { body: { accountId: ADMIN_ID, password: b64('definitely-wrong') } }, { status: 401, code: 'invalid_credentials' })
  await expect('A2 POST /auth/login', '账号不存在', 'POST', '/auth/login', { body: { accountId: `ghost-${RUN}`, password: b64(PW) } }, { status: 401, code: 'invalid_credentials' })
  await expect('A2 POST /auth/login', '缺少 password', 'POST', '/auth/login', { body: { accountId: ADMIN_ID } }, { status: 401, code: 'invalid_credentials' })
  await expect('A2 POST /auth/login', '未知字段', 'POST', '/auth/login', { body: { accountId: ADMIN_ID, password: b64(ADMIN_PW), ttl: 9 } }, { status: 400, code: 'unknown_field' })

  await expect('A3 GET /auth/me', '正常', 'GET', '/auth/me', ownerTok, { status: 200, check: (r) => r.json.account.accountId === owner.accountId })
  await expect('A3 GET /auth/me', '缺 token 头', 'GET', '/auth/me', { accountId: owner.accountId }, { status: 401 })
  await expect('A3 GET /auth/me', '只有 account 头', 'GET', '/auth/me', { accountId: owner.accountId }, { status: 401 })
  await expect('A3 GET /auth/me', '坏 JWT 结构', 'GET', '/auth/me', { token: 'not.a.jwt', accountId: owner.accountId, rawToken: true }, { status: 401 })
  await expect('A3 GET /auth/me', 'alg=none', 'GET', '/auth/me', { token: `${Buffer.from(J({ alg: 'none' })).toString('base64url')}.${Buffer.from(J({ a: owner.accountId, iat: Date.now(), exp: Date.now() + 60000 })).toString('base64url')}.`, accountId: owner.accountId, rawToken: true }, { status: 401 })
  await expect('A3 GET /auth/me', '已过期', 'GET', '/auth/me', { token: sign(owner.accountToken, owner.accountId, -10), accountId: owner.accountId, rawToken: true }, { status: 401, code: 'token_expired' })
  await expect('A3 GET /auth/me', 'exp 超 3 天上限', 'GET', '/auth/me', { token: sign(owner.accountToken, owner.accountId, 4 * 86400), accountId: owner.accountId, rawToken: true }, { status: 401, code: 'token_exp_too_long' })
  await expect('A3 GET /auth/me', '头与 payload 账号不一致', 'GET', '/auth/me', { token: sign(owner.accountToken, other.accountId), accountId: owner.accountId, rawToken: true }, { status: 401, code: 'token_account_mismatch' })
  await expect('A3 GET /auth/me', '用别人的 key 签', 'GET', '/auth/me', { token: sign(other.accountToken, owner.accountId), accountId: owner.accountId, rawToken: true }, { status: 401, code: 'unauthorized' })

  await expect('A4 POST /auth/logout', 'allDevices=false 可过', 'POST', '/auth/logout', { ...helperTok, body: { allDevices: false } }, { status: 204 })
  await expect('A4 POST /auth/logout', 'allDevices=true 不支持', 'POST', '/auth/logout', { ...helperTok, body: { allDevices: true } }, { status: 400, code: 'not_supported' })
  await expect('A4 POST /auth/logout', '空 body 也 204', 'POST', '/auth/logout', helperTok, { status: 204 })

  await expect('A5 PUT /auth/password', '旧密码错', 'PUT', '/auth/password', { ...otherTok, body: { oldPassword: b64('wrong-old-pass'), newPassword: b64('brand-new-pass-1') } }, { status: 401, code: 'invalid_credentials' })
  await expect('A5 PUT /auth/password', '新旧相同', 'PUT', '/auth/password', { ...otherTok, body: { oldPassword: b64(other.password), newPassword: b64(other.password) } }, { status: 400, code: 'same_password' })
  await expect('A5 PUT /auth/password', '新密码太短', 'PUT', '/auth/password', { ...otherTok, body: { oldPassword: b64(other.password), newPassword: b64('short') } }, { status: 400, code: 'invalid_password' })
  const NEXT_PW = other.password === PW ? 'scenario-pass-new' : PW
  const pwChanged = await expect('A5 PUT /auth/password', '成功换密', 'PUT', '/auth/password', { ...otherTok, body: { oldPassword: b64(other.password), newPassword: b64(NEXT_PW) } }, { status: 200, check: (r) => typeof r.json.accountToken === 'string' && r.json.accountToken.length === 64 })
  const otherNew = { token: pwChanged.json.accountToken, accountId: other.accountId }
  await expect('A5 PUT /auth/password', '旧密钥立即失效', 'GET', '/auth/me', otherTok, { status: 401 })

  await expect('A6 GET /auth/accounts', '缺 accountId 参数', 'GET', '/auth/accounts', adminTok, { status: 400, code: 'invalid_request' })
  await expect('A6 GET /auth/accounts', '存在', 'GET', `/auth/accounts?accountId=${helper.accountId}`, adminTok, { status: 200, check: (r) => r.json.exists === true })
  await expect('A6 GET /auth/accounts', '不存在', 'GET', `/auth/accounts?accountId=ghost-${RUN}`, adminTok, { status: 200, check: (r) => r.json.exists === false && r.json.account === null })

  // ══════════ B. 项目 ══════════
  const projName = `sc-proj-${RUN}`
  const created = await expect('B4 POST /projects', 'private 成功', 'POST', '/projects', { ...ownerTok, body: { name: projName, visibility: 'private', description: '场景矩阵' } }, { status: 201 })
  const pid = created.json.id
  await expect('B4 POST /projects', '缺 name', 'POST', '/projects', { ...ownerTok, body: { visibility: 'private' } }, { status: 400, code: 'invalid_project_name' })
  await expect('B4 POST /projects', 'name 超 100', 'POST', '/projects', { ...ownerTok, body: { name: 'x'.repeat(101), visibility: 'private' } }, { status: 400, code: 'invalid_project_name' })
  await expect('B4 POST /projects', 'description 超 2000', 'POST', '/projects', { ...ownerTok, body: { name: `${projName}-d`, visibility: 'private', description: 'x'.repeat(2001) } }, { status: 400, code: 'invalid_description' })
  await expect('B4 POST /projects', 'visibility 非法', 'POST', '/projects', { ...ownerTok, body: { name: `${projName}-v`, visibility: 'secret' } }, { status: 400, code: 'invalid_visibility' })
  await expect('B4 POST /projects', '重名（同名 owner）', 'POST', '/projects', { ...ownerTok, body: { name: projName, visibility: 'private' } }, { status: 409, code: 'project_name_exists' })
  await expect('B4 POST /projects', 'public 被普通用户拒', 'POST', '/projects', { ...ownerTok, body: { name: `${projName}-pub`, visibility: 'public' } }, { status: 403, code: 'public_project_requires_leader' })

  await expect('B1 GET /projects', 'pageSize 超 200 被夹住', 'GET', '/projects?pageSize=999', adminTok, { status: 200, check: (r) => r.json.pageSize === 200 })
  await expect('B1 GET /projects', 'pageNum=0 归 1', 'GET', '/projects?pageNum=0', adminTok, { status: 200, check: (r) => r.json.pageNum === 1 })
  await expect('B1 GET /projects', 'includeArchived', 'GET', '/projects?includeArchived=true', adminTok, { status: 200 })
  await expect('B2 GET /projects/mine', '不含别人的', 'GET', '/projects/mine', ownerTok, { status: 200, check: (r) => Array.isArray(r.json) && r.json.every((p) => p.memberCount >= 1) })
  await expect('B2 GET /projects/mine', 'includeArchived', 'GET', '/projects/mine?includeArchived=true', ownerTok, { status: 200 })
  await expect('B3 GET /projects/{id}', 'owner 可见', 'GET', `/projects/${pid}`, ownerTok, { status: 200, check: (r) => r.json.members.length === 1 })
  await expect('B3 GET /projects/{id}', '非成员 404', 'GET', `/projects/${pid}`, helperTok, { status: 404, code: 'project_not_found' })
  await expect('B3 GET /projects/{id}', 'id 非整数', 'GET', '/projects/abc', ownerTok, { status: 400, code: 'invalid_request' })
  await expect('B3 GET /projects/{id}', 'id 不存在', 'GET', '/projects/999999', adminTok, { status: 404, code: 'project_not_found' })

  await expect('B5 PUT /projects/{id}', '改 description', 'PUT', `/projects/${pid}`, { ...ownerTok, body: { description: '改过的描述' } }, { status: 200, check: (r) => r.json.description === '改过的描述' })
  await expect('B5 PUT /projects/{id}', '改成自己当前的名字（幂等 200）', 'PUT', `/projects/${pid}`, { ...ownerTok, body: { name: projName } }, { status: 200 })
  await expect('B4 POST /projects', '再建一个（造重名用）', 'POST', '/projects', { ...ownerTok, body: { name: `${projName}-2`, visibility: 'private' } }, { status: 201 })
  await expect('B5 PUT /projects/{id}', '改名到已被占用的名字', 'PUT', `/projects/${pid}`, { ...ownerTok, body: { name: `${projName}-2` } }, { status: 409, code: 'project_name_exists' })
  await expect('B5 PUT /projects/{id}', 'status 非法', 'PUT', `/projects/${pid}`, { ...ownerTok, body: { status: 'deleted' } }, { status: 400, code: 'invalid_request' })

  await expect('B8 POST /projects/{id}/members', '加 member', 'POST', `/projects/${pid}/members`, { ...ownerTok, body: { accountId: helper.accountId } }, { status: 200, check: (r) => r.json.role === 'member' })
  await expect('B8 POST /projects/{id}/members', '提为 manager', 'POST', `/projects/${pid}/members`, { ...ownerTok, body: { accountId: helper.accountId, role: 'manager' } }, { status: 200, check: (r) => r.json.role === 'manager' })
  await expect('B8 POST /projects/{id}/members', 'owner 角色不可授', 'POST', `/projects/${pid}/members`, { ...ownerTok, body: { accountId: other.accountId, role: 'owner' } }, { status: 400, code: 'owner_role_not_assignable' })
  await expect('B8 POST /projects/{id}/members', 'role 非法', 'POST', `/projects/${pid}/members`, { ...ownerTok, body: { accountId: other.accountId, role: 'admin' } }, { status: 400, code: 'invalid_role' })
  await expect('B8 POST /projects/{id}/members', '账号不存在', 'POST', `/projects/${pid}/members`, { ...ownerTok, body: { accountId: `ghost-${RUN}` } }, { status: 404, code: 'account_not_found' })
  await expect('B8 POST /projects/{id}/members', '改 owner 自己角色', 'POST', `/projects/${pid}/members`, { ...ownerTok, body: { accountId: owner.accountId } }, { status: 409, code: 'owner_role_immutable' })
  await expect('B8 POST /projects/{id}/members', '把 other 加为 member', 'POST', `/projects/${pid}/members`, { ...ownerTok, body: { accountId: other.accountId } }, { status: 200 })
  await expect('B8 POST /projects/{id}/members', 'member 无权加人', 'POST', `/projects/${pid}/members`, { ...otherNew, body: { accountId: owner.accountId } }, { status: 403, code: 'forbidden' })
  await expect('B5 PUT /projects/{id}', 'manager 改项目被拒', 'PUT', `/projects/${pid}`, { ...helperTok, body: { description: 'x' } }, { status: 403, code: 'forbidden' })

  await expect('B7 GET /projects/{id}/members', '成员列表', 'GET', `/projects/${pid}/members`, ownerTok, { status: 200, check: (r) => r.json.length === 3 && r.json.some((m) => m.role === 'owner') })

  // 转让与回传
  await expect('B10 PUT /projects/{id}/owner', '转给自己（幂等）', 'PUT', `/projects/${pid}/owner`, { ...ownerTok, body: { accountId: owner.accountId } }, { status: 200 })
  await expect('B10 PUT /projects/{id}/owner', '缺 accountId', 'PUT', `/projects/${pid}/owner`, { ...ownerTok, body: {} }, { status: 400, code: 'invalid_request' })
  await expect('B10 PUT /projects/{id}/owner', '目标不存在', 'PUT', `/projects/${pid}/owner`, { ...ownerTok, body: { accountId: `ghost-${RUN}` } }, { status: 404, code: 'account_not_found' })
  await expect('B10 PUT /projects/{id}/owner', '转给 helper', 'PUT', `/projects/${pid}/owner`, { ...ownerTok, body: { accountId: helper.accountId } }, { status: 200, check: (r) => r.json.owner === helper.accountId })
  await expect('B10 PUT /projects/{id}/owner', '已非 owner 再转让被拒', 'PUT', `/projects/${pid}/owner`, { ...ownerTok, body: { accountId: owner.accountId } }, { status: 403, code: 'owner_transfer_forbidden' })
  await expect('B10 PUT /projects/{id}/owner', '转回 owner', 'PUT', `/projects/${pid}/owner`, { ...helperTok, body: { accountId: owner.accountId } }, { status: 200 })

  await expect('B9 DELETE /projects/{id}/members/{accountId}', 'manager 不能移除 manager', 'DELETE', `/projects/${pid}/members/${helper.accountId}`, { ...helperTok }, { status: 403, code: 'forbidden' })
  await expect('B9 DELETE /projects/{id}/members/{accountId}', '移除自己（manager）', 'DELETE', `/projects/${pid}/members/${helper.accountId}`, { ...ownerTok }, { status: 204 })
  await expect('B9 DELETE /projects/{id}/members/{accountId}', '移除不存在的成员', 'DELETE', `/projects/${pid}/members/${helper.accountId}`, { ...ownerTok }, { status: 404, code: 'member_not_found' })
  await expect('B9 DELETE /projects/{id}/members/{accountId}', '不能移除 owner', 'DELETE', `/projects/${pid}/members/${owner.accountId}`, { ...ownerTok }, { status: 409, code: 'owner_cannot_be_removed' })

  // 归档 / 解档
  // 空项目可直接删（204），有 issue 的项目已在上面验证 409
  const empty = await expect('B4 POST /projects', '建空项目', 'POST', '/projects', { ...ownerTok, body: { name: `sc-empty-${RUN}`, visibility: 'private' } }, { status: 201 })
  await expect('B6 DELETE /projects/{id}', '删空项目 204', 'DELETE', `/projects/${empty.json.id}`, ownerTok, { status: 204 })
  await expect('B6 DELETE /projects/{id}', '删已删项目 404', 'DELETE', `/projects/${empty.json.id}`, ownerTok, { status: 404, code: 'project_not_found' })
  await expect('B5 PUT /projects/{id}', '归档', 'PUT', `/projects/${pid}`, { ...ownerTok, body: { status: 'archived' } }, { status: 200, check: (r) => r.json.status === 'archived' })
  await expect('B5 PUT /projects/{id}', '归档后改名被拒', 'PUT', `/projects/${pid}`, { ...ownerTok, body: { name: `${projName}-x` } }, { status: 409, code: 'project_archived' })
  await expect('B8 POST /projects/{id}/members', '归档后加人被拒', 'POST', `/projects/${pid}/members`, { ...ownerTok, body: { accountId: other.accountId } }, { status: 409, code: 'project_archived' })
  await expect('B9 DELETE /projects/{id}/members/{accountId}', '归档后移除被拒', 'DELETE', `/projects/${pid}/members/${helper.accountId}`, { ...ownerTok }, { status: 409, code: 'project_archived' })
  await expect('B10 PUT /projects/{id}/owner', '归档后转让被拒', 'PUT', `/projects/${pid}/owner`, { ...ownerTok, body: { accountId: helper.accountId } }, { status: 409, code: 'project_archived' })
  await expect('B1 GET /projects', '归档默认不出现在列表', 'GET', '/projects', { ...ownerTok }, { status: 200, check: (r) => r.json.items.every((p) => p.id !== pid) })
  await expect('B5 PUT /projects/{id}', '解档', 'PUT', `/projects/${pid}`, { ...ownerTok, body: { status: 'active' } }, { status: 200 })

  // 可见性转换
  const leader = await ensure('sc-leader', PW)
  const leaderTok = { token: leader.accountToken, accountId: leader.accountId }
  await expect('M4 PUT /admin/accounts/{id}/role', '提为 leader', 'PUT', `/admin/accounts/${leader.accountId}/role`, { ...adminTok, body: { role: 'leader' } }, { status: 200 })
  const pub = await expect('B4 POST /projects', 'leader 可建 public', 'POST', '/projects', { ...leaderTok, body: { name: `sc-pub-${RUN}`, visibility: 'public' } }, { status: 201 })
  await expect('B5 PUT /projects/{id}', 'public→private', 'PUT', `/projects/${pub.json.id}`, { ...leaderTok, body: { visibility: 'private' } }, { status: 200, check: (r) => r.json.visibility === 'private' })
  await expect('B5 PUT /projects/{id}', 'private→public', 'PUT', `/projects/${pub.json.id}`, { ...leaderTok, body: { visibility: 'public' } }, { status: 200, check: (r) => r.json.visibility === 'public' })
  await expect('M4 PUT /admin/accounts/{id}/role', '降为 user（仍是 public owner）', 'PUT', `/admin/accounts/${leader.accountId}/role`, { ...adminTok, body: { role: 'user' } }, { status: 409, code: 'owner_of_public_projects' })
  await expect('B10 PUT /projects/{id}/owner', 'public 转给普通 user 被拒', 'PUT', `/projects/${pub.json.id}/owner`, { ...leaderTok, body: { accountId: owner.accountId } }, { status: 409, code: 'owner_must_be_leader' })

  // ══════════ B. 设备 / 工作区 ══════════
  await expect('B11 POST /devices/batch', '同步两台', 'POST', '/devices/batch', { ...ownerTok, body: { devices: [{ host: 'sc-a', port: 1, os: 'win' }, { host: 'sc-b', port: 2 }] } }, { status: 200, check: (r) => r.json.synced === 2 })
  await expect('B11 POST /devices/batch', '同批重复 host+port 去重 upsert', 'POST', '/devices/batch', { ...ownerTok, body: { devices: [{ host: 'sc-a', port: 1 }, { host: 'sc-a', port: 1 }] } }, { status: 200, check: (r) => r.json.synced === 2 })
  await expect('B11 POST /devices/batch', '空批=全下线', 'POST', '/devices/batch', { ...ownerTok, body: { devices: [] } }, { status: 200, check: (r) => r.json.synced === 0 })
  await expect('B11 POST /devices/batch', 'host 缺失', 'POST', '/devices/batch', { ...ownerTok, body: { devices: [{ port: 1 }] } }, { status: 400, code: 'invalid_request' })
  await expect('B11 POST /devices/batch', 'host 超 255', 'POST', '/devices/batch', { ...ownerTok, body: { devices: [{ host: 'h'.repeat(256) }] } }, { status: 400, code: 'invalid_request' })
  await expect('B11 POST /devices/batch', 'port 越界', 'POST', '/devices/batch', { ...ownerTok, body: { devices: [{ host: 'x', port: 65536 }] } }, { status: 400, code: 'invalid_request' })
  await expect('B11 POST /devices/batch', '201 台超限', 'POST', '/devices/batch', { ...ownerTok, body: { devices: Array.from({ length: 201 }, (_, i) => ({ host: `h${i}` })) } }, { status: 400, code: 'invalid_request' })
  await expect('B11 POST /devices/batch', 'devices 不是数组', 'POST', '/devices/batch', { ...ownerTok, body: { devices: 'x' } }, { status: 400, code: 'invalid_request' })
  await expect('B12 GET /devices', '只返 active', 'GET', '/devices', ownerTok, { status: 200, check: (r) => Array.isArray(r.json) })
  await expect('B12 GET /devices', '查他人（允许）', 'GET', `/devices?accountId=${owner.accountId}`, otherNew, { status: 200 })
  await expect('B13 GET /devices/mine', '含 inactive 分页', 'GET', '/devices/mine?pageSize=5', ownerTok, { status: 200, check: (r) => typeof r.json.total === 'number' })
  await expect('B15 POST /device-workspaces', 'index 成功', 'POST', '/device-workspaces', { ...ownerTok, body: { instance: `sc:${RUN}`, type: 'index', detail: '#i' } }, { status: 200 })
  await expect('B15 POST /device-workspaces', 'portal 成功', 'POST', '/device-workspaces', { ...ownerTok, body: { instance: `sc:${RUN}`, type: 'portal', detail: '#p', workspaceId: 'w1', cwd: `D:/sc/${RUN}/a` } }, { status: 200 })
  await expect('B15 POST /device-workspaces', 'index 带 cwd 被拒', 'POST', '/device-workspaces', { ...ownerTok, body: { instance: `sc:${RUN}`, type: 'index', detail: '#i', cwd: 'D:/x' } }, { status: 400, code: 'invalid_workspace_shape' })
  await expect('B15 POST /device-workspaces', 'portal 缺 cwd 被拒', 'POST', '/device-workspaces', { ...ownerTok, body: { instance: `sc:${RUN}`, type: 'portal', detail: '#p', workspaceId: 'w2' } }, { status: 400, code: 'invalid_workspace_shape' })
  await expect('B15 POST /device-workspaces', 'type 非法', 'POST', '/device-workspaces', { ...ownerTok, body: { instance: `sc:${RUN}`, type: 'page', detail: 'x' } }, { status: 400, code: 'invalid_type' })
  await expect('B15 POST /device-workspaces', 'instance 缺失', 'POST', '/device-workspaces', { ...ownerTok, body: { type: 'index', detail: 'x' } }, { status: 400, code: 'invalid_request' })
  await expect('B16 GET /device-workspaces', 'type 过滤', 'GET', `/device-workspaces?type=index`, ownerTok, { status: 200, check: (r) => r.json.every((w) => w.type === 'index') })
  await expect('B16 GET /device-workspaces', 'workspaceId 过滤', 'GET', `/device-workspaces?workspaceId=w1`, ownerTok, { status: 200, check: (r) => r.json.length >= 1 && r.json.every((w) => w.workspaceId === 'w1') })
  await expect('B16 GET /device-workspaces', 'instance 过滤', 'GET', `/device-workspaces?instance=${encodeURIComponent(`sc:${RUN}`)}`, ownerTok, { status: 200 })
  await expect('B16 GET /device-workspaces', 'cwdPrefix + cwd 同时传被拒', 'GET', `/device-workspaces?cwd=D:/sc&cwdPrefix=D:/sc`, ownerTok, { status: 400, code: 'invalid_request' })
  await expect('B16 GET /device-workspaces', '查不存在的账号=空', 'GET', `/device-workspaces?accountId=ghost-${RUN}`, ownerTok, { status: 200, check: (r) => r.json.length === 0 })
  await expect('B14 DELETE /devices/{id}', '删他人设备', 'DELETE', '/devices/999999', ownerTok, { status: 404, code: 'device_not_found' })

  // ══════════ C. Issue ══════════
  // 两条 issue：fullIssueId 只写一次（验证全字段落库），issueId 用于后面的 upsert/状态流转
  const issueId = `sc-issue-${RUN}`
  const fullIssueId = `sc-full-${RUN}`
  await expect('C1 POST /issues/batch', '全字段提交', 'POST', '/issues/batch', {
    ...ownerTok,
    body: [{
      issueId: fullIssueId, title: '场景矩阵 issue', assignee: helper.accountId, projectId: pid,
      detail: 'x'.repeat(5000), cwd: 'D:/work/space', urgency: 'runtime', permission: 'workspace-write',
      source: 'dsh', sourceInstance: 'inst-1', assignerTask: 't1', assignerMeta: '{"a":1}',
      dependsOn: 'dep-1', status: 'pending', assigneeTask: 'at', assigneeInstance: 'ai', assigneeMeta: '{}',
    }],
  }, { status: 200, check: (r) => Array.isArray(r.json) && r.json[0] === fullIssueId })
  await expect('C1 POST /issues/batch', '简单提交（用于 upsert）', 'POST', '/issues/batch', { ...ownerTok, body: [{ issueId, title: '初版标题', assignee: helper.accountId, projectId: pid }] }, { status: 200 })
  await expect('C1 POST /issues/batch', 'upsert 覆盖 assignee/urgency', 'POST', '/issues/batch', { ...ownerTok, body: [{ issueId, title: '改名后', assignee: owner.accountId, projectId: pid, urgency: 'relaxed' }] }, { status: 200 })
  await expect('C1 POST /issues/batch', '空数组', 'POST', '/issues/batch', { ...ownerTok, body: [] }, { status: 200, check: (r) => Array.isArray(r.json) && r.json.length === 0 })
  await expect('C1 POST /issues/batch', '101 条超限', 'POST', '/issues/batch', { ...ownerTok, body: Array.from({ length: 101 }, (_, i) => ({ title: `t${i}`, assignee: owner.accountId })) }, { status: 400, code: 'invalid_request' })
  await expect('C1 POST /issues/batch', '非数组', 'POST', '/issues/batch', { ...ownerTok, body: { title: 'x' } }, { status: 400, code: 'invalid_request' })
  await expect('C1 POST /issues/batch', 'title 空', 'POST', '/issues/batch', { ...ownerTok, body: [{ title: '   ', assignee: owner.accountId }] }, { status: 400, code: 'invalid_title' })
  await expect('C1 POST /issues/batch', 'urgency 非法', 'POST', '/issues/batch', { ...ownerTok, body: [{ title: 'x', assignee: owner.accountId, urgency: 'panic' }] }, { status: 400, code: 'invalid_urgency' })
  await expect('C1 POST /issues/batch', 'permission 非法', 'POST', '/issues/batch', { ...ownerTok, body: [{ title: 'x', assignee: owner.accountId, permission: 'root' }] }, { status: 400, code: 'invalid_permission' })
  await expect('C1 POST /issues/batch', 'status 非法', 'POST', '/issues/batch', { ...ownerTok, body: [{ title: 'x', assignee: owner.accountId, status: 'done' }] }, { status: 400, code: 'invalid_status' })
  await expect('C1 POST /issues/batch', 'cwd 超 500', 'POST', '/issues/batch', { ...ownerTok, body: [{ title: 'x', assignee: owner.accountId, cwd: 'c'.repeat(501) }] }, { status: 400, code: 'invalid_request' })
  await expect('C1 POST /issues/batch', '项目不存在', 'POST', '/issues/batch', { ...ownerTok, body: [{ title: 'x', assignee: owner.accountId, projectId: 999999 }] }, { status: 404, code: 'project_not_found' })
  const outsider = await ensure('sc-outsider', PW)
  await expect('C1 POST /issues/batch', '非项目成员', 'POST', '/issues/batch', { token: outsider.accountToken, accountId: outsider.accountId, body: [{ title: 'x', assignee: outsider.accountId, projectId: pid }] }, { status: 403, code: 'not_project_member' })

  // 全枚举值扫一遍
  for (const urgency of ['runtime', 'direct', 'urgent', 'normal', 'relaxed']) {
    await expect('C1 POST /issues/batch', `urgency=${urgency}`, 'POST', '/issues/batch', { ...ownerTok, body: [{ title: `u-${urgency}`, assignee: owner.accountId, urgency }] }, { status: 200 })
  }
  for (const permission of ['read-only', 'workspace-write', 'danger-full-access']) {
    await expect('C1 POST /issues/batch', `permission=${permission}`, 'POST', '/issues/batch', { ...ownerTok, body: [{ title: `p-${permission}`, assignee: owner.accountId, permission }] }, { status: 200 })
  }
  for (const status of ['pending', 'accepted', 'routing', 'running', 'success', 'failed', 'abandoned']) {
    await expect('C1 POST /issues/batch', `status=${status}`, 'POST', '/issues/batch', { ...ownerTok, body: [{ title: `s-${status}`, assignee: owner.accountId, status }] }, { status: 200 })
  }

  await expect('C2 GET /issues', 'projectId 过滤', 'GET', `/issues?projectId=${pid}`, adminTok, { status: 200, check: (r) => r.json.items.every((i) => i.projectId === pid) })
  await expect('C2 GET /issues', 'source 过滤', 'GET', '/issues?source=dsh', adminTok, { status: 200, check: (r) => r.json.items.every((i) => i.source === 'dsh') })
  await expect('C2 GET /issues', 'keyword', 'GET', `/issues?keyword=${encodeURIComponent('sc-issue')}`, adminTok, { status: 200 })
  await expect('C2 GET /issues', 'pageSize 夹到 200', 'GET', '/issues?pageSize=9999', adminTok, { status: 200, check: (r) => r.json.pageSize === 200 })
  await expect('C2 GET /issues', 'status 非法', 'GET', '/issues?status=nope', adminTok, { status: 400, code: 'invalid_status' })
  await expect('C2 GET /issues', 'projectId 非整数', 'GET', '/issues?projectId=abc', adminTok, { status: 400, code: 'invalid_request' })

  await expect('C3 GET /issues/{issueId}', 'upsert 后可选字段被清空', 'GET', `/issues/${issueId}`, adminTok, {
    status: 200,
    check: (r) => r.json.title === '改名后' && r.json.detail === null && r.json.dependsOn === null && r.json.urgency === 'relaxed',
  })
  await expect('C3 GET /issues/{issueId}', '全字段写入后可回读', 'GET', `/issues/${fullIssueId}`, adminTok, {
    status: 200,
    check: (r) =>
      r.json.assigner === owner.accountId &&
      r.json.dependsOn === 'dep-1' &&
      r.json.detail.length === 5000 &&
      r.json.permission === 'workspace-write' &&
      r.json.cwd === 'D:/work/space' &&
      r.json.sourceInstance === 'inst-1' &&
      r.json.assigneeTask === 'at',
  })
  await expect('C3 GET /issues/{issueId}', '不存在', 'GET', `/issues/ghost-${RUN}`, adminTok, { status: 404, code: 'issue_not_found' })

  await expect('C4 PUT /issues/{issueId}', '改 projectId 到别人的项目', 'PUT', `/issues/${issueId}`, { ...otherNew, body: { projectId: 999999 } }, { status: 404, code: 'project_not_found' })
  await expect('C4 PUT /issues/{issueId}', '未知字段', 'PUT', `/issues/${issueId}`, { ...ownerTok, body: { hack: 1 } }, { status: 400, code: 'unknown_field' })
  await expect('C4 PUT /issues/{issueId}', 'assignee 不存在', 'PUT', `/issues/${issueId}`, { ...ownerTok, body: { assignee: `ghost-${RUN}` } }, { status: 404, code: 'account_not_found' })
  await expect('C4 PUT /issues/{issueId}', 'permission=null 清空', 'PUT', `/issues/${issueId}`, { ...ownerTok, body: { permission: null } }, { status: 200, check: (r) => r.json.permission === null })
  await expect('C4 PUT /issues/{issueId}', 'status 非法', 'PUT', `/issues/${issueId}`, { ...ownerTok, body: { status: 'done' } }, { status: 400, code: 'invalid_status' })

  await expect('C6 POST /issues/status/batch', '带 assignee 字段一起更新', 'POST', '/issues/status/batch', {
    ...helperTok,
    body: [{ issueId, status: 'accepted', expectedStatus: 'pending', assigneeTask: 'cl-1', assigneeInstance: 'inst-x', assigneeMeta: '{"k":1}', assignedAt: '2026-01-01T00:00:00.000Z' }],
  }, { status: 200, check: (r) => r.json.success === 1 })
  await expect('C6 POST /issues/status/batch', 'assignedAt 落库', 'GET', `/issues/${issueId}`, helperTok, { status: 200, check: (r) => r.json.assignedAt === '2026-01-01T00:00:00.000Z' })
  await expect('C6 POST /issues/status/batch', '201 条超限', 'POST', '/issues/status/batch', { ...ownerTok, body: Array.from({ length: 201 }, () => ({ issueId: 'x', status: 'pending' })) }, { status: 400, code: 'invalid_request' })
  await expect('C6 POST /issues/status/batch', '空数组', 'POST', '/issues/status/batch', { ...ownerTok, body: [] }, { status: 200, check: (r) => r.json.success === 0 && r.json.failed.length === 0 })
  await expect('C6 POST /issues/status/batch', '非数组', 'POST', '/issues/status/batch', { ...ownerTok, body: {} }, { status: 400, code: 'invalid_request' })

  await expect('C9 POST /issues/{issueId}/comments', '带角色与时间', 'POST', `/issues/${issueId}/comments`, {
    ...helperTok,
    body: { content: '带元信息的评论', commentId: `sc-cm-${RUN}`, commentRole: 'assignee', commentAuthorType: 'agent', commentAt: '2026-02-02T00:00:00.000Z' },
  }, { status: 201, check: (r) => r.json.commentRole === 'assignee' && r.json.commentAt === '2026-02-02T00:00:00.000Z' })
  await expect('C9 POST /issues/{issueId}/comments', '内容超 10000', 'POST', `/issues/${issueId}/comments`, { ...helperTok, body: { content: 'x'.repeat(10001) } }, { status: 400, code: 'invalid_request' })
  await expect('C9 POST /issues/{issueId}/comments', '未知字段', 'POST', `/issues/${issueId}/comments`, { ...helperTok, body: { content: 'x', author: 'hacker' } }, { status: 400, code: 'unknown_field' })
  await expect('C9 POST /issues/{issueId}/comments', 'issue 不存在', 'POST', `/issues/ghost-${RUN}/comments`, { ...helperTok, body: { content: 'x' } }, { status: 404, code: 'issue_not_found' })

  await expect('C7 GET /issues/comments', '增量有数据', 'GET', '/issues/comments?sinceId=0&limit=5000', adminTok, { status: 200, check: (r) => Array.isArray(r.json.items) && r.json.nextSinceId >= 0 })
  await expect('C7 GET /issues/comments', 'limit 夹到 2000', 'GET', '/issues/comments?limit=99999', adminTok, { status: 200 })
  await expect('C7 GET /issues/comments', 'sinceId 负数按 0', 'GET', '/issues/comments?sinceId=-5', adminTok, { status: 200 })
  await expect('C8 GET /issues/comments/cursor', '返回 maxId', 'GET', '/issues/comments/cursor', adminTok, { status: 200, check: (r) => typeof r.json.maxId === 'number' })
  await expect('C10 GET /issues/{issueId}/comments', '按时间正序', 'GET', `/issues/${issueId}/comments`, adminTok, { status: 200, check: (r) => r.json.length >= 1 })
  await expect('C10 GET /issues/{issueId}/comments', 'issue 不存在', 'GET', `/issues/ghost-${RUN}/comments`, adminTok, { status: 404, code: 'issue_not_found' })

  // 附件
  const payload = Buffer.from(`scenario ${RUN}`, 'utf8')
  const sha = createHash('sha256').update(payload).digest('hex')
  const up = await expect('F1 POST /files', '不带 sha 也可', 'POST', '/files', { ...ownerTok, raw: payload, headers: { 'x-file-name': encodeURIComponent(`场景 ${RUN}.txt`) } }, { status: 201 })
  const fid = up.json.fileId
  await expect('F1 POST /files', '带正确 sha', 'POST', '/files', { ...ownerTok, raw: payload, headers: { 'x-file-name': 'a.txt', 'x-file-sha256': sha } }, { status: 201, check: (r) => r.json.sha256 === sha })
  await expect('F1 POST /files', 'sha 非法格式', 'POST', '/files', { ...ownerTok, raw: payload, headers: { 'x-file-name': 'a.txt', 'x-file-sha256': 'zz' } }, { status: 400, code: 'invalid_request' })
  await expect('F1 POST /files', '缺 X-File-Name', 'POST', '/files', { ...ownerTok, raw: payload }, { status: 400, code: 'invalid_file_name' })
  await expect('F1 POST /files', '非法 percent-encoding', 'POST', '/files', { ...ownerTok, raw: payload, headers: { 'x-file-name': '%ZZ' } }, { status: 400, code: 'invalid_file_name' })
  await expect('F1 POST /files', '文件名带路径分隔符被剥掉', 'POST', '/files', { ...ownerTok, raw: payload, headers: { 'x-file-name': encodeURIComponent('../../etc/passwd') } }, { status: 201, check: (r) => r.json.fileName === 'passwd' })
  await expect('C11 POST /issues/attachments/batch', '挂 assigner 类型', 'POST', '/issues/attachments/batch', { ...ownerTok, body: [{ issueId, fileId: fid, type: 'assigner', description: 'd1' }] }, { status: 200, check: (r) => r.json.count === 1 })
  await expect('C11 POST /issues/attachments/batch', '同 fileId 改类型=upsert', 'POST', '/issues/attachments/batch', { ...ownerTok, body: [{ issueId, fileId: fid, type: 'assignee' }] }, { status: 200 })
  await expect('C11 POST /issues/attachments/batch', '51 条超限', 'POST', '/issues/attachments/batch', { ...ownerTok, body: Array.from({ length: 51 }, () => ({ issueId, fileId: fid, type: 'assignee' })) }, { status: 400, code: 'invalid_request' })
  await expect('C11 POST /issues/attachments/batch', 'issue 不存在', 'POST', '/issues/attachments/batch', { ...ownerTok, body: [{ issueId: `ghost-${RUN}`, fileId: fid, type: 'assignee' }] }, { status: 404, code: 'issue_not_found' })
  await expect('C12 GET /issues/{issueId}/attachments', 'type=assignee', 'GET', `/issues/${issueId}/attachments?type=assignee`, adminTok, { status: 200, check: (r) => r.json.length === 1 && r.json[0].type === 'assignee' })
  await expect('C12 GET /issues/{issueId}/attachments', 'type 非法', 'GET', `/issues/${issueId}/attachments?type=other`, adminTok, { status: 400, code: 'invalid_type' })
  await expect('F2 GET /files/{fileId}', '下载内容一致', 'GET', `/files/${fid}`, adminTok, { status: 200, check: (r) => true })
  await expect('F2 GET /files/{fileId}', '非法 fileId 400', 'GET', '/files/not-a-uuid', adminTok, { status: 400, code: 'invalid_file_id' })

  // 来源字典
  await expect('C14 POST /issue-sources/batch', '同批重复 code 去重', 'POST', '/issue-sources/batch', { ...ownerTok, body: [{ code: `sc-${RUN_ALPHA}`, description: 'first' }, { code: `sc-${RUN_ALPHA}`, description: 'second' }] }, { status: 200, check: (r) => r.json.count === 1 })
  await expect('C14 POST /issue-sources/batch', 'code 含数字被拒', 'POST', '/issue-sources/batch', { ...ownerTok, body: [{ code: 'sc1' }] }, { status: 400, code: 'invalid_source_code' })
  await expect('C14 POST /issue-sources/batch', 'code 双中划线被拒', 'POST', '/issue-sources/batch', { ...ownerTok, body: [{ code: 'a--b' }] }, { status: 400, code: 'invalid_source_code' })
  await expect('C14 POST /issue-sources/batch', '101 条超限（先判长度）', 'POST', '/issue-sources/batch', { ...ownerTok, body: Array.from({ length: 101 }, (_, i) => ({ code: `x-${i}` })) }, { status: 400, code: 'invalid_request' })
  await expect('C13 GET /issue-sources', '按 q 搜索', 'GET', `/issue-sources?q=sc-${RUN_ALPHA}`, ownerTok, { status: 200 })
  const selfCheck = await call('GET', '/auth/me', ownerTok)
  if (selfCheck.status !== 200) {
    const dbg = { accountId: owner.accountId, tokenLen: owner.accountToken?.length, status: selfCheck.status, body: selfCheck.json }
    throw new Error(`owner 自己的 /auth/me 就失败了：${JSON.stringify(dbg)}`)
  }
  const srcList = await call('GET', '/issue-sources', ownerTok)
  if (!Array.isArray(srcList.json)) throw new Error(`GET /issue-sources 期望数组，实际 ${srcList.status} ${JSON.stringify(srcList.json)}`)
  const src = srcList.json.find((s) => s.code === `sc-${RUN_ALPHA}`)
  if (!src) throw new Error(`找不到来源 sc-${RUN_ALPHA}，现有：${srcList.json.map((s) => s.code).join(',')}`)
  await expect('C15 PUT /issue-sources/{id}', '只改 pluginName', 'PUT', `/issue-sources/${src.id}`, { ...adminTok, body: { pluginName: 'my-plugin' } }, { status: 200, check: (r) => r.json.pluginName === 'my-plugin' && r.json.description === 'second' })
  await expect('C15 PUT /issue-sources/{id}', '未知字段', 'PUT', `/issue-sources/${src.id}`, { ...adminTok, body: { code: 'hack' } }, { status: 400, code: 'unknown_field' })
  await expect('C16 DELETE /issue-sources/{id}', '删除', 'DELETE', `/issue-sources/${src.id}`, adminTok, { status: 204 })

  await expect('C5 DELETE /issues/{issueId}', '遗弃', 'DELETE', `/issues/${issueId}`, ownerTok, { status: 204, check: () => true })
  await expect('B6 DELETE /projects/{id}', '有 issue 时 409', 'DELETE', `/projects/${pid}`, ownerTok, { status: 409, code: 'project_has_issues' })
  await expect('C5 DELETE /issues/{issueId}', '遗弃后仍是 abandoned', 'GET', `/issues/${issueId}`, ownerTok, { status: 200, check: (r) => r.json.status === 'abandoned' })
  await expect('F3 DELETE /files/{fileId}', '普通用户 403', 'DELETE', `/files/${fid}`, ownerTok, { status: 403 })
  await expect('F3 DELETE /files/{fileId}', '管理员 204', 'DELETE', `/files/${fid}`, adminTok, { status: 204 })

  // ══════════ M. 管理与运维 ══════════
  await expect('M1 GET /health', '字段齐全', 'GET', '/health', {}, { status: 200, check: (r) => r.json.ok === true && typeof r.json.db.userVersion === 'number' })
  await expect('M2 GET /version', '47 端点', 'GET', '/version', {}, { status: 200, check: (r) => r.json.endpoints.length === 47 })
  await expect('M6 GET /admin/accounts', 'q 搜索', 'GET', `/admin/accounts?q=sc-hel`, adminTok, { status: 200, check: (r) => r.json.items.every((a) => a.accountId.includes('sc-hel')) })
  await expect('M6 GET /admin/accounts', '普通用户 403', 'GET', '/admin/accounts', helperTok, { status: 403 })
  await expect('M4 PUT /admin/accounts/{id}/role', 'user→leader', 'PUT', `/admin/accounts/${helper.accountId}/role`, { ...adminTok, body: { role: 'leader' } }, { status: 200, check: (r) => r.json.globalRole === 'leader' })
  await expect('M4 PUT /admin/accounts/{id}/role', 'leader→administrator', 'PUT', `/admin/accounts/${helper.accountId}/role`, { ...adminTok, body: { role: 'administrator' } }, { status: 200 })
  await expect('M4 PUT /admin/accounts/{id}/role', 'administrator→user', 'PUT', `/admin/accounts/${helper.accountId}/role`, { ...adminTok, body: { role: 'user' } }, { status: 200 })
  await expect('M4 PUT /admin/accounts/{id}/role', '非法角色', 'PUT', `/admin/accounts/${helper.accountId}/role`, { ...adminTok, body: { role: 'root' } }, { status: 400, code: 'invalid_request' })
  await expect('M4 PUT /admin/accounts/{id}/role', '目标不存在', 'PUT', `/admin/accounts/ghost-${RUN}/role`, { ...adminTok, body: { role: 'user' } }, { status: 404, code: 'account_not_found' })
  await expect('M4 PUT /admin/accounts/{id}/role', '普通用户调用 403', 'PUT', `/admin/accounts/${helper.accountId}/role`, { ...ownerTok, body: { role: 'leader' } }, { status: 403 })
  await expect('M5 POST /admin/accounts/{id}/password', '重置为弱密码被拒', 'POST', `/admin/accounts/${helper.accountId}/password`, { ...adminTok, body: { newPassword: b64('password1234') } }, { status: 400, code: 'weak_password' })
  await expect('M5 POST /admin/accounts/{id}/password', '目标不存在', 'POST', `/admin/accounts/ghost-${RUN}/password`, { ...adminTok, body: { newPassword: b64('another-pass-1234') } }, { status: 404, code: 'account_not_found' })
  await expect('M5 POST /admin/accounts/{id}/password', 'base64 非法', 'POST', `/admin/accounts/${helper.accountId}/password`, { ...adminTok, body: { newPassword: '@@@' } }, { status: 400, code: 'invalid_password_encoding' })
  await expect('M3 POST /admin/shutdown', '无凭据 401', 'POST', '/admin/shutdown', {}, { status: 401 })
  await expect('M3 POST /admin/shutdown', '错误 shutdown token 401', 'POST', '/admin/shutdown', { headers: { 'x-shutdown-token': 'wrong' } }, { status: 401 })

  // ══════════ 汇总 ══════════
  console.log('─'.repeat(96))
  console.log('端点'.padEnd(52) + '场景数'.padEnd(10) + '失败')
  console.log('─'.repeat(96))
  for (const [k, v] of [...perEndpoint.entries()].sort()) {
    console.log(k.padEnd(52) + String(v.total).padEnd(10) + (v.bad || ''))
  }
  console.log('─'.repeat(96))
  const covered = perEndpoint.size
  const totalScenarios = [...perEndpoint.values()].reduce((n, v) => n + v.total, 0)
  console.log(`端点 ${covered} 个 / 场景 ${totalScenarios} 条 / 通过 ${pass} / 失败 ${failures.length}`)
  if (failures.length) console.log(`\n失败明细：\n${failures.map((f) => `  ✗ ${f}`).join('\n')}`)

  console.log(`\n无法通过 HTTP 验证的项（需要进程/时序控制）：
  · 非回环来源被 M3 拒绝（本机只能从 127.0.0.1 发起）
  · M1 停机中返回 503（窗口只有几十毫秒，且会把服务停掉）
  · BEGIN IMMEDIATE 并发竞态（同一进程内串行，要另起多进程压测）
  · WAL 崩溃恢复、磁盘写满、单实例锁抢占（需杀进程 / 造故障）`)

  if (failures.length) process.exitCode = 1
}

main().catch((err) => {
  console.error('\n场景矩阵中断：', err)
  process.exit(1)
})
