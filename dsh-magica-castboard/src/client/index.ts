/**
 * Client 半侧入口：只做装配 —— 建 store、注册语言包与样式、把两个 slot 接上。
 *
 * @module dsh-magica-castboard/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'

import { createElement } from 'react'

import { PanelPage } from './app/panel-page.tsx'
import { InteractionRow } from './features/interactions/card.tsx'
import { AuthGate } from './features/auth/gate.tsx'
import { InteractionOverlay } from './features/interactions/overlay.tsx'
import { installConversationInteractions } from './features/interactions/conversation.ts'
import { SidebarIcon } from './app/sidebar-icon.tsx'
import { TeamworkIcon } from './app/teamwork-icon.tsx'
import { TeamworkPage } from './features/teamwork/page.tsx'
import { installPanelStyles } from './design/index.ts'
import type { ModelCatalogView, PromptCompletions, WorkspaceRow } from './data/index.ts'
import { BoardStore } from './data/state/index.ts'
import { Lanes } from './features/board/page.tsx'
import { NS, en, zh } from './labels/index.ts'

/** client 插件名。 */
export const name = '@meiyukichan/dsh-magica-castboard/client'

/** 面板 id（侧栏入口与 main 的 key 必须一致）。 */
export const PANEL_ID = 'castboard'
/** 项目管理面板 id。 */
export const TEAMWORK_PANEL_ID = 'teamwork'

/** Cordis 服务依赖：导航必须等 `uiWorkspace` 就绪（与 shell 官方插件同一写法）。 */
export const inject = ['slots', 'locale', 'sessions', 'uiSession', 'uiWorkspace'] as const

