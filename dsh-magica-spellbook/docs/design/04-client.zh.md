# 04 · 浏览器侧目录选择器设计（client / directory-browser）

> 一级模块：**client** → 二级模块 `directory-browser`。0.1.6 基线：`src/client/DirectoryBrowser.tsx` **892 行** + `DirectoryBrowser.module.css` **404 行** + `globals.d.ts` 14 行。
> 一句话问题：dsh 官方确实有一个目录浏览器（`packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx`，1 052 行），但它是 **slot occupant** —— 由 `apply()` 把 flow 注册进 ui-workspace 的两个 directory-flow 洞，**自己不导出裸组件**。想在**自己的设置面板里弹一个选路径的框**的插件没有可用入口。
> 所以本模块 = **从官方 fork 并加固的受控组件**：数据与语义全部由 props 注入，不占任何 slot。

---

## 1. 契约

### 1.1 Props（7 必填 + 3 可选）

```tsx
interface DirectoryBrowserProps {
  // 必填 7：纯浏览
  open: boolean
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  createDirectory: (path: string, name: string) => Promise<string>
  onOpen: (path: string) => void          // 选中路径回传
  onClose: () => void
  busy: boolean
  t: Translate

  // 可选 3：扩展点
  onCommit?: (path: string) => Promise<void> | void   // Open 提交前 hook（如创建 workspace）
  footerExtra?: ReactElement                           // footer 自定义槽（追加在 New-folder 右侧）
  onPathChange?: (path: string | null) => void         // 路径变更回调
}
```

转出的类型（re-export）：`DirectoryEntry = { name; path; hidden }`、`DirectoryListing = { path; home; crumbs; entries; truncated }`（**`truncated` 必填**）、`Translate = (key, params?) => string`。

### 1.2 后端契约（对 `listDirectory` 的要求）

| 要求 | 原因 |
|---|---|
| `crumbs` 是**从根到当前**的完整链 | 面包屑直接渲染它 |
| `entries` 按名排序 | 组件不再排（`visibleEntries` 只做 `hidden` 过滤） |
| `home` 是**宿主**的家目录 | 平台推断与首次落点都靠它（见 §3.2） |
| `truncated` 必填 | 只提示"未列全"，不做分页 |
| `signal` 必须被消费 | 新扫描 abort 旧的（INV-2） |

### 1.3 不变量（INV-1 ~ INV-6）

| # | 不变量 | 落地 |
|---|---|---|
| INV-1 | 目录选择器**不占任何 slot**，纯受控组件 | props 全注入 |
| INV-2 | 同一时刻只有**一个** `listDirectory` 扫描有效：新扫描 abort 旧的，`requestSeq` 守卫所有 `setState` | `supersede()` + `:349/:368/:416/:540` |
| INV-3 | 导航落地**不闪中间帧**：目标腿 + 父腿合成一次两栏落地；父腿 200 ms 未回则先落单栏，晚到的父腿**原地升级** | `PARENT_LEG_WAIT_MS = 200` |
| INV-4 | 所有副作用可逆：卸载/关闭时 abort 扫描、清掉"父级那一拍"计时器 | `useEffect` 清理 |
| INV-5 | 落点记忆是**模块级**而非 props：跨对话框开关存活，页面刷新重置 | `lastNavigatedPath` |
| INV-6 | Host 平台只能由 **Host 自己报的 `home` 路径**推断，绝不用 `navigator.platform` | `hostIsWindows` 推断 |

---

## 2. 状态机（Miller 双栏）

### 2.1 状态与 ref

| 类别 | 内容 |
|---|---|
| state（14） | `loading`、`error`、`createError`、`current`（listing）、`parent`（listing \| null）、`selected`（DirectoryEntry \| null）、`draftPath`（string \| null）、`draftPending`、`creatingFolder`、`folderDraft`（string \| null）、`showHidden`、`drives` 等 |
| ref（17） | `requestSeq`、`parentSeq`、`scanAbort`、`parentTimer`、`listDirectoryRef`、`showHiddenRef`、`focusFlags`（输入框/面包屑/文件夹行/底栏）等 |
| 模块级缓存（3） | `lastNavigatedPath`、`drivesCache`、`hostHomeCache` |

### 2.2 三条腿的落地

```
navigate(targetPath)
  ├─ 目标腿：listDirectory(targetPath)            → 落地 current
  └─ 父腿  ：listDirectory(dirname(targetPath))   → 落地 parent（可选）
      · 两个都回来 → 一次 setState 合成双栏落地（不闪中间帧）
      · 父腿 200ms 未回 → 先落单栏；晚到的父腿「原地升级」成双栏
```

