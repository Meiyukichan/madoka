/**
 * 目录选择器的**纯**过滤/导航辅助（不碰 React，Node 里可单测）。
 *
 * 口径来自 `a.md` 的预览需求：用户在路径输入框里打字时，**只过滤当前列**，
 * 不发起任何网络请求（预览腿在 0.2 里明确不做，见 `05-conformance-client.md` Round 10 记录）。
 *
 * @module dsh-magica-spellbook/client/directory-browser/filter
 */

/** 目录条目（与 `DirectoryListing.entries` 兼容的最小子集）。 */
export interface FilterEntry {
  name: string
  path: string
  hidden?: boolean
}

/**
 * 从草稿路径里取"当前列的前缀"。
 *
 * 规则：取最后一段（`/` 或 `\` 之后）。整段是分隔符/空串时返回空串（= 不过滤）。
 * Windows 盘符根（`D:\`）的尾段也是空串。
 *
 * @param draft - 输入框里的草稿路径。
 * @returns 需要匹配的前缀（已 trim，保持原大小写由调用方决定）。
 */
export function tailPrefixOf(draft: string): string {
  const cut = Math.max(draft.lastIndexOf('/'), draft.lastIndexOf('\\'))
  return cut < 0 ? draft.trim() : draft.slice(cut + 1).trim()
}

/**
 * 编辑草稿相对**当前层目录**的前缀（等价于 0.1.6 `readDraft` 的关键分支）。
 *
 * 为什么需要它：点铅笔时会把**完整路径**填进草稿（`D:\p\src`）。若直接用
 * `tailPrefixOf` 取最后一段，前缀变成 `p`（Windows 反斜杠场景下会被拼成
 * `D:\p` 的尾段），当前列 `src` 一个都匹配不上 → **一进编辑列表就空**。
 *
 * 规则：
 * - 草稿就是当前层目录本身（或只多了个尾部斜杠）→ 前缀为空（不过滤）；
 * - 草稿是当前层目录的子串（`dir\abc`）→ 前缀是剩余那段的**第一段**；
 * - 其余情况（用户在输入完全不同的路径）→ 退回 `tailPrefixOf`。
 *
 * @param dir - 当前层目录（`listing.path`）。
 * @param draft - 输入框里的草稿路径。
 */
export function prefixWithin(dir: string | undefined, draft: string): string {
  const base = (dir ?? '').trim().replace(/[\\/]+$/, '')
  if (base !== '' && draft.startsWith(base)) {
    const rest = draft.slice(base.length)
    if (rest === '' || /^[\\/]/.test(rest)) {
      const tail = rest.replace(/^[\\/]+/, '')
      const cut = Math.max(tail.indexOf('/'), tail.indexOf('\\'))
      return (cut < 0 ? tail : tail.slice(0, cut)).trim()
    }
  }
  return tailPrefixOf(draft)
}

/**
 * 按前缀过滤条目。
 *
 * @param entries - 当前列条目。
 * @param prefix - 前缀；空串表示不过滤。
 * @param showHidden - 是否显示隐藏项。
 * @param selectedPath - 当前选中项的路径（**始终保留**，避免选中项被过滤掉导致焦点丢失）。
 * @param caseInsensitive - 是否忽略大小写（Windows 习惯；默认忽略）。
 */
export function filterEntries<T extends FilterEntry>(
  entries: readonly T[],
  prefix: string,
  showHidden: boolean,
  selectedPath?: string,
  caseInsensitive = true,
): T[] {
  const needle = caseInsensitive ? prefix.toLocaleLowerCase() : prefix
  return entries.filter((entry) => {
    if (!showHidden && entry.hidden === true) return false
    if (needle === '') return true
    if (selectedPath !== undefined && entry.path === selectedPath) return true
    const name = caseInsensitive ? entry.name.toLocaleLowerCase() : entry.name
    return name.startsWith(needle)
  })
}
