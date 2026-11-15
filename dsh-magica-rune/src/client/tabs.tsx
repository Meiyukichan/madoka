/**
 * 两个 tab 共用一个参数化组件 `KindTab`（工具 / 技能视觉完全同构，
 * 只是数据源与分类规则不同 —— 见 docs/design/03 §3）。
 *
 * 关键：`stateOf(scope)` 返回该作用域的取值函数 —— 全局 zone 与工作区 zone 的
 * 生效态**不同**（工作区会覆盖全局），所以必须按 scope 取，不能共用一个。
 * @module dsh-magica-rune/client/tabs
 */

import { cls } from './styles.ts'
import { categorizeSkill, categorizeTool, groupRows, matchesRow, type CategorizedRow } from './categorize.ts'
import { GroupHead, Pill, SearchRow, Zone, type RowState } from './parts.tsx'
import type { AbilityKind, ScopeKind } from '../shared/ability.ts'

type Translate = (key: string, params?: Record<string, unknown>) => string

/** 分类标题：优先取字典 `cat.<分类>`，缺失时回退分类名本身。 */
function categoryLabel(t: Translate, category: string): string {
  const key = `cat.${category.toLowerCase()}`
  const text = t(key)
  return text === key ? category : text
}

export function KindTab(props: {
  kind: AbilityKind
  t: Translate
  rows: readonly CategorizedRow[]
  /** 按作用域取生效态。 */
  stateOf: (scope: ScopeKind) => (name: string) => RowState
  search: string
  onSearch: (text: string) => void
  globalOpen: boolean
  workspaceOpen: boolean
  onToggleGlobalZone: () => void
  onToggleWorkspaceZone: () => void
  workspaceId: string | undefined
  onToggle: (name: string, scope: ScopeKind) => void
  onBatch: (names: readonly string[], scope: ScopeKind) => void
  workspaceExtra: unknown
}) {
  const word = props.kind === 'tools' ? 'tools' : 'skills'
  const query = props.search.trim().toLowerCase()
  // 分类标识（`file`）与展示名（`文件操作`）都要能搜到——界面显示的是后者。
  const filtered = query === ''
    ? props.rows
    : props.rows.filter(row => matchesRow(row, query, categoryLabel(props.t, row.category)))

  const groups = groupRows(filtered, props.kind === 'tools' ? 'tools' : 'skills')
  const globalState = props.stateOf('global')
  const workspaceState = props.stateOf('workspace')
  const globalStates = filtered.map(row => globalState(row.name))
  const globalEnabled = globalStates.filter(state => state === 'enabled').length
  const workspaceStates = filtered.map(row => workspaceState(row.name))
  const workspaceEnabled = workspaceStates.filter(state => state === 'enabled').length

  const renderGroups = (scope: ScopeKind, stateOf: (name: string) => RowState) => {
    if (groups.length === 0) {
      const key = query === '' ? `empty.${word}` : `noResults.${word}`
      return <div className={cls.empty}>{props.t(key)}</div>
    }
    return (
      <div className={cls.scroll}>
        {groups.map(group => {
          const category = group.category
          return (
            <div className={cls.group} key={category} data-category={category}>
              <GroupHead
                category={category}
                label={categoryLabel(props.t, category)}
                states={group.rows.map(row => stateOf(row.name))}
                onBatch={() => props.onBatch(group.rows.map(row => row.name), scope)}
              />
              <ul className={cls.grid}>
                {group.rows.map(row => (
                  <Pill
                    key={row.name}
                    name={row.name}
                    description={row.description}
                    state={stateOf(row.name)}
                    category={category}
                    builtinLabel={props.t('tool.builtin')}
                    onClick={() => props.onToggle(row.name, scope)}
                  />
                ))}
              </ul>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className={cls.body}>
      {/*
       * 搜索行放在**两个 zone 之上**：它同时过滤全局与工作区两份列表。
       * raw §3.1 是「每个 zone 各自一份 List（含自己的搜索行）」= 两个搜索框；
       * 这里故意改成共享一个，因为两个框看起来像各管一半，实际语义是同一个过滤器。
       */}
      <SearchRow
        placeholder={props.t(`search.${word}`)}
        value={props.search}
        onChange={props.onSearch}
      />

      <Zone
        title={props.t('scope.global')}
        count={`${globalEnabled}/${globalStates.length}`}
        open={props.globalOpen}
        onToggle={props.onToggleGlobalZone}
      >
        {renderGroups('global', globalState)}
      </Zone>

      <Zone
        title={props.t('scope.workspace')}
        count={`${workspaceEnabled}/${workspaceStates.length}`}
        open={props.workspaceOpen}
        onToggle={props.onToggleWorkspaceZone}
        extra={props.workspaceExtra}
      >
        {props.workspaceId === undefined
          ? <div className={cls.empty}>{props.t('scope.placeholder')}</div>
          : renderGroups('workspace', workspaceState)}
      </Zone>
    </div>
  )
}

/** 工具行组装（剔除受保护项 + 打分类）。 */
export function toolRows(
  tools: readonly { name: string; description: string }[],
  isProtected: (name: string) => boolean,
  builtin: readonly string[],
): CategorizedRow[] {
  const rows: CategorizedRow[] = []
  for (const tool of tools) {
    if (isProtected(tool.name)) continue
    rows.push({
      name: tool.name,
      description: tool.description,
      category: categorizeTool(tool.name, builtin),
    })
  }
  return rows
}

/** 技能行组装。 */
export function skillRows(
  skills: readonly { name: string; description: string; source?: string }[],
  isProtected: (name: string) => boolean,
): CategorizedRow[] {
  const rows: CategorizedRow[] = []
  for (const skill of skills) {
    if (isProtected(skill.name)) continue
    rows.push({
      name: skill.name,
      description: skill.description,
      category: categorizeSkill(skill.name),
    })
  }
  return rows
}
