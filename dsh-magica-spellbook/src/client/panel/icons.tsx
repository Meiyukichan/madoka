/**
 * 图标薄层：图标**值是 `@deepseek-ai/dsh-client-ui-primitives` 的真实组件**，这里只是转出，
 * 不再自绘任何 `<svg>`。
 *
 * 0.2 的图标命名是 `IconXxxOutlineRegular` / `IconXxxOutlineMedium`
 * （`lib/types/icons/index.d.ts`），props 是 `IconProps { size?: number; className?: string }`，
 * 尺寸默认值由字形自带（chevron 14px，其余 16px）。
 *
 * ⚠️ 为什么这里还有一处类型声明（唯一一处）：
 * `0.2.0-rc.2` 的 `lib/types/index.d.ts` 写的是 `export * from './icons/index.tsx'`，但发布物的
 * `files` 只有 `lib/index.js` / `lib/**\/*.css` / `lib/types/**\/*.d.ts` —— 它引用的
 * `lib/types/icons/index.tsx` **没有发布**，于是图标在类型面上不可达：
 * - `import { IconCheckOutlineRegular } from '…/dsh-client-ui-primitives'` → TS2305（没有该导出）；
 * - 直接从 `…/lib/types/icons/index.d.ts` 取 → 被 `exports` 映射挡住（TS2307）。
 *
 * 而这些图标在 `lib/index.js` 里**运行时确实存在且可用**（本层逐个核对过）。所以：
 * - 值：照常从同一条 bare specifier 取，永远是宿主模块表提供的真实组件（external，不打进 bundle）；
 * - 类型：只补"这些导出存在，且 props 是 `size`/`className`"这一件事（**不重写**任何 dsh 语义形状）。
 *
 * 上游修好（发布 `icons/index.d.ts` 或改成 `export * from './icons/index.d.ts'`）后，
 * 删掉 `RealIcon` 即可直接 `export * from '@deepseek-ai/dsh-client-ui-primitives'`。
 *
 * @module dsh-magica-spellbook/client/panel/icons
 */

import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentType } from 'react'

/** 图标组件的类型面（与 dsh `IconProps` 同形，仅用于让 JSX 见到真实组件）。 */
type RealIcon = ComponentType<{ size?: number; className?: string }>

/** 见文件头注释：运行时存在、类型面缺失的图标。 */
interface RealIcons {
  IconCheckOutlineRegular: RealIcon
  IconChevronDownOutlineRegular: RealIcon
  IconChevronLeftOutlineRegular: RealIcon
  IconChevronRightOutlineRegular: RealIcon
  IconChevronUpOutlineRegular: RealIcon
  IconCloseOutlineRegular: RealIcon
  IconEditOutlineRegular: RealIcon
  IconFolderCloseRegular: RealIcon
  IconFolderOpenRegular: RealIcon
  IconLoadingOutlineRegular: RealIcon
  IconPlusOutlineRegular: RealIcon
}

const icons = primitives as unknown as RealIcons

export const {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconChevronUpOutlineRegular,
  IconCloseOutlineRegular,
  IconEditOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  IconLoadingOutlineRegular,
  IconPlusOutlineRegular,
}: RealIcons = icons

/** 图标 props（同 dsh `IconProps`）。 */
export type IconProps = { size?: number; className?: string }
