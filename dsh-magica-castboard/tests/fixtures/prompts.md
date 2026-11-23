# dsh-amazing-castboard 具名上下文与提示词注入全集

> **适用版本**：`@amazing-tools/dsh-amazing-castboard` 0.1.2-alpha.204
> **事实来源**：按当前源码逐行抄录（`src/task/context.ts`、`src/issue/dispatch-guidance.ts`、
> `src/issue/portrait-prompt.ts`、`src/issue/work-session.ts`、`src/issue/router-service.ts`、
> `src/link/deliver.ts`、`src/task/index.ts`、`src/index.ts`）。
> **XML 样例是逐字模板**（`${…}` / `{{…}}` 是运行时替换位，其余字符与源码完全一致）。
> 与本文冲突时**以代码为准**。

---

## 1. 三条注入通道

castboard 往模型上下文里放东西，只有三种物理通道。理解这三条，后面所有条目都只是"往哪条塞什么"。

| 通道 | 物理形态 | 何时生效 | 能否压缩后存活 | 谁在用 |
|---|---|---|---|---|
| **① 系统提示词 section** | `ctx.systemPrompt.section({ name, order, text })` | 每次系统提示词组装（首轮、压缩后重建、每个 step） | ✅ 会 | `plugin:dsh-amazing-castboard`（宿主级）、`castboard-issue-routing`、`castboard-project-portrait`（agent 作用域） |
| **② 会话首轮具名上下文** | magica 的 `context` 选项 → `PluginContextEntry[]` → 首轮消息**末尾**的多条 `UserMessage`（`form: 'snapshot'`） | 会话建立那一刻，追加在首个 step 消息末尾（用户指令 / AGENTS.md / 运行时上下文 / 技能目录之后） | ❌ 不重投 | `castboard-task-rules`、`castboard-task-references`、`castboard-issue-references`、`castboard-project-portrait-target` |
| **③ 会话中途注入** | `agent.inject(msg)`（`next-step` 队列，`wake: false`）/ `agent.followup` / `agent.steer`；消息由 `buildPluginMessage(plugin, text, section)` 造 | 下一个 step 边界被取走；`inject` 必须**再补一轮唤醒**才会真正读到 | ❌ | `castboard-task-acceptance`、`castboard-issue-creation-guidance`、`castboard-issue-comments` |

### 1.1 具名消息是怎么造出来的（magica 侧）

`buildPluginMessage(plugin, text, section?)`（`dsh-magica/src/sessions/core.ts:202`）：

```ts
// 有 section 名 → 具名 section（GUI 的上下文行就显示这个名字）
{ kind: section, plugin, form: 'snapshot', sections: [{ name: section, text }] }
// 没有 section 名 → 普通插件上下文（GUI 行显示包名）
{ kind: 'plugin', plugin }
```

- **`name` 只影响呈现与日志**（GUI 行 label + 展开后的 section 名），模型看到的始终是 `text`。
- 一条 entry = 一条消息 = GUI 里一行上下文，所以**一个条目必须只放一个 section**。
- `context` 与 `injectContext` 都接受 `string | { name, text } | (…)[]`，由
  `toContextEntries` / `contextEntriesToMessages`（`core.ts:234/268`）归一：空串被剔除，
  `name` 缺省则退化成无名插件上下文。
- 归属插件名必须是 `@amazing-tools/dsh-amazing-castboard`（`contextPlugin: PLUGIN_NAME`），
  否则 GUI 上下文行会署名成 magica（用户报过这个 bug）。

### 1.2 为什么常驻会话的静态指导"两条腿都走"

`issue/work-session.ts` 对 router / 肖像会话的静态指导同时用 ① 和 ②：

- **② 具名插件上下文**：GUI 的「上下文注入」行里看得见名字；
- **① agent 作用域 systemPrompt section**：跟随系统提示词，**压缩后重建时自动回来**，
  插件上下文做不到这一点。

代价只是首轮多一份，换来「看得见 + 不丢」。

### 1.3 指令 vs 数据：为什么两类上下文走不同通道

`task/context.ts` 模块头把职责切分写死了，改提示词前必须先读这张表：

| 注入 | 装什么 | 性质 | 走哪个通道 |
|---|---|---|---|
| `BOARD_PROMPT_TEXT` | 看板存在 + 何时碰 + 硬约束 | **静态指令**，所有会话 | ① systemPrompt section |
| `castboard-task-rules` | 交接协议、清单操作协议、边界纪律、失败路径 | **指令**，仅执行会话 | ② 插件上下文 |
| `castboard-task-references` | 任务身份、输入附件、router 参考方案、标签、上次执行结果、上次执行至今的评论、验收清单 | **数据**，全部来自 task | ② 插件上下文 |
| `userInstruction` | 用户要做什么（任务描述） | **用户输入** | `followup` |

**为什么执行会话的上下文用 `ContextFormed` snapshot 而不是 `systemPrompt.section`**：
执行会话的上下文是**数据**，要跟着每一轮执行重新生成；系统提示词段是**静态规则**，进程启动装配一次即可。
dsh 的 `MessageSource.plugin` 带 `ContextFormed`（`@deepseek-ai/dsh-llm` 的 `llm/src/message.ts:81`），
其中 `form: 'snapshot'` 要求带 `sections: readonly ContextSnapshotSection[]`（`{ name, text }`），
GUI 会把这些 section 渲染成**可折叠的命名上下文行**，模型看到的是 `text`。
官方 `context/time-context/src/index.ts:216` 就是这么写的。

**关键推论：指令一律进 rules**。所以「怎么勾选清单」是 `castboard-task-rules` 里的
`<checklist_protocol>`（静态、无条件输出），而 references 里只有清单**内容** ——
这样「没有清单时也要能新增清单」这条指令才不会因为数据为空而丢失。

---

## 2. 全量清单

### 2.1 具名上下文（10 条）

| # | section 名 | 通道 | 受众会话 | 组装函数（文件） | 注入时机 |
|---|---|---|---|---|---|
| 1 | `plugin:dsh-amazing-castboard` | ① | **所有会话** | `BOARD_PROMPT_TEXT`（`task/context.ts:99`） | 插件 `apply()` 里注册一次 |
| 2 | `castboard-task-rules` | ② | 看板起的执行会话 | `CASTBOARD_RULES_XML`（`task/context.ts:161`，常量） | 每次**开新会话**的首轮 |
| 3 | `castboard-task-references` | ② | 看板起的执行会话 | `castboardReferences()`（`task/context.ts:226`） | 每次**开新会话**的首轮 |
| 4 | `castboard-task-acceptance` | ③ | 待验收卡的那条会话 | `castboardAcceptanceXml()`（`task/context.ts:517`） | 结算进 `in_review` 且挂策略时（一次性，`acceptanceInjectedAt` 幂等） |
| 5 | `castboard-issue-routing` | ①+② | router 常驻会话 | `castboardIssueRoutingXml()`（`task/context.ts:675`，模板在 `:581`） | 会话建立（两条腿各一次） |
| 6 | `castboard-issue-references` | ②（每轮） | router 常驻会话 | `castboardIssueReferences()`（`task/context.ts:703`） | **每条 issue 一轮**，`session.run()` 里随指令注入 |
| 7 | `castboard-issue-creation-guidance` | ③ | 正在执行、需要分发的会话 | `castboardIssueCreationGuidance()`（`issue/dispatch-guidance.ts:51`） | 模型调 `castboard_issues_help` 时 |
| 8 | `castboard-project-portrait` | ①+② | 肖像常驻会话 | `CASTBOARD_PORTRAIT_XML`（`issue/portrait-prompt.ts:48`，常量） | 会话建立（两条腿各一次） |
| 9 | `castboard-project-portrait-target` | ②（每轮） | 肖像常驻会话 | `portraitTargetXml()`（`issue/portrait-prompt.ts:150`） | **每个项目一轮** |
| 10 | `castboard-issue-comments` | ③ | 被评论唤醒的会话 | `commentsXml()`（`link/deliver.ts:600`） | 有新评论投递到对端会话时 |

### 2.2 用户消息（不是具名上下文，但同属"提示词"）

| # | 文本 | 组装函数（文件） | 作为什么发出去 | 时机 |
|---|---|---|---|---|
| A | 执行指令 | `userInstruction()` → `effectivePrompt()`（`task/context.ts:436`） | 首轮 `prompt` / 续跑 `prompt` | 每次执行轮 |
| B | 唤醒语 | `WAKE_INSTRUCTION` / `ASSIGNER_WAKE_INSTRUCTION`（`link/deliver.ts:584/589`） | 门面 `wake` 的指令 | 会话不在本进程、必须 resume 时 |
| C | 验收轮唤醒语 | `ACCEPTANCE_ROUND_INSTRUCTION`（`task/context.ts:567`） | 辅助轮 `followup` | 注入验收上下文之后 |
| D | 分发指令 | `taskDispatchInstruction()`（`task/context.ts:474`） | 辅助轮（`assist`）的 user 消息 | 人点「分发」 |
| E | router 每轮指令 | `routerInstruction()`（`issue/router-service.ts:92`） | `followup` | 每条 issue 一拍 |
| F | 肖像每轮指令 | `portraitInstruction()`（`issue/portrait-prompt.ts:173`） | `followup` | 每个项目一拍 |
| G | 建立期占位指令 | `ROUTER_IDLE_PROMPT`（`router-service.ts:101`）/ `PORTRAIT_IDLE_PROMPT`（`portrait-prompt.ts:44`） | 首轮 `prompt` | 会话建立，只为拉起并等空闲 |

### 2.3 进会话但**不是**提示词模板的文本（避免误以为漏了）

下面这些确实会进会话，但内容是**透传**（人写的、或系统生成的事实），没有模板可写：

| 文本 | 形态 | 来源 | 备注 |
|---|---|---|---|
| 人写的评论 → 续跑一轮 | 普通 user 消息（`source: {kind:'user'}`） | `followUp(taskId, text)`（`task/index.ts:590`） | 待验收卡上评论 = 在同一会话追加一轮 |
| 人写的评论 → 插话 | 普通 user 消息（`steerMessage`，`task/index.ts:133`） | `steer(taskId, text)`（`:727`） | 进行中的卡上评论，下一个 step 边界读到 |
| 结算写的系统评论 | 评论流一行（`authorType: 'system'`） | `settlement` 的 `sink.addSystem` | **只写 jsonl、不唤醒会话**（叫起来只是让它读自己刚写的通知） |
| 退回留言 | 评论流一行 | `POST /tasks/:id/reject` | `deliver: false`，不唤醒 |
| 工具返回值 | 工具结果 | 各工具的 `render` | 不是上下文注入 |

---

## 3. 按会话类型看完整组合

### 3.1 任意普通会话（用户自己开的）

```
系统提示词
 └── [① 系统段] plugin:dsh-amazing-castboard      ← BOARD_PROMPT_TEXT，极简一段
```

只有这一段。**没有**任何 castboard 具名上下文 —— 工具 schema 已经写清了怎么调，多一份就是每个会话白付 token。

### 3.2 看板执行会话 · 首轮（`trigger` = manual / dispatch / scheduled）

```
系统提示词
 ├── [① 系统段] plugin:dsh-amazing-castboard
 └── 用户指令（source: user）= effectivePrompt(task)      ← A
     紧接着首个 step 消息末尾追加两条具名上下文：
 ├── [②] castboard-task-rules        ← CASTBOARD_RULES_XML（常量，无任务数据）
 └── [②] castboard-task-references   ← castboardReferences(task, workspacePath, attachments, comments)
```

组装点：`ExecutionService.start()`（`task/index.ts:909-950`）
→ `context: buildContexts(task, workspace.path, inputAttachments, seedComments)`（`:936`）

`buildContexts()` 返回顺序**就是注入顺序**：rules 在前、references 在后。

