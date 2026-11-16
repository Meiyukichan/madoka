# dsh-teamwork · 待办与未决项

> 本文件记录**「已经确认要做、但协议未定 / 尚未排期」**的事项。
> 与设计文档的分工：`api-design.zh.md` / `sdk-design.zh.md` 写**已定稿**的契约；
> 这里写**还没有契约**的缺口，以及补齐它需要拍的决策。
>
> 每条的格式固定：背景 → 缺口（协议/端点/SDK 三层）→ 可选方案 → 影响面 → 验收 → 状态。
> 定稿后把内容搬进 `api-design.zh.md` 与 `sdk-design.zh.md`，本条降级为「已关闭」。

| # | 事项 | 影响面 | 状态 |
|---|---|---|---|
| TODO-1 | **权限（审批）/ 问答（提问）等「待决交互」事件的特殊通道** | 协议（表 + 端点）、SDK（原子 + 组合）、`dsh-magica-lattice` 协同链路 | 🟡 未决（协议未定，本轮不进 SDK） |
| TODO-2 | **`src/server` 是否迁到 `@meiyukichan/dsh-magica-spellbook` 的 `createJsonRouter`** | 服务端路由层（47 端点 / 118 用例）；SDK 不受影响 | 🟡 未决（当前保持 Fastify） |

---

## TODO-2 · 服务端路由：保持 Fastify，还是切到发布包的 `createJsonRouter`？

### 背景

`@meiyukichan/dsh-magica-spellbook@0.2.0-alpha.1` 已发布，它的 `createJsonRouter` / `jsonRoute` /
`sendJson` / `sameOrigin` / `readJsonBody` 是"**插件自建 JSON HTTP 面**"的官方实现（四道闸：方法门 →
信任围栏 → 读体闸门 → 匹配；`/magica/interactions` 就是这套）。SDK 侧的出站与日志已经切过去（设计文档 §11.2/§11.3）。

服务端 `src/server` 目前是 **Fastify**：47 个路由 + TypeBox 严格 schema + 118 个用例（含合约测试）。

### 两难

| 方案 | 优点 | 代价 |
|---|---|---|
| **A. 保持 Fastify**（当前） | 现有用例全绿；schema/错误处理/限流已成型；`reply.hijack()` 也能局部共存 | 与"新 HTTP 面统一用发布包 router"的纪律不完全一致（但服务端不是插件，是独立进程） |
| **B. 整体切到 `createJsonRouter`** | 一个路由框架、一套闸门；与插件侧同构 | 47 个端点的写法要重写；TypeBox 校验、错误体、限流、文件流下载都要重新接；118 个用例需复核 |
| **C. 局部共存** | 新端点用发布包 router（`app.all(path, { preHandler })` + `reply.hijack()` 交给 node:http），旧端点留 Fastify | 两套并存，心智成本 + 边界容易漏（如 404/405 语义） |

### 建议

**A + 纪律**：本包是"参考实现服务端"，不是插件；HTTP 面纪律只约束**新写的插件侧路由**（见设计文档 §11.7）。
若将来要开源给第三方当"标准模板"，再评估 B（那时值得一次性重写 + 全量回归）。

### 状态

🟡 未决；不影响 SDK 进度（SDK 半侧没有 HTTP 面）。触发条件：出现第二个 HTTP 消费方，或服务端需要与插件共用一套路由闸门。

---

## TODO-1 · 权限 / 问答等「待决交互」缺少跨实例通道

### 1. 背景（为什么这条会落在 teamwork）

`dsh-magica-lattice/docs/raw` 那套文档里，共享库只承载了五类协作事实：

| 已有通道 | 载体 | 方向 |
|---|---|---|
| issue | `issues` 表（7 值状态机） | 下发 ⇄ 执行 |
| 评论 | `issue_comment`（`commentId` 幂等 + 自增 id 游标） | 双向 |
| 附件 | `issue_attachment` + `files/<fileId>` | 双向（`input` / `output`） |
| 关系与肖像 | `device_workspaces`（`index` / `portal`）、`devices` | 上报 → 查询 |
| 项目与人 | `projects` / `project_member` | 派活寻址 |

