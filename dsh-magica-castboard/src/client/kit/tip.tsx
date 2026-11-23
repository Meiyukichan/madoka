/**
 * 面板统一的悬浮提示：直接使用 DSH primitives 的 Tooltip，
 * 保证延迟、定位、材质和键盘焦点行为与 shell 完全一致。
 *
 * @module dsh-magica-castboard/client/kit/tip
 */
import { Tooltip, type TooltipSide } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactElement } from 'react'

type TooltipAnchor = Parameters<typeof Tooltip>[0]['children']

/** 包一层 DSH Tooltip；默认在锚点右侧，与 shell 一致，`portal` 让提示不被看板列的 overflow 裁掉。 */
export function Tip({ label, children, side = 'right', align = 'center' }: {
  label: string
  children: ReactElement
  side?: TooltipSide
  align?: 'center' | 'end'
}) {
  return (
    <Tooltip label={label} side={side} align={align} portal>
      {children as TooltipAnchor}
    </Tooltip>
  )
}
