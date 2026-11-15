# 04 · 包工程、测试与验收

> 路径约定同 `01`（`packages/…` = DSH `0.2.0-rc.2` 源码）。本文的 `package.json` / `cordis.patch.yml` / 构建配置**可直接采用**，且与仓库里的实际文件逐字段一致。
>
> 插件形态固定为四件套：`dsh.bundle.patch` 指向 `cordis.patch.yml`、`dsh.client{platform,inject}`、`exports["./client"]` 给 `default` 键、`lib/client.js` 是闭包工厂；patch 只需要 3 行 insert（`- insert:` + `id` + `name`）。本包是**插件**（host 侧 ESM + client 侧 CJS 闭包工厂），不是 client 产物走 ESM 的**库**——库形态要求 `exports["./client"]` 用 `import` 键，插件声明写成那样会被模块系统判为形状不合法。

---

## 1. 目录结构

```
dsh-magica-rune/
  package.json
  pnpm-workspace.yaml
  tsconfig.json
  tsconfig.dts.json
  cordis.patch.yml
  locale/
    zh.json                  ← meta.title / meta.description（Plugins 页显示名）
    en.json                  ← 必须存在，否则一个语言都不读
  resources/
    dsh-plugins-principles/SKILL.md  ← 随包发布的内置技能（files 覆盖）
  assets/
    icon-180.png             ← 相对路径，≤256 KiB
  scripts/
    build.mjs                ← esbuild CLI：lib/index.js + lib/client.js（压缩）+ 可选 dts
    clean.mjs                ← 清 lib/（含 *.js.map 残留）
  src/
    index.ts                 ← host 入口：name / inject / Config / apply
    config.ts  namespace.ts  policy.ts  state.ts
    workspace.ts  guard.ts  restrict.ts  skill-gate.ts  catalog.ts  router.ts
    builtin-skill.ts         ← 内置技能 provider（registerProvider）
    client.ts                ← client 入口：inject + re-export apply
    shared/
      ability.ts  dsh.ts     ← 纯数据层 + dsh 结构性类型
    client/
      index.ts               ← apply(ctx)
      controller.ts          ← async 数据/写入（乐观锁 + 重试）
      store.ts               ← defineStore 视图状态
      AbilitySection.tsx     ← 根组件
      tabs.tsx  parts.tsx    ← tab 容器 / zone / 药丸 / 下拉 / 确认弹窗
      styles.ts              ← CSS 文本常量 + <style data-plugin> 注入
      nav-icon.ts            ← MutationObserver + mask hack
      categorize.ts          ← 工具分类 + 搜索匹配
      face.ts  icons.tsx     ← 注入面 / 图标
      locales.ts             ← zh / en 字典
  lib/                       ← 产物：index.js / client.js / types/**
  tests/
    ability.test.ts  policy.test.ts  state.test.ts
    categorize.test.ts  builtin-skill.test.ts  artifacts.test.ts
  e2e/
    harness.mjs  run.mjs
    style.test.mjs  toggle.test.mjs  scope.test.mjs
    search.test.mjs  skills.test.mjs
```

---

## 2. `package.json`（与本仓实际文件逐字段一致）

```json
{
  "name": "@meiyukichan/dsh-magica-rune",
  "version": "0.2.0-alpha.1",
  "type": "module",
  "license": "MIT",
  "publishConfig": {
    "access": "public"
  },
  "icon": "./assets/icon-180.png",
  "description": "DSH 能力管理：按全局或工作区启用 / 禁用任意工具与技能。被禁项同时从模型的工具清单与系统提示词中移除，运行期再兜底拦截；支持搜索、分组批量与内置保护，改动即时生效、无需重启。",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/Meiyukichan/madoka.git",
    "directory": "dsh-magica-rune"
  },
  "engines": {
    "node": ">=22.5",
    "pnpm": ">=11"
  },

  "main": "./lib/index.js",
  "types": "./lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "files": [
    "lib",
    "cordis.patch.yml",
    "locale",
    "resources",
    "assets/icon-180.png",
    "README.md"
  ],

  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-settings"
      ]
    }
  },

  "scripts": {
    "build": "node scripts/build.mjs",
    "test": "node --test --test-isolation=none \"tests/**/*.test.ts\"",
    "typecheck": "tsc -p tsconfig.dts.json --noEmit",
    "e2e": "node e2e/run.mjs",
    "prepare": "node scripts/build.mjs",
    "prepublishOnly": "node scripts/build.mjs",
    "clean": "node scripts/clean.mjs"
  },

  "peerDependencies": {
    "@deepseek-ai/cordis": ">=4.0.4",
    "@deepseek-ai/dsh-client-store": ">=0.2.0-rc.2 <0.3.0-0",
    "@deepseek-ai/dsh-client-ui-primitives": ">=0.2.0-rc.2 <0.3.0-0",
    "@deepseek-ai/dsh-client-ui-slots": ">=0.2.0-rc.2 <0.3.0-0",
    "@deepseek-ai/dsh-scope": ">=0.2.0-rc.2 <0.3.0-0",
    "@deepseek-ai/dsh-system-prompt": ">=0.2.0-rc.2 <0.3.0-0",
    "@deepseek-ai/dsh-tools": ">=0.2.0-rc.2 <0.3.0-0",
    "@deepseek-ai/schemastery": ">=3.18.4"
  },

  "devDependencies": {
    "@types/node": "^22.20.5",
    "@types/react": "~18.3.1",
    "esbuild": "^0.25.10",
    "playwright": "1.61.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "typescript": "^5.9.3"
  }
}
```

