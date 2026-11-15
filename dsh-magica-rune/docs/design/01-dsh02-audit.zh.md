# 01 · 0.1.2 → 0.2.0-rc.2 逐项过时审计（工具 + 技能）

> 判定符号：`✅` 原样成立 ｜ `⚠️` 需改（签名/载荷/语义变了）｜ `❌` 过时（API 不存在或去了别处）｜ `⛔` 移出范围（已评估，不做）
>
> 路径约定：`packages/…` = DSH 源码（`0.2.0-rc.2`）；`⟨sd⟩/…` = 本仓 `dsh-magica-spellbook`；`raw/…` = 本仓 `docs/raw/`。
> 行号以 0.2.0-rc.2 源码为准，**`raw/` 里的行号一律作废**。
>
> **范围**：本审计只覆盖**工具**与**技能**两类。命令 / Agent 两类的评估结论收在 §4.5，不进入实现。

---

## 0. 一页结论

| # | 组件 | 判定 | 替换目标 |
|---|---|---|---|
| 1 | `settings.register(ns, schema)` + `scope.get/watch/commit` | ❌ | 插件自己的 `Config` + `Volatile<T>` + `loader/volatile-update` |
| 2 | `z.dict(...)` 内叶子 `.volatile()` | ❌ 加载期抛错 | 一个 kind 一个 fixed-path volatile |
| 3 | `ctx.on('agent/created', agent => …)` | ⚠️ | `({ agent, source, signal }) => …` |
| 4 | `realpathSync` + `workspaceRegistry.list()` 手比对 | ⚠️ | `workspaceRegistry.resolveByPath()` / `⟨sd⟩` `findWorkspace()` |
| 5 | `tools.guard(fn)` | ✅ | 原样（读 `exec.arguments`，不是 `args`） |
| 6 | `tools.restrict({deny})` 在 agent ctx 上 | ⚠️ | 原样但必须预过滤未知名字，并建议挂 `createScope` |
| 7 | `agentCtx.on('system-prompt/assemble', (a, next) => …)` | ⚠️ | `(a, context, next) => …`，`next()` 无参 |
| 8 | `state.updateInternalTools(schemas(), schemas(agent))` | ❌ | 只取 `schemas(agent)`，且必须在 restrict **之前** |
| 9 | `ctx.on('tools/change', () => refresh())` | ⚠️ | **必须加防重入**（restrict 自身会 emit） |
| 10 | skill 遮蔽 `invocation:{…:false}` | ⚠️ | 语义成立，但**必须落 agent scope 层**（否则静默漏放） |
| 11 | `packages/guard` 当权限体系 | ⛔ 误判 | 它只是 loop-hygiene 两件套（结论存档，不影响本方案） |
| 12 | client `inject` 含 `@deepseek-ai/dsh-client-runtime` | ❌ 包不存在 | 删除 |
| 13 | 组件内 `locale.subscribe` + `useSyncExternalStore` | ❌ | 删；`locale: NS` 自动注入 `t` |
| 14 | 自建 store | ❌ | `defineStore` + controller + `hooks` |
| 15 | 字符串 CSS + `head.appendChild` | ❌ | CSS Modules（构建预设内建注入） |
| 16 | `Modal` 缺 `closeLabel` | ❌ 类型不过 | 补 |
| 17 | 自绘下拉浮层 | ❌ | `Menu` / `MenuSurface` |
| 18 | `--dsw-alias-brand-primary` 当品牌蓝 | ❌ 语义变了 | `--dsw-alias-state-business-primary` |
| 19 | 圆角 5px / 6px 字面量 | ❌ 被 lint 拒 | `--dsw-radius-xs/sm` |
| 20 | `engines.dsh` | ❌ 零读取方 | 删除 |
| 21 | peer `>=0.1.2-rc.1` | ❌ 零保护 | `>=0.2.0-rc.2` |
| 22 | `exports["./client"] = { import: … }` | ❌ 会抛 | `{ types, default }` |
| — | `named_subagent` guard 分支 / command 门禁 / `dsh-agent-center` 目录 | ⛔ | 移出范围，见 §4.5 |

---

## 1. Host 侧

### A1 `ctx.get('settings')` —— ❌ 整个 API 被换掉

0.1.2：`settings.register('ability', schema)` → Scope；`scope.get()` / `scope.watch(cb)` / `scope.commit()`；配置写进 `~/.dsh/settings.yaml` 的 `ability:` 段。

0.2：`settings` 是 `SettingsForms`，只做「把 **Loader entry 的 Config schema** 投影成表单 + 写回 profile patch」。

```ts
// packages/settings/settings/src/index.ts:223-236
export class SettingsForms extends Service {
  static inject = ['configEditor', 'profileContext']
  constructor(private readonly ownerContext: Context) { super(ownerContext, 'settings') }
```

公开方法（逐个核对）：

```ts
configure(presentation: { auto?: boolean }, owner: Fiber = this.ctx.fiber): () => void
prepareDocument(): Promise<string>
describe(options?: SettingsDescribeOptions): SettingsDescriptor[]
async update(ns: string, patch: object, expectedRevision?: number): Promise<void>
async replace(ns: string, section: object, expectedRevision?: number): Promise<void>
async mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
```

| 0.1.2 用法 | 0.2 现实 |
|---|---|
| `settings.register('ability', schema)` | **不存在**（全仓无 `settings.register(`） |
| 返回 scope + owner mode 参数 | **不存在**。只有 `configure({auto?}, owner?)` 控制「是否自动生成表单页」 |
| `scope.get()` | 无。插件从自己的 `config`（`apply(ctx, config)` 第二参）读，volatile 字段用 `.get()` |
| `scope.watch(cb)` | 无。用 `ctx.on('loader/volatile-update', cb)` |
| `scope.commit()` / revision | 无。写走 `settings.replace/update/mutate` + `expectedRevision`，冲突抛 `SettingsConflictError` |

**关键细节**：

- schema 库仍是 `@deepseek-ai/schemastery`，写法 `import z from '@deepseek-ai/schemastery'` + `z.object({...})`。`role('secret')` ✅、`Volatile<T>` + `.volatile()` ✅（`Volatile` 类型来自 `@deepseek-ai/cosmokit`，`vendor/cordis/src/index.ts:16` 再导出）。
- **非 volatile 字段不能通过 settings 编辑**：`write()` 抛 `Config field "…" is not volatile`（`packages/settings/settings/src/index.ts:386-389`）、`Plugin entry "…" has no volatile fields`（`:385`）。→ 能力策略的每个字段都必须 `.volatile()`，否则 UI 写不进去。
- **`.volatile()` 不能出现在 dict / array 内部**（这条会直接打死照抄的 schema）：

```ts
// vendor/schemastery/src/index.ts:488-509
function validateVolatileSchema(schema, path = [], blocked = false, seen = new Map()) {
  if (schema.meta?.volatile && blocked) {
    throw new ValidationError('volatile fields require a fixed object path without an enclosing volatile field', { path })
  }
  const nested = blocked || !!schema.meta?.volatile
  if (schema.dict) { for (const [key, child] of Object.entries(schema.dict)) validateVolatileSchema(child, [...path, key], nested, seen) }
  if (schema.sKey) validateVolatileSchema(schema.sKey, [...path, '<key>'], true, seen)    // dict 的 value 一律 blocked
  if (schema.inner && …) validateVolatileSchema(schema.inner, [...path, '*'], true, seen) // array 元素一律 blocked
}
```

→ `workspaces: z.dict(layer)` 的**值**是被 blocked 的；只要 `layer` 内部**没有** `.volatile()` 就没事。正确形态：**一个 kind 一个 fixed-path volatile**：

```ts
const layer = () => z.object({
  disabled: z.array(z.string()).default([]),     // 不标 volatile ← 正确
  enabled: z.array(z.string()).default([]),
})
const kind = () => z.object({
  global: layer().default({ disabled: [], enabled: [] }),
  workspaces: z.dict(layer()).default({}),
}).volatile()                                    // ← volatile 落在这里
export const Config = z.object({ tools: kind(), skills: kind() })
```

**读实时值 + 感知热更新**（0.2 官方写法，替代 `scope.get()` / `scope.watch()`）：

