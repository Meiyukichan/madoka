# 05-client · 61 条 ❌ 缺失的三分类裁定（A 必补 / B 有意不做 / C 素材不可信）

> 性质：**只读裁定**。未改源码、未跑测试、未装依赖；除本文件外未写任何文件。
> 输入：`docs/design/05-conformance-client.md`（61 条 ❌）+ 当前源码（`src/client/panel/*`、`src/client/directory-browser/*`）+ 决策上下文（`00-overview.zh.md` §3.5/§3.7/§3.8/§3.9、`04-client.zh.md`）+ 0.2 主题 token 实况（`deepseek-harness/packages/client/ui-theme/src/styles/*`）。
> 口径：**每条都以当前代码复核过**，不采用核对表里的行号（Round 1–3 修复后 `DirectoryBrowser.tsx` 整体下移约 21 行，`styles.ts` 移 2 行，本文引用的是**现状行号**）。核对表末尾「修复记录」里已落地的修复，若与某条 ❌ 直接冲突，该条归 C（素材已过期），并给出反证行号。
> 判定标准：**A** = 0.2 下仍成立、且用户可感知的功能/契约（含无障碍、信息缺失、可见文案错误）；**B** = 0.1.6 特有的实现形态，或随「不做的那一层」一起放弃、当前缺失无可见后果；**C** = 素材引用已删除/不存在的东西、自相矛盾、或其实只是 0.1.6 的实现细节。

---

## 1. 结论（10 行）

1. **A 30 条 / B 19 条 / C 12 条**（合计 61；核对表的 ⚠️ 156 条不在本次裁定范围）。
2. A 按工作量：**小 18、中 4、大 8**；大工作量全部是同一块——目录选择器「路径草稿预览 + 键盘下降」层（A-044/054/055/056/058/072/077/081）。
3. A 里**没有一条落在接管主链路上**：`composer` key、`sessionId` 去重、5s 下限、两道 dispose 守卫、waterfall 抢占都成立，与真机三闭环一致。
4. A 的可见缺陷集中在三处：**首次打开目录选择器是空白面板**（A-210，`navigate(undefined)` 短路且无提示）、卡片**推荐徽标/eyebrow 误用**（A-114/116/275）、轮询**在途响应复活卡片**（A-224）。
5. A 的无障碍缺口成组出现：卡片选项 ARIA（A-269）＋目录两栏 `role=list`/`aria-current`（A-059/A-060），后者还是焦点恢复的锚点（`a.md:185-187`）。
6. B 的主体是「简化版 Miller 双栏」的结构/样式层（B-092/097/098/103–106/111/140/167）与 0.1.6 的失焦/防丢守卫（A-062/216/217）。
7. C 含 **3 条已被代码反证**：A-199（`transport.ts:75`）、B-316/B-334（`locales.ts:36-44` + `panel.test.ts:158-184`）。
8. C 含 **1 条素材自相矛盾**：B-130 要求 `.createIn`，而同一素材 `a.md:282` 明写组件从未使用该 key，核对表自己把 A-105 判为 ✅。
9. C 含 **3 条同源**：A-093/A-213/B-303 都是 `drivesLabel !== 'browser.drives'` 这个「字典漏注册探测 hack」，字典随包后探测条件失效。
10. 收尾判断：**还剩用户可感知的功能缺口**，但样式/结构类几乎全在 B/C；剩下的实质缺口只有三处——目录选择器首屏空白（A-210，一行改）＋键盘/预览层（T7，需中等改造或改文档口径）＋卡片推荐徽标（T1）。

---

## 2. 逐条裁定（61 条）