### 3.3 看板执行会话 · 续跑（同一会话再跑一轮）

`context` 选项在 `start()` 里是一个**三元**（`task/index.ts:932-936`），三种情形互斥：

| 情形 | 投什么 |
|---|---|
| 调用方**显式给了 `extraContext`**（评论唤醒轮） | **只投 `extraContext`** —— `buildContexts` 的 rules / references **完全不投** |
| 续跑（有 `sessionId` + `followUpText`）且没给 `extraContext` | **什么都不投** —— 初始上下文已在会话日志里，重投只会在对话里凭空多出一份 |
| 全新会话 | 投 `buildContexts(...)` = rules + references |

```
（不重投 rules / references —— 它们已经在会话日志里）
 ├── 用户指令 = followUpText（人写的评论正文，或 ACCEPTANCE_ROUND_INSTRUCTION）
 └── 仅当调用方显式给了 extraContext 才投（此时也只投它）
```

**复用本进程还活着的句柄时**（`task/index.ts:892-906`）：先 `handle.followup(...)` 再
`handle.injectContext(extraContext)` —— **顺序不能反**。注入进的是 `next-step` 队列，
必须先让它开始新一轮，那条上下文才会在 step 边界被取走。

### 3.4 router 常驻会话（issue → task）

```
系统提示词
 ├── [① 系统段] plugin:dsh-amazing-castboard
 └── [① agent 作用域] castboard-issue-routing @ order 150     ← 静态指导（压缩后重建也不丢）
     会话建立那一刻同时投一份：
 ├── [②] castboard-issue-routing        ← 同文本，GUI 里看得见

每一拍（一条 issue）：
 ├── 用户消息 = routerInstruction(issueId)                   ← E，含确定性 issueId
 └── [② 每轮] castboard-issue-references ← castboardIssueReferences(issue, extras)
```

- cwd = `$DSH_HOME/storages/castboard/worklabs`，沙箱 `read-only`，单轮上限默认 2 小时
  （`DSH_CASTBOARD_ROUTER_TTL_MS`），压缩落地即换会话。
- 组装点：`openRouterSession()`（`src/index.ts:407`）+ `session.run(instruction, references)`
  （`:442-443`）→ `openWorkSession().run()`（`issue/work-session.ts:253`）。

### 3.5 项目肖像常驻会话（workspace → 肖像 md）

```
系统提示词
 ├── [① 系统段] plugin:dsh-amazing-castboard
 └── [① agent 作用域] castboard-project-portrait @ order 160   ← 静态规则
     会话建立时同时投一份：
 ├── [②] castboard-project-portrait

每个项目一拍：
 ├── 用户消息 = portraitInstruction(target)                  ← F（键: 值 行格式，不转义）
 └── [② 每轮] castboard-project-portrait-target                ← portraitTargetXml(target)（结构化真值）
```

- cwd = `worklabs/workspaces`，沙箱 `workspace-write`（写权限只落在这个 cwd），单轮上限默认 2 小时
  （`DSH_CASTBOARD_PORTRAIT_TTL_MS`）。
- 组装点：`openPortraitSession()`（`src/index.ts:462`）+ `PortraitService` 的
  `session.run(portraitInstruction(target), [{ name: PORTRAIT_TARGET_SECTION, text: portraitTargetXml(target) }])`
  （`issue/portrait-service.ts:284-285`）。

### 3.6 被上游 issue 评论唤醒的执行会话

```
（执行会话已 dispose → 门面 resume，形态是辅助轮 + 瞬态）
 ├── 用户消息 = WAKE_INSTRUCTION / ASSIGNER_WAKE_INSTRUCTION   ← B，只有一句触发语
 └── [③/②] castboard-issue-comments ← commentsXml(anchorId, comments)
```

组装点：`CommentDeliverer` → `ExecutionService.wakeForComment(taskId, instruction, commentsXml)`
（`task/index.ts:437`）→ `start(taskId, 'issue-comment', instruction, true, true, context)`。

会话**还活着**时不走这条路：直接 `agent.followup` / `agent.steer` 一条
`buildPluginMessage(..., ISSUE_COMMENTS_SECTION)`，**不发那句触发语**（见 `pushContextTo`，`task/index.ts:357`）。

### 3.7 执行会话 · 自动验收轮

```
结算落地 → 卡片进 in_review 且挂策略
 ├── [③] castboard-task-acceptance ← castboardAcceptanceXml(task, chosen)   ← 先注入（agent.inject）
 └── 紧接着一轮辅助轮 followup：ACCEPTANCE_ROUND_INSTRUCTION            ← C，只有一句
```

- `agent.inject()` 是 `wake: false` 的纯排队，**没有这一轮唤醒就永远读不到**（实测过）。
- 三条守卫：只在 `in_review`、必须有策略、`acceptanceInjectedAt` 未写过。
- 组装点：`injectAcceptanceContext()`（`task/index.ts:627`）+ `startAcceptanceRound()`（`:688`）。

### 3.8 执行会话 · 人点「分发」

```
[③] 不注入具名上下文，直接作为这一轮的 user 消息发出去：
     taskDispatchInstruction(task, target)     ← D
（其中 <steps> 第 1 步要求模型自己调 castboard_issues_help 去拿 ⑦）
```

组装点：`ExecutionService.dispatch(taskId, text)`（`task/index.ts:605`）→ `start(..., 'issue-dispatch', text, true)`。

### 3.9 分发指导的按需注入（⑦）

```
模型调 castboard_issues_help
 └── [③] castboard-issue-creation-guidance ← castboardIssueCreationGuidance({ instance })
     注入失败 / 调用方不是 agent 会话 → 正文改为随工具返回值下发（guidance 字段）
```

组装点：`issue/dispatch-tools.ts:590-642`。

---

## 4. 逐个 section 详解（含逐字样例）

### 4.1 `plugin:dsh-amazing-castboard` —— 常驻系统段

| 项 | 值 |
|---|---|
| 常量 | `BOARD_PROMPT_SECTION` / `BOARD_PROMPT_TEXT`（`task/context.ts:64/99`） |
| 通道 | ①（`ctx.systemPrompt.section`，插件级，所有会话可见） |
| order | `ctx.systemPrompt.getSectionOrder('TOOLS_SDK') + 100`（不自己编槽位，dsh 调整分区表时自动跟随） |
| 组装时机 | `apply()` 装配时注册一次，此后每次系统提示词组装都带上 |

**逐字正文**（源码里按句折行拼接，产出**没有任何换行**）：

```text
Use the castboard_* tools to read and write the shared task panel the user sees in the GUI. Act on a task only when the user points you at one — never go looking for board work on your own, and never let it displace what the user actually asked for. When the user does point you at a task, claim it first: castboard_get, then move it todo -> in_progress so the board shows it is taken and nobody else picks it up (skip that move if it is already in_progress, and never take over another session's task; a planned issue is not an approval). To hand it back, move it in_progress -> in_review and record the outcome with castboard_comment_add; only a session the board started as this task's execution session also calls castboard_execution_report first. If you cannot finish, comment why and move it back to todo. Only the user can move a task to done.
```

**写作纪律**（源码注释明确要求，改这段前先读）：只写工具 schema 里读不到的规则；不列能力清单；
不写 UI 细节；「认领必须带理由」要写成因果（`so the board shows it is taken and nobody else picks it up`）
而不是流程步骤。系统提示词**不国际化**（装配期产物，会话中途不会切语言）。

---

### 4.2 `castboard-task-rules` —— 执行会话的协议门禁

| 项 | 值 |
|---|---|
| 常量 | `CASTBOARD_RULES_XML`（`task/context.ts:161`，纯常量，**不含任何任务身份或数据**） |
| 通道 | ②（首轮具名上下文） |
| 组装时机 | 每次**开新会话**；续跑不重投 |
| 组装函数 | `buildContexts()` 的第一项（`task/context.ts:417`） |

**逐字样例**：

```xml
<castboard_task_rules>
<before_start when="动手之前">
  <step order="1" tool="castboard_comments">读本任务的全部评论（issue 转来的卡带的是下发方在 issue 阶段的讨论，含补充要求与澄清）</step>
  <step order="2" tool="castboard_get">读整条任务：描述、router-reference 里的推荐方案、验收清单、上次执行记录</step>
</before_start>

<handoff_protocol when="任务完成后">
  <step order="1" tool="castboard_get">读回本任务，确认状态与最新内容（避免基于过期快照收尾）</step>
  <step order="2" tool="castboard_execution_report">提交结构化执行报告：做了什么 / 改了哪些文件 / 如何验证 / 剩余风险</step>
  <step order="3" tool="castboard_comment_add">留评论：做了什么改动 / 如何验证 / 剩余风险</step>
  <step order="4" tool="castboard_move">将本任务移至待验收 in_review</step>
</handoff_protocol>

<checklist_protocol>
  <rule tool="castboard_checklist" action="check">完成一项就勾选，并在 note 里附证据。</rule>
  <rule tool="castboard_checklist" action="add">需要补充验收项时用它追加。</rule>
  <rule>未完成项会在验收时高亮，全部勾完再移待验收。</rule>
</checklist_protocol>

<boundaries>
  <rule>本会话由任务面板执行服务启动，任务已置为进行中——无需认领。</rule>
  <rule>「已完成」（done）仅限用户在界面操作，代码已限制：会话移了会被拒。</rule>
  <rule>清单勾选不等于完成；全部勾完再移待验收。</rule>
</boundaries>

<on_failure>无法完成时：留评论说明原因，并将任务移回待办 todo。</on_failure>

<issue_comments>
如果这张卡来自一条 issue（issueId 非空），你可以和下发方对话：

- **缺少上下文就主动问，不要在会话里干等**：
  `castboard_issue_comment_add { issueId: "<这张卡的 issueId>", commentRole: "assignee", body: "…" }`
  这条评论会立刻上云，并被投递到创建这条 issue 的那个会话里。
- **回答下发方的问题**：下发方的评论会以 `castboard-issue-comments` 具名上下文的形式注入你的会话，
  用 `castboard_issue_comment_add { issueId, commentRole: "assignee", body: "…" }` 回答。

⚠️ commentRole 必须是 assignee（你是执行方）。工具会按你的会话身份软校验。
⚠️ 给看板卡片留进展 / 交接评论仍然用 `castboard_comment_add`（那是本地卡片评论，也会同步上云）。
</issue_comments>
</castboard_task_rules>
```

**每个子块的作用**：

| 子块 | 何时被用到 | 为什么必须在这里 |
|---|---|---|
| `<before_start>` | 模型动手之前 | references 只带「上次执行之后」的评论（首次是全部但有条数上限），而 issue 阶段的讨论已被搬成这张卡的初始评论 —— 不先读就会把「其实早就说过了」的要求重做一遍 |
| `<handoff_protocol>` | 任务完成后 | 四步固定顺序；`castboard_get` 先读回是为了避免基于过期快照收尾 |
| `<checklist_protocol>` | 随时 | **无条件输出**：即使当前没有清单，也要知道怎么用 `action=add` |
| `<boundaries>` | 全程 | 三条都是代码已经强制的（移 done 会被拒），写出来是让模型不要白试 |
| `<on_failure>` | 无法完成时 | 唯一合法的退出路径 |
| `<issue_comments>` | 需要和下发方对话时 | 与分发指导的 `<comments>` **方向相反**（这里「我是 assignee」）；工具按会话身份软校验，两段必须各自说清自己那一侧 |

---

### 4.3 `castboard-task-references` —— 执行会话的任务数据

| 项 | 值 |
|---|---|
| 常量 | `REFERENCES_SECTION`（`task/context.ts:123`） |
| 通道 | ②（首轮具名上下文） |
| 组装函数 | `castboardReferences(task, workspacePath, inputAttachments, comments)`（`task/context.ts:226`） |
| 组装时机 | 每次**开新会话**；`comments` 由调用方从 `ThreadService` 读出（函数本身是纯函数） |

