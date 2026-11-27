# 05 · 会话运行内核（k/l/m 三片）一致性核对 —— sessions-b

> 只读核对：**未修改任何源码、未运行任何测试**。所有判定都落在具体文件行号上。
> 核对对象：`.e2e/audit/G5-sessions-2.md`（需求清单）× `src/sessions/*.ts`、`src/interactions/*.ts`、`src/client/panel/*.ts` × `tests/**/*.test.ts`。
> 有意差异白名单：`docs/design/00-overview.zh.md` §3.8 / §3.9 / §5（以下称"白名单"）。

## 0. 输入事实与编号口径（先读这一节，否则数字对不上）

**① 输入文件被截断。** `G5-sessions-2.md` 实测只有 **209 行**，内容为 `K-001 … K-177`，末尾是一行 `<!--PART2-->` 占位符：

```
$ (Get-Content .e2e/audit/G5-sessions-2.md).Count   → 209
$ 匹配 '^| K-' 的行                                  → 177
$ 匹配 '^| L-' / '^| M-' 的行                        → 0 / 0
$ 最后一行                                           → <!--PART2-->
```

也就是说 **L 组与 M 组的表格从未落到这个文件里**。为了不让"测试契约覆盖"这一最关键产出缺位，本文档按被引用的原始素材**原地重建** L / M 编号（与 k.md→K 的抽取规则一致：一素材行 = 一条契约 = 一个 ID）：

| 组 | 来源 | 编号映射 | 条数 |
|---|---|---|---|
| K | `G5-sessions-2.md` 原文 | `K-001 … K-177`（原样保留） | 177 |
| L | `docs/raw/l.md` §9 表格（`:5-40`，一 row 一条） | `L-001 … L-036`（自上而下） | 36 |
| M | `docs/raw/m.md` §13.2–§13.10 | `M-001 … M-274`，分段见下表 | 274 |
| M 分段 | §13.2 core 38 → `M-001…M-038`；§13.3 store 45 → `M-039…M-083`；§13.4 resume 26 → `M-084…M-109`；§13.5 approval 42 → `M-110…M-151`；§13.6 questions 32 → `M-152…M-183`；§13.7 ephemeral 29 → `M-184…M-212`；§13.8 workspace 25 → `M-213…M-237`；§13.9 无断言风险面 10 → `M-238…M-247`；§13.10 ensure-workspace 27 → `M-248…M-274` | — | 274 |

**② 状态语义**（五档，白名单外的一律不许"顺手放过"）：

| 标记 | 含义 |
|---|---|
| ✅ | 实现满足契约原文 |
| ✅有意差异 | 实现与契约原文**不同或更强**，且差异被白名单 §3.8 / §3.9 / §5 明确登记 |
| ⚠️ | 实现满足意图但形态/计数/文案偏离，或只覆盖了契约的一部分（M 组还表示"有断言但缺要点"） |
| ❌ | 未实现 / 无对应断言 |
| M 组专用 | ✅ 已覆盖、⚠️ 部分覆盖（缺的要点写在差异列）、❌ 完全未覆盖 |

**③ 三处命中率极高的"版本差"**（后面大量行会引用）：

- dsh 类型**全部换成手写结构面** `src/shared/dsh.ts`（213 行，`:6-10` 说明理由）→ 契约里所有"`import type` 某个 dsh 符号"的条目都变成"结构面等价";
- 主入口改用 `export * from './sessions/index.ts'`（`src/index.ts:64`），**没有** `./sessions` 子入口（`package.json:11-16`）→ 所有依赖"子入口/主入口可达性"的计数契约失效；
- 门面把 `idleTimeoutMs` **真正传进了** `runTurnVerified`（`workspace.ts:359`、`ephemeral.ts:308`）→ l.md 里"能力存在但未启用"的旧结论已过期。

---

## 1. 统计

**① 逐条判定分布（合计 487 条 = K 177 + L 36 + M 274）**

| 组 | ✅ | ✅有意差异 | ⚠️ | ❌ | 小计 |
|---|---|---|---|---|---|
| K（dsh 组件与 slot 用法） | 138 | 4 | 25 | 10 | **177** |
| L（边界 / 失败模式 / 已知限制） | 31 | 0 | 5 | 0 | **36** |
| M（测试契约覆盖，见 §3） | 52 | 2 | 44 | 176 | **274** |
| **合计** | **221** | **6** | **74** | **186** | **487** |

**② 白名单（✅有意差异 6 条）逐条溯源**

| ID | 差异 | 白名单出处 |
|---|---|---|
| K-043 | 插件上下文缺省 `source.kind` 从 `'plugin'` 改为 `'spellbook-context'` | §5#25 |
| K-104 | `source` 不再是 `{kind:'plugin'}`，而是具名 kind + `plugin` 字段 | §5#25 |
| K-136 | `TURN_END_KINDS` 七值（多 `forked`） | §5#1 |
| K-140 | `ResumeFailure` 四值（多 `SESSION_ALREADY_ACTIVE`） | §3.8#5 |
| M-001 | 测试断言 TURN_END_KINDS 为 7 个 | §5#1 |
| M-004 | 测试断言 `source.kind === 'spellbook-context'` | §5#25 |

**③ M 组覆盖率（本轮最关键的数字）**

| 指标 | 值 |
|---|---|
| 契约总数 | 274 |
| 有断言且覆盖要点（✅ + ✅有意差异） | **54（19.7%）** |
| 部分覆盖（⚠️，有断言但缺契约要点） | **44（16.1%）** |
| 完全无对应断言（❌） | **176（64.2%）** |
| 需要补的断言条目（⚠️ + ❌） | **220** |
| 三门面级空白 | `workspace` 25 条 **0%**、`ensure-workspace` 27 条 **0%**、`approval` 42 条 19% |

**④ 结论三句话**

1. K/L 两组基本对齐：148/213 直接满足 + 6 条有白名单出处的有意差异，剩 35 条偏离里绝大多数是"类型形态/计数基线"这类钝刀子。
2. **真正的风险在 M 组**：64% 的测试契约在本仓完全没有对应断言，缺口集中在 `runWorkspaceSession`（25 条 0 覆盖）与 `ensure-workspace.ts`（27 条 0 覆盖）两个整文件，以及审批/提问的状态机语义（超时、abort、注销结算）。
3. 白名单之外的"实现已偏离但未登记"有 6 类（G-14），其中最该立刻补的是 `serviceOf` 属性回退（G-5，它同时违反 M-011 并让 K-054 的结论失效）。

---

## 2. 逐条大表（K + L）

> M 组的逐条判定在 **§3 测试契约覆盖表**（同一批 ID，为免重复只写一次；统计口径包含它们）。

### 2.1 K 组：dsh 组件 / 服务 / 事件 / slot 用法（`G5-sessions-2.md` 原文，177 条）

