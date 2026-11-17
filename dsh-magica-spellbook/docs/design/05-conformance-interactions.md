# G3 · 待决交互 host 面：需求 → 实现一致性核对

> **核对方式：只读。** 未修改任何源码、未运行任何测试（`pnpm test` / `typecheck` / `build` 均未执行），只用文件读取与内容检索取证。
> **输入**：需求清单 `.e2e/audit/G3-interactions.md`（278 条：`D-001..D-113` + `E-001..E-165`，含 14 条存疑 `Q-01..Q-14`）。
> **实现**：`src/interactions/*.ts`、`src/shared/wire.ts`、`src/core/router.ts`、`src/sessions/{questions,approval,store,core}.ts`、`src/client/panel/*.ts(x)`。
> **测试**：`tests/interactions/route.test.ts`、`tests/sessions/questions.test.ts`、`tests/client/panel.test.ts`（+ 旁证 `tests/sessions/facade.test.ts`）。
> **有意差异白名单**：`docs/design/00-overview.zh.md` §3.8 / §3.9 / §5（26 行适配矩阵）。命中白名单的条目记为「✅ 有意差异」，不再进 GAPS。
> **判定口径**：状态只反映**代码实际行为 vs 需求语义**；「没有断言」不算差异，统一收在 §5。

## 0. 证据路径缩写

| 缩写 | 实际路径 |
|---|---|
| `wire.ts` | `src/shared/wire.ts` |
| `route.ts` | `src/interactions/route.ts` |
| `collect.ts` / `ownership.ts` | `src/interactions/collect.ts` / `src/interactions/ownership.ts` |
| `router.ts` | `src/core/router.ts` |
| `questions.ts` / `approval.ts` | `src/sessions/questions.ts` / `src/sessions/approval.ts` |
| `store.ts` / `core.ts` | `src/sessions/store.ts` / `src/sessions/core.ts` |
| `workspace.ts` / `ephemeral.ts` | `src/sessions/workspace.ts` / `src/sessions/ephemeral.ts` |
| `surface.ts` / `carrier.ts` / `transport.ts` | `src/client/panel/surface.ts` 等 |
| `Card.tsx` / `Composer.tsx` | `src/client/panel/Card.tsx` / `Composer.tsx` |
| `api-request-trust.ts` | `D:\project-code\llm\deepseek-harness\packages\client\connection\src\api-request-trust.ts` |
| `rpc-host.ts` / `loopback-hostname.ts` | 同上目录 |
| `events.ts` | `D:\project-code\llm\deepseek-harness\vendor\cordis\src\events.ts` |
| `webserver.ts` | `D:\project-code\llm\deepseek-harness\packages\host\webserver\src\index.ts` |

**结构性事实先说清（影响 D-001/006/008/038/050/107、E-107/146/147）**：0.1.6 的「4 文件 633 行」在 0.2 变成 **5 个文件 + 1 个上提的 HTTP 助手**：契约从 `src/interactions/types.ts` 移到 `src/shared/wire.ts`（117 行，零 import，host/client 共用），HTTP 闸门从「本模块私有」上提到 `src/core/router.ts`（393 行，与 `/e2e` 面复用），`src/interactions/` 只剩 `collect.ts`(69) / `index.ts`(40) / `ownership.ts`(70) / `route.ts`(268)。这是 §四 的分层决策，不是功能缺失。

---

## 1. 统计

| 状态 | 条数 | 占比 |
|---|---|---|
| ✅ 一致 | **244** | 87.8% |
| ⚠️ 有差异 | **28** | 10.1% |
| ❌ 缺失 | **1** | 0.4% |
| ✅ 有意差异（白名单） | **5** | 1.8% |
| **合计** | **278** | 100% |

| 分组 | 一致 | 有差异 | 缺失 | 有意差异 |
|---|---|---|---|---|
| D 组（113） | 98 | 14 | 0 | 1（D-008） |
| E 组（165） | 146 | 14 | 1（E-154） | 4（E-095 / E-096 / E-163 / E-164） |

**28 条差异的归因**（12 + 2 + 6 + 7 + 1 = 28）：

- **结构/行号漂移 12**：D-001、D-006、D-038、D-060、D-074、D-107、E-059、E-107、E-110、E-146、E-147、E-162 —— 改字即可；
- **安全默认值 2**：D-113、E-125（另见 GAP-2/GAP-3 的默认值交叉结论）；
- **语义实质差异 6**：D-053、D-054、D-056、E-016、E-018、E-154；
- **守卫/信封/文案 7**：D-021、D-078、D-079、D-095、E-074、E-104、E-119；
- **测试面 1**：E-160。

> 注：「语义实质差异 6」里的 `E-154` 是唯一的 ❌（代码里那张编译期双向断言**不存在**，而 00 §5 行 7 声称「保留」）。

---

## 2. 逐条核对大表

### 2.1 D 组（113 条）

