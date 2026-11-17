# 05 · sessions 一致性核对（A 卷：需求 I-001…I-125 + 重点核对项）

> **性质**：只读核对。未修改任何源码、未运行任何测试。
> **需求来源**：`.e2e/audit/G4-sessions-1.md`（逐条表 I-001…I-125）+ `docs/raw/j.md`（重点机制，**因 G4 的 J 段整段缺失**，见 §5 第 1 条）。
> **实现**：`src/sessions/{core,store,workspace,ephemeral,approval,questions,ensure-workspace,index}.ts`（8 文件 / 3236 行）。
> **测试**：`tests/sessions/{core,facade,observers,questions,store}.test.ts`（5 文件 / 926 行 / 61 个 `it`）。
> **有意差异白名单**：`docs/design/00-overview.zh.md` §3.8（5 条真机差异）、§3.9（落地状态）、§5（26 行 0.2 适配矩阵）。
>
> 约定：证据列的 `core.ts:36-44` 均为 `src/sessions/<文件>`；`test: '…'` 指 `tests/sessions/*.test.ts` 里的 `it(...)` 标题。行号以核对时文件实际内容为准。

---

## 1. 统计

| 口径 | ✅ 一致 | ⚠️ 有差异 | ❌ 缺失 | ✅ 有意差异（白名单命中） | 合计 |
|---|---|---|---|---|---|
| I-001…I-125（G4 逐条表） | **113** | **8** | **0** | **4** | 125 |
| J-S01…J-S14（重点核对项，素材 J 段缺失后以 `docs/raw/j.md` 补） | **8** | **1** | **1** | **4** | 14 |
| **合计** | **121** | **9** | **1** | **8** | **139** |

- ⚠️ 的 8 条：I-001、I-003、I-004、I-005、I-016、I-041、I-100、I-101；补核 1 条：J-S06。
- ❌ 的 1 条：J-S12（门面级 `ctx.effect` 兜底 `dispose()` 缺失，`j.md:45`/`j.md:191` 明确要求）。
- 有意差异 8 条全部命中白名单，未发现"未申报的功能删减"：I-018（§5 #1）、I-065/I-066（§3.8 #3 · §5 #25）、I-089（§3.8 #5）、J-S04（§5 #1）、J-S08（§3.8 #5）、J-S13（§3.8 #2 · §5 #24）、J-S14（§3.8 #4 · §5 #26）。
- 结论口径：**内核（`core.ts`/`store.ts`）几乎零漂移**，差异与缺口集中在**两个门面**（`workspace.ts` 无任何测试、无 fiber 兜底、TTL 文案未修）与**续跑错误归一化**。

---

## 2. 大表（逐条，I-001…I-125）