**逐字模板**（`${…}` 是运行时值，`⟨可选⟩` 表示整块可能不输出）：

```xml
<castboard_task_references>
<task id="${task.id}" source="任务面板执行服务">
  <title>${task.title}</title>
  <workspace id="${task.workspaceId}">${workspacePath}</workspace>
  ⟨当 task.issueId 非空时⟩
  <issue id="${task.issueId}">
    这张卡由上面这条 issue 转来。**发 issue 评论要传这个 issue id**：
    castboard_issue_comment_add { issueId: "${task.issueId}", commentRole: "assignee", body: "…" }
    上面 <task id="${task.id}"> 那个是**任务 id**，只能配 castboard_comment_add / castboard_move / castboard_execution_report，
    传给 castboard_issue_comment_add 会被拒。
  </issue>
</task>

⟨当有输入件时⟩
<input_attachments count="${n}" dir="${第一个附件的父目录}">
  <input_attachment index="1" name="${name}" path="${绝对路径}">${description}</input_attachment>
  <input_attachment index="2" name="${name}" path="${绝对路径}"></input_attachment>
</input_attachments>

⟨当有已结束的上一次执行时⟩
<last_execution trigger="${manual|dispatch|scheduled|followup|acceptance|issue-comment}" outcome="${succeeded|failed|cancelled}" started_at="${ISO}" ended_at="${ISO}">
  <error>${错误文本，≤500 字符}</error>
</last_execution>

⟨当上次执行之后有评论时（最多 20 条）⟩
<comments_since_last_execution count="${总数}" since="${ISO}" omitted="${被截断条数}">
  <comment by="${system|agent|user}" role="${assigner|assignee}" thread="${会话 id 前 24 字符}" author="${云端账号}" at="${ISO}">${正文}</comment>
</comments_since_last_execution>

⟨当 router 留了参考方案时⟩
<router-reference>
  <dag>${DAG 码}</dag>
  <proposal>${推荐执行方案 + 补充信息 + 注意点}</proposal>
</router-reference>

⟨当有标签时⟩
<tags count="${n}">
  <tag>${tag}</tag>
</tags>

<checklist progress="${已完成}/${总数}">
  <item index="1" checked="true" evidence="${证据 note}">${条目文本}</item>
  <item index="2" checked="false">${条目文本}</item>
</checklist>
</castboard_task_references>
```

**填好值的完整实例**（一张从 issue 转来、带附件与历史评论的卡）：

```xml
<castboard_task_references>
<task id="t-9f3a1c-7b2" source="任务面板执行服务">
  <title>给 dsh-webide 补 glibc bundle 检测</title>
  <workspace id="a3f1c9d2-8e4b-4c17-9a55-2d6f7e8b1c03">D:\projects-code\optix\common\harness\furina</workspace>
  <issue id="6f2b9d41-3c8a-4e77-bb10-5c9d2e1a7f88">
    这张卡由上面这条 issue 转来。**发 issue 评论要传这个 issue id**：
    castboard_issue_comment_add { issueId: "6f2b9d41-3c8a-4e77-bb10-5c9d2e1a7f88", commentRole: "assignee", body: "…" }
    上面 <task id="t-9f3a1c-7b2"> 那个是**任务 id**，只能配 castboard_comment_add / castboard_move / castboard_execution_report，
    传给 castboard_issue_comment_add 会被拒。
  </issue>
</task>

<input_attachments count="2" dir="C:\Users\r30038105\.dsh\storages\castboard\attachments\6f2b9d41-3c8a-4e77-bb10-5c9d2e1a7f88">
  <input_attachment index="1" name="崩溃日志.txt" path="C:\Users\r30038105\.dsh\storages\castboard\attachments\6f2b9d41-3c8a-4e77-bb10-5c9d2e1a7f88\崩溃日志.txt">线上反馈的原始栈</input_attachment>
  <input_attachment index="2" name="glibc-2.17.lock" path="C:\Users\r30038105\.dsh\storages\castboard\attachments\6f2b9d41-3c8a-4e77-bb10-5c9d2e1a7f88\glibc-2.17.lock"></input_attachment>
</input_attachments>

<last_execution trigger="manual" outcome="failed" started_at="2026-11-16T02:11:08.412Z" ended_at="2026-11-16T02:19:41.006Z">
  <error>本轮未正常结束：reason={"kind":"error"}</error>
</last_execution>

<comments_since_last_execution count="23" since="2026-11-16T02:19:41.006Z" omitted="3">
  <comment by="user" role="assigner" author="r30038105" at="2026-11-16T02:21:10.001Z">补一条：2.17 那台也要覆盖，别只测 2.28。</comment>
  <comment by="agent" thread="session-4b1e77aa-0c93-4f2e" at="2026-11-16T02:22:03.556Z">收到，我先把检测逻辑改成按 ldd 版本区间判断。</comment>
</comments_since_last_execution>

<router-reference>
  <dag>step1 -> (step2, step3) -> step4</dag>
  <proposal>落点：packages/dsh-webide/src/bundle.ts 的 detectGlibc()；先加最小复现脚本再改实现；已知坑：musl 环境没有 ldd，要按 /lib/ld-musl-* 兜底。</proposal>
</router-reference>

<tags count="2">
  <tag>webide</tag>
  <tag>glibc</tag>
</tags>

<checklist progress="1/3">
  <item index="1" checked="true" evidence="bundle.ts:118 已加版本区间判断">能识别 glibc &lt; 2.28</item>
  <item index="2" checked="false">musl 环境走 ld-musl 兜底</item>
  <item index="3" checked="false">补一条回归用例</item>
</checklist>
</castboard_task_references>
```

**关键纪律**：

- 所有用户可控文本都过 `escapeXml` / `escapeXmlAttr`（标题、清单项、评论正文里带 `<` 就能伪造标签）。
- `<issue>` 块**必须显式写清两个 id 各配哪个工具** —— 真机踩过：执行会话手里只有任务 id，
  把它当 `issueId` 传给 `castboard_issue_comment_add`，评论写进不存在的锚点、回执照样说成功，双方都以为发了。
- `comments_since_last_execution` 的 `count` 报**总数**、`omitted` 报被截断条数：只报实际条数会让模型
  以为「上次执行后只有这么多评论」，把丢掉的历史读成「不存在」。
- `by` 由 `authorType` 决定（`system` / `agent` / `user`），不再靠「有没有 threadId」猜 ——
  系统消息混进 agent 会让模型以为那是自己写的。
- `<checklist>` 为空时输出 `<checklist>本任务没有验收清单。</checklist>`，**不静默留空**
  （留空会被读成「依赖丢了」）。
- `nextRunAt` 这类「相对当前时刻」的值**不进 references / 索引**（每次落盘都变）。

---

### 4.4 `castboard-task-acceptance` —— 待验收那一轮的判断依据

| 项 | 值 |
|---|---|
| 常量 | `TASK_ACCEPTANCE_SECTION`（`task/context.ts:500`） |
| 通道 | ③（`agent.inject(buildPluginMessage(...))`）+ 紧随一轮 `followup` |
| 组装函数 | `castboardAcceptanceXml(task, strategies)`（`task/context.ts:517`） |
| 组装时机 | 结算落地后卡片进 `in_review` 且挂了策略；`acceptanceInjectedAt` 幂等，离开待验收时由路由清掉 |

**逐字模板**：

```xml
<castboard_task_acceptance>
<task id="${task.id}">
  <title>${task.title}</title>
</task>
<context>这张卡刚执行完，现在停在**待验收**。这一轮不写代码，只做判断与收尾：先判能不能收，再决定这张卡去哪一列。</context>
<steps>
  <step order="1">先看下面的 <accept_strategies>（验收为完成）：逐条核对执行报告、评论里的证据与代码事实。</step>
  <step order="2">**只要有一条不满足** → 用 castboard_comment_add 写清缺什么，然后 castboard_move 把这张卡移到 **todo（待办）**（系统会自动把它标记为「验收未通过」）。到这一步就结束，不要分发。</step>
  <step order="3">**全部满足** → 再看 <dispatch_strategies>（分发为 issue）：按它们拆出新的 issue。先用 castboard_issues_help 看建 issue 的规矩，再用 castboard_issues_create 建；一张卡可以拆多条，先后关系用 dependsOn 表达。没有 <dispatch_strategies> 就跳过这一步。</step>
  <step order="4">用 castboard_comment_add 汇总：验收结论（通过 / 不通过 + 依据），以及派了哪几条 issue（标题 + issueId）。</step>
  <step order="5">**全部满足（分发 issue 成功也算成功）** → 最后 castboard_move 把这张卡移到 **done（已完成）**。</step>
</steps>
<never>不要改执行记录，也不要替人做「遗弃 / 归档」这类删除性动作。你这一轮只做三件事：结论、新 issue、把卡移到 todo 或 done。</never>
<accept_strategies when="先看这里：能不能收">
  <strategy id="${id}" title="${title}">${description}</strategy>
</accept_strategies>
<dispatch_strategies when="确认能收之后再按这些拆 issue">
  <strategy id="${id}" title="${title}">${description}</strategy>
</dispatch_strategies>
</castboard_task_acceptance>
```

**顺序是硬要求**（用户定的）：`close`（验收为完成）策略在前、`issue`（分发为 issue）策略在后 ——
先判断这张卡能不能收，只有确认能收，才轮到「还该派什么活出去」。两个策略块各自为空时**整块不输出**。

**这一轮是 agent 唯一被允许把卡移到 `done` 的场景**：闸门在 `castboard_move` 里按
「调用方会话是否正在跑 `acceptance` 轮」放行（判据是台账里那条 `trigger==='acceptance'` 的
running 执行记录，sessionId 由 dsh 注入，agent 无法伪造）。

**唤醒语**（`ACCEPTANCE_ROUND_INSTRUCTION`，逐字）：

```text
按下面注入的 castboard-task-acceptance 执行本轮验收
```

刻意只有一句：所有要求都在上下文里，这里不重复、不加任何指令 —— 免得两处口径打架。

---

### 4.5 `castboard-issue-routing` —— router 的静态指导

| 项 | 值 |
|---|---|
| 常量 | `ISSUE_ROUTING_SECTION`（`task/context.ts:450`）、模板 `CASTBOARD_ISSUE_ROUTING_XML`（`:581`） |
| 通道 | ①（agent 作用域 systemPrompt section，order **150**）+ ②（会话建立时投一份） |
| 组装函数 | `castboardIssueRoutingXml(files)`（`task/context.ts:675`）—— 把四个绝对路径填进占位符 |
| 组装时机 | `openRouterSession()` 建立会话时（`src/index.ts:419-431`）；**每条 issue 不重投** |
| 占位符 | `{{WORKSPACES_CUSTOM}}`、`{{STRATEGY_CUSTOM}}`、`{{SCRATCH_DIR}}`、`{{TASKS_DIR}}` |

**逐字样例**（占位符已填成示例值）：

