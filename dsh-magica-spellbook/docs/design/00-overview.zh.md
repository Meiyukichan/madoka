# dsh-magica-spellbook 设计总纲（DSH 0.2.0-rc.2）

> 状态：**设计定稿，可进入实现**。
> 目标运行时：`@deepseek-ai/dsh` **0.2.0-rc.2**（源码 `D:\project-code\llm\deepseek-harness`，tag `dsh-v0.2.0-rc.2`）。
> 素材基线：`docs/raw/a.md`–`o.md`（15 篇 / 10 759 行，剖析对象 `@amazing-tools/dsh-magica` **0.1.6-rc.26**）。
> 本文只写"设计"；0.1.6 的逐函数实现细节在 `docs/raw/`，不复述。

---

## 0. 读法与文档分工

| 文档 | 覆盖 | 读者 |
|---|---|---|
| **本文** `00-overview.zh.md` | 模块总览与计数、包/产物契约、依赖矩阵、**0.2 适配矩阵**、横切规则、测试与落地顺序、风险登记册 | 所有人先读这一篇 |
| [`01-core-utils.zh.md`](01-core-utils.zh.md) | 核心工具层：`logger` / `crypto` / `router` / `net` / `pricing` | 写 host 工具代码的人 |
| [`02-sessions.zh.md`](02-sessions.zh.md) | 会话运行内核：`core` / `store` / `workspace` / `ephemeral` / `approval` / `questions` / `ensure-workspace` | 写会话门面的人（最复杂） |
| [`03-interactions.zh.md`](03-interactions.zh.md) | 待决交互：host HTTP 面 + 线上契约 + 浏览器侧卡片/接管装配 | 写"吃掉请求又要把它显示出来"的人 |
| [`04-client.zh.md`](04-client.zh.md) | 浏览器侧目录选择器（`DirectoryBrowser`）及其产物契约 | 写 client 组件的人 |

约定：

- 本文写 `spellbook` 代码用 `src/<模块>/<文件>.ts:NN`；写 dsh 侧坐标用 `packages/<组>/<包>/src/<文件>.ts:NN`（相对 `D:\project-code\llm\deepseek-harness`）。
- **凡是标 ✅ 的 0.2 事实均已在本机 0.2.0-rc.2 源码中逐条核对**；标 ⚠️ 的是"必须实现时再核一次"的点，标 ❗ 的是"0.1.6 写法在 0.2 上会静默失效"的点。

---

## 1. 模块总览与计数

### 1.1 一级模块：6 个，忽略 lattice → **5 个**

`docs/raw/` 的 15 篇剖析按源码目录天然分成 6 个一级模块：

| # | 一级模块 | 源码目录 | 文件 / 行数 | 一句话职责 | 0.2 归属 |
|---|---|---|---|---|---|
| 1 | **client（浏览器侧）** | `src/client/**` | 12 / 2 624 | ① 嵌入式目录选择器；② 把宿主待决的提问/审批画进 dsh 会话页 | ✅ **spellbook** |
| core-utils | `logger` / `crypto` / `router` / `net` | 4 / 1 418 | 脱敏诊断日志、字段加解密、进站 HTTP 路由、内网出站 fetch | ✅ **spellbook** |
| 3 | **interactions（待决交互 host 面）** | `src/interactions/**` | 4 / 633 | 待决项的线上契约、归属判定、采集、HTTP 读写面 | ✅ **spellbook** |
| 4 | **sessions（会话运行内核）** | `src/sessions/**` | 8 / 5 046 | 程序化建会话、结局判定、台账、续跑、审批/提问接管、workspace 登记 | ✅ **spellbook** |
| 5 | **link（Issue⇄Task⇄Session 评论通道）** | `src/link/**`（+ `src/issue/**`、`src/task/**`） | ~23 | 让"下发方会话"与"执行方会话"通过云端评论双向对话 | ⛔ 随 lattice / teamwork 走 |
| 6 | **lattice（共享 Issue SDK）** | `src/lattice/**` | 22 / ~8 050 | 33 个外部 Issue 库端点的纯 TS 封装 | ⛔ **按指令忽略** |

> **结论（用户问的那个数）**：
> **一级模块共 6 个；排除 lattice 后是 5 个；其中 4 个进入 spellbook（client / core-utils / interactions / sessions），第 5 个 `link` 虽然也在 raw 素材里，但它的数据模型是 issue 台账 + task 台账 + 评论流，工程上归 lattice/teamwork，不属于"可复用的会话 SDK"。**

### 1.2 为什么 `link` 不算 spellbook（口径说明，避免争议）

1. **它的入口全是 lattice 的东西**：`src/link/**` 的七份文件（`comment` / `cursor` / `deliver` / `inbox` / `store` / `thread` / `types`）只服务 `lattice-link.json` + `comments/<anchorId>.jsonl`，上游写者 `CommentPublisher` / `IssueFinalizer` / `ArtifactUplink` 全在 `src/issue/**`。
2. **它没有"可被任意插件复用"的形状**：`deliver()` 的三档投递依赖具体宿主（`ExecutionService.steer()` / `handle.followup()` / `agents.resume`）。
3. **它需要的上游改动**（`docs/raw/n.md` §2 的 U1/U2：评论表加"方向 + 作者类型"两列、增量拉取改 `id` 游标）是**云端 API 契约变更**，与 spellbook 的"纯本地 SDK"定位冲突。
4. 结论：`link` 的设计已定稿在 `docs/raw/o.md`，迁移到 `dsh-magica-lattice` 的实施文档里，**spellbook 不承载**。

### 1.3 二级模块（spellbook 内实际交付单元）

| 一级 | 二级模块 | 文件 | 对外入口 | 依赖 dsh 运行时？ |
|---|---|---|---|---|
| core-utils | `logger` | 1（`core/logger.ts`） | 主入口 | 否（纯 `node:*`） |
| core-utils | `crypto` | 1（`core/crypto.ts`） | 主入口 | 否（`@primno/dpapi` 可选） |
| core-utils | `router` | 1（`core/router.ts`） | 主入口 | 否（只对 `node:http`） |
| core-utils | `net` | 1（`core/net.ts`） | 主入口（`undici` 保持 external + 惰性） | 否 |
| core-utils | `pricing` | 1（`core/pricing.ts`，表内联） | 主入口 | 否 |
| sessions | `core`（内核） | 1 | 主入口（部分内部） | 仅 `import type` |
| sessions | `store`（台账） | 1 | 主入口 + `./sessions` | 否（`ctx.get('dshHomePath')`） |
| sessions | `workspace`（正式门面） | 1 | 主入口 + `./sessions` | 是（`ctx.get`） |
| sessions | `ephemeral`（临时门面） | 1 | 主入口 + `./sessions` | 是（`ctx.get`） |
| sessions | `approval`（审批接管） | 1 | 主入口 + `./sessions` | 是（`ctx.on`） |
| sessions | `questions`（提问接管） | 1 | 主入口 + `./sessions` | 是（`ctx.on`） |
| sessions | `ensure-workspace` | 1 | 主入口 + `./sessions` | 是（`ctx.get`） |
| interactions | `types`（线上契约） | 1 | 主入口 + `./interactions` | 否（零 import） |
| interactions | `ownership` | 1 | 主入口 | 否 |
| interactions | `collect` | 1 | 主入口 | 否 |
| interactions | `route`（HTTP 面） | 1 | 主入口 | 否（`node:http` 类型） |
| client | `directory-browser` | 2（tsx + module.css） | **子路径** `./directory-browser`（raw TSX） | 是（primitives / react） |
| client | `interactions-panel`（卡片 + 接管） | 9 | 子路径 `./interactions`（编译后 ESM） | 是（primitives / react） |

计数口径：**spellbook = 4 个一级模块 / 18 个二级模块**（`pricing` 计入 core-utils）。若按"可独立 import 的入口"算则是 **4 个入口**：`.`、`./client`、`./directory-browser`、`./package.json`。