| ID | 原差异摘要 | 裁定 | 理由（≤40 字，引现状行号/决策条款） | 收尾动作 |
|---|---|---|---|---|
| A-044 | 无 `ScannedDirectory` / 已确认扫描目录记忆 | A | 预览层整块缺失；`04-client` §2.2/§5 列为须复用契约 | 并入 T7 |
| A-048 | 无 `cx()` 辅助，模板串拼 className | C | 模板串等价（`DB:394/415/434`）；§5#4 只要求不用 `clsx` | 删条，登记 |
| A-052 | 面包屑不重写 home、不本地化 | B | `04-client` §1.2：`crumbs` 由宿主给全链，直接渲染（`DB:344-349`） | 贴回核对表 |
| A-053 | 无 `separatorOf` | C | 分隔符在 `parentPathOf`/`joinPath` 内联判定（`DB:108-122`），无错路径 | 删条 |
| A-054 | 无 `levelDirectory` | A | 预览层缺失，勾选只能手打全路径 | 并入 T7 |
| A-055 | 无 `draftDirectory` | A | 同上 | 并入 T7 |
| A-056 | 无 `readDraft`（tail 命中当前列） | A | 输入前缀不能过滤当前列（`DB:295` 只做 hidden 过滤） | 并入 T7 |
| A-058 | 无 tail 判定，无「只过滤、不打网络」路径 | A | 同 A-056，用户可见 | 并入 T7 |
| A-059 | 无 `LevelColumn`、无 `role=list/listitem` | A | 两栏无列表语义（`DB:384-429`）；`a.md:185` 明列 | T5 |
| A-060 | 行无 `aria-current` | A | 选中只靠 class（`DB:415`），且焦点恢复靠它 | T5（T6 依赖） |
| A-062 | 无 `pathEditing` 的 `onMouseDown` 守卫 | B | 编辑态只由 Esc/Enter 结束（`DB:358-364`），无 blur 可丢 | 贴回核对表 |
| A-063 | 行无 `disabled` | B | `pick()` 在 await 前已锁 `targetPath`（`DB:296-308`），可点不致错提交 | 贴回核对表 |
| A-072 | 无 `previewDraftLevel` | A | 预览层缺失 | 并入 T7 |
| A-077 | 无 `viewRef` | A | 随预览去抖 effect 一起补 | 并入 T7 |
| A-081 | 无 250ms 草稿去抖 | A | `04-client` §2.2 的 `DRAFT_PREVIEW_DEBOUNCE_MS` 无实现（`DB:62-68`） | 并入 T7 |
| A-083 | 面包屑不滚右、行不滚右列 | A | `crumbBar` 有 `overflow-x:auto`（`DB.css:59`）但无 `scrollIntoView` | T5 |
| A-084 | 无焦点三标记恢复 effect | A | 只有 `autoFocus`（`DB:356/477`），导航后焦点落 body | T6 |
| A-087 | `truncated` 从不读取 | A | 列表被截断却无提示（`DB:41` 字段无人消费） | T5 |
| A-092 | `browser.home` 从未使用 | B | 随 A-052 一并不做（`a.md:266` 的键只服务 home 重写） | 贴回核对表 |
| A-093 | `browser.drives` 未使用 | C | 该键只服务 aria-label 探测（`a.md:280`）；按钮文本即访问名 | 删条 |
| A-096 | `browser.untitledFolder` 未使用 | B | 空串 + placeholder 已达同一意图（`DB:443/478`） | 贴回核对表 |
| A-102 | `browser.truncated` 未使用 | A | 与 A-087 同一缺口，需补 zh/en 键（`locales.ts:36-44`） | T5 |
| A-114 | 无 `RECOMMENDED` 正则 / `parseRecommended` | A | 推荐后缀不拆，且 eyebrow 误用它（`Card:156`） | T1 |
| A-116 | 无 `parseRecommended`（答案值仍原样 ✅） | A | 同 A-114，只缺显示侧 | T1 |
| A-163 | 无 `ix.unavailable`，runtime 未时就绪即 `null` | B | runtime 在槽位注册前已装（`surface:179` 早于 `:185`），分支不可达 | 贴回核对表 |
| A-199 | `list` 不吞缺 `items` | C | 已修：`transport.ts:75` `Array.isArray` 兜底 + 测试 `:148-155` | 删条 |
| A-210 | 无缓存时不走宿主 homedir | A | 返回值已改对，但 `DB:167-177` 把 `undefined` 当「不扫描」→ 首屏空白且无提示 | T9 |
| A-213 | 无 `drivesLabel` / `aria-label` 判定 | C | 字典已随包（`locales:36-44`），探测 hack 失效 | 删条 |
| A-215 | 无三标记消费顺序 | A | 同 A-084 | T6 |
| A-216 | 无 `editorScope` / `onBlur` 守卫 | B | 无 onBlur 关闭逻辑，编辑态不丢输入（`DB:353-365`） | 贴回核对表 |
| A-217 | 三处 `onMouseDown preventDefault` 全无 | B | 同 A-216（无 blur 关闭即无需防） | 贴回核对表 |
| A-224 | 无 `inFlight` 互斥 | A | 在途 `list` 晚到会重发布已摘卡片（`surface:137-149` 无世代守卫） | T3 |
| A-264 | `labels` 每渲染新建对象 | A | `MarkdownText` 按引用判缓存（`MarkdownText.tsx:191`），每次重解析 | T2 |
| A-269 | 选项/反馈无 ARIA | A | 裸 `button`（`Card:199-223`），读屏无法判选 | T2 |
| A-275 | 无 `parseRecommended`（徽标也不渲染） | A | `.magica-ix-badge` 无人渲染（`styles:44`）；同 A-114 | T1 |
| B-043 | 无 `--dsw-alias-scrollbar-bg-l2` 重绑 | A | token 0.2 仍在（`scrollbar.css:11-19`），对话框未抬升 | T4 |
| B-044 | 无 `scrollbar-hover-l2` 重绑 | A | 同 B-043 | T4 |
| B-045 | `.dialog` 未重绑 `--dsh-scrollbar-thumb` | A | 抬升面（`DB.css:3-14`）缺间接层，列滚动条仍用 l1 对 | T4 |
| B-062 | 卡片未重绑 `--dsw-elevation-stroke-color` | A | token 仍在（`design-platform.css:186/304`）；深色缺一层分离（`styles:22`） | T4 |
| B-074 | 卡片未重绑 `--dsh-scrollbar-thumb` | A | 卡内滚动条与面板不一致（`styles:22`） | T4 |
| B-075 | 审批卡未重绑 `-hover` | A | 同 B-074（`styles:58`） | T4 |
| B-092 | 无 `.editorScope` | B | `display:contents` 无视觉；高亮已由 `.crumbBar:has()` 承担（`DB.css:62-65`） | 贴回核对表 |
| B-097 | 无 `.millerRow` | B | 只有两栏，不需要横向 Miller 容器（`DB:384-429`） | 贴回核对表 |
| B-098 | 无 `.crumbTrail` | B | 面包屑直排在可滚动的 `.crumbBar`（`DB.css:51-60`） | 贴回核对表 |
| B-103 | 无 `.crumbEditZone` | B | 铅笔改 `.iconButton` + 独立 `.pathInput`（`DB:332-339/353`） | 贴回核对表 |
| B-104 | 无 `.crumbEditGlyph` | B | 同 B-103 | 贴回核对表 |
| B-105 | 无编辑区 hover 转色 | B | 同 B-103 | 贴回核对表 |
| B-106 | 无 `:disabled` 两支 | B | 编辑区无禁用态（无 `crumbEditZone`） | 贴回核对表 |
| B-111 | 无 `.rowSeat` | B | 行内直接三子元素，无座位层（`DB:391-404`） | 贴回核对表 |
| B-130 | 无 `.createIn`（「在 X 中新建」这行） | C | 与素材自相矛盾：`a.md:282` 明写组件从未用该 key | 删条 |
| B-140 | 无 `.magica-ix-min` | B | 最小化不渲染 body（`Card:185`），`max-height` 无副作用 | 贴回核对表 |
| B-153 | 复选框无 `::before` 伪元素 | C | 边框直画在 `.check` 上（`styles:39`），渲染等价 | 删条 |
| B-161 | 无 `.magica-ix-field` / `.field>*` | A | 自定义答案单行（`Card:229`），长答案看不全 | T8 |
| B-162 | 无 `.magica-ix-mirror` 自增高 | A | 同 B-161（自增高靠镜像层） | T8 |
| B-167 | 无 `.magica-ix-pager` | B | progress 直接进 footer，无包裹层（`Card:245-248`） | 贴回核对表 |
| B-248 | 「2 条 `export type` 转出 3 个符号」不成立 | C | 类型本地声明直接导出（`DB:29-45`），0.2 无该文件 | 删条 |
| B-254 | 既无 `clsx` 也无 `cx` | C | 同 A-048，纯拼法差异 | 删条 |
| B-296 | 无 `plan-review` 分流落点 | B | `00-overview` §3.9 登记未做；intent 已用于徽标/approve（`Card:158/197`） | 贴回核对表 |
| B-303 | 无 `browser.drives` / 无 `drivesLabel` 判定 | C | 同 A-213 | 删条 |
| B-316 | 全仓无 `browser.*` 字典 | C | 已修：`locales.ts:36-44` 九个键 + `panel.test.ts:171-177` | 删条 |
| B-334 | 同 B-316（文案是 key 原文无解） | C | 同上 | 删条 |

