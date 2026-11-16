# dsh-magica-spellbook（0.2.0-alpha.1）

面向 **DSH 0.2.0-rc.2** 的插件 SDK：把「程序化建会话 / 结局判定 / 待决交互 / 诊断日志 / 进站路由 / 内网出站」这些每个插件都要重写一遍的东西收成一个库。

- **纯库，不是插件**：没有 `apply(ctx)`、没有 `dsh.bundle`、没有 `cordis.patch.yml`。消费方是插件，在构建期把它打进自己的 bundle。
- **零运行时 `@deepseek-ai/*` 依赖**（连类型也不 import）：dsh 的契约以「结构面」形式写在 `src/shared/dsh.ts`，每一条都标了源码坐标。
- **pnpm 构建 + `lib/` 只有两个压缩 JS**：`lib/index.js`（host）、`lib/client.js`（浏览器），声明在 `lib/types/**`。

## 目录

```
src/
├── index.ts                  host 唯一入口
├── shared/
│   ├── wire.ts               线上契约（零 import，host/browser 共用）
│   └── dsh.ts                dsh 契约的结构面（带源码坐标）
├── core/                     logger / crypto / router / net / pricing
├── sessions/                 core / store / workspace / ephemeral / approval / questions / ensure-workspace
├── interactions/             ownership / collect / route（host HTTP 面）
└── client/
    ├── index.ts              浏览器唯一入口
    ├── panel/                卡片 + 会话页接管（样式是字符串，无 CSS 文件）
    └── directory-browser/    可嵌入目录选择器（以源码形式导出）
tests/                        node:test，按模块镜像
docs/                         design/（权威设计）+ raw/（0.1.6 剖析素材）
```

## 命令

```bash
pnpm install        # 依赖装到包内 store（.pnpm-store / .pnpm-cache）
pnpm typecheck      # tsc --noEmit（host + client）
pnpm test           # node --test（102 例）
pnpm build          # lib/index.js + lib/client.js（压缩）+ lib/types/**
pnpm verify         # 产物契约：两个压缩 JS / 零 dsh 运行时导入 / client 裸 import 白名单
```

`test` 固定带 `--test-isolation=none`：默认隔离模式会给每个测试文件起子进程并接管管道，在受限沙箱下会 `EPERM`。构建脚本同理——它调 **esbuild CLI** 而不是 JS API（后者也起管道子进程）。

## 消费方式

### host 半

```ts
import {
  runWorkspaceSession,
  createInteractionHandler,
  INTERACTION_PREFIX,
  createEventLogger,
} from 'dsh-magica-spellbook'

export const inject = ['agents', 'webServer', 'workspaceRegistry']

export function apply(ctx: Context): void {
  ctx.inject(['webServer'], (webCtx) => {
    const handler = createInteractionHandler(webCtx, { strictMutations: true })
    webCtx.effect(() =>
      webCtx.webServer.register({ kind: 'prefix', path: INTERACTION_PREFIX, handler }),
    )
  })

  const session = runWorkspaceSession(ctx, {
    workspaceId,
    workspacePath,
    prompt: '把这个 issue 处理掉',
    permission: 'workspace-write',
    humanInteraction: { approvalTimeoutMs: 10 * 60_000 },
  })
  void session.firstTurn
}
```

### client 半

```ts
import { createInteractionSurface, INTERACTION_LOCALE_NS, zh, en } from 'dsh-magica-spellbook/client'

export const inject = ['slots', 'uiSession', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(INTERACTION_LOCALE_NS, { zh, en }))
  const surface = createInteractionSurface(ctx, {
    t: ctx.locale.bind(INTERACTION_LOCALE_NS),
    pluginId: '@acme/dsh-panel',
  })
  ctx.effect(() => () => surface?.dispose())
}
```

可嵌入目录选择器（以源码形式导出，消费方自己编译）：

```tsx
import { DirectoryBrowser } from 'dsh-magica-spellbook/directory-browser'
```

## 真机 E2E（dev profile 隔离）

