# Castboard 整体设计

> 状态：v1 已实现。本文描述当前 `0.2.0-alpha.6` 的整体结构、边界和关键链路。  
> 读者：维护者、二次开发者、需要评估数据流与安全边界的集成方。

## 1. 定位

Castboard 是 **DSH 的多人、多实例、多系统协同框架**：它解决的是 **“把工作交给正确的机器和 Agent，并让结果回到源系统可消费的事件流”**。

- 看板只是人类操作面的一个投影，不是系统本体；
- task / issue 是统一的工作对象，负责跨实例派发、认领、评论和依赖；
- 多人协作由项目、成员、角色、assigner / assignee 定义；
- 多实例协作由 instance、租约、云端 CAS 和事件流定义；
- 多系统协作由 **事件源模型** 定义：每个外部系统通过 teamwork SDK 把 issue 送进共享库，执行结果和产物再回写到该系统可消费的事件流；
- teamwork 共享库负责项目、成员、设备、issue、评论与附件；
- spellbook 负责执行 Agent 会话、交互与工具能力；
- runtime 是一条旁路：目标实例直接执行一次命令，不建 task、不起 Agent 会话。

### 非目标

- 不做通用工作流引擎；
- 不替代 DSH 的 session / workspace / approval 能力；
- 不替代源系统的业务状态机；Castboard 只负责跨系统流转与执行回写；
- 不提供公网多租户 SaaS；
- 不把 runtime 当作后台任务队列（只支持前台命令）；
- 不在插件内重新实现一套 SQL/ORM。

## 2. 包边界

```text
@meiyukichan/dsh-magica-castboard   本包
├── host 半侧：台账 / 调度 / 执行 / issue 流水线 / 工具 / HTTP
└── client 半侧：看板、项目管理、设置、交互卡片

@meiyukichan/dsh-magica-teamwork    共享库
├── 服务端：Fastify + SQLite（项目/成员/设备/issue/评论/附件）
└── SDK：CastboardClient + 协议类型

@meiyukichan/dsh-magica-spellbook   宿主能力 SDK
├── 会话门面（正式 / 临时 / 续跑）
├── 工具与上下文注册
└── 交互收集与应答
```

原则：

- castboard 不复制 teamwork 的数据库模型；
- castboard 不直接操作 DSH 内部 session 存储，只通过 spellbook 门面；
- client 不直接访问 Node / SQLite，只通过 `/api/castboard` 与宿主服务通信；
- 跨包只依赖公开类型 / SDK，不 import 对方内部实现。

## 3. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│ DSH Host                                                     │
│                                                             │
│  ┌──────────────┐   /api/castboard    ┌──────────────────┐  │
│  │ client 半侧  │◄────────────────────►│ HTTP routes      │  │
│  │ 看板 / 项目  │                      │ tasks/issues/... │  │
│  └──────┬───────┘                      └────────┬─────────┘  │
│         │ slots / locale / theme                │            │
│         ▼                                       ▼            │
│  ┌──────────────┐   tools    ┌──────────────────────────┐   │
│  │ Agent 会话   │◄──────────►│ 4 个能力网关工具          │   │
│  └──────┬───────┘            └────────────┬─────────────┘   │
│         │ spellbook 门面                  │                  │
│         ▼                                 ▼                  │
│  ┌──────────────┐   lease    ┌──────────────────────────┐   │
│  │ 执行引擎     │───────────►│ 台账 / 索引 / 评论 / 设置 │   │
│  │ 调度 / 验收  │            │ $DSH_HOME/storages/...    │   │
│  └──────┬───────┘            └──────────────────────────┘   │
│         │ sync / publish / inbox                            │
│         ▼                                                   │
│  ┌──────────────┐   HTTP     ┌──────────────────────────┐   │
│  │ teamwork SDK │◄──────────►│ dsh-magica-teamwork 本地 │   │
│  └──────────────┘            │ Fastify + SQLite          │   │
│                              └──────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

