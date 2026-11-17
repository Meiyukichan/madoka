/**
 * 卡片样式：以字符串注入（不是 CSS Modules）。
 *
 * 三条硬约束（缺一不可，见 `docs/design/03-interactions.zh.md` §4.6）：
 * ① 组件不出包，样式要能跟着任意消费方的 bundle 走；
 * ② 这条入口由构建直编，**没有 CSS 管线**（`import css from './x.module.css'` 会原样留在产物里）；
 * ③ 消费方的打包链不保证有 CSS plugin。
 *
 * 因此：统一 `magica-ix-` 前缀 + 固定 `<style id>` + 引用计数 + `data-plugin`（HMR 按它回收）。
 * 不要在这段字符串里写注释。
 *
 * @module dsh-magica-spellbook/client/panel/styles
 */

/** 注入的 `<style>` 元素 id（每页一个）。 */
export const INTERACTION_STYLE_ID = 'magica-ix-styles'

/** 卡片样式本体。 */
export const INTERACTION_STYLES = [
  '.magica-ix-frame{display:flex;justify-content:center;padding:6px calc(var(--dsh-composer-side-clearance,16px) + 16px) 10px;}',
  '.magica-ix-card,.magica-ix-card *{box-sizing:border-box;}',
  // 卡片与审批卡都要重绑这三个变量：dsh 的浮层在浅/深色下用不同的描边与滚动条取值，
  // 不重绑会落回全局默认（B-043/B-044/B-045/B-062/B-074/B-075）
  '.magica-ix-card{display:flex;flex-direction:column;width:100%;max-width:var(--dsh-chat-content-width,760px);max-height:min(60vh,520px);border-radius:20px;background:var(--dsw-specific-input-major);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary);font-size:14px;overflow:hidden;--dsw-elevation-stroke-color:var(--dsw-alias-border-l2-darkmode-thin);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-bg-l1);}',
  '.magica-ix-header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:20px 16px 0 24px;}',
  '.magica-ix-headings{display:flex;flex-direction:column;gap:4px;min-width:0;}',
  '.magica-ix-eyebrow{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);}',
  '.magica-ix-title{margin:0;font-size:16px;line-height:22px;font-weight:500;}',
  '.magica-ix-actions{display:flex;gap:4px;}',
  '.magica-ix-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;}',
  '.magica-ix-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
  '.magica-ix-icon:disabled{color:var(--dsw-alias-label-dimmed);cursor:default;}',
  '.magica-ix-body{overflow-y:auto;overscroll-behavior:contain;padding:8px 0 0;}',
  '.magica-ix-detail{margin:0 24px 8px;}',
  '.magica-ix-options{display:flex;flex-direction:column;gap:1px;padding:4px 12px;}',
  '.magica-ix-option{display:flex;align-items:flex-start;gap:10px;width:100%;min-height:40px;padding:8px 12px;border:1px solid transparent;border-radius:12px;background:transparent;color:inherit;text-align:left;cursor:pointer;transition:background-color 120ms ease,border-color 120ms ease;}',
  '.magica-ix-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
  '.magica-ix-option.magica-ix-on{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);}',
  '.magica-ix-option:disabled{cursor:default;opacity:.6;}',
  '.magica-ix-num{display:inline-flex;align-items:center;justify-content:center;flex:0 0 20px;width:20px;height:20px;border-radius:6px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font-size:11px;}',
  '.magica-ix-check{position:relative;flex:0 0 14px;width:14px;height:14px;margin-top:5px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l4);}',
  '.magica-ix-checkon{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary-foreground);}',
  '.magica-ix-copy{display:flex;flex-direction:column;gap:2px;min-width:0;}',
  '.magica-ix-label{font-size:14px;line-height:24px;font-weight:500;}',
  '.magica-ix-desc{font-size:14px;line-height:24px;color:var(--dsw-alias-label-tertiary);}',
  '.magica-ix-badge{padding:0 5px;border-radius:5px;background:var(--dsw-specific-sidebar-nav-item-active-accent);color:var(--dsw-alias-button-info-fill);font-size:10px;line-height:16px;}',
  '.magica-ix-approve .magica-ix-label{display:inline-flex;align-items:center;gap:6px;}',
  '.magica-ix-recommend{padding:0 5px;border-radius:5px;background:var(--dsw-specific-sidebar-nav-item-active-accent);color:var(--dsw-alias-button-info-fill);font-size:10px;line-height:16px;}',
  '.magica-ix-customrow{display:flex;align-items:center;gap:10px;margin:4px 12px;padding:8px 12px;border:.5px solid transparent;border-radius:12px;}',
  '.magica-ix-customrow:focus-within{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);}',
  '.magica-ix-input{flex:1;min-width:0;border:0;background:transparent;color:inherit;font:inherit;outline:none;caret-color:var(--dsw-alias-state-business-primary);resize:none;overflow:hidden;max-height:160px;}',
  '.magica-ix-input::placeholder{color:var(--dsw-alias-label-caption);}',
  '.magica-ix-block{margin:4px 12px;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-module-platform);}',
  '.magica-ix-block:focus-within{border-color:var(--dsw-alias-state-business-primary);}',
  '.magica-ix-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px 10px 18px;}',
  '.magica-ix-progress{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);word-spacing:-2px;}',
  '.magica-ix-feedback{font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary);text-align:right;}',
  '.magica-ix-footerbtns{display:flex;gap:12px;}',
  '.magica-ix-apprroot{display:flex;justify-content:center;padding:6px calc(var(--dsh-composer-side-clearance,16px) + 16px) 10px;}',
  '.magica-ix-appr{display:flex;flex-direction:column;width:100%;max-width:var(--dsh-chat-content-width,760px);border:1px solid var(--dsw-alias-state-warn-secondary);border-radius:20px;background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);overflow:hidden;}',
  '.magica-ix-strip{display:flex;align-items:center;gap:8px;padding:8px 16px;background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);font-size:12px;}',
  '.magica-ix-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);}',
  '.magica-ix-apprbody{max-height:var(--dsh-composer-text-max-height,336px);overflow-y:auto;padding:14px 16px 0;}',
  '.magica-ix-headline{margin:0 0 8px;font-size:15px;line-height:24px;font-weight:500;}',
  '.magica-ix-command{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-module-platform);font-family:var(--ds-font-family-code,monospace);font-size:12px;line-height:18px;word-break:break-all;white-space:pre-wrap;}',
  '.magica-ix-appr{--dsw-elevation-stroke-color:var(--dsw-alias-border-l2-darkmode-thin);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-bg-l1);}',
  '.magica-ix-appractions{display:flex;justify-content:flex-end;gap:12px;padding:14px 16px;}',
  '.magica-ix-reject:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);border-color:transparent;color:var(--dsw-alias-state-error-primary);}',
].join('')

