# 02 · 会话运行内核设计（sessions）

> 一级模块：**sessions**。0.1.6 基线：`core.ts` 1469、`store.ts` 551、`workspace.ts` 903、`ephemeral.ts` 815、`questions.ts` 528、`approval.ts` 402、`ensure-workspace.ts` 208、`index.ts` 170 —— **8 文件 / 5 046 行（非空 3 772）**。
> 这是 spellbook 最核心、也最容易写错的模块。它解决三个真实问题：
> **① `whenIdle()` 不是成功信号**（结局只有 `turn/end` 的 `reason` 说了算）；
> **② `agents.create()` 不会自动挂 agent preset**（不挂 = 空全局层：无工具、无 prompt section、无 skill catalog）；
> **③ `agents.resume()` 需要的参数，会话日志里一个都没有**（title / workspaceId / agentPreset / provider-model 都只存在于调用方脑子里）。
> 一句话定位：**把 dsh 的 `agents` / `sessions` / `workspaceRegistry` 装配成"临时会话"与"正式会话"两个门面，并附带台账、续跑、审批/提问接管、workspace 登记四块基础设施。**

---

## 0. 结构

### 0.1 文件与依赖

```
index.ts ──► workspace.ts ──┬─► core.ts（运行内核）
        └──► ephemeral.ts ──┤    ├─ resolveAgents / runTurnVerified / installObservers
                            ├─► store.ts（台账）      ├─ applyPermission / resolvePermission
                            ├─► approval.ts ──────────┤  ├─ installContextDelivery
                            ├─► questions.ts ─────────┤  └─ composeAgentScope / resolveResumeTarget
                            └─► ensure-workspace.ts ──┘       / assertSessionNotLive / toResumeError
                                                             / manageWaterfallListener
```

| 边 | 性质 |
|---|---|
| `workspace/ephemeral` → `core` | 全部运行机制 |
| `workspace/ephemeral` → `store` | 台账读写 |
| `workspace` → `approval` / `questions` | 人工交互接管（`humanInteraction` 开启时） |
| `ephemeral` → `approval` / `questions` | **fail-fast** 版本 |
| `approval/questions` → `core` | `manageWaterfallListener` |
| `questions` → `event-log` | 提问的唯一留痕（`question.*`） |
| `workspace/ephemeral` → `interactions/ownership` | `noteMagicaSession`（负缓存自愈） |
| `core` → 同目录 | **零依赖**（除类型 `SessionRecord` / `ApprovalRecord`） |

**host/client 分界**：本模块 100% 在 host 侧执行；不 import 任何 `@deepseek-ai/dsh-client-*`、不注册 slot、不产出 CSS。它对 GUI 的影响全部通过**写会话日志 / 写 workspace 成员表**间接发生。

### 0.2 对外接口（`index.ts` 转出什么）

`index.ts` 是唯一再导出点，但**不是全部**。0.1.6 的口径：自有声明 **95 条** → 主入口可达 **49**、经 `./sessions` 子入口可达 **+34**、两入口都拿不到 **12**。

本设计把 0.1.6「本该对外却漏转出」的 7 个符号补齐（`SessionRunState`、`ObserverHooks`、`runTurnVerified`、`resolveAgents`、`resolveAgentPresetId`、`ApprovalAnswererOptions`、`QuestionAnswererOptions`），并把内部实现（`mintMessageId` 等）标注 `@internal`。

---

## 1. 门面契约

### 1.1 `runWorkspaceSession`

```ts
interface RunWorkspaceSessionOptions {
  sessionId?: string                        // 续跑目标；台账里没有 / kind 不符 → 新建并忽略
  newSessionId?: () => string               // 自定义 id 铸造器（受 SESSION_ID_SAFE 校验）
  workspaceId: string                       // attach 目标
  workspacePath: string                     // 必须等于 workspace canonical path
  prompt: string | string[]
  title?: string                            // 钉住标题
  contextPlugin?: string                    // 上下文署名，默认本包名
  context?: PluginContextEntry | readonly PluginContextEntry[]
  agentPresetId?: string | false            // false = 裸 agent；不传 = 挂默认
  setup?: AgentSetup
  model?: { provider: string; model: string }   // ⚠️ 不支持 reasoningEffort（与临时会话刻意不同）
  permission?: SessionPermission            // 'read-only' | 'workspace-write' | 'danger-full-access'
  humanInteraction?: HumanInteractionOptions // 不传 = 不接管（走 dsh 默认链路）
  onText?: (text: string) => void
  onTurnEnd?: (reason: TurnEndReason, turn: number) => void
  ttlMs?: number                            // per-turn TTL；<=0 / 不传 = 无上限
  idleTimeoutMs?: number                    // ★ 0.2 本设计新增：whenIdle 看门狗（见 §3.2）
  storeDir?: string
}

interface WorkspaceSessionHandle {
  id: string
  resumed: boolean
  firstTurn: Promise<TurnSettlement>                  // 永不 reject（见 §1.4）
  getState(): WorkspaceSessionState
  followup(message: string | string[]): Promise<TurnSettlement>
  injectContext(entries: PluginContextEntry | readonly PluginContextEntry[]): void   // ★ 0.1.6 只在 ephemeral 有
  cancel(cause?: AgentCancelCause): void
  dispose(): Promise<void>
  wake(): Promise<void>
}
```

### 1.2 `runEphemeralSession`

字段差异（其余同）：

| 字段 | 临时会话 | 正式会话 |
|---|---|---|
| 归属 | 未分组（不 attach） | attach 到 workspace |
| `cwd` | 调用方随意给 | 必须 = canonical path |
| `model.reasoningEffort` | **支持** | 不支持 |
| `title` | 无 | 有 |
| 沙箱选项 | `sandbox?: SandboxMode`，缺省固定 `'workspace-write'` | `permission?: SessionPermission`，缺省读全局默认 |
| 人工交互 | 固定 fail-fast | 可选接管 |
| `injectContext` | 有 | **本设计补上**（0.1.6 缺，是下游 `link` 模块的 K1 坑） |
| TTL 缺省 | 30 分钟 | 无上限 |
| `noInteraction` | 默认 `true`，注入「禁止向用户提问」插件上下文 | 无此字段 |
| 台账 `kind` | `'ephemeral'`，多写 `cwd` | `'workspace'`，多写 `workspaceId` / `workspacePath` / `title` |

**沙箱缺省值刻意不同**：临时会话是"跑完就丢、无人值守"，用固定沙箱才可预期（不随 GUI 全局设置漂移）；正式会话由用户在界面管理，跟随全局默认。

### 1.3 状态形状

```ts
type ResumeFailure = 'SESSION_LIVE' | 'SESSION_LOG_MISSING' | 'SESSION_SETUP_REQUIRED'

interface WorkspaceSessionState {
  running: boolean
  messages: string[]
  done: boolean
  error: string | null
  errorCode?: ResumeFailure
  turnEnds: TurnEndReason[]
  outcome?: TurnEndReason['kind']
  externallyDisposed: boolean
  disposed: boolean
  resumed: boolean
  attachError?: string
  workspaceAttached: boolean
  ledgerWriteFailed?: boolean
  pendingApprovals: PendingApproval[]
  pendingQuestions: PendingQuestion[]
}
```

`getState()` **每次现场拼**：`snapshotRunState(state)`（数组返回副本）+ 待决项从模块级表实时快照。待决项**不进 `state`**，避免两处状态不同步。

### 1.4 三条门面级铁律

| 铁律 | 内容 | 理由 |
|---|---|---|
| F-1 | **`firstTurn` 永不 reject** | `ensureFirstTurn = startFirstTurn().catch(() => lastSettlement(state))`。调用方靠 `getState().errorCode` 区分「在跑 / 日志没了 / setup 没重传」。"会话建不起来"本身就是一个可判读的结局 |
| F-2 | **`followup` 串行化，且前一个失败不传染** | `turnDone = myDone.then(() => undefined, () => undefined)` 吞错，下一个 `followup` 才能读到 `state.error` 并抛出可读错误 |
| F-3 | **`state.error` 是永久闸门** | 一旦非空，后续 `followup` 全部抛 `previous turn errored: <msg>`；想继续只能 `wake()`（它清 `state.error`） |

