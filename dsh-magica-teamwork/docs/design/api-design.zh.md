# dsh-teamwork 接口设计（逐模块）

> 本文是 **47 个端点** 的正式契约。表结构见 [`db-design.zh.md`](./db-design.zh.md)，
> 服务端实现形态见 [`server-design.zh.md`](./server-design.zh.md)，客户端 SDK 见 [`sdk-design.zh.md`](./sdk-design.zh.md)。
>
> 状态：**47 个端点全部定稿**（A 6 / B 16 / C 16 / F 3 / M 6）。

---

## 0. 通用约定

### 0.1 基础

| 项 | 值 |
|---|---|
| 前缀 | `/dsh-teamwork/v1`（下文路径省略前缀） |
| 请求体 | `application/json; charset=utf-8`（`F1` 例外：`application/octet-stream`） |
| 响应体 | `application/json`（`F2` 例外：二进制流） |
| 字段命名 | 请求/响应一律 `camelCase`；DB 列 `snake_case` |
| 时间 | ISO-8601 UTC 毫秒：`2026-11-11T11:05:54.829Z` |
| 请求追踪 | 可带 `X-Request-Id`；响应回显（缺省服务端生成） |

### 0.2 鉴权头

需要鉴权的端点带两个头，缺一不可：

```
dsh-teamwork-token:   <auth_token>      # HS256 JWT，客户端用 accountToken 签
dsh-teamwork-account: <accountId>       # 必须与 JWT payload 的 a 一致
```

服务端**不信任** `dsh-teamwork-account` 单独存在：必须验证它等于 token 内的 `a`，
再用该账号的 `account_token` 验签（详见 server-design §4.2）。

**JWT 形态**：`header.payload.signature`，`HMAC-SHA256(key = account.account_token)`

```jsonc
// header
{ "alg": "HS256", "typ": "JWT" }
// payload ← 只放这三个字段，绝不放 account_token
{ "a": "alice", "iat": 1762861554829, "exp": 1763120754829 }
```

| 校验项 | 规则 |
|---|---|
| 签名 | `timingSafeEqual` 比较；**先按 `payload.a` 查账号**，再取 `account_token` 验签 |
| 账号一致 | 头部 `dsh-teamwork-account` === payload `a` |
| 未过期 | `exp > now` |
| **过期上限** | `exp <= now + 3d + 60s`（防客户端签一个 10 年 token） |
| 账号状态 | 必须 `status='active'`（每次校验都查，不信任 token 内容） |
| 角色 | **不信 token**，每次从 DB 取 `global_role` |

### 0.2.1 鉴权级别与覆盖（47 个）

| 级别 | 数量 | 端点 | 校验内容 |
|---|---|---|---|
| **公开** | **4** | A1 register、A2 login、M1 health、M2 version | 无 token；A1 额外受注册闸门约束 |
| **签名（JWT）** | **35** | A3–A5、B1–B16、C1–C14、F1–F2 | 双头 + 验签 + 账号 active |
| **签名 + administrator** | **7** | A6、C15、C16、**F3**、M4、M5、M6 | 上者 + `global_role='administrator'` |
| **本地 / administrator** | **1** | M3 shutdown | `X-Shutdown-Token`（锁文件）+ 回环来源，**或** administrator JWT |

> **为什么 M1/M2 公开**：`ensure` 与 launcher 要在**任何账号存在之前**判断服务是否就绪
> （首次部署库里没有账号，不可能带 token）。这两个端点**不返回业务数据**，只有版本、pid、
> db 路径、缓存计数这类运行状态。

> **为什么 M3 留本地通道**：Windows 下停服不能靠 `process.kill(-pid)`，只能调该端点；
> 而停服常发生在"管理员账号还没建"或"管理员密码忘了"的时刻。

**"签名"不等于"有权限"**：JWT 只证明"你是谁"，能做什么由三层决定：

```
第 1 层  路由声明 auth: 'public' | 'signed' | 'administrator' | 'local'
第 2 层  集中 guard：验签 + 账号 active + 取 global_role
第 3 层  业务层判定：项目内角色（owner/manager/member）、资源归属（我的设备/我的文件）
```

例：`B5 PUT /projects/{id}` 是"签名"级，但业务层还要判"必须是该项目 owner 或 administrator"——那是**协作语义**，不是认证。

### 0.3 密码字段的传输编码（**所有密码一律 base64**）

| 项 | 规则 |
|---|---|
| 涉及字段 | `password`（A1/A2）、`oldPassword` / `newPassword`（A5）、`newPassword`（M5） |
| 编码 | **标准 base64（UTF-8 字节）**，例如明文 `correct horse` → `Y29ycmVjdCBob3JzZQ==` |
| 宽松解码 | 同时接受 URL-safe（`-` `_`）与省略填充；解码后必须是**合法 UTF-8**，否则 `400 invalid_password_encoding` |
| 长度校验 | 针对**解码后的明文**：12..128 个字符；编码串长度 > 512 直接拒绝（防 DoS） |
| 哈希输入 | **解码后的明文**，即 `SHA256(utf8(accountId + ":" + 明文))` —— 编码只影响传输，不影响存储 |
| 日志 | 请求体中这三个字段**必须在日志里打码**（`"***"`），即使已 base64 |

> ⚠️ **base64 不是加密**。它只解决"密码在日志、抓包、错误上报里不直接可见"这一个弱目标；
> 真正的防线是 HTTPS/VPN + 服务端的哈希、限流与失败延迟。不要把 base64 当安全控制写进验收标准。

### 0.4 错误体

```jsonc
{
  "code": "invalid_password",           // 稳定标识，客户端按它分支
  "message": "密码长度必须是 12 到 128 个字符",  // 可直接展示给人
  "details": { "field": "password", "min": 12, "max": 128 },
  "requestId": "01J..."
}
```

- `code` 是**契约**（改动即破坏兼容）；`message` 可改。
- `details` 可选，只放字段级信息，不放堆栈。
- 业务校验失败一律 4xx + 上述结构；**5xx 不带 `details`**。

### 0.4.1 严格请求体（未声明字段一律 400）

所有端点的请求体 schema 都是 **strict**（TypeBox `additionalProperties: false`）：

| 情况 | 行为 |
|---|---|
| 出现 schema 里没声明的字段 | **400 `unknown_field`**，`details.field` 指出是哪个 |
| 传空对象 `{}` | 合法（若所有字段都可选） |
| 传 `null` 给可选字段 | 合法，表示"清空"（仅对可清空的列有效，见各端点说明） |

**为什么不用"静默忽略"**：静默忽略会让客户端以为写入生效了，实际没有，这类 bug 极难排查。
这是新 API，没有存量客户端要兼容，**fail-loud 更划算**。

**身份字段禁止出现在请求体**（它们只能由签名头决定）：

| 字段 | 出处 |
|---|---|
| `assigner` | C1、C4 |
| `author` | C9 |
| `createdBy` | B4 |
| `accountId` | B11、B15（设备/工作区归属） |

传了这些字段 → `400 unknown_field`。**唯一例外**是"指向他人"的字段（`assignee`、`project_member.accountId`、
`PUT /projects/{id}/owner` 的 `accountId`）—— 它们不是调用者身份，而是业务目标，需要业务校验。
### 0.5 分页 / 幂等

| 项 | 值 |
|---|---|
| 分页入参 | `pageNum`（默认 1，`<1` 归一 1）、`pageSize`（默认 20，`<1` 归一 20，上限 200） |
| 分页出参 | `{ total, pageNum, pageSize, items }` |
| 幂等键 | 由各业务字段承担（`issueId`、`commentId`、`code`…），**不引入 `Idempotency-Key` 头** |

---

## 1. 模块 A · 账号（6 个）

### 1.0 公共 DTO

**AccountVo**（唯一的账号出参，**永不含 `accountToken`**）

| 字段 | 类型 | 说明 |
|---|---|---|
| `accountId` | string | 账号；**区分大小写**；注册后不可改 |
| `displayName` | string \| null | 展示名 |
| `globalRole` | `administrator` \| `leader` \| `user` | 全局角色 |
| `status` | `active` \| `disabled` | |
| `lastLoginAt` | string \| null | 最后登录时间 |
| `createdAt` | string | |
| `updatedAt` | string | |

**AuthSessionVo**（注册/登录/改密成功时返回）

| 字段 | 类型 | 说明 |
|---|---|---|
| `account` | AccountVo | 账号信息 |
| `accountToken` | string | 64 字符小写 hex；**JWT 的 HMAC 签名密钥**，按密码级机密对待 |
| `ttlSeconds` | number | `259200`（3 天）；客户端签 `exp` **不得超过** `now + ttlSeconds + 60` |

> `accountToken` 只在 **A1 / A2 / A5** 三个响应里出现，其它任何接口、日志、错误体都不得包含。

---

### 1.1 A1 · `POST /auth/register`

