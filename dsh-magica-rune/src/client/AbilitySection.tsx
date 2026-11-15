/**
 * 根组件：「设置 → 能力管理」页（2 个 tab：工具 / 技能）。
 *
 * 契约（docs/design/03 §3）：
 * - `t` 由 slot 的 `locale: NS` 自动注入；
 * - `useStore` / `actions` 来自 `store:` seat（纯视图状态）；
 * - `useAbility` / `load` / `toggle` / `toggleBatch` 来自 `inject` 的 `hooks` 与回调（数据 + 写回）。
 *
 * 组件不接触 ctx，也不自行订阅 locale —— 语言切换由框架重投影，`t` 的引用会换新。
 * @module dsh-magica-rune/client/AbilitySection
 */

import { useEffect, useRef } from 'react'
import { cls, installStyles } from './styles.ts'
import { TABS, type AbilityViewState } from './store.ts'
import type { AbilityDataState } from './controller.ts'
import { isProtected } from './controller.ts'
import { DSH_BUILTIN_CATS } from './categorize.ts'
import { effectiveState, type AbilityKind, type ScopeKind } from '../shared/ability.ts'
import { KindTab, skillRows, toolRows } from './tabs.tsx'
import { ConfirmDisable, WorkspaceDropdown } from './parts.tsx'
import type { RowState } from './parts.tsx'

type Translate = (key: string, params?: Record<string, unknown>) => string

/**
 * `store:` 派生的 actions（措辞与 `store.ts` 的 `AbilityViewActions` 一致，但**去掉 draft**）。
 * 用具体接口而不是 `Record<string, fn>`：索引签名在 `noUncheckedIndexedAccess` 下
 * 会变成 `fn | undefined`，每个调用点都要 `!`，得不偿失。
 */
export interface AbilitySectionActions {
  selectTab(tab: AbilityKind): void
  toggleZone(zone: ScopeKind): void
  setSearch(kind: AbilityKind, text: string): void
  selectWorkspace(id: string): void
  setPending(pending: { kind: AbilityKind; name: string } | null): void
}

export interface AbilitySectionProps {
  t: Translate
  useStore: <T>(selector: (state: AbilityViewState) => T) => T
  actions: AbilitySectionActions
  useAbility: <T>(selector: (state: AbilityDataState) => T) => T
  load: (silent?: boolean) => Promise<void>
  toggle: (kind: AbilityKind, name: string, scope: ScopeKind, workspaceId?: string) => Promise<void>
  toggleBatch: (
    kind: AbilityKind, names: readonly string[], scope: ScopeKind, workspaceId?: string,
  ) => Promise<void>
}

/** 样式在模块工厂执行期注入一次（不是组件 render 里）。 */
installStyles()

export function AbilitySection(props: AbilitySectionProps) {
  const view = props.useStore(state => state)
  const data = props.useAbility(state => state)
  const translate: Translate = typeof props.t === 'function' ? props.t : key => key
  const actions = props.actions

  // 只加载一次：props.load 是 inject 工厂产出的，引用可能每次投影都变，
  // 直接依赖它会造成重复请求。
  const loaded = useRef(false)
  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    void props.load()
  }, [props.load])

  const builtin = new Set(data.builtinDisabled)
  const toolProtected = (name: string): boolean => isProtected(data.nonDisableable, name)
  const skillProtected = (name: string): boolean => isProtected(data.skillNonDisableable, name)

  const stateAt = (kind: AbilityKind, scope: ScopeKind) => (name: string): RowState =>
    effectiveState(
      data.value[kind], scope, name, builtin,
      scope === 'workspace' ? view.selectedWorkspaceId : undefined,
    )

  /** 点击药丸：DSH 内置分类在「全局 + 当前启用」时先弹确认。 */
  const makeToggle = (kind: AbilityKind) => (name: string, scope: ScopeKind): void => {
    const current = stateAt(kind, scope)(name)
    if (current === 'builtin') return
    if (kind === 'tools' && scope === 'global' && current === 'enabled') {
      const row = toolRows(data.tools, toolProtected, data.builtinDisabled).find(item => item.name === name)
      if (row !== undefined && DSH_BUILTIN_CATS.has(row.category)) {
        actions.setPending({ kind, name })
        return
      }
    }
    void props.toggle(kind, name, scope, scope === 'workspace' ? view.selectedWorkspaceId : undefined)
  }

  const makeBatch = (kind: AbilityKind) => (names: readonly string[], scope: ScopeKind): void => {
    void props.toggleBatch(
      kind, names, scope, scope === 'workspace' ? view.selectedWorkspaceId : undefined,
    )
  }

  const workspaceExtra = (): unknown => {
    if (data.workspaces.length === 0) return undefined
    return (
      <WorkspaceDropdown
        scopes={data.workspaces}
        selectedId={view.selectedWorkspaceId}
        placeholder={translate('scope.placeholder')}
        onSelect={id => actions.selectWorkspace(id)}
      />
    )
  }

  const renderTab = (kind: AbilityKind) => (
    <KindTab
      kind={kind}
      t={translate}
      rows={kind === 'tools'
        ? toolRows(data.tools, toolProtected, data.builtinDisabled)
        : skillRows(data.skills, skillProtected)}
      stateOf={scope => stateAt(kind, scope)}
      search={view.search[kind]}
      onSearch={text => actions.setSearch(kind, text)}
      globalOpen={view.globalOpen}
      workspaceOpen={view.workspaceOpen}
      onToggleGlobalZone={() => actions.toggleZone('global')}
      onToggleWorkspaceZone={() => actions.toggleZone('workspace')}
      workspaceId={view.selectedWorkspaceId}
      onToggle={makeToggle(kind)}
      onBatch={makeBatch(kind)}
      workspaceExtra={workspaceExtra()}
    />
  )

  const body = data.status === 'loading' || data.status === 'idle'
    ? <div className={cls.loading}>{translate('loading')}</div>
    : data.status === 'error'
      ? <div className={cls.error}>{`${translate('error')}${data.error === null ? '' : `：${data.error}`}`}</div>
      : renderTab(view.tab)

  const pending = view.pending

  return (
    <div className={cls.section}>
      <div className={cls.header}>
        <h2 className={cls.title}>{translate('nav')}</h2>
        <p className={cls.desc}>{translate('desc')}</p>
      </div>

      <div className={cls.tabs} role="tablist" aria-label={translate('nav')}>
        {TABS.map(key => (
          <button
            key={key}
            type="button"
            role="tab"
            className={cls.tab}
            aria-selected={view.tab === key ? 'true' : 'false'}
            data-active={view.tab === key ? 'true' : undefined}
            onClick={() => actions.selectTab(key)}
          >
            {translate(`tab.${key}`)}
          </button>
        ))}
      </div>

      {body}

      {pending === null ? null : (
        <ConfirmDisable
          title={translate('disable.title')}
          description={translate('disable.desc', { name: pending.name })}
          confirmLabel={translate('disable.confirm')}
          cancelLabel={translate('disable.cancel')}
          closeLabel={translate('close')}
          onCancel={() => actions.setPending(null)}
          onConfirm={() => {
            const target = pending
            actions.setPending(null)
            void props.toggle(target.kind, target.name, 'global')
          }}
        />
      )}
    </div>
  )
}