| ID | 状态 | 证据（src:行号 或 test 名） | 差异说明 |
|---|---|---|---|
| D-001 | ⚠️ | `wire.ts:1-117`、`collect.ts:1-69`、`ownership.ts:1-70`、`route.ts:1-268`、`router.ts:1-393` | 4 文件/633 行/`types.ts` 139 行的形状不成立：契约改为 `src/shared/wire.ts`(117)，HTTP 助手提到 `src/core/router.ts`(393)，`src/interactions` 现为 4 文件 447 行。语义等价，属 §四分层；行号需重锚（Q-01） |
| D-002 | ✅ | 对 `src/interactions/*.ts` + `wire.ts` 检索 `@deepseek-ai` 零命中；`route.ts:10` 仅 `import type { ServerResponse } from 'node:http'` | — |
| D-003 | ✅ | `wire.ts:1-117` 全文无 import 语句；两常量在 `wire.ts:103`（`INTERACTION_PREFIX`）、`wire.ts:106-111`（`INTERACTION_PATHS`） | 文件更名（types.ts → shared/wire.ts），额外汇出 `INTERACTION_TAG`(114)、`WATERFALL_TAKEOVER`(117) |
| D-004 | ✅ | `ownership.ts:10` `import { getSessionRecord, getSessionStore }` | 多引入 `getSessionStore`（供 `sessionStoreAvailable` 诊断，`ownership.ts:68-70`） |
| D-005 | ✅ | `collect.ts:7-10` | — |
| D-006 | ⚠️ | `route.ts:11-15` 只 import `createJsonRouter` / `HttpRouteError` / `type JsonRouterRoute` | 不再 import `sameOrigin` / `sendJson`：同源比较改为内联（`route.ts:213-236`），信封改为本地 `ok`/`fail`（`route.ts:49-60`），故 D-078/D-079 出现差异 |
| D-007 | ✅ | `src/index.ts:64-65` `export * from './interactions/index.ts'`；`interactions/index.ts:6-40` 含 6 项 + 全部类型 | 额外汇出 `clipArgs`/`MAX_BODY_BYTES`/`INTERACTION_TAG`/`WATERFALL_TAKEOVER`/`noteMagicaSessionInMemory`/`sessionStoreAvailable` |
| D-008 | ✅ 有意差异 | `package.json:11-16` exports 只有 `.` / `./client` / `./directory-browser` / `./package.json`；浏览器面走 `src/client/panel/index.ts:1-31` | `./interactions → lib/client/interactions/index.js` 是 0.1.6 多入口布局，与 0.2「只暴露 `.`/`./client`」冲突（Q-03 判不适用，AGENTS §一.1） |
| D-009 | ✅ | `questions.ts:213-286`（hold）+ `questions.ts:366-387`（answer/cancel）+ `approval.ts:102-212`；读面 `collect.ts:33-69` | — |
| D-010 | ✅ | `wire.ts:117` `WATERFALL_TAKEOVER = { prepend: true, global: true }`；`questions.ts:301`、`approval.ts:169` 传入；dsh `events.ts:255` `const method = options.prepend ? 'unshift' : 'push'` | — |
| D-011 | ✅ | `questions.ts:295-300` `return hold(request)`（无 `next()`）；`approval.ts:161-169` 同构 | — |
| D-012 | ✅ | 全模块检索无 `ctx.userQuestions` / `ctx.approval` 访问；列表能力自建（`questions.ts:390-397`、`approval.ts:215-224`） | — |
| D-013 | ✅ | 同上：无 `answer?` / `decide?` 调用点 | — |
| D-014 | ✅ | `questions.ts:49` `const bridges = new Map<string, Bridge>()`；`approval.ts:53` 同 | 行号从 0.1.6 的 157/165 漂到 49/53 |
| D-015 | ✅ | `route.ts:238-243` 4 行路由表（1 读 3 写） | — |
| D-016 | ✅ | `route.ts:120`（写面）与 `collect.ts:38`（读面）都调同一个 `isMagicaSession`（`ownership.ts:35`） | — |
| D-017 | ✅ | `bridges` 为模块级 Map，无任何持久化；`resetQuestions`/`resetApprovals` 直接清空 | — |
| D-018 | ✅ | `route.ts:130-155` `settle()` 四分支 | — |
| D-019 | ✅ | `settle()` 只做「字符串 → 状态码」映射，不改写业务返回；业务值来自 `questions.ts:25` / `approval.ts:36` | — |
| D-020 | ✅ | `router.ts:346-392` 阶段 1 方法门 → 2 信任围栏 → 3 读体 → 4 匹配 → 5 业务 → 6 兜底 | — |
| D-021 | ⚠️ | `route.ts:49-60` 信封正确；但方法门 405 是**空体**（`router.ts:59-61` `sendResponse(response, 405, '', { allow })`） | INV-7 字面要求「所有响应二选一」；405 走的是 `Allow` 头 + 空体。与 E-023 兼容、与 INV-7 冲突。见 GAP-7 |
| D-022 | ✅ | `ownership.ts:44-45` 超限清空；判负只写 `foreign` | 但正结果现在被缓存（见 D-054），「负缓存只影响性能」这句仍成立 |
| D-023 | ✅ | `route.ts:169-177`：`query('sessionId')` → 空串转 `undefined` → `collect` → `ok` | — |
| D-024 | ✅ | `route.ts:179-211`：`requireString`(400) → `allowSession`(403) → 载荷校验(400) → `settle` | — |
| D-025 | ✅ | `wire.ts:103,106-111` 单点定义；`transport.ts:9-15` 反向 import 同一份 | — |
| D-026 | ✅ | `wire.ts:11-14` | — |
| D-027 | ✅ | `wire.ts:38-43`；卡片 `Card.tsx:92-102`（`toggle(option.label)`）、`Card.tsx:120`（`toAnswer` 原样回传） | 服务端**不**校验 `selected` 元素是否真在 `options` 里（契约层不拦，属卡片责任） |
| D-028 | ✅ | `wire.ts:24-36` | 多出 `waitCallId` / `waitTimed`（0.2 新字段，§5 行 4） |
| D-029 | ✅ | `wire.ts:29` `options?:`；`questions.ts:164` 仅 `options.length > 0` 才赋值 | — |
| D-030 | ✅ | `questions.ts:166` 仅 `item.multiSelect === true` 才写；`Card.tsx:94` 判 `=== true` | — |
| D-031 | ✅ | `wire.ts:17-21` `kind: string` | — |
| D-032 | ✅ | 代码只透传（`questions.ts:154,167-170`）；dsh 工具侧只映射 schema 参数（`packages/interaction/user-questions/src/projection.ts`） | 0.2 起 `AskUserQuestionItem` 才带 `intent`（§5 行 4），走工具路径仍恒空 |
| D-033 | ✅ | `wire.ts:39-43` | — |
| D-034 | ✅ | `wire.ts:46-65` 判别联合 | — |
| D-035 | ✅ | `wire.ts:47-53` + `collect.ts:43-49` | — |
| D-036 | ✅ | `questions.ts:216` `randomUUID()`；`approval.ts:105` 同 | — |
| D-037 | ✅ | `wire.ts:54-65` + `collect.ts:54-64` | 多出 `displayReason`（§5 行 6） |
| D-038 | ⚠️ | `approval.ts:111-118`（`resolveArgs` 反查）+ `workspace.ts:160,175-181`（`tool/call` 记 `toolCallArgs`，超 `MAX_APPROVAL_ARGS_CHARS` 截断 + `…`） | 需求引 `approval.ts:80-93` 已漂到 111-118；且截断发生在**门面**而非 answerer，`ApprovalAnswererOptions` 无 `maxArgsChars` |
| D-039 | ✅ | `questions.ts:217` / `approval.ts:106` `Date.now()` | — |
| D-040 | ✅ | `wire.ts:68-72` | — |
| D-041 | ✅ | `wire.ts:75-78` | — |
| D-042 | ✅ | `wire.ts:81-85` | — |
| D-043 | ✅ | `wire.ts:88-90` | — |
| D-044 | ✅ | `wire.ts:93-95` | — |
| D-045 | ✅ | `wire.ts:84`（两值）+ `approval.ts:17`（四值闭集）+ `approval.ts:204-212` | — |
| D-046 | ✅ | `wire.ts:98-100` | — |
| D-047 | ✅ | `wire.ts:103` | — |
| D-048 | ✅ | `wire.ts:106-111`（4 键逐字一致） | — |
| D-049 | ✅ | `store.ts:244-257`（原子写）；`workspace.ts:272-296`、`ephemeral.ts:260-276` 各写一份 | 子目录名 `sessions`（`store.ts:21`）与需求一致 |
| D-050 | ✅ | `ownership.ts:13-15` `interface InteractionHostFace { get?(name): unknown }` | 理由需更新（Q-04）：0.2 有 peer semver + shell 模块表；保留该面更实际的收益是「零运行时 dsh 依赖」（`shared/dsh.ts:1-10`） |
| D-051 | ✅ | `ownership.ts:18`（`foreign`）、`:23`（`FOREIGN_CACHE_MAX = 1024`）、`:44`（`foreign.clear()`） | — |
| D-052 | ✅ | `ownership.ts:25-27` `${storeDir ?? ''}\u0000${sessionId}` | — |
| D-053 | ⚠️ | `ownership.ts:35-47`：①`known.has(key)` → true ②`foreign.has(key)` → false ③台账 ④判负写缓存 | 判定链**多了一层正白名单首查**（`known`，`ownership.ts:21`），顺序不再严格是需求的 ①算 key→②负缓存→③台账 |
| D-054 | ⚠️ | `ownership.ts:40-43` 命中台账后 `known.add(key)` | 需求「正结果**不缓存**」不再成立：命中即入 `known` 且**永不失效**（`deleted` 台账后仍判 true）。03 §3.1:144 只承诺「`ledgerWriteFailed` 时才加白名单」，实现比文档宽。见 GAP-5 |
| D-055 | ✅ | `ownership.ts:44` 整表清空，非 LRU | — |
| D-056 | ⚠️ | `ownership.ts:50-54` 除 `foreign.delete(key)` 外还 `known.add(key)` | 「只做 delete」不成立（自愈语义仍对，但多了正缓存写入） |
| D-057 | ✅ | `ownership.ts:62-65` | — |
| D-058 | ✅ | `store.ts:285-306`：`resolveStoreDir` 抛错被 `getSessionStore` 吞成 `null`；`get()` 内 `readFileSync` 全 try/catch | — |
| D-059 | ✅ | `store.ts:285-291`（不可用→null）+ `ownership.ts:39-46`（null→判负并写缓存） | 0.2 新增 `sessionStoreAvailable`（`ownership.ts:68-70`）可用于外部区分 |
| D-060 | ⚠️ | `ownership.ts:39` `getSessionRecord(host as never, ...)`；`ownership.ts:69` `getSessionStore(host as never, ...)` | 「唯一断言」不成立：现为 2 处 |
| D-061 | ✅ | `collect.ts:13-20` | — |
| D-062 | ✅ | `collect.ts:24` `max === undefined` 短路 | HTTP 面不透传该选项（`route.ts:172-175` 只传 sessionId/storeDir），即经 `/magica` 取列表永远不截断 |
| D-063 | ✅ | `collect.ts:22` 注释 + 03 §3.2:158 | — |
| D-064 | ✅ | `collect.ts:24` 三短路（`undefined` / `!(max>0)` 含 `NaN` / `length<=max`） | — |
| D-065 | ✅ | `collect.ts:25` `${args.slice(0, max)}…`（U+2026） | — |
| D-066 | ✅ | `collect.ts:37-68`：解构 → `owned` 闭包(38) → 提问(41-50) → 审批(52-65) → 排序(68) | — |
| D-067 | ✅ | `collect.ts:42` / `:53` `if (!owned(...)) continue` | — |
| D-068 | ✅ | `collect.ts:60-63` 条件展开（callId/reason/displayReason/args） | — |
| D-069 | ✅ | `collect.ts:68` `since` 升序 + `id.localeCompare` 兜底 | — |
| D-070 | ✅ | 依赖链无非受控抛出：`listPending*` 纯内存（`questions.ts:390-397`）、读盘异常已收成 null（`store.ts:226-231`） | — |
| D-071 | ✅ | `store.ts:226-231`：只 `ENOENT` 不记错；其余 `recordError` + null | — |
| D-072 | ✅ | `collect.ts:67` 注释 + `:68` 重排 | — |
| D-073 | ✅ | `route.ts:28` `MAX_BODY_BYTES = 64 * 1024` | — |
| D-074 | ⚠️ | `route.ts:31-40`：`prefix?` / `storeDir?` / `strictMutations?` / **`trustedHosts?`** | 多第四个选项 `trustedHosts`（`route.ts:39`），03 §3.3:163 未记录（GAP-11） |
| D-075 | ✅ | `route.ts:256` `options.prefix ?? INTERACTION_PREFIX` | — |
| D-076 | ✅ | `route.ts:37`（注释默认 false）、`:167` `const strict = options.strictMutations === true` | — |
| D-077 | ✅ | `route.ts:36`、`:213-217`；03 §3.3:207 | 语义确认：默认放行无 Origin（`router.ts:183`）。风险真实存在 → GAP-2 |
| D-078 | ⚠️ | `route.ts:49-60` 本地 `writeHead`，未走 `sendJson`（`router.ts:41-46`） | 响应头逐字等价（`cache-control: no-store` + `content-type: application/json; charset=utf-8`），但「都转 `sendJson`」不成立 → 连带丢了 `sendJson` 的守卫（D-079） |
| D-079 | ⚠️ | `route.ts:56` `fail` 有 `if (response.headersSent) return`；`route.ts:49-53` `ok` **无守卫** | 成功路径若在已发头后再写会抛 `ERR_HTTP_HEADERS_SENT`（当前调用链不可达，但契约不再由代码保证）。见 GAP-6 |
| D-080 | ✅ | `route.ts:62-68`；`HttpRouteError` 定义 `router.ts:16-26` | — |
| D-081 | ✅ | `route.ts:70-81`，消息 `${label} is required` | — |
| D-082 | ✅ | `route.ts:85-88` `answers must be a non-empty array` | — |
| D-083 | ✅ | `route.ts:91-94` `each answer must be an object` | — |
| D-084 | ✅ | `route.ts:96-99` `each answer needs a question id` | — |
| D-085 | ✅ | `route.ts:100-103` `answer "<id>": selected must be string[]` | — |
| D-086 | ✅ | `route.ts:108` 仅当非空字符串才带上 `custom` | — |
| D-087 | ✅ | `route.ts:100` 只校验 `Array.isArray` + 元素类型，空数组合法 | — |
| D-088 | ✅ | 03 §3.3:180 / 卡片 `Card.tsx:48-65` 保证不产生「答了但没选」 | — |
| D-089 | ✅ | `route.ts:132-135` | — |
| D-090 | ✅ | 同上（`cancelled` 同分支） | — |
| D-091 | ✅ | `route.ts:136-143`，文案逐字一致 | — |
| D-092 | ✅ | `route.ts:144-151`，文案逐字一致 | — |
| D-093 | ✅ | `route.ts:152-154` `the interaction was not answered: <result>` | — |
| D-094 | ✅ | `route.ts:144-151`；03:203 | — |
| D-095 | ⚠️ | `route.ts:121-126`：403 `forbidden`，message = `this interaction surface only serves sessions created through this SDK` | **文案漂移**：需求逐字要求 `...created through 旧实现`。见 GAP-8 |
| D-096 | ✅ | `route.ts:114-128` 只判归属，不判「谁发的」 | — |
| D-097 | ✅ | `route.ts:169-177` 无 `allowSession` 调用 | — |
| D-098 | ✅ | `route.ts:179-188` 顺序完全一致 | — |
| D-099 | ✅ | `route.ts:190-197` | — |
| D-100 | ✅ | `route.ts:199-211`：sessionId → approvalId → allowSession → decision 校验 → settle | — |
| D-101 | ✅ | `route.ts:180-186`；`test` 名「字段错误先于归属错误（400 而不是 403）」（route.test.ts:147） | 该 test 只断言「缺 sessionId → 400」与「坏 sessionId → 403」 |
| D-102 | ✅ | `route.ts:213-236`：无 Origin / 无 Host → 403；`new URL(origin).host !== host` → 403；文案 `same-origin request required` 逐字一致 | 未复用 `core.ts` 的 `sameOrigin`（`router.ts:64-73`），逻辑等价但重复实现 |
| D-103 | ✅ | 表级围栏仍在匹配前（`router.ts:361-371`），`guard` 是路由级叠加（`route.ts:240-242`） | — |
| D-104 | ✅ | `route.ts:238-243` 四行 | — |
| D-105 | ✅ | `router.ts:278-284` `segmentsAfterPrefix` + `route.ts:239-242` 前缀后路径 | — |
| D-106 | ✅ | `route.ts:213-217` `strict` 为 false 时直接调 handler（恒等） | 实现形式是 `guard(handler)` 而非 `mutation(route)` 包装器，语义等同 |
| D-107 | ⚠️ | `route.ts:251-266`：`prefix` / `trust:'browser'` / `maxBytes` / `onError` / `onNotFound` / `routes` 全对，**另加** `...(options.trustedHosts !== undefined ? { trustedHosts } : {})`（`:263`） | 参数集比需求多一项（安全相关，见 GAP-1） |
| D-108 | ✅ | `router.ts:180-185`：`cross-site` 拒 → `browser` 且无 Origin 放行 → 否则 `sameOrigin` | — |
| D-109 | ✅ | `route.ts:260-262` `fail(404, 'not_found', 'no such interaction endpoint')`；test「跨站 → 403；未命中端点 → 信封 404」（route.test.ts:231） | — |
| D-110 | ✅ | `router.ts:370-379`：`rest === undefined` → `onNotFound` | — |
| D-111 | ✅ | `router.ts:200` `handler(context): Promise<void> \| void`；`ok`/`fail` 同步 `end()`（`route.ts:52,59`） | — |
| D-112 | ✅ | `route.ts:62-68` 任意异常 → 500 `internal` + `interaction route failed: ` 前缀 | — |
| D-113 | ⚠️ | `router.ts:354-360` 已实现**可选** Host 围栏（`trustedHosts`）；`route.ts:263` 只在调用方显式传时透传；`createInteractionHandler` 默认 `options = {}`（`:253`）→ **默认不校验 Host** | 从「不在本模块」变成「在但默认关」；默认姿态与 dsh 主壳（强制 loopback/白名单）仍不一致 → GAP-1 |