| 项 | 内容 |
|---|---|
| 鉴权 | 公开 + **注册闸门**（见下） |
| 额外 Header | `X-Registration-Code: <code>`（仅 `--registration=code` 模式需要） |
| 请求体 | `{ accountId, password, displayName? }`（`password` 为 base64） |
| 成功 | **201** + `AuthSessionVo`（注册即登录） |

**请求字段**

| 字段 | 类型 | 必填 | 规则 |
|---|---|---|---|
| `accountId` | string | ✅ | `^[A-Za-z0-9@_-]{3,64}$`；**区分大小写**；**不含 `:`**（哈希分隔符约束） |
| `password` | string | ✅ | base64；解码后 12..128 字符；拒绝首尾空白；拒绝弱口令表；不做复杂度强制 |
| `displayName` | string | ❌ | ≤64；`trim` 后空串 → `null` |

**注册闸门**（服务端启动参数 `--registration`）

| 模式 | 行为 |
|---|---|
| `open` | 谁都能注册，落 `user` |
| `code` | 必须带正确的 `X-Registration-Code`，否则 `403 invalid_registration_code` |
| `closed` | 一律 `403 registration_closed`（只能由 administrator 通过 M5 之外的管理流程建号） |

**处理要点**

1. `BEGIN IMMEDIATE` 事务内：`INSERT … SELECT … CASE WHEN (SELECT COUNT(*)=0) THEN 'administrator' ELSE 'user' END`
   —— 首个账号自动成为 `administrator`（并发安全，见 db-design §3.1）
2. 写 `last_login_at = now`
3. 返回 `accountToken`（客户端保存到本地凭据文件）

**错误码**

| HTTP | code | 场景 |
|---|---|---|
| 400 | `invalid_request` | 缺字段 / 非 JSON |
| 400 | `invalid_account_id` | 格式不符（`details.reason` 指出哪一条） |
| 400 | `invalid_password_encoding` | 不是合法 base64 / 解码后非 UTF-8 |
| 400 | `invalid_password` | 长度不符 / 首尾空白 |
| 400 | `weak_password` | 命中内置弱口令表 |
| 403 | `registration_closed` | 闸门为 `closed` |
| 403 | `invalid_registration_code` | 闸门为 `code` 但码缺失/错误 |
| 409 | `account_exists` | 账号已存在 |
| 429 | `rate_limited` | 每 IP 10/min；每账号 5/min + 30/h |

**示例**

```http
POST /dsh-teamwork/v1/auth/register
X-Registration-Code: s3cr3t

{ "accountId": "alice", "password": "Y29ycmVjdCBob3JzZQ==", "displayName": "Alice" }
```

```jsonc
// 201
{
  "account": { "accountId": "alice", "displayName": "Alice", "globalRole": "administrator",
               "status": "active", "lastLoginAt": "2026-11-11T11:05:54.829Z",
               "createdAt": "2026-11-11T11:05:54.829Z", "updatedAt": "2026-11-11T11:05:54.829Z" },
  "accountToken": "6cc899893df1f9b606795947e338148459daee74b0771dce92138caa08f00c36",
  "ttlSeconds": 259200
}
```

---

### 1.2 A2 · `POST /auth/login`

| 项 | 内容 |
|---|---|
| 鉴权 | 公开 |
| 请求体 | `{ accountId, password }`（`password` 为 base64） |
| 成功 | 200 + `AuthSessionVo` |

**必须做对的 4 条**（写代码时逐条对照）

| # | 要求 | 做错的后果 |
|---|---|---|
| 1 | 按 `account_id` 取行，**绝不** `WHERE account_token = ?` | pass-the-hash：DB 泄露即可登录 |
| 2 | 账号不存在时也走 `DUMMY_HASH` 等量计算 + 同样 `sleep(300ms)` | 响应时间差 = 账号枚举 |
| 3 | `timingSafeEqual` 常量时间比较 | `===` 可测前缀匹配长度 |
| 4 | 失败统一 `401 invalid_credentials`，同 code / 同 message / 同延迟 | 区分"账号不存在"与"密码错" = 泄露账号存在 |

**错误码**

| HTTP | code | 场景 |
|---|---|---|
| 400 | `invalid_request` | 缺字段 |
| 400 | `invalid_password_encoding` | 密码不是合法 base64 |
| 401 | `invalid_credentials` | 账号不存在 **或** 密码错（不可区分） |
| 403 | `account_disabled` | `status='disabled'` |
| 429 | `rate_limited` | 同上限，带 `Retry-After` |

> `account_disabled` 会泄露"账号存在"，但禁用是运营行为，用户必须能知道原因 —— 这是**刻意的可接受泄露**，
> 与"密码错 vs 不存在"的不可区分性并不冲突。

**副作用**：`last_login_at = now`；**写失败不影响登录成功**（`try/catch` + 日志）。

---

### 1.3 A3 · `GET /auth/me`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| 成功 | 200 + `AccountVo` |

**错误码**

| HTTP | code | 场景 |
|---|---|---|
| 401 | `unauthorized` | 缺头 / 头格式错 / 验签失败 |
| 401 | `token_expired` | `exp <= now` |
| 401 | `token_account_mismatch` | 头部账号 ≠ token 内 `a` |
| 401 | `token_exp_too_long` | `exp > now + 3d + 60s` |
| 403 | `account_disabled` | 账号已禁用（**校验时必须查 status**） |

> 不返回 token 过期时间：`exp` 是客户端自己签的，它本来就知道。

---

### 1.4 A4 · `POST /auth/logout`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| 请求体 | `{ allDevices?: boolean }`（可省略） |
| 成功 | **204** 无 body |

**语义**

| 项 | 行为 |
|---|---|
| 服务端动作 | **只**把该 token 从鉴权缓存（server-design §4.6）里删掉；无会话可清 |
| 客户端动作 | 删除本地保存的 `auth_token` |
| `allDevices: true` | 返回 `400 not_supported` —— 没有会话表，无法按设备踢人；要全踢只能改密码（A5，签名密钥随之改变） |
| 幂等 | 同一个 token 调多次都返回 204 |

**错误码**：`401 unauthorized`（token 本身无效）/ `400 not_supported`（传了 `allDevices: true`）

---

### 1.5 A5 · `PUT /auth/password`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| 请求体 | `{ oldPassword, newPassword }`（均为 base64） |
| 成功 | 200 + `{ accountToken, ttlSeconds }` |

**规则**

| 项 | 内容 |
|---|---|
| 校验旧密码 | 与 A2 同：`timingSafeEqual` + 失败 `sleep(300ms)` + 统一 `401 invalid_credentials` |
| 更新 | `account_token = SHA256(utf8(accountId + ":" + 新密码明文))` |
| 连带效果 | **该账号所有旧 `auth_token` 立即失效**（签名密钥变了）；鉴权缓存全清 |
| 新密码 | 同 A1 规则；**不得与旧密码相同** → `400 same_password` |

**为什么返回新 `accountToken` 而不是 204**：签名密钥已变，客户端手里的旧密钥必然失效。
返回 204 会逼客户端立刻再调 A2（多一次往返 + 一次密码校验）；直接给新密钥一次搞定，
安全性不降低（旧密码已经验过，且响应只发给本人）。

**错误码**

| HTTP | code | 场景 |
|---|---|---|
| 400 | `invalid_password_encoding` | 任一密码不是合法 base64 |
| 400 | `invalid_password` | 新密码长度不符 |
| 400 | `weak_password` | 新密码命中弱口令表 |
| 400 | `same_password` | 新旧相同 |
| 401 | `unauthorized` | token 无效 |
| 401 | `invalid_credentials` | 旧密码错（含 300ms 延迟） |
| 429 | `rate_limited` | 同 A2 |

---

### 1.6 A6 · `GET /auth/accounts?accountId=`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 + **administrator** |
| Query | `accountId`（必填；精确匹配；**区分大小写**） |
| 成功 | 200 + `{ exists: boolean, account: AccountVo \| null }` |

**为什么用 `{exists, account}` 而不是 404**

这个接口的唯一用途是"加项目成员前确认这个人有没有账号"。用 404 表达"没有"会让调用方
把**正常情况**当异常处理，还得自己吞掉错误。用 `exists:false` 语义更直白。

**错误码**

| HTTP | code | 场景 |
|---|---|---|
| 400 | `invalid_request` | 缺 `accountId` |
| 401 | `unauthorized` | token 无效 |
| 403 | `forbidden` | 非 `administrator` |
| 429 | `rate_limited` | — |

**示例**

```jsonc
// 200 命中
{ "exists": true, "account": { "accountId": "alice", "displayName": "Alice",
    "globalRole": "leader", "status": "active",
    "lastLoginAt": "2026-11-11T11:05:54.829Z",
    "createdAt": "2026-11-01T02:00:00.000Z", "updatedAt": "2026-11-11T11:05:54.829Z" } }

// 200 未命中
{ "exists": false, "account": null }
```

---

## 2. A 组错误码汇总

