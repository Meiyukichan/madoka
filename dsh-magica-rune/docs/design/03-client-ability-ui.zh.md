# 03 · Client 侧：「能力管理」设置页详细设计（视觉保真的唯一依据）

> **本文的第一目标是把 `raw/a.md` + `raw/b.md` 的页面原样搬到 0.2**。凡是 CSS 值，一律照抄；只有「0.2 已不存在的值」按 §6 的映射表替换，替换项逐条给理由。
>
> 路径约定同 `01`。

---

## 1. 入口与声明

### 1.1 `src/client.ts`

```ts
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 类型侧：拉 settings shell 的 SlotMap 合并（'settings.section'）与 ctx.locale
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

/** Cordis 服务依赖（不是包名！） */
export const inject = ['slots', 'locale', 'remote', 'remote.settings']

export { apply } from './client/index.ts'
```

- `remote.settings` 是**合法 service 名**（官方 `ui-settings-general/src/client/index.ts:68` 就这么写：`['slots','locale','connection','remote','remote.settings','configForms','shortcuts']`）。
- 三层声明的分工（`packages/client/AGENTS.md:85-97`）：

| 声明 | 单位 | 本案取值 |
|---|---|---|
| `export const inject` | **Cordis 服务名** | `['slots','locale','remote','remote.settings']` |
| `package.json` 的 `dsh.client.inject` | **包名**（仅为模块图/预检） | 见 `04` §2 |
| `dsh.client.external` | 模块 specifier | **不用**（功能插件不该用） |

### 1.2 apply 骨架

```ts
// src/client/index.ts
import { createAbilityViewStore } from './store.ts'
import { AbilityController } from './controller.ts'
import { AbilitySection } from './AbilitySection.tsx'
import { en, zh } from './locales.ts'

const NS = 'settings.ability'

export function apply(ctx: ClientContext): void {
  // ① 字典 + 稳定 t（bind 结果每 namespace 稳定，可直接进闭包）
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-magica-rune: dictionaries')

  // ② 导航图标（0.2 仍无 icon 字段，见 §8）
  ctx.effect(() => setupNavIcon(() => t('nav')), 'dsh-magica-rune: nav icon')

  // ③ 数据/写入 controller（async 副作用都在这里，不进 store.actions）
  const controller = new AbilityController(ctx)

  // ④ 外部变更推送 + 重连刷新
  ctx.effect(() => {
    const disposers = [
      ctx.remote.$on('settings/document-updated', (ns, revision) => {
        if (ns !== ABILITY_NS) return
        // 自己刚写完那次也会推回来；用 revision 去重，避免整页重载与 UI 抖动
        if (revision === controller.revision) return
        void controller.load(true)                       // silent：不清搜索词 / 不闪 loading
      }),
      ctx.on('connection/reset', () => { void controller.load(true) }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-magica-rune: settings invalidations')

  // ⑤ 注册设置页
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'ability',
    order: 17,                                    // 插件(15) 之后、Agent 预设(20) 之前 —— 0.2 仍精确
    label: () => t('nav'),                        // SlotLabel = string | (() => string)，thunk 每次投影重读
    locale: NS,                                   // 声明后 t 自动注入组件 props
    store: createAbilityViewStore,                // 工厂形式：root scope 每 entry 一份实例
    inject: (actions) => ({                       // 声明 store 后 inject 收到 baked actions
      hooks: { ability: controller.store },       // → 组件 prop useAbility(sel)
      load: (silent?: boolean) => controller.load(silent),
      toggle: (kind, name, scope) => controller.toggle(kind, name, scope),
      toggleBatch: (kind, names) => controller.toggleBatch(kind, names),
      selectWorkspace: (id: string) => { actions.selectWorkspace(id) },
    }),
  }, AbilitySection))
}
```

**为什么把 `t` 放进闭包而不塞进 `inject`**：`t` 由 `PropsLocale` 自动注入（`packages/client/ui-slots/src/index.ts:89-98`）；在 `inject` 里再给一个 `t` 会与它撞名。`locale: NS` 声明后**框架已经处理语言切换重渲染**——`t` 的函数引用每个 locale revision 都会换新（`packages/client/ui-renderer/src/client/scoped-slots.tsx:292-316` 注释明确「freshness rides identity」），`React.memo` 子组件也会正常重渲染。

---

## 2. 数据层

### 2.1 视图 store（纯同步，`defineStore`）

```ts
// src/client/store.ts
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

export const TABS = ['tools', 'skills'] as const
export type AbilityTab = typeof TABS[number]
export type ScopeKind = 'global' | 'workspace'

export interface AbilityViewState {
  tab: AbilityTab
  globalOpen: boolean          // 全局 zone 默认展开
  workspaceOpen: boolean       // 工作区 zone 默认折叠
  search: Record<AbilityTab, string>
  selectedWorkspaceId: string | undefined
  pending: { kind: AbilityTab; name: string } | null   // 非 null 时弹二次确认
}

type AbilityViewActions = {
  selectTab(d: AbilityViewState, tab: AbilityTab): void
  toggleZone(d: AbilityViewState, zone: ScopeKind): void
  setSearch(d: AbilityViewState, tab: AbilityTab, text: string): void
  selectWorkspace(d: AbilityViewState, id: string): void
  setPending(d: AbilityViewState, pending: AbilityViewState['pending']): void
}

export function createAbilityViewStore(): EngineStoreHandle<AbilityViewState, AbilityViewActions> {
  return defineStore({
    init: (): AbilityViewState => ({
      tab: 'tools',
      globalOpen: true,
      workspaceOpen: false,
      search: { tools: '', skills: '' },
      selectedWorkspaceId: undefined,
      pending: null,
    }),
    actions: {
      selectTab: (d, tab) => { d.tab = tab },
      toggleZone: (d, zone) => {
        if (zone === 'global') d.globalOpen = !d.globalOpen
        else d.workspaceOpen = !d.workspaceOpen
      },
      setSearch: (d, tab, text) => { d.search[tab] = text },
      selectWorkspace: (d, id) => { d.selectedWorkspaceId = id; d.workspaceOpen = true },
      setPending: (d, pending) => { d.pending = pending },
    },
  })
}
```

