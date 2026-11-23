/**
 * 样式入口：分区拼接后一次注入（顺序即层叠顺序，不能随意调换）。
 *
 * @module dsh-magica-castboard/client/design
 */
import { UI_CSS } from '@meiyukichan/dsh-magica-teamwork/client'

import { SHELL_CSS } from './shell.ts'
import { TILES_CSS } from './tiles.ts'
import { DRAWER_CSS } from './drawer.ts'
import { FORMS_CSS } from './forms.ts'
import { DIALOGS_CSS } from './dialogs.ts'

/** 样式文本。 */
export const PANEL_CSS = [SHELL_CSS, TILES_CSS, DRAWER_CSS, FORMS_CSS, DIALOGS_CSS, UI_CSS].join('\n')

/** `<style>` 标签 id。 */
const STYLE_ID = 'dsh-magica-castboard-panel'

/** 归属标记。 */
const STYLE_OWNER = '@meiyukichan/dsh-magica-castboard'

/** 幂等注入（DOM 判据，模块重载也能重建）。 */
export function installPanelStyles(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) return () => { existing.remove() }
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.plugin = STYLE_OWNER
  style.dataset.pluginCss = 'castboard-panel'
  style.textContent = PANEL_CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}