```ts
// packages/client/product-analytics/src/index.ts:30-51
static Config = z.object({ enabled: z.boolean().default(true).volatile(), appVersion: z.string() })
constructor(ctx: Context, private readonly config: Config) {
  ...
  ctx.on('loader/volatile-update', () => { for (const listener of this.listeners) listener() })
}
enabled(): boolean { return this.active && this.config.enabled.get() }
```

语义确认：`vendor/loader/src/config/entry.ts:162-195` `_commitVolatile()` 用 `updateVolatile(ref, source)` **原地改写**引用，然后 `fiber.ctx.emit(self, 'loader/volatile-update', paths)`。所以 `apply(ctx, config)` 收到的 `config` 是**活对象**：`config.tools.get()` 永远是最新值，且因为全部字段都是 volatile，配置改动走 volatile-only 路径（`entry.ts:144-149`），**不会 remount 插件**。

**另有一条必须做**：不声明的话，DSH 会在「插件」设置页为我们的 entry 自动生成一张巨大的表单。官方做法是关掉：

```ts
// packages/client/product-analytics/src/index.ts:38
ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
```

### A2 `ctx.get('tools')`

#### A2.1 `tools.guard` —— ✅ 一字未改

```ts
// packages/core/tools/src/index.ts:723-731
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined

// :1136-1142
guard(guard: ToolGuard): () => void {
  return this.layers.effect(this.ctx, layer => layer.guards.append(guard), { label: 'tools.guard()', notify: false })
}

// :1145-1154  全局层先查，再走 scope 链 → 顶层 ctx 注册的 guard 对所有 agent（含子代理）生效
private guardReason(exec: ToolExecution): string | undefined {
  const globalReason = this.layers.global.guardReason(exec)
  if (globalReason !== undefined) return globalReason
  if (exec.agent === undefined) return undefined
  for (const layer of this.layers.chainLayers(exec.agent)) { … }
}
```

执行位置：`tools/pre-execute` waterfall 之后、tool body 之前（`index.ts:1503-1531`）。`return string` = 干净的模型可见拒绝；`throw` 会被外层 catch 成 `toolErrorResult`（异常路径，后续 guard 不再执行）。**原方案「体内不 throw」的纪律仍然正确。**

`ToolExecution` 字段（`index.ts:326-352` + `393-398`）：`callId` / `rootCallId` / `name` / `schema?` / `arguments` / `agent?` / `parent?` / `signal` / `token`。
**没有 `caller`、没有 `scope`**。参数是 `exec.arguments`（**不是 `args`**）。`exec.agent` 就是 `Agent` 实例。

#### A2.2 `tools.restrict` —— ⚠️ 三处必须处理

```ts
// :696-705
export interface ToolRestriction { readonly allow?: readonly string[]; readonly deny?: readonly string[] }

// :1097-1124
restrict(filter: ToolRestriction): () => void {
  const scope = scopeOf(this.ctx)
  if (scope === undefined) throw new Error('tools.restrict() requires a scoped context (agent.ctx): …')
  if (allow === undefined && deny === undefined) throw new Error('tools.restrict({}) is a no-op: …')
  if ([…].includes(RUN_CODE_NAME)) throw new Error(`tools.restrict() cannot name reserved PTC mode presentation transport "${RUN_CODE_NAME}"; …`)
  const known = this.view(scope).restrictableNames
  const unknown = […].filter(name => !known.has(name))
  if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool…`)
  return this.layers.effect(this.ctx, layer => layer.restrictions.append(compiled), { label: 'tools.restrict()' })
}
```

| 点 | 0.1.2 方案 | 0.2 现实 | 处置 |
|---|---|---|---|
| 作用域 | 在 `agentCtx` 上调用 | **unscoped 直接抛错**（不是 no-op） | 保持原做法；任何「顶层兜底 restrict」都会抛 |
| 未知名 | 逐个 try/catch 吞错 | **仍然抛错** | 必须保留 try/catch，**并且**先用 `tools.schemas(agent)` 的可见名字预过滤 |
| own-layer 免疫 | preset 重插的工具移不掉 | **语义变了**：preset 是 agent 的**祖先**，其工具是祖先贡献 → **能被 restrict 移除**；免疫只剩「agent.ctx 自己注册的」 | `raw/` §2.4 的 workflow-redirect 文本兜底**可以降级为可选** |
| `run_code` | RESERVED，不可 restrict | 仍抛错；且 0.2 默认 `mode:'native'` 时 `run_code` 根本不在可见集 | 保留剔除 |

**own-layer 语义变化的源码依据**：

```ts
// packages/core/tools/src/index.ts:1163-1174
// A restriction filters what a scope inherits — the global layer and every ancestor layer on its chain —
// and never what its OWN layer registers.
// …
// Reading the exempt set as "the global layer" instead of "not mine" held only while every model-facing
// tool sat in the host composition. Once presets moved them onto the agent plane they became an ANCESTOR
// contribution, so a child's filter silently stopped constraining anything it was given.
```

#### A2.3 `tools.schemas(scope?)` —— ⚠️ 关键：全局视图**不是**全量

```ts
// :1254-1262
schemas(scope?: ScopeKey): ToolSchema[] {
  return [...this.view(scope).visible.values()].map(definition => this.schemaOf(definition, true))
}
// :1282-1294 → { name, description, parameters, deferLoading? }
```

- `tools.schemas(agent)` ✅ 存在，官方自己就这么用（`packages/experimental/browser-use-runtime/src/mcp.ts:114`）。同一个 key 也接受 `Agent`（agent 的 scope key 就是 agent 实例，`packages/core/agent-loop/src/agent.ts:130-131`）。
- **`tools.schemas()`（无参）只有 global 层**（`chainLayers(undefined)` = `[]`），**不含 preset / agent-plane 工具**。→ `raw/` §6.3 的 `updateInternalTools(schemas(), schemas(agent))` 在 0.2 会漏掉大部分工具。
- `schemas(agent)` 返回的是**已受限视图**。所以「restrict-free 全量目录」只能**在 restrict 之前**快照。
- 没有公开的 `tools.view()` / `knownNames` / `restrictableNames`（`ToolView` 是 private 返回类型，`index.ts:713-721`）。

#### A2.4 `tools/change` —— ⚠️ 会自递归

```ts
// :199-208
'tools/change'(): void   // payload 为空
// :833-836  ScopedLayers.onChange
private readonly layers = new ScopedLayers(scope => new ToolLayer(scope), () => { this.ctx.emit('tools/change') })
// :1119-1123  restrict 用默认 notify=true；:1140 guard 用 notify:false
```

→ `raw/` 的 `tools/change → refreshInternal() + restrictHandle.refresh()` 与 `refresh() → restrict()` 构成真实的递归环。**必须加防重入**（见 `02` §8.3）。

#### A2.5 0.2 有没有官方「工具禁用」？

**没有名字级禁用名单。** 官方只有：

| 机制 | 说明 | 出处 |
|---|---|---|
| `tools.presentAs('native'\|'ptc'\|'both')` | scoped-only，选**呈现形态** | `index.ts:974-999`、`packages/core/agent-tool-presentation/src/index.ts:59-72` |
| tools `Config.mode` | 进程级呈现形态，**无 disabled 列表** | `index.ts:810-813` |
| `tool-subagent.toolFilter` | 子代理工具的 allow/deny，load 期 fail-loud | `packages/subagent/tool-subagent/src/index.ts:82-92,126-129,318-319` |
| preset 组合 | 挂/不挂工具插件 | 见 D2 |

### A3 `ctx.get('systemPrompt')`

#### A3.1 `section()` —— ✅（注意字段名）

```ts
// packages/core/system-prompt/src/index.ts:52-76
export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  readonly interpolate?: boolean
  readonly complete?: boolean
}
// :454-463
section(section: PromptSection): () => void {
  if (!Number.isFinite(section.order)) throw new TypeError(…)
  return this.layers.effect(this.ctx, layer => layer.sections.insert(section.name, section), { label: 'systemPrompt.section()' })
}
```

**没有 `title` 字段**。`order` 建议从 `ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW') + 50` 取，而不是硬编码 `2650`（`SECTION_ORDERS` 里 `TOOL_WORKFLOW: 2600`、`TOOL_RALPH: 2700`）。

