/**
 * �������??4 ������ȫ��ֻ??props����??ctx / fetch / ȫ��״̬?? *
 * ��ʽ���� `UI_CSS`��`dsh-atw-*` �ࣩ������ע??`<style data-plugin>`?? *
 * @module dsh-magica-teamwork/client/components
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'

import type { Lang } from '../model/labels.js'

/** ͨ�� props??*/
export interface BaseProps {
  className?: string
  style?: CSSProperties
  children?: ReactNode
}

/** 1) ��ť??*/
export function Button(props: {
  children: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary'
  disabled?: boolean
  title?: string
  className?: string
}): ReactNode {
  return (
    <button
      type="button"
      className={`dsh-atw-button ${props.className ?? ''}`.trim()}
      data-variant={props.variant ?? 'default'}
      disabled={props.disabled}
      title={props.title}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

/** 2) �ձ�??*/
export function Badge(props: { children: ReactNode; tone?: 'neutral' | 'urgent' | 'warn' | 'ok' }): ReactNode {
  return (
    <span className="dsh-atw-badge" data-tone={props.tone ?? 'neutral'}>
      {props.children}
    </span>
  )
}

/** 3) ͷ��ȡ����ĸ��??*/
export function Avatar(props: { name: string; size?: number }): ReactNode {
  const initial = props.name.trim().slice(0, 1).toUpperCase() || '?'
  return (
    <span className="dsh-atw-avatar" style={{ width: props.size ?? 20, height: props.size ?? 20 }} title={props.name}>
      {initial}
    </span>
  )
}

/** 4) �����??*/
export function Input(props: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  onEnter?: () => void
  disabled?: boolean
  autoFocus?: boolean
}): ReactNode {
  return (
    <input
      className="dsh-atw-input"
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      autoFocus={props.autoFocus}
      onChange={event => { props.onChange(event.target.value) }}
      onKeyDown={event => { if (event.key === 'Enter') props.onEnter?.() }}
    />
  )
}

/** 5) ��̬??*/
export function Empty(props: { text: string; action?: ReactNode }): ReactNode {
  return (
    <div className="dsh-atw-empty">
      <div>{props.text}</div>
      {props.action}
    </div>
  )
}

/** 6) תȦ??*/
export function Spinner(): ReactNode {
  return <span className="dsh-atw-spinner" role="status" aria-label="loading" />
}

/** 7) ��ҳǩ??*/
export function Tabs<T extends string>(props: {
  items: readonly { key: T; label: string }[]
  active: T
  onChange: (key: T) => void
}): ReactNode {
  return (
    <div className="dsh-atw-tabs" role="tablist">
      {props.items.map(item => (
        <button
          key={item.key}
          type="button"
          role="tab"
          className="dsh-atw-tab"
          data-active={item.key === props.active ? '1' : '0'}
          aria-selected={item.key === props.active}
          onClick={() => { props.onChange(item.key) }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/** 8) ������Esc �رգ�����ʱ����Ⱦ���֣�??*/
export function Modal(props: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: string
}): ReactNode {
  useEffect(() => {
    if (!props.open) return undefined
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') props.onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [props.open, props.onClose])
  if (!props.open) return null
  return (
    <div className="dsh-atw-modal-mask" onClick={props.onClose} role="presentation">
      <div
        className="dsh-atw-modal"
        style={props.width === undefined ? undefined : { width: props.width }}
        onClick={event => { event.stopPropagation() }}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
      >
        <h3 style={{ marginTop: 0 }}>{props.title}</h3>
        {props.children}
        {props.footer === undefined ? null : <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>{props.footer}</div>}
      </div>
    </div>
  )
}

/** 9) ��Ƭ??*/
export function Card(props: {
  id: string
  title: string
  meta?: ReactNode
  running?: boolean
  onClick?: () => void
  draggable?: boolean
  onDragStart?: (event: React.DragEvent<HTMLDivElement>) => void
}): ReactNode {
  return (
    <div
      className="dsh-atw-card"
      data-card-id={props.id}
      data-running={props.running === true ? '1' : '0'}
      draggable={props.draggable === true}
      onDragStart={props.onDragStart}
      onClick={props.onClick}
      role="button"
      tabIndex={0}
    >
      <div className="dsh-atw-card-title">{props.title}</div>
      {props.meta === undefined ? null : <div className="dsh-atw-card-meta">{props.meta}</div>}
    </div>
  )
}

/** 10) ��??*/
export function Column(props: {
  status: string
  label: string
  count: number
  children: ReactNode
  onDropTask?: (taskId: string) => void
}): ReactNode {
  const [over, setOver] = useState(false)
  return (
    <div
      className="dsh-atw-column"
      data-column={props.status}
      data-drop={over ? '1' : '0'}
      onDragOver={event => { event.preventDefault(); setOver(true) }}
      onDragLeave={() => { setOver(false) }}
      onDrop={event => {
        event.preventDefault()
        setOver(false)
        const taskId = event.dataTransfer.getData('text/plain') || event.dataTransfer.getData('application/x-dsh-castboard-task')
        if (taskId !== '') props.onDropTask?.(taskId)
      }}
    >
      <div className="dsh-atw-column-head">
        <span>{props.label}</span>
        <span className="dsh-atw-count">{props.count}</span>
      </div>
      {props.children}
    </div>
  )
}

/** 11) ����բ�ţ���????����/���������ڼ䱣������ݲ���??*/
export function ListGate<T>(props: {
  state: { status: 'idle' | 'loading' | 'ready' | 'error'; message?: string; value?: T }
  children: (value: T) => ReactNode
  onRetry?: () => void
  emptyText?: string
  isEmpty?: (value: T) => boolean
}): ReactNode {
  const { state } = props
  if (state.status === 'loading' && state.value === undefined) return <Spinner />
  if (state.status === 'error') {
    return (
      <Empty
        text={state.message ?? '����ʧ��'}
        action={<Button onClick={props.onRetry}>����</Button>}
      />
    )
  }
  if (state.value === undefined) return <Empty text={props.emptyText ?? '��������'} />
  if (props.isEmpty?.(state.value) === true) return <Empty text={props.emptyText ?? '��������'} />
  return <>{props.children(state.value)}</>
}

/** 12) ��Աѡ��`search` �������ṩ�������ֱ�����磩??*/
export function PersonPicker(props: {
  value?: string
  candidates: readonly { id: string; name: string }[]
  onChange: (id: string | undefined) => void
  search?: (keyword: string) => void
  placeholder?: string
  lang?: Lang
}): ReactNode {
  const [keyword, setKeyword] = useState('')
  return (
    <div className="dsh-atw-person" style={{ gap: 8 }}>
      <Input
        value={keyword}
        placeholder={props.placeholder ?? (props.lang === 'en' ? 'Search people' : '搜索成员')}
        onChange={value => {
          setKeyword(value)
          props.search?.(value)
        }}
      />
      <select
        className="dsh-atw-input"
        value={props.value ?? ''}
        onChange={event => { props.onChange(event.target.value === '' ? undefined : event.target.value) }}
      >
        <option value="">—</option>
        {props.candidates
          .filter(item => keyword === '' || item.name.toLowerCase().includes(keyword.toLowerCase()))
          .map(item => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
      </select>
    </div>
  )
}

/** 13) 项目卡片墙。 */
export function ProjectsCards(props: {
  items: readonly { id: string; name: string; description?: string; members?: number; private?: boolean }[]
  onOpen: (id: string) => void
  lang?: Lang
}): ReactNode {
  if (props.items.length === 0) {
    return <Empty text={props.lang === 'en' ? 'No projects yet' : '还没有项目'} />
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
      {props.items.map(item => (
        <div key={item.id} className="dsh-atw-card" onClick={() => { props.onOpen(item.id) }} role="button" tabIndex={0}>
          <div className="dsh-atw-card-title">{item.name}</div>
          {item.description === undefined ? null : <div className="dsh-atw-card-meta">{item.description}</div>}
          <div className="dsh-atw-card-meta">
            {item.private === true ? <Badge tone="warn">{props.lang === 'en' ? 'Private' : '私有'}</Badge> : null}
            {item.members === undefined ? null : <Badge>{item.members}</Badge>}
          </div>
        </div>
      ))}
    </div>
  )
}

/** 14) toast 容器（数据来自模块级队列，卸载时宿主调 `resetToasts()`）。 */
export function Toasts(props: { items: readonly { id: number; level: string; text: string }[]; onDismiss?: (id: number) => void }): ReactNode {
  if (props.items.length === 0) return null
  return (
    <div className="dsh-atw-toasts">
      {props.items.map(item => (
        <div
          key={item.id}
          className="dsh-atw-toast"
          data-level={item.level}
          onClick={() => { props.onDismiss?.(item.id) }}
          role="status"
        >
          {item.text}
        </div>
      ))}
    </div>
  )
}
