# 重点事项

- **用中文回答**
- **新代码一律面向 `0.2.0-rc.2` 的 DSH**；本地源码：`D:\project-code\llm\deepseek-harness`（下文路径都相对它）。
- 本仓另有 0.1.2 线（`@meiyukichan/dsh-index`）：**只维护，不复用其代码、类型和 API 记忆** 。
- 写插件前先查源码中同类官方实现，对齐 API、命名与返回结构；**不要照抄 0.1.2 时代的代码**（本文件末尾列了常见漂移）。
- 项目下所有子包采用pnpm构建 (pnpm-workspace.yaml)，版本统一从0.2.0-alpha.1开始，最后lib/只有两个文件：index.js/client.js【压缩源码】。*.js.map 禁止进入 lib/
- 要有tests单元测试

## 一、包结构与构建产物

1. **产物统一 `lib/`**：`main: "lib/index.js"`、`types: "lib/types/index.d.ts"`、client bundle `lib/client.js`；`exports` 暴露 `.`、`./client`、`./package.json`（需要插件展示元信息时加 `./locale/*.json`）。`files` 必须覆盖所有相对运行时 import 与产物，不出现 `dist/` 或独立 `client/` 目录。

2. **`package.json` 的 `dsh` 声明**：

   ```json
   "dsh": {
     "bundle": { "patch": "./cordis.patch.yml" },
     "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings"] }
   }
   ```

   - `dsh.client` 必须同时导出 `./client`，否则 Host 扫描直接报错；`platform` 固定 `"web"`。
   - `dsh.client.inject` 是**包名依赖边**（启动图排序、HMR diff），**不是 Cordis 服务注入**。服务依赖写 `export const inject = ['slots', 'locale', ...]`。
   - `dsh.client.external` 只供基础设施/传输/生成装配声明非基线模块请求；功能插件不得靠它获取另一个插件的运行时值（构建期 purity gate 会拒绝跨插件值导入）。
   - `immediately: true` 仅用于必须在 shell 启动前注册 factory 的一阶段预取行，普通插件不要加。

3. **`cordis.patch.yml` 用 `insert` 挂行**（`id` + `name`），`name` 必须与 `package.json` 的 `name` 完全相同：

   ```yaml
   - insert:
       - id: acme-panel
         name: '@acme/dsh-panel'
         config:
           port: !!js ctx.acmeStartup.port ?? 3000
   ```

   - 行支持 `inject`、`config`、`disabled`、`!!js` 表达式；`dsh plugin add <pkg>` 会把声明了 `dsh.bundle` 的包追加进 profile 的 bundle 列表。
   - 后应用的层按行胜出，**patch 整体替换目标行的 `config`（不深合并）**：覆盖已有行时重述全部键。
   - **只有 bare 包名那一行会挂载 `./client`**；`pkg/subpath` 行只有 host 半侧。需要独立生命周期的页面/插件应拆成独立包，而不是靠子路径行。