### 2.1 逐条理由（每个字段都有明确依据）

| 字段 | 为什么这样写 | 反例 / 依据 |
|---|---|---|
| **`engines.dsh` 不写** | 0.2 **零读取方**（`packages/util/package-manifest/README.md:93` 明文「不强制检查」） | 写 `engines.dsh` 得不到任何保护：唯一的闸是 peer 校验（下一行），这个字段连读的人都没有 |
| peer 全部 `>=0.2.0-rc.2 <0.3.0-0` | 兼容性校验只查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`，且 `semver.satisfies(rt, range, {includePrerelease:true})`。只有**带上界**的范围才拦得住次版本跃迁：裸 `>=` 下限写得再高也是零保护，所以必须显式封顶 `<0.3.0-0` | `packages/boot/app-boot/src/plugin-compatibility.ts:61-88` |
| `cordis >=4.0.4` / `schemastery >=3.18.4` | **不进那道闸**，只能靠自查；写实际版本便于阅读 | 同上（第 75 行只匹配 `@deepseek-ai/dsh*`） |
| `exports["./client"]` 用 **`default`** | 有形状校验：必须 string 或**含 `default`** 的对象；写 `import` 会抛 `exports["./client"] must be a string or an object with a string default` | `packages/client/modules/src/index.ts:194-205, 845-848` |
| `exports["./cordis.patch.yml"]` **不需要** | profile 走文件系统 `join` 读 patch，不经 exports；但 `files` **必须**包含它 | `packages/boot/app-boot/src/profile.ts:73-75` |
| `exports["./locale/*.json"]` + **`locale/en.json` 必须存在** | 否则一个语言都不读（只认 `en` 作为回退基线） | `packages/boot/app-boot/src/package-meta.ts:101-122, 151` |
| `icon: "./assets/icon-180.png"` | 相对路径 + svg/png/jpeg/webp + **≤256 KiB** + realpath 必须在包目录内 | `package-meta.ts:14-39` |
| `dsh.client.inject` 只列 **4 个包** | 只列被 `import type` 引用的**非基线**包 | 不写 `@deepseek-ai/dsh-client-runtime`（0.2 全仓**不存在**）；也不重复 `ui-primitives` / `ui-slots` / `client-store` / `react`（基线 external 隐式，`packages/client/AGENTS.md:78`） |
| `dsh.client.platform: "web"` | 只认 `=== 'web'`，其它值静默不算 client 行 | `client/modules/src/index.ts:841-844` |
| **不写 `immediately`** | 一阶段预取只给基础设施（`client/web/src/boot.ts:115-122`） | 功能插件加了会改变启动时序 |
| **不写 `dsh.client.external`** | 功能插件不该用它取其它插件的运行时值；构建期 purity gate 会拒 | `client/tsdown.client.ts:528-546` |
| `devDependencies` 只放**工具链**（`@types/*`、esbuild、playwright、react、react-dom、typescript） | 基线模块（react / ui-primitives / ui-slots / client-store）由 shell 模块表注入，不需要装进包 | `packages/client/AGENTS.md:62-66`、`docs/user/develop/basic/publish.zh.md:103` |
| dsh 包**只写 `peerDependencies`**，不双写 devDependencies | 实例由宿主运行时提供；本地 `autoInstallPeers: false`，避免 registry 上的同名陈旧版本污染 `node_modules` | `pnpm-workspace.yaml` 里 `autoInstallPeers: false` 那段注释 |

> **可发布**：包名 `@meiyukichan/dsh-magica-rune`（scoped）+ `publishConfig.access = "public"`，不写 `private`（写了 `npm publish` 会直接拒绝）。发布前只剩两件事：`version` 改成正式号、复核 tsconfig 的 `paths` 回退（见 `05-skill-compliance.zh.md` §九-1）。

---

## 3. `cordis.patch.yml`（可直接采用）

```yaml
# 刻意不写 config：默认值由 Config schema 的 .default() 提供（src/config.ts）。
# 用户的配置由「能力管理」页写入 **profile 自己的** cordis.patch.yml。
- insert:
    - id: dsh-magica-rune
      name: dsh-magica-rune
```

要点：

| 点 | 说明 |
|---|---|
| `id` = **settings namespace** | 0.2 的 `ns` 就是这条 patch 行的 `id`（`packages/settings/settings/src/index.ts:317`）→ 必须与本包 `src/namespace.ts` 的 `ABILITY_NS` 一致，**不能随意改名** |
| `name` = package `name` | insert 行的 `name` 就是模块 specifier，profile 据此去 `node_modules/<name>` 定位包 |
| **不写 `config`** | 默认值交给 schema `.default()`。在这里写一份是**有害**的：本行会成为组件期的 **base 层**，而 patch **整体替换、不深合并**（`vendor/include/src/index.ts:120-123`），schema 默认值一旦演进，陈旧的 yaml 值会盖住新默认值 |
| 用户配置落在**哪** | `<DSH_HOME>/profiles/<profile>/cordis.patch.yml`（即 `~/.dsh/profiles/web/cordis.patch.yml`）。profile 初始化时这个文件被写成 `# Your patch layer for this dsh profile, applied after every bundle layer: … []`（`packages/boot/app-boot/src/profile.ts:40, 220-224, 259-260`）。用户点一次开关后，里面会多出一段**不带 `insert`、只按 id 覆盖**的行（见下） |
| 层序（后者胜） | bundle 层 → **profile 的 `cordis.patch.yml`（用户层）** → `$DSH_HOME/cordis.patch.yml`（可选的 home 层）→ CLI `--patch`（`profile-context.ts:63-70`）。我们包的 `insert` 行来自 bundle 层，用户的值来自第二层 |
| 页面写入的落点 | `config-editor.documentPath = profileContext.patchPath`，`edit()` 首次 `createNode({ id, name, config })`、后续 `setIn([i,'config'])`，再 `writeFileAtomic(path, …, {mode:0o600})`（`packages/boot/config-editor/src/index.ts:33-34, 87-142`）。**UI 与手改是同一个文件** |
| 手动改配置的**三种写法** | ① 用「能力管理」页（推荐，走 `settings.replace` + revision 乐观锁）；② 在 profile patch 里加 `- id: dsh-magica-rune` + `config:`（**要重述全部键**，因为整体替换）；③ CLI `--patch` 覆盖层 |
| ⚠️ 覆盖层会让页面写不进去 | 若该行被 home patch 或 CLI overlay 覆盖，`configEditor.edit()` 抛 `Configuration for "dsh-magica-rune" is overridden by a home patch or command-line overlay`（`:140`）→ 页面写入会失败并回滚 |
| `!!js` 可用 | 在**该行 fiber 的 `internal/config`** 里求值，`with (ctx)` 作用域，服务必须先 `inject`（`vendor/loader/src/config/utils.ts:5-9`、`vendor/loader/src/index.ts:104-113`） |
| 不要拆包 | 拆成 `pkg/host` + `pkg/client` 会让 **client 永不加载**（subpath 行「permanently not a client row」，`client/modules/src/index.ts:827-833`） |

### 3.1 「按 id 覆盖的行」长什么样（最终效果）

> **这是官方文档明确规定的做法，不是我们的发明。** 依据：
> - `docs/architecture.zh.md:27`：「各层按此顺序应用在空条目列表之上：先按 profile 列出的顺序应用每个组合包，然后是 **profile 的 `cordis.patch.yml`**，然后是 home 级的那份，最后是任意 `--patch` overlay。一条 patch 按 id 定位某个条目并替换其整个 config，或插入新条目。」
> - `docs/user/develop/basic/publish.zh.md:118-132` 把层序列成 1~4 条，并给出对 bundle 作者的两条推论，**第 132 条原文**：
>   > 「用户可以在自己 profile 的 `cordis.patch.yml` 中覆盖你的行，无需改动你的包，**所以优先给出用户大概率会保留的配置默认值，其余交给 schema 承担**。」
>   → 这正是本文「包内 patch 只 `insert`、默认值只写在 schema」的依据。
> - `docs/user/guide/providers.zh.md:46,48`：模型页写入的就是 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，并明确「也就是模型页写入的同一份文档。可以直接编辑它」，设置页顶部还有**打开配置文件**按钮。
> - `docs/user/guide/mcp-memory.zh.md:33`：只对一个 profile 生效写 `$DSH_HOME/profiles/<name>/cordis.patch.yml`，对本机所有 profile 生效写 `$DSH_HOME/cordis.patch.yml`。

装好插件、第一次打开能力管理页之前，`~/.dsh/profiles/web/cordis.patch.yml` 还是初始模板：

```yaml
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
[]
```

用户在页面上禁掉全局的 `bash`、并在工作区 `a1b2…` 里禁掉 `playwright` 之后，同一个文件变成：

```yaml
# Your patch layer for this dsh profile, applied after every bundle layer:
[]
- id: dsh-magica-rune          # ← 只是按 id 定位，没有 insert：这是在「覆盖」bundle 层那条 insert 行
  name: dsh-magica-rune
  config:                      # ← 整段替换 bundle 行（原来没有 config），不深合并
    tools:
      global:
        disabled: [bash]
        enabled: []
      workspaces:
        a1b2c3d4-...:
          disabled: [playwright]
          enabled: []
    skills:
      global:
        disabled: []
        enabled: []
      workspaces: {}
```

要点：

- `config` 里的值是**最终生效值**（schema 默认 → bundle base → 本层 override，本层胜）。
- 前端读的是 `settings.describe()` 里这条 namespace 的 `value`（resolved）与 `revision`；写是 `replace(ns, section, revision)`。
- 删掉这段（或把某个 name 从数组里去掉）等价于「恢复默认」；整条 `config` 删空后 `edit()` 会把这一行也删掉（`:125`）。
- **不要**去改 `node_modules/dsh-magica-rune/cordis.patch.yml`——那是 bundle 层，会被本层覆盖，而且下次装插件会被覆盖回去。

---

## 4. 构建

### 4.1 `scripts/build.mjs`（本仓习惯：esbuild CLI + `stdio:'inherit'`，避开 JS API 的 pipe EPERM）

```js
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const pkgName = 'dsh-magica-rune'
const cli = fileURLToPath(new URL('../node_modules/esbuild/bin/esbuild', import.meta.url))

/** 模块表里的 9 个基线 specifier（packages/client/web/src/platform.ts:7-21），其余一律打进 bundle。 */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// ① host 半侧（ESM / node）
run([
  'src/index.ts', '--bundle', '--format=esm', '--platform=node', '--target=node22',
  '--minify', '--legal-comments=none', '--outfile=lib/index.js',
  '--external:@deepseek-ai/*',            // 与宿主共享实例，不打包
])