#### A3.2 `system-prompt/assemble` —— ⚠️ 签名变了

```ts
// :19-31
'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext,
  next: () => Promise<PromptAssembly>): Promise<PromptAssembly>

// :625-634
const transformed = await this.ctx.waterfall(scopeTarget(this, scope), 'system-prompt/assemble', assembly, context,
  () => Promise.resolve(assembly))
if (completeSection === undefined && !runtimeContextSuppressed) return transformed
return { …transformed, sections: completeSection === undefined ? transformed.sections : [completeSection], … }
```

- **第三个参数才是 `next`**，且 `next()` **不接参数**。0.1.2 的 `(assembly, next)` 写法会把 `context` 当成 `next` → 运行时崩。
- `assembly.sections: AssembledSection[]`（`{name,text,interpolate?}`）**可变**，可以 `await next()` 后 filter 再 return。
- ⚠️ 若某 scope 注册了 `complete: true` 的 section，waterfall 结果会被**还原成那一段**（`:632`），过滤白做。→ 我们的过滤要放在 `next()` 之后、且接受这个边界。
- `agent.ctx.on(...)` 能收到，因为 `assembleContextFor` 显式带 `scope: agent`（`packages/core/agent/src/dispatch.ts:174-176`）。

#### A3.3 `tool:<name>` 命名 —— ✅ 仍是全仓统一惯例

`packages/fs/tool-fs/src/read.ts:70`、`packages/shell/tool-bash/src/index.ts:260`、`packages/workflow/tool-workflow/src/index.ts:324`、`packages/subagent/tool-subagent/src/index.ts:599`。

### A4 `ctx.get('workspaceRegistry')` —— ✅ 名字与同步性都没变，但有了更好的 API

```ts
// packages/workspace/workspace/src/index.ts:170-194
export class WorkspaceRegistry extends Service {
  static inject = ['storageDomain', 'sessionPersistence']
  constructor(ctx: Context) { super(ctx, 'workspaceRegistry') }
// :284-298  同步、无持久化 IO
list(): Workspace[] { return this.requireState().workspaceIds.map(…) }
```

元素字段（`src/types.ts:63-91`）：`id`、`path`、`title`、`createdAt`、`updatedAt`、`sessionIds` + 方法。**没有 `name`**。`path` 是 `fs.realpath` 规范化后的**不可变**值。服务名**不是** `workspaces`。

**新增官方 API**：

```ts
// packages/workspace/workspace/src/index.ts:493-506
/**
 * Resolve by canonical directory path without creating or mutating a workspace.
 * A missing path rejects during `realpath`; an existing unowned directory returns `undefined`.
 */
async resolveByPath(path: string): Promise<Workspace | undefined> {
  const canonical = await realpathNormalize(path)
  for (const entity of this.entities.values()) { if (entity.path === canonical) return entity }
  return undefined
}
```

→ 手写 `realpathSync.native + toLowerCase + 逐条比 list()` 整段删掉。**注意**：路径不存在时 **reject**（不是返回 `undefined`），必须 try/catch；且它用真实大小写，比手写 `toLowerCase` 更准。

**本仓 SDK 已封装**，按 `AGENTS.md` 应直接用：

```ts
// ⟨sd⟩/src/sessions/ensure-workspace.ts:45-50
export async function findWorkspace(ctx: unknown, projectPath: string): Promise<DshWorkspaceLike | undefined> {
  if (projectPath === '') throw new Error('findWorkspace: projectPath must not be empty')
  const registry = getWorkspaceRegistry(ctx)          // ctx.get('workspaceRegistry')，缺则 undefined
  if (registry === undefined) return undefined
  return registry.resolveByPath(normalizeProjectPath(projectPath))
}
```

### A5 `ctx.get('agents')` —— ✅

```ts
// packages/core/agent/src/index.ts:582-588
list(): Agent[] { return [...this.store.values()].map(entry => entry.agent) }
// :590-600 新增 roots(): Agent[]（只看顶层）
```

`Agent` 有 `.ctx`（agent scope 上下文）、`.session`、`.id`、`.options`、`.inbox`、`.status`（`runtime-types.ts:163-242`）。本方案用它来遍历 live agent 做 restrict / skill 遮蔽的重挂。

### A6 `ctx.get('skills')` —— ⚠️ get/snapshot ✅，但遮蔽的落层规则是致命细节

```ts
// packages/skill/skill/src/index.ts:373-374
constructor(ctx: Context, config: Config = {}) { super(ctx, 'skills') … }
// :439-460  register(skill: SkillRegistration): () => void   ← 同步、scope 化
// :470       async list(options: SkillViewOptions = {}): Promise<SkillSummary[]>
// :481       async snapshot(options: SkillViewOptions = {}): Promise<SkillCatalogSnapshot>   ← { skills, complete }
```

`SkillViewOptions = { cwd?: string; signal?: AbortSignal; scope?: ScopeKey }` → 「按工作区列 skill」是原生能力。

`SkillInvocationPolicy`（`:48-54`）字段仍是 `{ modelInvocable, userInvocable }`，**两个都必填**（`:783-795` 缺一半直接 throw）。`SkillRegistration = Omit<SkillDefinition,'invocation'|'provider'> & { invocation?, provider? }`（`:94-100`），`source` 必填、`description` 非空。

**遮蔽的落层规则（本方案最危险的一处）**：

| 规则 | 证据 |
|---|---|
| 跨层 **nearest-wins，无视 rank** | `:551-565`；`skill.spec.ts:1142-1171` 实证 |
| **同层内** 按 `rank → providerOrder → localOrder` 排序，**rank 小者胜** | `:567-582`、`:807-811` |
| runtime skill 固定 `RUNTIME_RANK = 250` | `:25` |
| project skill：`PROJECT_DSH_RANK = 100` / `PROJECT_AGENTS_RANK = 200` | `packages/skill/skill-filesystem/src/index.ts:36-40` |
| 其余：custom 300 / user-dsh 400 / user-agents 500 / bundled 600 | 同上 |

层结构的官方说明（`packages/bundle/web-app/cordis.patch.yml`，`skill-filesystem` 那一行上方）：

> The `skill` REGISTRY stays in the host plane. It is host+per-scope layered (the tools-registry shape): deployment-level providers — repository plugins, a host skill-filesystem row — register into its **global layer**, while a preset's `skill-filesystem` registers into **that preset's layer**, and each agent reads the merged catalog its scope chain selects.

→ **结论**：
- 通过 `agent.ctx.get('skills').register(...)` 注册 → 落 **agent scope 层**（比 preset/global 更近）→ **跨层 nearest-wins 生效，遮蔽成立**。这正是 `raw/dsh-skill-ability.md` §5.2 强调「必须用 `agentCtx.get('skills')`」的原因，0.2 下这条规则**变得更重要**。
- 若图省事从 preset ctx 或 global ctx 注册 → 落**同层** → runtime 250 输给 project 100/200 → **静默漏放**（不报错、不 warn，只有 `.dsh/skills`、`.agents/skills` 里的同名 skill 逃逸）。
- `skills.register` unscoped 时**静默落 global**（`:441-442`、`packages/core/scope/src/store.ts:236-237`），不 throw 不 warn —— 这是 footgun。
- → **`02` §9.3 给出实现 + 一条强制回归测试**（用 project 级同名 skill 验证遮蔽）。

另外四处必须注意：

1. `registerProvider(provider)` 契约变了 → **必须传工厂** `(control) => provider`（`:390-428`，直接传对象 `TypeError: create is not a function`）。本方案不注册 provider。
2. `snapshot` 返回 `{ skills, complete }`，**没有 `incomplete` / `revision`**（`:231-236`）。`raw/` 里的 `incomplete` 改名 `complete`（语义取反）。
3. `invalidateCache` 已 **private**（`:621-625`），不可外部调用；register/dispose 仍同步 revision+1 + 清缓存 + `skills/change`（`:288-297`、`store.ts:257-262`、`vendor/cordis/src/fiber.ts:375-382`）。
4. `skills/change` **不在** client 转发白名单（`packages/api/remotes/src/remote-events.ts:20-48`），插件不可扩充 → 斜杠菜单热刷新仍然做不到（`raw/` §5.7 的妥协继续有效）。

