# 03 · 待决交互设计（interactions host 面 + 会话页接管）

> 一级模块：**interactions**（4 文件 / 633 行）+ **client/interactions-panel**（9 文件 / 约 1 350 行）。
> 一句话问题：**谁吃掉了 dsh 的提问/审批请求，谁就有义务把它显示出来并结算。**
> 背景：正式会话门面用 `{ prepend: true, global: true }` 的 waterfall 监听把 `user-questions/request` / `approval/request` 提前认领并 `await` 挂住，**从不调 `next()`** → dsh 的 `api/remotes` 转发器收不到 → 浏览器里 `ui-user-questions` / `ui-approval` 的卡片**永远不会出现**，agent 的 turn 永久挂在 `await` 上。
> 而 dsh 那两个卡片组件**不是公开导出**（`QuestionComposer` / `ApprovalPanel` 都没 re-export），所以卡片只能**复刻**：DOM 照抄、CSS 照抄（改成字符串注入）、文案照抄。

---

## 0. 结构

```
host（Node）                                   浏览器
┌──────────────────────────────────────┐      ┌────────────────────────────────────────┐
│ sessions/approval.ts   pending 表     │      │  surface.ts                             │
│ sessions/questions.ts  pending 表     │      │   ① poll → transport.ts → fetch        │
│ interactions/collect.ts  合并+过滤+排序│◄────►│   ② publish(carrier) → uiSession 注册表│
│ interactions/ownership.ts 归属判定     │ HTTP │   ③ slots.inject('conversation.composer')│
│ interactions/route.ts  4 端点 + 闸门   │      │   ④ injectInteractionStyles(pluginId)   │
│ http-route.ts  createJsonRouter        │      │   ⑤ installInteractionRuntime({t,actions})│
└──────────────────────────────────────┘      │  Card.tsx / Composer.tsx / carrier.ts   │
                                               │  locales.ts / styles.ts / runtime.ts    │
                                               └────────────────────────────────────────┘
```

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/interactions/types.ts` | 139 | 线上契约（**零 import**，host/browser 共用） |
| `src/interactions/ownership.ts` | 91 | 归属判定 + 负缓存 + 自愈 |
| `src/interactions/collect.ts` | 88 | 合并两张待决表、过滤、排序、`args` 截断 |
| `src/interactions/route.ts` | 315 | 1×GET + 3×POST，请求体校验、错误码映射、跨站闸门 |
| `src/client/interactions/carrier.ts` | 98 | 浏览器侧载体类 + 认领标记 + 快照提取 |
| `src/client/interactions/Card.tsx` | 462 | 卡片（提问流 + 审批流） |
| `src/client/interactions/Composer.tsx` | 35 | `conversation.composer` 槽位组件 |
| `src/client/interactions/surface.ts` | 300 | 接管装配（轮询 → 发布 → 占位 → 样式 → runtime → 可逆销毁） |
| `src/client/interactions/transport.ts` | 94 | 同源 `fetch`，统一信封解包 |
| `src/client/interactions/styles.ts` | 149 | 56 条 CSS 字符串 + 幂等/引用计数注入 |
| `src/client/interactions/locales.ts` | 66 | `ix.*` 20 个 key 的 zh/en 字典 |
| `src/client/interactions/runtime.ts` | 46 | 模块级单例 `{t, actions}` |
| `src/client/interactions/index.ts` | 64 | 子入口汇总 |

---

## 1. 不变量（14 条，从 0.1.6 的客户端 + host 面各表合并）

| # | 不变量 | 落地 |
|---|---|---|
| I-1 | **谁吃掉请求谁结算**：认领者必须同时提供读（列表）与写（应答）两个方向 | `types.ts` 模块注释 + `route.ts` |
| I-2 | **归属唯一凭证是会话台账**：列表过滤与应答校验走**同一个**判定函数 | `collect.ts` 的 `owned` 与 `route.ts` 的 `allowSession` 都调 `isMagicaSession` |
| I-3 | **待决状态只在内存**：只有"本进程 + 该会话还活着"才答得上；进程重启后不可恢复 | `collect.ts` 注释 + `route.ts` 的 409 |
| I-4 | **结算幂等、失败可区分**：同一 id 第二次应答必然失败，且分成"已结算 / 会话没了 / 输入非法"三档 | `route.ts` 的 `settle()` |
| I-5 | **业务结果原样回传**：路由只做"字符串结果 → HTTP 信封"的映射 | 同上 |
| I-6 | **闸门先于匹配**：方法门 → 信任围栏 → 读体闸门 → 匹配 | `http-route.ts` 的 `createJsonRouter` |
| I-7 | **失败一律带稳定错误码**：所有响应是 `{ok:true,value}` / `{ok:false,error:{code,message}}` 二选一 | `types.ts` 的 `InteractionEnvelope` |
| I-8 | **负缓存只影响性能，不影响正确性**：判负结果可随时丢弃，门面写完台账后主动抹掉 | `ownership.ts` |
| I-9 | **载体靠标记字段认领，不靠 `instanceof`**：热重载后旧实例仍在注册表里也能正确判定 | `carrier.ts` 的 `INTERACTION_TAG` |
| I-10 | **一个会话最多发布一条载体**（等得最久的那条） | `surface.ts` 按 `sessionId` 去重 |
| I-11 | **槽位选择器只认带标记的载体，绝不抢 dsh 自己的卡片** | `surface.ts` 的 `select` |
| I-12 | **轮询间隔不得低于 5 s**；页面隐藏时不轮询；`dispose()` 之后不得再 publish | `Math.max(5_000, intervalMs)` + `isHidden()` + 双守卫 |
| I-13 | **应答成功当场摘卡**，不等下一拍 | `surface.ts` 的 `dropCarrier` |
| I-14 | **槽位组件的 `key` 必须按"这一次交互"区分**，否则多题卡片翻到第 3 题后换一条单题交互会整页卡死 | `Composer.tsx` 的显式 `key` |

---

## 2. 线上契约（`types.ts`，零 import）

```ts
interface InteractionOption { label: string; description?: string }