约束：`actions` 是**纯 immer draft 变更，不能 async**（`packages/client/store/src/contract.ts:40`）。所有网络/异步都在 controller。

### 2.2 controller（apply 世界的 async owner）

```ts
// src/client/controller.ts
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

export interface AbilityDataState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  value: AbilitySettingsValue        // settings 里 ABILITY_NS 的当前值
  revision: number
  tools: ToolRow[]
  skills: SkillRow[]
  workspaces: WorkspaceRow[]
  /** 视图态里的选中工作区，跟随数据一起维护，方便 toggle 用 */
  selectedWorkspaceId: string | undefined
}

const EMPTY: AbilityDataState = {
  status: 'idle', error: null, revision: 0,
  value: { tools: emptyKind(), skills: emptyKind() },
  tools: [], skills: [], workspaces: [], selectedWorkspaceId: undefined,
}

export class AbilityController {
  readonly store: SnapshotStore<AbilityDataState> = createSnapshotStore(EMPTY)

  constructor(private readonly ctx: ClientContext) {}

  get revision(): number { return this.store.getSnapshot().revision }

  async load(silent = false): Promise<void> {
    if (!silent) this.store.update(d => { d.status = 'loading'; d.error = null })
    try {
      // 目录 + 配置并行
      const [catalog, descriptor] = await Promise.all([
        fetchCatalog(this.ctx),
        this.ctx.remote.settings.describe(),
      ])
      if (!descriptor.ok) throw new Error(descriptor.error.message)
      const ns = descriptor.value.namespaces.find(n => n.ns === ABILITY_NS)
      if (ns === undefined) throw new Error(`settings namespace "${ABILITY_NS}" not found`)
      this.store.update(d => {
        d.status = 'ready'; d.error = null
        d.value = ns.value as AbilitySettingsValue
        d.revision = ns.revision
        d.tools = catalog.tools; d.skills = catalog.skills
        d.workspaces = catalog.workspaces
        if (d.selectedWorkspaceId === undefined) d.selectedWorkspaceId = catalog.workspaces[0]?.id
      })
    } catch (error) {
      // silent 模式失败不把整页打成 error（保留旧数据），只记日志
      if (!silent) this.store.update(d => { d.status = 'error'; d.error = String(error) })
    }
  }

  async toggle(kind: AbilityTab, name: string, scope: ScopeKind): Promise<void> {
    const state = this.store.getSnapshot()
    const next = structuredClone(state.value) as AbilitySettingsValue
    applyToggle(next[kind], scope, name, state.selectedWorkspaceId)
    // 乐观更新：先刷 UI
    this.store.update(d => { d.value = next })
    try {
      const result = await this.ctx.remote.settings.replace(ABILITY_NS, next, state.revision)
      if (!result.ok) throw new Error(result.error.message)
      this.store.update(d => { d.revision = result.value.revision })
    } catch {
      await this.load(true)     // 冲突/网络错 → 全量重读对账
    }
  }

  async toggleBatch(kind: AbilityTab, names: readonly string[]): Promise<void> { /* 同构，循环 applyToggle */ }
}
```

**交互观感与 `raw` 一致**：点完立刻变色（乐观更新），失败再回滚；没有 loading 遮罩、没有按钮禁用、没有 toast。

### 2.3 toggle 语义（**与 `raw` 完全一致**）

```
scope = global:
  enabled  → 点击:  global.disabled.push(name)
  disabled → 点击:  global.disabled.remove(name)

scope = workspace:
  enabled  → 点击:  ws.disabled.push(name); ws.enabled.remove(name)
  disabled → 点击:  ws.disabled.remove(name)
    若 global 也禁了 → ws.enabled.push(name)        # 工作区「捞回」全局禁用
    否则             → ws.enabled.remove(name)        # 顺手清掉陈旧项
```

`effectiveState(value, scope, name)`：

```
builtin（命中 BUILTIN_DISABLED）            → 'builtin'   不可编辑，显示徽标 + 替代说明 tooltip
global                                     → global.disabled.includes(name) ? 'disabled' : 'enabled'
workspace                                  → ws.disabled.includes(name) ? 'disabled'
                                           : ws.enabled.includes(name)  ? 'enabled'
                                           : global.disabled.includes(name) ? 'disabled' : 'enabled'
```

批量：`enable = !allEnabled`（不是全启用就全部启用，否则全部禁用）。部分启用时用 ref 直接写 DOM 的 `indeterminate`。

---

## 3. 组件结构（**与 `raw` 完全一致**）

```
AbilitySection                       ← 根：标题 + tabs + 当前 tab 内容
├─ header:  h2.section/.title / p.desc
├─ tabs:    2 × button.tab（本地 data-active 属性，不是 class）
└─ body（按 tab 分支）
   ├─ ToolsTab    → 2 × zone → ToolList    → group × N → ToolToggle(+Modal)
   └─ SkillsTab   → 2 × zone → SkillList   → group × N → SkillToggle
      每个 zone 的标题行右侧可挂 WorkspaceDropdown（仅「工作区」zone、且存在工作区时）
```

> **只有 2 个 tab**（工具 / 技能）。原设计的 `CommandsTab` / `AgentsTab` 已移出范围（`01` §4.5），不存在、也不留灰掉的占位。

两个 `List` 是**同一套样式的两份拷贝**（`raw` §3.1 的原始决定，保留；`b.md` §11.3 把「复制粘贴」列为已知瑕疵，可在实现时抽成一个参数化组件，但**视觉输出必须一致**）。

props 类型：

```tsx
import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createAbilityViewStore } from './store.ts'

export interface AbilityInjected {
  hooks: { ability: HostObservable<AbilityDataState> }
  load: (silent?: boolean) => Promise<void>
  toggle: (kind: AbilityTab, name: string, scope: ScopeKind) => Promise<void>
  toggleBatch: (kind: AbilityTab, names: readonly string[]) => Promise<void>
  selectWorkspace: (id: string) => void
}

export type AbilitySectionProps =
  PropsRuntime<'settings.section'>                              // { close }
  & PropsLocale<'settings.ability'>                             // { t }
  & PropsStore<ReturnType<typeof createAbilityViewStore>>        // { useStore, actions }
  & InjectFace<AbilityInjected>                                 // useAbility + 回调

export function AbilitySection({ t, useStore, actions, useAbility, load, toggle }: AbilitySectionProps) {
  const view = useStore(s => s)
  const data = useAbility(s => s)
  // 首次加载：普通 effect，不订阅任何外部快照
  useEffect(() => { void load() }, [load])
  ...
}
```