关键点：

- **Host 是唯一的写入者**；client 只读/发命令；
- **teamwork 服务默认只监听回环地址**，castboard 通过 SDK 访问；
- **Agent 会话是执行载体**，但 issue / runtime 不要求每条工作都起会话；
- **评论是跨机事实流**，投递不是数据源，只是唤醒手段。

## 4. 数据与持久化

### 4.1 Castboard 本地台账

```text
$DSH_HOME/storages/castboard/
├── castboard.pid              单写者租约
├── castboard-task.json        任务索引（含 revision）
├── castboard-issue.json       issue 索引
├── castboard-link.json        issue ↔ task / session 关系
├── castboard.settings.yaml    看板设置
├── castboard-templates.json   用户模板
├── tasks/<taskId>.json        任务详情 + 执行历史
├── issues/<issueId>.json      issue 详情
├── comments/<anchorId>.jsonl  评论流（task 或 issue）
├── cursors/                   发布 / 拉取游标
└── portraits/                 项目肖像
```

设计取舍：

- 索引与详情分离，列表读取不展开大对象；
- JSON 文件采用原子写（临时文件 + rename）；
- 评论用 JSONL 追加，天然按时间顺序；
- 游标与幂等表独立落盘，重启后不重复上传；
- 租约保证同一 `DSH_HOME` 只允许一个可写进程，其余进程降级为只读。

### 4.2 Teamwork 共享库

```text
$DSH_HOME/storages/teamwork/server/
├── teamwork.db       SQLite（9 表 / 30 索引 / WAL）
├── files/<fileId>    附件
├── config.json       可选配置
└── run/server.json   单实例锁
```

共享库是 **issue / 项目 / 成员 / 设备 / 评论的权威来源**；本地 issue 是镜像 + 本地执行状态。

### 4.3 迁移

- 旧版 `castboard-task.json` 内的 `settings` 会一次性迁到 `castboard.settings.yaml`；
- 旧 `backlog` 任务会迁移到 issue；
- 损坏的索引会隔离并从详情重建；
- 墓碑保证已删除 issue 不会被远端同步重新插回。

## 5. Host 生命周期

### 5.1 租约与单写者

- `LeaseService` 在 `$DSH_HOME/storages/castboard/castboard.pid` 上竞争；
- 只有 owner 才写台账、执行任务、发布评论、做 runtime；
- 非 owner 仍可提供只读 HTTP / UI；
- owner 失效后，其他进程可接管；
- 所有写入口都先经过 owner gate。

### 5.2 台账层

- `TaskStore`：任务索引、详情、执行历史、模板、验收策略；
- `IssueStore`：issue 镜像、状态迁移、claim、mergeRemote；
- `CommentStore`：按 anchor 的 JSONL 流，幂等追加；
- `LinkStore`：issue 与 task / assigner session / assignee session 的关系；
- `SettingsStore`：设置 YAML；
- `PublishCursorStore` / `PullCursorStore`：评论与附件的同步水位。

### 5.3 同步与认领

```text
远端 pending issue
  → myInstanceIssues(status=pending, instance=本机)
  → claimable 预过滤（墓碑 / 已定案 / 无权限）
  → teamwork claim（云端 CAS）
  → 本地 pending → accepted
  → mergeRemote（只更新镜像字段，不碰本地执行状态）
```

- 拉取与认领分两步：先判断“值得落”，再做云端 CAS；
- 认领失败不会把别人的 issue 拉到本地；
- 本地执行状态（routing / running / success）不被远端镜像合并覆盖。

### 5.4 路由与派发

两种执行模式：

1. **issue → task**：`IssueRouterService` 起临时会话，把 issue 规划成 task；
2. **runtime**：`RuntimeCommandWorker` 直接执行，跳过 router。

Router 关键规则：