**0.2 新增的官方「按 skill 开关」**（仅对**自己写的 SKILL.md** 有效）：frontmatter `disable-model-invocation: true` / `user-invocable: false`（`packages/skill/skill-filesystem/src/index.ts:1000-1016`，旧键名会被拒）。→ 若用户只想关自己仓库里的 skill，这是零代码方案；「按项禁用 + 工作区覆盖 + 热加载」仍然只能靠本方案。

### A7 `ctx.get('webServer')` —— ✅ 一字不差

```ts
// packages/host/webserver/src/index.ts:38-58
export type WebRouteKind = 'exact' | 'prefix'
export interface WebRoute {
  kind: WebRouteKind
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
// :160-173
register(route: WebRoute): () => void {
  const table = route.kind === 'exact' ? this.exact : this.prefixes
  if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
  table.set(route.path, route)
  return () => { table.delete(route.path) }
}
```

handler 就是原生 `IncomingMessage / ServerResponse`，**没有** `WebRequest/WebResponse` 抽象；`ctx.webServer.route(...)` 之类不存在。另有 `registerUpgrade`（WebSocket）、`registerFallback`（SPA 兜底，唯一）、`tapIndex`、`renderIndex`（`:181-218, 356-361`）。

> 服务所在包是 `@deepseek-ai/dsh-host-webserver`。**`dsh-webide` 这个包不存在**（`raw/` 的 `dsh webide HTTP route` 说法作废，不影响用法）。

---

## 2. 事件

### B1 `agent/created` / `agent/disposed` —— ⚠️ 载荷结构变了（最易静默出错的点）

```ts
// packages/core/agent/src/runtime-types.ts:248-270
/**
 * An entered agent is ready for per-agent initialization after factory setup.
 * Listeners run in order and are awaited before creation resolves. …
 * A throw or rejection fails creation and skips later listeners. …
 * @mode serial
 */
'agent/created'(this: Scoped<Agent>, payload: { agent: Agent; source: SessionStartSource; signal?: AbortSignal }): undefined | Promise<undefined>
'agent/disposed'(this: Scoped<Agent>, payload: { agent: Agent }): void
```

| 性质 | 0.2 现实 | 证据 |
|---|---|---|
| 载荷 | **`{ agent, source, signal? }` 对象**，不是 agent 实例 | 同上 |
| throw | **会 veto agent 创建**（serial） | `packages/core/agent/src/index.ts:549-554` |
| 时机 | 在第一次 assemble **之前**；AgentLoop 在 listeners 完成前不放行队列输入 | `packages/core/agent-loop/src/index.ts:611-631` |
| resume | **会重发** | `agent-loop/src/index.ts:872-882, 754-780` |
| disposed | `emit`，**异常被吞**，不 veto | `agent/src/index.ts:512-525` |
| scope | scope-filtered（agent-scoped 监听器只收自己） | 同上 |

> ⚠️ **最危险的静默 bug**：`raw/` 写的 `ctx.on('agent/created', agent => { … agent.id … })` 在 0.2 会拿到 `{agent,source}` 对象，`agent.id` = `undefined` → workspace 索引全部落空 → guard 走「无 agent 归属，只查全局」分支 → **不报错，只是按工作区配置全部失效**。必须解构，并在 `04` §7 的 T-H13 锁死。

### B2 有没有更合适的挂载点？—— ❌ 没有，`agent/created` 仍是唯一正确点

| 候选 | 为什么不行 | 证据 |
|---|---|---|
| `agent/pre-step` | 跑在 `assemble()` **之后**，对本 step 的工具集**已经太晚** | `agent-loop/src/agent.ts:272-282` |
| `CreateAgentOptions.setup(ctx, agent)` | 语义最好，但**只有调用 `create()/resume()` 的人能传** | `core/agent/src/index.ts:100-118` |
| `session/created` | 更早，但拿不到 agent scope，无法挂 restrict / skill 遮蔽 | `agent-loop/src/index.ts:622-624` |

### B3 skill 侧的热加载链路 —— ✅ 全链路成立

register/dispose 同步失效 → 下一个 pre-step `snapshot` cache key 含 revision → miss → `collectFresh` → `filter(isModelInvocable)` → digest 变化 → 重发 replacement catalog。`MAX_COLLECT_ATTEMPTS = 2`、`snapshot.complete` 优雅跳过（`:23`、`:519-549`、`:643-645`、`tool-skill/src/index.ts:225`）。

且 0.2 把 catalog 状态改由会话历史推导（`:279-311`、`:328-335`），比 0.1.2 更抗 compaction / 重放。

---

## 3. 会话 cwd → workspace

### C1 `agent.session.header.cwd` —— ✅ 字段、类型、不可变性都没变

```ts
// packages/core/session/src/types.ts:91-105
export interface SessionHeader {
  readonly version: typeof SESSION_FORMAT_VERSION
  readonly id: SessionId
  readonly createdAt: number
  /** Absolute working directory the session was created in (if any). */
  readonly cwd?: string
  …
}
// packages/core/session/src/index.ts:464  readonly header: SessionHeader
// :138  return deepFreeze(record as unknown as SessionHeader)
```

### C2 子代理继承父 cwd —— ✅

```ts
// packages/subagent/subagent/src/child-agent.ts:139-157
export function childSessionMeta(parent: Agent, childDepth: number, isSeeded: boolean) {
  const parentHeader = parent.session.header
  const agentPreset = parent.ctx.get('agentPresets')?.composedPreset(parent.ctx)
  return {
    ...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {},
    ...agentPreset === undefined ? {} : { agentPreset },
    parentSession: parentHeader.id, isSeeded, origin: 'subagent', delegationDepth: childDepth,
  }
}
```

→ 「子代理按所在工作区生效」的语义成立；0.2 还额外持久化 `agentPreset`。

### C3 官方 cwd→workspace API —— ✅ `resolveByPath`（见 A4）

---

## 4. 0.2 的新机制（先确认「不是替代品」，别误判）

### D1 `packages/guard` 是什么 —— ⛔ 不是权限体系

只有两个包，README 自述「**循环卫生 guard 家族**」（`packages/guard/README.md:6-12`）：

| 包 | 做的事 | 是否提供工具黑白名单 |
|---|---|---|
| `repeat-tool-reminder` | 监听 `tools/post-execute`，**只加 context，从不 veto** | ❌ |
| `timeout-policy` | `tools/execute` 包装超时 | ❌ |

**两者都没有 `tools.guard()` 调用。** → 自写 `tools.guard` 仍是唯一的「按名字强制拒绝对某个 agent 调用某个工具」挂载点。

0.2 真正的「权限轴」是 `permissionPresets`（只捆绑 `sandbox mode` + `approval policy`，`packages/interaction/permission-presets/README.md:32-52`），作用于「工具**能做什么**」而非「**哪些工具存在**」——与本能力管理**正交**，不可混淆，也不要把它叫「权限」。

### D2 preset 是否原生控制 tools/skills —— ✅ 支持，但是「组合式」

- preset 通过 `plugins` 子行**挂/不挂**工具插件（`packages/preset/agent-preset/README.md:36-46`），**没有名字级黑名单**。
- **preset scope 是 agent scope 的父**（`packages/preset/agent-preset-registry/src/index.ts:241-250` `bindScopeParent`）→ 这正是 restrict 能过滤 preset 工具的根因。
- 可用入口：`agentPresets.composedPreset(ctx)`（`:290`）、`agentPresets.serviceFor(agent, name)`（`:297-299`，读 preset 隔离域里的服务）。

### D3 有没有「按工作区」的官方配置维度 —— ❌ 没有

settings 的维度是 **profile entry id（进程级）**（`docs/subsystems/settings.zh.md:7-13`）；Cordis `isolate()` 是**服务隔离**不是配置命名空间（`vendor/cordis/src/context.ts:115-125`）；`workspaceRegistry` 只有 sessions 归属 / archive / pin / order。

→ 「全局 + 按工作区」**必须由插件自己的 Config 承载**（`workspaces: { [wsId]: … }`）。这反而更好：单实例、单表单、一条 `loader/volatile-update` 热更新通道。

### D4 `createScope` —— ✅ 0.2 用来「可撤销 / 可 refresh」的官方范式