| code | HTTP | 出处 |
|---|---|---|
| `invalid_request` | 400 | A1/A2/A6 |
| `unknown_field` | 400 | 所有带请求体的端点（§0.4.1） |
| `invalid_account_id` | 400 | A1 |
| `invalid_password` | 400 | A1/A5 |
| `invalid_password_encoding` | 400 | A1/A2/A5 |
| `weak_password` | 400 | A1/A5 |
| `same_password` | 400 | A5 |
| `not_supported` | 400 | A4 |
| `invalid_credentials` | 401 | A2/A5 |
| `unauthorized` | 401 | A3/A4/A5/A6 |
| `token_expired` | 401 | A3（及所有签名端点） |
| `token_account_mismatch` | 401 | A3（及所有签名端点） |
| `token_exp_too_long` | 401 | A3（及所有签名端点） |
| `forbidden` | 403 | A6（及所有需角色的端点） |
| `registration_closed` | 403 | A1 |
| `invalid_registration_code` | 403 | A1 |
| `account_disabled` | 403 | A2/A3 |
| `account_exists` | 409 | A1 |
| `rate_limited` | 429 | A1/A2/A5/A6 |

---

## 3. 模块 B · 项目 / 成员 / 设备 / 工作区（16 个）

### 3.0 公共 DTO

**ProjectVo**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | 项目主键 |
| `name` | string | 全局唯一，1..100 |
| `owner` | string \| null | **派生字段**：成员表里 `joined_at` 最早的 `owner`；无则 `null` |
| `createdBy` | string \| null | 创建人（审计用，**不参与任何权限判定**） |
| `status` | `active` \| `archived` | `archived` = 只读 |
| `visibility` | `public` \| `private` | `private` 成员上限 5 |
| `description` | string \| null | |
| `memberCount` | number | 成员数（子查询） |
| `createdAt` / `updatedAt` | string | |

**ProjectDetailVo** = `ProjectVo` + `members: ProjectMemberVo[]`

**ProjectMemberVo**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | 成员行主键 |
| `projectId` | number | |
| `accountId` | string | 成员账号 |
| `displayName` | string \| null | **JOIN `account` 得来**（`COALESCE(a.display_name, a.account_id)`），成员表不存 |
| `role` | `owner` \| `manager` \| `member` | |
| `joinedAt` | string | **首次**加入时间（移除后重新加入不刷新） |
| `updatedAt` | string | |

**DeviceVo**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | |
| `accountId` | string | 归属账号 |
| `host` | string | hostname 或 IP |
| `port` | number | 未上报时为 `0` |
| `os` | string \| null | |
| `status` | `active` \| `inactive` | |
| `lastActiveAt` | string | |
| `createdAt` / `updatedAt` | string | |

> 已删除 `dshPatcherVersion`（旧 10 字段 → 9）。

**WorkspaceVo**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | |
| `accountId` | string | |
| `instance` | string | `ip:port`（= `device.host:port`） |
| `workspaceId` | string \| null | `type=index` 时必为 `null` |
| `cwd` | string \| null | `type=index` 时必为 `null` |
| `type` | `index` \| `portal` | |
| `detail` | string | md 文本（不限长度） |
| `createdAt` / `updatedAt` | string | |

---

### 3.1 B1 · `GET /projects`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| Query | `pageNum` / `pageSize` / `keyword?` / `includeArchived?`（默认 `false`） |
| 成功 | 200 + `{ total, pageNum, pageSize, items: ProjectVo[] }` |

**可见性规则**

| 调用者 | 能看到 |
|---|---|
| `administrator` | **全部项目** |
| 其他人 | **只有自己是成员的项目**（按成员表过滤） |

| 参数 | 说明 |
|---|---|
| `keyword` | 按 `name` 模糊匹配（`LIKE '%x%'`）；表小，全扫可接受 |
| `includeArchived` | `false` 时排除 `status='archived'` |

排序固定 `updated_at DESC`。

**错误码**：`400 invalid_request`（分页参数非法时归一化而非报错，此码只用于类型错）/ `401 unauthorized`

---

### 3.2 B2 · `GET /projects/mine`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| Query | `includeArchived?`（默认 `false`） |
| 成功 | 200 + `ProjectVo[]`（**不分页**，`updated_at DESC`） |

与 B1 的区别：**不分页**，用于侧边栏/下拉框这类"要全量"的场景。

> `administrator` 调这个接口**也只返回自己参与的项目**（不是全部）——语义是"我的"，不是"所有"。

---

### 3.3 B3 · `GET /projects/{id}`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| 成功 | 200 + `ProjectDetailVo` |

**可见性**：`administrator` 或该项目成员；否则 **404 `project_not_found`**（不返回 403——避免用状态码探测项目是否存在）。

**错误码**：`404 project_not_found` / `401 unauthorized`

---

### 3.4 B4 · `POST /projects`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| 请求体 | `{ name, visibility?, description? }` |
| 成功 | **201** + `ProjectDetailVo` |

**请求字段**

| 字段 | 必填 | 规则 |
|---|---|---|
| `name` | ✅ | `trim` 后 1..100；**全局唯一** |
| `visibility` | ❌ | 默认 `public`；只接受 `public` / `private` |
| `description` | ❌ | ≤2000 |

**创建规则（关键）**

| 规则 | 说明 |
|---|---|
| `public` 项目 | **创建人必须是 `administrator` 或 `leader`**（因为创建人将成为 owner），否则 `403 public_project_requires_leader` |
| `private` 项目 | **任何登录用户都能建**（成员上限 5） |
| owner | **创建人自动成为唯一 owner**（先写项目行，再写成员行 `role='owner'`，同一事务） |
| `created_by` | 服务端填当前账号；**请求体里出现 → `400 unknown_field`** |

**错误码**

| HTTP | code | 场景 |
|---|---|---|
| 400 | `invalid_project_name` | 空 / 超 100 |
| 400 | `invalid_visibility` | 非 `public`/`private` |
| 403 | `public_project_requires_leader` | 非 leader/administrator 建 public |
| 409 | `project_name_exists` | 名称重复 |
| 401 | `unauthorized` | |

---

### 3.5 B5 · `PUT /projects/{id}`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 + **项目 `owner` 或 `administrator`** |
| 请求体 | `{ name?, description?, visibility?, status? }`（部分更新，未传的字段不动） |
| 成功 | 200 + `ProjectDetailVo` |

**逐字段规则**

| 字段 | 规则 | 失败码 |
|---|---|---|
| `name` | `trim` 1..100，全局唯一 | `400 invalid_project_name` / `409 project_name_exists` |
| `description` | ≤2000 | `400 invalid_description` |
| `visibility` → `private` | **当前成员数必须 ≤5** | `409 cannot_shrink_to_private`，`details:{current,limit}` |
| `visibility` → `public` | **当前 owner 必须是 `leader`/`administrator`** | `409 cannot_publish` |
| `status` → `archived` | owner/administrator 可归档 | — |
| `status` → `active` | 同上（可还原） | — |

**归档项目只读**：若项目当前 `status='archived'`，**只有 `status` 字段允许改**（即还原），
请求里带其它字段 → `409 project_archived`。

**错误码**：`403 forbidden`（非 owner/administrator）/ `404 project_not_found` /
`409 cannot_shrink_to_private` / `409 cannot_publish` / `409 project_archived`

---

### 3.6 B6 · `DELETE /projects/{id}`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 + **项目 `owner` 或 `administrator`** |
| 成功 | **204**（硬删除；成员行由外键 `CASCADE` 清掉） |

**前置检查（顺序不能错）**

1. 项目存在 → 否则 `404 project_not_found`
2. 权限（owner / administrator）→ 否则 `403 forbidden`
3. **该项目下 `issue` 数量为 0** → 否则 `409 project_has_issues`，`details:{count}`

> 第 3 条是为了**杜绝悬空引用**：`issue.project_id` 是弱引用（全库只有一个外键），
> 直接删项目会让 issue 指向不存在的项目。要么先把 issue 迁走/删掉，要么改成归档（B5）。

**错误码**：`403 forbidden` / `404 project_not_found` / `409 project_has_issues`

---

### 3.7 B7 · `GET /projects/{id}/members`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| 成功 | 200 + `ProjectMemberVo[]`（`joined_at ASC`，不分页） |

**可见性**：与 B3 相同（administrator 或成员），否则 `404 project_not_found`。

> 名字来自 `account.display_name` 的 JOIN；账号被禁用也照常返回（成员关系还在）。

---

### 3.8 B8 · `POST /projects/{id}/members`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 + 项目 `owner` / `manager` / `administrator` |
| 请求体 | `{ accountId, role? }` |
| 成功 | 200 + `ProjectMemberVo`（**upsert**：已是成员则更新角色） |

**角色授予矩阵**（越权一律 `403 forbidden`）