**禁止**：组件里 `useSyncExternalStore`、`locale.subscribe`、拿 `ctx`、`document.head.appendChild(<style>)`。

---

## 4. 注册侧与原语的三个裁决

### 4.1 用到的官方原语（只有 3 个）

| 组件 | 用在哪 | 用法 |
|---|---|---|
| `Tooltip` | 每个工具/技能药丸 | `<Tooltip label={desc} side="bottom" maxWidth={500} delayMs={1000} portal>{button}</Tooltip>` |
| `Modal` | 禁用「DSH 内置分类」工具前的二次确认 | `<Modal open onClose title closeLabel description footer>` |
| `Button` | Modal footer（`ghost` 取消 / `primary` 确认） | — |

`Tooltip` 0.2 签名（`packages/client/ui-primitives/src/Tooltip.tsx:62`）：
`{ label, shortcutKeys, side='right', align='center', delayMs=0, focusDelayMs=0, gap=8, disabled=false, portal=false, maxWidth, openOnClick=false, children }`，`side: 'right'|'bottom'|'top'`。**`side/maxWidth/delayMs` 可一字不改**。
> 加 `portal`：`.toolScroll{overflow-y:auto; max-height:420px}` 会裁掉留在锚点 stacking context 里的气泡。

`Modal` 0.2 签名（`Modal.tsx:23-26`）：**非 headless 时 `closeLabel: string` 必填**（`raw` 漏传，`b.md` §3.2 的警告依然有效）。新增 `description?: string`。

```tsx
{pending !== null && (
  <Modal
    open
    onClose={() => actions.setPending(null)}
    title={t('disable.title')}
    closeLabel={t('close')}
    description={t('disable.desc').replace('{name}', pending.name)}
    footer={<>
      <Button variant="ghost" onClick={() => actions.setPending(null)}>{t('disable.cancel')}</Button>
      <Button variant="primary" onClick={() => {
        const target = pending; actions.setPending(null)
        if (target !== null) void toggle(target.kind, target.name, 'global')
      }}>{t('disable.confirm')}</Button>
    </>}
  >
    {/* 正文留空：说明走 description，与 0.2 Modal 的版式一致 */}
  </Modal>
)}
```

`Button` 0.2：`variant: 'primary'|'ghost'|'outline'|'toolbar'`（默认 `ghost`），`size: 'md'|'sm'`。`ghost`/`primary` 照用。

### 4.2 明确**不替换**的自研件

| 自研件 | 为什么不能换成官方原语 |
|---|---|
| tab 条（下划线 + 13px） | `SegmentedControl` / `SegmentedTabs` 是「等宽分段胶囊 + 滑动指示器」，视觉完全不同 |
| 药丸按钮（H28/R6→R8/0.5px 描边/13px） | `Pill` 是 H24/R999/无边框/`bg-layer-2`，完全不同；`ui-primitives/README.md:200` 明确「`Pill` and `Input` have no design source」 |
| 分组批量勾选（无文案 + indeterminate） | `Checkbox` 强制 `label: string` 且渲染可见文字，不暴露 `indeterminate` |
| 搜索框（H30/13px） | `Input` 是 H32/R12/font14；README 明确搜索框属 consumer-owned composition |
| zone 折叠头（12px 可旋转 caret + h3 13px） | `DisclosureRow` 是 24px 定高 + 两个 chevron 图标 + 不同颜色层级 |
| 分类色点（**任意**分类色 / 8px） | `StateDot` 只有 4 个语义态 |
| 「内置禁用」徽标（font10/R5→R4/实心 warn + 反相文字） | `Tag` 的 `warning` 是 12% 淡底 + warn 文字，视觉相反 |
| 三个内联 SVG（caret / chevron / check） | caret 是**填充路径**，与 0.2 outline chevron 形状不同 → 保留原 SVG；只有 check 可用 `IconCheckOutlineRegular`（14px） |

### 4.3 必须替换的自研件：工作区下拉 → `Menu`

```tsx
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'

<Menu
  open={wsOpen}
  onClose={() => setWsOpen(false)}
  portal                                   // 设置面板 .options 有 overflow-y:auto，必须 portal
  getAnchorRect={() => triggerRef.current?.getBoundingClientRect() ?? null}
  selectedId={view.selectedWorkspaceId}
  items={scopes.map(s => ({ id: s.id, label: s.title }))}
  onSelect={(id) => { setWsOpen(false); selectWorkspace(id) }}
  listClassName={css.wsMenu}
  anchor={
    <button ref={triggerRef} type="button" className={css.select}
      aria-haspopup="menu" aria-expanded={wsOpen}
      onClick={() => setWsOpen(v => !v)}>
      {currentTitle}
      <span className={css.chevron} aria-hidden="true">{WS_CHEVRON_SVG}</span>
    </button>
  }
/>
```

- **chevron 继续自绘**（`Menu` 只渲染 `anchor`，不提供触发器内部图标），原方案「按钮右侧绝对定位 chevron」**可原样保留**。
- 选中对勾由 `selection="check"`（默认）提供，是 `IconCheckOutlineRegular` 14px，颜色 `--dsw-alias-label-primary`（不是 brand-primary）。
- `.wsMenu` **只能**写 `min-width` / `max-width`，**不能**写 `background` / `backdrop-filter`（`ui-theme/tests/menu-surfaces.client.spec.ts:73-80` 会拒）。
- **无自动上下翻转**：0.2 的 `Menu` 只做视口夹取（`Menu.tsx:276`）。若要翻转，自己算 `side`。

**视觉差异（必须记录，无法避免）**：