---

## 2. 台账（store）

### 2.1 路径与格式

```
<dshHomePath('storages','magica')>/sessions/<sessionId>.json
```

- `dshHomePath` 由 `@deepseek-ai/dsh-app-boot` 通过 `ctx.provide('dshHomePath', dshHomePath)` 提供（✅ 0.2 未变）。
- **不重新实现 `$DSH_HOME` 解析**：既没传 `storeDir` 又没有该服务时**抛错**并提示显式传：
  `session store needs ctx.dshHomePath (provided by @deepseek-ai/dsh-app-boot); pass \`storeDir\` explicitly when running outside a full dsh composition`
  但 `getSessionStore()` 把它收成 `null` → 门面降级（不续跑、不落记录）。
- 文件内容 = `JSON.stringify(record, null, 2) + '\n'`（2 空格缩进 + 末尾换行，测试断言）。
- `STORE_VERSION = 1`、`STORE_SUBDIR = 'sessions'`。

### 2.2 `SessionRecord`（13 个字段）

```ts
interface SessionRecord {
  version: number                 // 强制 = STORE_VERSION
  sessionId: string              // 同时是文件名（经 SAFE_ID）
  kind: 'ephemeral' | 'workspace'
  createdAt: number               // 首建定，续跑沿用
  updatedAt: number
  model?: { provider: string; model: string; reasoningEffort?: string }  // reasoningEffort 只有 ephemeral 写
  permission?: string             // 存预设名 / 沙箱模式名（两者取值相同）
  cwd?: string                    // 仅 ephemeral
  workspaceId?: string            // 仅 workspace
  workspacePath?: string          // 仅 workspace
  agentPresetId?: string          // mount 实际挂上的 id 优先
  title?: string                  // 仅 workspace
  customSetup?: boolean           // === true 才置位
}
```

**为什么这 13 个字段重要**：会话日志只记"模型看到的东西"，不记"谁用什么参数建起来的"。续跑需要的 `title` / `workspaceId` / `agentPresetId` / `provider-model` **只在这里**。

### 2.3 原子写与删除

```ts
// put()
const target = join(sessionsDir, fileName)
const tmp = `${target}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`
writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
renameSync(tmp, target)
this.records.set(stored.sessionId, stored)      // 先写盘成功，再更新缓存
```

| 操作 | 顺序 | 理由 |
|---|---|---|
| `put` | 盘先、缓存后 | 写失败时磁盘还是旧内容，内存保持旧值才对 |
| `remove` | **盘先、成功后删缓存** | 反过来 `rmSync` 失败（Windows 文件被占常态）会留「内存没了、磁盘还在」→ 本进程判"没记录"→ 续跑变新建（丢上下文）；重启后又从磁盘捞回来 |

- tmp 名带 `pid` + 时间戳：多进程并发写同一 id 不互踩 tmp。
- **并发写不加锁**：一会话一文件 → 没有共享索引的读-改-写竞态；同一记录"后写者胜 + 原子替换"，因为台账是**创建参数快照**而非累加账本。
- 目录只建一次（`dirReady` 标志）。

### 2.4 读路径：单文件直读，不扫目录

`get(sessionId)` = 直接读一个小文件。500 条记录时全量扫约 90 ms，直读亚毫秒级 —— 续跑分派（`resolveResumeTarget`）只走 `get()`。

错误码区分：**只有 `ENOENT` 等价于"台账里没有"**；`EACCES` / `EISDIR` / `EMFILE` / Windows 被占用 → **记进 `loadErrors`** 但同样返回 `null`（即仍会导致"静默新建"，只留诊断痕迹）。

### 2.5 损坏恢复

`parseOne` 是 `get()` 与 `ensureLoaded()` **共用**的解析入口，保证"直读"与"全量扫"对同一份坏数据判定一致：

| 失败 | `loadErrors` 里的 message（逐字） |
|---|---|
| JSON parse 抛错 | 原始 `err.message` |
| 缺 `sessionId` / `kind` 非法 | `not a session record (missing sessionId / kind)` |
| `version` 比本 build 新 | `record version N is newer than this build supports (1)` |
| `readFileSync` 非 ENOENT | `read failed (<code>): <message>` |

**版本只拒 `>`，`<` 一律接受**（字段缺省必须能容忍）。`recordError` 用 `errorPaths: Set` 去重（同一路径只报一次）。单文件损坏**不抛** —— 一个坏文件不该让整个看板瘫掉。

### 2.6 两个 id 正则（不同，别混）

| 正则 | 位置 | 字符集 | 长度 | 用途 |
|---|---|---|---|---|
| `SAFE_ID` | `store.ts` | `A-Za-z0-9._-` | 1–200 | `recordFileName`（读/写/删都过它） |
| `SESSION_ID_SAFE` | `core.ts` | `A-Za-z0-9_-`（**无点号**） | 1–100 | 只校验调用方自定义铸造器 |

原因：id 会拼进 `<sessionId>.json`，宽松接受等于交出"写任意路径"的能力。

失败文案：`session id "..." is not usable as a store file name (allowed: A-Z a-z 0-9 . _ -, length 1-200)`。

---

## 3. 内核（core）

### 3.1 结局判定：`turn/end` 是唯一真源

```ts
// ★ 0.2：7 个 kind（0.1.6 是 6 个）
export const TURN_END_KINDS = [
  'completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked',
] as const
```

**必须保留双向子类型断言**，让 dsh 增删 kind 时**编译报错**而不是静默漂移：

```ts
type _KindsMatchDsh =
  TurnEndReason['kind'] extends (typeof TURN_END_KINDS)[number]
    ? (typeof TURN_END_KINDS)[number] extends TurnEndReason['kind'] ? true : never
    : never
```

| kind | dsh 语义（✅ 0.2 `packages/core/session/src/types.ts:201-229`） | 算完成？ | `describeTurnEnd` |
|---|---|---|---|
| `completed` | 正常完成 | ✅ | `completed` |
| `aborted` | 取消打断；带 `reason: TurnEndCancelCause` | ❌ | `aborted (<cause.kind>)` |
| `blocked` | 阻塞（等审批/交互） | ❌ | `blocked` |
| `error` | 失败；`error: LlmFailure` | ❌ | `error: <message>`（缺 message 时 `unknown`） |
| `max-tokens` | 至少一个 step 撞输出上限 | ❌ | `output truncated (max-tokens)` |
| `interrupted` | 崩溃孤儿 turn 被后补关闭；**loop 从不live 发出** | ❌ | `interrupted (crash recovery)` |
| `forked` | **0.2 新增**：fork 播种时关闭源会话里仍开着的 turn | ❌ | `forked (fork seed)` |
| `undefined` | `whenIdle` 归来但没观察到新 `turn/end` | ❌ | `no turn/end observed` |

`describeTurnEnd` 的 `error` 分支必须做 `(reason.error as { message?: string }).message ?? 'unknown'` 收窄 —— 事件数据来自日志/外部，运行时可能畸形，描述函数本身不能抛。`default` 分支保留（带 `/* v8 ignore */`），防御未来 kind。

### 3.2 `runTurnVerified`（含 0.2 看门狗修正）

```ts
async function runTurnVerified(
  handle: AgentHandle,
  state: SessionRunState,
  message: UserMessage | undefined,
  alreadyDelivered = false,
  idleTimeoutMs?: number,
): Promise<TurnSettlement>
```

