# dsh-teamwork · 服务端设计

> **本文是 `dsh-teamwork` 服务端的唯一设计基线。**
>
> 技术栈：**Node 24 + `node:sqlite` + 零第三方运行时依赖 + 自签 token + 本地磁盘附件**。
>

---

## 0. 决策登记（已与需求方确认，勿单方面推翻）

| # | 决策 | 取值 | 理由 / 影响 |
|---|---|---|---|
| D1 | 进程形态 | **独立 Node 进程**，另配 `bin` 一键启动/停止/重启 | `node:sqlite` 只有同步 API，放进 dsh web 进程会阻塞事件循环（AGENTS.md 二·1） |
| D2 | 表范围 | **9 张表**：旧 8 张业务表（`issue`/附件/评论/`issue_source`/`project`/成员/`device`/工作区）+ 新增 `account`。**`whitelist` 已合并进 `account.global_role`** | 少一张表、少一次 JOIN；角色只有一个真相 |
| D3 | 附件 | **本地磁盘 + 服务端流式下载** | 零 S3 依赖；下载必须带签名头，不再有免鉴权直链 |
| D4 | 包形态 | **单 npm 包、双入口**：`.` = SDK，`./server` = 服务端 | 发布简单；服务端代码随包分发（`files: ["lib"]`） |
| D5 | issue 归属项目 | **新增 `project_id` 列**（可空）+ 复合索引（原「不加列、靠 JSON」方案已废弃） | 项目有 owner/成员上限/归档等真实语义，issue 不挂项目无法 JOIN、删项目会悬空 |
| D6 | 加密 | **不区分 Win/Linux**，统一 AES-256-GCM + 独立 0600 密钥文件；接口 token 用「随机不透明 + 服务端存哈希」 | 详见 [`sdk-design.zh.md`](./sdk-design.zh.md) §1（算法选择）与 §3（落盘信封） |
| D7 | 路径前缀 | `/dsh-teamwork/v1/...` | 带 `v1`；后续破坏性升级可并行挂 `v2` |
| **D8** | **服务端可替换** | 本服务是**参考实现**，不是必需件。协议（端点 / 字段 / 状态码 / 错误体）定义在 [`sdk-design.zh.md`](./sdk-design.zh.md) §11，任何人可另写服务端 | SDK 只依赖协议；本仓库的端口、SQLite、表名、token 格式都**不是**协议的一部分 |
| **D9** | **token 形态** | **无会话表**：客户端用 `account_token` 作 HMAC 密钥签 HS256 JWT，服务端查一行账号验签；`exp` 3 天，**服务端封顶** | 需求方指定；代价是失去单点吊销与设备观测（见 §4.2） |
| **D10** | **密码存储** | **`account_token = SHA256("account_id:password")`（小写 hex 64）**，取代 scrypt 的 `password_hash` | 需求方指定。已知降级：抗离线爆破 51 ms → 0.71 µs；补偿措施见 db-design §3.1.0（限流 + 300ms 延迟 + 密码 ≥12 位 + **永不作凭据** + 不建索引） |
| **D11** | **自动拉起** | **不内嵌**：服务永远是独立进程；由 `dsh-teamwork ensure`（幂等）+ 薄 launcher 插件在插件加载时自动拉起（§3.7） | `node:sqlite` 与 `worker_threads` 在 DSH 的 webworker runtime 里都是 mock（§3.6），内嵌没有收益只有风险 |

---

## 1. 事实基线（已在本机实测，不是假设）

| 项 | 实测值 | 影响 |
|---|---|---|
| Node | `v24.19.0` | `node:sqlite` / `node:crypto` 均可用，`type: module` 原生 ESM |
| pnpm | `12.14.0` | 构建与 workspace 用它 |
| `node:sqlite` | `DatabaseSync` / `StatementSync`（**仅同步**） | D1 的硬理由；服务端每请求的 DB 调用是微秒级同步，独立进程内可接受 |
| SQLite 版本 | `3.53.3` | `ON CONFLICT` / **部分唯一索引** / 表达式索引 / `json_extract` / `strftime('%Y-%m-%dT%H:%M:%fZ')` 全部可用 |
| `LIKE` 语义 | ASCII 大小写不敏感（`'ABC' LIKE '%b%'` → `1`） | 大小写不敏感；中文不受影响 |
| 加密原语 | `scrypt` / `aes-256-gcm` / `randomBytes` 齐全 | 零原生依赖、零平台分支 |

**已验证的 SQLite 行为**（直接跑过）：

```sql
-- 部分唯一索引 + 带 WHERE 的冲突目标，可命中
CREATE UNIQUE INDEX uk_ws_index  ON ws(account_id,instance) WHERE workspace_id IS NULL;
INSERT INTO ws(...) VALUES(...,NULL,...)
  ON CONFLICT(account_id,instance) WHERE workspace_id IS NULL
  DO UPDATE SET detail = excluded.detail;
-- ↑ 连续两次上报同一实例，行数恒为 1（实测 c=1）
```

---

## 2. 工程形态（单包双入口）

### 2.1 `package.json` 骨架

```jsonc
{
  "name": "@meiyukichan/dsh-teamwork",
  "version": "0.1.0",
  "type": "module",
  "description": "Project/issue collaboration service + SDK for DeepSeek Harness 0.2.0-rc.2",
  "engines": { "node": ">=24.0.0", "dsh": ">=0.2.0-rc.2" },
  "bin": { "dsh-teamwork": "./lib/bin/cli.js" },
  "main": "lib/sdk/index.js",
  "types": "lib/sdk/index.d.ts",
  "exports": {
    ".":            { "types": "./lib/sdk/index.d.ts",    "default": "./lib/sdk/index.js" },
    "./server":     { "types": "./lib/server/index.d.ts", "default": "./lib/server/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib"],
  "dependencies": {
    "fastify": "^5.0.0",
    "@sinclair/typebox": "^0.34.0"
  },
  "devDependencies": { "@types/node": ">=24.0.0", "typescript": ">=5.7.0 <6.0.0" }
}
```

**运行时依赖就这三个（含可选），其余全靠 Node 内置**（§2.5 说明选型理由）：

| 包 | 用途 | 能不能不要 |
|---|---|---|
| `fastify` | HTTP 框架：schema 校验、钩子、错误处理、pino 日志、`inject()` 测试 | 不要就只能手写 ~150 行 router + 自己接校验与日志 |
| `@sinclair/typebox` | 一份 schema 同时产出 **运行时校验 + TS 类型 + OpenAPI**（Fastify 官方推荐组合） | 不要就得 zod 之类，工作量一样但和 Fastify 配合没这么顺 |
| `@fastify/swagger`（后加） | 从 schema 自动生成 OpenAPI，给"第三方实现协议"用 | 可后加，不影响主链路 |

> 另有一个**独立小包** `@meiyukichan/dsh-teamwork-launcher`（Cordis 插件，负责加载时自动拉起服务），
> 它带 `@deepseek-ai/*` peer 依赖，因此**不并进主包**，理由见 §3.7 ④。

**明确不引**：ORM（`prisma`/`drizzle`/`typeorm` 都不引，SQLite 直接写 SQL）、DI 容器（手写 `container.ts`）、
`better-sqlite3`（原生模块，会把安装变成编译）、`tRPC`（会破坏「服务端可替换」）。

### 2.2 目录结构

```
src/
  shared/            两端共用：路由常量、枚举、错误码、DTO 类型（纯类型 + 纯函数）
    routes.ts        const ROUTES = { auth: '/dsh-teamwork/v1/auth', ... }
    enums.ts         IssueStatus / IssueUrgency / IssuePermission / ProjectMemberRole / ...
    errors.ts        TeamworkErrorCode 枚举 + BusinessError 类
    types.ts         请求/响应 DTO + CurrentUser（全项目唯一的用户形状）
    permissions.ts   权限纯函数：isAdministrator / canCreateFormalProject / canManageMembers
  server/            ← 入口 ./server
    index.ts         export { buildApp, startServer }（buildApp 供 inject() 测试与内嵌）
    container.ts     手写依赖装配（不引入 DI 容器）
    app.ts           Fastify 实例：注册 TypeBox 编译器、onRequest 鉴权钩子、setErrorHandler、pino
    routes/
      index.ts       路由注册表（每条带 auth 级别 + TypeBox schema）
      auth.routes.ts projects.routes.ts devices.routes.ts issues.routes.ts files.routes.ts admin.routes.ts
    hooks/
      auth.hook.ts     onRequest 钩子 = 原 guard（§4.5）
      rate-limit.hook.ts
      error.handler.ts setErrorHandler = @ControllerAdvice
    modules/
      auth/          ← 参考实现（§2.3 逐层展开）
        auth.controller.ts    （handler：收 FastifyRequest/Reply，调 service）
        auth.service.ts
        auth.mapper.ts
        auth.schema.ts        （TypeBox schema = DTO 校验 + OpenAPI）
        password.encoder.ts
        authenticate.ts       （唯一鉴权实现，导出 authenticateHeaders）
        auth-cache.ts         （鉴权结果缓存，§4.6）
      projects/      project + member
      devices/       device + device-workspace
      issues/        issue + status + comment + attachment + source
      files/         上传 / 下载 / 删除
      admin/         accounts（改角色/重置密码）/ shutdown / health
    db/
      open.ts        DatabaseSync + PRAGMA + 迁移执行
      uow.ts         事务单元（= @Transactional）
      migrations/001_init.sql
  sdk/               ← 入口 .
    index.ts         export { TeamworkClient, CredentialStore, ... }
    client.ts        HTTP 客户端
    credential.ts    AES-256-GCM 信封读写
    auth.ts          登录态管理
  bin/
    cli.ts           start / stop / restart / status / doctor
```

### 2.3 分层骨架（以 auth 为参考实现，其余模块照此复制）

**分层职责速查**

| 层 | 目录 | 职责 |
|---|---|---|
| `@RestController` | `*.controller.ts` | 解析 HTTP、调 DTO 校验、调 service、组装 VO；**无 SQL、无密码学** |
| `@Service` | `*.service.ts` | 业务规则、事务边界、跨表协作；可抛 `BusinessError`；**不碰 `req`/`res`** |
| `@Mapper` / `@Repository` | `*.mapper.ts` | 只有 SQL 与行映射（SQL `AS` 别名直接映射 camelCase）；**无业务判断** |
| DTO + `@Valid` | `*.dto.ts` | 形状校验 + 类型收窄（返回 typed DTO 或抛 `invalid_request`） |
| `@ControllerAdvice` | `hooks/error.handler.ts`（`app.setErrorHandler`） | `BusinessError` → 统一错误体；未捕获异常 → 500 |
| `PasswordEncoder` bean | `password.encoder.ts` | 唯一的哈希位置（`SHA256("账号:密码")`） |
| `@Transactional` | `db/uow.ts` 的 `transaction(fn)` | `BEGIN IMMEDIATE` + 失败回滚 |
| `@Configuration` + DI | `container.ts` | 手工装配（零框架依赖） |

**① DTO 层（只校验形状，判业务规则不在这里）**

```ts
// modules/auth/auth.dto.ts
export interface LoginDto { accountId: string; password: string }

export function parseLogin(raw: unknown): LoginDto {
  const body = raw as Record<string, unknown> | null
  const accountId = typeof body?.accountId === 'string' ? body.accountId : ''
  const password  = typeof body?.password  === 'string' ? body.password  : ''
  if (!ACCOUNT_ID_RE.test(accountId)) throw new BusinessError('invalid_request', 400, { field: 'accountId' })
  if (password.length === 0)          throw new BusinessError('invalid_request', 400, { field: 'password' })
  return { accountId, password }
}
```

**② Mapper 层（只有 SQL；列名映射交给 SQL 别名）**