---

## A 组执行清单

> 9 个小任务，全部只碰 `src/client/`。**工作量对应**：小 18 = T1(3) + T2(2) + T3(1) + T4(6) + T5(5) + T9(1)；中 4 = T6(2) + T8(2)；大 8 = T7(8)。
> 测试环境现状：`tests/` 是 `node:test`、**无 DOM**（`tests/setup.mjs` 只隔离 `DSH_HOME`）；需要 DOM 的断言用 `react-dom/server` 的 `renderToStaticMarkup`（`react-dom` 目前不在 devDependencies，要么加，要么改用 `react/jsx-runtime` 的 `jsx()` 产物断言）；`surface.ts` 因 `import Composer.tsx` 在 Node 里不可 import，照 `services.ts` 的抽法先抽纯逻辑。

**T1 · 推荐徽标 + eyebrow 误用（A-114 / A-116 / A-275）**
- 文件：`panel/Card.tsx`；复用 `styles.ts:44` 的 `.magica-ix-badge`。
- 改：新增 `RECOMMENDED = /\s*[（(]\s*(Recommended|推荐)\s*[)）]\s*$/i` 与 `parseRecommended(label) => { text, recommended }`；`Card:156` 的 `question.header ?? t('ix.recommended')` 改成 `question.header ?? ''`，空则整行 `eyebrow` 不渲染；选项显示走 `parseRecommended`，命中时在 `magica-ix-label` 内加 `<span className="magica-ix-badge">`。
- 铁律：`toggle(option.label)` / `toAnswer` 仍用**原始 label**，只改显示。
- 断言：`header` 缺失 → DOM 无 eyebrow 文本；label `"Allow (Recommended)"` → 可见 `Allow` + 徽标，提交 `selected` 仍含原串；`"推荐"` 中文后缀同样命中。