| 维度 | `raw` 自绘 | 0.2 `Menu` |
|---|---|---|
| 外圆角 | 12px | 16px（`--dsw-radius-lg`，`MenuSurface.module.css:3`） |
| 描边 | `0.5px solid border-l4` + elevation | `border: 0`，描边在阴影里（stroke 重绑 `border-l1`） |
| 底色 | `bg-layer-1` | 半透明 `--dsw-menu-surface-fill` + backdrop blur |
| 选中态 | `font-weight:500` + brand-primary | 无字重变化 + 行尾对勾 + 主文字色 |
| 行高 / 圆角 | `6px 10px` / R8 | `min-height:34px; padding:6px 8px` / R12 |

理由：0.2 的浮层材质（半透明 + backdrop-filter + macOS backing）**只能由 `MenuSurface` 提供**——`docs/web-styling.zh.md:26` 与 `menu-surfaces.client.spec.ts:58-71` 都会拒绝自绘 `role="menu"`/`"listbox"` 的浮层。

---

## 5. CSS 全量清单（照抄 + 4 处映射）

交付方式：**CSS Modules**（`src/client/AbilitySection.module.css`），构建期由共享预设的 lightningcss 插件编译并在**工厂执行期**注入带 `data-plugin` 的 `<style>`。类名不再需要 `dwa-` 前缀（模块作用域已隔离），但**保持相同的层级与命名习惯**以便与 `raw` 对照。

```ts
// 每个用 CSS Modules 的包都要有 src/css-modules.d.ts（照抄 ui-theme/src/css-modules.d.ts:1-11）
declare module '*.module.css' { const classes: Record<string, string>; export default classes }
declare module '*.css'
declare module '*.css?inline' { const css: string; export default css }
```

### 5.1 骨架与标题（✅ 一字不改）

```css
.section { display: flex; flex-direction: column; gap: 12px; max-width: 760px;
           color: var(--dsw-alias-label-primary); }
.header  { display: flex; flex-direction: column; gap: 8px; }
.title   { margin: 0; font-size: 18px; font-weight: 600; }
.desc    { margin: 0; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.toolsWrap { display: flex; flex-direction: column; gap: 16px; padding-top: 2px; }
```

> `max-width: 760px` **永远不会生效**（真实内容列宽 = 800 − 188 − 48 = **564px**）。保留，但布局不能依赖 760。

### 5.2 Tab 条（✅ 一字不改；新增 `:focus-visible::after`）

```css
.tabs { display: flex; align-items: flex-end; gap: 22px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l2); margin-top: 2px; }

.tab { position: relative; border: 0; padding: 7px 1px 9px; background: transparent;
       color: var(--dsw-alias-label-tertiary); font: inherit;
       font-size: 13px; line-height: 20px; cursor: pointer; }

.tab:hover,
.tab[data-active='true'] { color: var(--dsw-alias-label-primary); }

/* 0.2 官方基线：激活态与键盘聚焦都画下划线 */
.tab[data-active='true']::after,
.tab:focus-visible::after {
  position: absolute; right: 0; bottom: -1px; left: 0; height: 2px;
  border-radius: 2px 2px 0 0; background: var(--dsw-alias-label-primary); content: '';
}

/* ⚠️ 唯一必须替换的一处：focus 环改用 token，不再硬编码 2px */
.tab:focus-visible {
  outline: var(--dsw-focus-ring-width)
           solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px; border-radius: 2px;
  color: var(--dsw-alias-label-primary);
}
```

激活态用 **`data-active="true"` 属性**（不是 class），与官方一致。

### 5.3 Zone（全局 / 工作区折叠区）（✅ 一字不改）

```css
.zone     { display: flex; flex-direction: column; gap: 8px; }
.zoneHead { display: flex; align-items: center; gap: 8px; }
.zoneToggle { display: flex; align-items: center; gap: 6px; border: 0; background: transparent;
              padding: 0; font: inherit; cursor: pointer; color: var(--dsw-alias-label-primary); }
.zoneToggle:hover { color: var(--dsw-alias-state-business-primary); }
.zoneCaret { display: inline-flex; align-items: center; justify-content: center;
             width: 12px; height: 12px; flex: none; transition: transform .15s;
             color: var(--dsw-alias-label-tertiary); }
.zoneToggle[aria-expanded='false'] .zoneCaret { transform: rotate(-90deg); }
.zoneTitle { margin: 0; font-size: 13px; font-weight: 400; line-height: 20px; color: inherit; }
.zoneCount { margin-left: 4px; font-size: 12px; font-weight: 400;
             color: var(--dsw-alias-label-tertiary); }
.zoneCount::before { content: '·'; margin-right: 4px; }
```

折叠箭头用 §5.10 的内联 SVG，**默认朝下**，折叠时整体 `rotate(-90deg)` 变朝右。

### 5.4 搜索行与滚动区（✅ 一字不改）

```css
.searchRow   { display: flex; gap: 8px; margin-bottom: 10px; }
.searchInput { flex: 1; height: 30px; padding: 0 10px;
               border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm); /* 6px → 8px */
               font: inherit; font-size: 13px;
               background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.searchInput::placeholder { color: var(--dsw-alias-label-dimmed); }
.searchInput:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); } /* brand-primary → business */
.toolScroll { max-height: 420px; overflow-y: auto; padding: 0 0 12px; margin: 0; }
```

**滚动区固定 420px 上限**是「页面高度可控」的关键：工具再多也只在这里滚，外层设置面板不跳。

### 5.5 分组头 + 批量勾选（✅ 除圆点外一字不改）

```css
.group { margin: 0; }
.group + .group { margin-top: 10px; }
.groupTitle { display: flex; align-items: center; gap: 6px; margin: 0 0 6px;
              font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-tertiary); }
.catDot { width: 8px; height: 8px; border-radius: 50%; corner-shape: round; /* ⚠️ 0.2 必须补 */
          flex: none; display: inline-block; }   /* 背景色由 JS 内联注入，见 §7 */
.groupCount { margin-left: 4px; font-size: 11px; font-weight: 400; }
.groupCount::before { content: '·'; margin-right: 4px; }
.batchToggle { margin-left: auto; margin-right: 12px; display: inline-flex; align-items: center; cursor: pointer; }
.batchToggle input { width: 14px; height: 14px; margin: 0; cursor: pointer;
                     accent-color: var(--dsw-alias-brand-primary); }  /* ✅ 保持黑白，与官方 Checkbox 同款 */
```

