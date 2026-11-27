# Castboard 交互事件上报、跨机同步与应答 —— 实施计划

> 状态：**设计稿，部分实现**。第一刀已落：spellbook `magica/interaction-changed` 事件 + castboard `InteractionCoordinator` 骨架（事件唤醒 + 安全拍）。协议 / projection / 上报 / 应答仍待实现。
> 协议 v1 已定：控制评论的 body 是**纯 JSON**，不再使用 marker 包裹。
> 范围：`dsh-magica-castboard` 的 issue / task / comment / interaction 链路。
> 不涉及：0.1.2 的 `dsh-magica-index`、`dsh-magica-im`、magica 兼容、云端新增表。

---

## 0. 结论先行

1. **评论是传输层**：`requested` / `answered` / `completed` 都是版本化 JSON 控制评论，搭现有 issue 评论上云。
2. **评论 body 直接是 JSON**：`schema: "castboard.interaction/v1"` 做判别和版本，不再有 `[castboard-interaction:v1]` marker。
3. **source host 是唯一 authority**：真正挂住 approval/question 的机器决定 apply；dispatcher 永远不 apply 远端交互。
4. **projection 是跨机读模型**：dispatcher 的工具、UI、reporter 重启恢复都从评论流投影，不读本地 `InteractionService`。
5. **Coordinator 事件驱动 + 安全拍**：spellbook 在 pending 增加/移除时发事件，Coordinator 立即 `refresh -> reconcile -> report`；30s 安全拍只兜底，不再每 5s 盲轮询。
6. **只对 task 会话上报**：`sessionId -> taskId -> task.issueId` 且 `link.assigneeSessionId === interaction.sessionId`；router / portrait / 普通 DSH 会话 / 子代理一律不报。
7. **deliver 只开一个窄口子**：只放行 `requested` / `completed` 的 system 评论，普通 system 评论仍然不投递。
8. **应答统一写控制评论**：工具写 `answered`，source host 的 bridge 收到后调 `InteractionService.answerRemote`。
9. **工具基于 projection**：`castboard_issue interactions` / `answer_interaction` 从评论流找 request，不依赖本地 pending cache。
10. **重启可收口**：projection 重建后，对“已上报、source host 已丢失”的交互补发 `completed(outcome:'expired')`，不让 dispatcher 永远等。

---

## 1. 术语

| 术语 | 含义 |
|---|---|
| source host / 交互源 | 真正挂住 approval/question 的 host；通常是 assignee 执行机 |
| dispatcher / 派发方 | 创建 issue、把任务派给 assignee 的会话所在 host |
| pending | spellbook `listPendingApprovals` / `listPendingQuestions` 里的待决项 |
| requested | 交互出现事件 |
| answered | 某一方给出的答案（运输/审计事件） |
| completed | source host 观察到 pending 消失后发出的关闭通知 |
| control comment | 不是人类聊天，而是 castboard 控制面写在 issue 评论流里的 JSON 事件 |
| projection | 从评论流重建的交互状态视图，工具/桥接/渲染共用 |

---

## 2. 现状调研（代码证据）

### 2.1 组件与职责

| 文件 | 现有职责 | 与本方案关系 |
|---|---|---|
| `src/host/exec/interactions.ts` | 包装 spellbook pending，供 `/state` 与 `/magica` 使用 | 需要增量：`refreshResult`、`answerRemote`、full answers、outcome |
| `src/host/http/routes/magica.ts` | 本机面板的交互读写；`requireOwner()` 绑 storage lease | **不用于跨机应答**；只保留本机 UI |
| `src/host/http/routes/state.ts` | `/state` 带 interactions + fingerprint | 本地面板可见性；跨机交互走评论 |
| `src/host/http/routes/shared.ts` | `interactionRecords` / `pendingInteractionRecords` | 需要暴露 refresh 失败信息 |
| `src/host/pipeline/thread.ts` | 评论唯一读写入口；append/publish/deliver；`addSystem` | 需要新增 `addControl`，不能直接用 `addSystem` 写 answer |
| `src/host/pipeline/deliver.ts` | 评论合并窗口与三档投递；**过滤所有 system** | 需要对 interaction request/completed 开窄口子 |
| `src/host/pipeline/inbox.ts` | 每 5s 拉云评论、落盘、投递 | 可选挂 `onIngested`，但正确性不依赖它 |
| `src/host/pipeline/publish.ts` | 本地评论按 watermark 上云；comment id 幂等 | 控制评论复用 |
| `src/host/pipeline/sdk-face.ts` | 云评论 listSince / publish | 云端没有交互 metadata，协议必须放 body |
| `src/host/ledger/comment-store.ts` | JSONL 评论；`MAX_COMMENT_BODY=4000` | 控制评论必须限长 |
| `src/host/ledger/task-store.ts` | `taskIdOfSession()` | scope 过滤关键 |
| `src/host/ledger/link-types.ts` / `link-store.ts` | `assignerSessionId` / `assigneeSessionId` | 判定 task 会话与投递目标 |
| `src/host/context/comment-context.ts` | `commentsXml`，把 body 转义进 `<comment>` | 需要识别交互协议并结构化渲染 |
| `src/host/context/task-context.ts` | `<comments>` 自己再渲染一遍所有评论 | 必须共用交互渲染器，否则首次执行看到 raw JSON |
| `src/host/tools/issue-tools.ts` | `castboard_issue_state` 返回 issue/comments/link | 需要加 interactions 投影 |
| `src/host/tools/gateway.ts` / `gateway-schema.ts` | 四个 gateway 工具与 oneOf schema | 增加 `interactions` / `answer_interaction` capability |
| `src/host/tools/issue-comment.ts` | `castboard_comment get/add` | `get` 需要过滤控制评论 |
| `src/index.ts` | 组装所有服务、inbox、deliverer、InteractionService | 需要新增 Coordinator/bridge/工具接线 |
| `src/shared/wire.ts` | BoardSettings 与默认值 | 增加 `interactionReportEnabled` |
| `src/host/ledger/settings-yaml.ts` | YAML 字段顺序与注释 | 增加设置键 |
| `src/host/rules.ts` | 设置校验 | 增加 boolean 校验 |
| `src/client/features/preferences/dialog.tsx` | 面板设置页 | 增加开关与 i18n |
| `src/client/features/task/panels.tsx` / `issue/dispatched.tsx` | 直接渲染 `comment.body` | 控制评论会显示 raw JSON，需要摘要/隐藏 |
| spellbook `interactions/collect.ts` | 采集 pending，保留完整 `questions` | source of truth 的输入 |
| spellbook `sessions/questions.ts` | 支持 `answers[]` 多题 | castboard face 需要 full answers |

### 2.2 现有 `InteractionService.refresh`

`src/host/exec/interactions.ts`：

```ts
async refresh(): Promise<readonly PendingInteraction[]> {
  const face = this.deps.face
  if (face === undefined) {
    this.cache = []
    return this.cache
  }
  try {
    // ...
  } catch {
    // Keep the last snapshot on a failed read (do not blank the UI)
  }
  return this.cache
}
```

问题：**失败时返回旧 cache，调用方无法区分“真的没有 pending”和“刷新失败”**。reporter 如果直接拿它做 diff，会在一次失败后把全部 pending 误判为 completed。

计划：新增

```ts
export interface InteractionRefresh {
  items: readonly PendingInteraction[]
  ok: boolean
}

async refreshResult(): Promise<InteractionRefresh>
```

- `ok:false`：face 缺失、读失败、服务不可用；reporter/coordinator 整拍跳过，**绝不发布 completed**。
- `refresh()` 保留给 `/state`，内部走 `refreshResult()`，失败时仍返回旧 cache。

### 2.3 现有应答：`/magica` 是面板路由

`src/host/http/routes/magica.ts`：

```ts
const requireOwner = (): void => {
  if (deps.isWritable()) return
  throw fail('forbidden', `本窗口只读：交互由另一个 dsh web 负责（${deps.ownerHint()}）`, 403)
}
```

结论：

- 只适合**本机面板**；
- 权限是本机 storage lease；
- 内部也只是调 `InteractionService`；
- 远端 dispatcher 不是 lease 主人，不能调；
- 不能作为跨机 answer 传输层。

### 2.4 现有 `InteractionService` 应答依赖 UI cache

```ts
async answerApproval(id: string, approved: boolean, note?: string): Promise<boolean> {
  const target = this.cache.find(item => item.id === id && item.kind === 'approval')
  if (target === undefined) return false
  // ...
}
```

问题：`cache` 只由 `/state` / `refresh` 填充；如果看板没打开、或进程刚启动，bridge 直接调会 `false`，远端 answer 丢失。