interface SlotsFace {
  inject(key: string, callback: () => () => void): void
  register(options: Record<string, unknown>, component: unknown): () => void
}
interface LocaleFace {
  register(ns: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(ns: string, params?: never): (key: string, params?: Record<string, string | number>) => string
}
interface Work {
  list: {
    getSnapshot(): { items: readonly { workspaceId: string; title?: string; path?: string; sessionIds: readonly string[] }[]; archivedSessionIds?: readonly string[] }
    subscribe?(listener: () => void): () => void
  }
}
interface SessionService {
  binding?(sessionId: string): {
    session?: { projections: { faceOf(name: string): { getSnapshot(): unknown } } }
  } | undefined
  subagentAddress?(id: string): unknown
  refresh(): Promise<void>
  list: { getSnapshot(): { current?: string; byId: Record<string, { origin?: string } | undefined> } }
}
/** 0.2 shell 的会话归档面（`uiWorkspace` 服务）。 */
interface WorkspaceArchiveFace {
  archiveSession?(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
  /** 0.2 navigation owner: select a session, or a subagent address, and show it. */
  openSession?(target: unknown): void
}
interface Ctx {
  slots: SlotsFace
  locale: LocaleFace
  effect(callback: () => () => void, label?: string): void
  get?(name: string): unknown
  inject?(services: readonly string[], callback: (scope: Ctx) => void): unknown
  on?(event: string, callback: (...args: never[]) => void): unknown
  [key: string]: unknown
}

function serviceOf<T>(scope: Ctx, name: string): T | undefined {
  const viaGet = scope.get?.(name) as T | undefined
  if (viaGet !== undefined) return viaGet
  return scope[name] as T | undefined
}

interface ModelCatalogResponse {
  ok: boolean
  value?: {
    default?: { provider: string; model: string }
    groups: readonly { id: string; name: string; models: readonly { id: string; name?: string }[] }[]
    failures?: readonly { id?: string; name?: string; message?: string }[]
  }
}

interface SlashRemote {
  skills?: {
    list(request: { sessionId: string }, signal?: AbortSignal): Promise<{
      ok: boolean
      value?: { skills: readonly { name: string; description?: string }[] }
    }>
  }
  commands?: {
    list(sessionId: string): Promise<{
      ok: boolean
      value?: readonly { name: string; description?: string; input?: { hint?: string } }[]
    }>
  }
}

interface SessionsListFace {
  list: { getSnapshot(): { current?: string; byId: Record<string, unknown> } }
}

interface WorkspacesListFace {
  list: { getSnapshot(): { items: readonly { workspaceId: string; sessionIds: readonly string[] }[] } }
}

/** 读取项目快照（永不抛）。 */
function readWorkspaces(service: Work | undefined): WorkspaceRow[] {
  if (service === undefined) return []
  try {
    return service.list.getSnapshot().items.map(item => ({
      id: item.workspaceId,
      path: item.path ?? '',
      title: item.title ?? item.path ?? item.workspaceId,
      sessionCount: item.sessionIds.length,
    }))
  } catch {
    return []
  }
}

function bindPermissionPreset(client: Ctx, store: BoardStore): void {
  const install = (scope: Ctx): void => {
    const sessions = serviceOf<SessionService>(scope, 'sessions')
    store.installPermissionPreset(() => {
      try {
        const current = sessions?.list.getSnapshot().current
        if (sessions?.binding === undefined || current === undefined || current === '') return undefined
        const value = sessions.binding(current)?.session?.projections.faceOf('permissions').getSnapshot() as
          | { currentValue?: unknown }
          | undefined
        return typeof value?.currentValue === 'string' && value.currentValue !== '' ? value.currentValue : undefined
      } catch {
        return undefined
      }
    })
  }
  if (typeof client.inject === 'function') client.inject(['sessions'], install)
  else install(client)
}

function bindModelCatalog(client: Ctx, store: BoardStore): void {
  const install = (scope: Ctx): void => {
    const namespace = serviceOf<{ modelCatalog?: () => Promise<ModelCatalogResponse> }>(scope, 'remote.session')
    const alternate = serviceOf<{ session?: { modelCatalog?: () => Promise<ModelCatalogResponse> } }>(scope, 'remote')
    const rpc = namespace?.modelCatalog?.bind(namespace) ?? alternate?.session?.modelCatalog?.bind(alternate.session)
    if (rpc === undefined) return
    store.installModelCatalog(async (): Promise<ModelCatalogView> => {
      try {
        const result = await rpc()
        if (result.ok !== true || result.value === undefined) return { models: [] }
        const models = result.value.groups.flatMap(group => group.models.map(model => ({
          provider: group.id,
          model: model.id,
          name: model.name ?? model.id,
          groupName: group.name,
        })))
        const failures = (result.value.failures ?? []).map(failure => ({
          name: failure.name ?? failure.id ?? 'provider',
          message: failure.message ?? '',
        }))
        return {
          models,
          ...(result.value.default === undefined ? {} : { defaultModel: result.value.default }),
          ...(failures.length === 0 ? {} : { failures }),
        }
      } catch {
        return { models: [] }
      }
    })
  }
  if (typeof client.inject === 'function') client.inject(['remote.session'], install)
  else install(client)
}

function bindPromptCompletions(client: Ctx, store: BoardStore): void {
  const install = (scope: Ctx): void => {
    const remote = serviceOf<SlashRemote>(scope, 'remote')
    const sessions = serviceOf<SessionsListFace>(scope, 'sessions')
    const workspaces = serviceOf<WorkspacesListFace>(scope, 'workspaces')
    store.installPromptCompletions(async (workspaceId?: string): Promise<PromptCompletions> => {
      const current = sessions?.list.getSnapshot().current
      let sessionId: string | undefined = current
      if (workspaceId !== undefined && workspaceId !== '') {
        try {
          const rows = workspaces?.list.getSnapshot().items ?? []
          const ids = rows.find(row => row.workspaceId === workspaceId)?.sessionIds ?? []
          if (current === undefined || !ids.includes(current)) sessionId = ids[0] ?? current
        } catch { /* keep the current session */ }
      }
      if (sessionId === undefined || sessionId === '') return { commands: [], skills: [] }
      const [skills, commands] = await Promise.all([
        remote?.skills?.list({ sessionId }).catch(() => undefined),
        remote?.commands?.list(sessionId).catch(() => undefined),
      ])
      return {
        skills: (skills?.ok === true ? skills.value?.skills ?? [] : []).map(item => ({
          name: item.name,
          kind: 'skill' as const,
          ...(item.description === undefined || item.description === '' ? {} : { description: item.description }),
        })),
        commands: (commands?.ok === true ? commands.value ?? [] : []).map(item => ({
          name: item.name,
          kind: 'command' as const,
          ...(item.description === undefined || item.description === '' ? {} : { description: item.description }),
          ...(item.input?.hint === undefined ? {} : { hint: item.input.hint }),
        })),
      }
    })
  }
  if (typeof client.inject === 'function') client.inject(['remote'], install)
  else install(client)
}

/** 插件入口。 */
export function apply(ctx: Context): void {
  const client = ctx as unknown as Ctx
  const t = client.locale.bind(NS)
  const store = new BoardStore()

  client.effect(() => installPanelStyles(), 'dsh-magica-castboard: styles')
  client.effect(() => client.locale.register(NS, { zh, en }), 'dsh-magica-castboard: dictionaries')

  // 项目列表：优先订阅（服务就绪即首帧），再在每次拉取时兜底读快照。
  const bindWorkspaces = (scope: Ctx): void => {
    const service = scope.get?.('workspaces') as Work | undefined
    if (service === undefined) return
    const push = (): void => { store.setWorkspaces(readWorkspaces(service)) }
    push()
    const off = service.list.subscribe?.(push)
    if (off !== undefined) scope.effect(() => off, 'dsh-magica-castboard: workspaces')
    else scope.effect(() => () => undefined, 'dsh-magica-castboard: workspaces')
  }
  if (typeof client.inject === 'function') client.inject(['workspaces'], bindWorkspaces)
  else bindWorkspaces(client)

  bindModelCatalog(client, store)
  bindPromptCompletions(client, store)
  bindPermissionPreset(client, store)

  // 会话归档：0.2 的 `uiWorkspace.archiveSession`（可选能力；没装就只归档卡片）。
  const bindArchiver = (scope: Ctx): void => {
    const service = scope.get?.('uiWorkspace') as WorkspaceArchiveFace | undefined
    const archive = service?.archiveSession
    if (service === undefined || typeof archive !== 'function') return
    store.installSessionArchiver(async sessionIds => {
      const archived: string[] = []
      const failed: { sessionId: string; error: string }[] = []
      const queue = [...sessionIds]
      // 限并发 2：每次归档都要走 shell 的会话操作，别把主线程/服务排满。
      const worker = async (): Promise<void> => {
        for (;;) {
          const sessionId = queue.shift()
          if (sessionId === undefined) return
          try {
            await service.archiveSession?.(sessionId, { stopActivity: true })
            archived.push(sessionId)
          } catch (error) {
            failed.push({ sessionId, error: error instanceof Error ? error.message : String(error) })
          }
        }
      }
      await Promise.all([worker(), worker()])
      return { archived, failed, unsupported: [] }
    })
  }
  if (typeof client.inject === 'function') client.inject(['uiWorkspace'], bindArchiver)
  else bindArchiver(client)

  // 会话跳转：0.2 的 sessions 服务没有 `open`；导航权在 uiWorkspace。
  // 每次点击都从根 ctx 懒取服务，避免 apply 早于 uiWorkspace 就绪时 jumper 永远没装上。
  store.installSessionJumper(async (sessionId: string) => {
    const ui = (client.uiWorkspace ?? client.get?.('uiWorkspace')) as WorkspaceArchiveFace | undefined
    const sessions = (client.sessions ?? client.get?.('sessions')) as SessionService | undefined
    // Bind the service: `openSession` calls `this.replaceMain`, so detaching it
    // makes `this` undefined and navigation dies with "reading 'replaceMain'".
    const openSession = ui?.openSession?.bind(ui)
    if (openSession === undefined || sessions === undefined) {
      return 'unavailable'
    }
    const archived = (id: string): boolean => {
      try {
        const workspaces = client.get?.('workspaces') as Work | undefined
        return workspaces?.list.getSnapshot().archivedSessionIds?.includes(id) === true
      } catch {
        return false
      }
    }
    // Some producers store the bare uuid while the shell catalog may key it as
    // `session-<uuid>` (or vice versa); accept both spellings.
    const candidateIds = sessionId.startsWith('session-')
      ? [sessionId, sessionId.slice('session-'.length)]
      : [sessionId, `session-${sessionId}`]
    try {
      const addressOf = (): unknown => {
        try {
          return sessions.subagentAddress?.(sessionId)
        } catch {
          return undefined
        }
      }
      const resolveId = (): string | undefined => {
        const list = sessions.list.getSnapshot().byId
        return candidateIds.find(id => list[id] !== undefined)
      }
      const lookup = (): { id?: string; state: 'openable' | 'archived' | 'absent' } => {
        const id = resolveId()
        if (id === undefined) return { state: addressOf() === undefined ? 'absent' : 'openable' }
        return { id, state: archived(id) ? 'archived' : 'openable' }
      }
      let found = lookup()
      if (found.state === 'absent') {
        try { await sessions.refresh() } catch { /* 保留原判 */ }
        found = lookup()
      }
      if (found.state === 'archived') return 'archived'
      if (found.state === 'absent') {
        return 'missing'
      }
      // A catalog child is selected through its durable direct-parent address.
      openSession(addressOf() ?? found.id ?? sessionId)
      return 'opened'
    } catch {
      return 'unavailable'
    }
  })

  store.start()
  client.effect(
    () => installConversationInteractions(client, store, view => createElement(InteractionRow, { view, store, t })),
    'dsh-magica-castboard: conversation interactions',
  )
  client.effect(() => () => { store.dispose() }, 'dsh-magica-castboard: board store')

  client.slots.inject('sidebar.panellist', () =>
    client.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 40,
        label: () => t('entry.label'),
        inject: () => ({ store, t }),
      },
      SidebarIcon,
    ),
  )