| 操作者 | 可授予 |
|---|---|
| `administrator` | `manager` / `member` |
| 项目 `owner` | `manager` / `member` |
| 项目 `manager` | **仅 `member`** |
| 项目 `member` | — |

**规则表**

| # | 规则 | 失败码 |
|---|---|---|
| 1 | `role` 只接受 `manager`/`member`；传 `owner` → 拒绝 | `400 owner_role_not_assignable` |
| 2 | 目标已是 owner → 不能通过本接口改其角色（必须走 B10） | `409 owner_role_immutable` |
| 3 | 目标账号必须存在 | `404 account_not_found` |
| 4 | 项目归档中 | `409 project_archived` |
| 5 | `visibility='private'` 且当前成员数 = 5 → 拒绝**新增**（更新已有成员角色不占名额） | `409 project_member_limit`，`details:{limit:5,current:5}` |
| 6 | `joined_at` 不覆盖（重新加入保留首次时间） | — |

> 第 5 条是**跨行约束**，服务端在 `BEGIN IMMEDIATE` 里先 `COUNT(*)` 再写，
> 否则并发加人能突破 5 人（见 db-design §3.4.1）。

**错误码**：`400 owner_role_not_assignable` / `400 invalid_role` / `403 forbidden` /
`404 project_not_found` / `404 account_not_found` / `409 owner_role_immutable` /
`409 project_archived` / `409 project_member_limit`

---

### 3.9 B9 · `DELETE /projects/{id}/members/{accountId}`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 + 项目 `owner` / `manager` / `administrator` |
| 成功 | **204** |

**规则**

| # | 规则 | 失败码 |
|---|---|---|
| 1 | **不能移除 `owner`**（必须先 B10 转让） | `409 owner_cannot_be_removed` |
| 2 | 项目内 `manager` 只能移除 `member` | `403 forbidden` |
| 3 | 目标不是成员 | `404 member_not_found` |
| 4 | 自己移除自己：`member`/`manager` 可以；`owner` 不行（同第 1 条） | — |
| 5 | 项目归档中 | `409 project_archived` |

**错误码**：`403 forbidden` / `404 project_not_found` / `404 member_not_found` /
`409 owner_cannot_be_removed` / `409 project_archived`

---

### 3.10 B10 · `PUT /projects/{id}/owner`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 + **全局 `administrator` 或该项目当前 `owner`** |
| 请求体 | `{ accountId }` |
| 成功 | 200 + `ProjectDetailVo` |

**规则**

| # | 规则 | 失败码 |
|---|---|---|
| 1 | 调用者不是 administrator 也不是当前 owner | `403 owner_transfer_forbidden` |
| 2 | 目标账号不存在 | `404 account_not_found` |
| 3 | **`public` 项目要求目标是 `leader`/`administrator`**（`private` 不限） | `409 owner_must_be_leader` |
| 4 | 目标已是当前 owner | 200 幂等（无写入） |
| 5 | 目标还不是成员 | 自动加入（`role` 直接为 `owner`） |
| 6 | 原 owner | 降为 `manager`（**不是 `member`**，避免转让时丢失管理能力） |

**事务顺序（错了会撞唯一索引）**

```sql
BEGIN IMMEDIATE;
  -- ① 先降旧 owner，否则新 owner 插入时两个 owner 同时存在 → uk_tw_member_owner 冲突
  UPDATE project_member SET role='manager' WHERE project_id=? AND role='owner' AND account_id<>?;
  -- ② 再升新 owner（upsert）
  INSERT INTO project_member(project_id, account_id, role) VALUES(?,?,'owner')
    ON CONFLICT(project_id, account_id) DO UPDATE SET role='owner';
COMMIT;
```

**错误码**：`403 owner_transfer_forbidden` / `404 project_not_found` / `404 account_not_found` /
`409 owner_must_be_leader` / `409 project_archived`

---

### 3.11 B11 · `POST /devices/batch`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| 请求体 | `{ devices: [{ host, port?, os? }] }`（≤200 条） |
| 成功 | 200 + `{ synced: number, deactivated: number }` |

**全量同步语义**（关键：这是"覆盖式"而不是"追加式"）

```sql
BEGIN IMMEDIATE;
  -- ① 我名下所有设备先全标 inactive
  UPDATE device SET status='inactive' WHERE account_id=? AND status='active';
  -- ② 再 upsert 本批为 active（(account_id, host, port) 唯一）
  INSERT INTO device(account_id, host, port, os, status, last_active_at) VALUES(?,?,?,?,'active',now)
    ON CONFLICT(account_id, host, port) DO UPDATE SET
      os=COALESCE(excluded.os, os), status='active', last_active_at=now;
COMMIT;
```

| 规则 | 说明 |
|---|---|
| `accountId` | 来自 token；**请求体里出现 → `400 unknown_field`** |
| `port` 缺省 | 落 `0` |
| `os` 缺省 | 保留原值（`COALESCE`） |
| 设备不在本批 | 变 `inactive`（**不会被删除**，删除走 B14） |
| 空数组 | 合法：等于"我这台机器下线了"，全部置 `inactive` |

**错误码**：`400 invalid_request`（超过 200 条 / `host` 空）/ `401 unauthorized`

---

### 3.12 B12 · `GET /devices?accountId=`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| Query | `accountId?`（省略 = 查自己；**任何登录用户可查任意账号**） |
| 成功 | 200 + `DeviceVo[]`（**只含 `active`**，`last_active_at DESC`，不分页） |

**用途**：派发任务前找目标实例。与 B13 的区别是**只给在线设备**。

**错误码**：`400 invalid_request`（accountId 非法）/ `401 unauthorized`

---

### 3.13 B13 · `GET /devices/mine`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| Query | `pageNum` / `pageSize` |
| 成功 | 200 + `{ total, pageNum, pageSize, items: DeviceVo[] }` |

**含 `inactive`**（管理页面要看历史设备），按 `last_active_at DESC`。

> B12 与 B13 的这个差别是**刻意的**，别合并。

---

### 3.14 B14 · `DELETE /devices/{id}`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| 成功 | **204** |

**规则**：**任何登录用户可删任意设备**（服务端不做资源级鉴权）；不存在 → `404 device_not_found`。

**错误码**：`404 device_not_found`

---

### 3.15 B15 · `POST /device-workspaces`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| 请求体 | `{ instance, workspaceId?, cwd?, type, detail }` |
| 成功 | 200 + `WorkspaceVo` |

**两种形状（由 `type` 决定，写错 → `400 invalid_workspace_shape`）**

| `type` | 必填 | 必须为空 |
|---|---|---|
| `index` | `instance` / `detail` | `workspaceId` / `cwd` |
| `portal` | `instance` / `workspaceId` / `cwd` / `detail` | — |

| 规则 | 说明 |
|---|---|
| `accountId` | 来自 token；**请求体里出现 → `400 unknown_field`** |
| `detail` | md 文本，**不限长度**（整体覆盖式写入） |
| 幂等 | 同 `(accountId, instance)` 的 `index` 只刷新 `detail`；同 `(accountId, instance, workspaceId)` 的 `portal` 刷新 `cwd`+`detail` |
| 覆盖式 | 每次上报整体替换 `detail`，不做增量合并 |

**错误码**：`400 invalid_workspace_shape` / `400 invalid_type` / `401 unauthorized`

---

### 3.16 B16 · `GET /device-workspaces`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| Query | `accountId?` / `instance?` / `type?` / `workspaceId?` / `cwd?` / `cwdPrefix?` |
| 成功 | 200 + `WorkspaceVo[]`（不分页，`updated_at DESC`） |

**匹配方式（刻意不用 `LIKE '%x%'`）**

| 参数 | 匹配 |
|---|---|
| `accountId` | 精确（省略 = 自己；**查他人允许**，见下） |
| `instance` / `type` / `workspaceId` | 精确 |
| `cwd` | **精确**（走 `idx_tw_ws_cwd`） |
| `cwdPrefix` | **前缀**（`cwd >= ? AND cwd < ?` + `\uffff`，走索引） |

> **为什么不提供包含匹配**：`cwd LIKE '%proj-7%'` 会同时命中 `proj-7`、`proj-70`、`old-proj-7`，
> 跨实例派发时**会派错目标**。调用方本来就知道完整路径（issue 的 `cwd` 字段），精确/前缀足够。

**跨账号可见性（刻意的例外）**：任何登录用户都能按 `cwd` 查**别人**的工作区肖像。
跨实例派发必须这样做（否则派发方无法知道目标机器上有没有这个项目）。

**错误码**：`400 invalid_request`（`cwd` 与 `cwdPrefix` 同时传）/ `401 unauthorized`

---

## 4. B 组错误码汇总