计划：新增不依赖 UI cache 的 `answerRemote({ interactionId, sessionId, kind, ... })`；bridge 先 `refreshResult()` 再 apply。

### 2.5 现有 `addSystem` 强制 role=assignee

`src/host/pipeline/thread.ts`：

```ts
async addSystem(anchorId, draft) {
  const forced: CommentDraft = { ...draft, role: 'assignee', authorType: 'system' }
  // ...
}
```

- `requested` / `completed` 需要 `role='assignee'`，`addSystem` 合适；
- `answered` 需要 `role='assigner'`，`addSystem` 会把方向写反；
- 需要新增 `addControl(anchorId, { role, ... })`，显式指定 role，`authorType` 固定 system。

### 2.6 现有 deliver 过滤 system

`src/host/pipeline/deliver.ts` 有三处：

```ts
// 1) deliver()
const human = comments.filter(comment => comment.authorType !== 'system')

// 2) retryPending()
const pending = unique(all.filter(comment =>
  comment.authorType !== 'system'
  && targetsSide(comment, side)
  // ...
))

// 3) route()
const uniqueBatch = unique(comments.filter(comment =>
  comment.authorType !== 'system' && comment.threadId !== sessionId))
```

如果 request/completed 用 system，**三处都必须改**，而且只能放行合法交互控制评论。

### 2.7 现有 `liveSession` 接线

`src/index.ts` 已直接透传 `CommentContextEntry`，不再 map 成 `{name,text}`；`delivery.test.ts` 也断言了 `form:'notice'` / `summary`。

**这一项已修，不再是阻塞项。**

### 2.8 现有 `commentsXml` 只转义，不识别协议

`src/host/context/comment-context.ts`：

```ts
lines.push(`  <comment ${attrs}>${escapeXml(comment.body)}</comment>`)
```

如果直接塞 JSON，agent 看到的是转义后的 raw 协议，且没有“用工具回答”的引导。

### 2.9 现有 task context 自己渲染评论

`src/host/context/task-context.ts`：

```ts
if (comments.length > 0) {
  lines.push(`<comments count="${comments.length}">`)
  for (const comment of comments) {
    lines.push(`  <comment ...>${escapeXml(comment.body)}</comment>`)
  }
  lines.push('</comments>')
}
```

首次执行虽然还没收到 live comment，也会从 task context 看到全部评论；交互协议必须在这里也结构化渲染，不能只改 `commentsXml`。

### 2.10 现有模型设置

`src/shared/wire.ts`：

```ts
export interface BoardSettings {
  defaultPermission: Permission
  maxConcurrent: number
  autoRoute: boolean
  portraitRunOnStart: boolean
  commentsEnabled: boolean
  commentPollMs: number
}
```

需要新增 `interactionReportEnabled`。

### 2.11 现有 cloud comment 能力

`src/host/pipeline/sdk-face.ts`：

```ts
publish: async input => {
  await call(client.castboardAddIssueComments, input.issueId, [{
    commentId: input.commentId,
    content: input.body,
    commentAt: isoLocal(input.createdAt),
    ...(input.role === null ? {} : { commentRole: input.role }),
    commentAuthorType: input.authorType,
  }])
}
```

云端评论只有 `content/commentRole/commentAuthorType/commentAt`，没有自定义 metadata。因此：

- 交互协议必须放在 `content`；
- `systemKey` 只在本地存在，过云会丢，**不能作为跨机判断依据**；
- `commentAuthorType: 'system'` 会被 teamwork 服务端接受，并原样返回。

### 2.12 现有 inbox 拉取

`src/host/pipeline/inbox.ts` 每个 tick：

```ts
await this.retryPending()
await this.deps.cursor.load()
const sinceId = Math.max(0, this.deps.cursor.current() - COMMENT_OVERLAP)
const page = await this.deps.fetchPage({ sinceId, limit: COMMENT_PAGE_LIMIT })
// ...
const ingested = await this.ingestByAnchor(fresh)
if (!ingested.failed) this.deps.cursor.advance(page.nextSinceId)
const delivered = await this.deliverByAnchor(ingested.added)
```

这是现成的 5s 轮询；Coordinator 可以独立定时，也可以复用这个 tick。正确性不依赖 `onIngested`。

### 2.13 现有 task 会话判定

`src/host/ledger/task-store.ts`：

```ts
taskIdOfSession(sessionId: string): string | undefined {
  if (sessionId === '') return undefined
  for (const task of this.ledger.tasks) {
    if (task.trashedAt !== undefined) continue
    if (task.claimedBy === sessionId) return task.id
    for (let index = task.executions.length - 1; index >= 0; index -= 1) {
      if (task.executions[index]?.sessionId === sessionId) return task.id
    }
  }
  return undefined
}
```

这是“只对 castboard task 会话”的关键闸门。

### 2.14 `castboard_issue state` 实际上裁掉了 comments

`src/host/tools/gateway.ts`：

```ts
const ISSUE_CAPABILITIES = [
  // ...
  { capability: 'state', handler: 'castboard_issue_state', stripComments: true },
]

function stripComments(value: unknown): unknown {
  // ...
  delete record.comments
  return record
}
```

所以计划里“issue state 返回 comments”这句不准确：

- `castboard_issue state` 只返回 issue + attachments；
- `castboard_comment get` 才走 `castboard_issue_state` 并截取 comments；
- 要在 `castboard_issue state` 里加 `interactions`，不会被 `stripComments` 删掉。

### 2.15 客户端直接渲染 comment.body

- `src/client/features/task/panels.tsx` 的 issue state 和 `CommentBubble` 直接显示 `comment.body`；
- `src/client/features/issue/dispatched.tsx` 也直接显示；
- 控制评论如果不处理，会显示 raw JSON。

### 2.16 `coveredUntil` 是 per-anchor，不是 per-target-session

`src/host/pipeline/deliver.ts` 用 `coveredUntil(anchorId)` 过滤。正常流程下 request/completed 写在 task context 之后，问题不大；但“assigner 离线 + assignee 重新 seed”时，可能把 request 永久吞掉。计划对控制评论**绕过该水位**，或后续改成 per-target-session。

### 2.17 `ThreadService.add` 的幂等与裁剪

```ts
function clipBody(body: string): string {
  return body.length > MAX_COMMENT_BODY ? body.slice(0, MAX_COMMENT_BODY) : body
}

async add(anchorId, draft): Promise<ThreadComment | undefined> {
  const [only] = await this.addMany(anchorId, [draft])
  return only
}
```

- id 已存在时 `appendRows` 返回 `[]`，`add` 返回 `undefined`；
- 写失败会抛异常；
- body 超 4000 会被静默裁剪。

控制评论必须在编码层保证 ≤ 4000，不能依赖 `clipBody`。

### 2.18 `InteractionService` 没有 outcome 记录

面板答完、pending 消失后，reporter 只能写 `unknown`。需要在 `InteractionService` 或 Coordinator 维护 `outcomeOf(id)`，answer/cancel 时写入。

### 2.19 gateway capability 现状

`src/host/tools/gateway.ts`：

```ts
const ISSUE_CAPABILITIES = [
  { capability: 'help', handler: 'castboard_issues_help' },
  { capability: 'create', handler: 'castboard_issues_create' },
  { capability: 'state', handler: 'castboard_issue_state', stripComments: true },
  { capability: 'links', handler: 'castboard_issue_links' },
  { capability: 'convert', handler: 'castboard_issue_task' },
]
```

需要新增 `interactions` / `answer_interaction`，不新增第五个工具。

### 2.20 现有 `InteractionFace.answerQuestion` 是单答案

```ts
answerQuestion?: (input: {
  id: string
  sessionId: string
  answer: string
  selected?: readonly string[]
}) => Promise<void>
```

但 spellbook 的 `answerQuestion` 接受 `{ answers: AskUserQuestionAnswerItem[] }`，`validateAnswers` 按 question id 逐题校验。

`src/index.ts` 的 `createInteractionFace` 目前把同一个 `selected` / `custom` 复制给所有 question；一个 pending 有两个问题时，会答错。

必须改成 full answers，`/magica` 的单题路由再做适配。

### 2.21 spellbook 目前没有交互变更事件

`dsh-magica-spellbook` 对外只有拉取和结算接口：

- `collectPendingInteractions(host, options)`：一次性列出当前 pending；
- `listPendingApprovals` / `listPendingQuestions`：按会话列出；
- `answerApproval` / `answerQuestion` / `cancelQuestion`：结算。

它内部确实知道“交互出现/消失”的精确时刻：