逐步：① 记基线 `turnEndCountBefore` / `msgCountBefore`；② `!alreadyDelivered && message` → `agent.followup(message)`；③ **看门狗**（仅 `idleTimeoutMs > 0`）：`Promise.race([whenIdle(), timeout])`，timer `unref()`；超时 → `cancel({ kind:'hook', reason:'magica:idle-timeout' }, { keepInbox: true })` 并返回 `{ kind:'aborted', completed:false, timedOut:true }`；④ 无看门狗 `await whenIdle()`；⑤ 取 `turnEnds.slice(before).at(-1)` 作为本轮 reason；⑥ 返回 `TurnSettlement`。

```ts
interface TurnSettlement {
  reason?: TurnEndReason
  kind?: TurnEndReason['kind']
  completed: boolean
  texts: string[]
  externallyDisposed: boolean
  timedOut?: boolean
}
```

**❗ 0.1.6 的两个缺陷，本设计必须修**：

| 缺陷 | 0.1.6 | 0.2 设计 |
|---|---|---|
| 看门狗是死代码 | `runTurnVerified` 支持 `idleTimeoutMs`，但**两个门面的 `runOneTurn` 都没传** → `whenIdle()` 不收敛时 `firstTurn`/`followup` 永久 pending | 门面**必须**传入（新选项 `idleTimeoutMs`，与 `ttlMs` 独立：TTL 管整轮墙钟，看门狗管"活动归零"不收敛） |
| 超时结算形状非法 | 超时路径直接 `{ kind:'aborted' } as TurnEndReason`（缺 `reason` 字段），消费方访问 `reason.reason.kind` 读到 `undefined` | 构造**完整**的 `{ kind:'aborted', reason:{ kind:'hook', reason:'magica:idle-timeout' } }`，不再用断言绕过 |

`whenIdle` reject 向上抛，不转成结算（这是"真错"而不是"结局"）。

### 3.3 观察者：`installObservers`

```ts
function installObservers(agentCtx: Context, sessionId: SessionId, state: SessionRunState, hooks?: ObserverHooks): () => void
```

- 内部 `openApprovals: Map<string, { toolName; callId?; reason?; since }>`。
- `safeHook(name, call)` 吞掉 5 个消费方钩子的异常，只写一条日志：`magica-sessions: observer hook threw`（钩子跑在 `agentCtx.on` 回调里，一抛就冒进 dsh 事件派发循环）。
- 主体 `agentCtx.on('session/event', ...)`：先 `if (session.id !== sessionId) return`（**纵深防御**，即使 scope 已过滤），再按 `event.type` 分派：

| 事件 | 处理 |
|---|---|
| `assistant/message` | `extractAssistantText` 抽纯文本 → push `messages` + `onText` |
| `turn/end` | push `turnEnds`、写 `outcome`、**清空 `openApprovals`**、`onTurnEnd` |
| `approval/asked` | 记入 `openApprovals` |
| `approval/decided` | 配对出表 → push `approvals`，`waitedMs = max(0, now - since)` |
| `approval/policy` | `state.approvalPolicy` |
| `sandbox/mode` | `state.sandboxMode` |
| `plan/mode` | `state.planMode` |
| `tool/call` | `onToolCall(callId, name, arguments)` |
| `tool/result` | `onToolResult(message.source.callId)` |

`turn/end` 时 `openApprovals.clear()` 的理由：审批对是 turn-enclosed 的，turn 结束时还挂着的必然悬空（append 抛错 / 崩溃尾巴），不清会一直占内存且永远等不到配对。

`agent/disposed` 单独注册，置 `state.externallyDisposed = true` + `onDisposed`。
两个 `agentCtx.on` **各自** `try/catch`：形状不符时降级（仍可用 `whenIdle` 拿"活动归零"，但拿不到结局原因）。
注销器幂等：`disposed` 闸门 → 逐个 `off()` → 清空数组。

`extractAssistantText`：只取 `type === 'text' && typeof text === 'string'` 的 block（过滤 reasoning / tool-call），**`join('')`**（不是 `join(' ')`）后 `trim()`；空/纯空白返回 `null`。

### 3.4 消息构造四件套

```ts
function mintMessageId(): MessageId           // 'magica-msg-<ts36>-<seq36>-<rand6>'
function mintSessionId(prefix: string): SessionId   // '<prefix>-<ts36>-<seq36>-<rand8>'
function buildUserMessage(text: string | string[]): UserMessage
function buildPluginMessage(plugin: string, text: string, section?: string): UserMessage
function toContextEntries(value: PluginContextEntry | readonly PluginContextEntry[] | undefined): Array<{ name?: string; text: string }>
```

**为什么本地 mint id 而不 import `MessageId()`**：dsh 的品牌函数运行时是 no-op，本地断言可保持"构建产物零运行时 `@deepseek-ai/*` 导入"（P2）。唯一性靠 `messageSeq` 单调递增（200 次调用不重复是验收契约）。

`buildUserMessage`：

```ts
{ id, role: 'user', content: string[] 归一成 [{ type:'text', text }], source: { kind:'user' } }
```

`buildPluginMessage` 两分支（`section` 名会变成**用户可见的来源标签**）：

```ts
// 无名
source = { kind: 'plugin', plugin }
// 具名
source = { kind: section, plugin, form: 'snapshot', sections: [{ name: section, text }] }
```

**为什么用 `section` 当 `source.kind`**：GUI 的上下文行 label 只取 `source.kind` —— `kind:'plugin'` 显示插件包名，其余 kind 显示 kind 本身。具名 section 让 GUI 显示 `lattice-rules` 而不是 `@amazing-tools/dsh-magica`。`plugin` 字段两条分支都保留（它表达"谁注入的"）。

`toContextEntries` 归一规则：`undefined` → `[]`；数组归一成列表；非空字符串 → `{ text }`；对象且 `text` 非空 → `{ name?, text }`（`name` 非空才带）；其余（空串 / `null` / 非对象 / `text` 非字符串）**静默丢弃**。

### 3.5 上下文投递：`installContextDelivery`

```ts
interface ContextDeliveryHandle { push(entries: readonly UserMessage[]): void; dispose(): void }

function installContextDelivery(agentCtx: Context, contexts: UserMessage[]): ContextDeliveryHandle
```

```ts
let pending = [...contexts]
const listener = async (_payload, next) => {
  const decision = await next()
  if (pending.length === 0) return decision
  if (decision.kind === 'reject') return decision          // 空批次继续等下一个 step
  const batch = pending; pending = []
  return { ...decision, messages: [...decision.messages, ...batch] }   // ★ 追加到末尾
}
const off = agentCtx.on('agent/pre-step', listener, { prepend: true })
```

| 决策 | 理由 |
|---|---|
| 不用 `agent.inject()` | `inject` 排进 `next-step` 队列，而 turn 的第一个 step 边界**先排空 `next-step`、再从 `next-turn` 取 1 条** → 上下文必然排在用户消息**前面**，规则占住会话开头 |
| `{ prepend: true }`（**不需要 `global`**） | 注册在 `setup(agentCtx)` 的 agent scope 上，天然只收本 agent。最外层监听在 `next()` 返回**之后**才追加，于是排在其他所有监听（技能目录、运行时上下文）产出**之后**，即模型请求的最后 |
| 追加到 `decision.messages` **末尾** | 比 dsh 官方 `agent-instructions`（splice 在最后一条 claimed 消息之后）更靠后，正是"紧跟 skill-catalog"的需求 |
| 投递后**不自我注销** | 常驻会话要能反复 `push()`；空转时只是一次 `pending.length === 0` 直接返回 |
| 返回值用**展开**而非重建 | 0.2 的 `enter` 分支新增 `startsRequestSeries?: true`，展开才能保留 |

边界：只在第一个**进入**（`kind:'enter'`）的 step 追加一次；被 `reject` 的那步不算数，上下文继续等下一个 step。

### 3.6 权限：`resolvePermission` + `applyPermission`

```ts
const DEFAULT_PERMISSION_PRESET = 'workspace-write'

function resolvePermission(ctx: Context, explicit?: string): string   // 三级回退
function applyPermission(ctx: Context, session: Session, name: string): 'preset' | 'sandbox' | 'none'
```

