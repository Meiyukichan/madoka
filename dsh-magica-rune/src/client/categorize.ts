/**
 * 分类 / 分组 / 配色（纯函数，照抄 docs/raw/a.md §6，可单测）。
 *
 * 名字来源：工具接口只给 `{ name, description }`，**没有 category 字段**，
 * 所以分类纯靠名字推断。技能用连字符前缀规则。
 * @module dsh-magica-rune/client/categorize
 */

/**
 * 固定分类及其展示顺序（动态分类排在它们之前，组间按字母序）。
 *
 * 相对 raw 增补了 `web` / `workflow` / `plugin` 三个 dsh 原生分类：
 * raw 是 dsh-minecraft，把 web_search/web_fetch/workflow 放在 `builtinDisabled` 里，
 * 所以它们只会落进 `builtin`；rune 默认不砍原生能力（builtinDisabled 为空），
 * 必须给它们各自的归属，否则会被误判成动态分类（Web / Workflow）。
 */
export const FIXED_CATS: readonly string[] = [
  'plugin-other', 'mcp', 'web', 'plugin', 'workflow',
  'file', 'shell', 'image', 'agent', 'job', 'goal', 'ralph', 'cordis', 'misc', 'builtin',
]

/**
 * dsh 原生分类：圆点统一用 warn 橙，且禁用前要二次确认。
 *
 * 这就是「是不是所有内置工具一个颜色」的答案：**是**——raw §6.3 的 `catColor`
 * 对 DSH_BUILTIN_CATS 一律返回 `--dsw-alias-state-warn-primary`，颜色不承担
 * 区分子类的职责（子类由分组的名称 + 位置表达），只承担「这是 dsh 原件」的信号。
 */
export const DSH_BUILTIN_CATS: ReadonlySet<string> = new Set<string>([
  'web', 'plugin', 'workflow', 'file', 'shell', 'image', 'agent',
  'job', 'goal', 'ralph', 'cordis', 'misc', 'builtin',
])

const FILE_TOOLS = ['read', 'write', 'edit', 'glob', 'grep']
const SHELL_TOOLS = ['pwsh', 'bash']
const IMAGE_TOOLS = ['read_image', 'describe_image']
const AGENT_TOOLS = [
  'list_agents', 'subagent', 'subagent_fork', 'named_subagent', 'send_message', 'interrupt_agent',
]
const MISC_TOOLS = ['ask_user_question', 'skill', 'todo_write', 'exit_plan_mode', 'present']
const WEB_TOOLS = ['web_search', 'web_fetch']
const WORKFLOW_TOOLS = ['workflow']
const PLUGIN_TOOLS = ['plugin_manager']

/** 工具名 → 分类。 */
export function categorizeTool(name: string, builtin: readonly string[]): string {
  if (builtin.includes(name)) return 'builtin'
  if (FILE_TOOLS.includes(name)) return 'file'
  if (SHELL_TOOLS.includes(name)) return 'shell'
  if (IMAGE_TOOLS.includes(name)) return 'image'
  if (AGENT_TOOLS.includes(name)) return 'agent'
  if (WEB_TOOLS.includes(name)) return 'web'
  if (WORKFLOW_TOOLS.includes(name)) return 'workflow'
  if (PLUGIN_TOOLS.includes(name)) return 'plugin'
  if (name.startsWith('job_')) return 'job'
  if (['create_goal', 'get_goal', 'update_goal'].includes(name)) return 'goal'
  if (name === 'ralph') return 'ralph'
  if (name.startsWith('cordis_')) return 'cordis'
  if (MISC_TOOLS.includes(name)) return 'misc'
  if (name.startsWith('mcp__')) return 'mcp'
  const cut = name.indexOf('_')
  if (cut > 0) return capitalize(name.slice(0, cut))
  return 'plugin-other'
}

/** 技能名 → 分类：连字符前缀（`gc-brainstorming → Gc`）。 */
export function categorizeSkill(name: string): string {
  const cut = name.indexOf('-')
  if (cut > 0) return capitalize(name.slice(0, cut))
  return capitalize(name)
}

