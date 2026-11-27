# 认证交换协议（`dsh-teamwork/1`）

> 本文是 **认证的唯一权威**。`api-design.zh.md` / `sdk-design.zh.md` 里关于「客户端现签 JWT、固定双头」的段落已经过时。

## 0. 边界

SDK **只认 HTTP**：

```text
POST /dsh-teamwork/v1/auth/token     # 账号 + 长期凭据 → 一组请求 headers
POST /dsh-teamwork/v1/auth/logout    # 带当前 headers，服务端自行撤销
```

SDK 不关心 JWT、header 名字、企业 IdP。企业部署自己的 teamwork 服务时，只要满足本协议（以及其余业务端点）即可，不需要实现样例服务的 TypeScript `AuthProvider`。

样例服务的 `AuthProvider` 只是内部扩展点：

```ts
interface AuthProvider {
  issue(input: { accountId; accountToken; device? }): Promise<AuthGrant>
  authenticate(input: { headers }): Promise<CurrentUser>
  logout(input: { headers }): void
}
```

## 1. `/auth/token`

公开端点；请求体严格字段：

```json
{
  "accountId": "alice",
  "accountToken": "…",
  "device": {
    "id": "…",
    "host": "10.0.0.2",
    "port": 3939,
    "os": "win32"
  }
}
```

- `accountToken` 是长期凭据 / refresh token，不是 access token；
- `device` 可选；IP 不作为身份，设备绑定用稳定的 `device.id`；
- 未知字段 → `400 unknown_field`；
- 账号或长期凭据错误 → `401 invalid_credentials`（不区分账号是否存在）；
- 账号禁用 → `403 account_disabled`；
- 响应必须 `Cache-Control: no-store`。

成功响应：

```json
{
  "accountId": "alice",
  "headers": {
    "dsh-teamwork-token": "…",
    "dsh-teamwork-account": "alice"
  },
  "expiresAt": 1760000000000,
  "displayName": "Alice",
  "globalRole": "administrator"
}
```

- `headers` 是任意 K-V；允许 `Authorization`、`X-*`、`cookie`；
- SDK 会拒绝 `host` / `content-length` / `content-type` / `transfer-encoding` / `connection` / `upgrade` / `set-cookie`，以及带 CR/LF 的值；
- `expiresAt` 是 epoch ms；`null` 表示只能靠后续 401 判断；
- **绝不返回 `accountToken`**。

本地样例的 headers 仍然是旧 JWT 双头：

```json
{
  "dsh-teamwork-token": "HS256 JWT",
  "dsh-teamwork-account": "alice"
}
```

JWT payload 仍是 `{ a, iat, exp }`，签名密钥是 DB 里的 `account_token`；这些细节只属于本地 `LocalJwtAuthProvider`，不是 SDK 协议。

## 2. `/auth/logout`

```http
POST /dsh-teamwork/v1/auth/logout
<当前 auth headers>
```

- SDK 成功后删除 `.credentials.json`（保留 `.credentials.key`）；
- 样例服务路由调用 `AuthProvider.logout(headers)`，本地 provider 清 `AuthCache`；
- 无状态实现可以直接 204。

## 3. 登录

`POST /auth/login` 继续只返回：

```json
{ "account": { … }, "accountToken": "…", "ttlSeconds": 259200 }
```

SDK 收到后再调一次 `/auth/token` 换 headers；登录响应不包含 headers。

## 4. SDK 刷新规则

```text
headers 有效（expiresAt - 30s 之前）→ 直接用
headers 缺失/过期 → 单飞调 /auth/token → 更新文件 → 用新 headers
API 401 → 清 headers，调一次 /auth/token，重试一次
仍 401 / auth 返回 401 → login_required，不再自动重试
auth 5xx/网络失败 → auth_refresh_failed，保留账号
```

并发 401 共用一个 `refreshPromise`，只打一次 `/auth/token`。

## 5. `.credentials.json` v2

整文件 AES-256-GCM；明文：

```ts
interface StoredCredentialV2 {
  v: 2
  server: string
  accountId: string
  displayName: string | null
  accountToken: string
  ttlSeconds: number
  auth: {
    headers: Record<string, string>
    expiresAt: number | null
    obtainedAt: string
  } | null
  savedAt: string
}
```

v1 自动迁移：保留 `accountId` / `accountToken`，`auth = null`，第一次请求补 `/auth/token`。

## 6. 本地 JWT 设备信息

`device` 只是认证交换的输入；本地 provider 当前不强制校验，也不把 IP 放进 JWT。需要设备绑定的企业服务可以自行使用 `device.id`，但应保持「同一账号 + 长期凭据 + 设备」的语义，不要把 IP 当身份。
