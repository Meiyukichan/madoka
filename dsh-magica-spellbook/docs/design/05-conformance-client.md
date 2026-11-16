# 05 · 客户端一致性核对（G1-client 616 条 × 实现 × 测试）

> 性质：**只读核对**。不改源码、不跑测试、不改 `package.json` / profile。
> 输出对象：`docs/design/05-conformance-client.md`。
> 输入：需求清单 `.e2e/audit/G1-client.md`（A-001–A-280 来自 `docs/raw/a.md`，B-001–B-336 来自 `docs/raw/b.md`）；实现 `src/client/panel/*`、`src/client/directory-browser/*`、`src/client/index.ts`、`src/shared/wire.ts`（相关处顺带核 `src/sessions/*`）；测试 `tests/client/*.test.ts`。
> **口径**：需求清单描述的是 0.1.6 `@amazing-tools/dsh-magica` 的实现事实。本仓是 0.2 的重写，模块已改名（`interactions/*` → `panel/*`），因此「一致」= **契约语义等价**（允许改文件名 / 行号漂移 / 内部函数拆并）；只有「行为、数据形状、生命周期、可见文案」才是判定依据。
>
> 状态定义：
> - `✅一致` —— 契约存在且语义等价（证据给出实际行号）。
> - `⚠️有差异` —— 能力存在，但形状 / 数值 / 命名 / 触发条件与需求不同（含等价重命名、文案改字）。
> - `❌缺失` —— 实现中不存在对应能力。
> - `✅有意差异` —— 差异被白名单文档显式批准：`docs/design/00-overview.zh.md` §3.5（client.js 是 ESM bundle、panel 无 CSS 文件、样式走字符串）、§3.7（`./directory-browser` 源码入口）、§3.8（真机 E2E 结论）、§5（0.2 适配矩阵）；`docs/design/04-client.zh.md`（目录选择器设计）。
>
> 证据图例（省略 `src/client/` 前缀）：`surface:`=`panel/surface.ts`、`carrier:`=`panel/carrier.ts`、`Card:`=`panel/Card.tsx`、`Composer:`=`panel/Composer.tsx`、`runtime:`=`panel/runtime.ts`、`styles:`=`panel/styles.ts`、`locales:`=`panel/locales.ts`、`transport:`=`panel/transport.ts`、`panel/index:`=`panel/index.ts`、`client/index:`=`client/index.ts`、`DB:`=`directory-browser/DirectoryBrowser.tsx`、`DB.css:`=`directory-browser/DirectoryBrowser.module.css`、`wire:`=`src/shared/wire.ts`、`primitives.d.ts:`/`globals.d.ts:` 同名文件；测试证据写作 `panel.test.ts:行 + 用例名`。

---

## 1. 统计

| 状态 | 条数 | 占比 | 说明 |
|---|---|---|---|
| ✅一致 | **383** | 62.2% | 契约存在且语义等价（`surface`/`carrier`/`transport`/`locales`/`styles` 的 token 用法、图标与文案使用点大多在此档） |
| ⚠️有差异 | **156** | 25.3% | 能力在，但形状/声明集合/触发条件不同（集中在 `DB` 的交互语义、`styles` 的声明缺项、`locales` 的文案改字） |
| ❌缺失 | **61** | 9.9% | 实现中不存在（`DB` 的 `readDraft`/`visibleEntries`/焦点四标记、卡片推荐徽标与 ARIA、3 处 scrollbar/stroke 重绑、`browser.*` 字典与 3 个 key） |
| ✅有意差异 | **16** | 2.6% | 白名单批准（`client.js` 是 ESM bundle、`panel` 无 CSS 文件走字符串、`./directory-browser` 源码入口、externals 9 项、库不写 `apply`/`dsh.client`） |
| **合计** | **616** | 100% | A 段 280 + B 段 336，ID 连续无缺号无重号 |

> 样式条目（A-256–A-279、B-055–B-178）的判定细化：**规则/声明缺项、token 换用、结构性改名/改布局 → `⚠️有差异`**；**仅声明值微调（像素/字号/间距）或只新增声明且不改变排布语义 → `✅一致`**，具体差值仍写在「差异说明」列，便于二次判断。

| 分段 | ✅一致 | ⚠️有差异 | ❌缺失 | ✅有意差异 | 小计 |
|---|---|---|---|---|---|
| A（a.md，A-001–A-280） | 161 | 81 | 35 | 3 | 280 |
| B（b.md，B-001–B-336） | 222 | 75 | 26 | 13 | 336 |
| **合计** | **383** | **156** | **61** | **16** | **616** |

**分模块读数（由大表归并）**

| 模块 | 主要状态 | 一句话结论 |
|---|---|---|
| `panel/surface.ts`（装配/轮询/发布） | 多数 ✅，7 处 ⚠️ | 主干正确（去重、两道 dispose 守卫、5s 硬下限、精确摘卡都有），薄弱点在**错误面**（`serviceOf` 属性回退裸奔、`pollOnce` 后段无 catch、无 `inFlight`）与 **Map 键用 `sessionId` 而非 `kind:id`** |
| `panel/carrier.ts` / `runtime.ts` / `transport.ts` | 基本 ✅ | `key = kind:id`、排序、Result/Actions、四方法请求体全对；`unwrap` 缺「非 JSON / `!ok`」分支 |
| `panel/Card.tsx` + `styles.ts` | ✅ 与 ⚠️ 各半 | 提问/审批两条流与 `busy/error` 语义对；缺推荐徽标、ARIA、镜像自增高，样式少了 3 处 token 重绑 |
| `panel/locales.ts` | ⚠️ 居多 | 命名空间独立、键集对齐 ✅；**多处文案与 dsh 原文不同、`ix.move`/`ix.unavailable` 缺失、`escalation` 丢占位符** |
| `directory-browser/DirectoryBrowser.tsx` | ❌/⚠️ 集中区（35+ 条缺失） | 保留了「abort + requestSeq + 200ms 父腿 + 盘符 + 独立 createError」这些骨架，但 `readDraft`/`visibleEntries`/`select`/`advance`/焦点四标记/`truncated` 这一整层未实现；另有 3 个 P0 级缺陷（`[props]` 依赖、首屏 `'/'`、`onClose` 无守卫） |
| 十项高危 | **8 ✅ / 2 ⚠️** | 见 §2：`Composer` key、`sessionId` 去重、5s 下限、两道 dispose 守卫、waterfall 抢占、locale 命名空间、abort+requestSeq、200ms 兜底 **全部成立**；`isInteractionCarrier` 多校验三个字段、样式注入缺 `data-plugin-css` 属可接受偏差 |
| 文档/代码漂移 | 14 条 | `04-client` §1.1（类型来源）、§4.3（50 规则/229 声明）、§5#12（892 行）、§2.1（14 state / 17 ref / 焦点四标记）与实际代码全部不符，见测试缺口 T-14 |

---

## 2. 十项高危逐条裁决（「输入框/选择框弹不出来」高危项）

| 需求 | 现状（行号级） | 判定 | 结论 |
|---|---|---|---|
| A-040 / B-297 显式 React `key` = `${kind}:${id}` | `Composer:`23 `key={\`${view.kind}:${view.id}\`}` 挂在 `<InteractionCard>` 上；`Composer:`14-16 注释保留了「承重墙」理由；`Composer:`30 单返回元素，key 变化即卸载重挂 `InteractionCard`（`index/drafts/busy/minimized` 全在 `Card.tsx:76-80` 里，随 key 重置） | ✅一致 | **有**。等价于 0.1.6 的 `:21-29`。唯一残余风险：`Card.tsx:146` 在 `question === undefined` 时返回空 `<div/>` 而非 `null`，比基线更安全；`Composer:`20 在 runtime 未装时返回 `null`（静默，见 A-163）。 |
| A-035 / A-221 认领只看 `value.tag === INTERACTION_TAG` | `carrier:`38-47：`isInteractionCarrier` = `candidate.tag === INTERACTION_TAG` **且** `key/kind/sessionId` 均为 string；`surface:`190-193 `select` 只调它，返回 `candidate.view` | ⚠️有差异 | **有，但比要求更严**。仍是「标记字段」判定（不用 `instanceof`，热重载安全），额外三个字段是类型收窄，对自家载体恒真；与 dsh 官方 `instanceof PendingQuestion/PendingApproval` 依然互斥。差异点：`select` 返回的是 `view` 而不是载体本身（`matched` 形状自定，需与 `Composer:`18 的 `matched as PendingInteractionRecord` 保持一致）。 |
| A-034 / A-218 发布去重键是 `sessionId` | `surface:`70-77 `claim()` 按 `sessionId` 取 `since` 最小的一条；`surface:`98 `published = Map<sessionId, unpublish>`；`surface:`127-135 多退（`keepSessions` 差集）/ 少补（`published.has` 跳过） | ✅一致 | **有**。0.1.6 用 `claimed`+`wanted(key)`，本仓直接把 `Map` 的键换成 `sessionId`，语义更强（一个会话一条）。`since` 升序由 `claim` 末尾 `sort` 保证。 |
| A-036 / A-183 轮询间隔硬下限 `Math.max(5000, intervalMs ?? 5000)` | `surface:`20 `INTERACTION_POLL_MS = 5_000`；`surface:`93 `Math.max(INTERACTION_POLL_MS, options.intervalMs ?? INTERACTION_POLL_MS)` | ✅一致 | **有**，常数与表达式等价（`INTERACTION_POLL_MS` 即 5000）。 |
| A-037 / A-228 dispose 后绝不再 publish（同 tick + 跨 await） | 同 tick：`surface:`125 `if (disposed) return`（`publishRecords` 首行）；跨 await：`surface:`147 `if (disposed) return`（`await transport.list()` 之后）；另有 `surface:`139 入口守卫；`surface:`139/147 之外 `surface:`212 `void pollOnce()` 不重排 | ✅一致 | **两道守卫都在**。注意 `surface:`148 `publishRecords(records)` 位于 `try` 之外：`list` 返回形状不合（缺 `items`）时 `for..of undefined` 会 reject（见 GAPS P0-4），但那不是 dispose 竞态。 |
| A-039 / A-172 样式标签共享 + refs 计数 + `data-plugin` 重写 | `styles:`71 模块级 `styleState{refs,element}`；`styles:`79-90 首次建/复用 `<style id="magica-ix-styles">`；`styles:`91 每次注入都重写 `dataset['plugin']`；`styles:`92 `refs += 1`；`styles:`93-105 幂等释放（`released` 锁 + `refs-1`，归零 `remove()`） | ⚠️有差异 | **有共享+计数+重写**。两处差异：①**未写 `data-plugin-css`**（0.1.6 两个属性都写；dsh HMR 用 `style[data-plugin]` 定位，本仓仍可被回收，故非致命）；②元素句柄**缓存在模块变量**而非每次 `getElementById`：HMR 已把标签摘掉后（`refs` 仍 >0 的窗口内）再次注入会写进已脱离文档的节点 → 样式静默消失。`styles:`81 只在首次 `element===null` 时查 DOM。 |
| A-026 / A-029 abort + requestSeq 守卫 | `DB:145-149` `seq = ++requestSeq.current` + `scanAbort.current?.abort()` + 新 controller；`DB:164/191/200` 三处 `requestSeq.current !== seq` 守卫；卸载 `DB:253-256`、关闭 `DB:244-251` 都 `abort()` + `clearTimers()`；`clearTimers` `DB:132-141` 管 `parentTimer`/`slowTimer` | ✅一致 | **有**。差异只在实现形态：没有独立 `supersede()`，逻辑内联在 `navigate`（`DB:143-207`）；卸载时**不递增 `requestSeq`**（靠 abort 让已发请求 reject），理论上仍有一次「已 resolve 但在飞行中」的回调能过守卫（React 18 之后卸载 setState 不再告警，属噪声级）。 |
| A-028 / A-203 父腿 200ms 兜底 + `landSingle` 只落一次 | `DB:62` `PARENT_LEG_WAIT_MS = 200`；`DB:172-180` 目标腿成功后才挂计时器，回调里 `if (requestSeq.current !== seq \|\| landed) return` → `landed = true` + 单栏落地；`DB:183-186` `await parentLeg`（catch 降级 null）；`DB:187-190` 落地后立刻 `clearTimeout`；`DB:191` 再验 seq、`DB:192` `landed = true`、`DB:193-197` 合成两栏 | ✅一致 | **有，且只落一次**（`landed` 布尔 + seq 双守卫）。两处细节偏离：①计时器**只在 closeEditor 语义下才该挂**（A-203），本仓只有一种 `navigate`，路径编辑提交也走它，因此「提交式 vs 预览式」区分不存在（因为预览本身没实现，见 A-072/A-058）；②计时器**已触发**的分支不会把 `parentTimer.current` 置 `null`（`DB:173-180`），留下一个已失效 id，`clearTimers` 再清一次属无害。 |
| A-020 / A-021 waterfall `{prepend:true, global:true}` 且不调 `next()` | `wire:`117 `WATERFALL_TAKEOVER = { prepend: true, global: true }`；`src/sessions/questions.ts:288-301`（认领后 `return hold(request)`，只有「未装 / 归属不符」才 `next()`）、`:315-316` 注释「为什么不能 return next()」；`src/sessions/approval.ts:160-195` 同构；`src/sessions/core.ts:573-598`（`agent/pre-step` 只 `{prepend:true}`） | ✅一致 | **有**，且是同一份常量（`wire:` 与宿主共享）。「抢先认领 + 从不 `next()`」在 questions/approval 两条 waterfall 上都成立；附带 `agent/pre-step` 的 `{prepend:true}` 与 0.2 事实对齐（`00-overview` §4.2）。 |
| A-143 / B-304 locale 命名空间独立、同 `(ns, locale)` 重复注册抛错 | `locales:`8 `INTERACTION_LOCALE_NS = 'magica-interaction'`；`surface:`194 槽位 `locale:` 声明用它；`git` 全仓**没有** `ctx.locale.register(...)` 调用（`surface` 从不取 locale 服务，`surface:`94 `options.t ?? makeTranslate(zh)` 自带兜底） | ✅一致 | **命名空间独立成立**（不与 dsh 的 `question` / `approval` 撞）。但这也意味着「重复注册抛错」这条路径在本模块**不可达**——真正的风险被搬给了消费方：它若在自己的 `apply` 里 `locale.register('magica-interaction', …)` 又不在 `ctx.effect` 里 dispose，第二次热更才会抛。本仓缺少消费方字典资产（见 B-316 / A-090），这是 P0 级缺口。 |

---

## 3. 逐条大表

### 3.1 A 段（a.md，A-001 – A-280）