| ID | 状态 | 证据 | 差异说明 |
|---|---|---|---|
| K-001 | ✅ | `src/sessions/core.ts:14-31,33` 只 import `../shared/dsh.ts`、`../shared/wire.ts`；`src/sessions/*.ts` 全仓 grep `@deepseek-ai` 仅命中 `store.ts:121` 的一句**文案** | 零运行时 dsh 依赖比契约更强 |
| K-002 | ⚠️ | `src/shared/dsh.ts:13` `export type SessionIdLike = string`；`core.ts:206-208` `asSessionId` 原样返回 string | 品牌类型退化为 string（结构面策略），无类型层区分 |
| K-003 | ✅ | `src/shared/dsh.ts:22-26` 结构面 `DshSessionLike`；`core.ts:658` `session.append`；`workspace.ts:325` `titles?.rename?.(handle.agent.session, …)` | class 降级为接口，但用法（append / rename(session)）一致 |
| K-004 | ✅ | `src/shared/dsh.ts:68-72`；`core.ts:396` `extractAssistantText(event: DshSessionEvent)` | — |
| K-005 | ✅ | `src/shared/dsh.ts:58-65` `DshTurnEndReason` 七档 | 见 K-136（多 `forked`） |
| K-006 | ✅ | `src/shared/dsh.ts:52` `DshTurnEndCancelCause = DshCancelCause \| {kind:'legacy'}`；`core.ts:712` 只产 `kind:'hook'` | — |
| K-007 | ✅ | `src/shared/dsh.ts:45-49`；`core.ts:745` `cancel({kind:'hook',…},{keepInbox:true})`；`workspace.ts:549` 默认参数 | — |
| K-008 | ✅ | `core.ts:357-365` `resolveAgents`；`workspace.ts:208,233` `agents.create/resume`；`:225` `agents.get` | — |
| K-009 | ✅ | `src/shared/dsh.ts:39-42` `{ agent, dispose(): Promise<void> }` | — |
| K-010 | ✅ | `workspace.ts:187-203`、`ephemeral.ts:194-210` 各有 `makeSetup(): DshAgentSetup`（门面内闭包，未对外导出） | `makeSetup` 不再是共享导出，语义不变 |
| K-011 | ✅ | `core.ts:891-902` `commit?: DshAgentSetupCommit`；`:895-900` 运行时形状闸门 | 比契约多一层运行时兜底 |
| K-012 | ✅ | `workspace.ts:208-221`（`sessionId`/`meta.cwd`/`meta.agentPreset`/`agentOptions`/`setup`） | — |
| K-013 | ⚠️ | `core.ts:586-597` 用**内联结构** `{ kind: string; messages?: DshUserMessageLike[] }` 描述决策 | 没有具名 `PreStepDecision` 类型 |
| K-014 | ✅ | `src/shared/dsh.ts:115-120`；`workspace.ts:214-219` 只填 provider/model/reasoningEffort | 不传 `maxTokens` |
| K-015 | ⚠️ | `core.ts:187-192` `mintMessageId(): string` | 品牌类型退化为 string（同 K-002） |
| K-016 | ✅ | `src/shared/dsh.ts:75-80` `DshUserMessageLike`；`core.ts:211,235` 两处返回它 | — |
| K-017 | ❌ | `asReasoningEffortId` / `ReasoningEffortId` 全仓 grep **0 命中**；`core.ts:320-322` 用 `String(candidate.reasoningEffort)` 直转 | 缺品牌转换点，`EphemeralModel.reasoningEffort` 是裸 string（`ephemeral.ts:56-60`） |
| K-018 | ✅ | `core.ts:625-637` `resolvePermission`（读 `defaultPreset`）；`:643-663` `applyPermission`（调 `set`） | — |
| K-019 | ✅ | `ephemeral.ts:63` `SessionPermission` 三值；`core.ts:658` `session.append('sandbox/mode', { mode })` | — |
| K-020 | ⚠️ | 无 `import type {} from '@deepseek-ai/dsh-sandbox-policy'`；`core.ts:505-509` 直接读 `data.mode` | 靠结构面+注释（`core.ts:230-234` 同策略）；零 import 更强，但白名单未登记 |
| K-021 | ⚠️ | 同上；`core.ts:510-514` 读 `data.active` | 同 K-020 |
| K-022 | ✅ | `ensure-workspace.ts:53-68` 返回 `DshWorkspaceLike`（`src/shared/dsh.ts:148-152`，含 `attachSession?`） | — |
| K-023 | ❌ | `asWorkspaceId` grep **0 命中**；`workspace.ts:253` `registry.get(options.workspaceId)` 直传 string | 品牌转换缺失 |
| K-024 | ✅ | `src/shared/dsh.ts:155-160` 四方法齐全；`workspace.ts:249-261` 用 `get`，`ensure-workspace.ts:49,62` 用 `resolveByPath`，`:63` `create` | `list` 未使用（契约也只要求可用） |
| K-025 | ✅ | `src/shared/dsh.ts:143-145`；`workspace.ts:323-328` 丢弃返回值 | — |
| K-026 | ✅ | `approval.ts:17` 四值闭集 | — |
| K-027 | ✅ | `approval.ts:56-63` `ApprovalRequestLike`（多 0.2 的 `displayReason`） | 多一字段（白名单 §5#6 要求"用"，`approval.ts:110` 透传） |
| K-028 | ✅ | `questions.ts:126-139`（多 0.2 的 `wait`） | 白名单 §5#4 |
| K-029 | ✅ | `questions.ts:213,235,275` 返回 `{ answers: InteractionAnswerItem[] }` | — |
| K-030 | ✅ | `questions.ts:145-176` `normalizeQuestions` 逐字段处理 id/question/detail/header/options/multiSelect/intent | 字段名一致，选项收窄为 `{label,description?}` |
| K-031 | ⚠️ | `src/shared/wire.ts:17-45` 改为自有 `InteractionIntent`/`InteractionAnswerItem`/`InteractionQuestion` 再导出 | 不直接再导出 dsh 的 Ask* 类型（零 import 策略）；字段是子集 |
| K-032 | ✅ | `approval.ts:11,105`；`questions.ts:10,216` 只有 `randomUUID` | — |
| K-033 | ✅ | `store.ts:13` 恰好 `existsSync/mkdirSync/readFileSync/readdirSync/renameSync/rmSync/writeFileSync` 七个 | — |
| K-034 | ✅ | `store.ts:14` 只 `join`；`ensure-workspace.ts:13` 只 `normalize` | — |
| K-035 | ✅ | 全仓零 `@deepseek-ai` 运行时导入 | — |
| K-036 | ✅ | 同上 | — |
| K-037 | ✅ | 同上 | — |
| K-038 | ✅ | `questions.ts:118-123` `error.name='UserQuestionError'` + `error.code` | 鸭式构造保留 |
| K-039 | ✅ | `src/shared/dsh.ts:136-140` 手写 `DshAgentPresetsLike`；全仓无 `@deepseek-ai/dsh-agent-presets` | — |
| K-040 | ✅ | `src/sessions/*.ts` 无 `@deepseek-ai/dsh-client-*`、无 react、无 JSX、无 `--dsw-*`（grep 仅 `store.ts:121` 命中 `@deepseek-ai` 文案） | — |
| K-041 | ✅ | `workspace.ts:258-261` `await workspace.attachSession(sessionId)` | — |
| K-042 | ✅ | `workspace.ts:321-329` | — |
| K-043 | ✅有意差异 | `core.ts:240` 缺省 kind = `DEFAULT_CONTEXT_KIND`（`core.ts:222` = `'spellbook-context'`）；具名时 kind = section 名（`:240`） | §5#25：会话格式 v4 拒绝 `kind:'plugin'`，故缺省具名化；`source.kind` 仍是 GUI 行 label |
| K-044 | ✅ | `core.ts:594-596` `[...(decision.messages ?? []), ...batch]` | — |
| K-045 | ✅ | `core.ts:98-113`、`workspace.ts:85-101`、`approval.ts:23-33` 全为纯数据 | 无函数/无 live 引用 |
| K-046 | ✅ | `workspace.ts:117,178` 截 2000 字符 + `…`；`questions.ts:178-185` 逐项浅拷 | — |
| K-047 | ⚠️ | `core.ts:357-365` 形状校验在；但取服务走 `serviceOf`，**含属性回退**（`src/shared/dsh.ts:195`） | `{ agents: {...} }` 这种无 `get` 的 ctx 现在也能过（违反 M-011 第 5 例） |
| K-048 | ✅ | 从不 `ctx.get('sessions')`；`workspace.ts:325,380`、`ephemeral.ts:340` 都用 `handle.agent.session` | `seq` 未读 |
| K-049 | ✅ | `ensure-workspace.ts:25-27` 直接 `serviceOf('workspaceRegistry')`，无形状校验 | — |
| K-050 | ⚠️ | `core.ts:368-372` 校验 `mount`；`:885` `mount(agentCtx, presetId)`；`:389` `resolve()` | 未读 `defaultId`（改用 `resolve()` 返回的 `id`，`core.ts:374-378`） |
| K-051 | ⚠️ | `core.ts:648-649` 校验 `typeof set === 'function'`；`:630` 读 `defaultPreset` | `resolve()` / `names` 未使用 |
| K-052 | ✅ | `workspace.ts:323-328` `serviceOf('sessionTitle')` + `titles?.rename?.()` + `try/catch` | — |
| K-053 | ✅ | `store.ts:116-124` `resolveStoreDir` 抛；`:285-291` `getSessionStore` catch→`null` | — |
| K-054 | ⚠️ | `core.ts:920-935` 三级降级在；但 `serviceOf`（`src/shared/dsh.ts:184-197`）在 `get` 拿不到时会**退回属性访问**，cordis 根 ctx 上 `ctx.logger` 存在 → 第一级实际可用 | K 的"标准部署下必然走 stderr"结论失效；这是行为变化，无测试 |
| K-055 | ✅ | 全仓无 `userApproval` 引用 | — |
| K-056 | ✅ | 全仓无 `userQuestions` 服务调用 | — |
| K-057 | ✅ | 全仓无 `sandboxPolicy` 服务调用 | — |
| K-058 | ✅ | 全仓无 `planMode` 服务调用；只读 `plan/mode` 事件（`core.ts:510-514`） | — |
| K-059 | ✅ | 全仓无 `sessionProjections` | — |
| K-060 | ✅ | `src/sessions/**` 无 `inject` 声明（grep 唯一命中是 `panel/surface.ts:52` 的 slot `inject`） | — |
| K-061 | ✅ | `core.ts:448` `ctx.on('session/event', …)` 无注册选项 | — |
| K-062 | ✅ | `core.ts:539` `ctx.on('agent/disposed', …)` | — |
| K-063 | ✅ | `core.ts:585-599` waterfall + `{ prepend: true }` | — |
| K-064 | ✅ | `src/shared/wire.ts:117` `WATERFALL_TAKEOVER = { prepend: true, global: true }`；`approval.ts:169` 使用 | — |
| K-065 | ✅ | `questions.ts:301` 使用同一常量 | — |
| K-066 | ✅ | `core.ts:598` 只给 `{ prepend: true }` | — |
| K-067 | ✅ | `core.ts:452-459` 抽文本 → `state.messages.push` + `onText` | — |
| K-068 | ✅ | `core.ts:460-470` push turnEnds、写 outcome、`openApprovals.clear()`、`onTurnEnd(reason, turn)` | — |
| K-069 | ✅ | `core.ts:471-482` | — |
| K-070 | ✅ | `core.ts:483-499` `waitedMs = Math.max(0, at - since)` | — |
| K-071 | ✅ | `core.ts:500-504` 仅收 `'ask'`/`'never'` | — |
| K-072 | ✅ | `core.ts:505-509` | — |
| K-073 | ✅ | `core.ts:510-514`（`false` 也落值） | — |
| K-074 | ✅ | `core.ts:515-522`；门面只在需要人机交互时挂 `onToolCall`（`workspace.ts:175-184`，截 2000） | — |
| K-075 | ✅ | `core.ts:523-528` 按 `message.source.callId` | — |
| K-076 | ✅ | `core.ts:506` 只读 `data.mode`，不碰 `source` | — |
| K-077 | ✅ | `approval.ts:107-110` 原样透传 `reason`；`workspace.ts:177-179` 记 `tool/call` 入参 | 契约是"看板从 reason 识别"，实现侧成立 |
| K-078 | ✅ | 无 `session/created` / `session/disposed` 注册 | — |
| K-079 | ✅ | 无 `agent/created` / `agent/status` | — |
| K-080 | ✅ | 无 `agent/turn-stopping` | — |
| K-081 | ✅ | 无 `agent/error` | — |
| K-082 | ✅ | 无 `agent/inbox/*` | — |
| K-083 | ✅ | 无 `session/flush` | — |
| K-084 | ⚠️ | `sessions` 模块确实零 slot（grep 无 `slots.`）；但 `package.json:11-16` **没有** `./sessions` 子入口，且**有** `./client` 入口；`src/index.ts:64` 用 `export *` 汇总 | "子入口直指 TS 源码、没有 client 入口"两条已不成立（改为单入口 + 独立 client bundle） |
| K-085 | ✅ | `interactions/ownership.ts:18-54` 模块级负缓存 + 白名单 | — |
| K-086 | ✅ | `workspace.ts:380` `applyPermission(ctx, agent.session, …)`；`:325` `rename(session, title)` | — |
| K-087 | ⚠️ | 全链路是 string（`src/shared/dsh.ts:13`） | 同 K-002 |
| K-088 | ✅ | `Session.seq` 未被读取 | — |
| K-089 | ✅ | `src/shared/dsh.ts:68-72`；`core.ts:450-451` 按 `event.type` 窄化后读 `data` | 未读 `event.time` 以外的字段（`:476,488` 读 `event.time`） |
| K-090 | ✅ | `core.ts:451-531` 九个事件分支全覆盖 | — |
| K-091 | ✅ | `core.ts:49-55` 双向子类型断言；`:104` `turnEnds: DshTurnEndReason[]`；`:126` `TurnSettlement.reason` | 断言的档数变 7（白名单 §5#1） |
| K-092 | ✅ | `core.ts:712` 只产 `{kind:'hook', reason:'magica:idle-timeout'}` | 顺带修掉 l.md 指的"缺 reason 字段" |
| K-093 | ✅ | `workspace.ts:549`、`ephemeral.ts:501` 默认 `{kind:'hook', reason:'magica:cancel'}` | — |
| K-094 | ✅ | `followup` `core.ts:732`；`whenIdle` `:740,752`；`cancel` `:745`；`session` `workspace.ts:380` | — |
| K-095 | ✅ | `src/shared/dsh.ts:39-42` | — |
| K-096 | ✅ | 门面 `makeSetup()` 返回 `DshAgentSetup`（`workspace.ts:187`、`ephemeral.ts:194`） | — |
| K-097 | ✅ | `core.ts:895-900` 拒绝裸函数并抛出可读错误 | — |
| K-098 | ✅ | `workspace.ts:208-221` 五字段 | — |
| K-099 | ✅ | `workspace.ts:233-244`、`ephemeral.ts:240-248` 只用 `resumeSessionId`/`agentOptions`/`setup` | — |
| K-100 | ✅ | `workspace.ts:214-219`（无 `maxTokens`） | — |
| K-101 | ⚠️ | 结构面内联（同 K-013） | 无具名 `PreStepDecision` |
| K-102 | ✅ | `core.ts:211-219` / `:235-258` | — |
| K-103 | ✅ | `src/shared/dsh.ts:75-80` 四字段齐全 | — |
| K-104 | ✅有意差异 | `core.ts` `source = { kind, form, summary|sections }` | §5#25：`kind` 不再是 `'plugin'`；V4 source 不写退役的 `plugin` 字段 |
| K-105 | ✅ | `form:'snapshot'` + `sections:[{name,text}]`；`form:'notice'` 带 `summary` | — |
| K-106 | ⚠️ | `mintMessageId` 返回 string | 同 K-015 |
| K-107 | ❌ | 同 K-017（无品牌转换） | `EphemeralModel.reasoningEffort?: string`（`ephemeral.ts:59`） |
| K-108 | ⚠️ | 只用 `defaultPreset`（`core.ts:630`）与 `set`（`:651`） | `resolve`/`names`/`current` 未使用 |
| K-109 | ✅ | 无 `PresetSpec` 依赖 | — |
| K-110 | ✅ | `ephemeral.ts:63` 三值与 `SandboxMode` 一致 | — |
| K-111 | ✅ | 未使用 dsh 的 `SANDBOX_MODES` | — |
| K-112 | ✅ | `approval.ts:20,45` `settle(outcome: ApprovalOutcome)` | — |
| K-113 | ✅ | `core.ts:110-111` `approvalPolicy?: 'ask' \| 'never'`；`:500-503` | — |
| K-114 | ✅ | `core.ts:88-95` 六字段 | — |
| K-115 | ✅ | `questions.ts:167-170` 透传 `intent.kind/approve`（+ 0.2 的 `callId`） | 白名单 §5#4 |
| K-116 | ✅ | `src/shared/wire.ts:39-44` `{ id, selected, custom? }` | `selected` 原样透传（`questions.ts:274-276`） |
| K-117 | ✅ | `questions.ts:28` 三码闭集 | — |
| K-118 | ✅ | `src/shared/dsh.ts:148-160` | — |
| K-119 | ✅ | `workspace.ts:325` 丢弃返回值 | — |
| K-120 | ⚠️ | 所有 `ctx` 参数类型是 `unknown`，内部转 `DshContextLike`（`src/shared/dsh.ts:172-178`） | 不再用 cordis `Context` 类型（零 import 策略） |
| K-121 | ❌ | 计数基线失效：`core.ts` 941 行、导出块 36 条；新增 `pickModel`/`resolveDefaultModel`/`toContextEntries`/`toMessages`/`DEFAULT_CONTEXT_KIND`/`TAKEOVER_OPTIONS`/`SESSION_ID_SAFE`（`sessions/index.ts:6-41`） | 55 函数 + 33 类型 + 5 常量 + 2 class 的精确拆分无法在现结构下成立，需重建基线 |
| K-122 | ❌ | 无 `./sessions` 子入口（`package.json:11-16`）；`src/index.ts:64` `export *` | 49/46 的"双入口"前提消失 |
| K-123 | ✅ | 七条"本该对外却漏转出"现已全部可达：`SessionRunState`(`sessions/index.ts:52`)、`ObserverHooks`(`:47`)、`runTurnVerified`(`:34`)、`resolveAgents`(`:31`)、`resolveAgentPresetId`(`:30`)、`ApprovalAnswererOptions`(`:106`)、`QuestionAnswererOptions`(`:123`) | 契约指的问题已修复 |
| K-124 | ⚠️ | 分层已变（`core.ts` 直接导出 `emptyRunState/snapshotRunState/releaseRunState`：`sessions/index.ts:18,35,29`） | "39 条有意分层"无法套用 |
| K-125 | ❌ | `src/sessions/index.ts` 现 7 个值块（`:6,56,72,87,96,108,127`）+ 7 个 `export type` 块（`:43,70,79,89,106,120,135`） | 11 条 / 全模块 20 条的口径不成立 |
| K-126 | ❌ | 同上，108/120 个符号不可复现 | 需重新统计 |
| K-127 | ❌ | `src/index.ts:63-65` 只有 `export *`，无具名转出块（`:33-55`/`:56-85` 那套行号已不存在） | 可达性判定改由 `export *` 传递 |
| K-128 | ❌ | 实际导出块数：`index.ts` 0 自有声明 ✓，但 `core.ts` 36 导出块、`store.ts` 11、`workspace.ts` 2、`ephemeral.ts` 5、`approval.ts` 7、`questions.ts` 9、`ensure-workspace.ts` 5 | 42/14/6/5/10/11/7 全部不成立 |
| K-129 | ⚠️ | 主入口可达的 core 符号已变（新增 `pickModel` 等，见 `sessions/index.ts:6-41`） | 名单需重出 |
| K-130 | ⚠️ | `store.ts` 11 值 + 4 类型**全部**可达（`sessions/index.ts:56-70`） | 契约"14 中 7 可达"不成立（现在更多） |
| K-131 | ⚠️ | `workspace.ts` 值 2 条（`runWorkspaceSession`、`ensureWorkspaceForSession`）+ 4 类型；`ephemeral.ts` 值 5 + 类型 5，全部可达 | 数量口径不同（6 / 5） |
| K-132 | ✅ | 四条"不可达"现已全部导出：`installApprovalAnswerer`(`sessions/index.ts:99`)、`installFailFastAnswerer`(`:100`)、`snapshotPendingApprovals`(`:103`)、`ApprovalAnswererOptions`(`:106`) | 契约指的问题已修复 |
| K-133 | ⚠️ | `questions` 9 值 + 4 类型全可达（`sessions/index.ts:108-125`）；`ensure-workspace` 5 值全可达（`:127-133`） | `asWorkspaceId` 在实现里**不存在**（不是"不可达"） |
| K-134 | ❌ | `sessions/index.ts` 未转出任何 `Dsh*` 类型；`core.ts:938` 的 `export type { DshAgentOptions, … }` 也没被上层再导出 | "dsh 25 条 / 主入口 9 条"整表失效 |
| K-135 | ✅ | 本文档沿用 ✅/⚠️/❌；`🔸`（仅子入口可达）因子入口取消而不再适用 | 口径已更新 |
| K-136 | ✅有意差异 | `core.ts:36-44` 七值：`completed/aborted/blocked/error/max-tokens/interrupted/forked` + `:49-55` 双向断言 | 白名单 §5#1（0.2 多了 `forked`） |
| K-137 | ✅ | `core.ts:622` | — |
| K-138 | ✅ | `core.ts:773-781` `code` + `name='SessionResumeError'` | `code` 联合多一值（K-140） |
| K-139 | ✅ | `approval.ts:17` 顺序与契约一致 | — |
| K-140 | ✅有意差异 | `core.ts:766-771` 四值：多 `SESSION_ALREADY_ACTIVE` | 白名单 §3.8#5（0.2 同一 sessionId 只允许一个写 handle） |
| K-141 | ✅ | `store.ts:18` `STORE_VERSION=1`；`:21` `STORE_SUBDIR='sessions'` | 目录 `storages/magica/sessions`（`store.ts:119`） |
| K-142 | ✅ | `store.ts:27` | — |
| K-143 | ✅ | `store.ts:30-35` | — |
| K-144 | ⚠️ | `store.ts:38-58` 实为 **13** 个键（`version/sessionId/kind/createdAt/updatedAt/model/permission/cwd/workspaceId/workspacePath/agentPresetId/title/customSetup`，`:37` 自述 13） | 契约写 14；疑为素材计数口径问题（见 §5） |
| K-145 | ⚠️ | `workspace.ts:104-114` 有 **9** 个成员（比契约多 `injectContext`） | 契约 8 个且把 `injectContext` 算作临时会话独有 |
| K-146 | ⚠️ | `ephemeral.ts:117-127` 与 workspace 同形（都有 `injectContext`） | "临时会话多一个"的差异已消失 |
| K-147 | ✅ | `ephemeral.ts:112-113` `readonly never[]`；`getState` 恒填 `[]`（`:490-491`） | `noInteraction:false` 时也不外露（见 M-182） |
| K-148 | ✅ | `core.ts:63-85` 文案原样保留（含 `'error: ' + message`、`'(… )'` 括号组） | 多一条 `forked (fork seed)`（`:80-82`） |
| K-149 | ✅ | `core.ts:360-361` | — |
| K-150 | ✅ | `core.ts:440` | — |
| K-151 | ✅ | `core.ts:833` | — |
| K-152 | ✅ | `core.ts:896-899` | — |
| K-153 | ✅ | `ensure-workspace.ts:58` | — |
| K-154 | ✅ | `ensure-workspace.ts:46` | — |
| K-155 | ✅ | `ensure-workspace.ts:76` | — |
| K-156 | ✅ | `ensure-workspace.ts:79-82`（两段拼接） | — |
| K-157 | ✅ | `workspace.ts:356`、`ephemeral.ts:305` | — |
| K-158 | ✅ | `workspace.ts:229-230`、`ephemeral.ts:235-236` | — |
| K-159 | ⚠️ | `questions.ts:52` `LOG_PLUGIN='dsh-magica-spellbook'`（单段）；`tests/sessions/questions.test.ts:46` 断言只有一个单段目录 | 不再是 `magica:sessions/ephemeral`；白名单未登记 |
| K-160 | ✅ | `questions.ts:232,255` | — |
| K-161 | ✅ | `questions.ts:279` | — |
| K-162 | ✅ | `store.ts:130-132` | — |
| K-163 | ✅ | `store.ts:120-123`（两段拼接） | — |
| K-164 | ✅ | `workspace.ts:367-391`：create/resume(`:367`) → attach(`:378`) → permission(`:379-388`) → title(`:389`) → followup(`:391`) | 次序与契约一致 |
| K-165 | ✅ | `workspace.ts:208-221` | — |
| K-166 | ✅ | `core.ts:885` `await presets.mount(agentCtx, presetId)` | — |
| K-167 | ✅ | `workspace.ts:260` | — |
| K-168 | ✅ | `core.ts:657-662` 降级 `sandbox/mode`；`workspace.ts:381-387` 返回 `'none'` 时告警 | — |
| K-169 | ✅ | `workspace.ts:325` `titles?.rename?.()` | — |
| K-170 | ✅ | `core.ts:755-762` 取本轮增量最后一条 `turn/end` | — |
| K-171 | ✅ | `core.ts:596` `[...(decision.messages ?? []), ...batch]` + `:598` `{prepend:true}` | — |
| K-172 | ✅ | `core.ts:592-593` 只判 `pending.length === 0` 与 `decision.kind === 'reject'` | — |
| K-173 | ✅ | `core.ts:575-618` 常驻监听 + `pending` 队列；`dispose()` 才注销 | — |
| K-174 | ✅ | `src/shared/wire.ts:117` + `approval.ts:157-170` / `questions.ts:288-302` | — |
| K-175 | ✅ | `approval.ts:144` 只在 `timeoutMs !== undefined && > 0` 时设定时器；门面透传可空（`workspace.ts:305-317`） | — |
| K-176 | ✅ | `approval.ts:193` 固定 `'unavailable'`；`questions.ts:338-343` reject `NO_PROVIDER` | 比"依赖 dsh 默认"更显式 |
| K-177 | ✅ | `questions.ts:312-317` 注释说明"不能 `return next()`"；`approval.ts:179-201` fail-fast | — |