```ts
// modules/auth/auth.mapper.ts
export interface AccountRow {
  id: number; accountId: string; displayName: string | null
  accountHash: string; status: 'active' | 'disabled'; lastLoginAt: string | null
}

export class AccountMapper {
  private readonly findByAccountIdStmt
  private readonly insertStmt
  private readonly touchLastLoginStmt
  private readonly countStmt

  constructor(db: DatabaseSync) {
    this.findByAccountIdStmt = db.prepare(`
      SELECT id, account_id AS accountId, display_name AS displayName,
             account_token AS accountHash, status, last_login_at AS lastLoginAt
        FROM dsh_teamwork_account WHERE account_id = ?`)
    this.insertStmt = db.prepare(`
      INSERT INTO dsh_teamwork_account(account_id, display_name, account_token)
      VALUES (?, ?, ?) RETURNING id`)
    this.touchLastLoginStmt = db.prepare(`
      UPDATE dsh_teamwork_account
         SET last_login_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE account_id = ?`)
    this.countStmt = db.prepare(`SELECT COUNT(*) AS n FROM dsh_teamwork_account`)
  }

  findByAccountId(id: string): AccountRow | undefined { return this.findByAccountIdStmt.get(id) as AccountRow | undefined }
  insert(input: { accountId: string; displayName: string | null; accountHash: string }): number {
    return (this.insertStmt.get(input.accountId, input.displayName, input.accountHash) as { id: number }).id
  }
  touchLastLogin(accountId: string, at: string): void { this.touchLastLoginStmt.run(at, accountId) }
  count(): number { return (this.countStmt.get() as { n: number }).n }
}
```

**③ 编解码层（唯一的密码学位置）**

```ts
// modules/auth/password.encoder.ts
export const DUMMY_HASH = sha256hex('dsh-teamwork:dummy')

export interface PasswordEncoder {
  derive(accountId: string, password: string): string   // → 64 位小写 hex
  verify(storedHash: string, accountId: string, password: string): boolean
}

export const passwordEncoder: PasswordEncoder = {
  // account_token = SHA256(utf8(account_id + ":" + password))
  derive: (accountId, password) => createHash('sha256').update(`${accountId}:${password}`, 'utf8').digest('hex'),
  verify(storedHash, accountId, password) {
    const a = Buffer.from(storedHash, 'hex')
    const b = Buffer.from(this.derive(accountId, password), 'hex')
    return a.length === b.length && timingSafeEqual(a, b)   // 常量时间
  },
}
```

**④ Service 层（业务规则 + 事务；不碰 HTTP）**

```ts
// modules/auth/auth.service.ts
export class AuthService {
  constructor(
    private readonly accounts: AccountMapper,
    private readonly tokens: TokenService,
    private readonly encoder: PasswordEncoder,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  login(dto: LoginDto): SessionDto {
    const row = this.accounts.findByAccountId(dto.accountId)

    // 账号不存在也走一次等量计算：杜绝用响应时间枚举账号（§4.1 细节 ④）
    const stored = row ? row.accountHash : DUMMY_HASH
    const hashInputId = row ? row.accountId : dto.accountId
    const passwordOk = this.encoder.verify(stored, hashInputId, dto.password)
    if (!row || !passwordOk) throw new BusinessError('invalid_credentials', 401)

    if (row.status !== 'active') throw new BusinessError('account_disabled', 403)

    this.touchLastLogin(row.accountId)              // 审计字段，写失败不影响登录
    return this.tokens.issue(row)                   // 签发会话 token（含 createdIp/userAgent）
  }

  register(dto: RegisterDto, ctx: RequestContext): SessionDto {
    passwordPolicy.assert(dto.password)             // 长度 ≥12 / 无首尾空白 / 非弱口令
    this.registrationGate.assert(dto.registrationCode)   // --registration-code / --registration=closed
    const accountToken = this.encoder.derive(dto.accountId, dto.password)

    return this.uow.transaction(() => {
      // 「首个账号 = administrator」必须在事务内判定，否则并发注册会出两个 administrator
      const isFirst = this.accounts.count() === 0
      const globalRole = isFirst ? 'administrator' : 'user'
      const id = this.accounts.insert({                 // 一次 INSERT 写入角色，无第二张表
        accountId: dto.accountId,
        displayName: dto.displayName ?? null,
        accountToken,
        globalRole,
      })
      this.accounts.touchLastLogin(dto.accountId, this.clock.nowIso())
      const session = this.tokens.issue({ id, accountId: dto.accountId, displayName: dto.displayName }, ctx)
      return { account: this.toAccountVo(dto.accountId, dto.displayName ?? null, globalRole), ...session }
    })
  }

  private touchLastLogin(accountId: string): void {
    try { this.accounts.touchLastLogin(accountId, this.clock.nowIso()) } catch { /* 只记日志，不抛 */ }
  }
}
```

**⑤ Controller 层（只做 HTTP 适配；Fastify 的 `RouteHandler` 签名）**

```ts
// modules/auth/auth.controller.ts
export function loginController(deps: Deps): RouteHandler<{ Body: LoginDto }> {
  return async (req, reply) => {
    const session = deps.services.auth.login(req.body)      // ① 入参已由 schema 校验 ② 业务
    return reply.code(200).send(toLoginResponse(session))   // ③ 组装 VO
    // 不用 try/catch：BusinessError 由 app.setErrorHandler 统一转错误体（= @ControllerAdvice）
  }
}
```

**⑥ 事务与错误归谁**

| 事项 | 归属 | 说明 |
|---|---|---|
| `BEGIN IMMEDIATE` / `COMMIT` / 回滚 | `db/uow.ts` | service 只写 `uow.transaction(() => {...})`，不写裸 SQL |
| `BusinessError(code, status, details)` | `shared/errors.ts` | service 抛，controller 不 catch |
| 映射成 `{code,message,details,requestId}` | `hooks/error.handler.ts`（`app.setErrorHandler`） | 唯一出口；未捕获异常 → 500，堆栈只进日志 |
| 入参校验 | 各模块 `*.schema.ts`（TypeBox） | 由 Fastify 在 handler 之前执行，非法直接 400 |
| 限流 | `hooks/rate-limit.hook.ts`（`onRequest`） | 横切逻辑，不属于业务 |

**三条分层铁律**（review 时按这个卡）：

1. **controller 里不许出现**：SQL、`createHash`/`timingSafeEqual`、事务控制、跨模块 mapper 调用
2. **mapper 里不许出现**：业务判断（如 `role === 'administrator'`）、错误码选择、`Date.now()` 之类的时间取值
3. **service 里不许出现**：`req`/`res`/`headers`、`res.writeHead`、HTTP 状态码字面量（状态码由 `BusinessError` 携带）

### 2.4 构建

```jsonc
"scripts": {
  "build":      "tsc -p tsconfig.build.json && tsc -p tsconfig.dts.json && node scripts/emit-dts.mjs",
  "typecheck":  "tsc --noEmit",
  "test":       "node --test --experimental-test-isolation=none \"tests/**/*.test.ts\""
}
```

- `outDir: lib`（AGENTS.md 一·1 的产物目录约定，本项目沿用）
- 不打包、不 minify：ESM 逐文件产出，堆栈可读
- `lib/bin/cli.js` 首行 `#!/usr/bin/env node`，由构建脚本补 shebang + 可执行位

### 2.5 技术选型：Fastify + TypeBox（已定）

选它的原因不是"性能"，是**它就带着我们缺的那三件基础设施**：

| 我们的具体问题 | Fastify 的答案 |
|---|---|
| 47 个端点里一半是参数校验 + 分页 + 错误码 | `schema` 声明式校验，`req.query`/`req.body` 自动 400 |
| 鉴权要集中、handler 零鉴权代码 | `onRequest` 钩子 + `routeOptions.config.auth`（§4.5） |
| 统一错误体 | `setErrorHandler`（= `@ControllerAdvice`） |
| 别人要能写服务端（协议优先） | `@fastify/swagger` 从 schema 自动产出 OpenAPI，天然不漂 |
| 48 端点要做契约测试 | `app.inject()` 不起端口直接打 |
| 附件 raw body 上传 / 流式下载 | `addContentTypeParser` + `reply.send(stream)`，无需额外库 |
| 结构化请求日志 + requestId | 内置 pino，`req.id` |
| 单实例锁 / 优雅停机 | 启动 <100 ms；`await app.close()` 天然等于优雅停机 |
| Windows 免编译 | 纯 JS，无原生依赖 |

**分层映射（旧 `RouteDef` 方案 → Fastify）**

| 现设计 | Fastify 落点 |
|---|---|
| `RouteDef.auth` | `app.route({..., config: { auth } })`（`auth` 仍是**必填**，否则启动即报错） |
| `guard()` | `app.addHook('onRequest')`，读 `req.routeOptions.config.auth` |
| `parseXxx()` DTO | TypeBox schema（`Type.Object`），同时产出 TS 类型与 OpenAPI |
| `BusinessError` → 统一错误体 | `app.setErrorHandler` |
| 手写 router 匹配 | `app.route({ method, url })` |
| `server.close()` | `await app.close()` |

```ts
// server/routes/projects.routes.ts
app.route({
  method: 'GET',
  url: '/dsh-teamwork/v1/projects',
  config: { auth: 'signed' },                    // ← TS 版 @AuthTokenCheck
  schema: { querystring: ProjectListQuery, response: { 200: PageProject, 400: ErrorBody } },
  handler: listProjectsController,
})
```

**为什么不是别的**

| 候选 | 不选的理由 |
|---|---|
| **NestJS** | DI + decorator + RxJS 换来「强分层纪律」，我们用目录 + 三条铁律已拿到；decorator 元数据还让 ESM 打包变绕 |
| **Hono** | 更轻，但没有 schema 校验/OpenAPI/内置结构化日志，配齐就是"穷人版 Fastify"；它擅长的 edge 不是我们的形态 |
| **Express 5** | 无 schema、无类型化钩子，鉴权要层层手拼 |
| **AdonisJS** | 自带 ORM（我们不引 ORM） |
| **tRPC** | **违反「服务端可替换」**：其它语言实现不了，出局 |

**边界（选了框架也不许越的线）**

1. **不引 ORM**：`node:sqlite` + 裸 SQL + mapper 层，保持可审计
2. **不引 DI 容器**：`container.ts` 手工装配，类型即接线图
3. **不把框架概念漏进 service/mapper**：`FastifyRequest` 只允许出现在 `controller` 与 `hooks`
4. **同步 SQLite 仍在 event loop 上**：框架不改变这件事；独立进程 + 单机 + 微秒级可接受，但**禁止**在 handler 里做大目录 `readdirSync` 之类重同步 IO

---

## 3. 运行形态与生命周期

### 3.1 目录布局

```
$DSH_TEAMWORK_HOME  (默认 ~/.dsh/storages/teamwork)
├── .credentials.json        ← SDK 客户端凭据（AES-GCM 信封，见 SDK 文档 §3）
├── .credentials.key         ← SDK 客户端密钥（0600）
└── server/                 ← 服务端 dataDir（--data-dir，默认同级 server/）
    ├── teamwork.db         (+ teamwork.db-wal / -shm)
    ├── files/<fileId>      附件实体（内容寻址以外的 UUID 命名）
    ├── config.json         服务端配置（§3.2.1；自动拉起时的设置点）
    ├── run/server.json     单实例锁：{ pid, host, port, startedAt, version, shutdownToken }
    └── logs/server.log     仅 --log-file 时写；默认 stdout（JSON Lines）
```

> SDK 与服务端在同一台机器时共用 `$DSH_TEAMWORK_HOME` 父目录但**互不覆盖**：
> 客户端只写两个点号文件，服务端只写 `server/` 子树（含 `config.json`）。

### 3.2 配置

**优先级：CLI flag > 环境变量 > 配置文件 > 默认值**（后者被前者覆盖）。

```
① dsh-teamwork serve --port 4000            ← 最高
② DSH_TEAMWORK_PORT=4000 dsh-teamwork serve
③ <dataDir>/config.json 的 "port": 4000   ← 自动拉起时的主要设置点
④ 内置默认值
```

