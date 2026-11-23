/**
 * 看板视图状态（teamwork 组件库的 model 层，**纯函数**，不依赖 React/DOM）。
 *
 * 五字段与四个动作对应 raw t §4 的 `ViewController`：
 * `open` / `page` / `detailId` / `issue` / `layout`。
 *
 * @module dsh-magica-teamwork/client/model/view
 */

/** 页面。 */
export type TeamworkPage = 'board' | 'projects' | 'members' | 'settings'

/** 布局。 */
export type BoardLayout = 'columns' | 'list'

/** 视图状态。 */
export interface ViewState {
  open: boolean
  page: TeamworkPage
  /** 打开的卡片详情 id。 */
  detailId?: string
  /** 从 issue 视角打开的详情。 */
  issue?: string
  layout: BoardLayout
}

/** 初始状态。 */
export function initialView(page: TeamworkPage = 'board'): ViewState {
  return { open: false, page, layout: 'columns' }
}

/** 动作。 */
export type ViewAction =
  | { type: 'open'; page?: TeamworkPage }
  | { type: 'close' }
  | { type: 'go'; page: TeamworkPage }
  | { type: 'detail'; id?: string; issue?: string }
  | { type: 'layout'; layout: BoardLayout }

/** 归约。 */
export function reduceView(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case 'open':
      return { ...state, open: true, page: action.page ?? state.page }
    case 'close':
      return { ...state, open: false, detailId: undefined, issue: undefined }
    case 'go':
      return { ...state, page: action.page, detailId: undefined, issue: undefined }
    case 'detail':
      return { ...state, detailId: action.id, issue: action.issue }
    case 'layout':
      return { ...state, layout: action.layout }
    default:
      return state
  }
}

/** 详情是否开着。 */
export function detailOpen(state: ViewState): boolean {
  return state.detailId !== undefined || state.issue !== undefined
}