interface InteractionQuestion {
  id: string; question: string
  detail?: string; header?: string
  options?: InteractionOption[]
  multiSelect?: boolean
  intent?: { kind: string; approve: string; callId?: string }   // ★ 0.2：透传 plan-review
}

interface InteractionAnswerItem { id: string; selected: string[]; custom?: string }

type PendingInteractionRecord =
  | { kind: 'question'; id: string; sessionId: string; since: number; questions: InteractionQuestion[] }
  | { kind: 'approval'; id: string; sessionId: string; since: number; toolName: string
      callId?: string; reason?: string; args?: string; displayReason?: Record<string, string> }  // ★ 0.2

interface AnswerQuestionBody { sessionId: string; questionId: string; answers: InteractionAnswerItem[] }
interface CancelQuestionBody { sessionId: string; questionId: string }
interface AnswerApprovalBody { sessionId: string; approvalId: string; decision: 'allowed-once' | 'rejected' }

interface InteractionListValue   { items: PendingInteractionRecord[] }
interface InteractionAnswerValue { result: string }

type InteractionEnvelope<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

const INTERACTION_PREFIX = '/magica'
const INTERACTION_PATHS = {
  list: '/interactions',
  answerQuestion: '/interactions/question/answer',
  cancelQuestion: '/interactions/question/cancel',
  answerApproval: '/interactions/approval/answer',
} as const
```

**两处刻意偏离 dsh**：

| 偏离 | 理由 |
|---|---|
| `intent.kind` 从字面量联合 `'plan-review'` **放宽成 `string`** | 前向兼容：dsh 将来加 `intent` 分支时不至于让旧版 spellbook 编译失败 |
| `decision` 从四值**收窄成两值** | 另外两个值（`cancelled` / `unavailable`）**只能由服务端产生**，用户没有"撤回"和"无人可答"这两个动作 |

**`detail` / `intent` 的来源**：dsh 的 `ask_user_question` 工具**不转发** `detail` / `intent`，只有直接调 `ctx.userQuestions.ask()` 的调用方才填得进来。所以走工具路径时它们恒为 `undefined` —— 契约透传，但不要指望工具能带上。

---

## 3. host 面

### 3.1 归属判定（`ownership.ts`）

```ts
interface InteractionHostFace { get?(name: string): unknown }   // ★ 刻意不用 cordis Context