### 2.2 L 组：边界 / 失败模式 / 已知限制（`docs/raw/l.md` §9，36 条）

| ID | 状态 | 证据 | 差异说明 |
|---|---|---|---|
| L-001 | ✅ | `core.ts:357-365` 抛可读错误；`workspace.ts:400-406`、`ephemeral.ts:355-361` 收敛进 `state.error` | 契约的"firstTurn 吞掉异常"行为保留 |
| L-002 | ⚠️ | `core.ts:368-372` 缺 `mount` 即返回 `undefined`；`core.ts:882-890` 跳过 mount；`workspace.ts:212` 不填 `meta.agentPreset` | **静默降级保留**；但设计 §6.3 要求"降级 + warn + `state.presetApplied=false`"，实现两者都没做（见 G-7） |
| L-003 | ✅ | `core.ts:388-392` `try { … } catch { return undefined }` | — |
| L-004 | ✅ | `core.ts:648-662` 降级返回 `'sandbox'`；`workspace.ts:381-387`、`ephemeral.ts:341-343` `'none'` 时告警 | — |
| L-005 | ✅ | `core.ts:649-656` `set` 抛 → 落到 `:658` `append('sandbox/mode')` | 不动 approval policy，与契约一致 |
| L-006 | ✅ | `core.ts:660-662` 返回 `'none'`（不抛） | — |
| L-007 | ⚠️ | `core.ts:920-935` 三级；但 `serviceOf` 属性回退（`src/shared/dsh.ts:195`）让第一级 `ctx.get('logger')` 失败后仍能拿到 `ctx.logger` | 契约的"必然走 stderr"不再成立（更优，但无测试） |
| L-008 | ✅ | `workspace.ts:249-251` `attachError='workspaceRegistry service unavailable'`，不抛 | — |
| L-009 | ✅ | `workspace.ts:258-266` `try/catch` → `attachError` | — |
| L-010 | ✅ | `workspace.ts:323-328` `try { titles?.rename?.() } catch {}` | 仍无诊断痕迹 |
| L-011 | ✅ | `store.ts:285-291` `getSessionStore` → `null`，静默 | — |
| L-012 | ⚠️ | `workspace.ts:297-300`、`ephemeral.ts:277-280` 写 `state.ledgerWriteFailed` + warn ✓ | **但设计 §6.3 的"写失败时进程内白名单兜底"没接线**：`noteMagicaSession` 在 `try` 内（`:296`、`:276`），写失败即跳过；`noteMagicaSessionInMemory`（`interactions/ownership.ts:57`）全仓无调用点 → 待决项仍会因归属判定失败而从看板消失（见 G-6） |
| L-013 | ✅ | `store.ts:168-189` `parseOne` → `null` + `recordError` | — |
| L-014 | ✅ | `store.ts:181-187` 只拒 `>` | — |
| L-015 | ✅ | `store.ts:224-231` 非 ENOENT 记 `loadErrors` 并返回 `null` | — |
| L-016 | ✅ | `store.ts:260-279` 先 `rmSync` 成功再删缓存 | — |
| L-017 | ✅ | `store.ts:252-254` tmp（带 pid+时间）+ rename | — |
| L-018 | ✅ | `core.ts:734-750` 看门狗；**两个门面都传了** `options.idleTimeoutMs`（`workspace.ts:359`、`ephemeral.ts:308`） | 契约指出的"门面没传"已修复（白名单 §6.3 属于设计要求，非 §3.8/§5，故此处按已实现记 ✅） |
| L-019 | ✅ | `core.ts:710-719` `timeoutSettlement()` 形状完整（`reason:{kind:'aborted', reason:{kind:'hook', reason:'magica:idle-timeout'}}`） | 契约的"缺 reason 字段"已修复 |
| L-020 | ✅ | `core.ts:755-762` 无增量 → `reason` 字段缺席 + `completed:false` | — |
| L-021 | ⚠️ | `workspace.ts:225` 调 `assertSessionNotLive`；`ephemeral.ts:231-254` **不调** | 临时会话的"还活着"由 `toResumeError` 归一成 `SESSION_ALREADY_ACTIVE`（`core.ts:847-853`），与正式会话的 `SESSION_LIVE` 不同码（见 G-9） |
| L-022 | ✅ | `core.ts:854-858` | 仍靠正则（`/not found\|SESSION_QUERY_SESSION_NOT_FOUND\|no such session\|ENOENT/i`） |
| L-023 | ✅ | `workspace.ts:226-232`、`ephemeral.ts:232-238` | — |
| L-024 | ✅ | `core.ts:818` `expectedKind` 不符 → `mint()` 新建 | — |
| L-025 | ✅ | `workspace.ts:490`、`ephemeral.ts:444` | — |
| L-026 | ✅ | `workspace.ts:488`、`ephemeral.ts:442` | — |
| L-027 | ✅ | `approval.ts:144`、`questions.ts:260` 只在显式 `timeoutMs > 0` 时计时 | — |
| L-028 | ✅ | `approval.ts:174`、`questions.ts:306` `if (bridges.get(key) === bridge) bridges.delete(key)` | 仍无 `reset` 之外的兜底（`resetApprovals`/`resetQuestions` 只给测试用） |
| L-029 | ✅ | `approval.ts:94-98` 旧待决全 `settle('cancelled')` | — |
| L-030 | ✅ | `questions.ts:203-207` 旧待决全 `settleAbort()` | — |
| L-031 | ✅ | `approval.ts:205` 非法 outcome → `'invalid-outcome'`，不结算 | — |
| L-032 | ✅ | `questions.ts:274-276` 原样 `resolve({answers})` | 看板必须传 `options[].label` 原文（无代码约束） |
| L-033 | ✅ | `questions.ts:297-298`、`:332-333` `owner === undefined` → `next()` | — |
| L-034 | ✅ | `core.ts:505-509` 只读 `mode`，`sandbox_permissions` 单次升级不入 `sandboxMode` | — |
| L-035 | ✅ | 重复实现仍在：`workspace.ts:119-131`、`ephemeral.ts:129-141` | 维护风险未消除（契约即记录该现状） |
| L-036 | ⚠️ | `SessionRunState`/`ObserverHooks`/`ApprovalAnswererOptions`/`QuestionAnswererOptions` 现已全部转出（`sessions/index.ts:52,47,106,123`） | 契约的"未转出"已修复（风险消除，但计数类契约 K-121/122 因此失效） |