| code | HTTP | 出处 |
|---|---|---|
| `invalid_request` | 400 | B1/B10/B11/B16 |
| `unknown_field` | 400 | 所有带请求体的端点（§0.4.1） |
| `invalid_project_name` | 400 | B4/B5 |
| `invalid_description` | 400 | B5 |
| `invalid_visibility` | 400 | B4 |
| `invalid_role` | 400 | B8 |
| `owner_role_not_assignable` | 400 | B8 |
| `invalid_workspace_shape` | 400 | B15 |
| `invalid_type` | 400 | B15 |
| `unauthorized` | 401 | 全部 |
| `forbidden` | 403 | B5/B6/B8/B9（项目内角色不足） |
| `public_project_requires_leader` | 403 | B4 |
| `owner_transfer_forbidden` | 403 | B10 |
| `project_not_found` | 404 | B3/B5/B6/B7/B8/B9/B10 |
| `account_not_found` | 404 | B8/B10 |
| `member_not_found` | 404 | B9 |
| `device_not_found` | 404 | B14 |
| `project_name_exists` | 409 | B4/B5 |
| `project_member_limit` | 409 | B8 |
| `cannot_shrink_to_private` | 409 | B5 |
| `cannot_publish` | 409 | B5 |
| `project_archived` | 409 | B5/B8/B9/B10 |
| `project_has_issues` | 409 | B6 |
| `owner_cannot_be_removed` | 409 | B9 |
| `owner_role_immutable` | 409 | B8 |
| `owner_must_be_leader` | 409 | B10 |

---

## 5. 模块 C · Issue（16 个）

### 5.0 公共 DTO 与枚举

**IssueVo（22 字段）**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | 库内主键（跨实例不可移植） |
| `issueId` | string | 业务唯一键 / 幂等键，1..100 |
| `projectId` | number \| null | 归属项目（`null` = 临时 issue） |
| `title` | string | 标题，1..200 |
| `detail` | string \| null | 正文 |
| `assigner` | string | 下发人（= 创建者） |
| `assignerTask` | string \| null | 上游标识（建议存上游会话 id） |
| `assignerMeta` | string \| null | 扩展 JSON |
| `cwd` | string \| null | 项目路径，≤500 |
| `urgency` | string | 5 值，默认 `normal` |
| `permission` | string \| null | 3 值，可空 |
| `assignee` | string | 责任人 |
| `assigneeTask` | string \| null | 下游标识（建议存执行会话 id） |
| `assigneeInstance` | string \| null | 执行实例 `ip:port` |
| `assigneeMeta` | string \| null | 输出 JSON |
| `status` | string | 7 值 |
| `source` | string | 来源 code，默认 `self` |
| `sourceInstance` | string \| null | 来源实例 |
| `dependsOn` | string \| null | 依赖 JSON（服务端不解析） |
| `createdAt` / `assignedAt` / `updatedAt` | string | |

**CommentVo（10 字段）**：`id` / `commentId` / `issueId` / `author` / `content` / `commentRole` / `commentAuthorType` / `commentAt` / `createdAt` / `updatedAt`

**AttachmentVo（8 字段）**：`id` / `issueId` / `fileId` / `fileName` / `type` / `description` / `createdAt` / `updatedAt`

**SourceVo（6 字段）**：`id` / `code` / `description` / `pluginName` / `createdAt` / `updatedAt`

**status 7 值**

| 值 | 语义 | 终态 |
|---|---|---|
| `pending` | 已上报未认领（默认） | 否 |
| `accepted` | 已认领（写 `assigneeInstance`） | 否 |
| `routing` | 进入规划 | 否 |
| `running` | 执行中 | 否 |
| `success` | 成功 | 是 |
| `failed` | 失败 | 否 |
| `abandoned` | 遗弃 | 是 |

```
pending ──► accepted ──► routing ──► running ──► success / failed
任意状态 ──► abandoned
```

> ⚠️ **上图只是约定，服务端不校验它。** 状态转移是否合法、哪一方能推哪个状态，
> **全部由使用侧（DSH 侧）判定**；服务端只做三件事：枚举校验（7 值）、`expectedStatus` 条件更新（并发仲裁）、落库。

**urgency 5 值**：`runtime`（直取）/ `direct`（直通）/ `urgent` / `normal`（默认）/ `relaxed`
**permission 3 值**：`read-only` / `workspace-write` / `danger-full-access`（可空）

> **两处刻意的统一**：① `urgency`/`permission` **所有写入路径都校验**（早期实现只在全字段覆盖时校验，导致批量路径能写进非法枚举）；② `assigner` **不可由请求体指定**（身份只来自 token）。
**写权限策略（服务端到底管不管）**

| 接口 | 服务端是否校验"谁能写" |
|---|---|
| **全部 16 个 C 端点** | ❌ **都不管** —— 任何登录用户都能读写任何 issue（越权、状态机、可见性全部由 SDK 侧保证） |

> **服务端只做三件事**：① 认证（签名头）② 枚举/格式校验 ③ 落库。
> "谁该看到、谁该改"全部由 SDK/DSH 侧负责 —— 这是本项目刻意的分工。
> 依据见 `server-design` §9.0「信任模型」：**默认部署 = 本机单用户**（SDK 不配置 host 就只连 localhost），
> 资源级鉴权只在显式跨机共享时才成为需求，而那部分由 SDK 承担。

### 5.1 C1 · `POST /issues/batch`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| 请求体 | **JSON 数组**，元素见下（≤100 条） |
| 成功 | 200 + `string[]`（`issueId`，**顺序与请求一致**） |

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `issueId` | ❌ | 服务端生成 UUID | 幂等键；**重试必须保持不变** |
| `title` | ✅ | — | 1..200 |
| `detail` | ❌ | — | 正文 |
| `assignee` | ✅ | — | 责任人账号（**必须存在**） |
| `projectId` | ❌ | — | 归属项目（校验存在 / 成员 / 未归档） |
| `cwd` | ❌ | — | ≤500 |
| `urgency` | ❌ | `normal` | 5 值，**本路径也校验** |
| `permission` | ❌ | — | 3 值，校验 |
| `source` | ❌ | `self` | 开放取值 |
| `sourceInstance` | ❌ | — | |
| `assignerTask` | ❌ | — | |
| `assignerMeta` | ❌ | — | 扩展 JSON |
| `dependsOn` | ❌ | — | 原样存取 |
| `status` | ❌ | `pending` | **仅创建时生效**；7 值校验 |

**upsert 语义（关键）**

| 列 | 已存在时的行为 |
|---|---|
| `assigner` / `assignerTask` / `assignerMeta` / `cwd` / `urgency` / `permission` / `assignee` / `source` / `sourceInstance` / `dependsOn` | **发布方字段，整体覆盖** |
| `title` / `detail` / `projectId` | **整体覆盖**（新列，同发布方语义） |
| `status` / `assigneeInstance` / `assigneeMeta` | **整体覆盖**（不再做 `status='pending'` 守卫） |
| `assigneeTask` / `assignedAt` | 透传：传了就写，不传不动 |

> **不再有"pending 守卫"**：服务端不判断状态、不假设重放语义 —— 要不要在重发时保留执行方进度，
> **由 SDK 决定**（它可以先 GET 再决定发什么）。这是"服务端只管落库"的必然结果。

**批量语义**：**整批原子**——`BEGIN IMMEDIATE` 包住，任一条校验失败整批回滚并返回 400
（不是"部分成功"，与 C6 刻意不同）。

**错误码**

| HTTP | code | 场景 |
|---|---|---|
| 400 | `invalid_request` | 非数组 / 超 100 条 / 缺 `title` 或 `assignee` |
| 400 | `unknown_field` | 请求体出现 `assigner` 等身份字段或未声明字段 |
| 400 | `invalid_title` | 空 / 超 200 |
| 400 | `invalid_status` / `invalid_urgency` / `invalid_permission` | 枚举不符（`details.field`） |
| 403 | `not_project_member` | 传了 `projectId` 但不是成员 |
| 404 | `account_not_found` | `assignee` 不存在 |
| 404 | `project_not_found` | `projectId` 不存在 |
| 409 | `project_archived` | 项目已归档 |

---

### 5.2 C2 · `GET /issues`

| 参数 | 位置 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `pageNum` / `pageSize` | query | ❌ | 1 / 20 | |
| `status` | query | ❌ | — | 精确 |
| `source` | query | ❌ | — | 精确 |
| `projectId` | query | ❌ | — | 走复合索引 |
| `keyword` | query | ❌ | — | 按 `title` 模糊 |

**出参**：`{ total, pageNum, pageSize, items: IssueVo[] }`，`created_at DESC`

**可见性**：**不做过滤**（任何登录用户可查全部 issue；`administrator` 与普通用户无差别）。

**错误**：`400 invalid_status`（`status` 传了非法值）/ `401 unauthorized`

---

### 5.3 C3 · `GET /issues/{issueId}`

| 参数 | 位置 | 必填 |
|---|---|---|
| `issueId` | path | ✅ |

**出参**：200 + `IssueVo`

**可见性**：**任何登录用户**（服务端不做资源级鉴权；`issueId` 不存在 → 404）。

---