**缺的正好是"卡住的那一刻"**：执行方跑会话时弹出的**审批（approval）**与**提问（user-questions）**，
在 magica 里是一张**只存在于本进程内存**的待决表，配套一个**本机 HTTP** 读写面
（`/magica/interactions`：GET list + 3 个 POST；`PendingInteractionRecord` =
`{kind:'question'} | {kind:'approval'}`；归属判定只认**本机会话台账**）。

于是出现一个结构性问题：

> 下发方在 A 机器，执行会话在 B 机器。B 的 agent 卡在一个审批上等 30 分钟，
> **A 完全看不到**；A 也没法替他点那个"允许"。而 issue 的状态仍然是 `running`，
> 看板上显示"执行中"，实际是"在等人"。

这与三维协同里的「**多人**」维度直接冲突：多人协同的定义是"同一件事由两个人从两端推进"，
而审批/提问恰恰是最需要两个人对齐的时刻。

### 2. 缺口（三层，逐层都能独立排期）

#### 2.1 协议层（表 + 语义）

| 缺什么 | 说明 |
|---|---|
| 一张「待决交互」表 | 至少要有：`interactionId`（幂等键）、`issueId`（或 `taskId` 锚点）、`kind`（`approval` / `question`）、`payload`（原始 JSON：`toolName` / `callId` / `reason` / `args` / `questions` / `options` / `intent`）、`status`（`pending` / `answered` / `canceled` / `expired`）、`ownerInstance`（谁在等）、`assigner`/`assignee`（两端账号）、`since` / `claimedAt` / `settledAt`、`revision` |
| 一张「应答」表（或并入上表） | `interactionId` + `answer`（`InteractionAnswerItem[]` 或 `approve/deny` + `reason`）+ `answeredBy` + `answeredAt`；一个 interaction 只能被结算一次（CAS） |
| 一个增量游标 | 与评论一致：**自增 `id` 做游标**，`(items, nextSinceId, hasMore)`；不用时间戳（会漏） |
| 幂等语义 | 同 `interactionId` 重复上报 → upsert，不新增行（否则重发会变成两条待办） |
| 过期语义 | `expired` 是**服务端可判**的状态（TTL），还是只由调用方 `cancel`？（需要定） |
| 敏感度 | 审批的 `args` 可能是文件内容/命令原文。**当前协议的 C 组一律"任何登录用户可读"**，这条通道不能照抄——需要参与者过滤或字段级加密（见方案 C） |

#### 2.2 端点层（建议形状，对齐现有 C 组写法）

| # | 端点 | 方法 / 路径（草案） | 用途 |
|---|---|---|---|
| 1 | `interactionSubmit` | `POST /interactions/batch` | 执行方把本机待决交互上报（幂等 upsert） |
| 2 | `interactionList` | `GET /interactions` | 按 `issueId` / `status` / `kind` 查询（下发方看板用） |
| 3 | `interactionListSince` | `GET /interactions/since` | 增量拉取（`sinceId` + `limit`，与评论同形） |
| 4 | `interactionClaim` | `POST /interactions/claim` | 声明"我这边有人在处理"（可选，跨实例去重） |
| 5 | `interactionAnswer` | `POST /interactions/{id}/answer` | 结算（`expectedStatus:'pending'` 条件更新，防双答） |
| 6 | `interactionCancel` | `POST /interactions/{id}/cancel` | 会话没了 / 用户撤单 / 超时 |

> 为什么不复用评论表：评论是**append-only 文本流**，没有"当前状态"、没有 CAS、也没有
> "一个待决只能结算一次"。硬塞进评论会把"谁在等"变成"谁说过什么"，看板与一致性都做不了。

#### 2.3 SDK 层（补齐后要加什么）

| 层 | 新增 |
|---|---|
| 原子 | `client.interaction.submit/list/listSince/claim/answer/cancel`（6 个）+ 端点表 6 行 |
| 组合 | 建议 4 个：`latticePendingInteractions({ issueId, kind? })`、`latticeOpenInteraction(input)`（按 issue 上下文建一条）、`latticeAnswerInteraction(id, answer)`、`latticeCancelInteraction(id, reason?)` |
| 约束 | 一律"**一拍一次**"（D20）：`waitInteraction()` 这种"内部等答案"的方法**不做**，等待由插件的 5s 轮询驱动 |
| 组合层的顺序保证 | `issueFinalize` 之前若还有 `pending` 的 interaction，应能**本地拒绝**（否则会出现"标了 success 但审批还没人答"） |

