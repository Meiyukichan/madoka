/**
 * 选项标签里的"推荐"标记解析（纯 TS，可单测）。
 *
 * dsh 的约定是**在标签文本里**标注推荐项（`AskUserQuestionItem.options[].label`
 * 建议"把推荐项放第一位并在末尾加 `(Recommended)`"）。这里据此解析出
 * "纯标签 + 是否推荐"，这样徽标能单独渲染、答回去的仍是**纯标签**
 * （宿主按 label 精确匹配，带后缀会答非所问）。
 *
 * 口径是 旧实现 与 spellbook 的**并集**（diff C9 / D9）：大小写不敏感、半角/全角括号、
 * 英文/中文后缀都认；同时保留"空标签保护"——整条标签只有后缀时回退原文，不返回空串。
 *
 * @module dsh-magica-spellbook/client/panel/recommended
 */

const SUFFIX = /\s*(?:\(\s*recommended\s*\)|（\s*recommended\s*）|\(\s*推荐\s*\)|（\s*推荐\s*）)\s*$/i

/**
 * 拆出推荐标记。
 * @param label - 原始选项标签。
 * @returns `clean` 去掉后缀的标签，`recommended` 是否被标为推荐。
 */
export function parseRecommended(label: string): { clean: string; recommended: boolean } {
  const match = SUFFIX.exec(label)
  if (match === null) return { clean: label, recommended: false }
  const clean = label.slice(0, match.index).trimEnd()
  if (clean === '') return { clean: label, recommended: false }
  return { clean, recommended: true }
}
