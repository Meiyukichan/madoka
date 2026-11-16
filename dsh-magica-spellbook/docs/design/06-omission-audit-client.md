> 只读复核：未改源码/测试/依赖。行号口径 = `docs/raw/a.md`（实际 792 行）与 `docs/raw/b.md`（实际 840 行）；已排除 `05-conformance-client.md` 61 条 + `-triage.md` 的 A/B/C 裁定，以及"网络预览腿 / 0.1.6 样式层 / `browser.home` 重写"三项明确不做。

## 结论
- 真遗漏 **8** 条 / 已覆盖 **10** 条（抽样）/ 有意不做 **3** 条（另有 2 条"待人工确认"）
- 一句话：**是**——仍有 3 处用户可感知缺口：路径编辑一进去列表就空（N1）、错误与拒绝无读屏播报（N2/N4）、英文界面里审批标题是中文（N3）；其余为控制台噪声/公共 API/弱可见级。

## 真遗漏（按严重度）
| # | 原始要求（raw 行号 + 原文 ≤30 字） | 现实现（文件:行 + 现状） | 为什么算遗漏 | 最小修法 |
|---|---|---|---|---|
| N1 | a.md:176-186 `readDraft`：`directory` 等于当前层目录 → `tail` 是**其后缀**，a.md:181 此分支不重扫 | `filter.ts:26-29` 只取最后一个分隔符后的段；`DirectoryBrowser.tsx:367` 点铅笔把**完整路径**填进 draft、`:314-319` 用它过滤 | draft=`D:\p` 时 tail=`p`，右列 `startsWith('p')` 全不匹配 → **一进编辑态列表就空**（用户以为目录没了） | 加 `prefixWithin(dir, draft)`：draft 以 `dir+分隔符` 开头才取尾段，否则返回 `''`（跨目录不预览） |
| N2 | a.md:583-591 三标记 `refocusPathInput`/`refocusPick`/`refocusEditZone` 的**置位者与消费** | `DirectoryBrowser.tsx:150` 声明 `rowFocusWant`，`:253-264` 只读；全仓无 `rowFocusWant.current = true`，也无关闭后/编辑结束回焦 | Enter 落地 → 输入框卸载 → 焦点回 `body`；单栏时无 `aria-current` 行可落（`:434/457` 只在两栏/选中时挂），键盘用户从 Tab 头重来 | 提交式导航成功后置 `rowFocusWant.current = true`；单栏给 `listing.path` 行补 `aria-current` |
| N3 | a.md:788 `reason ?? escalation({toolName})` 的取值顺序（0.2 增 `displayReason`） | `Card.tsx:338` `displayReason?.['zh']` 硬编码；`wire.ts:64` 是 `Record<string,string>`，host 同时下发 en/zh（`tests/sessions/approval.test.ts:169`） | 英文界面审批标题/说明显示中文，用户可感知 | `displayReason?.[document.documentElement.lang] ?? displayReason?.['en'] ?? reason ?? toolName`（dsh locale 会写 `<html lang>`） |
| N4 | a.md:779 抄了「`role="status"` 的 feedback 位」 | `Card.tsx:292`、`:362` 的 `.magica-ix-feedback` 无 `role`/`aria-live`（T2 只补了选项 ARIA，此条被误记"已做"） | 读屏用户提交/放弃/审批后**零反馈**；应答失败静默 | 两处加 `role="status"`（可加 `aria-live="polite"`） |
| N5 | a.md:319/365 `variant?: 'takeover' \| 'plain'` 决定卡片外壳 | `Card.tsx:35` 声明、`:369-376` 解构时**不取** variant；恒渲染 `magica-ix-frame`/`magica-ix-apprroot`（`:157`、`:341`） | 公开 API 静默无效；a.md:311 明列"看板弹窗/详情内联"用 `plain`，会带上 composer inset 外壳 | `variant==='plain'` 时不渲染那两个外壳 div |
| N6 | a.md:223-224 父腿是目标腿**成功后** `continueScan` 才有的事（原文无孤儿 promise） | `DirectoryBrowser.tsx:188-191` 两腿并发创建；`:214` 仅成功分支 `await parentLeg`；`:230-235` catch 只管目标腿 | 目标腿失败或 seq 过期（`:195` 提前 return）→ `parentLeg` 的 rejection 无人接 → 控制台 `Uncaught (in promise)` | `parentLeg.catch(() => null)`；或在过期/失败分支 `abort()` |
| N7 | a.md:171 `defaultTopLevel` 每次由 `hostHomeCache` 派生（b.md:592 第二次起落 `C:\`） | `DirectoryBrowser.tsx:80-107` `topLevelCache` 只算一次；首次打开时 home 未知 → 永久缓存 `null` | 文档承诺的"第二次起落在盘/根"永不发生（退化为宿主 homedir，弱可见） | 缓存改由 `hostHomeCache` 派生，或写 home 时清 `topLevelCache` |
| N8 | b.md:17 #7 `Modal` 焦点契约（dsh `useModalLayer`："React autoFocus 早于本层捕获触发控件"） | `DirectoryBrowser.tsx:520` 新建输入框用 React `autoFocus`，未用 `data-modal-autofocus` | 关新建弹窗后 `previous`（该输入）已卸载 → 焦点落到 dialog 容器而非"新建文件夹"按钮，Tab 顺序重来 | `:520` 改 `data-modal-autofocus`（`:388` 路径输入是后挂的一次性焦点，保留 `autoFocus`） |

## 已覆盖核对（抽样 10 条，证明没瞎报）
| 原始要求（对应你问的编号） | 实现位置 |
|---|---|
| ① a.md:294-304 `globals.d.ts` 两份 ambient 声明 | `directory-browser/globals.d.ts:1-13` 已等价（`*.module.css` + `__DSH_BOOT__`）；`__DSH_BOOT__` 与 a.md:303 一样**无人读**，故不需要"类似声明"以外的东西（其 `locale` 字段正是 N3 的顺手修法） |
| ② a.md:570-581 盘符/落点记忆 | `DirectoryBrowser.tsx:77-79` 三个模块级缓存、`:244` 读落点、`:197` 写落点；a.md:591 的"失败不缓存"已被 `:69,271,287` 的 60s TTL 修掉（优于原文） |
| ④ a.md:603-627 一条载体 + 标签过滤 + 不抢卡 | `surface.ts:84` `precedence=()=>1`（同 a.md:188）、`:192-195` `isInteractionCarrier(owner.pendingInteraction)`、`registry.ts:23-30` 按 `sessionId` 取最早、`surface.ts:86` delegate=`Promise.resolve()` |
| ⑤ a.md:629-641 节流/可见性/销毁 | `surface.ts:124` 在途互斥、`:126/138` 世代守卫、`:212-217` visibilitychange + 回前台补拍、`:136` await 后 guard（原文也只靠 guard、不 abort；隐藏期定时器空转一拍无网络，可接受） |
| ⑥ b.md:9-36 26 处 props | `DirectoryBrowser.tsx:360/506`（Modal 两处 open/onClose/title/className/headless 全给）、`:492/495/529/532`、`Card.tsx:276-289/355-359`、`:197` MarkdownText（text+labels+`variant`）、图标 12/14/16 三档逐处齐 —— **未发现比原文少的 props** |
| ⑦ b.md:403-436 导出全表 | `panel/index.ts` 覆盖 28 条声明导出，仅 `install/releaseInteractionRuntime` 不外露（同 b.md:539-547）；`./directory-browser` 走 `package.json` 子路径 raw TSX（同 b.md:421）—— **无缺项**，多出的是 `makeTranslate`/`INTERACTION_LOCALE_NS` |
| ⑧ b.md:570-583 §8.2 结构差异 | 草稿改组件内 `useState` → 仅"换交互"时丢，且 `Composer.tsx:23` 的 key 会让实例重建，无额外功能后果；纯文本 `args`、plan-review 已在 triage B-296/§8.2 登记 |
| ⑨ b.md:596 `uiSession` 不可用 | `surface.ts:77` 返回 `undefined`（同 a.md:468）；会话页静默但看板可用，属已知限制而非遗漏 |
| a.md:206-214 / §9 IME 风险 | `DirectoryBrowser.tsx:395,524` 与 `Card.tsx:263`（`isComposing \|\| keyCode===229`）均已闭合 |
| b.md:591 `/cac/drives` 每次打 404 | `DirectoryBrowser.tsx:278` 显式 `r.ok`、`:287` 失败缓存 60s —— 该风险已闭合 |

## 有意不做（附理由）
- a.md:181/224 的路径**预览腿**（逐级预取父/子列 + 250ms 去抖重扫）：`filter.ts:1-8` 与 triage T7 已留档，改走"只过滤当前列"，符合 AGENTS.md §二.1。
- 0.1.6 样式层（`editorScope`/`crumbEditZone`/`millerRow`/`.magica-ix-min` 等）：triage B 组 19 条，当前形态无可见后果。
- `browser.home` 面包屑重写：`a.md:266` 的键只服务该重写，triage A-052/A-092 已定不做。
- 待人工确认（不计入 N）：① `/cac/drives` 返回格式是 dsh-minecraft 私有 → `DirectoryBrowser.tsx:410` 直接把字符串当 label，无法验证；② POSIX 时 a.md:578 会补一个 `/` 按钮，当前 `:401` 直接不渲染。
