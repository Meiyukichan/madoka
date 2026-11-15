# 02 · Host 侧：能力门禁详细设计

> 目标：在**不触碰 agent loop** 的前提下，按「全局 + 工作区」两级配置，在运行时拦截 / 隐藏被禁的 tool、skill；对 command / agent 提供只读目录。
>
> 路径约定同 `01`：`packages/…` = DSH 0.2.0-rc.2 源码；`⟨rune⟩/…` = 本包 `src/…`。

---

## 1. 模块划分

```
⟨rune⟩/src/                       # host 半侧
  index.ts              apply(ctx, config)：唯一入口，按序组装，全部副作用收进一个 ctx.effect
  config.ts             Config schema（volatile-safe）+ 默认值 + AbilityConfig 接口
  types.ts              跨模块共享的内部类型（EffectiveGate / ToolCatalogEntry / AgentLike / ToolExecutionLike…）
  policy.ts             纯函数：BUILTIN_DISABLED / NON_DISABLEABLE / RESERVED + buildXxxEffective
  state.ts              GuardState：gate(tool) / skillGate(skill) + agentWorkspace + internalTools + 查询方法
  workspace.ts          工作区索引：agent/created → Map<agentId, wsId>
  guard.ts              主通道：tools.guard
  restrict.ts           辅通道：per-agent createScope + tools.restrict + system-prompt/assemble 过滤
  skill-gate.ts         skill 遮蔽：agentCtx.get('skills').register(同名, invocation 双 false)
  catalog.ts            HTTP：GET /rune-ability/catalog（+ workspaces）
  router.ts             极小的 JSON 路由辅助（sendJson / sendMethodNotAllowed / sendError，约 60 行）
```

依赖方向：`index → {config, state, workspace, guard, restrict, skill-gate, catalog}`；`state/policy` 不依赖 Cordis；`guard/restrict/skill-gate/catalog` 只依赖 `state` + `ctx`。**policy 是纯函数，可单测，无 ctx。**

---

## 2. 配置层（替换 `settings.register`）

### 2.1 schema（volatile 边界是硬约束）

```ts
// ⟨rune⟩/src/config.ts
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

/** 一层门禁：disabled = 本层新增禁用；enabled = 本层恢复上层禁用（相对增量）。 */
export interface AbilityLayer {
  disabled: string[]
  enabled: string[]
}
/** 一个能力类别：全局层 + 按 workspaceId 的覆盖层。 */
export interface AbilityKindSettings {
  global: AbilityLayer
  workspaces: Record<string, AbilityLayer>
}

/** ⚠️ `.volatile()` 绝不能出现在 dict / array 内部（schemastery 会抛 ValidationError）。 */
const layer = () => z.object({
  disabled: z.array(z.string()).default([]),
  enabled: z.array(z.string()).default([]),
})

/**
 * 一个 kind。volatile 落在这个 **固定路径** 的对象上：
 *   tools: Volatile<AbilityKindSettings>
 * 内部的 workspaces 是 dict，其 value 被 schemastery 标记为 blocked —— 只要里面不再出现
 * `.volatile()` 就完全合法。
 */
const kind = () => z.object({
  global: layer().default({ disabled: [], enabled: [] }),
  workspaces: z.dict(layer()).default({}),
}).default({ global: { disabled: [], enabled: [] }, workspaces: {} }).volatile()

export interface Config {
  tools: Volatile<AbilityKindSettings>
  skills: Volatile<AbilityKindSettings>
}

export const Config: z<Config> = z.object({
  tools: kind(),
  skills: kind(),
})
```

> **只有两个 kind**：命令与 Agent 两类已移出范围（见 `01` §4.5），配置里不存在对应子树。

**为什么必须 volatile**：0.2 的 settings 服务拒绝对非 volatile 字段写入（`packages/settings/settings/src/index.ts:385-389`）；而且 volatile 字段让配置改动走 volatile-only 路径（`vendor/loader/src/config/entry.ts:144-149`），**不 remount 插件**。

**为什么不能嵌 volatile**：`vendor/schemastery/src/index.ts:488-509` 的 `validateVolatileSchema` 对 dict 的 value 与 array 的元素都置 `blocked = true`，一旦内部再出现 `.volatile()` 直接抛
`volatile fields require a fixed object path without an enclosing volatile field`。

### 2.2 设置命名空间（`ns`）

0.2 的 settings namespace **就是 profile 里那条 patch 行的 `id`**（`packages/settings/settings/src/index.ts:317` `entry.options.id as SettingsNamespace`）。

```ts
// ⟨rune⟩/src/namespace.ts
/** 必须与 cordis.patch.yml 的 insert.id 完全一致；改名会让前端写不回去。 */
export const ABILITY_NS = 'dsh-magica-rune'
```

**启动自检**（防止有人覆盖 patch 时改了 id 导致前端静默写失败）：

```ts
ctx.inject(['settings'], (child) => {
  child.effect(() => {
    const found = child.settings.describe().some(d => String(d.ns) === ABILITY_NS)
    if (!found) {
      ctx.logger.warn(
        `ability: settings namespace "${ABILITY_NS}" not found; the ability page cannot persist. `
        + 'Check that cordis.patch.yml inserts this package with id "' + ABILITY_NS + '".')
    }
    // 关掉「插件」页为本 entry 自动生成的大表单
    return child.settings.configure({ auto: false }, ctx.fiber)
  }, 'ability: settings self-check')
})
```

> `settings` 是**可选**依赖（走 `ctx.inject` 而非 `inject`），未挂载时门禁照常工作，只有前端持久化降级。

### 2.3 读取与热更新

```ts
// apply(ctx, config) 内
const readSettings = (): AbilitySettingsValue => ({
  tools: config.tools.get(),      // Volatile.get() → 不可变快照
  skills: config.skills.get(),
})

state.sync(readSettings())                                  // ① 种子
ctx.effect(() => ctx.on('loader/volatile-update', () => {    // ② 热更新
  state.sync(readSettings())
  restrictHandle.refresh()      // 只重挂 restrict/assemble 的 scope
  skillHandle.refresh()         // 只重挂 skill 遮蔽
}), 'ability: config watch')
```

