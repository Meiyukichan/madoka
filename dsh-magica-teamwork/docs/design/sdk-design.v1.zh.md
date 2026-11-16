# dsh-teamwork · SDK 设计

> 配套文档：[`server-design.zh.md`](./server-design.zh.md)（参考实现的服务端设计）、
> [`db-design.zh.md`](./db-design.zh.md)（参考实现的库表）。
> 本文定义**单包双入口里 `.` 这个入口**：纯库，无 `apply(ctx)`、无 `inject`、无 `dsh.bundle`。
>
> 一句话定位：**给 DSH 插件/脚本用的项目管理服务客户端 + 凭据管理**，把「登录、存凭据、带 token 调接口、幂等重试」
> 收成一个 `TeamworkClient`；服务端在哪、SQLite 怎么存，使用方完全不用知道。
>
> ⚠️ **协议优先**：本 SDK **不绑定** `./server` 这个参考实现。任何人只要按 §11 的协议实现服务端
> （用 Go/Java/SQLite/Postgres/云函数都行），SDK 就能直接用。本文档里出现的端口 `3939`、
> `/dsh-teamwork/v1`、SQLite 表结构都是**参考实现的取值，不是协议要求**；
> 但 §11 里的**两个请求头 + HS256 签名方案 + `accountToken` 回传**是协议的一部分，换服务端必须一致。

---

## 0. 决策登记

与需求方确认过的（勿单方面推翻）：

| # | 决策 | 取值 |
|---|---|---|
| E1 | 包形态 | 单包双入口：`.` = SDK，`./server` = 服务端（见服务端文档 §2） |
| E2 | 加密 | **不区分 Win/Linux**，统一 AES-256-GCM + 独立 0600 密钥文件 |
| E3 | 凭据内容 | 只存 `accountToken`（密码校验值 + JWT 签名密钥）+ 账号信息 + `ttlSeconds`；**不存明文密码、不存 authToken** |
| E4 | 鉴权头 | `dsh-teamwork-token: <authToken>` + `dsh-teamwork-account: <accountId>`（替代旧 `X-AUTH-TOKEN`）；`authToken` 是**客户端签的 HS256 JWT** |
| E5 | 身份 | 所有接口的身份来自 token；SDK **不发送** `user_id` |
| **E6** | **token 来源** | **`accountToken` 由服务端在注册/登录响应里返回**（`SHA256(账号:密码)`，一次性）；**`authToken` 由 SDK 每次请求用 `accountToken` 现签 HS256 JWT**（payload `{a,iat,exp}`） |
| **E7** | **服务端可替换** | 协议由 SDK 定义（§11）。参考实现（`./server`）**不是必需件**，第三方按协议实现即可；SDK 不依赖任何服务端内部实现 |

---

## 1. 加密方案（最终决定 + 论证）

需求里最初设想的是「账号 + 密码组合成一个不可解密的 token」，这条在密码学上**不能同时成立**：
不可解密就无法从 token 里取出账号，那就必须查库；能取出账号就说明它可解密。所以拆成两层，各用最合适的原语，
**全部用 `node:crypto`，零原生依赖、零平台分支**：

| 层 | 目的 | 算法 | 落点 |
|---|---|---|---|
| ① 请求签名 token（`auth_token`） | 每次请求证明「我是这个账号」 | **HS256 JWT**：`HMAC-SHA256(key = account_token, header.payload)`，payload = `{a, ip, iat, exp}` | 请求头 `dsh-teamwork-token` / `dsh-teamwork-account` |
| ② 签名密钥（`account_token`） | 密码校验值 + token 签名密钥 | **`SHA-256(utf8(account_id + ":" + password))`**（需求方指定；见 §1.5） | 服务端 DB `account.account_token`；客户端 `.credentials.json`（**密码等价物，按机密对待**） |
| ③ 本地凭据存储 | 落盘保密 | **AES-256-GCM**，密钥 = 独立 32B 随机文件（`0600`） | `$DSH_TEAMWORK_HOME/.credentials.json` + `.credentials.key` |

### 1.1 为什么不选 DPAPI

| 论点 | 结论 |
|---|---|
| 「不区分 Win/Linux」是硬要求 | DPAPI 只有 Windows 有，必然分支出两套代码路径 |
| Node 里没有内置 DPAPI | 只能靠 PowerShell 子进程（dsh desktop 的 `upload-with-credentials.ps1` 就是 `Import-Clixml`）或原生模块；SDK 宿主环境未必有 `powershell`，且沙箱下子进程可能被拒 |
| 威胁模型并不更强 | DPAPI `CurrentUser` 防的是「别的用户账户 / 别的机器」；AES 层 + `0600` 在**同机同用户**威胁下等价，而 DPAPI 多出来的那点强度换来的是「可能启动失败」 |

### 1.2 为什么不选 JWT / 自包含加密 token

- 自包含 token（服务端主密钥 `AES-GCM` 密文里带 `accountId + exp`）省一次查库，但**吊销要额外黑名单**，
  而 SQLite 按 `auth_token` 唯一索引查一次是微秒级 —— 省不到东西，却把「可吊销」这个最重要的属性变成可选件。
