# Castboard

DSH 0.2 的协作看板与 Agent 派活中枢：把想法记成 issue，把工作派给某台机器上的 Agent 会话执行，执行结果、评论、交互和产物再回到共享库。

Castboard 不是一个孤立的看板。它把三件事接在同一套链路上：

- **任务面板**：看板、任务台账、cron 调度、执行与验收；
- **项目管理**：项目、成员、设备、issue 与共享库评论；
- **远程执行**：把任务派给目标 instance 的 Agent 会话，或者以 `runtime` 方式直接执行一次命令。

> 当前包版本：`0.2.0-alpha.6`  
> 适用 DSH：`0.2.0 ~ 0.2.2`（开发和测试基线：`0.2.1-rc.5`）  
> 技术设计：[`docs/technical/overall-design.md`](docs/technical/overall-design.md)

## 5 分钟上手

适合：只有一台机器，想让 DSH Agent 按卡片干活。

1. 在 dshmarket 或 CLI 安装 Castboard，然后重启 DSH；
2. 打开侧边栏 **项目管理**；
3. 第一次使用先注册账号 —— **第一个注册的账号自动成为 administrator**；
4. 新建一个项目，例如「试点项目」；
5. 打开侧边栏 **任务面板**，点「新建任务」；
6. 填写标题、项目、任务详情。权限保持默认的「工作区内修改」；
7. 创建任务，把卡片放在「待办」；
8. 打开任务详情，点「立即执行」；
9. Agent 会在一个新会话里执行，并在「时间线」里汇报；
10. 执行结束后卡片进入「待验收」，你确认结果后拖到「完成」。

这样一条最小闭环就跑通了。

## 它能做什么

| 能力 | 你会得到什么 |
|---|---|
| 任务看板 | 待办 / 进行中 / 待验收 / 完成 四列，拖拽、排序、搜索、模板 |
| 任务台账 | 单写者租约、原子写、执行历史、验收策略、导入导出、诊断 |
| 派活 | 把任务派给指定机器上的 DSH Agent 会话执行 |
| Issue | 待规划、依赖、认领、转任务、跨机追踪、评论与附件 |
| Runtime | 目标 instance 直接执行一次命令，不建卡、不起 Agent 会话 |
| 交互回传 | Agent 的提问 / 审批以控制评论同步到 issue，可远程回答 |
| 项目管理 | 项目、成员、设备在线状态、工作区肖像、issue 详情 |
| 自动产物 | 执行结束后按 `execution_report.artifacts` 自动上传附件 |

## 核心概念

| 概念 | 说明 |
|---|---|
| **Task / 任务** | 看板上的卡片，会进入执行队列；一次执行是一个完整 Agent 会话 |
| **Issue** | 待规划或跨机派发的工作项；可转成 task，也可直接 runtime 执行 |
| **Project / 项目** | 任务与 issue 的归属；teamwork 里同时维护成员和可见性 |
| **Instance** | 一台在线 DSH 设备，地址是 `host:port` |
| **Assignee** | 负责执行的人；目标 instance 属于这个账号 |
| **Runtime** | 目标 instance 直接执行一次命令，不建 task、不起 Agent 会话 |
| **Interaction** | Agent 执行中的提问 / 审批；同步成 issue 控制评论后可远程回答 |
| **Artifact** | 执行产物；执行报告里的 artifacts 会自动上传并挂到 issue |

## 环境要求

- DSH `0.2.0 ~ 0.2.2`；
- Node.js `>= 22.5`；
- 用 npm / dshmarket 安装不需要 pnpm；从源码开发需要 pnpm `>= 11`；
- 同一 `DSH_HOME` 建议只跑一个可写实例：Castboard 通过租约保证单写者。

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

装进 profile：

```bash
dsh plugin --profile <profile> add link:<path-to-dsh-magica-castboard>
```

## 界面使用指南

### 任务面板

任务面板由四列主状态加一条「待规划」泳道组成：

```text
待规划 issue │ 待办 │ 进行中 │ 待验收 │ 完成
```

#### 顶部工具栏

| 操作 | 用途 |
|---|---|
| 新建任务 | 创建一张任务卡 |
| 从模板新建 | 用内置/自定义模板快速建卡 |
| 搜索 | 按标题或 ID 搜索 |
| 项目筛选 | 只看某个项目的任务 |
| 列内排序 | 默认 / 最近更新 / 紧急度 / 创建时间 / 标题 |
| 设置 | 并发、自动规划、评论、交互、工作区指导、Router/验收策略 |
| 导入 / 导出 | 完整 JSON 备份导入，或导出 JSON / CSV |
| 诊断 | 检查台账、租约、索引健康 |

#### 看板列

- **待规划**：还没转成任务的 issue；可以新增、编辑、补讨论、填本机附件路径；
- **待办**：等待执行；
- **进行中**：有 Agent 会话正在执行；
- **待验收**：执行结束，等待你确认或自动验收；
- **完成**：验收通过，可归档；
- **其它任务**：已取消、已归档、已删除的任务收在这里。

卡片可以直接拖到允许的状态；非法迁移会提示原因。

#### 任务详情