语义依据（`vendor/loader/src/config/entry.ts:162-195`）：`_commitVolatile()` 用 `updateVolatile(ref, source)` **原地改写**引用，再 `emit('loader/volatile-update', paths)`。→ `apply` 收到的 `config` 是**活对象**，`.get()` 永远是最新值；**guard 闭包不需要重挂**（它读 `state` 的引用）。

### 2.4 写入路径（前端 → host）

前端不直连本插件，而是走 DSH 已生成的 `ctx.remote.settings`：

| 操作 | 调用 | 说明 |
|---|---|---|
| 读 | `ctx.remote.settings.describe()` | 取 `namespaces.find(n => n.ns === ABILITY_NS)` 的 `value` + `revision` |
| 写整段 | `ctx.remote.settings.replace(ABILITY_NS, section, revision)` | section = `{ tools, skills }` |
| 写单点 | `ctx.remote.settings.mutate(ABILITY_NS, [{ op:'set', path:['tools','workspaces',wsId,'disabled'], value:[…] }], revision)` | 路径编辑，避免整段重述 |
| 冲突 | 返回 `{ ok:false, error }` 且 host 抛 `SettingsConflictError` | 前端 `load()` 重读对账 |
| 推送 | `ctx.remote.$on('settings/document-updated', (ns, revision) => …)` | 事件在白名单内（`packages/api/remotes/src/remote-events.ts:45`） |

> 前端只需配置 `export const inject = ['slots','locale','remote','remote.settings']`；host 侧**不需要**任何 remote 代码——`@deepseek-ai/dsh-api-settings-controller` 已经把 `settings` 投影成 `ctx.remote.settings`。

**写入最终落盘在哪**（常见误用：以为存在一个独立的 `~/.dsh/settings.yaml#ability` 段）：`settings.replace` → `SettingsForms.write` → `configEditor.edit()`，而 `configEditor.documentPath = profileContext.patchPath`——也就是**用户 profile 自己的 `cordis.patch.yml`**，落成一条按 id 覆盖的行（`packages/boot/config-editor/src/index.ts:33-34, 87-142`）。

→ 因此：
- **本包自带的 `cordis.patch.yml` 不写 `config`**（只 `insert` 那行）。写了会成为组件期的 base 层；而 patch 整体替换、不深合并，schema 默认值一旦演进，陈旧 yaml 值会盖住新默认。
- 用户想手改，就在**profile 的** patch 里加 `- id: dsh-magica-rune` + 完整 `config`（整体替换，要重述全部键）。
- 若该行被 home patch / CLI overlay 覆盖，页面写入会抛 `overridden by a home patch or command-line overlay`（`:140`）并回滚。

---

## 3. `policy.ts` —— 纯函数合并语义

### 3.1 生效集合公式

```
global(tool) = BUILTIN_DISABLED
             ∪ s.tools.global.disabled
             − { n ∈ s.tools.global.enabled | n ∉ BUILTIN_DISABLED }
             − RESERVED
             − NON_DISABLEABLE

effective(wsId) = global(tool)
                ∪ ws.disabled
                − { n ∈ ws.enabled | n ∉ BUILTIN_DISABLED }
                − RESERVED
                − NON_DISABLEABLE
```

**关键不变量**：工作区 `enabled` **只能恢复用户自己加的禁用**，不能恢复 `BUILTIN_DISABLED`（产品决策，替代品存在）。实现上就是 `mergeLayer` 里那句 `if (builtin.has(name)) continue` 守卫。

`effective(wsId)` **已折叠 global**，所以 guard 热路径一次查找即可，**不能先查 global 再查 ws**（那会让全局禁用否决工作区 `enabled`）。

### 3.2 名单（三张，全部可在 `cordis.patch.yml` 改）

```ts
// src/policy.ts —— 名单是**配置**，不是硬编码；这里只是 schema 默认值（patch 才是权威）
export const DEFAULT_TOOL_BUILTIN_DISABLED   = []                              // 开箱即禁（enabled 不可恢复）
export const DEFAULT_TOOL_NON_DISABLEABLE    = ['run_code', 'sandore_*']       // 永不禁（'*' = 前缀）
export const DEFAULT_SKILL_NON_DISABLEABLE   = [
  'dsh-plugins-principles',
  'sandore-workflow-authoring',
  'cordis-plugin-development',
  'editing-cordis-compositions',
]

/** 不可通过配置解除的硬保护（API 级约束，不是偏好）。 */
export const HARD_RESERVED = new Set(['run_code'])
```

**为什么只有三张表**（不必凑第四张）：「restrict 不能命名」不单独设表——`restrict` 只 deny 那些**没通过** `toolProtected()` 的名字，所以名单 ② 自动承担了「RESERVED」的职责：

```ts
toolProtected(name) = HARD_RESERVED.has(name) || matches(nonDisableable, name)
```

`run_code` 同时被两重保护：写进名单 ② 只是让它在 yaml 里**可见/自解释**；代码里的 `HARD_RESERVED` 保证「即使有人把它从 yaml 删掉也照样保护」。它是 PTC 呈现传输（不是能力工具），`tools.restrict` 命名它会抛错（`packages/core/tools/src/index.ts:1111-1112`）、注册同名工具被拒（`:1080-1081`）。

**三张表的三个用途**（同一份 `toolProtected` 谓词驱动）：

| 用途 | 行为 |
|---|---|
| guard | 受保护的名字恒放行（`denied()` 返回 false） |
| restrict | `restrictableNamesFor()` 直接剔除 → 永不进 deny 列表 |
| catalog / UI | 不下发 → 页面**看不到**一个点了没用的开关 |

> **设计取舍**（必须记录）：把 `cac_web_search` / `playwright` / `describe_image` / `sandore_*` 写进 `NON_DISABLEABLE`、把 `web_search`/`web_fetch`/`workflow` 写进 `BUILTIN_DISABLED`，属于「自带替代品」那类产品的**产品决策**，不是能力管理的通用语义。本包的语义是通用能力管理，所以两张表都是**可配置**的，出厂默认取保守值（`builtinDisabled: []`）。

### 3.3 折叠函数