语义：`<h4>`，依次 色点 → 分类名 → `·N/M` → 批量勾选框（右推）。部分选中用 ref 写 `el.indeterminate = true`。

### 5.6 药丸按钮（页面主角）（⚠️ 圆角 6→8）

```css
.toolGrid { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; margin: 0; padding: 0; }

.toolBtn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px;
           border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); /* 6px → 8px */
           background: transparent; font: inherit; font-size: 13px;
           color: var(--dsw-alias-label-secondary); cursor: pointer;
           transition: background .12s, border-color .12s, color .12s; }
.toolBtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

/* 启用态：淡灰底 + 分类色描边（描边由内联 style 覆盖为 catColor(category)） */
.toolBtnEnabled { border-color: var(--dsw-alias-state-business-primary);
                  background: var(--dsw-alias-bg-module-platform);
                  color: var(--dsw-alias-label-primary); }
.toolBtnEnabled:hover { background: var(--dsw-alias-interactive-bg-active); }

/* 内置禁用态：半透明 + 虚线圈（dashed 保持 1px，见下） */
.toolBtnBuiltin { opacity: .5; cursor: not-allowed; border-style: dashed; }
.toolBtnBuiltin:hover { background: transparent; color: var(--dsw-alias-label-secondary); }

.toolName { font-family: var(--ds-font-family-code); }   /* 真实 token 名是 --ds- 前缀 */
.toolBadge { font-size: 10px; padding: 1px 6px; border-radius: var(--dsw-radius-xs);  /* 5px → 4px */
             background: var(--dsw-alias-state-warn-primary);
             color: var(--dsw-alias-label-primary-foreground); }
```

三态：

| 状态 | 视觉 | 代码判定 |
|---|---|---|
| 启用 | 淡灰底 + 1px 分类色描边 + 主文字色 | `row.state === 'enabled'` → `[styles.toolBtn, styles.toolBtnEnabled]` + 内联 `borderColor: catColor(category)` |
| 禁用 | 透明底 + 发丝灰描边 + 次要文字色 | `row.state === 'disabled'` → 仅 `styles.toolBtn` |
| 内置禁用 | 半透明 + 虚线圈 + 右侧「内置禁用」橙色徽标 | `row.state === 'builtin'` → `[styles.toolBtn, styles.toolBtnBuiltin]` |

> **本页最有辨识度的视觉特征**：`toolBtnEnabled` 的 `border-color` 被内联样式覆盖为分类色，所以**每个分组的启用按钮描边颜色不同**（文件操作=橙、MCP=蓝、动态插件=按 hash 取的调色板色…）。

`builtin` 态的可交互性（细节但重要）：为了仍能显示 tooltip，**不要用 `disabled` 属性**（会吞掉 hover/focus）：

```tsx
<button type="button" className={clsx(styles.toolBtn, styles.toolBtnBuiltin)}
  aria-disabled={true} tabIndex={-1} onClick={undefined} style={undefined}>
```

### 5.7 工作区下拉按钮（✅；浮层改 `Menu` 见 §4.3）

```css
.select { box-sizing: border-box; flex: none; height: 28px; padding: 0 28px 0 10px;
          border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm); /* 8px ✅ */
          font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; appearance: none;
          background-color: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.select:hover { border-color: var(--dsw-alias-label-caption); }
.select:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.chevron { position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
           color: var(--dsw-alias-label-tertiary); pointer-events: none; }
/* 浮层只允许调宽度 */
.wsMenu { min-width: 160px; max-width: 280px; }
```

### 5.8 三种占位态（⚠️ 空态 dashed 由 0.5px → 1px）

```css
.empty { padding: 20px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary);
         border: 1px dashed var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); }
.loading { padding: 20px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.error { padding: 12px; font-size: 13px; color: var(--dsw-alias-state-error-primary);
         border: 0.5px solid var(--dsw-alias-state-error-primary);
         border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); }
```

> 空态的 `dashed` 记号 0.2 规范要求保持 **1px**（`docs/web-styling.zh.md:29`）；实线发丝线仍 0.5px。

### 5.9 三个内联 SVG（**直接抄 `raw/a.md`**）

折叠箭头（`viewBox 0 0 14 14`，展开朝下，折叠时 CSS `rotate(-90deg)`）：

```html
<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z" fill="currentColor"/></svg>
```

下拉 chevron（`viewBox 0 0 12 12`，描边 1.5）：

```html
<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
```

选中对勾（`viewBox 0 0 14 14`，描边 1.5）——若用 `Menu` 则由 `selection="check"` 自带，不必自备：

```html
<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 7.5L5.5 10.5L11.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
```

`fill="currentColor"` / `stroke="currentColor"` 让图标跟随文字色，浅深色自动适配。

---

## 6. Token 真名映射（**唯一需要改颜色的地方**）

### 6.1 全部存在（可直接用，浅/深值已核对）

`label-primary` / `-secondary` / `-tertiary` / `-caption` / `-dimmed` / `-primary-foreground`、`bg-base` / `bg-layer-1` / `-2` / `-3` / `bg-module-platform`、`border-l1`~`l4`、`interactive-bg-hover` / `-active`、`state-business-primary` / `state-warn-primary` / `state-success-primary` / `state-error-primary` / `state-idle-primary`、`brand-primary`、`elevation-panel` / `-prominent` / `-soft`、`menu-surface-fill`、`--ds-font-family-code`、`--dsw-focus-ring-width` / `--dsw-focus-ring-color`、`--dsw-radius-xs`(4) / `-sm`(8) / `-md`(12) / `-lg`(16) / `-xl`(20) / `-panel`(28)。

`b.md` §11.2 的实测对照全部成立（`bg-module-platform` = `rgb(245,246,247)`/`rgb(53,54,56)`；`bg-layer-1` = 白/`rgb(35,35,36)`；`border-l2` = `rgba(0,0,0,.1)`/`rgba(255,255,255,.12)`；面板底 `bg-layer-2` = 白/`rgb(44,44,46)`）。