**T2 · 卡片选项 ARIA + `labels` 记忆（A-269 / A-264）**
- 文件：`panel/Card.tsx`。
- 改：`Card:193` 选项容器 `role={multiSelect ? 'group' : 'radiogroup'}`；`Card:199-209` 每个选项 `role={multiSelect ? 'checkbox' : 'radio'}` + `aria-checked={on}` + `aria-label={option.label}`；`Card:266` feedback 加 `role="status"`。
- 改：`Card:148` 的 `labels` 用 `useMemo(() => ({...}), [t])`（`useMemo` 已在 `Card:9` 导入），保持引用稳定。
- 断言：`role="radio"` 数 == 选项数；选中项 `aria-checked="true"`；报错时存在 `role="status"` 节点且文本等于 `t('ix.error.unanswered')`；同一 `t` 下两次渲染的 `labels` 引用相等（探针组件比较 props）。

**T3 · 轮询在途守卫（A-224）**
- 文件：`panel/surface.ts`（`pollOnce` 137-149、`schedule` 151-158、`refresh` 221-223）。
- 改：`let inFlight = false`（入口判、`finally` 复位）；另加 `let generation = 0`，`dropCarrier` / 应答成功时 `generation += 1`，`await list()` 之后比对世代，不等则整份丢弃。
- 为何必须两者都有：`inFlight` 只防并发；卡片复活是「应答后的旧响应重发布」（`surface:124-128` 按 `sessionId` 补发）。
- 断言：并发两次 `refresh()` 只发 1 次 `fetch`；`answerQuestion` 成功后旧的在途响应不 `publish`（需先把 `pollOnce` 的判定抽成纯函数或注入假 `transport`/假 `uiSession`）。

