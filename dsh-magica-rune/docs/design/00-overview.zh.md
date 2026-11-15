# 00 · 总览：把 0.1.2 的能力管理方案移植到 0.2.0-rc.2（仅工具 + 技能）

> 源码基线：DSH `0.2.0-rc.2`（tag `dsh-v0.2.0-rc.2`），本地 `D:\project-code\llm\deepseek-harness`。
> 本文所有 `packages/…:行号` 都相对该源码根；`⟨rune⟩/…` 相对本仓 `dsh-magica-rune`；`⟨sd⟩/…` 相对本仓 `dsh-magica-spellbook`。

---

## 0. 范围

**本插件只管理两类能力：**

| 类别 | 展示名 | 门禁通道 | 效力 |
|---|---|---|---|
| tool | 工具 | 双通道：`tools.guard`（执行拦截，权威）+ `createScope(agent)` 上的 `tools.restrict` + `system-prompt/assemble` 过滤（省 token） | 完整 |
| skill | 技能 | 运行时遮蔽：`agentCtx.get('skills').register(同名, invocation 双 false)` + guard 双保险 | 完整 |

**原始设计的「命令」「Agent」两个 tab 不做。** 理由与评估结论存档在 `01-dsh02-audit.zh.md` §4.5——0.2 没有命令级门禁挂载点，`named_subagent` 工具也已不存在。代码、配置、UI、文案、测试中**一律不出现**这两类。

因此配置只有两个子树（`tools` / `skills`），页面只有两个 tab，状态只有两份 gate。

---

## 1. 定位

`dsh-magica-rune` 是一个 **DSH 0.2 插件**，host + client 双侧，提供：

1. **「设置 → 能力管理」页**（`settings.section`，`id=ability`，`order=17`）——工具 / 技能两个 tab，每个 tab 都有**全局层**与**工作区层**两层配置。
2. **host 侧门禁**——按「会话所属工作区 + 全局配置」在运行时拦截 / 隐藏被禁能力，主 agent 与子代理都生效，改配置后**热生效**（不重启、不重载插件）。

它与 `docs/raw/` 的关系是**移植而非重写**：

| 维度 | 是否保持一致 |
|---|---|
| 页面视觉（版式、字号、描边、圆角、hover、配色算法、图标形状） | **完全一致**，CSS 值逐条照抄 `raw/a.md` §5 |
| 页面交互（tab、折叠 zone、搜索、分组批量、Tooltip、二次确认、下拉） | **完全一致**，逐条对齐 `raw/a.md` §8 |
| 配置语义（相对增量 + 全局传导、三态、工作区覆盖） | **完全一致** |
| 双通道机制（guard 主 + restrict 辅 + skill 运行时遮蔽） | **完全一致**（并且 restrict 在 0.2 上更强） |
| DSH 组件与 API | **全部替换为 0.2 原生**，逐项列在 `01-dsh02-audit.zh.md` |
| tab 数量 | **2 个**（工具 / 技能），原设计是 4 个 |

**唯一允许改动的是「过时的组件」。** 任何「0.2 已有更好做法但会改变视觉」的替换，都在 `03` §6 里逐条列出并给出取舍。

---

## 2. 为什么不能照抄 raw

`raw/` 写于 0.1.2 时代。0.2 有 **3 处结构性变化**会让照抄的代码直接编译不过或静默失效（第 4 处 `named_subagent` 与本方案无关，已移出范围）：

### 2.1 配置持久化层换了模型（最严重）

0.1.2：`ctx.get('settings').register('ability', schema)` 返回一个 Scope，`scope.get()` / `scope.watch()` / `scope.commit()`，配置写进 `~/.dsh/settings.yaml` 的 `ability:` 段。

0.2：`settings` service 已经没有 `register` / `watch` / `get`。它变成了「**把 Loader entry 的 Config schema 投影成表单**」的服务：

```ts
// packages/settings/settings/src/index.ts:223
export class SettingsForms extends Service {
  configure(presentation: { auto?: boolean }, owner: Fiber = this.ctx.fiber): () => void
  prepareDocument(): Promise<string>
  describe(options?: SettingsDescribeOptions): SettingsDescriptor[]
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
  replace(ns: string, section: object, expectedRevision?: number): Promise<void>
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}
```