- JWT 同理，且默认载荷可读（`base64`），容易误把敏感字段塞进去。

### 1.3 诚实边界（必须写进 README，不许含糊）

这一层**防的是**：凭据文件被误提交进仓库、被复制进日志/工单/聊天记录、被备份系统带到别的机器、被同机其他用户
（`0600` + 目录权限）读到。

这一层**防不住**：以当前用户身份运行的恶意进程 —— 它能直接读 `.credentials.key`。
这一点与 DSH 自己把 API Key 明文放在 `~/.dsh/.credentials.yaml` 是同级别的；不要宣称「本 SDK 的凭据绝对安全」。

### 1.4 两把"token"分别由谁产生（最容易搞错）

| 名字 | 谁产生 | 存在哪 | 用途 |
|---|---|---|---|
| `account_token` | **服务端**（`SHA256("account_id:password")`），登录/注册响应里回传 | DB `account.account_token` + 本地 `.credentials.json` | **密码校验值**，同时是 `auth_token` 的 **HMAC 签名密钥** |
| `auth_token` | **客户端**（用 `account_token` 当密钥签 HS256 JWT） | 只在内存 + 本地 `.credentials.json` | **每次请求带在 header 里** |

完整时序：

```
① SDK → POST /auth/login { accountId, password }
② 服务端：查行 → 算 SHA256(account_id:password) → timingSafeEqual 比对
③ 服务端 → 200 { account, accountToken, ttlSeconds }    ← accountToken 按密码级机密对待
④ SDK：accountToken 进内存 → 签出 auth_token（HS256，payload = {a,ip,iat,exp}）
        → 两个值一起 AES-256-GCM 加密写 .credentials.json
⑤ 每次请求：
        dsh-teamwork-token:   <auth_token>
        dsh-teamwork-account: <account_id>
⑥ 服务端：按 header 的 account_id 查行 → 用其 account_token 验签 → 校验 exp ≤ now+TTL
⑦ 下次进程启动：解密 .credentials.json → 拿到 account_token → **重新签** auth_token（不必再输密码）
```

三条**禁止**：

| 禁止 | 为什么 |
|---|---|
| ❌ 把 `account_token` 放进 JWT **payload** | payload 只是 base64，**解码即可读**；等于把签名密钥公开发布（护栏 1） |
| ❌ 让 `exp` 超过服务端 TTL | 服务端强制 `exp <= now + TTL + 60s`，超了直接 `exp_too_long`（护栏 2） |
| ❌ 用 `account_token` 直接当请求凭据 | 它只能当**签名密钥**；直接发它等于把密码等价物放上网络 |

> 注意：`account_token` 在客户端落盘 = **密码等价物落盘**（能读文件即可反复签新 token）。
> 这是需求方知情选择的方案，风险清单见 [`db-design.zh.md`](./db-design.zh.md) §3.2.2。

### 1.5 算法清单与实测成本（本机 Node 24.19 实测，不是估算）

| 用途 | 算法 / 参数 | 输出 | 实测 |
|---|---|---|---|
| `auth_token` 生成 | **HS256 JWT**：`HMAC-SHA256(account_token, header.payload)`，base64url 三段 | 173 字符 | 验签 **10.38 µs**（含查库） |
| `auth_token` 载荷 | `{a: account_id, ip, iat, exp}`（**不含 account_token**，它只作密钥） | 明文可读（无秘密） | — |
| 签名/验签密钥 | `account_token`（64 hex；服务端在登录响应里下发） | 绝不进 token 三段 | 换钥只改签名（实测） |
| 密码传输 | 请求体 `password` 一律 **base64**（`api-design §0.3`）；**SDK 边界收明文、发请求前编码**，调用方无感 | — | — |
| 密码存储 | **`account_token = SHA-256(utf8(account_id + ":" + 明文))`**（需求方指定） | 64 字符小写 hex | **0.71 µs** |
| 密码比对 | `crypto.timingSafeEqual`（常量时间；**不 trim、不做 Unicode 归一化**） | bool | 0.04 µs |
| 本地凭据加密 | **AES-256-GCM**（AEAD），key 32B 随机、IV 12B 随机/次、tag 16B、AAD 绑版本+kid | 129B 明文 → 129B 密文 | 26 µs |
| DB | **不加密**（SQLite 明文文件），靠文件权限 + OS 账户隔离 | — | — |
| 传输 | **HTTP 明文**，默认只绑 `127.0.0.1`；跨机需前置 TLS 反代 | — | — |

#### 为什么密码用快哈希是"已知降级"，而 token 用 HMAC 不是

| | `account_token`（密码派生） | `auth_token`（签名 token） |
|---|---|---|
| 输入熵 | 人类口令，实际 **20–40 bit** | 密钥是 64 hex（256 bit）；payload 无需保密 |
| 泄露后能爆破吗 | **能**：逐账号枚举，快哈希下 GPU 约 10¹⁰ 次/秒 | 不能：HMAC 抗密钥恢复 |
| 该用什么 | 理想是慢哈希（scrypt/argon2） | 快哈希/MAC 即可 |
| 本项目实际 | **`SHA-256(账号:密码)`（0.71 µs）—— 需求方指定** | **HMAC-SHA256**（签名 18.79 µs / 验签 10.38 µs 含查库） |