`.e2e/` 下是一套**只在 dev profile 跑**的验证装置，按 `dsh-plugins-principles` 的隔离要求做：`DSH_HOME` 指向工作区内的临时目录，**不碰 `~/.dsh/profiles/web`**。

```
.e2e/
├── plugin/            dsh-spellbook-e2e：把 spellbook 各层掏成 /e2e/* HTTP 端点
├── mock-messages.mjs  脚本化 Messages mock（dsh 的 deepseek 适配器只认 Messages SSE）
├── run-scenarios.mjs  基础场景（健康/日志/首轮/续跑/followup/TTL/cancel/dispose）
└── run-interactions.mjs  待决交互场景（question / approval 接管）
```

步骤：

```bash
# 1) 隔离的 DSH_HOME + dev profile（@deepseek-ai 指向本机已装 dsh 的插件目录，只读引用）
$env:DSH_HOME = "$PWD/.e2e/dsh-home"
# 2) 起 Messages mock（脚本决定模型这一轮回文本还是调工具）
$env:MOCK_SCRIPT='[{"kind":"text","text":"mock reply"}]'; node .e2e/mock-messages.mjs
# 3) 起 dev 端（3081 与默认 3080 错开），provider 指到 mock
$env:DEEPSEEK_BASE_URL='http://127.0.0.1:8085/v1'; $env:DEEPSEEK_API_KEY='mock-key'
dsh --profile dev --port 3081 --no-open
# 4) 跑场景
node .e2e/run-scenarios.mjs
node .e2e/run-interactions.mjs question
node .e2e/run-interactions.mjs approval
```

实测结果（同一次宿主生命周期内，mock 用 `POST /__mock/script` 运行时换脚本）：

| 场景 | 结果 |
|---|---|
| 基础（首轮/续跑/followup/TTL/cancel/dispose/日志/pricing） | ✅ 14/14 |
| 看门狗（`whenIdle` 不收敛） | ✅ 1/1 |
| 提问接管（HTTP 面） | ✅ 7/7 |
| 审批接管（HTTP 面） | ✅ 5/5 |
| **输入框选择框**（真 Web UI，headless Chrome + CDP） | ✅ 28 个 `magica-ix` 节点，点选「方案 A」→「提交」→ 宿主 `remaining=0 / outcome=completed` |
| **输入框审批卡**（真 Web UI） | ✅ 「拒绝」/「允许一次」，点拒绝 → 宿主 `remaining=0 / outcome=completed` |
| **输入框计划评审卡**（真 Web UI） | ✅ 合成 plan-review 提问 → 徽标「计划评审」+ 批准项标「推荐」→ 点批准并提交 → `remaining=0` |
| **遗漏修复专套**（`run-round11.mjs`） | ✅ 11/11：脱敏落盘、台账 `options` 优先、`getState` 透出 `approvals`、非法答案 400 文案、`multiSelect:false` 透传、非 2xx 信封、审批标题本地化 |

复现：`node .e2e/loop.mjs`（问题闭环）、`node .e2e/loop-approval.mjs`（审批闭环）、`node .e2e/browser.mjs`（CDP 自检）。

> 这套装置抓出了 7 个只在真机才暴露的问题（路由 query 串、缺省模型、v4 `source.kind`、fail-fast 抢答、活动写锁未分类、primitives 不再导出 `Icon*` 导致 composer 崩溃、slot 的 `registrant` 选项导致接管静默不注册），都已修掉并补了回归测试。见 `docs/design/00-overview.zh.md` §3.8。

## 一致性核对（raw 素材逐条比对）

`docs/raw/` 的 10 篇素材（排除 lattice 的 `f/g/h` 与 link 的 `n/o`）已提取成 **1 960 条可断言需求**，并逐条对照实现产出 5 份核对表：

