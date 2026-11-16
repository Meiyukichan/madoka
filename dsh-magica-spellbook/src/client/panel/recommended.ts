/**
 * 选项标签里的"推荐"标记解析（纯 TS，可单测）。
 *
 * dsh 的约定是**在标签文本里**标注推荐项（`AskUserQuestionItem.options[].label`
 * 建议"把推荐项放第一位并在末尾加 `(Recommended)`"）。0.1.6 的实现据此解析出
 * "纯标签 + 是否推荐"，这样徽标能单独渲染、答回去的仍是**纯标签**
 * （宿主按 label 精确匹配，带后缀会答非所问）。
 *
 * @module dsh-magica-spellbook/client/panel/recommended
 */

const SUFFIXES = ['(Recommended)', '（推荐）', '(推荐)', ' (Recommended)']

/**
 * 拆出推荐标记。
 * @param label - 原始选项标签。
 * @returns `clean` 去掉后缀的标签，`recommended` 是否被标为推荐。
 */
export function parseRecommended(label: string): { clean: string; recommended: boolean } {
  const trimmed = label.trimEnd()
  for (const suffix of SUFFIXES) {
    if (!trimmed.endsWith(suffix)) continue
    const clean = trimmed.slice(0, trimmed.length - suffix.length).trimEnd()
    if (clean === '') break
    return { clean, recommended: true }
  }
  return { clean: label, recommended: false }
}
