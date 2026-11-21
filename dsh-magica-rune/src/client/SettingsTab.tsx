/** 「设置」tab：官方界面插件开关 + 提醒阈值（都走 host 的内存/补丁通道）。 */
import { useEffect, useState } from 'react'
import {
  IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'

interface PanelRow {
  id: string
  label: string
  hint: string
  disabled: boolean | null
}

interface PanelsPayload {
  plugins?: PanelRow[]
  nudgeEveryCalls?: number
}

/** 六个开关的展示文案（host 只给 id/状态，文案走 i18n）。 */
const PANEL_KEYS: ReadonlyArray<{ id: string; title: string; hint: string }> = [
  { id: 'ui-plugin-manager', title: 'panel.plugins', hint: 'panel.pluginsHint' },
  { id: 'entry-customization', title: 'panel.more', hint: 'panel.moreHint' },
  { id: 'ui-schedule', title: 'panel.schedule', hint: 'panel.scheduleHint' },
  { id: 'ui-settings-account', title: 'panel.accountPage', hint: 'panel.accountPageHint' },
  { id: 'account-controller', title: 'panel.accountRpc', hint: 'panel.accountRpcHint' },
  { id: 'deepseek-account', title: 'panel.accountHost', hint: 'panel.accountHostHint' },
]

async function readState(): Promise<PanelsPayload | undefined> {
  try {
    const response = await fetch('/rune-ability/panels', { headers: { accept: 'application/json' } })
    if (!response.ok) return undefined
    return (await response.json()) as PanelsPayload
  } catch {
    return undefined
  }
}

/**
 * 设置视图：上半是六个官方界面插件的开关（写 profile patch），下半是提醒阈值（改内存 + 延后落盘）。
 * @param props - 只用到 `t`。
 */
export function SettingsTab({ t, useEveryToolCalls, setEveryToolCalls }: {
  t: (key: string, params?: Record<string, string>) => string
  /** 与 nudge controller 共享的 store：跨 tab 重挂保留用户刚改的值。 */
  useEveryToolCalls: <R>(selector: (state: { everyToolCalls: number }) => R) => R
  setEveryToolCalls: (value: number) => void
}) {
  const [panels, setPanels] = useState<PanelRow[] | undefined>(undefined)
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const every = useEveryToolCalls(state => state.everyToolCalls)

  useEffect(() => {
    let alive = true
    void readState().then(payload => {
      if (!alive || payload === undefined) return
      setPanels(payload.plugins ?? [])
    })
    return () => { alive = false }
  }, [])

  const toggle = (id: string, enabled: boolean): void => {
    setBusy(id)
    setFailed(null)
    void fetch('/rune-ability/panels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, enabled }),
    })
      .then(async response => {
        if (!response.ok) throw new Error(String(response.status))
        setPanels(current => current?.map(row => (row.id === id ? { ...row, disabled: !enabled } : row)))
      })
      .catch(() => { setFailed(id) })
      .finally(() => { setBusy(null) })
  }

  const commitEvery = (next: number): void => {
    const clamped = Math.min(100, Math.max(1, Math.round(next)))
    if (clamped === every) return
    setEveryToolCalls(clamped)
  }

  return (
    <div>
      <div className="rune-setting-row">
        <div className="rune-setting-text">
          <div className="rune-setting-title">{t('panel.section')}</div>
          <div className="rune-setting-desc">{t('panel.sectionDesc')}</div>
        </div>
      </div>

      {panels === undefined
        ? <div className="rune-setting-desc" style={{ padding: '12px 0' }}>{t('loading')}</div>
        : PANEL_KEYS.map(key => {
          const row = panels.find(item => item.id === key.id)
          // 缺字段（旧宿主 / 未覆盖）按「默认已关」处理：我们这 6 个里 5 个默认关，
          // 只有账号 Host 默认开，它由 host 端 effectivePanelDisabled 显式返回 false。
          const disabled = row?.disabled !== false
          return (
            <div key={key.id} className="rune-setting-row">
              <div className="rune-setting-text">
                <div className="rune-setting-title">{t(key.title)}</div>
                <div className="rune-setting-desc">{t(key.hint)}</div>
                {failed === key.id && <div className="rune-setting-error" role="alert">{t('panel.saveFailed')}</div>}
              </div>
              <Switch
                checked={!disabled}
                disabled={busy === key.id}
                label={t(key.title)}
                onChange={(next: boolean) => { toggle(key.id, next) }}
              />
            </div>
          )
        })}

      <div className="rune-setting-row">
        <div className="rune-setting-text">
          <div className="rune-setting-title">{t('nudge.title')}</div>
          <div className="rune-setting-desc">{t('nudge.description')}</div>
        </div>
        <div className="rune-setting-control">
          <div className="rune-stepper">
            <span className="rune-stepper-value">{every}</span>
            <span className="rune-stepper-arrows">
              <button type="button" className="rune-stepper-arrow" aria-label={t('nudge.increase')}
                disabled={every >= 100} onClick={() => { commitEvery(every + 1) }}>
                <IconChevronUpOutlineRegular size={9} />
              </button>
              <button type="button" className="rune-stepper-arrow" aria-label={t('nudge.decrease')}
                disabled={every <= 1} onClick={() => { commitEvery(every - 1) }}>
                <IconChevronDownOutlineRegular size={9} />
              </button>
            </span>
          </div>
          <span className="rune-stepper-unit">{t('nudge.unit')}</span>
        </div>
      </div>
    </div>
  )
}