```ts
// packages/core/scope/src/index.ts:104-147
export interface Scope {
  ctx: Context
  rawDispose: () => Promise<void> | void
  dispose(): Promise<void>
}
export interface CreateScopeOptions { parent?: ScopeKey }
export function createScope(ctx: Context, key: ScopeKey, options?: CreateScopeOptions): Scope
```

官方最有参考价值的用例（**本方案应照此实现 restrict 的可 refresh 挂载**）：

```ts
// packages/experimental/browser-use-runtime/src/mcp.ts:108-118
const refreshBlockedMasks = (): void => {
  for (const [agent, state] of clients) {
    if (state.status !== 'blocked') continue
    const inherited = ctx.tools.schemas(agent).filter(tool => tool.name.startsWith(toolPrefix))
    if (inherited.length === 0) continue
    state.mask ??= createScope(ctx, agent)
    state.mask.ctx.tools.restrict({ deny: inherited.map(tool => tool.name) })
  }
}
```

`createScope(ctx, agent)` 用 **agent 当 scope key** → 落**同一层**，但**有独立 dispose 边界** → 刷新时只 `dispose()` 这个 scope，不碰 agent 自己的注册，也不会重复累加 restriction。

> 注意：同 key 再 `createScope` 不会新开层（`ScopedLayers.effect` 复用 `this.scoped.get(agent)`，`store.ts:236-247`），dispose 只撤自己那几条。

### 4.5 ⛔ 已移出范围：命令 与 Agent

原始设计有「工具 / 技能 / 命令 / Agent」四个 tab。**本方案只做工具与技能**。两条移出理由都已在 0.2 源码里确认，结论存档于此，**不进入实现**（配置、UI、文案、测试中一律不出现）。

#### 4.5.1 命令：0.2 没有门禁挂载点

```ts
// packages/interaction/commands/src/index.ts:315
list(agent: Agent): readonly CommandDescriptor[]
// 同服务：register(definition) / registerFileReceiptResolver / find(agent,name) / execute(...)
// packages/interaction/commands/src/types.ts:105-112
'command/run': { commandId; name; args?; source }   // @mode emit（只观察，不能 veto）
'command/done': { … }
```

- `ctx.commands` **没有** `restrict`、**没有** `enabled/hidden` 概念、**没有** `command/pre-execute` waterfall。
- 两个事件都是 **emit**，监听器无法否决一次命令执行。
- → 想做「按项禁用命令」只能改执行器或替换 `list()`，两者都不是 public API 的增量注册。

#### 4.5.2 Agent：`named_subagent` 工具在 0.2 已不存在

原始方案的 guard 有第三个分支：`exec.name === 'named_subagent'` + `exec.arguments.agent`。

- 全仓 grep `named_subagent` **零命中**。
- 0.2 的委托工具是 `subagent`（`packages/subagent/tool-subagent/src/index.ts:2`，工具名 `config.toolName ?? 'subagent'`），且**每个 `ctx.subagents` provider 一个独立插件实例**；模型侧参数里的 `provider` 是 **LLM** provider，不是 subagent provider。
- → 模型根本无法选择 subagent provider，「按 agent 名字禁用」在 0.2 无对应物。想禁「派子代理」只能在**工具**维度禁 `subagent` / `subagent_fork` / `list_agents` —— 那属于工具 tab 的天然能力，不需要单独的 Agent tab。
- `raw/` 里 `dsh-agent-center` 的 `/…/catalog` HTTP 依赖也随之删除，它本来就是 0.1.2 时代的外部插件。

#### 4.5.3 对本方案的净影响

| 项 | 影响 |
|---|---|
| 配置 | 只有 `tools` / `skills` 两个子树（原设计四个） |
| 状态 | 只有 `gate` / `skillGate` 两份（原设计四份） |
| policy | 只有 `buildEffective` 一个函数（tool 与 skill 同构复用） |
| catalog HTTP | 只有 `{ ns, tools, skills, workspaces }`（无 `commands` / `agentPresets`） |
| 前端 | 2 个 tab（原设计 4 个）；无只读态、无 `readOnly.*` 文案 |
| 门禁效力 | **不受影响**：工具与技能两个通道本来就是完整实现的 |

---

## 5. Client 侧

### E1 `settings.section` —— ✅ 未改名，未换 kind

```ts
// packages/client/ui-settings/src/client/contract/slots.ts:57
'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }
// :126-129
export interface SettingsSectionOwnerProps { close: () => void }
```

渲染点只传 `close` 并按 id 过滤（`ui-settings-general/src/client/SettingsRoot.tsx:98-100`）。**`order: 17` 仍精确落在「插件」(15) 与「Agent 预设」(20) 之间**。

0.2 同一 `sidebar.settings` 新增了 `settings.action`（内容列 header 右侧动作位）与 `settings.onboarding`（引导步骤），与本案无关。

### E2 `register` 选项 —— ✅ 字段一致；`label` 是 `string | (() => string)`

```ts
// packages/client/ui-slots/src/index.ts:764-793  KindOptions（list 分支）
{ id: string; order?: number; label?: SlotLabel; priority?: number }
// :811-834  BaseOptions
{ name: K; children?: D; store?: H; locale?: N; registrant?: string }
// :753-758
export type SlotLabel = string | (() => string)
```

`label` **不是** `LocalizedText`（那个只用于 `package.json` 元信息）。`label: () => t('nav')` **完全正确，可照抄**。

### E3 `icon` 字段 —— ❌ 仍然没有，`raw/a.md` §10 的 hack **必须保留**

```tsx
// packages/client/ui-settings-general/src/client/SettingsRoot.tsx:31-39
/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'account') return <IconUserOutlineMedium className={css.navIcon} size={16} />
  if (id === 'models') return <IconDataOutlineMedium className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutlineMedium className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPersonalizationOutlineMedium className={css.navIcon} size={16} />
  if (id === 'archived-sessions') return <IconArchiveOutlineMedium className={css.navIcon} size={16} />
  return <IconSettingsOutlineMedium className={css.navIcon} size={16} />
}
```

投影结构只有 `{ id, order, label }`（`shell-contract.ts:23-28`）。**没有任何 icon 通道。**

核对结论：`'[role="dialog"] nav button'` 选择器**仍命中**；`[MARKER] > svg:first-child{display:none}` **仍成立**；图标容器保持 **16×16**（`size={16}` + `.navIcon{flex:none}`，`SettingsRoot.module.css:167-169`）；`characterData: true` 仍必要。

> **禁止**把 `id` 改成 `'plugins'` 之类去借用图标——同 id + 同 priority 会**直接抛错**（`ui-slots/src/index.ts:1230-1234`），即使不抛也会**替换掉别人的 cell**。

### E4 occupant props —— ⚠️ 可用但要改

```ts
// packages/client/ui-slots/src/index.ts:601-610
export type ComposedProps<K, EntryKey, S, H, I, M, N> =
  PropsRuntime<K, EntryKey> & PropsRenderSlots<S> & PropsRenderFactories
  & PropsStore<H> & InjectFace<I> & MatchedShare<SlotMap[K], M> & PropsLocale<N>
```

| props | `settings.section` 下实际内容 |
|---|---|
| `PropsRuntime` | `{ close }` + `ScopeStandardProps<'root'>`（`useSessions`/`useSessionStatus`/`useSessionRetainInfo`/`useWorkspaces`/`usePanelInfo`/`useResource`） |
| `PropsLocale<N>` | 声明 `locale: NS` 才有 `{ t }`，**自动注入** |
| `PropsStore<H>` | 声明 `store` 才有 `{ useStore, actions }` |
| `InjectFace<I>` | `inject` 工厂返回值（`hooks` 成员变成 `use<Name>`） |

→ `raw/a.md` §4 的 `inject: () => ({ store, locale: ctx.locale, t })` **里 `locale` 和 `t` 都必须删掉**：`t` 与 `PropsLocale` 撞名；`locale`（整个 service 对象）违反「组件永不接触 ctx」（`packages/client/AGENTS.md:41`）。

### E5 `inject` 工厂签名 —— ⚠️ 现在带参数