> ⚠️ **已知降级，不遮掩**：密码侧用快哈希，意味着 **DB 泄露后弱口令可在秒级被离线枚举**
> （对比 scrypt 51 ms/次，差约 7 万倍）。这是需求方知情后选定的方案（db-design §3.1.0 / A-8），
> 补偿措施：登录限流（IP 10/分、账号 5/分）+ 失败统一延迟 300 ms + 密码最小 **12 位** + 弱口令表 + 不建索引。

**为什么 token 侧不再用「服务端随机 + 存摘要」**：需求方要求去掉会话表（见 §1.2 与 db-design §3.2），
于是改成「客户端用 `account_token` 签名、服务端无状态验签」。代价是：**失去了单点吊销与设备观测**，
且 **DB 泄露 = 可伪造任意账号的 token**（签名密钥就在库里）。这三条都写进了 db-design §3.2.2。

**为什么 `account_token` 不是加密**：它没有密钥、不可解密，是单向摘要；"加密账号密码"是口语说法。
它的两种用法：① 登录时重算比对；② 作为 `auth_token` 的 HMAC 密钥。**绝不能**直接当请求凭据发送。

**为什么本地加密是 AES-256-GCM 而不是 AES-CBC**：AEAD 自带认证标签，篡改密文/IV/AAD 直接失败，
不需要自己拼 encrypt-then-MAC（那是最常见的实现错误来源）；无 padding → 无 padding oracle。
ChaCha20-Poly1305 同样可接受，选 AES-GCM 是因为 x86 有 AES-NI 硬件加速、生态更常见。

**明确禁用**：MD5、SHA-1、`Math.random`、DPAPI（分平台，见 §1.1）、任何自研加密或自创协议。
**允许且使用**：HS256（HMAC-SHA256）—— 但只用于**签名**，payload 明文，绝不承载密钥。
---

## 2. 包与用法

### 2.1 入口

```ts
import { TeamworkClient, CredentialStore, TeamworkError } from '@meiyukichan/dsh-teamwork'
import { startServer } from '@meiyukichan/dsh-teamwork/server'   // 只有服务端要 import
```

`exports` 见服务端文档 §2.1；SDK 入口**不 import 任何 `node:http` / `node:sqlite`**（用 `import type` 隔离类型），
保证在只装运行时依赖的场景下不会因为服务端模块被连带加载。

### 2.2 最小用法

```ts
const tw = await TeamworkClient.create({
  baseUrl: 'http://127.0.0.1:3939/dsh-teamwork/v1',
  // home 缺省 = $DSH_TEAMWORK_HOME ?? ~/.dsh/storages/teamwork
})

// 首次：注册 / 登录（服务端回 accountToken → SDK 立刻签名 + 加密落盘 → 再返回）
await tw.register({ accountId: 'meiyuki@team', password: '...', displayName: 'めゆき' })

// 之后：create() 已自动从凭据文件恢复登录态，直接调用
const issues = await tw.issues.list({ status: 'pending', pageSize: 50 })

// 3 天后 exp 过期：SDK 下次请求自动用新 exp 现签（纯本地操作，调用方无感）
// （只有在「改过密码 / 账号被禁用」时才需要重新输密码）
try {
  await tw.issues.list({ status: 'pending' })
} catch (e) {
  if (e instanceof TeamworkError && e.code === 'login_required') {
    // 账号信息还在（tw.auth.accountId），只需向用户要密码
    await tw.login({ accountId: tw.auth.accountId!, password: await promptPassword() })
    // ↑ 内部已原子覆盖 .credentials.json，无需重建 client
  }
}

// 派发一条工作
await tw.issues.create({
  issueId: `dsh:${hostname()}:${uuidv5(ns, taskId)}`,   // 幂等键，重试必须复用
  assignee: 'peer@team',
  cwd: process.cwd(),
  urgency: 'urgent',
  title: '修复登录超时',        // 必填 1..200
  projectId: 7,                 // 可选：归属项目（null = 临时 issue）
  detail: '## 现象\n...',       // 可选：正文本体
})

// 认领（DB 层条件更新仲裁，抢不到会给 status_conflict）
const r = await tw.issues.updateStatus([
  { issueId, status: 'accepted', expectedStatus: 'pending', assigneeInstance: '10.1.2.3:3080' },
])
// r = { success: 1, failed: [] } | { success: 0, failed: [{ issueId, reason: 'status_conflict' }] }
```

---

## 3. 凭据存储（`CredentialStore`）

### 3.1 文件布局

```
$DSH_TEAMWORK_HOME (默认 ~/.dsh/storages/teamwork)
├── .credentials.key     32 字节原始密钥的 base64url 文本（POSIX 0600 / Windows 依赖用户目录 ACL）
└── .credentials.json    AES-256-GCM 信封
```

### 3.2 信封格式