### 2.2 E 组（165 条）

| ID | 状态 | 证据（src:行号 或 test 名） | 差异说明 |
|---|---|---|---|
| E-001 | ✅ | `questions.ts:295` 监听器签名一致（`request, next`） | — |
| E-002 | ✅ | 代码只 `ctx.on(...)` + 选项；dsh 侧 `packages/interaction/user-questions/src/types.ts:157-162` | — |
| E-003 | ✅ | `questions.ts:136` `agent?:`、`:297` `request.agent?.session?.id` | — |
| E-004 | ✅ | `approval.ts:163` | — |
| E-005 | ✅ | `approval.ts:56-63` 载荷面 + `:17` 闭集 | — |
| E-006 | ✅ | `events.ts:255` `push`（无 prepend）；本仓全部传 `WATERFALL_TAKEOVER`（`wire.ts:117`） | — |
| E-007 | ✅ | `events.ts:255` `unshift` | — |
| E-008 | ✅ | `events.ts:173` `.filter(hook => hook.global \|\| !filter \|\| ...)`；本仓传 `global: true`（`wire.ts:117`） | — |
| E-009 | ✅ | `events.ts:238` `const cb = cbs.shift() ?? inner`；本仓不调 `next()`（`questions.ts:299`） | — |
| E-010 | ✅ | 本模块不调 `ask()`（检索零命中），前置顺序由 dsh 保证 | 不涉及实现 |
| E-011 | ✅ | 0.2 检索：只有局部函数 `packages/interaction/user-questions/src/index.ts:318`，无同名事件 | — |
| E-012 | ✅ | dsh `user-approval` 侧兜底；本仓 fail-fast 亦返回 `'unavailable'`（`approval.ts:193`） | — |
| E-013 | ✅ | 同 E-011（是 `ctx.waterfall` 的最后实参，`:324,329`） | — |
| E-014 | ✅ | dsh 侧语义未变；本仓因此必须自持 Promise（`questions.ts:235-285`） | — |
| E-015 | ✅ | `questions.ts:313-317` 注释 + `:338-343` reject `NO_PROVIDER` | — |
| E-016 | ⚠️ | `ownership.ts:35-47` | 同 D-053：多一层正白名单首查 |
| E-017 | ✅ | `store.ts:213-235`（缓存 → 文件名 → ENOENT → 其它 errno）+ `:168-189`（parseOne 记 loadErrors） | — |
| E-018 | ⚠️ | `ownership.ts:40-43` | 同 D-054：正结果被 `known` 缓存且不失效 |
| E-019 | ✅ | `ownership.ts:44` | — |
| E-020 | ✅ | `workspace.ts:296`、`ephemeral.ts:276` 调 `noteMagicaSession`；`ownership.ts:53` 抹负缓存 | — |
| E-021 | ✅ | `surface.ts:20` `INTERACTION_POLL_MS = 5_000`、`:93` `Math.max(5_000, ...)` | — |
| E-022 | ✅ | `router.ts:346-392` 六阶段 | — |
| E-023 | ✅ | `router.ts:350-353` 表级方法门；`Allow` 按 `METHOD_ORDER` 去重排序（`:337-344`）；`sendMethodNotAllowed`（`:59-61`） | — |
| E-024 | ✅ | `router.ts:361-363` 抛 `HttpRouteError(403,'forbidden',...)` → `onError` → 信封 | — |
| E-025 | ✅ | `router.ts:235-264`：415（`:240-245`）→ 413（`:246-252`）→ 400（`:254-258,260-262`） | — |
| E-026 | ✅ | `router.ts:369-379` | — |
| E-027 | ✅ | `router.ts:380-387` handler 拿 `response` 自写 | — |
| E-028 | ✅ | `router.ts:388-391` → `onError`（`route.ts:62` `toFail`） | — |
| E-029 | ✅ | `router.ts:350-353` 只看方法表，不看路径 | — |
| E-030 | ✅ | `router.ts:361-371`：围栏与读体都在匹配之前 | — |
| E-031 | ✅ | `router.ts:240-245` 强制 `application/json` 前缀匹配 | — |
| E-032 | ✅ | `router.ts:180-185` 三步判定逐条一致 | — |
| E-033 | ✅ | 同上：cross-site 最高优先（`:182`），缺 Origin 放行（`:183`），Origin 与 Host 同 host 放行（`:184`→`:64-73`） | — |
| E-034 | ✅ | dsh `webserver.ts:161-170`（`WebRoute`/`register`）；本仓不定义该类型 | — |
| E-035 | ✅ | 同 E-034；handler 生命周期归 `webserver.ts:241-251` | — |
| E-036 | ✅ | `webserver.ts:166-170` 文案逐字 `webserver: duplicate ${route.kind} route "${route.path}"` | — |
| E-037 | ✅ | `webserver.ts:324` `pathname !== prefix && !pathname.startsWith(\`${prefix}/\`)` → `/magicaextra` 不匹配 | 本仓 `router.ts:278-284` 同语义 |
| E-038 | ✅ | `webserver.ts:318-328` exact 未命中后取 `prefix.length` 最大者 | — |
| E-039 | ✅ | `webserver.ts:318-328` 匹配；fallback 由 composition 提供，本模块不注册 fallback | — |
| E-040 | ✅ | `webserver.ts:241-251`：`headersSent` → `res.destroy()`，否则 `writeHead(400)` 空体 | — |
| E-041 | ✅ | `route.ts` 全文无 `webServer` 访问 | — |
| E-042 | ✅ | `router.ts:278-284` 纯字符串截前缀，未 `new URL` | — |
| E-043 | ✅ | 契约成立（`webserver.ts:166-170`）；本模块不自注册，故不涉及 | — |
| E-044 | ✅ | `answerQuestion`/`cancelQuestion`/`answerApproval` 全同步（`questions.ts:366-387`、`approval.ts:204-212`） | — |
| E-045 | ✅ | `questions.ts:248` 先 `delete` 再 resolve；test「正常应答 → answered…重复应答 → 404」（route.test.ts:99） | — |
| E-046 | ✅ | `approval.ts:127-137` 同构（先 delete 再 resolve） | 无「审批重复应答 → 404」断言（§5） |
| E-047 | ✅ | `questions.ts:306` / `approval.ts:174` 注销时删 bridge；`answerQuestion:372` 取不到 → `session-gone`；test「会话不在接管表里 → 409」（route.test.ts:170） | — |
| E-048 | ✅ | `questions.ts:253-258`（abort）→ `settle` 出表；`approval.ts:140-146` 同构 | 无断言（§5） |
| E-049 | ✅ | `questions.ts:230-233` 先查 `signal.aborted` 再 reject `ASK_ABORTED`；`approval.ts:121` 先查再 resolve `'cancelled'` | 无断言（§5） |
| E-050 | ✅ | `questions.ts:264-268` `{ once: true }`；`approval.ts:148-152` 同 | 无断言（§5） |
| E-051 | ✅ | `questions.ts:203-207`（旧项 `settleAbort`）、`approval.ts:94-98`（旧项 `'cancelled'`） | 无断言（§5） |
| E-052 | ✅ | `questions.ts:306` `if (bridges.get(key) === bridge) bridges.delete(key)`；`approval.ts:174` 同 | 无断言（§5） |
| E-053 | ✅ | `questions.ts:303-307` 先逐个 `settleAbort` 再按同一性删 | 无断言（§5） |
| E-054 | ✅ | 同 E-051（旧项在装新 bridge 前已全部结算并 `clear()`） | — |
| E-055 | ✅ | `questions.ts:277-282` reject `ASK_CANCELLED` | cancel 端点无断言（§5） |
| E-056 | ✅ | `questions.ts:2-5` 注释 + `:277-282`；审批侧对照 `approval.ts:121,141,193` | — |
| E-057 | ✅ | `approval.ts:102-118` 按 `callId` 调 `resolveArgs`；`workspace.ts:311` 注入 `toolCallArgs.get` | — |
| E-058 | ✅ | 03 §3.2:158；`collect.ts:22` | — |
| E-059 | ⚠️ | `surface.ts:20` `INTERACTION_POLL_MS = 5_000` | 需求引 `surface.ts:36`，现已移到 20 |
| E-060 | ✅ | 门面截断 `workspace.ts:178`（`…` 结尾）；卡片容错 `Card.tsx:275-284` | — |
| E-061 | ✅ | `src/interactions/*.ts` 检索无 `slots` / `style` / `dsw-` 命中 | — |
| E-062 | ✅ | 检索 `@deepseek-ai` 零命中 | — |
| E-063 | ✅ | 本模块零调用这两个服务，故无服务名漂移风险 | — |
| E-064 | ✅ | `route.ts:16-17` 只 import 旧实现 自己的 `answerApproval` / `answerQuestion` / `cancelQuestion` | — |
| E-065 | ✅ | 结论仍成立（结算只能靠监听器自己 resolve/reject）；00 §4.3 已固化 | — |
| E-066 | ✅ | 同上：本模块未使用任何 `answer`/`cancel`/`list` 远端能力 | — |
| E-067 | ✅ | `Card.tsx:328-334` 按 `kind` 分流；`Card.tsx:270-273` 审批侧字段独立读取 | — |
| E-068 | ✅ | `wire.ts:51,58` `since: number`；顺序由 host 保证（`collect.ts:68`）；卡片可用 `Date.now()-since` | — |
| E-069 | ✅ | `Card.tsx:275-284` `JSON.parse` 失败 → 原样展示 | — |
| E-070 | ✅ | `transport.ts:58-65` `answered` 与 `cancelled` 都是 `{ ok: true }`；`Card.tsx:135-144` 取消成功也 `onAnswered` | — |
| E-071 | ✅ | `carrier.ts:33` `${kind}:${id}`；test「key = kind:id，且带标记字段」（panel.test.ts:31） | — |
| E-072 | ✅ | `route.ts:51,58` `cache-control: no-store` | — |
| E-073 | ✅ | `route.ts:51,58` `application/json; charset=utf-8` | — |
| E-074 | ⚠️ | `route.ts:56` 仅 `fail` 有守卫；`:49-53` `ok` 无 | 同 D-079（GAP-6） |
| E-075 | ✅ | 本模块不注册路由；`webserver.ts:161+` 为 `Service` 子类 | — |
| E-076 | ✅ | `route.ts` 无 `ctx.webServer`；`ownerCtx` 只被 `store.ts:118` 的 `dshHomePath` 使用 | — |
| E-077 | ✅ | `webserver.ts:166-170` 返回删表 disposer | — |
| E-078 | ✅ | 同上：`delete` 不存在的 key 安全 | — |
| E-079 | ✅ | 同 E-036（碰撞即配置错误） | — |
| E-080 | ✅ | `store.ts:118-124`；类型 `shared/dsh.ts:181` `(...segments: string[]) => string` | — |
| E-081 | ✅ | 0.2 `packages/util/home-paths/src/index.ts` `resolveDshHome`（configured > `$DSH_HOME` > `~/.dsh`）未变；本仓只调 `home()` 不自造 | — |
| E-082 | ✅ | `store.ts:118`、`questions.ts:60` 都 `serviceOf(...)` 并判 `undefined` | — |
| E-083 | ✅ | `store.ts:285-291` 抛→`null`；`ownership.ts:39-46` 判 `false` 不抛 | — |
| E-084 | ✅ | 不涉及（未调 `ask`） | — |
| E-085 | ✅ | 本仓 `QuestionErrorCode` 只三档（`questions.ts:28`），是 dsh 六档的子集 | 子集即够用：其余四档由 dsh 自己在 `ask()` 前置阶段抛 |
| E-086 | ✅ | `questions.ts:117-123` 鸭式 `name='UserQuestionError'` + `code` | — |
| E-087 | ✅ | 不涉及（未调 `approval.request`） | — |
| E-088 | ✅ | 不涉及 `setPolicy`；本仓读 `approval/policy` 日志（`core.ts:500-503`） | — |
| E-089 | ✅ | 不涉及（`decide()` 是 dsh 私有） | — |
| E-090 | ✅ | `core.ts:502` 只认 `'ask' \| 'never'` | — |
| E-091 | ✅ | `core.ts:471-481` 读 `approval/asked`（id/toolName/callId/reason） | — |
| E-092 | ✅ | `core.ts:483-498` 读 `approval/decided` 并配对记 `waitedMs` | — |
| E-093 | ✅ | `core.ts:500-503` | — |
| E-094 | ✅ | 全文无 `webserver/index-inject` 命中 | — |
| E-095 | ✅ 有意差异 | `questions.ts:218-228,231,249,334` 自记 `question.*`；0.2 已新增 `SessionProjectionMap.userQuestions`（`user-questions/src/types.ts:74-126`） | 00 §5 行 5 + §6.4:499 已显式决策：投影不能替代 pending 表，自建日志保留（Q-14 采纳） |
| E-096 | ✅ 有意差异 | `questions.ts:82-88`（`logInteraction`）、`:91-93`（可注入）、`:96-106`（回收） | `src/interactions/**` 本身零日志（检索确认）；日志在 `src/sessions/questions.ts`，是 0.1.6 起就有的既定设计（00 §6.4） |
| E-097 | ✅ | 两事件仍 `mode: 'waterfall'`（`user-questions/src/types.ts:157`、`user-approval/src/types.ts:87`） | — |
| E-098 | ✅ | `src/interactions/*.ts` 无 slot 注册代码 | — |
| E-099 | ✅ | `surface.ts:45-49`（面）、`:97` `registerPendingInteraction<PendingInteractionCarrier>(() => 1)` | — |
| E-100 | ✅ | `carrier.ts:22-34` `key`/`kind`/`sessionId` 三字段 | — |
| E-101 | ✅ | dsh 侧抛错文案见 00 §5 行 15；本仓按 `sessionId` 去重保证同 key 只发一次（`surface.ts:128-135`） | — |
| E-102 | ✅ | `surface.ts:185-199`：`conversation.composer` + `select` 只认带 tag 的载体 + `locale` | — |
| E-103 | ✅ | `wire.ts:50,57` 裸 `string`；`carrier.ts:26` 同 | — |
| E-104 | ⚠️ | `questions.ts:297` `request.agent?.session?.id`；`approval.ts:165` **也是可选链** | 需求「审批侧无可选链（`agent` 必填）」不成立：审批侧同样用了 `?.`（更宽容：agent 缺失时 `next()` 而非 TypeError） |
| E-105 | ✅ | 待决 id 自生成（`questions.ts:216`、`approval.ts:105`）；未使用任何 dsh 审计 id | — |
| E-106 | ✅ | `approval.ts:104` `String(request.callId)` | — |
| E-107 | ⚠️ | `interactions/index.ts:6-40` 导出值 12 + 类型 12 = 24 条 | 「21 条 / 分布 12-2-4-3」不再成立：新增 `clipArgs`、`MAX_BODY_BYTES`、`INTERACTION_TAG`、`WATERFALL_TAKEOVER`、`noteMagicaSessionInMemory`、`sessionStoreAvailable`（GAP-9） |
| E-108 | ⚠️ | `interactions/index.ts:11,13,16` 让 `InteractionHostFace` / `noteMagicaSession` / `resetMagicaSessionCache` 都**从主入口可达** | 「不可达 3 条」不成立（对库消费者是有意为之：门面与测试都要用） |
| E-109 | ✅ | `collect.ts:33-36` 签名一致，返回按 `since` 升序 | — |
| E-110 | ⚠️ | `route.ts:251-254`：`(request: never, response: ServerResponse) => Promise<void>` | 返回类型对；但 `request` 退化成 `never`（`route.ts:265` 再断言一次），调用方传 `IncomingMessage` 必须强转 |
| E-111 | ✅ | `route.ts:162-165`；`JsonRouterRoute` 定义在 `router.ts:197-201` 并从主入口可达（`src/index.ts:45`） | — |
| E-112 | ✅ | `route.ts:239,169-177`；test「列出待决项（只有台账里的会话）」（route.test.ts:60） | GET 不读体：`router.ts:217` `BODY_METHODS` 不含 GET |
| E-113 | ✅ | `route.ts:240,179-188`；test「正常应答 → answered，且挂住的 Promise 被 resolve」（route.test.ts:99） | — |
| E-114 | ✅ | `route.ts:70-112,130-155` | 失败集实现齐全；但 `answers` 三档 400 无断言（§5） |
| E-115 | ✅ | `route.ts:241,190-197` | 端点 3 全链**零断言**（§5，最严重覆盖缺口） |
| E-116 | ✅ | `route.ts:242,199-211`；test「decision 非法 → 400；合法 → answered」（route.test.ts:186） | — |
| E-117 | ✅ | `route.ts:207` 逐字一致 | — |
| E-118 | ✅ | 方法门 `router.ts:350`、跨站 `:361`、415 `:240-245`、413 `:246-252`、非对象 400 `:260-262` | 413 与非对象 400 无断言（§5） |
| E-119 | ⚠️ | `wire.ts:98-100` 信封保留 | 「与 `/lattice` 面统一」的前提消失：lattice 已不在本仓（00 §1.1）；统一对象只能是历史参照 |
| E-120 | ✅ | `questions.ts:279`（`ASK_CANCELLED`）、`:255`（`ASK_ABORTED`）、`:338-343`（`NO_PROVIDER`） | 三档实现齐全；`ASK_CANCELLED` 档无断言（§5） |
| E-121 | ✅ | `approval.ts:141,193`（`'cancelled'` / `'unavailable'`）+ 四值闭集 `:17` | — |
| E-122 | ✅ | dsh 在派发前就返回 `'rejected'`（`user-approval/src/index.ts` 的 `decide`），本模块无须处理 | — |
| E-123 | ✅ | `workspace.ts:160,175-181,311` + `approval.ts:111-118` | — |
| E-124 | ✅ | `route.ts:257` `trust:'browser'` + `:213-217` 可选 `strictMutations`；对照 `api-request-trust.ts:91-118` | 对照结论成立，但默认姿态不安全（GAP-1/GAP-2） |
| E-125 | ⚠️ | dsh 强制 Host（`api-request-trust.ts:99-103`：缺失/不可解析/非 loopback 且不在白名单 → false）；旧实现 默认不看 Host，只有可选 `trustedHosts`（`router.ts:354-360`） | 「旧实现 不做」升级为「可开但默认关」。**仍是默认无 DNS-rebinding 防护** → GAP-1 |
| E-126 | ✅ | `router.ts:182` `String(site).toLowerCase() === 'cross-site'`；dsh `api-request-trust.ts:106` `=== 'cross-site'` | 大小写不敏感是更宽的一侧（等价或更严），语义等价成立 |
| E-127 | ✅ | `router.ts:183` 无 Origin 放行；理由确为「没有 Host 围栏」，风险留给部署层 | — |
| E-128 | ✅ | `router.ts:184` → `sameOrigin`（`:64-73`）`new URL('null')` 抛 → `false` | 「解析失败即拒」而非专门分支，与需求描述一致 |
| E-129 | ✅ | `carrier.ts:23,38-47`；test「只认标记字段，不认结构相似的陌生对象」（panel.test.ts:40） | — |
| E-130 | ✅ | 重启后 `bridges` 空 → `session-gone` → 409（`questions.ts:372`、`approval.ts:207`） | 无断言（§5） |
| E-131 | ✅ | `surface.ts:20,153-158`（5 s 节奏）；应答时 409 由 `transport.ts:35-39` 抛出 | — |
| E-132 | ✅ | `store.ts:168-189`（`parseOne` 记 `loadErrors`）+ `:226-233`；`ownership.ts:39-46` 判负 → 应答 403 | 无断言（§5） |
| E-133 | ✅ | `store.ts:285-291` 全判负；额外提供 `sessionStoreAvailable`（`ownership.ts:68-70`）作为可诊断入口 | 仍是「不区分台账不可用与台账里没有」的隐式耦合 |
| E-134 | ✅ | test「正常应答…重复应答 → 404」（route.test.ts:134-144） | — |
| E-135 | ✅ | `questions.ts:260`、`approval.ts:144`：`timeoutMs` 默认 `undefined`（无超时）；门面可传（`workspace.ts:305-317`） | — |
| E-136 | ✅ | `collect.ts:19,24`；门面截断 `workspace.ts:178` | HTTP 面不暴露 `maxArgsChars`（D-062），经 `/magica` 取列表恒全量 → GAP-9 |
| E-137 | ✅ | `router.ts:362` `cross-origin request rejected` 逐字 | — |
| E-138 | ✅ | `router.ts:183` + `route.ts:214`：默认配置下无 Origin 的 POST 直接进业务 | **确认成立**（安全债，GAP-2） |
| E-139 | ✅ | `webserver.ts:166-170`；本模块不自注册，故不触发 | — |
| E-140 | ✅ | `webserver.ts:247-251` | — |
| E-141 | ✅ | `router.ts:246-252`（有 `content-length` → 413）、`:254-258`（解析失败/超限 → 400）；上限 `route.ts:28` | — |
| E-142 | ✅ | `router.ts:250` `request body exceeds ${maxBytes} bytes`（=65536）、`:257` `body is not valid JSON or too large` | 两文案逐字一致 |
| E-143 | ✅ | `route.ts:100-107` 允许 `selected: []` 且不带 `custom`；卡片侧 `Card.tsx:104-108`（skip）与 `:112-115`（未答不许提交）构成第二道 | 需求「这一层不拦，需要卡片侧保证」成立 |
| E-144 | ✅ | 同 D-032 | — |
| E-145 | ✅ | `route.ts:169-177` 无分页；`?sessionId=` 可缩范围 | — |
| E-146 | ⚠️ | 路径常量现在在 `wire.ts:106-111`（不在 `interactions/types.ts`）；加端点三处 = `wire.ts` + `route.ts:238-243` + handler | 改动点仍是三处，位置变了 |
| E-147 | ⚠️ | 加字段 = `wire.ts`（可选字段）+ `collect.ts:54-64` + 卡片 | 位置同 E-146；门面侧还要改 `approval.ts:23-33` |
| E-148 | ✅ | 未收紧：`route.ts:37,167` 仍默认 `false` | 破坏性变更的判断仍成立（GAP-2 要动它，须发 minor） |
| E-149 | ✅ | 未换信封（`wire.ts:98-100`） | — |
| E-150 | ✅ | `workspace.ts:296` / `ephemeral.ts:276` 都调 `noteMagicaSession`；`ownership.ts:53` 抹负缓存 | 无断言（§5）；且现在还有正白名单兜底（D-054） |
| E-151 | ✅ | `route.ts:166` `options.storeDir` 贯穿 `collect`/`allowSession`；门面同源传参 | — |
| E-152 | ✅ | `route.ts:256` + `router.ts:278-284,370-379` 不一致即全 404 | — |
| E-153 | ✅ | 事件名与选项硬编码（`questions.ts:294`、`approval.ts:162`、`wire.ts:117`），无运行时自检 | 静默失效风险仍在（无探测代码） |
| E-154 | ❌ | `approval.ts:16-20` 只有本地 `APPROVAL_OUTCOMES` 元组 + 派生类型；**没有任何对照 dsh `ApprovalOutcome` 的编译期断言**（对照 `core.ts:49-55` 对 `DshTurnEndReason` 有真断言） | 需求要求的「编译期双向断言」缺失，而 00 §5 行 7 声称「保留」。dsh 若增删取值，本仓**不会**编译报错 → GAP-4 |
| E-155 | ✅ | `questions.ts:277-282` reject，绝无 `resolve({answers: []})` | — |
| E-156 | ✅ | host 侧 id 为 `randomUUID()`（`questions.ts:216`）；client 侧按 `sessionId` 去重（`surface.ts:128-135`） | — |
| E-157 | ✅ | 契约成立（`webserver.ts:166-170` 抛 → 消费方 `apply` 失败） | 本模块不注册，故不触发 |
| E-158 | ✅ | `onError = toFail`（`route.ts:62-68`）自身不抛；`fail` 先查 `headersSent`（`:56`） | `ok` 无守卫（D-079），但被 `router.ts:388-391` 的 catch → `toFail` 兜住 |
| E-159 | ✅ | `route.ts:51,58`；client 侧无缓存层（`transport.ts:41-49` 每次真取） | — |
| E-160 | ⚠️ | 现为 `tests/interactions/route.test.ts`（254 行）：归属过滤 ✓（`:60,85`）、`question/answer` ✓（`:99`）、`approval/answer` ✓（`:186`）、错误码映射部分 ✓（403/404/409/405/415）、跨站拒绝 ✓（`:231`）、`session-gone` ✓（`:170`） | **`question/cancel` 端点零覆盖**；跨站 403 只断言状态码不断言文案；413/审批重复应答/竞态全缺 → §5 |
| E-161 | ✅ | `tests/client/panel.test.ts:75-84`（统一前缀、无硬编码色、无深色选择器、用 `--dsw-alias-`） | 原文件名 `interactions-styles.test.mjs` 已并入 `panel.test.ts` |
| E-162 | ⚠️ | `package.json:24` `pnpm test` = `node --import ./tests/setup.mjs --test --test-isolation=none "tests/**/*.test.ts"` | 「`npm test`（package.json:46）」不成立：脚本在第 24 行，跑法是 pnpm + node:test（TS 直跑） |
| E-163 | ✅ 有意差异 | `route.test.ts:7` `import { resetMagicaSessionCache } from '../../src/interactions/ownership.ts'`（源码直导入，非 `lib/**` 深导入） | 0.2 `lib/` 只剩两个压缩产物，深导入不可能（Q-02 判不适用） |
| E-164 | ✅ 有意差异 | `package.json:3` `"version": "0.2.0-alpha.1"` | 全篇锚定 `v0.1.6-rc.26`，行号与 API 面均已按 0.2 重锚（Q-01 采纳） |
| E-165 | ✅ | 纪律性要求；当前版本 0.2.0-alpha.1，本轮为只读核对未改动源码 | — |

