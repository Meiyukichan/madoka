# diff.md 差异修复记录（spellbook ← 旧实现 对照）

> 基准：`docs/raw/diff.md`（spellbook 0.2.0-alpha.2 vs 旧实现 / DSH 0.1.2）。
> 口径：**A 类（spellbook 有、旧实现 无）= 我们的增强 → 不修**；B/S/E 里"旧实现侧缺口"不修；
> **D 类（旧实现 有、spellbook 没有）+ 幽灵声明 + C 类里属退步的条目 → 修**。
> 每条都对着**当前源码**复核过（alpha.2 之后又改过多轮，部分条目已不复现）。

## 一、已修（22 条）

### 幽灵声明（10 条，全部修好并在产物里验证）

| # | 符号 | 修法 | 验证 |
|---|---|---|---|
| 1 | `ephemeralPending` | `sessions/index.ts` 补再导出 | `tests/exports.test.ts` |
| 2–3 | `isLoopbackHost` / `isTrustedHost` | 根 `index.ts` 的 router 再导出清单补两项 | `tests/exports.test.ts` |
| 4–5 | `pickDisplayText` / `currentLang` | `client/panel/index.ts` 补 display-text 再导出 | `verify.mjs` 产物断言 |
| 6 | `parseRecommended` | 同上（recommended） | `verify.mjs` |
| 7–9 | `carrierKey` / `claim` / `InteractionRegistry` | 同上（registry） | `verify.mjs` |
| 10 | `serviceOf` | 同上（services） | `verify.mjs` |

`scripts/verify.mjs` 新增 `DECLARED_EXPORTS` 守卫：这 10 个符号一旦从产物里消失，构建当场红。

### D 类（旧实现 有、spellbook 没有）

| 项 | 修法 | 落点 |
|---|---|---|
| **D2** 全组未答校验 + 跳转 | 末题提交扫全组，跳到第一条缺答题并报 `ix.error.incomplete`（该 key 之前是死键） | `Card.tsx` `advance()` |
| **D3** 末题跳过提交整组 | 跳过末题改为提交**整组**草稿（早前只提交当前题，前面答案被丢弃） | `Card.tsx` `skip()` |
| **D4** settle 异常兜底 + busy 三态 | `submit/cancel/settle` 全部 `try/catch/finally`；busy 改 `'answer' \| 'cancel' \| null`，只有 answer 态显示「提交中…」 | `Card.tsx` |
| **D5** `variant: 'plain'` 死参数 | 入口真正接收 `variant`：`plain` 不套浮层外壳、不渲染收起按钮；`takeover`（缺省）保持原样 | `Card.tsx` |
| **D7** 关闭代际围栏 | 新增 `openGeneration`：每次 open/close 递增，`confirmCreate` 回包世代不符则整体作废（不再 setState/navigate） | `DirectoryBrowser.tsx` |
| **D8** `failureText` + `role="alert"` | 新增 `failureText()` 优先取 Host 业务错误 `{rpcError:{message}}`；两处错误区补 `role="alert"` | `DirectoryBrowser.tsx` |
| **D9** 推荐后缀大小写不敏感 | `parseRecommended` 改单正则（大小写不敏感、全/半角括号、英文/中文后缀），保留空标签保护 | `recommended.ts` |
| **D10** 目录细节组（3 项） | 无盘符且非 Windows 时给 POSIX `/` 兜底入口；盘符栏 `aria-label` 仅在翻译到时挂；`onCommit` 期间 `committing` 冻结视图 | `DirectoryBrowser.tsx` |
| **D11-1** 超时结算丢文本 | `timeoutSettlement(texts, externallyDisposed)`：带上本轮已产出文本 | `sessions/core.ts` |
| **D11-2** wake 后不重装投递器 | ephemeral 改为「`delivery === null` 就安装」，wake 后 `injectContext` 仍可用 | `sessions/ephemeral.ts` |
| **D11-3** `data-plugin-css` 写空串 | 改写 `INTERACTION_STYLE_ID`（0.2 HMR 靠它回收样式产物） | `panel/styles.ts` |
| **D13** followup 并发互斥 | `followup` 先 `ensureFirstTurn()` 再串行（首轮未落定不再并发跑第二轮） | `sessions/workspace.ts` |
| **D14** 续跑丢调用方 context | `installContextDelivery(agentCtx, contexts)` 总投（续跑也投） | `sessions/workspace.ts` |
| **D15** 续跑 preset 不回退台账 | 未显式传 preset 时读 `record.agentPresetId` | `sessions/workspace.ts` |
| **D16** 投递器 dispose 容错 | `delivery.dispose()` 包 `try/catch`（不再中断后续清理） | `sessions/workspace.ts` |