```xml
<castboard_issue_routing>
<role>你是 router：把待规划 issue 转成一张可执行的 task。**一次只处理一条**。</role>
<boundary>
**你不执行这条 issue 的工作。** 不要改代码、不要跑命令、不要写文件、不要产出调研报告/清单/方案文档。
你只做一件事：读懂 issue 已经给的诉求，**适度**补齐执行所需的信息，然后调用 castboard_issue_task 转成 task。
task 会由**单独的执行者**（别的会话 / 别的 agent）去执行 —— 你在这里"顺手帮它做掉"就是越界。
补充信息要**克制**：够下游照着干就行。不要扩大范围、不要臆造需求、不要把方案写成设计文档、
也不要把 detail 改写成另一个人写的东西（title / detail 与 issue 保持一致）。
**需求与方案必须分开放**：detail 只写「要做什么」，reference.router 只写「怎么做」—— 两边不许重复。
</boundary>
<custom_files>下面两个文件**由用户维护**，比自动生成的索引与肖像更权威；**不存在或内容为空就忽略**（不要报错、不要当成任务）：
<workspaces_custom>C:\Users\r30038105\.dsh\storages\castboard\worklabs\workspaces-custom.json（用户对 workspace 的指导：JSON，`workspaces` 是 workspaceId → 说明）</workspaces_custom>
<strategy_custom>C:\Users\r30038105\.dsh\storages\castboard\worklabs\strategy-custom.json（用户对 router 派活的策略：JSON，`strategies` 是 `[{ id, title, description }]`，顺序即优先级）</strategy_custom>
动手之前先看它们：与自动信息冲突时**以这两个文件为准**；里面点名了某个项目就按它走。</custom_files>
<inputs>当前要转换的 issue 在 <castboard_issue_references> 里。没有那一段 = 现在没有待处理的 issue，什么都不用做。
那一段可能还带三块**现场材料**（都只在有内容时才出现）：
<input_attachments>这条 issue 的输入件已下到本地（需求文档 / 日志 / 截图…），给的是路径 —— 需要读就按路径读；
<comments>下发方在共享库上的评论，常含补充要求或澄清；
<workspaces_catalog>本实例的项目清单（`index.md`）与项目肖像目录，判断 cwd 时先看这里。
</inputs>
<preparation>动手之前先看清三件事，别凭空设计：
1. 有没有可用的指导 —— <strategy_custom> 里的用户策略优先，再看技能 / 子代理 / sandore 工作流（按需取用，不要硬套）；
2. 最近 issue → task 的转换历史长什么样（前人的 reference.router 是重要参考）；
3. C:\Users\r30038105\.dsh\storages\castboard\tasks 下真实 task 的粒度：标题多长、detail 写多少、checklist 几条；
其中 issueId 有值的那些就是**从 issue 转来的历史样本**：重点看它们的 detail 与 reference.router
**各写了什么、怎么分工**，照那个分工来（detail 讲需求、reference.router 讲做法）。
</preparation>
<steps>
<step n="1">确定 cwd —— 这条活应该在**哪个项目目录**里执行。依据：issue 自带的 cwd、detail 里点到的路径、
<workspaces_custom> 里用户的指定（有就直接采用，不必再推断）、
<workspaces_catalog> 里的项目清单。**先读 `index.md`**：一览表与每个项目那段都带
`workspaceId` 与 `cwd`（项目绝对路径），再加上「一句话职责 / 能做什么 / 关键词 / 适合接的活 / 不适合」
—— 写得足够可判别，通常只看索引就能定归属。
**没有 `<cwd>` 是正常的**：派活方可以完全不指定目录（共享库里 cwd 本来就允许为空），
这时就按 detail 与 `<workspaces_catalog>` 自己判断该落在哪个项目，不必回头要 cwd。
**定了哪个项目，就把该项目的 `cwd` 原样（逐字）传给 castboard_issue_task**：别改写、别拼相对路径、别加引号。
只有「索引里有两个项目都像」时，才去读它们的肖像 `<workspaceId>.md`（能做什么、边界在哪、模块入口）。
判断不出来就用 references 里的 <fallback_cwd>（插件已按 issueId 建好 .cache/<issueId>；没有该字段才用 C:\Users\r30038105\.dsh\storages\castboard\.cache/<issueId>），并在 reference.router 里写明「cwd 未能确定，先用临时目录」。
**cwd 必须在本机真实存在**：工具内部会拿它解析（必要时注册）成一个 dsh 项目，
并把 cwd 与 workspaceId 一起绑定到新卡上 —— 传一个不存在的路径，工具会直接报错。</step>
<step n="2">确定 title / detail —— **detail 只写「要做什么」**：
title 与 issue 一致；detail 与 issue 一致（背景 / 目标 / 验收标准 / 约束与边界），可**适度补需求侧的信息**；
**不写实现方案**：不写改哪个文件、分几步、用什么库、怎么验证 —— 那些全是 reference.router 的活；
也不要把 issue 里已有的段落再抄一遍（执行者读两遍同样的东西，纯浪费）。
urgency 三选一 urgent（紧急）/ normal（一般）/ relaxed（不急）；
permission 三选一 read-only / workspace-write / danger-full-access；两者 issue 已有就沿用。</step>
<step n="3">确定周边资源：这条活需要哪些技能 / 子代理 / 工作流，给一个**简单**的参考方案就够。</step>
<step n="4">执行步骤：简单就写进 reference.router；确实复杂才给 reference.dag（DAG 码，可选）。</step>
<step n="5">reference.router —— **只写「怎么做」**，与 detail **严格互补、不重叠**：
落点（哪个包 / 文件 / 入口 / 命令）、推荐步骤顺序、技术取舍与理由、已知的坑、怎么自验。
**detail 里已经写过的目标与验收标准，这里一个字都不要再抄**；只写「执行者不看就会踩坑」的东西。
几行到十几行就够 —— 它不是设计文档。</step>
<step n="6">checklist —— 只有确实需要验收清单时才给（可选，非必要不添加）。</step>
</steps>
<delegation limit="1">调研与字段组装**最多派 1 个子代理** —— 一条 issue 只允许一个，**绝不许并行开第二个**。
派之前把要查的东西一次性写全（cwd 依据 / 历史粒度 / 周边资源），让它一轮就把话说完；
它回来之后你自己复核并提交。**已经派过一个就不要再派**：缺什么自己去读，不要用第二个子代理补。
本来就不复杂（多数情况）→ 干脆不派，自己做完。</delegation>
<handoff>调用 castboard_issue_task 提交：issueId / title / detail / cwd / urgency / permission / reference / checklist。
提交前自查一遍：**detail 讲「要做什么」、reference.router 讲「怎么做」，两者不重叠** ——
同一段话出现在两边就删掉一边（需求留在 detail，做法留在 reference.router）。
这个工具会建 task（status=todo、execution=queue）+ 回写 issue（workspaceId / cwd / meta / assigneeTask）+ 同步线上。
一次只转一条；转完就停，等下一次唤醒。</handoff>
<never>不要自己改 issue 的状态；不要一次建多张 task；**一条 issue 最多一个子代理，不许并行开多个**；**不要把 detail 与 reference.router 写成同一份内容**；issue 信息不足时不要硬猜 cwd；**不要真的去做这条 issue 要求的工作**。</never>
</castboard_issue_routing>
```

**注意**：四个占位符替换的是**机器相关的绝对路径**（跟 `$DSH_HOME` 走），绝不能把路径写死进常量
（别的机器可能没有 D 盘，也可能跑在 Linux / macOS 上）。提示词里已写明「文件不存在或为空就忽略」，
所以替换时**不探测存在性**。

---

### 4.6 `castboard-issue-references` —— router 每轮看的 issue 数据

| 项 | 值 |
|---|---|
| 常量 | `ISSUE_REFERENCES_SECTION`（`task/context.ts:497`） |
| 通道 | ②（**每轮**注入，不是只有首轮） |
| 组装函数 | `castboardIssueReferences(issue, extras)`（`task/context.ts:703`） |
| 组装时机 | `IssueRouterService` 每拍（3s 一拍、单飞）→ `session.run(routerInstruction(id), references)` |

**逐字模板**：

```xml
<castboard_issue_references>
<issue_id>${issue.id}</issue_id>
<title>${issue.title}</title>
<detail>${issue.detail}</detail>
<urgency>${issue.urgency}</urgency>
<permission>${issue.permission}</permission>
<cwd>${issue.cwd}</cwd>
<workspace_id>${issue.workspaceId}</workspace_id>
<source>${issue.source}</source>
<remote>true|false</remote>
<assigner>${issue.assigner}</assigner>
<assigner_task>${issue.assignerTask}</assigner_task>
<route_attempts>${issue.routeAttempts}</route_attempts>
<route_error>${issue.routeError}</route_error>
<assigner_meta>
${assignerMeta 里除 title / detail 之外的其余字段（JSON 字符串）}
</assigner_meta>
⟨有输入件时⟩
<input_attachments count="${n}" dir="${落盘目录}">
  <input_attachment index="1" name="${name}" path="${绝对路径}">${description}</input_attachment>
</input_attachments>
⟨有评论时⟩
<comments count="${n}">
  <comment by="${作者}" at="${时间}">${正文}</comment>
</comments>
⟨拿到 catalog 路径时⟩
<workspaces_catalog>
当前实例的所有工作区信息如下：
workspace 清单索引文件：${indexFile}
  一览表（workspaceId / 标题 / cwd 绝对路径 / 一句话职责）+ 每个项目一段
  （workspaceId / cwd 绝对路径 / 能做什么 / 关键词 / 适合接的活 / 不适合）。
  **先读它**：索引写得足够可判别，通常只看这份索引就能定下这条 issue 的 cwd。
workspace 肖像目录：${portraitDir}（每个项目一份画像 `<workspaceId>.md`：能做什么、边界在哪、模块入口）
  只在「索引里有两个项目都像」时才需要翻肖像。
  **采用哪个项目，就把它的 cwd 原样（逐字）填进 castboard_issue_task** —— 不要改写、不要拼相对路径。
</workspaces_catalog>
</castboard_issue_references>
```
**三块现场材料的缺席语义**（刻意设计）：

| 标签 | 内容 | 缺席时 |
|---|---|---|
| `<input_attachments>` | 已下到 worklab 的输入件（目录 + 逐个文件，**只给路径不贴正文**） | **整块不输出** |
| `<comments>` | 共享库上这条 issue 的评论（下发方的补充说明常在这里） | **整块不输出** |
| `<workspaces_catalog>` | 项目清单索引文件 + 肖像目录（给 router 判断 cwd） | 拿不到路径时不输出 |

空标签会让模型以为「有附件 / 有评论但内容是空的」，不输出就没有语义 —— router 该做的是
「按 issue 本身的信息去转换」。

`<assigner_meta>` 刻意剔掉 `title` / `detail`：它们必然也在 meta 里（共享库那两列就是从 meta
投影的），原样再打一遍等于把长正文塞两趟（实测 detail 可达数千字）。

**每轮的 user 指令**（`routerInstruction(issueId)`，逐字）：

```text
请使用子代理，按照 castboard-issue-routing 的指导，把当前 issue（issueId: 6f2b9d41-3c8a-4e77-bb10-5c9d2e1a7f88）转换成 task。注意：**只做转换，不要执行这条 issue 的工作**（不要改代码/跑命令/写文件，也不要产出方案文档）——读懂它、适度补齐执行所需的信息后调用 castboard_issue_task 即可；task 会由单独的执行者去执行。
```

指令只带 issueId（**可核对**：上下文是动态注入的，两者必须能对上），数据全部走 references。

**建立期的占位指令**（`ROUTER_IDLE_PROMPT`，逐字）：

```text
（初始化）你已就位。现在没有待处理的 issue，什么都不用做，等下一次唤醒。
```

---

### 4.7 `castboard-issue-creation-guidance` —— 分发 issue 的指导

| 项 | 值 |
|---|---|
| 常量 | `DISPATCH_GUIDANCE_SECTION`（`issue/dispatch-guidance.ts:23`） |
| 通道 | ③（`agent.inject(buildPluginMessage(...))`） |
| 组装函数 | `castboardIssueCreationGuidance({ instance })`（`issue/dispatch-guidance.ts:51`）—— **动态**（要写本机实例） |
| 组装时机 | 模型调 `castboard_issues_help` 时（`issue/dispatch-tools.ts:590`）；注入失败或无 agent 会话 → 正文随工具返回值下发 |

