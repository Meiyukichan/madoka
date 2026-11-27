# Castboard

> **DSH 的多人、多实例、多系统协同框架。**

Castboard 不是一块看板，也不是单机待办列表。它定义的是：

> 工作如何被创建、归属、派发、执行、观测，并把结果和产物送回原系统。

看板只是这套框架的一个**可视化投影**。同一套状态还会通过模型工具、`/api/castboard` HTTP 面和跨机事件流，被 Agent、其他 DSH 实例和外部系统使用。

> 当前包版本：`0.2.0-alpha.6`  
> 适用 DSH：`0.2.0 ~ 0.2.2`（开发和测试基线：`0.2.1-rc.5`）  
> 技术设计：[`docs/technical/overall-design.md`](docs/technical/overall-design.md)

## 阅读路线

| 你想做什么 | 建议阅读 |
|---|---|
| 第一次使用 | 5 分钟上手 → 两种入口 → 安装 → 界面使用指南 → 常见使用场景 |
| 理解它为什么强 | 五个核心机制 → 多系统 = 多事件源 → 整体架构 |
| 接入自己的系统 | 四个工具网关 → Runtime 使用指南 → 技术设计 |
| 排查问题 | 故障排查 → 配置 / 数据目录 |

下面从最直观的“它是什么”开始，再进入使用和架构。

## 一句话理解

| 概念 | 通俗解释 |
|---|---|
| **Issue** | 一张工单，也是一个事件源；进入 Castboard 的第一站 |
| **Router** | 调度翻译器；把“待规划的 issue”翻译成“可执行的 task” |
| **Comment** | 跨会话、跨实例的上下文总线；不是附属聊天 |
| **Runtime** | 远程扳手；直接在某台机器上执行一次命令，不建卡、不起会话 |
| **Teamwork** | 共享台账；保存项目、成员、设备、issue、评论和附件 |

整体流转：

```text
外部系统 / 人 / Agent
        │ 创建 issue（带 source）
        ▼
   Teamwork 共享库
        │ 认领
        ▼
   Router / Runtime
        │ 转 task / 直接执行
        ▼
   Agent 会话 / 目标 shell
        │ 评论、交互、结果、产物
        ▼
   回到 issue，再回给源系统
```

## 为什么不是普通看板

普通看板停在“把事记下来”。Castboard 还回答：

- **谁来做**：项目、成员、角色、assigner / assignee；
- **在哪做**：目标 DSH instance 和它所在的机器、操作系统；
- **以什么权限做**：read-only / workspace-write / danger-full-access；
- **做到哪一步**：状态机、依赖、评论、交互、执行历史；
- **做完怎么回来**：结果评论、产物附件、回写源系统。

它不是单机单人的待办列表，而是一张跨越 **多人、多实例、多操作系统、多个 DSH 宿主** 的协作网。

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

## 两种入口：界面和对话

Castboard 不要求你先打开面板。它有两种入口，最终落到**同一套 issue / task / 评论 / 状态链路**：

| 入口 | 适合 |
|---|---|
| **界面** | 看全局、拖卡、改配置、处理交互 |
| **对话** | 快速记录、直接派活、临时插入一条 issue |

### 直接对话创建 issue

在 DSH 会话里直接对 Agent 说：

```text
帮我创建一条 issue：修复登录页在移动端的布局。
```

Agent 会通过 `castboard_issue(create)` 创建 issue。如果信息不够，它会继续问，或者用 `castboard_teamwork` 查项目、成员、设备。

更完整的说法：

```text
帮我建一条待规划 issue：
项目：试点项目
标题：修复登录页在移动端的布局
详情：iPhone 13 上按钮溢出，验收标准是 375px 宽度下不横向滚动。

把这个需求派给 yukino 的在线设备。
```

也可以直接在对话里补评论、回答交互：

```text
在这个 issue 下补一句：验收标准是 375px 宽度下不横向滚动。
执行方问目录选哪个，帮我回答：用 D:\project-code\test\deepseek-harness。
```

### 对话入口不是“绕过系统”

对话创建 issue 仍然走：

```text
castboard_issue(create)
  → 共享库 issue
  → 待规划 / router / runtime
  → 评论与状态回写
```

所以它和界面创建没有两条数据链：只是入口不同，事实来源相同。

### 界面入口

适合需要看全局的时候：

- 任务面板看四列、拖卡、排序、筛选；
- 项目管理看项目、成员、设备；
- 任务详情看执行历史、评论、交互、附件；
- 设置页改并发、评论、Router / 验收策略。

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

普通安装直接用 npm 包：