**T4 · 六处 token 重绑（B-043 / B-044 / B-045 / B-062 / B-074 / B-075）**
- 文件：`panel/styles.ts:22`（card）、`panel/styles.ts:58`（appr）、`directory-browser/DirectoryBrowser.module.css` 的 `.dialog.dialog`。
- 改：卡片加 `--dsw-elevation-stroke-color:var(--dsw-alias-border-l2-darkmode-thin)`、`--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)`、`--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)`；审批卡加后两条；`.dialog` 加后两条（抬升面）。
- 断言：`INTERACTION_STYLES` 含上述属性名；`DB.css` 文本含 `--dsh-scrollbar-thumb`；现有「无硬编码色 / 无 `data-ds-dark-theme`」断言保持绿。

**T5 · 目录两栏 a11y + 截断提示 + 面包屑滚右（A-059 / A-060 / A-083 / A-087 / A-102）**
- 文件：`DirectoryBrowser.tsx`、`DirectoryBrowser.module.css`（新增 `.status`）、`panel/locales.ts`（+`browser.truncated` zh/en，键集必须同步）。
- 改：两栏容器 `role="list"`、行 `role="listitem"`；行加 `aria-current={selected?.path === entry.path ? 'true' : undefined}`；`listing?.truncated === true` 时在 `.content` 上方渲染 `.status` 行用 `t('browser.truncated')`；`.crumbBar` 加 ref，落地后 `scrollLeft = scrollWidth`。
- 断言：`truncated:true` 出现文案节点、`false` 不出现；选中行 `aria-current="true"`；`role="listitem"` 数 == 行数；`DB.css` 含 `.status`；`zh`/`en` 键集仍深度相等。

**T6 · 焦点恢复（A-084 / A-215）**
- 文件：`DirectoryBrowser.tsx`（`DB:130-151` state/ref 区、`DB:195-231` 落地分支、`DB:353-366` 路径输入）。
- 改：加 `focusWant = useRef<'input' | 'crumb' | 'row' | 'footer' | null>`，编辑/落地/关闭各分支写标记；落地 effect 按标记聚焦（`row` 分支用 `button[aria-current="true"]`，与 T5 的 `aria-current` 配套），取代裸 `autoFocus`。
- 断言：首帧焦点在路径输入；一次 `navigate` 落地后 `document.activeElement !== document.body`；编辑态期间扫描回包不抢走输入框焦点（T5 的 `aria-current` 已能定位行）。

**T7 · 路径草稿预览 + 键盘下降（A-044 / A-054 / A-055 / A-056 / A-058 / A-072 / A-077 / A-081）**
- 文件：`DirectoryBrowser.tsx`（主要）、`DirectoryBrowser.module.css`（`.field`/`.mirror` 若与 T8 共用）。
- 改：补 `levelDirectory`/`draftDirectory`/`readDraft(listing, draft, scanned)`/`visibleEntries(entries, selectedPath, showHidden, filterPrefix)`（`a.md:177-180` 口径：选中项永远保留、`.` 前缀放开隐藏项）；`draft` 变化 250ms 去抖后 `previewDraftLevel`；同时补 `advance()`（行上 Enter 进入目录、Backspace 回父级）——这是当前唯一的键盘下降缺口。
- 工作量：大（新状态机 + 3 个纯函数 + 分支落点），建议只做「tail 命中当前列过滤 + advance」的最小闭环，跳过网络预览腿。
- 断言：路径输入框输入前缀不触发 `listDirectory`；`visibleEntries` 表驱动（含选中项保留 / 前缀 / 隐藏项）；行上 Enter 会 `navigate` 到该目录；250ms 内连打不重复预览。

**T8 · 自定义答案自增高（B-161 / B-162）**
- 文件：`panel/Card.tsx:227-242`、`panel/styles.ts`。
- 改：`<input>` 换 `<textarea rows={1}>` + 隐藏 mirror（`.magica-ix-field` 的 grid 两层 + `.magica-ix-mirror`），保留现有 IME 守卫（`Card:236-239`）与 Enter 行为。
- 断言：长文本输入后 `scrollHeight <= clientHeight`（自增高生效）；`INTERACTION_STYLES` 含 `.magica-ix-field`/`.magica-ix-mirror`；`.magica-ix-block` 的 `min-height:64px`。

