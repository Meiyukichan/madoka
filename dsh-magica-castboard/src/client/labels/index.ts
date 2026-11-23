/**
 * 语言包入口：命名空间、两份字典、无 React 上下文的兜底翻译。
 *
 * @module dsh-magica-castboard/client/labels
 */
import { en } from './en.ts'
import { zh } from './zh.ts'

/** locale 命名空间。 */
export const NS = 'castboard'

/** 翻译函数（`{name}` 占位符）。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string

export { en, zh }

/**
 * 组件容器之外的兜底翻译（store 里的提示文案用）。
 *
 * 组件一律用 slot 注入的 `t`；这个函数只服务「没有 React 上下文」的角落，读一次
 * 当前 `<html lang>`，不写偏好。
 */
export function translate(key: string, params?: Record<string, string | number>): string {
  let lang: 'zh' | 'en' = 'zh'
  try {
    if (typeof document !== 'undefined' && document.documentElement.lang.toLowerCase().startsWith('en')) lang = 'en'
  } catch { /* 无 DOM */ }
  const dict = lang === 'en' ? en : zh
  const value = (dict as Record<string, string>)[key] ?? (zh as Record<string, string>)[key] ?? key
  if (params === undefined) return value
  return value.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
}