```ts
export interface EffectiveGate {
  global: ReadonlySet<string>
  workspaces: ReadonlyMap<string, ReadonlySet<string>>
}

function mergeLayer(base: ReadonlySet<string>, layer: AbilityLayer, builtin: ReadonlySet<string>): Set<string> {
  const next = new Set(base)
  for (const name of layer.disabled) next.add(name)
  for (const name of layer.enabled) {
    if (builtin.has(name)) continue          // ← 内置禁用不可恢复
    next.delete(name)
  }
  return next
}

/** 只折叠「内置禁用 + 用户覆盖」；受保护名单在查询期剔除（因为前缀规则塞不进 Set）。 */
export function buildEffective(kind: AbilityKindSettings, builtin: ReadonlySet<string>): EffectiveGate {
  const global = mergeLayer(builtin, kind.global, builtin)
  const workspaces = new Map<string, ReadonlySet<string>>()
  for (const [wsId, layer] of Object.entries(kind.workspaces)) {
    workspaces.set(wsId, mergeLayer(global, layer, builtin))
  }
  return { global, workspaces }
}
```

`skills` 用同一个 `buildEffective`（传 `builtin = ∅`）。两个 kind 完全同构，共用一份实现。

---

## 4. `state.ts` —— 热路径唯一数据源

```ts
export class GuardState {
  /** 名单匹配器：`run_code` 的硬保护在 Policy 内部，与配置无关。 */
  policy = new Policy({ toolBuiltin: [], toolNonDisableable: [], skillNonDisableable: [] })
  gate: EffectiveGate = emptyGate()        // tool
  skillGate: EffectiveGate = emptyGate()   // skill

  /** agentId(string) → workspaceId；只由 workspace.ts 在 agent/created 写。 */
  readonly agentWorkspace = new Map<string, string>()
  /** restrict 之前的全量工具快照（只增不减）。 */
  readonly internalTools = new Map<string, ToolCatalogEntry>()
  /** skill 的原始 description 缓存（遮蔽前抓，供 catalog 用；只增不减）。 */
  readonly skillDescCache = new Map<string, SkillCatalogEntry>()

  sync(input: StateInput): void { /* 重建 policy + 两份 gate */ }
  updateInternalTools(entries: readonly ToolCatalogEntry[]): void { /* 见 §10.3 */ }
  updateSkillDesc(entries: readonly SkillCatalogEntry[]): void { /* 同「只增不减」语义 */ }

  /** guard 热路径：零 IO、O(1)、不抛。受保护的名字恒 false。 */
  denied(agentId: string | undefined, name: string): boolean {
    if (this.policy.toolProtected(name)) return false
    return resolve(this.gate, this.workspaceOf(agentId)).has(name)
  }
  isSkillDenied(agentId: string | undefined, name: string): boolean {
    if (this.policy.skillProtected(name)) return false
    return resolve(this.skillGate, this.workspaceOf(agentId)).has(name)
  }
  /** restrict 用：已剔除受保护项，可直接喂给 `tools.restrict({ deny })`。 */
  restrictableNamesFor(agentId: string | undefined): string[]
  /** assemble 过滤用：与 restrict 同源。 */
  effectiveNamesFor(agentId: string | undefined): ReadonlySet<string>
  /** skill 遮蔽用：已剔除受保护项。 */
  effectiveSkillNames(agentId: string | undefined): string[]

  private workspaceOf(agentId: string | undefined): string | undefined {
    return agentId === undefined ? undefined : this.agentWorkspace.get(agentId)
  }
}
```

**为什么 `denied` 不先查 global**：工作区 set 已折叠 global 与自身覆盖；先查 global 会让「全局禁 A + 工作区恢复 A」失效。这是本设计最关键的不变量，热路径的所有查找都必须服从它。

---

## 5. `workspace.ts` —— cwd → workspaceId

> 语义：`agent/created` 时解析一次，成功就 `set`、解析不出来就 `delete`（`agent/disposed` 也删）。
> 解析失败的四种情况都是**正常退化**，不是错误：
>
> | 情况 | 结果 |
> |---|---|
> | `cwd` 为空（header 未填） | 不解析，无映射 |
> | `workspaceRegistry` 尚未就绪 | 无映射 |
> | `realpathNormalize` 抛错（目录不存在 / 路径未完全限定） | 无映射 |
> | `resolveByPath` 返回 `undefined`（该目录不是**已注册**工作区根） | 无映射 |
>
> 无映射时 `resolve()` 只看全局层——这是**设计意图**：不是工作区根目录的会话，工作区级策略不适用。
> 另外注意 `resolveByPath` 是**精确等值匹配**，子目录 cwd 匹配不上父工作区。

```ts
// findWorkspace 定义在本文件末尾：把 ctx.get('workspaceRegistry') 包成
// async findWorkspace(ctx, path) => Promise<{ id, title, path } | undefined>
import type { Scope } from '@deepseek-ai/dsh-scope'

export function installWorkspaceIndex(ctx: Context, state: GuardState): () => void {
  return ctx.effect(() => {
    const off = ctx.on('agent/created', async ({ agent }) => {
      const agentId = String(agent.id)
      try {
        const cwd = agent.session.header.cwd
        const ws = cwd === undefined || cwd === '' ? undefined : await findWorkspace(ctx, cwd)
        if (ws === undefined) {
          state.agentWorkspace.delete(agentId)                    // 不属于任何注册工作区 → 回退全局
        } else {
          state.agentWorkspace.set(agentId, String(ws.id))
        }
      } catch (error) {
        state.agentWorkspace.delete(agentId)                      // 解析失败 = 回退全局，绝不 throw
        ctx.logger.warn(`ability: workspace resolve failed for agent ${agentId}: ${String(error)}`)
      }
    })
    const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      // 只清本模块负责的那份状态；restrict 的 mask scope / skill 遮蔽由各自模块的
      // agent/disposed 监听清理，互不越界。
      state.agentWorkspace.delete(String(agent.id))
    })
    return () => { off(); offDisposed() }
  }, 'ability: workspace index')
}
```

要点：

| 点 | 说明 |
|---|---|
| **必须解构 `{ agent }`** | 0.2 的载荷是对象（`packages/core/agent/src/runtime-types.ts:261`）。不解构 → `agent.id === undefined` → **全部静默降级为只查全局** |
| **绝不 throw** | `agent/created` 是 `serial`，throw 会让 **agent 创建失败**（`packages/core/agent/src/index.ts:549-554`） |
| **`findWorkspace` 而非手写 realpath** | 内部走 `workspaceRegistry.resolveByPath()`（`packages/workspace/workspace/src/index.ts:493-506`），物理 canon 由 dsh 唯一负责；本包的 `findWorkspace` 自带空串校验与 registry 缺失降级 |
| **不自己做 Windows 大小写归一** | `resolveByPath` 用 `fs.realpath` 的真实 case，比 `toLowerCase` 准 |
| **冷路径** | 只在 `agent/created` 跑一次；guard 热路径零 IO，只查 Map |
| 子代理 | `childSessionMeta()` 让子代理继承父 `cwd`（`packages/subagent/subagent/src/child-agent.ts:139-157`）→ 自动命中同一工作区；若被派到别的 cwd 则命中那个工作区（正确语义） |