| ID | 状态 | 证据 | 差异说明 |
|---|---|---|---|
| A-001 | ⚠️有差异 | `package.json:3` | 本仓版本 `0.2.0-alpha.1`（AGENTS 统一版本约定），非 `0.1.6-rc.26` |
| A-002 | ⚠️有差异 | `panel/` 9 文件 + `DB` 3 文件 | 0.1.6 的 12 文件/2624 行布局已重写；`interactions/*`→`panel/*` |
| A-003 | ✅一致 | `DB:29-42`、`DB:45`、`DB:110` | `DirectoryBrowser`/`Props`/`DirectoryEntry`/`DirectoryListing`/`Translate` 均直接导出（非 re-export） |
| A-004 | ✅一致 | `package.json:14` | `./directory-browser` 直指 `.tsx` 源码 |
| A-005 | ✅一致 | `DB:26`、`DB.css:1` | `import css from './DirectoryBrowser.module.css'`，默认导出 class map |
| A-006 | ⚠️有差异 | `globals.d.ts:2-12` | ambient 成立；`Window.__DSH_BOOT__` 形状改为 `{locale?, ...}`，非 `entries[]` |
| A-007 | ✅一致 | `Card:328`、`Card:30` | `InteractionCard` + `InteractionCardProps` |
| A-008 | ✅一致 | `Composer:17` | `InteractionComposer` |
| A-009 | ✅一致 | `carrier:12/22/38/60/50/53` | 6 名齐（`INTERACTION_TAG` 定义在 `wire:114` 并 re-export） |
| A-010 | ⚠️有差异 | `panel/index:1-31`、`package.json:11-16` | 有唯一出口，但**无 `./panel` 子入口**；经 `./client`→`lib/client.js` 暴露 |
| A-011 | ✅一致 | `locales:8/11/39/36/64` | 5 名齐 |
| A-012 | ✅一致 | `runtime:14/27`、`panel/index:30-31` | install/release 不从出口导出 |
| A-013 | ✅一致 | `styles:16/19/77` | 3 名齐 |
| A-014 | ✅一致 | `surface:20/23/30/39/85` | 5 名齐 |
| A-015 | ✅一致 | `transport:22/55` | 2 名齐 |
| A-016 | ✅一致 | `surface:10`、`Composer:7-8` | surface→Composer 单向；Composer 只 import Card/runtime |
| A-017 | ✅一致 | `DB:15-26` | 只 import react + primitives + css，零 `panel/*` |
| A-018 | ⚠️有差异 | `wire:1-117`；`sessions/questions.ts:14` | 同源契约成立，文件从 `interactions/types.ts` 改名 `shared/wire.ts` |
| A-019 | ✅一致 | — | 背景事实：官方组件是 slot occupant、不导出裸组件；本仓据此自建 |
| A-020 | ✅一致 | `wire:117`、`sessions/questions.ts:288-301`、`sessions/approval.ts:160-195` | `{prepend,global}` 提前认领；只有未装/归属不符才 `next()` |
| A-021 | ✅一致 | `sessions/questions.ts:312-316` 注释 + `:299 return hold(request)` | 认领后不 `next()`，故必须自己显示＋结算；本仓面板即该义务的落点 |
| A-022 | ✅一致 | 基线事实（官方不导出 `QuestionComposer`） | 卡片只能复刻，本仓 `Card.tsx` 自绘 |
| A-023 | ✅一致 | 基线事实（官方只导类型） | 同上 |
| A-024 | ✅一致 | `Card.tsx` 全篇 + `styles:19-64` | DOM/CSS/文案复刻路线成立 |
| A-025 | ✅一致 | `DB:110-123`、`DB:48-59` | 不占 slot，纯 props 受控 |
| A-026 | ✅一致 | `DB:145-149`、`DB:164/191/200` | abort + requestSeq 守卫所有 setState |
| A-027 | ✅一致 | `DB:62` | `PARENT_LEG_WAIT_MS = 200` |
| A-028 | ✅一致 | `DB:172-198` | 200ms 兜底 + 晚到父腿原地升级 |
| A-029 | ✅一致 | `DB:244-256`、`DB:132-141` | 关闭/卸载 abort + 清两个计时器 |
| A-030 | ✅一致 | `DB:76`、`DB:166`、`DB:211` | 模块级 `lastNavigatedPath`，跨开关存活 |
| A-031 | ✅一致 | `DB:80-84`、`DB:165` | 只由宿主 `home` 推断，无 `navigator.platform` |
| A-032 | ✅一致 | `styles:20`、`styles:55` | `frame`/`apprroot` 自带 `justify-content:center` + 左右 inset |
| A-033 | ✅一致 | `carrier:38-47`、`carrier:4-5` | 标记字段认领，注释保留了热重载理由 |
| A-034 | ✅一致 | `surface:70-77`、`surface:124-136` | 一会话一条（`since` 最小） |
| A-035 | ⚠️有差异 | `carrier:41-46`、`surface:190-193` | 除 `tag` 外还校验 `key/kind/sessionId` 为 string；仍非 `instanceof` |
| A-036 | ✅一致 | `surface:20`、`surface:93` | 硬下限 5000 |
| A-037 | ✅一致 | `surface:139/125/147` | 隐藏不轮询；dispose 后两道 publish 守卫 |
| A-038 | ✅一致 | `surface:160-176` | 三个应答方法 `result.ok` 时立即 `dropCarrier` |
| A-039 | ✅一致 | `styles:71/91-105` | 全页共享 + refs 计数 + `data-plugin` 重写 |
| A-040 | ✅一致 | `Composer:23`、`Composer:14-16` | 显式 `key = ${kind}:${id}` |
| A-041 | ✅有意差异 | `00-overview` §3.5/§3.7 | 本仓 `panel/**` 进单文件 `lib/client.js`（不再 tsc 逐文件直编）；`DB` 仍 raw TSX |
| A-042 | ✅一致 | `DB:49-55` | 7 项必填齐 |
| A-043 | ✅一致 | `DB:56-58` | `onCommit`/`footerExtra`/`onPathChange` 齐 |
| A-044 | ❌缺失 | — | 无 `ScannedDirectory`、无「已确认扫描目录」记忆（路径编辑无预览扫描） |
| A-045 | ⚠️有差异 | `DB:112-123` | 12 个 useState，集合与 0.1.6 的 14 个不同（无 `slowScan/scanWindow` 等） |
| A-046 | ⚠️有差异 | `DB:125-130` | 5 个 ref（`requestSeq/scanAbort/parentTimer/slowTimer/listDirectoryRef`），无焦点四标记 |
| A-047 | ✅一致 | `DB:76-78` | 三个模块级缓存齐 |
| A-048 | ❌缺失 | `DB` 全篇 | 无 `cx()` 辅助函数，直接用模板串拼 className |
| A-049 | ⚠️有差异 | `DB:80-84` | `hostIsWindows()` 无参数，读 `hostHomeCache` |
| A-050 | ⚠️有差异 | `DB:86-88` | 无缓存时返回 `'/'`（需求要求返回 `undefined` 让宿主用 homedir）——见 A-210 |
| A-051 | ⚠️有差异 | `DB:203/269/287` | 内联 `instanceof Error ? message : String`，不优先取 `rpcError.message` |
| A-052 | ❌缺失 | `DB:309-316` | 面包屑直接渲染 `crumb.name`，无 home 重写/本地化（`browser.home` 未用） |
| A-053 | ❌缺失 | `DB:90-104` | 无 `separatorOf`；`parentPathOf`/`joinPath` 内部按前缀猜分隔符 |
| A-054 | ❌缺失 | — | 无 `levelDirectory` |
| A-055 | ❌缺失 | — | 无 `draftDirectory` |
| A-056 | ❌缺失 | — | 无 `readDraft`（无「tail 命中当前列」概念） |
| A-057 | ⚠️有差异 | `DB:260`、`DB:353-354` | 只有 `showHidden` 过滤；无前缀过滤、无「选中项永远保留」逻辑 |
| A-058 | ❌缺失 | — | 无 tail 判定，故无「只在当前列过滤、不打网络」这条路径 |
| A-059 | ❌缺失 | `DB:352-371` | 无 `LevelColumn` 组件，无 `role="list"/"listitem"` |
| A-060 | ❌缺失 | `DB:356-369` | 行上无 `aria-current`（只用 class 表示选中） |
| A-061 | ✅一致 | `DB:362-366`、`DB:384-388` | 选中 `IconFolderOpen16`、未选中 `IconFolderClose16` |
| A-062 | ❌缺失 | — | 无 `pathEditing` 态，故无 `onMouseDown preventDefault` |
| A-063 | ❌缺失 | `DB:356-360` | 行无 `disabled`（`busy` 只作用于底栏按钮） |
| A-064 | ✅一致 | `DB:328`、`DB:446` | IME 保护改为 `event.nativeEvent.isComposing`（比 ref 方案更简，效果等价；未额外判 `keyCode===229`） |
| A-065 | ⚠️有差异 | `DB:145-149` | `supersede()` 内联进 `navigate`，无独立函数／无 `restartSlowScanWindow` |
| A-066 | ⚠️有差异 | `DB:151-155` | 慢扫描窗口重置内联（清旧 timer + 置新） |
| A-067 | ⚠️有差异 | `DB:157-160` | 无 `launchListing` 返回值概念；用 ref 里的 `listDirectory`（这点一致） |
| A-068 | ✅一致 | `DB:159-160` | 父腿共享同一 controller/seq（不二次递增） |
| A-069 | ⚠️有差异 | `DB:162-198` | 五步大体成立；但父级 entries 里**找回选中项**缺失（恒 `setSelected(null)`），也无 `scanned` 分支 |
| A-070 | ⚠️有差异 | `DB:143-144` | `navigate(target: string)` 必填，不支持无参 |
| A-071 | ⚠️有差异 | `DB:380-382` | 单击 = 只 `setSelected`（不预扫子层），双击 = `navigate`；无 `refocusPick` |
| A-072 | ❌缺失 | — | 无 `previewDraftLevel`（编辑期预览） |
| A-073 | ⚠️有差异 | `DB:324-326` | Escape 只 `setDraft(null)`；因为草稿不入 state 树，无需回滚导航 |
| A-074 | ⚠️有差异 | `DB:382` | 无 `advance()`；深一层靠双击/回车导航（父列由 `parentPathOf` 反推） |
| A-075 | ⚠️有差异 | `DB:276-291` | 有 `creating` 单栅栏（非 `openGeneration`）；失败写 `createError` ✅；成功后 `navigate(created)` ✅ |
| A-076 | ⚠️有差异 | `DB:253-256` | 卸载 abort + 清计时器；无 `openGeneration++`、不递增 `requestSeq` |
| A-077 | ❌缺失 | — | 无 `viewRef`（无去抖预览 effect，故不需要） |
| A-078 | ⚠️有差异 | `DB:209-212`、`DB:244-251` | 打开时只 `navigate`（不重置 `showHidden`）；关闭时 abort + 清 draft/folderDraft/createError |
| A-079 | ✅一致 | `DB:214-242` | `open` 才跑、有缓存、5s `AbortController`、显式判 `response.ok`（`DB:225`） |
| A-080 | ✅一致 | `DB:64`、`DB:154-155` | 300ms 后才显示慢扫描提示 |
| A-081 | ❌缺失 | — | 无 250ms 草稿预览去抖 |
| A-082 | ⚠️有差异 | `DB:167` | 只在导航成功时 `onPathChange(path)`；草稿变化 / 取消编辑不回调 `null` |
| A-083 | ❌缺失 | — | 无面包屑滚右、无 miller 行滚右列 |
| A-084 | ❌缺失 | `DB:321/442` | 只有 React `autoFocus`，无三标记焦点恢复 effect |
| A-085 | ⚠️有差异 | `DB:199-204` | 所有失败都进 `error`，但取 `cause.message`（无 `rpcError` 优先） |
| A-086 | ✅一致 | `DB:121`、`DB:287`、`DB:449` | `createError` 独立渲染，不覆盖主 `error` |
| A-087 | ❌缺失 | — | `truncated` 字段从不读取，无「仅显示开头部分」提示 |
| A-088 | ✅一致 | `DB:183-186`、`DB:194` | 父腿失败/缺失 → `parent=null` 单栏落地 |
| A-089 | ✅一致 | `DB:258`、`DB:294` | `open=false` 先 `return null`，`Modal open={open}` 恒真 |
| A-090 | ⚠️有差异 | `DB` 全篇（9 个 key） | 13 个 `browser.*` key 本仓只用到 9 个；且**仓库内无字典资产**（消费方无货可抄） |
| A-091 | ✅一致 | `DB:294`、`DB:296` | `browser.title` 用于 Modal aria + h2 |
| A-092 | ❌缺失 | — | `browser.home` 从未使用（面包屑不做 home 重写） |
| A-093 | ❌缺失 | `DB:334-347` | `browser.drives` 未使用（盘符栏无标签） |
| A-094 | ✅一致 | `DB:410`、`DB:433`、`DB:438` | `browser.newFolder` |
| A-095 | ✅一致 | `DB:443` | `browser.folderName` 作 placeholder |
| A-096 | ❌缺失 | — | `browser.untitledFolder` 未使用（新建输入框默认空串） |
| A-097 | ✅一致 | `DB:459` | `browser.create` |
| A-098 | ✅一致 | `DB:415`、`DB:452` | `browser.cancel` |
| A-099 | ✅一致 | `DB:423` | `browser.open` |
| A-100 | ✅一致 | `DB:300` | `browser.editPath` 作 title |
| A-101 | ✅一致 | `DB:392` | `browser.loading` |
| A-102 | ❌缺失 | — | `browser.truncated` 未使用 |
| A-103 | ✅一致 | `DB:402` | `browser.showHidden` |
| A-104 | ⚠️有差异 | `DB:334-347` | 盘符按钮照常渲染 ✅，但完全没有 `drivesLabel !== 'browser.drives'` 判定，也无 `aria-label` |
| A-105 | ✅一致 | `DB` 全篇 | `browser.createIn` 未使用（与需求一致） |
| A-106 | ✅一致 | `DB.css:3`、`DB:294` | `.dialog.dialog` 双写 |
| A-107 | ⚠️有差异 | `DB.css:62-65` | 有 `:has(.pathInput)` / `:has(.crumb:focus-visible)`，缺 hover/编辑态两支 |
| A-108 | ✅一致 | `DB.css:108/117/133` | `driveBar`/`driveBtn`/`driveBtnActive` 三件套 |
| A-109 | ✅一致 | `DB.css` 全篇 | 无 `@media`、无 `body[data-ds-dark-theme]`、全 token |
| A-110 | ✅一致 | `globals.d.ts:2-5` | CSS Module 默认导入声明 |
| A-111 | ✅一致 | `globals.d.ts:8-12`（全仓无读取） | 声明了但从未读取，与需求一致（死契约） |
| A-112 | ✅一致 | `Card:328-334` | 卡片不取数据，全 props |
| A-113 | ✅一致 | `Card:38-42`、`Card:44-46` | `Draft` 三字段 + 空草稿工厂 |
| A-114 | ❌缺失 | — | 无 `RECOMMENDED` 正则、无 `parseRecommended`（推荐后缀不拆显示） |
| A-115 | ⚠️有差异 | `Card:30-36`、`Card:328` | 5 个 props 齐，但 `variant` **完全未被消费**（死 prop） |
| A-116 | ❌缺失 | — | 无 `parseRecommended`；答案值仍回 label 原文 ✅（只缺拆显示） |
| A-117 | ⚠️有差异 | `Card:48-53` | `skipped` 也算已答（为「跳过即提交」服务），其余一致 |
| A-118 | ✅一致 | `Card:55-65` | 跳过→`selected:[]`；单选+自由文本→`selected:[]`+`custom` |
| A-119 | ⚠️有差异 | `Card:87-144` | 七步被拆并成 `patch/toggle/skip/advance/submit/cancel`；无逐题 `settle` 自动推进 |
| A-120 | ✅一致 | `Card:286-295` | `settle('allowed-once' \| 'rejected')` |
| A-121 | ✅一致 | `Card:127`、`Card:289` | 成功分支也 `setBusy(false)` |
| A-122 | ✅一致 | `Card:77` | 草稿在组件内 `useState`（关卡片即丢，与需求一致） |
| A-123 | ✅一致 | `Card:79`、`Card:113`、`Card:128` | 报错存已翻译字符串（切语言不跟随） |
| A-124 | ⚠️有差异 | `Card:159-166` | 收起按钮**恒渲染**（不区分 variant，因为 `variant` 未消费）→ 弹窗/内联场景也多出按钮 |
| A-125 | ✅一致 | `Card:214-226` | 无 `focusedQuestions`，输入框也无 `autoFocus`，不会抢焦点 |
| A-126 | ⚠️有差异 | `Card:220-225` | 选项按钮上无 Enter；但自由文本输入框 Enter = `advance()`（等价快捷路径存在） |
| A-127 | ✅一致 | `Card:328-334` | 无 `plan-review` 分流（`wire:31` 已透传 `intent`，卡片忽略）；`00-overview` §3.9 记为未做 |
| A-128 | ⚠️有差异 | `Card:222` | 本仓**已有** IME 守卫（`isComposing \|\| keyCode===229`），优于基线（基线的缺口本仓已补） |
| A-129 | ⚠️有差异 | `Card:275-284`、`Card:311` | 不用 slot ✅；但 `view.args` 会尝试 `JSON.parse` 美化后放进 `<pre>`，不再是纯文本原样 |
| A-130 | ✅一致 | `Composer:18-20` | runtime 未装 / 不是自家载体 → `null` |
| A-131 | ✅一致 | `Composer:11-16` | 保留「chain 按注册项 key」的背景与对策 |
| A-132 | ✅一致 | `Composer:23` | 显式 key 即卡死链路的唯一解（已存在） |
| A-133 | ✅一致 | `Card:151`、`Card:300` | 外壳 `magica-ix-frame` / `magica-ix-apprroot` 恒在 |
| A-134 | ⚠️有差异 | `wire:114` | 值改为 `'dsh-magica-spellbook/interaction'`（包名变更的必然结果，语义一致） |
| A-135 | ✅一致 | `carrier:22-35` | `tag/key/kind/sessionId/view` 齐，`key = kind:id` |
| A-136 | ⚠️有差异 | `carrier:41-46` | 见 A-035：标记判定 + 三个结构字段 |
| A-137 | ✅一致 | `carrier:50`、`carrier:53-57` | Result 与 Actions 三方法 |
| A-138 | ✅一致 | `carrier:60-66` | 按 `since` 升序、`id.localeCompare` 兜底 |
| A-139 | ⚠️有差异 | `carrier:33` vs `surface:98/109-122` | `key` 用 `kind:id` ✅；但**摘卡按 `sessionId`**（`drop(sessionId)`），不是「按 `kind:id` 精确摘」 |
| A-140 | ⚠️有差异 | `locales:11-33`、`locales:39-61` | 21 个 key 全 `ix.` 前缀 ✅；`en` 用 `Record<InteractionKey,string>` 而非 `satisfies`，keyst 对齐等价 |
| A-141 | ✅一致 | `locales:36`、`locales:64` | 两个类型 |
| A-142 | ✅一致 | `locales:8` | `'magica-interaction'`，与 dsh 的 `question`/`approval` 不同 |
| A-143 | ✅一致 | `locales:8`（且全仓无 `locale.register`） | 命名空间独立；重复注册抛错路径在本模块不可达 |
| A-144 | ⚠️有差异 | `locales:12` | `'还有题目没有作答'` ≠ `'请先完成这道问题。'`；且该 key 未被使用 |
| A-145 | ⚠️有差异 | `locales:13`、`Card:113` | `'请先选择或填写答案'` ≠ `'请选择一个选项或填写自定义答案。'` |
| A-146 | ✅一致 | `locales:14`、`Card:236` | `ix.prev = 上一题` |
| A-147 | ✅一致 | `locales:15`、`Card:246` | `ix.next = 下一题` |
| A-148 | ⚠️有差异 | `locales:20-21`、`Card:162` | 未合并成 `ix.move`，拆成 `ix.minimize`/`ix.expand` |
| A-149 | ⚠️有差异 | `locales:19`、`Card:170` | `'取消'` ≠ `'放弃整组问题'` |
| A-150 | ⚠️有差异 | `locales:22`、`Card:155` | 文案值一致，但**语义误用**：`ix.recommended` 被当作 eyebrow 缺省（`question.header ?? t('ix.recommended')`），推荐徽标本身没实现 |
| A-151 | ⚠️有差异 | `locales:23`、`Card:217` | `'其他答案'` ≠ `'输入你的答案'` |
| A-152 | ✅一致 | `locales:18`、`Card:239` | `ix.skip = 跳过本题` |
| A-153 | ✅一致 | `locales:16`、`Card:246` | `ix.submit = 提交` |
| A-154 | ✅一致 | `locales:17`、`Card:246` | `ix.submitting = 提交中…` |
| A-155 | ⚠️有差异 | `locales:25`、`Card:304` | `'等待你的决定'` ≠ `'等待审批'` |
| A-156 | ⚠️有差异 | `locales:29`、`Card:309` | `'操作详情'` ≠ `'审批详情'` |
| A-157 | ⚠️有差异 | `locales:28`、`Card:305-307` | 文案改写且**丢掉 `{toolName}` 占位符**；触发条件改为「args 含 sandbox_permissions」 |
| A-158 | ✅一致 | `locales:26`、`Card:318` | `ix.approval.allow = 允许一次` |
| A-159 | ✅一致 | `locales:27`、`Card:315` | `ix.approval.reject = 拒绝` |
| A-160 | ✅一致 | `locales:30`、`Card:148` | `ix.copy = 复制` |
| A-161 | ✅一致 | `locales:31`、`Card:148` | `ix.copied = 已复制` |
| A-162 | ✅一致 | `locales:32`、`Card:148` | `ix.footnotes = 脚注` |
| A-163 | ❌缺失 | `Composer:20` | 无 `ix.unavailable`：runtime 未就绪时直接 `null`，会话页静默无卡片 |
| A-164 | ⚠️有差异 | `locales:28`、`locales:67-73` | 有 `{param}` 插值能力（`makeTranslate`），但该 key 已无占位符 → 不变式失效 |
| A-165 | ⚠️有差异 | `locales:11-61` | 多处与 dsh 原文不同（见 A-144/145/150/155/156/157） |
| A-166 | ✅一致 | `runtime:22-24` | 最后装的赢 |
| A-167 | ✅一致 | `runtime:27-29`、`runtime:32-34` | 读当前值；release 身份比对 |
| A-168 | ✅一致 | `panel/index:30-31` | 只导出 `interactionRuntime`（+类型） |
| A-169 | ✅一致 | `styles:16` | `'magica-ix-styles'` |
| A-170 | ✅有意差异 | `styles:19-64`（44 条） | 规则数 44 而非 56；`00-overview` §3.5 明示「样式是字符串、约 45 条规则」 |
| A-171 | ✅一致 | `styles:94-105` | refs-1，归零才 `remove()` |
| A-172 | ⚠️有差异 | `styles:77-106` | 有 SSR 守卫/复用/refs+1/重写 `data-plugin`/幂等释放；缺 `data-plugin-css`；元素句柄缓存导致 HMR 摘标签后可能写进脱管节点 |
| A-173 | ✅一致 | `styles:97-98` | 没有计数就会被人提前摘掉——计数已实现 |
| A-174 | ✅一致 | `surface:20` | `INTERACTION_POLL_MS = 5_000` |
| A-175 | ✅一致 | `surface:23-27` | 最小结构面（`get?`/`effect?`/索引） |
| A-176 | ✅一致 | `surface:45-49` | 只声明 `registerPendingInteraction?`，不 import dsh 包 |
| A-177 | ✅一致 | `surface:51-54` | 只声明 `inject?`/`register?` |
| A-178 | ⚠️有差异 | `surface:185/188` | 槽位名硬编码字符串，未导出 `COMPOSER_SLOT` 常量 |
| A-179 | ✅一致 | `surface:30-36`、`surface:39-43` | Options 5 字段 / Surface 2 方法 |
| A-180 | ⚠️有差异 | `surface:56-67` | `get()` 有 try/catch，**属性回退 `surface:65` 没有**——未声明 inject 时访问 `ctx.slots` 会抛（见 GAPS P0-1） |
| A-181 | ✅一致 | `surface:89-90` | 无 `registerPendingInteraction` → 返回 `undefined` |
| A-182 | ✅一致 | `surface:92` | `options.transport` 可覆盖 |
| A-183 | ✅一致 | `surface:93` | 硬下限 |
| A-184 | ⚠️有差异 | `surface:98`、`surface:109-122` | 有 Map + 精确摘，但键是 `sessionId` 而非 `kind:id` |
| A-185 | ✅一致 | `surface:160-176` | 三个方法 `ok` 时摘卡 |
| A-186 | ⚠️有差异 | `surface:96` vs `surface:179` | 顺序反了：先注入样式（96）后装 runtime（179）；基线是先 runtime 后样式 |
| A-187 | ✅一致 | `surface:97` | precedence 恒 1 |
| A-188 | ✅一致 | `surface:185-199` | `slots.inject(slot, () => register(...))`，`disposeSlot` 取 inject 返回值 |
| A-189 | ⚠️有差异 | `surface:186-198` | 有 name/locale/select/registrant；`registrant` 在 0.2 不是合法选项（S-01），`select` 返回 `view` |
| A-190 | ✅一致 | `surface:186-198` | 无 `store`、不显式给 `priority`（缺省 0） |
| A-191 | ✅一致 | 背景（chain 不做同优先级冲突检查） | 缺省 0 共存安全 |
| A-192 | ⚠️有差异 | `surface:100-103`、`surface:138-213` | 局部状态 `disposed/timer/published`；**无 `inFlight`**（A-224）；其余步骤齐 |
| A-193 | ✅一致 | `transport:19`、`transport:46`、`transport:71` | `TIMEOUT_MS = 10_000` + `AbortSignal.timeout` |
| A-194 | ✅一致 | `transport:22-25` | Actions + `list()` |
| A-195 | ⚠️有差异 | `transport:35-39` | `ok:false` 取 `code: message` ✅；但无「JSON 解析失败 → `HTTP <status>`」分支，也不判 `response.ok` |
| A-196 | ✅一致 | `transport:41-49`、`transport:68-75` | GET 无 body / POST 带 json + 均带超时（拆成 `post` + 内联 GET） |
| A-197 | ✅一致 | `transport:58-65` | `settle` 折成 `{ok:false,error}` |
| A-198 | ✅一致 | `transport:76-101` | 四方法 + 与 `wire:68-85` 请求体逐字对齐 |
| A-199 | ❌缺失 | `transport:74` | 直接 `return value.items`，无 `?? []` 容忍（缺字段时下游 `for..of` 抛错，见 GAPS P0-4） |
| A-200 | ⚠️有差异 | `panel/index:6-31`、`client/index:11-29` | 纯 re-export 成立，但成员集合/所在文件与基线不同（wire 类型搬到 `client/index`） |
| A-201 | ✅一致 | `DB:192-197` | 一次 setState 批次落地（`landed` 后才合成） |
| A-202 | ✅一致 | `DB:183-186`、`DB:194-195` | 父腿失败 → 单栏 + 清选中 |
| A-203 | ✅一致 | `DB:172-180`、`DB:191` | 200ms 兜底 + `landed` 只落一次 |
| A-204 | ✅一致 | `DB:127`、`DB:187-190`、`DB:246-256` | 计时器存 ref 并在落地/关闭/卸载清理 |
| A-205 | ✅一致 | `DB:191-197` | 晚到父腿升级成两栏 |
| A-206 | ⚠️有差异 | `DB:350-394` | 语义变了：左列 = 父级，右列 = 当前层；无 `parent/child` 三级 Miller |
| A-207 | ⚠️有差异 | `DB:166`、`DB:211` | 写入/读取点存在，但无「Open 确认」写入点（`pick` 不写）、取消编辑不回导航 |
| A-208 | ✅一致 | `DB:77`、`DB:217-221`、`DB:230-235` | `null`=未拉；失败写 `{failed:true,at}` 短期缓存（超出需求） |
| A-209 | ✅一致 | `DB:78-84`、`DB:165` | 用 `hostHomeCache` 推断，无 `navigator.platform` |
| A-210 | ❌缺失 | `DB:86-88` | 无缓存时返回 `'/'`，不是 `undefined` → 首屏不走宿主 homedir（设计 `04-client` §3.2 明确要求 homedir） |
| A-211 | ⚠️有差异 | `DB:334-347` | 只有 drives 列表；无 POSIX `/` 兜底按钮 |
| A-212 | ⚠️有差异 | `DB:340` | 用 `listing.path.startsWith(drive)` 判高亮，不是 `slice(0,2).toUpperCase()` |
| A-213 | ❌缺失 | — | 无 `drivesLabel` / 无 `aria-label` 判定 |
| A-214 | ✅一致 | `DB:225`、`DB:233-237` | 显式判 `ok`、`catch` 空吞、5s 超时 |
| A-215 | ❌缺失 | `DB:321/442` | 只靠 `autoFocus`，无三标记消费顺序 |
| A-216 | ❌缺失 | — | 无 `editorScope` / `onBlur` 守卫 |
| A-217 | ❌缺失 | — | 三处 `onMouseDown preventDefault` 都没有（因为没有路径编辑态） |
| A-218 | ✅一致 | `surface:124-136` | 多退（`surface:128-130`）+ 少补（`surface:131-135`）+ `sessionId` 去重 |
| A-219 | ✅一致 | `surface:70-77`、`surface:98` | 去重键就是 `sessionId`（比基线更彻底） |
| A-220 | ✅一致 | `surface:134` | `delegate = () => Promise.resolve()` |
| A-221 | ⚠️有差异 | `surface:190-193`、`carrier:41-46` | 只认自家载体、与官方向量互斥 ✅；但额外校验三个字段，且返回 `view` |
| A-222 | ✅一致 | 背景（chain 按 priority 升序） | 三方共存与顺序无关（`select` 互斥） |
| A-223 | ✅一致 | `surface:151-158` | 自链 `setTimeout`，`finally` 后才排下一拍 |
| A-224 | ❌缺失 | `surface:138-149` | 无 `inFlight` 互斥：`refresh()`、`visibilitychange`、定时器可并发 `list()` |
| A-225 | ✅一致 | `surface:139`、`surface:105-107` | 隐藏页直接 return 且不重排 |
| A-226 | ✅一致 | `surface:206-210`、`surface:226-229` | 回前台补一拍 + dispose 摘监听 |
| A-227 | ✅一致 | `surface:141-146` | `catch` 空吞，保留上一份 |
| A-228 | ✅一致 | `surface:147` | `await` 后再判 `disposed` |
| A-229 | ✅一致 | `surface:125` | `publishRecords` 首行守卫 |
| A-230 | ✅一致 | `surface:219-239` | 幂等 + 清计时器/监听/载体/slot 样式/runtime |
| A-231 | ✅有意差异 | `primitives.d.ts:1-57`、`00-overview` §4.1 | 不声明 npm 依赖，用本地 ambient 最小类型面（零运行时 `@deepseek-ai` 依赖） |
| A-232 | ✅一致 | `primitives.d.ts:14-56` | `Button`/`Modal`/`MarkdownText`/图标面齐（含 `labels`） |
| A-233 | ✅一致 | `DB:404/414/417/451/454`、`Card:235/238/241/314/317` | `Button` 使用点更多，但都只用 variant/icon/disabled/onClick/className |
| A-234 | ✅一致 | `DB:294`、`DB:428` | 两处 `Modal` |
| A-235 | ✅一致 | `DB:406` | `IconPlusOutline16 size={14}` |
| A-236 | ✅一致 | `DB:402` | `IconCheckOutline16 size={14}` |
| A-237 | ✅一致 | `DB:311`、`DB:368` | `IconChevronRightOutline14 size={12}` |
| A-238 | ✅一致 | `DB:303`、`Card:213` | `IconEditOutline16`（14 / 12） |
| A-239 | ✅一致 | `DB:363-366`、`DB:385-388` | 两个文件夹图标按选中切换 |
| A-240 | ✅一致 | `Card:200` | `IconCheckOutline14 size={12}` |
| A-241 | ✅一致 | `Card:165` | `IconChevronDown/UpOutline14` 无 props |
| A-242 | ✅一致 | `Card:236`、`Card:247` | `IconChevronLeft/RightOutline14` 无 props |
| A-243 | ✅一致 | `Card:174` | `IconCloseOutline16` 无 props |
| A-244 | ✅一致 | `Card:183` | `MarkdownText text={question.detail}` |
| A-245 | ✅一致 | `Card:148`、`primitives.d.ts:38` | `labels` 形状 = `MarkdownLabels` |
| A-246 | ✅一致 | `primitives.d.ts:44-54` | 图标 props = `{size?, className?}` |
| A-247 | ⚠️有差异 | `DB:29-42`、`DB:15-25` | 类型自建（不 import `dsh-host-directory-picker/types`，为守住零依赖） |
| A-248 | ⚠️有差异 | `DB:45` | `Translate` 自建 `(key: string, params?) => string` |
| A-249 | ⚠️有差异 | `package.json:35-41` | 两个包连 devDependencies 都没有（零 dsh 依赖策略） |
| A-250 | ⚠️有差异 | `primitives.d.ts:26-33` | `Modal` 只声明实际用到的 6 项；`description/footer/contentClassName` 未声明 |
| A-251 | ⚠️有差异 | `DB:294-296`、`DB:434-438` | 两处都 `headless`；主框有 `h2`（296），新建弹窗标题是 `<p>`（438）→ 对话框缺 heading |
| A-252 | ✅一致 | `DB:294`、`DB:434` | `className={css.dialog}` / `css.createDialog` |
| A-253 | ⚠️有差异 | `DB:294` vs `DB:430-432` | 新建弹窗有 `creating` 守卫 ✅；**主框 `onClose={props.onClose}` 无任何守卫**（busy 时点遮罩/按 Esc 就关） |
| A-254 | ⚠️有差异 | `DB:324-326` | 路径输入 Esc 只 `setDraft(null)`，未 `stopPropagation` → 同一次 Esc 仍会冒泡关掉 `Modal` |
| A-255 | ✅一致 | 背景（`Modal.module.css`） | Modal 固定样式由 dsh 提供 |
| A-256 | ⚠️有差异 | `DB.css:3-14` | 双写压过 ✅，但宽高/圆角/背景取的是自有值（720px/20px/`bg-layer-1`） |
| A-257 | ⚠️有差异 | `primitives.d.ts:14-23` | `Button` 面缺 `size`（未用，故不影响） |
| A-258 | ✅一致 | `DB`/`Card` 全部 `Button` | 只用 variant/icon/disabled/onClick/className |
| A-259 | ✅一致 | `DB:414/419`、`Card:314` | `css.footerAction`（`DB.css:230-232`）+ `magica-ix-reject`（`styles:63`） |
| A-260 | ✅一致 | `primitives.d.ts:44-54` | 图标 props 形状一致，颜色靠 `currentColor` |
| A-261 | ✅一致 | `DB.css:187-189`、`DB.css:183-185` | 图标着色在外层 class 的 `color` 上 |
| A-262 | ✅一致 | `DB:303/311/363/368/385/402/406`、`Card:200/213` | 显式 12/14/16 档齐 |
| A-263 | ✅一致 | `Card:183`、`primitives.d.ts:36-41` | `text` + `labels`（另加 `variant="compact"`） |
| A-264 | ❌缺失 | `Card:148` | `labels` 每次渲染新建对象 → 丢 `MarkdownText` 的流式缓存（基线用 `useMemo`） |
| A-265 | ✅一致 | `DB:439-448`、`DB:318-330` | 两处都是裸 `<input>`，不用 `Input` |
| A-266 | ✅一致 | — | `Pill/Toast/Tooltip/HoverCard/Menu` 未使用 |
| A-267 | ✅一致 | — | `useAnchoredPosition`/`useDismissOnOutsidePointer` 未使用 |
| A-268 | ✅一致 | `package.json:29-41` | 无 `clsx` 依赖（`cx` 也被删掉了，见 A-048） |
| A-269 | ❌缺失 | `Card:190-208`、`Card:251` | 选项是裸 `<button>`：无 `role="radiogroup"/"radio"/"checkbox"`、无 `aria-checked`、feedback 无 `role="status"` |
| A-270 | ⚠️有差异 | `Card:77/159-166/220-225/328` | 草稿 state ✅、无 plan-review ✅、无焦点标记 ✅；但「收起按钮只在 takeover」✗（恒渲染）、`variant` 未消费 |
| A-271 | ⚠️有差异 | `styles:20-54` | 关键值部分一致（`max-height:min(60vh,520px)`、radius 20、`specific-input-major`、`elevation-panel`、option `min-height:40px`/120ms），部分不同（option padding、checkbox 14px、无 `customBlock` min-height） |
| A-272 | ⚠️有差异 | `styles:19-64` | 前缀 ✅、无 `@media` ✅、无 `corner-shape` ✅、三处兜底 760/16/336 ✅；但 `--magica-ix-pad` 私有变量未引入 |
| A-273 | ⚠️有差异 | `locales:11-33` | 9 个 key 的名字/前缀被重排（`option.recommended`→`ix.recommended`、`custom.placeholder`→`ix.custom`、`action.*`→`ix.*`） |
| A-274 | ⚠️有差异 | `locales:11-33` | `ix.` 前缀 ✅、新增 submit/submitting/copy/copied/footnotes ✅、无 `plan.*` ✅；`nav.minimize/maximize` 未合并为 `ix.move`，`ix.unavailable` 缺失 |
| A-275 | ❌缺失 | — | 无 `parseRecommended`（推荐后缀既不拆也不显示徽标） |
| A-276 | ⚠️有差异 | `Card:300-322` | 三层结构 ✅、两个决策字面量 ✅、busy 禁用 ✅；`body` 无 `tabIndex/role="group"`（只有 aria-label）、`reason ?? escalation({toolName})` 换成 `displayReason?.zh ?? reason ?? toolName` |
| A-277 | ✅一致 | `Card:311`、`Card:321`、`Card:286-295` | 纯文本详情（无 slot）+ 就地错误 + `busy` |
| A-278 | ⚠️有差异 | `styles:55-63` | warn 三色/8px 圆点/`max-height` 兜底 ✅；`command` 字号 12 而非 13，另有底/内边距 |
| A-279 | ✅一致 | `styles:63`、`styles:61`、`styles:59` | 前缀 ✅、无 `corner-shape` ✅、`monospace` 兜底 ✅、336 兜底 ✅ |
| A-280 | ⚠️有差异 | `locales:25-29` | 5 个 key 前缀统一 ✅；`waiting`/`detailAria` 改写、`escalation` 无占位符；`reject`/`allow` 逐字一致 |
### 3.2 B 段（b.md，B-001 – B-336）