```jsonc
{
  "v": 1,
  "alg": "aes-256-gcm",
  "kid": "a1b2c3d4",          // key 指纹前 8 位，便于换钥与排错
  "iv": "base64url(12B)",      // 每次写入新随机 IV，绝不复用
  "tag": "base64url(16B)",
  "ct": "base64url(ciphertext)"
}
```

解密后的明文（**只在内存里存在**）：

```jsonc
{
  "v": 1,
  "server": "http://127.0.0.1:3939/dsh-teamwork/v1",
  "accountId": "meiyuki@team",
  "displayName": "めゆき",
  "globalRole": "user",
  "accountToken": "5e60415360c7fe33…（64 hex）",   // 密码等价物 + 签名密钥，按机密对待

  "ttlSeconds": 259200,                            // 服务端下发的有效期（3 天）
  "savedAt": "2026-11-11T11:05:54.829Z"
}
```

> **`accountToken` 是这份文件里最值钱的东西**：拿到它就能无限重签 `authToken`。
> 因此 `authToken` **根本不需要落盘**——它是每个请求现签的，不存在"文件里的 token 过期了"这回事。
> 反过来，`accountToken` 丢了就必须重新登录输密码。

> **文件里不存 `authToken`**：JWT 每次请求现签（`exp = now + ttlSeconds`），
> 所以没有"作废文件里的 token"这一步，也彻底消除了"文件 exp 与内存 exp 不一致"的 bug。
> 唯一会失效的是 `accountToken`（改密码 / 管理员重置 / 账号禁用），那时必须重新登录。

- **AAD**（附加认证数据）：`dsh-teamwork/credential/v1|<kid>`
  —— 把版本与 key 指纹绑进认证标签，篡改 `v`/`kid` 会直接解密失败
- `iv` 每次 `save()` 都重新 `randomBytes(12)`；GCM 下 **IV 复用 = 灾难**，这条不允许「优化」
- 先写 `tmp` 再 `rename`（同目录），保证崩溃时不会留下半截信封
- `save()` 时对 `.credentials.json` 与 `.credentials.key` 都用 `fs.open(path, 'w', 0o600)`

### 3.3 凭据生命周期（含过期）

| 场景 | 行为 |
|---|---|
| 首次 `save()` | 若 `.credentials.key` 不存在 → `randomBytes(32)` 生成并 `0600` 落盘 |
| 正常 `load()` | 读 key → 解密；解不开（key 变了/文件损坏）→ 抛 `TeamworkError('credential_corrupt')`，**不自动删**（可能想手工抢救） |
| **`authToken` "过期"** | 不存在这个概念：JWT 每次请求现签（`exp = now + ttlSeconds`）。只有服务端 401 才处理，见 §4.1 |
| **服务端拒绝（401）** | 说明 `account_token` 已变（改过密码）或账号被禁用 → 清掉 `accountToken`，抛 `login_required`（必须重新输密码） |
| **重新登录** | `login()` → 新 `accountToken` + `ttlSeconds` → **原子覆盖** `.credentials.json`（`authToken` 不落盘，无需处理） |
| 显式退出 | `tw.logout()` → 删 `.credentials.json`（保留 `.credentials.key`）；**服务端无法作废**（无会话表），要真正作废只能改密码 |
| 重置 | `CredentialStore.reset()` 删两个文件；`dsh-teamwork doctor` 提供 `--reset-credential` |
| 换钥 | 读旧 key 解密 → 生成新 key → 用新 key 加密 → 原子替换两个文件；任一步失败保留旧文件 |

> 「过期」与「登出」的差别：**过期保留账号信息**（为了免敲账号重新登录），**登出是主动清除**（可能换人用这台机器）。

### 3.4 并发与多实例

同一 `home` 被多个进程（比如多个 DSH 实例）同时使用时：

- 读：无锁，直接读（信封整体原子替换，读到的要么旧要么新）
- 写：`save()` 前取 `.<home>/.credentials.lock`（`fs.open('wx')`），失败则 100ms 重试 ×10，仍失败抛 `credential_busy`
- **不做内存缓存**：每次请求前不重复解密，`TeamworkClient` 在内存里持有解密后的凭据，直到进程退出或 `reload()`

---

## 4. 认证生命周期

### 4.0 响应契约（登录/注册回传 `accountToken`）

| 端点 | 请求 | 成功响应（**协议要求，字段名固定**） |
|---|---|---|
| `POST /auth/register` | `{ accountId, password(明文), displayName? }` → SDK 自动 base64 | **201** `{ account: AccountVo, accountToken: string, ttlSeconds: number }` |
| `POST /auth/login` | `{ accountId, password(明文) }` → SDK 自动 base64 | 200，同上（同一账号永远拿到同一个 `accountToken`） |
| `GET /auth/me` | 签名头 | 200 `AccountVo`（**不包 `{account}`**） |
| `POST /auth/logout` | 签名头 | **204**（无 body；纯语义，服务端只清鉴权缓存） |
| `PUT /auth/password` | `{ oldPassword(明文), newPassword(明文) }` | 200 `{ accountToken, ttlSeconds }`（**新密钥**） |
| `POST /admin/accounts/{id}/password` | `{ newPassword(明文) }`（administrator） | **204** |

