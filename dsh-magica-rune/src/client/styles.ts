/**
 * 本页全部样式（**唯一来源**）。
 *
 * 交付方式说明（docs/design/04 §4.2）：官方 0.2 用 CSS Modules + lightningcss，
 * 由共享 tsdown 预设编译并在**模块工厂执行期**注入带 `data-plugin` 的 `<style>`。
 * 本仓构建走 esbuild CLI（避开沙箱里的 pipe EPERM），esbuild 不做 CSS Modules，
 * 因此这里采用文档里的「轻量 (B)」方案：类名统一 `rune-` 前缀保证唯一，
 * 样式在**模块顶部**注入一次（与官方一样在工厂执行期，不是组件 render 里），
 * 并由模块系统按 `data-plugin` 回收。
 *
 * 全量数值照抄 docs/raw/a.md §5，只有 4 处按 0.2 的真名映射：
 *   1. `--dsw-alias-brand-primary`（0.2 = 近黑/近白）→ `--dsw-alias-state-business-primary`
 *   2. `border-l4` 深色是 .2（不写死数值，直接用 token）
 *   3. 焦点环 → `--dsw-focus-ring-*`（0.1.2 的 `outline: 2px solid` + brand 色）
 *   4. `--dsw-alias-state-warn-primary` 等状态色沿用同名 token
 *
 * ⚠️ 三处**故意保留字面 px**（raw 是 6px / 6px / 5px，0.2 的 `--dsw-radius-*`
 * 只有 4/8/12/16/20/28，取 token 会变成 8px / 8px / 4px，视觉对不上）：
 *   - `.rune-search-input` / `.rune-pill` → `border-radius: 6px`
 *   - `.rune-badge` → `border-radius: 5px`
 * 这三处不是遗漏，是「与 raw 逐值一致」优先于「只用 token」的取舍。
 * @module dsh-magica-rune/client/styles
 */

export const PLUGIN_ID = '@meiyukichan/dsh-magica-rune'
const STYLE_TAG_ID = `${PLUGIN_ID}/ability.css`

/** 类名常量（与下面的 CSS 一一对应）。 */
export const cls = {
  section: 'rune-section',
  header: 'rune-header',
  title: 'rune-title',
  desc: 'rune-desc',
  tabs: 'rune-tabs',
  tab: 'rune-tab',
  body: 'rune-body',
  zone: 'rune-zone',
  zoneHead: 'rune-zone-head',
  zoneToggle: 'rune-zone-toggle',
  zoneCaret: 'rune-zone-caret',
  zoneTitle: 'rune-zone-title',
  zoneCount: 'rune-zone-count',
  searchRow: 'rune-search-row',
  searchInput: 'rune-search-input',
  scroll: 'rune-scroll',
  group: 'rune-group',
  groupTitle: 'rune-group-title',
  catDot: 'rune-cat-dot',
  groupCount: 'rune-group-count',
  batchToggle: 'rune-batch-toggle',
  grid: 'rune-grid',
  pill: 'rune-pill',
  pillEnabled: 'rune-pill-enabled',
  pillBuiltin: 'rune-pill-builtin',
  pillName: 'rune-pill-name',
  badge: 'rune-badge',
  select: 'rune-select',
  chevron: 'rune-chevron',
  menu: 'rune-menu',
  empty: 'rune-empty',
  loading: 'rune-loading',
  error: 'rune-error',
} as const

