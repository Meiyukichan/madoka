/**
 * 初始状态。
 *
 * @module dsh-magica-castboard/client/data/state/initial
 */
import { readPersistedView } from './persist.ts'
import type { BoardState } from './types.ts'

/** 冷启动快照。 */
export function initialState(): BoardState {
  const view = readPersistedView()
  return {
    status: 'loading',
    revision: 0,
    issueRevision: 0,
    linkRevision: 0,
    tasks: [],
    issues: [],
    issueLinks: undefined,
    details: new Map(),
    issueDetails: new Map(),
    interactions: [],
    workspaces: [],
    templates: [],
    filters: {
      ...(view.workspaceId === undefined ? {} : { workspaceId: view.workspaceId }),
      urgencies: view.urgencies,
    },
    search: '',
    sortBy: view.sortBy,
    composer: { open: false },
    issueComposer: { open: false },
    secondaryOpen: false,
    diagOpen: false,
    tplManagerOpen: false,
    settingsOpen: false,
    dispatchedOpen: false,
    interactionInboxOpen: false,
    archiveSessionsSupported: false,
  }
}