| ID | 状态 | 证据 | 差异说明 |
|---|---|---|---|
| B-001 | ⚠️有差异 | `DB:404-411` | `variant="outline"`+`icon` ✅；`disabled` = `listing===null \|\| loading \|\| busy`（无 `parentInert`/`draftPending` 概念） |
| B-002 | ✅一致 | `DB:414` | 取消按钮：`outline` + `footerAction` + `disabled={busy}` |
| B-003 | ⚠️有差异 | `DB:417-424`、`DB:263-274` | `primary`+`disabled={targetPath===null\|\|loading\|\|busy}` ✅；`pick()` 先 `await onCommit` 再 `onOpen`（等价「不再关」语义） |
| B-004 | ✅一致 | `DB:451` | 新建弹窗取消：`outline` + `disabled={creating}` |
| B-005 | ✅一致 | `DB:454-460` | `primary` + `disabled={creating \|\| trim()===''}` |
| B-006 | ⚠️有差异 | `DB:294` | `open/title/className/headless` ✅；`onClose` 无守卫（见 A-253） |
| B-007 | ✅一致 | `DB:428-435` | `open={folderDraft!==null}` + 创建中不关 + `title` + `createDialog` + `headless` |
| B-008 | ✅一致 | `DB:406` | `IconPlusOutline16 size={14}` |
| B-009 | ✅一致 | `DB:402` | `IconCheckOutline16 size={14}` |
| B-010 | ✅一致 | `DB:368` | `IconChevronRightOutline14 size={12} className={css.rowChevron}` |
| B-011 | ✅一致 | `DB:311` | 面包屑分隔符同款 |
| B-012 | ✅一致 | `DB:303` | `IconEditOutline16 size={14}` |
| B-013 | ✅一致 | `DB:363`、`DB:385` | `IconFolderOpen16 size={16} className={css.rowIconSelected}` |
| B-014 | ✅一致 | `DB:365`、`DB:387` | `IconFolderClose16 size={16} className={css.rowIcon}` |
| B-015 | ✅一致 | `Card:238` | 跳过：`outline` + `disabled={busy}` |
| B-016 | ✅一致 | `Card:241-248` | `primary` + `disabled={busy \|\| !hasAnswer}` + 文案按 `busy/isLast` 取 submitting/submit/next |
| B-017 | ✅一致 | `Card:314` | 拒绝：`outline` + `className="magica-ix-reject"` + `disabled={busy}` |
| B-018 | ✅一致 | `Card:317` | 允许一次：`primary` + `disabled={busy}` |
| B-019 | ✅一致 | `Card:183` | `MarkdownText text={question.detail} labels={labels}` |
| B-020 | ✅一致 | `Card:200` | 多选勾 `size={12}` |
| B-021 | ✅一致 | `Card:200` | 与选项行同一点（自由文本行走 `.magica-ix-block`，勾由选项状态决定） |
| B-022 | ✅一致 | `Card:165` | 收起/展开无 props |
| B-023 | ✅一致 | `Card:174` | 取消无 props |
| B-024 | ✅一致 | `Card:213` | 自定义答案行 `IconEditOutline16 size={12}` |
| B-025 | ✅一致 | `Card:236` | 上一题无 props |
| B-026 | ✅一致 | `Card:247` | 下一题无 props |
| B-027 | ✅一致 | `DB:294/435` | 两处 `headless`，自绘 chrome |
| B-028 | ✅一致 | 全仓 `Button` | 只用 `primary`/`outline` |
| B-029 | ⚠️有差异 | `DB:303/311/363/368/385/402/406`、`Card:200/213` | 显式 size 12 处、缺省 3 处（`Card:165/174/236/247` 四处无 props 一致） |
| B-030 | ✅一致 | `Card.tsx` 全篇 | 只复用 `Button`/`MarkdownText`/图标，卡片 DOM+CSS 自绘 |
| B-031 | ✅一致 | `DB.css:12/30/79/102/194` | `--dsw-alias-label-primary` |
| B-032 | ✅一致 | `DB.css:184/242` | `--dsw-alias-label-secondary` |
| B-033 | ✅一致 | `DB.css:42/79/94/122/203` | `--dsw-alias-label-tertiary` |
| B-034 | ✅一致 | `DB.css:299` | `--dsw-alias-label-caption` 用于 `::placeholder` |
| B-035 | ⚠️有差异 | `DB.css:64` | `border-l2` 只用于 `:has(.pathInput)`/`:has(:focus-visible)`，无 hover 分支 |
| B-036 | ✅一致 | `DB.css:22/114/156/223` | `border-l3` 四处（header/footer/发丝/盘符栏） |
| B-037 | ✅一致 | `DB.css:290` | `border-l4` 用于新建输入框 |
| B-038 | ✅一致 | `DB.css:129/175/249` | `interactive-bg-hover` |
| B-039 | ✅一致 | `DB.css:135/180` | `interactive-bg-active` + `bg-hover` 兜底 |
| B-040 | ✅一致 | `DB.css:212` | `bg-layer-2` 用于加载浮标 |
| B-041 | ✅一致 | `DB.css:188` | `button-info-fill`（唯一品牌蓝） |
| B-042 | ✅一致 | `DB.css:259` | `state-error-primary` |
| B-043 | ❌缺失 | — | `--dsw-alias-scrollbar-bg-l2` 未使用（无 `--dsh-scrollbar-thumb` 重绑） |
| B-044 | ❌缺失 | — | `scrollbar-hover-l2` 同上 |
| B-045 | ❌缺失 | — | 抬升面（`.dialog`）没有重绑 `--dsh-scrollbar-thumb` 间接层 |
| B-046 | ✅一致 | `DB.css:3`、`DB:294` | 双写同类名提特异度，机制与需求一致 |
| B-047 | ✅一致 | `styles:1-13` | 组件不出包 → 样式必须跟着消费方 bundle 走 |
| B-048 | ✅有意差异 | `00-overview` §3.5 | 本仓 `panel/**` 由 esbuild 打进 `lib/client.js`，不再走「tsc 直编无 CSS 管线」这条路 |
| B-049 | ✅一致 | `styles:6-7` | 消费方打包链不保证有 CSS plugin（理由仍成立） |
| B-050 | ✅一致 | `DB:26`、`package.json:14` | `DB` 可用 CSS Module，因为它由消费方编译 |
| B-051 | ✅一致 | `styles:19-64` | 44 条规则类名全 `magica-ix-` 前缀 |
| B-052 | ✅一致 | `styles:16/71-92` | 固定 id + 引用计数 |
| B-053 | ✅一致 | `styles:91` | `data-plugin = pluginId`，HMR 可按它回收 |
| B-054 | ✅一致 | `styles:19-64` | 字符串内无注释（注释都在 `styles:1-13`） |
| B-055 | ✅一致 | `styles:22` | 卡片文字色 `label-primary` |
| B-056 | ✅一致 | `styles:38/52` | `num` / `progress` 用 `label-secondary` |
| B-057 | ✅一致 | `styles:25/28/43/61` | eyebrow/icon/desc/command 用 `label-tertiary` |
| B-058 | ✅一致 | `styles:48` | `input::placeholder` 用 `label-caption` |
| B-059 | ✅一致 | `styles:30` | `icon:disabled` 用 `label-dimmed` |
| B-060 | ✅一致 | `styles:40` | `checkon` 用 `label-primary-foreground` |
| B-061 | ✅一致 | `styles:36`、`styles:46` | `option.on` / `customrow:focus-within` 用 `border-l2` |
| B-062 | ❌缺失 | `styles:22` | `.magica-ix-card` **未重绑** `--dsw-elevation-stroke-color`（浅/深主题描边不跟随） |
| B-063 | ✅一致 | `styles:39`、`styles:49` | `border-l4` 用于复选框/无选项输入框 |
| B-064 | ✅一致 | `styles:35/36/46` | `interactive-bg-hover` |
| B-065 | ✅一致 | `styles:63` | `interactive-bg-hover-danger` |
| B-066 | ✅一致 | `styles:38` | `num` 底 `bg-overlay` |
| B-067 | ✅一致 | `styles:49`、`styles:61` | `block` 与 `command` 用 `bg-module-platform` |
| B-068 | ✅一致 | `styles:47`、`styles:50` | `caret-color` + `block:focus-within` 用 `state-business-primary` |
| B-069 | ✅一致 | `styles:53` | `feedback` 用 `state-error-primary` |
| B-070 | ✅一致 | `styles:57/58` | `state-warn-primary` |
| B-071 | ✅一致 | `styles:56` | `state-warn-secondary` 描边 |
| B-072 | ✅一致 | `styles:57` | `state-warn-tertiary` 背景 |
| B-073 | ✅一致 | `styles:44` | `badge` 用 `button-info-fill`（但 JSX 从未渲染 badge） |
| B-074 | ❌缺失 | `styles:22` | 卡片未重绑 `--dsh-scrollbar-thumb` |
| B-075 | ❌缺失 | `styles:56` | `appr` 未重绑 `--dsh-scrollbar-thumb-hover` |
| B-076 | ✅一致 | `styles:22/56` | 两张卡背景 `specific-input-major` |
| B-077 | ✅一致 | `styles:44` | `badge` 背景 `specific-sidebar-nav-item-active-accent` |
| B-078 | ✅一致 | `styles:22` | 卡片 `box-shadow: var(--dsw-elevation-panel)` |
| B-079 | ✅一致 | `styles:56` | 审批卡 `box-shadow: var(--dsw-shadow-lv2)` |
| B-080 | ✅一致 | `styles:22/56` | `max-width: var(--dsh-chat-content-width, 760px)` |
| B-081 | ✅一致 | `styles:20/55` | `calc(var(--dsh-composer-side-clearance,16px) + 16px)` |
| B-082 | ✅一致 | `styles:59` | `max-height: var(--dsh-composer-text-max-height, 336px)` |
| B-083 | ✅一致 | `styles:61` | `var(--ds-font-family-code, monospace)` |
| B-084 | ⚠️有差异 | `styles:22` | 泛光部分成立，但卡片未重绑描边 token（B-062）→ 深色下少一层分离 |
| B-085 | ✅一致 | `styles:56` | 沿用 `--dsw-shadow-lv2`（深色不另声明，两主题相同） |
| B-086 | ✅一致 | `styles:19-64` | 固定前缀取代 CSS Module hash |
| B-087 | ✅一致 | `styles:20/55/59` | 三个 composer 变量都补了缺省值 |
| B-088 | ✅一致 | `DB.css`/`styles` 全篇 | `@media (max-width:720px)` 未复刻（与需求描述一致；`04-client` §8.1 记为待补） |
| B-089 | ✅一致 | 同上 | `prefers-reduced-motion` 未复刻（同上记为待补） |
| B-090 | ✅一致 | 同上 | `corner-shape` 未复刻 |
| B-091 | ✅一致 | `styles:61` | `monospace` 兜底保留（含 B-091 指出的 Windows CJK 退化风险） |
| B-092 | ❌缺失 | — | 无 `.editorScope` |
| B-093 | ✅一致 | `DB.css:16-23` | `border-bottom: 0.5px border-l3` ✅；padding 16/16/12/24，与需求 16/14/8/24 不同 |
| B-094 | ⚠️有差异 | `DB.css:25-31` | `.title` 字号/行高/权重/颜色一致（另有 `display` 缺省） |
| B-095 | ⚠️有差异 | `DB.css:51-60` | 透明 1px 边 + radius 8 ✅；改用 margin 定位、`gap:2px`、`overflow-x:auto` |
| B-096 | ⚠️有差异 | `DB.css:62-65` | 只有两支 `:has`（缺 hover 编辑区） |
| B-097 | ❌缺失 | `DB:349-394` | 无 `.millerRow`；两栏由 `.content` 直接 flex 容器承载 |
| B-098 | ❌缺失 | — | 无 `.crumbTrail`（面包屑直接在 `.crumbBar` 里换行/滚动） |
| B-099 | ✅一致 | `DB.css:67-72` | `.crumbSeat` inline-flex + `gap:2px` + `flex:0 0 auto` |
| B-100 | ✅一致 | `DB.css:74-87` | `max-width:160px` + ellipsis + 13/22/500 + tertiary |
| B-101 | ✅一致 | `DB.css:89-91` | hover 转 `label-primary` |
| B-102 | ⚠️有差异 | `DB.css:93-95` | `.crumbChevron` tertiary（缺 `flex:none`） |
| B-103 | ❌缺失 | — | 无 `.crumbEditZone` |
| B-104 | ❌缺失 | — | 无 `.crumbEditGlyph`（铅笔改用 `.iconButton`） |
| B-105 | ❌缺失 | — | 同上 hover 转色规则不存在 |
| B-106 | ❌缺失 | — | 无 `:disabled` 两支 |
| B-107 | ✅一致 | `DB.css:97-106` | `.pathInput` 无边框/透明/13px/outline:none（`min-width:160px` 而非 `flex:1 1 0`） |
| B-108 | ⚠️有差异 | `DB.css:139-145` | `.content` flex 列 + relative + padding（值 12/16/12/24） |
| B-109 | ⚠️有差异 | `DB.css:147-151` | `.column` `min-width:256px` + `overflow-y:auto`（缺 gap） |
| B-110 | ✅一致 | `DB.css:153-157` | `.divider` 0.5px + `border-l3` |
| B-111 | ❌缺失 | — | 无 `.rowSeat` |
| B-112 | ⚠️有差异 | `DB.css:159-172` | `.row` 28px/radius 6/透明底/左对齐（`gap:8px`、无 `flex:none`） |
| B-113 | ✅一致 | `DB.css:174-176` | hover `bg-hover` |
| B-114 | ✅一致 | `DB.css:178-181` | `.rowSelected` 带 `bg-hover` 兜底 |
| B-115 | ⚠️有差异 | `DB.css:183-185` | `.rowIcon` secondary |
| B-116 | ⚠️有差异 | `DB.css:187-189` | `.rowIconSelected` `button-info-fill` |
| B-117 | ⚠️有差异 | `DB.css:191-200` | `.rowName` flex + ellipsis + 13/20 |
| B-118 | ⚠️有差异 | `DB.css:202-204` | `.rowChevron` tertiary |
| B-119 | ⚠️有差异 | `DB.css:257-263` | 只有 `.error`（`padding:0 24px 10px`、右对齐）；无 `.status` |
| B-120 | ⚠️有差异 | `DB.css:257-263` | `.error` 用 `state-error-primary` ✅；`.status` 不存在 |
| B-121 | ✅一致 | `DB.css:206-216` | `.loadingFloat` absolute + `bg-layer-2`（右下角 24/20） |
| B-122 | ⚠️有差异 | `DB.css:218-224` | `.footerBar` + 上边线 0.5px |
| B-123 | ⚠️有差异 | `DB.css:234-246` | `.showHiddenToggle` inline-flex + secondary |
| B-124 | ⚠️有差异 | `DB.css:248-251` | 有 hover；**无 `:disabled`** 两支 |
| B-125 | ✅一致 | `DB.css:253-255` | `.showHiddenToggleActive` 转 primary |
| B-126 | ✅一致 | `DB.css:226-232` | `.footerGap{flex:1}` + `.footerAction{min-width:72px}` |
| B-127 | ✅一致 | `DB.css:265-271` | `.createDialog.createDialog` `width:min(380px,100%)` |
| B-128 | ✅一致 | `DB.css:273-277` | `.createBody` flex 列 `gap:12px`（padding 由 dialog 承担） |
| B-129 | ✅一致 | `DB.css:279-285` | `.createTitle` primary（14/22，非 16/24） |
| B-130 | ❌缺失 | — | 无 `.createIn`（「在 X 中新建」这行不存在） |
| B-131 | ⚠️有差异 | `DB.css:287-296` | `.createInput` 44px/radius 22/0.5px `border-l4` |
| B-132 | ✅一致 | `DB.css:298-306` | `::placeholder` caption + `.createActions` 右对齐 |
| B-133 | ✅一致 | `DB.css:117-126` | `.driveBtn`（多了 0.5px 边、12px 字号） |
| B-134 | ⚠️有差异 | `DB.css:128-131` | 有 hover；无 `:disabled` |
| B-135 | ✅一致 | `DB.css:133-137` | `.driveBtnActive` + 兜底链 |
| B-136 | ⚠️有差异 | `DB.css`（40 条规则） | 规模 40 条而非 50；「无硬编码色」✅、`0.5px` 发丝 ✅ |
| B-137 | ✅一致 | `styles:20` | `.magica-ix-frame` 值与需求逐字相同 |
| B-138 | ⚠️有差异 | `styles:22` | 缺 `padding:0 0 10px`、`border:0`、`--dsw-elevation-stroke-color` 与两条 scrollbar 重绑 |
| B-139 | ✅一致 | `styles:21` | `.magica-ix-card,.magica-ix-card *{box-sizing:border-box}` |
| B-140 | ❌缺失 | — | 无 `.magica-ix-min`（最小化态只靠不渲染 body，无 `max-height:none`/header padding 收紧） |
| B-141 | ⚠️有差异 | `styles:23-24` | `.header` gap 8、padding `20px 16px 0 24px` ✅；`.headings` 而非 `.heading` |
| B-142 | ⚠️有差异 | `styles:25` | 无 `margin-bottom:5px` |
| B-143 | ✅一致 | `styles:26/32` | `.title` 一致；`.detail` 用 `0 24px 8px` |
| B-144 | ⚠️有差异 | `styles:27` | `display:flex;gap:4px`，缺 `align-items/flex-shrink` |
| B-145 | ⚠️有差异 | `styles:28` | `display:inline-flex` 而非 `grid`，其余一致 |
| B-146 | ✅一致 | `styles:29-30` | hover 转 primary、disabled 转 dimmed |
| B-147 | ⚠️有差异 | `styles:31` | 只有 `overflow-y/overscroll`，缺 flex 三件与 `min-height:0`，多了 padding |
| B-148 | ⚠️有差异 | `styles:33` | 缺 `margin:8px 0 0` |
| B-149 | ⚠️有差异 | `styles:34` | `gap:10px`、`padding:8px 12px`，缺 `flex-shrink:0` |
| B-150 | ✅一致 | `styles:35-37` | hover / `.on` / `:disabled` 三态齐（disabled 多 `opacity:.6`） |
| B-151 | ⚠️有差异 | `styles:38` | 字号 11，缺 `margin-top:2px`/`line-height` |
| B-152 | ⚠️有差异 | `styles:39` | 座位 14px（需求 20px） |
| B-153 | ❌缺失 | `styles:39` | 无 `::before` 伪元素复选框（边框直接画在 `.check` 上） |
| B-154 | ⚠️有差异 | `styles:40` | `checkon` 有，`::before` 规则无（因为 B-153 不存在） |
| B-155 | ⚠️有差异 | `styles:41` | `.copy` 改成 flex 列；无 `.magica-ix-line` |
| B-156 | ✅一致 | `styles:42` | `label` 14/24/500 |
| B-157 | ✅一致 | `styles:44` | `badge`（10px/16px，需求 11/18） |
| B-158 | ✅一致 | `styles:43` | `desc` 14/24 + tertiary |
| B-159 | ⚠️有差异 | `styles:45` | `align-items:center`、`margin:4px 12px`、`border:.5px`（需求 `100%/40px/1px`） |
| B-160 | ⚠️有差异 | `styles:46` | 只有 `:focus-within` 合成一条；无 `:hover`、无 `.customon` |
| B-161 | ❌缺失 | — | 无 `.magica-ix-field` / `.field>*`（也无镜像自增高） |
| B-162 | ❌缺失 | — | 无 `.magica-ix-mirror` |
| B-163 | ⚠️有差异 | `styles:47` | `.input` resize/无边框/透明/caret 色齐（缺 `overflow-y:auto`） |
| B-164 | ⚠️有差异 | `styles:47-48` | placeholder ✅；`.field:not(.block)` 不存在 |
| B-165 | ⚠️有差异 | `styles:49` | `border/bg/focus` ✅；缺 `min-height:64px`、`--magica-ix-pad` 私有变量与 `8px 12px` 内距 |
| B-166 | ⚠️有差异 | `styles:51` | 有 flex/space-between/gap 12；padding 改 `8px 10px 10px 18px`，缺 `margin-top:12px` |
| B-167 | ❌缺失 | — | 无 `.magica-ix-pager` |
| B-168 | ⚠️有差异 | `styles:52` | `word-spacing:-2px` ✅；字号 11、缺 padding/nowrap |
| B-169 | ⚠️有差异 | `styles:53` | 有 `text-align:right` + error 色；缺 `flex:1/min-height:16px` |
| B-170 | ✅一致 | `styles:54` | `.footerbtns` `display:flex;gap:12px` |
| B-171 | ✅一致 | `styles:55` | `.apprroot` 值与需求一致 |
| B-172 | ⚠️有差异 | `styles:56` | 主体一致；缺两条 scrollbar 重绑 |
| B-173 | ✅一致 | `styles:57-58` | warn 三色/8px 圆点 ✅；padding 8/16、字号 12 |
| B-174 | ⚠️有差异 | `styles:59` | 有 `max-height`/`overflow-y`；缺 `display/gap/box-sizing`，padding `14px 16px 0` |
| B-175 | ⚠️有差异 | `styles:60` | 加了 `margin:0 0 8px`，其余一致 |
| B-176 | ⚠️有差异 | `styles:61` | 多了背景/内距/`white-space:pre-wrap`，字号 12 |
| B-177 | ✅一致 | `styles:62` | `.appractions` 右对齐 `gap:12px` + `14px 16px` |
| B-178 | ✅一致 | `styles:63` | reject hover 三声明齐 |
| B-179 | ✅有意差异 | `styles:19-64`、`00-overview` §3.5 | 规则数 44（白名单：字符串样式「约 45 条规则」），全部 `magica-ix-` 前缀，单 `<style id>` |
| B-180 | ✅一致 | `surface:45-49`、`surface:89/97` | 只声明用到的一个方法；服务用 `serviceOf` 取（非 inject 声明） |
| B-181 | ✅一致 | `surface:90` | 缺服务/缺方法 → `undefined` |
| B-182 | ✅一致 | `surface:51-54`、`surface:181-185` | `inject`/`register` 结构面 |
| B-183 | ✅一致 | `surface:182` | 任一缺失 → 跳过槽位；`try/catch` 兜住 register/inject 抛错 |
| B-184 | ✅一致 | `surface:94`、`surface:31` | 不取 locale；`options.t` + `makeTranslate(zh)` 兜底 |
| B-185 | ✅一致 | `surface:25`（声明但从不调用） | `effect?` 保留未用，卸载由调用方收口 |
| B-186 | ✅一致 | 背景（`ui-session` 每次调用建 domain） | 与本仓用法一致 |
| B-187 | ✅一致 | `surface:98/132` | 同 `key` 重复发布不会发生（`published.has(sessionId)` 先判） |
| B-188 | ✅一致 | 背景（按 `sessionId` 投影，precedence 大者胜） | 本仓 precedence 恒 1 |
| B-189 | ✅一致 | `surface:134` | `delegate` 直接 resolve |
| B-190 | ⚠️有差异 | `carrier:60-66` | `interactionRecords` 已实现但**全仓无调用点**（surface 走 HTTP）→ 事实上的死 API |
| B-191 | ✅一致 | 全仓无 `locale/change` 订阅 | 不订阅，靠 `t` 变化 + 槽位 `locale` 重渲染 |
| B-192 | ✅一致 | `panel/*` 无 `ctx.on` | 两个 Remote Event 不订阅 |
| B-193 | ✅一致 | `surface:205-210`、`surface:226-229` | 挂/摘 `visibilitychange` |
| B-194 | ✅一致 | `DB:148/157/223`、`transport:46/71` | 三处 AbortSignal 使用 |
| B-195 | ✅一致 | `panel/*` 全篇 | 不订阅任何 dsh 事件（轮询 + 注册表） |
| B-196 | ✅一致 | 背景（`conversation.composer` 是 `chain/session`） | 本仓按 chain 注册 |
| B-197 | ✅一致 | 背景（渲染点在 `ConversationRoot`） | 不在本包代码内 |
| B-198 | ⚠️有差异 | `surface:190` | 只读 `owner.pendingInteraction`，其余 owner props 不声明（结构面自建） |
| B-199 | ✅一致 | `surface:190-193` | `select` 是纯函数、无副作用 |
| B-200 | ✅一致 | `Composer:17-18` | 只吃 `matched` |
| B-201 | ✅一致 | 背景（`renderSlotChain` 签名） | 不在本包代码内 |
| B-202 | ✅一致 | 背景（`overlay` 让 fallback 常驻） | 本仓依赖该行为保住 composer 草稿 |
| B-203 | ✅一致 | 背景（完整 props） | 类型上只声明 `{matched}` |
| B-204 | ✅一致 | `surface:186-198` | 无 `children/store/inject/priority` |
| B-205 | ✅一致 | `Composer:19` | 槽位派生的 `t` 未被消费（用模块级 runtime 的 `t`） |
| B-206 | ✅一致 | `surface:188` | `name:'conversation.composer'` |
| B-207 | ✅一致 | `surface:190-193` | `select` 只认自家载体 |
| B-208 | ✅一致 | `surface:194` | `locale: INTERACTION_LOCALE_NS` |
| B-209 | ⚠️有差异 | `surface:195` | 仍传 `registrant`，但 0.2 的注册选项面没有它（S-01）→ 死字段，被静默忽略 |
| B-210 | ✅一致 | 未使用 | `priority/children/store/inject` 均未用 |
| B-211 | ✅一致 | `surface:185` | `inject` 回调在声明存在时同步跑（沿用 dsh 语义） |
| B-212 | ✅一致 | `surface:185-199` | 回调返回 `register` 的 disposer，归属调用方 fiber |
| B-213 | ✅一致 | `surface:185-199`、`surface:231-236` | `disposeSlot` = `inject` 的返回函数，连带注销注册 |
| B-214 | ✅一致 | `DB:29-33` | `DirectoryEntry` 三字段 |
| B-215 | ✅一致 | `DB:36-42` | `truncated` 必填（但从不读，见 A-087） |
| B-216 | ⚠️有差异 | `DB:45` | 自建 `Translate`（`params?: Record<string, unknown>`），等价 |
| B-217 | ✅一致 | `Card:148`、`primitives.d.ts:38` | `MarkdownLabels` 形状一致 |
| B-218 | ⚠️有差异 | `wire:11-95` | 8 个契约类型都在，但集中在 `shared/wire.ts`（含 `InteractionEnvelope`），非 `interactions/types.ts` |
| B-219 | ✅一致 | `carrier:15-19`、`carrier:22` | 结构性满足，不 import |
| B-220 | ✅一致 | 全仓 grep：无 `dsh-client-ui-session/slots/approval/user-questions` import | 零 dsh 客户端依赖（`primitives` 用 ambient 声明） |
| B-221 | ⚠️有差异 | `panel/index:1-31` | 导出语句 15 条左右，符号集与基线的 30/34 计数不可直接对照 |
| B-222 | ⚠️有差异 | `Card:2` + `carrier:6` + `Composer:1` + `locales:5` + `runtime:3` + `styles:3` + `surface:5` + `transport:2` | 逐文件计数不同（`runtime` 3 而非 4，`Carrier` 多一个 `SessionPendingInteractionBase`） |
| B-223 | ⚠️有差异 | 同上 | 种类分布随之变化（函数/组件 11、类型 12、常量/字典 5、class 1） |
| B-224 | ✅一致 | `panel/index:30-31` | `install`/`release` 不可达 |
| B-225 | ⚠️有差异 | `panel/index:1-31`、`client/index:11-29` | 可达性口径变了：`./interactions` 子入口不存在，全部经 `./client` |
| B-226 | ✅一致 | `DB:110`、`DB:258` | 签名与 `open===false → null` |
| B-227 | ✅一致 | `DB:48-59` | 全类型齐 |
| B-228 | ⚠️有差异 | `Card:328` | 签名少 `variant`（传进来也不消费），故「缺省 `'plain'`」无意义 |
| B-229 | ✅一致 | `Card:30-36` | 3 必填 + 2 可选 |
| B-230 | ✅一致 | `Composer:17` | `({ matched }: { matched: unknown })` |
| B-231 | ✅一致 | `carrier:22-35` | 构造与五个字段 |
| B-232 | ✅一致 | `carrier:38-47` | 类型守卫 |
| B-233 | ✅一致 | `carrier:60-66` | 排序口径一致 |
| B-234 | ✅一致 | `carrier:53-57` | 三方法全签名 |
| B-235 | ✅一致 | `locales:64` | 比 `Translate` 更窄（值必须 string） |
| B-236 | ✅一致 | `runtime:14-17` | `t` + `actions` |
| B-237 | ✅有意差异 | `styles:19-64` | 44 条规则（白名单 `00-overview` §3.5） |
| B-238 | ✅一致 | `styles:77` | 返回幂等移除函数 + 写 `data-plugin` |
| B-239 | ✅一致 | `surface:23-27` | 三成员齐（`effect` 返回 `unknown`） |
| B-240 | ✅一致 | `surface:30-36` | 2 必填 3 可选 |
| B-241 | ✅一致 | `surface:39-43` | `refresh` + `dispose` |
| B-242 | ✅一致 | `surface:85-88` | 返回 `undefined` 的条件一致 |
| B-243 | ✅一致 | `transport:22-25`、`transport:68-75` | `list()` 失败抛错，不折成 Result |
| B-244 | ✅一致 | `transport:55-56`、`wire:103` | 前缀缺省 `/magica` |
| B-245 | ✅一致 | `globals.d.ts:2-5` | ambient `classes` |
| B-246 | ⚠️有差异 | `panel/index:6-31` | 14 条 export / 约 26 个符号名（含 `SessionPendingInteractionBase` 与 `makeTranslate`） |
| B-247 | ⚠️有差异 | `panel/index:6-31` + `client/index:12-29` | 转出明细映射到新行号；wire 类型搬到 `client/index` |
| B-248 | ❌缺失 | `DB:29-45` | 不再是「2 条 `export type` 转出 3 个符号」，而是本地声明+直接导出 |
| B-249 | ✅一致 | `runtime:4-7` | 不外露的理由（装配权归 surface + 身份比对）写在文件头 |
| B-250 | ✅一致 | `surface:13/179/237` | 全仓唯一装/摘点 |
| B-251 | ✅有意差异 | `00-overview` §3.7、`package.json:14` | 子入口导出裸组件（raw TSX） |
| B-252 | ✅一致 | `DB:48-59` | 数据全走 props |
| B-253 | ⚠️有差异 | `DB:15-25/29-42` | 类型自建（不引 `dsh-host-directory-picker/types`）；`04-client` §1.1 仍写成引自该包 → 文档滞后 |
| B-254 | ❌缺失 | `DB` 全篇 | 既无 `clsx` 也无 `cx`，className 用模板串拼 |
| B-255 | ⚠️有差异 | `DB:211`、`DB:86-88` | 用 `lastNavigatedPath ?? defaultTopLevel()` ✅；但 `defaultTopLevel()` 无缓存时给 `'/'` 而非 `undefined` |
| B-256 | ⚠️有差异 | `DB:324-326` | Esc 只清草稿，不重新导航 |
| B-257 | ✅一致 | `DB:187-190`、`DB:246-256` | 计时器 id 存 ref，落地/关闭/卸载都清 |
| B-258 | ✅一致 | `DB:129-130` | `listDirectoryRef` 收 props，避免请求自持 |
| B-259 | ✅一致 | `DB:214-242`、`DB:334-347` | `drivesCache` + `GET /cac/drives` + 盘符按钮 |
| B-260 | ✅一致 | `DB:56-58` | 三个扩展点 |
| B-261 | ✅一致 | `DB:121/287/449` | 独立 `createError` |
| B-262 | ⚠️有差异 | `DB:62-64` vs `DB:260/324-326/380-382` | 三常量里两个 ✅（`PARENT_LEG_WAIT_MS`/`SLOW_SCAN_DELAY_MS`）、`DRAFT_PREVIEW_DEBOUNCE_MS` ❌；**`readDraft`/`select`/`advance`/`cancelPathEdit`/焦点四标记全未实现** |
| B-263 | ✅一致 | `Card.tsx` | 自建 `InteractionCard`（官方不导出） |
| B-264 | ✅一致 | `styles:1-13` | 字符串 + `<style>` 注入（固定前缀 + refs） |
| B-265 | ✅一致 | `Card:77` | 组件内 state |
| B-266 | ✅一致 | `surface:138-149`、`carrier:22-35` | HTTP 轮询 + 标记载体 |
| B-267 | ✅一致 | `carrier:41-46` | `tag` 判定 |
| B-268 | ✅一致 | `transport:76-101` | POST 到 `/magica/interactions/*` |
| B-269 | ✅一致 | `surface:160-176` + 下一拍自愈 | `dropCarrier` 当场摘 |
| B-270 | ✅一致 | `surface:151-158`、`surface:105-107` | 5s 自链 + 隐藏暂停 |
| B-271 | ✅一致 | `Card:328-334` | `PlanReviewPanel` 未复刻（`00-overview` §3.9 记为未做） |
| B-272 | ⚠️有差异 | `Card:275-284/311` | 纯文本 → 美化 JSON `<pre>` |
| B-273 | ✅一致 | `DB:225/233-237` | 显式判 `ok` + 空吞 + 5s 超时；并加了失败 TTL 缓存（超出需求） |
| B-274 | ✅一致 | `DB:80-88` | 只由宿主 `home` 推断 |
| B-275 | ⚠️有差异 | `DB:64/154-155`、`DB:392` | 300ms 提示 ✅、旧视图继续渲染 ✅；`truncated` 无任何提示（需求里至少应提示） |
| B-276 | ✅一致 | `DB:172-180` | 200ms 先落单栏、晚到升级 |
| B-277 | ✅一致 | `DB:129-130` | ref 化 + `navigate` 依赖 `[props]`（见 P0-2 的另一面） |
| B-278 | ✅一致 | `surface:90` | `uiSession` 不可用静默返回 `undefined`（会话页无卡片无提示，与基线同） |
| B-279 | ✅一致 | `surface:182` | 跳过槽位注册，载体照常发布 |
| B-280 | ✅一致 | `surface:219-239` | 消费方忘 `dispose` 无自愈（设计即如此） |
| B-281 | ✅一致 | `runtime:22-34`、`styles:71-105` | 样式共享 + refs 正确；runtime 最后装的赢 |
| B-282 | ✅一致 | `surface:139`、`surface:206-210` | 隐藏 return + 回前台补拍 |
| B-283 | ✅一致 | `surface:141-146` | `catch` 空吞保留上一份 |
| B-284 | ✅一致 | `surface:70-77` | 一会话只显示等得最久那条（无队列提示） |
| B-285 | ⚠️有差异 | `Card:222`、`DB:328/446` | 本仓提问卡**已加** IME 守卫（`isComposing \|\| keyCode===229`），选择器两处输入框也有 → 该风险已消除 |
| B-286 | ✅一致 | `Composer:23` | key 是唯一防线，已保留 |
| B-287 | ✅一致 | `Card:79/113/128` | 报错存已翻译字符串 → 切语言不跟随（同基线退化） |
| B-288 | ✅一致 | 无 `@media` | 窄屏 / reduced-motion 未复刻（同基线；`04-client` §8.1 要求补） |
| B-289 | ✅一致 | `Card:328-334` | `plan-review` 走通用问答流，无三分支按钮 |
| B-290 | ✅一致 | 背景（待决状态是内存态） | 宿主重启后列表为空 |
| B-291 | ⚠️有差异 | `wire:46-65`、`carrier:25/33`、`Card:329` | 扩展落点变成 `wire` + `carrier` + `Card`（文件改名），链路本身仍自动适配 |
| B-292 | ⚠️有差异 | `styles:19-64`、`panel.test.ts:75-84` | 落点正确；测试文件名/断言集合不同（只锁前缀/无硬编码色/token，不锁具体声明） |
| B-293 | ✅一致 | `surface:93` | `intervalMs` 被硬下限夹住，改不动 |
| B-294 | ✅一致 | `DB:36-42`、`DB:260` | 只依赖 `crumbs`/`entries` 契约 |
| B-295 | ⚠️有差异 | `DB:76-78` | 模块级缓存区仍在，但共享面变小（无 `drives` 落点记忆） |
| B-296 | ❌缺失 | — | 无 `plan-review` 分流落点（`Card:329` 只按 `kind` 两分） |
| B-297 | ✅一致 | `Composer:14-16/23` | 承重墙 key + 理由注释都在 |
| B-298 | ✅一致 | `surface:125`、`surface:147` | 同 tick / 跨 await 两道守卫都在 |
| B-299 | ✅一致 | `styles:91` | `data-plugin` 重写（后注入者覆盖）——同样的已知未处理边界 |
| B-300 | ✅一致 | `DB:15-26` vs `panel/*` | 两子系统零共享、零互相 import |
| B-301 | ✅一致 | `surface:1-8/23-54` | 不 import 任何 dsh UI 包，结构面自建 |
| B-302 | ✅一致 | `wire:103-111`、`transport:9-15` | 前缀与路径同源常量 |
| B-303 | ❌缺失 | `DB:334-347` | 无 `browser.drives`、无 `drivesLabel !== 'browser.drives'` 判定 |
| B-304 | ✅一致 | `locales:8/11-33` | `ix.` + `magica-interaction` 独立命名空间 |
| B-305 | ✅有意差异 | `00-overview` §3.5、`client/index:4-6` | spellbook 是库不写 `apply`/`dsh.client` |
| B-306 | ✅一致 | `package.json:14` | raw TSX 子入口 |
| B-307 | ⚠️有差异 | `panel/index:1-31`、`package.json:13` | 能力在，但入口是 `./client`（打包好的 ESM），无 `./interactions` 子入口 |
| B-308 | ✅一致 | `src/interactions/index.ts:18` | `createInteractionHandler` / `interactionRoutes` 都已导出 |
| B-309 | ✅有意差异 | 本仓即库本身 | 消费插件骨架不在本仓（归消费方） |
| B-310 | ✅有意差异 | `package.json:11-17` | 无 `dsh`/`dsh.bundle`/`dsh.client`（库）；`exports`/`files` 覆盖 `./client` 与 `./directory-browser` |
| B-311 | ✅一致 | 背景（插件级 vs 服务级 inject） | 本仓不涉及插件装配 |
| B-312 | ✅有意差异 | 同 B-310 | 库无 `dsh.client` |
| B-313 | ⚠️有差异 | 全仓无 `cordis.patch.yml` | 三条规则只在 `04-client` §7.2 以文档给出，仓库内无示例文件可照抄 |
| B-314 | ✅一致 | `surface:185-199` | 不改组合，只往 composer 加载体 |
| B-315 | ⚠️有差异 | `04-client:264-284` | 骨架只在文档里（含 `slots/uiWorkspace/locale/workspaces` 四个服务），本仓无对应实现 |
| B-316 | ❌缺失 | 全仓无 `browser.*` 字典 | 13（实际用到 9）个 `browser.*` key 的字典资产不存在 → 消费方装配后界面显示 key 原文 |
| B-317 | ✅一致 | `04-client:264-284` | 两个洞 + generator 写法在文档中给出 |
| B-318 | ✅一致 | `04-client:271-275` | `inject: () => ({...})` 函数形 |
| B-319 | ✅一致 | `04-client:276-280` | `function*` + `yield register` |
| B-320 | ✅一致 | `04-client:270` | 字典/槽位/定时器都进 `ctx.effect` |
| B-321 | ✅一致 | `surface:181-203` | surface 内部自己占 composer；文档给出消费方两行装法 |
| B-322 | ✅有意差异 | `00-overview` §3.5 | 本仓 `lib/client.js` 是 ESM bundle（保留 externals），不是闭包工厂 |
| B-323 | ✅有意差异 | `scripts/build.mjs:21-30` | externals **9 项**（含 `dockkit`），与 0.2 平台表一致（§5#19） |
| B-324 | ✅有意差异 | 同 B-322 | 不需要 `__ModuleLoader__` 包裹 |
| B-325 | ⚠️有差异 | `DB:26`、`styles:77` | `DB` 的 CSS Module 由消费方打包器处理（不经本仓注入）；`panel` 样式是字符串注入 → lightningcss+`data-plugin` 链路在本仓不存在 |
| B-326 | ✅一致 | `04-client:226-232`、`globals.d.ts:2-5` | raw TSX 的 typecheck 代价已在文档记录；本仓用 ambient 声明缓解 |
| B-327 | ✅一致 | 背景（client 改动需刷新） | 真机结论记录在 `00-overview` §3.8 |
| B-328 | ✅一致 | 背景（host 改动需重启） | 同上 |
| B-329 | ✅一致 | 背景（patch 改动需重装） | 同上 |
| B-330 | ✅一致 | 背景（dev profile 隔离） | 同上 |
| B-331 | ✅有意差异 | 同 B-310 | 库没有 `dsh.client.platform` |
| B-332 | ✅有意差异 | 同 B-322 | 不会出现 `__ModuleLoader__ is undefined` |
| B-333 | ✅一致 | `scripts/build.mjs:21-30` | `react`/`react-dom` 在 external，不会打两份 |
| B-334 | ❌缺失 | 同 B-316 | 无字典资产，「文案是 key 原文」的排查项无解可抄 |
| B-335 | ✅一致 | `04-client:245-262` | 官方选择器需先 disable（文档给出） |
| B-336 | ✅一致 | 全仓无 `locale.register` | 本仓不注册字典，故不存在该热更抛错路径 |
---