---

## 6. `guard.ts` —— 主通道（权威）

```ts
import { RESERVED } from './policy.ts'

export function installGuard(ctx: Context, state: GuardState): () => void {
  // ⚠️ 必须用插件顶层 ctx（unscoped）注册 → 落全局层 → 对所有 agent（含子代理）生效
  return ctx.effect(() => ctx.tools.guard((exec) => {
    try {
      if (RESERVED.has(exec.name)) return undefined
      const agentId = exec.agent === undefined ? undefined : String(exec.agent.id)

      // ① 工具名门禁
      if (state.denied(agentId, exec.name)) {
        return `ability: tool "${exec.name}" is disabled by settings`
      }

      // ② skill 工具的参数门禁（exec.arguments，不是 args）
      if (exec.name === 'skill') {
        const name = (exec.arguments as { name?: unknown } | undefined)?.name
        if (typeof name === 'string' && state.isSkillDenied(agentId, name)) {
          return `ability: skill "${name}" is disabled by settings`
        }
      }
      return undefined
    } catch (error) {
      // guard 体内绝不 throw：throw 会走 toolErrorResult 异常路径，后续 guard 不再执行
      ctx.logger.warn(`ability: guard failed: ${String(error)}`)
      return undefined
    }
  }), 'ability: tool guard')
}
```

语义核对（全部来自 0.2 源码）：

| 性质 | 证据 |
|---|---|
| 签名 `(exec: Readonly<ToolExecution>) => string \| undefined` | `packages/core/tools/src/index.ts:731` |
| 全局层优先，再走 scope 链 → 顶层注册覆盖所有 agent | `:1144-1154` |
| 执行位置：`tools/pre-execute` 之后、body 之前 | `:1503-1531` |
| `return string` = 干净的模型可见拒绝（`Error: <reason>`） | `:1519-1531` |
| **单调**：没有任何 guard 能强行放行 | `:1126-1135` |
| 与 `tools/pre-execute` 的分工 | pre-execute 是**可重排 waterfall**（后续能改回 allow），guard 是**只增不减**。**强制禁用必须用 guard** |

> **不做的分支**：`named_subagent` + `args.agent` 这类分支随「Agent」一类一起移出范围（0.2 无该工具，全仓零命中），guard 只保留 **工具名** 与 **`skill` 参数名** 两条判定。

---

## 7. `restrict.ts` —— 辅通道（省 token）

> **两条不变量**：
>
> 1. **顺序**：先算目标 deny 集，再决定动不动旧 mask。反了（先 `dispose()` 再看目标集为空就
>    `return`）会让 mask 永久丢失：旧 mask 已撤、新 mask 又不建。现在 deny 指纹未变就直接返回。
> 2. **补齐**：`agent/created` 只覆盖「我们已在监听时」创建的 agent。插件晚于会话启用
>    （loader 热重载、`plugin add` 后继续旧会话）时，那些 agent 从没进过索引，`refresh()`
>    刷不到它们 → 设置里已禁用、guard 也拒绝，但模型工具表里仍然有。
>    因此 apply 时与每次 `refresh()` 都执行 `agents.list()` 补齐（`seedFromRegistry()`）。

### 7.1 为什么用 `createScope` 而不是 `agent.ctx` 直接挂

`agent.ctx.tools.restrict()` 虽然合法，但撤不掉单条（只能等 agent 销毁），而 settings 一变就要重挂。0.2 的官方范式是 **per-agent 独立 scope**：

```ts
// packages/experimental/browser-use-runtime/src/mcp.ts:108-118
state.mask ??= createScope(ctx, agent)
state.mask.ctx.tools.restrict({ deny: inherited.map(tool => tool.name) })
```

`createScope(ctx, agent)` 用 **agent 当 scope key** → 落**同一层**（`ScopedLayers` 复用同一 layer，`packages/core/scope/src/store.ts:236-247`），但**有独立 dispose 边界** → 刷新时 `dispose()` 这个 scope 即可，不碰 agent 自身注册、不累加 restriction。

### 7.2 实现

```ts
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'

export interface RestrictHandle { refresh(): void; dispose(): void }

export function installRestrict(ctx: Context, state: GuardState): RestrictHandle {
  const masks = new Map<string, Scope>()
  const liveAgents = new Map<string, Agent>()

  const applyTo = (agent: Agent): void => {
    const agentId = String(agent.id)
    const tools = ctx.get('tools')
    if (tools === undefined) return

    // ① 先快照（restrict 之前的可见集 = restrict-free 全量，用于目录 UI）
    try { state.updateInternalTools(tools.schemas(agent)) } catch { /* 见 §10.3 */ }

    // ② 撤销旧 mask（独立 scope，不动 agent 自己的注册）
    void masks.get(agentId)?.dispose()
    masks.delete(agentId)

    const denied = [...state.effectiveNamesFor(agentId)].filter(name => !RESERVED.has(name))
    if (denied.length === 0) return

    const scope = createScope(ctx, agent)

    // ③ 预过滤未知名字：restrict 对未知名抛错（:1114-1118），而 agent 视角可见名才是安全集合
    let visible: Set<string>
    try { visible = new Set(tools.schemas(agent).map(s => s.name)) }
    catch { visible = new Set() }
    const known = denied.filter(name => visible.has(name))

    if (known.length > 0) {
      try { scope.ctx.tools.restrict({ deny: known }) }
      catch (error) { ctx.logger.warn(`ability: restrict skipped for ${agentId}: ${String(error)}`) }
    }

    // ④ assemble 过滤：省 token；动态读 state，settings 变了不用重挂中间件
    scope.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const result = await next()
      const now = state.effectiveNamesFor(agentId)
      if (now.size === 0) return result
      result.sections = result.sections.filter(section =>
        !(section.name.startsWith('tool:') && now.has(section.name.slice('tool:'.length))))
      return result
    })

    masks.set(agentId, scope)
  }

  // 监听器统一用 ctx.effect 收口（约定见 §11）：卸载时自动撤监听 + dispose 全部 mask scope
  const disposeListeners = ctx.effect(() => {
    const offCreated = ctx.on('agent/created', ({ agent }) => {
      liveAgents.set(String(agent.id), agent)
      try { applyTo(agent) } catch (error) {
        ctx.logger.warn(`ability: restrict setup failed for ${String(agent.id)}: ${String(error)}`)
      }
    })
    const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      const agentId = String(agent.id)
      liveAgents.delete(agentId)
      void masks.get(agentId)?.dispose()
      masks.delete(agentId)
    })
    return () => {
      offCreated(); offDisposed()
      for (const scope of masks.values()) void scope.dispose()
      masks.clear(); liveAgents.clear()
    }
  }, 'ability: restrict scope')

  return {
    refresh(): void {
      for (const agent of liveAgents.values()) {
        try { applyTo(agent) } catch (error) { ctx.logger.warn(`ability: refresh failed: ${String(error)}`) }
      }
    },
    dispose(): void { disposeListeners() },
  }
}
```