4. **client bundle 是 lazy-CJS 闭包工厂**：`format: "cjs"`、`platform: "browser"`、`outDir: "lib"`、`entryFileNames: "client.js"`，banner/intro/footer 三段齐全：

   ```js
   window.__ModuleLoader__.load({ id: "@acme/dsh-panel", factory: (require) => {
   var module = { exports: {} }; var exports = module.exports;
   /* bundle body */
   return module.exports; } });
   ```

   - externals 只允许模块表里的 specifier：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`（清单源：`packages/client/web/src/platform.ts`）。其余依赖必须打进 bundle，不能留裸 import。
   - 代码分割的 chunk 必须编译成 `require.async("./client.<name>.js")`，注册时带 `chunk` 字段；chunk 不得同步 require 兄弟 chunk。
   - 官方 `clientBundle` 预设**不在任何已发布包里**（`packages/client/tsdown.client.ts`），仓库外必须自己复刻这套产物契约。
   - CSS：模块 CSS 经 lightningcss 编译后**在工厂执行期**注入带 `data-plugin` 的 `<style>`，模块系统在卸载/HMR 时按插件回收；不要在组件 render 里 append `<style>`。全局样式可用 `?inline` 取文本，再用 `ctx.effect` 管理标签生命周期。
   - 保留 sourcemap（Host 从 `/plugins/<包名>/client.js.map` 提供），构建时替换 `process.env.NODE_ENV` / `import.meta.env.MODE`，产物默认 production。
   - Host 服务的是**构建产物** `lib/client.js`：改完源码必须重新构建对应包再验证，源码不会被直接执行。

5. **依赖与版本兼容**：需要与宿主共享实例的 dsh 包（cordis、dsh-llm、dsh-settings、dsh-tools 等）**同时**写 `peerDependencies` 与 `devDependencies`；范围必须覆盖当前运行时（如 `>=0.2.0-rc.2` / `^0.2.0-rc.2`）。0.2 在 profile 组合期会对 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peer 做 semver 校验（含 prerelease）：不满足的插件行会被**直接禁用**，安装也会被拒绝，只能用 `dsh plugin allow-version` 做逐版本显式豁免（`packages/boot/app-boot/src/plugin-compatibility.ts`）。`engines.dsh` 只是声明性字段，没有读取方，写它不产生任何保护。react、ui-primitives、ui-slots、client-store 等基线模块由 shell 模块表注入，只放 `devDependencies` 供类型检查。

## 二、运行时安全（host 侧）

1. **禁热路径同步阻塞**（危害 = 单次耗时 × 频率）：
   - 🔴 真热路径 + 重 I/O 必改异步：`readdirSync` 遍历大目录、`rmSync(recursive)`、大文件读写。
   - 🟡 热路径 + 轻 I/O：首选**缓存**（启动读一次 + 文件变更失效），而非机械改 async。
   - 🟢 原子写 `writeFileSync(tmp) + renameSync` 保留同步，保证文件完整性。
   - 冷路径（启动、登录、安装）可暂缓；同步死循环绝对禁止。

2. **禁未捕获异常 / 未处理 reject**：所有可能抛错的路径必须 `try/catch` 或 `.catch()`；HTTP handler 先 `if (!res.headersSent)` 再写错误响应。未处理 reject 会让 fiber 出错，甚至中断 web 进程或致 profile 启动失败（fail-loud）。

3. **副作用必须可逆**：service / event / slot / 定时器 / `<style>` 都必须可 dispose，并统一收口到 `ctx.effect(() => { ... return dispose }, 'label')`。**例外**：用 `process.env.NODE_TLS_REJECT_UNAUTHORIZED='0'` 对接企业内网自签证书（IDaaS / InferHub 等）不视为 P0，但推荐改用限定作用域的 `https.Agent({ rejectUnauthorized: false })`。

4. **可选 service 用 `ctx.get('xxx')` 并处理 `undefined`；硬依赖才 `inject: ['xxx']`**。不得访问未声明 inject 的 service 属性。

5. **不要自建长连接**：dsh 的长连接（Gateway 的 WebSocket mux、HMR 的 SSE）归 shell 所有；插件再开 SSE/WebSocket 会在路由卸载后留下无法回收的连接。插件事件走：
   - Typert Remote 方法 + 前端短轮询（间隔 ≥5s，设「任务完成 / 达上限 / 组件卸载」终止条件，定时器归 `ctx.effect` 回收）；或
   - `ctx.remote.$on(event, listener)` 订阅 shell 已转发的既有事件（仅限 `API_REMOTE_FORWARDED_EVENTS` 白名单，插件不能自行扩充）。

6. **限制并发，别占满 libuv 线程池**：单 Node 进程只有 4 个线程池槽，占满后所有 HTTP handler 排队。出站 fetch 带超时（`AbortSignal.timeout`）；批量读盘限并发（2~4），不无上限并发。

7. **HTTP 路由**：`ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler })` 返回 disposer，重复 `(kind, path)` 直接抛错；handler 直接持有 `ServerResponse`。服务器会把抛错请求记 400，但**自定义错误响应仍要自己 try/catch + `headersSent` 守卫**。

## 三、Host 端 API（0.2 现状）

- **插件形态**：导出 `name` / `inject` / `apply(ctx, config)` / `Config`。依赖未就绪时 fiber 停在 PENDING；`apply` 抛错进 FAILED；通过 `ctx` 做的注册随 fiber 卸载自动回收。
- **工具**：默认用 `defineTool`（`@deepseek-ai/dsh-tools`）声明 name/description/parameters/output/execute，再 `ctx.tools.register(...)`；参数校验、超时、并行与展示模式由工具表统一处理。只有对接外部 JSON Schema 时才直接注册裸 schema，并自行负责输入校验。自定义卡片在 client 侧注册 `tool.call.toolview`（按 tool 名 keyed）。
- **配置**：需要设置页即时编辑的字段声明为 `Volatile<T>` + `.volatile()`，操作开始时读 `.get()`，并监听 `loader/volatile-update`；敏感值用 `role('secret')` 或凭据引用。schema 表达不了的跨字段约束在 `apply` 或写入路径自行校验并抛错（本版本 schemastery 3.18.4 **没有** `.check()`，cookbook 里的写法在源码中不存在）。
- **服务**：需要对外提供能力时 `ctx.provide(name, impl)`（或用 `Service` 基类）；消费方按第 2 节第 4 条取用。跨插件通信只走 Cordis service / event，不走模块级全局或直接 import 对方实现。
- **Remote / RPC**：Host 方法经 Typert 生成 `/remote` 产物，client 通过 `ctx.remote.<namespace>` 调用、`ctx.remote.$on` 订阅。生成物之外的跨包值导入同样被 purity gate 拒绝。
- **缓存**：反复读取的小配置做「启动读一次 + 失效重读」，不要每次请求都 stat/read 盘。

## 四、前端（client 半侧）

1. **入口与依赖**：`src/client/index.ts` 导出 `apply`（可 async）、`inject`（Cordis 服务名）、可选 `Config`。只导出 loader 需要的值，组件/工具函数/常量保持内部（跨包只能 `import type`）。组件永不接触 `ctx`：数据与回调通过 slot 的派生 props（`PropsRuntime` / `PropsRenderSlots` / `PropsStore` / inject face / `PropsLocale`）进入。

2. **Slot 模型**（详见 `docs/subsystems/slots.zh.md`）：
   - 父组件在自己的 `register({ children })` 里**声明并授权** child slot；向别人的 slot 贡献内容用 `ctx.slots.inject(key, () => ctx.slots.register(...))`，不要裸 `register` 到未声明 slot（激活即失败）。
   - `register` 选项：`name`、list 用 `id`/`order`/`label`、keyed 用 `key`、chain 用 `select`/`priority`（单值遮蔽用 `priority`），以及 `children`、`store`、`inject`、`locale`。
   - 常用扩展点：`settings.general.item`（单行偏好）、`settings.section`（整页设置）、`settings.plugins.tab`（Plugins 页标签）、`plugins.detail.actions` / `plugins.detail.badge` / `plugins.detail.section`（插件详情页）、`sidebar.footer.action` / `sidebar.panellist`、`conversation.session.header.actions` / `conversation.chat.assistant-actions` / `conversation.input.left` / `conversation.input.right`、`tool.call.toolview`（自定义工具卡，按 tool 名 keyed）、`shell.overlay`（全局浮层）。完整树以 `docs/subsystems/slots.zh.md` 与实时 `Slots.listSubTree` 为准。
   - 组件只通过框架钩子拿实时数据：`useSession` / `useSessions` / `useWorkspaces` / `useStore` / `props.actions.*` / `t`。不要在业务组件里 `useSyncExternalStore` 或自己订阅外部快照；共享视图状态用 `defineStore`（`@deepseek-ai/dsh-client-store`）声明 store，跨 entry/重挂载由框架持有实例。
   - 只渲染 `session` / `session-maybe` scope 的 slot 才有 `sessionId`、`useConversation`、`useChat` 等标准 props；需要可复用的整套装配才用 `ctx.slots.registerFactory`。

   ```tsx
   import type { Context } from '@deepseek-ai/cordis'
   import type {} from '@deepseek-ai/dsh-client-ui-renderer/client' // 合并 ctx.slots
   import type {} from '@deepseek-ai/dsh-client-locale/client'      // 合并 ctx.locale
   import { defineStore } from '@deepseek-ai/dsh-client-store'

   declare module '@deepseek-ai/dsh-client-ui-slots' {
     interface LocaleNamespaceMap { 'acme.panel': 'title' | 'empty' }
   }

   export const inject = ['slots', 'locale']

   const createAcmeStore = () => defineStore({
     init: () => ({ open: false }),
     actions: { setOpen: (d, open: boolean) => { d.open = open } },
   })

   export function apply(ctx: Context): void {
     ctx.effect(() => ctx.locale.register('acme.panel', {
       zh: { title: '面板', empty: '暂无数据' },
       en: { title: 'Panel', empty: 'No data' },
     }))
     ctx.slots.inject('settings.general.item', () => ctx.slots.register({
       name: 'settings.general.item', id: 'acme', order: 100,
       store: createAcmeStore(), locale: 'acme.panel',
     }, AcmeRow))
   }
   ```

3. **UI 组件**：UI 一律用 `@deepseek-ai/dsh-client-ui-primitives`（基线 external，直接 import；不要 import 其他功能插件的组件）。先查组件目录 `packages/client/ui-primitives/README.md#component-catalog`：`Button` / `Input` / `Switch` / `Checkbox` / `SegmentedControl` / `SegmentedTabs` / `Pill` / `Tag` / `Modal` / `Menu` / `MenuItemButton` / `MenuSurface` / `Tooltip` / `HoverCard` / `Toast` / `RiskConfirmation` / `ImageLightbox` / `JsonTree` / `PathLabel` / `StateDot` / `DisclosureRow` / `TextShimmer`，以及工具输出卡 `TerminalBlock` / `ReadBlock` / `DiffBlock` / `SearchBlock` / `WebBlock`。菜单类必须用 `Menu` / `MenuSurface`（保持主题的透明材质与模糊）。

