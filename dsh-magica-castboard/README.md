# Castboard

DSH 0.2 的协作看板与 Agent 派活中枢：把想法记成 issue，把 issue 派给某台机器上的 Agent 会话执行，执行结果、评论、交互和产物再回到共享库。

Castboard 不是一个孤立的看板，它把三件事接在同一套数据链路上：

- **任务面板**：看板、任务台账、cron 调度、执行与验收；
- **项目管理**：项目、成员、设备、issue 与共享库评论；
- **远程执行**：把 issue 派给目标 instance 的 Agent 会话，或者以 `runtime` 方式直接执行一次命令。

> 当前包版本：`0.2.0-alpha.6`  
> 适用 DSH：`0.2.0 ~ 0.2.2`（开发和测试基线：`0.2.1-rc.5`）  
> 技术设计：[`docs/technical/overall-design.md`](docs/technical/overall-design.md)

## 功能总览

| 能力 | 你会得到什么 |
|---|---|
| 任务看板 | 待办 / 进行中 / 待验收 / 完成 四列，支持拖拽、排序、搜索、模板 |
| 任务台账 | 单写者租约、原子写、执行历史、验收策略、导入导出、诊断 |
| 派活 | 把任务派给指定机器上的 DSH Agent 会话执行 |
| Issue | 待规划、依赖、认领、转任务、跨机追踪、评论与附件 |
| Runtime | 目标 instance 直接执行一次命令，不建卡、不起 Agent 会话 |
| 交互回传 | Agent 的提问 / 审批以控制评论同步到 issue，可远程回答 |
| 项目管理 | 项目、成员、设备在线状态、工作区肖像、issue 详情 |
| 自动产物 | 执行结束后按 `execution_report.artifacts` 自动上传附件 |

## 环境要求

- DSH `0.2.0 ~ 0.2.2`；
- Node.js `>= 22.5`；
- 使用 npm / dshmarket 安装时不需要 pnpm；从源码开发时需要 pnpm `>= 11`；
- 同一 `DSH_HOME` 下建议只跑一个可写实例：Castboard 通过租约保证单写者。

Castboard 依赖两个同系列包：

- `@meiyukichan/dsh-magica-spellbook`：DSH 会话、交互与工具 SDK；
- `@meiyukichan/dsh-magica-teamwork`：本地协作服务与客户端 SDK。

## 安装

### 通过 dshmarket / 插件市场

搜索 **Castboard** 或 `@meiyukichan/dsh-magica-castboard`，安装到目标 profile，然后重启 DSH。

### 通过 CLI

```bash
dsh plugin --profile <profile> add @meiyukichan/dsh-magica-castboard
```

例如：

```bash
dsh plugin --profile web add @meiyukichan/dsh-magica-castboard
```

安装后重启对应 DSH 实例。启动成功后，侧边栏会出现两个入口：

- **任务面板**：看板与任务台账；
- **项目管理**：项目、成员、设备与 issue 详情。

### 从源码开发

```bash
cd dsh-magica-castboard
pnpm install
pnpm build
pnpm test
```

把本地目录装进 profile：

```bash
dsh plugin --profile <profile> add link:<path-to-dsh-magica-castboard>
```

## 第一次使用

### 1. 打开项目管理，注册/登录本地协作服务

Castboard 默认会在回环地址上自动拉起 `dsh-magica-teamwork` 本地服务：

- 默认地址：`http://127.0.0.1:3939`；
- 数据目录：`~/.dsh/storages/teamwork/server`；
- **第一个注册的账号自动成为 administrator**。

打开侧边栏 **项目管理**：

1. 注册第一个账号（或登录已有账号）；
2. 新建项目；
3. 添加项目成员；
4. 在 **我的设备** 中确认目标机器在线。

> 如果使用已有的外部 teamwork 服务，可以用 `DSH_TEAMWORK_DATA` 指向配置目录，或设置 `DSH_TEAMWORK_AUTOSTART=0` 关闭自动拉起，再通过 `config.json` 指向你的服务。

### 2. 打开任务面板

任务面板由四列主状态加一条「待规划」泳道组成：

```text
待规划 issue │ 待办 │ 进行中 │ 待验收 │ 完成
```

常用操作：

- **新建任务**：右上角「新建任务」，或从模板新建；
- **拖拽**：只允许状态机允许的迁移，非法拖拽会被拒绝；
- **排序 / 搜索**：按项目、紧急度、标题、创建时间；
- **设置**：并发上限、默认 permission、自动路由、评论开关等；
- **导入 / 导出**：完整 JSON 台账备份与 CSV 任务清单；
- **诊断**：查看台账基本项与租约状态。

### 3. 让 Agent 帮你派活

Castboard 注册了四个面向模型的网关工具：

| 工具 | 能力 |
|---|---|
| `castboard_task` | `list` / `get` / `move` / `report` / `checklist` |
| `castboard_issue` | `help` / `create` / `state` / `links` / `interactions` / `answer_interaction` / `convert` |
| `castboard_teamwork` | `groups` / `group_members` / `devices` / `workspaces` |
| `castboard_comment` | `get` / `add` |