function isMagicaSession(host: InteractionHostFace, sessionId: string, storeDir?: string): boolean
function noteMagicaSession(sessionId: string, storeDir?: string): void
function resetMagicaSessionCache(): void
```

**为什么不用 `Context` 类型**：这个面是跨包调用的（spellbook 被打进消费插件的 bundle），每个插件的 `node_modules` 里可能各有一份 cordis，版本/实例不同 → 结构不兼容，传参直接类型报错。

判定算法：

```
key = `${storeDir ?? ''}\u0000${sessionId}`          // ★ 带 storeDir：同一 id 在不同台账目录下归属可能不同
foreign.has(key)        → false（0 次读盘）
getSessionRecord(...)   → 非 null ? true（不缓存正结果） : (超 1024 先清空) 记入负缓存 → false
```

| 决策 | 理由 |
|---|---|
| **正结果不缓存** | 台账可以被删，删掉后就该重新判负 |
| **负缓存上限 1024，超了整表清空** | 负缓存只省一次读盘，丢了不影响正确性；整表清空零额外簿记 |
| **自愈点 `noteMagicaSession`** | 门面写完台账后调用，抹掉"先被问一次（判负）→ 之后才建会话"的误判 |

⚠️ **已知副作用**：`getSessionRecord` 返回 `null` 有两种含义 —— "台账里确实没有"与"台账根本不可用"（无 `dshHomePath` 且未传 `storeDir`）。两者都被判负并写进缓存。

**本设计的修正**（对应 `02-sessions` §11 #10）：门面在 `ledgerWriteFailed` 时把该 `sessionId` 加入**进程内白名单**，`isMagicaSession` 先查白名单 —— 避免"台账写失败 → 该会话所有待决项永不可见 → 默认无超时 → 任务永久挂起"。

### 3.2 采集（`collect.ts`）

```ts
interface CollectInteractionOptions { sessionId?: string; storeDir?: string; maxArgsChars?: number }
function collectPendingInteractions(host: InteractionHostFace, options?: CollectInteractionOptions): PendingInteractionRecord[]
```

算法：两表并集 → 逐条 `isMagicaSession` 过滤 → 可选字段用**条件展开**（不写 `field: undefined`，保证 JSON 序列化后无 `"callId": null` 噪声）→ `args` 当场过 `clipArgs` → 按 `since` **升序** + `id` 用 `localeCompare` 兜底。

`clipArgs(args, max)`：`max === undefined || !(max > 0) || args.length <= max` → 原样返回；否则 `slice(0, max) + '…'`（**U+2026**）。
**注意**：截断后的 `args` **不再是合法 JSON**，卡片必须先 `JSON.parse` 再降级原文显示。

**为什么 `maxArgsChars` 默认不截断**：`args` 可能是整段工具入参（`bash` 的 command、`write` 的 content），而列表是**每 5 s 全量下发**的，多标签页轮询下大 payload 持续占带宽；但保持既有行为优先，减压阀由消费方开。

### 3.3 HTTP 面（`route.ts`）

```ts
interface InteractionHandlerOptions { prefix?: string; storeDir?: string; strictMutations?: boolean }
function interactionRoutes(ownerCtx: InteractionHostFace, options?): JsonRouterRoute[]
function createInteractionHandler(ownerCtx: InteractionHostFace, options?): (req, res) => Promise<void>
```

`createJsonRouter` 参数：`trust: 'browser'`、`maxBytes: 64 * 1024`、`onError: toFail`、`onNotFound: → 信封 404`、`prefix`（默认 `/magica`，**必须与 `webServer.register` 的 `path` 逐字一致**）。

四个端点：

| 方法 | 路径 | 请求体 | 成功值 |
|---|---|---|---|
| `GET` | `/interactions?sessionId=` | 无 | `{ items }` |
| `POST` | `/interactions/question/answer` | `AnswerQuestionBody` | `{ result: 'answered' }` |
| `POST` | `/interactions/question/cancel` | `CancelQuestionBody` | `{ result: 'cancelled' }` |
| `POST` | `/interactions/approval/answer` | `AnswerApprovalBody` | `{ result: 'answered' }` |

**handler 顺序铁律**：`requireString`（400）→ `allowSession`（403）→ `readAnswers` / `decision` 校验（400）→ `settle`（200 / 404 / 409 / 400）。
**字段校验排在归属校验之前**：坏请求拿 400 而不是 403，**不泄漏"这个 sessionId 是不是我们的"**。

`readAnswers` 校验阶梯：

| 条件 | 响应 |
|---|---|
| 不是数组 / 长度为 0 | 400 `answers must be a non-empty array` |
| 元素不是对象 / 是 `null` | 400 `each answer must be an object` |
| `id` 不是字符串或空 | 400 `each answer needs a question id` |
| `selected` 不是数组或含非字符串 | 400 `answer "<id>": selected must be string[]` |
| `custom` 不是字符串或 trim 后为空 | **不报错**，不带上该字段 |

`selected: []` **合法**（自由文本题的合法形态 `{ id, selected: [], custom: '…' }`）。

`settle()` 状态码映射：

| 业务返回 | HTTP | code |
|---|---|---|
| `answered` / `cancelled` | 200 | — |
| `not-found` | 404 | `not_found`（`this interaction is already settled, timed out, or its session ended`） |
| `session-gone` | 409 | `invalid_transition`（`the session holding this interaction is no longer answerable`） |
| 其他（如 `invalid-outcome`） | 400 | `invalid_input` |

**409 不是 404**：会话已不在接管表里是**状态冲突**（同一 id 重试永远不会成功）。

`allowSession` 失败 → 403 `forbidden` + `this interaction surface only serves sessions created through 旧实现`。它防的是"手搓的 POST"（同一 web 进程里任何页面都能发请求；围栏只管跨站）。

`strictMutations`（默认 `false`）：变更端点是否额外要求**严格同源**。默认信任 `browser` 档（拒自报跨站、带 Origin 必须同源、**放行不带 Origin 的请求** —— curl / 脚本 / 测试）。代价：本机任意脚本不带凭证就能批掉一次越权工具调用。浏览器的 POST 一定带 `Origin`，所以打开这个开关不破坏页面。

### 3.4 `list` 为什么不做归属闸门

`collect` 内部已逐条过滤。只有三个 POST 才需要 `allowSession`（因为要按 `sessionId` 从 `bridges` 里取 settle 句柄）。

---

## 4. 浏览器侧

### 4.1 载体（`carrier.ts`）

```ts
const INTERACTION_TAG = 'dsh-magica-spellbook/interaction'

