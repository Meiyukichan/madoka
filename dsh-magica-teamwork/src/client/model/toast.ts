/**
 * 模块级 toast 队列（raw u §7.1）：**不是 Provider**，卸载时靠 `resetToasts()` 收干净。
 *
 * 为什么用模块级：Provider 化会让"插件卸载后队列里还挂着定时器"变成常态，
 * 而模块级只有一个队列 + 一个定时器，`resetToasts()` 一次就能清空。
 *
 * @module dsh-magica-teamwork/client/model/toast
 */

/** toast 级别。 */
export type ToastLevel = 'info' | 'success' | 'warn' | 'error'

/** 一条 toast。 */
export interface ToastItem {
  id: number
  level: ToastLevel
  text: string
  /** 自动消失时间（0 = 不自动消失）。 */
  ttlMs: number
}

const listeners = new Set<(items: readonly ToastItem[]) => void>()
let items: ToastItem[] = []
let nextId = 1
let timer: ReturnType<typeof setTimeout> | undefined

/** 当前队列（只读快照）。 */
export function toasts(): readonly ToastItem[] {
  return items
}

/** 订阅（返回退订函数）。 */
export function subscribeToasts(listener: (items: readonly ToastItem[]) => void): () => void {
  listeners.add(listener)
  listener(items)
  return () => {
    listeners.delete(listener)
  }
}

/** 通知全部订阅者。 */
function emit(): void {
  for (const listener of listeners) listener(items)
}

/** 安排自动清理（只有一个定时器，按最早到期）。 */
function schedule(): void {
  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
  }
  const withTtl = items.filter(item => item.ttlMs > 0)
  if (withTtl.length === 0) return
  const minTtl = Math.min(...withTtl.map(item => item.ttlMs))
  const handle = setTimeout(() => {
    timer = undefined
    items = items.filter(item => item.ttlMs === 0 || item.ttlMs > minTtl)
    emit()
    schedule()
  }, minTtl) as ReturnType<typeof setTimeout> & { unref?: () => void }
  // Node 下不阻止进程退出；浏览器下没有 unref
  handle.unref?.()
  timer = handle
}

/** 推一条。 */
export function toast(text: string, options: { level?: ToastLevel; ttlMs?: number } = {}): ToastItem {
  const item: ToastItem = {
    id: nextId++,
    level: options.level ?? 'info',
    text,
    ttlMs: options.ttlMs ?? 4000,
  }
  items = [...items, item]
  emit()
  schedule()
  return item
}

/** 手动关一条。 */
export function dismissToast(id: number): void {
  const before = items.length
  items = items.filter(item => item.id !== id)
  if (items.length !== before) {
    emit()
    schedule()
  }
}

/** 全清（卸载时调用，raw u §7.1 的 teardown 纪律）。 */
export function resetToasts(): void {
  if (timer !== undefined) {
    clearTimeout(timer)
    timer = undefined
  }
  items = []
  nextId = 1
  emit()
}

/** 测试/诊断：还有没有定时器挂着。 */
export function toastTimerPending(): boolean {
  return timer !== undefined
}