---

## 3. 测试契约覆盖表（M 组，274 条；这是本次核对最关键的产出）

> 判定口径：**只认"当前仓库里存在、且真的会因为这些行为的改变而变红"的断言**。
> 覆盖位置写成 `文件:行`，指向 `tests/**/*.test.ts`；`—` 表示无任何对应断言。
> 注意：m.md 表格里的"行"列指 0.1.6 的 `tests/*.test.mjs` 行号，本仓已无那些文件，因此只能**按语义**映射（见 §5 素材错误 #5）。

### 3.1 §13.2 core（38 条）

| ID | 契约 | 判定 | 覆盖位置 / 缺什么 |
|---|---|---|---|
| M-001 | `TURN_END_KINDS` 恰好 6 个且顺序锁死 | ✅有意差异 | `core.test.ts:28-33` 断言 7 个（含 `forked`）；白名单 §5#1 |
| M-002 | 只有 completed 算完成；undefined 不算 | ✅ | `core.test.ts:35-40` |
| M-003 | `describeTurnEnd` 九条精确文案 | ✅ | `core.test.ts:42-53`（+`forked` 一条） |
| M-004 | 不具名 `source` 深等于 `{kind:'plugin',plugin}` | ✅有意差异 | `core.test.ts:70-79` 断言 `{kind:'spellbook-context',plugin,form,sections}`；白名单 §5#25 |
| M-005 | 具名 → kind=section、form=snapshot、sections | ✅ | `core.test.ts:85-93` |
| M-006 | `buildUserMessage` source 只有 user、多 block | ✅ | `core.test.ts:57-68` |
| M-007 | `mintMessageId` 200 次唯一 | ✅ | `core.test.ts:95-99` |
| M-008 | `emptyRunState` 初值 + 快照深拷 | ✅ | `core.test.ts:134-150` |
| M-009 | `outcome` 为 undefined 时键缺席 | ✅ | `core.test.ts:143-146` |
| M-010 | `errorMessage` 四种归一 | ✅ | `core.test.ts:152-157` |
| M-011 | `resolveAgents` 五种输入全抛（含"只有 agents 属性没有 get"） | ⚠️ | `core.test.ts:161-165` 只测 4 种；第 5 例不仅没测，**实现也不会抛**（`src/shared/dsh.ts:195` 属性回退）→ G-5 |
| M-012 | `resolveAgents` 返回同一引用 | ✅ | `core.test.ts:167-170` |
| M-013 | `assistant/message` 抽文本 + `onText` + 空白过滤 | ✅ | `observers.test.ts:16-28` + `core.test.ts:112-130` |
| M-014 | 只收 `type==='text'` | ✅ | `core.test.ts:112-125` |
| M-015 | `turn/end` 累积 + outcome 取最后 + `onTurnEnd(reason, turn)` | ⚠️ | `observers.test.ts:38-48` 只断言 outcome/turnEnds/approvals；"多条取最后"与 `turn` 序号未断言 |
| M-016 | `agent/disposed` 标记 + `onDisposed` 一次 | ✅ | `observers.test.ts:98-104`（`onDisposed` 未计数） |
| M-017 | 跨会话事件全挡（文本 + 结局） | ⚠️ | `observers.test.ts:30-36` 只测文本；`turn/end` 跨会话未测 |
| M-018 | 注销后全停 + 注销幂等 | ⚠️ | `observers.test.ts:106-116` 只测 session/event；`{session:1,disposed:1}` 与二次注销不抛未测 |
| M-019 | `agentCtx` 形状不符降级不抛 | ❌ | — |
| M-020 | 有 `turn/end` 时以它为准 | ✅ | `observers.test.ts:211-225` |
| M-021 | `whenIdle` 归来但无新 `turn/end` → kind undefined | ❌ | — |
| M-022 | 只取本轮增量（`slice(before)`） | ❌ | — |
| M-023 | `alreadyDelivered=true` 不重复投递 | ❌ | —（`observers.test.ts:243` 传了 true 但没断言 followup 次数） |
| M-024 | `whenIdle` reject 向上抛 | ❌ | — |
| M-025 | 上下文追加到 step 末尾 | ✅ | `observers.test.ts:148-157` |
| M-026 | 投完不自我注销（`size()===1`） | ⚠️ | `observers.test.ts:171-182` 有 push/投递/dispose 三段，但"常驻"没有断言 |
| M-027 | `reject` 的 step 不消耗上下文 | ✅ | `observers.test.ts:159-169` |
| M-028 | 空批次也注册监听 | ✅ | `observers.test.ts:171-182`（以 `[]` 初始化后 push） |
| M-029 | `dispose()` 丢掉未投递 | ✅ | `observers.test.ts:179-181` |
| M-030 | 显式权限最优先 | ✅ | `core.test.ts:172-174` |
| M-031 | 未传时读 `defaultPreset` | ✅ | `core.test.ts:175` |
| M-032 | 服务缺失 → `'workspace-write'` 常量 | ✅ | `core.test.ts:174` + `:4` |
| M-033 | `''` / `42` / `undefined` 都回退 | ❌ | 只测了 `undefined`；`core.ts:631` 的双校验无断言 |
| M-034 | getter 抛错降级不冒泡 | ✅ | `core.test.ts:176-179` |
| M-035 | 走 preset 时 `append` 零次 | ⚠️ | `core.test.ts:182-188` 断言返回 `'preset'` + `set` 收到名字；`appended` 为空未断言 |
| M-036 | preset 抛 → 降级且 `mode` 原样 | ⚠️ | `core.test.ts:190-194` 断言 `'sandbox'` 与 `type`；`data.mode==='read-only'` 未断言 |
| M-037 | 服务缺失时降级 `sandbox/mode` | ⚠️ | 只覆盖"`set` 抛"，无 `permissionPresets` 缺失分支 |
| M-038 | 两条路都失败 → `'none'` 不抛 | ❌ | — |

### 3.2 §13.3 store（45 条）

| ID | 契约 | 判定 | 覆盖位置 / 缺什么 |
|---|---|---|---|
| M-039 | `recordFileName` 普通 id 只加后缀 | ✅ | `store.test.ts:28` |
| M-040 | 拒绝 `../evil` / `a/b` / `a\b` | ⚠️ | `store.test.ts:33` 只测 `'bad/id'` |
| M-041 | 拒绝空串与 201 长 | ⚠️ | `store.test.ts:34` 只测超长 |
| M-042 | `resolveStoreDir` 显式 override 优先 | ❌ | — |
| M-043 | 走 `dshHomePath` 拼 `storages/magica` | ❌ | 无断言（门面测试用 override，见 `facade.test.ts:34,47`） |
| M-044 | 服务缺失抛 `pass \`storeDir\` explicitly` | ❌ | — |
| M-045 | `getSessionStore` 解析不出 → `null` | ❌ | — |
| M-046 | put→get→list→remove 闭环（含 put 返回值） | ⚠️ | `store.test.ts:39,79,88` 分散覆盖；`put` 返回的 `sessionId`/`updatedAt` 未断言 |
| M-047 | 2 空格缩进 + 结尾 `\n` + 新实例读回 | ✅ | `store.test.ts:39-48` + `:97-104` |
| M-048 | 缓存：外部删盘后同实例仍读到、新实例读不到 | ❌ | — |
| M-049 | 目录不存在时首读为空 | ❌ | — |
| M-050 | 坏文件 skip + `loadErrors` 计数 2 + 忽略 `.txt` | ⚠️ | `store.test.ts:70-77` 只有 1 个坏文件；计数/形状错/`.txt` 未测 |
| M-051 | 缺 `kind` 与缺 `sessionId` 都丢弃 | ⚠️ | 只测缺 `kind` |
| M-052 | 往返保留 9 个可选字段 | ⚠️ | 零散覆盖 `cwd`/`permission`/`title`（`facade.test.ts:60-69`、`store.test.ts:97-104`）；`model.reasoningEffort`/`workspaceId`/`workspacePath`/`agentPresetId`/`customSetup` 从未一次性断言 |
| M-053 | 三消费方不可用时返回 `null`/`[]`/`false` | ❌ | — |
| M-054 | 三消费方透传 `storeDir` | ⚠️ | 门面传了 `storeDir` 但三个薄封装未各自断言 |
| M-055 | `getSessionStore` 同目录同实例 | ❌ | — |
| M-056 | 不传 id → 新建 + 前缀 `/^magica-ws-/` | ⚠️ | `core.test.ts:241-244` 只断言 `resumed===false` 且 id 变了；前缀正则未断言 |
| M-057 | 空串等同不传 | ❌ | — |
| M-058 | 台账 `null` → 一律新建 | ✅ | `core.test.ts:242-244` |
| M-059 | 有记录 → 续跑并带 `record` | ✅ | `core.test.ts:254-259` |
| M-060 | 无记录 → 新建并忽略 id | ✅ | `core.test.ts:246-249` |
| M-061 | `assertSessionNotLive` 抛 `SESSION_LIVE` | ❌ | — |
| M-062 | 不在活层时通过 | ❌ | — |
| M-063 | 注册表抛错按不活着处理 | ❌ | — |
| M-064 | `toResumeError` not found → `SESSION_LOG_MISSING` | ✅ | `core.test.ts:279-282` |
| M-065 | 其他错误原样返回 | ✅ | `core.test.ts:283-286` |
| M-066 | 已是 `SessionResumeError` → 同一引用 | ❌ | `core.test.ts:275` 用的是带 `code` 的普通 `Error` |
| M-067 | 非 Error 包成 Error | ❌ | — |
| M-068 | `composeAgentScope` 顺序 `['observe','preset','user']` | ⚠️ | `observers.test.ts:186-207` 只断言 `['mount','setup']`（观察者不进 `order`） |
| M-069 | 不指定 preset → 挂默认 + 回填实际 id | ❌ | — |
| M-070 | `presetId=false` → 明确不挂 | ❌ | — |
| M-071 | preset 服务缺失 → 跳过不抛 | ❌ | — |
| M-072 | preset 抛错 → 注销监听并冒泡 | ❌ | — |
| M-073 | 调用方 `setup` 抛错 → 同样收尾 | ✅ | `observers.test.ts:186-207`（`:206` listeners 0） |
| M-074 | 指定 id → 原样返回且**不** resolve | ❌ | — |
| M-075 | 没指定 → 解析默认 id | ❌ | — |
| M-076 | 解析失败 → `undefined` | ❌ | — |
| M-077 | 无 preset 服务 → `undefined` | ❌ | — |
| M-078 | 服务无 `resolve` → `undefined` | ❌ | — |
| M-079 | `unsubscribe` 幂等 | ❌ | — |
| M-080 | `remove` 删盘失败 → 内存保持 | ❌ | — |
| M-081 | `version` 更高 → 跳过 + `loadErrors` | ⚠️ | `store.test.ts:57-68` 断言单文件 `get` + message；`list()` 为空未断言 |
| M-082 | `get()` 单文件直读不触发全量扫描 | ❌ | — |
| M-083 | `get` 对不存在/不安全名/坏 JSON 都返回 `null` | ⚠️ | `store.test.ts:50-55` 只测 ENOENT；`'../escape'` 与坏 JSON 未测 |

