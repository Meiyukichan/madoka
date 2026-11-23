/** forms 区段的样式（由 design/index.ts 按顺序拼接）。 */
export const FORMS_CSS = String.raw`
/* ── 通用按钮 / 对话框 ────────────────────────────────────────────── */
.lt-btn { height: auto; min-height: 32px; }
.lt-btn-danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.lt-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }

.lt-sheet { width: min(560px, calc(100vw - 48px)); max-height: min(860px, calc(100vh - 48px)); }
.lt-sheet-sm { width: min(480px, calc(100vw - 48px)); }
.lt-sheet-lg { width: min(960px, calc(100vw - 40px)); }
.lt-sheet-wide { width: 800px; max-width: calc(100vw - 48px); height: min(800px, calc(100vh - 48px)); border-radius: 32px; }
.lt-sheet-confirm { width: min(480px, calc(100vw - 48px)); }
.lt-sheet-content { min-height: 0; overflow: hidden; }
/* Modal renders content as header + description + body; make the body the only
   scroll region so the footer always stays inside the capped card. */
.lt-sheet .lt-sheet-content { flex: 1 1 auto; min-height: 0; }
.lt-sheet .lt-sheet-content > div:last-child { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
.lt-sheet .lt-sheet-body { flex: 1 1 auto; min-height: 0; max-height: none; overflow-y: auto; }
.lt-sheet-content > div:last-child { margin-top: 8px; }
.lt-sheet-content:has(> p) > div:last-child { margin-top: 16px; }
.lt-sheet-body { padding: 0; min-height: 0; overflow-y: auto; max-height: min(62vh, 680px); display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.lt-sheet-wide .lt-sheet-content { flex: 1 1 auto; min-height: 0; }
.lt-sheet-wide .lt-sheet-body { flex: 1 1 auto; min-height: 0; max-height: none; overflow-y: auto; }
.lt-sheet-foot { display: flex; align-items: center; gap: 10px; width: 100%; padding: 11px 0 0; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.lt-sheet-hint { flex: 1; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.lt-sheet-hint[data-tone="bad"] { color: var(--dsw-alias-state-error-primary); }
.lt-sheet-buttons { display: flex; gap: 8px; margin-left: auto; }
.lt-sheet-buttons .lt-btn { height: 32px; border-radius: 16px; }

.lt-input { display: flex; box-sizing: border-box; width: 100%; min-width: 0; padding: 0 10px; height: 32px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.lt-input > input { border: none; background: transparent; height: auto; padding: 0; min-width: 0; width: 100%; font: inherit; font-size: 14px; color: var(--dsw-alias-label-primary); }
.lt-input:focus-within { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.lt-input-bad { border-color: var(--dsw-alias-state-error-primary); }
.lt-native { font: inherit; font-size: 14px; line-height: 22px; height: 32px; padding: 0 10px; border-radius: 8px; width: 100%; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); color-scheme: light dark; }
.lt-native:focus { outline: none; border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.lt-native[data-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.lt-textarea { font: inherit; font-size: 14px; line-height: 22px; padding: 8px 10px; border-radius: 8px; width: 100%; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); color-scheme: light dark; min-height: 64px; resize: vertical; }
.lt-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.lt-sheet-body input::placeholder, .lt-sheet-body textarea::placeholder, .lt-input input::placeholder, .lt-textarea::placeholder { color: var(--dsw-alias-label-dimmed); }

.lt-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.lt-field[data-full="true"] { grid-column: 1 / -1; }
.lt-field-label { display: flex; align-items: center; gap: 3px; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.lt-req { color: var(--dsw-alias-state-error-primary); font-style: normal; }
.lt-form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.lt-row { display: flex; align-items: center; gap: 8px; }

.lt-select { position: relative; display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box; height: 32px; padding: 0 26px 0 10px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 8px; font: inherit; font-size: 14px; line-height: 22px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; appearance: none; text-align: left; max-width: 260px; width: 100%; }
.lt-select:disabled { opacity: .5; cursor: default; }
.lt-select-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.lt-select-icon { flex: none; display: inline-flex; }
.lt-select-icon svg { width: 14px; height: 14px; }
.lt-select-chevron { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); display: inline-flex; color: var(--dsw-alias-label-tertiary); pointer-events: none; }
.lt-pop { position: fixed; z-index: 9999; padding: 4px; box-sizing: border-box; max-width: min(420px, calc(100vw - 16px)); max-height: min(360px, calc(100vh - 32px)); overflow-y: auto; background: var(--dsw-alias-bg-layer-2); border: 0; border-radius: 20px; --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent); color: var(--dsw-alias-label-primary); font-size: 14px; }
.lt-pop-item { box-sizing: border-box; display: flex; align-items: center; gap: 8px; min-width: 100%; min-height: 38px; padding: 6px 8px; border-radius: 10px; cursor: pointer; color: inherit; }
.lt-pop-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.lt-pop-item:active { background: var(--dsw-alias-interactive-bg-active); }
.lt-pop-icon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; color: var(--dsw-alias-label-tertiary); }
.lt-pop-label { flex: 1; min-width: 0; font-size: 14px; line-height: 20px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lt-pop-check { flex: 0 0 18px; display: inline-flex; justify-content: center; color: var(--dsw-alias-label-primary); }
.lt-pop-item:not([data-selected="true"]) .lt-pop-check { display: none; }
.lt-pop-group { position: sticky; top: 0; z-index: 1; padding: 5px 8px 3px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; font-weight: 500; }
.lt-pop-empty { padding: 8px; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }

.lt-md { word-break: break-word; }

/* ── 表单 ─────────────────────────────────────────────────────────── */
.lt-composer-grid { max-height: min(72vh, calc(100vh - 240px)); overflow-y: auto; scrollbar-gutter: stable; display: grid; grid-template-columns: 1.12fr 0.88fr; gap: 18px; }
.lt-composer-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; height: 100%; }
.lt-composer-left { padding-right: 0; align-self: stretch; }
/* The detail card owns the leftover height, so the attachment card sits at the
   bottom of the column instead of leaving a gap under it. */
.lt-detail-card { flex: 1 1 0; min-height: 0; }
.lt-detail-card > .lt-field { flex: 1 1 auto; min-height: 0; }
.lt-detail-card .lt-slash { flex: 1 1 auto; min-height: 0; }
.lt-detail-card .lt-slash-input { flex: 1 1 auto; height: 100%; min-height: 120px; resize: none; }
.lt-attachment-card { flex: 0 0 auto; margin-top: auto; }
.lt-composer-right > .lt-form-card:last-child { margin-top: auto; }
.lt-issue-form { display: flex; flex-direction: column; gap: 12px; max-height: min(62vh, calc(100vh - 240px)); overflow-y: auto; }
@media (max-width: 768px) {
  .lt-sheet-lg { width: calc(100vw - 20px); }
  .lt-composer-grid { grid-template-columns: 1fr; gap: 14px; }
  .lt-composer-left { padding-right: 0; }
}

.lt-mode-picker { display: grid; gap: 8px; grid-template-columns: 1fr 1fr; }
.lt-mode { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 8px 10px; border-radius: 8px; cursor: pointer; text-align: left; border: 0.5px solid var(--dsw-alias-border-l4); background: transparent; color: inherit; font: inherit; }
.lt-mode:hover { background: var(--dsw-alias-interactive-bg-hover); }
.lt-mode-name { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; }
.lt-mode-hint { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.lt-mode[data-on="true"] { border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent); }

.lt-form-card { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); }
.lt-form-card-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.lt-form-card-hint { margin-left: 6px; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.lt-exec-card { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, var(--dsw-alias-bg-layer-2)); }
.lt-exec-summary { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.lt-exec-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-secondary); }
.lt-exec-dot[data-urgency="direct"] { background: var(--dsw-alias-state-success-primary); }
.lt-exec-dot[data-urgency="urgent"] { background: var(--dsw-alias-state-warn-primary); }
.lt-exec-dot[data-urgency="relaxed"] { background: var(--dsw-alias-state-success-primary); opacity: 0.6; }
.lt-exec-hint { flex: 1; min-width: 0; }
.lt-exec-pill { padding: 1px 7px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 11px; }
.lt-schedule-row { display: flex; align-items: center; gap: 8px; padding-top: 10px; border-top: 0.5px solid var(--dsw-alias-border-l2); font-size: 12px; color: var(--dsw-alias-label-primary); }
.lt-schedule-switch { flex: none; }
.lt-schedule-label { color: var(--dsw-alias-label-primary); }
.lt-attachments .lt-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }

.lt-cron-presets { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.lt-cron { font: inherit; font-size: 12px; height: 24px; padding: 0 10px; border-radius: 999px; display: inline-flex; align-items: center; cursor: pointer; border: 0.5px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); }
.lt-cron:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
.lt-cron[data-on="true"] { border-color: transparent; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground); }
.lt-cron-next { margin-left: auto; min-width: 132px; text-align: right; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-tertiary); }

.lt-checklist-editor { display: flex; flex-direction: column; gap: 8px; }
.lt-checklist-row { display: flex; align-items: center; gap: 8px; }
.lt-check { flex-shrink: 0; width: 15px; height: 15px; cursor: pointer; accent-color: var(--dsw-alias-button-primary-fill); }
.lt-icon-remove { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: none; background: none; cursor: pointer; color: var(--dsw-alias-label-tertiary); border-radius: 8px; }
.lt-icon-remove:hover { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.lt-dashed { align-self: flex-start; height: 32px; box-sizing: border-box; display: inline-flex; align-items: center; border: 0.5px dashed var(--dsw-alias-border-l3); background: none; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; font-size: 13px; padding: 0 12px; border-radius: 8px; }
.lt-dashed:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l4); }
.lt-dashed[disabled] { opacity: .45; cursor: not-allowed; }

.lt-discussion { display: flex; flex-direction: column; gap: 8px; max-height: 260px; overflow-y: auto; padding: 2px; }
.lt-discussion-row { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.lt-discussion-head { display: flex; align-items: center; gap: 6px; }
.lt-discussion-at { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.lt-discussion-body { font-size: 13px; color: var(--dsw-alias-label-primary); white-space: pre-wrap; word-break: break-word; }
.lt-attachments { display: flex; flex-direction: column; gap: 7px; }
.lt-attach-row { display: flex; align-items: center; gap: 9px; padding: 7px 8px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.lt-attach-icon { flex: 0 0 auto; width: 25px; height: 25px; display: grid; place-items: center; border-radius: 6px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent); color: var(--dsw-alias-brand-primary); font-family: inherit; font-size: 9px; font-weight: 700; letter-spacing: 0.02em; }
.lt-attach-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.lt-attach-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: inherit; font-size: 13px; font-weight: 500; line-height: 1.35; color: var(--dsw-alias-label-primary); }
.lt-attach-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.35; color: var(--dsw-alias-label-tertiary); }
.lt-attach-remove { flex: 0 0 auto; width: 24px; height: 24px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.lt-attach-remove:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.lt-attach-add { flex: 0 0 auto; height: 32px; padding: 0 12px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }
.lt-attach-add:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.lt-attach-add:disabled { opacity: 0.45; cursor: default; }

.lt-slash { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.lt-slash-tip { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.lt-slash-tip code { font-family: var(--dsw-font-mono, monospace); }
.lt-slash-pop { position: fixed; z-index: 1200; padding: 4px; box-sizing: border-box; overflow: hidden; border-radius: 14px; background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); border: 0.5px solid var(--dsw-alias-border-l2); }
.lt-slash-list { max-height: inherit; overflow-y: auto; }
.lt-slash-group { padding: 5px 8px 3px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.lt-slash-item { display: flex; align-items: baseline; gap: 8px; padding: 7px 8px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.lt-slash-item[data-active="true"] { background: var(--dsw-alias-interactive-bg-hover); }
.lt-slash-name { flex: none; font-weight: 500; color: var(--dsw-alias-label-primary); }
.lt-slash-param { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.lt-slash-desc { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }

.lt-accept { display: flex; flex-direction: column; gap: 8px; }
.lt-accept-row { display: flex; align-items: center; gap: 8px; }
.lt-accept-row .lt-select { flex: 1; max-width: none; }
.lt-accept-inline { flex: 1; display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 8px; font-size: 13px; }
.lt-accept-new { display: flex; flex-direction: column; gap: 8px; padding: 8px; border: 0.5px dashed var(--dsw-alias-border-l3); border-radius: 10px; }
.lt-accept-actions { display: flex; gap: 8px; flex-wrap: wrap; }

`