**为什么按需而不是常驻**：这段只对「正在执行、并且发现这活要分发出去」的那个会话有用，
所有会话常驻一份等于给每个会话白付几千 token。

**结构总览**（9 段，逐字样例见下）：

| 段 | 作用 |
|---|---|
| `<role>` | 你现在为什么要分发 issue |
| `<fields>` | **模型只给这些字段**（其余由工具填） |
| `<tools>` | 六个工具各自干什么、什么顺序用 |
| `<order>` | 1→5 的顺序纪律与四条硬禁止 |
| `<given>` | 唯一的免问口子：上游 `<target>` 已字面给定的字段 |
| `<prepare>` | 不占步骤号的前置整理（分几条 / 依赖 / 草稿） |
| `<steps>` | 1..5 步（项目组 → 项目成员 → 成员实例 → 该实例 Index → cwd） |
| `<submit>` | 一次整批提交 + 提交前自查 + 附件 / taskId |
| `<rules>` | 硬约束（一个 issue 一个人、能本地做完就别分发、不许臆造…） |
| `<comments>` | 建完之后仍可对话（**方向 = assigner**） |

**逐字样例**（`${facts.instance}` 换成示例值 `10.117.145.73:3080`）：

```xml
<castboard_issue_creation_guidance>
<role>你正在执行一个任务，做完（或做到一半）发现**还有别的活要交给别人**：可能是本实例的
另一个会话，也可能是别人的 dsh 实例。把这些活**拆成 issue 分发出去**，用 castboard_issues_create 上库。
issue 是「派给某人/某实例去处理」的工单，不是本任务的一部分 —— 你别自己去做它。</role>
<fields>**每条 issue 只需要 3 个必填字段**（字段名就是工具 schema 里的驼峰名），其余全部可选、
由工具自动补默认值：
<assignerMeta>**必填**。诉求内容，**必须是对象且含非空的 title 与 detail**（一句话标题 + 完整诉求）；
可以再加别的自定义键（如 acceptance / reference），但 title / detail 是硬要求。</assignerMeta>
<assignee>**必填**。责任人账号（**一个 issue 一个人**），来自 castboard_issue_group_members 的结果。</assignee>
<assigneeInstance>**必填**。对端实例 ip:port，来自 castboard_issue_workspaces（type="index"）的结果。
等于本机（10.117.145.73:3080）时说明这条活就在本机做，工具会把 source 记成 self；
不等于本机则记成 dsh（跨实例分发）。</assigneeInstance>
<cwd>**可选** —— 这条活应该在**对端机器**上的哪个项目目录里做（绝对路径，≤500 字符）。
**用户不想指定、或索引里看不出该用哪个目录时，就整项不传**（共享库创建 issue 时 `cwd` 本来就可空，
「不需要 cwd」是完全合法的一步，不要为了凑字段编一个目录）。
要传就必须来自 castboard_issue_workspaces 的真实结果（type="index" 的索引或 type="portal" 的肖像），不要凭印象拼。</cwd>
<urgency>可选：runtime | direct | urgent | normal | relaxed（不传 = normal）。</urgency>
<permission>可选：read-only | workspace-write（默认） | danger-full-access。</permission>
<attachments>可选：交给对方的**输入件**（产物 / 日志 / 规格 / 样例数据）的绝对路径数组，
来自 ask_user_question 的多选（提交前那一节）；没有材料就不传。</attachments>
<dependsOn>可选：本条 issue 依赖的**其他 issue** 的数组（字符串 list）。每一项只能是两种之一：
① **本批某条 issue 的 `ref`**（短别名，如 `["evt-b"]`）—— 同批创建时用这种，因为 issueId 是工具现铸的，
你事先拿不到；② **库里已有 issue 的真实 issueId**（标准 UUID，通常是别人给你的）。
语义：`dependsOn` 里的 issue **必须全部 success**，本条 issue 才能进入规划（router 会话）；
只要有一个没成功，本条就停在待规划列不动，直到依赖跑完（不会标失败、不会退回）。
**一次创建多个 issue 时，先判断它们之间有没有先后依赖**：有依赖的，给**被依赖方**起一个 `ref`，
把那个 `ref` 填进**依赖方**的 `dependsOn`；工具铸完 id 会自动把 ref 翻译成真 issueId。
**你永远不要自己写 issueId、也不要自己编 UUID**（`issueId` 不是你能传的字段，传了整批会被参数校验拒掉）。
彼此独立就**不要填**（空数组等于没依赖）。依赖方一定会在被依赖方之后才被规划；
**不许让一条 issue 依赖它自己，也不许让同批两条互相依赖**（成环 = 两边都永远进不了规划，工具会直接拒）。</dependsOn>
</fields>
<tools>
<tool name="castboard_issues_help">本文件（指导）。**调用 castboard_issues_create 之前必须先调它**。</tool>
<tool name="castboard_issue_groups">用户所在的群组/项目列表（无参数）。第 1 步用它确定目标项目组。</tool>
<tool name="castboard_issue_group_members">某个项目下的成员（参数 projectId），**已按派活权限过滤**：
你是这个项目的 owner / creator / manager → 返回全部成员；否则**只返回你自己**（`restricted: true`），
说明你只能把活派给你自己的多实例。第 2 步用它确定责任人。</tool>
<tool name="castboard_issue_devices">某个账号名下的**在线设备（= 可派活的实例）**（参数 userId）：
每台一行 `host` + `port`，实例 id 就是 `host:port`。**实例清单只认它**（设备台账），
第 3 步用它拿候选实例 —— 不要拿工作区索引凑（那只覆盖上报过索引的机器）。</tool>
<tool name="castboard_issue_workspaces">工作区（**同一个接口的两种视图，用 `type` 选**）：
**`type="index"`** = 项目索引（`index.md`），第 4 步用它：传 `userId` + `instance`（第 3 步选定的那台）
→ 拿到**那一台机器**的索引，用来挑 cwd。**没有 instance 就不许拿它挑 cwd**（那是这个人所有机器混在一起的索引）。
**`type="portal"`** = 某个工作区的肖像详情（参数 `instance` + `workspaceId`），索引里看不出该用哪个目录时才用它。</tool>
<tool name="castboard_issue_state">查一条 issue 的现状（参数 issueId）：记录 + 评论 + 已交出来的产物
（产物会下到本地临时目录并给路径）。想知道「对方做到哪了 / 交了什么」时用它。</tool>
<tool name="castboard_issues_create">真正建 issue：参数是 issues 数组（每项 = 3 个必填字段 + 可选 cwd / urgency /
permission / attachments / ref / dependsOn），外加可选的 taskId。建完会把 issue id 记到那张任务的
derivedIssues 里；回执里每条都带 issueId / source / urgency / permission / dependsOn（有依赖时会看到翻译后的
真实 issueId，可以拿它自查 ref 有没有解析对）。</tool>
</tools>
<order>**严格按下面 1→5 的顺序走，一步都不许跳、不许乱序、不许合并**。
每一步都标了 `requires`（必须先拿到什么）与 `produces`（这一步定出什么）：
**没拿到 `requires` 里的东西，就不许开始这一步；没产出 `produces`，就不许进下一步。**
四条硬禁止：
① **不许把不同步骤的 ask_user_question 合并成一个问题**（项目组 / 责任人 / 实例 / cwd 是四次不同的询问）；
② **不许跳过 ask_user_question 自己替用户决定** —— 免问只有两种：该步写明「单个候选可以直接用」，
或上游已经用 `<target>` 字面给了这个字段（见下面 `<given>`）；
③ **不许用「猜一个合理的值」代替工具结果或用户选择**（项目组 / 账号 / ip:port / cwd / 附件路径都一样）；
④ **不许先调 castboard_issues_create 再补信息**（建之前必须 5 步全走完）。
中途缺任何一项信息 → 停下来问用户，不要用默认值蒙过去。</order>
<given>**唯一的一种免问：上游已显式给定（只认字面来源，不认推测）**。
本轮如果**自带** `<castboard_task_dispatch>` 的 `<target project="…" assignee="…" [instance="…"]/>`，
那么 target 里**出现的**字段直接采用上游值，第 1 / 2 / 3 步的「必须问」对这些字段不再适用。
但**核对照做**：仍要用 `castboard_issue_groups` / `castboard_issue_group_members` / `castboard_issue_workspaces`
（`type="index"`）验证它真实存在，查不到就停下来报错，不许改成猜。
**这个豁免只认那种字面标签** —— 你自己用工具查到的、issue 记录里自带的、或「看起来只有一个候选」都**不算**
「已给定」（第 2 步的 `restricted: true` 只说明你只能派给自己，不构成免问）；target 里**没出现**的字段
（cwd / 附件）也不享受这个豁免 —— 该问照问，问不到就整项不传。
</given>
<prepare>**动工具之前先想清楚**（不占步骤号，只整理、不调创建工具）：
先确定**到底要分发几条 issue**：一条 issue = 一个独立交付物，一个人拿到它就能做完、能验收。
如果一件事需要两个人并行做，就拆成两条 issue，并在 title / detail 里各自写清范围（谁改哪一块）。
**然后想清楚它们之间有没有先后依赖**：B 必须等 A 做完才能开始时，就是有依赖 ——
给 A 起一个短别名（`ref`，如 "evt-a"），把 A 的 ref 填进 B 的 `dependsOn`（如 ["evt-a"]）。
彼此独立的就都别填 dependsOn。有依赖时被依赖方的 issueId 会由工具现铸，所以你**只能用 ref 引用**，
不要自己编 issueId。
最后按 `<fields>` 的字段清单（3 个必填 + 若干可选），为每条 issue 排好内容
（title + detail 一定要写清楚：做什么、验收标准是什么）。
</prepare>
<steps>
<step n="1" title="确定目标项目组" requires="无（入口）" produces="projectId">
**先调工具**：`castboard_issue_groups`（无参数）拿用户所在的群组/项目列表。
拿到列表之后再决定要不要问：**只有 1 个项目就直接用它，不必问**（这一步唯一的免问情形；
上游 `<target>` 已经给了 project 时见 `<given>`）；
**有多个就必须用 `ask_user_question` 让用户选**，不要自己替用户挑。
问题怎么问：一个问题选一个项目，选项写「项目名（id=…）」，让用户看到就明白选哪个。
选定后把 projectId 记下来 —— 第 2 步的成员查询**只能**用它。
</step>
<step n="2" title="确定每条 issue 的责任人（项目成员）" requires="第 1 步的 projectId" produces="每条 issue 的 assignee（账号）">
**先调工具**：`castboard_issue_group_members`（参数 projectId = 上一步选的项目）拿**可分发**成员列表。
拿到成员之后**必须用 `ask_user_question`**：**有 N 条 issue 就提 N 个问题**，一个问题只问一条 issue 的责任人。
**选项必须写「姓名 + 账号」**（成员的 `displayName` + `userId`，例如「冉汆 r30038105」）；
`displayName` 为空就只写账号。不要只写账号 —— 用户按名字认人。
每个问题里带上这条 issue 的 title，用户才知道在给哪一条选人。可以都选同一个人，但**必须用户自己选**。
**注意权限**：结果**已按派活权限过滤** —— 若返回 `restricted: true`（只有你自己），说明你不是这个项目的
owner / creator / manager，**只能派给你自己的多实例**，不要试图填别人的账号。
</step>
<step n="3" title="查询该成员有哪些实例" requires="第 2 步每条 issue 的 assignee 账号" produces="每条 issue 的 assigneeInstance（ip:port）">
**先调工具**：`castboard_issue_devices`（参数 userId = 该条 issue 的责任人账号）拿这个人的**在线设备（= 实例）**：
每台一行 `host` + `port`，实例 id 就是 `host:port`（`port` 为 0 时只有 host）。
**实例清单只来自设备台账**（`/api/internal/devices`），不要用工作区索引去凑 —— 那是下一步的事，
而且只覆盖「恰好上报过索引」的机器，刚装好的机器会漏。
拿到实例之后**必须用 `ask_user_question`**：**每条 issue 各问一次**「这条活落到哪台实例」。
**选项必须写「账号 + ip:port」**（例如「r30038105 10.117.145.73:3080」）。
**多条 issue 的实例可以不同**（同一个人的两台机器、或不同的人），所以**逐条问、不要合并成一个问题**。
某条 issue 的责任人只有一台实例时，也要把这一台**明确告知用户**（可以在下一个问题里带上，不要静默决定）。
**这一步只定实例，不要定 cwd** —— 目录信息在下一步按「这台实例」去查。
</step>
<step n="4" title="查询这台实例的 Index（必要时深入 detail）" requires="第 3 步每条 issue 的 assigneeInstance" produces="这台机器上的候选 cwd 列表">
**先调工具，且必须带齐两个参数**：`castboard_issue_workspaces`（`type="index"`，`userId` = 这条 issue 的责任人账号，
`instance` = 第 3 步给它选定的那台 `ip:port`）—— 这样拿到的才是**那一台机器**的项目索引指导。
**顺序不许倒**：没有 `instance` 就去查 index 是错的（拿回来的是这个人所有机器的索引，用户没法按机器选目录）。
读 `detail`（`index.md`：每个项目一段，带 `workspaceId` / `cwd` / 职责 / 关键词 / 适合接的活），列出这台机器上可用的目录。
**只有索引看不出该用哪个目录时**，才用同一个工具的另一个视图深入：`castboard_issue_workspaces`
（`type="portal"`，参数 `instance` + `workspaceId`）读那个工作区的肖像 —— 不要一上来就逐个翻肖像。
**这一步只读**：产出候选目录，cwd 还没定（下一步由用户选）。
</step>
<step n="5" title="确定每条 issue 的 cwd（可选）" requires="第 4 步这台实例的候选 cwd 列表" produces="每条 issue 的 cwd，或明确不传">
**必须用 `ask_user_question`**：每条 issue 各问一次「这条活在这台实例的哪个项目目录里做」，
**选项 = 第 4 步索引里列出的 cwd（写「项目名 + cwd 路径」）**，并且**必须额外加一个选项「不需要 cwd」**。
**「不需要 cwd」是合法结果，不是失败**：用户选它（或索引里根本没有可用项目）→ 这条 issue **整项不传 `cwd`**，
交给对方自己判断目录。共享库创建 issue 时 `cwd` 本来就可空 —— **不许**为了「字段必填」编一个目录，
也**不许**把这个问题标成「必填 / 必须选一个路径」再问一遍。
**要传 cwd 就必须逐字来自工具结果**：绝对路径、≤500 字符、对端真实存在。不要自己拼、不要猜、不要写相对路径。
**assigneeInstance 用第 3 步选定的那台**：与本机（10.117.145.73:3080）相同 → 工具记 source=self；不同 → source=dsh。
</step>
</steps>
<submit>**信息齐了以后，一次调用 `castboard_issues_create`**，把整批 issue 作为 `issues` 数组传进去（不要一条一条调）：
**提交前逐条自查**：必填 3 项 —— assignerMeta(title+detail) / assignee（第 2 步）/ assigneeInstance（第 3 步）；
可选项 —— cwd（第 5 步，**没有就整项不传**）/ urgency / permission / attachments（有输入件才传）。
**urgency / permission 按每条 issue 的实际情况定**：拿不准就用 `normal` + `workspace-write`；
只有确实紧急才用 urgent / direct，只有确实只需读才用 read-only。这两项**不需要问用户**，你直接判断。
**只有必填那 3 项缺了才需要回去补**；可选项「用户没选」是正常终态，不要因此卡住或编值。
**再确认一遍依赖**：有先后关系的，被依赖方带上 `ref`，依赖方的 `dependsOn` 里写那些 ref（或库里已有 issue 的真实 issueId）；
没有依赖就一条都别填。填错的 ref（既不是本批 ref 也不是 UUID）会让整批被拒 —— 这是故意的，
因为一个解析不了的依赖落库后永远查不到，等于静默失效。
**但 UUID 打错一位不会被拦**：形态合法就照发，规划侧查不到就当「没有依赖」静默放过 —— 所以 issueId
只能从工具结果（如 castboard_issue_state / 上一次建 issue 的回执）里**逐字复制**，绝不要手打或凭记忆写。
**有输入件就给 `attachments`**：对方接手需要的产物 / 日志 / 规格 / 样例数据的绝对路径数组（input 类型，跟着 issue 一起交过去）。
没有材料就不传（空数组等于没附件）。**别把本机的私密文件、凭据、临时垃圾往里塞。**
`taskId` 一般**不用传**：在任务会话里执行时，工具会自己从调用方会话认出你正在执行的那张卡，并把它写成 issue 的
`assignerTask`（上游血缘），同时把新 issue 的 id 追加到那张卡的 `derivedIssues` 里；只有在独立会话（没有 task）里
才需要你在参数里给出 taskId（拿不准就不要传，宁可没有血缘也不要编一个）。
提交后把结果如实汇报给用户：每条 issue 的 issueId / 责任人 / 实例 / cwd / 紧急度 / 附件数，以及失败原因（如有）。
</submit>
<rules>
**一条 issue 只有一个 assignee**：想两个人做，就拆成两条，各自写清范围，别让两人改同一处。
**能在本实例做完就不要分发**：分发是给「本机做不了 / 该别人做 / 该别的实例做」的活，不是把活推出去。
**不许臆造**：项目名、成员账号、实例 ip:port、cwd、附件路径，都必须来自工具结果或用户的选择；
工具里查不到就问用户，宁可多问一轮，也不要编一个看起来合理的值。
**没有管理权就只能派给自己**：成员列表被过滤成你自己（`restricted: true`）时，
`assignee` 只能填你自己，跨实例也只能落到你自己的实例上 —— 成员列表就是按这个权限过滤出来的，
别绕过去填别人的账号（工具侧不会替你拦，拦不拦得住取决于对端，别赌）。
**不要传多余字段**：issueId / assigner / status / source / sourceInstance / assignerTask 由工具填；
你只管 3 个必填（assignerMeta / assignee / assigneeInstance）+ 可选（cwd / urgency / permission /
attachments / ref / dependsOn / taskId）。多传的**不会**被静默忽略 —— schema 是
`additionalProperties: false`，多一个字段整批都会被参数校验拒掉。
**cwd 是可选项，不是必填项**：用户选「不需要 cwd」就直接不传，别把可选项当成硬门槛去反复追问。
**依赖写清先后，别写成一锅**：只有「B 真的必须等 A 完成」时才填 dependsOn —— 依赖没满足时本条会一直
停在待规划列（不会标失败、不会退回），白等一轮。彼此能并行的就不要互相依赖，让它们同时开跑。
**不要重复建**：同一条活只建一次。提交失败时先看返回的原因（字段不合格 / 连接问题 / 字典缺 source），
改对了再重试 —— 每次调用都会新铸 issue id，无脑重发会产生重复 issue。
**如果回执里带了 `created`**（`ok:false` 但 `created` 非空 = 部分成功：issue 已经建好，只是后续某一步失败），
那些 id **不要再建一遍**，只补做失败的那一步。
**写明验收标准**：每条 issue 的 detail 至少包含「要做什么」和「怎么算做完」，否则对方没法判断什么时候能交。
</rules>

<comments>
建完 issue 之后，你仍然可以随时和执行方对话：

- **主动询问执行方**：`castboard_issue_comment_add { issueId, commentRole: "assigner", body: "…" }`
这条评论会立刻上云，并被投递到这条 issue 的执行会话里（执行方会看到你的问题）。
- **回答执行方的提问**：执行方缺上下文时，会用 `commentRole: "assignee"` 发评论问你。
那些评论会以 `castboard-issue-comments` 具名上下文的形式出现在你的会话里（不必轮询）。
用 `castboard_issue_comment_add { issueId, commentRole: "assigner", body: "…" }` 回答即可。

⚠️ commentRole 必须是 assigner（你是下发方）。工具会按你的会话身份软校验，传错会被纠正并在回执里说明。

⚠️ **你要说的话（验收结论 / 追问 / 补充要求）一律走 `castboard_issue_comment_add`，不要用 `castboard_comment_add`。**
那个工具是**执行方给自己那张卡**写进展用的，两个理由：
① 它的 `role` 固定是 `assignee`（「执行方的进展」），而卡片评论的锚点就是这条 issue；
② 于是你写下的那句话会被判成「执行方说的」，交叉路由到**你自己**的会话 —— 表现为「我在卡片上写的验收结论，
以 issue 评论的形式回声给自己，执行方一个字都没收到」；要改卡片状态请用 `castboard_move`，要说话请用 issue 评论。
（2026-11-13 真机踩过一次，代价是一整轮验收结论没送出去。）
</comments>
</castboard_issue_creation_guidance>
```

