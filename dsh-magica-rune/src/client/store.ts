/**
 * 视图 store（纯同步状态：当前 tab、搜索词、折叠态、选中工作区、待确认项）。
 *
 * 用 0.2 的 `defineStore`（`@deepseek-ai/dsh-client-store`）：
 * `actions` 是**纯 draft 变更，不能 async** —— 网络/写回都在 controller 里。
 * 组件通过 `props.useStore(selector)` 读、`props.actions.xxx()` 写，
 * 业务组件里不应出现 `useSyncExternalStore`。
 * @module dsh-magica-rune/client/store
 */

import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { AbilityKind } from '../shared/ability.ts'

/** 只有两个 tab。 */
export const TABS: readonly AbilityKind[] = ['tools', 'skills']

export interface AbilityViewState {
  tab: AbilityKind
  /** 全局 zone 默认展开。 */
  globalOpen: boolean
  /** 工作区 zone 默认折叠。 */
  workspaceOpen: boolean
  search: Record<AbilityKind, string>
  selectedWorkspaceId: string | undefined
  /** 非 null 时渲染二次确认弹窗。 */
  pending: { kind: AbilityKind; name: string } | null
}

type AbilityViewActions = {
  selectTab(d: AbilityViewState, tab: AbilityKind): void
  toggleZone(d: AbilityViewState, zone: 'global' | 'workspace'): void
  setSearch(d: AbilityViewState, tab: AbilityKind, text: string): void
  selectWorkspace(d: AbilityViewState, id: string): void
  setPending(d: AbilityViewState, pending: AbilityViewState['pending']): void
}

/** 工厂形式传给 slot 的 `store:`（root scope 每个 entry 一份实例）。 */
export function createAbilityViewStore() {
  return defineStore<AbilityViewState, AbilityViewActions>({
    init: (): AbilityViewState => ({
      tab: 'tools',
      globalOpen: true,
      workspaceOpen: false,
      search: { tools: '', skills: '' },
      selectedWorkspaceId: undefined,
      pending: null,
    }),
    actions: {
      selectTab: (d, tab) => { d.tab = tab },
      toggleZone: (d, zone) => {
        if (zone === 'global') d.globalOpen = !d.globalOpen
        else d.workspaceOpen = !d.workspaceOpen
      },
      setSearch: (d, tab, text) => { d.search[tab] = text },
      selectWorkspace: (d, id) => { d.selectedWorkspaceId = id; d.workspaceOpen = true },
      setPending: (d, pending) => { d.pending = pending },
    },
  })
}