```ts
type AccountVo = {
  accountId: string
  displayName: string | null
  globalRole: 'administrator' | 'leader' | 'user'
  status: 'active' | 'disabled'
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}
```

| 规则 | 说明 |
|---|---|
| `accountToken` | **服务端产出**（`SHA256(账号:密码)`）；SDK 不自己算，以响应为准（避免算法漂移） |
| `ttlSeconds` | 必填（参考实现 `259200` = 3 天）；SDK 用它算 `exp`，**服务端仍会封顶 `exp <= now + ttl + 60s`** |
| 落盘 | `login()` 内部：拿 `accountToken` → 加密写 `.credentials.json` → 才置 `state='authenticated'`；写失败抛 `credential_*`，内存不留"假装已登录" |
| 换服务端 | `baseUrl` 变了 → `server` 字段不匹配 → 不复用旧凭据，要求重新 `login()` |

### 4.1 每个请求现签 JWT（**不再有"刷新"概念**）

```ts
// 每次发请求前（内存操作，微秒级）
const iat = Date.now()
const exp = iat + Math.min(ttlSeconds * 1000, CAP)   // CAP = 3d + 60s，服务端会再校验
const token = jwtSign({ a: accountId, iat, exp }, accountToken, 'HS256')
headers['dsh-teamwork-token'] = token
headers['dsh-teamwork-account'] = accountId
```

| 特性 | 结果 |
|---|---|
| 无"续期" | 没有 refresh token、没有 expiresAt 落盘、没有定时器 |
| 无"过期"状态 | `state` 只有 `authenticated` / `login_required` / `anonymous` |
| 401 处理 | 见下表；**签名是纯本地操作**，所以 401 重试不需要网络登录 |
| 成本 | HS256 签名实测 **18.79 µs**（见 §1.5），每请求一次可忽略 |

**401 的四条分支**（按服务端 `code` 分）

| 服务端 code | 含义 | SDK 行为 |
|---|---|---|
| `token_expired` | `exp` 已过 | 用当前时钟重签 → **只重试一次**；仍失败 → `login_required` |
| `token_exp_too_long` | 客户端时钟过快，`exp` 超了服务端上限 | 用 `exp = now + ttl - skew` 重签（`skew` 从 `/health` 的 `serverTime` 学）→ 重试一次 |
| `token_account_mismatch` | 两个头不一致 | **代码 bug**，直接抛 `internal_error`，不重试 |
| `unauthorized` | 签名对不上（`accountToken` 已变）或账号被禁用 | 清 `accountToken` → `state='login_required'` → 抛 `login_required` |

**`accountToken` 失效的三种原因**（都必须重新登录输密码）

1. 用户自己改了密码（A5）→ 响应里给了新 `accountToken`，SDK 直接换掉，**不用重登**
2. 管理员重置密码（M5）→ 下次请求 401 `unauthorized` → 必须重登
3. 账号被禁用 → 403 `account_disabled` → 保留凭据，`state='login_required'`（管理员恢复后可直接用）

### 4.2 时钟偏差

现签模式下时钟问题只剩一处：**本地时钟比服务端快**时，`exp` 可能超过服务端上限（`now + ttl + 60s`）。

| 情形 | 判定 |
|---|---|
| 偏差 ≤ 60s | 正常（服务端留了 60s 余量） |
| 偏差 > 60s，服务端回 `token_exp_too_long` | 用 `skew = 本地 now - 服务端 serverTime` 修正后重签一次 |
| 本地时钟**慢** | 无影响（`exp` 更小，只会更早过期；服务端按自己的时钟判） |

`/health` 的 `serverTime` 与本地时间差，`doctor` 子命令会打印出来供排查。

---

## 5. 客户端 API

### 5.1 构造

```ts
TeamworkClient.create(options?: {
  baseUrl?: string          // 默认 http://127.0.0.1:3939/dsh-teamwork/v1
  home?: string             // 默认 $DSH_TEAMWORK_HOME ?? ~/.dsh/storages/teamwork
  timeoutMs?: number        // 默认 15000
  retries?: number          // 默认 2（仅幂等请求）
  fetch?: typeof fetch      // 注入用（测试/自定义 agent）
  accountToken?: string     // 【可选】直接注入 account_token：CI / 第三方服务端 / 无凭据文件的场景
  persist?: boolean         // 默认 true；false = 纯内存，不写 .credentials.json
  probe?: boolean           // 默认 true；启动时拉 GET /version 做能力探测（失败只警告）
  strictProtocol?: boolean  // 默认 false；true 时 protocol 主版本不匹配直接抛 incompatible_server
}): Promise<TeamworkClient>
```

> `persist: false` 是「服务端可以自己写」的关键逃生口：
> 有人拿一次性 token 在 CI 里跑，或者他的服务端用完全不同的 token 生命周期，
> 都不需要碰 `$DSH_TEAMWORK_HOME` 下的任何文件。

### 5.2 命名空间与方法