### 7.3 三个必须注意的点

| 点 | 说明 |
|---|---|
| **`restrict` 必须 scoped** | unscoped 直接抛 `tools.restrict() requires a scoped context`（`:1098-1101`） |
| **未知名仍抛错** | `:1114-1118`；0.2 没有公开 `restrictableNames`（`ToolView` 是 private），所以只能「先看可见名再挑」 |
| **own-layer 免疫范围收窄** | preset 的工具是**祖先贡献**，**能**被 restrict 移除（`:1163-1174`）；只有「agent.ctx 自己注册的」免役。→ 用来兜底「own-layer 工具看得到但调不了」的 workflow-redirect 文本因此降级为**可选**，见 §10.2 |

### 7.4 `system-prompt/assemble` 签名（易错）

```ts
// packages/core/system-prompt/src/index.ts:19-31
'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext,
  next: () => Promise<PromptAssembly>): Promise<PromptAssembly>
```

- **第三个参数才是 `next`**，且 `next()` **不接参数**。若按直觉写成 `(assembly, next)`，`context` 就会占住 `next` 的位置 → 运行时崩。
- `assembly.sections` **可变**，`await next()` 后 filter 再 return。
- `AssemblySection.name` 就是 `tool:<toolName>`，全仓统一惯例（`packages/fs/tool-fs/src/read.ts:70`、`packages/shell/tool-bash/src/index.ts:260`、`packages/workflow/tool-workflow/src/index.ts:324`、`packages/subagent/tool-subagent/src/index.ts:599`）。
- ⚠️ 若该 scope 注册了 `complete: true` 的 section，waterfall 结果会被**还原成那一段**（`:632`），过滤白做。我们只用 `tool:` 前缀过滤，不动其它，规避该边界。
- 通过 `agent.ctx.on(...)` 能收到，因为 `assembleContextFor` 显式带 `scope: agent`（`packages/core/agent/src/dispatch.ts:174-176`）。

---

## 8. 动态性与 `tools/change` 防重入

### 8.1 生效时机

| 触发 | guard | restrict | assemble | skill 遮蔽 |
|---|---|---|---|---|
| 启动 | 立即 | — | — | — |
| 改配置（volatile） | **立即**（闭包读 `state` 引用） | `refresh()` 后下一 step | 下一 step | `refresh()` 后下一 pre-step |
| 新 agent / 子代理 / resume | 立即 | `agent/created` 即时 | 即时 | `agent/created` 即时 |
| MCP 重连 / 新工具注册 | 立即（按名判定） | 未知名自动跳过 | — | — |

### 8.2 为什么 guard 不需要重挂

`installGuard` 的闭包读 `state`（对象引用）。`state.sync(...)` 只替换 `state.gate` 等字段，**不替换 state 本身** → guard 下一调用即生效。

### 8.3 ⚠️ `tools/change` 自递归（必须防）

```ts
// packages/core/tools/src/index.ts:833-836
private readonly layers = new ScopedLayers(scope => new ToolLayer(scope), () => { this.ctx.emit('tools/change') })
// :1119-1123  restrict 用默认 notify=true；:1140 guard 用 notify:false
```

→ `restrict` 自己会 emit `tools/change`，而 `refresh()` 又会 `restrict`。必须防重入，且**不要在这里重复枚举 agent**——`refresh()` 内部已经会在 restrict 之前对每个 live agent 快照 `internalTools`：

```ts
export function installToolsChange(
  ctx: Context, _state: GuardState, restrict: RestrictHandle,
): () => void {
  let reentrant = false
  return ctx.effect(() => ctx.on('tools/change', () => {
    if (reentrant) return
    reentrant = true
    try {
      // 新工具出现 / MCP 重连 / restriction 自身变更，统一走一次 refresh：
      // 每个 live agent 都会「先快照 schemas(agent) 进 internalTools，再重挂 restrict」
      restrict.refresh()
    } catch (error) {
      ctx.logger.warn(`ability: tools/change refresh failed: ${String(error)}`)
    } finally {
      reentrant = false
    }
  }), 'ability: tools change')
}
```

---

## 9. `skill-gate.ts` —— 运行时遮蔽（落层是生死线）

### 9.1 机制

skill 有原生 `SkillInvocationPolicy = { modelInvocable, userInvocable }`（`packages/skill/skill/src/index.ts:48-54`）。在 **agent scope 层**注册一个同名 runtime skill，两个都是 `false` → 一个 register 覆盖 4 个消费点：

| 消费点 | 判定 | 证据 |
|---|---|---|
| `skill` 工具 execute | `isModelInvocable(summary)` / `isModelInvocable(skill)` | `packages/skill/tool-skill/src/index.ts:138,145` |
| `<available_skills>` 注入 | `snapshot.skills.filter(isModelInvocable)` | 同 `:226` |
| 斜杠菜单（SessionSkillCatalog） | `.filter(isUserInvocable)` | `packages/api/session-controller/src/skill-catalog.ts:62-86` |
| `/skill-name` 手势注入 | `isUserInvocable(skill)` | `tool-skill/src/index.ts:195` |

### 9.2 ⚠️ 落层规则（本方案最危险的一处）