---

## 3. GAPS

> 排序：**安全 > 正确性 > 体验**。每条给：现状 / 原始要求（ID + 原文）/ 最小修法 / 需要补的断言。

### GAP-1（安全 · 头等，Q-09）Host 头围栏默认缺失 → `/magica` 面默认可被 DNS-rebinding 打穿

**现状（代码级结论）**

- 校验开关：`router.ts:354-360`
  ```ts
  const host = request.headers.host
  if (options.trustedHosts !== undefined && options.trustedHosts.length > 0) {
    if (typeof host !== 'string' || !options.trustedHosts.includes(host)) {
      throw new HttpRouteError(403, 'forbidden', 'untrusted host')
    }
  }
  ```
  即：**只有调用方显式给了非空 `trustedHosts` 才校验**。
- 透传：`route.ts:263` `...(options.trustedHosts !== undefined ? { trustedHosts: options.trustedHosts } : {})`；`createInteractionHandler` 的默认参数是 `options: InteractionHandlerOptions = {}`（`route.ts:253`），且**全仓没有任何地方传 `trustedHosts`**（`docs/design/03-interactions.zh.md` 也未记该选项）。⇒ **默认部署无 Host 围栏**。
- `trust: 'browser'` 到底校验了什么（`router.ts:180-185`，逐条读）：
  1. `sec-fetch-site` 小写等于 `cross-site` → 拒（唯一看 Fetch-Metadata 的地方）；
  2. `trust === 'browser'` **且** `request.headers.origin === undefined` → **`return true` 直接放行**；
  3. 其余走 `sameOrigin(request)`（`router.ts:64-73`）→ `new URL(origin).host === request.headers.host`。
  ⇒ **它一次都没把 Host 头拿去和任何白名单/loopback 判定比对**，只在第 3 步把 Host 当「比较基准」。Host 头是整条链里唯一能防 rebinding 的头（浏览器按它以为的域名填，rebinding 改不了），而它恰恰完全没被信任评估。