interface StyleState {
  refs: number
  element: HTMLStyleElement | null
}

const styleState: StyleState = { refs: 0, element: null }

/**
 * 注入卡片样式（幂等 + 引用计数）。
 *
 * 两个细节是承重的（A-172 / B-053）：
 * 1. **每次进入都重新 `getElementById`**，不信任缓存——dsh HMR 可能按 `data-plugin`
 *    摘掉标签，缓存里的句柄会变成"脱管节点"，之后的 `remove()` 什么也删不掉。
 * 2. 同时写 `data-plugin` 与 `data-plugin-css`：HMR 按后者回收样式产物。
 *
 * @param pluginId - 写进 `data-plugin`，HMR 按它回收。
 */
export function injectInteractionStyles(pluginId: string): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.getElementById(INTERACTION_STYLE_ID)
  if (existing !== null) {
    styleState.element = existing as HTMLStyleElement
  } else {
    const element = document.createElement('style')
    element.id = INTERACTION_STYLE_ID
    element.textContent = INTERACTION_STYLES
    document.head.appendChild(element)
    styleState.element = element
  }
  const element = styleState.element
  element.dataset['plugin'] = pluginId
  // 0.2 的 HMR 按这个属性回收样式产物：写空串等于回收不到（diff D11-3）
  element.dataset['pluginCss'] = INTERACTION_STYLE_ID
  styleState.refs += 1
  let released = false
  return () => {
    if (released) return
    released = true
    styleState.refs = Math.max(0, styleState.refs - 1)
    if (styleState.refs > 0) return
    // 释放时也重新查一次：缓存的句柄可能已被 HMR 摘走
    const live = document.getElementById(INTERACTION_STYLE_ID) ?? styleState.element
    try {
      live?.remove()
    } catch {
      // 已被 HMR 回收
    }
    styleState.element = null
  }
}
