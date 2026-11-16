/**
 * 审批文案的本地化选择（纯 TS，可单测）。
 *
 * 0.2 的 `ApprovalRequestEvent.displayReason` 是 `{ en: string; [locale]: string }`
 * —— 宿主同时发多语言。0.1.6 的实现写死 `displayReason['zh']`，在英文界面上会把
 * 中文标题显示出来（a.md:788 的语义是"按当前语言取，取不到再退回"）。
 *
 * @module dsh-magica-spellbook/client/panel/display-text
 */

/** 宿主送来的多语言文案。 */
export type LocalizedReason = Readonly<Record<string, string>>

/**
 * 按当前界面语言挑文案。
 *
 * 顺序：`lang` → `lang` 的主语言（`en-US` → `en`）→ `en` → `zh` → 第一个非空值 → `fallback`。
 *
 * @param displayReason - 宿主的多语言文案（可能为 undefined）。
 * @param lang - 当前界面语言（如 `'zh-CN'`、`'en'`）；缺省按 `en` 处理。
 * @param fallback - 全都没有时的兜底（通常是 `reason` 或工具名）。
 */
export function pickDisplayText(
  displayReason: LocalizedReason | undefined,
  lang: string | undefined,
  fallback: string,
): string {
  if (displayReason === undefined) return fallback
  const normalized = (lang ?? '').trim().toLowerCase()
  const primary = normalized.split('-')[0] ?? ''
  for (const key of [normalized, primary, 'en', 'zh']) {
    if (key === '') continue
    const value = displayReason[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  for (const value of Object.values(displayReason)) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return fallback
}

/** 读当前文档语言（SSR / 无 document 时返回 `undefined`）。 */
export function currentLang(): string | undefined {
  if (typeof document === 'undefined') return undefined
  const lang = document.documentElement?.lang
  return typeof lang === 'string' && lang !== '' ? lang : undefined
}