**T9 · 首屏回退到宿主 homedir（A-210）**
- 文件：`DirectoryBrowser.tsx`（`DB:100-106`、`DB:164-177`、`DB:244-247`）。
- 改：`navigate` 的 `undefined` 分支不再短路，改为照常扫描但**不带参数**（`listDirectoryRef.current(undefined, signal)`），把「缺省目录」交给宿主（`04-client` §3.2 的 homedir 约定）；父腿同样跳过。
- 兜底：该扫描失败时保留现有 `.error`，并在 `listing === null && !loading` 时渲染一行空态提示（复用 `browser.loading` 旁的 `.status`，见 T5），不要留纯白面板。
- 断言：`hostHomeCache` 为空时首屏 `listDirectory` 被调用且第一参为 `undefined`；成功后渲染出条目；失败时出现提示文案而非空白。

---

## B/C 组登记（贴回核对表用）

**B（19 条，有意不做）**

- **A-052**｜面包屑不做 home 重写/本地化：`04-client` §1.2 已定「`crumbs` 由宿主给全链，面包屑直接渲染」，重写会把宿主路径显示名改错。
- **A-062**｜无 `pathEditing` 的 `onMouseDown preventDefault`：编辑态只由 Esc/Enter 结束（`DB:358-364`），没有 blur 关闭，也就不存在「点按钮丢编辑态」需要防。
- **A-063**｜列表行不加 `disabled`：`pick()` 在 `await onCommit` 之前已把 `targetPath` 锁进闭包（`DB:296-308`），提交中切视图不会错提交；禁用行反而让界面假死。**注**：`DB:329` 的 `onClose={props.onClose}` 无守卫仍是真缺陷（核对表 P1-3，不在本 61 条内），请单独修。
- **A-092**｜`browser.home` 不使用：与 A-052 同源，该键只服务 home 重写。
- **A-096**｜新建文件夹输入框不预填 `browser.untitledFolder`：空串 + `placeholder`（`DB:443/478`）已达同一意图，预填在重名时反而误导。
- **A-163**｜不补 `ix.unavailable`：`surface.ts:179` 在槽位注册（`:185`）之前就装了 runtime，`Composer:20` 的 `runtime === undefined` 分支在受支持装法下不可达。
- **A-216**｜无 `editorScope` / `onBlur` 守卫：当前没有 blur 关闭逻辑，编辑态更稳；加了反而引入「点铅笔就丢输入」的窗口。
- **A-217**｜三处 `onMouseDown preventDefault`：同 A-216。
- **B-092**｜`.editorScope{display:contents}`：无视觉作用，编辑区高亮已由 `.crumbBar:has(.pathInput)`（`DB.css:62-65`）承担。
- **B-097**｜`.millerRow`：本组件只有目标层 + 父层两栏，无第三列，不需要横向滚动容器（`DB:384-429`）。
- **B-098**｜`.crumbTrail`：面包屑直排在 `.crumbBar` 内并可横向滚动（`DB.css:51-60`），多一层 trail 无收益。
- **B-103**｜`.crumbEditZone`：铅笔走 `.iconButton`、路径编辑走独立 `.pathInput`（`DB:332-339/353`），形态不同，0.2 不复刻 crumb 内联编辑器。
- **B-104**｜`.crumbEditGlyph`：同 B-103。
- **B-105**｜编辑区 hover 转色：同 B-103（无该元素）。
- **B-106**｜`.crumbEditZone:disabled` 两支：同 B-103（无该元素，无禁用态）。
- **B-111**｜`.rowSeat`：行内直接 `图标 + 名称 + 箭头`（`DB:391-404`），无座位层。
- **B-140**｜`.magica-ix-min`：最小化时不渲染 body（`Card:185`），只剩 header，`max-height:min(60vh,520px)` 无副作用；`padding-bottom` 只差 14px 视觉。
- **B-167**｜`.magica-ix-pager`：进度直接作为 footer 左槽（`Card:245-248`），无包裹层需求。
- **B-296**｜无 `plan-review` 三分支分流：`00-overview` §3.9「plan-review 意图分流 ⏳ 未做」已登记；当前已消费 `intent` 做徽标与 approve 选项标注（`Card:158/197`），不阻塞流程。

**C（12 条，素材不可信/已过期）**

