/**
 * 侧栏入口 glyph（shell 负责行、标签与点击）。
 *
 * 0.2 的 `sidebar.panellist` 只给 glyph 位（`size` / `active`），侧栏那一行的
 * 文字与数字壳不让插件画 —— 所以 0.1.2 那条「待规划｜待办｜进行中｜待验收」
 * 数字带收成 glyph 右上角一颗角标：有等你的交互就显示交互数（红），否则显示
 * 待验收数；完整四项读数放在 `title` / `aria-label` 里，信息不丢。
 *
 * @module dsh-magica-castboard/client/app/sidebar-icon
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'

import type { BoardStore } from '../data/state/index.ts'
import { entryStats } from '../data/derive/index.ts'
import type { Translate } from '../labels/index.ts'
import { Tip } from '../kit/index.ts'

/** 侧栏入口。 */
export function SidebarIcon({ size = 18, active, store, t }: {
  size?: number
  active?: boolean
  store: BoardStore
  t: Translate
}) {
  const state = useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())
  const stats = entryStats(state)
  const title = t('entry.stats', {
    issue: String(stats.issue),
    todo: String(stats.todo),
    doing: String(stats.doing),
    review: String(stats.review),
  })
  const anchor = useRef<HTMLSpanElement>(null)

  // The shell's panellist slot only owns the glyph; counts belong at the right edge
  // of the row, after the shell-owned label. Attach a sibling strip to that row and
  // keep it in sync while the row exists.
  //
  // Collapsed rail: every panel row is 36px wide and shows only the glyph. The strip and
  // the "待交互" hint use `margin-left:auto`, so leaving them there squeezes the icon out
  // of the row (the numbers become the visible content). Sync by the row's real width and
  // attach them only when the row is expanded.
  useEffect(() => {
    const glyph = anchor.current
    const row = glyph?.closest('button, a, [role="button"], li')
    if (row === null || row === undefined) return
    const host = row as HTMLElement
    let hint: HTMLElement | null = null
    let strip: HTMLElement | null = null

    const compact = (): boolean => host.clientWidth > 0 && host.clientWidth < 80

    const ensureHint = (): void => {
      if (stats.pending <= 0) {
        hint?.remove()
        hint = null
        return
      }
      const existing = host.querySelector<HTMLElement>('.lt-entry-ix')
      if (existing !== null) {
        hint = existing
        return
      }
      const node = document.createElement('span')
      node.className = 'lt-entry-ix'
      node.setAttribute('role', 'button')
      node.tabIndex = 0
      node.textContent = t('interaction.entry')
      node.setAttribute('aria-label', t('interaction.entryTitle', { n: String(stats.pending) }))
      const open = (event: Event): void => {
        event.preventDefault()
        event.stopPropagation()
        store.openInteractionInbox()
      }
      node.addEventListener('click', open)
      node.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') open(event)
      })
      host.append(node)
      hint = node
    }

    const ensureStrip = (): void => {
      const current = strip ?? host.querySelector<HTMLElement>('.lt-entry-stats')
      const node = current ?? document.createElement('span')
      if (current === null) {
        node.className = 'lt-entry-stats'
        host.append(node)
      }
      strip = node
      const values: readonly [string, number][] = [
        ['issue', stats.issue],
        ['todo', stats.todo],
        ['in_progress', stats.doing],
        ['in_review', stats.review],
      ]
      node.replaceChildren(...values.flatMap(([key, value], index) => {
        const nodes: HTMLElement[] = []
        if (index > 0) {
          const separator = document.createElement('span')
          separator.className = 'lt-entry-stat-sep'
          separator.textContent = '|'
          nodes.push(separator)
        }
        const slot = document.createElement('span')
        slot.className = 'lt-entry-stat'
        slot.dataset.stat = key
        slot.textContent = String(value)
        nodes.push(slot)
        return nodes
      }))
      node.setAttribute('aria-label', title)
    }

    const sync = (): void => {
      if (compact()) {
        hint?.remove()
        hint = null
        strip?.remove()
        strip = null
        return
      }
      ensureHint()
      ensureStrip()
      order()
    }

    /**
     * Keep the row order `glyph → shell label → counts → hint`.
     *
     * React owns the glyph/title and re-inserts the title when the sidebar expands; our
     * siblings are appended by hand, so without this the title can land after the counts
     * ("0 | 2 | 0 任务面板"). Re-appending moves the siblings to the end in order.
     */
    const order = (): void => {
      if (hint === null && strip === null) return
      const children = host.children
      const stripSeat = children.length - (hint === null ? 1 : 2)
      if (strip !== null && children[stripSeat] !== strip) host.append(strip)
      if (hint !== null && host.lastElementChild !== hint) host.append(hint)
    }

    sync()
    const observer = new MutationObserver(() => {
      if (compact()) return
      if (hint !== null && !hint.isConnected) host.append(hint)
      if (strip !== null && !strip.isConnected) host.append(strip)
      order()
    })
    observer.observe(host, { childList: true })
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { sync() }) : undefined
    resize?.observe(host)
    return () => {
      observer.disconnect()
      resize?.disconnect()
      hint?.remove()
      strip?.remove()
    }
  }, [stats.issue, stats.todo, stats.doing, stats.review, stats.pending, title, store, t, size])

  return (
    <Tip label={title} side="right" align="center">
      <span ref={anchor} className="lt-entry" data-active={active === true ? 'true' : undefined} aria-label={title} role="img">
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
          <rect x="2" y="3.2" width="12" height="9.6" rx="1.8" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5.2 3.2v9.6M2 6.1h3.2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M7 6.3h4.7M7 8.2h4.7M7 10.1h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </span>
    </Tip>
  )
}