| 命名空间 | 方法 | 对应端点 |
|---|---|---|
| `tw.auth` | `register/login/me/logout/changePassword` + `refresh()`（用 `accountToken` 重签） | A1–A5 |
| `tw.projects` | `list/mine/get/create/update/remove` | B1–B6 |
| `tw.members` | `list(projectId)/add(projectId,{accountId,role})/remove(projectId,accountId)`（`role` 仅 `manager`/`member`） | B7–B9 |
| `tw.projects`（补充） | `transferOwner(projectId,accountId)` | B10 |
| `tw.devices` | `sync(list)/list({accountId})/mine(page)/remove(id)` | B11–B14 |
| `tw.workspaces` | `upsert(item)/list(filter)` | B15/B16 |
| `tw.issues` | `create(item)/list(query)/get(id)/overwrite(id,item)/abandon(id)/updateStatus(items)` | C1–C6 |
| `tw.comments` | `add(issueId,item)/list(issueId)/delta({sinceId,limit})/cursor()` | C7–C10 |
| `tw.attachments` | `add(items)/list(issueId,type?)` | C11/C12 |
| `tw.sources` | `list(code?)/register(items)` | C13/C14 |
| `tw.files` | `upload(stream,{fileName,sha256?})/download(fileId)/remove(fileId)` | F1–F3 |
| `tw.admin` | `accounts.list({q})/setRole(accountId,role)/resetPassword(accountId,newPassword)` | M4（改角色）、M5（重置密码）、M6（账号列表） |

签名约定（全部 `Promise`，全部抛 `TeamworkError`）：

```ts
create(item: IssueCreateInput): Promise<string[]>          // 返回 issueId 数组，顺序与入参一致
updateStatus(items: IssueStatusUpdateItem[]): Promise<{ success: number; failed: { issueId: string; reason: string }[] }>
list(query: IssueListQuery): Promise<Page<Issue>>          // Page = { total, pageNum, pageSize, items }
```

### 5.3 类型完全对齐服务端

- 枚举从 `shared/enums.ts` 导出（`IssueStatus` / `IssueUrgency` / `IssuePermission` /
  `ProjectMemberRole` / `ProjectVisibility` / `WhitelistRole` / `AttachmentType` / `WorkspaceType` / `DeviceStatus`）
- `Issue` = **旧 19 字段 + `projectId` / `title` / `detail`**（`id` 用 `number`，`createdAt/assignedAt/updatedAt` 是 ISO 字符串）
- `Page<T>` 只有一种形状，不存在 `page`/`list` 两种变体

---

## 6. 错误模型

```ts
class TeamworkError extends Error {
  code: TeamworkErrorCode       // 'unauthorized' | 'forbidden' | 'not_found' | 'rate_limited' | ...
  status?: number               // HTTP 状态码，网络错误时 undefined
  details?: unknown             // 服务端 details
  requestId?: string            // 服务端 requestId，报障时带上
}

// 网络层（非 HTTP）
'network_error' | 'timeout' | 'bad_response'
// 本地层
'credential_missing' | 'credential_corrupt' | 'credential_busy' | 'not_authenticated'
// 认证层：需要用户重新输密码（改过密码 / 账号被禁用 / 无 accountToken）
'login_required'
// 服务端能力
'unsupported'                    // 调了服务端 /version 未声明的端点
'incompatible_server'            // /version 的 protocol 主版本不匹配（strictProtocol 时）
// 服务端层：直接用服务端的 code（'invalid_request' / 'issue_not_found' / 'status_conflict' / 'expired' / 'exp_too_long' ...）
```

铁律：

1. **不吞错**。所有 `fetch` 失败都要转成 `TeamworkError` 再抛，绝不返回 `undefined`。
2. **不透出 body 原文**给终端用户（可能含内部信息）；`message` 用固定短句，`details` 原样保留给开发者。
3. 批量接口的**业务失败不算抛错**（`updateStatus` 单条失败进 `failed[]`），只有 HTTP 层失败才抛。

---

## 7. 超时、重试、幂等

| 项 | 规则 |
|---|---|
| 超时 | 默认 15s，`AbortSignal.timeout(timeoutMs)`；上传/下载按 `max(timeoutMs, 60s)` |
| 重试 | 仅 `GET/PUT/DELETE` 或**带幂等键**的写操作；次数默认 2；退避 `300ms × 2^n + jitter`；只对 `network_error` / `timeout` / `429` / `5xx` 重试；`4xx` 不重试 |
| 幂等键 | `issueId` 必须由调用方生成并**重试时复用**（缺失时服务端会生成 UUID → 重试产生重复） |
| 评论幂等 | `commentId` 同理：SDK 在 `comments.add` 里若未提供，**由 SDK 生成 UUID 并在重试中复用**（服务端才是真正的兜底方） |
| 批量 | `updateStatus` 逐条独立，重试整体安全（条件更新天然幂等） |
| 连接 | 默认 `fetch`（undici）；需要自定义 agent / 代理时通过 `options.fetch` 注入，不内置代理逻辑 |

---

## 8. 上传与下载

