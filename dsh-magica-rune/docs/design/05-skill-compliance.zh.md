# 05 · 对照 `dsh-plugins-principles` 的合规审查

审查基准：本包内置的 skill `resources/dsh-plugins-principles/SKILL.md`
（面向 DSH `0.2.0-rc.2` 的插件硬性规则）。逐条给出结论、证据位置，以及**为什么**偏离。

结论：**7 类规则全部通过**；审查过程中发现并修掉 2 个真实问题；另有 3 处有意偏差（均有理由）。

---

## 一、工程要求（SKILL §1）

| 规则 | 结论 | 证据 |
|---|---|---|
| 1.1 产物只在 `lib/`，且只有 `index.js` / `client.js`（类型在 `lib/types`），**`*.js.map` 不得进入 `lib/`** | ✅ | `lib/` = `index.js`、`client.js`、`types/`；`scripts/build.mjs` 构建后扫描并删除 `*.js.map`；`tests/artifacts.test.ts` 把这条钉成回归测试 |
| 1.2 `dsh.bundle.patch` 指向 `cordis.patch.yml`；`exports` 暴露 `.`/`./client`/`./package.json`/`./locale/*.json`；`type: module`；`files` 覆盖所有运行时相对 import 与产物 | ✅ | `package.json`；`files` 含 `lib`/`cordis.patch.yml`/`locale`/**`resources`**（内置 skill 的正文在 `resources/`，由 `lib/index.js` 以 `../resources/...` 读取，必须随包） |
| 1.2 `platform: "web"`；声明 `dsh.client` 就必须有 `./client` 导出 | ✅ | 两者同处 `package.json` |
| 1.2 `dsh.client.inject` 只写**包名**（不是服务名） | ✅ | `dsh-api-remotes`/`dsh-client-connection`/`dsh-client-locale`/`dsh-client-ui-settings`；服务依赖写在 Cordis `export const inject` |
| 1.2 不用 `dsh.client.external`、不加 `immediately` | ✅ | 均未声明 |
| 1.3 共享实例的 dsh 包**同时**写 `peerDependencies` 与 `devDependencies`，范围覆盖运行时 | ⚠️ **偏差** | 见 §四-1 |
| 1.4 `cordis.patch.yml` 用 `insert`；`name` 必须与 `package.json.name` 完全一致 | ✅ | 两侧都是 `dsh-magica-rune`；`id` 同时是 settings 命名空间 |
| 1.5 client bundle 是闭包工厂，banner/intro/footer 三段齐全；externals 只允许基线模块表内 + `dsh.client.external` 声明项 | ✅ | `lib/client.js` 首行 `window.__ModuleLoader__.load({ id: "dsh-magica-rune", factory: (require) => {`，末行 `return module.exports; } });`；实际 external 仅 4 个：`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-primitives`，全在表内；无裸 import；无 chunk；无 sourcemap |

## 二、运行时安全（SKILL §2）

| 规则 | 结论 | 证据 |
|---|---|---|
| 2.1 热路径不得同步阻塞；🟡 热路径 + 轻 I/O 首选**缓存** | ✅（**审查中修掉 1 处**） | `builtin-skill.ts` 的 `list()` 原先每次 `existsSync`+`readdirSync`+`readFileSync`，而 `list()` 会在每次 skill snapshot 时被调用。现改为**缓存候选行**（只有名字/描述），`get()` 仍每次读盘（正文要「改了立刻生效」），`control.invalidate` / abort 时失效重扫。宿主其余路径无同步 I/O（`grep readdirSync/readFileSync/statSync` 只剩这 3 处，全已缓存或只在 `get()` 里） |
| 2.2 不得有未捕获异常 / 未处理 reject；HTTP handler 先判 `headersSent` | ✅（**审查中修掉 1 处**） | `restrict.ts` 的 `system-prompt/assemble` 中间件原先没有兜底：上游 `next()` 的异常应继续冒泡（那是 assemble 链的事），但**我们自己的段落过滤**必须有 catch。已加 try/catch + `Array.isArray(result?.sections)` 守卫。其余 10 处 `ctx.on` 监听器与 `catalog.ts` 的 HTTP handler 均已有 try/catch + `headersSent` 守卫 |
| 2.3 副作用必须可逆，统一收口 `ctx.effect` | ✅ | 11 个挂载点全部经 `ctx.effect`；`<style>` 在模块工厂期注入并带 `data-plugin`，由模块系统回收；导航图标返回完整 disposer（断开 observer、摘标记、删 `<style>`） |
| 2.4 可选服务用 `ctx.get` 并判 undefined；硬依赖才 `inject` | ✅ | `inject = ['tools','webServer','systemPrompt']`；`settings`/`skills`/`workspaceRegistry`/`agents` 一律 `ctx.get` + 判空 |
| 2.5 不得自建 SSE/WebSocket 长连接 | ✅ | 零长连接；只订阅 shell 已转发的 `settings/document-updated`（`ctx.remote.$on`），无自建轮询 |
| 2.6 限制并发，别占满 libuv 线程池；出站要带超时 | ✅ | `catalog.ts` 的两次 `skills.snapshot` 是串行 `await`，且都带 `AbortSignal.timeout(2000)`；无无上限并发 |

## 三、源码一致性（SKILL §3）

| 规则 | 结论 | 证据 |
|---|---|---|
| 3.1 先读官方同类实现，对齐 API/命名/返回形状 | ✅ | `docs/design/01-dsh02-audit.zh.md` 逐条记录源码坐标（`tools/src/index.ts:1080-1112`、`settings/src/index.ts:357-360`、`skill/src/index.ts:439-459` 等） |
| 3.2 UI 风格跟随 ui-primitives，不自造第二套视觉语言 | ✅（**审查中整改**） | 药丸 → `Button variant="ghost" size="sm"`（`sm` 自带 H28，与 raw 同值）；搜索框 → `Input`；`Modal`/`Menu`/`Button`/`Tooltip` 本来就用原语。唯一例外：分组批量勾选保留原生 `<input type="checkbox">` —— `Checkbox` 原语不支持 `indeterminate`，而 raw 要求「半选态」（见 §四-2） |
| 3.3 优先复用 dsh 已导出的工具/服务/API | ⚠️ **偏差** | 见 §四-3 |
| 3.4 Markdown 页面用官方 `MarkdownText` | ✅ N/A | 本页不渲染 Markdown（工具描述走 `Tooltip` 纯文本） |
| 3.5 优先使用本仓 0.2 线 SDK `dsh-magica-spellbook` | ⚠️ **偏差** | 见 §四-3 |

## 四、i18n 与明暗主题（SKILL §4）

| 规则 | 结论 | 证据 |
|---|---|---|
| 4.1 `inject` 含 `'locale'`；`ctx.effect` 里 `ctx.locale.register(NS, { zh, en })`；两份字典同键集；`ctx.locale.bind(NS)` | ✅ | `src/client/index.ts`；zh/en 各 30 键、`diff = []`（有自检脚本） |
| 4.1 slot 注册声明 `locale: NS` 拿 `t`；组件内**不得** `useSyncExternalStore(locale…)` | ✅ | `register({ …, locale: NS })`；组件只吃 `t` prop |
| 4.1 所有可见文案走 `t()`，复用 `common` 词汇 | ✅ | 分类标签也有 `cat.*` 键（审查中补齐了 `cat.web`/`cat.workflow`/`cat.plugin`，原先会回退成英文 id） |
| 4.1 插件展示名/描述来自 `locale/*.json` 的 `meta.title`/`meta.description`；导出 `./package.json` 与 `./locale/*.json` | ✅ | `locale/zh.json`、`locale/en.json`；`exports` 两项都在 |
| 4.1 Host Config **没有** `.i18n()` 约定 | ✅ | 用 `description()` + locale 服务 |
| 4.2 颜色只用 `--dsw-alias-*`；不得硬编码 `#fff`/`#000`/`rgba()` | ✅ | `styles.ts` 中 `#hex` = 0、`rgb(` = 0 |
| 4.2 功能 CSS 不得写 `body[data-ds-dark-theme]` | ✅ | 0 处；明暗全部靠 token |
| 4.2 只用 dsh 真实存在的 token | ✅ | 运行时逐个验证：`label-dimmed/caption/tertiary`、`border-l3/l4`、`bg-module-platform`、`radius-xs/sm`、`focus-ring-*`、`elevation-prominent`、`ds-font-family-code` 全部解析成功 |

## 五、dev profile 隔离（SKILL §5）

| 规则 | 结论 | 证据 |
|---|---|---|
| 所有个人开发在 dev profile 进行 | ✅ | 全程只用 `--profile dev`；端口用 **3082**（3081 被别的实例占用） |
| 首次安装即初始化 profile；dev 只有 `dsh-base`，要 UI 需再装 `dsh-web-app` | ✅ | `dsh plugin --profile dev add` 走过一遍，并手工补了 `@deepseek-ai/dsh-web-app` 进 `bundles`（registry 上的 0.2 版不存在，见 §四-1） |
| 装本地插件须先 `pnpm build` | ✅ | `e2e/run.mjs` 自动起停 dev 实例；`pnpm e2e` 前会先 `pnpm build` |

## 六、禁止事项（SKILL §6）

| 规则 | 结论 |
|---|---|
| 不得自行 `npm publish` | ✅ 未发布 |
| 不得修改 `~/.dsh/profiles/web` 下配置 | ✅ 只**读取**过它的 `package.json`（查 bundle 列表），未写入 |

## 七、合规说明（SKILL §7）

- `peerDependencies` 用 `>=`（本仓用户要求「`>=` 与 `^` 只留一种」）；SKILL §7 明确 `^`/`>=` 都可覆盖运行时，故不冲突。
- `.gitignore` / `.npmrc` 的检查按 SKILL §7 忽略。

---

## 八、审查中修掉的问题

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 1 | `src/restrict.ts` | `system-prompt/assemble` 中间件的段落过滤没有 try/catch，也不防 `sections` 缺失 → 违反 §2.2 | 过滤逻辑 try/catch，`Array.isArray(result?.sections)` 守卫；上游异常继续冒泡 |
| 2 | `src/builtin-skill.ts` | `list()` 每次同步 `readdirSync`+`readFileSync`，而它按 skill snapshot 频次调用 → 违反 §2.1（🟡 热路径 + 轻 I/O 应缓存） | 缓存候选行；`get()` 保持每次读盘；`control.invalidate`/abort 失效重扫 |
| 3 | `src/client/locales.ts` | 缺 `cat.web`/`cat.workflow`/`cat.plugin` 三个键，分组标题回退成英文 id（`web`/`workflow`），违反 §4.1「所有可见文案走 `t()`」 | 补齐 zh/en 三个键，键集仍 30/30 一致 |
| 4 | `src/client/parts.tsx` + `styles.ts` | §3.2：药丸与搜索框是原生 `<button>`/`<input>`，没有复用原语 | 药丸改 `Button`（`ghost`+`sm`）、搜索框改 `Input`；CSS 只覆盖 raw 与 `sm` 有差异的 4 个声明（padding/字号/行高/圆角/描边），并把 hover 规则提权到双类选择器以压过原语的 `ghost:hover:not(:disabled)`。E2E 的视觉断言全部仍然通过 |

## 九、仍存在的偏差与「发布前」清单

> 决策记录：§3.2 已整改（见 §八-4）；§3.3/§3.5 暂缓（本仓 SDK 未就绪）；§1.3 见下面的推荐。

### 1. 共享实例包只在 `peerDependencies`，不在 `devDependencies`（§1.3）—— **推荐「双写」**

**结论：要发布的话，目标是 `peerDependencies` + `devDependencies` 双写**（这也是 dsh 官方插件的做法），但**现在还不能写 dev 那一半**。

理由：

| | 作用 | 对**使用者**的影响 |
|---|---|---|
| `peerDependencies` | 声明「这个包由宿主提供，别自己装一份」；profile 组合期还会做 semver 校验 | **决定性**：缺了它，用户装完会拿到两份 cordis/dsh-tools 实例 |
| `devDependencies` | 只服务于本仓 `pnpm install` / `tsc` / 本地构建 | **零**：`npm/pnpm` 安装时根本不装依赖方的 devDependencies，不会进用户环境 |

所以 dev 那一半的唯一受益者是**我们自己**（本地能解析真实类型）。当前写不了的客观原因：registry 上
`@deepseek-ai/dsh-*` 只有过时的 `0.0.1-rc.1`，`0.2.0-rc.2` 未发布 → 写进 devDependencies 会让
`pnpm install` 失败或装到不兼容类型；本仓又禁止 `link:`。

**过渡方案（现状）**：类型解析用 `tsconfig.json` 的 `paths` 指向本机 dsh 安装树里的 `.d.ts`。
只影响 `tsc`；esbuild 把 `@deepseek-ai/*` 全标 external，构建与运行时都不看它。
代价：换机器 `pnpm typecheck` 可能报 TS2307（build/runtime 不受影响）。

**发布前清单**（5 分钟）：

1. 在 `devDependencies` 补回 8 条与 peer 同范围的条目（`>=0.2.0-rc.2`；`schemastery` 用 `>=3.18.4`、`cordis` 用 `>=4.0.4`）；
2. 删掉 `tsconfig.json` 里的 `paths` 回退；
3. 干净 clone 上跑 `pnpm install && pnpm typecheck && pnpm build && pnpm test && pnpm e2e`。

### 2. 分组批量勾选仍是原生 `<input type="checkbox">`（§3.2 的残留）

`Checkbox` 原语的参数是 `{ checked, onChange, label, disabled, title, className }` ——
**没有透传 ref / `indeterminate`**。而 raw 明确要求分组头呈「半选态」（部分启用）。
换过去会静默丢掉这个状态，所以保留原生元素：`<input type="checkbox">` + `accent-color: brand`，
尺寸 14×14 由 `.rune-batch-toggle input` 覆盖。

**若要完全合规**：需要 `Checkbox` 支持 `indeterminate`（或暴露 input ref）；在那之前这是唯一的例外。

### 3. 未采用本仓 SDK `dsh-magica-spellbook`（§3.3 / §3.5）—— **暂缓**

用户决定：**spellbook 还没开发好，先忽略这条**。因此 `src/router.ts`（`sendJson`/`sendText`/
`sendMethodNotAllowed`）与 `src/workspace.ts`（`normalizeProjectPath`）保留各自不到 40 行的实现。

SDK 就绪后，替换点是明确的：`import { sendJson, sendMethodNotAllowed, normalizeProjectPath } from 'dsh-magica-spellbook'`
（构建会把 SDK 打进 `lib/index.js`，符合它「纯库随插件打包」的定位）。

---

## 十一、插件市场（`docs/contribute-plugins.md`）合规

市场那边（madoka 仓库根）的投稿要求分三档：硬性（CI/评审核对）、推荐、以及提交物本身。

### 硬性要求

| 要求 | 结论 | 证据 |
|---|---|---|
| `package.json` 声明 `dsh.bundle`（只声明 `dsh.client` 不可安装，是最常见的被拒原因） | ✅ | `dsh.bundle.patch: "./cordis.patch.yml"` |
| `cordis.patch.yml` 在包目录里，`insert` 行的 `name` 与包名**完全一致** | ✅ | 两侧都是 `@meiyukichan/dsh-magica-rune`；`id` 保持 `dsh-magica-rune`（settings 命名空间） |
| 真实可用的代码（不接受空壳） | ✅ | 26 工具 / 15 技能、35 个 E2E 用例 |
| `files` 覆盖全部运行时产物 | ✅ | `lib`、`cordis.patch.yml`、`locale`、`resources`（内置 skill 正文） |
| 不是 `private`、包名 scoped、`repository` 指向本仓子目录 | ✅ | `repository: { url: .../madoka.git, directory: dsh-magica-rune }` |

### 推荐项

| 项 | 结论 | 说明 |
|---|---|---|
| 发布到 npm（预构建安装可跳过 `allowBuilds` 构建审批） | 📌 待你发布 | 已加 `prepublishOnly: node scripts/build.mjs`，保证 tarball 里有 `lib/`；另加 `prepare: node scripts/build.mjs`，让**从 GitHub 源码安装**时也能现场构建（否则 `lib/` 被 gitignore、源码安装会拿到空包） |
| `screenshots.json` + 仓库内截图（1-8 张、相对路径、不得越界） | ✅ | `screenshots.json` → `assets/screenshot-1.png`（真 PNG，UI 实拍） |
| `icon`（GitHub 托管位图） | ⬜ 可选 | 暂缺 180×180 图标；不写则回退到作者头像 |
| `dsh-plugin` GitHub topic（仓库设置） | ⬜ 你来做 | 不在代码里 |
| 仓库已满 1 天 | ⬜ 你确认 | 市场要求，无法从代码侧保证 |

### 提交物

一个文件：`data/plugins/Meiyukichan__madoka--dsh-magica-rune.yml`。内容已备好在本包的
`docs/marketplace/entry.yml`（monorepo 子包形态：`url` 指向子目录、`name` 用 `owner/repo#subname`、
分类取 `tools`）。**不要**手工改两个 README，也**不要**往 `data/screenshots.json` 加键。

### 顺手修掉的一个真实坑：peer 范围要覆盖预发布，但**不能过界到 0.3**

市场文档专门警告：`"^0.2.0-rc.2"` 这种写法在 npm 解析时**匹配不到 `0.4.0-rc.1`**。
实测确认我们原来的 `>=0.2.0-rc.2` 同样有该问题（semver 元组规则，与 DSH 自己的 gate 用
`includePrerelease` 不同，所以 **gate 放行、用户却装不上**）。

但反过来也不能图省事写 `|| >=0.3.0-rc.1` —— 那等于宣称兼容 0.3，而本包只对 **0.2.0-rc.2**
验证过（0.3 的 API 尚未审查）。所以取「只覆盖 0.2 线」的写法，与市场文档示例
`>=0.1.0-rc.1 <0.2.0-0` 同形：

| 版本 | `>=0.2.0-rc.2`（最初） | `>=0.2.0-rc.2 \|\| >=0.3.0-rc.1`（过界） | **`>=0.2.0-rc.2 <0.3.0-0`（现）** |
|---|---|---|---|
| `0.2.0-rc.2` | ✅ | ✅ | ✅ |
| `0.2.0-rc.3`（未来 rc） | ✅ | ✅ | ✅ |
| `0.2.0` / `0.2.1` | ✅ | ✅ | ✅ |
| `0.1.2` | ✅（不该） | ✅（不该） | ❌ 正确拒绝 |
| `0.2.1-rc.1` | ❌ | ❌ | ❌（patch 线预发布，DSH 未发布过这种形态） |
| `0.3.0-rc.1` / `0.3.0` | ❌ 但 gate 会放行 | ✅ 不该放 | ❌ 正确拒绝 |

已用于全部 6 个 `@deepseek-ai/dsh-*` peer。**等 0.3 真发布并实测通过后**，再把范围扩成
`>=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-rc.1` 这类多条分支。

---

## 十二、复核方式

```bash
pnpm typecheck    # 0 error
pnpm test         # 69/69
pnpm build        # exit 0，lib/ 无 *.js.map
pnpm e2e          # 35/35，真开浏览器（含视觉数值、落盘、两级作用域、搜索、技能与目录契约）
```