```ts
// packages/settings/settings/src/index.ts:20-31
export interface SettingsDescriptor {
  ns: SettingsNamespace      // ← 就是 Loader entry 的 id
  autoGenerate: boolean
  schema: unknown
  value: unknown             // resolved
  revision: number
  base?: unknown
  user?: unknown
  applies: 'live'
  secrets?: RedactedSecret[]
}
```

→ **「插件自己注册一个 settings namespace」这条路径在 0.2 不存在**。插件配置 = 插件自己的 Cordis entry `Config`。因此能力策略改为：

```ts
export interface Config {
  tools: Volatile<AbilityKindSettings>
  skills: Volatile<AbilityKindSettings>
}
export const Config: z<Config> = z.object({ /* 两个 kind，全部 .volatile() */ })
```

面向前端的读写仍然走 `ctx.remote.settings.*`（`describe` / `replace` 名字与语义都没变，`packages/api/settings-controller/src/index.ts:97-139`），**推送刷新也仍然可用**（`settings/document-updated` 在白名单里，`packages/api/remotes/src/remote-events.ts:45`）。**只有 host 侧的注册方式换了。**

### 2.2 工作区解析有了原生 API

0.1.2：`realpathSync.native(cwd)` + 遍历 `workspaceRegistry.list()` 比 `.path`。

0.2：`workspaceRegistry` 多了一个 **`resolveByPath(path): Promise<Workspace | undefined>`**（Service 目录可见），本仓 SDK `dsh-magica-spellbook` 已封装为 `findWorkspace(ctx, path)`（`⟨sd⟩/src/sessions/ensure-workspace.ts:45-50`，只用纯字符串归一，物理 realpath 交给 dsh 的唯一 canon）。

按 `AGENTS.md`「本仓 SDK 命中即直接 import，不自造」→ **直接用 `findWorkspace`**，删掉手写 realpath 比对。

### 2.3 工具与技能「下移到 preset 层」

这是 0.2 最容易被忽略的变化，也是本方案两个通道各自的关键前提：

- **tool**：`tools` 的 `view()` 注释明确写了这次迁移的后果（`packages/core/tools/src/index.ts:1170-1174`）：
  > *"Reading the exempt set as 'the global layer' instead of 'not mine' held only while every model-facing tool sat in the host composition. **Once presets moved them onto the agent plane they became an ANCESTOR contribution**, so a child's filter silently stopped constraining anything it was given."*

  → `agent.ctx.tools.restrict()` 现在能过滤 **preset 挂上来的工具**（它们是祖先层贡献）。`raw/dsh-tool-ability.md` §2.4 担心的「own-layer 工具 restrict 移不掉」在 0.2 **大幅缓解**（只豁免「注册进 agent 自己那一层」的工具）。
- **skill**：`skill-filesystem` / `tool-skill` 在 Web 面被 host 层 disabled、改由 preset 各挂一份（`packages/bundle/web-app/cordis.patch.yml:475-488`、`presets/standard.patch.yml:34-37`）。→ 技能遮蔽**必须注册进 agent scope 层**，注册在 preset 层会因同层 rank 输给 project 级 provider 而**静默漏放**（详见 `02` §9.2）。

---

## 3. 总体架构