### 6.2 四处必须改

| # | `raw` 写法 | 0.2 现实 | 改为 |
|---|---|---|---|
| 1 | `--dsw-alias-brand-primary` 当「品牌蓝」用：搜索/下拉 focus 边框、选中项文字、`CAT_PALETTE` 第 5 色 | 0.2 把它绑成**近黑（浅）/ 近白（深）**（`design-platform.css:192` / `:310`），官方文档明确（`ui-dockkit/README.zh.md:78`） | **`--dsw-alias-state-business-primary`**（浅 `rgb(65,118,230)` / 深 `rgb(122,170,255)`）。若要更强的蓝用 `--dsw-alias-brand-primary-new-colorprimary-new-color`（`:191` = `rgb(65,118,230)`） |
| 2 | 批量勾选 `accent-color: brand-primary` | 同上——但**这里要保持** | **保持 `--dsw-alias-brand-primary`**（0.2 官方 `Checkbox.module.css:16` 就是黑白勾选，这是设计） |
| 3 | `border-l4` 深色按 `.16` 理解（`b.md` §11.2 也是 `.16`） | 深色是 **`rgba(255,255,255,.2)`**（`:307`） | 用 token，**不要写死 .16** |
| 4 | `border-radius: 5px`（徽标）/ `6px`（药丸、搜索框） | 0.2 只有 4/8/12/16/20/28，且 lint 拒绝 `>4 且 <99` 的字面 px（`ui-theme/tests/radius-styles.client.spec.ts:22-28`） | 5px → `--dsw-radius-xs`(4)；6px → `--dsw-radius-sm`(8) |

另外两处规范要求：

- `border-radius: 50%`（分类色点）**必须同规则补 `corner-shape: round`**，否则 0.2 的 `superellipse(1.5)` 会把它画成小 squircle（spec 强制：`corner-shape-styles.client.spec.ts:83`）。
- 浮层若保留自绘（不推荐）：`border: 0` + `box-shadow: var(--dsw-elevation-prominent)`（描边由阴影第一层提供，可重绑 `--dsw-elevation-stroke-color`）。`border + elevation` 并存会被 `elevation-styles.client.spec.ts:149-166` 拒绝。

### 6.3 无法还原的一处（产品决策）

0.2 对全站应用 `corner-shape: superellipse(1.5)`（`ui-theme/src/styles/corner-shape.css:16-25`），所有圆角都是**超椭圆**而非圆弧。规范禁止组件级 opt-out（`docs/ui-radius.zh.md:52`「不要添加组件专用的平滑规则」）。→ **视觉上会比 0.1.2 略「方」一点**，这是平台级的，插件无法规避，需在验收清单里注明。

---

## 7. 分类、分组与配色算法（**照抄 `raw/a.md` §6，一行不改**）

### 7.1 工具分类（只给 `{name, description}`，无 category 字段，纯名字推断）

```ts
function categorize(name: string): string {
  if (BUILTIN_DISABLED.includes(name)) return 'builtin'
  if (['read','write','edit','glob','grep'].includes(name)) return 'file'
  if (['pwsh','bash'].includes(name)) return 'shell'
  if (['read_image','describe_image'].includes(name)) return 'image'
  if (['list_agents','subagent','subagent_fork','named_subagent','send_message','interrupt_agent'].includes(name)) return 'agent'
  if (name.startsWith('job_')) return 'job'
  if (['create_goal','get_goal','update_goal'].includes(name)) return 'goal'
  if (name === 'ralph') return 'ralph'
  if (name.startsWith('cordis_')) return 'cordis'
  if (['ask_user_question','skill','todo_write','exit_plan_mode'].includes(name)) return 'misc'
  if (name.startsWith('mcp__')) return 'mcp'
  const i = name.indexOf('_')
  if (i > 0) return cap(name.slice(0, i))     // sandore_x → Sandore
  return 'plugin-other'
}
```

技能用**连字符前缀**规则：`gc-brainstorming → Gc`、`plm-init → Plm`，无连字符则自身名首字母大写。

### 7.2 分组合并与排序

```
FIXED_CATS = ['plugin-other','mcp','file','shell','image','agent','job','goal','ralph','cordis','misc','builtin']
1. 按 category 聚合
2. 动态分类（不在 FIXED_CATS 里）且该组 < 2 个 → 并入 'plugin-other'（≥2 才独立成组）
3. 排序：动态分类在前（sortKey = -1，组间字母序）→ plugin-other → mcp → file → shell
        → image → agent → job → goal → ralph → cordis → misc → builtin
```

技能：合并目标换成 `misc`，排序为「前缀分类字母序，`misc` 永远最后」。

### 7.3 分类圆点配色（稳定 hash）

```ts
const CAT_PALETTE = [
  'var(--dsw-alias-state-business-primary)',
  'var(--dsw-alias-state-warn-primary)',
  'var(--dsw-alias-state-success-primary)',
  'var(--dsw-alias-state-error-primary)',
  'var(--dsw-alias-state-business-primary)',   // ← 原 brand-primary，按 §6.2 #1 替换
  'var(--dsw-alias-label-caption)',
]

function catColor(cat: string): string {
  if (DSH_BUILTIN_CATS.has(cat)) return 'var(--dsw-alias-state-warn-primary)'      // dsh 内置统一橙
  if (cat === 'mcp') return 'var(--dsw-alias-state-business-primary)'               // MCP 蓝
  if (cat === 'plugin-other') return 'var(--dsw-alias-label-tertiary)'              // 其它插件灰
  let hash = 0
  for (const ch of cat) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffff
  return CAT_PALETTE[hash % CAT_PALETTE.length]
}
```

hash 只由分类名决定 → 同一分类在多次渲染/刷新间颜色稳定。

> `b.md` §11.3 的已知瑕疵：`commandCatColor` / `agentCatColor` 用硬编码 `hsl(...)`，深色下对比度不足。**本次统一成 `CAT_PALETTE`**（修正该瑕疵，视觉在浅色下基本一致、深色下更正确）。

### 7.4 隐藏项