### 3.3 §13.4 resume（26 条，全部为 workspace/ephemeral 门面级）

| ID | 契约 | 判定 | 覆盖位置 / 缺什么 |
|---|---|---|---|
| M-084 | workspace 新建落台账（9 字段 + 2 时间戳） | ❌ | 无 workspace 门面测试（G-2） |
| M-085 | 台账能被读回 | ❌ | — |
| M-086 | workspace 不传 id → 新建 | ❌ | 只有 ephemeral 同形（`facade.test.ts:39`） |
| M-087 | 自定义铸造器 / 非法 id 同步抛 | ⚠️ | `core.test.ts:261-264` 覆盖 `resolveResumeTarget` 层；"续跑不再调铸造器"未测 |
| M-088 | `contextPlugin` 不再写入 source；`kind`=section | ✅（有意差异） | V4 source 不写退役的 `plugin` 字段，生产者身份由 `kind` 表达 |
| M-089 | 已知 id → resume（不 create、模型回退台账） | ⚠️ | `facade.test.ts:81-105` 是 ephemeral 版；`agentOptions` 深等未断言 |
| M-090 | 未知 id → 新建并忽略 | ✅ | `facade.test.ts:107-124` + `core.test.ts:246-249` |
| M-091 | 续跑调用方模型覆盖台账并回写 | ❌ | — |
| M-092 | 续跑权限不传就不重设 | ❌ | — |
| M-093 | 续跑显式权限重新应用 | ❌ | — |
| M-094 | 活层 → `SESSION_LIVE`（且 `resumed` 仍 true） | ❌ | — |
| M-095 | `setup` 未重传 → `SESSION_SETUP_REQUIRED` | ❌ | — |
| M-096 | 重传 `setup` 后正常续跑 | ❌ | — |
| M-097 | 日志缺失 → `SESSION_LOG_MISSING` | ❌ | — |
| M-098 | ephemeral 台账写 `kind/agentPresetId/reasoningEffort/cwd/permission` | ⚠️ | `facade.test.ts:60-69` 断言 `kind/cwd/permission/version`；`agentPresetId` 与 `reasoningEffort` 未断言 |
| M-099 | ephemeral 续跑自动 mount 台账 preset | ❌ | — |
| M-100 | ephemeral 未知 id → 新建（前缀 `旧实现-`） | ⚠️ | `facade.test.ts:107-124` 未断言前缀 |
| M-101 | ephemeral 活着续跑 → `SESSION_LIVE` | ❌ | 实现改为 `SESSION_ALREADY_ACTIVE`（G-9），无测试 |
| M-102 | workspace 不传 preset → 挂默认 + 写 meta/台账 | ❌ | — |
| M-103 | `agentPresetId=false` → 不挂不写 | ❌ | — |
| M-104 | 显式 preset 续跑沿用台账 id | ❌ | — |
| M-105 | ephemeral 不传 preset → 默认 + 台账 | ❌ | — |
| M-106 | 台账不可用 → 会话照跑（降级） | ❌ | — |
| M-107 | 台账不可用不影响 attach/权限 | ❌ | — |
| M-108 | 续跑不再追加上下文（pre-step 计数） | ❌ | — |
| M-109 | 跨门面不改写别人的记录 | ⚠️ | `facade.test.ts:107-124` 只断言"新建且 id 不同"；原记录未变未断言 |

### 3.4 §13.5 approval（42 条）

> ⚠️ 结构性盲区：`tests/helpers/fake.ts:27-37` 的 `on()` **丢弃 options**，所以本仓所有"`prepend` / `global`"契约在测试里**根本不可见**（G-15）。

| ID | 契约 | 判定 | 覆盖位置 / 缺什么 |
|---|---|---|---|
| M-110 | 注册 `prepend + global` | ❌ | fakeCtx 丢弃 options，无法断言 |
| M-111 | 注销后监听器被摘掉 | ✅ | `facade.test.ts:76-78`（approval listener 0） |
| M-112 | 注销幂等（三次） | ❌ | — |
| M-113 | 不是自己的会话 → `next()` | ❌ | — |
| M-114 | 自己会话挂住并进待决表 | ✅ | `route.test.ts:189-201` |
| M-115 | `answerApproval` 答上 → resolve | ✅ | `route.test.ts:212-221` |
| M-116 | 同一 id 答两次 → `not-found` | ❌ | 只有 question 版（`route.test.ts:135-144`） |
| M-117 | 会话不在接管表 → `session-gone` | ❌ | 只有 question 版 |
| M-118 | id 不存在 → `not-found` | ❌ | 只有 question 版 |
| M-119 | 注销之后 → `session-gone` + 已按 cancelled 结算 | ❌ | — |
| M-120 | 超时 → `cancelled` | ❌ | — |
| M-121 | 默认不超时 | ❌ | — |
| M-122 | 超时前答上 → 先答者胜 | ❌ | — |
| M-123 | `signal` abort → `cancelled` | ❌ | — |
| M-124 | 已 abort 的 signal → 立刻 cancelled | ❌ | — |
| M-125 | 注销时把挂着的全部收尾 | ❌ | — |
| M-126 | `ctx.effect` 里挂注销函数 | ⚠️ | `facade.test.ts:206-214` 只断言 `effects()>=1` |
| M-127 | 多会话互不干扰 | ❌ | — |
| M-128 | `listPendingApprovals` 按等待升序 | ❌ | — |
| M-129 | 传 `sessionId` 过滤 | ❌ | — |
| M-130 | `APPROVAL_OUTCOMES` 深等四值 | ❌ | `core.test.ts` 未导入该常量 |
| M-131 | `asked + decided` 配对 `waitedMs` | ✅ | `observers.test.ts:50-60` |
| M-132 | 无配对 `asked` 的 `decided` 被忽略 | ⚠️ | `observers.test.ts:38-48` 只覆盖 `turn/end` 清空 |
| M-133 | 多个审批按 decided 顺序累积 | ❌ | — |
| M-134 | `approval/policy` 落 `state.approvalPolicy` | ⚠️ | `observers.test.ts:62-81` 只测 `'never'`；初值 `undefined` 与 `'ask'` 未测 |
| M-135 | `sandbox/mode` 落 `state.sandboxMode` | ✅ | `observers.test.ts:71,76` |
| M-136 | `plan/mode` 的 `false` 也落值 | ⚠️ | 只测 `true`（`:72,77`） |
| M-137 | 别的会话的四种事件被挡 | ⚠️ | `observers.test.ts:30-36` 只测 assistant/message |
| M-138 | fail-fast 注册也是 `prepend+global` | ❌ | fakeCtx 盲区 |
| M-139 | fail-fast 自己会话立刻 `unavailable` | ⚠️ | `facade.test.ts:195-204` 只断言装了 1 个监听，未真触发 |
| M-140 | fail-fast 非自己会话 → `next()` | ❌ | — |
| M-141 | 沙箱越界申请也走同一条路 | ❌ | — |
| M-142 | `args` 按 `callId` 取到 | ❌ | `workspace.ts:175-184` 有实现，无断言 |
| M-143 | 查不到/抛错 → 字段缺席仍能挂住 | ❌ | — |
| M-144 | 无 `callId` 不查 | ❌ | — |
| M-145 | fail-fast 注销幂等 | ❌ | — |
| M-146 | fail-fast 也挂 `ctx.effect` 注销 | ❌ | — |
| M-147 | 门面自动装 fail-fast | ✅ | `facade.test.ts:195-204` |
| M-148 | dispose 后 answerer 被摘掉 | ✅ | `facade.test.ts:76-78` |
| M-149 | 重复安装同 sessionId 先结算旧 bridge | ❌ | — |
| M-150 | `answerApproval` 拒绝非法 outcome | ⚠️ | `route.test.ts:202-210` 断言的是**路由层** 400（payload 校验），不是 `approval.ts:205` 的 `'invalid-outcome'` |
| M-151 | `turn/end` 清掉悬空 `openApprovals` | ✅ | `observers.test.ts:38-48` |

### 3.5 §13.6 questions（32 条）

| ID | 契约 | 判定 | 覆盖位置 / 缺什么 |
|---|---|---|---|
| M-152 | 注册 `prepend + global` | ❌ | fakeCtx 盲区 |
| M-153 | 注销后摘掉、幂等 | ❌ | — |
| M-154 | 不是自己的会话 → `next()` | ❌ | — |
| M-155 | `agent` 缺失 → `next()` | ❌ | — |
| M-156 | 自己会话挂住并进待决表 | ✅ | `route.test.ts:63-83` |
| M-157 | 透传 `intent`/`detail`/`multiSelect` | ⚠️ | `route.test.ts:67-82` 传了 options/multiSelect 并断言 `wait*`；`intent`/`detail` 未测 |
| M-158 | `answerQuestion` resolve 成用户答案 | ✅ | `route.test.ts:99-132` |
| M-159 | `custom` 自由文本原样 | ❌ | 无 `custom` 用例 |
| M-160 | 同一 id 答两次 → `not-found` | ✅ | `route.test.ts:135-144` |
| M-161 | 会话不在接管表 → `session-gone` | ✅ | `route.test.ts:170-182`（经 409 映射） |
| M-162 | id 不存在 → `not-found` | ✅ | `route.test.ts:118` |
| M-163 | `cancelQuestion` reject `ASK_CANCELLED` | ❌ | 路由 `/question/cancel` 无测试（`route.test.ts:243-253` 只测 415） |
| M-164 | cancel 会话不在接管表 | ❌ | — |
| M-165 | cancel id 不存在 | ❌ | — |
| M-166 | `signal` abort → `ASK_ABORTED` | ❌ | — |
| M-167 | 已 abort 立刻 reject | ❌ | — |
| M-168 | 注销时全部按 `ASK_ABORTED` 收尾 | ❌ | — |
| M-169 | `ctx.effect` 里的注销也收尾 | ⚠️ | `facade.test.ts:206-214`（只计数） |
| M-170 | 默认不超时 | ❌ | — |
| M-171 | `timeoutMs` 超时 → `ASK_ABORTED` | ❌ | — |
| M-172 | 多会话互不干扰 | ❌ | — |
| M-173 | `listPendingQuestions` 升序 | ❌ | — |
| M-174 | fail-fast 自己会话 reject `NO_PROVIDER` | ⚠️ | `questions.test.ts:41` 断言 rejects `/does not accept human input/`；`code==='NO_PROVIDER'` 未断言 |
| M-175 | fail-fast 非自己会话 → `next()` | ❌ | — |
| M-176 | fail-fast `agent` 缺失 → `next()` | ❌ | — |
| M-177 | 门面自动装提问 fail-fast | ✅ | `facade.test.ts:195-204` |
| M-178 | dispose 后摘掉 | ⚠️ | `facade.test.ts:76-78` 只断言 approval 计数 |
| M-179 | 事件日志三行 + detail 精确形状 | ❌ | `questions.test.ts:34-54` 只断言 `question.fail-fast`；`asked/answered/cancelled` 未测，且实现写 `intent: undefined`（`questions.ts:226`）而非契约要求 `kind ?? null` |
| M-180 | fail-fast 也留痕 | ✅ | `questions.test.ts:51-53` |
| M-181 | `humanInteraction` 同时接管审批 + 提问 | ❌ | 无 workspace 测试 |
| M-182 | 不传 `humanInteraction` 一个监听都不加 | ❌ | 现实现走 ephemeral 的 `noInteraction`（`ephemeral.ts:321-325`），与契约的选项名不同且未测 |
| M-183 | dispose 把挂着的提问按 `ASK_ABORTED` 收尾 | ❌ | — |