- 只处理可路由 issue；
- `runtime` 永不进入 router；
- 临时会话输出结构化 decision；
- 失败退避 `n × 60s`，达到上限转 abandoned；
- router 的 `healStranded` 不会复位 `urgency=runtime` 的 routing issue。

`Dispatcher`：

- 按紧急度 → 创建时间 → id 排序；
- 受 `maxConcurrent` 和租约 gate 限制；
- 同一任务只允许一个执行；
- `done` / `in_review` 等状态由结算推进。

### 5.5 执行与验收

`ExecutionService`：

- 通过 spellbook 门面启动正式工作区会话；
- 执行期间维护 execution history / session 句柄；
- 结算结果映射为任务状态；
- 取消 / 超时 / 无会话门面都走失败或取消结算。

`AcceptanceRunner`：

- 任务到 `in_review` 后按验收策略启动辅助轮；
- 先写 `acceptanceInjectedAt`，起不来会回滚簿记；
- 支持 issue 策略和 close 策略；
- close 要求清单全部完成。

### 5.6 Issue 状态机

```text
pending ──► accepted ──► routing ──► running ──► success
   │            │           │           │
   │            │           │           ├──► failed
   │            │           │           └──► abandoned
   │            │           └──► pending（孤儿恢复 / 失败退避）
   │            └──► abandoned
   └──► abandoned
```

- `success` / `failed` / `abandoned` 是终态；
- 远端合并只允许 `pending` / `accepted`；
- `routing` 状态按来源归属：router 或 runtime worker，两者互不复位。

### 5.7 Runtime 链路

```text
创建 runtime issue
  ├─ 显式 cwd / permission
  ├─ SDK 按 assigneeInstance 查目标设备 OS
  ├─ 写 runtime.tool = pwsh | bash
  └─ 未知设备 / OS → 拒绝创建
            │
            ▼
target SyncService 拉取并认领
            │
            ▼
RuntimeCommandWorker
  ├─ accepted/pending → routing（CAS）
  ├─ 目标平台解析 tool
  ├─ DSH schema 校验（全局 view 缺失时用保守 command schema）
  ├─ workspace 包含性 + permission 上限检查
  ├─ 异步执行（不阻塞轮询，最多 4 并发）
  ├─ 本地先结算 success/failed
  ├─ 写系统结果评论 + 云端 publish（同 commentId）
  └─ finalize 回写远端
```

Runtime 结果是一条系统评论：

```text
role        = assignee
authorType  = system
systemKey   = sys.runtimeCommand
body        = runtime <tool> + outcome / exit code / stdout / stderr
```

投递器把这条评论当作 RPC 答案，允许唤醒 assigner；云端评论没有 `systemKey` 时，用正文前缀 `runtime ` 识别。目标会话不在线则记 pending 欠账。

### 5.8 评论、交互与投递

- `ThreadService` 是评论唯一写入口；
- 本地评论先落 JSONL，再触发 publish / deliver；
- `CommentPublisher` 按游标把本地行发到 teamwork；
- `IssueCommentInbox` 拉远端新评论并按 anchor 落盘；
- `CommentDeliverer` 三档投递：live session push / resume / pending 欠账；
- 普通 system 评论只作为 trace，不唤醒会话；
- 交互控制评论和 runtime 结果是两个窄口子。

交互协议：

- 控制评论 body 是纯 JSON；
- 类型：`requested` / `answered` / `completed`；
- 支持 question 与 approval；
- 关闭 `commentsEnabled` 同时停止 reporter / bridge / tool answer。

### 5.9 项目肖像与产物

- `PortraitRunner` 按 cron 批次扫描 workspace，写 `worklabs/workspaces/<id>.md`；
- 失败退避，有会话 TTL 和并发限制；
- `ArtifactUplink` 在结算后读取 `execution_report.artifacts`；
- 先挂附件再记幂等，每批 10 个 / 50MB / 0 字节跳过。

