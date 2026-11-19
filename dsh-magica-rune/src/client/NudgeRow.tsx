/** 通用设置里的「提醒阈值」行：数字 + 增减按钮（照 ui-theme 的字号行做的）。 */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

/** 本行需要的注入面（slot 把 `hooks` 的每个键变成 `use<Key>` 钩子）。 */
export interface NudgeRowProps {
  /** slot 把 `hooks: { everyToolCalls }` 变成这个钩子；快照是**整个 state 对象**。 */
  useEveryToolCalls: <R>(selector: (value: { everyToolCalls: number }) => R) => R
  setEveryToolCalls: (value: number) => Promise<void>
  t: (key: string) => string
}

const MIN = 1
const MAX = 100

/**
 * 通用设置行：连续多少次工具调用无文本输出后提醒。
 * @param props - 当前值、写入器与文案。
 * @returns 一行设置项。
 */
export function NudgeRow({ useEveryToolCalls, setEveryToolCalls, t }: NudgeRowProps) {
  const value = useEveryToolCalls(state => state.everyToolCalls)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const commit = (next: number): void => {
    const clamped = Math.min(MAX, Math.max(MIN, Math.round(next)))
    if (clamped === value) return
    setFailed(false)
    setBusy(true)
    void setEveryToolCalls(clamped).catch(() => { setFailed(true) }).finally(() => { setBusy(false) })
  }

  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
    <div>
      <div>{t('nudge.title')}</div>
      <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' }}>{t('nudge.description')}</div>
      {failed && <div role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' }}>{t('nudge.error')}</div>}
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <Button size="sm" variant="ghost" disabled={busy || value <= MIN} aria-label={t('nudge.decrease')}
        onClick={() => commit(value - 1)}>−</Button>
      <span style={{ minWidth: '2.5em', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      <Button size="sm" variant="ghost" disabled={busy || value >= MAX} aria-label={t('nudge.increase')}
        onClick={() => commit(value + 1)}>+</Button>
    </div>
  </div>
}