4. **Markdown**：文本页面优先官方 `MarkdownText`，不自造渲染器。0.2 的 `labels` **必填**（`{ code: { copyLabel, copiedLabel }, footnotes }`），另有 `variant: 'body' | 'compact'`、`fileMentions`、`pathImages`；链接/本地文件点击由最近的 `MarkdownDelegateProvider`（同包）提供，没有 provider 时本地链接保持纯文本。设置页优先用 `SettingsForm` + `SettingsValueField` / `SettingsSecretField` + `SettingsFormModel`。

5. **国际化**：`inject` 含 `'locale'`；在模块里 `declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { ... } }` 给命名空间加类型；`ctx.locale.register(ns, { zh, en })` 两份字典键集必须一致（在 `ctx.effect` 里注册以便卸载回收），`ctx.locale.bind(ns)` 取稳定 `t`，`ctx.locale.resolveText(LocalizedText)` 解析包元信息。slot 注册声明 `locale: ns` 后组件直接拿到 `t`，**不要**在组件里自行订阅 locale。外部语言包用 `ctx.locale.addLanguage({ id, label, fallback })` + `register(ns, lang, dict)`。所有可见文案走 `t()`；插件在 Plugins 页的显示名/描述用 `locale/en.json`、`locale/zh.json` 的 `meta.title` / `meta.description`（`package.json` 的 `icon` 为相对路径图片，≤256 KiB），并导出 `./locale/*.json`。