| ID | 状态 | 证据（src:行号 或 test 名） | 差异说明 |
|---|---|---|---|
| I-001 | ⚠️ 有差异 | `core.ts`…`index.ts` 共 8 文件、3236 行（`Get-ChildItem` 实测） | 文件数 8 一致；行数 5046/非空 3772 是 0.1.6 口径，本仓重写后为 3236/2890；包名与版本按 0.2 线为 `dsh-magica-spellbook`，非 `@amazing-tools/dsh-magica@0.1.6-rc.26` |
| I-002 | ✅ 一致 | `index.ts:1-135`；根入口 `src/index.ts:64` 仅 `export * from './sessions/index.ts'` | 唯一再导出点成立；两个会话门面 `runWorkspaceSession`(`index.ts:87`) / `runEphemeralSession`(`index.ts:76`) 都在 |
| I-003 | ⚠️ 有差异 | `index.ts:18,21,29,30,31,34-35,39` | 与要求**相反**：`resolveAgents`/`resolveAgentPresetId`/`runTurnVerified`/`emptyRunState`/`snapshotRunState`/`releaseRunState`/`warnLedgerWriteFailure` 七个全部经 `index.ts` 转出，且根入口 `export *` 使它们成为公开 API |
| I-004 | ⚠️ 有差异 | `index.ts:106`（`ApprovalAnswererOptions`）、`index.ts:124`（`QuestionAnswererOptions`） | 与要求相反：两个选项类型都被转出 |
| I-005 | ⚠️ 有差异 | `core.ts:14-33`（同目录只 `import type { SessionRecord }`）；`store.ts:15` | core.ts 合规；但 `store.ts` 并非"无内部依赖"——它 `import { serviceOf } from '../shared/dsh.ts'`（**值**导入，非类型） |
| I-006 | ✅ 一致 | `grep '@deepseek-ai' src/sessions` 仅命中 `store.ts:121` 的错误提示字符串 | 100% host 侧；无 client 包 import、无 slot、无 CSS |
| I-007 | ✅ 一致 | `store.ts:116-124`（`home('storages','magica')` + `store.ts:21` 子目录 `sessions`） | `$DSH_HOME/storages/magica/sessions/<id>.json` |
| I-008 | ✅ 一致 | `core.ts:722-763`；test: '交叉验证：whenIdle 归来后取本轮最后一条 turn/end' | `whenIdle()` 只判活动归零，结局取本轮新增 `turn/end` 末条 |
| I-009 | ✅ 一致 | `workspace.ts:549-556`（`cancel(cause,{keepInbox:true})`）、`workspace.ts:442-453`（`dispose`） | 两者独立，`dispose` 不复用 cancel |
| I-010 | ✅ 一致 | `core.ts:448-449`（先比对 `session.id` 再分派）、`core.ts:879`（在 `agentCtx` 上装）；test: '只处理本会话的事件（纵深防御）' | 监听装在 agent scope，仍显式比对 id |
| I-011 | ✅ 一致 | `core.ts:591-596`；`workspace.ts:200` / `ephemeral.ts:207`（`resumed ? [] : contexts`） | 追加在 `decision.messages` **末尾**、只投一次、续跑不重投 |
| I-012 | ✅ 一致 | `core.ts:381-393`（`resolveAgentPresetId` 不传参取默认）+ `core.ts:882-890`（`mount`）；`workspace.ts:207` | 不指定 preset 时挂默认 preset，`mount(ctx, undefined)` 由 dsh 选默认 |
| I-013 | ✅ 一致 | `core.ts:799-820`；test: '台账不可用 / 无记录 / kind 不符 → 新建'、'命中且 kind 一致 → 续跑' | 台账是唯一凭证，无记录则忽略传入 id |
| I-014 | ✅ 一致 | `store.ts:168-189`（坏文件只 `recordError`）；`store.ts:285-298`（解析不出→`null` 降级）；`store.ts:229`（仅 ENOENT 不算错误） | test: 'get 未命中返回 null（ENOENT 不记 loadErrors）'、'版本比本 build 新 → 跳过并记一条错误'、'缺 sessionId / kind → not a session record' |
| I-015 | ✅ 一致 | `wire.ts:117`、`approval.ts:169,195`、`questions.ts:301,345` | 三处审批/提问接管全用 `WATERFALL_TAKEOVER`；`agent/pre-step` 只 `{prepend:true}`（`core.ts:598`）是 agent-scope 注册，`00-overview.zh.md:402` 明确不需要 `global` |
| I-016 | ⚠️ 有差异 | `core.ts:670-707`（effect 兜底）、`workspace.ts:410-440`、`ephemeral.ts:365-395` | 监听/审批/提问/上下文投递/timer 都有回收点，但**两个门面都没有门面级 `ctx.effect(() => () => void dispose())`**（`j.md:45,191` 要求），fiber 卸载时 agent handle 与 observers 不会被回收 → 见 GAPS G1 |
| I-017 | ✅ 一致 | `src/shared/dsh.ts:1-213`（结构面手抄）；`core.ts:187-192,198-203,206-208` | 构建产物零运行时 `@deepseek-ai/*` 导入；品牌在构造点本地断言 |
| I-018 | ✅ 有意差异 | `core.ts:36-44`（7 个，含 `forked`）；test: 'TURN_END_KINDS 是 7 个且顺序锁定（0.2 新增 forked）' | 白名单 §5 #1：0.2 `TurnEndReasonMap` 多 `forked`（dsh `packages/core/session/src/types.ts:201-229`），常量表同步为 7 个 |
| I-019 | ✅ 一致 | `core.ts:48-55`（双向条件类型断言 `KindsMatchDsh`） | 命名从 `_KindsMatchDsh` 变为 `_assertKindsMatchDsh`，断言强度不变，且紧邻常量表 |
| I-020 | ✅ 一致 | `core.ts:58-60`；test: '只有 completed 算完成，undefined 不算' | 只认 `kind==='completed'` |
| I-021 | ✅ 一致 | `core.ts:62-85` | 只产英文短语，本地化交调用方 |
| I-022 | ✅ 一致 | `core.ts:64`；test: 'describeTurnEnd 的 9 条精确文案' | `no turn/end observed` |
| I-023 | ✅ 一致 | `core.ts:66-67` | `completed` |
| I-024 | ✅ 一致 | `core.ts:68-69` | `aborted (<reason.reason.kind>)` |
| I-025 | ✅ 一致 | `core.ts:70-71` | `blocked` |
| I-026 | ✅ 一致 | `core.ts:72-75` | `error: <message ?? 'unknown'>` |
| I-027 | ✅ 一致 | `core.ts:73`（`(reason.error as {message?:string})` + `?? 'unknown'`）；test: `error: unknown` | 描述函数不抛 |
| I-028 | ✅ 一致 | `core.ts:76-77` | `output truncated (max-tokens)` |
| I-029 | ✅ 一致 | `core.ts:78-79` | `interrupted (crash recovery)` |
| I-030 | ✅ 一致 | `core.ts:82-83` | `String(reason.kind)` 防御分支保留 |
| I-031 | ✅ 一致 | `core.ts:722-728`（第 4 参 `alreadyDelivered = false`） | 签名一致 |
| I-032 | ✅ 一致 | `core.ts:729-732` | 先记两个基线再投递 |
| I-033 | ✅ 一致 | `core.ts:732` | 仅 `!alreadyDelivered && message!==undefined` 才 `followup` |
| I-034 | ✅ 一致 | `core.ts:734`（`idleTimeoutMs !== undefined && > 0`） | 不传/0/负 = 不设上限 |
| I-035 | ✅ 一致 | `core.ts:735-742`（`Promise.race([idle, timeout])`，`timer.unref?.()` 于 738） | timer 必须 unref |
| I-036 | ✅ 一致 | `core.ts:745`；test: '看门狗：whenIdle 不收敛 → aborted + timedOut，且取消原因可判读'（断言 `hook:magica:idle-timeout`） | 原因字符串逐字一致 |
| I-037 | ✅ 一致 | `core.ts:710-719`（`timeoutSettlement`）+ `core.ts:749` | `{kind:'aborted',completed:false,timedOut:true}` |
| I-038 | ✅ 一致 | `core.ts:752` | 无看门狗直接 `await whenIdle()` |
| I-039 | ✅ 一致 | `core.ts:755-756` | 取本轮新增末条 |
| I-040 | ✅ 一致 | `core.ts:757-762` | `{reason?,kind?,completed,texts,externallyDisposed}` |
| I-041 | ⚠️ 有差异 | `core.ts:710-719`（`timeoutSettlement` 返回**完整** `reason: {kind:'aborted', reason:{kind:'hook', reason:'magica:idle-timeout'}}`） | 0.1.6 的超时结算故意构造缺 `reason` 的残缺对象、要消费方靠 `timedOut` 规避；0.2 实现改成形状完整（`as` 断言也去掉了），消费方无需规避。**改进型差异**，但需求文本需改写（见 §5 第 4 条） |
| I-042 | ✅ 一致 | `workspace.ts:152,340`（`ttlMs === undefined || !(ttlMs > 0)` → 无上限） | 正式会话默认无 TTL，故保留可选硬兜底 |
| I-043 | ✅ 一致 | `core.ts:412-417,548-559` | 返回幂等注销器 |
| I-044 | ✅ 一致 | `core.ts:418-420`（`offs` / `disposed` / `openApprovals`） | 内部状态恰三项 |
| I-045 | ✅ 一致 | `core.ts:435-443`（`safeHook`）、`core.ts:422-433`（logger→stderr） | 5 个钩子异常被吞并记一条日志。日志前缀是 `[spellbook]`（0.1.6 是 `[dsh-magica]`），随包名变更 |
| I-046 | ✅ 一致 | `core.ts:449` 在 `switch`(451) 之前 | 先比对 id 再分派 |
| I-047 | ✅ 一致 | `core.ts:452-459`（非空才 push） | 空文本不入 `state.messages` |
| I-048 | ✅ 一致 | `core.ts:461-463`（`typeof reason.kind !== 'string'` 整条忽略；`turn` 缺省 = `length+1`，**在 push 之前**计算） | 一致 |
| I-049 | ✅ 一致 | `core.ts:464-468`；test: 'turn/end 记结局、写 outcome、清空未配对审批' | 四件事齐备 |
| I-050 | ✅ 一致 | `core.ts:471-481` | key=`String(id)`、`since=event.time`；`id===''` 直接返回比 0.1.6（会记成 `'undefined'`）更严 |
| I-051 | ✅ 一致 | `core.ts:483-498`（`waitedMs = Math.max(0, at - since)`）；test: 'approval/asked + decided 配对出 waitedMs' | 配对出表 |
| I-052 | ✅ 一致 | `core.ts:500-504` | 仅接受 `'ask'`/`'never'` |
| I-053 | ✅ 一致 | `core.ts:505-508` | `sandboxMode = mode` |
| I-054 | ✅ 一致 | `core.ts:510-514` | `planMode = active` |
| I-055 | ✅ 一致 | `core.ts:515-521`；test: 'sandbox/mode、plan/mode、approval/policy、tool/call\|result 都进状态或钩子'（断言原始 JSON 串） | `arguments` 原样透传，不解析 |
| I-056 | ✅ 一致 | `core.ts:523-527` | 取 `data.message.source.callId` |
| I-057 | ✅ 一致 | `core.ts:466-467` | `turn/end` 时 `openApprovals.clear()` |
| I-058 | ✅ 一致 | `core.ts:538-546`（第二个 try 块）；test: 'agent/disposed 置 externallyDisposed' | 单独注册 |
| I-059 | ✅ 一致 | `core.ts:447/534`、`core.ts:538/544` | 两个 `on` 各自 try/catch 降级 |
| I-060 | ✅ 一致 | `core.ts:548-559`；test: '注销后不再收事件' | 幂等 + 逐个 try + `offs.length=0` |
| I-061 | ✅ 一致 | `core.ts:396-409`；test: 'extractAssistantText 多 block 用 join("")，过滤 reasoning/tool-call' | 只取 text block、trim、空返 null |
| I-062 | ✅ 一致 | `core.ts:187-192`；test: 'mintMessageId 连续 200 次不重复' | `magica-msg-<ts36>-<seq36>-<6 位随机>` |
| I-063 | ✅ 一致 | `core.ts:186`、`core.ts:206-208`（`asSessionId` 单点 no-op） | 不 import dsh 品牌函数 |
| I-064 | ✅ 一致 | `core.ts:211-219`；test: 'buildUserMessage：source 只有 user，字符串数组 → 多 block' | `source.kind='user'`，多 block，独占 turn |
| I-065 | ✅ 有意差异 | `core.ts:235-258`（kind=section 或 `spellbook-context`，保留 `plugin`/`form`/`sections`）；test: 'buildPluginMessage 具名：section 名当 kind，且带 form + sections' | 白名单 §3.8 #3 + §5 #25：v4 拒绝 `kind:'plugin'`，必须发生产者自有的具名 kind |
| I-066 | ✅ 有意差异 | `core.ts:222,240-245`（无名分支改用 `DEFAULT_CONTEXT_KIND='spellbook-context'`）；test: 'buildPluginMessage 无名：用默认 kind（v4 拒绝 plugin 这个 kind）' | 同上（§5 #25）；`section==='plugin'` 直接抛错（`core.ts:241-245`），比 0.1.6 多一道闸门 |
| I-067 | ✅ 一致 | `core.ts:230-231`（注释明确 GUI 上下文行显示 section 名）、`core.ts:246-251` | `plugin` 字段两条分支都保留 |
| I-068 | ✅ 一致 | `core.ts:264-282`；test: 'toContextEntries 归一与丢弃' | 空串/非对象/无 text 静默丢弃，空 name 退化为无名 |
| I-069 | ✅ 一致 | `core.ts:563-566`、`core.ts:604-618` | `push`/`dispose` 形状一致 |
| I-070 | ✅ 一致 | `core.ts:591-596`；test: 'reject 时不动，上下文继续等下一个 step' | 先 `await next()`，pending 空或 reject 不消费 |
| I-071 | ✅ 一致 | `core.ts:585-599`（`{ prepend: true }` 于 598） | 注册形式一致 |
| I-072 | ✅ 一致 | `core.ts:568-574`（注释说明 `prepend` 使其在 `next()` 之后追加） | 落在模型请求最后一条 |
| I-073 | ✅ 一致 | `core.ts:596`（`[...(decision.messages ?? []), ...batch]`） | 比官方 `lastClaimedIndex+1` 更靠后，符合要求 |
| I-074 | ✅ 一致 | `core.ts:592-596`；test: 'reject 时不动，上下文继续等下一个 step' | 只在首个 enter step 追加一次 |
| I-075 | ✅ 一致 | `core.ts:604-608`（`push` 只追加队列）；test: 'push 的条目在下一次 step 投递，且 dispose 后不再投' | 投递后不自我注销 |
| I-076 | ✅ 一致 | `core.ts:609-617`（`dispose` 内 `try { off?.() } catch`） | 回收点 = agent scope 销毁或显式 dispose |
| I-077 | ✅ 一致 | `core.ts:622` | `'workspace-write'` |
| I-078 | ✅ 一致 | `core.ts:625-637`；test: 'resolvePermission 三级回退' | 显式 → `defaultPreset` → 常量 |
| I-079 | ✅ 一致 | `core.ts:629-634`（`defaultPreset` 读取包 try/catch） | 服务已 dispose 也不抛 |
| I-080 | ✅ 一致 | `core.ts:643-663`（`'preset'\|'sandbox'\|'none'`）；test: 'applyPermission：预设可用走 preset，read-only 降级 sandbox' | 三态 |
| I-081 | ✅ 一致 | `core.ts:649-655` | `permissionPresets.set()` 成功即 `'preset'` |
| I-082 | ✅ 一致 | `core.ts:657-659` | 降级只写 `sandbox/mode` |
| I-083 | ✅ 一致 | `core.ts:653-655`（set 抛错→降级）；test 同上（mock `unknown preset "read-only"`） | `'read-only'` 不是预设名 |
| I-084 | ✅ 一致 | `core.ts:657-659`（降级路径不碰 approval policy） | 越界仍走审批，不被 `never` 拒死 |
| I-085 | ✅ 一致 | `core.ts:670-675`（`register: () => () => void` 回调形式） | 保留 dsh `Events` 增强类型检查 |
| I-086 | ✅ 一致 | `core.ts:680-686`（register 抛错→`onUninstall?.()` + 返回 `() => {}`） | 不接管、收尾 |
| I-087 | ✅ 一致 | `core.ts:688-703`（闸门→`off()`→`onUninstall()`→`effectDisposer()`） | 顺序一致 |
| I-088 | ✅ 一致 | `core.ts:699`、`core.ts:705`（`effectOf`）；test: 'ctx.effect 兜底登记存在（副作用可逆）'（`ctx.effects() >= 1`） | 会调用 `ctx.effect` 的 disposer 摘登记 |
| I-089 | ✅ 有意差异 | `core.ts:766-770`（4 个码：多 `SESSION_ALREADY_ACTIVE`）；`core.ts:847-853`；test: 'toResumeError：活动写 handle → SESSION_ALREADY_ACTIVE（真机回归）' | 白名单 §3.8 #5：0.2 同一 sessionId 只允许一个写 handle，真机只给字符串，故新增该分类 |
| I-090 | ✅ 一致 | `core.ts:773-781`（`readonly code`、`super(message, options)` 透传 cause、`name='SessionResumeError'`） | 调用方按 code 分支 |
| I-091 | ✅ 一致 | `core.ts:799-805` | 签名一致（`mintNew?` 第 5 参） |
| I-092 | ✅ 一致 | `core.ts:815` | store 为 null 或 id 空 → mint |
| I-093 | ✅ 一致 | `core.ts:816-817` | 无记录 → mint 并忽略 id |
| I-094 | ✅ 一致 | `core.ts:818` | kind 不符 → mint，绝不改写 |
| I-095 | ✅ 一致 | `core.ts:819` | 其余 → resume 并带出 record |
| I-096 | ✅ 一致 | `core.ts:797-798` 注释 + `core.ts:818`；test: '跨门面误用：把正式会话 id 传给临时门面 → 新建并忽略' | 防跨门面误用 |
| I-097 | ✅ 一致 | `core.ts:195,808-812`；test: '自定义铸造器要过 SESSION_ID_SAFE' | 自定义 id 必须匹配正则，否则抛 |
| I-098 | ✅ 一致 | `core.ts:195` vs `store.ts:24`；test: '允许的字符集与长度' | `SESSION_ID_SAFE` 不允许点号，比 `SAFE_ID` 更严 |
| I-099 | ✅ 一致 | `core.ts:823-836`（`agents.get` 抛错即按"不活"返回）；调用点 `workspace.ts:225` | 函数行为一致。**临时门面未调用**（`ephemeral.ts:231-254`）→ 见 GAPS G4 |
| I-100 | ⚠️ 有差异 | `core.ts:841-844`（结构化 `code.startsWith('SESSION_')` → 一律 `SESSION_LOG_MISSING`）+ `core.ts:854-858`（正则兜底）；test: 'toResumeError：结构化 code 优先，正则兜底' | 正则部分与要求一致；但**结构性 code 分支过宽**：任何 `SESSION_*`（如 `SESSION_QUERY_CORRUPT_SESSION` / `SESSION_QUERY_PERSISTENCE_FAILED`）都会被判成"日志缺失"，与 I-101 冲突 → GAPS G6 |
| I-101 | ⚠️ 有差异 | `core.ts:859` | 无 code 且不匹配正则的错误确实原样返回；但被上一条的结构化分支拦截的 `SESSION_*` 故障会被伪装成日志缺失 |
| I-102 | ✅ 一致 | `core.ts:870-878` | 字段与返回类型一致（含 `readonly`） |
| I-103 | ✅ 一致 | `core.ts:879-903`（observers→preset→userSetup）；test: '顺序：观察者 → preset → setup；setup 抛错时回滚监听'（`calls === ['mount','setup']`） | 顺序固定 |
| I-104 | ✅ 一致 | `core.ts:879`（第一行就是 `installObservers`） | 最早安装 |
| I-105 | ✅ 一致 | `core.ts:882-890`（`presetId !== false` → `mount(agentCtx, presetId)`；`readPresetId(mounted) ?? options.presetId`） | 一致 |
| I-106 | ✅ 一致 | `core.ts:887-889`（无 preset 服务时记调用方给的 id） | 一致 |
| I-107 | ✅ 一致 | `core.ts:894-902`（`typeof result.commit !== 'function'` → 抛，信息点明 `is not a function`） | 一致 |
| I-108 | ✅ 一致 | `core.ts:909-916`（`try { unsubscribe() } catch` 后 rethrow）；test 同上（断言 `listenerCount('session/event') === 0`） | 一致 |
| I-109 | ✅ 一致 | `core.ts:896-900` | 返回空函数会被显式拦下并给出可读错误 |
| I-110 | ✅ 一致 | `src/shared/dsh.ts:83-91`（两参签名）、`src/shared/dsh.ts:82-85`（只有 `commit()`） | 一致（0.2 起 `setup` 是两参，§5 #9） |
| I-111 | ✅ 一致 | `workspace.ts:205-222`、`ephemeral.ts:212-229`（先 `resolveAgentPresetId` 再 `agents.create`） | 创建前取具体 id |
| I-112 | ✅ 一致 | `core.ts:388-392`（任何一步失败 → `undefined`） | 让 `mount()` 报真正的错 |
| I-113 | ✅ 一致 | `core.ts:374-378`（读 `id` 字符串） | 不依赖 `AgentPreset` 类型 |
| I-114 | ✅ 一致 | `core.ts:357-365`；test: 'resolveAgents 缺失 / 形状不符都抛可读错误' | 经 `serviceOf`（`ctx.get` 优先，`src/shared/dsh.ts:184-197`）取；属性兜底属可见偏差但只在 `get` 拿不到时生效 |
| I-115 | ✅ 一致 | `core.ts:360-362`（提示 `inject: ["agents"]`） | 一致 |
| I-116 | ✅ 一致 | `core.ts:920-935`（logger→stderr→放弃） | 三级降级一致；前缀为 `[dsh-magica-spellbook]`（包名变更） |
| I-117 | ✅ 一致 | `store.ts:116-124` | 路径一致 |
| I-118 | ✅ 一致 | `store.ts:120-123`（无 override 且无 `dshHomePath` → 抛错并提示传 `storeDir`） | 一致（`getSessionStore` 在外层吞掉转成 `null` 降级，符合 I-014） |
| I-119 | ✅ 一致 | `store.ts:253`；test: 'put 原子写：2 空格缩进 + 末尾换行，且能读回' | 一致 |
| I-120 | ✅ 一致 | `store.ts:38-58`（13 字段：version/sessionId/kind/createdAt/updatedAt/model?/permission?/cwd?/workspaceId?/workspacePath?/agentPresetId?/title?/customSetup?） | 一致 |
| I-121 | ✅ 一致 | `store.ts:18`；test 断言 `version === STORE_VERSION` | `STORE_VERSION = 1` |
| I-122 | ✅ 一致 | `store.ts:88-94`（缺 `sessionId`/`kind` 即非记录；`kind` 只两值） | 一致 |
| I-123 | ✅ 一致 | `store.ts:100-104`、`store.ts:238-241`（`createdAt` 降序）、`store.ts:244-250`（每次 put 刷新 `updatedAt`）；test: 'list 按 createdAt 降序' | 一致 |
| I-124 | ✅ 一致 | `store.ts:30-35`、`store.ts:77-86` | 一致（`reasoningEffort` 仅临时会话写，见 I-125 相邻说明） |
| I-125 | ✅ 一致 | `store.ts:111`；`workspace.ts:294`；`ephemeral.ts:274` | 只记布尔标记 |