| 常量 | 值 | 作用 |
|---|---|---|
| `PARENT_LEG_WAIT_MS` | `200` | 父腿兜底等待 |
| `SLOW_SCAN_DELAY_MS` | `300` | 超过才显示"加载中"（旧视图继续渲染） |
| `DRAFT_PREVIEW_DEBOUNCE_MS` | `250` | 路径编辑器草稿预览去抖 |
| `/cac/drives` 超时 | `5_000` | 盘符栏请求 |
| `transport` 超时（交互模块） | `10_000` | 不是本模块，列在此处便于对照 |

### 2.3 键盘与焦点时序

| 交互 | 行为 |
|---|---|
| `Enter` 进入选中目录 | `advance()` |
| `Backspace`/上级按钮 | 回父级 |
| 面包屑点击 | `navigate(crumb.path)` |
| 路径编辑铅笔 | 进入 `draftPath` 编辑态；`Enter` 提交、`Esc` 回退到 `lastNavigatedPath ?? defaultTopLevel()`（**不是**官方那样 `navigate()` 无参回 homedir） |
| 新建文件夹 | 第二个 `Modal`（`headless`），独立 `createError`（不与主视图 `error` 互相覆盖） |

**焦点四标记**：输入框 / 面包屑 / 文件夹行 / 底栏，靠 ref 标记避免"扫描回来抢走焦点"。

---

## 3. 平台推断与落点记忆

### 3.1 为什么不能用 `navigator.platform`

浏览器与宿主可能不同机（SSH 隧道、远程 dsh web、容器）。用浏览器平台判断会得到错误的默认顶层（`/` vs `C:\`）和错误的盘符栏。

### 3.2 推断方式

```
首次 listDirectory 返回 listing.home
  → hostHomeCache.set(home)
  → hostIsWindows = /^[A-Za-z]:\\/.test(home)
  → defaultTopLevel() = hostIsWindows ? 'C:\\' : '/'
```

**代价**：首次打开前无缓存 → 落在**宿主 homedir**；第二次起才到 `C:\` 或 `/`。这是可接受的（首次不跳盘符）。

### 3.3 落点记忆

`lastNavigatedPath` 是**模块级**变量：跨对话框开关存活，页面刷新重置。
- 打开时：`navigate(lastNavigatedPath ?? defaultTopLevel())`
- 每次成功落地后更新
- `Esc` 取消路径编辑也回到它

### 3.4 盘符栏（Windows 增强，官方无）

```
GET /cac/drives  (5s 超时, AbortController)
  → drivesCache（成功才缓存；失败不缓存 → 每次打开都会重打一个 404）
  → 盘符按钮四态：默认 / hover / disabled / active
