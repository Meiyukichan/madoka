/**
 * 下拉选择器：按钮 + portal 弹层（支持分组、对勾、空态）。
 *
 * @module dsh-magica-castboard/client/kit/picker
 */
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Tip } from './tip.tsx'

/** 选项。 */
export interface Choice {
  value: string
  label: string
  icon?: ReactNode
  group?: string
}

function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Tick() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M2.5 7.5 5.5 10.5 11.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 选择器参数。 */
export interface DropdownProps {
  value: string
  choices: readonly Choice[]
  onChange: (value: string) => void
  label: string
  dataId?: string
  disabled?: boolean
  emptyLabel?: string
  triggerClass?: string
  triggerTitle?: string
}

const POP_MIN = 240

/** 下拉选择。 */
export function Dropdown({ value, choices, onChange, label, dataId, disabled = false, emptyLabel, triggerClass, triggerTitle }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const pop = useRef<HTMLDivElement | null>(null)
  const selected = choices.find(choice => choice.value === value)

  useEffect(() => {
    if (!open) return
    const closeOnOutside = (event: MouseEvent): void => {
      const target = event.target as Node
      if (trigger.current?.contains(target) === true) return
      if (pop.current?.contains(target) === true) return
      setOpen(false)
    }
    document.addEventListener('click', closeOnOutside)
    return () => { document.removeEventListener('click', closeOnOutside) }
  }, [open])

  useLayoutEffect(() => {
    if (!open) { setStyle(null); return }
    if (trigger.current === null) return
    const rect = trigger.current.getBoundingClientRect()
    const element = pop.current
    const maxHeight = 280
    const natural = element !== null ? element.scrollHeight : maxHeight
    const minWidth = Math.max(rect.width, Math.min(POP_MIN, window.innerWidth - 16))
    const width = element !== null ? element.offsetWidth : minWidth
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    const height = Math.min(maxHeight, natural)
    const below = window.innerHeight - rect.bottom - 8
    const above = rect.top - 8
    const flip = below < height && (above >= height || above > below)
    const max = Math.max(80, Math.min(maxHeight, flip ? above : below))
    setStyle({
      top: flip ? Math.max(8, rect.top - max - 4) : rect.bottom + 4,
      left,
      minWidth,
      maxHeight: max,
      overflowY: 'auto',
    })
  }, [open])

  return (
    <>
      <Tip label={triggerTitle ?? label}>
        <button
          ref={trigger}
          type="button"
          className={triggerClass === undefined ? 'lt-select' : `lt-select ${triggerClass}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled}
          {...(dataId === undefined ? {} : { 'data-select': dataId, 'data-value': value })}
          onClick={() => { setOpen(current => !current) }}
        >
          {selected?.icon !== undefined && <span className="lt-select-icon">{selected.icon}</span>}
          <span className="lt-select-label">{selected?.label ?? '—'}</span>
          <span className="lt-select-chevron"><Chevron /></span>
        </button>
      </Tip>
      {open && createPortal(
        <div
          ref={pop}
          className="lt-pop"
          role="listbox"
          style={style ?? { visibility: 'hidden' }}
          onClick={event => { event.stopPropagation() }}
        >
          {choices.length === 0 && emptyLabel !== undefined && <div className="lt-pop-empty" role="presentation">{emptyLabel}</div>}
          {choices.map((choice, index) => {
            const group = choice.group
            const showGroup = group !== undefined && group !== '' && choices[index - 1]?.group !== group
            return (
              <Fragment key={choice.value}>
                {showGroup && <div className="lt-pop-group" role="presentation">{group}</div>}
                <div
                  role="option"
                  aria-selected={choice.value === value}
                  className="lt-pop-item"
                  data-selected={choice.value === value ? 'true' : undefined}
                  onClick={() => { setOpen(false); onChange(choice.value) }}
                >
                  {choice.icon !== undefined && <span className="lt-pop-icon">{choice.icon}</span>}
                  <span className="lt-pop-label">{choice.label}</span>
                  <span className="lt-pop-check"><Tick /></span>
                </div>
              </Fragment>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}