### C 类（属退步/需定口径的）

| 项 | 修法 |
|---|---|
| **C20** query 的 `+` 转空格波及路径参数 | `safeDecode(text, plusAsSpace)`：只有 query 把 `+` 当空格，路径参数保持原样 |
| **C22** 临时会话缺续跑预检 | resume 前 `assertSessionNotLive`，活会话直接给 `SESSION_LIVE`（E2E S4b 已放宽为接受 `SESSION_LIVE`/`SESSION_ALREADY_ACTIVE`） |
| **C18** DPAPI 模块形状 | 兼容扁平 `{protectData(data, scope)}` 与嵌套 `{Dpapi:{protectData(data, entropy, scope)}}`；**实测发现**旧版 `unprotectData` 也是三参（少传会报 `3 arguments are required`，解密永远失败） |
| **C16** `stepBill` 计费口径 | 保持"`inputTokens` = 总输入"的减法口径，并把口径写进 JSDoc 契约（旧实现是加法，两包不可混算） |
| **C17** `timeoutMs: 0` 语义 | 保持 `0 = 不超时`，JSDoc 写明（旧实现是立即超时） |

## 二、不修（判定：增强 / 有意 / 误报）

| 类 | 条目 | 理由 |
|---|---|---|
| **A（20+2）** | 全部 | A 类定义就是"spellbook 有、旧实现 无"——是我们的增强，没有修的语义 |
| **B（B1–B4）** | 全部 | B 是"旧实现 内核有、门面未接"，且 spellbook 侧**已接**（`idleTimeoutMs` 5 参、normalizeProjectPath、`ledgerWriteFailed` 透传、状态四字段） |
| C1 | `strictMutations` 默认 `true` | 我们的安全默认（旧实现的 `false` 可被无 Origin 本机脚本零凭证批越权），保留 |
| C7 / C12 / C15 | 台账白名单 / `invalid-answer` / 载体判严 | 我们的修复，保留 |
| C11 / C14 / C23 | 关闭保护四条件 / 双腿并行导航 / 右栏双击钻入 | 交互模型是我们刻意选的（双击钻入才能保留"单击选中→提交"） |
| C2 / C5 / C6 / C8 / C9(上半) / C10 / C13 | 返回值 / 判型 / 深拷 / since 去重 / 解析 / 解包 / escalation | spellbook 侧更严或更省事，保留 |
| C19 | logger dispose 同步 flush | 我们的修复（异步在测试结束时常丢最后一批） |
| C21 | 代理 https/http 分档 | 已按 c.md 分档，实际分派等价（`EnvHttpProxyAgent` 内部回退） |
| **D1 / D6** | 单选自动翻页 / 路径预览腿 | 有意不做：前者与"逐题确认"的交互冲突；后者会引入 `readdir` 风暴 |
| **D12** | 多模块 SDK 定位 | 包定位差异（纯库 vs 完整插件），非能力缺失 |
| E（28 条） | DSH 0.2 vs 0.1.2 写法 | 版本差异，不计 |

## 三、验证

- `typecheck 0`
- **245 例单测全绿**（新增 `tests/exports.test.ts` 2 例 + `recommended` 并集 3 例）
- `lib/index.js` 57.1 KB、`lib/client.js` 23.5 KB；`verify` 通过（含新增的 10 条幽灵导出守卫）
- 真机 dev profile（`DSH_HOME` 隔离、3081）：基础 **14/14**、看门狗 **1/1**、提问 **7/7**、审批 **5/5**、
  遗漏修复专套 **11/11**、UI 选择框 / 审批卡 / 计划评审三闭环全部 `remaining=0`

## 四、本轮真机抓到的两个新问题（已修）

1. **DPAPI 解密参数**：旧版模块 `unprotectData` 需要 `(data, entropy, scope)` 三参，只传 data 会抛
   `3 arguments are required` → 密文原样返回（看起来像"密钥丢了"）。单测先在 Windows 上红了才发现。
2. **`SESSION_LIVE` 早退**：加了 C22 预检后，E2E 的"活动 handle 拒绝续跑"从 `SESSION_ALREADY_ACTIVE`
   变成 `SESSION_LIVE`。两者语义一致（先 dispose 再续跑），断言改为接受两种码，并在脚本里写明区别。