```

⚠️ 已知：宿主没装对应插件时每次打开对话框都会打一个 404 请求（`drivesCache` 仍是 `null`）。本设计要求：失败也写一个 `{ failed: true, at }` 的短期缓存（如 60 s），避免每次重打。

---

## 4. 样式

### 4.1 14 个 token（去重后，全部 `--dsw-alias-*`）

| token | 用途 |
|---|---|
| `--dsw-alias-label-primary` | 标题、行名、输入文字、hover/active 文字 |
| `--dsw-alias-label-secondary` | 未选中行图标、状态行、"显示隐藏项"文字 |
| `--dsw-alias-label-tertiary` | 面包屑、箭头、编辑图标、盘符按钮 |
| `--dsw-alias-label-caption` | 禁用态、`::placeholder` |
| `--dsw-alias-border-l2` | 面包屑栏 hover/聚焦/编辑描边 |
| `--dsw-alias-border-l3` | header 下边线、footer 上边线、两栏发丝分隔、盘符栏下边线 |
| `--dsw-alias-border-l4` | 新建文件夹输入框描边 |
| `--dsw-alias-interactive-bg-hover` | 行 hover、盘符 hover |
| `--dsw-alias-interactive-bg-active` | 选中行、激活盘符（**带 `--dsw-alias-interactive-bg-hover` 兜底**） |
| `--dsw-alias-bg-layer-2` | 浮动"加载中"标签 |
| `--dsw-alias-button-info-fill` | 选中行文件夹图标（**唯一的品牌蓝强调**） |
| `--dsw-alias-state-error-primary` | 错误行 |
| `--dsw-alias-scrollbar-bg-l2` / `--dsw-alias-scrollbar-hover-l2` | 重绑 `--dsh-scrollbar-thumb` / `-hover` 间接层 |

### 4.2 两条非 aliased 的契约

| 属性 | 含义 |
|---|---|
| `--dsh-scrollbar-thumb` / `-hover` | 滚动条 thumb 的**间接层**：默认 `l1` 对，抬升面（菜单/浮层/对话框）在自己的容器上重绑 `l2` 对，靠继承传给真正滚动的后代 |
| `.dialog.dialog` **双写** | `Modal` 的 `className` 与它自己的 `css.dialog` 是 `clsx` 拼接的，两份样式都命中 `.dialog`，最终顺序取决于注入顺序（CSS Module 各自 hash，顺序不受控）。双写把特异度提到 `(0,2,0)`，稳定压过 `(0,1,0)`。这是官方同款技巧 |

### 4.3 规则规模

**50 条规则 / 229 条声明**。关键选择器（按作用分组）：

| 组 | 选择器 |
|---|---|
| 壳 | `.editorScope`（`display: contents`）、`.header`（`border-bottom: 0.5px`）、`.content`、`.footerBar`（`border-top: 0.5px`） |
| 面包屑 | `.crumbBar`（透明 1px 边 + radius 8）、`:has(.crumbEditZone:enabled:hover)/:has(:focus-visible)/:has(.pathInput)` → `border-l2`、`.crumbTrail`、`.crumbSeat`、`.crumb`（`max-width:160px` + ellipsis）、`.crumbChevron`、`.crumbEditZone`、`.crumbEditGlyph`、`.pathInput` |
| 双栏 | `.millerRow`（`flex:1 1 0; overflow-x:auto`）、`.column`（`min-width:256px`）、`.divider`（0.5px 发丝） |
| 行 | `.row`（28px 高 / radius 6）、`:hover`、`.rowSelected`（兜底链）、`.rowIcon`/`.rowIconSelected`、`.rowName`、`.rowChevron` |
| 状态 | `.status`、`.error`、`.loadingFloat`（`bg-layer-2`） |
| 底栏 | `.showHiddenToggle` 四态、`.footerGap`、`.footerAction`（`min-width:72px`） |
| 新建弹窗 | `.createDialog.createDialog`（双写，`width: min(380px,100%)`）、`.createInput`（44px 高 / radius 22 / 0.5px `border-l4`） |
| 盘符 | `.driveBtn` 四态 |

**主题纪律**：无硬编码色、无 `body[data-ds-dark-theme]` 选择器、发丝描边一律 `0.5px`。

---

## 5. 与官方实现的差异（12 项）

| # | 维度 | 官方 | 本模块 | 为什么 |
|---|---|---|---|---|
| 1 | 交付形态 | 包 + `apply()` 注册进 ui-workspace 的两个 directory-flow 洞 | 稳定子入口 `./directory-browser`，导出裸组件（raw TSX） | 官方组件不可直接 import（只能靠裸路径，升级风险自担） |
| 2 | 数据来源 | `inject` 工厂给 `listDirectory`/`createDirectory`/`t` | **全部走 props** | 嵌入式用法没有 ui-workspace 服务依赖 |
| 3 | `listDirectory` 类型 | `@deepseek-ai/dsh-api-remotes/client` | `@deepseek-ai/dsh-host-directory-picker/types` | 前者是 RPC 客户端包，会把整条 remotes 依赖拖进来；后者是纯类型 |
| 4 | className 拼接 | `clsx` | 内联 `cx` | 不为一个函数声明 peer dep |
| 5 | 首屏目标 | `navigate()` 无参 → 宿主 homedir | `lastNavigatedPath ?? defaultTopLevel()` | 落点记忆 + 平台顶层 |
| 6 | 取消路径编辑兜底 | `navigate()` | `lastNavigatedPath ?? defaultTopLevel()` | 同上 |
| 7 | 父腿兜底计时器 | `setTimeout(landSingle, 200)`，**从不 clearTimeout** | 计时器 id 存 ref，卸载/关闭时 clear | 组件卸载后仍会触发一次 → 副作用不可逆 |
| 8 | `listDirectory` 身份 | 直接进 `useCallback` 依赖 | **收进 ref** | 消费方几乎总传内联箭头；进依赖会让"渲染→effect→navigate→setState→重渲染"自持成请求循环（弹窗永远 loading） |
| 9 | 盘符栏 | 无 | `drivesCache` + `GET /cac/drives` + 盘符按钮 | Windows 多盘不必手打路径 |
| 10 | 扩展点 | 无 | `onCommit` / `footerExtra` / `onPathChange` | Open 前建 workspace、加自己的按钮、跟踪当前路径 |
| 11 | 新建文件夹失败显示 | 共享 `error` 行 | 独立 `createError` | 主视图错误与弹窗内错误不该互相覆盖 |
| 12 | 文件规模 | 1 052 行 | 892 行（+404 CSS） | 去掉 slot 装配、换成 props 注入、加三处增强 |

**保持与官方逐条一致的部分**（不要"优化"）：Miller 双栏、`readDraft` / `visibleEntries`、`land` / `select` / `advance` / `cancelPathEdit`、焦点四标记、三个计时常量。

---

## 6. 产物契约（raw TSX 子入口）

### 6.1 为什么这条入口必须是源码

`./directory-browser` 指向 `src/client/DirectoryBrowser.tsx`，由**消费方**的打包器编译。好处是可以用 CSS Modules（正常写法）；代价是消费方必须具备 `.tsx` + `.module.css` 管线。

### 6.2 消费方最小配置

```js
// esbuild 示例
await esbuild.build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true, format: 'cjs', platform: 'browser', outfile: 'lib/client.js',
  loader: { '.tsx': 'tsx', '.css': 'css' },
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
             '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
             '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
             '@deepseek-ai/dsh-client-ui-dockkit'],
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: `return module.exports; } });` },
})
```

CSS Modules 用 lightningcss 编译后在**工厂执行期**注入带 `data-plugin` 的 `<style>`（`HMR` 按 `data-plugin` 回收）。

### 6.3 已知代价（必须写进 README）

1. 消费方 typecheck 工程必须包含该 `.tsx`，否则跨包类型解析失败（0.1.6 遇到过 `dsh-client-ui-primitives` 的 `.d.ts` 与 `icons/index.tsx` 不匹配 → TS2724/TS2305）。
2. 消费方的打包器必须有 CSS Module loader。
3. `files` 必须含 `src/client`（该入口的产物不进 `lib/`）。

**备选（本设计要求提供）**：`./directory-browser-lib` 指向 `lib/client/directory-browser.js`（预编译 + 字符串注入样式），给"打包链没有 CSS 管线"的消费方用。两条入口共享同一份源码，样式策略由构建脚本切换。

---

## 7. 装配（消费方视角）

### 7.1 两种装法

| 能力 | 入口 | 谁渲染 | 参考 |
|---|---|---|---|
| 嵌入式选择器（自己的设置面板弹窗） | `./directory-browser`（raw TSX） | 消费方自己 `import` 并渲染 | 0.1.6 的 `dsh-better-browser` / `dsh-amazing-market` |
| 接管官方 directory-flow（替换 dsh 的选目录体验） | 消费方自己的 client `apply` 里 `slots.inject` | 消费方组件 | 需先 `disabled` 官方 `ui-directory-picker-browse` |

### 7.2 接管官方槽位时的 `cordis.patch.yml`

```yaml
# 1. 关掉官方「原生系统选择框」入口
- id: directory-picker
  disabled: true