```
┌──────────────────────────────── host（Node）────────────────────────────────┐
│                                                                            │
│  Loader entry: id=dsh-magica-rune                                          │
│    Config（全 Volatile）── loader/volatile-update ──┐                       │
│      tools : AbilityKindSettings                   │                       │
│      skills: AbilityKindSettings                   ▼                       │
│                                          ┌──────────────────┐              │
│  ┌────────────────────┐                  │   policy.ts      │  纯函数       │
│  │ workspace.ts       │                  │ buildEffective   │              │
│  │ findWorkspace(cwd) │                  └────────┬─────────┘              │
│  │ Map<agentId,wsId>  │                           │ build                  │
│  └─────────┬──────────┘                           ▼                        │
│            │                          ┌──────────────────────┐             │
│            └─────────────────────────►│     GuardState       │             │
│                                       │ gate(tool)           │             │
│                                       │ skillGate(skill)     │             │
│                                       │ agentWorkspace       │             │
│                                       │ internalTools +      │             │
│                                       │ skillDescCache       │             │
│                                       └──────────┬───────────┘             │
│  ┌───────────────────────────────────────────────┴──────────────────────┐  │
│  │ 四个挂载点（全部是 DSH 已有的观察/拦截位，不改 loop）                    │  │
│  │  tool：① tools.guard（全局层，执行前单调拒绝，主通道）                  │  │
│  │        ② createScope(agent).ctx.tools.restrict（schema 移除，省 token）│  │
│  │        ③ 该 scope 上 on('system-prompt/assemble') 过滤 tool:<name>     │  │
│  │  skill：④ agentCtx.get('skills').register(同名, invocation:false) 遮蔽 │  │
│  │        ＋ guard 里判 exec.name==='skill' + arguments.name（双保险）    │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  webServer.register（kind:'exact'）                                        │
│    GET /rune-ability/catalog  ← { ns, tools, skills, workspaces }           │
└────────────────────────────────────────────────────────────────────────────┘
                                    ▲ fetch
┌──────────────────────────────── client（浏览器）─────────────────────────────┐
│  apply(ctx)                                                                 │
│    locale.register / bind                                                   │
│    AbilityController（async：load / toggle / persist）                       │
│      ├ ctx.remote.settings.describe()   ← 读配置 + revision                 │
│      ├ ctx.remote.settings.replace(...) ← 写配置（乐观锁）                   │
│      ├ ctx.remote.$on('settings/document-updated') ← 别处改动推送            │
│      └ fetch('/rune-ability/catalog')   ← 读工具/技能目录                    │
│    slots.inject('settings.section') → AbilitySection（2 个 tab）             │
│      store: view store（defineStore：tab/搜索/折叠/选中工作区）              │
│      locale: 'settings.ability' → 自动注入 t                                │
│      inject: (actions) => ({ hooks:{ ability }, load, toggle, … })          │
└────────────────────────────────────────────────────────────────────────────┘
```

**链条不变**（`raw/dsh-tool-ability.md` §3 的要求）：session → agent 发布（`agent/created`）→ loop → assemble（`systemPrompt.assemble` 拿 schemas + sections）→ 模型请求 → execute（`tools/pre-execute` → **guard** → body）。rune 只在「assemble 取 schemas 前」改 schema 视图、在「execute 过 guard」时加一条拦截、在「agent 创建后」往 agent 层注册技能遮蔽。**一个环节没增减。**

---

## 4. 两类能力的可行性结论

| 能力 | 0.2 拦截点 | 落地通道 | 判定 |
|---|---|---|---|
| **tool** | `tools.guard` + `tools.restrict` + `system-prompt/assemble` 全部存在，签名/语义一致 | guard（权威）+ restrict + assemble 过滤 | ✅ 与 0.1.2 **等价**，restrict 覆盖面更大 |
| **skill** | `skills.register` + `SkillInvocationPolicy` + 4 个消费点全部存在 | agent 层同名遮蔽 + guard 双保险 | ✅ 与 0.1.2 **等价**，但**落层是生死线** |

### 4.1 skill 的四个消费点（一个 `register` 全覆盖）

| 消费点 | 判定 | 证据 |
|---|---|---|
| `skill` 工具 execute | `isModelInvocable(summary)` / `isModelInvocable(skill)` | `packages/skill/tool-skill/src/index.ts:138,145` |
| `<available_skills>` 注入 | `snapshot.skills.filter(isModelInvocable)` | 同 `:226` |
| 斜杠菜单（SessionSkillCatalog） | `.filter(isUserInvocable)` | `packages/api/session-controller/src/skill-catalog.ts:62-86` |
| `/skill-name` 手势注入 | `isUserInvocable(skill)` | `tool-skill/src/index.ts:195` |

### 4.2 关键前提：遮蔽必须落 agent 层

0.2 的 skill registry 是 **host + per-scope 分层**的。官方注释（`packages/bundle/web-app/cordis.patch.yml`，`skill-filesystem` 那一行上方）写得很清楚：

> deployment-level providers — repository plugins, a host skill-filesystem row — register into its **global layer**, while a preset's `skill-filesystem` registers into **that preset's layer**, and each agent reads the merged catalog its scope chain selects.