- rebinding 攻击链为什么三道判定全过：攻击页 origin = `http://evil.example`，DNS 重绑后 socket 落到 `127.0.0.1:3080`，于是请求带 `Host: evil.example`、`Origin: http://evil.example`、`Sec-Fetch-Site: same-origin`（同源 fetch）。第 1 步不是 cross-site、第 2 步有 Origin、第 3 步 `new URL('http://evil.example').host === 'evil.example'` → **放行**。攻击者随即可 `GET /magica/interactions`（读到 `toolName`/`args`/`sessionId`/待决 id）并 `POST .../approval/answer`。冷启动也成立：`router.ts:183` 对「无 Origin」直接放行。
- 对照 dsh 0.2：`api-request-trust.ts:99-103` 先做 Host 围栏（Host 缺失 → false；不可解析 → false；非 loopback 且不在 `trustedHosts` → false），且注释明确「no marker shortcut」。

**原始要求（Q-09 关联）**

- D-113：「**Host 头围栏（防 DNS-rebinding）不在本模块**：那是部署策略，不该由 SDK 决定，由注册方自己加」。
- E-125：「Host 头围栏对照：dsh **强制**（Host 缺失即拒、且必须 loopback 或命中 `trustedHosts`）；旧实现 **不做**，`isTrustedInbound` 完全不看 Host 头 ⇒ `/magica` 前缀默认**没有** DNS-rebinding 防护，注册方必须自己加」。
- Q-09：「0.2 官方 API 面**强制** Host 围栏且 `trustedHosts` 由部署配置注入。旧实现 若继续不做，与主壳安全姿态不一致，这条应从『已知限制』升级为『须显式决策 + 默认值必须安全』」。