- `sessions/approval.ts` 的 `hold()` 在 `bridge.pending.set(id, ...)` 时出现，`settle()` 在 `bridge.pending.delete(id)` 时消失；
- `sessions/questions.ts` 同理，`settle()` 删除 pending；
- 但两个文件都没有 `ctx.emit`，也没有对外暴露订阅接口。

**不能由 castboard 直接监听 `approval/request` / `user-questions/request`**：spellbook 用 `{ prepend: true, global: true }` 的 waterfall 抢在 `api/remotes` 之前认领请求，并返回一个挂住的 Promise；外部普通监听器在它之后，根本收不到。再 prepend 一层去抢会和 spellbook 竞争，顺序不可靠。

**正确做法**：在 spellbook 增加一个 Cordis 事件，例如：

```ts
export interface InteractionChangedEvent {
  action: 'added' | 'removed'
  item: PendingInteractionRecord
  /** removed 时的原始原因；approval 是 ApprovalOutcome，question 是 answered/cancelled/aborted。 */
  outcome?: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'magica/interaction-changed'(change: InteractionChangedEvent): void
  }
}
```

- `hold()` 在 `bridge.pending.set` 之后发 `added`；
- `settle()` 在 `bridge.pending.delete` 之后发 `removed`，带上 `outcome`；
- 事件用 `ctx.emit`，listener 抛错不能影响审批/提问本身；
- castboard 用 `ctx.on('magica/interaction-changed', ...)` 订阅，属于 Cordis event，符合跨插件通信规则。

这样 Coordinator 不再需要 5s 盲轮询，而是“事件唤醒 + 安全拍兜底”。

---

## 3. 需求与边界

### 3.1 必须支持

1. assignee 执行会话出现 approval/question；
2. 只对该 task 对应的 issue 上报，不扩散到其他 issue/会话；
3. dispatcher 会话通过现有评论注入机制看到结构化交互；
4. dispatcher agent 通过工具应答；
5. 任务面板交互总览、DSH 原生会话、远端评论应答任意一个答了，其他入口自动关闭；
6. 交互完成后，dispatcher 会话收到一条评论注入提醒；
7. 任务面板可关闭交互上报；
8. 断线、重复、乱序、重启后不重复应答、不丢状态；
9. 不影响普通评论、普通 system 评论、execution/task 状态机；
10. 控制评论不能被客户端/工具当 raw JSON 展示。

### 3.2 不做

- 不新增云端 interaction 表/字段；
- 不让 agent 用普通 `castboard_comment` 自由文本回答；
- 不让远端直接调本机 `/magica` 前端 HTTP；
- 不把交互事件扩散到 router/portrait/普通 DSH 会话；
- 不做 magica 的 `kind:'plugin'` 兼容；
- 不修改 task metadata（交互是 issue 侧通道）；
- 不做远端面板 answer UI（面板只处理本机 pending）。

---

## 4. 总体架构

```text
source host（assignee 执行机）          cloud（issue 评论流）           dispatcher host（下发方）
┌──────────────────────────┐          ┌────────────────────┐          ┌──────────────────────────┐
│ spellbook pending        │          │                    │          │ agent 会话               │
│ InteractionService       │─requested▶│  system 评论       │─deliver─▶│ 评论上下文 + interaction  │
│ Coordinator              │◀─answered─│                    │◀─answer──│ projection + 工具         │
│  ├─ reconcile（bridge）   │          │                    │          │                          │
│  └─ report（reporter）    │─completed▶│                    │─deliver─▶│ 完成提醒                 │
└──────────────────────────┘          └────────────────────┘          └──────────────────────────┘
```

### 4.1 五个原则

1. **评论即事件日志**：不新增远端 RPC，不新增云端表。
2. **source host 是唯一 authority**：`requested` / `completed` 只由 source host 写；`answered` 只由应答方写。
3. **projection 是跨机读模型**：dispatcher 的工具/UI/reporter 重启恢复都读 projection。
4. **Coordinator 单拍**：`refresh -> reconcile -> report`，apply 完同一拍可以发 completed。
5. **deliver 窄口子**：只放行 `requested` / `completed`，普通 system 评论保持不变。

### 4.2 三条链路

**上报**

```text
spellbook pending
  -> InteractionService.refreshResult()
  -> Coordinator.report()
  -> ThreadService.addControl(requested)
  -> publish -> cloud
  -> dispatcher inbox
  -> deliver（只对 requested 开窄口子）
  -> agent 看到 <interaction>
```

**应答**

```text
agent 调 castboard_issue answer_interaction
  -> 读 projection 校验 request
  -> 写 answered 控制评论
  -> publish -> cloud
  -> source inbox
  -> Coordinator.reconcile()
  -> InteractionService.answerRemote()
  -> spellbook 解挂
```

**完成**

```text
pending 消失
  -> Coordinator diff
  -> 写 completed（outcome 尽力而为）
  -> publish -> cloud
  -> dispatcher 收到“已关闭”
```

---

## 5. 协议 v1（纯 JSON）

### 5.1 为什么不用 marker

评论 body 本身就是字符串；把完整 JSON 文档直接作为 body，判别由 `schema` 字段承担：

- 少一层 marker 解析；
- 少几十个字符；
- 不会出现“body 被截断后半截 marker 找不到”；
- 工具/UI 一次 `JSON.parse` 直接消费。

普通评论里的 JSON 不受影响：只有 `authorType === 'system'` 且 `schema` 匹配的评论才按协议解释。

### 5.2 信封

```json
{
  "schema": "castboard.interaction/v1",
  "event": "requested",
  "interactionId": "q-7f3a9c",
  "issueId": "5732b9b5-6b0c-4b46-99ee-6c44e1abe9b8",
  "sessionId": "session-abc",
  "kind": "question",
  "at": 1730000000000,
  "instance": "10.0.0.5:3080",
  "request": {}
}
```

公共字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema` | string | 是 | 固定 `castboard.interaction/v1` |
| `event` | `requested` \| `answered` \| `completed` | 是 | 事件类型 |
| `interactionId` | string | 是 | spellbook 的交互 id |
| `issueId` | string | 是 | 评论锚点 / issue UUID |
| `sessionId` | string | 是 | **交互源会话**（assignee 执行会话） |
| `kind` | `approval` \| `question` | 是 | 交互类型 |
| `at` | number | 是 | epoch ms；写入时同时作为评论 `createdAt` |

`instance`、`request`、`by`、`answer`、`outcome` 按事件类型出现。

### 5.3 `requested`（question）

```json
{
  "schema": "castboard.interaction/v1",
  "event": "requested",
  "interactionId": "q-7f3a9c",
  "issueId": "5732b9b5-6b0c-4b46-99ee-6c44e1abe9b8",
  "sessionId": "session-abc",
  "kind": "question",
  "at": 1730000000000,
  "instance": "10.0.0.5:3080",
  "request": {
    "questions": [
      {
        "id": "question-1",
        "header": "发布范围",
        "question": "这次只发测试环境还是生产？",
        "options": [
          { "label": "仅测试", "description": "只发测试环境" },
          { "label": "生产" }
        ]
      }
    ]
  }
}
```

`questions[]`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 问题 id，answer 靠它对应 |
| `question` | string | 是 | 问题正文 |
| `header` | string | 否 | 短标题 |
| `detail` | string | 否 | 补充说明 |
| `options` | `{ label, description? }[]` | 否 | 可选项；没有就是自由文本 |
| `multiSelect` | `true` | 否 | 省略 = 单选 |

`request.truncated?: true` 用于整体压缩后的降级标记。

### 5.4 `requested`（approval）

```json
{
  "schema": "castboard.interaction/v1",
  "event": "requested",
  "interactionId": "a-7f3a9c",
  "issueId": "5732b9b5-6b0c-4b46-99ee-6c44e1abe9b8",
  "sessionId": "session-abc",
  "kind": "approval",
  "at": 1730000000000,
  "instance": "10.0.0.5:3080",
  "request": {
    "toolName": "bash",
    "reason": "需要执行数据库迁移",
    "callId": "call-1",
    "argsPreview": "{\"command\":\"npm run migrate\"}",
    "argsTruncated": true
  }
}
```

`request`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `toolName` | string | 是 | 要执行的工具 |
| `reason` | string | 否 | 原因 |
| `callId` | string | 否 | 原始 tool call id |
| `argsPreview` | string | 否 | 截断后的入参预览 |
| `argsTruncated` | `true` | 否 | 预览是否被截断 |

`displayReason` 不进入协议：它是 source host 的 UI 本地化字段，dispatcher 的模型读 `reason` 就够了。

### 5.5 `answered`（question）

```json
{
  "schema": "castboard.interaction/v1",
  "event": "answered",
  "interactionId": "q-7f3a9c",
  "issueId": "5732b9b5-6b0c-4b46-99ee-6c44e1abe9b8",
  "sessionId": "session-abc",
  "kind": "question",
  "at": 1730000001000,
  "by": {
    "role": "assigner",
    "sessionId": "session-def"
  },
  "answer": {
    "answers": [
      { "questionId": "question-1", "selected": ["仅测试"] }
    ]
  }
}
```

`answer.answers[]`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `questionId` | string | 是 | 对应 `request.questions[].id` |
| `selected` | string[] | 否 | 选中的 option label |
| `custom` | string | 否 | 自由文本 |

`by`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `role` | `assigner` \| `assignee` | 是 | 应答方角色 |
| `sessionId` | string | 否 | agent 会话；人工面板可省略 |

### 5.6 `answered`（approval）

```json
{
  "schema": "castboard.interaction/v1",
  "event": "answered",
  "interactionId": "a-7f3a9c",
  "issueId": "5732b9b5-6b0c-4b46-99ee-6c44e1abe9b8",
  "sessionId": "session-abc",
  "kind": "approval",
  "at": 1730000001000,
  "by": { "role": "assigner", "sessionId": "session-def" },
  "answer": {
    "decision": "allowed-once",
    "note": "只跑一次"
  }
}
```

`decision` 只允许 `allowed-once` / `rejected`；`note` 可选。

### 5.7 `completed`

```json
{
  "schema": "castboard.interaction/v1",
  "event": "completed",
  "interactionId": "q-7f3a9c",
  "issueId": "5732b9b5-6b0c-4b46-99ee-6c44e1abe9b8",
  "sessionId": "session-abc",
  "kind": "question",
  "at": 1730000002000,
  "outcome": "answered"
}
```

`outcome`：

```text
answered | cancelled | expired | reporting_disabled | unknown
```

`completed` 不携带答案摘要；答案由 `answered` 承载。native 应答观测不到时只能 `unknown`，这是已知边界。

### 5.8 判别与解析

不需要 marker，靠 `schema`：

```ts
const trimmed = body.trim()
if (!trimmed.startsWith('{')) return { ok: false, reason: 'not-interaction' }

