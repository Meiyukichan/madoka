/**
 * 内联图标（代替 `@deepseek-ai/dsh-client-ui-primitives` 的 `Icon*Outline*`）。
 *
 * 为什么自己画：0.2 的 primitives **不再导出任何 `Icon*` 组件**（`lib/types/index.d.ts` 里只有
 * Button / Pill / Tag / Modal / Menu 等），我们若继续 `import { IconCheckOutline14 }`
 * 拿到的是 `undefined`，渲染时 React 直接抛 #130（element type is invalid）——
 * 真机表现为"输入框选择框整块崩掉"。
 *
 * 这些图标只用 `currentColor` 描边，尺寸由 `size` 决定，天然适配浅深色主题。
 *
 * @module dsh-magica-spellbook/client/panel/icons
 */

import type { SVGProps } from 'react'

/** 图标的公共 props。 */
export interface InteractionIconProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size?: number
}

/** 去掉 `size`，把其余 SVG props 原样传下去。 */
function withoutSize(props: InteractionIconProps): Omit<InteractionIconProps, 'size'> {
  const { size, ...rest } = props
  void size
  return rest
}

function stroke(props: InteractionIconProps): SVGProps<SVGSVGElement> {
  const size = props.size ?? 14
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
    ...withoutSize(props),
  }
}

export function IconCheckOutline14(props: InteractionIconProps) {
  return (
    <svg {...stroke(props)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export function IconCheckOutline16(props: InteractionIconProps) {
  return <IconCheckOutline14 {...props} size={props.size ?? 16} />
}

export function IconChevronDownOutline14(props: InteractionIconProps) {
  return (
    <svg {...stroke(props)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export function IconChevronUpOutline14(props: InteractionIconProps) {
  return (
    <svg {...stroke(props)}>
      <path d="m18 15-6-6-6 6" />
    </svg>
  )
}

export function IconChevronLeftOutline14(props: InteractionIconProps) {
  return (
    <svg {...stroke(props)}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}

export function IconChevronRightOutline14(props: InteractionIconProps) {
  return (
    <svg {...stroke(props)}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

export function IconCloseOutline16(props: InteractionIconProps) {
  return (
    <svg {...stroke({ ...props, size: props.size ?? 16 })}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

export function IconEditOutline16(props: InteractionIconProps) {
  return (
    <svg {...stroke({ ...props, size: props.size ?? 16 })}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

export function IconPlusOutline16(props: InteractionIconProps) {
  return (
    <svg {...stroke({ ...props, size: props.size ?? 16 })}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function IconFolderClose16(props: InteractionIconProps) {
  return (
    <svg {...stroke({ ...props, size: props.size ?? 16 })}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  )
}

export function IconFolderOpen16(props: InteractionIconProps) {
  return (
    <svg {...stroke({ ...props, size: props.size ?? 16 })}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3Z" />
      <path d="M3 10h18l-2 8H5Z" />
    </svg>
  )
}

export function IconLoadingOutline16(props: InteractionIconProps) {
  return (
    <svg {...stroke({ ...props, size: props.size ?? 16 })}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  )
}
