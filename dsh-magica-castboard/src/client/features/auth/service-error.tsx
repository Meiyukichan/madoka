/**
 * Data-plane 错误弹窗：配置非法或共享库不可达时，告诉用户原因和修复方式。
 *
 * @module dsh-magica-castboard/client/features/auth/service-error
 */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'

export interface ServiceErrorModalProps {
  open: boolean
  reason: string
  configPath?: string
  t: (key: string, params?: Record<string, string | number>) => string
  onClose?: () => void
}

const codeStyle = {
  fontFamily: 'var(--ds-font-family-code, var(--dsh-font-family-code-default, monospace))',
  fontSize: 12,
  lineHeight: 1.55,
  color: 'var(--dsw-alias-label-primary)',
} as const

const exampleStyle = {
  margin: 0,
  padding: '8px 10px',
  borderRadius: 'var(--dsw-radius-md, 8px)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
  ...codeStyle,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
} as const

export function ServiceErrorModal(props: ServiceErrorModalProps): ReactNode {
  return (
    <Modal
      open={props.open}
      onClose={props.onClose ?? (() => { /* keep it visible until fixed */ })}
      title={props.t('service.error.title')}
      closeLabel={props.t('service.error.close')}
      className="dsh-cb-service-error"
      footer={props.onClose === undefined
        ? null
        : <Button variant="primary" onClick={props.onClose}>{props.t('service.error.close')}</Button>}
    >
      <div style={{ display: 'grid', gap: 12, width: '100%', lineHeight: 1.6 }}>
        <div style={{
          display: 'grid',
          gap: 4,
          padding: '10px 12px',
          border: '0.5px solid var(--dsw-alias-border-l2)',
          borderRadius: 'var(--dsw-radius-md, 8px)',
          background: 'var(--dsw-alias-bg-layer-1)',
        }}>
          <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>{props.t('service.error.reason')}</span>
          <span style={{ color: 'var(--dsw-alias-state-error)', fontSize: 13 }}>{props.reason}</span>
        </div>
        {props.configPath === undefined ? null : (
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>{props.t('service.error.config')}</span>
            <code style={{ ...codeStyle, wordBreak: 'break-all' }}>{props.configPath}</code>
          </div>
        )}
        <div style={{ display: 'grid', gap: 6 }}>
          <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>{props.t('service.error.fix')}</span>
          <pre style={exampleStyle}>{'"domain": "127.0.0.1:3939"'}</pre>
          <pre style={exampleStyle}>{'"domain": "team.example.com"'}</pre>
        </div>
        <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>
          {props.t('service.error.restart')}
        </p>
      </div>
    </Modal>
  )
}