| 位置 | 规则 | 原因 |
|---|---|---|
| 工具 | `BUILTIN_DISABLED`（默认空，可由 config 扩展） | 由替代品接管时不再展示 |
| 工具 | `NON_DISABLEABLE`（`run_code` / `ask_user_question` / `todo_write`）+ 可配置扩展 | 禁用会自我锁死 |
| 技能 | `SKILL_NON_DISABLEABLE`（`cordis-plugin-development` / `editing-cordis-compositions` / `dsh-plugins-principles`） | 框架必须技能 |

> 推论：`state === 'builtin'` 分支在当前默认数据下**不可达**（`buildRows()` 已过滤）。保留该分支作为配置扩展时的兜底。

---

## 8. 设置导航项的图标（**0.2 仍必须用 hack，必须保留**）

### 8.1 为什么不能用官方字段

0.2 的 `settings.section` 注册项**仍然没有 `icon`**；导航图标由 shell 按 id 硬编码，未知 id 回退齿轮：

```tsx
// packages/client/ui-settings-general/src/client/SettingsRoot.tsx:31-39
/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'account') return <IconUserOutlineMedium className={css.navIcon} size={16} />
  …
  return <IconSettingsOutlineMedium className={css.navIcon} size={16} />
}
```

`SettingsSectionOwnerProps` 只有 `close`；投影结构只有 `{ id, order, label }`（`shell-contract.ts:23-28`）。→ 只有两条路：**保留 hack** 或**接受齿轮**。本案保留 hack。

### 8.2 与 0.2 DOM 的对应关系（已核对）

| 0.1.2 假设 | 0.2 现实 | 结论 |
|---|---|---|
| 选择器 `[role="dialog"] nav button` | `panel[role="dialog"] > nav > button`（`SettingsRoot.tsx:70-89`） | ✅ 仍命中 |
| button 第一个子节点是 shell 的 `<svg class="navIcon">` | 一致 | ✅ `[MARKER] > svg:first-child{display:none}` 仍成立 |
| 图标 18×18（SVG 自身属性） | 容器是 **16×16**（`size={16}` + `.navIcon{flex:none}`，`SettingsRoot.module.css:167-169`） | ⚠️ CSS 尺寸必须写 **16px** |
| `characterData: true` 必要 | `label: () => t('nav')` 切语言返回新串，shell 靠 locale 重投影 | ✅ 仍必要 |

### 8.3 全局样式表（用 `?inline` + `ctx.effect` 管生命周期）

```ts
// src/client/ability-nav.css —— 这是全局选择器，不能进 CSS Modules
const MARKER = 'data-dsh-ability-nav'

export const NAV_CSS = `
[${MARKER}] > svg:first-child { display: none }
[${MARKER}]::before {
  content: ''; flex: none; width: 16px; height: 16px;
  background: currentColor;
  -webkit-mask: url("${SLIDERS_SVG}") center / contain no-repeat;
  mask: url("${SLIDERS_SVG}") center / contain no-repeat;
}
`
```

`SLIDERS_SVG` 用 `raw/a.md` §10.2 的 data URI **原样**（`<` → `%3C`、`>` → `%3E`、属性用单引号、空格保留、不 base64）。

```ts
export function setupNavIcon(label: () => string): () => void {
  const style = document.createElement('style')
  style.dataset.dshAbilityNav = ''
  style.textContent = NAV_CSS
  document.head.appendChild(style)

  let disposed = false
  const sync = (): void => {
    if (disposed) return
    const want = label().trim()
    for (const button of document.querySelectorAll<HTMLButtonElement>('[role="dialog"] nav button')) {
      if ((button.textContent ?? '').trim() === want) button.setAttribute(MARKER, '')
      else button.removeAttribute(MARKER)
    }
  }
  sync()
  const observer = new MutationObserver(sync)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  return () => {
    disposed = true
    observer.disconnect()
    document.querySelectorAll(`[${MARKER}]`).forEach(el => el.removeAttribute(MARKER))
    style.remove()
  }
}
```

要点（`raw/a.md` §10.3 的四条理由全部仍然成立）：用 `mask` 而非 `<img>` 让颜色跟随 `currentColor`；用 `::before` + `data-*` 标记不碰 React 的 vDOM；用 `MutationObserver` 因为无声明式 icon 字段；**disposer 必须完整**（断 observer、摘标记、删 style）。

---

## 9. i18n（`zh` / `en` 必须同 key 集合）

