/**
 * 按钮与内联小块：ActionButton / CloseButton / GlyphLabel。
 *
 * @module dsh-magica-castboard/client/kit/button
 */
import { Button, IconCloseOutlineRegular, type ButtonVariant } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Tip } from './tip.tsx'

/** 按钮变体。 */
export type ActionTone = 'primary' | 'outline' | 'ghost' | 'danger'

/** 操作按钮参数。 */
export interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ActionTone
  size?: 'sm' | 'md'
  icon?: ReactNode
  /** DSH Tooltip 文案；不要再用原生 `title`。 */
  tooltip?: string
}

/** 官方 Button 的薄包装：补 danger 变体与稳定钩子类。 */
export function ActionButton({ tone = 'ghost', size, icon, tooltip, className, children, type = 'button', ...rest }: ActionButtonProps) {
  const variant: ButtonVariant = tone === 'primary' ? 'primary' : tone === 'ghost' ? 'ghost' : 'outline'
  const classes = ['lt-btn', tone === 'danger' ? 'lt-btn-danger' : '', className ?? ''].filter(part => part !== '').join(' ')
  const button = (
    <Button
      variant={variant}
      type={type}
      {...(size === undefined ? {} : { size })}
      {...(icon === undefined ? {} : { icon })}
      className={classes}
      data-tone={tone}
      {...rest}
    >
      {children}
    </Button>
  )
  return tooltip === undefined ? button : <Tip label={tooltip}>{button}</Tip>
}

/** 关闭按钮。 */
export function CloseButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="lt-close" aria-label={label} onClick={onClick}>
      <IconCloseOutlineRegular size={14} />
    </button>
  )
}

/** 图标 + 文字的内联小块。 */
export function GlyphLabel({ icon, children, className }: { icon: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <span className={className === undefined ? 'lt-glyph' : `lt-glyph ${className}`}>
      {icon}
      {children}
    </span>
  )
}
