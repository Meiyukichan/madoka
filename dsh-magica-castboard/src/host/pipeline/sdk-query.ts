/**
 * Dispatch/device/workspace query face on the shared library side (returns `degraded` when the SDK is missing).
 *
 * These 5 tools (help/groups/group_members/devices/workspaces) are essentially "reads of the shared library",
 * so they form an **optional face**: without an SDK they only return `{ degraded: true }`, neither throwing nor pretending to have data.
 *
 * @module dsh-magica-castboard/host/pipeline/sdk-query
 */

/** A candidate target (person / device / workspace). */
export interface QueryItem {
  id: string
  label: string
  detail?: string
  /** Member: display name; also given when `id` is the account, so the model can copy it verbatim. */
  account?: string
  displayName?: string
  /** Member: already permission-trimmed by the shared library (contains only oneself). */
  restricted?: boolean
  /** Device/workspace: instance `host:port`. */
  instance?: string
  /** Project/workspace: absolute path. */
  cwd?: string
}

export interface IssueQueryFace {
  groups: () => Promise<readonly QueryItem[]>
  groupMembers: (projectId: string) => Promise<readonly QueryItem[]>
  devices: (userId: string) => Promise<readonly QueryItem[]>
  /** `type` is required; the rest narrow the index/portrait on this instance. */
  workspaces: (query: {
    type: 'index' | 'portal'
    userId?: string
    instance?: string
    workspaceId?: string
  }) => Promise<readonly QueryItem[]>
}

export interface DegradedList {
  degraded: true
  items: readonly QueryItem[]
  reason: string
}

export async function queryOrDegrade<T>(
  face: (() => Promise<T>) | undefined,
): Promise<{ degraded: false; value: T } | DegradedList> {
  if (face === undefined) return { degraded: true, items: [], reason: '共享库未接入（缺 SDK 面）' }
  try {
    const value = await face()
    return { degraded: false, value }
  } catch (error) {
    return { degraded: true, items: [], reason: error instanceof Error ? error.message : String(error) }
  }
}
