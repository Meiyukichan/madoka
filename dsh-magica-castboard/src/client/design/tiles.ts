/** tiles 区段的样式（由 design/index.ts 按顺序拼接）。 */
export const TILES_CSS = String.raw`
/* ── 车列与卡片 ───────────────────────────────────────────────────── */
.lt-stage { position: relative; flex: 1; min-height: 0; display: flex; }
.lt-lanes { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 10px; flex: 1; min-height: 0; overflow-x: auto; }
.lt-secondary { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.lt-stage > .lt-lanes, .lt-stage > .lt-secondary { flex: 1; min-height: 0; }
.lt-lane { display: flex; flex-direction: column; min-width: 200px; min-height: 0; border-radius: 12px; background: var(--lt-surface-1); padding: 8px; gap: 8px; }
.lt-lane[data-over] { outline: 2px dashed var(--lt-line-strong); outline-offset: -2px; background: var(--lt-surface-2); }
.lt-lane-head { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 500; line-height: 20px; padding: 0 6px; margin-bottom: 2px; }
.lt-count { font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.lt-lane-add { margin-left: auto; box-sizing: border-box; width: 28px; height: 28px; min-width: 28px; max-width: 28px; padding: 0; flex: none; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 50%; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.lt-lane-add:hover { border-color: var(--dsw-alias-border-l3); background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-brand-primary); }
.lt-lane-add svg { width: 16px; height: 16px; }
.lt-textlink { border: 0; background: transparent; padding: 0 2px; font: inherit; font-size: 11px; color: var(--dsw-alias-state-business-primary); cursor: pointer; }
.lt-textlink:hover { text-decoration: underline; }
.lt-tiles { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; min-height: 0; flex: 1; padding: 4px; }

.lt-tile { position: relative; border-radius: 8px; padding: 12px 10px; cursor: pointer; background: var(--dsw-alias-bg-layer-3); box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); font-size: 14px; text-align: left; color: inherit; width: 100%; box-sizing: border-box; transition: background-color .12s ease; }
.lt-tile:hover { background: var(--dsw-alias-interactive-bg-hover); }
.lt-tile[draggable="true"] { cursor: grab; }
.lt-tile[data-dragging] { opacity: .45; }
.lt-tile[data-pending="interaction"] { box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, transparent); }
.lt-tile-title { font-size: 14px; line-height: 20px; font-weight: 500; padding-right: 20px; display: block; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lt-tile-remove { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; padding: 0; flex: none; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 11px; background: transparent; cursor: pointer; color: var(--dsw-alias-label-tertiary); opacity: 0; transition: opacity .12s ease, background-color .12s ease, color .12s ease; }
.lt-tile:hover .lt-tile-remove, .lt-tile:focus-within .lt-tile-remove { opacity: 1; }
.lt-tile-remove:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); color: var(--dsw-alias-state-error-primary); }
.lt-tile-meta { display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); flex-wrap: wrap; }
.lt-tile-right { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; }

.lt-tag { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--lt-surface-3); }
.lt-tag[data-urgency="runtime"] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent); color: var(--dsw-alias-state-business-primary); }
.lt-tag[data-urgency="direct"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent); color: var(--dsw-alias-state-warn-primary); }
.lt-tag[data-urgency="urgent"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); color: var(--dsw-alias-state-error-primary); }
.lt-tag[data-urgency="normal"] { background: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); color: var(--dsw-alias-label-secondary); }
.lt-tag[data-urgency="relaxed"] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); color: var(--dsw-alias-state-success-primary); }
.lt-tag[data-tone="blocked"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent); color: var(--dsw-alias-state-error-primary); }
.lt-tag[data-tone="scheduled"] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent); color: var(--dsw-alias-state-business-primary); }
.lt-tag[data-tone="trashed"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); color: var(--dsw-alias-state-error-primary); text-decoration: line-through; }
.lt-tag[data-tone="done"], .lt-tag[data-tone="succeeded"] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); color: var(--dsw-alias-state-success-primary); }
.lt-tag[data-tone="running"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent); color: var(--dsw-alias-state-warn-primary); }
.lt-tag[data-tone="failed"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); color: var(--dsw-alias-state-error-primary); }
.lt-tag[data-tone="cancelled"] { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); color: var(--dsw-alias-label-secondary); }
.lt-tag[data-tone="urgent"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); color: var(--dsw-alias-state-error-primary); }
.lt-tag[data-tone="dispatched"], .lt-tag[data-tone="transferred"], .lt-tone-business { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent); color: var(--dsw-alias-state-business-primary); }
.lt-tag[data-tone="assigner"], .lt-tag[data-tone="assignee"] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent); color: var(--dsw-alias-state-business-primary); }
.lt-tag[data-tone="source"] { color: var(--dsw-alias-label-tertiary); }
.lt-tag[data-tone="checklist"] { color: var(--dsw-alias-label-secondary); }

.lt-session { font: inherit; font-size: 10.5px; line-height: 12px; padding: 2px 6px; border-radius: 5px; border: 1px solid var(--lt-line); background: var(--lt-surface-3); color: var(--dsw-alias-label-secondary); cursor: pointer; display: inline-flex; align-items: center; gap: 3px; }
.lt-session:hover { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.lt-session svg:last-child { transform: translateY(-2.5px); }
.lt-unread { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-error-primary); flex: 0 0 auto; margin-left: 4px; }

.lt-card-pending { display: inline-flex; align-items: center; gap: 4px; border: 0; border-radius: 999px; cursor: pointer; padding: 2px 9px; font-size: 11px; font-weight: 600; line-height: 16px; background: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-label-primary-foreground); box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent), inset 0 1px 0 color-mix(in srgb, var(--dsw-alias-label-primary-foreground) 26%, transparent); }
.lt-card-pending:hover { filter: brightness(1.06); }
.lt-card-pending-label { background-image: linear-gradient(90deg, var(--dsw-alias-label-primary-foreground) 0%, var(--dsw-alias-label-primary-foreground) 40%, color-mix(in srgb, var(--dsw-alias-label-primary-foreground) 42%, var(--dsw-alias-state-warn-primary)) 50%, var(--dsw-alias-label-primary-foreground) 60%, var(--dsw-alias-label-primary-foreground) 100%); background-size: 250% 100%; background-position: 100% 0; background-clip: text; -webkit-background-clip: text; color: transparent; -webkit-text-fill-color: transparent; animation: lt-shimmer 1.8s linear infinite; }
.lt-card-run { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 2px 9px; font-size: 11px; font-weight: 600; line-height: 16px; color: var(--dsw-alias-label-primary-foreground); }
.lt-card-run[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary); }
.lt-card-run[data-tone="ok"] { background: var(--dsw-alias-state-success-primary); }
.lt-card-run-label { background-image: linear-gradient(90deg, var(--dsw-alias-label-primary-foreground) 0%, var(--dsw-alias-label-primary-foreground) 40%, color-mix(in srgb, var(--dsw-alias-label-primary-foreground) 42%, var(--dsw-alias-state-warn-primary)) 50%, var(--dsw-alias-label-primary-foreground) 60%, var(--dsw-alias-label-primary-foreground) 100%); background-size: 250% 100%; background-position: 100% 0; background-clip: text; -webkit-background-clip: text; color: transparent; -webkit-text-fill-color: transparent; animation: lt-shimmer 1.8s linear infinite; }
.lt-card-planning { display: inline-flex; flex: none; align-items: center; gap: 4px; border: 0; border-radius: 999px; padding: 2px 9px; font-size: 11px; font-weight: 600; line-height: 16px; background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-foreground); animation: lt-breathe 1.8s ease-in-out infinite; }
@keyframes lt-shimmer { to { background-position: 0 0; } }
@keyframes lt-breathe { 0%,100% { opacity: 1; } 50% { opacity: .7; } }
@media (prefers-reduced-motion: reduce) { .lt-card-pending-label { animation: none; background: none; color: inherit; -webkit-text-fill-color: currentColor; } .lt-card-planning { animation: none; } }

/* 待验收卡的快捷操作 */
.lt-quick { display: flex; gap: 6px; margin-top: 7px; }
.lt-quickpill { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 3px 10px; border: 0; border-radius: 999px; cursor: pointer; font: inherit; font-size: 11px; font-weight: 600; line-height: 16px; color: var(--dsw-alias-label-primary-foreground); }
.lt-quickpill:hover { filter: brightness(1.06); }
.lt-quickpill[data-tone="ok"] { background: var(--dsw-alias-state-success-primary); }
.lt-quickpill[data-tone="dispatch"] { background: var(--dsw-alias-state-business-primary); }
.lt-quickpill[data-tone="muted"] { background: var(--lt-surface-3); color: var(--dsw-alias-label-secondary); box-shadow: inset 0 0 0 0.5px var(--lt-line); }
.lt-quick-reject { display: flex; gap: 6px; margin-top: 7px; align-items: stretch; }
.lt-quick-reject .lt-input { flex: 1; width: auto; min-width: 0; }
.lt-quickbtn { flex: none; font-size: 12px; padding: 3px 8px; border-radius: 6px; cursor: pointer; border: 1px solid var(--lt-line); background: var(--lt-surface-2); color: inherit; }

/* 列头的交互总入口 */
.lt-inbox-entry { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; border: 0; border-radius: 999px; cursor: pointer; padding: 1px 7px; font-size: 11px; font-weight: 600; line-height: 16px; background: var(--lt-surface-3); color: var(--dsw-alias-label-tertiary); }
.lt-inbox-entry[data-on] { background: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-label-primary-foreground); }
.lt-inbox-count { display: inline-flex; align-items: center; justify-content: center; min-width: 13px; height: 13px; padding: 0 3px; border-radius: 7px; background: color-mix(in srgb, var(--dsw-alias-label-primary-foreground) 26%, transparent); font-size: 10px; font-weight: 700; }


`