#### 3.2.1 配置文件（自动拉起时唯一能改的地方）

服务通常由 `dsh-teamwork ensure` 或 DSH 的 launcher 插件拉起，**没有命令行可加 flag** —— 所以配置文件是必要的一层。

| 项 | 值 |
|---|---|
| 默认路径 | `<dataDir>/config.json`（即 `~/.dsh/storages/teamwork/server/config.json`） |
| 覆盖路径 | `--config <path>` 或 `DSH_TEAMWORK_CONFIG` |
| 格式 | JSON（允许 `//` 注释，加载时先剥离） |
| 缺失 | 视为空配置，全部走默认值（不报错） |
| 未知键 | **报错退出**（fail-loud，防拼错静默失效） |
| 类型错误 | 报错退出 |
| 热重载 | **不支持**；改完需要 `dsh-teamwork ensure`（会检测并优雅重启） |

```jsonc
// ~/.dsh/storages/teamwork/server/config.json
{
  "host": "127.0.0.1",
  "port": 3939,
  "tokenTtlDays": 3,
  "maxUploadMb": 64,
  "shutdownGraceMs": 5000,
  "startTimeoutMs": 10000,
  "registration": "open",          // open | code | closed
  "registrationCode": null,        // ← 建议留 null，用环境变量提供（见下）
  "privateMemberLimit": 5,
  "authCacheTtlMs": 60000,
  "logLevel": "info"
}
```

> ⚠️ `registrationCode` 是机密：**优先用 `DSH_TEAMWORK_REGISTRATION_CODE` 环境变量**，配置文件里留 `null`。
> 配置文件落在 dataDir 里（`0600`），但别把密钥写进会被备份/共享的位置。

#### 3.2.2 参数表（flag 与 env 一一对应）

| flag | env | 默认 | 说明 |
|---|---|---|---|
| `--host` | `DSH_TEAMWORK_HOST` | `127.0.0.1` | **只接受回环**（127.0.0.1 / ::1 / localhost）；`0.0.0.0`、局域网 IP、域名一律**启动即失败**（见 §9.0） |
| `--port` | `DSH_TEAMWORK_PORT` | `3939` | |
| `--data-dir` | `DSH_TEAMWORK_DATA` | `~/.dsh/storages/teamwork/server` | |
| `--config` | `DSH_TEAMWORK_CONFIG` | `<dataDir>/config.json` | 配置文件路径（随 `--data-dir` 走） |
| `--token-ttl-days` | `DSH_TEAMWORK_TOKEN_TTL_DAYS` | `3` | token 有效期；到期后必须重新登录 |
| `--max-upload-mb` | `DSH_TEAMWORK_MAX_UPLOAD_MB` | `64` | 附件单文件上限 |
| `--shutdown-grace` | `DSH_TEAMWORK_SHUTDOWN_GRACE_MS` | `5000` | 优雅停机等待在飞请求的上限 |
| `--start-timeout` | `DSH_TEAMWORK_START_TIMEOUT_MS` | `10000` | `ensure` 拉起后等待 `/health` 就绪的上限 |
| `--registration` | `DSH_TEAMWORK_REGISTRATION` | `open` | `open`（谁都能注册，落 `user`）/ `code`（须带 `X-Registration-Code`）/ `closed`（只能 administrator 建号） |
| `--registration-code` | `DSH_TEAMWORK_REGISTRATION_CODE` | — | `--registration=code` 时必填 |
| `--private-member-limit` | `DSH_TEAMWORK_PRIVATE_MEMBER_LIMIT` | `5` | `private` 项目成员上限（跨行约束，service 层 + 事务强制） |
| `--auth-cache-ttl` | `DSH_TEAMWORK_AUTH_CACHE_TTL_MS` | `60000` | 鉴权结果缓存 TTL（`0` = 关闭，§4.6） |
| `--log-level` | `DSH_TEAMWORK_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `--log-file` | `DSH_TEAMWORK_LOG_FILE` | 空（stdout） | 写文件时使用的路径 |
| `--detach`（仅 bin） | — | `false` | 后台启动并返回 pid |

**launcher 插件怎么把这些传下去**：它的 Config 就是上表的一个子集（`port`/`dataDir`/`startTimeoutMs`/`stopOnDispose` 等），
spawn 时映射成 flag 传给 `dsh-teamwork serve`；**两边都改时以 flag 为准**（因为 flag 优先级最高）。
若你不想在插件里重复配一遍，就别配 —— 服务自己会读 `<dataDir>/config.json`。

### 3.3 单实例锁

`run/server.json` 用 **`fs.open(path, 'wx')` 独占创建**写入；内容含随机 `shutdownToken`（32B base64url）。
启动时：

```
1. 读 run/server.json
   ├─ 不存在                                → 正常启动
   ├─ pid 不存在（进程已死）                 → stale 锁，覆盖后正常启动
   └─ pid 存活 且 GET /health 500ms 内 200   → 已在运行
        ├─ 无 --force → 退出码 3，提示 "already running (pid=..., port=...)"
        └─ 有 --force → 走 §3.5 优雅停机流程，再启动
```

进程正常退出（含 SIGINT/SIGTERM）**必须删除锁文件**（`finally` 里做，非 `process.on('exit')` 唯一依赖）。

### 3.4 优雅停机：唯一通道是 `POST /admin/shutdown`

**决策：正常退出/重启**只走 HTTP 停机路径，不靠信号。原因：Windows 上 detached 子进程收不到可靠的 SIGTERM，
而 HTTP 请求是**跨平台确定**的；且停机逻辑能在进程内跑完（checkpoint、关库、删锁）。

```http
POST /dsh-teamwork/v1/admin/shutdown
X-Shutdown-Token: <run/server.json 里的 shutdownToken，32B 随机，0600>

→ 202 { "ok": true, "stopping": true, "pid": 12345 }
```

| 项 | 规则 |
|---|---|
| 鉴权 | `X-Shutdown-Token`（只从锁文件读，**不接受 query 参数**——防日志泄露）**且**来源必须是回环地址；或 administrator 签名头。两条任选 |
| 幂等 | 重复调用返回 `202 { ok:true, alreadyStopping:true }`，**不重复执行停机** |
| 为什么不用管理员账号 | `bin stop` 必须能在**没有登录态**时停服务 |
| 响应方式 | **先回 202 再异步停**（不能等停完了再回，否则调用方拿不到响应） |
| 停止期间 | `/health` 立刻返回 `503 { stopping: true }`，业务接口也 503，让调用方停止投递 |

**停机序列（同一函数，/shutdown、SIGINT、`bin stop` 全走它）**

```
1. 置 stopping=true（幂等锁）→ /health 与业务接口开始返回 503
2. await app.close()           // 停止 accept 新连接
   ├─ 空闲 keep-alive 连接：Node ≥19 的 close() 会自动关掉，不阻塞（实测 1.2s 内完成）
   └─ 在飞请求（如正在流式下载附件）：会无限阻塞 close()（实测 1.5s 仍未完成）
3. grace 超时（--shutdown-grace，默认 5s）后强制 closeAllConnections()（实测 100ms 内完成）
4. PRAGMA wal_checkpoint(TRUNCATE) → db.close()
5. 删除 run/server.json
6. process.exit(0)
```

**三条实测结论（决定了上面为什么这么写）**

| 现象 | 实测结果 | 设计含义 |
|---|---|---|
| 空闲 keep-alive 连接是否阻塞 `close()` | **不阻塞**（1.2s 内完成） | 不需要为了"空闲连接"加复杂逻辑 |
| **在飞请求**是否阻塞 `close()` | **无限阻塞**（1.5s 仍未完成） | **必须有 grace 超时 + `closeAllConnections()`**，否则 restart 永远挂住 |
| 关闭后立刻重绑同一端口 | **成功，无 `EADDRINUSE`** | restart 不需要额外 sleep，但**必须等 `app.close()` resolve** |

**退出路径唯一性（硬规则）**

| 正常退出 | 异常退出 |
|---|---|
| `/shutdown`、前台 `SIGINT`、`bin stop`/`restart` | 未捕获异常 / 未处理 reject |

- 异常路径也**先跑同一套清理**（置 stopping → 删锁 → 尽力 checkpoint）再 `exit(1)`；
  `uncaughtException` / `unhandledRejection` 必须挂监听，**不许裸崩**（否则锁文件残留、DB 未 checkpoint）
- 任何退出前都删 `run/server.json`；删不掉也要日志告警（下次启动会按 stale 锁自愈）

### 3.5 `bin` 命令

| 命令 | 行为 |
|---|---|
| `dsh-teamwork start [flags]` | 前台运行；`--detach` 后台（spawn 自身 + 写 pid，等待 `/health` 就绪后返回） |
| `dsh-teamwork stop` | 读锁 → `POST /admin/shutdown` → 轮询直到**连接被拒**（不是只看 pid）→ 兜底见下表 |
| `dsh-teamwork restart [flags]` | `stop` 成功后 `start`（**这就是需求里的「优雅终止旧进程再重启」**） |
| `dsh-teamwork status` | 打印 `{running, pid, host, port, version, uptime, db}`；未运行退出码 3 |
| `dsh-teamwork doctor` | 自检：node 版本、dataDir 可写、DB 可打开、`PRAGMA integrity_check`、端口可用、SDK 凭据可解（若存在） |
| **`dsh-teamwork ensure`** | **幂等**：没跑就起、已在跑就复用、版本不一致就优雅重启。给脚本/CI/DSH 插件用（§3.7）。退出码：`0`=已在跑或拉起成功；`2`=拉起失败 |

`restart` 的关键细节：**不要**直接 `kill` 旧进程再立刻 bind，否则 `EADDRINUSE`。
必须等端口真正释放（`app.close()` resolve + 连接被拒）再起新进程；等待上限 10s，超时给出明确报错而不是静默重试。

**`stop` / `restart` 的失败矩阵（都要显式处理，不许静默重试）**

| 症状 | 判定 | 动作 |
|---|---|---|
| 返回 `401/403` | 锁里的 `shutdownToken` 过期（服务已重启过） | **重读锁**再试**一次**；仍失败则报错 |
| `ECONNREFUSED` / 连接被拒 | 已经停了 | 视为**成功**（幂等） |
| 202 但 10s 内仍未释放端口 | 进程卡在停机里 | **兜底 kill**：POSIX `kill(-pid, SIGTERM)` → 等 5s → `SIGKILL`；Windows `taskkill /PID <pid> /T /F`；记录日志 |
| 兜底后端口仍被占 | 有别的进程占着该端口 | **报错，不启动新进程**（绝不在不确定的情况下起第二个） |
| 新进程 10s 内 `/health` 不就绪 | 启动失败 | 报错 + 保留日志路径 + 删锁（下次可自愈） |

**重启的原子性**：`restart` = 确认停机（端口被拒）→ 启动 → 确认 `/health` 就绪。
任一步失败**立即中止并报错**，绝不并行起两个实例（单实例锁是第二道保险，不是第一道）。

### 3.6 运行环境支持矩阵（`node:sqlite` 能不能用）

| 运行环境 | `node:sqlite` | `node:worker_threads` | 本服务 |
|---|---|---|---|
| 本机 Node ≥ 22.5（独立进程 / CLI） | ✅ | ✅ | ✅ **主形态** |
| DSH **Node host**（普通插件宿主进程） | ✅ | ✅ | ✅ 可内嵌 |
| DSH **webworker runtime**（浏览器/Worker 那套） | ❌ **mock，调用即抛** | ❌ **mock** | ❌ **禁止** |

证据（DSH 0.2.0-rc.2 源码）：

```
packages/experimental/webworker-runtime/src/module-proxies.ts:68
    'node:sqlite': './node/builtin_modules/mock/sqlite.ts',
    （同表第 67 行：'node:worker_threads': './node/builtin_modules/mock/worker_threads.ts'）