可以直接对 Agent 说：

```text
帮我把「修复登录超时」派给 yukino，在她在线的那台机器上执行。
```

Agent 会通过：

```text
castboard_teamwork(groups)
→ castboard_teamwork(group_members)
→ castboard_teamwork(devices)
→ castboard_issue(create)
```

完成项目、成员、目标 instance 的选择与建 issue。

### 4. Runtime：直接执行一次命令

只有当**用户明确要求**在某个目标 instance 上执行命令时，才应该创建 `urgency=runtime` 的 issue。  
它不会建卡、不会起 Agent 会话，由目标 instance 直接执行一次命令，结果写回 issue 评论。

示例说法：

```text
在 yukino 的 192.168.3.7:3080 上，用 read-only 权限执行：
在当前工作区打印 cwd 和 git HEAD。
```

Runtime issue 的关键字段：

```text
cwd                       必填，目标机上已注册 workspace 内的绝对路径
permission                必填：read-only / workspace-write / danger-full-access
assigneeInstance          目标实例 ip:port
assignerMeta.runtime.arguments
  command                 必填
  description             必填
  workdir                 可选
  timeoutMs               可选，1000..600000，默认 120000
```

`runtime.tool` 不需要模型填写：目标实例按自己的平台选择：

- Windows → `pwsh`
- Linux / macOS → `bash`

执行结果是一条 `role=assignee`、`authorType=system` 的系统评论；它会被当作 RPC 答案投递给创建 issue 的 assigner 会话，不需要手动轮询。

更多约束见下方「Runtime 安全边界」。

### 5. 交互回传

Agent 在任务会话里发起的问题 / 审批会同步成 issue 上的控制评论。  
在项目管理或 issue 详情里回答后，结果会回到执行会话；相关能力：

- `castboard_issue(capability="interactions")`
- `castboard_issue(capability="answer_interaction")`

如果不需要这条链路，可以在任务面板设置里关闭 `commentsEnabled` / `interactionReportEnabled`。

## 任务与 Issue 状态

### 任务状态

```text
todo → in_progress → in_review → done → archived
  ↘        ↘             ↘
 canceled  canceled      canceled
```

补充规则：

- `done` 只能进 `archived`；
- `archived` 是终态；
- `abandoned` 是隐藏但保留记录的终态；
- `canceled` 仍可见，可以回到 `todo`；
- 所有非法迁移都会被工具 / API 拒绝。

### Issue 状态

```text
pending（待规划）
  → accepted（目标机已认领）
  → routing（规划 / 转换中）
  → running（执行中）
  → success / failed / abandoned
```

`runtime` issue 跳过 task / router / Agent 会话，由 `RuntimeCommandWorker` 直接执行。

## 任务面板界面

### 看板

- **待规划**：还没转成任务的 issue；可以新建、编辑、补充讨论和本机附件路径；
- **主列**：待办、进行中、待验收、完成；
- **次要区**：已取消、已归档、已删除；
- **卡片操作**：打开详情、编辑、移动、放弃、删除、查看执行历史；
- **设置**：`castboard.settings.yaml` 的界面入口；
- **导入 / 导出**：JSON 整册备份 / CSV 任务清单；
- **模板**：内置模板 + 用户模板；
- **诊断**：台账、租约、索引健康检查。

### 项目管理

- **我的项目 / 我的 Issue / 我的设备**；
- 项目详情：成员、角色、可见性、负责人转让；
- Issue 详情：状态、评论流、交互控制评论、附件；
- 设备：在线状态、OS、instance 地址。

## 配置

### 任务面板设置

设置保存在：

```text
$DSH_HOME/storages/castboard/castboard.settings.yaml
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `defaultPermission` | `workspace-write` | 新建执行使用的默认权限 |
| `maxConcurrent` | `4` | 同时执行的 Agent 会话上限，1..20 |
| `autoRoute` | `true` | 自动把待规划 issue 转成任务 |
| `portraitRunOnStart` | `false` | 启动时立即跑一轮项目肖像 |
| `commentsEnabled` | `true` | 是否拉取/投递评论 |
| `commentPollMs` | `5000` | 评论轮询间隔（毫秒） |
| `interactionReportEnabled` | `true` | 是否把 Agent 交互上报为控制评论 |

### 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_CASTBOARD_SYNC=0` | 关闭共享库同步 |
| `DSH_CASTBOARD_ROUTER=0` | 关闭自动规划 / 路由 |
| `DSH_CASTBOARD_PORTRAIT=0` | 关闭项目肖像 |
| `DSH_CASTBOARD_RUNTIME=0` | 关闭 runtime 执行通道 |
| `DSH_CASTBOARD_RUNTIME_ALLOW_CROSS_ACCOUNT=1` | 允许跨账号 runtime（默认只允许同账号） |
| `DSH_CASTBOARD_MAX_CONCURRENT=<n>` | 覆盖并发上限 |
| `DSH_CASTBOARD_SYNC_INTERVAL_MS=<n>` | 同步轮询间隔 |
| `DSH_CASTBOARD_COMMENT_POLL_MS=<n>` | 评论轮询间隔 |
| `DSH_CASTBOARD_PORTRAIT_TTL_MS=<n>` | 肖像会话 TTL |
| `DSH_CASTBOARD_ROUTER_MODEL=<model>` | 规划会话默认模型 |
| `DSH_CASTBOARD_PORTRAIT_MODEL=<model>` | 肖像会话默认模型 |
| `DSH_TEAMWORK_AUTOSTART=0` | 不自动拉起本地 teamwork |
| `DSH_TEAMWORK_DATA=<dir>` | teamwork 数据目录 |
| `DSH_TEAMWORK_INSTANCE=<ip:port>` | 当前实例地址覆盖值 |
| `CASTBOARD_TRACE=1` | 工具调用追踪日志 |