```ts
// 上传：raw body，不拼 multipart（服务端文档 §5.4 说明了原因）
const { fileId, sha256 } = await tw.files.upload(createReadStream(path), {
  fileName: 'report.pdf',
  sha256: await sha256Of(path),      // 可选；服务端校验不一致 → 400
})

// 关联到 issue
await tw.attachments.add([{ issueId, fileId, type: 'assignee', fileName: 'report.pdf' }])

// 下载：返回 ReadableStream，由调用方决定落盘还是直接读
const stream = await tw.files.download(fileId)
await pipeline(stream, createWriteStream(outPath))
```

- 上传前若给了 `sha256`，SDK 先算出**流式**摘要再发（大文件两次读）——或直接让服务端校验（`X-File-Sha256`），
  默认走服务端校验，SDK 不预先算（避免 64MB 文件读两遍）。**这一点由 `verify: 'server' | 'client'` 选项控制**
- 进度回调：`onProgress?: (sent: number, total: number) => void`（可选，不做 UI）

---

## 9. 与 DSH 的关系（未来插件的工程约束）

本 SDK **本身不是 DSH 插件**：无 `apply(ctx)`、无 `inject`、无 `cordis.patch.yml`、不发 client bundle。
但如果后面要包一层插件（在 DSH GUI 里看 issue、认领任务），必须遵守 AGENTS.md：

| 约束 | 要求 |
|---|---|
| 基线 | DSH `0.2.0-rc.2`（`engines.dsh`） |
| 产物 | 统一 `lib/`，client bundle 产出 `lib/client.js` |
| 包声明 | `dsh.bundle.patch` → `cordis.patch.yml`，`insert.name` 必须等于 `package.json.name` |
| 依赖 | `@deepseek-ai/*` 用 `>=` 且不低于安装版本；`react`/`react-dom` 作为 externals |
| 运行时 | 禁止热路径同步阻塞、禁止未捕获 reject/未处理 reject、副作用必须可逆、禁止 SSE（轮询 ≥5s） |
| UI | 用 `ui-primitives`；文案走 `locale.register/bind`；颜色只用 `--dsw-alias-*` |
| 本 SDK 的位置 | 插件里**只 import `.`（SDK 入口）**，绝不 import `./server`（服务端跑在独立进程） |

---

## 10. 测试与自检

| 层 | 做法 |
|---|---|
| 单测 | `node --test`；`CredentialStore` 用临时 home 目录，校验「密文不含明文」「篡改 tag 必失败」「换钥后旧文件仍可解」 |
| **密钥落盘** | 注册后读文件解密，断言 `accountToken` **逐字节等于**响应里的串；且文件里**没有** `authToken` 字段 |
| **现签** | 造 `ttlSeconds=60` → 连发两次请求 → 两次 `exp` 不同（每次现签）；`payload.a === accountId`；签名可用 `accountToken` 验证 |
| **401 重签** | mock 第一次回 `token_expired` → SDK 重签并重试一次 → 成功；第二次仍 401 → 抛 `login_required` |
| **token_exp_too_long** | mock 回 `token_exp_too_long` → 用 `health.serverTime` 算 skew 后重签 → 第二次成功 |
| 集成 | 起真服务（`startServer({dataDir: tmp, port: 0})`，监听 0 随机端口），跑注册→建项目→提交 issue→认领→评论→上传下载全链路 |
| 并发 | 同一 `issueId` 两个并发认领，断言恰有一个 `success`、另一个 `status_conflict` |
| 崩溃 | 写入中途 kill 进程，断言 `.credentials.json` 仍是完整 JSON（原子写） |
| 自检 | `dsh-teamwork doctor`：node 版本 / home 可写 / 凭据可解 / **服务端 `ttlSeconds`** / 与服务端时钟差 / 服务可达 |
| **契约测试** | `dsh-teamwork conformance --base-url <url>`：按 §11 的必需端点跑一遍，输出「通过 / 缺失 / 行为不符」报告，用来验收第三方服务端 |

---

## 11. 协议契约（服务端可替换）

### 11.1 定位：服务端是参考实现，SDK 面向"任何遵守契约的实现"

| 事实 | 含义 |
|---|---|
| SDK 有 **`host` 配置**，默认 `http://127.0.0.1:3939` | 装好就能用（本机单用户），不需要先部署什么 |
| 用户可以把 `host` 改成自己的域名 | 此时**服务端由用户自己实现**（任意语言、任意数据库、任意部署形态都行） |
| SDK 只依赖**本文档 + `api-design.zh.md`** 定义的 HTTP 契约 | 我们的 `./server`（Node + SQLite）只是参考实现之一，**换掉它 SDK 不改一行** |

> 由此推出一条硬约束：**`api-design.zh.md` 里写的东西就是契约本身**。
> 参考实现可以换存储、换语言、换部署形态，但路径、字段名、状态码语义、错误码字符串不能变。

### 11.2 SDK 依赖 vs 不依赖

