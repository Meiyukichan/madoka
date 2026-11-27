# dsh-magica-teamwork

DSH 的本地协作服务 + 客户端 SDK：**issue 派发与追踪**、项目与成员、设备与工作区肖像、文件附件。

- **服务端**：Node 24 + Fastify + `node:sqlite`，零第三方存储依赖，**首次启动自动建库建表**
- **SDK**：`createCastboardClient`（`CastboardClient`）通过 `/auth/token` 换请求 headers
- **可替换**：`host` 默认 `http://127.0.0.1:3939`；服务端可由任何人按契约实现，认证交换见 [`docs/design/auth-exchange.zh.md`](docs/design/auth-exchange.zh.md)

设计文档（唯一权威）：

| 文档 | 内容 |
|---|---|
| [`docs/design/auth-exchange.zh.md`](docs/design/auth-exchange.zh.md) | **认证交换协议**：`/auth/token`、`/auth/logout`、SDK 刷新、凭据 v2 |
| [`docs/design/db-design.zh.md`](docs/design/db-design.zh.md) | 9 张表 / 30 索引 / 19 CHECK / 1 外键 + 完整可执行 DDL |
| [`docs/design/api-design.zh.md`](docs/design/api-design.zh.md) | 50 个端点的入参 / 出参 / 错误码（认证部分看 auth-exchange） |
| [`docs/design/server-design.zh.md`](docs/design/server-design.zh.md) | 服务端实现形态、鉴权、停机、信任模型 |
| [`docs/design/sdk-design.zh.md`](docs/design/sdk-design.zh.md) | **SDK 规格（协同底座）**：`dsh-teamwork/1` 协议 + 兼容面 + 24 个组合方法 |
| [`docs/design/open-items.zh.md`](docs/design/open-items.zh.md) | **待办与未决项**：协议未定的缺口 |
| [`docs/design/sdk-design.v1.zh.md`](docs/design/sdk-design.v1.zh.md) | 历史 v1 客户端（`TeamworkClient`）文档，仅存档，不再随包提供 |

## 快速开始

```bash
pnpm install
pnpm build

# 起服务（零手工步骤：目录、数据库、表结构自动就绪）
pnpm start                      # 默认 127.0.0.1:3939，数据在 ~/.dsh/storages/teamwork/server
pnpm start -- --port 4000       # 换端口
pnpm start -- --help            # 全部参数
```

第一个注册的账号自动成为 `administrator`。

```ts
import { createCastboardClient } from 'dsh-magica-teamwork'

const client = createCastboardClient()                  // 默认连 127.0.0.1:3939
const registered = await client.auth.register({ accountId: 'alice', password: 'correct horse battery' })
if (!registered.ok) throw new Error(registered.reason)
// 或 client.auth.login({ accountId, password })

const project = await client.teamwork.project.create({ name: '试点', visibility: 'private' })
if (!project.ok) throw new Error(project.reason)
const created = await client.issueCreate({
  title: '修复登录超时',
  assignee: 'bob',
  projectId: project.data.id,
})
if (!created.ok) throw new Error(created.reason)
await client.issue.comment.add(created.data.issue.issueId, { content: '开始处理' })
await client.issueUpdateStatus({ issueId: created.data.issue.issueId, status: 'accepted', expectedStatus: 'pending' })
```

## 数据与配置

```
$DSH_TEAMWORK_HOME（默认 ~/.dsh/storages/teamwork）
├── server/
│   ├── teamwork.db          SQLite（首次启动自动创建，WAL）
│   ├── config.json          可选配置文件（自动拉起时唯一设置点）
│   ├── files/<fileId>       附件本体
│   └── run/server.json      单实例锁
├── .credentials.json        SDK 凭据（AES-256-GCM；含 accountToken + auth headers）
└── .credentials.key         SDK 密钥（0600）
```

配置优先级：**CLI flag > 环境变量 > `config.json` > 默认值**。常用项：

| flag | 默认 | 说明 |
|---|---|---|
| `--host` | `127.0.0.1` | **只接受回环**（127.0.0.1 / ::1 / localhost）；给 0.0.0.0 或局域网地址会直接拒绝启动 |
| `--port` | `3939` | `0` = 随机 |
| `--data-dir` | `~/.dsh/storages/teamwork/server` | 自动创建 |
| `--token-ttl-days` | `3` | 本地 JWT auth headers 的有效期上限，也是 `/auth/token` 的 `expiresAt` 依据 |
| `--registration` | `open` | `open` / `code` / `closed` |
| `--private-member-limit` | `5` | private 项目成员上限 |
| `--auth-cache-ttl` | `60000` | 鉴权结果缓存（`0` = 关闭） |

## 运维

```bash
curl -s localhost:3939/dsh-teamwork/v1/health   # 健康 + 版本 + 鉴权缓存统计
curl -s localhost:3939/dsh-teamwork/v1/version  # 协议 + 已实现端点清单
```