```bash
dsh plugin --profile <profile> add @meiyukichan/dsh-magica-castboard@0.2.0-alpha.6
```

例如：

```bash
dsh plugin --profile web add @meiyukichan/dsh-magica-castboard@0.2.0-alpha.6
```

也可以不写版本，跟随 npm 的 `latest`：

```bash
dsh plugin --profile <profile> add @meiyukichan/dsh-magica-castboard
```

安装后重启对应 DSH 实例。启动成功后，侧边栏会出现两个入口：

- **任务面板**：看板与任务台账；
- **项目管理**：项目、成员、设备与 issue 详情。

> `link:<path>` 只用于本地开发调试，普通用户不需要；下面「开发与测试」会单独说明。

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

## 五个核心机制

> 这一段解释 Castboard 的设计取舍；只想先用起来，可以先跳到「界面使用指南」，需要理解架构时再回来。

一句话版本：

> **issue 是事件，router 是转换器，评论是上下文总线，interaction 是非阻塞事件，runtime 是跨实例直连 RPC。**

### 1. Issue as Event Source：issue 是事件源

每一件进入 Castboard 的工作，先成为一个 issue：

- 带 `source` / `sourceInstance`，知道来自哪个系统、哪台实例；
- 带稳定的 `issueId`，天然是幂等键；
- 可以来自人、Agent、IM、工单、CI、监控或任何接了 teamwork SDK 的系统；
- 事件不等于“消息”：它有状态、依赖、归属、评论和产物。

所以 Castboard 不是“收消息再转发”，而是**把事件变成可执行、可追踪的工作对象**。

### 2. Router as Protocol Converter：router 是协议转换器

Router 不生产工作，它把一种工作形态转换成另一种：

```text
issue（待规划事件）
  → 临时规划会话（结构化 decision）
  → task（可执行卡片）
```

- 普通 issue 由 router 规划成 task；
- `direct` issue 跳过规划，直接转 task；
- `runtime` issue 跳过 router，直接进入 runtime worker；
- 依赖未满足、会话起不来、规划失败都有退避和明确终态。

它本质上是**跨形态协议转换层**：把“外部系统的事件”翻译成“DSH 能执行的卡”。

### 3. Comment as Context Bus：评论是上下文总线

评论不是附属聊天，而是 Castboard 的**跨会话、跨实例上下文总线**：

- append-only 持久化，不原地改历史；
- 多种协议共存：
  - 普通文本评论（人 / Agent）；
  - 系统评论（状态、错误、runtime 结果）；
  - JSON 控制评论（`requested` / `answered` / `completed`）；
- 投递三档：live session 直接 `push` / `steer` / `followUp`，远端实例走 inbox；
- 发布/拉取游标记录水位，`commentId` 保证幂等；
- 目标不在线就记 pending 欠账，之后补投。

默认轮询是秒级（`commentPollMs=5000`），本地投递走合并窗口，属于**准实时**而不是同步 RPC。好处是：慢网络、会话重启、跨机器都不会丢上下文。

### 4. Interaction as Non-blocking Event：交互上报不阻塞执行

Agent 执行中的提问 / 审批不是另开私有通道，而是：

```text
Agent interaction
  → 控制评论（requested）
  → issue 事件流
  → 远端 / 面板回答（answered）
  → 回到执行会话
```

- 上报本身不阻塞执行；
- 答案可以来自另一个会话、另一个实例，甚至另一个用户；
- 关闭评论通道时，上报和应答一起停，但执行本身不被卡死；
- 是否等待答案由 Agent 的交互语义决定；Castboard 只负责把事件送到正确的一侧。

### 5. Runtime as Direct RPC：runtime 是跨实例直连 RPC

`runtime` 是 Castboard 里一条特殊执行路径：

```text
issue(urgency=runtime)
  → 目标 instance 认领
  → 目标平台选择 pwsh / bash
  → 直接通过 shell 执行一次命令
  → 结果作为系统评论回传
```

- 不建 task；
- 不起 Agent 会话；
- 不经过 router；
- 有 cwd / permission / sandbox 三道闸门；
- 跨 Windows / Linux / macOS 自动选择目标工具；
- 结果按 RPC 语义回传给 assigner，但底层仍是可审计的 issue 评论。

一句话：**它把“远程执行一次工具”做成了共享库里的一个事件，而不是一条黑色 RPC。**

## 三种执行形态

| 形态 | 谁在动 | 适用场景 |
|---|---|---|
| **本机执行** | 当前实例的 Agent 会话 | 本机开发、修 bug、写文档 |
| **跨机派活** | 目标实例的 Agent 会话 | 让另一台机器 / 另一个人执行 |
| **Runtime 直连** | 目标实例的 shell | 只读检查、临时命令、探活 |