```ts
// packages/client/ui-slots/src/index.ts:620-627
export type InjectParams<K, H> =
  ScopeOf<K> extends 'session' ? ([H] extends [StoreDecl] ? [sessionId, actions] : [sessionId])
  : ScopeOf<K> extends 'session-maybe' ? (…)
  : ([H] extends [StoreDecl] ? [actions: BoundActions<HandleOf<H>>] : [])
```

root scope：**没声明 store → `() => I`；声明了 store → `(actions) => I`**。

### E6 `ctx.locale` —— ✅ register/bind 一致；❌ 自订阅违规

```ts
// packages/client/locale/src/client/index.ts:389
register<N>(ns: N, dicts: Record<BuiltInLocaleId, LocaleDictOf<N>>): () => void     // BuiltInLocaleId = 'zh' | 'en'
// :399
register(ns: string, locale: string, dict: LocaleDict): () => void
// :448
bind<N>(ns: N): TranslateNS<N>
```

`register(ns, { zh, en })` **仍是正确写法**，没有 `fallback` 参数（fallback 属 `addLanguage`）。类型化重载要求 `zh`/`en` 键集**完全等于** `LocaleNamespaceMap[N]` → 必须做声明合并。

`subscribe` / `getSnapshot` 仍在，但**不该由业务组件调用**：渲染器已为每个 outlet 订阅 locale revision（`packages/client/ui-renderer/src/client/scoped-slots.tsx:344-358`），且 `t` 的函数引用**每个 revision 换新**（`:292-316` 注释明确「freshness rides identity」），`React.memo` 子组件也会正常重渲染。

→ `raw/a.md` §4 的 `locale.subscribe(() => setLocaleTick(...))` **必须删除**。

### E7 `ctx.remote.settings` —— ✅ 方法名与信封都没变

```ts
// packages/api/settings-controller/src/index.ts
@Remote describe(): SettingsDescribeValue                                              // :97
@Remote update(ns, patch, expectedRevision?): Promise<SettingsNamespaceView>            // :115
@Remote replace(ns, section, expectedRevision?): Promise<SettingsNamespaceView>         // :132
@Remote async mutate(ns, ops, expectedRevision?): Promise<SettingsNamespaceView>        // :151
@Remote async openSettingsDocument(signal): Promise<SettingsDocumentOpenValue>          // :166
```

- 信封仍是 `{ ok: true, value } | { ok: false, error }`（`ui-settings/src/client/settings-mirror.ts:183-186`）。
- `value.namespaces[]` 字段：`{ ns, autoGenerate, schema, value, base?, user?, applies, secrets: [{path,set}], revision }`。
- **写 `replace` 要送整段 section**；只想改一个字段用 `update`（浅合并）或 `mutate`（路径编辑）。
- `value` 是 **redacted 解析值**，`user` 才是用户层。本方案无 secret 字段，两者等价；但若将来加 `role('secret')`，必须读 `user`。

**推送事件**：

```ts
// packages/settings/settings/src/types.ts:66-76
'settings/document-updated'(ns: SettingsNamespace, revision: number): void   // @mode emit
// packages/api/remotes/src/remote-events.ts:45
{ event: 'settings/document-updated', mode: 'emit' },                        // ← 在白名单内 ✅
```

→ `ctx.remote.$on('settings/document-updated', cb)` **仍可用**（插件不可扩充白名单，但这个已在里面）。**载荷多了 `revision`**，建议用它去重，避免自己刚写完又触发一次全量重载。

### E8 client 三层 inject 声明 —— ⚠️ 原方案混用了

| 声明 | 单位 | 用途 |
|---|---|---|
| `export const inject = [...]` | **Cordis service 名** | 运行时等待；未满足则 fiber PENDING |
| `package.json` 的 `dsh.client.inject` | **包名** | 模块图/预检 informational；**不参与服务注入** |
| `dsh.client.external` | 模块 specifier | 模块表请求；功能插件不该用 |

正确的两侧写法：

```ts
// src/client.ts
export const inject = ['slots', 'locale', 'remote', 'remote.settings']
```
```json
"dsh": { "client": { "platform": "web", "inject": [
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-settings"
] } }
```

- **`@deepseek-ai/dsh-client-runtime` 在 0.2.0-rc.2 全仓不存在** → 从 `dsh.client.inject` 删除（`raw/dsh-tool-ability.md` §1.2 列了它）。
- **不要**列 `ui-primitives` / `ui-slots` / `client-store` / `react` —— 它们是基线 external，`packages/client/AGENTS.md:78` 明确要求不要重复声明。
- `dsh.client.inject` 只列**被 `import type` 引用**的包名。

### E9 `Tooltip` —— ✅ 全兼容

```ts
// packages/client/ui-primitives/src/Tooltip.tsx:62
{ label, shortcutKeys, side = 'right', align = 'center', delayMs = 0, focusDelayMs = 0, gap = 8,
  disabled = false, portal = false, maxWidth, openOnClick = false, children }
// :13-14  export type TooltipSide = 'right' | 'bottom' | 'top'
```

`side="bottom" / maxWidth={500} / delayMs={1000}` **一字不改**。仍 clone 锚点（`:225-251`）。
**建议开 `portal`**：`.toolScroll{overflow-y:auto; max-height:420px}` 会裁掉 `position:fixed` 之外的气泡（锚点仍在滚动容器的 stacking context 内）。
行为差异：`onFocus` 里 `if (pointerModality()) return`（`:244-248`）——鼠标点击后的聚焦不再弹气泡。

### E10 `Modal` —— ❌ `closeLabel` 仍必填

```ts
// packages/client/ui-primitives/src/Modal.tsx:23-26
type ModalProps = ModalBaseProps & (
  | { headless: true; closeLabel?: never }
  | { headless?: false; closeLabel: string }
)
```

新增 `description?: string`（`Modal.module.css:106-113`），比塞进 `children` 更贴设计；`title` 现在是 `aria-label`（`Modal.tsx:67`）。

### E11 `Button` —— ✅

```ts
// packages/client/ui-primitives/src/Button.tsx:9-17
export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'
size?: 'md' | 'sm'      // md=H36/R12/font14；sm=H28/R8/font12
```

`ghost` / `primary` 仍有效（默认 `ghost`）。

### E12 现成原语替换裁决 —— ⚠️ 大部分**不能**替换

| 原自研件 | 可用的官方原语 | 裁决 |
|---|---|---|
| tab 条（下划线 + 13px） | `SegmentedControl` / `SegmentedTabs` | ❌ 是「分段胶囊 + 滑动指示器」，视觉完全不同 |
| 药丸按钮（H28/R6/0.5px 描边） | `Pill`（H24/R999/无边框） | ❌ 完全不同 |
| 分组批量勾选（无文案 + indeterminate） | `Checkbox`（强制 `label: string`，不暴露 `indeterminate`） | ❌ 会多出文字且丢半选 |
| 搜索框（H30/R6） | `Input`（H32/R12/font14） | ⚠️ 换用即改视觉；官网 README 明确 `Input` 无设计来源，搜索框属 consumer-owned |
| zone 折叠头（12px caret + h3 13px） | `DisclosureRow`（24px 定高 + 两个 chevron 图标） | ❌ 换用即改视觉 |
| 分类色点（任意色 / 8px） | `StateDot`（只有 4 个语义态） | ❌ |
| 「内置禁用」徽标（font10/R5/实心 warn + 反相文字） | `Tag`（12% 淡底 + warn 文字） | ❌ 视觉相反 |
| 工作区下拉浮层 | `Menu` + `MenuSurface` | ✅ **应换**（材质只能由它提供） |
| 二次确认 | `Modal` + `Button` | ✅ 已用 |
| 药丸 Tooltip | `Tooltip` | ✅ 已用 |
| 手写浮层定位/翻转/外点关闭 | `useAnchoredPosition` / `useAnchoredMaxHeight` / `useDismissOnOutsidePointer` | ✅ 可用（若保留自绘） |

**官方原语里没有 `SearchInput`**（全仓 `packages/client` 零命中），且 `README.md:83` 明确「need is genuinely specific 时自己写组件是允许的」。→ 搜索框、药丸、tab 条、zone 头、徽标**保持自研**。

**内联 SVG**：`raw/a.md` §5.10 的 caret 是**填充路径**，与 0.2 的 outline chevron 形状不同 → caret / chevron **保留内联 SVG**；「选中对勾」可换 `IconCheckOutlineRegular`（`Menu.tsx:5,477` 同款，14px）。