### 3.6 §13.7 ephemeral（29 条）

| ID | 契约 | 判定 | 覆盖位置 / 缺什么 |
|---|---|---|---|
| M-184 | 基本流程：单轮 | ⚠️ | `facade.test.ts:39-79` 断言 completed/texts/done/running/error/resumed；`turnEnds` 深等与 `outcome` 未断言 |
| M-185 | 只取 `type==='text'` | ✅ | `core.test.ts:112-130`（extractAssistantText 层） |
| M-186 | 一个 turn 内多条 `assistant/message` 全收 | ❌ | — |
| M-187 | 空 text 不收集 | ✅ | `core.test.ts:126-129` |
| M-188 | 六种 kind 全部记录 | ❌ | — |
| M-189 | 用户取消 ≠ 完成（`error===null`） | ❌ | — |
| M-190 | `whenIdle` 归来但无 `turn/end` → outcome undefined | ❌ | — |
| M-191 | `agent/disposed` 标记 | ✅ | `observers.test.ts:98-104` |
| M-192 | `noInteraction=true` 上下文走 pre-step 末尾 + 正文逐字 | ❌ | `NO_INTERACTION_PREFIX`（`ephemeral.ts:72`）无任何断言 |
| M-193 | `noInteraction=false` 不追加任何上下文 | ❌ | — |
| M-194 | `context` 顺序 `context` 在前 | ❌ | — |
| M-195 | `prompt` 为 `string[]` | ❌ | — |
| M-196 | 每轮 `followup` 不重复追加 | ❌ | — |
| M-197 | 多轮 followup 串行 + 返本轮结算 | ⚠️ | `facade.test.ts:154-169` 断言串行与 completed；`texts` 只含本轮未断言 |
| M-198 | `followup` 在上轮出错后抛 | ❌ | — |
| M-199 | `cancel` 保留 inbox | ❌ | — |
| M-200 | TTL 超时 → error + 自动 dispose | ❌ | — |
| M-201 | `ttlMs: 0` = 不设上限 | ❌ | — |
| M-202 | dispose 清理监听 + handle.dispose + 幂等 | ⚠️ | `facade.test.ts:76-79` 断言 disposed 与 approval 监听归零；`handle.dispose` 调用与幂等未断言 |
| M-203 | dispose 后 `followup` 抛 | ✅ | `facade.test.ts:141-152` |
| M-204 | dispose 清空累计输出（保留 outcome） | ❌ | — |
| M-205 | `wake` 从日志重载 + 之后能 followup | ❌ | — |
| M-206 | `wake` 幂等 | ❌ | — |
| M-207 | `wake` 等上一次 dispose 落地 | ❌ | — |
| M-208 | `getState` 返回副本 | ✅ | `core.test.ts:143-150` + `facade.test.ts:53-58` |
| M-209 | `agents` 缺失 → 异步标记 error | ❌ | — |
| M-210 | `agents.create` 参数透传 | ⚠️ | `facade.test.ts:176` 只断言"没建"，参数未断言 |
| M-211 | 权限：`permissionPresets` 存在时优先 | ❌ | — |
| M-212 | `ctx.effect` 安全网 | ✅ | `facade.test.ts:206-214` |

### 3.7 §13.8 workspace（25 条）

> **整个文件级空白**：`tests/` 下没有任何文件引用 `runWorkspaceSession`（grep 0 命中），故本节全部未覆盖；只有跨层机制（`installContextDelivery`/`describeTurnEnd`/`resolvePermission`）在别处被间接覆盖。

| ID | 契约 | 判定 | 覆盖位置 / 缺什么 |
|---|---|---|---|
| M-213 | 基本流程 + 前缀 `magica-ws-` | ❌ | — |
| M-214 | `cwd` 必须来自 `workspacePath` | ❌ | — |
| M-215 | attach 用 `workspaceId + sessionId` | ❌ | — |
| M-216 | attach 失败不抛（`attachError`） | ❌ | — |
| M-217 | attach 成功时 `attachError` **缺席** | ❌ | — |
| M-218 | `workspaceRegistry` 缺失 → 记 `attachError` | ❌ | — |
| M-219 | workspace 找不到 → 记 `attachError` | ❌ | — |
| M-220 | `title` 经 `sessionTitle.rename` 钉住 | ❌ | — |
| M-221 | 权限未传 → `defaultPreset` | ❌ | —（`core.test.ts:175` 只到 `resolvePermission`） |
| M-222 | 显式权限优先 | ❌ | — |
| M-223 | 全局也没有 → `workspace-write` | ❌ | 仅 `core.test.ts:174` 的常量层 |
| M-224 | `permissionPresets` 缺失 → 降级 | ❌ | — |
| M-225 | preset 存在时优先（`sandboxCalls` 为 0） | ❌ | — |
| M-226 | 不含 `reasoningEffort` / `agentPreset` | ❌ | — |
| M-227 | `context` 走 pre-step 追加 | ⚠️ | `observers.test.ts:148` 覆盖机制；门面的注入接线未测 |
| M-228 | `followup` 串行 + 返 `TurnSettlement` | ❌ | — |
| M-229 | 结局语义 `aborted` | ❌ | — |
| M-230 | `max-tokens` 单独可辨 | ⚠️ | `core.test.ts:42-53` 只覆盖文案；结算未测 |
| M-231 | `whenIdle` 无 `turn/end` → kind undefined | ❌ | — |
| M-232 | 默认不设 TTL | ❌ | — |
| M-233 | `cancel` 与 `dispose` 语义分离 | ❌ | — |
| M-234 | dispose 清空累计输出 | ❌ | — |
| M-235 | `wake` 重新加载 + 重挂 workspace | ❌ | — |
| M-236 | `wake` 幂等 | ❌ | — |
| M-237 | `agents` 缺失时 `firstTurn` 返兜底结算 | ❌ | — |

### 3.8 §13.9 "无断言风险面"（10 条，重写时没有安全网）—— 现状复核

| ID | 契约 | 判定 | 覆盖位置 / 缺什么 |
|---|---|---|---|
| M-238 | `idleTimeoutMs` 看门狗 | ✅ | `observers.test.ts:227-249` + `facade.test.ts:126-139`（风险已消除） |
| M-239 | 超时结算的 `reason` 形状 | ⚠️ | `observers.test.ts:243-247` 断言 `reason?.kind==='aborted'` 与 cancel cause；`reason.reason.kind==='hook'` 未断言 |
| M-240 | `warnLedgerWriteFailure` 三级降级 | ❌ | — |
| M-241 | `describeTurnEnd` 的 `default` 分支 | ⚠️ | `core.test.ts:42-53` 覆盖 9 条具名文案；`default`（`core.ts:82-83`，已无 `/* v8 ignore */`）未覆盖 |
| M-242 | `listSessionRecords` 多实例降序 | ❌ | — |
| M-243 | `loadErrors` 在 `get()` 命中缓存后的行为 | ⚠️ | `store.test.ts:50-55` 只覆盖 ENOENT 不记 |
| M-244 | `injectContext` 在 dispose 后静默 | ❌ | — |
| M-245 | `getState().ledgerWriteFailed` | ❌ | — |
| M-246 | 临时会话 `resolvePermission` 的第 2/3 级 | ❌ | `ephemeral.ts:166` 直接落 `DEFAULT_SANDBOX`，该路径确实是死代码且无断言 |
| M-247 | `toPending` 逐项浅拷 | ❌ | `questions.ts:178-185` 有实现，无断言 |

### 3.9 §13.10 ensure-workspace（27 条）

> **整个文件级空白**：`tests/` 下 grep `ensureWorkspace|findWorkspace|createWorkspace|normalizeProjectPath|getWorkspaceRegistry` **0 命中**。这一组契约可直接照搬成 `tests/sessions/ensure-workspace.test.ts`（现成的 27 条）。

| ID | 契约 | 判定 | 覆盖位置 / 缺什么 |
|---|---|---|---|
| M-248 | `normalizeProjectPath('') === ''` | ❌ | — |
| M-249 | 尾部斜杠去除 | ❌ | — |
| M-250 | 混合分隔符统一 | ❌ | — |
| M-251 | `..` 被解析 | ❌ | — |
| M-252 | 冗余分隔符压缩 | ❌ | — |
| M-253 | 命中已有 → 返回同引用且不 create | ❌ | — |
| M-254 | 未命中 → create（传归一化路径） | ❌ | — |
| M-255 | 归一发生在任何 registry 调用之前 | ❌ | — |
| M-256 | `title` 透传 create | ❌ | — |
| M-257 | 命中时 `title` 被忽略 | ❌ | — |
| M-258 | `attachSessionId` 触发 `workspace.attachSession` | ❌ | — |
| M-259 | registry 缺失 → `undefined`（不抛） | ❌ | — |
| M-260 | 空路径抛错 | ❌ | — |
| M-261 | `create` 失败原样上浮 | ❌ | — |
| M-262 | `findWorkspace` 命中返回同引用、不 create | ❌ | — |
| M-263 | `findWorkspace` 未命中 → `undefined` | ❌ | — |
| M-264 | `findWorkspace` registry 缺失 → `undefined` | ❌ | — |
| M-265 | `findWorkspace` 空路径抛错 | ❌ | — |
| M-266 | `createWorkspace` 创建 + 归一化 | ❌ | — |
| M-267 | 无 title → 传 `undefined` | ❌ | — |
| M-268 | `createWorkspace` registry 缺失 → 抛 | ❌ | — |
| M-269 | `createWorkspace` 空路径抛错 | ❌ | — |
| M-270 | `getWorkspaceRegistry` 返回同引用 | ❌ | — |
| M-271 | `getWorkspaceRegistry` 缺失 → `undefined` | ❌ | — |
| M-272 | 其他 service 名 → `undefined` | ❌ | — |
| M-273 | 正斜杠路径跨平台一致 | ❌ | — |
| M-274 | 4 种拼写归一后两两相等 | ❌ | — |

### 3.10 未覆盖汇总（按段落）

| 段落 | 条数 | ✅ | ✅有意差异 | ⚠️ | ❌ | 覆盖率（✅+有意差异） |
|---|---|---|---|---|---|---|
| §13.2 core | 38 | 21 | 2 | 8 | 7 | 61% |
| §13.3 store | 45 | 8 | 0 | 11 | 26 | 18% |
| §13.4 resume | 26 | 1 | 0 | 5 | 20 | 4% |
| §13.5 approval | 42 | 8 | 0 | 7 | 27 | 19% |
| §13.6 questions | 32 | 7 | 0 | 4 | 21 | 22% |
| §13.7 ephemeral | 29 | 6 | 0 | 4 | 19 | 21% |
| §13.8 workspace | 25 | 0 | 0 | 2 | 23 | **0%** |
| §13.9 风险面 | 10 | 1 | 0 | 3 | 6 | 10% |
| §13.10 ensure-workspace | 27 | 0 | 0 | 0 | 27 | **0%** |
| **合计** | **274** | **52** | **2** | **44** | **176** | **19.7%** |

**未覆盖（❌）的段落分布就是修法优先级**：ensure-workspace(27) + approval(27) + store(26) + workspace(23) + questions(21) + resume(20) + ephemeral(19) = **163 条，占全部 ❌（176 条）的 93%**。

---

## 4. GAPS（按影响排序）

> 每条给四段：**现状** / **原始要求** / **最小修法** / **需要补的断言**。
> 前 4 条是"没有安全网"级别的（改坏了没人拦），后面是行为与白名单的缺口。