function capitalize(value: string): string {
  if (value === '') return 'misc'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** 分类圆点的调色板（第 5 项由 raw 的 brand-primary 换成 0.2 的品牌蓝）。 */
const CAT_PALETTE: readonly string[] = [
  'var(--dsw-alias-state-business-primary)',
  'var(--dsw-alias-state-warn-primary)',
  'var(--dsw-alias-state-success-primary)',
  'var(--dsw-alias-state-error-primary)',
  'var(--dsw-alias-state-business-primary)',
  'var(--dsw-alias-label-caption)',
]

/** 分类 → 圆点颜色（同分类多次渲染稳定）。 */
export function catColor(category: string): string {
  if (DSH_BUILTIN_CATS.has(category)) return 'var(--dsw-alias-state-warn-primary)'
  if (category === 'mcp') return 'var(--dsw-alias-state-business-primary)'
  if (category === 'plugin-other') return 'var(--dsw-alias-label-tertiary)'
  let hash = 0
  for (const character of category) hash = (hash * 31 + character.charCodeAt(0)) & 0xffff
  return CAT_PALETTE[hash % CAT_PALETTE.length] ?? CAT_PALETTE[0]!
}

/** 一行（工具或技能）。 */
export interface CategorizedRow {
  name: string
  description: string
  category: string
}

/** 一个分组：分类标识 + 组内行（行内仍带原始 category，仅作展示/调试用）。 */
export interface RowGroup {
  category: string
  rows: CategorizedRow[]
}

/**
 * 聚合 + 排序：
 * 1. 动态分类（不在 `FIXED_CATS`）里 < 2 个的并入 `plugin-other`（技能并入 `misc`）
 * 2. 动态分类排在前（组间字母序），其余按 `FIXED_CATS` 顺序
 *
 * 注意返回的分组**带自己的 category**：被并入的行仍保留原始 `row.category`，
 * 所以调用方绝不能用 `rows[0].category` 当分组标签。
 */
export function groupRows(rows: readonly CategorizedRow[], mode: 'tools' | 'skills'): RowGroup[] {
  const bucket = new Map<string, CategorizedRow[]>()
  for (const row of rows) {
    const list = bucket.get(row.category)
    if (list === undefined) bucket.set(row.category, [row])
    else list.push(row)
  }
  const mergeTarget = mode === 'tools' ? 'plugin-other' : 'misc'
  for (const [category, list] of [...bucket]) {
    if (FIXED_CATS.includes(category)) continue
    if (list.length >= 2) continue
    bucket.delete(category)
    const target = bucket.get(mergeTarget)
    if (target === undefined) bucket.set(mergeTarget, [...list])
    else target.push(...list)
  }
  const dynamic = [...bucket.keys()].filter(category => !FIXED_CATS.includes(category)).sort()
  const fixed = FIXED_CATS.filter(category => bucket.has(category))
  return [...dynamic, ...fixed].map(category => ({
    category,
    rows: [...(bucket.get(category) ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
  }))
}

/** 组内计数 `N/M` 与「是否全启用」。 */
export function groupCount(states: readonly ('enabled' | 'disabled' | 'builtin')[]): {
  enabled: number
  total: number
  allEnabled: boolean
  someEnabled: boolean
} {
  let enabled = 0
  for (const state of states) if (state === 'enabled') enabled += 1
  return {
    enabled,
    total: states.length,
    allEnabled: enabled === states.length && states.length > 0,
    someEnabled: enabled > 0 && enabled < states.length,
  }
}

/**
 * 搜索匹配：工具名、分类**标识**（`file`）、分类**展示名**（`文件操作`）三者任一命中。
 * 展示名要由调用方按当前语言传进来（`categoryLabel(t, row.category)`）。
 */
export function matchesRow(row: CategorizedRow, query: string, label: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return row.name.toLowerCase().includes(q)
    || row.category.toLowerCase().includes(q)
    || label.toLowerCase().includes(q)
}