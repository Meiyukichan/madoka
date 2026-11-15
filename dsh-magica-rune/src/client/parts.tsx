import type { ChangeEvent } from 'react'
/**
 * 页面原子件：折叠 zone、搜索行、分组头、药丸按钮、工作区下拉。
 *
 * 样式与几何全部来自 `styles.ts`（数值照抄 raw/a.md §5）。
 * 组件只接 props，永远不接触 ctx。
 * @module dsh-magica-rune/client/parts
 */

import { useRef, useState } from 'react'
import { Button, Input, Menu, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { cls } from './styles.ts'
import { CaretIcon, ChevronIcon } from './icons.tsx'
import { catColor, groupCount } from './categorize.ts'
import type { WorkspaceRow } from './controller.ts'

/** 一行能力的生效态。 */
export type RowState = 'enabled' | 'disabled' | 'builtin'

/** 折叠 zone：全局 / 工作区。 */
export function Zone(props: {
  title: string
  count: string
  open: boolean
  onToggle: () => void
  extra?: unknown
  children?: unknown
}) {
  return (
    <section className={cls.zone}>
      <div className={cls.zoneHead}>
        <button
          type="button"
          className={cls.zoneToggle}
          aria-expanded={props.open ? 'true' : 'false'}
          onClick={props.onToggle}
        >
          <span className={cls.zoneCaret}><CaretIcon /></span>
          <span className={cls.zoneTitle}>{props.title}</span>
          <span className={cls.zoneCount}>{props.count}</span>
        </button>
        {props.extra as never}
      </div>
      {(props.open ? props.children : null) as never}
    </section>
  )
}

/**
 * 搜索行。
 *
 * 用 `ui-primitives` 的 `Input`（SKILL §3.2/§3.3：优先复用原语）。注意它的 `className`
 * 落在**外层 wrapper** 上、内层 `<input>` 自带 `.input` 类，所以尺寸要分两处覆盖：
 * wrapper 管高度/内距/圆角，内层用 `.rune-search > input`（(0,1,1) 胜过 primitive 的 (0,1,0)）管字号。
 */
export function SearchRow(props: {
  placeholder: string
  value: string
  onChange: (text: string) => void
}) {
  return (
    <div className={cls.searchRow}>
      <Input
        className={cls.searchInput}
        type="search"
        placeholder={props.placeholder}
        value={props.value}
        aria-label={props.placeholder}
        onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)}
      />
    </div>
  )
}

/** 分组头：色点 → 分类名 → `·N/M` → 批量勾选（右推）。 */
export function GroupHead(props: {
  category: string
  label: string
  states: readonly RowState[]
  onBatch: (enable: boolean) => void
}) {
  const local = useRef<HTMLInputElement | null>(null)
  const count = groupCount(props.states)
  const indeterminate = count.someEnabled
  return (
    <h4 className={cls.groupTitle}>
      <span className={cls.catDot} style={{ background: catColor(props.category) }} />
      <span>{props.label}</span>
      <span className={cls.groupCount}>{`${count.enabled}/${count.total}`}</span>
      <label className={cls.batchToggle}>
        <input
          ref={element => {
            local.current = element
            if (element !== null) element.indeterminate = indeterminate
          }}
          type="checkbox"
          checked={count.allEnabled}
          onChange={() => props.onBatch(!count.allEnabled)}
        />
      </label>
    </h4>
  )
}

/**
 * 药丸按钮。
 *
 * `builtin` 态刻意**不用 `disabled` 属性**（会吞掉 hover/focus，tooltip 就出不来），
 * 而是 `aria-disabled + tabIndex=-1 + 不接 onClick`。
 */
export function Pill(props: {
  name: string
  description: string
  state: RowState
  category: string
  builtinLabel: string
  onClick: () => void
}) {
  const enabled = props.state === 'enabled'
  const builtin = props.state === 'builtin'
  const className = builtin
    ? `${cls.pill} ${cls.pillBuiltin}`
    : enabled ? `${cls.pill} ${cls.pillEnabled}` : cls.pill
  const style = enabled ? { borderColor: catColor(props.category) } : undefined
  const label = builtin && props.description !== ''
    ? `${props.description}`
    : props.description
  const button = (
    <Button
      type="button"
      variant="ghost"
      // 尺寸交给原语：`sm` 正好是 H28（与 raw 一致），我们再覆盖 padding/字号/圆角/描边。
      size="sm"
      className={className}
      style={style as never}
      // 稳定的测试/调试钩子：E2E 用 data-name 定位，避免依赖文本匹配（多语言下尤其脆）。
      data-name={props.name}
      data-state={props.state}
      aria-disabled={builtin ? true : undefined}
      tabIndex={builtin ? -1 : undefined}
      onClick={builtin ? undefined : props.onClick}
    >
      <span className={cls.pillName}>{props.name}</span>
      {builtin ? <span className={cls.badge}>{props.builtinLabel}</span> : null}
    </Button>
  )
  return (
    <li style={{ position: 'relative' }}>
      {label === ''
        ? button
        : (
          <Tooltip label={label} side="bottom" maxWidth={500} delayMs={1000} portal>
            {button}
          </Tooltip>
        )}
    </li>
  )
}

/** 工作区下拉：触发器自绘 chevron，浮层交给 0.2 的 `Menu`（材质只能由它提供）。 */
export function WorkspaceDropdown(props: {
  scopes: readonly WorkspaceRow[]
  selectedId: string | undefined
  /** 未选中时的占位文案（raw 没有定义这个 key，由调用方传入 `t('scope.placeholder')`）。 */
  placeholder: string
  onSelect: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const current = props.scopes.find(scope => scope.id === props.selectedId)
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      portal
      getAnchorRect={() => trigger.current?.getBoundingClientRect() ?? null}
      selectedId={props.selectedId}
      items={props.scopes.map(scope => ({ id: scope.id, label: scope.title }))}
      onSelect={(id: string) => { setOpen(false); props.onSelect(id) }}
      listClassName={cls.menu}
      anchor={(
        <button
          ref={trigger}
          type="button"
          className={cls.select}
          data-empty={current === undefined ? 'true' : undefined}
          aria-haspopup="menu"
          aria-expanded={open ? 'true' : 'false'}
          onClick={() => setOpen(value => !value)}
        >
          {current?.title ?? props.placeholder}
          <span className={cls.chevron}><ChevronIcon /></span>
        </button>
      )}
    />
  )
}

/** 禁用内置分类工具前的二次确认。 */
export function ConfirmDisable(props: {
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  closeLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      open
      onClose={props.onCancel}
      title={props.title}
      closeLabel={props.closeLabel}
      description={props.description}
      footer={(
        <>
          <Button variant="ghost" data-rune-cancel onClick={props.onCancel}>{props.cancelLabel}</Button>
          <Button variant="primary" data-rune-confirm onClick={props.onConfirm}>{props.confirmLabel}</Button>
        </>
      )}
    />
  )
}