### 5.4 C4 · `PUT /issues/{issueId}` — 全字段覆盖

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `issueId` | path | ✅ | 请求体里出现 `issueId` → `400 unknown_field` |
| 其余 20 个业务字段 | body | ❌ | 见下 |

**写入行为（逐字段）**

| 字段 | 行为 |
|---|---|
| `assigner` / `assignee` / `status` / `urgency` / `source`（NOT NULL 列） | `COALESCE` → **不传保留原值** |
| `title` / `detail` / `projectId` / `assignerTask` / `assignerMeta` / `cwd` / `permission` / `assigneeTask` / `assigneeInstance` / `assigneeMeta` / `sourceInstance` / `dependsOn` | 直接赋值 → **传 `null` 即清空** |
| `assignedAt` | **透传**：传了就写，不传保持原值（不再与 `status` 挂钩，时机由 SDK 决定） |
| `assigner` | **不可写**：请求体里出现 → `400 unknown_field`（身份来自 token） |
| `id` / `issueId` / `createdAt` / `updatedAt` | 不可写 |

**出参**：200 + `IssueVo`

**权限**：**任何登录用户**（服务端不做资源级鉴权）；`issueId` 不存在 → 404

**错误**：`400 invalid_status` / `400 invalid_urgency` / `400 invalid_permission` / `400 invalid_title` / `403 not_project_member` / `404 issue_not_found`

---

### 5.5 C5 · `DELETE /issues/{issueId}` — 遗弃

| 参数 | 位置 | 必填 |
|---|---|---|
| `issueId` | path | ✅ |

**出参**：**204**（无 body）

**语义**：软删除 —— 把 `status` 置 `abandoned`（**不删行**）。

| 规则 | 说明 |
|---|---|
| 权限 | **任何登录用户**（服务端不校验是否为该 issue 的参与者） |
| 幂等 | 已经是 `abandoned` → 仍返回 204（**不做终态校验**，由使用侧判定） |

**错误**：`404 issue_not_found`（服务端不做写权限判定）

---

### 5.6 C6 · `POST /issues/status/batch` — 状态更新 / 认领

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| 请求体 | JSON 数组（≤200 条） |
| 成功 | **200** + `{ success: number, failed: [{ issueId, reason }] }` |

| 字段 | 必填 | 说明 |
|---|---|---|
| `issueId` | ✅ | |
| `status` | ✅ | 目标状态（7 值） |
| `expectedStatus` | ❌ | 条件更新前置（**认领竞态仲裁靠它**） |
| `assigneeTask` | ❌ | 非空才更新 |
| `assigneeInstance` | ❌ | 非空才更新 |
| `assigneeMeta` | ❌ | 非空才更新 |
| `assignedAt` | ❌ | **透传**：传了就写，不传不动（时机由 SDK 决定） |

**批量语义**：**部分成功**——单条失败只进 `failed[]`，HTTP 仍 200（与 C1 刻意相反）。

**`reason` 码**

| reason | 含义 |
|---|---|
| `issue_id_required` | `issueId` 为空 |
| `invalid_status` | `status` 非法 |
| `invalid_expected_status` | `expectedStatus` 非法 |
| `not_found` | issue 不存在 |
| `status_conflict` | 当前状态 ≠ `expectedStatus`（**认领失败，不要重试**） |
| `update_conflict` | 其它未命中 |

**认领竞态仲裁**：`UPDATE … WHERE issue_id=? AND status=?` 原子生效，
多实例并发只有一个 `changes=1`，其余得 `status_conflict`。

**服务端不校验状态转移，也不校验"谁能写"**：任何登录用户都可以把 `status` 改成 7 值中的任意一个
（只要求 `issueId` 存在）。**转移合法性、哪一方能推哪个状态、是否允许这个人操作，全部由使用侧判定**。
服务端只保证：枚举合法、`expectedStatus` 条件更新原子、落库。

**错误**：只可能是 `400 invalid_request`（非数组/超条数）与 `401 unauthorized`；**业务失败一律进 `failed[]`**

---

### 5.7 C7 · `GET /issues/comments` — 增量评论

| 参数 | 位置 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `sinceId` | query | ❌ | `0` | 自增 id 游标（`<0` 归一 0） |
| `limit` | query | ❌ | 500 | 上限 2000 |

**出参**：`{ items: CommentVo[], nextSinceId: number, hasMore: boolean }`

| 规则 | 说明 |
|---|---|
| 游标 | **必须用自增 `id`**（`comment_at` 可回填、`created_at` 精度低，用它们会漏消息） |
| 推进 | 本批为空时 `nextSinceId` 原样回传入参 |
| `hasMore` | `items.length >= limit`（恰好取满也为 `true`，下一拍可能返回空批） |
| **可见性** | **不过滤** —— 返回全表增量（服务端不做资源级鉴权） |

> **服务端不做可见性过滤**：任何登录用户都能拉到全表增量。
> 谁能看到哪些评论由 SDK/DSH 侧自己筛 —— 与本项目"服务端只管认证 + 校验 + 落库"的分工一致。
> ⚠️ 代价：这是**跨账号可读**的接口。如果以后要收紧，用下面第二个 SQL（带参与者过滤）。

**实现（默认：全表增量，无过滤）**

```sql
-- comment.mapper.ts :: listSinceId
SELECT * FROM dsh_teamwork_issue_comment
 WHERE id > ?
 ORDER BY id ASC
 LIMIT ?;
```

实测：5 万评论冷启动 **431 µs**，稳态几十 µs（主键范围扫，无排序、无 bloom）。

**若以后要按参与者过滤，用这条（实测数据见下）**

```sql
-- comment.mapper.ts :: listSinceIdVisible
-- 参数：(sinceId, accountId, accountId, limit)
SELECT c.id, c.comment_id, c.issue_id, c.author, c.content,
       c.comment_role, c.comment_author_type, c.comment_at,
       c.created_at, c.updated_at
  FROM dsh_teamwork_issue_comment c
  JOIN dsh_teamwork_issue i ON i.issue_id = c.issue_id
 WHERE c.id > ?
   AND (i.assigner = ? OR i.assignee = ?)
 ORDER BY c.id ASC
 LIMIT ?;
```

**为什么用 `JOIN` 而不是 `IN (子查询)`**（三种写法都实测过）

关键在于**把执行计划的选择权留给优化器**，不要硬编码一种：

| 数据形态 | 优化器选的计划 | 冷启动 | 稳态 |
|---|---|---|---|
| 我参与 20 个 issue / 2000 总数（1%），10 万评论 | 每个 issue 一次索引扫（`idx_tw_issue_assigner` + `idx_tw_issue_assignee`） | **1257 µs** | **31 µs** |
| 我参与 20 个 issue / 500 总数（4%），5 万评论 | 同上 | 1465 µs | 52 µs |
| 我参与 500 个 issue / 2000 总数（25%），10 万评论 | 主键顺序扫 + `BLOOM FILTER ON i` | **1010 µs** | **337 µs** |

后两种情况下它**自己**换成了 bloom filter 的嵌套循环计划 —— 这正是手写 `+` 想达到的效果，
但不用硬编码，而且高密度时不会退化。

**另外两种写法的实测（同一批数据）**

| 写法 | 稀疏（1%）冷启动 | 高密度（25%）稳态 |
|---|---|---|
| **`JOIN`（采用）** | **1257 µs** | **337 µs** |
| `IN (子查询)` | 1216 µs | 641 µs |
| `+issue_id IN (子查询)`（强制主键扫 + bloom） | **4664 µs** ❌ | 420 µs |

> `+issue_id` 是"一元加号禁止走索引"的写法。它看起来聪明，但**在可见数据稀疏时灾难性变慢**：
> 要扫 5 万行才凑出 500 条可见评论。**不要用。**

**`LEFT JOIN` 与 `JOIN` 等价**：因为 `WHERE (i.assigner=? OR i.assignee=?)` 对右表的列做了判空，
未匹配的行必然被过滤 —— 语义上已经退化为内连接。写成 `JOIN` 更诚实（实测两者计划与耗时完全一致）。
**不要**把条件写进 `ON` 再加 `WHERE i.issue_id IS NOT NULL`：那个形式实测慢 3 倍（4127 µs）。

**administrator 走另一条 SQL**（无需 JOIN）：

```sql
SELECT * FROM dsh_teamwork_issue_comment WHERE id > ? ORDER BY id ASC LIMIT ?;
```

**刻意不做的两件事**

| 不做 | 原因 |
|---|---|
| 缓存"我参与的 issue 集合"再拼 `IN (?,?,…)` | 动态占位符要按 N 分桶缓存预编译语句，换不到收益（JOIN 版冷启动已经 ≤1.3 ms、稳态 ≤52 µs） |
| 两段式（先取 id 再按 id 取正文） | 实测更慢：63 µs + 500 µs = 563 µs，一条 SQL 只要 50 µs |

**测试断言（防回归）**