packages/experimental/webworker-runtime/src/node/builtin_modules/mock/sqlite.ts:11
    export const DatabaseSync = notImplementedFail(MODULE, 'DatabaseSync')
```

该 runtime 仅被 `@deepseek-ai/dsh-experimental-webworker-packer` 依赖（浏览器侧），**不是** Node 宿主的插件执行环境。
本机 Node 24.19 实测：`node:sqlite` 直接可用（无需 `--experimental-sqlite`），worker 线程内同样可用。

> **硬约束**：teamwork server 永远不得运行在 webworker runtime 里。这也是选择「独立进程」的第二个理由（第一个是 `node:sqlite` 只有同步 API）。

### 3.7 自动拉起：`ensure` + launcher 插件

目标：**插件加载时自动把服务拉起来，不需要人手工敲命令**；同时脚本/CI 也能用同一条命令。

#### ① `ensure` 的状态机（幂等）

```
读 run/server.json
 ├─ 无锁 / pid 已死                  → spawn 新进程 → 轮询 /health（200ms × 50，上限 10s）
 ├─ /health 通 且 /version 一致      → 直接复用（exit 0）
 ├─ /health 通 但 /version 不一致    → 优雅停机（POST /admin/shutdown）→ 等端口释放（≤10s）→ spawn
 └─ 有锁但 /health 不通（僵死）      → 视为 stale → 覆盖锁 → spawn
```

- 健康探测：`GET /health`，单次超时 300 ms、最多 3 次重试 → 判定"在跑 / 没在跑"
- 拉起后轮询：`200 ms` 间隔、最多 `10 s`（`--start-timeout`），**每次 `timer.unref()`**，纯一次性有界轮询
- 版本不一致才重启，避免"每次加载插件都重启服务"

#### ② launcher 插件（极薄，只 spawn 不托管）

```ts
// dsh-teamwork-launcher/src/index.ts
export const name = 'dsh-teamwork-launcher'
export const inject = []                       // 不需要任何 service
export const Config = z.object({               // Schemastery + .i18n()
  autoStart:     z.boolean().default(true),
  baseUrl:       z.string().default('http://127.0.0.1:3939/dsh-teamwork/v1'),
  port:          z.number().default(3939),
  dataDir:       z.string().default(''),
  startTimeoutMs: z.number().default(10_000),
  stopOnDispose: z.boolean().default(false),
})

export function apply(ctx: Context, config: Config): void {
  if (!config.autoStart) return

  // ① 异步拉起，不阻塞插件加载（不 await 到健康）
  const ready = ensureServer(config)           // spawn detached + 轮询 /health

  // ② 失败只告警，绝不 throw —— 抛异常会让整个 profile 启动失败
  void ready.then(
    (info) => ctx.logger.info('teamwork ready: pid=%d port=%d version=%s', info.pid, info.port, info.version),
    (err)  => ctx.logger.warn('teamwork unavailable: %s', err.message),
  )

  // ③ 清理：默认不停服（插件热重载不该杀掉共享服务）
  ctx.effect(() => () => {
    if (config.stopOnDispose) void stopServer(config)   // 走 /admin/shutdown
  })
}
```

#### ③ 七个必须做对的细节

| # | 点 | 做法 | 不这么做会怎样 |
|---|---|---|---|
| 1 | 父进程退出后服务仍活着 | `spawn(process.execPath, [cliEntry,'serve',...], { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true }).unref()` | dsh 退出时把服务一起带走 |
| 2 | **Windows 停服** | 走 `POST /admin/shutdown`（本地 `shutdownToken`），**不要** `process.kill(-pid)` | Windows 不支持负 pid，`kill(-pid)` 直接失败 |
| 3 | POSIX 兜底 | 进程组 kill（DSH 的 `ptc-runtime-python` 就是 `detached:true` + `kill(-pid, sig)`） | 僵尸进程占端口 |
| 4 | 子进程日志 | `stdio` 指向 `dataDir/logs/server.log` 的 fd | 继承父管道，父进程退出后子进程写日志 EPIPE |
| 5 | 启动轮询 | 一次性有界（≤10s / 200ms），`timer.unref()` | 违反「禁长连接/禁 SSE」，也可能挂住宿主 |
| 6 | 并发加载 | 两个 dsh 实例同时 `ensure` → 靠锁文件 `wx` 独占 + `start` 退出码 `3`（已在跑） | 起两个实例抢端口 |
| 7 | 加载失败 | `ctx.logger.warn` + 标记不可用，**不 throw** | profile 启动失败（fail-loud 的代价太大） |

#### ④ 包边界（launcher 单独成包）

launcher 需要 `@deepseek-ai/cordis` 等 peer，而主包给普通 SDK 用户用，不该被迫装 cordis：

| 包 | 内容 | 依赖 |
|---|---|---|
| `@meiyukichan/dsh-teamwork` | SDK（`.`）+ 服务端（`./server`）+ `bin` | `fastify`、`@sinclair/typebox` |
| `@meiyukichan/dsh-teamwork-launcher` | Cordis 插件：`apply(ctx)` 里调 `ensure`（约 80 行） | `@deepseek-ai/cordis` 等 peer + `dsh-teamwork` |

- 两者同处一个 pnpm workspace，各自 `lib/`、各自 `cordis.patch.yml`（launcher 用 `insert` 挂进 profile，`insert.name` 必须等于其 `package.json.name`）
- launcher **不启动 HTTP、不碰 DB**，只 spawn 系统进程 → 天然避开 §3.6 的 webworker runtime 限制

---

## 4. 鉴权设计

### 4.1 账号（模块 1）

> 表结构与全部决策细节见 [`db-design.zh.md`](./db-design.zh.md) §3.1（含 §3.1.1 决策记录）。

| 项 | 规则 |
|---|---|
| `accountId` | `^[A-Za-z0-9@_-]{3,64}$`（用户的字符集要求）；**注册后不可改**；**严格区分大小写**（`Alice` ≠ `alice`）；**字符集不含 `:`**（见下「哈希公式」的分隔符约束） |
| `password` | 长度 **12..128**（因放弃 KDF，长度是主要防线）；**拒绝首尾空白**；拒绝内置弱口令表；不做复杂度强制 |
| 传输编码 | 请求体里的 `password` / `oldPassword` / `newPassword` **一律 base64**（解码后才是明文；日志必须打码），见 api-design §0.3 |
| 哈希 | **`account_token = SHA256(utf8(account_id + ":" + 明文))`，小写 hex 64 字符**（db-design §3.1.0） |
| 校验 | 按 `account_id` 取行 → 本地算哈希 → **`timingSafeEqual`** 比对；**禁止**用 `WHERE account_token = ?` 判定登录（pass-the-hash） |
| 首个用户 | 注册成功的**第一个**账号 `global_role='administrator'`（在 `BEGIN IMMEDIATE` 事务里判 `COUNT(*)=0`，否则并发注册会出两个 administrator） |
| 状态 | `active` / `disabled`；`disabled` 登录返回 403 且已有 token 全部失效（校验时联查 account.status） |
| 登录成功 | 写 `last_login_at`（**写失败不影响登录**） |
| 忘记密码 | **仅管理员重置**（`POST /admin/accounts/{accountId}/password`），成功后吊销该账号全部 token；无邮件/验证码流程 |
| 失败锁定 | **不做 DB 层锁定**（不加 `failed_login_count` / `locked_until`），防线全在内存限流 + 300ms 失败延迟（§4.4） |

**登录校验的分层落点**（完整骨架见 §2.3，此处只列「必须做对」的 5 条）：

| # | 必须做对 | 做错的后果 |
|---|---|---|
| 1 | 按 `account_id` 取行（`AccountMapper.findByAccountId`） | 若按 `account_token` 查 → pass-the-hash，DB 泄露即可登录 |
| 2 | 用**行里存的** `account_id` 参与哈希 | 与注册时的字符串有任何字节差异 → 永远登不上 |
| 3 | `timingSafeEqual` 常量时间比较（`PasswordEncoder.verify`） | `===` 会按前缀提前返回，可测出匹配长度 |
| 4 | 账号不存在时也走一次 `DUMMY_HASH` 等量计算 | 响应快 = 账号不存在 → 白送账号枚举接口 |
| 5 | 错误码统一 `invalid_credentials`（401） | 分开报"账号不存在/密码错" → 泄露账号是否存在 |

```ts
// service 里就是这个形状（详见 §2.3 ④）
const row = this.accounts.findByAccountId(dto.accountId)
const passwordOk = this.encoder.verify(row ? row.accountHash : DUMMY_HASH,
                                      row ? row.accountId : dto.accountId,
                                      dto.password)
if (!row || !passwordOk) throw new BusinessError('invalid_credentials', 401)
```

### 4.2 鉴权：无状态 `auth_token`（**没有会话表**）

> **需求方决定：不要 `dsh_teamwork_account_token` 表。** token 由客户端用「本账号的 `account_token` 作 HMAC 密钥」自己签，
> 服务端只做**无状态校验**：查一行账号 → 验签 → 校验 `exp`。没有签发记录、没有清理任务、没有心跳写盘。
> 库表依据见 [`db-design.zh.md`](./db-design.zh.md) §3.2。

**请求头（协议固定）**

```http
dsh-teamwork-token:   <auth_token>     ← HS256 JWT，三段式
dsh-teamwork-account: <account_id>
```

**token 结构**

```
header  = { "alg": "HS256", "typ": "JWT" }                            → base64url
payload = { "a": account_id, "ip": <签发时客户端 IP>, "iat": <ms>, "exp": <ms> }
signature = HMAC-SHA256( key = account.account_token, data = header + "." + payload ) → base64url
auth_token = header + "." + payload + "." + signature
```

实测：`alice` 的 token 173 字符，payload 明文为 `{"a":"alice","ip":"10.1.2.3","iat":...,"exp":...}`。

**服务端校验顺序（缺一不可）**

| # | 步骤 | 失败码 |
|---|---|---|
| 1 | 两个 header 必须都在 | `unauthorized` (401) |
| 2 | `SELECT account_token, status FROM dsh_teamwork_account WHERE account_id = ?`（header 里的账号） | `unauthorized` |
| 3 | 用该行 `account_token` 验 HMAC，**常量时间比较** | `unauthorized` |
| 4 | `payload.a === header 里的 account_id`（绑定，防串号） | `unauthorized` |
| 5 | `payload.exp > now` | `expired` (401) |
| 6 | **`payload.exp <= now + TTL(3天) + 60s`**（服务端封顶，见护栏 2） | `exp_too_long` (401) |
| 7 | `status === 'active'` | `account_disabled` (403) |
| 8 | （可选，默认关）`payload.ip === 本次请求 IP` | `ip_mismatch` (401) |

实测成本：**10.38 µs/次**（含查库 + HMAC + JSON 解析，20k 次平均）。

**三条护栏（不加就是洞，实现必须写死）**

| # | 护栏 | 不加的后果 |
|---|---|---|
| 1 | `account_token` **绝不进 payload**，只作 HMAC **密钥** | payload 是 base64 明文可读，密钥进 payload = 谁看见 token 谁能伪造 |
| 2 | 服务端强制 `exp <= now + TTL + 60s` | `exp` 由**客户端**填，不封顶等于「有效期用户自己定」 |
| 3 | 必须校验 `status='active'` | 管理员禁用账号后，旧 token 照样能用 |

**语义变化（相对有会话表的方案）**

| 项 | 变化 |
|---|---|
| 有效期 | 仍是 **3 天**，但由 token 内的 `exp` 自校验；过期后 SDK **重新签**一个（不需要再输密码） |
| 登出 | `POST /auth/logout` 只清本地 `.credentials.json`；**服务端无法单点作废** |
| 单设备吊销 | ❌ 没有。要作废就**改密码**（`account_token` 变 ⇒ 全部旧 token 立刻失效） |
| 设备列表 | ❌ 没有（原 `created_ip` / `user_agent` / `last_used_at` 观测随表一起取消） |
| 改密码 / 管理员重置 | 更新 `account_token` ⇒ **该账号所有旧 token 立即失效**（这是唯一的全局吊销手段） |

**已知风险（需求方知情后选定，完整清单见 db-design §3.2.2）**

- **DB 泄露 = 可伪造任意账号的 token**：签名密钥就存在 `account.account_token` 里
- **本地 json 存 `account_token` = 存密码等价物**：能读文件就能反复签新 token（每次 ≤3 天，但可续签 ⇒ 实际永久）
- **「3 天过期」只约束「拿到某一次 auth_token 的人」**，不约束持密钥者

**登录响应（客户端靠它拿到签名密钥）**

```json
// POST /auth/login  → 200
{ "account": { "accountId": "alice", "displayName": "Alice", "globalRole": "user" },
  "accountToken": "5e60415360c7…（64 hex）",
  "ttlSeconds": 259200 }