`resolvePermission`：① 调用方显式传入（非空串）；② `permissionPresets.defaultPreset`（它自己已处理"用户在看板里选的默认"与"无 settings 时的 composition 默认"，包 `try/catch`）；③ `'workspace-write'`。

`applyPermission` 三态：

| 返回 | 含义 |
|---|---|
| `'preset'` | 走了 `permissionPresets.set()`，`permission/preset` + `sandbox/mode` + `approval/policy` 三个 knob 都写了 |
| `'sandbox'` | 只 `session.append('sandbox/mode', { mode })` |
| `'none'` | 两条路都失败 |

**`'read-only'` 为什么走降级**：dsh 默认预设表只有两项（`workspace-write` / `danger-full-access`），`'read-only'` 是合法 `SandboxMode` 但**不是预设名**，`set()` 抛 `permission: unknown preset "read-only" (known: ...)` → 降级为直接 append `sandbox/mode`，**只改沙箱不动 approval policy**（`read-only` 下 policy 保持 `ask`，越界仍发审批，比 `never` 拒死更保守）。

`'none'` **必须由门面喊出来**（`warnLedgerWriteFailure`）：两条路都没写进去 → 会话按 composition 默认沙箱跑，可能比要求更宽松。

### 3.7 `manageWaterfallListener`（生命周期收口）

```ts
function manageWaterfallListener(
  ctx: Context,
  label: string,
  register: () => () => void,   // 回调而非事件名：保留 dsh 的 Events augmentation 类型检查
  onUninstall?: () => void,
): () => void
```

流程：① `try { off = register() } catch` → 无事件总线时**不接管**，调 `onUninstall`，返回 noop；② `uninstall`：幂等闸门 → `off()` → `onUninstall()` → **收回 `ctx.effect` 的 disposer**；③ `effectDisposer = ctx.effect(() => uninstall, label)`（包 `try/catch`，fiber 可能已 inactive）。

**第 ③ 步为什么必须自己收回**：`ctx.effect` 把回调登记进 fiber 的 disposables，**只有调用它返回的 disposer 才摘掉那条记录**。0.1.6 旧实现丢了返回值 —— 监听确实被 `off()` 摘掉（功能正确），但登记记录留到插件卸载（每会话 1 条 + 每次交互接管 2 条，长驻进程线性增长）。

### 3.8 续跑三件套

```ts
type ResumeFailure = 'SESSION_LIVE' | 'SESSION_LOG_MISSING' | 'SESSION_SETUP_REQUIRED'

class SessionResumeError extends Error {
  constructor(readonly code: ResumeFailure, message: string, options?: { cause?: unknown })
  name = 'SessionResumeError'
}

interface ResumeTarget { resumed: boolean; sessionId: SessionId; record?: SessionRecord }

function resolveResumeTarget(
  store: SessionRecordStore | null,
  requestedId: string | undefined,
  mintPrefix: string,
  expectedKind?: 'ephemeral' | 'workspace',
  mintNew?: () => string,
): ResumeTarget
```

分派表：

| 条件 | 结果 |
|---|---|
| `store === null`（台账不可用） | 新建 |
| `requestedId` 空 | 新建 |
| `store.get(requestedId) === null` | **新建（忽略传入 id）** |
| `expectedKind` 给了且 `record.kind !== expectedKind` | **新建（绝不改写别人的记录）** |
| 其余 | 续跑，带 `record` |

**为什么"台账无记录就新建并忽略 id"是刻意的**：台账里没有说明这个 id 不是我们建的（或记录被删了）。拿它去 `agents.create()` 会被持久化层拒绝 —— `session "<meta.id>" already has a persisted log on disk; load/resume it instead of creating`。

**为什么 `expectedKind` 是唯一闸门**：把正式会话 id 传给 `runEphemeralSession` 会 resume 那个会话再用 `ephemeral` kind 覆盖记录，把 `workspaceId` / `workspacePath` / `title` 全丢掉。

`assertSessionNotLive(agents, sessionId)`：`agents.get(id) !== undefined` 判活层（`get` 抛错时按"不活着"处理，让 `resume` 报真错）。提前查是为了给可读错误，而不是让调用方去猜 `session "<id>" already exists`。

`toResumeError(err, sessionId)`：
- 已是 `SessionResumeError` → 原样；
- 按 message 正则 `/not found|SESSION_QUERY_SESSION_NOT_FOUND|no such session|ENOENT/i` → `SESSION_LOG_MISSING`；
- 其余原样返回（**不伪装成"日志缺失"**，免得掩盖真实故障）。

⚠️ **这是本模块唯一靠字符串匹配的地方**。本设计要求：优先用结构化错误（`error.code` / `instanceof`），正则只作兜底并记一条诊断日志。

### 3.9 `composeAgentScope`

```ts
async function composeAgentScope(options: {
  ctx: Context; agentCtx: Context; sessionId: SessionId
  state: SessionRunState; hooks: ObserverHooks
  presetId?: string | false; userSetup?: AgentSetup
}): Promise<{ unsubscribe: () => void; commit?: AgentSetupCommit; presetId?: string }>
```

**固定顺序**：① `installObservers` → ② `agentPresets.mount` → ③ `userSetup`。监听必须最早，否则 preset 挂载期间产生的会话事件会漏。

- `presetId` 三态：`false` = 连默认都不挂（裸 agent）；`undefined` = 挂默认（`mount` 不传 id）；字符串 = 指定。
- `userSetup` 返回值**运行时形状兜底**：`typeof commit.commit !== 'function'` → 抛（错误信息点明"返回裸函数会让 dsh 的 `setupCommit?.commit()` 抛 is not a function"）。什么都不用 commit 就返回 `undefined`（**不要返回空函数**）。
- 任何一步抛错 → `try { unsubscribe() } catch {}` 再 rethrow（否则监听漏在已回滚的 scope 上）。
- `resolveAgentPresetId(ctx, requested)`：`requested` 非空原样返回；否则 `presets.resolve()`（不传参 = `defaultId`）拿**具体 id**，失败返回 `undefined`（让 `mount()` 在 setup 里报真错）。存在理由：`meta.agentPreset` 是**创建参数**，而 `mount()` 只在 setup 里才跑得到。

**`AgentPresetMountService` 是手写最小结构面**（`mount` / `resolve?`），让 `@deepseek-ai/dsh-agent-presets` 保持**可选 peer**。

---

## 4. 正式门面（workspace）

### 4.1 首轮十步（`startFirstTurn`）

```
① resolveAgents(ctx)                                             → 抛可读错误
② handle = resumed ? resumeAgent : createAgent
③ if (disposed) → dispose handle; return emptySettlement()
④ installInteractionHandlers()                                   ★ 必须在首轮之前
⑤ await attachToWorkspace()
⑥ if (!resumed || options.permission !== undefined) applyPermission(...)
⑦ if (options.title) sessionTitle.rename(session, title)
⑧ writeRecord()
⑨ settlement = await runOneTurn(buildUserMessage(options.prompt))
⑩ if (!disposed) { running = false; done = true }
```

- **句柄返回前首轮已启动**（`firstTurn` 是 `ensureFirstTurn()` 的 promise），所以句柄一返回会话就在跑。
- **④ 必须在 ⑨ 之前**，否则第一个审批就会漏接。
- ⑥：权限是会话日志里的 fold，resume 重放即恢复，**不传就不动**。
- ⑦：`sessionTitle.rename` 同步，包 `try/catch`（cosmetic）。用户来源的 rename 会 `supersede` 自动标题生成（✅ 0.2 语义未变）。
- ⑧ 之后调 `noteMagicaSession(String(sessionId))` 抹掉归属负缓存。

### 4.2 `makeSetup`（新建与续跑共用）