---

## 3. 补充核对表（重点核对项 · J-S01…J-S14）

> G4 的 J 段整段缺失（见 §5 第 1 条），下列条目直接以 `docs/raw/j.md` 的原文行号为依据。ID 前缀 `J-S` 为本卷补编，不对应素材里的 J-###。

| ID | 状态 | 证据（src:行号 或 test 名） | 差异说明 |
|---|---|---|---|
| J-S01 | ✅ 一致 | `workspace.ts:60-82` / `ephemeral.ts:78-96`；佐证 `j.md:51-62` 差异表 | 两个门面的 options 逐字段对齐：正式有 `workspaceId/workspacePath/title/permission/humanInteraction`、无 `sandbox`/`reasoningEffort`；临时有 `cwd/sandbox/noInteraction`、无 workspace/标题/`humanInteraction`；两者都有 `sessionId/newSessionId/contextPlugin/context/agentPresetId/setup/model/onText/onTurnEnd/ttlMs/idleTimeoutMs/storeDir`。默认值：`DEFAULT_SANDBOX='workspace-write'`(`ephemeral.ts:66`)、`DEFAULT_TTL_MS=30min`(`ephemeral.ts:69`)、正式 TTL 缺省无上限(`workspace.ts:152`) |
| J-S02 | ✅ 一致 | `workspace.ts:399-408`、`ephemeral.ts:354-363`（`firstTurn ??= startFirstTurn().catch(...)`）；佐证 `j.md:618` | **`firstTurn` 永不 reject**（错误只经 `getState().error/errorCode`）；`followup` 会 reject（test: 'dispose 之后 followup 直接抛 session disposed'）；`wake()` 失败会 reject（`workspace.ts:462-467`）；`dispose()` 不 reject（内部全部 try/catch） |
| J-S03 | ✅ 一致 | `workspace.ts:522-541`、`ephemeral.ts:476-493`；佐证 `j.md:27-43` | getState 现场拼：`snapshotRunState` 数组副本 + `resumed` + `pendingApprovals`/`pendingQuestions` 实时快照 + 可选 `attachError`/`workspaceAttached`（正式）；临时恒空数组(`ephemeral.ts:490-491`)。实现多一个可选 `ledgerWriteFailed`（只增不减，不破坏调用方） |
| J-S04 | ✅ 有意差异 | `core.ts:36-44,80-81`；佐证 `j.md:482-492`（0.1.6 映射表只 6 种 + undefined） | 7 种 kind 与文案全部落地；第 7 种 `forked` 的文案 `forked (fork seed)` 在素材里**没有依据**（白名单 §5 #1 只要求常量表变 7 个）→ 见 §5 第 3 条 |
| J-S05 | ✅ 一致 | `core.ts:734-753`；`workspace.ts:359`、`ephemeral.ts:308`（真正传入 `options.idleTimeoutMs`）；test: '看门狗：whenIdle 不收敛时首轮以 timedOut 结束而不是永久挂起' | 阈值 `>0` 才生效；门面层真正接线（0.1.6 是死代码，§5 #10）；触发后 `cancel({hook, magica:idle-timeout},{keepInbox:true})` 并返回 `timedOut:true` |
| J-S06 | ⚠️ 有差异 | `workspace.ts:346`（`会话超时（${Math.round(ttlMs / 60_000)} 分钟未完成）`）vs `ephemeral.ts:149-156,298`（`formatDuration`） | TTL 阈值/per-turn 计时/超时后 `void dispose()` 与 `j.md:23-25` 一致；但 §3.8 末段"新增 `formatDuration` 修掉「0 分钟未完成」"**只修了临时门面**，正式门面 `ttlMs:120` 仍显示「0 分钟未完成」→ GAPS G2 |
| J-S07 | ✅ 一致 | `store.ts:244-257`（tmp+rename、2 空格、`\n`）、`store.ts:260-279`（先删盘再删缓存）、`workspace.ts:455-483`（wake 四步）；佐证 `j.md:1-19,92` | wake 幂等闸门、等上一次 dispose 落地、`reattached` 在 resume 前置位、`disposed` 先解锁再 resume、并发释放回收新 handle、`state.error=null` 全部命中；台账续跑沿用原 `permission`/`cwd`(`ephemeral.ts:265-266`)、正式沿用 `permission`/`title`(`workspace.ts:277-293`) |
| J-S08 | ✅ 有意差异 | `core.ts:766-770,839-860`；`workspace.ts:224-245`、`ephemeral.ts:231-254`（两条 resume 都过 `toResumeError`） | 白名单 §3.8 #5：`SESSION_ALREADY_ACTIVE` 为新增分类；结构（结构化 code→正则兜底→原样返回）与 `j.md:594-599` 一致，另加 `SESSION_SETUP_REQUIRED` 校验(`workspace.ts:226-232`)。临时门面无 `assertSessionNotLive` → GAPS G4 |
| J-S09 | ✅ 一致 | `workspace.ts:247-267`（`registry.get` → `attachSession` → 成功置 `workspaceAttached`/失败置 `attachError`）、`workspace.ts:378`（首轮消息之前 attach）、`workspace.ts:481`（wake 后重 attach）；佐证 `j.md:418` | 竞态处理一致：attach 在 agent 建好之后、首轮消息之前，失败静默降级为 `attachError`、`meta.cwd` 用归一后的 workspace 路径以满足 dsh 的严格比对（§5 #14）。`registry.get` 抛错未包 try → GAPS G10 |
| J-S10 | ✅ 一致 | `workspace.ts:377`（首轮消息 391 之前）、`ephemeral.ts:338`（首轮 346 之前）、`workspace.ts:480`/`ephemeral.ts:435`（wake 后重装）；`approval.ts:157-176`、`questions.ts:288-309` | 安装时机早于首轮；注册在**插件级 ctx** 上并用 `WATERFALL_TAKEOVER` 抢在 `api/remotes` 之前（`j.md:135-137,518-541`）；同 sessionId 重装先结算旧 bridge(`approval.ts:94-98`、`questions.ts:203-207`) |
| J-S11 | ✅ 一致 | `core.ts:879-903`；test: '顺序：观察者 → preset → setup；setup 抛错时回滚监听' | 先装监听 → 再挂 preset → 最后跑调用方 setup，任一步抛错回滚监听 |
| J-S12 | ❌ 缺失 | `grep 'effectOf\|\.effect(' src/sessions` 只命中 `core.ts:15,705`；`workspace.ts` / `ephemeral.ts` 全文无 `ctx.effect` | 素材要求门面注册 `ctx.effect(() => () => { void dispose() }, 'magica:sessions/workspace')` 作为 fiber 销毁兜底（`j.md:45`、`j.md:191`）。实现完全没有 → fiber 卸载时 agent handle、observers、上下文投递器都不会被回收（审批/提问监听因 `manageWaterfallListener` 自带的 effect 会被摘掉，成为唯二被回收的部分）→ GAPS G1 |
| J-S13 | ✅ 有意差异 | `core.ts:310-354`（`resolveDefaultModel`/`pickModel`）；`workspace.ts:151,214-219`、`ephemeral.ts:169,221-225`；test: '再次落 agentDefaultModel.currentSelection()（0.2 是拉取式）'、'三者都没有 → 可读错误（而不是建出一个没模型的 agent）' | 白名单 §3.8 #2 / §5 #24：0.2 `agentDefaultModel` 是拉取式服务，必须主动查并填 `agentOptions`，否则首轮 `prompt variable "{{model}}" has no value`。素材 I 表无此条（属 0.2 新增要求） |
| J-S14 | ✅ 有意差异 | `ephemeral.ts:321-325`；test: 'noInteraction: false → 不装 fail-fast（把提问/审批留给上层接管）'、'默认（noInteraction 缺省）仍装 fail-fast' | 白名单 §3.8 #4 / §5 #26：`noInteraction === false` 时不装 fail-fast，否则会把提问抢答成否（0.1.6 无条件安装）。`j.md:74-78` 的 noInteraction 语义迁移也已落地（`ephemeral.ts:174` 注入无名插件上下文） |