let parsed: unknown
try {
  parsed = JSON.parse(trimmed)
} catch {
  return { ok: false, reason: 'malformed' }
}

if (!isRecord(parsed)) return { ok: false, reason: 'not-interaction' }
const schema = parsed.schema
if (typeof schema !== 'string' || !schema.startsWith('castboard.interaction/')) {
  return { ok: false, reason: 'not-interaction' }
}
if (schema !== 'castboard.interaction/v1') {
  return { ok: false, reason: 'unsupported', schema }
}

// 继续按 event/kind 校验
```

配套两个判断：

```ts
// 这条评论是不是“控制评论”
isControlComment(comment) =
  comment.authorType === 'system' && isInteractionBody(comment.body)

// 这条控制评论值不值得投递
isDeliverableInteraction(comment, issueId) =
  isControlComment(comment) &&
  decode(comment.body).ok &&
  event is requested | completed &&
  comment.role === 'assignee' &&
  event.issueId === issueId
```

- 普通评论里写 JSON：`authorType` 不是 `system`，不解释，按普通文本；
- 普通 system 评论：body 不是协议，不解析、不投递（trace only）；
- 未知版本：识别为 unsupported，不投递、不按普通评论渲染；
- 坏 JSON / 校验失败：`decodeInteraction` 返回 `malformed`，**不抛**；调用方按普通文本处理。

### 5.8.1 解析失败绝不抛出

`decodeInteraction` 内部必须 `try/catch`，任何坏 body 都返回结果，不向调用方抛：

```ts
type InteractionDecode =
  | { ok: true; event: InteractionEvent }
  | { ok: false; reason: 'not-interaction' }
  | { ok: false; reason: 'unsupported'; schema: string }
  | { ok: false; reason: 'malformed'; detail?: string }
```

调用方约定：

- `deliver` / `commentsXml` / `task-context`：解析失败时走**默认文本路径**，不要把异常冒出去；
- `projection`：跳过这条评论，继续处理下一条；
- `castboard_comment get` / client：按普通评论文本展示，不显示 raw JSON 以外的特殊结构。

**malformed 的 system 评论**：如果 body 看起来像控制协议（`system` + `schema` 前缀）但解析/校验失败，降级为普通文本注入，避免交互信息完全丢失；普通 system trace 仍然不投递。

这样“评论解析”永远不会让评论管道失败。

### 5.9 校验

`decodeInteraction` 对已知字段做强校验，未知字段忽略（向前兼容）：

- `issueId` / `interactionId` / `sessionId` 非空字符串，长度 ≤ 200；
- `kind` ∈ `approval | question`；
- `event` ∈ `requested | answered | completed`；
- `at` 有限正数；
- `requested`：`instance` 非空；`request` 形状匹配 kind；
- `answered`：`by` 形状匹配；`answer` 形状匹配 kind；
- `completed`：`outcome` ∈ 枚举；
- question：`questions` 1..20；`question.id` / `question.question` 非空；`options` ≤ 20；label 非空；
- answer：`answers` 1..20；`questionId` 非空；`selected` 字符串数组；`custom` 字符串。

### 5.10 长度与降级

`MAX_COMMENT_BODY = 4000`。

编码层先按字段上限裁剪：

| 字段 | 上限 |
|---|---|
| `question` | 1000 |
| `header` | 100 |
| `detail` | 500 |
| option `label` | 100 |
| option `description` | 200 |
| `reason` | 1000 |
| `argsPreview` | 1000 |
| `custom` | 1000 |
| `note` | 1000 |
| `questions` | 20 |
| `options` | 20 |

如果 `JSON.stringify` 后仍超 4000：

1. 去 `detail` / option `description` / `header`；
2. 缩短 `question` 和 option `label`；
3. 设 `request.truncated = true`；
4. 仍超就丢掉 `options`，只保留 question id + 文本，允许 dispatcher 用 `custom` 回答；
5. 仍超就减少 questions 数量，并保留 `truncated: true`。

`encodeInteraction` 始终返回 ≤ 4000 的合法 JSON；`addControl` 再 assert 一次。

### 5.11 评论 ID 与幂等

不新增 `eventId` 字段，直接由事件派生评论 id：

```text
requested:  hash(issueId + "\0" + interactionId + "\0requested")
answered:   hash(issueId + "\0" + interactionId + "\0answered\0" + canonical(answer))
completed:  hash(issueId + "\0" + interactionId + "\0completed")
```

- `requested` 不把 request payload 放进 hash：重试、重启、问题文案微调都不会生成第二条；
- `answered` 把 canonical answer 放进 hash：同一答案幂等，不同答案生成不同 id，source host 先到先得；
- `completed` 不把 outcome 放进 hash：一个 interaction 只有一条 completed，第一次写下的 outcome 就是最终值；
- id 格式化成 UUID v5 风格，本地评论和云端 `commentId` 用同一个值；
- `ThreadService.add` 遇到已存在的 id 返回 `undefined`，正好当“已经写过”处理。

### 5.12 版本

- `schema` 里带版本：`castboard.interaction/v1`；
- 未知版本（如 `v2`）识别为 unsupported，**不投递、不按普通评论处理**，UI 显示“不支持的交互事件”；
- v1 只做加法演进：新增可选字段旧解码器忽略；破坏性变更升 `v2`。

---

## 6. 状态模型与投影

### 6.1 状态

```ts
type InteractionStatus =
  | 'pending'
  | 'answered'
  | 'completed'
```

`cancelled` / `expired` / `reporting_disabled` 归入 `completed`，由 `outcome` 区分。

### 6.2 状态机

```text
requested -> pending
pending + answered -> answered
pending/answered + completed -> completed
completed 之后任何事件 -> 保持 completed（终态优先）
answered 先于 requested -> 暂存 answer，等 requested 到再合并
completed 先于 requested -> 直接终态，requested 到后不重新打开
重复事件 -> 按 comment id 去重；同 interaction 的 completed 取第一条
```

### 6.3 投影

`src/host/exec/interaction-projection.ts`：

```ts
export interface InteractionView {
  interactionId: string
  issueId: string
  sessionId: string
  kind: 'approval' | 'question'
  status: InteractionStatus
  request?: InteractionRequest
  answer?: InteractionAnswer
  outcome?: InteractionOutcome
  requestedAt?: number
  answeredAt?: number
  completedAt?: number
  truncated?: boolean
}

