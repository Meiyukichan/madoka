/**
 * `main` slot 的页面入口：把 slot 注入的 store / t 交给看板，并解析语言。
 *
 * @module dsh-magica-castboard/client/app/panel-page
 */
import type { BoardStore } from '../data/state/index.ts'
import type { Translate } from '../labels/index.ts'
import { Lanes } from '../features/board/page.tsx'

/** 语言（跟随 GUI 的 document.lang）。 */
function currentLang(): 'zh' | 'en' {
  try {
    const lang = document.documentElement.lang.toLowerCase()
    if (lang.startsWith('en')) return 'en'
    if (lang.startsWith('zh')) return 'zh'
  } catch { /* 无 DOM */ }
  return 'zh'
}

/** 看板页面。 */
export function PanelPage(props: { store: BoardStore; t: Translate; size?: number; active?: boolean }) {
  return <Lanes store={props.store} t={props.t} lang={currentLang()} />
}
