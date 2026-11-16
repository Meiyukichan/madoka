# 06 · 会话内核遗漏复核（i/j/k/l/m 逐节重读 × 当前实现）

> 只读复核。raw 行号均为当前文件实际行号（i 804 / j 620 / k 684 / l 722 / m 342，与任务书括号数字不符，以文件为准）；05 两卷已报项不重复，本节只收新发现。

## 结论
- 真遗漏 **7** / 已覆盖 **10**（本节抽样；05 两卷已逐条核 I、J-S、K、L、M 全表）/ 有意不做 **6**
- 一句话：**会话内核的"大功能"齐了，剩下的缺口集中在三处——状态采了却不给消费者、台账与实际权限漂移、上下文注入失败静默**；没有整块未实现的设计。
- 05 卷已列但仍未修的（不重开）：`ephemeral` 缺 `assertSessionNotLive`（G4/G-9）、`toResumeError` 的 `SESSION_*` 前缀过宽（G6）、`wake()` 后 `injectContext` 失效（G8）、workspace 台账 `agentPresetId` 缺 record 回退（G9）、`registry.get` 抛错未降级（G10）。

## 真遗漏（按严重度）

| # | 原始要求（raw 行 + 原文 ≤30 字） | 现实现（文件:行 + 现状） | 为什么算遗漏 | 最小修法 |
|---|---|---|---|---|
| 1 P1 | j.md:32-38「`getState()` = `{...snapshotRunState(state), …}`」；l.md:38「不出现在 `state.sandboxMode`…看板必须从」 | `core.ts:160-166` 采了 `approvals`/`approvalPolicy`/`sandboxMode`/`planMode`，但 `workspace.ts:528-547`、`ephemeral.ts:476-493` 逐字段重建时**把它们全过滤掉** | 4 个字段只写不读：审批历史（谁批了什么、等了多久）与沙箱/计划模式在公开句柄上**没有任何读取路径**，等于死状态；`getState` 也不是原文的"快照展开" | 两个 `getState()` 补 `...(snapshot.approvals.length>0?{approvals:…}:{})` 等四项（缺省即不出现）。（raw k.md:425 的类型表又没列这四项，口径**待人工确认**） |
| 2 P2 | l.md:488「ephemeral：`options.sandbox ?? record?.permission ?? sandbox`」；l.md:489「`options.cwd` > `record.cwd`」 | `ephemeral.ts:260-261` 反过来：`(resumed ? record?.permission : undefined) ?? sandbox`、`(resumed ? record?.cwd : undefined) ?? options.cwd` | 续跑时传 `sandbox: 'danger-full-access'` 会**真应用到会话**（`ephemeral.ts:334` 判定 `!resumed \|\| options.sandbox !== undefined`），台账却仍写旧值 → 台账与真实权限长期不一致，下次续跑又回落；05-a J-S07 判"✅ 延续台账"是误判 | 两行改成 `options.sandbox ?? record?.permission ?? sandbox` / `options.cwd ?? record?.cwd ?? …` |
| 3 P2 | l.md:196「③ `off = agentCtx.on('agent/pre-step', listener, …)`」（无 try/catch） | `core.ts:597-615` 把注册包进 `try/catch` 静默吞掉，`core.ts:618-621` 仍把条目塞进 `pending`；`workspace.ts:549-553` / `ephemeral.ts:495-499` 的 `injectContext` 照旧返回 `true` | 注册失败后上下文**永不投递**，而调用方拿到"成功"——正是"模型没看到规则"这类最难查的故障；原文没有这条静默降级 | `ContextDeliveryHandle` 增加 `installed` 位；`push()`/`injectContext()` 未安装时返回 `false`（或首次注册失败直接抛） |
| 4 P2 | l.md:292「③ `try { await workspace.attachSession(...); workspaceAttached = true }`」 | `workspace.ts:259-264`：只要 `typeof workspace.attachSession === 'function'` 就置 `workspaceAttached = true`，**函数缺失时也置 true 且无 `attachError`** | 附挂根本没发生却上报"已挂进 GUI 列表"，调用方（看板）无法察觉；与"attach 失败必须留痕"的降级口径矛盾 | `else` 分支补 `attachError = 'workspace.attachSession unavailable'`，并保持 `workspaceAttached = false` |
| 5 P3 | l.md:192「回调里先 `if (disposed) return`，再 `if (session.id !== sessionId)`」 | `core.ts:461-463` 回调只有 `session.id` 比对，**没有 `disposed` 闸门**（`disposed` 只用于注销器幂等，`core.ts:562`） | 注销与派发并发（宿主 `off()` 未真正摘除、派发遍历中重入）时仍会往已 `releaseRunState` 的 state 里写；原文显式加了这道纵深防御 | 回调首行补 `if (disposed) return` |
| 6 P3 | m.md:193「`pending.questions` **深等于**输入 `questions`」；m.md:215 detail「`multiSelect: false`」 | `questions.ts:166` 只在 `multiSelect === true` 时赋值 → **`false` 被丢弃**；`questions.ts:167` 同理只在 `intent.kind`+`approve` 都是字符串时才带 | 挂住的请求不再与原请求深等；`question.asked` 的 `detail` 经 `JSON.stringify` 后 `multiSelect` 整个消失（05-b G-10 只提了 `intent`，没提这条） | `normalized.multiSelect = item.multiSelect === true`；日志里写 `multiSelect: question.multiSelect ?? false` |
| 7 P3 | i.md:191-199「dsh 增删 kind 时这行编译报错，不会静默漂移」 | `core.ts:49-55` 的双向断言比的是 `shared/dsh.ts:58-65` 里**手写的** `DshTurnEndReason` | 0.2 改用手写结构面后，断言退化成"自己跟自己比"，dsh 真增删 kind 不会编译失败——INV 只剩注释意义 | 加一条 `scripts/verify` 读 dsh 侧 `TurnEndReasonMap` 做字符串快照比对；或在 §5 适配矩阵登记"该断言已弱化"（**待人工确认**是否接受） |