export interface InteractionProjection {
  of(issueId: string): Promise<readonly InteractionView[]>
  invalidate(issueId: string): void
}
```

实现要点：

- 只读 `ThreadService.list(issueId)`（已做 echo 去重）；
- 只接受 `authorType === 'system'`、`issueId === anchor`、`schema` 合法的评论；
- 按 `comment.createdAt` 和评论流顺序折叠；
- cache key 用 `comments.length + lastCommentId`，评论变化才重建；
- 不持久化，进程重启从评论流重建。

### 6.4 `refreshResult`

```ts
export interface InteractionRefresh {
  items: readonly PendingInteraction[]
  ok: boolean
}

async refreshResult(): Promise<InteractionRefresh> {
  const face = this.deps.face
  if (face === undefined) return { items: this.cache, ok: false }
  try {
    // ...
    return { items: this.cache, ok: true }
  } catch {
    return { items: this.cache, ok: false }
  }
}
```

- face 缺失也算 `ok:false`：不能因为“spellbook 没装”就把所有 pending 判成 expired；
- `refresh()` 保留给 `/state`，内部调 `refreshResult()`；
- reporter/coordinator 只在 `ok:true` 时做 diff。

### 6.5 outcome 记录

`InteractionService` 增加：

```ts
outcomeOf(id: string): InteractionOutcome | undefined
takeOutcome(id: string): InteractionOutcome | undefined
```

- `answerApproval` / `answerQuestion` / `answerRemote` 写 `answered`；
- `cancelQuestion` 写 `cancelled`；
- reporter 发 completed 时读取并清理；
- 进程重启后丢失，projection 的 `answered` 事件可兜底。

---

## 7. 控制评论写入口

### 7.1 `addControl`

`ThreadService` 增加：

```ts
export interface ControlCommentDraft extends Omit<CommentDraft, 'authorType'> {
  readonly role: CommentSide
}

async addControl(
  anchorId: string,
  draft: ControlCommentDraft,
): Promise<ThreadComment | undefined> {
  if (draft.body.length > MAX_COMMENT_BODY) {
    throw new Error(`control comment too large: ${draft.body.length}`)
  }
  return this.add(anchorId, { ...draft, authorType: 'system' })
}
```

- 不捕获异常：写失败让 reporter 知道，下一拍重试；
- `add` 返回 `undefined` 表示 id 已存在（幂等成功）；
- `createdAt` 用协议里的 `at`，让评论顺序和事件时间一致；
- `systemKey` 用 `castboard.interaction.requested` / `.answered` / `.completed`，仅本地排障，不跨机。

### 7.2 request

```ts
await thread.addControl(issueId, {
  id: interactionCommentId(event),
  role: 'assignee',
  threadId: sessionId,
  body: encodeInteraction(event),
  createdAt: event.at,
  systemKey: 'castboard.interaction.requested',
})
```

### 7.3 answer

```ts
await thread.addControl(issueId, {
  id: interactionCommentId(event),
  role: 'assigner',
  ...(bySessionId === '' ? {} : { threadId: bySessionId }),
  body: encodeInteraction(event),
  createdAt: event.at,
  systemKey: 'castboard.interaction.answered',
})
```

### 7.4 completed

```ts
await thread.addControl(issueId, {
  id: interactionCommentId(event),
  role: 'assignee',
  threadId: sessionId,
  body: encodeInteraction(event),
  createdAt: event.at,
  systemKey: 'castboard.interaction.completed',
})
```

### 7.5 不可以

- 不用 `addSystem` 写 answer（role 会错）；
- 不把控制评论写成 `agent` 绕过 system 过滤；
- 不依赖 `systemKey` 做跨机判断。

---

## 8. 投递：只给交互控制评论开口子

### 8.1 两个判断

`src/host/pipeline/interaction-delivery.ts`：

```ts
/** 合法控制评论：只有 requested / completed 值得投递。 */
export function isDeliverableInteraction(comment: ThreadComment, anchorId: string): boolean {
  if (comment.authorType !== 'system') return false
  if (comment.role !== 'assignee') return false
  const decoded = decodeInteraction(comment.body)
  if (!decoded.ok) return false
  const event = decoded.event
  if (event.issueId !== anchorId) return false
  return event.event === 'requested' || event.event === 'completed'
}

/**
 * 看起来像控制协议、但 JSON/字段坏掉的 system 评论。
 * 按“解析失败不丢信息”的约定，降级成普通文本投递。
 */
export function isMalformedInteractionLike(comment: ThreadComment): boolean {
  if (comment.authorType !== 'system') return false
  if (comment.role !== 'assignee') return false
  return decodeInteraction(comment.body).reason === 'malformed'
}

/** deliver 的窄口子：合法控制评论 + 坏控制评论的文本兜底。 */
export function isInteractionDeliverable(comment: ThreadComment, anchorId: string): boolean {
  return isDeliverableInteraction(comment, anchorId) || isMalformedInteractionLike(comment)
}
```

- 普通 system trace：`isInteractionDeliverable` 为 false，仍然不投递；
- 合法 `requested` / `completed`：投递；
- 坏控制评论：文本投递；
- 普通 user/agent 评论：不进入这个判断，按原逻辑投递。

### 8.2 deliver 三处修改

`deliver()`：

```ts
const deliverable = comments.filter(comment =>
  comment.authorType !== 'system' || isInteractionDeliverable(comment, anchorId))
if (deliverable.length === 0) return
```

`retryPending()`：

```ts
const pending = unique(all.filter(comment =>
  (comment.authorType !== 'system' || isInteractionDeliverable(comment, anchorId))
  && targetsSide(comment, side)
  // ...
))
```

`route()`：

```ts
const uniqueBatch = unique(comments.filter(comment =>
  (comment.authorType !== 'system' || isInteractionDeliverable(comment, anchorId))
  && comment.threadId !== sessionId))
```

### 8.3 `coveredUntil`

只对**交互控制评论**绕过 `coveredUntil`；普通评论仍按原水位：

```ts
const batch = uniqueBatch.filter(comment =>
  isInteractionDeliverable(comment, anchorId)
  || covered === 0
  || comment.createdAt > covered)