### 数据目录

```text
$DSH_HOME/storages/castboard/
├── castboard-task.json          任务索引
├── castboard-issue.json         issue 索引
├── castboard-link.json          issue ↔ task / 会话关系
├── castboard.settings.yaml      看板设置
├── castboard-templates.json     用户任务模板
├── castboard.pid                单写者租约
├── tasks/                       每个任务的详情与执行历史
├── issues/                      每个 issue 的详情
└── comments/                    每条 issue / task 的评论流

$DSH_HOME/storages/teamwork/
└── server/
    ├── teamwork.db              项目 / 成员 / 设备 / issue 共享库
    ├── files/                   共享库附件
    ├── config.json              可选服务配置
    └── run/server.json          本地服务单实例锁
```

## Runtime 安全边界

Runtime 是高风险能力，默认按下面的边界执行：

1. 只有用户明确要求才创建，不用于重试、健康检查、同步或省 token；
2. `cwd` 必须是目标机已注册 workspace 内的绝对路径；
3. `permission` 必须显式，且不能超过目标 shell 的 `sandboxMode`；
4. `read-only` / `workspace-write` 在目标 shell 没有 sandbox 时直接拒绝，不降级执行；
5. 不支持 `run_in_background`、`sandbox_permissions` 等逃逸参数；
6. 默认只允许同账号；跨账号需要显式设置 `DSH_CASTBOARD_RUNTIME_ALLOW_CROSS_ACCOUNT=1`；
7. 被拒绝的命令不会 spawn，issue 结算为 `abandoned`；运行中被 sandbox 拒绝结算为 `failed`；
8. 结果评论会回到 assigner 会话，失败原因也会作为评论保留。

## 故障排查

| 现象 | 检查 |
|---|---|
| 侧边栏没有「任务面板」 | 插件是否装进当前 profile；重启 DSH；检查 peer 兼容性 |
| 项目管理空白 / 登录失败 | `dsh-magica-teamwork` 本地服务是否在 3939 启动；`DSH_TEAMWORK_AUTOSTART` / `DSH_TEAMWORK_DATA` |
| 工具返回 `degraded` | 共享库 SDK 未接上；先启动/登录 teamwork 服务 |
| issue 停在 `pending` | 目标机器是否在线；`assigneeInstance` 是否匹配；`autoRoute` 是否打开 |
| runtime 被 `abandoned` | cwd 是否为已注册 workspace；permission 是否超过 sandbox；目标平台是否匹配 |
| runtime 结果没有自动出现 | assigner 会话是否仍在线；离线会记 pending 欠账，之后补投；也可用 `castboard_issue(state)` 查看评论 |
| 评论没有投递 | 设置中 `commentsEnabled` 是否为 true；目标会话是否在线 |
| 插件行被 profile 禁用 | 检查 DSH 版本是否在 peer 范围内；**不要写 `engines.dsh`** |
| 修改源码后 UI 没变化 | 重新 `pnpm build`，重启 DSH；client 运行的是 `lib/client.js` |

## 开发与测试

```bash
pnpm typecheck      # host + tests 类型检查
pnpm test           # 单测（当前 369 例）
pnpm build          # lib/index.js + lib/client.js
pnpm e2e            # Playwright 假 shell 渲染验收
pnpm e2e:dsh        # 工作区内隔离 DSH_HOME 的真 dsh E2E
pnpm e2e:accept     # 真机 HTTP 协议面验收（不需要浏览器）
```

源码结构：

```text
src/
├── index.ts          host 插件入口（name / inject / apply）
├── host/
│   ├── ledger/       台账、租约、设置、游标
│   ├── pipeline/     同步、路由、评论投递、runtime 等流水线
│   ├── dispatch/     调度器、派发器
│   ├── exec/         执行引擎、结算、验收
│   ├── tools/        模型工具与四个能力网关
│   ├── http/         /api/castboard HTTP 面
│   └── context/      系统提示与上下文注入
├── client/           看板、项目管理、设置、交互卡片
└── shared/           线格式与共享类型
```

## 技术文档

- [整体设计](docs/technical/overall-design.md)：包边界、Host/Client 架构、数据模型、状态机、同步与执行、runtime、评论投递、安全边界。

后续会按模块补充：调度与派发、issue 流水线、runtime、评论与交互、HTTP 与工具契约。

## License

MIT