---

## 2. 设计原则（6 条，全部来自 0.1.6 踩过的坑）

| # | 原则 | 为什么 | 落地判据 |
|---|---|---|---|
| P1 | **库，不是插件**：spellbook 自己不带 `apply(ctx)`、不写 `dsh.bundle`、不进 cordis 组合 | 0.1.6 把 `src/client/**` 做成库再由消费插件打包，才有 `better-browser` / `lattice` 两套消费方；一旦自己变成插件就绑死一个宿主 | `package.json` 无 `dsh.bundle`；`export const inject` 只出现在文档示例里 |
| P2 | **构建产物零运行时 `@deepseek-ai/*` 导入** | 消费插件把 spellbook 打进自己的 bundle；一旦有裸 import，宿主没装那个包就 `ERR_MODULE_NOT_FOUND` | 发布前跑 `grep -R "from '@deepseek-ai/" lib/**/*.js`，除 `import type` 残留注释外必须为空 |
| P3 | **服务一律 `ctx.get(...)` + `undefined` 处理**，不用 `inject` | 库没有 fiber，`inject` 无处解析；AGENTS 二.4 也要求可选 service 用 `ctx.get` | 只有 `resolveAgents` / `createWorkspace` 这类"调用时硬要求"才手写抛错 |
| P4 | **同一份线上契约两个进程共用**：`types.ts` 是叶子节点，零 import | host 路由与浏览器 transport 共用 `INTERACTION_PREFIX` / `INTERACTION_PATHS`，路径永不打两边各写一份而漂移 | `src/interactions/types.ts` 的 `import` 语句数必须为 0 |
| P5 | **副作用必须可逆**：监听、timer、挂住的 Promise、`<style>`、effect 登记全部有归属回收点 | 0.1.6 的 `manageWaterfallListener` 曾经漏收 `ctx.effect` 的 disposer，长驻进程线性泄漏 | 每个 `ctx.on` / `ctx.effect` / `setTimeout` 都能在 `dispose()` 链上找到唯一调用点 |
| P6 | **静默降级必须有可观测出口** | 0.1.6 有 7 处静默降级（`agentPresets` 缺失、台账不可用、`attachError`、`sessionTitle` …），全部只能靠调用方读 state | 每个降级点要么进 `state.*`、要么进 `loadErrors`、要么 `warn`；不允许"什么都不说" |

---

## 3. 包形态与产物契约（0.2 · pnpm · `lib/` 两文件）

### 3.0 三条硬约束

| # | 约束 | 出处 |
|---|---|---|
| C-1 | **pnpm workspace 构建**，版本统一 **`0.2.0-alpha.1`** 起 | 仓库约定（`pnpm-workspace.yaml`） |
| C-2 | **`lib/` 只有两个 JS 文件：`lib/index.js` + `lib/client.js`，且都是压缩源码** | 仓库约定 |
| C-3 | **spellbook 是库，不是插件**：无 `dsh.bundle`、无 `cordis.patch.yml`、无 `apply(ctx)` 导出 | §2 P1 |

C-2 带来的直接后果（相比 0.1.6 是**结构性简化**）：

- 不再有 `lib/sessions/`、`lib/interactions/`、`lib/proxy-fetch.js` 这些子路径产物 → **`exports` 收敛到 4 条**；
- 所有 host 代码打进**一个** `lib/index.js`，所有浏览器代码打进**一个** `lib/client.js`（`proxy-fetch` 的惰性 `undici` 靠 bundler `external` + `createRequire` 保住，见 §3.5）；
- 声明文件只有一份：`lib/types/index.d.ts`（`lib/` 里除两个 JS 外只剩它，属类型产物不占 JS 槽位）。

### 3.1 目录结构（优化后）

```
dsh-magica-spellbook/
├── package.json                 # 唯一包；version 0.2.0-alpha.1；无 dsh 字段（库）
├── pnpm-workspace.yaml          # packages: ['.']（预留 packages/*）
├── pnpm-lock.yaml
├── .npmrc                       # store/cache/virtual-store 全部留在包内
├── tsconfig.json                # typecheck（noEmit，host + client 全覆盖）
├── tsconfig.dts.json            # 声明产物 → lib/types/**
├── .gitignore                   # lib/ node_modules/ .pnpm-store/ .pnpm-cache/ .corepack/
├── README.md
├── scripts/
│   ├── build.mjs                # 调 esbuild CLI 打两个 bundle（见 §3.4）
│   ├── rm.mjs                   # 清 lib/
│   ├── verify.mjs               # §3.6 的六条断言
│   └── set-version.mjs          # 全仓 dsh-magica-* 版本同步（0.2.0-alpha.1）
├── src/
│   ├── index.ts                 # ★ host 唯一入口（re-export 全部 host 面）
│   ├── shared/
│   │   ├── wire.ts              # 线上契约：零 import，host 与 browser 共用
│   │   └── dsh.ts               # dsh 0.2 契约的**结构面**（带源码坐标，见 D-3）
│   ├── core/                    # 一级模块 core-utils
│   │   ├── logger.ts            # 脱敏诊断日志（原 event-log.ts）
│   │   ├── crypto.ts            # 字段加解密（原 field-crypto.ts）
│   │   ├── router.ts            # 进站 HTTP 路由（原 http-route.ts）
│   │   ├── net.ts               # 内网出站（原 proxy-fetch.ts）
│   │   └── pricing.ts           # 定价（pricing/ 目录 + prices.json 已合并成单文件）
│   ├── sessions/                # 一级模块 sessions（8 文件）
│   │   ├── index.ts  core.ts  store.ts
│   │   ├── workspace.ts  ephemeral.ts
│   │   ├── approval.ts  questions.ts
│   │   └── ensure-workspace.ts
│   ├── interactions/            # 一级模块 interactions（host 面）
│   │   ├── index.ts  ownership.ts  collect.ts  route.ts
│   └── client/                  # 浏览器侧（打进 client.js）
│       ├── index.ts             # ★ client 唯一入口（导出组件/工厂，无 apply）
│       ├── primitives.d.ts      # primitives 的最小类型面（shell 注入，不是我们的依赖）
│       ├── panel/               # 卡片 + 接管（字符串样式，无 CSS 文件）
│       │   ├── index.ts  Card.tsx  Composer.tsx
│       │   ├── carrier.ts  runtime.ts  surface.ts  transport.ts
│       │   └── styles.ts  locales.ts
│       └── directory-browser/   # 可嵌入组件（额外以源码形式导出，见 §3.7）
│           ├── DirectoryBrowser.tsx
│           ├── DirectoryBrowser.module.css
│           └── globals.d.ts
├── lib/                         # ★ 构建产物：只有两个 JS（压缩）+ 声明
│   ├── index.js                 #   ESM，minify
│   ├── client.js                #   ESM，minify，React 等 externals 保持裸 import
│   └── types/**                 #   tsc 声明（index.d.ts + client/** + core/** + sessions/** …）
├── tests/                       # node:test，按模块镜像（102 例）
│   ├── helpers/                 # fake.ts（ctx/req/res）、fake-agent.ts
│   ├── core/                    # logger / crypto / router / pricing
│   ├── sessions/                # core / store / observers / facade
│   ├── interactions/            # route（4 端点 × 闸门/归属/错误码）
│   └── client/                  # carrier / locales / styles / transport
└── docs/                        # 本目录（README.zh.md + design/ + raw/）
```

与 0.1.6 / 上一版的差异（都是净收益）：