6. **主题与样式**：
   - 颜色只用 `--dsw-alias-*` 语义 token，不硬编码 `#fff`/`#000`/`rgba(...)`（完全透明与 shiki 固定色除外）；不在功能 CSS 写 `body[data-ds-dark-theme]`（浅深覆盖归 ui-theme）。
   - 常用 token：文字 `--dsw-alias-label-primary/secondary/tertiary/caption`；背景 `--dsw-alias-bg-base/layer-1/2/3/overlay`；边框 `--dsw-alias-border-l1~l4`（中性边框/分隔线用 0.5px）；交互 `--dsw-alias-interactive-bg-hover/active`、`--dsw-alias-button-primary-fill/hover`；状态 `--dsw-alias-state-success/warn/error/idle-primary`（dsh 用 error，不叫 danger）；链接 `--dsw-alias-link`；浮层 `--dsw-elevation-panel/prominent/soft` + `--dsw-menu-surface-fill`；品牌 `--dsw-alias-brand-primary`；圆角见 `base.css` 的 `--dsw-radius-*`；焦点环 `--dsw-focus-ring-color/width`。
   - 组件样式用 **CSS Modules + `clsx`**，不引入组件库或 Tailwind；token 完整清单以 `packages/client/ui-theme/src/styles/*.css`（`design-platform.css` 为主）为准，不存在的 token 名在深色下会失效。