```ts
function makeSetup(): AgentSetup {
  return async (agentCtx: Context) => {
    const composition = await composeAgentScope({ ... })        // ① 内核装配
    unsubscribe = composition.unsubscribe
    mountedPresetId = composition.presetId
    if (!reattached) delivery = installContextDelivery(agentCtx, resumed ? [] : contexts)  // ② 上下文
    return composition.commit
  }
}
```

| 要点 | 理由 |
|---|---|
| 新建与续跑**共用** | `dispose()` 会把 agent scope 整个拆掉，两条路都必须重新装配 |
| `onToolCall` / `onToolResult` 钩子**只在传了 `humanInteraction` 时**才挂 | 否则 `toolCallArgs` 永远空、白占内存 |
| 参数截断 `MAX_APPROVAL_ARGS_CHARS = 2000` + `…` | `write` 的整个 `content` 可能上兆；存的是**未解析的 JSON 字符串**，截断后 `JSON.parse` 会抛，卡片必须容错 |
| 续跑带**空**初始批次 | 初始上下文已在会话日志里，再塞一次会造成日志堆重复行 |
| 但监听**仍要挂** | 常驻会话要能再 `push()` |
| `reattached` 区分"首轮续跑"与"dispose 后 wake" | 后者同样不该重投 |

### 4.3 `createAgent` / `resumeAgent`（✅ 0.2 签名已核）

```ts
if (presetId !== false) presetId = await resolveAgentPresetId(ctx, presetId)
return agents.create({
  sessionId,
  meta: { cwd: options.workspacePath, ...(typeof presetId === 'string' ? { agentPreset: presetId } : {}) },
  ...(model !== undefined ? { agentOptions: { provider: model.provider, model: model.model } } : {}),
  setup: makeSetup(),
})
```

`resumeAgent` 三步：① `assertSessionNotLive`；② `record?.customSetup === true && options.setup === undefined` → `SESSION_SETUP_REQUIRED`（文案：`` `<id>` was created with a custom setup; pass the same `setup` again to resume (closures cannot be stored in the ledger) ``）；③ `agents.resume({ resumeSessionId, agentOptions?, setup: makeSetup() })`，异常经 `toResumeError` 归一。

⚠️ 0.2 的 `AgentSetup` 是**两参**（`(agentCtx, agent)`），旧的一参写法仍类型兼容（少写参数是合法的），但实现应显式声明两参以免将来用到 `agent`。

### 4.4 `attachToWorkspace` 与 `attachError`

```ts
const registry = getWorkspaceRegistry(ctx)
if (registry === undefined) { attachError = 'workspaceRegistry service unavailable'; return }
const workspace = registry.get(asWorkspaceId(options.workspaceId))
if (workspace === undefined) { attachError = `workspace "..." not found in registry`; return }
try { await workspace.attachSession(asSessionId(String(sessionId))); workspaceAttached = true }
catch (err) { attachError = errorMessage(err) }
```

- ✅ 0.2 未变：`registry.get(id)` 拿 `Workspace`，**registry 本身没有 attach 方法**，attach 在 entity 上。
- **失败不抛**：attach 只影响"是否出现在 GUI 列表"，不该让任务跑不起来。
- **`cwd` 必须严格等于 workspace canonical path**：`attachSession` 会读会话头 `header.cwd`、`realpathNormalize` 后与 `record.path` 严格比对，不等就抛 `its cwd resolves to '<path>'`。`cwd` 是会话头的**不可变**字段。
- **推论**：隔离后的会话（worktree / 软链）**无法挂到原 workspace**，要为它单独建 workspace。
- 续跑/唤醒时 attach **幂等**（已在 `sessionIds` 里则跳过校验，只做成员表合并）。

### 4.5 `writeRecord` 字段优先级

| 字段 | 优先级 |
|---|---|
| `createdAt` | `record?.createdAt ?? Date.now()` |
| `model` | 本次 `options.model ?? record?.model` |
| `permission` | `options.permission` > `record.permission` |
| `workspaceId` / `workspacePath` | 本次必填 |
| `agentPresetId` | `mountedPresetId` > `presetId`（字符串时） |
| `title` | `options.title` > `record.title` |
| `customSetup` | `options.setup !== undefined` |

失败：`state.ledgerWriteFailed = true` + `warnLedgerWriteFailure`。
**为什么这条重要**：台账是交互面判定归属的**唯一**凭证；写不进去意味着该会话的审批/提问**不会出现在看板**，而它们默认没有超时 —— 一次写盘失败会被放大成"任务永久挂起"。

### 4.6 `dispose` / `wake` 的竞态

`dispose` 的顺序（不可换）：

```
置 disposed → stopTimer → 拆交互接管（先把挂着的审批/提问全部结算，否则 turn 永远卡着）
→ toolCallArgs.clear() → unsubscribe() → delivery.dispose() → state.running/done
→ await handle.dispose() → releaseRunState(state)（最后）
```

`dispose` 自身的并发：`if (disposed) { if (disposing) await disposing; return }`，`disposing = runDispose()`，`finally` 清空 —— 保证两次并发 `dispose()` 都等到真正落地。

`wake()` 四步（每步都防一个具体竞态）：

```ts
if (!disposed) return                                    // 幂等
if (disposing !== undefined) await disposing              // ① 等上一次释放真正落地
const agents = resolveAgents(ctx)
reattached = true                                        // ② 必须在 resume 之前置位
disposed = false                                         // ③ 先解开闸门
try { revived = await resumeAgent(agents) } catch (err) { disposed = true; throw err }
if (disposed) { try { await revived.dispose() } catch {}; return }   // ④ resume 期间被并发释放
handle = revived; state.disposed = false; state.done = false; state.error = null
installInteractionHandlers(); await attachToWorkspace(); writeRecord()
```

| # | 竞态 | 不这么写的后果 |
|---|---|---|
| ① | `handle.dispose()` 慢，与 `resume` 撞 | dsh 报"会话仍在活层"（`SESSION_LIVE`）白失败一次 |
| ② | preset 的 `setup` 在 `resume` 内部跑 | 它读这个标志决定要不要重投首轮上下文 |
| ③ | resume 期间并发来一次 `dispose()` | 事后无法分辨"刚唤醒又被放了"，会漏收新 handle |
| ④ | 唤醒后 `followup` 的永久闸门 | 必须复位，否则永远抛 `previous turn errored` |

`wake` **不重投**首轮上下文。

### 4.7 `runOneTurn` 与 TTL

```ts
async function runOneTurn(message: UserMessage): Promise<TurnSettlement> {
  if (disposed || handle === null) throw new Error('session disposed or agent not ready')
  startTimer()
  try {
    handle.agent.followup(message)
    return await runTurnVerified(handle, state, undefined, true, idleTimeoutMs)   // ★ 传看门狗
  } finally { stopTimer() }
}
```

TTL（`startTimer`）：`ttlMs === undefined || !(ttlMs > 0)` → 直接返回 —— **不传 / 传 0 / 传负数都是"不设上限"**。超时写 `state.error = '会话超时（<N> 分钟未完成）'` 并 `void dispose()`。**TTL 是 per-turn 的**（`runOneTurn` 里起、`finally` 停，轮与轮之间不计时）。

---

## 5. 临时门面（ephemeral）

### 5.1 与正式门面的结构对应

| 能力 | workspace | ephemeral | 差异 |
|---|---|---|---|
| 台账写入 | 同 | 同 | ephemeral 多写 `cwd`，且**续跑时沿用台账原值**（旧实现无条件写 `options.cwd` / `sandbox`，导致 `danger-full-access` 建的会话续跑一次被改成 `workspace-write`；`cwd` 传 `undefined` 时字段被 `JSON.stringify` 丢掉） |
| 交互接管 | 可选 | 固定 fail-fast | — |
| 权限 | `permission`，缺省读全局 | `sandbox`，缺省固定 `workspace-write` | 见 §1.2 |
| attach / 标题 | 有 | 无 | — |
| `injectContext` | 本设计补上 | 有 | 0.1.6 只有临时会话有 → 下游 `link` 的 K1 |
| 兜底结算 | `lastSettlement` / `emptySettlement` | 逐字重复的两份 | **本设计要求合并到 `core`** |

