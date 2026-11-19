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

  /** 写入新的阈值：读回整段 value → 改 nudge.everyToolCalls → replace。 */
  async setEveryToolCalls(value: number): Promise<void> {
    this.store.update((draft) => { draft.busy = true })
    try {
      const described = await this.ctx.remote.settings.describe() as RemoteResult<{ namespaces?: Descriptor[] }>
      if (!described.ok) throw new Error(described.error?.message ?? 'settings describe failed')
      const found = (described.value.namespaces ?? []).find(item => item.ns === ABILITY_NS)
      if (found === undefined) throw new Error(`settings namespace "${ABILITY_NS}" not found`)
      const current = (found.value ?? {}) as Record<string, unknown>
      const nudge = (current.nudge ?? {}) as Record<string, unknown>
      const next = { ...current, nudge: { ...nudge, everyToolCalls: value } }
      // 始终传 3 个参数（0.2.1 的 remote 会校验实参个数）
      const written = await this.ctx.remote.settings.replace(
        ABILITY_NS,
        next as unknown as Record<string, unknown>,
        found.revision,
      ) as RemoteResult<unknown>
      if (!written.ok) throw new Error(written.error?.message ?? 'settings replace failed')
      await this.load()
    } finally {
      this.store.update((draft) => { draft.busy = false })
    }
  }
}

/** 从命名空间的 value 里取 `nudge.everyToolCalls`（读不到给默认值）。 */
export function readThreshold(value: unknown): number {
  const nudge = (value as { nudge?: { everyToolCalls?: unknown } } | undefined)?.nudge
  const raw = nudge?.everyToolCalls
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return FALLBACK
  return Math.min(100, Math.max(1, Math.round(raw)))
}