**`castboard_issues_help` 的返回值**（注入之外还给一份紧凑字段表，与正文同口径）：

```json
{
  "ok": true,
  "injected": true,
  "local": { "userId": "r30038105", "instance": "10.117.145.73:3080" },
  "requiredFields": ["assignerMeta", "assignee", "assigneeInstance"],
  "optionalFields": ["cwd", "urgency", "permission", "attachments", "ref", "dependsOn"],
  "note": "指导已注入上下文 \"castboard-issue-creation-guidance\"（下一步生效）。按它的 5 步做…"
}
```

`injected: false` 时（调用方不是 agent 会话 / 注入抛错）额外带 `guidance` 字段，正文随返回值下发 ——
**不会**在返回值里骗模型说「已注入」而让它下一步什么也读不到。

---

### 4.8 `castboard-project-portrait` —— 肖像会话的静态规则

| 项 | 值 |
|---|---|
| 常量 | `PORTRAIT_SECTION`（`issue/portrait-prompt.ts:35`）、`CASTBOARD_PORTRAIT_XML`（`:48`） |
| 通道 | ①（agent 作用域 systemPrompt section，order **160**）+ ②（会话建立时投一份） |
| 组装时机 | `openPortraitSession()` 建立会话时（`src/index.ts:468-474`）；**每个项目不重投** |
| 行数上限 | `PORTRAIT_MAX_LINES = 1000`（模板里的 `{{MAX_LINES}}` 在建模块时替换掉） |

**逐字样例**：