合并规则：**跨层 nearest-wins（无视 rank）**；**同层内**按 `rank` 小者胜（runtime 250 / project 100、200）。→ 只有 `agent.ctx.get('skills')`（落 agent 层）能盖住 project 级 skill。详见 `02` §9.2。

---

## 5. 方案有效性结论

### 5.1 判定

**「能力管理」方案的骨架在 0.2.0-rc.2 上仍然成立；需要替换的组件共 16 项，其中 3 项是结构性替换（不是改签名）。**

| # | 组件 | 判定 | 替换为 |
|---|---|---|---|
| 1 | `settings.register(ns,schema)` + `scope.get/watch/commit` | ❌ 结构性 | `Config` + `Volatile<T>` + `loader/volatile-update` |
| 2 | `z.dict(...)` 内叶子 `.volatile()` | ❌ 加载期抛错 | 一个 kind 一个 fixed-path volatile |
| 3 | `realpathSync` + `workspaceRegistry.list()` 手比对 | ⚠️ | `findWorkspace()`（`workspaceRegistry.resolveByPath`） |
| 4 | `ctx.on('agent/created', agent => …)` | ⚠️ | `({ agent, source, signal }) => …` |
| 5 | `tools.guard(fn)` | ✅ | 原样（`exec.arguments`，不是 `args`） |
| 6 | `tools.restrict({deny})` 在 agent ctx 上 | ⚠️ | 原样但必须预过滤未知名字；建议挂 `createScope` |
| 7 | `agentCtx.on('system-prompt/assemble', (a, next) => …)` | ⚠️ | `(a, context, next) => …`，`next()` 无参 |
| 8 | `state.updateInternalTools(schemas(), schemas(agent))` | ❌ | 只取 `schemas(agent)`，且必须在 restrict **之前** |
| 9 | `ctx.on('tools/change', () => refresh())` | ⚠️ | **必须加防重入**（restrict 自身会 emit） |
| 10 | skill 遮蔽 `invocation:{…:false}` | ⚠️ | 语义成立，但**必须落 agent scope 层** |
| 11 | client `inject` 含 `@deepseek-ai/dsh-client-runtime` | ❌ 包不存在 | 删除 |
| 12 | 组件内 `locale.subscribe` + `useSyncExternalStore` | ❌ | 删；`locale: NS` 自动注入 `t` |
| 13 | 自建 store + 字符串 CSS 注入 | ❌ | `defineStore` + CSS Modules |
| 14 | `Modal` 缺 `closeLabel` | ❌ 类型不过 | 补 |
| 15 | `--dsw-alias-brand-primary` 当品牌蓝 | ❌ 语义变了 | `--dsw-alias-state-business-primary` |
| 16 | 圆角 5px / 6px 字面量 | ❌ 被 lint 拒 | `--dsw-radius-xs/sm` |

（完整 22 项见 `01-dsh02-audit.zh.md` §0；命令 / Agent 的过时点不在此表，已移出范围。）

### 5.2 四条不能碰的红线

1. **guard 必须是全局层（unscoped ctx 注册）**。`tools.guard` 的语义是「全局层 + scope 链，farthest first，单调拒绝」（`packages/core/tools/src/index.ts:1144-1154`）。注册在插件顶层 ctx → 覆盖所有 agent（含子代理）。
2. **skill 遮蔽必须注册进 agent scope 层**（`agent.ctx.get('skills')`），不能散装注册在 global/preset ctx。
3. **`tools.restrict` 必须在 scoped ctx 上调用**（unscoped 直接抛错，`:1098-1101`），且必须预过滤未知名字（未知工具名抛错，`:1114-1118`）。
4. **`agent/created` 处理器绝不 throw**（`serial` 监听器 throw 会让 agent 创建失败）。

### 5.3 阅读顺序

1. `01-dsh02-audit.zh.md` —— 认领所有替换项，别自己再发明。
2. `02-host-ability-gate.zh.md` —— 写 host。
3. `03-client-ability-ui.zh.md` —— 写前端；**视觉问题只看这一篇**。
4. `04-package-and-verification.zh.md` —— 打包、测试、验收。