| 优化 | 之前 | 现在 | 为什么 |
|---|---|---|---|
| 产物数量 | 每模块一个 JS + 多个子路径 | **2 个压缩 JS** | 与仓库约定一致；`files`/`exports` 漏配的可能性归零 |
| 入口数 | 6 条（`. / ./sessions / ./interactions / ./proxy-fetch / ./directory-browser / ./client`） | **4 条**（`. / ./client / ./directory-browser / ./package.json`） | 子路径入口在 0.2 会被当作独立插件行（只有 host 半侧），维护面更大 |
| 共享契约位置 | `src/interactions/types.ts`（在 host 模块里，却被 client 引用） | **`src/shared/wire.ts`** | 打两个 bundle 时它必须被两边各自内联，放在"中立层"最不容易被误改 |
| 构建器 | tsc + tsdown + esbuild + lightningcss | **esbuild CLI + tsc**（职责单一） | 打包/压缩交给 esbuild，类型交给 tsc；不引入 tsdown 的 rolldown 原生依赖 |
| `core/` 命名 | `event-log` / `field-crypto` / `http-route` / `proxy-fetch` + `pricing/` 目录 | `logger` / `crypto` / `router` / `net` / `pricing.ts` | 短名单词、与模块职责一一对应；`pricing` 不再需要旁路 JSON 资产 |
| `clsx` | peer/dep | **不要**（内联 `cx`） | 少一个消费方必须装的包；目录选择器只用一个函数 |

### 3.2 pnpm 配置（三个文件，直接照抄）

`pnpm-workspace.yaml`：

```yaml
# spellbook 是单包工程；'.' 必须在列表里，否则 pnpm 不认它是 workspace 成员。
# packages/* 是预留：将来若把 client 面板拆成独立包（见 §3.7 备选 B）不必改这里。
packages:
  - '.'
  - 'packages/*'
```

`.npmrc`（与 `dsh-magica-teamwork` 完全一致：包管理状态全部留在包内，避开受限权限下 pnpm 全局 store 锁的 EPERM）：

```ini
store-dir=./.pnpm-store
cache-dir=./.pnpm-cache
virtual-store-dir=./node_modules/.pnpm
fund=false
audit=false
verify-deps-before-run=false
```

`package.json` 里的 pnpm 事实：

```jsonc
"packageManager": "pnpm@11.7.0",   // 与 dsh 根一致；corepack 据此锁定
"engines": { "node": ">=22.5", "pnpm": ">=11" }
```

### 3.3 `package.json`（完整字段）

```jsonc
{
  "name": "dsh-magica-spellbook",
  "version": "0.2.0-alpha.1",
  "type": "module",
  "license": "MIT",
  "packageManager": "pnpm@11.7.0",
  "engines": { "node": ">=22.5", "pnpm": ">=11" },
  "main": "./lib/index.js",
  "types": "./lib/types/index.d.ts",
  "exports": {
    ".":                   { "types": "./lib/types/index.d.ts", "import": "./lib/index.js" },
    "./client":            { "types": "./lib/types/index.d.ts", "import": "./lib/client.js" },
    "./directory-browser": { "default": "./src/client/directory-browser/DirectoryBrowser.tsx" },
    "./package.json":      "./package.json"
  },
  "files": ["lib", "src/client/directory-browser", "README.md"],
  "scripts": {
    "build": "pnpm build:clean && pnpm build:js && pnpm build:dts",
    "build:clean": "node scripts/rm.mjs lib",
    "build:js": "node scripts/build.mjs",
    "build:dts": "tsc -p tsconfig.dts.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "verify": "pnpm build && node scripts/verify.mjs",
    "test": "node --test --test-isolation=none \"tests/**/*.test.ts\"",
    "version:set": "node scripts/set-version.mjs",
    "clean": "node scripts/rm.mjs lib"
  },
  "dependencies": {
    "undici": "^7.16.0"
  },
  "optionalDependencies": {
    "@primno/dpapi": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.20.5",
    "@types/react": "^19.2.0",
    "esbuild": "^0.25.10",
    "react": "^19.2.0",
    "typescript": "^5.9.3"
  }
}
```

设计说明：

1. **没有 `dsh` 字段**（C-3）。`dsh.client` 只在"这个包会被 `dsh plugin add` 装进 profile、且 shell 直接加载它的 `./client`"时才需要；spellbook 的消费方是**插件**，它们在构建期把 spellbook 打进自己的 bundle。缺 `dsh.client` 而声明 `./client` 会让 Host 扫描报错——所以两者要么都有、要么都没有，这里选"都没有"。
2. **`exports` 只有 4 条**，与 C-2 对齐。`./directory-browser` 是唯一的源码直出例外（§3.7）。
3. **没有任何 `@deepseek-ai/*` 依赖**（决策 D-3）：连类型也不 import（`src/shared/dsh.ts` 是手写结构面）。这不只是"少装几个包"——npm 上 `0.2.0-rc.2` 家族**并未全部发布**（如 `dsh-agent-presets` 只到 `0.1.x`），一旦写进 `peerDependencies`，`pnpm install` 会直接解析失败。AGENTS §一.5 的"peer + dev"约定针对的是**要共享宿主实例的插件**；spellbook 零运行时导入，不适用。
4. **`undici` 进 `dependencies`（不是 peer）**：它是我们自己的实现细节，消费方不该被迫选版本。
5. **`@primno/dpapi` 进 `optionalDependencies`**：非 Windows 安装不该失败；运行期用 `createRequire` 探测，缺了降级 AES-256-GCM。
6. **`test` 固定 `--test-isolation=none`**：默认隔离模式会给每个测试文件起子进程并接管管道，受限沙箱下会 `EPERM`；同时它也让 102 例跑在同进程里（更快）。
7. **运行时范围怎么声明**：写在 `README.md` 与本文 §5，而不是 `peerDependencies`。0.2 的 peer 校验（`packages/boot/app-boot/src/plugin-compatibility.ts:52-98`，`includePrerelease: true`）只对"被装进 profile 的插件行"生效，spellbook 不是插件行。

### 3.4 构建管线（esbuild CLI 打包 + tsc 出声明）

```
pnpm build
├── build:clean   node scripts/rm.mjs lib          # 先清，保证 lib 只有 2 个 JS
├── build:js      node scripts/build.mjs           # esbuild CLI ×2（stdio: 'inherit'）
│                                                   # → lib/index.js + lib/client.js（均 minify）
└── build:dts     tsc -p tsconfig.dts.json         # → lib/types/**（index.d.ts + 各模块 .d.ts）
```

`scripts/build.mjs` 的实际参数：

| 项 | host（`lib/index.js`） | client（`lib/client.js`） |
|---|---|---|
| entry | `src/index.ts` | `src/client/index.ts` |
| format / platform / target | `esm` / `node` / `node22` | `esm` / `browser` / `es2022` |
| jsx | — | `--jsx=automatic` |
| `--minify` | ✅ | ✅ |
| `--legal-comments=none` | ✅ | ✅ |
| external | `undici` / `@primno/dpapi` / `@deepseek-ai/*` | 平台模块表 9 项（§3.5） |
| define | — | `process.env.NODE_ENV` / `import.meta.env.MODE` → `"production"` |
| sourcemap | 不发布（`lib/` 只留两个文件）；需要时临时加 `--sourcemap` | 同 |

**为什么调 esbuild CLI 而不是它的 JS API**：JS API 会 `spawn` 一个用管道通信的常驻子进程；受限沙箱禁止管道子进程（`EPERM`）。CLI 通过 `spawnSync(..., { stdio: 'inherit' })` 运行，stdio 直通即可。

**为什么 `undici` 必须 external**：`core/net` 的惰性加载靠 `createRequire(import.meta.url)('undici')`（`01-core-utils` §4.3）。如果把 `undici` inline 进 `index.js`，"没装 undici 也能 import 主包"的性质就没了；标 external 后产物里保留 `require('undici')`，加载点仍在 `createProxyFetch()` 执行时。

**为什么 `minify: true` 而不做"可读产物"**：C-2 明确要压缩源码；调试靠 `tests/` 直接跑 `src/`（Node 类型擦除），不依赖读产物。