## 已覆盖核对（抽样 10 条，逐条给结论）
1. **结局全集/优先级**：`core.ts:36-44` 七 kind（含 0.2 新增 `forked`）；`turn/end` 取本轮增量**最后一条**并写 `outcome`（`core.ts:473-482`、`core.ts:768-769`）→ 未缺分支。
2. **看门狗超时结算**：`core.ts:722-732` 给出含 `hook` cause 的完整 `aborted`，i.md:243 指的"缺 `reason` 字段"粗糙点已修。
3. **观察者顺序/去重**：先 push 再回调（`core.ts:465-470`），一个 `assistant/message` 一条不合并；`onToolCall/onToolResult` 只在 `humanInteraction` 时挂（`workspace.ts:176-185`）→ 与 i.md:657 一致。`onError` 原文**不存在**（错误只经 `turn/end.reason`），非缺口。
4. **上下文注入点**：首轮 `resumed ? [] : contexts`（`workspace.ts:201`、`ephemeral.ts:202`），`wake` 后不重投，`reject` 的 step 不消耗（`core.ts:604-609`）→ 首轮/续跑/wake 三点齐；"压缩后重投"原文**无此要求**。
5. **门面选项**：`permission` / `agentPresetId` / `setup`(→`customSetup`) / `title` / `ttlMs` / `humanInteraction` / `contextPlugin` / `newSessionId` 全部在（`workspace.ts:61-83`、`ephemeral.ts:80-98`）；`maxTurns`、`signal` 原文两个门面**都没有**（k.md:424/436），不算漏。
6. **临时会话 TTL**：起算点在每轮 `runOneTurn`（`ephemeral.ts:299-307`），`!(ttlMs>0)`=无上限（`:287`），到期置 error 后 `void dispose()` 释放句柄（`:288-296`）；`cancel()` 刻意**不**销毁（`:501-508`）→ 与 j.md:23-25、INV-2 一致。
7. **并发/写锁**：同 `sessionId` 活着→`SESSION_LIVE`（`core.ts:836-849`，`workspace.ts:226`）；`followup` 期间 `resume` 被同一前置校验挡住；台账无锁、后写者胜 + 原子 rename（`store.ts:244-269`）→ 与 i.md:539「不做锁」一致（有意）。
8. **日志字段**：全仓只有 `question.*` 五个事件（`questions.ts:218-249`、`:334-337`），载荷 `sessionId/id/questions/waitedMs`；**raw 里没有 `session.*` 事件族**，checkpoint 7 的前提不成立；字段级差异见 05-b G-10。
9. **台账元数据**：13 字段与 i.md:496-514 / l.md:480-494 逐字一致（`store.ts:38-58`），`put` 白名单投影（`:246-262`），`customSetup` 只认 `===true`（`:111`）。
10. **占位/未实现**：`grep 'TODO|FIXME|未实现|占位' src/sessions` **零命中**；只有 client 侧注释里的"占位 composer"，与会话无关。

## 有意不做（附理由）
1. `buildPluginMessage` 不再有 `kind:'plugin'` 分支（`core.ts:235-258`）：v4 明确拒绝该 kind（00-overview §5#25），故 i.md:300 的无名分支被 `spellbook-context` 取代。
2. `noInteraction === false` 时不装 fail-fast（`ephemeral.ts:316-320`）：原实现无条件装会抢答（§5#26 / j.md:74-78 语义迁移）。
3. `pickModel` 必填模型路由并透传默认 `reasoningEffort`（`core.ts:348-367`）：0.2 `agentDefaultModel` 是拉取式（§5#24），原文"可不传 `agentOptions`"会炸 `{{model}}`。
4. `injectContext` 扩散到正式句柄（`workspace.ts:111`）：能力扩展，k.md:426 的成员表未列（05-b G-11 已登记）。
5. 两个门面的 `lastSettlement`/`emptySettlement` 仍是两份（l.md:100 建议合并）：逐字重复、无行为差异，纯整洁度。
6. `signal` 不用（`CreateAgentOptions.signal` 存在）：取消/超时统一走 `cancel(cause,{keepInbox:true})`，避免两条停止通道。