---

## 4. GAPS（按影响排序）

### G1 · P0 · 门面缺 fiber 兜底 `dispose()`，插件卸载后 agent 与 observers 泄漏

- **现状**：`runWorkspaceSession`（`workspace.ts:138-560`）与 `runEphemeralSession`（`ephemeral.ts:158-512`）只在句柄上暴露 `dispose()`，**没有任何 `ctx.effect`**；`grep 'effectOf\|\.effect(' src/sessions` 仅命中 `core.ts:15,705`（`manageWaterfallListener` 内部）。因此 `uninstall`（审批/提问接管）会随 fiber 卸载被摘掉，但 `installObservers` 的两条 `agentCtx.on(...)`、`installContextDelivery` 的 `agent/pre-step` 监听、以及 `agents.create/resume` 出来的 agent handle 都不会被回收。
- **原始要求**：I-016 / INV-9「每个副作用都有归属回收点——监听、timer、挂住的 Promise、**以及 `ctx.effect` 自己返回的 disposer**」（i.md:110）；`j.md:45`「`ctx.effect(() => () => { void dispose() }, 'magica:sessions/workspace')`（`:862-866`）是 fiber 销毁时的兜底」；`j.md:191`「旧实现 自己的 `ctx.effect` 会调 `handle.dispose()`」。
- **最小修法**：两个门面在 `const firstTurn = ensureFirstTurn()` 之后、`return` 之前各加一行（`effectOf` 已可从 `../shared/dsh.ts` 取）：
  ```ts
  try { effectOf(ctx, () => () => { void dispose() }, 'magica:sessions/workspace') } catch { /* fiber 已 inactive */ }
  ```
  临时门面把 label 换成 `'magica:sessions/ephemeral'`。