1. 结果正确性：只返回自己参与的 issue 的评论；分页连续 4 批不漏不重；末游标 = 表尾。
2. 计划断言：`EXPLAIN QUERY PLAN` 里针对评论表的那一步必须是 `SEARCH … (rowid>?)`（游标作为范围上界），
   **不能**是 `SCAN dsh_teamwork_issue_comment`（不带 rowid 上界的全表扫）。注意计划里用的是别名 `c`，别按表名匹配。
3. 超时断言：10 万评论、1% 可见度下冷启动 < 5 ms。
**错误**：`400 invalid_request`（`limit` 非数字）/ `401 unauthorized`

---

### 5.8 C8 · `GET /issues/comments/cursor`

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| 入参 | 无 |
| 出参 | `{ maxId: number }`（空表返回 `0`） |

**用途**：首次运行 / 本地游标丢失时，用它作为"从当前尾部开始"的起点，
**避免 `sinceId=0` 把整张表扫一遍**。

---

### 5.9 C9 · `POST /issues/{issueId}/comments`

| 参数 | 位置 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `issueId` | path | ✅ | — | |
| `content` | body | ✅ | — | 1..10000 |
| `commentId` | body | ❌ | 服务端 UUID | **幂等键**；重试必须不变 |
| `commentAt` | body | ❌ | `now()` | 评论发生时刻（客户端可回填） |
| `commentRole` | body | ❌ | — | `assigner`/`assignee`，自由取值 |
| `commentAuthorType` | body | ❌ | — | `user`/`agent`/`system`，自由取值 |

**出参**：201 + `CommentVo`

| 规则 | 说明 |
|---|---|
| `author` | **强制为 token 账号**；请求体里出现 → `400 unknown_field` |
| 幂等 | 同 `commentId` 重复提交 → **200 + 已存在的 CommentVo**（不报 409，便于重试） |
| 权限 | **任何登录用户**；仅校验 `issueId` 存在（否则 `404 issue_not_found`） |

**错误**：`400 invalid_content` / `404 issue_not_found`

---

### 5.10 C10 · `GET /issues/{issueId}/comments`

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `issueId` | path | ✅ | |

**出参**：`CommentVo[]`，`created_at ASC, id ASC`（**不分页**；单个 issue 的评论量级可控）

**权限**：**任何登录用户**（仅校验 `issueId` 存在）

---

### 5.11 C11 · `POST /issues/attachments/batch` — 批量挂附件

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| 请求体 | JSON 数组（≤50 条） |
| 成功 | 200 + `{ count: number }` |

| 字段 | 必填 | 说明 |
|---|---|---|
| `issueId` | ✅ | 必须存在且我有权访问 |
| `fileId` | ✅ | **UUID v4 格式**（`400 invalid_file_id`）；**不校验是否存在**（见下） |
| `type` | ✅ | **`assigner` / `assignee`** |
| `fileName` | ❌ | 缺省取文件记录里的原文件名 |
| `description` | ❌ | ≤500 |

| 规则 | 说明 |
|---|---|
| upsert | `(issueId, fileId)` 唯一：重复提交更新 `fileName`/`type`/`description` |
| `description` | `COALESCE` → 传空保留原值 |
| 原子性 | **整批原子**（`BEGIN IMMEDIATE`），任一条失败整批回滚 |
| 权限 | **任何登录用户**；仅校验 `issueId` 存在（否则 `404 issue_not_found`） |

> **刻意不校验 `fileId` 是否存在**：只校验 UUID v4 格式。
> 原因：不做文件元数据表（表数保持 9 张），服务端没有可查的"文件是否存在"依据。
>
> **代价（写清楚，别当 bug 修）**：
> - 可以挂一个不存在的 `fileId`，落库成功，直到 F2 下载才 404 → issue 详情里会出现死链。
> - 未挂载到任何 issue 的文件，**任何人都下载不了**（F2 的权限只能靠 `issue_attachment` 反查）。
> - F3 删除无法判断上传者 → **仅 `administrator` 可删**。
> - 上传后**必须先挂到 issue 才能被下载**（F2 靠"我是不是该 issue 的参与者"判定）。
>
> 如果以后要补，两条路：① 加 `dsh_teamwork_file` 元数据表（表数 9 → 10）；
> ② 在 `files/<fileId>.json` 写 sidecar（表数不变）。现在两条都不做。

**错误**：`400 invalid_type` / `400 invalid_file_id` / `400 invalid_request` / `404 issue_not_found`

---

### 5.12 C12 · `GET /issues/{issueId}/attachments`

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `issueId` | path | ✅ | |
| `type` | query | ❌ | `assigner` / `assignee`；省略查全部 |

**出参**：`AttachmentVo[]`（`created_at ASC`，不分页）

**权限**：参与者或 administrator

---

### 5.13 C13 · `GET /issue-sources`

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `q` | query | ❌ | 按 `code` / `description` 模糊匹配 |

**出参**：`SourceVo[]`（`code ASC`，不分页；字典表，量级几十条）

**权限**：任何登录用户（字典是公共信息）

---

### 5.14 C14 · `POST /issue-sources/batch` — 批量注册

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| 请求体 | JSON 数组（≤100 条）`{ code, description?, pluginName? }` |
| 成功 | 200 + `{ count: number }` |

| 规则 | 说明 |
|---|---|
| `code` 格式 | `^[a-z]+(-[a-z]+)*$`，1..64（**小写字母 + 单中划线**），不合规 → `400 invalid_source_code` |
| 去重 | **应用层先按 `code` 去重（保留最后一条）**，再入库 —— 不依赖 DB 行为 |
| upsert | 已存在则更新 `description` / `pluginName`（`COALESCE`，传空保留原值） |
| 权限 | 任何登录用户（来源是开放注册的） |

---

### 5.15 C15 · `PUT /issue-sources/{id}`

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `id` | path | ✅ | 来源主键 |
| `description` | body | ❌ | |
| `pluginName` | body | ❌ | |

**出参**：200 + `SourceVo`

**权限**：**administrator**；`code` **不可改**（改了会让已有 issue 的 `source` 悬空）。

**错误**：`403 forbidden` / `404 source_not_found`

---

### 5.16 C16 · `DELETE /issue-sources/{id}`

| 参数 | 位置 | 必填 |
|---|---|---|
| `id` | path | ✅ |

**出参**：**204**

**权限**：**administrator**。弱引用：**已有 issue 的 `source` 字符串不受影响**（不会置空、不会级联删）。

**错误**：`403 forbidden` / `404 source_not_found`

---

## 6. C 组错误码汇总

| code | HTTP | 出处 |
|---|---|---|
| `invalid_request` | 400 | C1/C6/C7/C11/C14 |
| `unknown_field` | 400 | 所有带请求体的端点（§0.4.1） |
| `invalid_title` | 400 | C1/C4 |
| `invalid_status` | 400 | C1/C2/C4 |
| `invalid_urgency` | 400 | C1/C4 |
| `invalid_permission` | 400 | C1/C4 |
| `invalid_content` | 400 | C9 |
| `invalid_type` | 400 | C11 |
| `invalid_file_id` | 400 | C11（UUID v4 格式） |
| `invalid_source_code` | 400 | C14 |
| `unauthorized` | 401 | 全部 |
| `forbidden` | 403 | C15/C16（需 administrator） |
| `not_project_member` | 403 | C1/C4 |
| `issue_not_found` | 404 | C3/C4/C5/C9/C10/C11/C12 |
| `account_not_found` | 404 | C1 |
| `project_not_found` | 404 | C1 |
| `source_not_found` | 404 | C15/C16 |
| `project_archived` | 409 | C1 |

**`failed[].reason`（C6 专用，不是错误码）**：`issue_id_required` / `invalid_status` /
`invalid_expected_status` / `not_found` / `status_conflict` / `update_conflict`

---

## 7. 模块 F · 文件（3 个）

> **设计取舍（已定）**：**不建文件元数据表**，文件本体存 `dataDir/files/<fileId>`。
> 因此服务端**不知道**文件的原名、大小、sha256、上传者 —— 这直接决定了 F2/F3 的权限只能靠
> `issue_attachment` 反查。详见下面各端点。

### 7.1 F1 · `POST /files` — 上传

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 |
| Header | `Content-Type: application/octet-stream`（必须） |
| Header | `X-File-Name: <percent-encoded UTF-8>`（必填，≤255 字符；解码后去除路径分隔符） |
| Header | `X-File-Sha256: <64 位小写 hex>`（可选，服务端边写边算并比对） |
| Body | **原始二进制**（不是 multipart） |
| 成功 | **201** + `{ fileId, fileName, size, sha256, createdAt }` |

| 规则 | 说明 |
|---|---|
| `fileId` | 服务端 `randomUUID()`（UUID v4 小写），同时是磁盘文件名 |
| 大小上限 | `--max-upload-mb`（默认 64）→ 超过 `413 payload_too_large` |
| 落盘顺序 | 写 `files/<fileId>.tmp` → 算 sha256 → 比对 `X-File-Sha256`（不符 → `400 sha256_mismatch` + 删 tmp）→ `rename` 成 `files/<fileId>` |
| 元数据 | **不落库**（响应里返回，之后不再可查） |