0.2 的 skill registry 是 **host + per-scope 分层**的（与 tools 同构）。官方注释把层结构讲得很清楚：

```yaml
# packages/bundle/web-app/cordis.patch.yml（skill-filesystem 那一行的注释）
# The `skill` REGISTRY stays in the host plane. It is host+per-scope layered
# (the tools-registry shape): deployment-level providers — repository plugins,
# a host skill-filesystem row — register into its global layer, while a preset's
# `skill-filesystem` registers into that preset's layer, and each agent reads the
# merged catalog its scope chain selects. Only the per-agent rows move behind
# presets: …
- id: skill-filesystem
  disabled: true
- id: tool-skill
  disabled: true
```

合并规则（`packages/skill/skill/src/index.ts:551-565, 567-582`）：

| 维度 | 规则 |
|---|---|
| **跨层** | **nearest-wins，无视 rank**（agent 层 > preset 层 > global 层） |
| **同层内** | 按 `rank → providerOrder → localOrder` 排序，**rank 小者胜** |
| rank 常量 | runtime `250`（`:25`）；project-dsh `100` / project-agents `200`（`packages/skill/skill-filesystem/src/index.ts:36-40`）；custom 300 / user-dsh 400 / user-agents 500 / bundled 600 |

**结论（必须严格遵守）**：

| 注册位置 | 落层 | 能否遮蔽 preset 的 `skill-filesystem`（preset 层，rank 100/200） | 判定 |
|---|---|---|---|
| `agent.ctx.get('skills').register(...)` | **agent 层**（更近） | **能**（跨层 nearest-wins） | ✅ **唯一正确做法** |
| preset ctx 注册 | preset 层（同层） | **不能**（250 输给 100/200，**静默漏放**） | ❌ |
| 插件顶层 ctx 注册（unscoped） | global 层 | **不能**（同层/更远，且静默无 warn） | ❌ footgun |

`skills.register` unscoped 时**静默落 global**（`:441-442`、`packages/core/scope/src/store.ts:236-237`）—— 不 throw 不 warn，这是最容易踩的易错点，0.2 依然如此。这是本包把「必须用 `agentCtx.get('skills')`」写成硬规则的原因，**0.2 下这条规则尤其重要**（因为 `skill-filesystem` 已下移到 preset 层，诱惑更大）。

### 9.3 实现

```ts
export interface SkillGateHandle { refresh(): void; dispose(): void }

export function installSkillGate(ctx: Context, state: GuardState): SkillGateHandle {
  const disposers = new Map<string, Array<() => void>>()
  const liveAgents = new Map<string, Agent>()

  const applyTo = (agent: Agent): void => {
    const agentId = String(agent.id)
    // ① 必须先 dispose 旧遮蔽：同层同名是 first-wins + warn + no-op disposer
    //    （packages/skill/skill/src/index.ts:445-448）→ 不先清就无法「启用」回来
    for (const dispose of disposers.get(agentId) ?? []) { try { dispose() } catch { /* noop */ } }
    disposers.set(agentId, [])

    const denied = state.effectiveSkillNames(agentId)   // 已在 state 里剔除受保护项
    if (denied.length === 0) return

    // ② 必须 agent-scoped：不走 agent.ctx 就落错层（见 §9.2）
    const skills = agent.ctx.get('skills')
    if (skills === undefined) return

    const mine: Array<() => void> = []
    for (const name of denied) {
      try {
        mine.push(skills.register({
          name,
          description: '(disabled by ability gate)',
          content: '',
          source: 'custom',
          invocation: { modelInvocable: false, userInvocable: false },
        }))
      } catch (error) {
        ctx.logger.warn(`ability: skill shadow "${name}" failed for ${agentId}: ${String(error)}`)
      }
    }
    disposers.set(agentId, mine)
  }

  // 监听器统一用 ctx.effect 收口（约定见 §11）：卸载时撤监听 + 释放全部遮蔽
  const disposeListeners = ctx.effect(() => {
    const offCreated = ctx.on('agent/created', ({ agent }) => {
      liveAgents.set(String(agent.id), agent)
      try { applyTo(agent) } catch (error) {
        ctx.logger.warn(`ability: skill gate setup failed: ${String(error)}`)
      }
    })
    const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      const agentId = String(agent.id)
      liveAgents.delete(agentId)
      for (const dispose of disposers.get(agentId) ?? []) { try { dispose() } catch { /* noop */ } }
      disposers.delete(agentId)
    })
    return () => {
      offCreated(); offDisposed()
      for (const list of disposers.values()) for (const dispose of list) { try { dispose() } catch { /* noop */ } }
      disposers.clear(); liveAgents.clear()
    }
  }, 'ability: skill gate scope')

  return {
    refresh(): void {
      for (const agent of liveAgents.values()) {
        try { applyTo(agent) } catch (error) { ctx.logger.warn(`ability: skill refresh failed: ${String(error)}`) }
      }
    },
    dispose(): void { disposeListeners() },
  }
}
```

### 9.4 三条硬约束

1. **先 dispose 再 register**。同层同名 runtime 是 **first-wins + warn + no-op disposer**（`packages/skill/skill/src/index.ts:445-448`）→ 不先清旧的，`register` 会被静默忽略，**「启用」操作永远失败**。
2. **`invocation` 两个字段都必须给**（`:783-795` 只给一半直接 throw）；`description` 非空、`source` 必填（`SkillRegistration`，`:94-100`）。
3. **必须写一条回归测试**（`04` §4.3 T-S3）：在 `.dsh/skills/<name>/SKILL.md` 放一个与待禁 skill 同名的 project 级 skill，验证遮蔽后 `snapshot({scope: agent})` 里该 name 的 `invocation.modelInvocable === false`。**这是唯一能证明落层正确的测试。**

### 9.5 热加载保证（0.2 全链路成立）

register/dispose 同步触发 `invalidateCache`（revision+1 + 清缓存 + `skills/change`，`:288-297, 621-625`、`store.ts:257-262`、`vendor/cordis/src/fiber.ts:375-382`）→ 下一个 pre-step `snapshot`（cache key 含 revision）miss → `collectFresh` → `filter(isModelInvocable)` → digest 变化 → 重发 replacement catalog（`tool-skill/src/index.ts:213-251, 279-311, 328-335`）。`MAX_COLLECT_ATTEMPTS = 2`、`snapshot.complete` 优雅跳过（`:23, 519-549, 643-645`）。

