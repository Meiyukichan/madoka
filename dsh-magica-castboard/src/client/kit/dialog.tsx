/**
 * 对话框骨架与告警：Sheet / Confirm / useAlert。
 *
 * @module dsh-magica-castboard/client/kit/dialog
 */
import { IconWarningOutlineRegular, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useState, type ReactNode } from 'react'

import type { Translate } from '../labels/index.ts'
import { ActionButton } from './button.tsx'

/** 对话框宽度档。 */
export type SheetWidth = 'sm' | 'md' | 'lg' | 'wide'

/** 对话框参数。 */
export interface SheetProps {
  open: boolean
  onClose: () => void
  title: string
  hint?: string
  width?: SheetWidth
  className?: string
  bare?: boolean
  footer?: ReactNode
  children: ReactNode
}

/** 通用对话框外壳。 */
export function Sheet({ open, onClose, title, hint, width = 'md', className, bare = false, footer, children }: SheetProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      {...(hint !== undefined && hint !== '' ? { description: hint } : {})}
      {...(bare ? { headless: true as const } : { closeLabel: '关闭' })}
      className={`lt-sheet lt-sheet-${width}${className === undefined ? '' : ` ${className}`}`}
      contentClassName="lt-sheet-content"
      {...(footer === undefined ? {} : { footer })}
    >
      {children}
    </Modal>
  )
}

/** 确认对话框参数。 */
export interface ConfirmProps {
  title: string
  body: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
  danger?: boolean
}

/** 二次确认（取消在左且自动聚焦）。 */
export function Confirm({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel, danger = true }: ConfirmProps) {
  return (
    <Sheet
      open
      onClose={onCancel}
      title={title}
      hint={body}
      width="sm"
      className="lt-sheet-confirm"
      footer={(
        <>
          <ActionButton tone="outline" autoFocus onClick={onCancel}>{cancelLabel}</ActionButton>
          <ActionButton tone={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</ActionButton>
        </>
      )}
    >
      {null}
    </Sheet>
  )
}

/** 非阻塞告警：用 DSH 的顶部 Toast，而不是一个 Modal 外壳。 */
export function useAlert(_t: Translate): { alert: (message: string) => void; node: ReactNode } {
  const [message, setMessage] = useState<{ id: number; text: string } | null>(null)
  const node = message === null
    ? null
    : (
        <Toast
          key={message.id}
          text={message.text}
          icon={<IconWarningOutlineRegular size={16} />}
          holdMs={4500}
          onDone={() => { setMessage(null) }}
        />
      )
  const alert = useCallback((text: string) => {
    setMessage(current => ({ id: (current?.id ?? 0) + 1, text }))
  }, [])
  return { alert, node }
}