点开卡片后进入任务详情，三个页签：

- **任务详情**：标题、正文、清单、附件、验收策略、执行配置；
- **执行配置**：模型、权限、执行方式、cron、执行历史；
- **时间线**：Agent 的进度评论、用户留言、系统消息。

常用动作：

- **立即执行**：新建会话跑一次；
- **停止执行**：停掉当前执行会话，任务回到待办；
- **跳转会话**：打开对应 DSH 会话；
- **复制任务**：沿用全部配置生成一张新卡；
- **存为模板**：把配置（含清单）保存为模板；
- **标记受阻 / 解除受阻**；
- **释放认领**：任务回到待办（确认持有会话已停止后再做）；
- **归档**：可选择连同执行会话一起归档；
- **删除 / 物理清除**：删除先标记，物理清除不可恢复。

### 新建 / 编辑任务字段

| 字段 | 说明 |
|---|---|
| 标题 | 一句话说清要做什么 |
| 项目 | 归属项目 |
| 任务详情 | 需求、背景、验收标准 |
| 模型 | 可选；留空用默认模型，也可以填 `provider/model` |
| 紧急度 | 影响派发顺序 |
| 执行方式 | 自动排队 / 定时执行 |
| Cron | 定时执行时填写，如 `0 9 * * *` |
| 执行权限 | 仅可查看 / 工作区内修改 / 完全权限 |
| 输入附件 | 本机绝对路径，转卡后进入执行上下文 |
| 验收清单（DoD） | 执行会话逐项勾选；未完成项验收时高亮 |
| 验收策略 | 可选；进入待验收后由自动验收轮判断收不收 |

> 权限选择建议：默认用「工作区内修改」。只有确实需要读工作区外文件或执行全局操作时才选「完全权限」。

### 项目管理

打开侧边栏 **项目管理**：

- **我的项目**：你参与的项目；
- **我的 Issue**：与当前账号相关的 issue；
- **我的设备**：在线 DSH 设备、OS、instance 地址；
- 项目详情：成员、角色、可见性、负责人转让；
- Issue 详情：状态、评论流、交互控制评论、附件。

第一次使用：

1. 注册/登录本地协作服务；
2. 建项目；
3. 加成员；
4. 确认成员设备在线。

项目规则：

- **private** 项目默认最多 5 名成员（含负责人）；
- 非 administrator / leader 只能创建 private 项目；
- 项目负责人不能直接通过成员接口改角色，需要先转让负责人；
- 归档项目只读，不能加成员或建 issue。

### 交互卡片

Agent 执行中如果需要审批或提问，会生成交互：

- 任务面板 / issue 详情里显示交互卡片；
- 全局浮层也会提示待处理交互；
- 选择答案后，结果回传给执行会话；
- 关闭 `commentsEnabled` 会暂停跨机交互上报与应答，但面板本地交互仍可处理。

## 常见使用场景

### 场景 1：单机任务执行

```text
新建任务 → 填需求 → 创建 → 点「立即执行」→ 时间线看进度
→ 待验收 → 确认 → 拖到「完成」
```

适合：本机开发、文档整理、测试修复、代码审查。

### 场景 2：把工作派给另一台机器

对 Agent 说：

```text
帮我把「修复登录超时」派给 yukino，在她在线的那台机器上执行。
```

Agent 会通过 `castboard_teamwork` 查项目、成员和设备，再用 `castboard_issue(create)` 建 issue。
对方实例认领并执行，评论和结果会回到共享库的这条 issue 上。

### 场景 3：只读检查 / 临时命令

对 Agent 说：

```text
在 yukino 的 192.168.3.7:3080 上，用 read-only 权限看当前目录和 git HEAD。
```

这是 runtime 场景：不建卡、不起 Agent 会话，目标 instance 直接执行一次命令，结果作为 issue 评论回传。

### 场景 4：定时任务

新建任务时把执行方式改为「定时执行」，填写 cron，例如：

```text
0 9 * * *     每天 09:00
0 * * * *     每小时
*/10 * * * *  每 10 分钟
0 9 * * 1     每周一 09:00
```

卡片会显示下次运行时间；到点自动进入执行队列。

### 场景 5：审批 / 提问回传

执行会话请求审批时：

1. 任务面板出现交互卡片；
2. 打开卡片，选择「允许一次」或「拒绝」；
3. 答案回传执行会话；
4. issue 上保留一条交互控制评论作为记录。

### 场景 6：执行产物自动回传

Agent 在执行报告里写 `artifacts` 路径，Castboard 会在结算后：

1. 上传这些文件到共享库；
2. 建立附件关系；
3. 在任务详情的「附件」区显示输入/输出/评论附件；
4. 记录幂等，避免重复上传。

## Agent 提示词示例

可以直接对 Agent 说：

```text
# 建任务
在「试点项目」里新建一个任务：修复登录页在移动端的布局。

# 派活
把这个需求派给 yukino 的在线设备，先让她确认目录再执行。

# 查询
看一下我派出去的 issue 现在什么状态，有没有新的评论。

# 定时
建一个每天 09:00 执行的巡检任务，检查服务健康并输出报告。

# Runtime
在 192.168.3.7:3080 上，用 workspace-write 权限执行 `git status`，工作目录用当前工作区。

# 交互
执行方问目录选哪个，帮我回答：用 D:\project-code\test\deepseek-harness。
```