## 4. 存疑裁决（S-01 – S-17）

| # | 裁决 | 一句理由 |
|---|---|---|
| S-01 | **采纳** | `surface:`195 仍在传 `registrant`，而 0.2 的 `register` 选项面无此键——字段被静默忽略，属死参数；诊断标签应改用 `id`/`order`。 |
| S-02 | **采纳（但结论转移）** | 本仓 `truncated` 是必填且**从不读取**（`DB:36-42`），矛盾不是"类型 vs 防御"而是"字段 vs 未实现"，归入 A-087/B-275 的缺口。 |
| S-03 | **采纳** | `Composer:`23 的 key 是承重墙，但"chain 按注册项 key"是渲染器实现细节，0.2 需以 `Slots.listSubTree` 复核；**保留 key，重验理由**。 |
| S-04 | **采纳** | `overlay`/`fallbackOnly` 是 dsh 渲染点的行为，不在本包代码里，不能当本仓验收项；但它决定 `magica-ix-frame` 的 inset 假设（`styles:20`）。 |
| S-05 | **采纳** | 本仓确有 `PARENT_LEG_WAIT_MS`（`DB:62`）与 `SLOW_SCAN_DELAY_MS`（`DB:64`），但**没有** `DRAFT_PREVIEW_DEBOUNCE_MS`（无草稿预览），断言必须先落源码。 |
| S-06 | **采纳** | 本仓轮询终止条件只有「dispose」「页面隐藏」（`surface:139`），无"任务完成/达上限"；`intervalMs` 又不可调低 → 通宵挂着的标签页会一直拍。 |
| S-07 | **采纳** | 同一条机制既是解又是未处理边界：`styles:91` 每次注入都覆盖 `data-plugin`，先注入方的 HMR 会摘掉共享标签；本仓还多一个脆弱点（元素句柄缓存，`styles:79-89`）。 |
| S-08 | **采纳** | `styles:61` 保留 `var(--ds-font-family-code, monospace)`，在字体栈缺失时正好踩上 dsh 刻意规避的 Windows CJK 退化。 |
| S-09 | **采纳并升级** | 硬编码 `C:\` 之外，本仓 `defaultTopLevel()` 在**无缓存时也不返回 `undefined`**（`DB:86-88`）→ 首屏落 `/` 而非 homedir，已是功能缺口而非措辞问题。 |
| S-10 | **不采纳** | 该笔误只影响按原文路径去 dsh 检出落行号；本仓核对全部走 `D:\project-code\llm\deepseek-harness`，与本条无关。 |
| S-11 | **采纳** | `DB:258` 先 `return null`、`DB:294` `Modal open={open}` 恒真，Modal 自身的关闭分支不会执行；`DB:324-326` 的 Esc 处理因此是**唯一**可能被用户触发的 Escape 路径。 |
| S-12 | **采纳** | 本仓已按 0.2 用 **9 项** externals（`scripts/build.mjs:21-30`，含 `dockkit`），与 `00-overview` §5#19 一致；照抄 8 项才是坑。 |
| S-13 | **采纳** | `globals.d.ts:8-12` 的 `__DSH_BOOT__` 全仓无读取、`surface:25` 的 `effect?` 从不调用，另有第三处死契约：`carrier:60-66` 的 `interactionRecords` 无调用点。 |
| S-14 | **采纳** | 三个常量"数值一致"≠"生命周期一致"：本仓清了父腿计时器（`DB:187-190/246-256`），基线不清；验收必须拆成数值断言 + 清理断言。 |
| S-15 | **采纳** | 本仓用 `primitives.d.ts` + `globals.d.ts` 缓解类型缺口，但 `04-client` §6.3 仍要求消费方 typecheck 包含该 `.tsx`；这是"已发生、未修复"的代价。 |
| S-16 | **采纳** | 本仓更彻底：`surface` 根本不注册 locale，`locale:` 只用于槽位派生 `t`，而 `Composer:19` 只读 `matched` → 派生的 `t` 恒未消费。 |
| S-17 | **采纳** | `data-plugin` 只能写一个包名，而标签全页共享；`styles:91-92` 的"重写 + 计数"在多插件 HMR 场景互相矛盾，只能断言单插件正确。 |

---

## GAPS

> 排序原则：**会导致 UI 不出现 / 崩溃** > **交互错误** > **体验**。每条四段：现状 / 原始要求（引 ID + 原文） / 最小修法 / 需要补的断言。
> 全部为只读结论，未改任何源码。

### P0 —— UI 不出现 / 崩溃

**P0-1 `serviceOf` 的属性回退裸奔，装配可能直接抛错（卡片整片消失）**
- 现状：`surface:56-67` 只有 `scope.get(name)` 包了 `try/catch`；`surface:65` 的 `scope[name]` 裸访问。cordis 里访问未声明 `inject` 的 service 属性会抛错 → `createInteractionSurface` 抛出 → 消费方 `apply` 崩 → 会话页连卡片带槽位一起没。
- 原始要求：A-180「取服务顺序：先 `scope.get?.(name)`，失败或 `undefined` 再试 `scope[name]`（service 代理属性）；**两个 `try/catch` 都是必需的**（没声明 `inject` 时访问 `ctx.uiSession` 会抛错）」。
- 最小修法：`surface:65` 的 `const direct = scope[name]` 整段包 `try { ... } catch { return undefined }`（3 行）。
- 需要补的断言：`createInteractionSurface` 在「`get()` 返回 undefined 且属性访问抛错」的假 scope 上返回 `undefined`、不抛；另加一条「属性访问返回代理对象」的正例。

**P0-2 `navigate` 的 `useCallback` 依赖整个 `props`，导航 effect 随消费方重渲染反复触发（请求风暴 / 永远 loading）**
- 现状：`DB:143-207` 的 `useCallback(..., [props])`；`DB:209-212` 的 effect 依赖 `[open, navigate]`。消费方一次重渲染 → `props` 换身份 → `navigate` 换身份 → effect 重跑 → 再打两条 `listDirectory`；`DB:167` 又回调 `onPathChange`，消费方若据此 setState 就形成「渲染→effect→请求→回调→渲染」自持环。`04-client` §5#8 之所以要求把 `listDirectory` 收进 ref（`DB:129-130`），要防的正是这个环——本仓只做了一半。
- 原始要求：B-258「与官方差异（`listDirectory` 身份）：官方直接用 props（进 `useCallback` 依赖）；本仓库收进 ref，因为……『渲染→effect→navigate→setState→重渲染』会自持成请求循环（弹窗永远 loading）」；`04-client` §5#8 同。
- 最小修法：`navigate` 的依赖改成 `[]`（所有外部输入已经走 ref；`props.onPathChange` 也进 ref），并把 `DB:209-212` 的 effect 依赖收敛为 `[open]`。
- 需要补的断言：同一 `open=true` 周期内，父组件连续重渲染 N 次后 `listDirectory` 调用次数恒为 2（目标腿 + 父腿）；`onPathChange` 触发的父组件 setState 不引发第二轮请求。

**P0-3 首屏落点错误：无缓存时 `defaultTopLevel()` 返回 `'/'`，不走宿主 homedir**
- 现状：`DB:86-88` 恒返回 `hostIsWindows() ? 'C:\\' : '/'`；`DB:211` 首屏 `navigate(lastNavigatedPath.value ?? defaultTopLevel())`。Windows 宿主首次打开会去 `listDirectory('/')`（宿主侧大概率 400 或空列表）；POSIX 宿主首次打开直接跳根目录而非家目录。
- 原始要求：A-050「`defaultTopLevel() => string \| undefined`：有 `hostHomeCache` 时 Windows 返回 `'C:\\'`、否则 `'/'`；**无缓存返回 `undefined`（让宿主用自己的 homedir）**」；`04-client` §3.2「首次打开前无缓存 → 落在**宿主 homedir**」。
- 最小修法：`DB:86-88` 改为 `function defaultTopLevel(): string | undefined { return hostHomeCache.value === null ? undefined : (hostIsWindows() ? 'C:\\' : '/') }`，`DB:211` 与 `DB:143` 的签名同步放宽为 `string | undefined`。
- 需要补的断言：`hostHomeCache` 为空时首屏请求的参数是 `undefined`；`home` 回来一次之后同一页面会话内变为 `'C:\\'` 或 `'/'`。

**P0-4 `pollOnce` 的后半段没有 try/catch，异常会变成 unhandled rejection**
- 现状：`surface:141-146` 只包住 `transport.list()`；`surface:148` 的 `publishRecords(records)` 在 try 外。`transport:74` 又直接 `return value.items`（无 `?? []`）——宿主少下发 `items` 时 `surface:126 claim(undefined)` 会抛；`surface:134` 的 `publish(...)` 若因重复 `key` 抛错也会穿出去。`surface:212` 是 `void pollOnce()`、`surface:155` 是 `.finally()`，**都没有 catch** → 浏览器控制台 unhandled rejection，且这一拍不再重排（`schedule` 在 `finally` 里，仍会排下一拍，但错误噪声会淹没真实故障）。
- 原始要求：A-199「`list` 用 `value.items ?? []` 容忍缺字段」；A-227「`catch` 空吞——一次失败最可能只是 web 进程正忙，卡片不该闪没」。
- 最小修法：`transport:74` → `return Array.isArray(value.items) ? value.items : []`；`surface:138-149` 的 `publishRecords` 调用也包进 `try/catch`（失败即保留上一份）；`surface:212` 改 `void pollOnce().catch(() => {})`。
- 需要补的断言：`fetch` 返回 `{ok:true,value:{}}` 时 `list()` 返回 `[]` 而非抛；`publish` 抛错时 `pollOnce` 不 reject 且不摘掉已有载体。

**P0-5 `browser.*` 字典资产不存在，消费方照文档装配会看到 key 原文**
- 现状：`DB` 用到 9 个 `browser.*` key（`DB:294/296/300/392/402/410/415/423/433/438/443/452/459`），全仓没有任何 `zh/en` 字典文件或常量；`04-client` §7.3 的骨架只有 `ctx.locale.register('directory-browser', {zh, en})` 一行，没有字典内容。
- 原始要求：A-090「13 个 `browser.*` key 的字面量**不在本仓库**……必须在消费方字典里以命名空间 `directory-browser` 注册，否则界面显示 key 原文」；B-316「client 半必须自己注册文案……`browser.*` 共 **13 个 key**」；B-334「卡片/选择器出现但文案是 key 原文 → 没注册该命名空间的字典」。
- 最小修法：在 `src/client/directory-browser/` 下新增 `locales.ts`（导出 `zh`/`en` 两份字典 + `DIRECTORY_BROWSER_LOCALE_NS`），并让 `package.json` 的 `files`/`exports` 覆盖它；`04-client` §7.3 的骨架改成 `import { zh, en } from '…/locales'`。
- 需要补的断言：`Object.keys(zh).sort()` 与 `Object.keys(en).sort()` 深度相等；字典 key 集合 ⊇ 组件里出现的全部 `t('browser.*')` 字面量（用正则扫 `.tsx` 做表驱动断言）。

**P0-6 样式标签句柄缓存 + 缺 `data-plugin-css`：HMR 后可能写出「脱管样式」**
- 现状：`styles:79-89` 仅在 `styleState.element === null` 时查 DOM；`styles:91` 只写 `data-plugin`。若 dsh HMR 在 `refs > 0` 的窗口内按 `data-plugin` 摘掉标签（另一个插件重载），本模块的 `styleState.element` 仍指向已 `remove()` 的节点，`styles:91-92` 之后所有注入都写进脱管节点 → 卡片样式**静默全丢**（`refs` 计数也永远不会归零到 0 之外的正确状态）。
- 原始要求：A-172「已存在则 `refs + 1` 并**重写** `data-plugin`/`data-plugin-css`；否则建标签……返回幂等移除函数（`released` 布尔锁 + **每次都重新 `getElementById`**）」；B-053「写 `data-plugin` = 消费方插件包名，web shell 的 HMR 驱动按它清理」。
- 最小修法：`injectInteractionStyles` 每次进入都 `document.getElementById(...)`（不信任缓存），并补 `dataset['pluginCss'] = ''`（React 的 dataset 映射写出 `data-plugin-css`）。
- 需要补的断言：先注入 A、外部 `remove()` 掉标签、再注入 B → 文档里重新出现一个带 `data-plugin=B` 的标签；两次注入 + 一次释放后 `refs === 1` 且标签仍在。

### P1 —— 交互错误

**P1-1 摘卡按 `sessionId` 而非 `kind:id`**
- 现状：`surface:109-122` `drop(sessionId)`；`carrier:33` 的 `key` 是 `kind:id`，但 `published` 的键是 `sessionId`（`surface:98`）。
- 原始要求：A-139「`key` 用 `kind:id` 而不是只有 `id`……摘卡必须按 `kind:id` 精确摘，**不按 `sessionId` 一把清**」；A-184「`live: Map<'kind:id', …>`……`dropCarrier(view)` 按 `kind:id` 精确摘」。
- 最小修法：`published` 改 `Map<carrier.key, unpublish>`，`claim()` 仍按 `sessionId` 去重（这层是对的），`drop` 接收 `record` 并算 `${kind}:${id}`。
- 需要补的断言：同会话先发 question、结算后再发 approval 时，`unpublish` 只对当前那条调用一次；`drop` 一个未发布的 key 是无操作。

**P1-2 无 `inFlight` 互斥，三路可并发 `list()`**
- 现状：`surface:138-149` 无 `inFlight`；`surface:216-218` 的 `refresh()`、`surface:206-208` 的 `visibilitychange`、`surface:151-158` 的定时器互不知情。
- 原始要求：A-224「在途互斥（`:240`）：`if (disposed \|\| inFlight) return`」。
- 最小修法：加模块内 `let inFlight = false`，在 `pollOnce` 入口判、`finally` 复位（`surface:155` 已有 `finally` 可复用）。
- 需要补的断言：并发两次 `refresh()` 只产生一次 `fetch`；`refresh()` 与回前台同时发生时同样只有一次。

**P1-3 主对话框 `onClose` 无守卫，`busy` 时点遮罩/按 Esc 会关掉整个选择器**
- 现状：`DB:294` `onClose={props.onClose}` 直通；只有新建弹窗有 `creating` 守卫（`DB:430-432`）。
- 原始要求：A-253「`onClose` 包了守卫：新建文件夹弹窗开着、`busy`、`committing` 时**不关**（`:639`、`:848`）」；B-006「`onClose`（有草稿 / 忙碌时拒绝关闭）」。
- 最小修法：`DB:294` 改 `onClose={() => { if (props.busy \|\| creating \|\| draft !== null \|\| folderDraft !== null) return; props.onClose() }}`。
- 需要补的断言：`busy=true` 时触发 Modal 的 `onClose` 不会调用 props 的 `onClose`；`draft !== null`（路径编辑中）同理。

**P1-4 路径编辑态按 Esc 会连带关掉对话框（未 `stopPropagation`）**
- 现状：`DB:323-329` 的 `onKeyDown` 里 Escape 只 `setDraft(null)`；事件继续冒泡到 Modal 的 keydown 监听 → `onClose`。
- 原始要求：A-254「Escape：`Modal` 内部统一监听 `keydown`，本仓库额外在 `editorScope` 上做 `stopPropagation` 拦截（路径编辑态下 Escape 只退出编辑、不关弹窗）」。
- 最小修法：`DB:324-326` 的 Escape 分支加 `event.stopPropagation()`；同时 `DB:445-448` 的新建输入框也一样处理。
- 需要补的断言：`draft !== null` 时按 Escape → `draft === null` 且 `onClose` 未被调用。

**P1-5 多题流程里「跳过最后一题」只提交当前题的回答**
- 现状：`Card:104-108` `skip()` 在 `isLast` 时 `submit([{ id: question?.id ?? '', selected: [] }])`——只提交**一道**答案，其余题目既没在 `drafts` 里也没进 payload；宿主按题号对账时其余题会被判「未作答」。
- 原始要求：A-118「`buildAnswers` 与 dsh `submitDrafts` 同口径」+ A-119「`skip`（`:231`）」；A-121「`settle` 的成功分支也 `setBusy(null)`」暗示提交必须是整组 `answers`。
- 最小修法：`skip()` 的 `isLast` 分支改成 `const answers = questions.map((item, at) => at === index ? { id: item.id, selected: [] } : toAnswer(item, drafts[at] ?? emptyDraft()))` 再 `submit(answers)`。
- 需要补的断言：3 题流程在第 3 题点「跳过」→ `answerQuestion` 收到的 `answers.length === 3`，第 3 条为 `{selected: []}`。

**P1-6 eyebrow 误用「推荐」文案，且推荐徽标逻辑整块缺失**
- 现状：`Card:155` `{question.header ?? t('ix.recommended')}`；`styles:44` 有 `.magica-ix-badge` 但 JSX 从不渲染；`Card:188-210` 也不解析 `(Recommended)` 后缀。
- 原始要求：A-114「`RECOMMENDED` = 正则…」、A-116「`parseRecommended` 只拆**显示**、不改答案值」、A-150「`ix.recommended`：zh = `推荐`…」、B-157「注入规则 30 `.magica-ix-badge`（`C309`）」。
- 最小修法：`Card:155` 改为 `question.header ?? ''`（空则整行不渲染）；新增 `parseRecommended()` 并在选项 label 后渲染 `<span className="magica-ix-badge">{t('ix.recommended')}</span>`。
- 需要补的断言：`header` 缺失时 DOM 不含 eyebrow；label 为 `"Allow (Recommended)"` 时显示文案为 `Allow` + 徽标，且提交的 `selected` 仍是原始 label。

**P1-7 选项行与反馈位缺 ARIA，读屏无法作答**
- 现状：`Card:190-208` 选项是裸 `<button>`（无 `role="radio"/"checkbox"`、无 `aria-checked`、无 `radiogroup`）；`Card:251` 的 feedback 无 `role="status"`；`DB:356-369` 的行无 `aria-current`。
- 原始要求：A-269「提问卡的 DOM 结构逐条复刻：`role="radiogroup"/"group"`、`role="radio"/"checkbox"` + `aria-checked`、`aria-label={display.label}`、… `role="status"` 的 feedback 位」；A-060「行上 `aria-current={selected \|\| undefined}`」。
- 最小修法：选项容器加 `role={multi ? 'group' : 'radiogroup'}`，选项加 `role`/`aria-checked`/`aria-label`；feedback 加 `role="status"`；`DB:380` 的行加 `aria-current={selected?.path === entry.path ? 'true' : undefined}`。
- 需要补的断言：`role="radio"` 数量 == 选项数、选中项 `aria-checked="true"`；报错出现时存在 `role="status"` 节点。

**P1-8 新建文件夹弹窗标题不是 heading，`createIn` 缺失**
- 现状：`DB:438` 用 `<p className={css.createTitle}>`；无 `.createIn`（B-130）。
- 原始要求：A-251「两个 `Modal` 都用 `headless`、自己画 `h2`」；B-129/B-130 的 `.createTitle`/`.createIn`。
- 最小修法：`DB:438` 的 `<p>` 换 `<h2>`；需要展示目标目录时加 `.createIn` 一行并补 CSS。
- 需要补的断言：`document.querySelectorAll('h2').length >= 2`（两处弹窗各一）；可选断言 `createIn` 文案包含当前目录名。

### P2 —— 体验 / 一致性

**P2-1 卡片样式缺三处关键 token 重绑与最小化态样式**
- 现状：`styles:22` 无 `--dsw-elevation-stroke-color` 重绑（B-062/B-084）与 `--dsh-scrollbar-thumb(-hover)` 重绑（B-074/B-075）；无 `.magica-ix-min`（B-140），最小化只靠不渲染 body。
- 原始要求：B-062「token `--dsw-alias-border-l2-darkmode-thin`：`.magica-ix-card` 的 `--dsw-elevation-stroke-color` 重绑」、B-074/B-075、B-140「注入规则 4 `.magica-ix-min`：`max-height:none`；规则 5 …`padding-bottom:14px`」。
- 最小修法：`styles:22` 末尾补三个自定义属性；`styles:19-64` 加 `.magica-ix-min{max-height:none}` 与 `.magica-ix-min .magica-ix-header{padding-bottom:14px}`，`Card:152` 的 `<section>` 在 `minimized` 时追加 `magica-ix-min`。
- 需要补的断言：`INTERACTION_STYLES` 含 `--dsw-elevation-stroke-color` 与 `--dsh-scrollbar-thumb`；含 `.magica-ix-min`；最小化时 `section.classList` 含它。

**P2-2 自由文本行缺镜像自增高与 `--magica-ix-pad`**
- 现状：`Card:214-226` 单行 `<input>`，无 `.magica-ix-mirror`/`.magica-ix-field`（B-161/B-162）；`styles:49` 的 `.magica-ix-block` 无 `min-height:64px`。
- 原始要求：B-161/B-162「`.magica-ix-field`…`.magica-ix-mirror`（自增高镜像）」；A-271「`.customBlock` 的 `min-height:64px` + `--magica-ix-pad:8px 12px`」。
- 最小修法：把 `<input>` 换成 `<textarea>` + 隐藏 mirror 的 grid 两层（照 B-161/B-162 的声明），无选项题套 `.magica-ix-block` 并补 `min-height:64px`。
- 需要补的断言：长文本输入后 textarea 高度增长（`scrollHeight <= clientHeight`）；`.magica-ix-block` 的 `min-height` 断言。

**P2-3 `title`/`variants` 死参数 + 收起按钮归属**
- 现状：`Card:30-36` 声明 `variant`，`Card:328` 不取；`Card:159-166` 收起按钮恒渲染。
- 原始要求：A-124「收起按钮……本仓库仅 `variant === 'takeover'` 渲染」；B-228「`variant` 缺省 `'plain'`」。
- 最小修法：`Card:328` 接住 `variant = 'plain'`，把它透传给 `QuestionFlow`，收起按钮按 `variant === 'takeover'` 条件渲染。
- 需要补的断言：`variant="plain"` 渲染结果不含 `title="收起/展开问题卡片"` 的按钮；`takeover` 含。

**P2-4 `MarkdownText` 的 `labels` 未记忆，丢流式缓存**
- 现状：`Card:148` 每次渲染新建 `{code:{...},footnotes}`。
- 原始要求：A-264「`labels` 必须是**引用稳定**的对象……本仓库用 `useMemo` 按 `t` 记忆」。
- 最小修法：`const labels = useMemo(() => ({...}), [t])`（`useMemo` 已在 `Card:9` 导入）。
- 需要补的断言：两次渲染（同一 `t`）拿到的 `labels` 引用相等（可用 `React.memo` 包裹的探针组件比较 props）。

**P2-5 目录选择器缺 `truncated` 提示、盘符 `aria-label`、`:disabled` 态与窄屏/动效适配**
- 现状：`DB` 从不读 `truncated`（A-087）、盘符按钮无 `aria-label`（A-104/A-213/B-303）、`showHiddenToggle`/`driveBtn` 无 `:disabled`（B-124/B-134）、无 `@media`（B-088/B-089）。
- 原始要求：A-087/A-102（`browser.truncated` 文案）、A-104「组件用 `drivesLabel !== 'browser.drives'` 判断『是否真的翻译到了』」、B-124/B-134 的 `:disabled` 两支、B-088/B-089 两个 `@media` 块。
- 最小修法：`DB` 在 `listing?.truncated === true` 时渲染 `.status` 行（配 `browser.truncated`）；盘符按钮加 `aria-label={drivesLabel !== 'browser.drives' ? drivesLabel : undefined}`；补 `:disabled` 两支与两个 `@media` 块。
- 需要补的断言：`truncated: true` 时出现 `browser.truncated` 文案节点；`:disabled` 时 `background` 无 hover 色（CSS 文本断言）；CSS 文本含 `@media (max-width:720px)` 与 `@media (prefers-reduced-motion:reduce)`。

**P2-6 选择器交互语义相对 0.1.6 大幅简化（沉淀成文档口径）**
- 现状：无 `readDraft`/`visibleEntries(filterPrefix)`/`select`(预扫子层)/`advance`/`cancelPathEdit`/焦点四标记/面包屑滚右（A-052–A-060、A-070–A-074、A-083、A-084、A-215–A-217、B-262）。
- 原始要求：B-262「与官方**逐条一致**的部分（保持官方交互语义）：Miller 双栏、`readDraft`/`visibleEntries`、`land`/`select`/`advance`/`cancelPathEdit`、焦点四标记、三个常量」；`04-client` §2.3/§2.1 同样把这些当契约。
- 最小修法：二选一——① 按 `04-client` §2 补齐（工作量大）；② 把 `04-client` §1.3/§2/§6 与 `00-overview` §1.3 中这些条目改成"未实现"，并在 README 声明「本组件是简化版 Miller 双栏」。**不允许**现状（文档承诺 ≥ 实现）。
- 需要补的断言：若走 ②，至少补「路径输入框输入前缀不触发网络」「卸载后无 in-flight setState 警告」两条；若走 ①，按 A-056/A-057/A-060/A-083/A-215 逐条补。

---

## 测试覆盖差距

> 现状：`tests/client/` 只有 `panel.test.ts` 一个文件、**4 个 describe / 10 个 `it()`**（carrier 3、locales 2、styles 1、transport 4），覆盖 `carrier`/`locales`/`styles`/`transport` 四个纯函数模块；**`surface`、`Composer`、`Card`、`DirectoryBrowser` 零测试**（本仓也无 DOM 环境，见 `tests/setup.mjs`）。

| # | 缺口 | 风险等级 | 建议断言（表驱动优先） |
|---|---|---|---|
| T-1 | `createInteractionSurface` 全无测试：`uiSession` 缺失 → `undefined`、`intervalMs` 硬下限、发布去重、两道 dispose 守卫、样式/locale/slot 的 dispose 顺序 | **P0** | 用假 `scope`（`get`/`slots`/`uiSession`）+ 假 `transport`，断言：① 返回 `undefined`；② 传 `intervalMs: 1000` 时实际排程间隔为 5000（可用假 timer 记录）；③ 两会话两条记录只发布 2 次、同会话 2 条只发布 `since` 最小的；④ `dispose()` 后 `transport.list` 再被调用一次也不再 `publish`（同 tick + await 后各一次）；⑤ `dispose` 调用了 `disposeSlot`/`disposeStyles`（可注入 spy 的 `pluginId`）。 |
| T-2 | `serviceOf` 的两级回退与异常路径 | **P0** | `get()` 抛错 + 属性为代理时仍能拿到；两者都缺时返回 `undefined` 不抛（对应 P0-1）。 |
| T-3 | `pollOnce` 的错误面与 `inFlight` | **P0** | `list` 拒绝 → 保留上一份、不摘卡；`list` 返回 `{items: undefined}` 不抛（对应 P0-4）；并发 `refresh()` 只发一次请求（对应 P1-2）。 |
| T-4 | `Composer` 的显式 `key`（唯一防「卡死」的承重墙） | **P0** | 浅渲染 `InteractionComposer` 并断言返回元素的 `key === 'question:q1'` / `'approval:a1'`；再断言「切到另一条交互时 key 不同」。（无 DOM 也能用 `react/jsx-runtime` 的 `jsx()` 产物断言，或引入 `react-dom/server`。） |
| T-5 | `DirectoryBrowser` 导航竞态与生命周期 | **P0** | ① 连续两次 `navigate` 只有最后一次 setState 生效（`requestSeq`）；② 父腿 200ms 未回先单栏、后到升级为双栏且**不重打目标腿**；③ 卸载/`open=false` 时 `abort` 被调用、`clearTimeout` 被调用；④ 无缓存时首屏目标为 `undefined`（对应 P0-3）；⑤ 父组件重渲染不触发新请求（对应 P0-2）。 |
| T-6 | `DirectoryBrowser` 的 props 契约 | P1 | `onCommit` 抛错 → 不调 `onOpen` 且 `error` 非空；`createError` 与 `error` 互不覆盖；`footerExtra` 渲染在「新建文件夹」右侧；`onPathChange` 在落地后被调用。 |
| T-7 | `Card` 的答案构造与跳过 | **P0** | `toAnswer`/`buildAnswers` 的口径（跳过 → `selected: []`；单选+自由文本 → `selected: []` + `custom`）；3 题流程点「跳过」时 `answers.length === questions.length`（对应 P1-5）；`busy` 时按钮 disabled。 |
| T-8 | `Card` 的可见文案与 ARIA | P1 | 选项容器/选项/feedback 的 `role`+`aria-checked`（对应 P1-7）；`header` 缺失时没有 eyebrow 文案；推荐徽标只在 label 含 `(Recommended)/(推荐)` 时出现（对应 P1-6）。 |
| T-9 | 文案字典完整性 | **P0** | `zh`/`en` key 集深度相等（已有）；新增一条：扫 `DB.tsx`/`Card.tsx` 里所有 `t('…')` 字面量，断言 ⊆ 字典 key 集（现在就**会红**：9 个 `browser.*` + `ix.*` 里 `ix.error.incomplete` 等未被引用，`ix.unavailable` 缺失）。 |
| T-10 | 样式契约 | P1 | 现有 3 条（前缀/无硬编码色/token）保留，补：`--dsw-elevation-stroke-color`、`--dsh-scrollbar-thumb`、`.magica-ix-min`、`@media` 两条（对应 P2-1/P2-5）；`DB.css` 也要有"无硬编码色 / 只 0.5px 发丝 / 无 dark-theme 选择器"三条（现在只测了 `panel/styles.ts`）。 |
| T-11 | `injectInteractionStyles` 的引用计数与 HMR 韧性 | P1 | 两次注入 + 一次释放后标签仍在、`refs === 1`；释放两次仍幂等；外部 `remove()` 后再注入会重新建标签（对应 P0-6）。需要 DOM 环境（`linkedom`/`happy-dom` 之一，或 `document` 最小 stub）。 |
| T-12 | `transport.unwrap` 的错误面 | P1 | 非 JSON 响应（HTML 404）→ 抛出含状态码的消息；`!response.ok` 但 body 是合法信封 → 仍按信封处理；`items` 缺字段 → `[]`（对应 P0-4）。 |
| T-13 | 与 host 的契约对账 | P1 | 用 `wire:106-111` 的路径常量断言 transport 实际请求 URL 与 `src/interactions/route.ts` 注册的 `interactionRoutes` 路径**同源**（表驱动，防 B-302 的漂移）。 |
| T-14 | `docs/design` 文档与代码的漂移守护 | P2 | 断言 `04-client` §1.1/§4.3/§5#12 提到的规模（892 行 / 50 规则 / 14 state / 17 ref / 焦点四标记）与源码实测一致；现在全部不一致（见 A-045/A-046/A-065–A-084、B-136）。要么改文档，要么改代码。 |



## 修复记录（Round 1–3）

| 项 | 改动 | 回归 |
|---|---|---|
| P0-1（serviceOf 属性回退无 try/catch） | 抽出 client/panel/services.ts，两条取用路径都包 try/catch | 	ests/client/panel.test.ts（3 例：get 抛+getter 抛 → undefined；回退；get 优先） |
| P0-2（DirectoryBrowser 请求风暴） | 
avigate 依赖改为 []，外部输入走 propsRef；首屏 effect 只依赖 open | 代码注释 + 真机闭环（无双扫） |
| P0-3（defaultTopLevel 返回 /） | 改为返回 string | undefined 并缓存；算不出时走空态（
avigate(undefined) 不扫描） | — |
| P0-4（rowser.* 字典缺失） | 9 个 rowser.* key 并入 zh/en | 	ests/client/panel.test.ts（键集 + 翻译值） |
| P0-5（pollOnce 形状容错） | 	ransport.list() 缺 items 返回 []；publish 失败走 debug 而非抛 | 同上（list 形状容错） |
| A-035/A-221（只认 tag 认领） | 已一致（carrier.ts 除 tag 还校验 key/kind/sessionId，更严） | — |
| 真机 bug #6/#7 | primitives 不再导出 Icon* → 自带 icons.tsx；slot 注册不接受 egistrant → 删除并 console.warn | 真机 UI 双闭环 |

### Round 8 修复记录（依据  5-conformance-client-triage.md）

> 裁定结论：61 条 ❌ 中 **A（必须补）30 / B（有意不做）19 / C（素材不可信）12**。本节只记录已执行的 A 项。

| 项 | 改动 | 回归 |
|---|---|---|
| P0-6 样式句柄缓存 / 缺 data-plugin-css | injectInteractionStyles 每次重新 getElementById、同时写 data-plugin + data-plugin-css，释放时也重新查 | 新增 	ests/client/styles-inject.test.ts（4 例，含 HMR 摘标签后重挂） |
| P1-1 摘卡按会话而非 kind:id | 抽出 client/panel/registry.ts（纯 TS）：published 以 kind:id 为键、同会话按 sessionId 去重、sync() 先摘后发；surface 改为复用 | 新增 	ests/client/registry.test.ts（7 例：key 形状、去重、换载体、精确摘、发布失败、clear 幂等） |
| P1-2 无在途互斥 | pollOnce 加 inFlight 守卫（定时器/回前台/efresh 三路并发只打一次） | 与 A-224 对齐；egistry 单测覆盖发布路径 |
| P1-3 主对话框 onClose 无守卫 | DirectoryBrowser 增加 equestClose()：usy/新建中/有草稿时拒绝关闭 | A-253 / B-006 |
| **A-210（新发现的功能缺口）** | 首次打开目录选择器是**纯白面板**：
avigate(undefined) 当"不扫描"。改为把 undefined 透传给 listDirectory（宿主 homedir 约定） | 代码注释 + 真机回归 |
| A-114/116/275 | 卡片眉标不再用 ix.recommended 兜底（每张无 header 的卡都写"推荐"）；新增 parseRecommended()：从标签剥离 (Recommended)/（推荐） 后单独渲染徽标，**答回宿主的仍是纯标签** | 新增 	ests/client/recommended.test.ts（5 例） |

### Round 9 修复记录（A 组 T2/T3/T4/T5/T8）

| 项 | 改动 | 回归 |
|---|---|---|
| T2（A-269/A-264） | 选项容器 ole={multiSelect ? 'group' : 'radiogroup'}、选项 ole={… 'checkbox' : 'radio'} + ria-checked；labels 改 useMemo([t]) 保持引用稳定（MarkdownText 按引用判断是否重解析） | 样式/结构断言 + 真机三闭环 |
| T3（A-224） | pollOnce 增加**世代守卫**：dropCarrier/应答后 generation += 1，wait list() 回来时世代不符则整份丢弃（卡片不再"复活一拍"）；配合 inFlight 互斥 | 与 egistry 单测共同覆盖发布路径 |
| T4（B-043/044/045/062/074/075） | 卡片与审批卡重绑 --dsw-elevation-stroke-color、--dsh-scrollbar-thumb、--dsh-scrollbar-thumb-hover | panel.test.ts：断言三个 token 名存在，且仍无硬编码色 |
| T5（A-059/060/083/087/102） | 两栏 ole="list"、行 ole="listitem" + ria-current、listing.truncated 时渲染 rowser.truncated 提示（ole="status"，新增 .status） | panel.test.ts：rowser.truncated 中英齐备且键集一致 |
| T8（B-161/162） | 自定义答案从 <input> 改为 <textarea rows={1}> + 输入时同步高度（esize:none、max-height:160px），保留 IME 守卫与 Enter 提交（Shift+Enter 换行） | panel.test.ts：断言 .magica-ix-input 含 esize:none 与 max-height |

### Round 10 修复记录（T6/T7 最小闭环/T9 收尾）

| 项 | 改动 | 回归 |
|---|---|---|
| T9 收尾 | 首屏扫描未返回/失败时渲染 rowser.empty（ole="status"），不再留纯白面板 | 	ests/client/filter.test.ts + 真机回归 |
| T6（A-084/A-215） | 新增 contentRef / pathInputRef / owFocusWant：落地后焦点回到选中行（锚点是上一轮的 ria-current="true"）；**正在编辑路径时不抢焦点**；仅当焦点还在 ody 上时才补焦点 | 代码注释 + 真机回归 |
| T7 最小闭环（A-055/A-081 部分） | 新增纯函数模块 directory-browser/filter.ts：	ailPrefixOf()（取最后一段）+ ilterEntries()（前缀过滤、隐藏项、**选中项始终保留**、大小写开关）；路径输入只做**当前列**过滤、不发任何网络请求；行上 **Enter 下降**进目录 | 新增 	ests/client/filter.test.ts（8 例） |
| T7 未做部分（登记） | 网络预览腿（逐级预取父/子列）、levelDirectory/draftDirectory 完整状态机在 0.2 明确**不做**：目录选择器的定位是"选一个目录"，实时预览会带来不必要的 eaddir 风暴（AGENTS.md §二.1 热路径约束），且宿主已用 listDirectory(path?) 提供缺省目录 | 已在  5-conformance-client-triage.md B/C 与本节登记 |
