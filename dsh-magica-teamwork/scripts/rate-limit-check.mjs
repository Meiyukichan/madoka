/**
 * 限流验证：单独跑，避免把整个场景矩阵拖进 60s 冷却窗口。
 *
 *   node scripts/rate-limit-check.mjs
 *
 * 验证两点：
 *   1. 同一账号连续失败登录，第 6 次开始返回 429 + Retry-After
 *   2. 冷却窗口过去后能恢复
 */
const BASE = `${(process.argv[2] ?? 'http://127.0.0.1:3939').replace(/\/+$/, '')}/dsh-teamwork/v1`
const ID = 'sc-ratelimit'
const PW = 'ratelimit-pass-1234'
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

async function login(password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: ID, password: b64(password) }),
  })
  return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.text() }
}

// 保证账号存在（登录失败就先注册）
let first = await login(PW)
if (first.status !== 200) {
  const reg = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: ID, password: b64(PW) }),
  })
  if (reg.status !== 201 && reg.status !== 409) {
    console.error('无法准备账号:', reg.status, await reg.text())
    process.exit(1)
  }
  // 注册本身也算一次 auth 调用；若已被限流要先等窗口过去
  if (reg.status === 429) {
    const wait = Number(reg.headers.get('retry-after') ?? 60)
    console.log(`准备阶段就触发了限流，等待 ${wait}s 窗口重置…`)
    await new Promise((r) => setTimeout(r, (wait + 2) * 1000))
  }
}

const results = []
let limitedAt = null
let retryAfter = null
for (let i = 1; i <= 8; i++) {
  const r = await login('definitely-wrong-password')
  results.push(`  第 ${i} 次 → ${r.status}${r.retryAfter ? ` (Retry-After: ${r.retryAfter})` : ''}`)
  if (r.status === 429) {
    limitedAt = i
    retryAfter = r.retryAfter
    break
  }
}
console.log(`账号 ${ID} 连续失败登录：`)
console.log(results.join('\n'))

let ok = 0
let fail = 0
const check = (name, cond) => {
  if (cond) {
    ok++
    console.log(`✅ ${name}`)
  } else {
    fail++
    console.log(`❌ ${name}`)
  }
}

check('第 6 次（5 次额度之后的第一次）开始 429', limitedAt !== null && limitedAt >= 6)
check('429 带 Retry-After 头', Boolean(retryAfter) && Number(retryAfter) > 0)

if (retryAfter) {
  const wait = Number(retryAfter) + 2
  console.log(`等待 ${wait}s 后验证恢复…`)
  await new Promise((r) => setTimeout(r, wait * 1000))
  const after = await login(PW)
  check('窗口过去后可以用正确密码登录（说明限流是滑窗不是封号）', after.status === 200)
}

console.log(`\n通过 ${ok}，失败 ${fail}`)
if (fail) process.exitCode = 1