| SDK **依赖**（变了就对接不上） | SDK **不依赖**（实现自由） |
|---|---|
| 路径 + HTTP 方法 | DB 引擎、表名、索引 |
| 请求/响应字段名与类型（`camelCase`） | 服务端进程模型、端口、是否 `bin` 启动 |
| 鉴权头名：`dsh-teamwork-token` / `dsh-teamwork-account` | 密码哈希算法（只要 `accountToken` 语义对） |
| JWT 形态：HS256，payload `{a, iat, exp}`，密钥 = `accountToken` | 是否有 `whitelist` / `issue_source` 这些表 |
| `accountToken` = `SHA256(账号:密码)` 的 64 位小写 hex | 限流参数、缓存 TTL |
| 成功状态码（200/201/204）与错误码 `code` 字符串 | 错误 `message` 文案 |
| 分页 `{total,pageNum,pageSize,items}` | 分页实现方式 |
| 时间格式 ISO-8601 UTC 毫秒 | 时间列的存储类型 |
| 密码字段是 base64（SDK 自动编码，调用方无感） | 服务端如何解码/校验 |
| `GET /version` 的 `protocol` + `endpoints[]` | `endpoints` 的具体排序 |

> **注意**：旧版本这里曾写"token 格式不依赖"——**那是错的**。`authToken` 是 SDK 自己签的，
> 所以 JWT 的算法、payload 字段、签名密钥都必须是契约的一部分。

### 11.3 端点分级（第三方可按需实现）

| 级别 | 端点 | 缺了的后果 |
|---|---|---|
| **Tier 1 · 必需** | A1 register / A2 login / A3 me / C1 issues.batch / C2 issues.list / C3 issue.get / C6 status.batch | `create()` 抛 `incompatible_server` |
| **Tier 2 · 协作** | A4 logout / A5 password / C4 / C5 / C7 / C8 / C9 / C10 / C11 / C12 / F1–F3 | 对应方法抛 `unsupported`，其余可用 |
| **Tier 3 · 项目与设备** | B1–B16 | 同上；纯 issue 收集服务端可以完全没有这些 |
| **Tier 4 · 管理** | C13–C16 sources / M1–M6 | 同上 |

SDK 按 `/version` 的 `endpoints[]` 判断能力，**不猜**。

### 11.4 能力探测（`GET /version`）

```jsonc
{
  "protocol": "dsh-teamwork/1",
  "name": "dsh-teamwork",
  "version": "0.1.0",
  "endpoints": ["POST /auth/login", "GET /projects", "POST /issues/batch"]
}
```

| 字段 | 契约要求 |
|---|---|
| `protocol` | 必须是 `dsh-teamwork/1`；不匹配 → `incompatible_server`（**不尝试兼容**） |
| `endpoints` | `"<METHOD> <path>"` 字符串数组；SDK 据此过滤可用方法 |
| `version` / `name` | 仅展示，不参与判定 |

### 11.5 第三方实现自检清单

| # | 检查 |
|---|---|
| 1 | 两个鉴权头齐全，`dsh-teamwork-account` 必须等于 JWT payload 的 `a` |
| 2 | `exp <= now + ttl + 60s` 必须校验（否则客户端可签长效 token） |
| 3 | `POST /issues/batch` 按 `issueId` upsert，返回 `issueId[]` 顺序与入参一致 |
| 4 | `POST /issues/status/batch` 返回 **200** + `{success, failed[]}`（**不是 4xx**） |
| 5 | `GET /issues/comments` 用自增 id 游标，返回 `{items, nextSinceId, hasMore}` |
| 6 | 错误体结构一致，`code` 用契约里的字符串 |
| 7 | `GET /version` 的 `protocol` 与 `endpoints` 齐全 |
| 8 | 204 响应确实无 body（SDK 会读 body 判空） |

---

## 12. 已收敛的决策与剩余开放项

### 12.1 已收敛（不要再翻案）

| 项 | 结论 |
|---|---|
| `host` 默认值 | `http://127.0.0.1:3939`；用户可改为自己的域名，此时**服务端由用户按契约实现** |
| 鉴权材料 | 只存 `accountToken`；`authToken` 每个请求现签，**不落盘** |
| 密码传输 | base64（SDK 边界收明文、发请求前编码） |
| 过期语义 | 没有 refresh token、没有 expiresAt；`exp = now + ttlSeconds`，服务端封顶 |
| 错误码 | `code` 字符串是契约，SDK 按它分支；`message` 不解析 |
| issue 的资源级鉴权 | **服务端不做**（C 组），SDK/DSH 侧负责 |
| 文件下载权限 | **只需签名头**（F2），`fileId` 的 UUID v4 随机性是唯一防线 |
| 附件的 `fileId` 校验 | 服务端只校验 UUID 格式，**不校验存在**（与参考实现一致） |

### 12.2 剩余开放项

1. **`persist: false` 的用途**：纯内存模式（服务端自己写、测试用）要不要正式暴露？现在是逃生口。
2. **离线队列**：网络断时是否把 issue 提交排队重试（会引入本地队列文件 + 幂等依赖）。
3. **`tw.files.upload` 的流式上限**：SDK 侧要不要在发送前就按 `--max-upload-mb` 拦（避免传完才 413）。