  client.slots.inject('main', () =>
    client.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ store }),
      },
      PanelPage,
    ),
  )

  client.slots.inject('sidebar.panellist', () =>
    client.slots.register(
      {
        name: 'sidebar.panellist',
        id: TEAMWORK_PANEL_ID,
        order: 41,
        label: () => t('teamwork.entry.label'),
        inject: () => ({ t }),
      },
      TeamworkIcon,
    ),
  )

  client.slots.inject('main', () =>
    client.slots.register(
      {
        name: 'main',
        key: TEAMWORK_PANEL_ID,
        locale: NS,
        inject: () => ({ t }),
      },
      TeamworkPage,
    ),
  )

  // 交互总览是全局浮层：侧栏入口在任何页面都能点，弹窗不能挂在看板面板页里。
  client.slots.inject('shell.overlay', () =>
    client.slots.register(
      {
        name: 'shell.overlay',
        id: 'castboard-interactions',
        inject: () => ({ store, t }),
      },
      InteractionOverlay,
    ),
  )

  // 登录态也是全局的：服务连上后即使没打开看板，也要能弹登录框。
  client.slots.inject('shell.overlay', () =>
    client.slots.register(
      {
        name: 'shell.overlay',
        id: 'castboard-auth',
        order: 10,
        inject: () => ({ store, t }),
      },
      AuthGate,
    ),
  )
}

// 供测试/外部探测：面板主视图与 store 的导出面。
export { Lanes }