```

> `accountToken` 在响应里回传是**需求方明确要求**；因此它必须按**密码级机密**对待：
> 不进日志、不进错误详情、不进任何其它接口的响应。

### 4.3 授权三层（不要混）

| 层 | 表 | 决定什么 |
|---|---|---|
| 全局角色 | `dsh_teamwork_account.global_role`（`administrator` / `leader` / `user`） | 能否建**正式**项目、能否调 `/admin/*` |
| 项目内角色 | `dsh_teamwork_project_member.role`（`owner` / `creator` / `manager` / `member`） | 在这个项目里能管什么 |
| 资源归属 | 各表的 `account_id` / `assignee` / `assigner` | 能否读写这一行 |

三条铁律：

1. **身份只来自 token**。接口**不再接受** `?user_id=`；需要查他人数据时用 `?accountId=` 且**仅 administrator 可用**。
这是鉴权设计上最关键的一条：**身份只能来自签名头，不能来自请求参数**。
2. `visibility` 仍然**只是标签**，不参与任何过滤与判定（保持旧语义，别偷偷加意义）。
3. `administrator` 可以绕过项目内角色，但**不能**绕过「账号必须 active」。

### 4.4 限流与失败延迟（不做 DB 锁定的补偿）

决策 A-2 放弃持久化登录锁定，所以**所有防爆破能力都在这一节**，参数故意收紧：

| 通道 | 限额 |
|---|---|
| `/auth/register`、`/auth/login`、`PUT /auth/password` | 每 IP **10 次/分钟** |
| 同上（按账号） | 每 `accountId` **5 次/分钟** + **30 次/小时** |
| 超限响应 | 429 + `Retry-After`（秒） |
| 失败延迟 | 密码错误 / 账号不存在统一 **`await sleep(300ms)`** 后再响应 —— 抑制爆破吞吐，正常用户无感 |
| 统一错误 | 两种情况**同 code、同 message、同延迟**，不泄露账号是否存在 |
| 计数存储 | 内存 `Map` + 每 60s 清理过期桶；**进程重启即清零（明确接受）** |

> 若日后需要「抗重启爆破」，补 `failed_login_count` + `locked_until` 两列即可（db-design §3.1.1 A-2 留了位置）。

### 4.5 鉴权的落点：路由声明 + 集中 guard（TS 版的 `@AuthTokenCheck`）

**TS 没有注解**，鉴权级别只能声明式表达。两条路：

| 方案 | 结论 |
|---|---|
| TS 装饰器（`@RequireAuth`） | ❌ 不用。要开 `experimentalDecorators`；装饰器**不能表达异步预检**（我们每次鉴权都要查一行 DB）；错误处理与返回值的耦合很差；堆栈不可读；测试要搞反射 |
| **路由元数据 + 集中 guard** | ✅ **采用**。`auth: 'signed'` 写在路由表里，由 router 在执行 handler 前统一跑，等同于注解且更显式 |

**路由表就是注解表**（`auth` 是**必填**字段，漏写直接编译不过）：

```ts
// server/http/route.ts
export type AuthLevel = 'public' | 'signed' | 'admin' | 'local'   // 级别名 `admin` ≡ globalRole === 'administrator'

interface Base { method: 'GET'|'POST'|'PUT'|'DELETE'; path: string }

// 类型上就把「public 路由没有 account」「signed 路由 account 必在」钉死
export type Route =
  | (Base & { auth: 'public'; handler: (req: IncomingMessage, res: ServerResponse, ctx: AnonymousContext) => Promise<void> })
  | (Base & { auth: 'signed' | 'admin' | 'local'; handler: (req: IncomingMessage, res: ServerResponse, ctx: AuthenticatedContext) => Promise<void> })

export interface AnonymousContext    { requestId: string; ip: string; account: null }
export interface AuthenticatedContext{ requestId: string; ip: string; account: { accountId: string; role: 'administrator'|'leader'|'user' } }
```

**唯一的鉴权入口**（任何 handler 都不许自己解析 header；**返回完整用户信息**，不是只有 id）

一条查询就把鉴权要的东西全查齐（账号 + 角色 + 签名密钥）。`whitelist` 合并进 `account` 后**是单表查询**，不再有 `LEFT JOIN` 与 `COALESCE`：

```ts
// server/modules/auth/auth.mapper.ts
export interface AuthRow {
  accountId: string
  displayName: string | null
  status: 'active' | 'disabled'
  accountToken: string
  globalRole: 'administrator' | 'leader' | 'user'
}

// 单表 + 唯一索引命中（合并 whitelist 前是 1.85 µs 的两表 JOIN）
const SQL_FIND_FOR_AUTH = `
  SELECT account_id   AS accountId,
         display_name AS displayName,
         status       AS status,
         account_token AS accountToken,
         global_role   AS globalRole
    FROM dsh_teamwork_account
   WHERE account_id = ?`
```

```ts
// server/modules/auth/authenticate.ts —— 全项目唯一的鉴权实现
export interface CurrentUser {
  accountId: string
  displayName: string | null
  globalRole: 'administrator' | 'leader' | 'user'
  status: 'active' | 'disabled'
}

export interface AuthResult {
  user: CurrentUser                                   // ← 业务直接用的用户信息
  token: { issuedAt: number; expiresAt: number; ip: string | null }   // ← 审计/日志用
}

export function authenticate(req: IncomingMessage, deps: Deps, now = Date.now()): AuthResult {
  const authToken = readHeader(req, 'dsh-teamwork-token')
  const accountId = readHeader(req, 'dsh-teamwork-account')
  if (!authToken || !accountId) throw new BusinessError('unauthorized', 401)

  const row = deps.authMapper.findForAuth(accountId)        // 一条 JOIN（上面那条 SQL）
  if (!row) throw new BusinessError('unauthorized', 401)

  const claims = verifyAuthToken({                            // 验签 + 时间校验，返回 payload
    authToken, accountId, key: row.accountToken, now,
    ttlMs: deps.config.tokenTtlMs, skewMs: 60_000,
  })                                                          // 失败抛 unauthorized / expired / exp_too_long

  if (row.status !== 'active') throw new BusinessError('account_disabled', 403)

  return {
    user: { accountId: row.accountId, displayName: row.displayName,
            globalRole: row.globalRole, status: row.status },
    token: { issuedAt: claims.iat, expiresAt: claims.exp, ip: claims.ip ?? null },
  }
}
```

**guard 由 Fastify 的 `onRequest` 钩子统一执行**（不是每个 handler 自己判）：

```ts
// server/hooks/auth.hook.ts —— 全项目唯一的鉴权落点
export function registerAuthHook(app: FastifyInstance, deps: Deps): void {
  app.addHook('onRequest', async (req) => {
    const level = (req.routeOptions.config as { auth?: AuthLevel }).auth
    if (!level) throw new Error(`route ${req.url} 缺少 config.auth`)   // 启动期就该被 §4.5 保险 1 挡住

    req.ctx = { requestId: req.id, ip: req.ip, user: null, token: null }
    if (level === 'public') return

    // 停机接口：本地回环 + shutdownToken，或 administrator 签名头
    if (level === 'local' && isLoopback(req.ip) &&
        headerEquals(req, 'x-shutdown-token', deps.lock.shutdownToken)) {
      req.ctx.user = { accountId: '__local__', displayName: null, globalRole: 'administrator', status: 'active' }
      return
    }

    const { user, token } = authenticateHeaders(req.headers, deps)   // 抛 unauthorized / account_disabled
    if (level === 'admin' && user.globalRole !== 'administrator') throw new BusinessError('forbidden', 403)
    req.ctx.user = user
    req.ctx.token = token
  })
}
```

> `req.ctx` 用 `declare module 'fastify'` 扩展类型；`controller` 里 `req.ctx.user` 在 `signed`/`admin` 路由上类型收窄为非空。

**对应的路由声明**（与 §5 的「鉴权」列一一对应）：

```ts
{ method: 'POST', url: '/dsh-teamwork/v1/auth/login',      config: { auth: 'public' }, handler: loginController },
{ method: 'GET',  url: '/dsh-teamwork/v1/projects',        config: { auth: 'signed' }, handler: listProjectsController },
  { method: 'PUT', url: '/dsh-teamwork/v1/admin/accounts/:accountId/role', config: { auth: 'administrator' }, handler: setRoleController },
{ method: 'POST', url: '/dsh-teamwork/v1/admin/shutdown',  config: { auth: 'local'  }, handler: shutdownController },
```

**handler 里长这样**（零鉴权代码，`ctx.user` 类型上必存在且信息完整）：

```ts
export const listProjectsController: RouteHandler = async (req, reply) => {
  // ctx.user = { accountId, displayName, globalRole, status }
  const result = deps.services.projects.list(req.ctx.user!, req.query as ProjectListQuery)
  return reply.code(200).send(result)
}
```

**`ctx.user` 与 `GET /auth/me` 返回同一个形状**（`CurrentUser`），避免两套用户 DTO：

```jsonc
// GET /dsh-teamwork/v1/auth/me  → 200，就是 ctx.user
{ "accountId": "alice", "displayName": "Alice", "globalRole": "administrator", "status": "active" }
```

### 4.5.1 业务层直接可用的三件东西

`CurrentUser` 是**领域对象**，不是"鉴权 DTO"。业务层拿到它就直接干活，**不再回头查库、不再自己拼 `accountId`**：

```ts
// shared/types.ts —— 全项目唯一的用户形状（server / sdk / 测试都用它）
export interface CurrentUser {
  accountId: string
  displayName: string | null
  globalRole: 'administrator' | 'leader' | 'user'
  status: 'active' | 'disabled'
}
```

**① 业务 service 的参数就收 `CurrentUser`**（不是 `string`）：

```ts
// server/modules/projects/project.service.ts
export class ProjectService {
  // 传 user 而不是 accountId：service 内部随时能拿到 role / displayName，不用再查
  list(user: CurrentUser, query: ProjectListQuery): Page<ProjectVo> { /* ... */ }
  create(user: CurrentUser, input: CreateProjectInput): number { /* 用 canCreateFormalProject(user) */ }
  detail(user: CurrentUser, projectId: number): ProjectDetailVo { /* ... */ }
}
```

**② 权限判定是纯函数**（`shared/permissions.ts`，零 IO、可单测、业务与 guard 共用）：

```ts
export const isAdministrator = (u: CurrentUser) => u.globalRole === 'administrator'

/** 规则：administrator / leader（全局）才能建 public（不限成员）项目；private 项目任何人可建 */
export const canCreateFormalProject = (u: CurrentUser) =>
  u.globalRole === 'administrator' || u.globalRole === 'leader'

/** 项目内角色判定（需要查 project_member，一次索引查 ~2 µs） */
export const canManageMembers = (memberRole: MemberRole | null, u: CurrentUser) =>
  isAdministrator(u) || memberRole === 'owner' || memberRole === 'creator' || memberRole === 'manager'