### 5.2 `noInteraction` 的注入形态

```
NO_INTERACTION_PREFIX = '禁止向用户提问，直接完成/回答。'
```

**不是**拼进 user 消息，而是 `contexts.push(buildPluginMessage(contextPlugin, NO_INTERACTION_PREFIX))` —— 一条 `source.kind = 'plugin'` 的**插件规则**（"插件说的"，不是"用户说的"）。**刻意无名**（不传 `section`）：GUI 行显示来源插件署名。顺序：调用方 `context` 全部在前，这条最后。

### 5.3 fail-fast 接管（临时会话必须装）

```ts
installFailFastAnswerer(ctx, sessionId)              // 审批：恒返回 'unavailable'
installFailFastQuestionAnswerer(ctx, sessionId)      // 提问：恒 reject NO_PROVIDER
```

**为什么必须有**：dsh web 的 remote 桥会把请求塞进缓冲等浏览器回答，而 `RemoteEventQueue.push()` **只在队列结束时**才返回 `false`（与"有没有浏览器连着"无关）。所以"什么都不做"在 web profile 下 = 请求永远挂着；临时会话的 TTL 会先到期，真正的错误（越界操作）被掩盖成"临时会话超时"。

**它不是"自动批准"**：审批恒 `'unavailable'`（一个都不批），提问恒 `NO_PROVIDER`（"没人能回答"），与 dsh 在没有 remote 桥时的默认行为一致。

### 5.4 `injectContext`（常驻会话的关键能力）

```ts
injectContext(entries) { delivery?.push(toMessages(entries)) }
```

可反复调用，每批只投一次；已 `dispose()` 时 `delivery === undefined` → **静默无效**（⚠️ 0.1.6 无直接断言，本设计要求至少返回 `boolean` 表示"是否真的投进去了"）。

---

## 6. 审批接管（approval）

### 6.1 pending 表

```ts
const bridges = new Map<string, Bridge>()          // 模块级，sessionId → bridge
interface Bridge { sessionId: string; pending: Map<string, PendingEntry> }   // key = randomUUID()
interface PendingEntry extends PendingApproval { settle: (outcome: ApprovalOutcome) => void }
interface PendingApproval { id: string; toolName: string; callId?: string; reason?: string; args?: string; since: number }

const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const
```

**为什么是模块级 Map 而不是挂在 handle 上**：看板是 HTTP 服务，处理"用户点击"的那个请求里**没有 handle**，只有从任务库里取的 `sessionId`。代价是模块级状态必须有明确回收点（由 `ctx.effect` 兜底）。

`APPROVAL_OUTCOMES` 带与 `TURN_END_KINDS` 同款的**双向子类型断言**（dsh 增删取值即编译报错）。

### 6.2 认领

```ts
const WATERFALL_TAKEOVER = { prepend: true, global: true } as const   // ★ 单点常量

ctx.on('approval/request', (request, next) => {
  if (uninstalled) return next()
  if (request.agent.session.id !== sessionId) return next()
  return hold(request)
}, WATERFALL_TAKEOVER)
```

| 选项 | 缺了会怎样 |
|---|---|
| `prepend: true` | 排在 dsh web 的 remote 桥（`packages/api/remotes/src/index.ts` 的 `ctx.on`，**无 prepend**）后面 → 桥 hold 住请求等浏览器 → 看板永远看不到（**静默失效**） |
| `global: true` | `approval/request` 是 agent-scoped waterfall，监听注册在**插件级 ctx** 上，作用域过滤会排除它（**静默失效**） |
| `uninstalled` 闸门 | 注销后仍可能收到派发（注销与派发异步），此时应 `next()` 交还而不是继续 hold |
| 只接管自己的会话 | 转交 `next()`，用户在 GUI 里自己开的会话照常弹它自己的卡片 |

### 6.3 `hold` 的结算

```
id = randomUUID(); since = Date.now(); signal = request.signal
args = resolveArgs?.(callId)          // 按 callId 从 tool/call 关联出的原始 JSON，包 try/catch

① if (signal?.aborted === true) return Promise.resolve('cancelled')    ★ 必须先查
② new Promise(resolve => {
     settle(outcome): done 闸门 → clearTimeout → removeEventListener → pending.delete(id) → resolve
     onAbort = () => settle('cancelled')
     timeoutMs !== undefined → setTimeout(...).unref?.()
     signal?.addEventListener('abort', onAbort, { once: true })
     pending.set(id, { ...entry, settle })
   })
```

**① 为什么必须先查 `signal.aborted`**：已经 abort 的 `AbortSignal` **不会**再触发 `addEventListener` 的 `abort` 事件，不查就会挂一个永不结算的 Promise。

**`args` 的来源**：`ApprovalRequestEvent` 只带 `callId` 不带参数（✅ 0.2 也一样，另外多了 `displayReason`），所以要自己在 `tool/call` 时记、`tool/result` 时丢，审批到来时按 `callId` 反查。

### 6.4 超时与取消

- `ApprovalAnswererOptions.timeoutMs` **默认 `undefined` = 不超时**（与 dsh 一致：`ApprovalService.decide()` 整个函数没有任何计时器，唯一让等待结束的是 `signal` 的 abort）。
- 兜底来自 **agent 生命周期**：`ctx.effect` 会 `handle.dispose()`，agent 销毁时 dsh 会 abort 工具调用的 signal → `onAbort` 结算。
- ⚠️ 不要把兜底归给 `AgentFactory.createAgent` 的 `ownerCtx`：`AgentRegistry.create()` 传的是**注册表自己的** fiber，不是插件的。插件卸载能回收 agent 靠的是我们自己的 effect。

注销器：

```ts
() => {
  for (const entry of [...pending.values()]) entry.settle('cancelled')
  if (bridges.get(sessionId) === bridge) bridges.delete(sessionId)   // ★ 只删自己那条
}
```

重复 `install`（同 `sessionId`）**先结算旧的**：否则那些 `settle` 函数从此无人持有，对应 `await` 永不结束，turn 永久卡死。

### 6.5 查询与应答

```ts
function listPendingApprovals(sessionId?: string): Array<PendingApproval & { sessionId: string }>   // since 升序
function snapshotPendingApprovals(sessionId: string): PendingApproval[]
function answerApproval(sessionId: string, approvalId: string, outcome: string): ApprovalAnswerResult
type ApprovalAnswerResult = 'answered' | 'invalid-outcome' | 'not-found' | 'session-gone'
```

`answerApproval` 的顺序：outcome 不在闭集 → `'invalid-outcome'`（**不结算**）；无 bridge → `'session-gone'`；无 entry → `'not-found'`；否则 `settle` → `'answered'`。

**为什么非法 outcome 必须明确拒绝**：dsh 会把非法值 normalize 成 `'unavailable'` 不崩，但那样看板会以为"用户的选择生效了"。

`toPending` 剥掉 `settle` —— **`settle` 绝不可外泄**。

---

## 7. 提问接管（questions）

### 7.1 与审批的三个关键差异

| # | 差异 | 后果 |
|---|---|---|
| Q-1 | **失败一律 reject**（审批是 resolve 闭集） | 照审批写法 resolve `{ answers: [] }` 会被 `ask_user_question` 当**正常答案**返回，模型以为"用户答了但什么都没选" |
| Q-2 | `request.agent` **可选** | `agent === undefined` 时 dsh 走全局派发，我们认不出会话 → 只能 `next()` |
| Q-3 | 提问**没有** `approval/asked` 那样的审计事件 | 只能自己记 `eventLog`（0.2 新增 `userQuestions` 投影，但仍不含"我们的 answerer 拒了它"这类事实） |