- **A-048**｜无 `cx()`：模板串等价，`04-client` §5#4 的决策只是「不为一个函数加 peer dep」，不要求存在 `cx`。
- **A-053**｜无 `separatorOf`：分隔符在 `parentPathOf`/`joinPath` 内联判定（`DB:108-122`），Windows/POSIX 两种前缀都覆盖，无错误路径。
- **A-093**｜`browser.drives` 未使用：该键只服务 `aria-label`（`a.md:280-281`），盘符按钮文本 `C:\` 本身就是访问名，不挂 `aria-label` 不是缺陷。
- **A-199**｜`list` 不吞缺 `items`：**已修**——`transport.ts:75` `Array.isArray(value.items) ? value.items : []`，回归见 `panel.test.ts:148-155`。
- **A-213**｜无 `drivesLabel !== 'browser.drives'` 判定：这是 0.1.6 为「消费方漏注册字典」设计的探测 hack；0.2 字典随包发布（`locales.ts:36-44`），探测前提消失。
- **B-130**｜无 `.createIn`：**素材自相矛盾**——`a.md:282` 明写「`browser.createIn` 由 better-browser 注册，但本组件当前版本未使用」，核对表自己又把 A-105「`browser.createIn` 未使用」判为 ✅；该 CSS 规则在 0.1.6 也是死规则。
- **B-153**｜复选框无 `::before`：边框直接画在 `.check` 上（`styles:39`），`::before` 只是 0.1.6 的绘制手法，渲染等价。
- **B-248**｜「2 条 `export type` 转出 3 个符号」：0.2 无 `interactions/types.ts`，类型在 `DB:29-45` 本地声明并直接导出，该条描述的实现前提已不存在。
- **B-254**｜既无 `clsx` 也无 `cx`：同 A-048，纯 className 拼法。
- **B-303**｜无 `browser.drives` / `drivesLabel` 判定：同 A-213。
- **B-316**｜全仓无 `browser.*` 字典：**已修**——`locales.ts:36-44` 收录 9 个在用键（`browser.truncated` 仍缺，见 A-102/T5），键集与取值回归见 `panel.test.ts:158-184`。
- **B-334**｜同 B-316。

## 执行结果（Round 8–10）

| 任务 | 状态 | 落点 |
|---|---|---|
| T1 推荐徽标 + eyebrow 误用 | ✅ 已做 | panel/recommended.ts + Card.tsx；	ests/client/recommended.test.ts（5 例） |
| T2 选项 ARIA + labels 记忆 | ✅ 已做 | Card.tsx（ole/ria-checked/useMemo([t])） |
| T3 轮询在途 + 世代守卫 | ✅ 已做 | surface.ts（inFlight + generation） |
| T4 六处 token 重绑 | ✅ 已做 | panel/styles.ts（卡片 + 审批卡） |
| T5 两栏 a11y + 截断提示 | ✅ 已做 | DirectoryBrowser.tsx、rowser.truncated、.status |
| T6 焦点恢复 | ✅ 已做 | DirectoryBrowser.tsx（contentRef/pathInputRef/owFocusWant） |
| T8 自定义答案自增高 | ✅ 已做 | Card.tsx（	extarea + 高度同步）+ 样式断言 |
| T9 首屏回退宿主 homedir | ✅ 已做 | DirectoryBrowser.tsx（undefined 透传 + 空态 rowser.empty） |
| T7 路径预览 + 键盘下降 | ⚠️ **部分**（2/8） | 已做：ilter.ts 的 	ailPrefixOf/ilterEntries（当前列前缀过滤、选中项保留）+ 行上 Enter 下降 + 8 例单测 |
| T7 剩余 6 条（A-044/054/056/058/072/077） | ⛔ 明确不做（改判 B） | 网络预览腿（逐级预取父/子列、完整 levelDirectory 状态机）会引入 eaddir 风暴，违反 AGENTS.md §二.1 热路径约束；目录选择器定位是"选一个目录"，宿主已用 listDirectory(path?) 提供缺省目录。已在  5-conformance-client.md Round 10 记录登记 |

**结论**：A 组 30 条中 **24 条已修**，6 条（T7 的网络预览腿）改判为"有意不做"并留档；B 组 19 条、C 组 12 条按本文档 §B/C 登记执行（不采纳理由已逐条写明）。