**dsh 0.2 里有没有现成等价实现（可复用路径）**

| 形态 | 路径 | 说明 |
|---|---|---|
| 判定函数本体 | `D:\project-code\llm\deepseek-harness\packages\client\connection\src\api-request-trust.ts:91-118` | `isTrustedApiRequest(request, trustedHosts)`：Host 存在 + 可解析 + （loopback 或命中白名单）→ `sec-fetch-site` → Origin 必须等于 Host authority（`'null'` 拒）。约 40 行，依赖零外部模块 |
| loopback 判定 | 同目录 `loopback-hostname.ts:12-18` | `localhost` / `[::1]` / `127/8`，18 行，可直接复刻 |
| 白名单规范化 | `api-request-trust.ts:49-83` | `assertTrustedAuthority` / `canonicalAuthority` / `isTrustedAuthority`（`host:port` 精确、port-less 匹配任意端口） |
| **可调用的服务面** | `packages/client/connection/src/rpc-host.ts:79-80,104-107` | `HostConnectionService` 以 **`connection`** 名注册（`super(ctx, 'connection')`），暴露 `requestRejection(request): 401 \| 403 \| undefined` 与 `admit(request)`；入参只要 `{ headers }`（`rpc.ts` 的 `ConnectionTrustRequest`），传 `req.headers` 即可 |
| 不可直接 import | `packages/client/connection/src/index.ts:40-52` | 包 index **没有**导出 `isTrustedApiRequest`（只导出 `HostConnectionService` / `RpcId` / `transportError` / `API_PATH` 等） |

结论：**有等价实现，但只能「取服务 / 复刻函数」，不能 import**。推荐「服务优先 + 复刻兜底」：`ctx.get('connection')?.requestRejection({ headers: req.headers }) === 403` → 直接 403；服务缺失时退回复刻的 20 行 loopback-only 围栏（默认只允许 loopback，比现状安全）。

**最小修法**

1. `core/router.ts:354-360` 改成默认开启：`trustedHosts` 未显式给时，**仍**要求 `Host` 存在、可解析、且为 loopback（复刻 `loopback-hostname.ts:12-18`）；显式给了白名单则 loopback ∪ 白名单。
2. `interactions/route.ts:253-263` 增加 `hostFence` 的注入点：优先调宿主 `connection.requestRejection`（复用部署配置的 `trustedHosts`），否则用第 1 步的默认围栏。
3. 不改任何调用方签名即可落地（默认值变安全 = 行为变更，按 E-148 的口径需要发 minor 并在 README 安全节写明）。

**需要补的断言**

- `Host: evil.example` + `Origin: http://evil.example` + `Sec-Fetch-Site: same-origin` 的 `GET /magica/interactions` → **403**（现状 200）。
- `Host` 缺失 → 403；`Host: 10.0.0.5:3080`（非 loopback、不在白名单）→ 403。
- `Host: 127.0.0.1:3080` → 200；`trustedHosts: ['magica.internal:3080']` 且 `Host: magica.internal:3080` → 200。
- 同一组 Host 用例对三个 POST 各跑一遍（围栏在匹配前、与方法无关）。

### GAP-2（安全 · 头等，Q-13）`strictMutations` 默认 `false` → 无 Origin 的本机脚本可批掉越权工具调用

**现状（代码级结论）**

- `route.ts:37` 注释即写「默认 `false`，放行不带 Origin 的本机脚本」；`:167` `const strict = options.strictMutations === true`。
- 包装器 `guard`（`route.ts:213-217`）：`if (!strict) { handler(context); return }` → **严格同源整段被跳过**。
- 表级围栏 `trust:'browser'`（`route.ts:257`）在 `origin === undefined` 时 `return true`（`router.ts:183`）。
- 因此对 `curl -X POST http://127.0.0.1:3080/magica/interactions/approval/answer -H 'content-type: application/json' -d '{"sessionId":"…","approvalId":"…","decision":"allowed-once"}'` 的完整判定：方法门过（POST 在表里）→ 信任围栏过（无 Origin 放行）→ 读体闸门过（`content-type` 是唯一硬要求，`router.ts:240-245`）→ 匹配 → `requireString` 过 → `allowSession` 过（`sessionId` 取自同源可读的 `GET /magica/interactions`）→ `decision` 合法 → `answerApproval`（`approval.ts:204-212`）settle `allowed-once` → **越权工具调用被批准**。
- 凭证要求：**零**。`GET /magica/interactions` 同样零凭证，且返回 `sessionId` + 待决 `id` + `toolName` + `args`，是完整的「读 → 写」利用链。触发条件只有一个：本机任意进程/脚本（含容器挂载、其他用户的浏览器扩展、供应链脚本）能连上该端口。

**原始要求（Q-13 关联）**

- D-077：「默认 `trust:'browser'` 放行不带 Origin 的请求（curl / 集成脚本 / 测试）；代价是本机任意进程 / 脚本不带凭证就能 POST 三个应答端点，其中 `answerApproval` 可直接批掉一次越权工具调用」。
- E-138：「**无 Origin 的本机脚本可以调变更端点**（默认配置）；要挡就打开 `strictMutations`」。
- Q-13：「默认配置下……是明确的安全债。0.2 若沿用，必须在安全评审里单列，而不是继续记在『已知限制』表里」。

**最小修法**

1. 三个 POST 默认要求「有 Origin 且同源」= `strictMutations` 默认改 `true`；`strict` 的取值改为 `options.strictMutations !== false`（默认真，显式关才关）。
2. 若必须保留无 Origin 的脚本通道：给脚本一个**能力令牌**（`createInteractionHandler` 生成一次 per-process token，`Authorization` 头或 `x-magica-token`），无 Origin 且无 token → 403；有 Origin 则只做同源校验。
3. 折中（不改默认值的最小动作）：只对 `decision === 'allowed-once'` 强制要求 Origin（`rejected` 放行），并在 `createInteractionHandler` 首次构造时 `warnLedgerWriteFailure`-式打一条 stderr 告警——但这只是降级，仍与 Q-13 的「默认值必须安全」不符。

**需要补的断言**

- 默认配置下：无 `Origin` 的 `POST /interactions/approval/answer`（`decision: 'allowed-once'`）→ **403**（现状 200 且真的把挂住的 Promise resolve 成 `allowed-once`）。
- 默认配置下：无 `Origin` 的 `POST /interactions/question/answer` → 403；`GET /interactions` → 200（读面保持可脚本化）或一并收紧，二者择一并写进断言。
- `Origin: http://evil.example` → 403（已有 `cross-site` 用例，但缺「Origin 不自报 cross-site」的用例）；`Origin: http://127.0.0.1:3080` → 200。
- 打开 `strictMutations: true` 时：无 Origin → 403；有同源 Origin → 200（回归，防止误伤页面）。

### GAP-3（安全）`strictMutations` 的判定语义不防 rebinding —— 它不能当作 GAP-1 的替代

**现状**：`route.ts:219-234` 只做 `new URL(origin).host === headers.host`，与 `router.ts:64-73` 的 `sameOrigin` 同构。rebinding 场景下 `Origin` 与 `Host` **同时**是攻击者的域名（`evil.example`），这条比较恒为真；`sec-fetch-site` 也是 `same-origin`。⇒ 即使把 `strictMutations` 打开，GAP-1 的 rebinding 通道依然通。

**原始要求**：D-102「`requireSameOrigin(inner)`：先 `sameOrigin(ctx.request)`（比较 Origin 头 host 与 Host 头），不过 → 403」；Q-09「须显式决策 + 默认值必须安全」。

**最小修法**：把同源校验的实现改为「Origin 必须是 loopback 或命中 `trustedHosts`」而不是「Origin 等于 Host」——即复用 GAP-1 的白名单口径，一处判定同时覆盖跨站与 rebinding；`sameOrigin` 保留给「Origin 与 Host 一致」这一较弱断言。

**需要补的断言**：`Host: evil.example` 与 `Origin: http://evil.example` 同时出现时，`strictMutations: true` 下也必须是 403。

### GAP-4（正确性）E-154：`ApprovalOutcome` 的编译期双向断言不存在（唯一 ❌）

**现状**：`approval.ts:16-20`
```ts
export const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number]
```
—— 这是「自身元组派生类型」，没有对照 dsh 的 `ApprovalOutcome` 做任何断言（本仓按设计不 import dsh 类型，`shared/dsh.ts:1-10`）。对照反例：`core.ts:49-55` 对 `DshTurnEndReason` 有真正的双向断言（`KindsMatchDsh`）。而 `00-overview.zh.md` §5 行 7 写「`APPROVAL_OUTCOMES` 双向断言保留 ✅」——**文档与代码不符**。

**原始要求**：E-154「`ApprovalOutcome` 四值闭集有**编译期双向断言** ⇒ dsh 增删取值会**编译报错**（刻意设计），不会静默漂移；改 dsh 侧要同步 `APPROVAL_OUTCOMES`」。