### 7.2 数据结构

```ts
interface PendingEntry {
  id: string; questions: AskUserQuestionItem[]; since: number
  settleAnswer(answer: AskUserQuestionAnswer): void   // resolve
  settleCancel(): void                                 // reject ASK_CANCELLED
  settleAbort(): void                                  // reject ASK_ABORTED
}
type QuestionAnswerResult = 'answered' | 'cancelled' | 'not-found' | 'session-gone'   // 无 'invalid-outcome'
type QuestionErrorCode = 'ASK_ABORTED' | 'ASK_CANCELLED' | 'NO_PROVIDER'
```

`settle(finish, event)` 统一收口：幂等闸门 → 清 timer → `removeEventListener` → `pending.delete` → 写日志（带 `waitedMs`）→ `finish()`。

### 7.3 错误构造（鸭式，不 import 运行时类）

```ts
function questionError(message: string, code: QuestionErrorCode): Error {
  const error = new Error(message) as Error & { code: string }
  error.name = 'UserQuestionError'
  error.code = code
  return error
}
```

dsh 服务端 `restoreUserQuestionError` 按 `name` + `code` 认回来（检查 `name === 'UserQuestionError'`、`message`/`code` 都是 string）。这样既保持"零运行时 dsh 导入"，又让错误跨边界可识别。

### 7.4 日志（引用计数）

```ts
let sharedLogger: EventLogger | null = null
let loggerOverride: EventLogger | null = null
let activeAnswerers = 0   // 只统计提问 answerer
```

`eventLog()` 懒创建（`loggerOverride ?? (sharedLogger ??= createEventLogger('dsh-magica'))`）；`withLoggerRef(uninstall)` 安装 +1 / 注销 -1，归零则 `disposeInteractionLogger()`。理由：`createEventLogger` 构造时就起一个 5s flush interval（已 `unref`），按"副作用必须可逆"仍要有归属回收点。

事件名：`question.asked`（入口，含 `questions[].id/question/options[].label/multiSelect/intent.kind`）、`question.aborted`、`question.answered`、`question.cancelled`、`question.fail-fast`。`logInteraction` 包 `try/catch`（日志不该影响主流程）。

### 7.5 `toPending` 必须逐项浅拷

```ts
{ id, questions: entry.questions.map(item => ({ ...item })), since }
```

只拷数组的话元素对象仍与挂住的请求共享，调用方改 `questions[0].question` 会直接影响 dsh 侧的请求对象。

---

## 8. workspace 登记（ensure-workspace）

```ts
async function ensureWorkspace(ctx, projectPath, options?: { title?: string; attachSessionId?: string }): Promise<Workspace | undefined>
async function findWorkspace(ctx, projectPath): Promise<Workspace | undefined>
async function createWorkspace(ctx, projectPath, title?): Promise<Workspace>
function getWorkspaceRegistry(ctx): WorkspaceRegistry | undefined
function normalizeProjectPath(input: string): string
```

`ensureWorkspace` 四步：① registry 缺失 → `undefined`；② `resolveByPath(normalized)` 命中 → 返回已有；③ 未命中 → `registry.create(normalized, title)`（dsh 内部 realpath + stat 验证）；④ 传了 `attachSessionId` → `workspace.attachSession(...)`。

**降级 vs 抛错的刻意不对称**：`ensureWorkspace` / `findWorkspace` 缺 registry 静默返回 `undefined`（软降级）；`createWorkspace` 缺 registry **抛错**（硬失败，文案 `createWorkspace: ctx.workspaceRegistry is not available (headless/test deployment without dsh-workspace package)`）。三个 API 都对空串 `throw Error`。

`normalizeProjectPath`（纯字符串、无 I/O）：

```
'' → ''
normalize(input)                                   // 混合分隔符、..、冗余分隔符
while 尾部分隔符 && 不是盘符根（/^[A-Za-z]:$/）→ 剥
```

**为什么不自己做 realpath**：dsh 的 `create()` / `resolveByPath()` 内部都调 `realpathNormalize`。本层只做纯字符串归一，把物理归一留给 dsh 的唯一 canon（避免两套 canon 分歧）。

`getWorkspaceRegistry` **不做形状校验**（与 `resolveAgents` 不同）—— 这是 0.1.6 的现状，本设计要求补上（见 §12 R-5）。

---

## 9. 协议与数据形状（逐字）

### 9.1 台账 JSON

```json
{
  "version": 1,
  "sessionId": "magica-ws-m8x2k1-a3f9",
  "kind": "workspace",
  "createdAt": 1762900000000,
  "updatedAt": 1762900100000,
  "model": { "provider": "deepseek", "model": "deepseek-v4" },
  "permission": "workspace-write",
  "workspaceId": "41d3cebe-…",
  "workspacePath": "D:\\tmp\\dsh-lattice-issue",
  "agentPresetId": "general",
  "title": "修登录超时",
  "customSetup": true
}
```

`STORE_VERSION` 迁移语义：`< 1`（或缺失）接受；`=== 1` 接受；`> 1` **拒绝**（记 `loadErrors` 并跳过该条）。

改结构的正确姿势：`STORE_VERSION + 1`，**同时**在 `asRecord` / `copyString` 字段链加新字段。只改一边 → "新记录被旧 build 拒掉"或"老记录字段静默丢失"。

### 9.2 消息对象字面量

```ts
buildUserMessage('干活')
// { id:'magica-msg-…', role:'user', content:[{type:'text',text:'干活'}], source:{kind:'user'} }

buildPluginMessage('@x/y', '规则', 'lattice-rules')
// { id:'magica-msg-…', role:'user', content:[{type:'text',text:'规则'}],
//   source:{ kind:'lattice-rules', plugin:'@x/y', form:'snapshot', sections:[{name:'lattice-rules',text:'规则'}] } }
```

**最终模型请求次序**（`installContextDelivery` 在首个 enter 的 step 末尾追加）：

```
[用户 prompt] → [工作区指令] → [运行时上下文] → [技能目录] → [调用方 context…] → [NO_INTERACTION_PREFIX]
```

### 9.3 `bridges` 两张表

**审批**

```
bridges: Map<sessionId, { sessionId, pending: Map<approvalId, PendingApproval & { settle }> }>
出口：answerApproval → settle(outcome) | timeoutMs → settle('cancelled') | signal abort → onAbort
     | 注销器 / 重复 install → 全量 settle('cancelled')
```

**提问**

```
bridges: Map<sessionId, { sessionId, pending: Map<questionId, PendingEntry> }>
出口：answerQuestion → settleAnswer(resolve) | cancelQuestion → settleCancel(reject ASK_CANCELLED)
     | 超时 / abort / 注销 / 重复 install → settleAbort(reject ASK_ABORTED)
```

---

## 10. 运行期文案（逐字，18 + 补充）