- **需要补的断言**：① `fakeCtx.effects() >= 2`（1 条来自交互接管的 `manageWaterfallListener`，1 条来自门面兜底）；② 调用 fakeCtx 的 effect disposer（或伪造 fiber 卸载）后 `handle.getState().disposed === true` 且 `bundle.agentCtx.listenerCount('session/event') === 0`；③ 正式门面同款断言。

### G2 · P0 · 正式门面 TTL 超时文案仍是「0 分钟未完成」（`formatDuration` 只补在临时门面）

- **现状**：`workspace.ts:346` 里是 `state.error = \`会话超时（${Math.round(ttlMs / 60_000)} 分钟未完成）\``。`ttlMs: 120` → `Math.round(0.002) = 0` → 「会话超时（0 分钟未完成）」。`formatDuration`（`ephemeral.ts:149-156`）是临时门面的模块私有函数，正式门面无法复用。
- **原始要求**：`j.md:23`「超时后写 `state.error = '会话超时（N 分钟未完成）'`」+ `00-overview.zh.md:355`「顺带修掉一个文案 bug：`ttlMs: 120` 曾显示「0 分钟未完成」→ 新增 `formatDuration`（毫秒 / 秒 / 分钟）」。
- **最小修法**：把 `formatDuration` 提到 `core.ts` 并 `export`，`workspace.ts:346` 改为 `会话超时（${formatDuration(ttlMs)}未完成）`，`ephemeral.ts:149-156` 改为从 core 引入（顺带消掉一处重复）。
- **需要补的断言**：正式门面 `ttlMs: 120`（配合 `fakeAgents({ neverIdle: true })` 或直接驱动定时器）→ `handle.getState().error` 匹配 `/120 毫秒/` 且不匹配 `/0 分钟/`；临时门面保留同款断言。