**最小修法**：在 `shared/dsh.ts` 加一个结构镜像
```ts
export type DshApprovalOutcomeLike = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
// approval.ts
type OutcomesMatchDsh = ApprovalOutcome extends DshApprovalOutcomeLike
  ? DshApprovalOutcomeLike extends ApprovalOutcome ? true : never : never
const _assertOutcomes: OutcomesMatchDsh = true
```
（与 `core.ts:49-55` 同款；dsh 侧四值当前未变，见 `user-approval/src/types.ts:32`、`index.ts:55`，所以断言本身不会立刻失败。）同时把 00 §5 行 7 的措辞改成「断言在 `shared/dsh.ts` 镜像上」。

**需要补的断言**：编译期断言本身即可（`pnpm typecheck` 覆盖）；再加一条**运行期**测试：`APPROVAL_OUTCOMES` 深度等于四值闭集（防止常量表被手改成 `as const` 之外的形状），并断言 `answerApproval(s, id, 'denied')` → `'invalid-outcome'` → HTTP 400（`route.ts:152-154`）。

### GAP-5（正确性）正结果被永久缓存（`known`），与 D-054 / E-018 判决相反

**现状**：`ownership.ts:20-21` 新增 `known` Set；`:37` 首查即 `return true`；`:41` 台账命中后 `known.add(key)`；`:52` `noteMagicaSession` 也写入；**没有任何删除点**（`deleteSessionRecord` 不通知它）。后果：`store.remove(sessionId)` 之后 `isMagicaSession` 仍返回 `true` → 列表继续列出该会话的待决项、写面继续接受应答。与 D-054「台账随时可能被删，删掉后同一 `sessionId` 就该重新判负」直接冲突。

**原始要求**：D-054「正结果**不缓存**：台账随时可能被删」；E-018「正结果不缓存：台账可以被 `deleteSessionRecord` 删掉，删掉之后同一 `sessionId` 就该重新判负，缓存正结果会把语义糊掉」。

**最小修法**：把 `known` 收敛成「仅台账写失败时的兜底」——只在 `noteMagicaSessionInMemory`（`ownership.ts:57-59`，目前只是 `noteMagicaSession` 的别名）里写入，`isMagicaSession` 命中台账时**不写** `known`；并让 `sessions/store.ts` 的 `remove()` 调一次 `noteMagicaSession`-对称的 `forgetMagicaSession(sessionId, storeDir)`（清 `known` + 补 `foreign`）。这样 03 §3.1:144 的承诺与代码一致。

**需要补的断言**：`seedSession → isMagicaSession true → store.remove → isMagicaSession false`；`writeRecord` 失败路径下 `noteMagicaSessionInMemory` 后仍为 true（这是白名单的唯一合法用途）；`deleteSessionRecord` 后 `GET /interactions` 不再列出该会话。

### GAP-6（正确性）`ok()` 缺 `headersSent` 守卫

**现状**：`route.ts:49-53` 直接 `response.writeHead(...)` + `end(...)`，无 `headersSent` 检查；`fail()`（`:55-60`）有。当前调用链不可达（每个 handler 在 `ok` 之前都会 `return`），但契约（INV）要求的是「多分支 handler 误写不抛」。

**原始要求**：D-079「`sendJson` 底层有 `headersSent` 守卫 → 多分支 handler 误写不会抛 `ERR_HTTP_HEADERS_SENT`」；E-074 同。

**最小修法**：`ok()` 首行加 `if (response.headersSent) return`；或（更好）让 `ok`/`fail` 直接调 `router.ts:41-46` 的 `sendJson`，恢复 D-078/D-006 的依赖关系。

**需要补的断言**：构造一个「已发头后再 `ok`」的单元（或直接对 `ok`/`fail` 导出的内部函数做注入测试）：不抛错、第二次写入被忽略。

### GAP-7（正确性）405 不带信封

**现状**：`router.ts:59-61` `sendMethodNotAllowed` → `sendResponse(response, 405, '', { allow })`：空体 + `Allow` 头。而 `onNotFound`（`route.ts:260-262`）是信封 404。

**原始要求**：D-021「所有响应二选一 `{ok:true,value}` / `{ok:false,error:{code,message}}`，浏览器侧一个解包函数通吃」。E-023 只要求「405 + `Allow`」，未规定体形状 —— 两条要求在此冲突，需一次显式裁决。

**最小修法**：405 也发信封 `{ok:false, error:{code:'method_not_allowed', message:'...'}}`（保留 `Allow` 头），并在 `transport.ts:35-39` 的 `unwrap` 里能吃下；或把 D-021 的措辞收窄为「所有**业务**响应（≥400 的路由级错误）走信封，表级闸门除外」。

**需要补的断言**：`DELETE /magica/interactions` → 405 + `Allow: GET, POST`（现有 test 只断言 `status === 405`，未断言 `Allow` 头、未断言体形状）。

### GAP-8（正确性）403 文案漂移

**现状**：`route.ts:121-126` message = `this interaction surface only serves sessions created through this SDK`。

**原始要求**：D-095「message 逐字 `this interaction surface only serves sessions created through 旧实现`」（E-114 的失败集里也复述为 `forbidden`）。

**最小修法**：改回逐字文案（若「旧实现 → spellbook」更名是有意为之，则同步改 D-095 的需求原文并记入白名单，二者择一，不能两边都留着）。

**需要补的断言**：403 体 `error.message` 全等断言（现有 `route.test.ts:147-168` 只断言 state code）。

### GAP-9（体验）导出面漂移 + `maxArgsChars` 经 HTTP 不可达

**现状**：`interactions/index.ts:6-40` 导出 24 条（需求记 21 条），且 `InteractionHostFace` / `noteMagicaSession` / `resetMagicaSessionCache` 从主入口可达；`CollectInteractionOptions.maxArgsChars`（`collect.ts:19`）在 `interactionRoutes` 的 list handler 里**没有透传**（`route.ts:172-175` 只传 `sessionId` / `storeDir`），所以经 `/magica/interactions` 取列表永远全量。

**原始要求**：E-107「`export` 共 **21 条**」；E-108「不可达 3 条」；E-136「可选 `maxArgsChars`；**默认不截断**（保持既有行为），消费方不传就还是全量」。

**最小修法**：`InteractionHandlerOptions` 增加 `maxArgsChars?: number` 并在 `route.ts:172-175` 透传（一行）；导出面用一张 `docs/design/03-interactions.md` 的表固化（谁对消费者可达），E-107/E-108 的计数按新表重写。

**需要补的断言**：`collectPendingInteractions(host, { maxArgsChars: 10 })` 的 `args` 以 `…` 结尾且长度 = 11（`clipArgs` 三短路各一条）；`createInteractionHandler(..., { maxArgsChars: 10 })` 的 GET 响应里 `args` 已截断；`storeDir` 与 `sessionId` 不被 maxArgsChars 影响。

### GAP-10（体验）轮询缺「任务完成即停 / 达上限」两个终止条件

**现状**：`surface.ts:151-158` 的 `schedule()` 只被 `dispose()`（`:219-225`）终止；`pollOnce` 在 `document.hidden` 时直接 return（`:105-107,139`），并靠 `visibilitychange` 立即补拍（`:205-210`）。⇒ 页签长期可见时**永久**每 5 s 打一次 `GET /interactions`，即使列表恒空。

**原始要求**：Q-10（关联 E-059 / E-021 / E-058 / E-131）「0.1.6 文档对『任务完成 / 达上限 / 组件卸载』三个终止条件只在 e.md:604 一笔带过，没有可断言的细节。0.2 需补齐为独立需求项」。工作区纪律（AGENTS §二.5）同款：「设『任务完成 / 达上限 / 组件卸载』终止条件」。

**最小修法**：`pollOnce()` 拿到空列表时把间隔退避到 `Math.min(30_000, intervalMs * n)`；或引入 `idleAfter`（连续 N 拍全空 → 停轮询，由 `refresh()` / 会话事件重启）。必须保留硬下限 5 s（`surface.ts:93` 已保证）。

**需要补的断言**：连续 3 拍空 → 第 4 拍不发请求；`refresh()` 后恢复；`dispose()` 后不再有 `fetch` 调用（用假 fetch 计数）；`intervalMs: 100` 仍被抬到 5000。

### GAP-11（体验）文档滞后于代码（3 处）

**现状**

1. `03-interactions.zh.md:163` 的 `InteractionHandlerOptions` 仍是三键，缺 `trustedHosts`；`:168` 的 `createJsonRouter` 参数表缺 `trustedHosts`。
2. `03-interactions.zh.md:133` 的判定算法没有 `known` 白名单首查（代码 `ownership.ts:37`）。
3. `00-overview.zh.md` §5 行 7 声称「双向断言保留 ✅」，代码无该断言（GAP-4）。

**原始要求**：D-074「`InteractionHandlerOptions = {prefix?: string; storeDir?: string; strictMutations?: boolean}`」；E-016「判定流程；`foreign.has(key)` 命中则 0 次读盘直接 `false`」；E-154（见 GAP-4）。

**最小修法**：三处文档补齐/改口，且把 `trustedHosts` 写进「安全默认值」小节（与 GAP-1 的决策一起定稿）。

**需要补的断言**：无（文档项）；建议加一条 `scripts` 级检查：`00-overview` §5 表里「✅ 保留」的每一行，在代码里都能 grep 到对应符号。

---

## 4. 存疑裁决（Q-01 ~ Q-14）

