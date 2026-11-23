/**
 * 诊断弹窗。
 *
 * @module dsh-magica-castboard/client/features/board/diagnostics
 */
import type { BoardStore } from '../../data/state/index.ts'
import type { Translate } from '../../labels/index.ts'
import { Sheet, Tip } from '../../kit/index.ts'

// ─── 健康诊断 ────────────────────────────────────────────────────────

/** 只读诊断读数（台账修订号 / 条数 / 执行中 / 写权限 / 实例 / 共享库能力）。 */
export function DiagnosticsSheet({ store, t }: { store: BoardStore; t: Translate }) {
  const state = store.getSnapshot()
  const diagnostics = state.diagnostics
  const running = state.tasks.filter(task => task.hasRunning === true).length
  const sdkMissing = diagnostics?.sdkMissing ?? []
  return (
    <Sheet open onClose={() => { store.closeDiagnostics() }} title={t('diag.title')} hint={t('diag.subtitle')} width="sm">
      {diagnostics === undefined
        ? <div className="lt-empty-small">{t('common.loading')}</div>
        : (
            <>
              <div className="lt-diag-grid">
                <div className="lt-diag-item"><b>{diagnostics.revision ?? 0}</b><span>{t('diag.revision')}</span></div>
                <div className="lt-diag-item"><b>{diagnostics.tasks ?? 0}</b><span>{t('diag.tasks')}</span></div>
                <div className="lt-diag-item"><b>{diagnostics.issues ?? 0}</b><span>{t('diag.issues')}</span></div>
                <div className="lt-diag-item" data-bad={running > 0 ? 'true' : undefined}><b>{running}</b><span>{t('diag.running')}</span></div>
                <div className="lt-diag-item" data-bad={diagnostics.writable === false ? 'true' : undefined}>
                  <b>{diagnostics.writable === false ? 'RO' : 'RW'}</b><span>{t('diag.writable')}</span>
                </div>
                <div className="lt-diag-item">
                  <Tip label={diagnostics.instance ?? ''} align="center"><b className="lt-diag-text">{diagnostics.instance ?? '—'}</b></Tip>
                  <span>{t('diag.instance')}</span>
                </div>
              </div>
              {sdkMissing.length > 0 && (
                <div className="lt-card-block" data-kind="degraded">
                  <div className="lt-block-label">{t('diag.sdkMissing')}</div>
                  {sdkMissing.map(item => <span key={item} className="lt-note" data-tone="bad">{item}</span>)}
                </div>
              )}
            </>
          )}
    </Sheet>
  )
}
