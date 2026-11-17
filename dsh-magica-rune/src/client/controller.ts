/**
 * 数据 + 写回 controller（apply 世界，持有 ctx）。
 *
 * 与视图 store 的分工：这里只放 **async 副作用**（拉目录、读配置、写配置、冲突回滚），
 * 状态用 `createSnapshotStore` 承载，经 slot `inject` 的 `hooks` 隔间暴露成 `useAbility`。
 *
 * 写入走 shell 已生成的 `ctx.remote.settings`（0.2 不再有 `settings.register`）：
 * - 读：`describe()` → 找到 `ns === ABILITY_NS` 那条的 `value` 与 `revision`
 * - 写：`replace(ns, section, revision)`，乐观锁；失败 → 静默重载对账
 *
 * 三张名单（builtinDisabled / nonDisableable / skillNonDisableable）不在 client 配置里，
 * 由 host 的 `/rune-ability/catalog` 下发：UI 需要它们来渲染 builtin 徽章、隐藏受保护项。
 * @module dsh-magica-rune/client/controller
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DshContextLike } from './face.ts'
import {
  applyToggle, batchTarget, cloneSettings, effectiveState, emptySettings, normalizeSettings,
  type AbilityKind, type AbilitySettingsValue, type ScopeKind,
} from '../shared/ability.ts'
import { matches } from '../policy.ts'
import { ABILITY_NS, CATALOG_PATH } from '../namespace.ts'

export interface ToolRow { name: string; description: string }
export interface SkillRow { name: string; description: string; source?: string }
export interface WorkspaceRow { id: string; title: string; path: string }

export interface AbilityDataState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  value: AbilitySettingsValue
  revision: number
  tools: ToolRow[]
  skills: SkillRow[]
  workspaces: WorkspaceRow[]
  /** host 下发的名单（用于 builtin 徽章与隐藏受保护项）。 */
  builtinDisabled: string[]
  nonDisableable: string[]
  skillNonDisableable: string[]
}

function emptyState(): AbilityDataState {
  return {
    status: 'idle',
    error: null,
    value: emptySettings(),
    revision: 0,
    tools: [],
    skills: [],
    workspaces: [],
    builtinDisabled: [],
    nonDisableable: [],
    skillNonDisableable: [],
  }
}

interface CatalogPayload {
  ns?: string
  tools?: ToolRow[]
  skills?: SkillRow[]
  workspaces?: WorkspaceRow[]
  builtinDisabled?: string[]
  nonDisableable?: string[]
  skillNonDisableable?: string[]
}

export class AbilityController {
  /** 数据快照（组件侧通过 `useAbility` 读）。 */
  readonly store = createSnapshotStore<AbilityDataState>(emptyState(), { flush: 'sync' })
  readonly ctx: DshContextLike
  /**
   * 进行中的写入数。
   *
   * 为什么需要：`load()` 可能在某次写入**之前**发出、在写入**之后**返回，
   * 它带回来的是旧 revision 与旧 value。若直接应用，会把刚写完的 revision 顶回去，
   * 于是下一次 `replace` 必撞乐观锁（表现为「点一下生效、再点一下没反应」）。
   * 所以写入期间到达的 load 只更新目录字段，不碰 `value` / `revision`。
   */
  private writes = 0
  /** load 序号：只允许最新一次 load 的结果落地，避免旧响应覆盖新响应。 */
  private loads = 0

  constructor(ctx: DshContextLike) {
    this.ctx = ctx
  }

  /** 当前 revision（供 `document-updated` 去重）。 */
  get revision(): number {
    return this.store.getSnapshot().revision
  }

  /** 拉目录 + 读配置。`silent` 用于「别处改了配置」的静默刷新（不清搜索词、不闪 loading）。 */
  async load(silent = false): Promise<void> {
    const seq = ++this.loads
    if (!silent) this.store.update(draft => { draft.status = 'loading'; draft.error = null })
    try {
      const [catalog, descriptor] = await Promise.all([
        fetchCatalog(),
        this.ctx.remote.settings.describe(),
      ])
      if (!descriptor.ok) throw new Error(descriptor.error.message)
      const namespaces = descriptor.value.namespaces ?? []
      const found = namespaces.find(item => item.ns === ABILITY_NS)
      if (found === undefined) throw new Error(`settings namespace "${ABILITY_NS}" not found`)
      if (seq !== this.loads) return
      const writing = this.writes > 0
      this.store.update(draft => {
        draft.status = 'ready'
        draft.error = null
        draft.tools = catalog.tools ?? []
        draft.skills = catalog.skills ?? []
        draft.workspaces = catalog.workspaces ?? []
        draft.builtinDisabled = catalog.builtinDisabled ?? []
        draft.nonDisableable = catalog.nonDisableable ?? []
        draft.skillNonDisableable = catalog.skillNonDisableable ?? []
        if (writing) return
        draft.value = normalizeSettings(found.value)
        // revision 只增不减：旧响应不能把它顶回去
        draft.revision = Math.max(draft.revision ?? 0, found.revision)
      })
    } catch (error) {
      if (!silent && seq === this.loads) {
        this.store.update(draft => { draft.status = 'error'; draft.error = String(error) })
      }
    }
  }