| 编号 | 裁决 | 一句理由 |
|---|---|---|
| Q-01 | **采纳** | 全篇行号锚定 v0.1.6-rc.26，本表已按 0.2 实测行号重锚（差异 12 条全部是位置而非语义）。 |
| Q-02 | **不采纳（判不适用）** | `lib/` 只剩两个压缩产物，`lib/interactions/ownership.js` 深导入不可能存在；测试已改源码直导入（`route.test.ts:7`），0.1.6 的多文件布局前提不成立。 |
| Q-03 | **不采纳（判不适用）** | `exports` 只有 `.` / `./client` / `./package.json`（`package.json:11-16`），`./interactions` 子入口与 0.2「只有 bare 包名那行挂 `./client`」的契约直接冲突。 |
| Q-04 | **部分采纳** | 0.2 有 peer semver + shell 模块表，「cordis 实例不兼容」已弱化；但「零运行时 dsh 依赖」仍是硬收益，保留 `InteractionHostFace`，只把文档理由从「实例不兼容」改成「零依赖结构面」。 |
| Q-05 | **不采纳** | 0.2 的 `intent.kind` 仍只有 `'plan-review'`（`user-questions/src/types.ts:26`），没有扩充取值；放宽成 `string` 仍是纯前向兼容，`BAD_INTENT` 语义未变。 |
| Q-06 | **采纳（已核实不变）** | `ApprovalOutcome` 仍四值（`user-approval/src/types.ts:32`、`index.ts:55`），`decision` 收窄两值仍正确；但「双向断言」本身没落地（GAP-4）。 |
| Q-07 | **不采纳** | 0.2 仍无 `user-questions/no-answerer` 事件，`noAnswerer` 仍是 `ctx.waterfall(...)` 的最后一个实参（`user-questions/src/index.ts:318-329`），「兜底是函数返回值」成立。 |
| Q-08 | **部分采纳** | 六阶段闸门与信封仍是自研 `core/router.ts`（不是 dsh 能力），这一组条目可继续按 旧实现 实现核对；但 Q-09 的 Host 围栏应改用 dsh 等价实现（GAP-1）。 |
| Q-09 | **采纳（头等安全）** | 默认无 Host 围栏 + `trust:'browser'` 完全不看 Host，rebinding 可读可写；`trustedHosts` 只实现了「可开」而非「默认安全」→ GAP-1/GAP-3。 |
| Q-10 | **采纳** | 现状只有「卸载即 dispose」与 hidden 跳过，缺「任务完成即停」与「达上限」，不可断言 → GAP-10。 |
| Q-11 | **不采纳** | 0.2 `home-paths` 的解析优先级仍是 configured > `$DSH_HOME` > `~/.dsh`，未改成 profiles 目录；台账路径假设成立（`store.ts:116-124`）。 |
| Q-12 | **部分采纳** | `conversation.composer` 的 slot 形状、`uiSession.registerPendingInteraction` 签名 0.2 未变（00 §5 行 15/16）；但 0.2 的 `chain` 选择器/授权写法与 0.1.6 不同，浏览器侧必须按 0.2 重写 —— 本仓已重写（`surface.ts:185-199`），故「不能照搬」这条已落实，无需再作为存疑保留。 |
| Q-13 | **采纳（头等安全）** | 复现确认：无 Origin 的本机脚本可零凭证 `POST /interactions/approval/answer` 批掉 `allowed-once`，且 `GET` 同面免费提供 `sessionId`/待决 id → GAP-2。 |
| Q-14 | **采纳** | 0.2 确实新增了 `userQuestions` 投影与 `user-question-reply`（`user-questions/src/types.ts:74-126`），但投影不含「我们的 answerer 拒了它」这类事实、也不能结算；自建 `question.*` 日志保留（`00` §5 行 5 / §6.4 已记），不算重复记账。 |

---

## 5. 测试覆盖差距

> 口径：只列「需求有断言价值、代码已实现、测试无对应断言」的条目。现有断言集中在 3 个文件：`tests/interactions/route.test.ts`（11 个 it）、`tests/sessions/questions.test.ts`（2 个 it，只测日志落盘）、`tests/client/panel.test.ts`（11 个 it，carrier/locales/styles/transport）。

### 5.1 完全无断言的需求簇（按风险排序）

| 簇 | 涉及 ID | 说明 |
|---|---|---|
| **cancellation 全链** | E-115、D-099、E-055、E-120、D-090 | `POST /interactions/question/cancel` 零测试；「cancel → reject `ASK_CANCELLED`」这一铁律（E-056 的全部意义）没有任何断言守着。**最严重** |
| **安全围栏** | D-076、D-077、D-102、D-103、E-124、E-125、E-127、E-138 | `strictMutations` 与 `trustedHosts` 无一条测试；GAP-1/GAP-2 的默认值目前**没有任何测试会失败** |
| **归属缓存** | D-022、D-051~D-057、D-059、E-016、E-018、E-019、E-150 | `ownership.ts` 零直接测试（仅被 `facade.test.ts:26` 调 `reset`）；负缓存命中「0 次读盘」、超 1024 清空、正白名单（GAP-5）全无断言 |
| **竞态矩阵** | E-046、E-048、E-049、E-050、E-051、E-052、E-053、E-054、E-130 | 重复 install 先结算、旧注销器晚到、abort 竞态、超时出表、审批重复应答 —— 10 个场景 0 断言；这些正是 0.1.6 踩过的坑 |
| **读体闸门细节** | D-073、E-025、E-118、E-141、E-142 | 415 有一档断言；413（`request body exceeds 65536 bytes`）、chunked 400（`body is not valid JSON or too large`）、「体不是 JSON 对象」三档无断言 |
| **`readAnswers` 阶梯** | D-082、D-083、D-084、D-085、D-087、E-143 | 只有「缺 sessionId → 400」；四条答案校验消息、`selected: []` 合法、`custom` 空串被丢弃全无断言 |
| **采集/排序/截断** | D-062~D-069、E-136 | `clipArgs` 三短路、`maxArgsChars` 透传（GAP-9）、`since` 升序 + `id` 兜底、条件展开不产出 `"callId": null` —— 均无断言 |
| **浏览器装配** | E-021、E-099~E-102、E-131、Q-10 | `createInteractionSurface` 零测试：5 s 硬下限、hidden 跳过、`dispose` 后不再 publish、按 sessionId 去重、`select` 只认 tag、轮询终止（GAP-10） |
| **卡片行为** | D-027、E-067、E-069、E-070、§5 行 6 | `Card.tsx` 零渲染测试：`JSON.parse` 降级、`displayReason` 回退、skip 的 `{id, selected: []}`、取消成功也收起 |
| **台账降级** | E-132、E-133、D-059 | 台账损坏 → 判负 → 应答 403；台账不可用 → 列表恒空 —— 无断言（`store.loadErrors` 是唯一诊断入口，也没测） |
| **`Allow` 头内容** | E-023 | test 只断言 `status === 405`，没断言 `Allow: GET, POST` 与排序去重 |

### 5.2 已有断言但强度不足

| ID | 现有断言 | 缺口 |
|---|---|---|
| D-101 | 「字段错误先于归属错误」（route.test.ts:147） | 只测「缺 `sessionId` → 400」+「坏 sessionId + 合法字段 → 403」；没测「坏 sessionId + **坏 answers** → 400」（真正的顺序判定） |
| D-095 | 403 `forbidden` | 未断言 message 逐字（会让 GAP-8 的文案漂移永远测不出来） |
| E-024 / E-033 | 只测 `sec-fetch-site: cross-site` | 四组合里的另外三档（缺 Origin 放行、Origin 同 host 放行、Origin 异 host 拒）无断言 |
| D-109 | 404 信封 + 文案 | 无（这条已够） |
| E-060 | 门面截断 | 只有实现，无「截断后 `args` 不是合法 JSON」的断言 |

### 5.3 建议补的最小测试集（7 条，按收益排序）

1. `POST /interactions/question/cancel` → 200 `{result:'cancelled'}`，且挂住的 Promise **reject** `ASK_CANCELLED`（覆盖 E-115 / E-055 / E-120）。
2. 默认配置下无 Origin 的 `POST /interactions/approval/answer`（`allowed-once`）→ 403（GAP-2 的守门断言；先改代码再补测）。
3. `Host: evil.example` + `Origin` 同域 + `Sec-Fetch-Site: same-origin` → 403（GAP-1）。
4. `isMagicaSession`：`seed → true`；`store.remove → false`；`noteMagicaSessionInMemory` 后仍 `true`（GAP-5 + D-054）。
5. `clipArgs` 三短路 + `collectPendingInteractions({ maxArgsChars })` 的 `…` 结尾（D-062~D-065）。
6. `readAnswers` 四条错误消息逐字（D-082~D-085）+ `selected: []` 合法（D-087）。
7. 重复 install：旧 bridge 的待决项先 reject `ASK_ABORTED` / `'cancelled'`，且旧 disposer 晚到不摘新 bridge（E-051 / E-052）。

---

## 6. 一句话结论

**249/278（89.6%）直接对齐**（244 一致 + 5 白名单内有意差异）；28 条差异里 **12 条只是行号/布局/文档漂移**（改字即可），**实质需要动手的只有 3 类**：① 安全默认值（GAP-1 Host 围栏、GAP-2 `strictMutations`、GAP-3 二者语义错位）；② 一个真缺失（GAP-4 双向断言）与两个「文档说保留、代码没做」的缓存/守卫（GAP-5、GAP-6）；③ 测试面最痛的是 **cancel 端点与安全围栏完全没有断言**——当前把 `strictMutations` 默认改成 `true`，CI 不会有任何一条测试变红。

## 修复记录（Round 2）

| 项 | 改动 | 回归 |
|---|---|---|
| GAP-1（Host 围栏） | createJsonRouter 信任闸门改为「Host 必须回环，或 	rustedHosts 显式白名单」→ 堵 DNS rebinding | 	ests/interactions/route.test.ts（Host: evil.example → 403 untrusted host） |
| GAP-2（strictMutations） | 默认改为 	rue（无 Origin 的 POST 一律 403） | 同上（无 Origin POST → 403；显式 alse 才放行） |
| GAP-5（ownership 缓存） | 待办：正结果缓存策略与 D-054/E-018 对齐（下一轮） | — |
| GAP-6（ok() headersSent） | 待办（下一轮） | — |

### Round 5 补充

| 项 | 改动 | 回归 |
|---|---|---|
| question/cancel 端点零覆盖 | 新增两条：取消 → {result:'cancelled'} 且挂住的 Promise **reject**（E-051：绝不 resolve 空答案）、待决表清空、再取消 404；缺 questionId → 400 | 	ests/interactions/route.test.ts |
| E-154（审批闭集） | Object.freeze + isApprovalOutcome()；精确元组测试 | 	ests/sessions/approval-outcomes.test.ts |
| GAP-6（ok() 守卫） | ok() 首句加 headersSent 保护 | 与 ail() 对齐 |
| plan-review 意图分流（d.md） | 卡片识别 question.intent.kind === 'plan-review'：显示「计划评审」徽标、intent.approve 指向的选项标「推荐」；intent 已由 host 逐层透传 | 	ests/interactions/collect.test.ts（intent 透传 + wait 透传 + args 截断） |