### E13 `Menu` 复刻下拉的四个视觉差异

| 维度 | 原 `.dwa-popover` | 0.2 `Menu` |
|---|---|---|
| 外圆角 | 12px | **16px**（`MenuSurface.module.css:3` `--dsw-radius-lg`） |
| 描边 | `0.5px solid border-l4` + elevation | `border:0`，描边在阴影里（stroke 重绑 `border-l1`，`Menu.module.css:8-25`） |
| 底色 | `bg-layer-1` | 半透明 `--dsw-menu-surface-fill` |
| 选中态 | `font-weight:500` + brand-primary | 无字重变化 + 行尾对勾 + 主文字色 |
| 定位翻转 | 自己算 | ❌ **无自动上下翻转**（`side` 是入参，y 只做夹取，`Menu.tsx:276`） |

`portal` + `getAnchorRect` 可解决设置面板 `overflow-y:auto` 的裁剪；`listClassName` 只能调宽高，**不能**改 `background` / `backdrop-filter`（`ui-theme/tests/menu-surfaces.client.spec.ts:73-80` 会拒）。

### E14 store —— ❌ 必须换 `defineStore`

```ts
// packages/client/store/src/contract.ts:56-60
export interface StoreSpec<T, A> { init: () => T; persist?: string; actions: A }
// :132-136
export type PropsStore<H> = H extends StoreHandle<infer T, infer A>
  ? { useStore: SnapshotSelectorHook<T>; actions: BakedActions<T, A> }
  : object
```

`actions` 是**纯 draft 变更，不能 async** → 数据加载 / 写回 / 冲突回滚必须放在 apply 世界的 controller，经 `inject` 的 `hooks` 隔间（`SnapshotStore` 即 `HostObservable`，`ui-slots/src/renderer.ts:35`）暴露。

官方最贴近本需求的范式：`ui-agent-preset/src/client/index.ts:212-230`（`hooks` + 命令回调 + `settings.section` 注册）。

### E15 CSS 交付 —— ❌ 必须换 CSS Modules

共享 tsdown 预设**已内建**三种形态（`packages/client/tsdown.client.ts`）：

| 形态 | 产物 | 位置 |
|---|---|---|
| `*.module.css` | lightningcss `cssModules:{pattern:'[hash]_[local]'}` → 类名映射 + **工厂执行期**注入带 `data-plugin` 的 `<style>` | `:36-56`、`:548-571` |
| `*.css?inline` | 默认导出编译后文本，生命周期交给 `ctx.effect` | `:572-587` |
| 普通 `*.css` | 同 `.module.css` 的注入路径（无类名映射） | `:588-602` |

模块系统在卸载/HMR 时按 `data-plugin` 回收 `<style>`（`modules/src/client/system.ts:454-459`、`entry-lifecycle.ts:19-27`）。→ **绝不在组件 render 里 append `<style>`**。

### E16 主题 token —— ⚠️ 全部存在，但有 4 处语义/数值要改

逐个核对见 `03-client-ability-ui.zh.md` §6。四处**必须**改：

| 原写法 | 问题 | 改为 |
|---|---|---|
| `--dsw-alias-brand-primary` 当品牌蓝（focus 边框 / 选中文字 / 分类色） | 0.2 把它绑到**近黑（浅）/ 近白（深）**（`design-platform.css:192`/`:310`） | `--dsw-alias-state-business-primary` |
| 批量勾选的 `accent-color: brand-primary` | 语义同上，但**这里要保持** | 保持 `--dsw-alias-brand-primary`（官方 `Checkbox.module.css:16` 同款） |
| `border-l4` 深色按 `.16` 理解 | 0.2 深色是 **`.2`**（`:307`） | 用 token，不要写死 |
| `border-radius: 5px / 6px` | 0.2 无这两档，且 lint 拒绝 >4 且 <99 的字面 px（`ui-theme/tests/radius-styles.client.spec.ts:22-28`） | `--dsw-radius-xs`(4) / `--dsw-radius-sm`(8) |

另有一处**无法还原**：0.2 全站 `corner-shape: superellipse(1.5)`（`corner-shape.css:16-25`），所有圆角都是超椭圆。规范禁止组件级 opt-out（`docs/ui-radius.zh.md:52`）。且 `border-radius:50%` 必须同规则配 `corner-shape: round`（spec 强制，`corner-shape-styles.client.spec.ts:83`），否则 8px 分类色点会变 squircle。

### E17 设置面板几何 —— ✅ 数字全部成立

面板 **800px** / 高 `min(800px, 100vh - 2*max(24px, --dsh-frame-overlay-top))` / 圆角 **28px**（`raw/a.md` 写 32 ❌）/ 导航列 **188px** / `.options` padding `0 24px 24px` / header 54px。
→ **内容列宽 = 800 − 188 − 48 = 564px** ✅；`max-width: 760px` 确实永不生效，照抄即可。

### E18 tab 条 CSS —— ✅ 逐值一致

`gap:22px` / `13px` / `line-height:20px` / `padding:7px 1px 9px` / `border-bottom:0.5px` / 下划线 `height:2px` + `border-radius:2px 2px 0 0` + `bottom:-1px` / `align-items:flex-end` / `margin-top:2px` / 静息 `label-tertiary` / hover+激活 `label-primary` / `data-active="true"`。

两处增量：0.2 让 `:focus-visible::after` **也画下划线**；`focus` 环用 `var(--dsw-focus-ring-width)` + `var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))`（`PluginsSettingsSection.module.css:48-65`）。原方案的硬编码 `2px solid` 会被 `focus-ring-styles.client.spec.ts:28-31` 拒绝，也无法被指针抑制（`focus.css:18-21`）。

---

## 6. 包工程

### F1 `dsh.client` 字段集 —— ✅ 但原方案的包名有幽灵

```ts
// packages/util/package-manifest/src/types.ts:80-94
platform: 'web' | string          // 必填；只认 === 'web'（client/modules/src/index.ts:841-844）
inject?: string[]                 // 包名依赖边
immediately?: boolean             // 一阶段预取，仅基础设施（client/web/src/boot.ts:115-122）
external?: string[]               // 模块表请求
```

**没有 `entry`**。`@deepseek-ai/dsh-client-runtime` 在 0.2 全仓不存在 → 删除。

### F2 `dsh.bundle` —— ✅

`patch: string | string[]`（`types.ts:68-72`、`app-boot/src/profile.ts:58-64`）。`dsh plugin add` 只改 **profile 的 `package.json`** 里 `dsh.profile.bundles`（`plugin-manager/src/operations.ts:88-113`）。

### F3 `exports["./client"]` —— ❌ 形状有强制校验

必须是 **string** 或**含 `default` 的对象**；写成 `{ import: … }` 会抛 `exports["./client"] must be a string or an object with a string default`（`client/modules/src/index.ts:194-205, 845-848`）。

`./cordis.patch.yml` **不需要**导出（profile 走文件系统 join，`profile.ts:73-75`），但 `files` 必须包含它。

### F4 peer 兼容 —— ❌ `raw/` 的版本范围「能过闸但零保护」

```ts
// packages/boot/app-boot/src/plugin-compatibility.ts:61-88
// 只查 @deepseek-ai/dsh 与 @deepseek-ai/dsh-*（第 75 行）
semver.satisfies(runtimeVersion, range, { includePrerelease: true })
```

实测（semver 7.8.5，runtime `0.2.0-rc.2`）：

| range | 结果 |
|---|---|
| `>=0.1.2-rc.1` | **true（照样通过——零保护）** |
| `^0.1.2-rc.1` | **false（被拦）** |
| `>=0.2.0-rc.2` / `^0.2.0-rc.2` / `~0.2.0-rc.2` | true |
| `workspace:*` | 被替换为 runtime，恒过 |

**`cordis` / `schemastery` 根本不进这道闸。** 不满足时：组合期把行 `disabled:true` + stderr `dsh: disabling profile plugin row "…"`（`compatibility-preflight.ts:79-83,101-118`）；安装/启用期直接拒（`plugin-manager/src/index.ts:546-547,721-723`）。

→ 全部 peer 写 `>=0.2.0-rc.2`。