**不需要**调用任何额外 invalidate API；**也不能**（`invalidateCache` 已是 private）。

> 斜杠菜单热刷新仍然做不到：`skills/change` **不在** client 转发白名单（`packages/api/remotes/src/remote-events.ts:20-48`），插件不可扩充。这是白名单机制的固有边界，不接受实时刷新的妥协方案继续有效。

---

## 10. guard 之外的两条附加通道

### 10.1 catalog HTTP（UI 数据面）

```ts
export function installCatalog(ctx: Context, state: GuardState): () => void {
  return ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: '/rune-ability/catalog',
      async handler(req, res) {
        if (req.method !== 'GET') { sendMethodNotAllowed(res, 'GET'); return }
        try {
          const payload = {
            ns: ABILITY_NS,
            tools: [...state.internalTools.values()].sort((a, b) => a.name.localeCompare(b.name)),
            skills: await collectSkills(ctx, state),
            workspaces: collectWorkspaces(ctx),
          }
          sendJson(res, 200, payload)
        } catch (error) {
          // HTTP handler 必须自己 try/catch + headersSent 守卫
          if (!res.headersSent) sendJson(res, 500, { error: String(error) })
          ctx.logger.warn(`ability: catalog failed: ${String(error)}`)
        }
      },
    })
    return dispose
  }, 'ability: catalog route')
}
```

**为什么用 HTTP 而不是 Typert Remote**：`ctx.remote.<ns>` 需要 Typert 生成物（`@Remote` 装饰 + codegen），那是 monorepo 内建能力；本包在仓库外，`webServer.register` 是 Service 目录里公开稳定的原生 API（`packages/host/webserver/src/index.ts:42-48,160-173`），零 codegen 依赖。配置读写**不自己造**——直接用 shell 已生成的 `ctx.remote.settings`。

数据源：

| 字段 | 来源 | 说明 |
|---|---|---|
| `tools` | `state.internalTools` | **restrict 之前**的快照，只增不减（见 §10.3）。**不能用 `tools.schemas()`**（只有 global 层，漏 preset 工具） |
| `skills` | 两段式 `snapshot`（见下） | 保留原始 description |
| `workspaces` | `ctx.workspaceRegistry.list()` | `{ id, title, path }`；registry 缺失 → `[]` |

**skills 两段式**（只在 global 层拿原始 desc 是不够的）：preset 才有本地 provider，`snapshot({scope: undefined})` 拿不到 preset skill。做法：

```ts
async function collectSkills(ctx: Context, state: GuardState) {
  const skills = ctx.get('skills')
  if (skills === undefined) return []
  const cwd = undefined
  const globalSnap = await skills.snapshot({ cwd, signal: AbortSignal.timeout(2000) }).catch(() => undefined)
  const agent = ctx.get('agents')?.list()[0]
  const scopedSnap = agent === undefined
    ? undefined
    : await skills.snapshot({ cwd, scope: agent, signal: AbortSignal.timeout(2000) }).catch(() => undefined)
  // global 优先（原始 desc），scoped 只补充未见项；再看有没有缓存过的原始 desc
  const seen = new Map<string, SkillCatalogEntry>()
  for (const s of globalSnap?.skills ?? []) seen.set(s.name, { name: s.name, description: s.description, source: s.source })
  for (const s of scopedSnap?.skills ?? []) if (!seen.has(s.name)) seen.set(s.name, { … })
  for (const [name, entry] of state.skillDescCache) if (!seen.has(name)) seen.set(name, entry)
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}
```

`state.skillDescCache` 在 `agent/created` 里**遮蔽之前**抓一次（此时还是原始 desc），解决「preset skill 在 global 视图里看不到」的问题。每段都带 `AbortSignal.timeout(2000)` 防挂起（`AGENTS.md` §2.6 要求出站/异步都带超时）。

### 10.2 workflow-redirect 文本兜底（降级为可选）

用 `systemPrompt.section({ order: 2650, text: '…workflow disabled…' })` 硬编码兜底「own-layer 工具看得到但调不了」是常见误用——`order` 写死会在官方 section 顺序变动后错位。0.2 里 preset 工具**能被 restrict 移除**（§7.3），这段的必要性大幅下降。保留为**可选配置**：

```ts
if (config.workflowRedirect?.get() === true) {
  const order = ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW') + 50   // 不要硬编码 2650
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'dsh-magica-rune:workflow-redirect',
    order,
    text: 'In this context the workflow tool is disabled. Use the configured workflow alternative instead.',
  }), 'ability: workflow redirect')
}
```

`PromptSection` 字段是 `name` / `order` / `text` / `interpolate?` / `complete?`，**没有 `title`**（`packages/core/system-prompt/src/index.ts:52-76`）。

### 10.3 `internalTools` 只增不减

```ts
updateInternalTools(entries: readonly ToolCatalogEntry[]): void {
  for (const entry of entries) {
    const prev = this.internalTools.get(entry.name)
    // 新工具或描述变化时更新；已存在且描述未变则保留（避免无谓的 UI 抖动）
    if (prev === undefined || prev.description !== entry.description) {
      this.internalTools.set(entry.name, { name: entry.name, description: entry.description })
    }
  }
}
```

- 更新时机：`agent/created`（**restrict 之前**）、`tools/change`（防重入内）。
- 语义：**只增不减** —— 工具一旦被见过就留在列表，这样被 restrict 移除的工具在 UI 仍可见、可重新启用。
- **不要**用 `ctx.tools.schemas()`（无参）—— 它只含 global 层，漏掉 preset 挂在 agent 平面的全部工具。

---

## 11. `index.ts` 组装顺序

**统一约定**：每个 `installXxx(ctx, …)` **必须**在内部用 `ctx.effect` 收口自己的全部注册，并返回该 effect 的 disposer（`installRestrict` / `installSkillGate` 还额外返回 `refresh()`，供配置变更时重挂）。`apply` **只按顺序调用、不额外再包 `ctx.effect`**——这样「谁注册谁负责回收」，卸载时不留孤儿。

