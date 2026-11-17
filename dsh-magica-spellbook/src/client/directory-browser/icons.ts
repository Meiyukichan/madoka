/**
 * `DirectoryBrowser` 用到的图标（**值来自 `@deepseek-ai/dsh-client-ui-primitives` 的真实组件**）。
 *
 * 为什么这个文件在 `directory-browser/` 里、而不是复用 `../panel/icons.tsx`：
 * 包的 `files` 只发布 `lib` + `src/client/directory-browser`（不发布整个 `src`），
 * 而 `exports["./directory-browser"]` 直接指向这里的 `.tsx`。所以要保证**这个目录自包含**——
 * 跨目录相对 import 会在消费方编译时直接断掉。`panel/icons.tsx` 会被打进 `lib/client.js`，
 * 不需要出现在发布源码里。
 *
 * ⚠️ 上游缺陷（primitives@0.2.0-rc.2）：`lib/types/index.d.ts` 写 `export * from './icons/index.tsx'`，
 * 但发布物里没有 `lib/types/icons/index.tsx`，所以 `Icon*` 在**类型面**不可达（TS2305；
 * 走 `lib/types/icons/index.d.ts` 又被 `exports` 挡成 TS2307）。而这些图标在 `lib/index.js` 里
 * **运行时就存在**。因此：值照常从真实包取（external，不进 bundle），
 * 类型只补"这些导出存在且 props 是 size/className"（与真实 `IconProps` 同形，不重写 dsh 语义）。
 * 上游补发布后，本文件可退化成 `export * from '@deepseek-ai/dsh-client-ui-primitives'`。
 *
 * @module dsh-magica-spellbook/client/directory-browser/icons
 */

import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentType } from 'react'

/** 图标组件类型面（同 dsh `IconProps`）。 */
export type IconProps = { size?: number; className?: string }

type RealIcon = ComponentType<IconProps>

interface RealIcons {
  IconCheckOutlineRegular: RealIcon
  IconChevronRightOutlineRegular: RealIcon
  IconEditOutlineRegular: RealIcon
  IconFolderCloseRegular: RealIcon
  IconFolderOpenRegular: RealIcon
  IconPlusOutlineRegular: RealIcon
}

const icons = primitives as unknown as RealIcons

export const {
  IconCheckOutlineRegular,
  IconChevronRightOutlineRegular,
  IconEditOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  IconPlusOutlineRegular,
}: RealIcons = icons