# 2. 关掉官方 ui-directory-picker-browse 的 client 面
#    （它占同一个槽 + 同一个 directory-browser locale 命名空间，会撞）
- id: ui-directory-picker-browse
  disabled: true
- insert:
    - id: acme-directory              # 自己（含 client 半）
      name: '@acme/dsh-directory'
    - id: directory-picker-browse      # 借用官方 host 后端（list/createDirectory RPC）
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
```

三条规则：① 只 `insert` 不 `replace`；② 先 `disabled` 同槽/同命名空间的官方条目（directory-flow 是 `chain` 语义，官方那条不关就轮不到你）；③ host 后端可以只借用不实现。

### 7.3 client `apply` 骨架（两个洞 + generator inject）

```ts
export const inject = ['slots', 'uiWorkspace', 'locale', 'workspaces']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('directory-browser', { zh: zhDict, en: enDict }))
  const injected = () => ({
    listDirectory: (p, signal) => ctx.uiWorkspace.listDirectory(p, signal),
    createDirectory: (p, name) => ctx.uiWorkspace.createDirectory(p, name),
    t: ctx.locale.bind('directory-browser'),
  })
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', inject: injected }, BrowseFlow)
      yield ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow', inject: injected }, BrowseFlow)
    }))
}
```

要点：两个洞都要占（会话空态 + 侧栏工作区）；`inject` 是**函数**不是对象（挂载时求值才能拿到最新 `ctx`）；generator 写法让每次 `register` 的 dispose 由 slots 统一回收。

---

## 8. 失败模式与 0.2 适配

### 8.1 失败模式（10 条）

| # | 场景 | 表现 | 处理 | 残余风险 |
|---|---|---|---|---|
| 1 | 宿主无 `/cac/drives` | 盘符栏不出现 | 显式判 `r.ok` + `catch` 空吞 + 5 s 超时 | 每次打开打一个 404（本设计加短期失败缓存） |
| 2 | 浏览器与宿主平台不同 | 默认顶层正确 | 由宿主 `home` 推断 | 首次无缓存 → 落宿主 homedir |
| 3 | 大目录扫描慢 | 300 ms 后才显示"加载中" | `SLOW_SCAN_DELAY_MS` + 旧视图继续渲染 | 无分页；`truncated` 只提示 |
| 4 | 父级扫描卡住 | 200 ms 后先落单栏 | 计时器 | 晚到父腿会改写视图（原地升级），用户可能看到一次跳变 |
| 5 | 消费方每次渲染传新箭头函数 | 不会无限重扫 | ref 化 + 身份稳定 | 若 `t` 每次变，`targetName`/`crumbs` 会重算（仅性能） |
| 6 | 消费方忘 `dispose` | 卡片/样式残留 | 无法自愈 | 需在 `ctx.effect` 里收口 |
| 7 | 宿主进程重启 | 待决状态消失 | 内存态 | 消费方启动对账应把相关执行标失败 |
| 8 | 消费方没注册 `browser.*` 字典 | 文案显示 key 原文 | 组件靠 `drivesLabel !== 'browser.drives'` 判"是否真翻译到" | 改 key 名或 `t` 的 fallback 会让该判断失效 |
| 9 | 窄屏 | 不缩圆角、不减 padding | 官方有 `@media (max-width:720px)`，本模块未复刻 | **本设计要求补** |
| 10 | `prefers-reduced-motion` | 动画不关闭 | 官方有，本模块未复刻 | **本设计要求补** |

### 8.2 0.2 适配

| # | 项 | 处置 |
|---|---|---|
| 1 | `--dsw-alias-*` token | ✅ 0.2 仍在用（`packages/client/ui-theme/src/styles/design-platform.css`），14 个 token 全部有效 |
| 2 | `Button` 变体 | 只用 `primary` / `outline`，**显式写**不依赖默认值（0.2 新增 `toolbar`，默认档可能变） |
| 3 | `Modal` | `headless: true`（自绘 header/footer，只借 portal + 遮罩 + Escape + `aria-label`） |
| 4 | `MarkdownText` | 本模块**不用**（目录选择器无 Markdown）；但若将来加"目录说明"必须传 `labels` |
| 5 | `DirectoryListing` 类型来源 | `@deepseek-ai/dsh-host-directory-picker/types`（✅ 0.2 仍在） |
| 6 | `Translate` 类型来源 | 经 `@deepseek-ai/dsh-client-locale/client` 转出的 `@deepseek-ai/dsh-client-ui-slots` 的 `Translate` |
| 7 | 平台模块表新增 `dockkit` | 与本模块无关，但消费方的 externals 要跟着平台表走 |

---

## 9. 验收契约（12 条）

1. `open === false` 时返回 `null`（不挂载子树）。
2. 连续两次导航只有最后一次的 `setState` 生效（`requestSeq`）。
3. 卸载时旧扫描被 abort、父腿计时器被清。
4. 父腿 200 ms 未回 → 先落单栏；父腿后到 → 原地升级为双栏，**不重新请求目标腿**。
5. `lastNavigatedPath` 跨开关存活（同一页面会话内）。
6. `hostIsWindows` 由 `home` 推断（`C:\Users\x` → true，`/home/x` → false）。
7. `showHidden === false` 时 `visibleEntries` 过滤 `hidden`。
8. `onCommit` 存在时，"确认"先 `await onCommit(targetPath)` 再 `onClose`；`onCommit` 抛错则不关。
9. `footerExtra` 渲染在 New-folder 右侧。
10. `onPathChange` 在路径变更时被调用，且取消编辑时传 `null`。
11. `createError` 与 `error` 互不覆盖。
12. 样式里没有 `#fff` / `#000` / `rgba(` 字面量（`grep` 断言），也没有 `body[data-ds-dark-theme]`。
