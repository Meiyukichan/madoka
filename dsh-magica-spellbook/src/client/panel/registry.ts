/**
 * 待决载体的发布登记（纯 TS，**不 import `.tsx`**，可在 Node 里单测）。
 *
 * 两条规则（来自 `A-034/A-139/A-184`）：
 * 1. **同会话只留一条**载体（按 `sessionId` 去重，取等得最久的那条）——一个输入框只放一个选择框；
 * 2. 注销/摘卡必须按 **`kind:id`** 精确摘，不能按 `sessionId` 一把清——
 *    同一会话先问问题、结算后再来审批时，按会话清会把刚发布的新载体一起摘掉。
 *
 * @module dsh-magica-spellbook/client/panel/registry
 */

import type { PendingInteractionRecord } from '../../shared/interaction.ts'

/** 一条记录的载体 key（`kind:id`）。 */
export function carrierKey(record: { kind: string; id: string }): string {
  return `${record.kind}:${record.id}`
}

/** 发布函数形状（与 `uiSession.registerPendingInteraction` 返回的一致）。 */
export type PublishFn = (record: PendingInteractionRecord) => () => void

/** 同会话去重：保留 `since` 最早的那条，结果按 `since` 升序。 */
export function claim(records: readonly PendingInteractionRecord[]): PendingInteractionRecord[] {
  const bySession = new Map<string, PendingInteractionRecord>()
  for (const record of records) {
    const current = bySession.get(record.sessionId)
    if (current === undefined || record.since < current.since) bySession.set(record.sessionId, record)
  }
  return [...bySession.values()].sort((a, b) => a.since - b.since)
}

/** 已发布载体的登记表。 */
export class InteractionRegistry {
  private readonly published = new Map<string, () => void>()
  private readonly publish: PublishFn

  // 注意：不能用 TypeScript 的参数属性（`constructor(private readonly x)`）——
  // Node 的类型擦除模式不支持，`node --test` 会直接 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
  constructor(publish: PublishFn) {
    this.publish = publish
  }

  /** 已发布的载体 key（`kind:id`），用于诊断。 */
  keys(): string[] {
    return [...this.published.keys()]
  }

  /** 按 `kind:id` 精确摘一条（未发布是无操作）。 */
  drop(record: { kind: string; id: string }): void {
    const key = carrierKey(record)
    const unpublish = this.published.get(key)
    if (unpublish === undefined) return
    this.published.delete(key)
    try {
      unpublish()
    } catch {
      // 已注销
    }
  }

  /** 摘掉全部（dispose）。 */
  clear(): void {
    for (const key of [...this.published.keys()]) {
      const unpublish = this.published.get(key) ?? null
      this.published.delete(key)
      try {
        unpublish?.()
      } catch {
        // 已注销
      }
    }
  }

  /**
   * 用一轮轮询结果同步登记表：多余的摘掉、新的发布。
   * @param records - 本轮全部待决记录。
   * @returns 本轮发布失败的 key（供诊断钩子用）。
   */
  sync(records: readonly PendingInteractionRecord[]): { kept: PendingInteractionRecord[]; failed: string[] } {
    const kept = claim(records)
    const keepKeys = new Set(kept.map((record) => carrierKey(record)))
    for (const key of [...this.published.keys()]) {
      if (!keepKeys.has(key)) {
        const unpublish = this.published.get(key)
        this.published.delete(key)
        try {
          unpublish?.()
        } catch {
          // 已注销
        }
      }
    }
    const failed: string[] = []
    for (const record of kept) {
      const key = carrierKey(record)
      if (this.published.has(key)) continue
      try {
        this.published.set(key, this.publish(record))
      } catch {
        failed.push(key)
      }
    }
    return { kept, failed }
  }
}