class PendingInteractionCarrier {
  readonly tag = INTERACTION_TAG
  readonly key: string          // `${kind}:${id}`
  readonly kind: 'question' | 'approval'
  readonly sessionId: string
  readonly view: PendingInteractionRecord
  constructor(view: PendingInteractionRecord)
}

function isInteractionCarrier(value: unknown): value is PendingInteractionCarrier   // 判 tag 字段
function interactionRecords(snapshot: ReadonlyMap<string, unknown>): PendingInteractionRecord[]
```

**靠标记字段而非 `instanceof`**：热重载后旧实例仍在 `uiSession` 注册表里，类身份会失效，标记不会。

另外两个类型：

```ts
type InteractionResult = { ok: true } | { ok: false; error: string }
interface InteractionActions {
  answerQuestion(view, answers: InteractionAnswerItem[]): Promise<InteractionResult>
  cancelQuestion(view): Promise<InteractionResult>
  answerApproval(view, decision: 'allowed-once' | 'rejected'): Promise<InteractionResult>
}
```

### 4.2 传输（`transport.ts`）

```ts
interface InteractionTransport extends InteractionActions { list(): Promise<PendingInteractionRecord[]> }  // list 失败抛错
function createInteractionTransport(options?: { prefix?: string }): InteractionTransport
```

- 同源 `fetch`，`TIMEOUT_MS = 10_000`。
- 统一信封解包：`ok:false` → 抛带 code 的错误；`list()` 失败**抛错**（不折成 `InteractionResult`，因为它是读不是写）。
- 复用 `INTERACTION_PREFIX` / `INTERACTION_PATHS`，与 host 路由**同源**，路径不会两边各写一份而漂移。

### 4.3 接管装配（`surface.ts`）

```ts
const INTERACTION_POLL_MS = 5_000

interface InteractionScopeFace { get?(name: string): unknown; effect?(fn: () => unknown, label?: string): void; [key: string]: unknown }
interface InteractionSurfaceOptions { t: InteractionTranslate; pluginId: string; intervalMs?: number; prefix?: string; transport?: InteractionTransport }
interface InteractionSurface { refresh(): void; dispose(): void }
function createInteractionSurface(scope: InteractionScopeFace, options: InteractionSurfaceOptions): InteractionSurface | undefined
```

装配五步：

```
① pollOnce()      → transport.list() → publish(list)
② publish(list)   → 按 sessionId 去重（等得最久的那条）→ new PendingInteractionCarrier
                  → uiSession.registerPendingInteraction(precedence)(carrier, delegate)
                    precedence 恒 1；delegate = () => Promise.resolve()