// ② client 半侧（CJS 闭包工厂 / browser）
run([
  'src/client.ts', '--bundle', '--format=cjs', '--platform=browser', '--target=es2022',
  '--jsx=automatic', '--minify', '--legal-comments=none',
  '--outfile=lib/client.js',   // 不产出 sourcemap：lib/ 只允许 index.js / client.js（+ types/）
  // 三段必须严格：banner 的 load 行 + intro 的 module 声明，footer 收尾
  `--banner:js=window.__ModuleLoader__.load({ id: ${JSON.stringify(pkgName)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  '--footer:js=return module.exports; } });',
  // 三个 define 缺一不可（tsdown.client.ts:522-527 的注释解释了 zustand 的 import.meta 探测）
  '--define:process.env.NODE_ENV="production"',
  '--define:import.meta.env.MODE="production"',
  '--define:import.meta.env="{\\"MODE\\":\\"production\\"}"',
  ...CLIENT_EXTERNALS.flatMap(name => [`--external:${name}`]),
])
```

**产物验收**：`lib/client.js` 恰好是

```js
window.__ModuleLoader__.load({ id: "dsh-magica-rune", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
/* … bundle body … */
return module.exports; } });
```

（`id` 必须等于包名 `@meiyukichan/dsh-magica-rune`，`var module/exports` 两段声明不可省——模块系统要靠工厂返回值注册导出；官方 tsdown 预设的 banner/intro/footer 见 `packages/client/tsdown.client.ts:618-624`。）

### 4.2 CSS 的处理

| 形态 | esbuild 这条路线怎么做 |
|---|---|
| `*.module.css` | esbuild **不做 CSS Modules**。两条选项：<br>**(A)** 改用 `tsdown`/`rolldown` + 自写 CSS Modules 插件，复刻 `packages/client/tsdown.client.ts:36-56,548-571`（哈希类名 + 工厂期注入带 `data-plugin` 的 `<style>`）。<br>**(B) 本包采用**：类名自己保证唯一（`rune-` 前缀），CSS 以 **TS 字符串常量**写在 `src/client/styles.ts`，在 `apply` 里 `ctx.effect` 注入 `<style data-plugin="<包名>">`。视觉等价，代价是没有作用域隔离 |
| `*.css?inline` | esbuild 无虚拟模块；若要走这条路，用 `--loader:.css=text` 把 CSS 变成字符串导出，再 `ctx.effect` 注入 |

**本包采用 (B)**：`styles.ts` 导出 `CSS` 字符串与 `cls` 短名→`rune-*` 映射，
注入函数按 `data-plugin-css` 做幂等判断、disposer 负责移除（与官方预设的第 3、4 条契约一致）。

**若将来改用 (A)**，需复刻的契约（全部来自官方预设）：

1. 类名哈希：lightningcss `cssModules: { pattern: '[hash]_[local]' }`。
2. 注入时机：**模块工厂执行期**（不是组件 render）。
3. 标签标记：`tag.dataset.plugin = <包名>`、`tag.dataset.pluginCss = '<包名>/<文件名>'`；已存在则不重复插入。
4. 卸载/HMR：模块系统按 `data-plugin` 回收（`client/modules/src/client/system.ts:454-459`、`entry-lifecycle.ts:19-27`）——**不要自己删**。
5. 全局 sheet（nav mask hack）走 `?inline` + `ctx.effect` 自管生命周期，**必须可逆**。

### 4.3 分块（chunk）

本包按设计**不需要** chunk（`AbilitySection` + 两个 tab 一起加载）。若将来要拆：

- esbuild 的 `--splitting` **只支持 ESM**，CJS 闭包工厂不能直接用；
- 必须复刻官方的 `require.async("./client.<name>.js")` 改写（`client/tsdown.client.ts:437-471`）、`chunkFileNames: 'client.[name].js'`、注册时带 `chunk` 字段、**chunk 不得同步 require 兄弟 chunk**；
- 结论：**要 chunk 就用 tsdown/rolldown，不要用 esbuild**。

---

## 5. `locale/*.json`

```json
// locale/en.json（必须存在）
{
  "meta": {
    "title": "Ability",
    "description": "Enable or disable tools and skills globally or per workspace."
  }
}
```

```json
// locale/zh.json
{
  "meta": {
    "title": "能力管理",
    "description": "按全局或工作区启用/禁用工具与技能。"
  }
}
```

⚠️ DSH 的 `SkillInvocationPolicy` 与 skill 的 locale 命名空间无关；这里只是 Plugins 页的展示元信息。**界面文案**仍走 `ctx.locale.register(NS, { zh, en })`（§`03` §9）。

---

## 6. `pnpm-workspace.yaml`

```yaml
packages:
  - '.'

# 单包工程：'.' 必须在列表里，否则 pnpm 不认为它是 workspace 成员。
# autoInstallPeers: false —— 本包的 @deepseek-ai/* 全是 peerDependencies，由宿主运行时提供；
# 让 pnpm 自动装 peer 会去 registry 拉，拉到的同名版本与 0.2.0-rc.2 不兼容，会污染 node_modules。
autoInstallPeers: false

# pnpm 11 构建脚本白名单（写在 workspace 根才生效）
allowBuilds:
  esbuild: false
```

（`allowBuilds` 只认 workspace 根这一份；`autoInstallPeers: false` 是 `peerDependencies` 策略的配套——少了它，pnpm 会自己拉一份同名 dsh 装进 `node_modules`，本地类型与运行时就和宿主不是同一个版本。）

---

## 7. 测试计划

### 7.1 纯函数单测（无 Cordis，最快最稳）

| ID | 测什么 | 断言 |
|---|---|---|
| T-P1 | `buildEffective` 全局合并 | `builtin ∪ global.disabled − global.enabled(非内置) − RESERVED − NON_DISABLEABLE` |
| T-P2 | **工作区折叠** | `effective(ws)` 已含 global；`ws.enabled` 能恢复 `global.disabled` |
| T-P3 | **内置禁用不可恢复** | `builtin` 里的名字即使出现在 `ws.enabled` 也不被删除 |
| T-P4 | `RESERVED` / `NON_DISABLEABLE` 双保险 | 即使用户在两个层都写，也不进 `effective` |
| T-P5 | 未注册工作区 | `byWorkspace` 无该 key → 查询回退 `global` |

### 7.2 `GuardState` 单测

| ID | 断言 |
|---|---|
| T-S1 | `agentId === undefined` → 只查 `global` |
| T-S2 | `agentWorkspace` 未命中 → 回退 `global` |
| T-S3 | **不先查 global**：全局禁 A + 工作区 `enabled: A` → `denied(wsAgent, 'A') === false` |
| T-S4 | `internalTools` **只增不减**：restrict 后再次 `updateInternalTools([])` 仍保留此前已加入的项 |

### 7.3 `toggle` 语义单测（前端逻辑，纯函数抽出）

| ID | 场景 | 断言 |
|---|---|---|
| T-T1 | global enabled→点击 | `global.disabled` 含该名 |
| T-T2 | global disabled→点击 | `global.disabled` 不含该名 |
| T-T3 | ws enabled→点击 | `ws.disabled` 含该名，`ws.enabled` 不含 |
| T-T4 | ws disabled→点击（global 也禁） | `ws.disabled` 移除 + `ws.enabled` **含**该名 |
| T-T5 | ws disabled→点击（global 未禁） | `ws.disabled` 移除 + `ws.enabled` **清理陈旧项** |
| T-T6 | 批量 | `enable = !allEnabled` |

### 7.4 Host 集成测试（用 `@deepseek-ai/dsh-test-support` 起真实 fiber）

| ID | 场景 | 验什么 | 断言 |
|---|---|---|---|
| T-H1 | 全局禁 `bash` | guard | `tools.execute({name:'bash', agent})` 返回 `isError` 且文本含 `ability: tool "bash" is disabled` |
| T-H2 | 工作区禁 `pwsh`（global 未禁） | guard | 该 wsId 的 agent 被拒；另一工作区的 agent **放行** |
| T-H3 | 工作区 `enabled` 恢复全局禁 | guard | 该 agent **放行**（证明没先查 global） |
| T-H4 | restrict 生效 | schema 视图 | `tools.schemas(agent)` 不含被禁名字；`tools.schemas()`（另一 agent）仍含 |
| T-H5 | preset 工具被 restrict | **0.2 语义** | 挂在 preset/祖先层的工具**也能**从 `schemas(agent)` 消失 |
| T-H6 | restrict 未知名 | 健壮性 | 配置里放一个不存在的名字 → **不抛错**，其余名字仍被 restrict |
| T-H7 | assemble 过滤 | section | `systemPrompt.assemble({scope:agent})` 的 `sections` 不含 `tool:<被禁>` |
| T-H8 | **skill 遮蔽落层**（最关键） | 跨层 nearest-wins | 在 `.dsh/skills/<name>/SKILL.md` 放同名 project skill → `skills.snapshot({scope: agent})` 里该 name 的 `invocation.modelInvocable === false` |
| T-H9 | skill 热加载 | 先禁后启 | 改 config 后再次 `snapshot`，`modelInvocable` 恢复 `true`（证明「先 dispose 再 register」） |
| T-H10 | `skill` 工具被 guard 拒 | guard 双保险 | `execute({name:'skill', arguments:{name:'<被禁>'}})` 被拒 |
| T-H11 | 配置热更新 | `loader/volatile-update` | 改 config 不 remount 插件，guard 下一调用即生效 |
| T-H12 | **`tools/change` 防重入** | 递归防护 | 注册一个新工具触发 `tools/change` → `refresh()` 不产生第二次 `tools/change` 风暴 |
| T-H13 | `agent/created` 载荷 | 解构 | 注册监听，断言 `payload.agent.id` 为字符串（防「拿到对象当 agent」回归） |
| T-H14 | 无可选 service | 降级 | 不挂 `workspaceRegistry` → 全部 agent 走全局策略，**不抛错** |
| T-H15 | catalog 路由 | HTTP | `GET /rune-ability/catalog` 返回 `{ ns, tools, skills, workspaces }`；`POST` 返回 405 |
| T-H16 | catalog 含被 restrict 的工具 | internalTools | 被禁工具仍在 `tools` 数组里（UI 才能重新启用） |

### 7.5 前端测试

| ID | 验什么 |
|---|---|
| T-C1 | `categorize` 的表驱动用例（全部 12 类 + 动态前缀 + `mcp__`） |
| T-C2 | 分组合并：动态分类 <2 个并入 `plugin-other`；排序符合 `FIXED_CATS` |
| T-C3 | `catColor` 稳定性：同一分类多次调用同色；`builtin`/`mcp`/`plugin-other` 特判 |
| T-C4 | `effectiveState` 三态（含 workspace 继承与恢复） |
| T-C5 | 组件渲染：只有 2 个 tab；`data-active="true"`、`aria-expanded`、`indeterminate`、`aria-disabled`（builtin） |
| T-C6 | `Modal` 传了 `closeLabel`（类型层即保证，加一条渲染断言防回归） |
| T-C7 | 字典 `zh`/`en` **键集完全相等**（`Object.keys` 排序后深比） |
| T-C8 | controller：`load()` 四态；`toggle()` 乐观更新 + 失败重载 |

---

## 8. 验证矩阵（人工验收）

| 场景 | guard | restrict | assemble | 配置 | 工作区 | UI 预期 |
|---|---|---|---|---|---|---|
| 无任何配置 | 放行 | 不挂 | 不过滤 | 默认 | — | 全部启用态，无徽标 |
| 全局禁 `bash` | 拒 | schema 移除 | section 过滤 | 写 `tools.global.disabled` | — | 「Shell」组 0/1，药丸灰 |
| 工作区禁 `pwsh`（global 未禁） | 该 ws 拒 | 该 ws 移除 | 该 ws 过滤 | 写 `tools.workspaces.<id>.disabled` | wsId 命中 | 仅该工作区灰 |
| 工作区恢复全局禁的 `bash` | 该 ws 放行 | 该 ws 保留 | 该 ws 保留 | 写 `ws.enabled` | wsId 命中 | 该工作区蓝 |
| 工作区试图恢复 `BUILTIN_DISABLED` | 仍拒 | 仍移除 | 仍过滤 | `enabled` 被 policy 守卫忽略 | — | 仍显示「内置禁用」徽标 |
| `NON_DISABLEABLE`（`run_code`）配置禁用 | 放行 | 跳过 | 不过滤 | policy 剔除 | — | UI 不展示该行 |
| preset 挂的工具被禁 | 拒 | **能移除**（0.2 语义） | 过滤 | — | — | 看不到也调不了 |
| MCP 重连同名工具 | 拒（按名） | 未知名 try 跳过 | — | — | — | 调不了 |
| 子代理（继承父 cwd） | 按同 ws 拒 | 同 ws | 同 ws | — | 同 wsId | 子代理按所在 ws 生效 |
| 子代理被派到别的 cwd | 按那个 ws | 那个 ws | 那个 ws | — | 命中另一 wsId | 「按所在工作区」的正确语义 |
| 改配置新增禁用 | **立即**拒 | `refresh` 后下一 step | 下一 step | `loader/volatile-update` | — | 不刷新页面即变灰 |
| 在别处改配置 | 立即 | 同上 | 同上 | `settings/document-updated` | — | 静默同步，搜索词不丢 |
| registry 不可用 | 只 global 拒 | 只 global | 只 global | — | `undefined` | 工作区 zone 空态 |
| resume 会话 | 重挂后生效 | 重挂 | 重挂 | — | 重新解析 | 与新建一致 |

---

## 9. 风险与回退

| 风险 | 影响 | 缓解 / 回退 |
|---|---|---|
| guard 体内异常 | 工具执行异常 | 体内只做 Map/Set 查找 + 外层 try/catch（`02` §6）；出问题 `dsh plugin disable` 即回到无拦截 |
| `.volatile()` 嵌套进 dict/array | **插件加载期抛错** | schema 只在 kind 这一层标 volatile（`02` §2.1）；T-P0 加一条 `Config(...)` 能解析的冒烟测试 |
| `agent/created` 未解构 → `agent.id` undefined | 工作区策略**静默**失效 | T-H13 锁死；`workspace.ts` 里 assert 并 warn |
| skill 遮蔽注册到错的层 | project skill **静默逃逸** | 只用 `agent.ctx.get('skills')`；T-H8 用真 project skill 回归 |
| 用 `tools.schemas()` 当全量 | preset 工具在 UI 看不到、永远禁不掉 | 只用 `schemas(agent)` 且在 restrict 之前快照；T-H16 |
| `tools/change` 自递归 | CPU 打满 | 防重入标记；T-H12 |
| restrict 抛错被宽 catch 吞掉 | 该 agent 无 restrict，只靠 guard（token 没省） | catch 里 `logger.warn` 带 agentId；T-H6 |
| `remote.settings` 写失败 / revision 冲突 | UI 状态与磁盘不一致 | 乐观更新 + 失败 `load()` 对账；静默失败，不出 toast |
| settings namespace 被改名（patch id 变了） | 前端写不回去 | 启动自检 warn（`02` §2.2）；文档明示「`ns` = patch 行 id」 |
| 前端自绘浮层 | 被 0.2 的 UI spec 拒绝 / 材质不一致 | 用 `Menu`；`.wsMenu` 只调宽度 |
| 圆角/颜色用了不存在的 token | 深色主题失效 | 只用 `03` §6 列出的真名；**不存在 6px/5px 档** |
| 超椭圆圆角（平台级） | 圆角观感与纯直角矩形有细微差异 | 无法规避，写进验收清单（`03` §11 末条） |
| 本包崩溃 | profile 启动失败（fail-loud） | 所有 `agent/created` 处理器 try/catch；所有副作用可逆 |

**总体回退策略**：每个模块（guard / restrict / skill-gate / catalog / workspace-index / watch / redirect）独立 dispose，全部收口进 `index.ts` 的 `ctx.effect`。任一出问题 → 整个模块 stop/update 即回到 DSH 原生行为。最差情况：`dsh-magica-rune` 完全卸载，DSH 不受任何影响。

---

## 10. 实施 checklist（按阶段，每步可独立验证）

| 阶段 | 内容 | 验证点 |
|---|---|---|
| **S0 骨架** | `package.json` / `cordis.patch.yml` / `locale/*.json` / 构建脚本；`src/index.ts` 只有 `name`/`inject`/`Config`/空 `apply` | dev profile 装得上、能启动、`lib/index.js` 与 `lib/client.js` 产物形状正确 |
| **S1 配置层** | `config.ts` + `namespace.ts` + `state.ts` + `policy.ts` + 自检 | T-P1~P5 通过；配置能经 `settings.describe()` 读到；改配置触发 `loader/volatile-update` 不 remount |
| **S2 工作区** | `workspace.ts`（`findWorkspace`） | T-H13（载荷解构）+ agent 的 wsId 正确写入 `state.agentWorkspace` |
| **S3 guard** | `guard.ts` | T-H1~H3、T-H10；改配置立即生效 |
| **S4 restrict + assemble** | `restrict.ts`（`createScope`） | T-H4~H7、T-H12 |
| **S5 skill 遮蔽** | `skill-gate.ts` | **T-H8 / T-H9 必须先过**，否则整条 skill 通道不可信 |
| **S6 catalog** | `catalog.ts` + `router.ts` | T-H15、T-H16 |
| **S7 前端骨架** | `client/index.ts` + `AbilitySection.tsx` + CSS 骨架 + tab | 设置里出现「能力管理」，版式/字号/tab 与「插件」页**并排对比一致**；T-C5 |
| **S8 前端数据** | `controller.ts` + `store.ts` + 四态 | T-C8；loading/error/empty/ready 四态可见 |
| **S9 前端列表** | `categorize` + 分组 + `catColor` + 药丸 + 批量 | T-C1~C3；分组头（11px/600 标题 + 8px 色点，勾选右推）与药丸（高 28px、字号 13px、0.5px 描边、圆角 `--dsw-radius-sm`）逐项比对 `03` §5.5/5.6 的数值 |
| **S10 前端开关** | `effectiveState` + `toggle` + 乐观更新 | T-T1~T6；点一下立刻变色，刷新后保留 |
| **S11 两 zone + 下拉** | `Menu` 复刻工作区下拉 | 浮层材质正确、点外部关闭、切工作区自动展开 |
| **S12 确认 + tooltip** | `Modal`（含 `closeLabel`）+ `Tooltip`（含 `portal`） | 内置分类弹确认；1s 后出 tooltip 且不被滚动区裁剪 |
| **S13 i18n + 主题** | 两个 tab 的全量字典 + token 核对 | T-C7；切语言即时生效；浅/深都无「亮块」 |
| **S14 导航图标** | `nav-icon.ts` | 图标不是齿轮；切语言后仍正确；卸载后无残留标记与 `<style>` |
| **S15 收尾** | `.gitignore` / README / 全量回归 | 完整跑 §8 验证矩阵；确认全文无命令 / Agent 残留 |