```

原因：`coveredUntil` 是 per-anchor，不是 per-target-session；assigner 离线 + assignee 重新 seed 时，request 可能被永久吞掉。更彻底的修法是改成 per-target-session，但改动面更大，第一阶段先对控制评论开白名单。

### 8.4 合并窗口与摘要

- request/completed 仍走 `coveredUntil` 之外的合并窗口；
- 同一批 request + completed 按 `createdAt` 排序渲染；
- `CommentContextEntry.summary` 对 interaction 用更准确的文案，例如 `Interaction requested` / `Interaction closed`。

---

## 9. 上报：Coordinator

### 9.1 位置

新增 `src/host/exec/interaction-coordinator.ts`：

```ts
export class InteractionCoordinator {
  start(): void
  stop(): void
  /** 事件驱动的唤醒；短 debounce 合并 added/removed 突发。 */
  wake(reason?: string): void
  tick(): Promise<void>
}
```

- **事件驱动**：spellbook 的 `magica/interaction-changed`（见 §2.21）→ `wake()`；
- **远端评论驱动**：inbox 的 `onIngested`（见 §10.1）→ `wake()`；
- **安全拍**：每 30s（或 `max(30s, commentPollMs * 6)`）跑一次 `tick()`，只兜底漏事件/重启/投影变化；
- 如果 spellbook 版本没有事件能力，退化为 `commentPollMs` 安全拍；
- 单飞：上一拍未完成时 `wake()` 只置 `dirty`，当前拍结束后再跑一次；
- 只在 `lease.isOwner()` 时运行；
- 定时器 `unref`，随 owner 服务 dispose。

**正常路径不再有 5s Coordinator 延迟**：source host 的 pending 一出现，`hold()` 发事件，Coordinator 立刻写 `requested`；pending 一消失，`settle()` 发事件，Coordinator 立刻写 `completed`。

### 9.2 事件订阅

在 `src/index.ts` 的接线里：

```ts
ctx.effect(() => ctx.on('magica/interaction-changed', change => {
  if (change.action === 'removed') {
    interactions.noteOutcome(change.item.id, outcomeOfChange(change))
  }
  coordinator.wake(change.action)
}))
```

- `noteOutcome` 只写第一次，不覆盖 `answerRemote` 已经记录的 `answered`；
- listener 只做“记录 + 唤醒”，不做 I/O；
- 事件在非 owner 窗口也会到达，但 Coordinator 的 `tick` 会检查 lease，不写评论。

### 9.3 tick

```ts
async tick(): Promise<void> {
  const refresh = await this.interactions.refreshResult()
  if (!refresh.ok) return

  const applied = await this.bridge.reconcile(refresh.items)
  const current = await this.currentReportable(refresh.items, applied)

  await this.report(current)
  await this.completeMissing(current)
}
```

- `reconcile` 见 §10；
- `applied` 的 id 从 `current` 排除，这样同一拍可以发 completed；
- 没有事件时由安全拍调用；有事件时由 `wake()` 触发。

### 9.4 过滤（只对 task 会话）

```ts
function reportable(interaction: PendingInteraction): { taskId: string; issueId: string } | undefined {
  if (settings.interactionReportEnabled === false) return undefined
  const taskId = interaction.taskId
    ?? deps.taskIdOfSession?.(interaction.sessionId)
  if (taskId === undefined) return undefined
  const task = deps.tasks.get(taskId)
  if (task === undefined || task.trashedAt !== undefined) return undefined
  if (task.issueId === undefined || task.issueId === '') return undefined
  const link = deps.links.get(task.issueId)
  if (link?.assigneeSessionId !== interaction.sessionId) return undefined
  return { taskId, issueId: task.issueId }
}
```

补充：

- 不看 `authorType`，只看 task 归属；
- 不订阅所有 session 事件，只消费 `InteractionService` 的 pending；
- 子代理会话没有 taskId，天然被过滤；
- router/portrait 没有 taskId，天然被过滤；
- task 没有 issueId（纯本地卡）不报；
- issue link 缺失时暂不报，等 link 建立。

### 9.5 出现

`known` 以 `interactionId` 为键，值里保存 `commentId` 和请求事件。

```ts
for (const item of items) {
  const target = reportable(item)
  if (target === undefined) continue
  if (known.has(item.id)) continue

  const event = buildRequestedEvent(item, target)
  const commentId = interactionCommentId(event)
  const written = await thread.addControl(target.issueId, {
    id: commentId,
    role: 'assignee',
    threadId: item.sessionId,
    body: encodeInteraction(event),
    createdAt: event.at,
    systemKey: 'castboard.interaction.requested',
  })
  // written === undefined 表示 id 已存在，也是成功
  known.set(item.id, {
    commentId,
    event,
    issueId: target.issueId,
    sessionId: item.sessionId,
    seeded: false,
  })
}
```

- 写失败会抛异常；捕获后不要加入 `known`，下一拍重试；
- `written === undefined` 是幂等成功，正常加入 `known`。

### 9.6 完成

```ts
for (const [interactionId, previous] of known) {
  if (current.has(interactionId)) continue
  // seeded = 重启恢复；没有本地 apply 证据，不能谎报 answered
  const outcome = previous.seeded
    ? 'expired'
    : outcomeOf(interactionId) ?? projectionOutcome(previous) ?? 'unknown'
  const event = buildCompletedEvent(previous, outcome)
  await thread.addControl(previous.issueId, {
    id: interactionCommentId(event),
    role: 'assignee',
    threadId: previous.sessionId,
    body: encodeInteraction(event),
    createdAt: event.at,
    systemKey: 'castboard.interaction.completed',
  })
  known.delete(interactionId)
}
```

- `outcomeOf` 来自 `InteractionService`（同一进程内的 answer/cancel）；
- `projectionOutcome` 从评论流里的 `answered` / `completed` 取；
- `seeded` 的条目来自重启恢复：projection 里的 `answered` 只能证明“有人答过”，不能证明 source host 已经 apply；重启后统一按 `expired` 收口，避免谎报；
- 拿不到 outcome 的普通条目写 `unknown`；
- 写成功（或 id 已存在）才删除 `known`。

### 9.7 重启

第一次 tick 从 projection 重建 `known`：

- 扫描有 task/link 的 issue；
- 对每个 `requested` 且 `sessionId -> task -> issue` 属于本机的交互，加入 `known`，标记 `seeded: true`；
- 如果当前 pending 里没有它 → 直接发 `completed(outcome:'expired')`；
- 如果当前 pending 里有它 → 不重发 requested（projection 已经证明写过）。

这样进程重启不会让 dispatcher 永远等，也不会重复 request；代价是“重启前已 apply 但还没写 completed”的交互会被保守地标成 `expired`，而不是谎报 `answered`。如果以后需要精确区分，增加 `applied` 回执即可。

### 9.8 开关关闭

建议：

- `interactionReportEnabled=false` 时**不再发新 requested**；
- 已上报、仍 pending 的交互**继续正常 completed**，不伪造 `reporting_disabled`；
- 这样重新打开不会出现“已关闭又被重开”的问题。

如果产品要求“关闭即止血”，再引入 `completed(reporting_disabled)` 和 `reopened` 事件；第一阶段不做。

### 9.9 不要重复 completed

- reporter 只对“自己上报过 requested”的 interaction 发 completed；
- bridge 远程 apply 后不要自己再发 completed；
- answer 工具不要发 completed；
- 本地面板/DSH 原生回答也不发 completed；
- 全部由 Coordinator 的 pending diff 统一收口。

---

## 10. 应答：Bridge + Tool

### 10.1 Bridge

`src/host/exec/interaction-bridge.ts`：

```ts
export class InteractionBridge {
  async reconcile(pending: readonly PendingInteraction[]): Promise<ReadonlySet<string>>
  async applyAnswer(event: InteractionAnsweredEvent): Promise<boolean>
}
```

`reconcile`：

- 对每个 pending，读该 issue 的评论流；
- 找 `answered` 且 `interactionId` / `sessionId` / `issueId` 匹配的事件；
- 找到就 `applyAnswer`；
- 返回本拍成功 apply 的 interaction id 集合。

`applyAnswer`：

```ts
const target = pending.find(item =>
  item.id === event.interactionId && item.sessionId === event.sessionId)
if (target === undefined) return false

const taskId = target.taskId ?? deps.taskIdOfSession?.(target.sessionId)
const task = taskId === undefined ? undefined : deps.tasks.get(taskId)
if (task?.issueId !== event.issueId) return false

await this.service.answerRemote({
  interactionId: event.interactionId,
  sessionId: event.sessionId,
  kind: event.kind,
  ...(event.kind === 'approval'
    ? { decision: event.answer.decision, note: event.answer.note }
    : { answers: event.answer.answers }),
})
return true
```

- `answerRemote` 失败 → 返回 false，下一拍重试；
- 已经 apply / pending 消失 → 返回 false，不重复写；
- bridge **不写新的 answered 评论**；
- inbox 的 `onIngested` 在落盘后调用 `coordinator.wake()`，让远端 answer 到达时立刻 reconcile；即使这个 hook 漏了，安全拍也会兜底。

### 10.2 `InteractionService.answerRemote`

```ts
async answerRemote(input: {
  interactionId: string
  sessionId: string
  kind: 'approval' | 'question'
  decision?: 'allowed-once' | 'rejected'
  note?: string
  answers?: readonly InteractionAnswerItem[]
}): Promise<boolean> {
  // 先 refreshResult，确保 cache 有目标
  // 调 face.answerApproval / face.answerQuestion
  // 成功后从 cache 摘除，并记录 outcome
}
```

- 不要求调用方先打开 `/state`；
- full answers 直接透传给 spellbook；
- 失败抛出，bridge 下一拍重试。

### 10.3 full answers

`InteractionFace.answerQuestion` 改为：

```ts
answerQuestion?: (input: {
  id: string
  sessionId: string
  answers: readonly InteractionAnswerItem[]
}) => Promise<void>
```

`createInteractionFace` 直接透传 `answers`；`/magica` 的单题路由构造 `[{ id: firstQuestionId, selected, custom }]`。

### 10.4 工具设计

`castboard_issue` 增加两个 capability：

```ts
const ISSUE_CAPABILITIES = [
  // ...
  { capability: 'interactions', handler: 'castboard_interactions_list' },
  { capability: 'answer_interaction', handler: 'castboard_interaction_answer' },
]
```

Schema：

```ts
branch('interactions', 'List open and recent interactions for one issue.', {
  issueId: string('Issue UUID.'),
  includeClosed: boolean('Include completed interactions. Default false.'),
  limit: integer('Max recent interactions. Default 20.'),
}, ['issueId'])