③ slots.inject('conversation.composer', () => slots.register(
                    { name:'conversation.composer', select: owner => isInteractionCarrier(owner.pendingInteraction)
                        ? owner.pendingInteraction : null, locale:'magica-interaction', registrant:`${pluginId}:interactions` },
                    InteractionComposer))
④ injectInteractionStyles(pluginId)   → <style id="magica-ix-styles" data-plugin=pluginId>
⑤ installInteractionRuntime({ t, actions })
```

**降级**：

| 缺什么 | 行为 |
|---|---|
| `uiSession` 不可用 | `createInteractionSurface` 返回 **`undefined`**（调用方降级为"看板侧仍可用卡片"） |
| `slots` 不可用 | 跳过槽位注册，其余照常（但载体发布了没人认领，注册表里会积压到 `dispose`） |
| `locale` | **不取**。翻译函数由调用方以 `options.t` 传入，或消费方自己 `ctx.locale.bind(ns)` 后转交。槽位注册里的 `locale: 'magica-interaction'` 唯一作用是让渲染器为这个注册项派生 `t` 并在语言切换时重渲染（那个 `t` 未被消费） |

**轮询规则**：`Math.max(5_000, intervalMs)` 硬下限；`document.hidden` 时直接 return；`visibilitychange` 回前台立即补一拍；`dispose()` 之后**不得再 publish**（`publish` 里与 `await` 之后**双守卫**各防一种竞态）；应答成功**当场摘卡**（`dropCarrier`），不等下一拍。

### 4.4 卡片（`Card.tsx`）

```ts
interface InteractionCardProps {
  view: PendingInteractionRecord
  t: InteractionTranslate
  actions: InteractionActions
  variant?: 'takeover' | 'plain'
  onAnswered?: () => void
}
```

提问流（`Draft { selected: string[]; custom: string; skipped: boolean }`）：

- 多题逐题翻页；`answered(draft)` 决定"下一步/提交"是否可点；
- **`skip` 不是独立的裁决值**，而是 `{ id, selected: [] }` 的空选择（与 dsh `submitDrafts` 同口径）；单选填了自由文本 = `selected: []` + `custom`；
- 底栏按钮：`跳过本题`（`ix.skip`）/ 按状态取 `ix.next` · `ix.submit` · `ix.submitting`；
- 头部：最小化 / 展开、取消（`ix.cancel`）；多选勾 `ix.recommended` 徽标。

审批流：

- 顶部 warn 条（`state-warn-*`）+ 标题 + 命令本体（等宽 `--ds-font-family-code`，`word-break: break-all`）+ 详情（MarkdownText）；
- 按钮：`拒绝`（`ix.approval.reject`，hover 危险色）/ `允许一次`（`ix.approval.allow`）；
- **`ix.approval.escalation`**：`args` 里带 `sandbox_permissions` 单次升级时显示提示；
- `displayReason`（★ 0.2）：优先按当前语言取 `displayReason[locale]`，回退 `reason`。

**唯一复用的 dsh 渲染器**：`MarkdownText`（**`labels` 必填**：`{ code: { copyLabel, copiedLabel }, footnotes }`）。

### 4.5 槽位组件（`Composer.tsx`）

```tsx
export function InteractionComposer({ matched }: { matched: unknown }) {
  const view = matched as PendingInteractionRecord | undefined
  const runtime = interactionRuntime()
  if (view === undefined || runtime === undefined) return null
  return <InteractionCard key={`${view.kind}:${view.id}`} view={view} t={runtime.t} actions={runtime.actions} variant="takeover" />
}
```

**`key` 是承重墙**：dsh 的 chain 槽位按注册项做 key，不加这个显式 `key` 时，多题卡片翻到第 3 题后换成单题交互会**整页卡死**（React 复用实例 + 内部 state 停留在第 3 题）。

### 4.6 样式（`styles.ts`）

**为什么不能用 CSS Modules**（三条构建约束，缺一不可）：

1. 组件没导出，样式只能复刻 —— 复刻的 CSS 要能跟着**任意消费方**的 bundle 走；
2. `src/interactions` 由 `tsc` 直编，**没有 CSS 管线**：`tsc` 不认识 `import css from './x.module.css'`，会把 import 原样留在产物里 → 运行时必然 import 失败；
3. 消费方的打包链不保证有 CSS plugin。

所以：**56 条规则**（提问 47 + 审批 9）的字符串 + 统一 `magica-ix-` 前缀 + 幂等注入（固定 id `magica-ix-styles`）+ **引用计数** + 写 `data-plugin`（HMR 按它回收）。**不要在这段字符串里写注释**（无法被压缩器安全处理）。

**目录选择器可以用 CSS Modules**（见 04 文档），因为它的子入口直接映射 `.tsx` 源码，由消费方编译。这是**被迫的两种策略**，不要为了"复用几个 class"把两者耦起来。

### 4.7 i18n（`locales.ts` / `runtime.ts`）

```ts
const INTERACTION_LOCALE_NS = 'magica-interaction'
const zh: Record<InteractionKey, string>   // 20 个 key
const en: Record<InteractionKey, string>   // 与 zh 逐 key 对齐（satisfies 强制）
type InteractionTranslate = (key: InteractionKey, params?: Record<string, string>) => string