### 3.5 `client.js` 是 ESM bundle，不是闭包工厂（关键决策 D-2）

| 形态 | 谁用 | 我们要不要 |
|---|---|---|
| **闭包工厂** `window.__ModuleLoader__.load({ id, factory })` | 被 shell **直接加载**的插件 client 半 | ❌ spellbook 不是插件，shell 不加载它 |
| **ESM bundle**（保留裸 `import` 的 externals） | 被**消费插件的 bundler**按需内联、可 tree-shake | ✅ 当前形态 |

所以 `lib/client.js` 的第一行就是 `export ...`，而不是 `window.__ModuleLoader__.load`。

但**external 白名单不变**（因为最终仍要进 shell 模块表）✅ `packages/client/web/src/platform.ts:8-16`：
`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。
其余依赖必须打进 `client.js`，不能留裸 import。

**切换开关**：若将来要让 spellbook 的卡片面板作为"独立可加载插件"（例如把 `conversation.composer` 接管做成开箱即用），只需在 `scripts/build.mjs` 的 client 一档加 `--format=cjs` + 三段 banner/footer，并把 `package.json` 的 `dsh.client` 补上——**代码不用改**。这是把"库 / 插件"两种形态留在构建层的原因。

**CSS 策略（与两文件约束的配合）**：

| 来源 | 形态 | 说明 |
|---|---|---|
| `client/panel/**` | **无 CSS 文件**，样式是 `styles.ts` 的字符串（约 45 条规则） | 天然满足"单文件产物"；`tsc`/bundler 不需要 CSS 管线 |
| `client/directory-browser/*.module.css` | 只在 §3.7 的源码入口里存在 | 由消费方编译；**不进 `client.js`** |

如果将来把目录选择器也编进 `client.js`，需要 lightningcss 把模块 CSS 编成字符串并在工厂执行期注入带 `data-plugin` 的 `<style>`（AGENTS §一.4）——此时"两文件 + CSS Modules"同时成立，代价是构建链多一步。

### 3.6 校验脚本断言（`pnpm verify`）

1. `lib/` 里 **恰好两个 `.js`**：`index.js`、`client.js`（多一个就 fail）。
2. 两个文件都**被压缩过**：`index.js` 行数 < 40 且无 4 空格缩进的代码行；`client.js` 同理。
3. `index.js` **零运行时 `@deepseek-ai/*` 导入**（`import ... from '@deepseek-ai/...'` 只允许出现在 `import type` 已被擦除后为 0）。
4. `client.js` 的裸 import **只在平台白名单内**（正则抽取所有 `from "..."` / `require("...")` 与白名单求差，必须为空）。
5. `index.js` **保留了 undici 的惰性加载点**：同时出现 `createRequire` 与 `"undici"` 字面量（证明没被 inline 掉）。
6. `package.json` 的 `exports` 目标文件全部存在。

> 运行时范围（`>=0.2.0-rc.2`）不再写进 `peerDependencies`（见 §3.3 说明 3），所以第 6 条不再校验 semver；需要自动校验时，由消费插件在自己的 `peerDependencies` 里声明。

### 3.7 唯一源码入口：`./directory-browser`（例外 D-1）

`lib/` 只有两个 JS，无法同时提供"可被别的插件当组件 import 的裸组件"和"单文件产物"。而 `DirectoryBrowser` 的产品价值恰恰是**嵌入别人的设置面板**（0.1.6 的两个消费方都是这么用的）。

因此保留**一条源码直出的例外**：`"./directory-browser": "./src/client/directory-browser/DirectoryBrowser.tsx"`。

- 不违反 C-2：它不在 `lib/` 里。
- 代价（必须写进 README）：消费方 typecheck 要包含该 `.tsx`；消费方 bundler 要支持 `.tsx` + `.module.css`；`files` 必须含 `src/client/directory-browser`。
- **备选 A**（若要求零例外）：把目录选择器也编进 `client.js`，去掉这条 `exports`，届时"嵌入"只能靠消费方**自己 fork** 组件，或由我们把面板做成独立的 slot occupant。
- **备选 B**（若既要不占 `lib/` 又要可复用）：把它拆成独立子包 `packages/directory-browser`（`pnpm-workspace.yaml` 已预留 `packages/*`），该子包自己满足"两文件"约定（`index.js` 导出组件 + `client.js` 提供样式注入版），主包只依赖它。

### 3.8 真机 E2E（dev profile）与它抓出的 0.2 破坏性变更

按 `dsh-plugins-principles` §五 的 dev profile 隔离跑真机：`DSH_HOME` 指到工作区内的 `.e2e/dsh-home`，profile `dev` 只装 `dsh-base + dsh-web-app + dsh-spellbook-e2e`，模型侧接一个**脚本化 Messages mock**（dsh 的 deepseek 适配器只讲 Messages SSE，仓库自带的 `llm-mock-server` 讲 OpenAI chat/completions，对不上）。

结果：基础场景 **14/14**、看门狗 **1/1**、提问接管 **7/7**、审批接管 **5/5**（合计 27 项断言）。

它抓到 5 个**单元测试与静态审查都看不出来**的问题，全部是"0.2 与 0.1.6 的隐性差异"：

| # | 现象（真机） | 根因 | 修法 |
|---|---|---|---|
| 1 | 带 `?id=...` 的 `GET /e2e/state` 返回**空体 404** | `createJsonRouter` 用 `request.url`（含 query）做路径段匹配 | 匹配前只取 pathname（`router.ts` 的 `pathnameOf`），补回归 test |
| 2 | 首个 turn 以 `prompt variable "{{model}}" has no value` 收场 | dsh 的 `agentDefaultModel` 是**拉取式**服务（`currentSelection()`），dsh 自己的入口会查它并填 `agentOptions`；库不查 → agent 没有模型路由 | 新增 `pickModel(ctx, explicit, record)`：显式 → 台账 → `agentDefaultModel` → 否则**同步抛** `no model route`（不要建出没模型的 agent） |
| 3 | turn 以 `format v4 message requires a producer-owned source kind` 收场 | 会话格式 v4 **明确拒绝** `source.kind === 'plugin'`（`session-format-v3-to-v4/src/message-sources.ts`：`refuses retired plugin wrappers`） | `buildPluginMessage` 永远发具名 kind：有 section 用 section，没有用 `spellbook-context`；`section === 'plugin'` 直接抛错 |
| 4 | `noInteraction: false` 时提问被**自动答否**，接管端永远等不到待决项 | 临时门面**无条件**安装 fail-fast 应答器 | `installInteractionHandlers()` 在 `noInteraction === false` 时直接 return，把提问/审批留给上层（GUI 或插件自己的 HTTP 面） |
| 5 | 续跑失败只给出字符串 `session "…" is already owned by an active write handle`，`errorCode` 恒为 `undefined` | 0.2 同一 `sessionId` 只允许一个**写 handle**；而门面的 `resumeAgent` 把 dsh 的结构化错误重新包成普通 `Error` | 两个门面的 resume 都过 `toResumeError`，新增分类 `SESSION_ALREADY_ACTIVE`（提示"先 dispose 持有它的 handle"） |
| 6 | 正式会话的输入框选择框**整块崩溃**：React #130（element type is invalid），控制台 `slot entry crashed in 'conversation.composer'` | `@deepseek-ai/dsh-client-ui-primitives` 在 0.2 **不再导出任何 `Icon*Outline*`**（`lib/types/index.d.ts` 只有 Button/Pill/Tag/Modal/Menu 等），我们 import 的 8 个图标全是 `undefined` | 新增 `src/client/panel/icons.tsx`：11 个内联 SVG（`currentColor` + `size`）；Card / DirectoryBrowser 改为从它 import |
| 7 | 选择框永不注册（slot occupant 只有官方 `mf`），且**零报错** | slot 注册选项里带了 0.1.6 才有的 `registrant`，0.2 的 `register` 直接抛；装配处用 `try/catch` 静默吞掉 | 删掉 `registrant`；`catch` 改 `console.warn`，并加 `surface.debug` 钩子（真机上这类失败必须可见） |

顺带修掉一个文案 bug：`ttlMs: 120` 曾显示「0 分钟未完成」→ 新增 `formatDuration`（毫秒 / 秒 / 分钟）。

**这 5 条都要写进"0.2 适配矩阵"**（§5），因为它们是升级时最容易静默踩中的部分：不报类型错、只在跑起来时以奇怪的运行时错误出现。

### 3.9 落地状态（本机实测）

| 项 | 状态 | 证据 |
|---|---|---|
| `pnpm install` | ✅ exit 0 | `allowBuilds` 全 false（沙箱禁止 pnpm 用管道 spawn 子进程） |
| `pnpm typecheck` | ✅ exit 0 | `tsc -p tsconfig.json --noEmit`（host + client 全量） |
| `pnpm test` | ✅ **115 例全绿** | `node --test --test-isolation=none` |
| `pnpm build` | ✅ exit 0 | `lib/index.js` 53.6 KB、`lib/client.js` 17.7 KB、`lib/types/**` |
| `pnpm verify` | ✅ exit 0 | 两个压缩 JS / 零 dsh 运行时导入 / client 裸 import 白名单 / undici 仍惰性 |
| **真机 dev profile E2E** | ✅ **27 项断言全过** | 基础 14/14、看门狗 1/1、提问接管 7/7、审批接管 5/5（§3.8） |
| core-utils | ✅ 已完成 | logger（11 条脱敏 + 周轮转 + 熔断）、crypto（DPAPI/AES + 并发首建）、router（6 阶段闸门 + 参数路由）、net（惰性 undici + 代理 + 并发限）、pricing（三层匹配） |
| sessions | ✅ 已完成 | core / store / workspace / ephemeral / approval / questions / ensure-workspace |
| interactions | ✅ 已完成 | 线上契约、归属判定（含进程内白名单）、采集、4 端点 + 闸门 |
| client | ✅ 已完成 | 卡片（提问流 + 审批流）、接管装配、载体、传输、样式注入、目录选择器 |
| `tests/contracts/` 数据驱动表 | ⏳ 未做 | 264 条 0.1.6 契约目前以**逐条 test()** 形式覆盖了其中高价值部分；表驱动迁移留到 P4 |
| `plan-review` 意图分流 | ⏳ 未做 | 线上契约已透传 `intent` / `wait`，卡片仍走通用问答流 |
| 目录选择器的 `@media` 无障碍 | ⏳ 未做 | 见 `04-client` §8.1 第 9/10 条 |

---

## 4. 依赖矩阵

### 4.1 host 侧（按模块）

| 模块 | dsh 包（**结构面，不 import**） | dsh service（`ctx.get` / `ctx.on`） | 网络 |
|---|---|---|---|
| logger | — | 可选 `logger`（实测拿不到，见 4.3） | — |
| crypto | — | — | — |
| router | — | — | — |
| net | — | —（**刻意不用** `ctx.web.fetch`） | 出站 `undici` |
| pricing | — | — | — |
| sessions core | `shared/dsh.ts` 里的 `DshAgentRegistryLike` / `DshAgentHandleLike` / `DshSessionLike` / `DshTurnEndReason` / `DshAgentPresetsLike` / `DshPermissionPresetsLike` … | `agents`、`permissionPresets`、`agentPresets`、`sessionTitle`、`dshHomePath` | — |
| sessions store | `DshHomePath` | `dshHomePath` | — |
| sessions facades | 同上 + `DshWorkspaceRegistryLike` | 同上 + `workspaceRegistry` | — |
| interactions | —（零 import） | `dshHomePath`（经 store） | — |
| client（浏览器） | `client/primitives.d.ts` 声明 primitives 的最小面 | `uiSession`、`slots`（运行时结构面） | 同源 `fetch` |

### 4.2 事件（spellbook 注册 / 消费）

| 方向 | 事件 | 模式 | 注册选项 | 0.2 核对 |
|---|---|---|---|---|
| 注册 | `approval/request` | waterfall（agent-scoped） | `{ prepend: true, global: true }` | ✅ `packages/interaction/user-approval/src/types.ts:87-92` |
| 注册 | `user-questions/request` | waterfall（agent-scoped，`agent` **可选**） | `{ prepend: true, global: true }` | ✅ `packages/interaction/user-questions/src/types.ts:157-162` |
| 注册 | `agent/pre-step` | waterfall（agent-scoped） | `{ prepend: true }`（**不需要** `global`，注册在 agentCtx 上） | ✅ `packages/core/agent/src/runtime-types.ts:320` |
| 注册 | `session/event` | emit（agent-scoped） | 无 | ✅ `packages/core/session/src/index.ts` |
| 注册 | `agent/disposed` | emit（agent-scoped） | 无 | ✅ `packages/core/agent/src/runtime-types.ts` |
| 消费 | `assistant/message` / `turn/end` / `tool/call` / `tool/result` | 会话日志事件 | — | ✅ `packages/core/session/src/types.ts:297,341,361,375` |
| 消费 | `approval/asked` / `approval/decided` / `approval/policy` | 会话日志事件 | — | ✅ |
| 消费 | `sandbox/mode` | 会话日志事件 | — | ✅ `packages/sandbox/sandbox-policy/src/index.ts:138` |
| 消费 | `plan/mode` | 会话日志事件 | — | ✅ `packages/plan/plan-mode/src/index.ts:53,434` |

### 4.3 三条"以为有其实没有"的依赖（0.1.6 实测，0.2 未变）

| 误以为 | 实际 | 处置 |
|---|---|---|
| `ctx.logger` 是 service，可 `ctx.get('logger')` | `logger` 是 cordis 根 context 的**自有属性**（`vendor/cordis/src/context.ts`），`ctx.get` 只查 service store → 标准部署返回 `undefined` | `warnLedgerWriteFailure` 的三级降级保留：`ctx.get('logger').warn` → `process.stderr.write` → 放弃。**不要**把告警只接到 logger |
| `ctx.userQuestions` / `ctx.approval` 有 `answer()` / `cancel()` / `list()` | 都没有。服务名分别是 `userQuestions` 和 **`approval`**（不是 `userApproval`），对外只有 `ask()` / `request()` | 结算的唯一途径就是**自己 hold 住 waterfall 的 Promise 并 resolve/reject** |
| `session.append('sandbox/mode')` 需要一个 `setSandboxMode()` 助手 | dsh 把 sandbox-policy 折在内部，ESM 导入会 `ERR_MODULE_NOT_FOUND` | 直接 `session.append('sandbox/mode', { mode })` |

---

## 5. 0.2.0-rc.2 适配矩阵（★ 全仓库最重要的一张表）

> 左侧是 `docs/raw/` 记录的 0.1.6 事实，右侧是本机 0.2.0-rc.2 的真实情况。**标 ❗ 的项如果照抄，运行时不会报错，但功能静默失效。**

| # | 0.1.6 的写法 / 假设 | 0.2.0-rc.2 事实 | 处置 |
|---|---|---|---|
| 1 | `TURN_END_KINDS = ['completed','aborted','blocked','error','max-tokens','interrupted']`（6 个） | ❗ `TurnEndReasonMap` 多了 **`forked`**（fork 播种时关闭源会话里仍开着的 turn）→ **7 个** | 常量表改成 7 个并保留双向子类型断言；`never` 兜底分支保留 | ✅ `packages/core/session/src/types.ts:201-229` |
| 2 | `turn/end` 只有 `{ turn, reason }` | ✅ 未变 | 不动 | ✅ `:297` |
| 3 | `error` 变体是 `{ kind:'error'; error: LlmFailure }` | ✅ 未变（`LlmFailure` 来自 `dsh-llm`） | `describeTurnEnd` 的 `?? 'unknown'` 兜底保留 | ✅ `:212` |
| 4 | `AskUserQuestionRequestEvent = { questions, agent?, signal? }` | ✅ 多了 `wait?: { callId; timed? }`；`AskUserQuestionItem` 多了 `intent?: { kind:'plan-review'; approve; callId? }` | 线上契约要**透传** `intent` 与 `wait`；卡片支持 `plan-review` 分流（0.1.6 缺这个功能） | ✅ `packages/interaction/user-questions/src/types.ts:24-35,129-146` |
| 5 | 提问**没有任何会话日志事件**，只能自己记 `eventLog` | ❗ 0.2 新增 `SessionProjectionMap.userQuestions`（`{ active: PendingUserQuestion[]; settled: SettledUserQuestion[] }`）与 `MessageSourceMap['user-question-reply']`，**timed `ask_user_question` 可从会话日志重建**；blocking 旧工具仍不入两侧 | ① 自己的 pending 表仍**必须**保留（结算只能靠它）；② 展示层可以额外用投影做"崩溃后仍可见"的证据；③ 日志留痕策略要重估 | ✅ `packages/interaction/user-questions/src/types.ts:74-126` |
| 6 | `ApprovalRequestEvent = { agent, toolName, callId?, reason?, signal? }` | ✅ 多了 `displayReason?: { en: string; [locale: string]: string }`，且**明确"不持久化到审批审计事件"** | 卡片优先展示 `displayReason[locale]`，回退 `reason`；**不要**把它写进 `PendingInteractionRecord` 的持久字段 | ✅ `packages/interaction/user-approval/src/types.ts:63-76` |
| 7 | `ApprovalOutcome` 四值闭集 | ✅ 未变（`'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'`） | `APPROVAL_OUTCOMES` 双向断言保留；HTTP `decision` 仍收窄两值 | ✅ `:32` |
| 8 | `agents.create(meta: { cwd, agentPreset })` / `agents.resume({ resumeSessionId, agentOptions, setup })` | ✅ 未变；`CreateAgentOptions.meta` 另含 `parentSession` / `isSeeded` / `origin` / `delegationDepth` | 只用 `cwd` + `agentPreset`，其余保持缺省 | ✅ `packages/core/agent/src/index.ts:63-144` |
| 9 | `AgentSetup` 返回 `{ commit(): void }` 或 `undefined` | ✅ 签名变成 `(agentCtx, agent)` 两参；返回 `AgentSetupCommit \| Promise<AgentSetupCommit\|void> \| void` | 我们的 `makeSetup()` 要接受两个参数（忽略第二个即可）；运行时形状兜底保留 | ✅ `:51-54` |
| 10 | `Agent.whenIdle()` 是唯一等待点 | ✅ 未变，且 0.2 另有 `runMaintenance()` | 看门狗（`idleTimeoutMs`）必须**在门面层真正传入**（0.1.6 是死代码，见 6.3） | ✅ `packages/core/agent/src/runtime-types.ts:191` |
| 11 | `agent/pre-step` 决策是 `{ kind:'enter', messages }` / `{ kind:'reject' }` | ✅ 未变；`enter` 多了 `startsRequestSeries?: true` | 追加 `messages` 时必须**展开保留**原 `decision` 其余字段（含新字段） | ✅ `:112-119` |
| 12 | `permissionPresets.defaultPreset` / `set(session, name)`；`'read-only'` 不是预设名 | ✅ 未变；`defaultPreset` 是 `Volatile`，composed 默认不匹配任何预设时 `apply` 直接抛 | 三级回退保留；`'read-only'` 走 `session.append('sandbox/mode')` 降级路径 | ✅ `packages/interaction/permission-presets/src/index.ts:171,223-225` |
| 13 | `sessionTitle.rename(session, title)` 同步 | ✅ 未变（`rename` 返回快照，用户来源的 rename 会 `supersede` 自动生成） | 保留 `try/catch`，标 cosmetic | ✅ `packages/session/session-title/src/index.ts:401` |
| 14 | `workspaceRegistry.{create,get,resolveByPath,list}`；`workspace.attachSession(sid)` | ✅ 未变；`attachSession` 校验 `header.cwd` 与 workspace path 严格相等 | 保留 `attachError` 静默降级；`cwd` 必须是 canonical path | ✅ `packages/workspace/workspace/src/index.ts:236,280,500`；`entity.ts:109-143` |
| 15 | `uiSession.registerPendingInteraction(precedence)` | ✅ 未变（`SessionPendingInteractionBase` = `key` / `kind` / `sessionId`；同 `key` 重复发布抛 `ui-session: duplicate pending interaction key`） | 载体 key 继续用 `${kind}:${id}` | ✅ `packages/client/ui-session/src/client/index.ts:40-47,391-410` |
| 16 | `conversation.composer` 是 `{ kind:'chain', scope:'session' }` | ✅ 未变（owner `ComposerChainProps`） | `select` 仍只认带 `INTERACTION_TAG` 的载体 | ✅ `packages/client/ui-conversation/src/client/contract/slots.ts:187` |
| 17 | `locale.register(ns, 'zh', dict)` 单语言形参 | ✅ 两种重载都在：`(ns, locale, dict)` 与 `(ns, { zh, en })`；同 `(ns, locale)` 重复注册抛错 | 统一用对象形 `register(ns, { zh, en })`，两份字典键集必须一致 | ✅ `packages/client/locale/src/client/index.ts:399-410` |
| 18 | `Button` 只有 `primary` / `ghost` / `outline` | ✅ 多了 **`toolbar`**；`MarkdownText` 需要 `labels`；`MarkdownDelegateProvider` 管链接委托 | 卡片/选择器的 `variant` 显式写，不依赖默认值 | ✅ `packages/client/ui-primitives/README.md:37-75` |
| 19 | 平台模块表 = 8 个 specifier | ✅ 9 个（多了 `@deepseek-ai/dsh-client-ui-dockkit`） | externals 从平台表派生，不硬编码 | ✅ `packages/client/web/src/platform.ts:8-16` |
| 20 | `plugin-compatibility` 不看 `engines.dsh` | ✅ 只看 `peerDependencies` 里的 dsh 家族，`includePrerelease: true`，不满足即禁用/拒装 | `engines.dsh` 只作声明；真正护栏是 `peerDependencies` | ✅ `packages/boot/app-boot/src/plugin-compatibility.ts:52-98` |
| 21 | `webServer.register({kind,path,handler})` 重复 `(kind,path)` 抛错 | ✅ 未变 | 一个进程只能有一个消费方挂同一前缀；`options.prefix` 要能改 | ✅ `packages/host/webserver/src/index.ts` |
| 22 | `ctx.get('dshHomePath')` 由 `app-boot` provide | ✅ 未变 | 台账目录解析不出时**降级为 null**，不抛 | ✅ `packages/boot/app-boot/src/index.ts` |
| 23 | `createJsonRouter` 用 `request.url` 直接切路径段（0.1.6 如此） | ❗ `request.url` **带 query**，`/x?id=1` 切不出 `/x` → 带查询串的 GET 全部落到空体 404 | 匹配前取 pathname（`router.ts` 的 `pathnameOf`），单测覆盖 query/hash | ✅ 真机 §3.8-#1 |
| 24 | 建 agent 不传 `agentOptions`，靠 dsh 自己补默认模型 | ❗ `agentDefaultModel` 是**拉取式**（`currentSelection()`），dsh 自己的入口主动查它；库不查 → `{{model}}` 为空 → 首轮 `prompt variable "{{model}}" has no value` | `pickModel(ctx, explicit, record)`：显式 → 台账 → `agentDefaultModel` → 否则**同步抛**可读错误 | ✅ 真机 §3.8-#2，`packages/core/agent-default-model/src/index.ts:67-73` |
| 25 | 插件上下文消息写 `source: { kind: 'plugin', plugin }`（0.1.6 合法） | ❗ 会话格式 v4 **拒绝** `kind === 'plugin'`：`format v4 message requires a producer-owned source kind` | `buildPluginMessage` 永远发具名 kind（`section` 或 `spellbook-context`）；`section === 'plugin'` 直接抛 | ✅ 真机 §3.8-#3，`packages/session/session-format-v3-to-v4/src/message-sources.ts:7-12` |
| 26 | 临时会话门面无条件装 fail-fast 应答器 | ❗ 调用方要「人类在环」（`noInteraction: false`）时它会把提问/审批**抢答成否** | `noInteraction === false` 时不装，交给上层接管 | ✅ 真机 §3.8-#4 |

### 5.1 新增能力的取舍（0.2 给的，用不用）

| 0.2 能力 | 用不用 | 理由 |
|---|---|---|
| `SessionProjectionMap.userQuestions` | **读**（展示层） | 给"待决项在崩溃后仍可见"提供日志级证据；但**不能**替代 pending 表（它只知道"有个未答的 timed 调用"，无法结算） |
| `MessageSourceMap['user-question-reply']` | 不用 | 那是 dsh 自己的迟到回复通道，magica 的答案是同步 resolve 的 |
| `Agent.runMaintenance()` | 暂不用 | 会话门面不做非 turn 维护任务；将来做「会话内周期对账」时再评估 |
| `startsRequestSeries` | 不用 | 我们的上下文追加不改请求序列边界 |
| `approval.displayReason` | **用** | 直接解决 0.1.6「reason 是英文长句、无法本地化」的问题 |
| `dockkit` external | 暂不用 | 只有需要 dock 面板的插件才用；spellbook 不进 dock |

---

## 6. 横切设计规则

### 6.1 运行时安全（host 侧，7 条硬规则）

1. **热路径禁同步重 I/O**：`readdirSync` 遍历大目录、`rmSync(recursive)`、大文件读写必须异步或缓存。台账 `get()` 走**单文件直读**（不扫目录）就是为了这条（500 条记录时全量扫约 90 ms，直读亚毫秒）。
2. **原子写保留同步**：`writeFileSync(tmp) + renameSync(target)`，tmp 名带 `pid` + 时间戳，先写盘成功再更新内存缓存。
3. **禁未捕获异常 / 未处理 reject**：HTTP handler 先 `if (res.headersSent)` 再写错误；`void flushPending()` 之类必须内部全 `try/catch` 永不 reject。
4. **副作用可逆**：见 P5。`ctx.effect` 的 disposer 必须**自己收回**（`manageWaterfallListener` 的教训：只 `off()` 不调 disposer，登记记录会留到 fiber 卸载）。
5. **可选 service 必须 `ctx.get` + `undefined` 处理**；硬依赖才 `inject`（spellbook 没有 `inject`）。
6. **不自建长连接**：`link` 模块的 3 s 轮询已随它迁走；spellbook 的浏览器侧**只**用短轮询（≥5 s，硬下限 `Math.max(5_000, intervalMs)`）。
7. **限制并发**：出站 fetch 一律带 `AbortSignal.timeout`；批量读盘并发 2~4（`createLimitedFetch(fetcher, 2..4)`）；单 Node 进程只有 4 个 libuv 槽。

### 6.2 错误模型（统一三层）

| 层 | 形状 | 例子 |
|---|---|---|
| 库内部 | **绝不包装成 Result**，该抛就抛（`Error` / `SessionResumeError` / `HttpRouteError`） | `resolveAgents` 抛"declare inject: [agents]" |
| 门面边界 | **不抛**，收敛进 `state`：`error`（人话）+ `errorCode`（可判读）+ `ledgerWriteFailed` / `attachError` | `firstTurn` 永不 reject，调用方读 `getState()` |
| HTTP 边界 | `{ ok:true, value }` / `{ ok:false, error:{ code, message } }` 信封 + 稳定状态码 | 404 `not_found` / 409 `invalid_transition` / 403 `forbidden` |

> **为什么门面不 reject**：`firstTurn` reject 会让调用方必须"两套错误通道"，且 `followup` 的串行链会被前一个 rejection 传染。0.1.6 的结论是"会话建不起来"本身就是**可判读的结局**（`completed: false` + `errorCode`）。

### 6.3 三个必须记住的"能力存在但未启用"的坑

| 坑 | 0.1.6 现象 | 本设计的处置 |
|---|---|---|
| `runTurnVerified(..., idleTimeoutMs)` 看门狗 | 能力完整，但两个门面的 `runOneTurn` **都没传**该参数 → `whenIdle()` 不收敛时 `firstTurn`/`followup` 永久 pending | **必须在门面传入**（默认 `ttlMs` 之外再给一个 `idleTimeoutMs` 选项），且先修超时结算的形状：`{ kind:'aborted', reason:{ kind:'hook', reason:'magica:idle-timeout' } }`，不再用 `as TurnEndReason` 断言绕过（见 02 文档 §4.3） |
| `agentPresets` 缺失 | 不挂 preset = 空全局层（无工具、无 prompt section、无 skill catalog），magica 自己**不 warn** | 降级 + `warn`（走 stderr 兜底），并在 `state` 里留 `presetApplied: false` |
| 台账写失败 | 该会话的审批/提问**不会**出现在看板（归属判定失败），而它们默认无超时 → 任务永久挂起 | `ledgerWriteFailed` 必须被消费方读到；本设计额外要求：写失败时**同时**把待决项留在进程内供同进程轮询（归属判定加"进程内白名单"兜底，见 03 文档 §3.2） |

### 6.4 可观测性

- **诊断日志**（`event-log`）面向"用户能拿去提 issue"：环形缓冲 200 条、`detail` 截 600 字、周轮转 NDJSON、`sanitize` 11 条规则；与 `ctx.logger` **并存不替代**。
- **提问的留痕**：0.1.6 因为"提问没有任何会话日志事件"而自建日志（`question.asked` / `answered` / `cancelled` / `aborted` / `fail-fast`）。0.2 有了 `userQuestions` 投影，本设计仍保留自建日志（投影只覆盖 timed 调用，且不含"我们的 answerer 拒了它"这类事实）。
- **告警必须能落到人眼**：`warn` → logger → stderr 三级；dsh web 的 stderr 未必进用户可见面板 → 关键告警同时写诊断日志。

---

## 7. 契约与测试策略

### 7.1 三层测试

| 层 | 覆盖 | 形态 |
|---|---|---|
| 单元（host） | `core` 的 33 个符号、`store` 的 20 个、两个门面各 ~19 个 | `node:test` + 内存 fake（`ctx` 用最小对象 `/ctx\.agents/` 断言） |
| 契约（HTTP） | 4 个端点 × 归属/闸门/错误码 | 直接 `createInteractionHandler` + `mock req/res` |
| 快照（wire） | `PendingInteractionRecord` / 台账 JSON / 信封 | 字符串快照，改字段必须改快照 |

0.1.6 的 7 个 `session*` 测试文件共 **237 条**断言 + `ensure-workspace` **27 条**，`docs/raw/m.md` 已把每条提炼成"重写时必须保持"的契约表。**本设计把这张表当作验收基线**（迁移时逐条对照，可删但不可默默改变行为）。

### 7.2 迁移验收铁律（从 264 条里挑出的 12 条）

1. `TURN_END_KINDS` **顺序与内容**都锁死（改成 7 个后仍要 `deepEqual` 整数组）。
2. `isTurnCompleted(undefined) === false`（缺 `turn/end` 不能算成功）。
3. `describeTurnEnd` 的 9 条精确字符串（含 `'no turn/end observed'`、`'error: unknown'`）。
4. `buildPluginMessage` 具名分支：`source = { kind: section, plugin, form:'snapshot', sections:[{ name, text }] }`，深等于、无多余键。
5. `mintMessageId` 连续 200 次不重复。
6. `snapshotRunState` 的可选键**缺失**而非 `undefined`（`'outcome' in snap === false`）。
7. `resolveAgents` 5 种畸形输入全抛且 message 匹配 `/ctx\.agents/`，**不再接受** `ctx.agents` 属性访问。
8. `extractAssistantText` 多 block 用 `join('')`（不是 `join(' ')`），纯空白过滤。
9. `resolveResumeTarget`：台账无记录 / kind 不匹配 → **新建并忽略传入 id**。
10. `applyPermission` 返回三态 `'preset' \| 'sandbox' \| 'none'`；`'none'` 必须由门面告警。
11. 审批重复 `install` → 旧 bridge 全部 `'cancelled'`；提问重复 `install` → 全部 `ASK_ABORTED`。
12. `answerApproval` 非法 outcome → `'invalid-outcome'` 且**不结算**。

### 7.3 无安全网清单（重写时必须补测试）

`docs/raw/m.md` §13.9 列了 10 条 0.1.6 完全没测的行为，其中 3 条必须在 spellbook 里**先补测试再实现**：

- `idleTimeoutMs` 看门狗（超时 → `cancel` + `timedOut: true`）；
- `warnLedgerWriteFailure` 的三级降级；
- `EphemeralSessionHandle.injectContext` 在 `dispose()` 后的静默无效。

---

## 8. 落地顺序

| 阶段 | 内容 | 出口判据 |
|---|---|---|
| **P0**（先能 import） | `core-utils` 五件套（纯 Node、零 dsh 依赖）→ 可直接拿 0.1.6 代码迁 | 单测全绿；`grep` 零运行时 dsh 导入 |
| **P1**（能建会话） | `sessions`：`core` + `store` + `ephemeral`（先临时会话，无 workspace 依赖） | 264 条契约的表驱动测试；`firstTurn` 端到端跑通 |
| **P2**（能挂工作区） | `sessions`：`workspace` + `ensure-workspace` + 审批/提问接管 + `interactions` host 面 | 看板能列出待决项并结算；`attachError` / `ledgerWriteFailed` 有测试 |
| **P3**（能看见） | `client`：`interactions-panel`（卡片 + 接管）+ `directory-browser` | 会话页出现卡片；目录选择器可在自己的设置面板弹出 |
| **P4**（打磨） | `plan-review` 意图分流、IME 保护、`@media` 无障碍、`displayReason` | 对照 `04-client` 文档的"已知缺口"清单 |

依赖关系：`core-utils` ← 无；`sessions` ← `core-utils`（`http-route` / `event-log`）；`interactions` ← `sessions`（pending 表）+ `core-utils`（`http-route`）；`client` ← `interactions`（wire 类型）。

---

## 9. 风险登记册

| # | 风险 | 触发条件 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | `prepend: true, global: true` 任一丢失 | 有人"整理"注册选项 | 请求被 `api/remotes` 桥 hold，看板永远看不到待决项（**静默**） | 常量 `WATERFALL_TAKEOVER = { prepend: true, global: true }`，单点导出 + 契约测试断言选项 |
| R2 | `toResumeError` 靠 message 正则 | dsh 改文案 | 续跑错误退化成原样抛出，`errorCode` 缺失 | 换 `instanceof` + 结构化 code；正则只做兜底并记日志 |
| R3 | `cwd` 必须等于 workspace canonical path | 会话建在 worktree / 软链里 | `attachSession` 抛 `its cwd resolves to '<path>'`，会话不进 GUI 列表 | `attachError` 上报 + 文档写明"隔离会话要单独建 workspace" |
| R4 | 台账写失败 → 归属判定失败 → 待决项永不可见 | 磁盘满 / 权限 / 文件被占 | 任务永久挂起 | 见 6.3：进程内白名单兜底 + 强告警 |
| R5 | 模块级 `bridges` 无 `reset` | 调用方既不 `dispose()` 也不卸载 fiber | 空 Map 残留（几百字节），极端下泄漏 | 提供 `resetInteractionBridges()`（测试/诊断用）+ `dispose` 契约文档化 |
| R6 | 样式字符串注入的全局类名污染 | 消费方多、前缀不一致 | 视觉串台 | 统一 `magica-ix-` 前缀 + 引用计数 + `data-plugin` |
| R7 | `./directory-browser` 源码直出 | 消费方无 CSS Module 管线 | 构建失败 | 文档给 esbuild/tsdown 最小配置；提供编译后备用入口 `./directory-browser-lib` |
| R8 | peer 范围写错 | `>=0.2.0` 未含 prerelease 语义 | 插件行被静默禁用 | 范围写 `>=0.2.0-rc.2`，并用 `semver.satisfies(runtime, range, { includePrerelease: true })` 自测 |
| R9 | 0.2 的 `userQuestions` 投影与自建 pending 表双源 | 读者以为投影可替代 pending 表 | 结算不可能实现 | 文档明说：投影**只用于展示**，结算只走 pending 表 |
| R10 | `forked` 结局未处理 | 有人用旧 6 值 switch | 类型穷尽检查失效 / 运行时落 default | 常量表改 7 值 + 编译器双向断言 |

---

## 10. 附录

### 10.1 术语

| 术语 | 含义 |
|---|---|
| 门面（facade） | 面向调用方的一个函数，返回 handle：`runWorkspaceSession` / `runEphemeralSession` |
| 内核（kernel） | 两个门面共用的运行机制：`sessions/core.ts` |
| 台账（ledger） | `$DSH_HOME/storages/magica/sessions/<id>.json`，记录"创建参数"，是"可续跑"的唯一凭证 |
| 待决项（pending interaction） | 已被 spellbook 吃掉、还没结算的提问/审批 |
| 载体（carrier） | 浏览器侧把待决项发布进 `uiSession` 注册表的对象，靠 `tag` 标记字段认领 |
| 接管（takeover） | 用 `prepend + global` 的 waterfall 监听抢在 `api/remotes` 之前认领请求 |

### 10.2 核对方法（实现时怎么自查）

```bash
# 1. 零运行时 dsh 导入
grep -Rn "from '@deepseek-ai/" lib --include=*.js | grep -v "^\s*//"   # 必须为空