### G-1（P0）`runWorkspaceSession` 零测试

- **现状**：`src/sessions/workspace.ts` 571 行、9 个成员，承担"进 GUI 列表 + 钉标题 + 接管人工交互"三件最容易被用户看见的事；`tests/` 下 grep `runWorkspaceSession` **0 命中**（只有 `WorkspaceSessionState` 类型出现在源码里）。
- **原始要求**：m.md §13.8 有 25 条现成契约（`M-213…M-237`），全部要求"门面级"断言。
- **最小修法**：复制 `tests/helpers/fake-agent.ts` 的用法 + 造一个 `fakeWorkspaceRegistry`（`get/attachSession/create/resolveByPath`），新建 `tests/sessions/workspace.test.ts`。不需要新桩：`fakeAgents` 已能编排 create/resume/turn。
- **需要补的断言**：`M-213`(前缀 `magica-ws-`) `M-214`(`meta.cwd===workspacePath`) `M-215`(`attachCalls`) `M-216/217`(attach 失败不抛 / 成功时 `attachError` 缺席) `M-220`(`rename(session,title)` 收到 Session 对象) `M-233`(cancel vs dispose) `M-235`(wake 重挂 workspace)。

### G-2（P0）`src/sessions/ensure-workspace.ts` 零测试

- **现状**：5 个导出函数（`getWorkspaceRegistry`/`normalizeProjectPath`/`findWorkspace`/`ensureWorkspace`/`createWorkspace`）无任何断言；`tests/` grep 五个名字 **0 命中**。
- **原始要求**：m.md §13.10 的 27 条（`M-248…M-274`），含三条被"钉死"的设计（降级 vs 抛错的分界线、归一化先于 registry 调用、命中路径绝不写）。
- **最小修法**：新建 `tests/sessions/ensure-workspace.test.ts`，只用一个 `fakeCtx({ workspaceRegistry })` + 记录调用的 mock（`create`/`resolveByPath`/`attachSession`）。
- **需要补的断言**：`M-248`(空串返回 `''` 而非 `'.'`) `M-249`(剥尾分隔符) `M-259/268`(缺 registry：保证 `undefined` vs 抛 `workspaceRegistry is not available`) `M-257`(命中时 `title` 惰性) `M-261`(create 错误不包装)。

### G-3（P0）审批接管（42 条）只被路由层间接摸到

- **现状**：`src/sessions/approval.ts` 239 行，契约 42 条中只有 7 条 ✅；`route.test.ts` 只验证"挂住→列表→应答"一条主干。**超时、abort、注销结算、多会话隔离、升序、`APPROVAL_OUTCOMES` 深等全部无断言**。
- **原始要求**：m.md §13.5（`M-110…M-151`）。
- **最小修法**：新建 `tests/sessions/approval.test.ts`，用 `fakeCtx().invoke('approval/request', …)` 拿挂起的 Promise（现成手法见 `route.test.ts:189-194`）；`signal` 用 `AbortController`；超时用 `timeoutMs: 10` + `setTimeout` 等 30ms。
- **需要补的断言**：`M-120`(超时 → `'cancelled'`) `M-123/124`(abort 与已 abort) `M-125`(注销全收尾) `M-127`(双会话隔离) `M-128/129`(升序 + 过滤) `M-130`(`deepEqual([...APPROVAL_OUTCOMES], 四值)`) `M-149`(重复安装结算旧 bridge) `M-150`(`answerApproval(...,'maybe')==='invalid-outcome'` 且待决表仍 1 条)。

### G-4（P0）`prepend + global` 契约在测试里根本不可见

- **现状**：`tests/helpers/fake.ts:27-37` 的 `on(event, listener)` **签名里没有 options 参数**，也没有记录；因此 `WATERFALL_TAKEOVER`（`src/shared/wire.ts:117`）与两处注册（`approval.ts:169`、`questions.ts:301`）**没有任何测试能发现被删掉 `prepend`/`global`**。这是 K-174 / M-110 / M-138 / M-152 的共同盲区。
- **原始要求**：k.md `:673`（必须 `prepend: true` 才能抢在 `api/remotes` 之前）+ m.md §13.5#1、§13.6#1。
- **最小修法**：给 `fakeCtx` 的 `on` 增加第三参 `options?: DshEventOptions` 并把 `{event, options}` 记进 `listenerOptions(event)`；或在 `fake.ts` 里加 `lastOptions(event)`。改动 < 10 行，不影响现有断言。
- **需要补的断言**：`listenerOptions('approval/request')[0]` 深等于 `{prepend:true, global:true}`；`agent/pre-step` 深等于 `{prepend:true}`（**不含** `global`，K-066）。

### G-5（P1）`serviceOf` 的属性回退破坏"只认 `ctx.get`"契约

- **现状**：`src/shared/dsh.ts:184-197` 在 `ctx.get(name)` 拿不到时**退回 `ctx[name]` 属性访问**（`:195`）。后果一：`resolveAgents({ agents: {...} })` 这种"只有属性没有 `get`"的 ctx **不再抛错**；后果二：cordis 根 ctx 上 `ctx.logger` 还在，所以 `warnLedgerWriteFailure` 的第一级实际可用（K-054 的"必然 stderr"失效）。
- **原始要求**：m.md §13.2#11 明确"最后一条锁死**不再接受 `ctx.agents` 属性访问**"；k.md `:112` / `:123`。
- **最小修法**：`serviceOf` 增加参数 `{ allowProperty?: boolean }`，默认**关闭**属性回退；只给浏览器侧 `panel/surface.ts:56-67` 的独立 `serviceOf`（它自己已有一份实现）或测试 mock 打开。这样内核侧恢复"只走 `ctx.get`"。
- **需要补的断言**：`assert.throws(() => resolveAgents({ agents: {...} }), /ctx\.agents/)`（`M-011` 第 5 例）；以及"`ctx.get('logger')` 返回 undefined 时 `warnLedgerWriteFailure` 走 `process.stderr.write`"（`M-240`，可用 `process.stderr.write` 打桩）。

### G-6（P1）设计 §6.3 要求的"台账写失败 → 进程内白名单兜底"没有接线

- **现状**：`interactions/ownership.ts:57-59` 定义了 `noteMagicaSessionInMemory`，但**全仓无调用点**；两个门面的 `writeRecord` 把 `noteMagicaSession` 放在 `try` 内（`workspace.ts:296`、`ephemeral.ts:276`），`store.put` 一抛就跳过，`catch` 里只 warn（`workspace.ts:297-300`、`ephemeral.ts:277-280`）。结果：L-012 说的"审批/提问不出现在看板"**依然成立**，白名单设想的兜底是死代码。
- **原始要求**：`docs/design/00-overview.zh.md` §6.3 第三行（"写失败时同时把待决项留在进程内供同进程轮询"）；l.md §9 第 12/16 行。
- **最小修法**：在两个 `catch` 块里补一行 `noteMagicaSessionInMemory(sessionId, options.storeDir)`（`ephemeral.ts`/`workspace.ts` 已 import `noteMagicaSession`，改 import 即可）。
- **需要补的断言**：让 `store.put` 抛错（mock `SessionRecordStore` 或传只读目录）→ 断言 `state.ledgerWriteFailed === true` **且** `isMagicaSession(host, sessionId, dir) === true`（M-245 + 归属判定）。

### G-7（P1）`agentPresets` 缺失时既不 warn 也不留状态位

- **现状**：`core.ts:368-372` 直接返回 `undefined`；`core.ts:882-890` 静默跳过 mount；`SessionRunState`（`core.ts:98-113`）没有 `presetApplied` 字段。
- **原始要求**：设计 §6.3 第二行（"降级 + `warn`，并在 `state` 里留 `presetApplied: false`"）；l.md §9 第 2 行（现状是静默）。
- **最小修法**：`composeAgentScope` 在 `presets === undefined` 且 `options.presetId !== false` 时调 `warnLedgerWriteFailure(ctx, 'agentPresets unavailable …')`；在 `SessionRunState` 加可选 `presetApplied?: boolean`，`emptyRunState` 不写（保持"缺省即不出现"，与 `snapshotRunState` 的 `...(x !== undefined ? {x} : {})` 风格一致，见 `core.ts:161-166`）。
- **需要补的断言**：不传 `agentPresets` 跑一轮 → `getState().presetApplied === false`；并断言 stderr 收到一条 warn。

### G-8（P1）导出面计数类契约（K-121/122/125/126/127/128/134）全部失效

- **现状**：`package.json:11-16` 没有 `./sessions` 子入口；`src/index.ts:64` 用 `export *`；`sessions/index.ts` 是 7 值块 + 7 类型块；`core.ts` 导出块 36 条。契约的"95 = 55+33+5+2""主入口 49 / 不可达 46""index.ts 11 条 / 108 符号 / 120 去重""按文件 0/42/14/6/5/10/11/7"**一条都对不上**。
- **原始要求**：k.md `:245-309`。
- **最小修法**：写一个 `scripts/export-surface.mjs`（或一个 test）从 `lib/types/index.d.ts` 抽出符号表并落成基线文件，替代人工计数；同时在 `00-overview` 里把"95 条"标为**历史基线**。
- **需要补的断言**：一条 `it('导出面基线不变')`：`deepEqual(实际符号表, 基线)`——这样"少转出一个类型"这类事故会立刻红（K-123/K-132 提到的两类漏转出正是这样发生的）。

### G-9（P2）两个门面的"会话还活着"错误码不对称

- **现状**：`workspace.ts:225` 调 `assertSessionNotLive`（→ `SESSION_LIVE`，`core.ts:830-835`）；`ephemeral.ts:231-254` **不调**，只能靠 `agents.resume` 抛错再被 `toResumeError` 归一成 `SESSION_ALREADY_ACTIVE`（`core.ts:847-853`）。
- **原始要求**：m.md §13.4#18（临时会话活着续跑 → `SESSION_LIVE`）、l.md §9 第 25 行。
- **最小修法**：`ephemeral.ts` 的 `resumeAgent` 开头补 `assertSessionNotLive(agents, sessionId)`（与 workspace 对齐，一行 + import）。
- **需要补的断言**：`registry.get` 返回一个假 agent 后 `runEphemeralSession({sessionId})` → `getState().errorCode === 'SESSION_LIVE'`（M-101/M-094）。

### G-10（P2）提问事件日志的 `detail` 与契约有两处不一致

- **现状**：`questions.ts:218-228` 写 `question.asked` 时 `intent: question.intent?.kind`（无 intent 时是 `undefined`，JSON 序列化后被**省略**），而契约要求 `intent: kind ?? null`；另外契约要求的 `answered`/`cancelled` 两行虽有实现（`:249`），但没有任何断言；日志目录名也换成了单段 `dsh-magica-spellbook`（`:52`，K-159）。
- **原始要求**：m.md §13.6#28（事件名、`detail` 字段名与形状全部锁死，`options` 是 label 数组、`intent` 是 `kind ?? null`）。
- **最小修法**：`intent: question.intent?.kind ?? null`；`multiSelect: question.multiSelect ?? false` 同理显式化。
- **需要补的断言**：一次 asked → answered → asked → cancelled 的完整流程，断言 `events` 深等于那 4 个名字且 `asked` 行 `detail.questions[0]` 深等于 `{id, question, options:['方案 A','方案 B'], multiSelect:false, intent:null}`（`setInteractionLogger` + 内存 logger 即可，`questions.ts:91` 已留测试口）。

### G-11（P2）`injectContext` 扩散到正式会话且无任何断言

- **现状**：`WorkspaceSessionHandle` 也有 `injectContext`（`workspace.ts:110,543-548`），契约 K-145 明确它只有 8 个成员（`injectContext` 算临时会话独有，K-146）；同时 `WorkspaceSessionState`（`workspace.ts:85-101`）没有 `injectedMessages` 之类可观察位。
- **原始要求**：k.md `:426`、`:438`（K-145/K-146）。
- **最小修法**：二选一——① 在 `00-overview` §5 增补一行"正式会话也支持 `injectContext`（0.2 统一形状）"并更新 K-145/146 的基线；② 从 `WorkspaceSessionHandle` 移除。建议 ①（能力更好，成本为零）。
- **需要补的断言**：`injectContext` 在 `delivery === null`（首轮未建 agent）时返回 `false`、建好后返回 `true` 且下一拍 pre-step 追加（M-244）。

