/**
 * 通用设置里的「提醒阈值」行。
 *
 * 视觉逐项照 `ui-theme` 的 FontSizeRow：同一套行距（16px 上下 + 0.5px 分隔线）、
 * 同一个 stepper 药丸（min-width 72 / 高 36 / radius md / bg-module-platform）、
 * 数字用 tabular-nums 居中，右侧箭头列 hover 才显现，单位跟在药丸后面。
 */
import { useState } from 'react'
import {
  IconChevronDownOutlineRegular, IconChevronUpOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'

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

  return (
    <div className="rune-setting-row">
      <div className="rune-setting-text">
        <div className="rune-setting-title">{t('nudge.title')}</div>
        <div className="rune-setting-desc">{t('nudge.description')}</div>
        {failed && <div className="rune-setting-error" role="alert">{t('nudge.error')}</div>}
      </div>
      <div className="rune-setting-control">
        <div className="rune-stepper">
          <span className="rune-stepper-value">{value}</span>
          <span className="rune-stepper-arrows">
            <button
              type="button"
              className="rune-stepper-arrow"
              aria-label={t('nudge.increase')}
              disabled={busy || value >= MAX}
              onClick={() => { commit(value + 1) }}
            >
              <IconChevronUpOutlineRegular size={9} />
            </button>
            <button
              type="button"
              className="rune-stepper-arrow"
              aria-label={t('nudge.decrease')}
              disabled={busy || value <= MIN}
              onClick={() => { commit(value - 1) }}
            >
              <IconChevronDownOutlineRegular size={9} />
            </button>
          </span>
        </div>
        <span className="rune-stepper-unit">{t('nudge.unit')}</span>
      </div>
    </div>
  )
}
