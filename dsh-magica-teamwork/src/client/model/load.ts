/**
 * 数据加载状态机（`useLoad` 的纯核心）+ 唯一活定时器。
 *
 * 四个加载时刻（raw t §4）：挂载 / key 变化 / 手动重试 / 写成功后刷新。
 *
 * @module dsh-magica-teamwork/client/model/load
 */

/** 状态。 */
export type LoadState<T> =
  | { status: 'idle' }
  | { status: 'loading'; since: number; value?: T }
  | { status: 'ready'; value: T; at: number }
  | { status: 'error'; message: string; at: number }

/** 动作。 */
export type LoadAction<T> =
  | { type: 'start'; at: number }
  | { type: 'ok'; value: T; at: number }
  | { type: 'fail'; message: string; at: number }
  | { type: 'reset' }

/** 归约。 */
export function reduceLoad<T>(state: LoadState<T>, action: LoadAction<T>): LoadState<T> {
  switch (action.type) {
    case 'start': {
      // 已经在 loading 就不重置起点（避免"重复点击导致永远 loading"）
      if (state.status === 'loading') return state
      // 带着旧值进 loading：刷新期间界面不闪空态
      const previous = state.status === 'ready' ? state.value : undefined
      return previous === undefined ? { status: 'loading', since: action.at } : { status: 'loading', since: action.at, value: previous }
    }
    case 'ok':
      return { status: 'ready', value: action.value, at: action.at }
    case 'fail':
      return { status: 'error', message: action.message, at: action.at }
    case 'reset':
      return { status: 'idle' }
    default:
      return state
  }
}

/** 旧数据是否还能显示（重试期间不闪空态）。 */
export function staleValue<T>(state: LoadState<T>): T | undefined {
  if (state.status === 'ready') return state.value
  if (state.status === 'loading') return state.value
  return undefined
}

/** 是否该显示骨架（首次加载才显示）。 */
export function showsSkeleton<T>(state: LoadState<T>): boolean {
  return state.status === 'loading' && state.since !== undefined
}

/** 唯一活定时器：同一时刻只能有一个在跑。 */
export interface ClientTimer {
  /** 安排一次（会取消上一个）。 */
  schedule: (callback: () => void, delayMs?: number) => void
  /** 取消。 */
  cancel: () => void
  /** 是否在跑。 */
  pending: () => boolean
}

/** 造一个客户端定时器（防抖语义，raw u §5 的 300ms）。 */
export function createClientTimer(defaultDelayMs = 300, inject?: {
  set?: (callback: () => void, delayMs: number) => unknown
  clear?: (handle: unknown) => void
}): ClientTimer {
  let handle: unknown
  let has = false
  const set = inject?.set ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const clear = inject?.clear ?? ((target: unknown) => clearTimeout(target as ReturnType<typeof setTimeout>))
  const cancel = (): void => {
    if (!has) return
    has = false
    clear(handle)
    handle = undefined
  }
  return {
    schedule: (callback, delayMs = defaultDelayMs) => {
      cancel()
      has = true
      handle = set(() => {
        has = false
        handle = undefined
        callback()
      }, delayMs)
    },
    cancel,
    pending: () => has,
  }
}