| # | 文案 | 场景 |
|---|---|---|
| 1 | `session helper requires ctx.agents — declare inject: ["agents"] in the referencing plugin` | `resolveAgents` 硬依赖校验 |
| 2 | `magica-sessions: observer hook threw` | 观察者钩子抛错（吞掉后记录） |
| 3 | `(use the handle that owns it, or dispose it before resuming)` | 与 `already exists` 拼接 |
| 4 | `` setup 的返回值必须是 `{ commit(): void }` 对象或 undefined； `` | setup 返回值形状 |
| 5 | `ensureWorkspace: projectPath must not be empty` / `findWorkspace: …` / `createWorkspace: …` | 空串校验 |
| 6 | `createWorkspace: ctx.workspaceRegistry is not available (headless/test deployment without dsh-workspace package)` | registry 缺失 |
| 7 | `session disposed or agent not ready` | `runOneTurn` 前置 |
| 8 | `` pass the same `setup` again to resume (closures cannot be stored in the ledger) `` | `SESSION_SETUP_REQUIRED` |
| 9 | `ask_user_question was aborted before the user answered` | 提问 abort |
| 10 | `the user cancelled ask_user_question` | 提问 cancel |
| 11 | `no user-questions answerer accepted the request (this session does not accept human input)` | fail-fast `NO_PROVIDER` |
| 12 | `(allowed: A-Z a-z 0-9 . _ -, length 1-200)` | 文件名字符集 |
| 13 | `session store needs ctx.dshHomePath (provided by @deepseek-ai/dsh-app-boot); pass \`storeDir\` explicitly when running outside a full dsh composition` | 台账目录解析失败 |
| 14 | `session disposed` / `agent handle not created yet` / `previous turn errored: <msg>` | 门面闸门 |
| 15 | `会话超时（<N> 分钟未完成）` / `临时会话超时（<N> 分钟未完成）` | TTL（⚠️ 0.1.6 两处文档不一致，实现时统一为后者） |
| 16 | `workspaceRegistry service unavailable` / `workspace "<id>" not found in registry` / `its cwd resolves to '<path>'` | attach |
| 17 | `no turn/end observed` / `output truncated (max-tokens)` / `interrupted (crash recovery)` / `forked (fork seed)` / `aborted (<cause>)` / `error: <message或 unknown>` | `describeTurnEnd` |
| 18 | `magica:approval(<sid>)` / `magica:questions(<sid>)` / `magica:sessions/workspace` / `magica:sessions/ephemeral` | effect / waterfall label |
| 19 | `magica:cancel` / `magica:idle-timeout` | cancel cause reason |

---

## 11. 0.1.6 → 0.2 的行为变更清单（本设计主动改的 12 处）

| # | 项 | 0.1.6 | 本设计 | 影响面 |
|---|---|---|---|---|
| 1 | `TURN_END_KINDS` | 6 值 | **7 值**（加 `forked`） | 常量、`describeTurnEnd`、验收断言 |
| 2 | 看门狗 | 能力存在但门面没传 | **门面必须传 `idleTimeoutMs`** | 新选项 + 新测试 |
| 3 | 超时结算形状 | `{ kind:'aborted' } as TurnEndReason` | **完整 `{ kind:'aborted', reason:{kind:'hook',reason:'magica:idle-timeout'} }`** | 消费方可以安全穷尽 switch |
| 4 | `injectContext` | 只有临时会话 | **两个门面都有** | 下游 `link` 可直接用 |
| 5 | `lastSettlement` / `emptySettlement` | 两文件逐字重复 | **合并到 `core`** | 去重 |
| 6 | 漏转出的 7 个符号 | 不可达 | 全部经主入口/`./sessions` 可达 | 导出面 |
| 7 | `toResumeError` | 纯 message 正则 | **结构化 code 优先，正则兜底 + 记日志** | 抗 dsh 文案变更 |
| 8 | `getWorkspaceRegistry` | 无形状校验 | 补校验（不满足返回 `undefined`） | 与 `resolveAgents` 一致 |
| 9 | `agentPresets` 缺失 | 静默降级 | **降级 + warn + `state.presetApplied = false`** | 可观测 |
| 10 | `ledgerWriteFailed` | 只置标志 | **同时把该会话加入交互面的"进程内白名单"**（见 03 文档 §3.2） | 避免"审批永不可见" |
| 11 | 提问留痕 | 自建 eventLog | 保留 + **可选读取 0.2 的 `userQuestions` 投影做展示** | 崩溃后可举证 |
| 12 | `plan-review` 意图 | 无分流 | **透传 `intent` 并在卡片分流**（见 03/04 文档） | 新功能 |

---

## 12. 验收契约（从 0.1.6 的 264 条里提炼的 24 条硬约束）

| # | 契约 | 断言 |
|---|---|---|
| 1 | `TURN_END_KINDS` | `deepEqual` 整数组（**顺序也锁**） |
| 2 | `isTurnCompleted` | 只有 `completed` 为真；`undefined` 为假 |
| 3 | `describeTurnEnd` | 7 种 kind 各一条精确串 + `undefined` 一条 |
| 4 | `buildPluginMessage` 无名 | `source` 深等于 `{ kind:'plugin', plugin }`（无多余键） |
| 5 | `buildPluginMessage` 具名 | `source = { kind:section, plugin, form:'snapshot', sections:[{name,text}] }` |
| 6 | `buildUserMessage` | `source` 深等于 `{ kind:'user' }`；`string[]` → 多 block |
| 7 | `mintMessageId` | 200 次不重复 |
| 8 | `emptyRunState` | `running === true`、`done === false`、`error === null` |
| 9 | `snapshotRunState` | 可选字段**缺席**（`'outcome' in snap === false`） |
| 10 | `releaseRunState` | `messages` / `turnEnds` / `approvals` 就地清空；`outcome`/`error` 保留 |
| 11 | `errorMessage` | `Error`→message、`'plain'`→自身、`42`→`'42'`、`undefined`→`'undefined'` |
| 12 | `resolveAgents` | 5 种畸形输入全抛且 message 匹配 `/ctx\.agents/`；**不接受 `ctx.agents` 属性访问** |
| 13 | `installObservers` 文本提取 | 多 block `join('')`；纯空白过滤 |
| 14 | `installObservers` 过滤 | 只取 `{type:'text'}`，`reasoning` / `tool-call` 丢弃 |
| 15 | `store.put` 原子写 | 文件 2 空格缩进 + 末尾 `\n`；tmp+rename |
| 16 | `store.get` | 只有 ENOENT 不记 `loadErrors` |
| 17 | `store` 版本 | `> STORE_VERSION` 跳过并记错误；`<` 接受 |
| 18 | `resolveResumeTarget` | 无记录 / kind 不符 → 新建且忽略 id |
| 19 | `assertSessionNotLive` | 活层存在 → `SESSION_LIVE` |
| 20 | `applyPermission` | 三态返回；`'read-only'` 降级 `'sandbox'` |
| 21 | `resolvePermission` | 三级回退；`defaultPreset` 抛错时落地 composition 默认 |
| 22 | `composeAgentScope` | 顺序：观察者 → preset → setup；setup 抛错时 `unsubscribe` 被调 |
| 23 | 审批重复 install | 旧 bridge 全部 `'cancelled'` |
| 24 | 提问重复 install / `cancelQuestion` | 旧 bridge 全部 reject `ASK_ABORTED` / `ASK_CANCELLED`（**不是 resolve 空答案**） |

**必须补测的 3 条**（0.1.6 完全没测）：看门狗超时、`warnLedgerWriteFailure` 三级降级、`injectContext` 在 dispose 后的行为。

---

## 13. 风险与遗留

| # | 风险 | 缓解 |
|---|---|---|
| R-1 | `whenIdle()` 不收敛（审批挂着、工具不返回） | 看门狗（§3.2）+ `ttlMs` 双保险 |
| R-2 | `agents` 服务缺失 | 抛可读错误；`firstTurn` 收敛成 `completed:false` + `errorCode` |
| R-3 | `agentPresets` 缺失 → 空全局层 | 降级 + warn + `state.presetApplied` |
| R-4 | 台账不可用 | `getSessionStore()` 返回 `null`，门面**降级但不崩**；`ledgerWriteFailed` 强告警 |
| R-5 | `attachSession` cwd 不匹配 | `attachError` 上报；文档写明"隔离会话要单独建 workspace" |
| R-6 | `toResumeError` 靠文案 | 结构化 code 优先（§11 #7） |
| R-7 | 模块级 `bridges` 无 reset | 提供 `resetInteractionBridges()`（测试/诊断），并在文档里写明 dispose 契约 |
| R-8 | `firstTurn` 吞异常 | 文档显式写明"必须读 `getState().errorCode`" |
| R-9 | 0.2 `forked` 未处理 | 常量表 7 值 + 双向断言（编译期兜住） |
| R-10 | 0.2 `wait.timed` / 投影与自建 pending 表双源 | 文档明说：投影**只用于展示**，结算只走 pending 表 |