### F5 `engines.dsh` —— ❌ 零读取方

全仓 grep 只剩类型声明，`package-manifest/README.md:93` 明文「不强制检查 `engines.dsh`」。→ **删除**。

### F6 `allow-version` —— ⚠️ 别靠它兜底

`package@version` 与 `--dsh-version` 都必须是**精确版本**，allow 时 `--dsh-version` 必须等于当前运行时，必须 `--accept-risk`，存 profile 的 `compatibility.json`，且**不重载已加载实例**（`apps/cli/src/plugin.ts:17-62`、`app-boot/src/profile-compatibility.ts:113-141`）。

### F7 依赖分区 —— ⚠️

| 类别 | 放哪 | 说明 |
|---|---|---|
| `@deepseek-ai/cordis`（实际 4.0.4） | peer + dev | `^4.0.4` |
| `@deepseek-ai/dsh-settings` / `dsh-tools` / `dsh-system-prompt`（若要 import 类型/值） | peer + dev | `>=0.2.0-rc.2` |
| `@deepseek-ai/schemastery`（实际 3.18.4） | dependencies 或 peer+dev | `^3.18.4`；导入是 **default import 本地名 `z`** |
| 所有 client 包（locale / api-remotes / ui-settings / ui-slots / ui-primitives / client-store / ui-renderer）+ `react`/`react-dom` | **只 dev** | 基线模块由 shell 模块表注入（`packages/client/AGENTS.md:62-66`、`docs/user/develop/basic/publish.zh.md:103`） |

### F8 `cordis.patch.yml` —— ✅ 方言未变

`insert`（带 id → 插进 `group:true` 行的 config；不带 id → 顶层追加）/ 按 id 覆盖 / `group` + `isolate` / `disabled` / `!!js`。
`!!js` 在**该行 fiber 的 `internal/config`** 里求值，实现是 `new Function('ctx','expr','with (ctx) { return eval(expr) }')`（`vendor/loader/src/config/utils.ts:5-9`、`vendor/loader/src/index.ts:104-113`）——所以 `!!js ctx.webStartup.port` 里的 `ctx` 是函数参数，**服务必须先 `inject`**。
官方范式：`packages/bundle/web-app/cordis.patch.yml:169-177`。

`name` **只对覆盖类 patch** 做断言（不一致 → warn + 整条跳过，`vendor/include/src/index.ts:115-118`）；`config` **整体替换不深合并**（`include/src/index.ts:120-123`）。insert 行的 `name` 就是模块 specifier，**必须与 package.json 的 `name` 完全一致**。

### F9 `bare 包名行才挂 ./client` —— ✅ 仍成立

`client/modules/src/index.ts:827-833`（subpath 行「permanently not a client row」）+ `:841-848`。→ host+client 单包必须有一行裸名。

### F10 client bundle 契约 —— ✅ 全部一致

```ts
// packages/client/tsdown.client.ts:604-625
entryFileNames: 'client.js'
chunkFileNames: 'client.[name].js'
banner: (chunk) => `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`
intro: 'var module = { exports: {} }; var exports = module.exports;'
footer: 'return module.exports; } });'
```

- `format:'cjs'` / `platform:'browser'` / `outDir:'lib'` / `dts:false` / `sourcemap:true` / `clean:false`（`:477-498`）。
- chunk 动态导入被改写成 `require.async("./client.<name>.js")`（`:437-471`）；chunk 不得同步 require 兄弟 chunk。
- 三个 define 缺一不可：`process.env.NODE_ENV`、`import.meta.env.MODE`、**裸 `import.meta.env`**（`:522-527`）。
- **externals 就是 9 个，没增没删**；`PRELOADED_CLIENT_EXTERNALS` 是空数组：

```ts
// packages/client/web/src/platform.ts:7-21
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
] as const
```

→ `dsh-client-locale` / `ui-theme` / `ui-renderer` / `api-remotes` **都不在表里，不能当 external**，只能 `import type`，值走 `ctx.locale` / `ctx.remote`。

- purity gate 在构建期（`:528-546`，报错原文 `client bundle purity: "…" is not in …`）与运行期镜像（`modules/src/client/system.ts:379-385`）各一份。

### F11 sourcemap 说法纠正 —— ⚠️

`/plugins/<包名>/client.js.map` **不是可达路由**，它只是 indexed map 里 `sources` 的解析基准（`client/modules/src/index.ts:353-368`）。真实路由是 prefix `/plugins`（`:649`），只命中 combo（`/plugins/??<pkg>/client.js[.map]&rev=`，`:227-235`）与 chunk（`/plugins/<pkg>/client.<name>.js[.map]?rev=`，`:248-251,1086-1094`），其它一律 404（`:1146-1148`）。

### F12 `./locale/*.json` + icon —— ⚠️ `raw/` 漏了

要在 Plugins 页显示中文名/描述，必须：`exports` 加 `./locale/*.json`，**且必须存在 `locale/en.json`**（否则一个语言都不读，`app-boot/src/package-meta.ts:101-122,151`）。`icon`：相对路径 + svg/png/jpeg/webp + **≤256 KiB** + realpath 必须在包目录内（`package-meta.ts:14-39`）。

### F13 「参考包」要换

- `dsh-magica-spellbook` 是**库**（无 `dsh` 字段；client 产物是 **ESM**；`exports["./client"]` 用了 `import` 键——一旦补 `dsh.client` 就会抛 F3 的错）。只能抄它的 externals 清单。
- 真正的 0.2 插件范式在本仓：**`dsh-magica-spellbook/.e2e/plugin/`**（`dsh.bundle.patch` + `dsh.client{platform,inject}` + `exports["./client"]` 字符串 + 3 行 insert patch + 闭包工厂 client.js）。实测只 require 3 个基线模块。
- `dsh-magica-teamwork` 是 host-only CLI（无 `dsh` / 无 `./client` / 无 patch），只能证明「单文件 `lib/` + 独立 `.d.ts`」的构建习惯。

---

## 7. 五个「静默失效」陷阱（比编译错误危险得多）

| # | 陷阱 | 症状 | 防线 |
|---|---|---|---|
| 1 | `agent/created` 没解构 `{ agent }` | `agent.id === undefined` → workspace 索引全落空 → guard 走「只查全局」→ 按工作区配置**全部静默失效** | 类型 + 一条断言 `typeof agentId === 'string'` 的日志；`04` T-H13 |
| 2 | skill 遮蔽注册在 preset/global 层 | 落同层 → rank 250 输给 project 100/200 → `.dsh/skills` / `.agents/skills` 同名 skill **静默逃逸** | 必须 `agent.ctx.get('skills')`；`04` T-H8 用真 project skill 回归 |
| 3 | 用 `tools.schemas()` 当全量目录 | 只含 global 层 → preset 工具在 UI **看不到**，也就永远禁不掉 | 只用 `tools.schemas(agent)`，且在 restrict **之前**快照 |
| 4 | `tools/change` → refresh → restrict → `tools/change` | 递归风暴 / CPU 打满 | 防重入标记 + 只在真变化时刷；`04` T-H12 |
| 5 | `restrict` 传了未知名 | 抛错 → 若被宽 catch 吞掉，该 agent **完全没有 restrict**，只靠 guard 兜底（token 省不下来） | 先用可见名字预过滤 + catch 时 `logger.warn` 带 agentId；`04` T-H6 |

---

## 8. 结论

- **架构骨架成立**：guard（强制）+ restrict（省 token）+ assemble 过滤 + skill 遮蔽 + agent/created 解析 + webServer 目录接口，全部挂载点都在，语义基本不变。
- **实现层要换的比 `raw/` 预想的多**：配置层是**整体换掉**（不是改签名），`agent/created` 载荷、`system-prompt/assemble` 签名、`tools.schemas` 覆盖面、`tools/change` 自递归、skill 遮蔽落层这五处都会让照抄的代码**静默出错**而不是编译报错。
- **命令与 Agent 移出范围**（§4.5），对工具 / 技能两个通道的效力**零影响**。
- **前端视觉只需 4 处映射**（brand-primary / border-l4 深色 / 5-6px 圆角 / focus 环），其余 **一字不改**；另一个无法还原的是全站超椭圆圆角。