### 5.10 多系统事件源

Castboard 的“多系统”不是多个服务互相调用，而是 **多个事件源共享同一条工作事件流**。

```text
外部系统 A（工单 / IM / CI / 监控 / 业务后台）
  │ teamwork SDK：创建 issue，source = a
  ▼
Teamwork 共享库（issue + source + sourceInstance）
  │ Castboard 认领 / 执行
  ▼
Castboard Host（Agent 会话 / Runtime）
  │ 结果评论 + artifacts
  ▼
Teamwork 共享库（评论 / 附件）
  │ 源系统通过 teamwork SDK 拉取，或接入自己的 webhook
  ▼
外部系统 A
```

约束：

- 每个事件源使用稳定的 `source` 代码，且必须存在于 `dsh_teamwork_issue_source`；
- issue 同时记录 `source` 与 `sourceInstance`，用于区分来源系统和来源实例；
- 外部系统创建 issue 时只需 teamwork SDK，不需要变成 DSH 插件；
- Castboard 把结果写成 issue 评论、把产物挂成附件，源系统通过 SDK 读取；
- 如果源系统需要实时推送，由源系统自己的集成层订阅共享库事件，Castboard 不绑定具体业务系统的回调协议。

这样同一套任务模型可以接入 IM、工单、CI、监控等多个系统，而不需要为每个系统复制一套执行链路。

## 6. Client 半侧

- 通过 DSH slot 注册：
  - `sidebar.panellist`：任务面板入口；
  - `main`：看板整页；
  - `shell.overlay`：交互总览浮层；
  - 项目管理入口挂载 teamwork 页面。
- 数据来自 `/api/castboard` 与宿主事件；
- 所有可见文案走 locale（zh / en 键集一致）；
- 样式使用 `--dsw-alias-*` token，不硬编码深浅色；
- 不直接访问 Node / SDK，不在组件里自建长连接。

主要页面：

| 页面 | 内容 |
|---|---|
| 任务面板 | 四列看板 + 待规划 issue + 设置 / 模板 / 导入导出 / 诊断 |
| 项目管理 | 我的项目 / 我的 Issue / 我的设备 / 项目详情 / 评论与交互 |
| 交互浮层 | 待回答的 question / approval，跨看板可用 |

## 7. 工具与 HTTP 面

### 7.1 模型工具

四个面向模型的能力网关：

```text
castboard_task
  list | get | move | report | checklist

castboard_issue
  help | create | state | links | interactions | answer_interaction | convert

castboard_teamwork
  groups | group_members | devices | workspaces

castboard_comment
  get | add
```

网关只暴露能力枚举，底层 handler 保持独立；这样模型看到的是窄接口，内部可以继续演进。

### 7.2 HTTP

- 前缀：`/api/castboard`；
- 任务、issue、评论、状态、设置、诊断、导入导出、附件；
- 只读实例也必须能读；
- 写路由先经过租约 owner gate；
- 云端 issue 的评论有独立 `/issues/:id/cloud-comments` 读取面。

## 8. 配置与开关

### 8.1 看板设置

`castboard.settings.yaml`：

| 字段 | 默认 | 作用 |
|---|---|---|
| `defaultPermission` | workspace-write | 执行默认权限 |
| `maxConcurrent` | 4 | 并发执行上限 |
| `autoRoute` | true | 自动规划 |
| `portraitRunOnStart` | false | 启动时跑肖像 |
| `commentsEnabled` | true | 评论拉取/投递 |
| `commentPollMs` | 5000 | 评论轮询 |
| `interactionReportEnabled` | true | 交互上报 |

### 8.2 环境开关