```xml
<castboard_project_portrait>
<role>你是「项目肖像」写手：每轮只处理**一个项目**，产出两个文件 —— 该项目的肖像
`<workspaceId>.md`，以及增量更新目录索引 `index.md`。</role>
<purpose>
这份肖像是**给 router 用的指导文件**：router 手里有一条 issue，要靠它判断「这条活
该交给哪个工作区」。所以写的是**这个项目能做什么、边界在哪**，不是代码导读。
给一个没进过这个项目的人看，让他一眼能判断「这条活属于它吗」。
</purpose>
<index_goal>
index_file 是 router 的**第一判断依据**，目标是：**只看 index.md 就能定下约 80% 的 cwd**。
每个项目**必须**有两个关键字段，缺一条这个条目就是废的：
- `workspaceId`：项目的 dsh id，是 **UUID**（36 字符，`8-4-4-4-12`），不是 `ws-xxx` 这类自造名字；
- `cwd`：项目的**绝对路径**。router 会把 cwd **逐字**填进 task —— 写错一个字符，活就派到错的仓库，
或直接因为「路径不存在」被工具拒掉。
**这两个值只能「抄」**：来源是本轮输入（`workspace_id` / `project_path`）与上下文注入的
`<castboard_portrait_target>` —— 两处是同一份真值，**必须一致**。
禁止自造 id、禁止按项目名拼 id、禁止把路径换成相对路径或加引号/反引号/补斜杠、禁止任何「美化」。
拿不准就不写这一条（留「（待补）」），也不要编。
剩下的判据要写得**可判别**，而不是一句口号：
- 一览表的「一句话职责」：一句话说清「做什么 + 给谁用」，能据此排除掉一半项目；
- 本项目那一段：`能做什么` / `关键词` / `适合接的活` / `不适合（容易误派的近似领域）` 四条必须填满；
- `关键词` 写真实会出现在 issue 描述里的词（产品名、模块名、领域词），不是泛泛的「后端」「工具」。
判据要**互相区分**：相邻项目经常长得很像，正好在「不适合」里点明彼此的差别。
只有两个项目都符合时才需要再由 router 去读肖像 —— index.md 写得越可判别，这一步越少。
</index_goal>
<boundary>
**只读这一轮给的 project_path**：不要读别的项目、别的盘、别的仓库；不要顺着 import 跑到项目外面去。
**绝不修改那个项目**：不写文件、不改配置、不跑会落地更改的命令（构建 / 安装 / 迁移 / 提交都不行）。
唯一允许写入的是 output_file 与 index_file 这两个文件，其它一律不碰。
无人值守、不能向用户提问：判断不了的就不写，不要猜，不要留 TODO 占位。
</boundary>
<method>用子代理去读那个项目的代码与文档：README / docs / 清单文件（package.json、pyproject.toml、Cargo.toml 等）
/ 顶层目录 / 关键入口。子代理读，你负责归纳成摘要，写完自己复核一遍再落笔。</method>
<incremental>
**先看 output_file 是否已存在**（通常 `workspaces/<workspaceId>.md`）：
1. 存在 → **增量更新**：先把它读进来，在原有内容上增删改 —— 补上新增的功能，删掉已经不存在的，
顺手修正不准确的地方。**不要从头重写**（那既慢，又会丢掉之前已经核对过的结论）。
2. 不存在 → **新建**一份，按下面的结构写全。
index_file 同理：先读它，只改**属于你的那两处** ——
① `## 一览` 表格里本 workspace 那一行（没有就按列数加一行）；
② 下面 `## <workspaceId>（标题）` 那一段（没有就按同样的条目格式新建一段）。
别人的行与段落一个字符都不要动，不要重排表格、不要重写整份文件。
准确优先：改写是为了更准，不是为了更长。发现旧结论错了就直接改对。
</incremental>
<content>
<overview>一句话说清这个项目是干什么的</overview>
<capabilities>**这个项目提供哪些功能/能力**（要点列表，每条一行、动词开头）—— 这是 router 最需要的一节</capabilities>
<modules>主要模块与入口（5–15 条：目录/包 → 它负责什么）</modules>
<stack>语言 / 框架 / 主要依赖 / 构建与包管理方式</stack>
<workflow>怎么跑、怎么测、怎么构建（以仓库里真实存在的脚本为准，不要臆造命令）</workflow>
<boundaries>这个项目**不做什么**、以及容易被误派的近似领域（帮 router 排除）</boundaries>
<keywords>检索关键词：项目名、产品名、领域词（一行，逗号分隔）</keywords>
</content>
<format>
Markdown，**不超过 1000 行**（两个文件各自都不超过）。
不贴大段源码（最多引用几行）、不逐文件罗列、不写变更历史、不写「我读了…」这类过程叙述。
index.md 是**表格**：保持它现有的表头与列序，只补本行。
</format>
</castboard_project_portrait>
```

**边界为什么写得这么重**：这个会话是**无人值守**的（`noInteraction`），沙箱 `workspace-write` ——
写权限只落在会话自己的 cwd（`worklabs/workspaces`），但**读**是放开的，它有能力把整台机器的代码读一遍。
所以「只看这一轮给的 project_path」必须写成硬约束。

---

### 4.9 `castboard-project-portrait-target` —— 肖像每轮的结构化真值

| 项 | 值 |
|---|---|
| 常量 | `PORTRAIT_TARGET_SECTION`（`issue/portrait-prompt.ts:137`） |
| 通道 | ②（**每轮**注入） |
| 组装函数 | `portraitTargetXml(target)`（`issue/portrait-prompt.ts:150`） |
| 组装时机 | `PortraitService` 每拍 → `session.run(portraitInstruction(target), [{ name: PORTRAIT_TARGET_SECTION, text: portraitTargetXml(target) }])`（`issue/portrait-service.ts:284-285`） |

**逐字样例**：

```xml
<castboard_portrait_target>
<note>下面这些值由宿主从 dsh 项目注册表里取出，是**唯一权威来源**：写进 index.md 时逐字照抄。</note>
<workspace_id>a3f1c9d2-8e4b-4c17-9a55-2d6f7e8b1c03</workspace_id>
<cwd>D:\projects-code\optix\common\harness\furina</cwd>
<title>furina</title>
<output_file>C:\Users\r30038105\.dsh\storages\castboard\worklabs\workspaces\a3f1c9d2-8e4b-4c17-9a55-2d6f7e8b1c03.md</output_file>
<index_file>C:\Users\r30038105\.dsh\storages\castboard\worklabs\workspaces\index.md</index_file>
<mode>增量更新</mode>
</castboard_portrait_target>
```

`<mode>` 只有两种值：`增量更新`（`output_file` 已存在）/ `新建`。

**为什么要两份**（同一份真值渲染两次）：

- 用户消息（`portraitInstruction`）是**指令**，模型按它动手；
- 具名上下文（本 section）是**结构化数据**，字段边界清楚、不会被模型当成叙述改写 ——
  `workspaceId` / `cwd` 这两个要写进 `index.md` 的值，从这里取最不容易抄错。

两处由同一个 `PortraitTarget` 渲染，**必然一致**；提示词里也要求模型两处一致。

**每轮的 user 指令**（`portraitInstruction(target)`，逐字，注意它是「键: 值」行格式、**不转义**）：

```text
请给下面这个项目写一份项目肖像，然后同步更新目录索引。用子代理去读它的代码与文档。

目标：
- project_path: D:\projects-code\optix\common\harness\furina
- workspace_id: a3f1c9d2-8e4b-4c17-9a55-2d6f7e8b1c03
- title: furina
- output_file: C:\Users\r30038105\.dsh\storages\castboard\worklabs\workspaces\a3f1c9d2-8e4b-4c17-9a55-2d6f7e8b1c03.md
- index_file: C:\Users\r30038105\.dsh\storages\castboard\worklabs\workspaces\index.md

两件事，按顺序做：
1. 肖像：**增量更新**：C:\Users\r30038105\.dsh\storages\castboard\worklabs\workspaces\a3f1c9d2-8e4b-4c17-9a55-2d6f7e8b1c03.md 已存在 —— 先读它，在原有内容上增删改（补新增、删过时、修正不准确），不要从头重写。
   上限 1000 行；写「能做什么 / 模块入口 / 技术栈 / 怎么跑 / 不做什么 / 关键词」这类摘要，不写细枝末节。
2. 索引：读 C:\Users\r30038105\.dsh\storages\castboard\worklabs\workspaces\index.md，先把「本项目」的条目写出来，再落到索引里：
   - 一览表里本 workspace 那一行（没有就按列数加一行）；
   - 以及 `## <workspaceId>（标题）` 那一段（没有就按同样的条目格式新建一段）；
   每个项目**必须**有的两个关键字段，**只能从下面这两个真值里抄**（同一个值也注在
   具名上下文 `<castboard_portrait_target>` 里，两处必须一致），**一个字符都不要改**
   （不自造 id、不加引号/反引号、不换相对路径、不补斜杠）：
   - workspaceId：a3f1c9d2-8e4b-4c17-9a55-2d6f7e8b1c03
   - cwd（绝对路径）：D:\projects-code\optix\common\harness\furina
   router 会把 cwd 逐字填进 task，写错就等于把活派到错的仓库。
   剩下四条（`能做什么` / `关键词` / `适合接的活` / `不适合（容易误派的近似领域）`）都要填满 ——
   目标是**只看这份索引就能定下约 80% 的 issue 该给哪个项目**，所以「关键词」要写 issue 里真会出现的词，
   「不适合」要点明它与相邻项目（同类工具、同团队别的仓库）的区别。
   别人的行与段落一个字符都不要动；这个文件同样不超过 1000 行。

边界（务必遵守）：
1. 只读 project_path 下面的内容，不要读别的项目、别的盘，也不要顺着 import 走出去；
2. 不要修改那个项目（不写、不改配置、不跑构建/安装/迁移/提交）；
3. 只有 output_file 与 index_file 两个文件可写，其它一律不碰；
4. 不能向用户提问：判断不了的就不写。

做完回一句「已写入 C:\Users\r30038105\.dsh\storages\castboard\worklabs\workspaces\a3f1c9d2-8e4b-4c17-9a55-2d6f7e8b1c03.md」就停，不要做别的事。
```

`portraitExists: false` 时第 1 条的 `mode` 变成：
`**新建**：${outputFile} 还不存在 —— 按 castboard-project-portrait 的结构写一份。`

**建立期的占位指令**（`PORTRAIT_IDLE_PROMPT`，逐字）：

```text
（初始化）你已就位。现在还没有待写肖像的项目，什么都不用做，等下一次唤醒。
```

---

### 4.10 `castboard-issue-comments` —— 对端会话收到的评论

| 项 | 值 |
|---|---|
| 常量 | `ISSUE_COMMENTS_SECTION`（`link/deliver.ts:105`） |
| 通道 | ③（会话活着：`agent.followup` / `agent.steer`）/ ②（会话不在本进程：门面 `wake` 的 `extraContext`） |
| 组装函数 | `commentsXml(anchorId, comments)`（`link/deliver.ts:600`） |
| 组装时机 | 本机写了 issue 评论 / 轮询拉回云端新评论 / 补投欠账时，`CommentDeliverer` 交叉路由到对端会话 |

**逐字样例**：

```xml
<issue_comments count="2" issue="6f2b9d41-3c8a-4e77-bb10-5c9d2e1a7f88">
  <!-- 回复本 issue 用：castboard_issue_comment_add { issueId: "6f2b9d41-3c8a-4e77-bb10-5c9d2e1a7f88", commentRole: "assignee", body: "…" } -->
  <!-- 这个 issue id 才是 issue 评论的目标；任务 id（t-…）只能配 castboard_comment_add / castboard_move / castboard_execution_report。 -->
  <comment role="assigner" by="user" at="2026-11-16T02:21:10.001Z" author="r30038105">2.17 那台也要覆盖，别只测 2.28。</comment>
  <comment role="assigner" by="user" at="2026-11-16T02:24:55.220Z" author="r30038105">另外把 musl 环境也带上。</comment>
</issue_comments>
```

**两行注释是刻意的**：唤醒轮走的是**续跑**，而续跑不重投首轮的 `castboard-task-references` ——
执行会话在这一轮里拿不到 issue id，只有任务 id。真机因此把任务 id 当 `issueId` 传给
`castboard_issue_comment_add`，评论写进不存在的锚点、还回执成功。所以每次投递都把锚点带上。

**字段**：`role`（`assigner` / `assignee`，缺省按 `assigner`）、`by`（`user` / `agent` / `system`）、
`at`（ISO）、`author`（云端账号，有才输出）。正文**全部转义** —— 评论是外部输入（另一台机器上的 agent /
网页上的人写的），不转义就能伪造标签、冒充系统指令。

**投递侧的三道闸**（`link/deliver.ts`）：400ms 合并窗口（同一 issue 同一侧的一批合成一次注入）、
回声守卫（不投回写它的会话）、references 去重（`coveredUntil` 水位，水位以内已在 references 里）。

**会话不在本进程时的唤醒语**（逐字，只有这一句、不带内容）：

```text
// 执行方那一侧
上游 issue 有新评论，见下面的上下文；按它的要求处理（不要改任务状态）。
// 下发方那一侧（它没有卡，不该被叮嘱「不要改任务状态」）
你派出去的 issue 有新评论，见下面的上下文；按它的要求接着处理。
```

---

### 4.11 `<castboard_task_dispatch>` —— 人点「分发」时的一轮指令

| 项 | 值 |
|---|---|
| 常量 | 无（函数） |
| 通道 | **不是**具名上下文：直接作为这一轮的 **user 消息**发出去 |
| 组装函数 | `taskDispatchInstruction(task, target)`（`task/context.ts:474`） |
| 组装时机 | `ExecutionService.dispatch(taskId, text)`（`task/index.ts:605`）→ `start(..., 'issue-dispatch', text, true)` |
| 形态 | 辅助轮（`assist: true`）：**不动卡片状态**，卡留在待验收 |

**逐字样例**：

```xml
<castboard_task_dispatch>
<task id="t-9f3a1c-7b2">
  <title>给 dsh-webide 补 glibc bundle 检测</title>