停机只有一条正常通道（跨平台可靠）：

```bash
# 回环 + 锁文件里的 token，或 administrator 的 auth headers
curl -X POST localhost:3939/dsh-teamwork/v1/admin/shutdown
```

## 开发与测试

```bash
pnpm typecheck      # src + tests 两套 tsc --noEmit
pnpm build          # → lib/index.js（压缩单文件） + lib/index.d.ts
pnpm smoke          # 数据库自动迁移的 14 项断言
pnpm test           # tests/ 下 124 个用例，同进程跑完
pnpm saturate:sdk   # SDK 饱和测试：自起本地服务 → 打满每个端点与每个组合方法（183 断言 / 48 端点）
pnpm start          # node lib/index.js
```

饱和测试也可以打已部署的服务（第三方实现验收）：

```bash
node scripts/sdk-saturate.mjs --url http://<host>:<port>/dsh-teamwork/v1
```

> 前置：先 `node ./node_modules/typescript/bin/tsc -p tsconfig.tests.json`（脚本会检查 `lib-tests/`）。
> 详见 [`docs/design/sdk-design.zh.md`](docs/design/sdk-design.zh.md) §16.9。

构建产物只有两个文件：

| 文件 | 说明 |
|---|---|
| `lib/index.js` | 服务端 + SDK 打成一个**压缩 ESM**，`bin` 指向它（`node lib/index.js` 直接起服务；被 import 时只导出 API） |
| `lib/index.d.ts` | 合并后的类型声明 |

迁移 SQL 在构建期内联成字符串（`src/server/db/migrations.generated.ts`），所以单文件产物不依赖任何外部资源文件；`fastify` 作为外部依赖留在 `node_modules`。

测试目录：`tests/`（TypeScript，编译到 `lib-tests/`，由 `scripts/run-tests.mjs` 驱动）。

| 文件 | 覆盖 |
|---|---|
| `tests/helpers.ts` | 起真服务、造客户端、裸 HTTP、现场签 JWT |
| `tests/auth.test.ts` | 注册闸门、登录延迟、鉴权头组合、改密、凭据加密落盘 |
| `tests/projects.test.ts` | 可见性、owner 唯一与转让、private 上限、归档只读、角色矩阵 |
| `tests/issues.test.ts` | 批量提交/upsert、覆盖语义、状态批量的部分成功与竞态、评论幂等与增量、附件、来源字典 |
| `tests/devices.test.ts` | 全量同步与下线、跨账号可见、工作区两种形状与 cwd 精确/前缀 |
| `tests/files.test.ts` | raw body 上传、哈希校验、大小上限、下载、administrator 才能删 |
| `tests/admin.test.ts` | health/version、账号列表、改角色护栏、重置密码、停机 token |
| `tests/contract.test.ts` | **机械护栏**：47 端点清单、无鉴权头一律 401、普通用户打管理端点一律 403、错误体形状、时间与分页结构 |
| `tests/migrate.test.ts` | 自动建库、幂等、坏迁移回滚、版本护栏、外键级联、唯一 owner 索引 |

> `node --test <glob>` 在 Windows + 受限沙箱下不可用（无 glob 展开、子进程 spawn EPERM），
> 所以用 `scripts/run-tests.mjs` 以 `isolation: 'none'` 在单进程内跑。

### 对已部署实例做饱和测试

```bash
node scripts/saturate.mjs                      # 打 http://127.0.0.1:3939
node scripts/saturate.mjs http://127.0.0.1:4000
```

它会真注册账号、真建项目/issue/文件，跑完打印每条请求的状态，并在结尾用 `/version`
的能力清单反查覆盖率（当前 **47/47**，84 项断言）。注意它会写入真实数据，别对生产实例跑。

## 数据库迁移

不需要手动执行任何 SQL：

- `node:sqlite` 是 Node 内置模块（无需安装 sqlite）
- 打开不存在的库文件会自动创建
- `src/server/db/migrations/*.sql` 在启动时按 `PRAGMA user_version` 增量应用，每个文件一个事务；失败整体回滚且不推进版本
- 数据库版本高于程序支持版本时**拒绝启动**，不会静默降级

加一个迁移：新增 `002_xxx.sql`，重启即自动应用。

## 安全边界（务必先读）

本服务是**指导性服务**，不是访问控制网关：

- 默认只绑回环，SDK 不配 `host` 就只连本机 → 实际是单用户本地服务
- **issue 的读写不做资源级鉴权**；`GET /files/{fileId}` 只要登录就能下载
- 用户密码 → `accountToken = SHA256(账号:密码)`；本地 JWT 的签名密钥，按密码级机密对待；新 SDK 不再在客户端签 JWT
- `--host` **只接受回环**：`0.0.0.0` / 局域网 IP / 域名会直接拒绝启动。要跨机，请用 SSH 隧道或反向代理

详见 [`docs/design/server-design.zh.md`](docs/design/server-design.zh.md) §9.0。