  /**
   * 切换单个开关。乐观更新 → 落盘 → 冲突时对账后重试一次。
   *
   * 为什么要重试：连续快速点两下时，第一下的 RPC 响应可能还没回来，
   * 第二下就用旧 revision 发出 → 被乐观锁拒 → 表现为「点了没反应」。
   * 重试是在**对账拿到新 revision 之后**重新应用同一次翻转，语义仍然是「用户想翻转」。
   */
  async toggle(kind: AbilityKind, name: string, scope: ScopeKind, workspaceId?: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const previous = this.store.getSnapshot()
      const builtin = new Set<string>(previous.builtinDisabled)
      const next = cloneSettings(previous.value)
      if (!applyToggle(next[kind], scope, name, builtin, workspaceId)) return
      this.store.update(draft => { draft.value = next })
      if (await this.persist(next, previous.revision)) return
      // 第二次**不带 revision**：0.2.1 的 `describe()` 每次调用都可能推进 revision
      // （raw 里含 `entry.options.config` / `fiber.uid`），带锁重试会永远差一版。
      // 整段 replace 本身就是 last-write-wins，去掉锁不会丢用户语义。
      if (await this.persist(next, undefined)) return
      await this.load(true)
    }
  }

  /** 分组批量：不是全启用就全启用，否则全禁用。冲突时同样对账后重试一次。 */
  async toggleBatch(
    kind: AbilityKind, names: readonly string[], scope: ScopeKind, workspaceId?: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const previous = this.store.getSnapshot()
      const builtin = new Set<string>(previous.builtinDisabled)
      const next = cloneSettings(previous.value)
      const enable = batchTarget(next[kind], scope, names, builtin, workspaceId)
      let changed = false
      for (const name of names) {
        const current = effectiveState(next[kind], scope, name, builtin, workspaceId)
        if (current === 'builtin') continue
        if (enable === (current === 'enabled')) continue
        if (applyToggle(next[kind], scope, name, builtin, workspaceId)) changed = true
      }
      if (!changed) return
      this.store.update(draft => { draft.value = next })
      if (await this.persist(next, previous.revision)) return
      if (await this.persist(next, undefined)) return
      await this.load(true)
    }
  }

  /** @returns 是否写入成功（失败时已由调用方决定是否重试）。 */
  private async persist(value: AbilitySettingsValue, revision: number | undefined): Promise<boolean> {
    this.writes += 1
    try {
      const result = revision === undefined
        ? await this.ctx.remote.settings.replace(ABILITY_NS, value as unknown as Record<string, unknown>)
        : await this.ctx.remote.settings.replace(ABILITY_NS, value as unknown as Record<string, unknown>, revision)
      if (!result.ok) {
        // 结构化拒绝（冲突/覆盖层只读/字段不可写）：定位问题必须有据可查
        console.warn('[rune] settings write rejected: ' + result.error.message)
        return false
      }
      // 0.2.0 的 `replace` 会把新 revision 带回来；0.2.1（rc.5 起）声明为
      // `Promise<void>`（`packages/settings/settings/src/index.ts:357`），远端结果是
      // `undefined`。以前这里直接读 `result.value.revision` → TypeError 被 catch 吞掉，
      // 于是**写盘成功却被当成失败**，调用方重试又撞乐观锁（日志里 revision 一路 +1）。
      const wrote = result.value as { revision?: number } | undefined
      let nextRevision = typeof wrote?.revision === 'number' ? wrote.revision : undefined
      if (nextRevision === undefined) {
        // 自己去 describe 拿新 revision：`write()` 结尾已经 describe 过一次
        // （`:422`），所以这次读到的是写后的值，不会再触发版本推进。
        try {
          const again = await this.ctx.remote.settings.describe()
          if (again.ok) {
            const found = (again.value.namespaces ?? []).find(item => item.ns === ABILITY_NS)
            if (typeof found?.revision === 'number') nextRevision = found.revision
          }
        } catch {
          // 拿不到就交给下一次 load 对账，不影响本次写入已生效的事实
        }
      }
      if (typeof nextRevision === 'number') {
        // 与 load 一致：revision 只增不减
        this.store.update(draft => { draft.revision = Math.max(draft.revision ?? 0, nextRevision) })
      }
      return true
    } catch (error) {
      console.warn('[rune] settings write threw: ' + String(error))
      return false
    } finally {
      this.writes -= 1
    }
  }
}

async function fetchCatalog(): Promise<CatalogPayload> {
  try {
    const response = await fetch(CATALOG_PATH, { headers: { accept: 'application/json' } })
    if (!response.ok) return {}
    return (await response.json()) as CatalogPayload
  } catch {
    return {}
  }
}

/** UI 侧：该名字是否在受保护名单里（含 `*` 前缀规则）。 */
export function isProtected(patterns: readonly string[], name: string): boolean {
  return matches(patterns, name)
}