## 四个工具网关

Castboard 注册四个面向模型的网关工具：

| 工具 | 能力 |
|---|---|
| `castboard_task` | `list` / `get` / `move` / `report` / `checklist` |
| `castboard_issue` | `help` / `create` / `state` / `links` / `interactions` / `answer_interaction` / `convert` |
| `castboard_teamwork` | `groups` / `group_members` / `devices` / `workspaces` |
| `castboard_comment` | `get` / `add` |

典型链路：

```text
castboard_teamwork(groups)
→ castboard_teamwork(group_members)
→ castboard_teamwork(devices)
→ castboard_issue(create)
→ 目标实例认领 / 执行
→ castboard_issue(state) / castboard_comment(get)
```

## Runtime 使用指南

Runtime 只在**用户明确要求**在某个目标 instance 上执行命令时创建。它不建卡、不起 Agent 会话，目标实例直接执行一次命令。

### 请求形态

```text
urgency: runtime
assigneeInstance: 目标 ip:port
cwd: 目标机已注册 workspace 内的绝对路径
permission: read-only | workspace-write | danger-full-access
assignerMeta.runtime.arguments:
  command: string           必填
  description: string       必填
  workdir: string           可选
  timeoutMs: integer        可选，1000..600000，默认 120000
```

`runtime.tool` 不需要模型填写：目标实例按自己的平台选择：

- Windows → `pwsh`
- Linux / macOS → `bash`

### 结果怎么回来

执行完会写一条系统评论：

```text
role        = assignee
authorType  = system
systemKey   = sys.runtimeCommand
body        = runtime <tool> + outcome / exit code / stdout / stderr
```

这条评论会被当作 RPC 答案投递给创建 issue 的 assigner 会话。如果目标会话不在线，评论仍会落库，之后补投；也可以手动用 `castboard_issue(state)` 查看。

### 安全边界

1. 只有用户明确要求才创建；
2. `cwd` 必须是目标机已注册 workspace 内的绝对路径；
3. `permission` 必须显式，且不能超过目标 shell 的 `sandboxMode`；
4. `read-only` / `workspace-write` 在目标 shell 没有 sandbox 时直接拒绝，不降级执行；
5. 不支持 `run_in_background`、`sandbox_permissions` 等逃逸参数；
6. 默认同账号；跨账号需要显式 `DSH_CASTBOARD_RUNTIME_ALLOW_CROSS_ACCOUNT=1`；
7. 被拒绝的命令不 spawn，issue 结算 `abandoned`；运行中被 sandbox 拒绝结算 `failed`；
8. 结果评论会保留，失败原因也会写回。

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
| `DSH_CASTBOARD_RUNTIME_ALLOW_CROSS_ACCOUNT=1` | 允许跨账号 runtime |
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

备份建议：

- 看板：用「导出 → 完整台账（JSON）」；
- 共享库：备份 `~/.dsh/storages/teamwork/server/teamwork.db`；
- 附件：同时备份 `teamwork/server/files/`。

## 任务与 Issue 状态

### 任务状态

```text
todo → in_progress → in_review → done → archived
  ↘        ↘             ↘
 canceled  canceled      canceled
```

规则：

- `done` 只能进 `archived`；
- `archived` 是终态；
- `abandoned` 是隐藏但保留记录的终态；
- `canceled` 仍可见，可以回到 `todo`；
- 非法迁移会被工具 / API 拒绝。

### Issue 状态

```text
pending（待规划）
  → accepted（目标机已认领）
  → routing（规划 / 转换中）
  → running（执行中）
  → success / failed / abandoned
```

`runtime` issue 跳过 task / router / Agent 会话，直接执行。

## 故障排查

| 现象 | 检查 |
|---|---|
| 侧边栏没有「任务面板」 | 插件是否装进当前 profile；重启 DSH；检查 peer 兼容性 |
| 项目管理空白 / 登录失败 | teamwork 本地服务是否在 3939 启动；`DSH_TEAMWORK_AUTOSTART` / `DSH_TEAMWORK_DATA` |
| 工具返回 `degraded` | 共享库 SDK 未接上；先启动/登录 teamwork 服务 |
| issue 停在 `pending` | 目标机器是否在线；`assigneeInstance` 是否匹配；`autoRoute` 是否打开 |
| runtime 被 `abandoned` | cwd 是否为已注册 workspace；permission 是否超过 sandbox；目标平台是否匹配 |
| runtime 结果没有自动出现 | assigner 会话是否在线；离线会记 pending 欠账；也可用 `castboard_issue(state)` 查看 |
| 评论没有投递 | 设置中 `commentsEnabled` 是否为 true；目标会话是否在线 |
| 任务一直「进行中」 | 执行会话是否还活着；可停止执行，或释放认领让任务回待办 |
| 插件行被 profile 禁用 | 检查 DSH 版本是否在 peer 范围内；不要写 `engines.dsh` |
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