interface InteractionRuntime { t: InteractionTranslate; actions: InteractionActions }
function interactionRuntime(): InteractionRuntime | undefined
// installInteractionRuntime / releaseInteractionRuntime 刻意不从 index 导出
```

`installInteractionRuntime` / `releaseInteractionRuntime` **不外露**：模块级 runtime 的装配权只归 `surface.ts`（装 :1 处、摘 :1 处）；若对外暴露，第三方可绕过 `surface` 直接覆盖，而 `release` 的身份比对语义（只在 `current === candidate` 时清空）会被误用成"无条件清空"。

**0.2 的 `locale.register` 有两种重载**（✅ 已核）：`register(ns, locale, dict)` 与 `register(ns, { zh, en })`。本设计统一用对象形式，**两份字典键集必须一致**，且注册必须在 `ctx.effect` 的 disposer 里（同 `(ns, locale)` 重复注册会抛错）。

**两个已知坑**：

| 坑 | 现状 | 本设计 |
|---|---|---|
| 语言切换时已显示的报错不跟着变 | 报错在 `setError` 时就翻译成字符串 | 存 key，渲染时翻译 |
| 中文输入法回车上屏被当成"下一题" | 提问卡的自由文本 textarea **没有** IME 判断（目录选择器有） | 补 `isComposing \|\| keyCode === 229` |

---

## 5. dsh 侧契约（全部 ✅ 在 0.2 核对）

### 5.1 服务

| 服务 | 取用 | 用到的方法 | 失败语义 |
|---|---|---|---|
| `uiSession` | `serviceOf(scope,'uiSession')`（`get` 再退回属性，两条都 `try/catch`） | `registerPendingInteraction<T>(precedence: (i: T) => number): (i: T, delegate: () => Promise<void>) => () => void` | 缺失 → `createInteractionSurface` 返回 `undefined` |
| `slots` | 同上 | `inject(key, cb): () => void`、`register(options, component): () => void` | 缺失 → 跳过槽位注册 |
| `dshHomePath` | 经 `sessions/store` | 解析台账目录 | 缺失 → 归属全判负（见 §3.1 修正） |
| `webServer` | **消费方**注入并注册 | `register({ kind:'prefix', path, handler })` | 重复 `(kind,path)` 抛错 |

`registerPendingInteraction` 的真实行为（✅ 0.2 `packages/client/ui-session/src/client/index.ts:391-410`）：

- 每次调用**新建一个 domain**，用 `ctx.effect` 把 domain 的注册/释放挂到调用方 fiber 上；
- `publish` 对同 `key` 重复发布**抛错**（`ui-session: duplicate pending interaction key '<key>'`）；
- 所有 domain 的值按 `sessionId` 投影，`precedence` **大者胜**，同一会话只留一条；
- fiber 卸载 → 清空可见值 → `await Promise.allSettled(delegates)`。

**载体必须带 `key` / `kind` / `sessionId`**（`SessionPendingInteractionBase`），这就是 `carrier.key = kind:id` 的依据。

### 5.2 槽位

| 项 | 值 |
|---|---|
| key | `conversation.composer` |
| 声明 | `{ kind: 'chain', scope: 'session', owner: ComposerChainProps }`（✅ 0.2 `ui-conversation/src/client/contract/slots.ts:187`） |
| owner props | `{ sessionId, session, pendingInteraction }` |
| 选择器 | `(owner) => M \| null`，**必须纯函数**；chain 按 `priority` 升序尝试，第一个非 null 当选，结果成为组件的 `matched` |
| 渲染点 | `renderSlotChain('conversation.composer', owner, { fallback: inputBar, overlay: true })` |
| `overlay: true` 的意义 | fallback 常驻（election 时 `display:none` 隐藏而非卸载），**保住 composer 草稿** |

### 5.3 事件

本模块**不订阅任何 dsh 事件**。这是刻意的：待决状态活在 host 的调用栈上，而插件规则禁止 SSE 长连接 → 只能"前端短轮询 + 发布进 `uiSession` 注册表"。

用到的原生能力：`document.visibilitychange`、`AbortSignal`（`listDirectory` 第二参、`transport` 超时、`/cac/drives` 5s 超时）。

---

## 6. 0.2 适配

| # | 项 | 处置 |
|---|---|---|
| 1 | `AskUserQuestionRequestEvent.wait?: { callId, timed? }` | 透传进 `PendingInteractionRecord`（可选字段），卡片可显示"这条是限时提问" |
| 2 | `AskUserQuestionItem.intent` | 透传；卡片按 `intent.kind === 'plan-review'` 分流：正文走 `detail` 的 `MarkdownText`，按钮组换成"确认执行 / 拒绝 / 去聊天"，`approve` 命名的那个选项即批准 |
| 3 | `ApprovalRequestEvent.displayReason` | 透传（**不落持久字段**，dsh 明确它"never persisted in approval audit events"），卡片优先展示 |
| 4 | `SessionProjectionMap.userQuestions` | **可选读取**：`GET /interactions` 可附带"日志里存在但我们的内存表里没有"的 timed 提问作为"证据"（**不参与结算**）；默认关闭以免语义混乱 |
| 5 | `uiSession` / `slots` / `conversation.composer` | 契约未变 ✅ |
| 6 | `locale.register` 重载 | 用对象形式 ✅ |
| 7 | primitives | `Button` 新增 `toolbar` 变体（本模块不用）；`MarkdownText` 的 `labels` 仍必填 ✅ |
| 8 | `PLATFORM_MODULES` 多 `dockkit` | externals 从平台表派生，不硬编码 |

---

## 7. 失败模式（照抄 0.1.6 §9 的 18 条 + 本设计新增 4 条）

| # | 场景 | 表现 | 处理 | 残余风险 |
|---|---|---|---|---|
| 1 | 进程重启后点旧卡片 | 409 | 内存表空了 → `session-gone` | 消费方需**启动对账**把这些执行标失败 |
| 2 | 会话销毁但浏览器仍显示 | 409 | 注销时删 bridge | 最长 5 s 才发现 |
| 3 | 台账损坏 / 版本过新 | 该会话判"非 旧实现"，列表不出现，应答 403 | `parseOne` 记 `loadErrors` 返回 `null` | 判负进缓存 |
| 4 | 台账目录不可用 | **所有**会话判负 | `getSessionStore()` 返回 `null` | 本设计加进程内白名单兜底 |
| 5 | 同 id 双击 | 第二次 404 | `settle` 先出表 | 无（幂等失败） |
| 6 | 待决项从未被应答 | 永久挂着 | 默认无 timeout | 兜底只有 agent 生命周期；想加看门狗在门面传 `timeoutMs` |
| 7 | `args` 太大 | 每拍重复下载 | 可选 `maxArgsChars` | 默认不截断 |
| 8 | 跨站伪造 | 403 | `trust:'browser'` | 无 Origin 的本机脚本可调变更端点（`strictMutations` 可收） |
| 9 | 两个插件都想挂 `/magica` | 第二个 `register` 抛错 | `webServer` 重复检查 | composition 层协调，或换 `prefix` |
| 10 | handler 抛错且已写头 | 连接 destroy | `webserver` 兜底 | 已用 `try/catch` + `toFail` 收成信封 |
| 11 | 请求体 > 64 KiB | 413（有 `content-length`）/ 400（chunked） | `readMutationBody` | chunked 退化成 400（诚实但含糊） |
| 12 | `answers` 里 `selected: []` 且无 `custom` | 通过校验交回工具 | 只校验类型 | 卡片侧必须保证"空选择 + 空文本"不提交 |
| 13 | `intent` / `detail` 走工具路径 | 恒 `undefined` | dsh 工具不转发 | 不要指望工具能带 |
| 14 | `uiSession` 不可用 | 会话页没有卡片 | 返回 `undefined` | 看板侧仍可用；会话页**完全静默**（本设计加一条 `warn`） |
| 15 | 两个消费方同时装配 | 样式引用计数正确，但 runtime"最后装的赢" | 身份比对 | 语义上是"一页一个接管方" |
| 16 | 页面隐藏超一个周期 | 卡片更新暂停 | `isHidden()` | 后台标签页里 agent 提问会一直等到回前台 |
| 17 | `list` 网络抖动 | 保持上一份 | `catch` 空吞 | 宿主已结算时会显示到下次成功 |
| 18 | 同会话同时挂提问+审批 | 只显示等得最久的那条 | 按 `sessionId` 去重 | 第二条要等第一条结算（无队列提示） |
| 19 | **`plan-review` 意图** | 旧版走通用问答流：计划正文能看，但没有"确认执行/拒绝"三按钮 | 本设计补分流 | — |
| 20 | **IME 回车上屏** | 可能被当成"下一题" | 本设计补 `isComposing` 保护 | — |
| 21 | **语言切换时已显示的报错** | 不跟着变 | 本设计改为存 key 渲染时翻译 | — |
| 22 | **窄屏 / `prefers-reduced-motion`** | 卡片不缩放、动画不关闭 | 本设计补两个 `@media` 块 | — |

---

## 8. 装配（消费方视角）

### 8.1 host 半

```ts
export const inject = ['webServer']