### G3 · P1 · `runWorkspaceSession` 零测试，正式门面的全部语义无安全网

- **现状**：`tests/sessions/` 5 个文件只测 `runEphemeralSession`（`facade.test.ts`）、core、observers、store、questions 日志。`grep 'runWorkspaceSession' tests` = 0 命中。于是 `attachToWorkspace`、`pinTitle`、`humanInteraction` 安装、`title/permission` 台账回退、`wake()` 后的 re-attach、`SESSION_LIVE`/`SESSION_SETUP_REQUIRED` 分支全部没有断言（G1/G2/J-S09 因此也漏检）。
- **原始要求**：`00-overview.zh.md:370`「sessions ✅ 已完成」+ §7.3「无安全网清单（重写时必须补测试）」；`j.md:383-448` 给出正式门面的完整时序列（每一步都是可断言点）。
- **最小修法**：新增 `tests/sessions/workspace.test.ts`，复用 `fakeAgents` + `fakeCtx({ workspaceRegistry: { get: () => fakeWorkspace } })`，覆盖：首轮 completed + 台账 `kind:'workspace'`/`workspaceId`/`workspacePath`/`title`、attach 失败降级 `attachError`（registry 缺失 / workspace 不存在 / `attachSession` 抛错三态）、`humanInteraction` 装上两个监听、`dispose` 后监听清零。
- **需要补的断言**：至少 6 个 `it`（首轮、attach 三态、humanInteraction 开关、wake 重 attach、dispose 回收）。

### G4 · P1 · 临时门面续跑不调 `assertSessionNotLive`，`SESSION_LIVE` 在临时门面不可达

- **现状**：`workspace.ts:225` 调了 `assertSessionNotLive(agents, sessionId)`，`ephemeral.ts:231-254` 没有——它直接 `agents.resume(...)` 并靠 `toResumeError`（文案正则 `/already owned by an active write handle|is still live/i`）兜出 `SESSION_ALREADY_ACTIVE`。于是同一局面在正式门面报 `SESSION_LIVE`、在临时门面报 `SESSION_ALREADY_ACTIVE`，且后者依赖 dsh 的错误文案（`packages/session/session-persistence/src/errors.ts:31-37` 的 `SessionAlreadyOwnedError` 恰好只有 `sessionId`、没有 `code`，所以正则路径当前是唯一通路，脆弱）。
- **原始要求**：I-089「`ResumeFailure` 恰三个机器可读码：`SESSION_LIVE`、`SESSION_LOG_MISSING`、`SESSION_SETUP_REQUIRED`」（i.md:391-397）+ I-099「`assertSessionNotLive` 用 `agents.get(sessionId) !== undefined` 判活层」（i.md:426）；`j.md:588-589` 把 `assertSessionNotLive` 画在两个门面共同的续跑时序里。
- **最小修法**：在 `ephemeral.ts` 的 `resumeAgent` 首行加 `assertSessionNotLive(agents, sessionId)`（与 `workspace.ts:225` 对齐），`SESSION_ALREADY_ACTIVE` 降为"活层没查到但 dsh 仍拒绝"的第二道网。
- **需要补的断言**：临时门面用 `fakeAgents` 让 `agents.get(id)` 返回已存在对象 → `await handle.firstTurn` 不 reject、`getState().errorCode === 'SESSION_LIVE'`；且 `agents.resume` 未被调用。