```ts
export const name = 'dsh-magica-rune'
export const inject = ['tools', 'webServer', 'systemPrompt']
export const Config = AbilityConfigSchema

export function apply(ctx: Context, config: Config): void {
  const state = new GuardState()

  // 0) 可选：settings 自检 + 关掉「插件」页的自动表单（内部自带 ctx.effect，失败不影响门禁）
  installSettingsSelfCheck(ctx)

  // 1) 种子：先让 state 有 gate，否则 guard 首次调用读到空集
  state.sync(readSettings(config))

  // 2) 工作区索引（guard 依赖 agentWorkspace；顺序对更省心，尽管 guard 自带降级）
  const workspaceIndex = installWorkspaceIndex(ctx, state)

  // 3) 辅通道与 skill 遮蔽：都要在 guard 之前建好 handle，下面 watch 闭包按引用读
  const skillGate = installSkillGate(ctx, state)
  const restrict = installRestrict(ctx, state)

  // 4) 主通道（全局层，权威）
  const guard = installGuard(ctx, state)

  // 5) tools/change（防重入；必须在 restrict 装好之后）
  const toolsChange = installToolsChange(ctx, state, restrict)

  // 6) catalog HTTP
  const catalog = installCatalog(ctx, state)

  // 7) 可选的 workflow-redirect 文本兜底（见 §10.2）
  const redirect = installWorkflowRedirect(ctx, config)

  // 8) 配置热更新：一条通道驱动全部重挂
  const watch = ctx.effect(() => ctx.on('loader/volatile-update', () => {
    try {
      state.sync(readSettings(config))
      restrict.refresh()   // 重挂 per-agent restrict + assemble
      skillGate.refresh()  // 先 dispose 旧遮蔽再 re-register
    } catch (error) {
      ctx.logger.warn(`ability: volatile update failed: ${String(error)}`)
    }
  }), 'ability: config watch')

  // 9) 统一收口：顺序无关，但全部必须被撤
  ctx.effect(() => () => {
    watch(); redirect(); catalog(); toolsChange(); guard()
    restrict.dispose(); skillGate.dispose(); workspaceIndex()
  }, 'ability: teardown')
}
```

顺序理由：

| 步 | 为什么在这个位置 |
|---|---|
| 0 | `settings` 是可选依赖，自检失败只 warn，不能挡住门禁 |
| 1 | `state.sync` 必须先跑，否则第 2~5 步的任何首调都读到空 gate |
| 2 | guard 依赖 `agentWorkspace`；虽然它有「Map 未命中 → 查全局」的降级，顺序对能少一类排查 |
| 3 先于 4 | `restrict` / `skillGate` 的 `agent/created` 监听要先于 guard 的注册顺序无所谓（guard 无状态），但它们的 handle 必须已存在，供第 8 步闭包引用 |
| 5 | 必须在 `restrict` 之后（防重入标记要包住 `refresh()`） |
| 8 | 只此一处订阅 `loader/volatile-update`，避免多处分头处理造成状态不一致 |

**为什么 watch 闭包能读到最新 handle**：`const` 绑定在 `apply` 内、`install` 之后再订阅，闭包按引用读，后续 `refresh()` 永远是同一个对象。

**全部副作用可逆**：guard / restrict scope / skill 遮蔽 / route / section / 事件监听 / catalog 全部返回 disposer，由第 9 步一次性收口。任一出错 → 整个模块 stop/update 即回到 DSH 原生行为。

---

## 12. 与 agent loop 的关系（红线核对表）

| rune 的操作 | DSH 挂载点 | 为什么不改 loop | 0.2 依据 |
|---|---|---|---|
| 注册 guard | `ctx.tools.guard()` | dsh execute 路径本就调 `guardReason()`；只往 guards 表 append | `:1144-1154, 1503-1531` |
| 调 restrict | `ctx.tools.restrict()` | 只改 `view()` 返回的 schema 视图 | `:1097-1124, 1178-1219` |
| assemble 过滤 | `agentCtx.on('system-prompt/assemble')` | waterfall 加一环，调 `next()` 后过滤 sections；不改 `assembly.tools` | `:19-31, 625-634` |
| 监听 agent/created | `ctx.on('agent/created')` | 观察 + 初始化；**全 try/catch**（throw 会 veto 创建） | `runtime-types.ts:248-261` |
| 注册 skill 遮蔽 | `agentCtx.get('skills').register()` | 只往 agent 层加一条 runtime skill，不改发现机制 | `skill/src/index.ts:439-460` |
| 读 cwd | `agent.session.header.cwd` | 只读、immutable | `session/src/types.ts:94-105` |
| 查工作区 | `workspaceRegistry.resolveByPath()` | 只读，不创建不修改 | `workspace/src/index.ts:493-506` |
| HTTP route | `webServer.register()` | 标准路由注册，不碰 loop | `webserver/src/index.ts:160-173` |
| 读配置 | `config.<kind>.get()` | volatile 引用读取 | `entry.ts:162-195` |

**loop 链条不变**：session → agent 发布（`agent/created`）→ loop → assemble（schemas + sections）→ 模型请求 → execute（`pre-execute` → **guard** → body）。一个环节没增减。

---

## 13. 降级与回退矩阵

| 场景 | 行为 | 用户可见后果 |
|---|---|---|
| `settings` service 未挂载 | 跳过自检与 `configure`；门禁照常工作（读 `config`） | 前端写不回去（无 revision 来源） |
| `workspaceRegistry` 未挂载 | `findWorkspace` 返回 `undefined` → 所有 agent 回退全局策略 | 工作区级配置不生效（无报错） |
| `skills` service 未挂载 | 跳过 skill 遮蔽 | skill 只受 guard 保护（`skill` 工具调用被拒，但目录仍显示） |
| `tools` service 未挂载 | guard/restrict 都不装 | **完全回到原生行为**（能力管理失效） |
| `webServer` 未挂载 | catalog 不注册 | 前端显示错误态 |
| `restrict` 抛错（未知名） | catch + warn，该 agent 只靠 guard | 可见但调不了（token 没省） |
| `skills.register` 抛错 | catch + warn | 该 skill 只受 guard 保护 |
| `agent/created` 处理器抛错 | **绝不 throw**（否则 agent 创建失败） | 该 agent 回退全局策略 + warn |
| 配置冲突（并发写） | `SettingsConflictError` | 前端 `load()` 重读对账，不闪 loading |

**总体回退**：`dsh plugin disable dsh-magica-rune` 或 profile 里 `disabled: true` → 全部挂载点随之回收，DSH 回到原生行为，无残留（所有副作用都在 `ctx.effect` 内）。