```

**③ handler 里一行拿到、一行传下去**（无鉴权代码、无二次查询）：

```ts
export const createProjectController: RouteHandler = async (req, reply) => {
  const input = req.body as CreateProjectInput      // TypeBox 已校验
  const id = services.projects.create(ctx.user, input)      // ← user 直接可用
  return reply.code(201).send({ id })
}
```

| 业务需要什么 | 从哪来 | 要不要额外查库 |
|---|---|---|
| 我是谁（`accountId` / `displayName`） | `ctx.user` | ❌ 鉴权时一条 JOIN 已带回 |
| 我是不是 administrator | `ctx.user.globalRole` 或 `isAdministrator(ctx.user)` | ❌ |
| 我能不能建正式项目 | `canCreateFormalProject(ctx.user)` | ❌ |
| 我在**某个项目**里的角色 | `projectMemberMapper.findRole(projectId, accountId)` | ✅ 一次（这是项目维度，不是用户维度，无法预取） |
| token 何时过期 / 从哪个 IP 来 | `ctx.token` | ❌ 来自 JWT payload |

> **刻意不预取的东西**：`project_member` 的角色**不**在鉴权时查。
> 原因：一个用户可能属于几十个项目，每请求全量取出是纯浪费；而单个项目的角色查询是一次唯一索引命中（`uk_tw_member`）。
> 这条边界写清楚，避免后来的人"顺手把它塞进鉴权 SQL"。

**三道保险**（防「新加接口忘了挂鉴权」）：

| # | 保险 |
|---|---|
| 1 | `auth` 是 `Route` 的**必填**字段 → 漏写编译失败 |
| 2 | 单测遍历 `ROUTES`，断言每条都有 `auth`，且 `/admin/*` 不得为 `public`/`signed`（必须 `admin` 或 `local`） |
| 3 | 静态检查：`handler` 文件里不许出现 `dsh-teamwork-token` 字面量（鉴权只能在 `authenticate.ts` 里解析 header） |

> **角色查询要不要缓存**：已经和账号查询合并成一条 JOIN（1.85 µs），**不再单独缓存** ——
> 缓存会带来「撤销 administrator 后还能用 N 秒」的窗口，不值。

### 4.6 鉴权结果缓存（opt-in，默认开）

**要不要缓存**：单看 CPU 不值得（完整校验 6.36 µs，缓存命中 1.04 µs，省 5 µs）。
**真正的理由是 DB 形态**：§7.0 的 worker 线程门面下，**每次查库要跨线程 ~350 µs**，
而鉴权是**每个请求一次**的固定开销 —— 缓存把它降到 1 µs，等于每请求省 350 µs。

| 路径 | 成本 | 说明 |
|---|---|---|
| 完整校验（查库 + HMAC + JSON 解析） | **6.36 µs**（DB 在进程内）/ **≈350 µs**（DB 在 worker） | 现在的实现 |
| 缓存命中（sha256 key + Map.get） | **1.04 µs** | 跳过查库、HMAC、JSON 解析 |

**缓存结构**

```ts
// server/modules/auth/auth-cache.ts
interface CacheEntry {
  accountId: string
  globalRole: GlobalRole
  exp: number          // token 自己的过期时间（不可越过）
  cachedUntil: number  // min(exp, now + ttl)
}

const cache = new Map<string, CacheEntry>()   // key = sha256hex(auth_token)
const MAX_ENTRIES = 4096                       // LRU 上界，约 0.8 MB
```

**写入/命中规则**

```
命中条件（全部满足才用缓存）：
  ① key 存在
  ② cachedUntil > now
  ③ entry.exp > now                 ← 绝不越过 token 自身过期
  ④ entry.accountId === header.accountId  ← 绑定校验，防串号

未命中 → 走 §4.5 的完整 authenticate() → 写缓存：
  cachedUntil = min(exp, now + --auth-cache-ttl)
  超过 MAX_ENTRIES → 淘汰最早写入的（Map 插入序即近似 LRU）
```

**失效策略（关键，决定安全性）**

| 触发 | 动作 |
|---|---|
| 改密码 / 管理员重置（`account_token` 变） | **`cache.clear()`** |
| 改全局角色（M4） | **`cache.clear()`** |
| 禁用 / 删除账号 | **`cache.clear()`** |
| `POST /auth/logout` | 删除该 token 对应的单条 |
| 其它 | 不失效，靠 TTL 兜底 |

> **为什么敢用 `clear()`**：这些都是低频写操作（一天可能几次），清空一个 Map 是 O(1)；
> 而进程是**单实例**——写和读在同一个进程里，所以「改完立刻生效」，不存在多进程的脏读。

**三条安全底线**

| # | 底线 | 不守的后果 |
|---|---|---|
| 1 | 缓存项**绝不越过 `exp`**（`cachedUntil ≤ exp`） | 过期 token 继续可用，3 天 TTL 形同虚设 |
| 2 | 命中时**必须校验 `accountId` 一致** | 换 header 里的账号就能冒用别人的缓存项 |
| 3 | **缓存失败结果**（负缓存） | 攻击者用随机 token 撑爆内存；现在不缓存失败，攻击者每次只花 6 µs（还有限流兜） |

**配置与可观测**

| 项 | 值 |
|---|---|
| `--auth-cache-ttl` | 默认 `60000` ms；`0` = 关闭（调试用） |
| `/health` | 增加 `authCache: { size, hits, misses, ttlMs }` |
| 测试 | ① 改角色后立刻生效（不睡 TTL） ② 过期 token 命中缓存也拒绝 ③ 换 accountId header 不复用缓存 ④ 4096 条后不再增长 |

> 默认**开**，但可以在 `--auth-cache-ttl 0` 下完全关掉；关闭后行为与 §4.5 的完整校验完全一致。

## 5. 路由总表（47 个端点）

统一前缀 `/dsh-teamwork/v1`。鉴权列：`公开` / `签名头`（`dsh-teamwork-token` + `dsh-teamwork-account`）/ `签名头+administrator` / `本地`（shutdown token）。

### 5.1 模块 A · 账号（6）

| # | 方法 | 路径 | 鉴权 | 说明 | 旧对应 |
|---|---|---|---|---|---|
`{accountId,password,displayName?}` → `{account, **accountToken**, ttlSeconds}`（`accountToken` 是客户端签名密钥，按密码级机密对待） | — |
| A2 | POST | `/auth/login` | 公开 | `{accountId,password}` → 同上（重新登录 = 拿回同一个 `accountToken`，签发的 `auth_token` 各自独立） | 无 |
| A3 | GET | `/auth/me` | 签名头 | 当前账号 + 全局角色（过期时间由客户端自己的 `exp` 决定，服务端不回） | 无 |
| A4 | POST | `/auth/logout` | 签名头 | **纯语义**（无会话可清）；客户端删本地即可，不必调用 | 无 |
| A5 | PUT | `/auth/password` | 签名头 | `{oldPassword,newPassword}` → 更新 `account_token`，**该账号所有旧 auth_token 立即失效** | 无 |
| A6 | GET | `/auth/accounts?accountId=` | 签名头+administrator | 查账号是否存在及其全局角色（旧 `/api/users/info` 的最小替代） | A.5 |

### 5.2 模块 B · 项目 / 成员 / 设备 / 工作区（16）

| # | 方法 | 路径 | 鉴权 | 说明 | 旧对应 |
|---|---|---|---|---|---|
| B1 | GET | `/projects` | 签名头 | 分页；administrator 全量，其他人只看**自己作为成员**的项目 | `GET /api/projects` |
| B2 | GET | `/projects/mine` | 签名头 | 我参与的项目（不分页，按 `updated_at DESC`） | `GET /api/projects/mine` |
| B3 | GET | `/projects/{id}` | 签名头 | 详情 + 成员数组；不存在 404 | `GET /api/projects/{id}` |
| B4 | POST | `/projects` | 签名头 | 建项目；`public` 要求创建人（即 owner）是 `administrator`/`leader`（密码 403 `public_project_requires_leader`）；`private` 任何人可建（成员上限 5），**创建人成为唯一 owner** | `POST /api/projects` |
| B5 | PUT | `/projects/{id}` | 签名头 | 动态 SET（`name`/`description`/`visibility`/`status`）；需**成员 `owner`** 或 `administrator`；`archived` 项目只允许改 `status`（还原） | `PUT /api/projects/{id}` |
| B6 | DELETE | `/projects/{id}` | 签名头 | **`administrator` 或成员 `owner`**（权限只看成员表的 `owner`） | `DELETE /api/projects/{id}` |
| B7 | GET | `/projects/{id}/members` | 签名头 | 成员列表（按 `joined_at ASC`） | `GET /api/internal/projects/{id}/members` |
| B8 | POST | `/projects/{id}/members` | 签名头 | 加/改成员；**`role` 只接受 `manager`/`member`**（传 `owner` → 400 `owner_role_not_assignable`）；项目内 `manager` 只能给 `member`；**private 满 5 人 → 409 `project_member_limit`**；加成员时校验账号存在 | `POST /api/projects/{id}/members` |
| B9 | DELETE | `/projects/{id}/members/{accountId}` | 签名头 | 移除成员；**不能移除 `owner`**（409 `owner_cannot_be_removed`，必须走 B10 转让）；项目内 `manager` 只能移除 `member` | `DELETE /api/projects/{id}/members/{memberId}` |
| B10 | PUT | `/projects/{id}/owner` | 签名头 | **转让 owner**：`{accountId}`；仅 **全局 `administrator`** 或**该项目当前 `owner`** 可调（否则 403）；`public` 项目要求目标是 `leader`/`administrator`（409 `owner_must_be_leader`）；同事务「先降原 owner 为 manager，再升新 owner」 | 新增 |
| B11 | POST | `/devices/batch` | 签名头 | 全量同步：先全标 `inactive`，再 upsert 回 `active` | `POST /api/devices/batch` |
| B12 | GET | `/devices?accountId=` | 签名头 | **只返 `active`**（在线设备）；不带 `accountId` 时查自己，带则查该账号（**任何登录用户可查**） | `GET /api/internal/devices` |
| B13 | GET | `/devices/mine` | 签名头 | **我的设备（分页，含 `inactive`）**；`ORDER BY last_active_at DESC` | `GET /api/devices/mine` |
| B14 | DELETE | `/devices/{id}` | 签名头 | 删除设备；**任何登录用户可删任意设备**（不做资源级鉴权）；不存在 404 | `DELETE /api/devices/{id}` |
 param($m) "| B$([int]$m.Groups[1].Value + 1) |"  GET | `/devices/mine` | 签名头 | 分页，**含 inactive** | `GET /api/devices/mine` |
 param($m) "| B$([int]$m.Groups[1].Value + 1) |"  GET | `/devices?accountId=` | 签名头 | **只返 active**；不带 `accountId` 时查自己，带则需 administrator | `GET /api/internal/devices` |
 param($m) "| B$([int]$m.Groups[1].Value + 1) |"  DELETE | `/devices/{id}` | 签名头 | 只能删自己的 | `DELETE /api/devices/{id}` |
| B15 | POST | `/device-workspaces` | 签名头 | 单条 upsert（`index`/`portal` 两种形状） | `POST /api/device-workspaces` |
| B16 | GET | `/device-workspaces` | 签名头 | 条件查询：`accountId`/`instance`/`type`（精确）+ `workspaceId`（精确）+ **`cwd`（精确）/ `cwdPrefix`（前缀，走范围索引）**；**不提供包含匹配**（`%x%` 会误命中 `proj-7`↔`proj-70`） | `GET /api/internal/device-workspaces` |

> B15 的跨账号可见性：跨实例派发必须能按 `cwd` 找到别人的工作区，所以**允许**返回他人的工作区肖像；
> 设备列表（B11/B12）同理：任何登录用户都能查任意账号。

### 5.3 模块 C · Issue（16）

| # | 方法 | 路径 | 鉴权 | 说明 | 旧对应 |
|---|---|---|---|---|---|
| C1 | POST | `/issues/batch` | 签名头 | 批量提交（按 `issueId` upsert）；**必填 `title`**（1..200）、可选 `projectId`/`detail`；传了 `projectId` 则校验项目存在 + 成员身份 + 未归档 | `POST /api/issues/batch` |
| C2 | GET | `/issues` | 签名头 | 分页；**全表可查**（不做资源级鉴权）；`status`/`source`/**`projectId`** 过滤（走复合索引） | `GET /api/internal/issues` |
| C3 | GET | `/issues/{issueId}` | 签名头 | 单条；不存在 → 404（**不做资源级鉴权**，谁能看由 SDK 管） | `GET /api/issues/{issueId}` |
| C4 | PUT | `/issues/{issueId}` | 签名头 | 全字段覆盖（`assigned_at` 仍**仅在最终 `status='routing'`** 时写） | `PUT /api/issues/{issueId}` |
| C5 | DELETE | `/issues/{issueId}` | 签名头 | 遗弃（`status='abandoned'`），幂等 | `DELETE /api/issues/{issueId}` |
| C6 | POST | `/issues/status/batch` | 签名头 | 条件更新 / 认领；返回 `{success,failed[]}`，**批量不抛错** | `POST /api/issues/status/batch` |
| C7 | GET | `/issues/comments` | 签名头 | 增量评论（`sinceId` 自增 id 游标，**全表无过滤**，主键范围扫） | `GET /api/issues/comments` |
| C8 | GET | `/issues/comments/cursor` | 签名头 | 游标初始化 `{maxId}` | `GET /api/issues/comments/cursor` |
| C9 | POST | `/issues/{issueId}/comments` | 签名头 | 追加评论（`commentId` 幂等键，缺省服务端生成） | `POST /api/issues/{issueId}/comments` |
| C10 | GET | `/issues/{issueId}/comments` | 签名头 | 查评论（`created_at ASC, id ASC`） | `GET /api/issues/{issueId}/comments` |
| C11 | POST | `/issues/attachments/batch` | 签名头 | 批量挂附件（`type` 白名单 `assigner`/`assignee`：下发方提供 / 执行方交付） | `POST /api/issues/attachments/batch` |
| C12 | GET | `/issues/{issueId}/attachments?type=` | 签名头 | 查附件 | `GET /api/issues/{issueId}/attachments` |
| C13 | GET | `/issue-sources` | 签名头 | 来源列表（`code` 模糊过滤） | `GET /api/issue-sources` |
| C14 | POST | `/issue-sources/batch` | 签名头 | 批量注册（按 `code` upsert，**应用层先去重**） | `POST /api/issue-sources/batch` |
改来源（参考实现里由 administrator 操作）
| C16 | DELETE | `/issue-sources/{id}` | 签名头+administrator | 删来源（弱引用，不影响已有 issue） | A.2 |

### 5.4 文件（3）

| # | 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|---|
| F1 | POST | `/files` | 签名头 | **raw body 上传**（`Content-Type: application/octet-stream`，文件名走 `X-File-Name`，可选 `X-File-Sha256` 校验）→ `{fileId,fileName,size,sha256,createdAt}` |
| F2 | GET | `/files/{fileId}` | 签名头 | 流式下载；**只要登录就能下任何 `fileId`（不做资源级鉴权）**；磁盘上没有 → 404 |
| F3 | DELETE | `/files/{fileId}` | 签名头+administrator | **仅 administrator**（无文件元数据，无法判断上传者；见 api-design C11 的取舍说明） |

> **为什么不用 multipart**：`node:http` 没有 multipart 解析器，自己写解析器是典型的安全坑（边界、超大字段、流未消费）。
> raw body 上传 + 头部传文件名，SDK 侧一行 `fetch(url,{body:fileStream})` 即可；零解析代码 = 零解析漏洞。
> 需要兼容浏览器 `<input type=file>` 时，再单独加 multipart 端点（不在本期）。

### 5.5 管理与运维（6）

| # | 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|---|
| M1 | GET | `/health` | 公开 | `{ok,version,pid,uptimeMs,startedAt,serverTime,db:{path,userVersion,journalMode},authCache:{size,hits,misses,ttlMs}}`；停机中返回 503 |
| M2 | GET | `/version` | 公开 | `{protocol:'dsh-teamwork/1',name,version,dshEngine,node,endpoints:[...]}` —— **`protocol` 与 `endpoints` 是协议要求**，SDK 用它做能力探测（sdk §11.4） |
| M3 | POST | `/admin/shutdown` | 本地 / administrator | **202 + 异步停机**；`X-Shutdown-Token`（锁文件，仅回环）或 administrator 签名头；不接受 query 传 token；幂等（§3.4） |
| M4 | PUT | `/admin/accounts/{accountId}/role` | 签名头+administrator | 改全局角色 `{role}`（`administrator`/`leader`/`user`）；**不能降级最后一个 administrator**；**降级拥有 public 项目 owner 的账号 → 409 `owner_of_public_projects`** |
| M5 | POST | `/admin/accounts/{accountId}/password` | 签名头+administrator | **管理员重置密码**：`{newPassword}` → 更新哈希 + `last_login_at` 不动 + **吊销该账号全部 token**（忘记密码的唯一出口，见 §4.1） |
| M6 | GET | `/admin/accounts` | 签名头+administrator | 账号分页列表，`?q=` 按 `account_id`/`display_name` 模糊搜索，返回 `{accountId,displayName,status,lastLoginAt,createdAt}`（**不含 `account_token`**） |

---

## 6. 统一约定

### 6.1 错误体

```jsonc
{ "code": "issue_not_found", "message": "issue not found", "details": { "issueId": "..." }, "requestId": "req_..." }
```

#### 6.1.1 统一错误处理器（**必须写，否则错误体格式不一致**）

Fastify 的 schema 校验失败会抛自己的错误对象，不接管就会漏出与上面**不同结构**的 JSON。
集中处理器是唯一出口，业务代码**不要**自己 `reply.code().send()` 错误。

```ts
// server/http/error-handler.ts
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

const FRAMEWORK_CODES: Record<number, string> = {
  400: 'invalid_request',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    if (reply.sent) return                       // 已开始写响应：交给上层，不再抢写
    const requestId = req.id

    // ① TypeBox schema 校验失败
    if (err.validation) {
      const v = err.validation[0]
      const extra = (v.params as { additionalProperty?: string } | undefined)?.additionalProperty
      if (extra) {
        return reply.code(400).send({
          code: 'unknown_field',
          message: `不支持的字段: ${extra}`,
          details: { field: extra },
          requestId,
        })
      }
      return reply.code(400).send({
        code: 'invalid_request',
        message: err.message,
        details: { field: v.instancePath?.replace(/^\//, '') || undefined },
        requestId,
      })
    }

    // ② 业务错误（BusinessError 带 status + code + details）
    if (err instanceof BusinessError) {
      return reply.code(err.status).send({
        code: err.code, message: err.message, details: err.details, requestId,
      })
    }

    // ③ 框架错误（413 超限 / 415 媒体类型 / 404 路由不存在）
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({
        code: FRAMEWORK_CODES[err.statusCode] ?? 'invalid_request',
        message: err.message,
        requestId,
      })
    }

    // ④ 兜底 500：不把堆栈/内部信息返回给客户端
    req.log.error({ err }, 'unhandled error')
    return reply.code(500).send({ code: 'internal_error', message: '服务内部错误', requestId })
  })
}
```

**四条硬要求**

| # | 要求 | 不做的后果 |
|---|---|---|
| 1 | `reply.sent` 时直接返回 | 流式下载（F2）中途出错会二次写响应 → 连接异常 |
| 2 | `unknown_field` 单独分支 | 客户端不知道"哪个字段不被接受" |
| 3 | 500 不带 `details`、不带堆栈 | 泄露内部路径/SQL |
| 4 | 业务代码不自己 `send` 错误 | 两种错误体格式并存，SDK 要写两套解析 |

#### 6.1.2 错误码表


| HTTP | code 家族 | 场景 |
|---|---|---|
| 400 | `invalid_request` / `invalid_<field>` | 参数校验失败（字段级原因进 `details`） |
| 400 | `unknown_field` | 请求体出现未声明字段（含身份字段如 `assigner`/`author`/`createdBy`/`accountId`） |
| 400 | `invalid_file_id` | `fileId` 不是 UUID v4 |
| 413 | `payload_too_large` | 上传超 `--max-upload-mb` |
| 415 | `unsupported_media_type` | F1 的 `Content-Type` 不是 `application/octet-stream` |
| 401 | `unauthorized` | token 缺失/过期/吊销/账号禁用（不区分） |
| 403 | `forbidden` | 权限不足（含「非 administrator 查他人数据」） |
| 404 | `not_found` / `issue_not_found` / `file_not_found` | 资源不存在**或无权可见**（两者不区分） |
| 409 | `conflict` | 唯一键冲突（项目名重复、账号已存在） |
| 409 | `project_member_limit` | `private` 项目已达成员上限（`details:{limit,current}`） |
| 409 | `cannot_shrink_to_private` | `public→private` 但当前成员数 > 上限（`details:{current,limit}`） |
| 409 | `last_administrator` | 试图降级/禁用/删除最后一个全局 administrator |
| 403 | `public_project_requires_leader` | 建 `public` 项目但创建人不是 `administrator`/`leader` |
| 409 | `owner_must_be_leader` | 把 `public` 项目的 owner 转让给非 `leader`/`administrator` |
| 409 | `cannot_publish` | `private → public` 但当前 owner 不是 `leader`/`administrator` |
| 409 | `project_has_issues` | 删除项目时该项目下仍有 issue（先归档或迁走） |
| 409 | `project_archived` | 往已归档项目里写 issue |
| 409 | `owner_cannot_be_removed` | 直接移除 owner（必须先转让） |
| 400 | `owner_role_not_assignable` | 通过成员接口传 `role='owner'`（owner 只能由建项目或 B10 转让产生） |
| 403 | `owner_transfer_forbidden` | 非全局 administrator、也非该项目 owner 却调用 B10 转让 |
| 409 | `owner_of_public_projects` | 降级某账号会让他继续拥有 `public` 项目（`details:{projects:[...]}`） |
| 413 | `payload_too_large` | 上传超 `--max-upload-mb` |
| 429 | `rate_limited` | 限流，带 `Retry-After` |
| 500 | `internal_error` | 兜底；日志里有 `requestId` 与堆栈，**响应体不含堆栈** |
| 503 | `stopping` | 停机中（`/health` 与业务接口一致返回） |

早期那套 `{errorCode,errorType,errorMessage,traceId,clusterNode,details}`（按异常类名子串匹配状态码）**整体废弃**。

**落点（Fastify）**：`app.setErrorHandler` 是唯一出口 —— `BusinessError` 直接映射；Fastify 的 schema 校验错误（`error.validation`）映射成 `invalid_request` + `details`；其它异常一律 500，堆栈只进日志、响应体只带 `requestId`。

### 6.2 分页

- 入参统一 `pageNum`（默认 1，`<1` 归一 1）+ `pageSize`（默认 20，`<1` 归一 20，上限 200）
- 响应统一 `{ total, pageNum, pageSize, items }` —— **不再有 `page` / `list` 两种写法**
- 实现：`SELECT COUNT(*)` + `SELECT ... LIMIT ? OFFSET ?` 两条预编译语句

### 6.3 时间

- 入库、出参**一律** `TEXT`，格式 `YYYY-MM-DDTHH:mm:ss.sssZ`（UTC、毫秒、字典序 = 时间序）
- 生成用 `strftime('%Y-%m-%dT%H:%M:%fZ','now')`（实测产出 `2026-11-11T11:05:54.829Z`）
- 客户端入参接受 ISO-8601 带/不带 Z，服务端统一归一为 UTC 毫秒精度
- **取消**两种时区写法；展示层本地化由客户端负责

### 6.4 命名

- 请求/响应字段 `camelCase`；DB 列 `snake_case`
- **取消**那 4 组下划线别名（`assigned_at`/`comment_at`/`comment_role`/`comment_author_type`）——
  只接受 camelCase；SDK 不做兼容层，旧调用方本来也要改路径
- 账号相关列统一叫 `account_id`（旧叫 `user_id`），与模块 A 的概念对齐，见 §10

---

## 7. 数据模型

### 7.1 SQLite 映射规则

| 通用类型 | SQLite | 说明 |
|---|---|---|
| `BIGSERIAL PRIMARY KEY` | `INTEGER PRIMARY KEY AUTOINCREMENT` | **必须 `AUTOINCREMENT`**：评论游标依赖 id 不复用 |
| `VARCHAR(n)` | `TEXT` | 长度校验移到应用层（SQLite 不执行长度） |
| `TIMESTAMPTZ DEFAULT now()` | `TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))` | 见 §6.3 |
| `TEXT / JSON 字符串` | 同 `TEXT` | `json_extract` 可查 |
| `ILIKE '%x%'` | `LIKE '%x%'` | ASCII 不敏感；中文无影响 |
| 部分唯一索引 + `ON CONFLICT (..) WHERE ..` | **完全支持**（已实测） | 工作区肖像的两种形状靠它 |
| `@AutoPaging` / PageHelper | `COUNT(*)` + `LIMIT/OFFSET` | |
| `useGeneratedKeys` | `INSERT ... RETURNING id` | SQLite ≥ 3.35 支持，3.53 可用 |
| 外键 `ON DELETE CASCADE` | 同语法，但**必须每连接 `PRAGMA foreign_keys=ON`** | 最容易漏的一条 |

初始化 PRAGMA（每个连接开库后立即执行）：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

### 7.2 表清单（9 张 = 旧 9 张 - `whitelist` + 新增 `account`）

| # | 表 | 来源 | 列数 | 说明 |
|---|---|---|---|---|
| 1 | `dsh_teamwork_account` | **新增** | 9 | 账号（`account_token` 兼任签名密钥；`global_role` 吸收原 whitelist） |
| 2 | `dsh_teamwork_project` | 旧（砍 `owner`） | 8 | 项目（负责人只在成员表里） |
| 3 | `dsh_teamwork_project_member` | 旧（砍 3 列 + 唯一 owner） | 6 | 项目成员（`display_name`/`dept`/`creator` 已砍；每项目恰好一个 owner） |
| 4 | `dsh_teamwork_device` | 旧（砍 `dsh_patcher_version`） | 9 | 用户设备 |
| 5 | `dsh_teamwork_device_workspace` | 旧（复数改单数） | 9 | 工作区肖像 |
| 6 | `dsh_teamwork_issue` | 旧 + 3 列 | **22**（+`project_id` +`title` +`detail`） | 事件单 |
| 7 | `dsh_teamwork_issue_attachment` | 旧 | 8 | 附件关系（本体在磁盘） |
| 8 | `dsh_teamwork_issue_comment` | 旧 | 10 | 评论（id 为增量游标） |
| 9 | `dsh_teamwork_issue_source` | 旧 | 6 | 来源字典 |

### 7.3 新增表（account）的 DDL

**完整 DDL（9 张表全量、可直接执行）在 [`db-design.zh.md`](./db-design.zh.md) §4**，本节不再复制，避免两处漂移。
这里只保留两表的关键约束意图：

| 表 | 关键点 |
|---|---|
| `dsh_teamwork_account` | `account_id` 唯一（`uk_tw_account`，**BINARY 严格区分大小写**）；`account_token` 有 `ck_tw_account_token CHECK (length=64 AND 小写 hex)` 拦明文/大小写/长度；`status` 有 CHECK；`last_login_at` 可空、只写不判 |

### 7.4 issue 的项目归属（`project_id` 列）

决策 D5 不加列，于是「某项目的 issue」靠 **`assigner_meta` 里的 `projectId`**：

```jsonc
// POST /issues/batch（新增三个字段）
{ "issueId": "dsh:host:uuid", "title": "修复登录超时", "projectId": 7, "detail": "## 现象\n…",
  "assignee": "bob", "urgency": "normal", "assignerMeta": "{…扩展…}" }
```

```sql
-- 查询：走复合索引，过滤 + 排序一次完成（实测无 TEMP B-TREE）
SELECT * FROM dsh_teamwork_issue
 WHERE project_id = ?
 ORDER BY created_at DESC LIMIT ? OFFSET ?;

CREATE INDEX idx_tw_issue_project ON dsh_teamwork_issue(project_id, created_at DESC);
```

**`project_id` 的取值与校验**

| 情况 | 行为 |
|---|---|
| 不传（`NULL`） | 允许 = 无项目的临时 issue |
| 传了 | `POST /issues/batch` 校验：项目存在（404 `/project_not_found`）、调用者是该项目成员（403）、项目未归档（409 `/project_archived`） |
| 项目被删 | 删项目前先查 issue 数；>0 → `409 project_has_issues`（要求先归档或先把 issue 迁走），**杜绝悬空引用** |
| 与 `cwd` 的关系 | `project_id` = 业务归属（关系）；`cwd` = 执行定位（跨实例找设备）。两者并存 |

> **为什么改主意**：原方案（`assigner_meta.$.projectId` + 表达式索引）能让 issue 表零改动，
> 但代价是「归属靠约定、无法 JOIN、删项目留悬空」。项目现在有 owner/成员上限/归档这些真实语义，
> issue 不挂项目就变成孤岛 —— 所以加列。`title`/`detail` 同理（列表要标题、正文不该塞 JSON）。

### 7.5 索引与约束清单（旧 30 个 → 新 30 个）

> **完整、可执行的清单以 [`db-design.zh.md`](./db-design.zh.md) §4（DDL）/ §6（索引）/ §5（CHECK）为准**，
> 本节只做速查。DB 侧已实测：9 表 / 30 索引 / 18 CHECK / 1 外键。

| 表 | 索引（唯一） | 索引（普通） |
|---|---|---|
| account | `uk_tw_account` | — |
| project | `uk_tw_project_name` | `idx_tw_project_updated` |
| project_member | `uk_tw_member`、`uk_tw_member_owner`（部分） | `idx_tw_member_acct`、`idx_tw_member_pid` |
| device | `uk_tw_device` | `idx_tw_device_acct`、`idx_tw_device_host`、`idx_tw_device_acct_st` |
| device_workspace | `uk_tw_ws_portal`（部分）、`uk_tw_ws_index`（部分） | `idx_tw_ws_acct_instance`、`idx_tw_ws_cwd` |
| issue | `uk_tw_issue_id` | `idx_tw_issue_assignee`、`idx_tw_issue_assignee_instance`、`idx_tw_issue_assigner`、`idx_tw_issue_assigner_task`、`idx_tw_issue_assignee_task`、`idx_tw_issue_status`、`idx_tw_issue_source`、`idx_tw_issue_project`（复合：`project_id, created_at DESC`） |
| issue_attachment | `uk_tw_attachment` | `idx_tw_attachment_issue`、`idx_tw_attachment_issue_type` |
| issue_comment | `uk_tw_comment_id` | `idx_tw_comment_issue` |
| issue_source | `uk_tw_source_code` | — |

CHECK 策略（旧 3 个 → 新 15 个）：**系统维护、永不扩值的枚举 + 长度/范围护栏 → 加 CHECK；
业务会扩值的枚举 → 不加 CHECK**。分组见 db-design §5，此处只列分界线。

| 加 CHECK | 不加 CHECK |
|---|---|
| `account.status`、`account.global_role`、`project_member.role`、`device.status`、`device_workspace.type`、`issue_attachment.type`，以及 `account_id` / `project.name` / `issue.issue_id` / `issue.cwd` / `issue_source.code` 的长度与 `device.port` 范围、`issue_comment.content` 非空 | `issue.status` / `issue.urgency` / `issue.permission` / `issue.source` / `project.status` / `project.visibility` / `comment_role` / `comment_author_type` |

> 额外一条防呆：`ck_tw_account_token CHECK (length(account_token)=64 AND account_token NOT GLOB '*[^0-9a-f]*')` ——
> 只接受 64 位小写 hex，挡住「误把明文密码写进 `account_token`」这个最致命也最容易犯的错（实测：明文、大写 hex、长度不足全被拒）。

### 7.6 迁移

- 单一 `PRAGMA user_version` 版本号；`src/server/db/migrations/NNN_*.sql` 按序执行
- 每个迁移文件在**一个事务**里执行（`BEGIN IMMEDIATE` … `COMMIT`），失败整体回滚且不推进 `user_version`
- 首次启动：`user_version=0` → 跑全部迁移 → 写入预置数据（3 条 `issue_source`）

---

## 8. 并发与一致性

| 场景 | 做法 |
|---|---|
| 单进程 | SQLite WAL + 单连接（`DatabaseSync` 不支持并发，也不需要）；所有 DB 调用同步，天然串行 |
| 事务 | 显式 `BEGIN IMMEDIATE`…`COMMIT`，包住「先标 inactive 再 upsert」「建项目 + 写成员」这类多语句操作 |
| 认领竞态 | 沿用旧仲裁：`UPDATE ... WHERE issue_id=? AND status=?`，`changes===0` → `status_conflict`；这是 DB 层原子条件更新，多实例并发只有一个赢 |
| 批量接口 | `POST /issues/status/batch` 逐条独立更新，**单条失败不中断**，返回 `{success,failed[]}`；`POST /issues/batch` 与之相反（**整批失败**，单条校验失败即 400 且不写任何行 —— 用事务保证） |
| 幂等 | `issue_id` / `comment_id` 是客户端提供的幂等键；`ON CONFLICT ... DO UPDATE`（issue）/ `DO NOTHING`（comment） |
| 写放大 | `last_used_at` 60s 节流；`device.batch` 每 500 条一批 |
| 停机 | 停机时拒绝新写，等在飞请求；DB 关闭前 `wal_checkpoint(TRUNCATE)` |

---

## 9. 安全清单

### 9.0 信任模型（**先看这条，它解释了下文所有"不鉴权"**）

本服务的定位是**指导性服务（advisory service）**，不是访问控制系统。信任模型由**部署方式**决定：

| 部署形态 | 谁在访问 | 服务端要做的事 |
|---|---|---|
| **默认（99% 场景）** | SDK 未配置 host → 只连 `127.0.0.1:3939` → **本机、单用户** | 只做认证（证明"是你自己"）+ 校验 + 落库 |
| 显式配置 `--host 0.0.0.0` | ❌ 直接拒绝启动 | 本服务不做资源级鉴权；要跨机请用 SSH 隧道或反向代理，不要把端口暴露出去 |

**由此推出三个刻意决定**（不是遗漏）：

| # | 决定 | 在单用户默认部署下 | 多人共享时 |
|---|---|---|---|
| 1 | issue 的读写**不做资源级鉴权**（C 组） | 无差别 —— 本来就只有你一个人 | 任何登录用户可读写全部 issue |
| 2 | `GET /files/{id}` 任何登录用户可下（F2） | 无差别 | 知道 `fileId` 即可下载（UUID v4 防猜） |
| 3 | 项目/设备的**成员与归属**判定保留（B 组） | 正常生效 | 正常生效 —— 这层是**协作语义**（谁能被加进项目），不是安全边界 |

**启动时的硬约束**：`--host` 只接受回环地址（`127.0.0.0/8`、`::1`、`localhost`）。
其它取值在配置解析阶段就抛错并以非 0 退出：

```
拒绝绑定 0.0.0.0：本服务只允许回环地址（127.0.0.1 / ::1 / localhost）。
需要跨机访问请用 SSH 隧道或反向代理，不要把服务直接暴露出去。
```

理由：服务端不做资源级鉴权（§9.0），一旦监听 `0.0.0.0`，同网段任何有账号的人都能读写全部 issue、
下载任意 `fileId`。把「只允许回环」做成硬校验而不是警告，是因为警告在实际部署里几乎没人看。