三种形态共享同一套事实来源：**issue、评论、状态和产物都在共享库里**；差别只是“谁来执行、是否建卡、是否起 Agent 会话”。

## 多系统 = 多事件源

Castboard 里的“多系统”不是简单把几个服务拼在一起，而是：

> **每个系统都是一个独立事件源；issue 是跨系统流转的事件；执行结果和产物会回到源系统可消费的事件流。**

```text
系统 A（工单 / IM / CI / 监控 / 业务后台）
        │ teamwork SDK：创建 issue
        │ source = "jira" / "im" / "ci" ...
        ▼
┌─────────────────────────────┐
│ Teamwork 共享库              │
│ issue + source + comments   │
└──────────────┬──────────────┘
               │ Castboard 认领 / 执行
               ▼
┌─────────────────────────────┐
│ Castboard Host              │
│ Agent 会话 / Runtime        │
└──────────────┬──────────────┘
               │ 结果评论 / artifacts
               ▼
        回到共享库的事件流
               │
               ▼
系统 A 通过 teamwork SDK 拉取结果 / 产物
```

关键点：

- **保留事件源身份**：issue 携带 `source` 和 `sourceInstance`；
- **来源字典**：`source` 必须先在 `dsh_teamwork_issue_source` 注册；
- **统一事件模型**：IM、工单、CI 进入共享库后都是同一种 issue / comment / artifact；
- **结果回写**：执行结果写成 issue 评论，产物挂成附件；源系统通过 SDK 拉取，或用自己的集成把事件流接回业务系统；
- **不侵入源系统**：不需要把外部系统改造成 DSH 插件，只需要它接 teamwork SDK（或 HTTP 面）。

这就是“多系统协同”的含义：**不是让所有系统变成 DSH，而是让所有系统的事件都能进入同一条可执行、可回传的事件流。**

## 整体架构

```text
              人 / 浏览器 / Agent / 外部系统
                             │
                             ▼
              ┌──────────────────────────────┐
              │ Castboard Host（控制面）      │
              │ 租约 / 调度 / 路由 / 策略      │
              │ 执行面：Agent 会话 / Runtime   │
              │ 事件面：评论 / 交互 / 结果     │
              └──────────────┬───────────────┘
                             │ SDK / HTTP
                             ▼
              ┌──────────────────────────────┐
              │ Teamwork（数据面）            │
              │ 项目 / 成员 / 设备 / issue     │
              │ 评论 / 附件 / 在线状态         │
              └──────────────▲───────────────┘
                             │ SDK / HTTP
              ┌──────────────┴───────────────┐
              │ DSH Host B / C / D …          │
              │ Windows · Linux · macOS       │
              └──────────────────────────────┘
```

三个平面各司其职：

| 平面 | 职责 | 关键设计 |
|---|---|---|
| **控制面** | 谁执行、何时执行、执行成什么状态 | 单写者租约、CAS、状态机、owner gate |
| **数据面** | 项目、成员、设备、issue、评论、附件 | 共享库权威、本地镜像、增量游标 |
| **执行面** | Agent 会话、runtime 命令、产物 | spellbook 门面、permission / sandbox、失败不重跑 |

### 一致性保障

- **本机单写者**：同一 `DSH_HOME` 只有一个可写 owner，避免多进程写坏台账；
- **云端 CAS**：跨实例认领 issue 走 compare-and-set，先到先得；
- **镜像不覆盖执行状态**：远端只更新 issue 的镜像字段，不把本地 `routing` / `running` / `success` 改回去；
- **至少一次投递**：评论投递允许重试，但靠 `commentId` 保证幂等；
- **失败可解释**：超时、sandbox 拒绝、权限超限、cwd 不合法都会落到明确的 issue 状态与评论，而不是静默失败。

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

> 默认用「工作区内修改」。只有确实需要读工作区外文件或执行全局操作时才选「完全权限」。

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
# 直接建 issue
帮我创建一条 issue：修复登录页在移动端的布局，项目用「试点项目」。

# 带完整信息建 issue
建一条待规划 issue：项目「试点项目」，标题「修复登录页在移动端的布局」，
详情「iPhone 13 上按钮溢出，验收标准是 375px 宽度下不横向滚动」。

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

本地源码调试时，才把当前目录链接进 profile：

```bash
dsh plugin --profile <profile> add link:<path-to-dsh-magica-castboard>
```

> 这是开发调试入口；从 npm / dshmarket 安装的用户请使用上面的普通安装命令。

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