### G-12（P2）`describeTurnEnd` 的 `default` 分支无测试也无覆盖率豁免

- **现状**：`core.ts:82-83` 有 `default: return String((reason as {kind?: unknown}).kind)`，但 M-003 的"九条精确文案"不覆盖它；l.md/m.md 原实现有 `/* v8 ignore */`，现在没有。
- **原始要求**：m.md §13.9#4（该分支靠编译期断言保证不可达）。
- **最小修法**：加回 `/* v8 ignore next */`，或把 `default` 改成 `never` 兜底 + `throw`（不可达路径显式化）。
- **需要补的断言**：`assert.equal(describeTurnEnd({kind:'forked'}), 'forked (fork seed)')` 已有；补一条"未知 kind 不抛且返回字符串"（强行构造 `{kind:'weird'} as never`）。

### G-13（P3）store 的目录解析与诊断面（M-042…M-045、M-048、M-049、M-055、M-082、M-083）

- **现状**：`store.test.ts` 9 条全部走"构造 `new SessionRecordStore(dir)`"，**从不经过** `resolveStoreDir`/`getSessionStore`；因此"override 优先""`dshHomePath('storages','magica')` 的实参形状""服务缺失抛 `pass storeDir explicitly`""单例缓存""`get()` 不扫目录"全部无断言。
- **原始要求**：m.md §13.3#4/5/6/7/10/11/17/44/45。
- **最小修法**：在 `store.test.ts` 加一个 describe，用 `fakeCtx({ dshHomePath: (...s) => { calls.push(s); return join(dir, ...s) } })` + `resetSessionStores()`（`store.ts:324`）。
- **需要补的断言**：`deepEqual(calls[0], ['storages','magica'])`；`getSessionStore(ctx,dir) === getSessionStore(ctx,dir)`；20 个坏文件下 `get('good')` 正常且 `loadErrors.length===0`（未扫）→ 访问后变 20。

### G-14（P3）一批"形态差异"未在白名单登记

- **现状**：以下差异**实现成立、有能力价值**，但 §3.8/§3.9/§5 里找不到出处，因此本次只能记 ⚠️：手写结构面替代 dsh 类型（K-002/013/015/017/023/031/101/106/107/120）、零 `import type {}`（K-020/021）、`export *` 单入口（K-084/122/127）、`logger` 属性回退（K-054/L-007）、事件日志目录名单段化（K-159）、`describeTurnEnd` 多 `forked` 文案（K-148 备注）。
- **原始要求**：白名单机制本身要求"所有有意差异都要有登记"。
- **最小修法**：在 `00-overview` §5 末尾加 3 行（结构面替代、单入口 `export *`、日志单段目录），每行给 dsh 依据或真机现象。
- **需要补的断言**：无需新增行为断言；但建议给"零 `@deepseek-ai` 运行时导入"加一条 `verify` 级断言（`scripts/verify.mjs` 已有，可提为 test 也可保留）。

### G-15（P3）两个门面的 `maxTokens` / `reasoningEffort` 取舍没有断言兜底

- **现状**：workspace 刻意不支持 `reasoningEffort`（`workspace.ts:72-73` 注释），但实际创建时会**从 dsh 默认选择里透传**（`:214-219` 的 `model.reasoningEffort` 来自 `pickModel`→`resolveDefaultModel`，`core.ts:320-322`），因此 M-226（"workspace 不含 `reasoningEffort`"）与实现**语义上有张力**：调用方不能传，但默认路由带了值就会传下去。
- **原始要求**：m.md §13.8#14。
- **最小修法**：要么在文档里明确"workspace 不透传**调用方**的 `reasoningEffort`，但透传 dsh 默认选择的"，要么在 workspace 侧显式剥掉 `reasoningEffort`。
- **需要补的断言**：`agentDefaultModel.currentSelection()` 返回 `{provider,model,reasoningEffort}` 时，`workspace` 的 `agentOptions.reasoningEffort` 是 `undefined`（或按新口径断言相反）。

---

## 5. 疑似素材错误

> 指"素材本身有问题/过期/计数对不上"，**不是实现错**。建议回头修 `.e2e/audit/` 或 `docs/raw/`，否则后续核对会持续在这些点上耗时间。

| # | 位置 | 现象 | 建议 |
|---|---|---|---|
| 1 | `.e2e/audit/G5-sessions-2.md` **整文件** | 只有 K-001…K-177，末尾是 `<!--PART2-->` 占位符，**L 组与 M 组从未写入**（209 行 / 29149 字节） | 补 PART2，或把本文档 §0 的编号映射表反写回去；否则"逐条核对 L/M"没有权威输入 |
| 2 | k.md `:266`、`:290`（K-121）与 `:252`、`:268-274`（K-122） | "95 = 55 函数 + 33 类型 + 5 常量 + 2 class""主入口 49 / 不可达 46"是**0.1.6 文件布局**下的精确计数；本仓已重构（`export *` + 结构面 + 新增 6 个符号），这组数字连"下限"都不成立 | 标为"历史基线，仅用于追溯"，另出机器生成的导出面基线（见 G-8） |
| 3 | k.md `:242`/`:258`/`:290`（K-125/K-126/K-128） | 同上：`index.ts` 11 条导出、108 符号、120 去重、按文件 0/42/14/6/5/10/11/7 | 同上 |
| 4 | k.md `:399`（K-144） | "`SessionRecord` 字段完整集合（**14 个键**）"；实现是 13 个（`store.ts:37` 自述 13），l.md §12.1 也未列出第 14 个 | 回查 l.md §12.1 的 JSON 样例，确认是"13 键"还是漏了一个字段（若漏，属实现缺失而非素材错） |
| 5 | m.md §13.2–§13.8 的"行"列 | 全部指向 `tests/*.test.mjs`（0.1.6 的 7 个文件）的行号；本仓是 `tests/sessions/*.test.ts`，文件名与行号都不存在 | 覆盖表的意义会因此打折；建议把"行"列改成"测试名"或直接删掉 |
| 6 | m.md §13.1 `:7` | "共 237 条 … 一个 `test()` 一条"是 0.1.6 的口径；本仓 115→123 个 `it()`，且 §13.9 的 10 条"无断言"里有 1 条（看门狗）现在**已经被覆盖** | 更新统计口径，否则"264 条必须断言"会让读者高估缺口/低估覆盖 |
| 7 | l.md §9 第 22/23 行（L-018/L-019） | 断言"两个门面的 `runOneTurn` 都没传 `idleTimeoutMs`，能力存在但未启用"；本仓两个门面都传了（`workspace.ts:359`、`ephemeral.ts:308`），且 `timeoutSettlement` 形状已修好 | 这两行应改成"0.1.6 现状，0.2 已启用" |
| 8 | k.md `:16`–`:48`（K-002…K-037） | 把"`import type { SessionId }` 品牌类型/`import type {}` 拉 augmentation"当作契约；本仓刻意零 import，改为手写结构面（`src/shared/dsh.ts:1-12` 有说明） | 这组条目应从"dsh 组件清单"降级为"结构面等价物"，否则会产生大量假 ⚠️ |
| 9 | k.md `:123`（K-054）与 `:129`（K-055） | 文字写"服务名是 `userApproval`"，而 `00-overview` §4.3 明确写"服务名分别是 `userQuestions` 和 **`approval`**（不是 `userApproval`）"——两处素材自相矛盾 | 以 00-overview §4.3 为准（该条已对齐 dsh 源码），修 k.md 的措辞 |
| 10 | k.md `:426`/`:438`（K-145/K-146） | 把 `injectContext` 当作临时会话**独有**能力；实现里两个门面都有（`workspace.ts:110`、`ephemeral.ts:123`） | 要么是素材漏了 workspace 的成员，要么是实现多给了；需一次明确判定（见 G-11） |

---

## 6. 核对方法（可复现）

1. 需求：`Get-Content -Encoding UTF8 .e2e/audit/G5-sessions-2.md`（实测 209 行 / K 行 177 条；L/M 为 0 条）+ `docs/raw/l.md:3-40`（§9，36 行）+ `docs/raw/m.md:13-342`（§13.2–§13.10）。
2. 实现：逐文件通读 `src/sessions/{core,store,workspace,ephemeral,approval,questions,ensure-workspace,index}.ts`、`src/interactions/{route,ownership,collect,index}.ts`、`src/client/panel/{surface,carrier,Composer,index}.ts`、`src/shared/{dsh,wire}.ts`。
3. 断言：`tests/**/*.test.ts` 全量通读（12 个文件、123 个 `it()`），覆盖判定只认"改行为会变红"的断言。
4. 白名单：`docs/design/00-overview.zh.md:339-463`（§3.8 / §3.9 / §5 适配矩阵 26 行）。
5. 未执行：`pnpm test` / `pnpm typecheck` / `pnpm build`（本任务只读）。






## 修复记录（Round 2–3）

| 项 | 改动 | 回归 |
|---|---|---|
| G-2（ensure-workspace 零测试） | 新增 	ests/sessions/ensure-workspace.test.ts（9 例：路径归一、只查不建、复用、创建并挂载、fail-loud、空路径拒绝） | 已绿 |
| G-11（ownership 正结果永不失效） | isMagicaSession 不再缓存正结果；
oteMagicaSession 才进白名单，且白名单有 4096 上限 | 新增 	ests/interactions/ownership.test.ts（6 例） |
| G-4（ake.ts 的 on() 丢 options） | 待办（下一轮：让 fake 记录第三参，断言 prepend+global） | — |
| G-1（unWorkspaceSession 零测试） | 待办（下一轮） | — |

### Round 4 补充

| 项 | 改动 | 回归 |
|---|---|---|
| G-1（unWorkspaceSession 零测试） | 新增 	ests/sessions/workspace-facade.test.ts（9 例：cwd/preset/attach/台账 kind/attach 失败降级/registry 缺失/title 钉住/humanInteraction 装接管/续跑沿用 createdAt/fiber 卸载自动 dispose） | 已绿 |
| G-4（ake.ts 丢 on() 第三参） | FakeCtx 记录注册选项并暴露 listenerOptions(event) | 新增 	ests/sessions/waterfall-options.test.ts（断言审批/提问都是 {prepend:true, global:true}） |
| E-154（APPROVAL_OUTCOMES 无断言） | Object.freeze + isApprovalOutcome() 守卫；说明"零 import 下无法跨包编译断言" | 	ests/sessions/approval-outcomes.test.ts（精确元组/冻结/守卫） |
| GAP-6（ok() 无 headersSent 守卫） | ok() 首句加 if (response.headersSent) return | 与 ail() 对齐 |

### Round 6 补充

| 项 | 改动 | 回归 |
|---|---|---|
| pproval 27 条契约只覆盖 8 条 | 新增 	ests/sessions/approval.test.ts（13 例：挂住/结算、timeout、已 abort、挂住中 abort、注销结算、多会话隔离、重复安装、since 排序、resolveArgs 反查、displayReason 透传、未知 id/会话、非法 decision 不结算） | 已绿 |
| store 26 条契约 | 补 4 例：覆盖写保留 createdAt、损坏 JSON → loadErrors、list 跳过坏文件并按 createdAt 降序、**未知字段不落库** | 已绿 |
| 台账未做字段白名单（真实缺陷） | put() 从 {...input} 改为**逐字段投影**（未知字段不再写进 JSON 契约文件） | 上面那条用例会红 |
| plan-review 真机取证 | e2e 宿主加 POST /e2e/synthetic-question（真实 cordis waterfall 造待决提问），新增 loop-plan-review.mjs | 真机通过：徽标/推荐标记/批准提交/emaining=0 |

### Round 7 补充

| 项 | 改动 | 回归 |
|---|---|---|
| questions 剩余契约 | 新增 	ests/sessions/questions-contracts.test.ts（8 例：合法答案/自由文本、**10 种非法形状一律 invalid-answer 且不结算**、未知会话与未知 id、多题部分作答、list 过滤与排序、fail-fast 语义（reject 而非空答案）、注销以拒绝收尾） | 已绿 |
| 答案形状零校验（真实缺陷） | nswerQuestion 现在做库层校验（id 必须属于待决请求、不得重复、selected 必须是非空字符串数组、custom 必须是字符串），非法返回 invalid-answer；HTTP 层映射 400 invalid_input | 上面那组用例会红 |