### 3. 可选方案

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A. 新增独立表 + 6 端点**（推荐） | 上面 §2.1/§2.2 的形状 | 语义准（有状态 + CAS + 过期）；看板能画"谁在等" | 表数 +1（或 +2）；协议扩面 6 个端点 |
| **B. 复用评论通道 + 结构化 payload** | 用 `commentRole` / `commentAuthorType` 区分，正文塞 JSON；答案 = 另一条评论 | 零协议改动，最快能跑 | 没有当前状态（要扫全部评论）、没有 CAS（双答无法仲裁）、看板要自己算"最新一条是不是答案" |
| **C. A + 字段级加密 / 参与者过滤** | 表同 A；`payload` 与 `answer` 走加密或"只对 assigner/assignee 可读" | 审批内容敏感，这是长时间要走的唯一正解 | 需要先定密钥与可见性模型；C 组现有的"不过滤"约定要单独开口子 |

**倾向**：先做 **A（不含加密）**，把通道跑通；同时**明确写下**"本协议不做资源级鉴权"这一既有约定
在这条通道上**不适用**（审批/提问必须至少参与者可见），加密留作 C 排后续。

### 4. 影响面（不做会怎样）

| 场景 | 现状 | 缺口的后果 |
|---|---|---|
| 跨机下发 + 执行方需要审批 | 下发方看不到、也点不了 | 看板显示"执行中"，实际卡死；只能人工去那台机器上点 |
| 执行会话需要提问（`AskUserQuestion`） | 同上 | 一问就停，直到本机用户回归 |
| issue 收尾 | `issueFinalize` 不看 interaction | 可能"审批没答就标 success"（本地台账是权威，远端只是镜像） |
| 多人协同的评论通道 | 能传文本，不能传"待决状态" | "我等你在审批"这句话只能靠人手打评论 |

### 5. 验收（补齐后必须能证明）

1. 两台机器、两个账号：B 上报一条 `approval` → A 的看板在 5s 内看到 → A 结算 →
   B 的会话在下一拍拿到答案并继续；全程 issue 状态只从 `running` 走到 `finished` 一次。
2. 双答竞态：A 与 C 同时对同一 interaction 结算 → **恰好一个成功**，另一个 `status_conflict`。
3. 幂等：B 重复上报同 `interactionId` → 库里仍是一条。
4. 过期：会话没了 → `cancel` 后 `status='canceled'`；结算已 `canceled` 的 → 明确失败码。
5. 可见性：非参与者账号拉列表 → 看不到这条（或看不到 `payload` 明文）。
6. 回归：`issueFinalize` 在有 `pending` interaction 时的行为被固定下来（拒绝或显式允许 + 记录）。

### 6. 状态与排期

| 项 | 值 |
|---|---|
| 状态 | 🟡 **未决**：协议形状没定，本轮（`sdk-design` §17 的 M0–M4）**不实现** |
| 谁定 | 协议侧（`api-design.zh.md` 作者）先定 §2.1 的五个空白：过期语义、可见性、CAS 字段、`payload` 形状、锚点用 `issueId` 还是 `taskId` |
| 定稿后的落点 | ① `api-design.zh.md` 新增「模块 I · 待决交互」；② `sdk-design.zh.md` §7.2 端点表 +6、§9.2 原子 +6、§10 组合 +4；③ 测试加 `sdk-interaction.test.ts` + 上面 §5 的六个断言 |
| 关联文档 | `dsh-magica-spellbook/docs/raw/d.md`（待决交互 host 面：线上契约 / 归属闸门 / HTTP 读写面）、`…/e.md`（水位认领与闸门顺序）、`…/i.md`·`…/j.md`（`approval.ts` / `questions.ts` 的会话级接管） |

---

## 附：待办维护约定

1. 新增条目先写「背景 + 缺口」，**不要**先写方案——方案会变，缺口不会。
2. 每条必须有「不做会怎样」，否则无法排优先级。
3. 状态只有三档：🟡 未决 / 🟢 已定稿待实现 / ✅ 已关闭（并注明落到哪份文档的哪一节）。
4. 定稿后**搬走内容**，本文件只留一行摘要 + 指针，避免两处维护同一事实。