### G5 · P1 · waterfall 注册选项（`{prepend:true, global:true}`）没有任何断言

- **现状**：`tests/helpers/fake.ts:27-36` 的 `on(event, listener)` **忽略第三个参数**，所以三方接管（`approval.ts:169,195`、`questions.ts:301,345`）到底传没传 `WATERFALL_TAKEOVER` 测不出来。INV-8 是本项目最贵的一条铁律（不 `prepend` 就永远轮不到，`j.md:518-541`），却完全靠肉眼。
- **原始要求**：I-015 / INV-8「所有 waterfall 接管监听必须 `{ prepend: true, global: true }`，否则排在 `api/remotes` 转发器之后永远轮不到」（i.md:109）。
- **最小修法**：`fakeCtx.on` 记录 `options`（新增 `onOptions(event)` 或把 options 存进 listener 记录），断言三处接管注册时 `deepEqual(options, { prepend: true, global: true })`；顺带断言 `agent/pre-step` 注册时**只有** `prepend`（不传 `global`）。
- **需要补的断言**：`approval/request`、`user-questions/request` 各 1 条 + `agent/pre-step` 1 条 + `WATERFALL_TAKEOVER` 常量本身 `deepEqual` 1 条。

### G6 · P2 · `toResumeError` 结构化 code 前缀过宽，会把真实故障伪装成"日志缺失"

- **现状**：`core.ts:841-844` 对**任何** `typeof code === 'string' && code.startsWith('SESSION_')` 一律返回 `SESSION_LOG_MISSING`。dsh 里 `SESSION_QUERY_*` 有 5 个以上稳定码（`packages/session-query/session-query/src/config.ts:44` 等），其中 `SESSION_QUERY_CORRUPT_SESSION` / `SESSION_QUERY_PERSISTENCE_FAILED` 与"日志缺失"语义完全不同。
- **原始要求**：I-100「按 `/not found|SESSION_QUERY_SESSION_NOT_FOUND|no such session|ENOENT/i` 把普通 `Error` 归一成 `SESSION_LOG_MISSING`」（i.md:431）+ I-101「识别不出的错误**原样返回**，不伪装成「日志缺失」（免得掩盖真实故障）」（i.md:434）。
- **最小修法**：把结构化分支收窄为白名单（`code === 'SESSION_QUERY_SESSION_NOT_FOUND'` 或 `code.endsWith('_NOT_FOUND')`），其余 `SESSION_*` 走"原样返回"；保留文案正则兜底不动。
- **需要补的断言**：`toResumeError(Object.assign(new Error('x'),{code:'SESSION_QUERY_CORRUPT_SESSION'}),'s')` → 不是 `SessionResumeError`；`code:'SESSION_QUERY_SESSION_NOT_FOUND'` → `SESSION_LOG_MISSING`；`code:'SESSION_ALREADY_ACTIVE'` → 仍是 `SESSION_ALREADY_ACTIVE`（今日会被误判，属回归点）。

### G7 · P2 · 公开面比素材要求更宽：内部函数与选项类型全部转出

- **现状**：`index.ts:18,21,29,30,31,34-35,39` 转出了 `emptyRunState`/`installContextDelivery`/`installObservers`/`mintSessionId`/`releaseRunState`/`resolveAgentPresetId`/`resolveAgents`/`runTurnVerified`/`snapshotRunState`/`warnLedgerWriteFailure`/`composeAgentScope`/`manageWaterfallListener`/`pickModel`/`resolveDefaultModel`/`toMessages`/`assertSessionNotLive`/`asSessionId`/`errorMessage`/`TAKEOVER_OPTIONS`，以及 `ApprovalAnswererOptions`(`:106`)/`QuestionAnswererOptions`(`:124`)；根入口 `src/index.ts:64` 是 `export *`，所以它们全是包公开 API。
- **原始要求**：I-003「…在 `core.ts` 里 `export` 但**不经 `index.ts` 转出**，消费方拿不到」（i.md:55-64）+ I-004「`ApprovalAnswererOptions`、`QuestionAnswererOptions` 类型未转出」（i.md:65）。
- **最小修法**：**先决定口径**。若确认要宽公开面（利于单测直接打内核），就在 `00-overview.zh.md` §3.9 加一行"公开面包含内核原语"，并把 I-003/I-004 标为有意差异；否则把上述符号从 `index.ts` 移出，测试改深路径 import（现有测试已经全部深路径 import，改动成本低）。
- **需要补的断言**：一条"公开面清单"快照断言（`Object.keys(await import('../../src/sessions/index.ts')).sort()` 与预期数组 `deepEqual`），防止继续漂移。

### G8 · P2 · `wake()` 之后 `injectContext` 永久失效

- **现状**：`makeSetup` 里是 `if (!reattached) delivery = installContextDelivery(...)`（`workspace.ts:200`、`ephemeral.ts:207`），而 `wake()` 一开始就 `reattached = true`（`workspace.ts:459`、`ephemeral.ts:414`）。于是唤醒后的新 agent scope 上**不再安装**投递器，`delivery` 停在 `null`，`injectContext` 恒返回 `false`（`workspace.ts:543-548`、`ephemeral.ts:495-500`）；常驻无人值守循环"唤醒后继续投新 references"的用法静默失效。
- **原始要求**：I-011 / INV-4「续跑/唤醒不重投」（i.md:105）——只约束"不重投首轮上下文"，未要求关掉该能力；`j.md:80-86`「常驻会话（定时派活的无人值守循环）靠它做到「每处理一条新 issue 就投一次新的 references」：可反复调用」+ `j.md:17`「`reattached` 必须在 `resume` 之前置位：preset 的 `setup` 在 `resume` 内部跑，它读这个标志决定要不要重投首轮上下文」。
- **最小修法**：把"是否重投首轮上下文"与"是否安装投递器"拆开：`delivery = installContextDelivery(agentCtx, reattached ? [] : contexts)`（始终安装，只是初次批次为空），`wake()` 后 `injectContext` 恢复可用。
- **需要补的断言**：`await handle.wake()` 后 `handle.injectContext([{ text: 'x' }]) === true`，且下一个 step 只投这条新上下文（不重投首轮批次）。

### G9 · P3 · 正式门面台账的 `agentPresetId` 缺 `record` 回退（与临时门面不对称）