export function apply(ctx: Context): void {
  ctx.inject(['webServer'], (webCtx) => {
    const handler = createInteractionHandler(webCtx, { strictMutations: true })
    webCtx.effect(() => webCtx.webServer.register({ kind: 'prefix', path: INTERACTION_PREFIX, handler }))
  })
}
```

### 8.2 client 半

```ts
export const inject = ['slots', 'uiSession', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(INTERACTION_LOCALE_NS, { zh, en }))
  const surface = createInteractionSurface(ctx, {
    t: ctx.locale.bind(INTERACTION_LOCALE_NS),
    pluginId: '@acme/dsh-panel',
  })
  ctx.effect(() => () => surface?.dispose())
}
```

### 8.3 `package.json`（消费方必须有的四段）

```jsonc
{
  "exports": { ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
               "./client": { "default": "./lib/client.js" },
               "./cordis.patch.yml": "./cordis.patch.yml",
               "./package.json": "./package.json" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
           "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-conversation"] } },
  "files": ["lib", "cordis.patch.yml", "README.md"]
}
```

**交互卡片路线不需要改组合**（不抢官方槽位，只往 `conversation.composer` 加一个带标记的载体，与官方卡片按 `select` 互斥共存）。这一点与目录选择器路线相反（后者必须先 `disabled` 官方 `ui-directory-picker-browse`）。

---

## 9. 验收契约（16 条）

1. `types.ts` 的 `import` 语句数 = 0。
2. `INTERACTION_PATHS` 四个路径与 `route.ts` 注册表逐字一致（同源断言）。
3. `collect` 只列台账里有的会话；两表并集按 `since` 升序、`id` 兜底。
4. `clipArgs` 三短路 + `…` 结尾。
5. `readAnswers` 五档校验各一条；`selected: []` 合法。
6. `settle` 五档映射（200/200/404/409/400）。
7. `strictMutations: true` 时无 Origin 的 POST → 403。
8. 字段错误先于归属错误（坏 body 得 400 不是 403）。
9. 同 id 重复应答 → 404；会话注销后应答 → 409。
10. `carrier.key === `${kind}:${id}``；`isInteractionCarrier` 对 `{tag: 'other'}` 返回 false。
11. `surface` 在 `uiSession` 缺失时返回 `undefined`。
12. 轮询间隔 `Math.max(5000, n)`；隐藏页不发请求；`dispose` 后不 publish。
13. 应答成功后载体**当场**从注册表摘掉。
14. `Composer` 的 `key` 随 `kind:id` 变化（换交互必须换实例）。
15. 样式注入引用计数：两个 surface 时第一个 `dispose` 不摘标签。
16. 两份 locale 字典键集一致（`satisfies` + 运行时断言）。
