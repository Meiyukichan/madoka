/** shell 区段的样式（由 design/index.ts 按顺序拼接）。 */
export const SHELL_CSS = String.raw`
/* ── 根变量：语义色映射 + 淡面 ─────────────────────────────────────── */
.lt-page, .lt-sheet, .lt-drawer, .lt-empty {
  --lt-accent-normal: var(--dsw-alias-label-secondary);
  --lt-accent-relaxed: var(--dsw-alias-state-success-primary);
  --lt-accent-review: var(--dsw-alias-state-business-primary);
  --lt-accent-todo: color-mix(in srgb, var(--dsw-alias-state-business-primary) 60%, var(--dsw-alias-state-error-primary) 40%);
  --lt-surface-1: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent);
  --lt-surface-2: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);
  --lt-surface-3: color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
  --lt-line: color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent);
  --lt-line-strong: color-mix(in srgb, var(--dsw-alias-label-primary) 30%, transparent);
}

/* ── 页面骨架 ──────────────────────────────────────────────────────── */
.lt-page { display: flex; flex-direction: column; height: 100%; width: 100%; flex: 1; min-width: 0; min-height: 0; padding: 12px 16px; gap: 10px; box-sizing: border-box; color: var(--dsw-alias-label-primary); font-size: 14px; }
.lt-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lt-title-group { display: inline-flex; align-items: baseline; gap: 6px; flex: none; margin: 0 10px 0 0; }
.lt-title-group .lt-heading { margin: 0; }
.lt-heading { font-size: 18px; line-height: 24px; font-weight: 600; margin: 0 10px 0 0; }
.lt-version { margin: 0 2px 0 2px; font-size: 12px; line-height: 1; color: var(--dsw-alias-label-tertiary); user-select: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
.lt-title-group .lt-version { margin: 0; }
.lt-conn { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; line-height: 1; color: var(--dsw-alias-label-tertiary); user-select: none; white-space: nowrap; }
.lt-conn[data-status="offline"] { color: var(--dsw-alias-state-warn-primary); }
.lt-conn-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.lt-conn-dot[data-status="offline"] { background: var(--dsw-alias-state-warn-primary); }
.lt-conn-dot[data-status="loading"] { background: var(--dsw-alias-state-business-primary); animation: lt-pulse 1.6s ease-in-out infinite; }
.lt-flex { flex: 1; }
.lt-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); padding: 4px 8px; border-radius: 6px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.lt-note { display: block; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.lt-note[data-tone="bad"] { color: var(--dsw-alias-state-error-primary); }
.lt-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 10px 4px; }
.lt-empty-small { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 8px 0; }

/* 工具条上的字段：与按钮同高（28px）、同字号 */
.lt-bar .lt-input, .lt-bar .lt-select { height: 28px; box-sizing: border-box; border-radius: 8px; font-size: 12px; padding: 0 8px; }
.lt-bar .lt-input input { height: 100%; font-size: 12px; }
.lt-bar .lt-select { width: auto; min-width: 108px; max-width: 200px; padding-right: 24px; }
.lt-bar .lt-filter { height: 28px; border-radius: 8px; font-size: 12px; padding: 0 10px; }
.lt-bar .lt-iconbtn { width: 32px; min-width: 32px; height: 32px; padding: 0; border-radius: 16px; justify-content: center; }
.lt-bar .lt-iconbtn svg { width: 18px; height: 18px; }
.lt-icon-group { display: inline-flex; align-items: center; gap: 6px; }
.lt-search { width: 130px; }
.lt-page .lt-search { width: 200px; flex: none; }

/* 紧急度筛选胶囊 */
.lt-filter { display: inline-flex; align-items: center; gap: 5px; font: inherit; border: 0.5px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 999px; cursor: pointer; }
.lt-filter[data-on="true"] { color: var(--dsw-alias-label-primary-foreground); border-color: transparent; }
.lt-filter[data-urgency="urgent"][data-on="true"] { background: var(--dsw-alias-state-error-primary); }
.lt-filter[data-urgency="normal"][data-on="true"] { background: var(--lt-accent-normal); }
.lt-filter[data-urgency="relaxed"][data-on="true"] { background: var(--dsw-alias-state-success-primary); }
.lt-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.lt-dot[data-urgency="runtime"] { background: var(--dsw-alias-state-business-primary); }
.lt-dot[data-urgency="direct"] { background: var(--dsw-alias-state-warn-primary); }
.lt-dot[data-urgency="urgent"] { background: var(--dsw-alias-state-error-primary); }
.lt-dot[data-urgency="normal"] { background: var(--lt-accent-normal); }
.lt-dot[data-urgency="relaxed"] { background: var(--dsw-alias-state-success-primary); }

/* 分段按钮（新建任务 + 模板箭头） */
.lt-split-wrap { position: relative; display: inline-flex; }
.lt-split { display: inline-flex; align-items: stretch; }
.lt-split > .lt-btn { height: 32px; padding: 0 14px; font-size: 13px; border-radius: 0; }
.lt-split > .lt-btn:first-child { border-radius: 16px 0 0 16px; }
.lt-split > .lt-btn:last-child { border-radius: 0 16px 16px 0; }
.lt-split > .lt-btn + .lt-btn { padding: 0 7px; min-width: 28px; border-left: 0.5px solid color-mix(in srgb, var(--dsw-alias-label-primary-foreground) 28%, transparent); }

/* 动作菜单（模板 / 导出）：与选择器弹层同一套材料 */
.lt-menu-backdrop { position: fixed; inset: 0; z-index: 40; }
.lt-menu { position: absolute; top: calc(100% + 4px); left: 0; z-index: 41; min-width: max(100%, 200px); max-width: min(420px, calc(100vw - 24px)); box-sizing: border-box; display: flex; flex-direction: column; padding: 4px; max-height: 280px; overflow-y: auto; border-radius: 20px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 0; --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent); font-size: 14px; }
.lt-menu-right { left: auto; right: 0; }
.lt-menu-item { box-sizing: border-box; display: flex; align-items: center; min-height: 38px; border: none; background: none; text-align: left; cursor: pointer; padding: 6px 8px; font: inherit; font-size: 14px; line-height: 20px; font-weight: 500; color: inherit; border-radius: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lt-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.lt-menu-item:active { background: var(--dsw-alias-interactive-bg-active); }
.lt-menu-sep { height: 0.5px; margin: 4px 2px; background: var(--dsw-alias-border-l1); }


`