| 文档 | 覆盖 | 结论 |
|---|---|---|
| [`design/05-conformance-core-utils.md`](docs/design/05-conformance-core-utils.md) | `c.md` 208 条 | 199 一致 / 6 有差异 / 0 缺失 |
| [`design/05-conformance-interactions.md`](docs/design/05-conformance-interactions.md) | `d.md`+`e.md` 278 条 | 244 一致 / 28 差异 / 1 缺失（含 2 条安全债） |
| [`design/05-conformance-sessions-a.md`](docs/design/05-conformance-sessions-a.md) | `i.md`+`j.md` | 内核近零漂移；门面缺 fiber 兜底 |
| [`design/05-conformance-sessions-b.md`](docs/design/05-conformance-sessions-b.md) | `k/l/m.md` | 测试契约覆盖 19.7%（待补 220 条断言） |
| [`design/05-conformance-client.md`](docs/design/05-conformance-client.md) | `a.md`+`b.md` 616 条 | 383 一致 / 156 差异 / 61 缺失 |

据这些核对表已修：**Host 围栏**（挡 DNS rebinding）、**`strictMutations` 默认 `true`**（堵住零凭证批审批的利用链）、两个门面的 **fiber 卸载自动 dispose**、`queryOf` 畸形 pair 跳过、`dispose` 后停止持久化、`insecureFetch` 恒直连、workspace TTL 文案，并新增 `net.test.ts` / `ensure-workspace.test.ts` / `ownership.test.ts` / 安全回归 / client 装配韧性等 29 条断言（单测 **240 例**）。

**脚本铁律：本仓脚本一律不做删除操作**（`rm.mjs` 已改成纯 dry-run 报告；`build.mjs` 直接覆盖产物，不再清空 `lib/`）。

日志落在 `$DSH_HOME/logs/dsh-magica-spellbook/log-<周一>.ndjson`（单一级目录，事件靠 `event` 字段区分；根目录优先走宿主的 `dshHomePath`）。测试进程会由 `tests/setup.mjs` **无条件**把 `DSH_HOME` 指到临时目录，绝不写真实 `~/.dsh`。

## 三条使用铁律

1. **吃掉请求就要结算**：`humanInteraction` 一开，host 侧会用 `{ prepend: true, global: true }` 的 waterfall 抢在 `api/remotes` 之前认领提问/审批。此时**必须**注册 `createInteractionHandler`，否则请求永远挂着。
2. **门面永不 reject**：`firstTurn` 一定 resolve，读 `getState().errorCode` 区分「在跑 / 日志没了 / setup 没重传」。
3. **看门狗要显式开**：`whenIdle()` 不收敛时靠 `idleTimeoutMs` 兜底（`ttlMs` 是整轮墙钟，两者独立）。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/design/00-overview.zh.md`](docs/design/00-overview.zh.md) | 模块总览、产物契约、0.2 适配矩阵、风险 |
| [`docs/design/01-core-utils.zh.md`](docs/design/01-core-utils.zh.md) | 核心工具层 |
| [`docs/design/02-sessions.zh.md`](docs/design/02-sessions.zh.md) | 会话运行内核 |
| [`docs/design/03-interactions.zh.md`](docs/design/03-interactions.zh.md) | 待决交互（host + 浏览器） |
| [`docs/design/04-client.zh.md`](docs/design/04-client.zh.md) | 目录选择器 |

## 已知限制

- `lib/client.js` 是 **ESM bundle**（不是 `window.__ModuleLoader__` 闭包工厂）：spellbook 不是插件，shell 不直接加载它。要变成可加载插件形态，只需改 `scripts/build.mjs` 的 client 一档（cjs + banner/footer）并在 `package.json` 补 `dsh.client`，代码不动。
- `./directory-browser` 是**唯一源码直出入口**（`lib/` 只有两个 JS 的约束下无法同时提供"可被别的插件 import 的裸组件"）。代价：消费方要支持 `.tsx` + `.module.css`。
- `peerDependencies` **故意留空**：dsh 家族在 `0.2.0-rc.2` 并非全部发布到 npm（例如 `dsh-agent-presets` 只有 0.1.x），声明会直接让 `pnpm install` 失败；我们连类型都不 import，所以不需要它。支持的运行时范围见 `docs/design/00-overview.zh.md` §5。
