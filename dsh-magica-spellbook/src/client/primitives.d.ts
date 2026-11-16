/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的最小类型面。
 *
 * 该包由 shell 模块表注入（构建期 external），本包不依赖它的 npm 包，
 * 所以只在此声明我们用到的几个组件签名（与 0.2 的组件目录一致）。
 *
 * @module dsh-magica-spellbook/client/primitives
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType, ReactElement, ReactNode } from 'react'

  /** 按钮（0.2 的 variant 多了 `toolbar`）。 */
  export const Button: ComponentType<{
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    onClick?: () => void
    disabled?: boolean
    className?: string
    icon?: ReactNode
    children?: ReactNode
    type?: 'button' | 'submit'
    title?: string
  }>

  /** 对话框（`headless` 时自绘 chrome）。 */
  export const Modal: ComponentType<{
    open: boolean
    onClose?: () => void
    title?: string
    className?: string
    headless?: boolean
    children?: ReactNode
  }>

  /** GitHub 风格 Markdown 渲染（0.2 的 `labels` 必填）。 */
  export const MarkdownText: ComponentType<{
    text: string
    labels: { code: { copyLabel: string; copiedLabel: string }; footnotes: string }
    variant?: 'body' | 'compact'
    className?: string
  }>

  /** 图标（按需取用）。 */
  export const IconCheckOutline14: ComponentType<{ size?: number; className?: string }>
  export const IconCheckOutline16: ComponentType<{ size?: number; className?: string }>
  export const IconChevronLeftOutline14: ComponentType<{ size?: number; className?: string }>
  export const IconChevronRightOutline14: ComponentType<{ size?: number; className?: string }>
  export const IconChevronUpOutline14: ComponentType<{ size?: number; className?: string }>
  export const IconChevronDownOutline14: ComponentType<{ size?: number; className?: string }>
  export const IconCloseOutline16: ComponentType<{ size?: number; className?: string }>
  export const IconEditOutline16: ComponentType<{ size?: number; className?: string }>
  export const IconFolderOpen16: ComponentType<{ size?: number; className?: string }>
  export const IconFolderClose16: ComponentType<{ size?: number; className?: string }>
  export const IconPlusOutline16: ComponentType<{ size?: number; className?: string }>

  export type { ReactElement }
}