- **现状**：`workspace.ts:284-288` 只在 `mountedPresetId` 或 `options.agentPresetId` 有值时写 `agentPresetId`；`ephemeral.ts:267-273` 还多一级 `record?.agentPresetId` 回退。当组合里**没有 `agentPresets` 服务**（`resolveAgentPresets` 返回 `undefined`，`core.ts:883-889`）且调用方没显式传 `agentPresetId` 时，正式会话续跑一次就把台账里的 `agentPresetId` 抹掉，临时会话不会。
- **原始要求**：I-120「`agentPresetId?`」为台账字段（i.md:496-514）+ `j.md:92`「续跑时沿用台账原值」（该行只点了 `cwd`/`sandbox`，但"沿用原值"是同一族规则）。
- **最小修法**：`workspace.ts:284-288` 末尾补 `: record?.agentPresetId !== undefined ? { agentPresetId: record.agentPresetId } : {}`，与 `ephemeral.ts` 逐字对齐。
- **需要补的断言**：用无 `agentPresets` 服务的 ctx 建正式会话 → 手工往台账补 `agentPresetId` → 续跑一次 → 读回台账 `agentPresetId` 仍在。

### G10 · P3 · `attachToWorkspace` 的 `registry.get` 抛错会整轮失败而非降级

- **现状**：`workspace.ts:247-267` 只把 `attachSession` 包在 `try` 里；`getWorkspaceRegistry(ctx)`(`:248`) 与 `registry.get(options.workspaceId)`(`:253`) 在 `try` 之外。若 registry 的 `get` 抛错（dsh 内部加载 workspace 元数据失败等），异常会冒到 `startFirstTurn` → `ensureFirstTurn` 兜底 → `state.error`，**整轮不跑**；而同为 attach 失败的另外两种情形（registry 缺失 / workspace 不存在）只是 `attachError` + 继续跑。
- **原始要求**：`00-overview.zh.md:439`「保留 `attachError` 静默降级；`cwd` 必须是 canonical path」（§5 #14）；`j.md:418`「`workspaceRegistry.get` + `workspace.attachSession`」作为可降级的 attach 步骤。
- **最小修法**：把 `getWorkspaceRegistry` + `registry.get` 一起移进 `try`，`catch` 里 `attachError = errorMessage(error)`；保持 `workspaceAttached = false`。
- **需要补的断言**：`workspaceRegistry.get` 抛错的 ctx → `firstTurn` 仍 `completed === true`、`getState().attachError` 含错误信息、`getState().workspaceAttached === false`。

---

## 5. 疑似素材错误

1. **G4 自称「i.md + j.md 全量」，但 J 段整段缺失。** 文件 169 行、正文逐条表止于 I-125，最后一行是 `<!--APPEND-->`（明显的未完成标记），全文 0 条 `J-###`。而 G4 的标题与摘要（`:3`、`:21-22`、铁律 7/8、`j.md` 的 wake/TTL/门面差异/`ctx.effect` 兜底等内容）全部依赖 j.md。**后果**：任务要求的"两个门面 options 与默认值""handle 成员语义""getState 字段""workspace attach 竞态""审批/提问接管安装时机"在输入里**没有 ID 承载**，本卷只能用 `docs/raw/j.md` 的原文行号补编 §3。建议回补 J 段或明确"以 j.md 为准"。

2. **I-001 的行数断言对 0.2 重写无意义。** 「恰有 8 个文件、5046 行（非空 3772 行）」是 0.1.6 原包 `src/sessions/**` 的度量；本仓 8 文件 3236 行（非空 2890）。同一 ID 里的「包 `@amazing-tools/dsh-magica` v0.1.6-rc.26」也与 0.2 线包名冲突。建议拆成"文件数 = 8"（可断言）与"规模参考值"（不可断言）。

3. **`forked` 只有"常量表改 7 个"的依据，没有文案依据。** §5 #1 只要求常量表变 7 个并保留双向断言；`j.md:482-492` 的映射表停在 6 种 + `undefined`。实现在 `core.ts:80-81` 自取 `forked (fork seed)`，`core.test.ts:52` 把它固化成断言。若 dsh 后续改文案，这条会因为"素材没有权威值"而无法判断对错。建议在 §5 #1 补一行文案。

4. **I-041 描述的是 0.1.6 的缺陷，0.2 实现已修好，条目应改写。** 原文「超时路径**不读** `state.turnEnds`，直接构造 `{ kind: 'aborted' } as TurnEndReason`——该对象缺 `reason` 字段（真实 `aborted` 变体要求 `reason: TurnEndCancelCause`），消费方需靠 `timedOut: true` 规避」。实现 `core.ts:710-719` 给出完整 `reason`（含 `{kind:'hook',reason:'magica:idle-timeout'}`，与真正 cancel 的 cause 逐字相同）。按原文核对会判"实现不符"，实际上实现更好。建议改为"超时结算必须是形状完整的 `aborted`（含 hook cause）并置 `timedOut:true`"。

5. **I-089「恰三个码」与白名单 §3.8 #5 自相矛盾。** §3.8 明确"新增分类 `SESSION_ALREADY_ACTIVE`"并说"这 5 条都要写进 §5"，而 I-089 写"恰三个机器可读码"。本卷按白名单把 I-089 判为"有意差异"，但素材层面应改成"4 个码"或注明"3 个 0.1.6 码 + 1 个 0.2 新增码"，否则后续核对者会二选一地判错。

6. **I-003 / I-004 与 0.2 的出口结构冲突。** 素材假设"不经 `index.ts` 转出，消费方拿不到"；但本仓根入口 `src/index.ts:64` 是 `export * from './sessions/index.ts'`，只要 `index.ts` 列了名字就必然公开，反之亦然。也就是说"内核原语是否公开"是一个**设计选择**（已在 GAPS G7 给出两条路），素材把它写成了不可协商的约束。建议在 §3.9 增一行公开面口径。

7. **I-016 漏掉了最关键的那条副作用回收点。** I-016 列了"监听、timer、挂住的 Promise、`ctx.effect` 自己返回的 disposer"，但没有单列"**门面级** `ctx.effect(() => () => void dispose())`"（该要求在 `j.md:45`/`j.md:191`，未进 I 表）。只按 I 表核对会得到"✅ 一致"的假阳性——本卷 J-S12 才把它抓出来（GAPS G1）。建议把该条升进 I 表并给它一个可断言的 ID（如 `expect(fakeCtx.effects()) >= 2`）。

8. **I-116 与 I-045 的日志前缀是旧包名。** 「`process.stderr.write('[dsh-magica] ' + message + '\n')`」「只写一条日志」在 0.2 实现里是 `[dsh-magica-spellbook]`（`core.ts:931`）与 `[spellbook]`（`core.ts:429`）。按字符串逐字断言会假失败，建议素材把前缀参数化。

## 修复记录（Round 2）

| 项 | 改动 | 回归 |
|---|---|---|
| G1（门面缺 fiber 兜底） | 两个门面都挂 effectOf(ctx, () => () => void dispose(), …) | 	ests/sessions/facade.test.ts（fiber 回收 → disposed=true、监听器清零） |
| G2（workspace TTL 文案） | 抽出 core.formatDuration，两个门面共用 | 	ests/sessions/facade.test.ts + 真机 TTL 场景 |
| J 段素材缺失 | 核对文档已用 docs/raw/j.md 行号补编 J-S01…J-S14 | — |