branch('answer_interaction', 'Answer a pending approval or question.', {
  issueId: string('Issue UUID.'),
  interactionId: string('Interaction id from the injected <interaction>.'),
  decision: {
    type: 'string',
    enum: ['allowed-once', 'rejected'],
    description: 'Approval only.',
  },
  answers: {
    type: 'array',
    description: 'Question answers; one per question id.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        questionId: string('Question id.'),
        selected: stringArray('Selected option labels.', 'Option label.'),
        custom: string('Free-text answer.'),
      },
      required: ['questionId'],
    },
  },
  note: string('Optional note for approval.'),
}, ['issueId', 'interactionId'])
```

### 10.5 工具底层

**关键：基于 projection，不基于本地 `InteractionService`。**

```ts
async function answerInteraction(input) {
  const side = sideOf(deps, input.issueId, sessionIdOf(exec) ?? '')
  if (side !== 'assigner') throw forbidden('只有 assigner 会话能回答这条交互')

  const views = await projection.of(input.issueId)
  const target = views.find(view =>
    view.interactionId === input.interactionId && view.status !== 'completed')
  if (target === undefined) return stale()
  if (target.status === 'answered') return stale()

  validateAnswer(target.request, input)

  const event = buildAnsweredEvent(target, input)
  await thread.addControl(input.issueId, {
    id: interactionCommentId(event),
    role: 'assigner',
    ...(sessionId === '' ? {} : { threadId: sessionId }),
    body: encodeInteraction(event),
    createdAt: event.at,
    systemKey: 'castboard.interaction.answered',
  })

  // 本机就是 source host 时快路径；否则等 bridge
  if (deps.localPending(target.interactionId)) {
    await deps.interactions.answerRemote({ ... })
  }
  return { ok: true, status: 'accepted' }
}
```

校验：

- approval：必须有 `decision`，不能带 `answers`；
- question：必须有 `answers`，每个 questionId 属于该 pending，selected 是 option 子集；
- 多选/单选规则由 request 元数据校验；
- 每个 question 都必须有答案（selected 或 custom 至少一个）；
- 已 answered/completed → `stale`；
- 调用者必须是 issue 的 assigner 会话（`sideOf === 'assigner'`）；
- `both` / `observer` 拒绝。

### 10.6 三个入口，一个 authority

| 入口 | 路径 |
|---|---|
| 任务面板交互总览 | `/magica` → `InteractionService` → host service（仅本机） |
| DSH 原生会话 | spellbook 自己 resolve；Coordinator diff 感知 |
| 远端评论应答 | inbox → Coordinator.reconcile → `InteractionService` → host service |
| agent 工具 | `castboard_issue` → projection 校验 → answer 评论（+ 本地快路径） |

`InteractionService` / spellbook 是 source host 的唯一 authority；其他入口都只是调用它。只要一个人答了，pending 消失，其他入口自动关闭。

### 10.7 为什么不调 `/magica`

- `requireOwner()` 绑本机 lease；远端 dispatcher 不是主人；
- 没有跨机认证/寻址；
- 它内部就是 `InteractionService`，直接调 host service 更短、更稳；
- 评论已经提供持久化/断线恢复，不需要第二套 RPC。

### 10.8 本地快路径与幂等

- 工具写完 answer 评论后，如果 `InteractionService` 本机有 pending，直接 `answerRemote`；
- bridge 之后收到自己写的 answer 评论时，pending 已消失 → no-op；
- 如果 bridge 先 apply，工具快路径看到 pending 消失 → no-op；
- 两侧都不要因为“已消失”写多个 completed；completed 由 Coordinator 统一产生。

---

## 11. 渲染

### 11.1 agent XML

`commentsXml` / `task-context` 共用 `renderInteractionXml(event, side)`：

```xml
<interaction id="q-7f3a9c" kind="question" status="pending" at="2026-11-26T...">
  <summary>发布范围：这次只发测试环境还是生产？</summary>
  <questions>
    <question id="question-1">
      <header>发布范围</header>
      <text>这次只发测试环境还是生产？</text>
      <options>
        <option label="仅测试">只发测试环境</option>
        <option label="生产"/>
      </options>
    </question>
  </questions>
  <reply>Use castboard_issue capability="answer_interaction" issueId="..." interactionId="q-7f3a9c" to answer.</reply>
</interaction>
```

completed：

```xml
<interaction id="q-7f3a9c" kind="question" status="completed" outcome="answered">
  <summary>This interaction is closed. Do not answer it again.</summary>
</interaction>
```

answered（task context 可见，deliver 不投递）：

```xml
<interaction id="q-7f3a9c" kind="question" status="answered">
  <summary>Answered: 仅测试</summary>
  <reply>This interaction is already answered; do not answer it again.</reply>
</interaction>
```

分侧：

- `side='assigner'`：`<reply>` 指向 `answer_interaction`；
- `side='assignee'`：请求显示“等 dispatcher 应答，不要自己答”；answered 显示答案；completed 显示关闭。

### 11.2 `commentsXml` 结构化渲染

`comment-context.ts` 解析 body：

```ts
const decoded = decodeInteraction(comment.body)
if (decoded.ok && decoded.event.issueId === anchorId) {
  lines.push(renderInteractionXml(decoded.event, side))
  continue
}
```

- malformed：decode 返回 not-interaction，按普通 `<comment>` 文本渲染/注入，不抛；
- unsupported：输出 `<interaction status="invalid">` 警告，不投递 raw JSON；
- 普通评论：保持原样。

### 11.3 `task-context` 共用渲染

`task-context.ts` 的 `<comments>` 循环改为调用同一个 `renderInteractionXml`；否则首次执行 session 看到的是 raw JSON。

### 11.4 client UI

- `CommentBubble` / `dispatched.tsx` / task detail 用 `isControlComment` 判断；
- 控制评论渲染成一条本地化系统摘要，例如“交互请求 · 发布范围”“交互完成 · answered”，不显示 raw JSON；
- malformed：按普通评论文本展示，不显示特殊结构；
- unsupported：显示“不支持的交互事件”，不显示 raw JSON；
- 不改变普通评论的渲染。

### 11.5 `castboard_comment get`

- 过滤控制评论，避免模型看到 raw JSON；
- 新增的 `castboard_issue interactions` 负责结构化列表；
- `castboard_issue state` 增加 `interactions` 字段（不会被 `stripComments` 删掉）。

---

## 12. 设置

### 12.1 数据模型

```ts
export interface BoardSettings {
  // ...
  interactionReportEnabled: boolean
}

