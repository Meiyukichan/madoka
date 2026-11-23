/** drawer 区段的样式（由 design/index.ts 按顺序拼接）。 */
export const DRAWER_CSS = String.raw`
/* ── 详情抽屉 ─────────────────────────────────────────────────────── */
.lt-drawer { position: absolute; top: 0; bottom: 0; right: 0; z-index: 4; display: flex; flex-direction: column; overflow: hidden; width: min(987px, 92%); min-width: 440px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 14px; background: var(--dsw-alias-bg-layer-1); padding: 0; box-shadow: var(--dsw-elevation-prominent); animation: lt-drawer-in .16s ease-out; }
@keyframes lt-drawer-in { from { transform: translateX(14px); opacity: 0; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .lt-drawer { animation: none; } }
.lt-drawer .lt-detail { flex: 1; min-height: 0; }
.lt-detail { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; min-height: 0; padding: 0 14px 10px; position: relative; }
.lt-detail-head { position: sticky; top: 0; z-index: 2; display: flex; flex-direction: column; gap: 7px; background: var(--dsw-alias-bg-layer-1); padding: 12px 0 6px; }
.lt-title-row { display: flex; align-items: flex-start; gap: 10px; }
.lt-title-bar { flex: 1 1 200px; min-width: 0; display: flex; align-items: flex-start; gap: 8px; }
.lt-title-bar h3 { flex: 1; min-width: 0; margin: 0; font-size: 16px; line-height: 1.35; word-break: break-word; }
.lt-select.lt-title-select { width: fit-content; max-width: 100%; height: auto; padding: 0; border: 0; background: transparent; font-size: 16px; font-weight: 600; line-height: 1.35; }
.lt-select.lt-title-select .lt-select-label { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: normal; word-break: break-word; text-align: left; }
.lt-select.lt-title-select .lt-select-chevron { position: static; transform: none; align-self: flex-start; margin-top: 5px; }
.lt-select.lt-title-select:hover .lt-select-label { text-decoration: underline; text-underline-offset: 3px; }
.lt-statuspill { flex: none; display: inline-flex; align-items: center; height: calc(16px * 1.35); font-size: 11px; font-weight: 600; padding: 0 9px; border-radius: 999px; letter-spacing: .02em; }
.lt-statuspill[data-status="todo"] { background: color-mix(in srgb, var(--lt-accent-todo) 15%, transparent); color: var(--lt-accent-todo); }
.lt-statuspill[data-status="in_progress"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent); color: var(--dsw-alias-state-warn-primary); }
.lt-statuspill[data-status="in_review"] { background: color-mix(in srgb, var(--lt-accent-review) 16%, transparent); color: var(--lt-accent-review); }
.lt-statuspill[data-status="done"] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); color: var(--dsw-alias-state-success-primary); }
.lt-statuspill[data-status="canceled"], .lt-statuspill[data-status="archived"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.lt-top-buttons { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 6px; flex: 0 1 auto; }
.lt-mini { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 8px; cursor: pointer; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
.lt-mini:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
.lt-run { font: inherit; font-size: 12px; font-weight: 600; padding: 4px 11px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.lt-run:hover { filter: brightness(1.1); }
.lt-run[data-danger="true"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 92%, transparent); }
.lt-close { flex: none; width: 26px; height: 26px; border-radius: 8px; border: none; cursor: pointer; background: transparent; color: var(--dsw-alias-label-secondary); display: inline-flex; align-items: center; justify-content: center; }
.lt-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: inherit; }
.lt-inline-confirm { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.lt-inline-confirm > span { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.lt-inline-confirm > span[data-tone="bad"] { color: var(--dsw-alias-state-error-primary); }
.lt-archive-confirm { padding: 6px 8px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); border: 0.5px solid var(--dsw-alias-border-l2); }
.lt-archive-session-list { font-size: 11px; color: var(--dsw-alias-label-tertiary); word-break: break-all; }
.lt-card-block[data-kind="archive"] { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent); }
.lt-accept-list { display: flex; flex-direction: column; gap: 6px; }
.lt-accept-row { padding: 6px 9px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.lt-accept-head { display: flex; align-items: baseline; gap: 8px; }
.lt-accept-head b { flex: 1; min-width: 0; font-size: 12px; font-weight: 600; word-break: break-word; }
.lt-accept-text { margin: 3px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; word-break: break-word; }

.lt-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.lt-chip { display: inline-flex; align-items: center; gap: 4px; box-sizing: border-box; min-height: 20px; font-family: inherit; font-size: 11px; font-weight: inherit; line-height: 1; padding: 0 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
button.lt-chip { border: 0; cursor: pointer; font-size: 11px; }
button.lt-chip:hover { color: var(--dsw-alias-label-primary); text-decoration: underline; text-underline-offset: 2px; }
.lt-chip-icon { font-size: 11px; opacity: .85; display: inline-flex; align-items: center; }
.lt-chip[data-tone="urgent"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 15%, transparent); color: var(--dsw-alias-state-error-primary); }
.lt-chip[data-tone="normal"] { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); color: var(--lt-accent-normal); }
.lt-chip[data-tone="relaxed"] { background: color-mix(in srgb, var(--lt-accent-relaxed) 16%, transparent); color: var(--lt-accent-relaxed); }
.lt-detail-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); }

.lt-card-block { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 9px 11px; display: flex; flex-direction: column; gap: 5px; background: var(--dsw-alias-bg-layer-1); }
.lt-card-block[data-kind="interaction"] { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); }
.lt-block-label { font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); display: flex; align-items: center; gap: 6px; }
.lt-block-meta { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary); text-transform: none; letter-spacing: 0; }
.lt-block-meta[data-tone="bad"] { color: var(--dsw-alias-state-error-primary); font-weight: 600; }
.lt-desc { white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.55; }

.lt-checklist, .lt-report-list { display: flex; flex-direction: column; gap: 5px; }
.lt-checklist-item { display: flex; align-items: baseline; gap: 9px; padding: 6px 9px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); cursor: pointer; }
.lt-checklist-item input { flex-shrink: 0; transform: translateY(1px); cursor: pointer; accent-color: var(--dsw-alias-brand-primary); }
.lt-checklist-item[data-done="true"] .lt-checklist-text { text-decoration: line-through; color: var(--dsw-alias-label-tertiary); }
.lt-checklist-item[data-alert="true"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 6%, transparent); }
.lt-checklist-text { flex: 1; min-width: 0; font-size: 12px; word-break: break-word; }
.lt-checklist-note { max-width: 280px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.lt-issuetag { width: 100%; margin: 0; font: inherit; color: inherit; text-align: left; background: transparent; }
.lt-issuetag:hover { background: var(--dsw-alias-interactive-bg-hover); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent); }

.lt-report-summary { font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; margin-bottom: 8px; }
.lt-report-section { margin-bottom: 8px; }
.lt-report-label { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-bottom: 4px; }
.lt-report-list { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.55; word-break: break-all; }
.lt-report-risk { font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 30%, transparent); border-radius: 8px; padding: 6px 10px; }

.lt-detail-actions { display: flex; flex-direction: column; gap: 8px; }
.lt-move-buttons { display: flex; gap: 6px; flex-wrap: wrap; }
.lt-move { font: inherit; font-size: 12px; padding: 4px 11px; border-radius: 999px; cursor: pointer; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
.lt-move:hover { border-color: var(--dsw-alias-border-l3); color: inherit; }
.lt-move[data-to="done"] { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent); color: var(--dsw-alias-state-success-primary); }
.lt-move[data-to="blocked"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }

.lt-section { font-size: 12px; display: flex; flex-direction: column; gap: 7px; }
.lt-section h4 { margin: 0; font-size: 11px; color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: .05em; display: flex; align-items: center; gap: 6px; }
.lt-counter { font-size: 11px; font-weight: 600; padding: 0 6px; border-radius: 999px; line-height: 16px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
.lt-timeline { display: flex; flex-direction: column; gap: 8px; }
.lt-timeline-row { display: flex; flex-direction: column; }
.lt-bubble { display: flex; gap: 8px; }
.lt-bubble-avatar { flex: none; width: 26px; height: 26px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 12px; background: var(--dsw-alias-bg-layer-1); }
.lt-bubble[data-from="agent"] .lt-bubble-avatar { background: color-mix(in srgb, var(--lt-accent-normal) 15%, transparent); }
.lt-bubble-main { flex: 1; min-width: 0; border-radius: 12px; padding: 6px 10px; background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l2); }
.lt-bubble[data-from="agent"] .lt-bubble-main { border-color: color-mix(in srgb, var(--lt-accent-normal) 30%, transparent); background: color-mix(in srgb, var(--lt-accent-normal) 7%, transparent); }
.lt-bubble-meta { display: flex; align-items: baseline; gap: 8px; margin-bottom: 3px; }
.lt-bubble-meta b { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.lt-bubble[data-from="agent"] .lt-bubble-meta b { color: var(--lt-accent-review); }
.lt-bubble-meta span { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.lt-bubble-body { font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.lt-exec { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; padding: 5px 9px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); border: 0.5px solid var(--dsw-alias-border-l2); }
.lt-exec-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.lt-exec-dot[data-outcome="succeeded"] { background: var(--dsw-alias-state-success-primary); }
.lt-exec-dot[data-outcome="failed"] { background: var(--dsw-alias-state-error-primary); }
.lt-exec-dot[data-outcome="running"] { background: var(--dsw-alias-state-warn-primary); animation: lt-pulse 1.6s ease-in-out infinite; }
@keyframes lt-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
.lt-exec-trigger { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.lt-exec-outcome { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 6px; }
.lt-exec-outcome[data-outcome="succeeded"] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 15%, transparent); color: var(--dsw-alias-state-success-primary); }
.lt-exec-outcome[data-outcome="failed"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); color: var(--dsw-alias-state-error-primary); }
.lt-exec-outcome[data-outcome="running"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 15%, transparent); color: var(--dsw-alias-state-warn-primary); }
.lt-exec-outcome[data-outcome="cancelled"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.lt-exec-time { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.lt-exec-session { font: inherit; font-size: 11px; line-height: 12px; color: var(--dsw-alias-label-secondary); background: none; border: none; padding: 0; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.lt-exec-session:hover { color: var(--dsw-alias-brand-primary); text-decoration: underline dotted; }
.lt-exec-session svg:last-child { transform: translateY(-2.5px); }
.lt-exec-error { flex-basis: 100%; font-size: 11px; color: var(--dsw-alias-state-error-primary); word-break: break-all; }

.lt-comment-box { display: flex; gap: 7px; align-items: flex-end; margin-top: 2px; }
.lt-comment-input { flex: 1; font: inherit; font-size: 12px; line-height: 1.5; padding: 7px 10px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); resize: vertical; min-height: 38px; }
.lt-comment-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.lt-send { flex: none; font: inherit; font-size: 12px; padding: 7px 14px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.lt-send:disabled { opacity: .4; cursor: default; }

.lt-danger-zone { display: flex; align-items: center; gap: 8px; margin-top: auto; padding-top: 8px; border-top: 1px dashed var(--dsw-alias-border-l2); }


`
