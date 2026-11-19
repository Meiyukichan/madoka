/**
 * 通用设置里的「提醒阈值」：读 `dsh-magica-rune` 命名空间的 `nudge.everyToolCalls`。
 *
 * 写回沿用能力页的 `settings.replace`（整段替换 + 乐观锁），因为 0.2.1 的 client 面
 * 只暴露 describe / replace / mutate 这一组；`mutate` 的 path 语义更绕，这里没必要。
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DshContextLike } from './face.ts'
import { ABILITY_NS } from '../namespace.ts'

interface NudgeSettingState {
  everyToolCalls: number
  revision: number
  busy: boolean
}

interface Descriptor {
  ns: string
  revision: number
  value: unknown
}

interface RemoteResult<T> {
  ok: boolean
  value: T
  error?: { message?: string }
}

const FALLBACK = 15

export class NudgeSettingController {
  readonly store = createSnapshotStore<NudgeSettingState>({ everyToolCalls: FALLBACK, revision: 0, busy: false })
  private readonly ctx: DshContextLike
  /** 待写入的最新值（连点时只保留最后一个）。 */
  private pending: number | undefined
  /** 去抖定时器：连点合并成一次写盘。 */
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(ctx: DshContextLike) {
    this.ctx = ctx
  }

  async load(): Promise<void> {
    try {
      const result = await this.ctx.remote.settings.describe() as RemoteResult<{ namespaces?: Descriptor[] }>
      if (!result.ok) return
      const found = (result.value.namespaces ?? []).find(item => item.ns === ABILITY_NS)
      if (found === undefined) return
      const every = readThreshold(found.value)
      this.store.update((draft) => {
        draft.everyToolCalls = every
        draft.revision = Math.max(draft.revision, found.revision)
      })
    } catch {
      // 读不到就保持默认显示
    }
  }

  /**
   * 改阈值：**先改本地 store 立刻回显**，再合并成一次写盘。
   *
   * 为什么不能点一下写一次：一次交互原本是 describe → replace → describe 三个往返，
   * 而 replace 会让宿主写配置并触发 volatile 更新（实测 1~2s），连点就卡成幻灯片。
   * 现在：乐观更新 + 250ms 去抖 + 单飞，连点只写最后一次，界面无延迟。
   */
  setEveryToolCalls(value: number): void {
    this.store.update((draft) => {
      draft.everyToolCalls = value
      draft.busy = true
    })
    this.pending = value
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, 250)
  }

  /** 真正落盘：只写一次，冲突时对账重试一次。 */
  private async flush(): Promise<void> {
    const value = this.pending
    this.pending = undefined
    if (value === undefined) {
      this.store.update((draft) => { draft.busy = false })
      return
    }
    try {
      await this.write(value, this.store.getSnapshot().revision)
    } catch {
      // 冲突：拿最新 revision 再写一次
      try {
        await this.load()
        await this.write(value, this.store.getSnapshot().revision)
      } catch {
        await this.load()
      }
    } finally {
      this.store.update((draft) => { draft.busy = false })
    }
  }

  /** 单次 replace：读回整段 value → 改 nudge.everyToolCalls → 写回。 */
  private async write(value: number, revision: number): Promise<void> {
    const described = await this.ctx.remote.settings.describe() as RemoteResult<{ namespaces?: Descriptor[] }>
    if (!described.ok) throw new Error(described.error?.message ?? 'settings describe failed')
    const found = (described.value.namespaces ?? []).find(item => item.ns === ABILITY_NS)
    if (found === undefined) throw new Error(`settings namespace "${ABILITY_NS}" not found`)
    const current = (found.value ?? {}) as Record<string, unknown>
    const nudge = (current.nudge ?? {}) as Record<string, unknown>
    const next = { ...current, nudge: { ...nudge, everyToolCalls: value } }
    const written = await this.ctx.remote.settings.replace(
      ABILITY_NS,
      next as unknown as Record<string, unknown>,
      found.revision ?? revision,
    ) as RemoteResult<unknown>
    if (!written.ok) throw new Error(written.error?.message ?? 'settings replace failed')
    this.store.update((draft) => {
      draft.everyToolCalls = value
      draft.revision = Math.max(draft.revision, found.revision + 1)
    })
  }

  }

/** 从命名空间的 value 里取 `nudge.everyToolCalls`（读不到给默认值）。 */
export function readThreshold(value: unknown): number {
  const nudge = (value as { nudge?: { everyToolCalls?: unknown } } | undefined)?.nudge
  const raw = nudge?.everyToolCalls
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return FALLBACK
  return Math.min(100, Math.max(1, Math.round(raw)))
}