# 2. client bundle 形状
head -1 lib/client.js     # window.__ModuleLoader__.load({ id: "...", factory: (require) => {
tail -1 lib/client.js     #   return module.exports; } });

# 3. 平台 external 是否只用了白名单
node -e "const p=require('fs').readFileSync('lib/client.js','utf8');console.log([...p.matchAll(/require\(\"([^\"]+)\"\)/g)].map(m=>m[1]))"

# 4. peer 范围是否覆盖运行时
node -e "const s=require('semver');console.log(s.satisfies('0.2.0-rc.2','>=0.2.0-rc.2',{includePrerelease:true}))"  # true
```

### 10.3 与 0.1.6 素材的对应关系

| 素材 | 覆盖 | 本设计文档 |
|---|---|---|
| `raw/a.md` + `raw/b.md` | `src/client/**` | `04-client.zh.md`、`03-interactions.zh.md`（浏览器侧） |
| `raw/c.md` | 四个核心工具 | `01-core-utils.zh.md` |
| `raw/d.md` + `raw/e.md` | `src/interactions/**` | `03-interactions.zh.md` |
| `raw/i.md` + `raw/j.md` + `raw/k.md` + `raw/l.md` + `raw/m.md` | `src/sessions/**`（同一份文档的 5 个连续分片） | `02-sessions.zh.md` |
| `raw/n.md` + `raw/o.md` | `src/link/**` + `src/issue/**` + `src/task/**` | **不在本包**（见 §1.2） |
| `raw/f.md` + `raw/g.md` + `raw/h.md` | `src/lattice/**` | **按指令忽略** |