## 五、源码与文档索引

1. **本地 DSH 源码**：`D:\project-code\llm\deepseek-harness`（`0.2.0-rc.2`，tag `dsh-v0.2.0-rc.2`）。找不到本地源码时才 `where dsh`（Windows）/ `which dsh` 读已装产物。
2. **权威文档**（相对源码根）：
   - client 栈规则：`packages/client/AGENTS.md`
   - slot 模型与实时树：`docs/subsystems/slots.zh.md`
   - 样式与 token：`docs/web-styling.zh.md`、`packages/client/ui-theme/src/styles/`
   - 组件目录：`packages/client/ui-primitives/README.md#component-catalog`
   - 客户端模块/产物契约：`packages/client/modules/README.md`
   - 打包安装、配置、设置卡片：`docs/user/develop/basic/publish.zh.md`、`docs/user/develop/basic/config.zh.md`、`docs/cookbook/adding-a-settings-card.zh.md`、`docs/cookbook/adding-a-package.zh.md`
   - Web 服务器与 Remote：`docs/subsystems/web-server.zh.md`、`docs/subsystems/typert.zh.md`
   - 工具：`packages/core/tools/README.md`
3. **实时核对**：会话里有 `cordis_inspect_*` 工具时优先用它——Host 侧查 `Service` / `Event` / `Config`，Client 侧查 `Slots.listSubTree`（精确 slot 的 cardinality、scope、owner props、现有 occupant）、`Theme.listTokens`（当前真实 token 名）、`Service.listService`。源码与运行时不符时，以运行时为准并记录差异。
4. **本仓 SDK**：0.2 线是 `dsh-magica-spellbook`（SDK 文档目标位 `docs/spellbook/`，落地后优先 import，不自造）；`@meiyukichan/dsh-index` 是 0.1.2 线，只可参考工程形态。

## 六、0.1.2 → 0.2 常见漂移（照抄旧代码必踩）

| 0.1.2 写法 / 旧文档说法 | 0.2.0-rc.2 正确做法 |
|---|---|
| `dsh.client.inject: ["locale"]` 当服务注入 | 服务依赖写 Cordis `export const inject = ['locale', ...]`；`dsh.client.inject` 只写包名 |
| 组件里 `useSyncExternalStore(locale.subscribe, locale.getSnapshot)` | slot 注册声明 `locale: ns` 拿 `t`，或在 `apply` 里 `ctx.locale.bind(ns)` 后作 prop 传入 |
| `MessageText`、`OnboardingSurface`、单数 `ReferenceIcon` | 已移除/改名：用 `MarkdownText`；图标用 `ReferenceIconRegular` / `ReferenceIconMedium` |
| `<MarkdownText text streaming labels?>` 省略 labels | `labels` 必填：`{ code: { copyLabel, copiedLabel }, footnotes }`；另有 `variant` / `pathImages` / `fileMentions` |
| Host Config schema `.i18n({ zh, en })` | 全仓无此调用约定；配置说明用 `description()`，展示名走 `locale/*.json`，界面文案走 locale 服务 |
| 跨插件 `import` 组件 / 服务类 | 只允许 `import type`（声明合并）；运行时走 Cordis service 或 slot |
| `dsh.client.external` 当依赖声明用 | 仅基础设施模块请求可用；功能插件用 service / slot 协作 |
| 认为 `engines.dsh` 会拦住不兼容版本 | 只是声明性字段，无读取方强制 |

## 七、禁止事项

- 禁止擅自 `npm publish` 发布包。
- 不要擅自修改 `package.json` 的 `version`。
- 禁止擅自修改 `~/.dsh/profiles/web` 下的配置。
- 禁止安装插件测试，这个由开发者进行。
- 禁止创建 SSE/WebSocket 长连接作为插件事件通道（见第二节第 5 条）。
