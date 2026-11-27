/**
 * 组件库样式：**一个 CSS 字符串**（不是 CSS Modules），由宿主插件在 `apply` 里注入。
 *
 * 为什么是字符串：
 * - teamwork 是非插件包，不假设宿主的打包器支持 `?inline` / CSS Modules；
 * - 宿主（castboard）把 `UI_CSS` 塞进自己的 `<style data-plugin>`，卸载即回收；
 * - 类名统一 `dsh-atw-*`，颜色只用 `--dsw-alias-*` 等白名单 token（`scripts/lint-tokens.mjs` 校验）。
 *
 * @module dsh-magica-teamwork/client/styles
 */

/** token 白名单（只允许这些前缀，其余一律视为硬编码风险）。 */
export const TOKEN_WHITELIST = [
  '--dsw-alias-',
  '--dsw-elevation-',
  '--dsw-specific-',
  '--dsw-menu-',
  '--dsw-radius-',
  '--dsw-focus-',
] as const

/** 组件库样式。 */
export const UI_CSS = `
.dsh-atw-root {
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
}
.dsh-atw-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-atw-toolbar-spacer { flex: 1; }
.dsh-atw-page {
  position: relative;
  padding: 12px 16px;
  gap: 10px;
  box-sizing: border-box;
}
.dsh-atw-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: nowrap;
}
.dsh-atw-title-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  margin: 0 10px 0 0;
  white-space: nowrap;
}
.dsh-atw-page-title {
  margin: 0;
  font-size: 18px;
  line-height: 24px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
}
.dsh-atw-board {
  display: flex;
  gap: 12px;
  padding: 12px 10px;
  overflow-x: auto;
  min-height: 0;
  flex: 1;
}
.dsh-atw-column {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 268px;
  min-width: 268px;
  background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  padding: 10px;
  min-height: 120px;
}
.dsh-atw-column[data-drop='1'] { border-color: var(--dsw-alias-brand-primary); }
.dsh-atw-column-head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-secondary);
  font-weight: 600;
}
.dsh-atw-count {
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dsh-atw-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  border: 0.5px solid var(--dsw-alias-border-l2);
  cursor: pointer;
}
.dsh-atw-card:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-atw-card[data-running='1'] { border-color: var(--dsw-alias-state-success-primary); }
.dsh-atw-card-title { font-weight: 600; line-height: 1.35; }
.dsh-atw-card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.dsh-atw-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}
.dsh-atw-badge[data-tone='urgent'] { color: var(--dsw-alias-state-error-primary); }
.dsh-atw-badge[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary); }
.dsh-atw-badge[data-tone='ok'] { color: var(--dsw-alias-state-success-primary); }
.dsh-atw-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.dsh-atw-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-atw-button[data-variant='primary'] {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-bg-base);
  border-color: transparent;
}
.dsh-atw-button:disabled { opacity: 0.5; cursor: not-allowed; }
.dsh-atw-input {
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
}
.dsh-atw-empty {
  padding: 24px 12px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-atw-spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--dsw-alias-border-l3);
  border-top-color: var(--dsw-alias-brand-primary);
  animation: dsh-atw-spin 0.8s linear infinite;
}
@keyframes dsh-atw-spin { to { transform: rotate(360deg); } }
.dsh-atw-modal-mask {
  position: fixed;
  inset: 0;
  background: var(--dsw-alias-bg-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
}
.dsh-atw-modal {
  width: min(740px, 69%);
  max-height: 82vh;
  overflow: auto;
  background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  box-shadow: var(--dsw-elevation-prominent);
  padding: 16px;
}
.dsh-atw-detail-section {
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  padding: 10px 0;
}
.dsh-atw-detail-section > h4 {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-atw-detail-body { min-width: 0; flex: 1; }
.dsh-atw-two-col { display: flex; gap: 16px; }
.dsh-atw-person {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.dsh-atw-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
}
.dsh-atw-tabs { display: flex; gap: 4px; }
.dsh-atw-tabsbar {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  width: max-content;
  max-width: 100%;
  padding: 4px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-module-platform);
}
.dsh-atw-tabsbar button {
  height: 30px;
  padding: 0 16px;
  border-radius: var(--dsw-radius-md);
  font-size: 13px;
  line-height: 20px;
  background: transparent;
  box-shadow: none;
}
.dsh-atw-tabsbar button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-atw-tabsbar button[aria-selected='true'] {
  background: var(--dsw-alias-bg-layer-3);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3);
}
.dsh-atw-filterrow { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; }
.dsh-atw-issue-list {
  display: flex;
  flex-direction: column;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-atw-issue-row {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
  padding: 13px 4px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  cursor: pointer;
  transition: background-color .12s ease;
}
.dsh-atw-issue-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-atw-issue-row:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset: -2px;
}
.dsh-atw-issue-main {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1;
  min-width: 0;
}
.dsh-atw-issue-title {
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-atw-issue-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 16px;
  white-space: nowrap;
}
.dsh-atw-issue-meta span { overflow: hidden; text-overflow: ellipsis; }
.dsh-atw-issue-chips {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.dsh-atw-issue-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}
.dsh-atw-issue-chip::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.dsh-atw-issue-chip[data-tone='ok'] { color: var(--dsw-alias-state-success-primary); }
.dsh-atw-issue-chip[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary); }
.dsh-atw-issue-chip[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
.dsh-atw-issue-chip[data-tone='info'] { color: var(--dsw-alias-link); }
.dsh-atw-issue-chip[data-tone='brand'] { color: var(--dsw-alias-state-business-primary); }
.dsh-atw-issue-chip[data-tone='muted'] { color: var(--dsw-alias-label-tertiary); }
.dsh-atw-project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 10px;
}
.dsh-atw-project-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
  border-radius: 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  cursor: pointer;
  transition: border-color .12s ease, background-color .12s ease;
}
.dsh-atw-project-card:hover { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l3); }
.dsh-atw-project-card:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color); outline-offset: 2px; }
.dsh-atw-project-card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-atw-project-card-title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-atw-project-card-desc {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 18px;
}
.dsh-atw-project-card-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 12px;
}
.dsh-atw-project-card-meta > div { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dsh-atw-project-card-meta span { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 14px; }
.dsh-atw-project-card-meta b {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-atw-content {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-height: 0;
}
.dsh-atw-drawer-backdrop {
  position: absolute;
  inset: 0;
  z-index: 3;
  background: transparent;
}
.dsh-atw-drawer {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  width: min(987px, 92%);
  min-width: 440px;
  min-height: 0;
  overflow: hidden;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-prominent);
  animation: dsh-atw-drawer-in .16s ease-out;
}
@keyframes dsh-atw-drawer-in {
  from { transform: translateX(14px); opacity: 0; }
  to { transform: none; opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-atw-drawer { animation: none; }
}
.dsh-atw-drawer-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-atw-drawer-title { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.dsh-atw-drawer-title h2 {
  margin: 0;
  min-width: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-atw-drawer-body { display: flex; flex-direction: column; gap: 18px; flex: 1; min-height: 0; overflow-y: auto; padding: 16px; }
.dsh-atw-drawer-section { display: flex; flex-direction: column; gap: 8px; }
.dsh-atw-drawer-section h3 {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
}
.dsh-atw-members-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--dsw-alias-label-primary) !important;
  font-size: 14px !important;
  line-height: 20px !important;
  font-weight: 600 !important;
  letter-spacing: 0 !important;
  text-transform: none !important;
}
.dsh-atw-members-title span {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  font-weight: 400;
}
.dsh-atw-drawer-text { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; white-space: pre-wrap; }
.dsh-atw-kv { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 13px; line-height: 20px; }
.dsh-atw-kv span { color: var(--dsw-alias-label-tertiary); }
.dsh-atw-kv b { color: var(--dsw-alias-label-primary); font-weight: 500; text-align: right; }
.dsh-atw-issue-drawer { width: min(820px, 92%); }
.dsh-atw-issue-drawer-chips { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-atw-issue-drawer-text {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 21px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsh-atw-issue-comments { display: flex; flex-direction: column; gap: 8px; }
.dsh-atw-issue-comment {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-atw-issue-comment[data-system='1'] {
  border-color: var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-atw-issue-comment-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
.dsh-atw-issue-comment-meta b {
  color: var(--dsw-alias-label-secondary);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-atw-issue-comment-body {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsh-atw-issue-comment-control {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsh-atw-interaction { min-width: 0; }
.dsh-atw-interaction summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  list-style: none;
  cursor: pointer;
}
.dsh-atw-interaction summary::-webkit-details-marker { display: none; }
.dsh-atw-interaction summary::after {
  content: '›';
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  transform: rotate(0deg);
  transition: transform .12s ease;
}
.dsh-atw-interaction[open] summary::after { transform: rotate(90deg); }
.dsh-atw-interaction-kind {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
}
.dsh-atw-interaction-name {
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-atw-interaction-id {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
.dsh-atw-interaction-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-atw-interaction-fields { display: flex; flex-direction: column; gap: 4px; }
.dsh-atw-interaction-field { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dsh-atw-interaction-field > span { flex: none; color: var(--dsw-alias-label-tertiary); }
.dsh-atw-interaction-field > b {
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-weight: 400;
  overflow-wrap: anywhere;
}
.dsh-atw-interaction-pre {
  margin: 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: 11px;
  line-height: 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 180px;
  overflow: auto;
}
.dsh-atw-interaction-questions { display: flex; flex-direction: column; gap: 8px; }
.dsh-atw-interaction-question { display: flex; flex-direction: column; gap: 3px; }
.dsh-atw-interaction-question-header {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-weight: 500;
}
.dsh-atw-interaction-question-text { color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; }
.dsh-atw-interaction-question-detail { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.dsh-atw-interaction-options { display: flex; flex-wrap: wrap; gap: 5px; }
.dsh-atw-interaction-option,
.dsh-atw-interaction-multi {
  padding: 1px 6px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
}
.dsh-atw-interaction-multi { color: var(--dsw-alias-label-tertiary); }
.dsh-atw-interaction-answers { display: flex; flex-direction: column; gap: 6px; }
.dsh-atw-interaction-answer { display: flex; flex-direction: column; gap: 4px; }
.dsh-atw-interaction-answer-id { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsh-atw-interaction-custom {
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsh-atw-interaction-note { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsh-atw-interaction-unsupported { color: var(--dsw-alias-state-warn-primary); font-size: 12px; }
.dsh-atw-issue-comment-box { display: flex; align-items: flex-end; gap: 8px; margin-top: 4px; }
.dsh-atw-issue-comment-input {
  flex: 1;
  min-width: 0;
  min-height: 64px;
  max-height: 180px;
  resize: vertical;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  outline: none;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
}
.dsh-atw-issue-comment-input::placeholder { color: var(--dsw-alias-label-tertiary); }
.dsh-atw-issue-comment-input:focus-visible {
  border-color: var(--dsw-focus-ring-color);
  box-shadow: 0 0 0 1px var(--dsw-focus-ring-color);
}
.dsh-atw-device-table-wrap { overflow-x: auto; }
.dsh-atw-device-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 12px;
}
.dsh-atw-device-table th {
  padding: 6px 8px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
}
.dsh-atw-device-table td {
  padding: 8px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  vertical-align: middle;
}
.dsh-atw-device-table tr:last-child td { border-bottom: none; }
.dsh-atw-device-table th:nth-child(1) { width: 26%; }
.dsh-atw-device-table th:nth-child(2) { width: 18%; }
.dsh-atw-device-table th:nth-child(3) { width: 16%; }
.dsh-atw-device-table th:nth-child(4) { width: 28%; }
.dsh-atw-device-table th:nth-child(5),
.dsh-atw-device-table td:nth-child(5) { width: 92px; text-align: right; }
.dsh-atw-device-host { color: var(--dsw-alias-label-primary); font-weight: 500; }
.dsh-atw-device-actions { text-align: right; }
.dsh-atw-device-table td:nth-child(1),
.dsh-atw-device-table td:nth-child(4) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-atw-member-table-wrap { overflow-x: auto; }
.dsh-atw-member-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 12px;
}
.dsh-atw-member-table th {
  padding: 6px 8px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
}
.dsh-atw-member-table td {
  padding: 8px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
  vertical-align: middle;
}
.dsh-atw-member-table tr:last-child td { border-bottom: none; }
.dsh-atw-member-table th:nth-child(1),
.dsh-atw-member-table th:nth-child(2),
.dsh-atw-member-table th:nth-child(3) { width: 22%; }
.dsh-atw-member-table th:nth-child(4) { width: 24%; }
.dsh-atw-member-table th:nth-child(5),
.dsh-atw-member-table td:nth-child(5) { width: 92px; text-align: right; }
.dsh-atw-member-table td:nth-child(1),
.dsh-atw-member-table td:nth-child(2),
.dsh-atw-member-table td:nth-child(4) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-atw-member-table th:last-child,
.dsh-atw-member-table td:last-child { width: 92px; text-align: right; }
.dsh-atw-member-id { color: var(--dsw-alias-label-primary); font-weight: 500; }
.dsh-atw-role-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  box-sizing: border-box;
  height: 19px;
  padding: 0 8px;
  border: none;
  border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 17px;
  font-weight: 500;
  white-space: nowrap;
  box-shadow: none;
  min-width: 68px;
  justify-content: center;
}
.dsh-atw-role-pill:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-atw-member-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
.dsh-atw-member-name { flex: 1; min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-atw-member-add { display: flex; gap: 8px; margin-top: 4px; align-items: center; flex-wrap: nowrap; justify-content: flex-start; }
.dsh-atw-combo { position: relative; width: 260px; flex: none; }
.dsh-atw-combo > .dsh-atw-compact-input { width: 100%; box-sizing: border-box; }
.dsh-atw-combo-list {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  max-height: 220px;
  overflow-y: auto;
  padding: 4px;
  border-radius: var(--dsw-radius-md);
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-menu-surface-fill);
  box-shadow: var(--dsw-elevation-panel);
}
.dsh-atw-combo-option {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.dsh-atw-combo-option:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-atw-combo-id { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsh-atw-combo-empty {
  padding: 8px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.dsh-atw-combo-error { color: var(--dsw-alias-state-error-primary); }
.dsh-atw-picked {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 4px 0 10px;
  border-radius: var(--dsw-radius-md);
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-1);
  font-size: 13px;
}
.dsh-atw-edit-form { display: flex; flex-direction: column; gap: 10px; }
.dsh-atw-edit-form label { display: flex; flex-direction: column; gap: 5px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-atw-edit-actions { display: flex; justify-content: flex-end; gap: 8px; }
.dsh-atw-required { color: var(--dsw-alias-state-error-primary); }
.dsh-atw-form-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.dsh-atw-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dsh-atw-drawer-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-atw-compact-input { height: 28px; }
.dsh-atw-compact-input input {
  height: 22px;
  font-size: 13px;
}
.dsh-atw-tab {
  padding: 4px 10px;
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-atw-tab[data-active='1'] {
  background: var(--dsw-alias-interactive-bg-active);
  color: var(--dsw-alias-label-primary);
}
.dsh-atw-toasts {
  position: fixed;
  right: 16px;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 70;
}
.dsh-atw-toast {
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l2);
  box-shadow: var(--dsw-elevation-soft);
}
.dsh-atw-toast[data-level='error'] { border-color: var(--dsw-alias-state-error-primary); }
.dsh-atw-toast[data-level='warn'] { border-color: var(--dsw-alias-state-warn-primary); }
`.trim()

/** 从 CSS 文本里收集用到的自定义属性名（lint 用）。 */
export function collectTokens(css: string): readonly string[] {
  const found = new Set<string>()
  const pattern = /var\((--[a-z0-9-]+)/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(css)) !== null) {
    if (match[1] !== undefined) found.add(match[1])
  }
  return [...found].sort()
}