- `DSH_CASTBOARD_SYNC` / `ROUTER` / `PORTRAIT` / `RUNTIME`：总开关；
- `DSH_CASTBOARD_RUNTIME_ALLOW_CROSS_ACCOUNT`：runtime 跨账号；
- `DSH_CASTBOARD_MAX_CONCURRENT` / `SYNC_INTERVAL_MS` / `COMMENT_POLL_MS` / `PORTRAIT_TTL_MS`：运行时策略；
- `DSH_TEAMWORK_AUTOSTART` / `DSH_TEAMWORK_DATA` / `DSH_TEAMWORK_INSTANCE`：数据面地址与自动拉起。

## 9. 安全边界

- 单写者租约避免同一台账被多进程写坏；
- 原子写 + 索引隔离，坏文件可恢复；
- 共享库服务默认只监听回环；
- runtime 有 cwd / permission / sandbox 三道闸门；
- runtime 默认同账号，跨账号显式 opt-in；
- 伪造评论通过 `commentId` 幂等键去重；
- 评论路由区分 assigner / assignee / observer，不把内容投给错误一侧；
- 远端只做镜像合并，不覆盖本地执行状态。

## 10. 失败与恢复

| 失败点 | 处理 |
|---|---|
| 进程在 routing 中崩溃 | runtime worker 启动时标 failed；router 只恢复普通 issue |
| router 临时会话失败 | 退避重试，3 次 abandoned |
| 执行会话无法启动 | 结算失败并退回待办 |
| 评论投递失败 | 记 pending 欠账，目标在线后补投 |
| 评论 publish 失败 | 游标停在原地，下一拍重试 |
| runtime 评论/finalize 失败 | 本地已结算；远端重试一次，仍失败只记录 |
| 台账坏索引 | 隔离并从详情重建 |
| 附件上传失败 | 不记幂等，下次重试 |
| 云端 issue 已删除 | 负缓存跳过，不反复请求 |

## 11. 扩展点

- **新 runtime tool**：扩展 runtime tool catalog、parser、executor 和 schema；help 结构不用重写；
- **新工具能力**：在对应网关下增加 capability，底层 handler 单独实现；
- **新客户端页面**：通过 slot 注册，不修改 shell；
- **新数据面实现**：按 teamwork 协议替换服务端，castboard 只依赖 SDK 面；
- **新执行后端**：实现 spellbook 的 session 门面即可替换执行引擎。

## 12. 已知边界

- runtime 当前只实现 command tool（bash / pwsh）；
- runtime 只支持前台命令，不支持后台任务；
- 同一 `DSH_HOME` 只有一个可写 owner；
- teamwork 服务默认只允许回环访问；
- 云端评论没有 `systemKey`，runtime 结果跨机识别依赖正文前缀；
- 三处 runtime schema 表示（help 文本、fallback JSON Schema、工具外层 schema）目前保持同步，后续可收敛为单一来源。

## 13. 代码地图

```text
src/index.ts                     host 入口 / apply / 服务装配

src/host/ledger/                 台账、索引、租约、设置、游标、模板
src/host/pipeline/sync.ts        共享库拉取与认领
src/host/pipeline/router.ts      issue → task 规划
src/host/pipeline/runtime-*.ts   runtime 契约 / 执行 / worker
src/host/pipeline/thread.ts      评论唯一写入口
src/host/pipeline/deliver.ts     评论投递三档 + 窄口子
src/host/pipeline/inbox.ts       远端评论拉取
src/host/pipeline/publish.ts     本地评论上云
src/host/dispatch/               cron 调度 / 派发器
src/host/exec/                   执行引擎 / 结算 / 验收 / 交互上报
src/host/tools/                  工具定义与四个能力网关
src/host/http/                   /api/castboard 路由
src/host/context/                系统提示与上下文注入

src/client/app/                  页面入口与图标
src/client/features/             看板 / 项目 / 设置 / 交互
src/client/data/                 store 与 HTTP 客户端
src/client/labels/               zh / en 字典
src/shared/                      线格式、协议类型、常量
```

更细的模块设计后续放在 `docs/technical/` 下按模块补充。
