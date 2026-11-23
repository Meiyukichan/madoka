/**
 * Prompt textarea with a `/` completion menu for commands and skills.
 *
 * The menu follows the textarea through a portal so a scrollable modal cannot clip
 * it. Host-provided candidates win when present; otherwise a small built-in list
 * keeps the menu useful before the shell has loaded.
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { PromptCompletionItem } from '../data/index.ts'
import type { BoardStore } from '../data/state/index.ts'

const BUILTIN: readonly PromptCompletionItem[] = [
  { name: 'goal', kind: 'command', description: 'Create or update a goal' },
  { name: 'schedule', kind: 'command', description: 'Schedule a recurring task' },
  { name: 'plan', kind: 'command', description: 'Draft a plan before acting' },
  { name: 'browser', kind: 'command', description: 'Inspect the browser surface' },
  { name: 'review', kind: 'command', description: 'Review the current change' },
  { name: 'security', kind: 'command', description: 'Run a security pass' },
  { name: 'permission', kind: 'command', description: 'Show the permission preset', hint: '[mode]' },
  { name: 'frontend-ui-engineering', kind: 'skill', description: 'Frontend UI engineering' },
  { name: 'api-and-interface-design', kind: 'skill', description: 'API and interface design' },
  { name: 'test-driven-development', kind: 'skill', description: 'Test-driven development' },
  { name: 'debugging-and-error-recovery', kind: 'skill', description: 'Debugging and recovery' },
  { name: 'code-review-and-quality', kind: 'skill', description: 'Code review and quality' },
  { name: 'code-simplification', kind: 'skill', description: 'Simplify the implementation' },
]

export interface SlashPromptInputProps {
  value: string
  onChange: (value: string) => void
  store?: BoardStore
  workspaceId?: string
  rows?: number
  maxLength?: number
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
}

export function SlashPromptInput({
  value,
  onChange,
  store,
  workspaceId,
  rows = 4,
  maxLength = 8000,
  placeholder,
  ariaLabel,
  disabled = false,
}: SlashPromptInputProps) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [host, setHost] = useState<readonly PromptCompletionItem[] | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [start, setStart] = useState(-1)
  const [active, setActive] = useState(0)
  const [style, setStyle] = useState<Record<string, string | number>>({})

  useEffect(() => {
    if (store === undefined) return
    let live = true
    setHost(undefined)
    void store.fetchPromptCompletions(workspaceId).then(result => {
      if (!live) return
      const merged = [...result.commands, ...result.skills]
      setHost(merged.length > 0 ? merged : undefined)
    })
    return () => { live = false }
  }, [store, workspaceId])

  const candidates = useMemo(() => host ?? BUILTIN, [host])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return candidates
    return candidates.filter(item => item.name.toLowerCase().includes(needle)
      || item.description?.toLowerCase().includes(needle) === true)
  }, [candidates, query])

  useEffect(() => {
    if (active < filtered.length) return
    setActive(Math.max(0, filtered.length - 1))
  }, [active, filtered.length])

  useLayoutEffect(() => {
    if (!open) return
    const element = textarea.current
    if (element === null) return
    const rect = element.getBoundingClientRect()
    const measured = popup.current?.offsetHeight ?? 240
    const below = window.innerHeight - rect.bottom - 8
    const above = rect.top - 8
    const height = Math.min(measured, Math.max(below > above ? below : above, 120))
    const top = below > above ? rect.bottom + 6 : rect.top - height - 6
    setStyle(prev => (prev.left === rect.left && prev.top === top && prev.width === rect.width && prev.maxHeight === height
      ? prev
      : { position: 'fixed', left: rect.left, top, width: rect.width, maxHeight: height, zIndex: 1200 }))
  }, [filtered.length, open])

  useEffect(() => {
    if (!open) return
    const reposition = (): void => {
      const element = textarea.current
      if (element === null) return
      const rect = element.getBoundingClientRect()
      const measured = popup.current?.offsetHeight ?? 240
      const below = window.innerHeight - rect.bottom - 8
      const above = rect.top - 8
      const height = Math.min(measured, Math.max(below > above ? below : above, 120))
      setStyle({ position: 'fixed', left: rect.left, top: below > above ? rect.bottom + 6 : rect.top - height - 6, width: rect.width, maxHeight: height, zIndex: 1200 })
    }
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const row = list.current?.querySelector<HTMLElement>('[data-active="true"]')
    if (row === undefined || row === null) return
    row.scrollIntoView({ block: 'nearest' })
  }, [active, open, filtered])

  const detect = (): void => {
    const element = textarea.current
    if (element === null) return
    const cursor = element.selectionStart
    const before = element.value.slice(0, cursor)
    const slash = before.lastIndexOf('/')
    if (slash >= 0) {
      const previous = slash === 0 ? '\n' : before[slash - 1] ?? '\n'
      const tail = before.slice(slash + 1)
      if (/\s/.test(previous) && !/\s/.test(tail)) {
        setStart(slash)
        setQuery(tail)
        setOpen(true)
        return
      }
    }
    setOpen(false)
  }

  const insert = (item: PromptCompletionItem): void => {
    const element = textarea.current
    if (element === null || start < 0) return
    const cursor = element.selectionStart
    const inserted = `/${item.name} `
    onChange(`${value.slice(0, start)}${inserted}${value.slice(cursor)}`)
    setOpen(false)
    setTimeout(() => {
      if (textarea.current === null) return
      const next = start + inserted.length
      textarea.current.focus()
      textarea.current.setSelectionRange(next, next)
    }, 0)
  }

  return (
    <div className="lt-slash">
      <textarea
        ref={textarea}
        className="lt-textarea lt-slash-input"
        rows={rows}
        maxLength={maxLength}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={event => { onChange(event.target.value); detect() }}
        onClick={detect}
        onKeyUp={detect}
        onKeyDown={event => {
          if (open && filtered.length > 0) {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActive(current => (current + 1) % filtered.length)
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive(current => (current - 1 + filtered.length) % filtered.length)
              return
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              const item = filtered[active]
              if (item !== undefined) {
                event.preventDefault()
                insert(item)
                return
              }
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setOpen(false)
              return
            }
          }
        }}
      />
      <span className="lt-slash-tip">Type <code>/</code> for commands and skills</span>
      {open && filtered.length > 0 && createPortal(
        <div ref={popup} className="lt-slash-pop" style={style} role="listbox">
          <div ref={list} className="lt-slash-list">
            {filtered.map((item, index) => (
              <Fragment key={`${item.kind}-${item.name}`}>
                {filtered[index - 1]?.kind !== item.kind && (
                  <div className="lt-slash-group">{item.kind === 'command' ? 'Commands' : 'Skills'}</div>
                )}
                <div
                  className="lt-slash-item"
                  data-active={index === active ? 'true' : undefined}
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => { setActive(index) }}
                  onClick={() => { insert(item) }}
                >
                  <span className="lt-slash-name">/{item.name}</span>
                  {item.hint !== undefined && <span className="lt-slash-param">{item.hint}</span>}
                  {item.description !== undefined && <span className="lt-slash-desc">{item.description}</span>}
                </div>
              </Fragment>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