命名空间 `settings.ability`。在模块里声明合并以便类型化：

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.ability':
      | 'nav' | 'desc' | 'close'
      | `tab.${AbilityTab}`
      | 'scope.global' | 'scope.workspace'
      | `search.${AbilityTab}` | `empty.${AbilityTab}` | `noResults.${AbilityTab}`
      | 'cat.file' | … | 'cat.misc'
      | 'tool.builtin' | `builtinReason.${string}`
      | 'disable.title' | 'disable.desc' | 'disable.confirm' | 'disable.cancel'
      | 'loading' | 'error'
  }
}
```

| key | zh | en |
|---|---|---|
| `nav` | 能力管理 | Ability |
| `desc` | 管理工具的启用与禁用，可在全局或工作区配置。工作区配置叠加在全局之上。 | Manage tool enable/disable, configurable globally or per-workspace. Workspace config overlays global. |
| `close` | 关闭 | Close |
| `tab.tools` / `tab.skills` | 工具 / 技能 | Tools / Skills |
| `scope.global` / `scope.workspace` | 全局 / 工作区 | Global / Workspace |
| `search.tools` / `.skills` | 搜索工具 / 搜索技能 | Search tools / Search skills |
| `empty.tools` / `.skills` | 暂无工具配置 / 暂无技能 | No tool configuration yet / No skills |
| `noResults.tools` / `.skills` | 无匹配工具 / 无匹配技能 | No matching tools / No matching skills |
| `cat.file` `cat.shell` `cat.image` `cat.agent` `cat.job` `cat.goal` `cat.ralph` `cat.cordis` `cat.mcp` `cat.misc` `cat.builtin` `cat.plugin-other` | 文件操作 / Shell / 图像 / 子 Agent / 后台 Job / 目标管理 / Ralph 循环 / Cordis 动态插件 / MCP 服务器 / 其它 / 内置禁用 / 其它插件 | Files / Shell / Image / Sub-agent / Background Jobs / Goals / Ralph Loop / Cordis Plugins / MCP Servers / Misc / Built-in disabled / Other plugins |
| `tool.builtin` | 内置禁用 | Built-in disabled |
| `disable.title` / `disable.desc` / `disable.confirm` / `disable.cancel` | 禁用内置工具 / 该工具为 DSH 内置工具，禁用后可能导致 DSH 对话功能无法正常使用，是否禁用 {name}？ / 禁用 / 取消 | … |
| `loading` / `error` | 加载中… / 加载失败 | Loading… / Load failed |

`raw/a.md` §9 列出的**未使用残留 key**（`tab.mcp`、`scope.hint`、`tool.add`、`tool.enabled`、`tool.restore`、`cat.search`、`cat.browser`、`save`、`cancel`、`comingSoon` …）**本次全部删除**——0.2 的类型化 `LocaleNamespaceMap` 要求键集精确，残留 key 会让字典与类型不一致。

---

## 10. 逐条交互规格（`raw/a.md` §8 全保留 + 0.2 增量）

| # | 触发 | 行为 | 细节 |
|---|---|---|---|
| 1 | 点击 tab | 切本地 state，只换下半部分 | 无动画；`data-active="true"` + 2px 下划线 |
| 2 | 键盘 Tab 到 tab | `:focus-visible` 环（offset 2px） | **环用 token**，且 0.2 基线在聚焦时**也画下划线** |
| 2b | tab 上 ←/→/Home/End | roving tabIndex 走查 | 0.2 官方 tab 范式（`PluginsSettingsSection.tsx:61-97`），建议照抄 |
| 3 | 点击 zone 标题 | 折叠/展开 | `aria-expanded` 取反，caret `rotate(-90deg)` 过渡 `.15s`；**全局默认展开、工作区默认折叠** |
| 4 | 搜索框输入 | 立即客户端过滤（无防抖、无请求） | `name.toLowerCase().includes(q) \|\| category.toLowerCase().includes(q)`；无结果 → 虚线空态 |
| 5 | 点击药丸（enabled） | 禁用该能力 | **DSH 内置分类**（file/shell/image/agent/job/goal/ralph/cordis/misc/builtin）先弹二次确认 Modal，其它分类直接生效 |
| 6 | 点击药丸（disabled） | 启用 | 不弹确认 |
| 7 | 点击分组批量勾选 | 全开/全关该分组 | `checked = allEnabled`，部分启用用 ref 写 `indeterminate` |
| 8 | hover 药丸 | Tooltip | `side="bottom"`、`maxWidth=500`、`delayMs=1000`、**`portal`**；内容 = description（builtin 再拼一行原因） |
| 9 | 点击工作区下拉 | 打开浮层 | 0.2 由 `Menu` 处理外部点击/Esc/键盘 |
| 10 | 浮层定位 | `position:fixed` | `Menu` 的 `portal` + `getAnchorRect`，视口 8~12px 夹取；**无自动上下翻转** |
| 11 | 选中工作区 | 更新 `selectedWorkspaceId` + 自动展开工作区 zone | 所有开关与计数立即按新工作区的生效集重算 |
| 12 | 配置在别处被改 | `settings/document-updated` → **静默**重载 | 用 `revision` 去重，不清搜索词、不闪 loading |
| 13 | 加载中/出错/无数据 | `loading` / `error` / `empty` | 无数据时整块 tab 内容替换为空态文案 |
| 14 | 工作区 zone 折叠 | 不渲染列表 | 未选工作区时展开显示空态 |
| **15** | 连接重置 | 静默重载 | `ctx.on('connection/reset')` |

---

## 11. 验收清单（`raw/b.md` §13 全保留 + 0.2 增量）

- [ ] 设置弹窗里出现「能力管理」，位置在「插件」之后、「Agent 预设」之前，**图标不是齿轮**（`order: 17` 在 0.2 仍精确）。
- [ ] 标题 18/600、描述 13px 三级色、tab 间距 22px、激活项有 2px 下划线。**逐值比对 `PluginsSettingsSection.module.css`**（可直接在运行时的「插件」页旁对照）。
- [ ] 全局 zone 默认展开、工作区 zone 默认折叠；caret 折叠时朝右。
- [ ] 分组头：色点 8px + 11/600 名称 + `·N/M` + 右侧 14px 批量勾选（部分选中显示横杠）。
- [ ] 药丸按钮高 28px、**圆角 8px**（原 6px，见 §6.2 #4）、发丝描边；启用态淡底 + **分类色**描边；工具名是等宽字体（`--ds-font-family-code`）。
- [ ] 搜索框 30px 高、**圆角 8px**、focus 变**蓝**边（`state-business-primary`，不是黑白 `brand-primary`）；输入即过滤，无结果给虚线空态（dashed **1px**）。
- [ ] 列表区最高 420px 后内部滚动。
- [ ] hover 药丸 1s 后出 tooltip（最大宽 500，位于下方，**`portal` 生效不被滚动容器裁剪**）。
- [ ] 点 DSH 内置分类里的启用工具 → 弹确认框（**`closeLabel` 已传**）；取消不改状态，确认后立即变色。
- [ ] **只有 2 个 tab**（工具 / 技能），没有命令 / Agent 的残留 tab、灰态占位或文案。
- [ ] 切换工作区后，工作区 zone 自动展开，且开关状态与 `·N/M` 计数立即按新工作区重算。
- [ ] 深色主题下无「亮块/看不清」；切语言所有文案即时变化（**无任何自订阅代码**）。
- [ ] 在工作区下拉里，浮层是半透明 + 模糊材质（`MenuSurface`），不是纯色块。
- [ ] 分类色点在深色下仍是圆的（`corner-shape: round` 已补），不是 squircle。
- [ ] 在别处改 profile 配置的 `dsh-magica-rune` 段，页面静默同步且搜索词不丢。
- [ ] 已知差异确认：圆角曲率更「方」（超椭圆，平台级，见 §6.3）；下拉浮层圆角 16px、选中态无字重变化（`Menu` 自带，见 §4.3）。