</task>
<target project="42" assignee="r30038105" instance="10.117.145.73:3080"/>
<request>把「musl 环境兜底」和「回归用例」两件事拆出去，交给后端组做。</request>
<steps>
  <step order="1">先用 castboard_issues_help 看建 issue 的规矩（它会往本会话注入完整说明），再用 castboard_issue_groups / castboard_issue_group_members / castboard_issue_workspaces 核对目标。</step>
  <step order="2">按 <request> 里的要求把活拆成一条或多条 issue，用 castboard_issues_create 建；先后关系用 dependsOn 表达。目标字段（project / assignee / instance）**按 <target> 原样采用，不必再问用户**；<target> 里没有的字段（cwd / 附件）按上面那份指导的第 5、6 步处理 —— 能问就问，问不到（或用户不选）就整项不传，**不许编造**（共享库允许 cwd 为空）。</step>
  <step order="3">用 castboard_comment_add 汇总派了哪几条 issue（标题 + issueId）。</step>
</steps>
<never>不要改本任务的状态（它还留在待验收），也不要自己把它移到 done；不要动代码。</never>
</castboard_task_dispatch>
```

**字段说明**：

- `<task>`：这张卡的身份（标题），让模型知道从哪张卡派活。
- `<target>`：三个下拉（项目组 id / 责任人 / 目标实例），**任一为空则整个标签退化成 `<target/>`**。
  这是分发指导里 `<given>` 段说的「唯一免问口子」的来源 —— 只认这个**字面标签**，
  模型自己查到的候选不算「已给定」。
- `<request>`：人写的要求（1..4000 字符）。
- `<never>`：与验收轮同一套纪律 —— 不改状态、不自己收卡、不动代码。

与 `castboardAcceptanceXml` 的区别：那份是**自动**验收轮（策略来自文件），这份是**人**给的一次性说明
（怎么拆、派给谁）。两者都要求「别改任务状态、别自己收卡」。

---

## 5. 组装时序（谁在什么时候调什么）

### 5.1 注入点全清单（物理调用点 → section）

全仓 grep `systemPrompt.section` / `buildPluginMessage` / `injectContext` / `agent.inject` /
`followup` / `steer` / `context:` 的结果，**共 12 个物理注入点**，无第十三处：

| # | 调用点 | 注入内容 | 通道 | 文档章节 |
|---|---|---|---|---|
| 1 | `src/index.ts:606` `ctx.systemPrompt.section` | `plugin:dsh-amazing-castboard` | ① | 4.1 |
| 2 | `src/index.ts:431` `sections:[…]` → `work-session.ts:180/193` | `castboard-issue-routing`（两条腿） | ①② | 4.5 |
| 3 | `src/index.ts:474` `sections:[…]` → `work-session.ts:180/193` | `castboard-project-portrait`（两条腿） | ①② | 4.8 |
| 4 | `work-session.ts:256` `handle.injectContext` | `castboard-issue-references` / `castboard-project-portrait-target` | ②每轮 | 4.6 / 4.9 |
| 5 | `task/index.ts:364` `buildPluginMessage`（`pushContextTo`） | `castboard-issue-comments` | ③ | 4.10 |
| 6 | `task/index.ts:386` `handle.injectContext`（同上的退路） | `castboard-issue-comments` | ③ | 4.10 |
| 7 | `task/index.ts:655` `agent.inject(buildPluginMessage)` | `castboard-task-acceptance` | ③ | 4.4 |
| 8 | `task/index.ts:902` `handle.injectContext(extraContext)` | `castboard-issue-comments`（活句柄续跑） | ③ | 3.6 |
| 9 | `task/index.ts:932-936` `context:` 三元 | `buildContexts` = rules + references | ② | 3.2 / 3.3 |
| 10 | `dispatch-tools.ts:609` `target.inject(buildPluginMessage)` | `castboard-issue-creation-guidance` | ③ | 4.7 |
| 11 | `task/index.ts:894` `handle.followup(...)` | 执行指令 / 人评论正文 / 验收轮唤醒语 | user | 2.2 A·C |
| 12 | `task/index.ts:727` `agent.steer(steerMessage)` + `work-session.ts:254` `followup` | 人评论插话 / router·肖像每轮指令 | user | 2.2 B·E·F |

### 5.2 时序图

```
插件 apply()
 └─ ① ctx.systemPrompt.section(plugin:dsh-amazing-castboard)          ← 所有会话常驻

执行轮 start(taskId, trigger)
 ├─ 开新会话 → context: buildContexts(...)                          ← ② rules + references
 │     └─ castboardReferences(task, path, attachments, comments)
 └─ 复用活句柄 → handle.followup(text) + 可选 injectContext(extra)   ← 只有显式给了才投

结算落地
 ├─ 进 in_review 且挂策略 → injectAcceptanceContext()               ← ③ acceptance
 │     └─ 紧接着 startAcceptanceRound() → followup(ACCEPTANCE_ROUND_INSTRUCTION)
 └─ 任务终态 → IssueFinalizer（写 issue 状态与 assigneeMeta，不发上下文）

评论到达（本地写 / 云端拉回 / 补投）
 └─ CommentDeliverer.deliver()
      ├─ 会话活着 → followup|steer(buildPluginMessage(..., ISSUE_COMMENTS_SECTION))
      └─ 不在本进程 → wake → start(..., 'issue-comment', WAKE_INSTRUCTION, assist, transient,
                                   [{ name: ISSUE_COMMENTS_SECTION, text: commentsXml }])

router 服务（3s 一拍、单飞、仅租约主人）
 ├─ 建会话 → openWorkSession(sections:[castboard-issue-routing @150])  ← ①+②
 └─ 每条 issue → session.run(routerInstruction(id),
                             [{ name: castboard-issue-references, text: castboardIssueReferences(...) }])

肖像服务（3:00 / 13:00 两批、串行）
 ├─ 建会话 → openWorkSession(sections:[castboard-project-portrait @160]) ← ①+②
 └─ 每个项目 → session.run(portraitInstruction(target),
                           [{ name: castboard-project-portrait-target, text: portraitTargetXml(target) }])

模型调 castboard_issues_help
 └─ agent.inject(buildPluginMessage(..., castboard-issue-creation-guidance))  ← ③
```

---

## 6. 设计纪律与已知坑

| 纪律 / 坑 | 说明 |
|---|---|
| **一条 entry 一个 section** | 一个 `{name,text}` 就是 GUI 里一行上下文；混装会让那一行名字对不上内容 |
| **归属插件名必须是本插件** | `contextPlugin: PLUGIN_NAME`，否则 GUI 上下文行署名成 magica（用户报过） |
| **空块宁可不输出** | 空标签会被读成「有但内容为空」（如「有附件但没文件」），不输出才是「没有」 |
| **缺省要显式说明** | 例外是 `<checklist>`：为空时写「本任务没有验收清单。」—— 静默留空会被读成「依赖丢了」 |
| **全部转义** | 标题 / 清单项 / 评论正文 / 附件名都过 `escapeXml`；`escapeXmlAttr` 额外转 `"` |
| **两个 id 必须说清** | `<task id>` 与 `<issue id>` 并列摆出，并点名各配哪个工具（真机踩过） |
| **续跑不重投首轮上下文** | 重投只会在对话里凭空多出一份；只有显式 `extraContext` 才投 |
| **`inject` 必须配一轮唤醒** | `agent.inject()` 是 `wake: false` 的排队，不唤醒就永远读不到（验收轮踩过） |
| **顺序即语义** | `buildContexts` 返回顺序 = 注入顺序（rules 在前）；验收策略 close 在前、issue 在后 |
| **相对时刻不进上下文** | `nextRunAt` 这类值按当前时刻现算，落盘会让每次写都变，只在 HTTP 响应里补 |
| **静态指导两条腿** | 常驻会话的静态指导既进 systemPrompt section（压缩后仍在）也进首轮插件上下文（GUI 可见） |
| **按需注入省 token** | 分发指导只在调 `castboard_issues_help` 时注入；常驻等于给每个会话白付几千 token |
| **系统提示词不国际化** | `BOARD_PROMPT_TEXT` 是装配期产物，同一会话中途不会切语言 |

---

## 7. 速查：section 名 → 常量 → 文件

| section 名 | 常量 | 文件:行 |
|---|---|---|
| `plugin:dsh-amazing-castboard` | `BOARD_PROMPT_SECTION` / `BOARD_PROMPT_TEXT` | `task/context.ts:64` / `:99` |
| `castboard-task-rules` | `RULES_SECTION` / `CASTBOARD_RULES_XML` | `task/context.ts:117` / `:161` |
| `castboard-task-references` | `REFERENCES_SECTION` / `castboardReferences()` | `task/context.ts:123` / `:226` |
| `castboard-task-acceptance` | `TASK_ACCEPTANCE_SECTION` / `castboardAcceptanceXml()` | `task/context.ts:500` / `:517` |
| `castboard-issue-routing` | `ISSUE_ROUTING_SECTION` / `CASTBOARD_ISSUE_ROUTING_XML` / `castboardIssueRoutingXml()` | `task/context.ts:450` / `:581` / `:675` |
| `castboard-issue-references` | `ISSUE_REFERENCES_SECTION` / `castboardIssueReferences()` | `task/context.ts:497` / `:703` |
| `castboard-issue-creation-guidance` | `DISPATCH_GUIDANCE_SECTION` / `castboardIssueCreationGuidance()` | `issue/dispatch-guidance.ts:23` / `:51` |
| `castboard-project-portrait` | `PORTRAIT_SECTION` / `CASTBOARD_PORTRAIT_XML` | `issue/portrait-prompt.ts:35` / `:48` |
| `castboard-project-portrait-target` | `PORTRAIT_TARGET_SECTION` / `portraitTargetXml()` | `issue/portrait-prompt.ts:137` / `:150` |
| `castboard-issue-comments` | `ISSUE_COMMENTS_SECTION` / `commentsXml()` | `link/deliver.ts:105` / `:600` |
| （user 消息）分发指令 | `taskDispatchInstruction()` | `task/context.ts:474` |
| （user 消息）验收轮唤醒语 | `ACCEPTANCE_ROUND_INSTRUCTION` | `task/context.ts:567` |
| （user 消息）router 每轮指令 | `routerInstruction()` | `issue/router-service.ts:92` |
| （user 消息）肖像每轮指令 | `portraitInstruction()` | `issue/portrait-prompt.ts:173` |
| （user 消息）评论唤醒语 | `WAKE_INSTRUCTION` / `ASSIGNER_WAKE_INSTRUCTION` | `link/deliver.ts:584` / `:589` |
| （user 消息）建立期占位 | `ROUTER_IDLE_PROMPT` / `PORTRAIT_IDLE_PROMPT` | `issue/router-service.ts:101` / `issue/portrait-prompt.ts:44` |