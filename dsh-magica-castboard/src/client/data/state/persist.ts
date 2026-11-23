/**
 * 视图偏好持久化（项目筛选 / 排序）。
 *
 * @module dsh-magica-castboard/client/data/state/persist
 */
import type { BoardState, SortBy } from './types.ts'

const VIEW_KEY = 'dsh-magica-castboard:view:v1'
const LAST_WORKSPACE_KEY = 'dsh-magica-castboard:last-workspace:v1'
const LAST_MODEL_KEY = 'dsh-magica-castboard:last-model:v1'

interface PersistedView {
  workspaceId?: string
  urgencies: string[]
  sortBy: SortBy
}

/** 读回视图偏好（存储不可用时退回默认）。 */
export function readPersistedView(): PersistedView {
  try {
    const raw = localStorage.getItem(VIEW_KEY)
    if (raw === null) return { urgencies: [], sortBy: 'default' }
    const parsed = JSON.parse(raw) as Partial<PersistedView>
    return {
      ...(typeof parsed.workspaceId === 'string' ? { workspaceId: parsed.workspaceId } : {}),
      urgencies: Array.isArray(parsed.urgencies) ? parsed.urgencies.filter((item): item is string => typeof item === 'string') : [],
      sortBy: parsed.sortBy === 'updated' || parsed.sortBy === 'urgency' || parsed.sortBy === 'created' || parsed.sortBy === 'title'
        ? parsed.sortBy
        : 'default',
    }
  } catch {
    return { urgencies: [], sortBy: 'default' }
  }
}

/** 写回视图偏好（失败静默：偏好不是业务数据）。 */
export function persistView(state: BoardState): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({
      ...(state.filters.workspaceId === undefined ? {} : { workspaceId: state.filters.workspaceId }),
      urgencies: state.filters.urgencies,
      sortBy: state.sortBy,
    }))
  } catch { /* 存储不可用 */ }
}

/**
 * 记住「新建任务」上次选的项目 / 填的模型（0.1.2 的同名行为）。
 *
 * 项目 id 由 dsh 的 workspace 决定，不能硬编码；列表第一项又常常跟这次要建卡的项目
 * 无关，所以只能存在浏览器本地。只是「新建表单的默认值」，不参与任何业务判断。
 */
export function readLastWorkspace(): string | undefined {
  try {
    const raw = localStorage.getItem(LAST_WORKSPACE_KEY)
    const id = raw === null ? '' : raw.trim()
    return id === '' ? undefined : id
  } catch {
    return undefined
  }
}

/** 记住新建表单上次选的项目；传 `undefined` 清掉。 */
export function saveLastWorkspace(workspaceId?: string): void {
  try {
    const id = workspaceId === undefined ? '' : workspaceId.trim()
    if (id === '') localStorage.removeItem(LAST_WORKSPACE_KEY)
    else localStorage.setItem(LAST_WORKSPACE_KEY, id)
  } catch { /* 存储不可用 */ }
}

/** 读新建表单上次填的模型（`provider/model`）；没填过为 `undefined`。 */
export function readLastModel(): string | undefined {
  try {
    const raw = localStorage.getItem(LAST_MODEL_KEY)
    const id = raw === null ? '' : raw.trim()
    return id === '' ? undefined : id
  } catch {
    return undefined
  }
}

/** 记住新建表单上次填的模型；留空则清掉。 */
export function saveLastModel(model?: string): void {
  try {
    const id = model === undefined ? '' : model.trim()
    if (id === '') localStorage.removeItem(LAST_MODEL_KEY)
    else localStorage.setItem(LAST_MODEL_KEY, id)
  } catch { /* 存储不可用 */ }
}