/** 样式表文本。数值与 raw/a.md §5 逐条对应。 */
const CSS = `
.${cls.section} {
  display: flex; flex-direction: column; gap: 12px; max-width: 760px;
  color: var(--dsw-alias-label-primary);
}
.${cls.header} { display: flex; flex-direction: column; gap: 8px; }
.${cls.title} { margin: 0; font-size: 18px; font-weight: 600; }
.${cls.desc} { margin: 0; font-size: 13px; color: var(--dsw-alias-label-tertiary); }

.${cls.tabs} {
  display: flex; align-items: flex-end; gap: 22px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2); margin-top: 2px;
}
.${cls.tab} {
  position: relative; border: 0; padding: 7px 1px 9px; background: transparent;
  color: var(--dsw-alias-label-tertiary); font: inherit;
  font-size: 13px; line-height: 20px; cursor: pointer;
}
.${cls.tab}:hover, .${cls.tab}[data-active='true'] { color: var(--dsw-alias-label-primary); }
.${cls.tab}[data-active='true']::after {
  position: absolute; right: 0; bottom: -1px; left: 0; height: 2px;
  border-radius: 2px 2px 0 0; background: var(--dsw-alias-label-primary); content: '';
}
.${cls.tab}:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px)
    solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px; border-radius: 2px; color: var(--dsw-alias-label-primary);
}

.${cls.body} { display: flex; flex-direction: column; gap: 16px; padding-top: 2px; }

.${cls.zone} { display: flex; flex-direction: column; gap: 8px; }
.${cls.zoneHead} { display: flex; align-items: center; gap: 8px; }
.${cls.zoneToggle} {
  display: flex; align-items: center; gap: 6px; border: 0; background: transparent;
  padding: 0; font: inherit; cursor: pointer; color: var(--dsw-alias-label-primary);
}
.${cls.zoneToggle}:hover { color: var(--dsw-alias-state-business-primary); }
.${cls.zoneCaret} {
  display: inline-flex; align-items: center; justify-content: center;
  width: 12px; height: 12px; flex: none; transition: transform .15s;
  color: var(--dsw-alias-label-tertiary);
}
.${cls.zoneToggle}[aria-expanded='false'] .${cls.zoneCaret} { transform: rotate(-90deg); }
.${cls.zoneTitle} { margin: 0; font-size: 13px; font-weight: 400; line-height: 20px; color: inherit; }
.${cls.zoneCount} {
  margin-left: 4px; font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-tertiary);
}
.${cls.zoneCount}::before { content: '·'; margin-right: 4px; }

.${cls.searchRow} { display: flex; gap: 8px; }
/*
 * 搜索框由 ui-primitives 的 Input 原语渲染（SKILL §3.2 复用原语）：
 * className 落在外层 wrapper 上，所以高度/内距/圆角覆盖 wrapper；
 * 字号与占位色作用到内层 input —— 下面那条子选择器 (0,1,1) 胜过原语的 (0,1,0)；
 * focus-within 的品牌色描边由原语自己提供。
 */
.${cls.searchInput} {
  flex: 1; height: 30px; padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
}
.${cls.searchInput} > input {
  font: inherit; font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.${cls.searchInput} > input::placeholder { color: var(--dsw-alias-label-dimmed); }
.${cls.scroll} { max-height: 420px; overflow-y: auto; padding: 0 0 12px; margin: 0; }

.${cls.group} { margin: 0; }
.${cls.group} + .${cls.group} { margin-top: 10px; }
.${cls.groupTitle} {
  display: flex; align-items: center; gap: 6px; margin: 0 0 6px;
  font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-tertiary);
}
.${cls.catDot} {
  width: 8px; height: 8px; border-radius: 50%; corner-shape: round;
  flex: none; display: inline-block;
}
.${cls.groupCount} { margin-left: 4px; font-size: 11px; font-weight: 400; }
.${cls.groupCount}::before { content: '·'; margin-right: 4px; }
.${cls.batchToggle} {
  margin-left: auto; margin-right: 12px; display: inline-flex; align-items: center; cursor: pointer;
}
.${cls.batchToggle} input { width: 14px; height: 14px; margin: 0; cursor: pointer;
  accent-color: var(--dsw-alias-brand-primary); }

.${cls.grid} { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; margin: 0; padding: 0; }
/*
 * 药丸由 ui-primitives 的 Button 原语渲染（variant=ghost + size=sm）：sm 自带 H28，
 * 正是 raw 的数值，其余按 raw 覆盖。
 *
 * ⚠️ hover 规则必须提权：原语的 ghost:hover:not(:disabled) 是 (0,3,0)，
 * 而单类的 .rune-pill:hover 只有 (0,2,0)，所以下面写成双类选择器
 * （同样 (0,3,0)，但我们的样式表更晚注入 → 胜出）。
 */
.${cls.pill} {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px;
  border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 6px;
  background: transparent; font: inherit; font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-label-secondary); cursor: pointer;
  transition: background .12s, border-color .12s, color .12s;
}
.${cls.pill}:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.${cls.pill}.${cls.pillEnabled} {
  border-color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-primary);
}
.${cls.pill}.${cls.pillEnabled}:hover { background: var(--dsw-alias-interactive-bg-active); }
.${cls.pill}.${cls.pillBuiltin} { opacity: .5; cursor: not-allowed; border-style: dashed; }
.${cls.pill}.${cls.pillBuiltin}:hover { background: transparent; color: var(--dsw-alias-label-secondary); }
.${cls.pillName} { font-family: var(--ds-font-family-code); }
.${cls.badge} {
  font-size: 10px; padding: 1px 6px; border-radius: 5px;
  background: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-label-primary-foreground);
}

.${cls.select} {
  box-sizing: border-box; flex: none; height: 24px; padding: 0 24px 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm, 8px);
  font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; appearance: none;
  background-color: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  position: relative;
}
.${cls.select}:hover { border-color: var(--dsw-alias-label-caption); }
.${cls.select}:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.${cls.select}[data-empty='true'] { color: var(--dsw-alias-label-tertiary); }
.${cls.chevron} {
  position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
  color: var(--dsw-alias-label-tertiary); pointer-events: none;
}
/* 工作区下拉浮层：Menu 的 listClassName 落在卡片上，内部 .viewport
   在 scrollable 模式下已带 overflow-y:auto（Menu.module.css:65-77），
   所以只要压住卡片高度，工作区很多时就在浮层内部滚动，不会顶穿视口。 */
.${cls.menu} { min-width: 160px; max-width: 280px; max-height: 260px; }

.${cls.empty} {
  padding: 20px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary);
  border: 0.5px dashed var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm, 8px);
}
.${cls.loading} { padding: 20px; text-align: center; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.${cls.error} {
  padding: 12px; font-size: 13px; color: var(--dsw-alias-state-error-primary);
  border: 0.5px solid var(--dsw-alias-state-error-primary);
  border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-bg-layer-1);
}
`

/**
 * 注入一次样式表（**模块工厂执行期**调用，不是组件 render）。
 * 带 `data-plugin` 让模块系统在卸载 / HMR 时按插件回收。
 */
export function installStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}