**错误码**

| HTTP | code | 场景 |
|---|---|---|
| 400 | `invalid_file_name` | 缺头 / 超 255 / 解码失败 |
| 400 | `sha256_mismatch` | 客户端给的哈希与实际不符 |
| 413 | `payload_too_large` | 超 `--max-upload-mb` |
| 415 | `unsupported_media_type` | `Content-Type` 不是 `application/octet-stream` |

### 7.2 F2 · `GET /files/{fileId}` — 下载

| 项 | 内容 |
|---|---|
| 鉴权 | **签名头**（只需登录，**不做资源级鉴权**） |
| Path | `fileId`（UUID v4 格式校验 → `400 invalid_file_id`） |
| 成功 | 200 + 二进制流，`Content-Type: application/octet-stream`，`Content-Length`，`Content-Disposition: attachment; filename="<fileId>"` |

**权限：任何已登录用户都能下载任何 `fileId`**

只要签名头通过、`fileId` 是合法 UUID、磁盘上文件存在，就返回内容。不判断"文件是谁传的"、不判断"是否挂在某个 issue 上"。

> 这与 C 组的取舍一致：**服务端不做资源级鉴权**，"谁该拿到这个 fileId、谁不该"由 SDK/DSH 侧保证。
> `fileId` 是 UUID v4（122 位随机），猜不出来。

| 后果 | 说明 |
|---|---|
| 知道 `fileId` 就能下载 | 前提是拿到签名头（= 一个有效账号） |
| 无法阻止"内部人员横向读取" | 已明确接受；需要隔离时靠 SDK 不发这个 id |
| 没有元数据 → 文件名只能给 `fileId` | `Content-Disposition` 不还原原名 |

**错误码**：`400 invalid_file_id` / `404 file_not_found`（磁盘上没有）

> 磁盘缺文件返回 404（不是 500）：服务端没有任何记录证明"它应该存在"。

### 7.3 F3 · `DELETE /files/{fileId}` — 删除

| 项 | 内容 |
|---|---|
| 鉴权 | 签名头 + **administrator** |
| Path | `fileId` |
| 成功 | **204**（幂等：文件不存在也返回 204） |

**为什么要 administrator**：没有元数据表就判断不了上传者，"谁都能删"不可接受，所以只给管理员。

**删除动作（顺序）**

```sql
BEGIN IMMEDIATE;
  DELETE FROM dsh_teamwork_issue_attachment WHERE file_id = ?;   -- 先清引用，避免死链
COMMIT;
-- 再 fs.unlink(files/<fileId>)，忽略 ENOENT
```

> 先清附件引用再删文件：否则 issue 详情里会留下指向已删文件的记录。
> **注意**：这一步是"删文件即撤销所有挂载"，不可恢复。

**错误码**：`400 invalid_file_id` / `403 forbidden`（非 administrator）

---

## 8. 模块 M · 管理与运维（6 个）

### 8.1 M1 · `GET /health` — 健康检查

| 项 | 内容 |
|---|---|
| 鉴权 | **公开** |
| 成功 | 200 + 下述 JSON；**停机中返回 503** |

```jsonc
{
  "ok": true,
  "version": "0.1.0",
  "pid": 12345,
  "uptimeMs": 3600000,
  "startedAt": "2026-11-11T10:00:00.000Z",
  "serverTime": "2026-11-11T11:00:00.000Z",
  "db": { "path": "…/teamwork.db", "userVersion": 1, "journalMode": "wal" },
  "authCache": { "size": 12, "hits": 4096, "misses": 37, "ttlMs": 60000 }
}
```

**为什么公开**：`ensure`/launcher 要在**任何账号存在之前**判断就绪（首次部署库里没有账号）。
**不返回任何业务数据**。

### 8.2 M2 · `GET /version` — 能力探测

| 项 | 内容 |
|---|---|
| 鉴权 | **公开** |
| 成功 | 200 + 下述 JSON |

```jsonc
{
  "protocol": "dsh-teamwork/1",
  "name": "dsh-teamwork",
  "version": "0.1.0",
  "dshEngine": "0.2.0-rc.2",
  "node": "24.19.0",
  "endpoints": ["POST /auth/login", "GET /projects", "…"]
}
```

| 字段 | 用途 |
|---|---|
| `protocol` | **协议版本**，SDK 用它判断能否对接（不匹配直接报错，不猜） |
| `endpoints` | 能力探测：SDK 据此判断服务端支持哪些接口（少一个就别调用） |

### 8.3 M3 · `POST /admin/shutdown` — 停机

| 项 | 内容 |
|---|---|
| 鉴权 | **两条任选**：① `X-Shutdown-Token`（从锁文件读，**只接受回环来源**）② administrator 签名头 |
| Body | 无 |
| 成功 | **202** + `{ ok: true, stopping: true }`（异步停机，不等待在飞请求） |

| 规则 | 说明 |
|---|---|
| 不接受 query 传 token | `?token=` 会进访问日志 → 只认 header |
| 只接受回环 | 非 `127.0.0.1`/`::1` 一律 403（即使 token 正确） |
| 幂等 | 重复调用返回 202 |
| 停机流程 | 停止接受新连接 → 等待在飞请求（`--shutdown-grace`，默认 5s）→ `closeAllConnections()` → 释放单实例锁 → 退出 |

> **为什么留本地通道**：Windows 下不能 `process.kill(-pid)`，只能调这个端点；而"要停机"常发生在
> 管理员账号还没建、或密码忘了的时候。

**错误码**：`403 forbidden`（token 错 / 非回环 / 非 administrator）

### 8.4 M4 · `PUT /admin/accounts/{accountId}/role` — 改全局角色

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `accountId` | path | ✅ | |
| `role` | body | ✅ | `administrator` / `leader` / `user` |

**出参**：200 + `AccountVo`

| 规则 | 失败码 |
|---|---|
| 不能降级**最后一个** `administrator` | `409 last_administrator` |
| 降级的账号**拥有 `public` 项目**的 owner 身份 → 拒绝 | `409 owner_of_public_projects`，`details:{projects:[...]}` |
| 目标不存在 | `404 account_not_found` |
| 非 administrator 调用 | `403 forbidden` |

**副作用**：清空鉴权缓存（角色改动立即生效）。

### 8.5 M5 · `POST /admin/accounts/{accountId}/password` — 管理员重置密码

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `accountId` | path | ✅ | |
| `newPassword` | body | ✅ | **base64**（同 A1/A5 规则），解码后 12..128 字符 |

**出参**：**204**

| 规则 | 说明 |
|---|---|
| 效果 | 重算 `account_token` → **该账号所有旧 `auth_token` 立即失效** |
| `last_login_at` | **不动**（这不是一次登录） |
| 新密码校验 | 同 A1：长度、弱口令表；**不检查是否与旧密码相同**（管理员不知道旧密码） |

**错误码**：`400 invalid_password_encoding` / `400 invalid_password` / `400 weak_password` /
`403 forbidden` / `404 account_not_found`

### 8.6 M6 · `GET /admin/accounts` — 账号列表

| 参数 | 位置 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `q` | query | ❌ | — | 按 `accountId` / `displayName` 模糊匹配 |
| `pageNum` / `pageSize` | query | ❌ | 1 / 20 | |

**出参**：`{ total, pageNum, pageSize, items: AccountVo[] }`，`created_at DESC`

> **永不返回 `accountToken`**（它是密码等价物，只在 A1/A2/A5 的响应里出现）。

**错误码**：`403 forbidden`

---

## 9. F / M 错误码汇总

| code | HTTP | 出处 |
|---|---|---|
| `invalid_file_name` | 400 | F1 |
| `invalid_file_id` | 400 | F2/F3 |
| `sha256_mismatch` | 400 | F1 |
| `invalid_password` | 400 | M5 |
| `invalid_password_encoding` | 400 | M5 |
| `weak_password` | 400 | M5 |
| `forbidden` | 403 | F3/M3/M4/M5/M6 |
| `file_not_found` | 404 | F2 |
| `account_not_found` | 404 | M4/M5 |
| `last_administrator` | 409 | M4 |
| `owner_of_public_projects` | 409 | M4 |
| `payload_too_large` | 413 | F1 |
| `unsupported_media_type` | 415 | F1 |

---

## 10. 全局：47 个端点已全部定稿

| 模块 | 端点数 | 状态 |
|---|---|---|
| A · 账号 | 6 | ✅ |
| B · 项目/成员/设备/工作区 | 16 | ✅ |
| C · Issue | 16 | ✅ |
| F · 文件 | 3 | ✅ |
| M · 管理与运维 | 6 | ✅ |
| **合计** | **47** | ✅ |

---

