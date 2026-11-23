/** dialogs 区段的样式（由 design/index.ts 按顺序拼接）。 */
export const DIALOGS_CSS = String.raw`
/* ── 交互卡 ───────────────────────────────────────────────────────── */
.lt-interaction-list { display: flex; flex-direction: column; gap: 12px; }
.lt-conversation-interaction { display: flex; justify-content: center; padding: 6px calc(var(--dsh-composer-side-clearance, 0px) + 16px) 10px; }
.lt-conversation-interaction .lt-ix-card { max-width: var(--dsh-chat-content-width, 760px); }
/* 提问卡：逐条对齐 dsh QuestionComposer（ui-user-questions/QuestionComposer.module.css）。 */
.lt-ix-card { display: flex; flex-direction: column; width: 100%; max-width: none; max-height: min(60vh, 520px); padding: 0 0 10px; border: 0; --dsw-elevation-stroke-color: var(--dsw-alias-border-l2-darkmode-thin); border-radius: var(--dsw-radius-xl); background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2)); box-shadow: var(--dsw-elevation-panel); color: var(--dsw-alias-label-primary); overflow: hidden; --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }
.lt-ix-card, .lt-ix-card * { box-sizing: border-box; }
.lt-ix-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-shrink: 0; padding: 20px 16px 0 24px; }
.lt-ix-headingBlock { min-width: 0; }
.lt-ix-eyebrow { margin-bottom: 5px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.lt-ix-title { margin: 0; font-size: 16px; line-height: 22px; font-weight: 500; overflow-wrap: anywhere; }
.lt-ix-headerActions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.lt-ix-icon { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: none; border-radius: 999px; corner-shape: round; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.lt-ix-icon:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.lt-ix-icon:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.lt-ix-detail { margin: 0 2px 8px; }
.lt-ix-body { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.lt-ix-options { display: flex; flex-direction: column; gap: 1px; margin: 8px 0 0; padding: 4px 12px; }
.lt-ix-option { display: flex; align-items: flex-start; gap: 8px; width: 100%; min-height: 40px; flex-shrink: 0; padding: 8px 12px 8px 8px; border: 1px solid transparent; border-radius: var(--dsw-radius-md); background: transparent; color: inherit; text-align: left; cursor: pointer; font: inherit; transition: background-color 120ms ease, border-color 120ms ease; }
.lt-ix-option:hover:not(:disabled), .lt-ix-optionSelected { background: var(--dsw-alias-interactive-bg-hover); }
.lt-ix-optionSelected { border-color: var(--dsw-alias-border-l2); }
.lt-ix-option:disabled { cursor: default; }
.lt-ix-number { display: grid; place-items: center; flex: 0 0 20px; width: 20px; height: 20px; margin-top: 2px; border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 18px; }
.lt-ix-checkbox { display: grid; place-items: center; flex: 0 0 20px; width: 20px; height: 20px; margin-top: 2px; }
.lt-ix-checkbox::before { content: ''; grid-area: 1 / 1; width: 14px; height: 14px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-xs); transition: background-color 120ms ease, border-color 120ms ease; }
.lt-ix-checkbox > svg { grid-area: 1 / 1; }
.lt-ix-checkboxChecked { color: var(--dsw-alias-label-primary-foreground); }
.lt-ix-checkboxChecked::before { border-color: var(--dsw-alias-label-primary); background: var(--dsw-alias-label-primary); }
.lt-ix-optionCopy { min-width: 0; flex: 1; }
.lt-ix-optionLine { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 6px; }
.lt-ix-optionLabel { font-size: 14px; line-height: 24px; font-weight: 500; overflow-wrap: anywhere; }
.lt-ix-description { color: var(--dsw-alias-label-tertiary); font-size: 14px; line-height: 24px; font-weight: 400; }
.lt-ix-customrow { display: flex; align-items: flex-start; gap: 8px; width: 100%; min-height: 40px; flex-shrink: 0; padding: 8px 12px 8px 8px; border: 1px solid transparent; border-radius: var(--dsw-radius-md); transition: background-color 120ms ease, border-color 120ms ease; }
.lt-ix-customrow:hover, .lt-ix-customrow:focus-within:not(.lt-ix-customrow-yielded), .lt-ix-customrow-active { background: var(--dsw-alias-interactive-bg-hover); }
.lt-ix-customrow:focus-within:not(.lt-ix-customrow-yielded), .lt-ix-customrow-active { border-color: var(--dsw-alias-border-l2); }
.lt-ix-field { display: grid; min-width: 0; }
.lt-ix-field > * { grid-area: 1 / 1; min-width: 0; padding: 0; font: inherit; font-size: 14px; line-height: 24px; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
.lt-ix-fieldMirror { box-sizing: content-box; max-height: 144px; overflow: hidden; visibility: hidden; }
.lt-ix-fieldInput { resize: none; overflow-y: auto; border: none; outline: none; background: transparent; color: var(--dsw-alias-label-primary); caret-color: var(--dsw-alias-state-business-primary); }
.lt-ix-fieldInput::placeholder { color: var(--dsw-alias-label-caption); }
.lt-ix-fieldInline { flex: 1; }
.lt-ix-fieldBlock { min-height: 64px; flex-shrink: 0; margin: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform); }
.lt-ix-fieldBlock > * { padding: 8px 12px; }
.lt-ix-fieldBlock:focus-within { border-color: var(--dsw-alias-state-business-primary); }
.lt-ix-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-shrink: 0; margin-top: 12px; padding: 0 10px 0 18px; }
.lt-ix-pager { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.lt-ix-progress { padding: 0 4px; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 24px; font-weight: 500; white-space: nowrap; word-spacing: -2px; }
.lt-ix-feedback { flex: 1; min-height: 16px; color: var(--dsw-alias-state-error-primary); font-size: 11px; line-height: 16px; text-align: right; }
/* 审批卡的反馈在 apprbody 的可滚动列里，不参与 footer 的弹性分配。 */
.lt-ix-apprbody > .lt-ix-feedback { flex: none; min-height: 0; margin: 6px 0 12px; }
.lt-ix-footerActions { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
/* dsh 的 Button 是 36px；.lt-btn 的 height:auto 会把交互按钮压到 32px 的 min-height。 */
.lt-ix-footerActions .lt-btn, .lt-ix-appractions .lt-btn { height: 36px; }
@media (max-width: 720px) { .lt-ix-card { border-radius: var(--dsw-radius-xl); } .lt-ix-header { padding: 10px 12px 0 18px; } .lt-ix-options { padding: 4px 8px; } .lt-ix-title { font-size: 15px; line-height: 21px; } .lt-ix-option, .lt-ix-customrow { padding: 8px 6px; } .lt-ix-footer { align-items: flex-end; padding: 0 10px; } .lt-ix-footerActions { flex-shrink: 0; } }
@media (prefers-reduced-motion: reduce) { .lt-ix-option, .lt-ix-customrow { transition: none; } }
.lt-ix-appr { display: flex; flex-direction: column; width: 100%; max-width: var(--dsh-chat-content-width, 760px); border: 1px solid var(--dsw-alias-state-warn-secondary); border-radius: var(--dsw-radius-xl, 20px); background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2)); box-shadow: var(--dsw-elevation-panel); color: var(--dsw-alias-label-primary); overflow: hidden; }
.lt-ix-strip { display: flex; align-items: center; gap: 8px; padding: 10px 16px; background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-primary); font-size: 13px; line-height: 18px; }
.lt-ix-apprbody { display: flex; flex-direction: column; gap: 6px; box-sizing: border-box; max-height: var(--dsh-composer-text-max-height, 336px); overflow-y: auto; padding: 12px 16px 0; }
.lt-ix-headline { margin: 0; color: var(--dsw-alias-label-primary); font-size: 15px; line-height: 24px; font-weight: 500; }
.lt-ix-command { margin: 0; color: var(--dsw-alias-label-tertiary); font-family: var(--ds-font-family-code, monospace); font-size: 13px; line-height: 20px; word-break: break-all; white-space: pre-wrap; }
.lt-ix-appractions { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 16px; }
.lt-inbox-row .lt-ix-card, .lt-inbox-row .lt-ix-appr { border-radius: 14px; box-shadow: none; }
.lt-inbox-row .lt-ix-card { max-height: min(38vh, 340px); }
.lt-inbox-row .lt-ix-apprbody { max-height: min(32vh, 280px); }
.lt-interaction { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 14px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.lt-interaction[data-kind="approval"] { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent); }
.lt-interaction-head { display: flex; align-items: center; gap: 8px; }
.lt-interaction-kind { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 999px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
.lt-interaction-kind[data-kind="approval"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent); color: var(--dsw-alias-state-warn-primary); }
.lt-interaction-wait { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.lt-interaction-session { display: inline-flex; align-items: center; gap: 4px; margin-left: 4px; padding: 1px 7px; border: 0; border-radius: 999px; cursor: pointer; font: inherit; font-size: 11px; line-height: 16px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
.lt-interaction-session:hover { color: var(--dsw-alias-brand-primary); text-decoration: underline dotted; }
.lt-interaction-body[data-format="question"] { font-family: inherit; background: var(--dsw-alias-bg-layer-1); }
.lt-interaction-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.lt-interaction-body { margin: 0; padding: 8px 10px; max-height: 200px; overflow: auto; border-radius: 8px; background: var(--dsw-alias-bg-layer-1); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
.lt-interaction-answer { display: flex; flex-direction: column; gap: 8px; }
.lt-interaction-options { display: flex; flex-wrap: wrap; gap: 6px; }
.lt-option { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; }
.lt-option:hover { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover); }
.lt-interaction-actions { justify-content: flex-end; }
.lt-inbox { display: flex; flex-direction: column; gap: 16px; max-height: min(64vh, 720px); overflow-y: auto; padding-right: 2px; }
.lt-inbox-row { display: flex; flex-direction: column; gap: 8px; padding: 12px 12px 10px; border-radius: 16px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.lt-inbox-head { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.lt-inbox-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; font-size: 15px; line-height: 22px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.lt-inbox-meta { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.lt-inbox-kind { flex: none; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 16px; background: var(--lt-surface-3); color: var(--dsw-alias-label-secondary); }
.lt-inbox-kind[data-kind="approval"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent); color: var(--dsw-alias-state-warn-primary); }

/* ── 生成设置 ─────────────────────────────────────────────────────── */
.lt-settings-body { display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: 0; align-items: start; }
.lt-settings-nav { display: flex; flex-direction: column; gap: 4px; padding-right: 12px; border-right: 0.5px solid var(--dsw-alias-border-l1); }
.lt-settings-tab { display: flex; align-items: center; height: 36px; padding: 0 12px; border: 0; border-radius: 10px; background: transparent; cursor: pointer; text-align: left; font: inherit; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.lt-settings-tab:hover { background: var(--dsw-alias-interactive-bg-hover); }
.lt-settings-tab[data-on="true"] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-weight: 500; }
.lt-settings-pane { min-width: 0; padding-left: 18px; padding-right: 2px; }
@media (max-width: 760px) {
  .lt-settings-body { grid-template-columns: 1fr; }
  .lt-settings-nav { flex-direction: row; padding: 0 0 8px; border-right: none; }
  .lt-settings-pane { padding-left: 0; }
}
.lt-settings-section h4 { margin: 0 0 8px; font-size: 12px; }
.lt-settings-section { display: block; }
.lt-settings-section[hidden] { display: none; }
.lt-settings-section .lt-note { margin-top: 8px; }
.lt-settings-rows { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.lt-settings-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.lt-settings-row .lt-select { flex: 0 0 200px; max-width: 200px; }
.lt-settings-row .lt-settings-desc { flex: 1 1 auto; width: auto; min-width: 0; }
.lt-settings-row-text { align-items: flex-start; }
.lt-settings-row .lt-settings-title { flex: 0 0 180px; width: 180px; }
.lt-settings-row .lt-settings-text { flex: 1 1 auto; width: auto; min-width: 0; }
.lt-settings-row .lt-settings-kind { flex: 0 0 150px; max-width: 150px; }
.lt-add-row { display: block; margin-top: 10px; }
.lt-conc-row { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
.lt-conc { flex: none; width: 72px; padding: 0 8px; text-align: center; font: inherit; font-size: 14px; height: 32px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.lt-conc[data-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.lt-conc-hint { flex: 1; min-width: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.lt-toggle { display: flex; align-items: center; gap: 8px; margin-top: 4px; cursor: pointer; font-size: 13px; }
.lt-toggle input { margin: 0; cursor: pointer; accent-color: var(--dsw-alias-brand-primary); }
.lt-inline-field { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.lt-inline-field .lt-input { flex: 0 0 160px; width: 160px; }
.lt-diag-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.lt-diag-item { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 10px 6px; border-radius: 12px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.lt-diag-item b { font-size: 16px; font-weight: 700; }
.lt-diag-item span { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.lt-diag-item[data-bad="true"] b { color: var(--dsw-alias-state-error-primary); }

/* ── 分发 / 已派发 ─────────────────────────────────────────────────── */
.lt-dispatch { display: flex; flex-direction: column; gap: 12px; }
.lt-dispatch-targets { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.lt-dispatch-targets .lt-select { width: 100%; max-width: none; }
@media (max-width: 560px) { .lt-dispatch-targets { grid-template-columns: 1fr; } }
.lt-dispatched { display: flex; flex-direction: column; gap: 6px; max-height: 60vh; overflow-y: auto; }
.lt-dispatched-row { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l2); }
.lt-dispatched-row[data-open="true"] { background: var(--dsw-alias-bg-layer-2); }
.lt-dispatched-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lt-dispatched-title { flex: 1 1 auto; min-width: 0; font-size: 13px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── 导入 ─────────────────────────────────────────────────────────── */
.lt-import { display: flex; flex-direction: column; gap: 12px; }
.lt-import-picker { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.lt-sheet-body .lt-import-picker input[type="file"] { flex: 0 1 auto; width: auto; max-width: 260px; padding: 4px 8px; font-size: 12px; }
.lt-import-filename { font-size: 12px; color: var(--dsw-alias-state-business-primary); word-break: break-all; }
.lt-import-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px; }
.lt-import-stat { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 9px 6px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l2); }
.lt-import-stat b { font-size: 16px; font-weight: 700; }
.lt-import-stat span { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.lt-import-stat[data-tone="ok"] b { color: var(--dsw-alias-state-success-primary); }
.lt-import-stat[data-tone="warn"] b { color: var(--dsw-alias-state-warn-primary); }
.lt-import-stat[data-tone="bad"] b { color: var(--dsw-alias-state-error-primary); }
.lt-import-section { margin-bottom: 10px; }
.lt-import-section h4 { margin: 0 0 6px; font-size: 12px; }
.lt-import-list { display: flex; flex-direction: column; gap: 4px; max-height: 160px; overflow-y: auto; }
.lt-import-row { display: flex; align-items: center; gap: 10px; justify-content: space-between; padding: 5px 9px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l2); }
.lt-import-row[data-tone="bad"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent); }
.lt-import-title { font-size: 12px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lt-import-status { font-size: 11px; color: var(--dsw-alias-label-tertiary); flex-shrink: 0; }
.lt-import-result { font-size: 12px; color: var(--dsw-alias-state-success-primary); margin-top: 10px; }

/* ── 模板库 ───────────────────────────────────────────────────────── */
.lt-template-list { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.lt-template-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.lt-template-row .lt-input { flex: 0 0 150px; width: 150px; min-width: 0; }
.lt-template-meta { flex: 1; min-width: 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lt-template-buttons { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.lt-template-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); }

/* ── 告警 / 侧栏入口 ──────────────────────────────────────────────── */
.lt-alert { display: flex; align-items: flex-start; gap: 10px; margin: 0; font-size: 14px; line-height: 1.55; word-break: break-word; white-space: pre-wrap; color: var(--dsw-alias-label-primary); }
.lt-alert-glyph { flex: none; margin-top: 2px; color: var(--dsw-alias-state-warn-primary); }
.lt-glyph { display: inline-flex; align-items: center; gap: 4px; }
.lt-orb { flex: none; }
.lt-orb[data-status="issue"] { color: var(--dsw-alias-label-secondary); }
.lt-orb[data-status="todo"] { color: var(--lt-accent-todo); }
.lt-orb[data-status="in_progress"] { color: var(--dsw-alias-state-warn-primary); }
.lt-orb[data-status="in_review"] { color: var(--dsw-alias-state-business-primary); }
.lt-orb[data-status="done"] { color: var(--dsw-alias-state-success-primary); }
.lt-orb[data-status="canceled"], .lt-orb[data-status="archived"] { color: var(--dsw-alias-label-dimmed); }
.lt-orb[data-status="trashed"] { color: var(--dsw-alias-state-error-primary); }

/* 侧栏入口 glyph（shell 自带行高与颜色，插件只画图形）。 */
.lt-entry { position: relative; display: inline-flex; align-items: center; justify-content: center; }
.lt-entry > svg { flex: none; display: block; }
.lt-entry-badge { position: absolute; top: -4px; right: 0; min-width: 13px; height: 13px; padding: 0 2px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; font-size: 8px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary-foreground); background: var(--dsw-alias-state-error-primary); pointer-events: none; }
.lt-entry-badge[data-tone="review"] { background: var(--dsw-alias-state-business-primary); }
.lt-entry-stats { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; font-size: 12px; line-height: 1; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; cursor: help; }
.lt-entry-stat-sep { opacity: .5; }
.lt-entry-stat[data-stat="issue"] { color: var(--dsw-alias-label-secondary); }
.lt-entry-stat[data-stat="todo"] { color: var(--dsw-alias-state-success-primary); }
.lt-entry-stat[data-stat="in_progress"] { color: var(--dsw-alias-state-warn-primary); }
.lt-entry-stat[data-stat="in_review"] { color: var(--dsw-alias-state-business-primary); }
.lt-entry-ix { flex: none; margin-left: 8px; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 16px; font-weight: 600; background: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-label-primary-foreground); cursor: pointer; white-space: nowrap; }
.lt-entry-ix:hover { filter: brightness(1.06); }
.lt-diag-item b.lt-diag-text { font-size: 11px; font-weight: 600; line-height: 1.2; word-break: break-all; text-align: center; }

/* 焦点可见性 */
.lt-tile:focus-visible, .lt-filter:focus-visible, .lt-chip:focus-visible, .lt-quickbtn:focus-visible, .lt-mode:focus-visible, .lt-cron:focus-visible, .lt-menu-item:focus-visible, .lt-select:focus-visible, .lt-dashed:focus-visible, .lt-close:focus-visible, .lt-sheet-buttons button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}

/* 服务连接错误：比默认 380px 的 Modal 略宽，内容仍走 Modal 的 24px 左右 padding */
.dsh-cb-service-error.dsh-cb-service-error { width: min(520px, calc(100vw - 32px)); }

`