export const DEFAULT_SETTINGS: BoardSettings = {
  // ...
  interactionReportEnabled: true,
}
```

默认 `true`：功能面向 issue 协作，默认关闭会让 dispatcher 看不到交互。

### 12.2 解析/YAML

`src/host/rules.ts`：

```ts
if (source.interactionReportEnabled !== undefined) {
  if (typeof source.interactionReportEnabled !== 'boolean') {
    throw new Error('interactionReportEnabled must be a boolean')
  }
  settings.interactionReportEnabled = source.interactionReportEnabled
}
```

`src/host/ledger/settings-yaml.ts`：

- 加入 `FIELD_ORDER`；
- 加入 header 注释；
- 默认序列化时写出 `interactionReportEnabled: true`。

### 12.3 面板 UI

`src/client/features/preferences/dialog.tsx`：

- 在 comments 设置附近加 `Switch`；
- 加入 dirty 判定和 save payload；
- 中英文 locale 同步；
- 文案说明“只影响 task 执行会话的交互上报”。

### 12.4 行为

| 状态 | 行为 |
|---|---|
| 开启 | Coordinator 对 task 会话上报 requested/completed |
| 关闭 | 不再上报新交互；已上报的继续正常 completed |
| 重新开启 | 下一拍扫描当前 pending，未上报过的补 requested |

`commentsEnabled` 与 `interactionReportEnabled` 的关系：**待拍板**。建议 reporter 也受 `commentsEnabled` 约束，避免“request 写得出去、answer 回不来”的黑洞；如果产品希望解耦，则只在 UI 里提示。

---

## 13. 失败、安全与隐私

### 13.1 失败

| 失败 | 处理 |
|---|---|
| `refreshResult` 失败 / face 缺失 | Coordinator 整拍跳过，不发 completed |
| 评论发布失败 | publisher watermark 保留，下一拍重试 |
| bridge apply 失败 | 记录，next tick 重试；不阻塞 cursor |
| answer 过期/已答 | 返回 stale；不重复写 |
| 解析失败 | 当普通评论处理，不抛 |
| 事件乱序 | projection 暂存；终态优先 |
| 进程重启 | projection 重建；已上报未完成的补 `completed(expired)` |
| body 超长 | 编码层降级；仍超则抛错，不写半截 JSON |

### 13.2 权限

- 工具 answer 仅 issue assigner 会话（`sideOf === 'assigner'`）；
- bridge 必须匹配 `issueId + interactionId + sessionId + kind`；
- 不接受其他 issue 的 interactionId；
- 不接受 assignee 回答自己的交互；
- `both` / `observer` 拒绝。

### 13.3 信任模型

- 控制评论靠 `authorType === 'system'` + `role` + `schema` 判别；
- 云端 issue ACL 是唯一权限边界；
- 没有签名/HMAC：能写 issue 评论的人理论上能伪造 system 控制评论；
- 如果需要更强信任，再引入签名；第一阶段不做。

### 13.4 隐私

- approval 默认不传完整 `args`；
- 只传 `toolName/reason/callId/argsPreview`；
- `argsPreview` 截断并标记；
- question/option 文本做长度上限；
- 控制评论进入 issue 评论，受 issue ACL 保护；
- `displayReason` 不跨机，避免多语言 UI 字段膨胀。

### 13.5 不要做的事

- 不要把 `systemKey` 当跨机依据；
- 不要让 request/completed 用 `agent` 绕过语义；
- 不要让普通 system 评论可投递；
- 不要让工具直接调远端 `/magica`；
- 不要用评论正文承载完整工具 args；
- 不要在 body 里放 marker 再套 JSON。

---

## 14. 测试矩阵

### 14.1 协议

- `encodeInteraction` / `decodeInteraction` 往返；
- 普通 JSON 评论识别为 not-interaction；
- 未知 `schema` 识别为 unsupported；
- 坏 JSON 识别为 malformed；
- `issueId` / `kind` / `event` 形状校验；
- 超长 body 降级且仍可 decode；
- `interactionCommentId` 稳定：requested/completed 不含 payload，answered 含 canonical；
- 同一答案不同顺序生成同一 id。

### 14.2 投影

- requested -> pending；
- answered 先到、requested 后到；
- 重复 event；
- answered -> answered；
- completed/cancelled/expired；
- 乱序/迟到；
- 重启从评论重建；
- 只接受 system + 合法 schema。

### 14.3 Coordinator / Reporter

- 只报 task + issue + assignee session；
- 不报 router/portrait/无 issue task/子代理；
- 事件 `added` 唤醒后立即写 requested；
- 事件 `removed` 唤醒后立即写 completed；
- inbox `onIngested` 唤醒后立即 reconcile；
- 事件丢失时安全拍仍能补上；
- refresh 失败不产生 completed；
- 新 pending -> requested；
- 消失 -> completed；
- 写失败下一拍重试；
- 关闭开关不发新 request；
- 已上报后关闭继续正常 completed；
- 不重复 completed；
- 重启从 projection 补 expired。

### 14.4 投递

- 普通 system 评论仍跳过；
- requested/completed system 评论被投递；
- answered 不投递；
- 普通评论投递不变；
- `route` / `retryPending` 也放行；
- `coveredUntil` 不吞控制评论；
- `liveSession` 透传 form/summary。

### 14.5 应答

- 工具 approval/question；
- 多题/多选/自由文本；
- 非 assigner 拒绝；
- stale/already answered；
- 本地快路径 + bridge 幂等；
- answer 评论不投递给执行会话；
- full answers 透传给 spellbook。

### 14.6 双机模拟

- assignee pending -> requested 评论；
- dispatcher inbox -> 注入；
- dispatcher 工具 -> answer 评论；
- assignee inbox -> Coordinator.reconcile -> `InteractionService.answerRemote`；
- completed 评论 -> dispatcher 注入；
- 任一侧重启/断线后恢复。

### 14.7 回归

- 旧普通评论/系统评论行为；
- 任务状态机不变；
- issue 状态不变；
- 现有 291 个 castboard 测试全绿。

---

## 15. 分阶段实施

### P0：协议 + 投影 + 渲染

- `src/shared/interaction-protocol.ts`：类型、encode/decode、字段校验、size 降级；
- `src/host/exec/interaction-projection.ts`；
- `commentsXml` / `task-context` 共用 `renderInteractionXml`；
- 单测协议/投影/渲染。

验收：普通评论不变；交互评论结构化显示；坏协议不抛。

### P1：控制评论 + 投递窄口子

- `ThreadService.addControl`；
- `deliver` 三处过滤用 `isDeliverableInteraction`；
- `coveredUntil` 对控制评论绕过；
- 测试 request/completed 能进会话，其他 system 仍不进。

### P2：Coordinator + 设置

- spellbook `magica/interaction-changed` 事件（added/removed）；
- `refreshResult` / `answerRemote` / full answers / outcome；
- `InteractionCoordinator`（事件唤醒 + 安全拍）；
- inbox `onIngested` 唤醒；
- `interactionReportEnabled` 全链路（wire/rules/yaml/UI/locale）；
- 测试出现/完成/事件唤醒/安全拍/重启/开关。

### P3：Bridge + 完成

- `InteractionBridge.reconcile`；
- inbox `onIngested` 唤醒；
- completed 产生；
- 双机模拟。

### P4：工具 + UI

- `castboard_issue` `interactions` / `answer_interaction`；
- schema/validation/auth；
- tool 底层写 answer 评论；
- client 控制评论摘要；
- 单测。

### P5：收尾

- 文档；
- 观测事件；
- 真实双机验证；
- 回滚开关说明。

---

## 16. 待拍板

1. `interactionReportEnabled` 默认开还是关？建议 **开**。
2. `commentsEnabled=false` 时 reporter 是否也停？建议 **停**，避免只写不收。
3. 关闭开关时，已上报 pending 是继续正常 completed，还是发 `completed(reporting_disabled)`？建议 **继续正常 completed**。
4. 子代理会话的交互是否上报？当前按“不扩散”**不报**。
5. 多题回答是否必须全部作答？建议工具侧 **强制全答**。
6. `completed` 是否带答案摘要？建议 **不带**，答案由 `answered` 承载。
7. 面板/Native 应答是否写 `answered` 评论？工具一定写；面板建议写（如果 route 能解析 issue），Native 暂时观测不到。
8. `coveredUntil` 只给控制评论开白名单，还是改成 per-target-session？建议第一阶段白名单，后续再彻底修。
9. `requested.taskId` 是否保留？建议 **可选保留**。
10. `displayReason` 是否进协议？建议 **不进**。
11. 是否给 spellbook 增加 `magica/interaction-changed` 事件？建议 **加**；否则 Coordinator 只能继续 5s 盲轮询。

---

## 17. 关键代码索引

| 内容 | 文件 |
|---|---|
| 协议类型/编解码（新增） | `src/shared/interaction-protocol.ts` |
| 评论 id（新增） | `src/host/exec/interaction-id.ts` |
| 投影（新增） | `src/host/exec/interaction-projection.ts` |
| Coordinator（新增） | `src/host/exec/interaction-coordinator.ts` |
| Bridge（新增） | `src/host/exec/interaction-bridge.ts` |
| 投递判断（新增） | `src/host/pipeline/interaction-delivery.ts` |
| 当前 InteractionService | `src/host/exec/interactions.ts` |
| `/magica` 面板路由 | `src/host/http/routes/magica.ts` |
| `/state` interactions | `src/host/http/routes/state.ts` |
| interactionRecords | `src/host/http/routes/shared.ts` |
| addSystem / addControl | `src/host/pipeline/thread.ts` |
| deliver system 过滤 | `src/host/pipeline/deliver.ts` |
| inbox tick | `src/host/pipeline/inbox.ts` |
| cloud comment publish | `src/host/pipeline/sdk-face.ts` |
| commentsXml | `src/host/context/comment-context.ts` |
| task comments | `src/host/context/task-context.ts` |
| taskIdOfSession | `src/host/ledger/task-store.ts` |
| IssueLink | `src/host/ledger/link-types.ts` |
| BoardSettings | `src/shared/wire.ts` |
| 设置校验 | `src/host/rules.ts` |
| YAML 设置 | `src/host/ledger/settings-yaml.ts` |
| gateway capabilities | `src/host/tools/gateway.ts` |
| gateway schema | `src/host/tools/gateway-schema.ts` |
| issue state tool | `src/host/tools/issue-tools.ts` |
| issue comment tool | `src/host/tools/issue-comment.ts` |
| liveSession 接线 | `src/index.ts` |
| client 评论渲染 | `src/client/features/task/panels.tsx` / `issue/dispatched.tsx` |
| spellbook collect | `dsh-magica-spellbook/src/interactions/collect.ts` |
| spellbook 交互事件（新增） | `dsh-magica-spellbook/src/shared/interaction.ts` |
| spellbook 事件发射点 | `dsh-magica-spellbook/src/sessions/approval.ts` / `questions.ts` |
| inbox `onIngested` 唤醒 | `src/host/pipeline/inbox.ts` |
| Coordinator 事件订阅 | `src/index.ts` |
| spellbook answer | `dsh-magica-spellbook/src/sessions/approval.ts` / `questions.ts` |

---

## 18. 一句话评审结论

**用纯 JSON 控制评论做事件日志、source host 做唯一 authority、spellbook 的 added/removed 事件驱动 Coordinator、dispatcher 只读 projection 并用 answer 评论应答、deliver 只给 requested/completed 开窄口子。**
