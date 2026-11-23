/**
 * Teamwork 登录弹窗（castboard 本地实现，DSH Modal / Input / Button）。
 *
 * 文案全部走 castboard 的 locale `t()`；组件不发请求，提交由 AuthGate 负责。
 *
 * @module dsh-magica-castboard/client/features/auth/login-modal
 */
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, type ReactNode } from 'react'

export interface LoginModalProps {
  open: boolean
  state?: 'anonymous' | 'login_required'
  t: (key: string, params?: Record<string, string | number>) => string
  busy?: boolean
  error?: string
  accountId?: string
  onSubmit: (input: { accountId: string; password: string }) => void
  onRegister?: (input: {
    accountId: string
    password: string
    displayName?: string
  }) => void
  onClose?: () => void
}

const labelStyle = {
  display: 'grid',
  gap: 6,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
} as const

export function LoginModal(props: LoginModalProps): ReactNode {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [account, setAccount] = useState(props.accountId ?? '')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [localError, setLocalError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!props.open) return
    setMode('login')
    setAccount(props.accountId ?? '')
    setPassword('')
    setConfirmPassword('')
    setDisplayName('')
    setLocalError(undefined)
  }, [props.open, props.accountId])

  const submit = (): void => {
    if (props.busy === true) return
    if (account.trim() === '' || password === '') {
      setLocalError(props.t('login.required'))
      return
    }
    if (mode === 'register' && props.onRegister !== undefined && password !== confirmPassword) {
      setLocalError(props.t('login.passwordMismatch'))
      return
    }
    setLocalError(undefined)
    if (mode === 'register' && props.onRegister !== undefined) {
      props.onRegister({
        accountId: account.trim(),
        password,
        ...(displayName.trim() === '' ? {} : { displayName: displayName.trim() }),
      })
      return
    }
    props.onSubmit({ accountId: account.trim(), password })
  }

  const error = localError ?? props.error
  const registering = mode === 'register' && props.onRegister !== undefined
  return (
    <Modal
      open={props.open}
      onClose={props.onClose ?? (() => { /* stays open until submitted */ })}
      title={registering ? props.t('login.registerTitle') : props.t('login.title')}
      description={registering
        ? props.t('login.registerHint')
        : (props.state === 'login_required' ? props.t('login.expired') : props.t('login.anonymous'))}
      closeLabel={props.t('login.close')}
      footer={(
        <>
          {props.onClose === undefined ? null : (
            <Button variant="outline" onClick={props.onClose} disabled={props.busy === true}>{props.t('login.cancel')}</Button>
          )}
          {props.onRegister === undefined ? null : (
            <Button
              variant="outline"
              onClick={() => { setMode(registering ? 'login' : 'register'); setLocalError(undefined) }}
              disabled={props.busy === true}
            >
              {registering ? props.t('login.backToLogin') : props.t('login.register')}
            </Button>
          )}
          <Button variant="primary" onClick={submit} disabled={props.busy === true}>
            {props.busy === true
              ? props.t(registering ? 'login.registering' : 'login.submitting')
              : props.t(registering ? 'login.registerSubmit' : 'login.submit')}
          </Button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 14, minWidth: 320 }}>
        <label style={labelStyle}>
          <span>{props.t('login.account')}</span>
          <Input
            value={account}
            placeholder={props.t('login.accountHint')}
            autoComplete="username"
            data-modal-autofocus
            disabled={props.busy === true}
            onChange={event => { setAccount(event.target.value) }}
            onKeyDown={event => { if (event.key === 'Enter') submit() }}
            style={{ width: '100%' }}
          />
        </label>
        <label style={labelStyle}>
          <span>{props.t('login.password')}</span>
          <Input
            type="password"
            value={password}
            placeholder={props.t('login.passwordHint')}
            autoComplete={registering ? 'new-password' : 'current-password'}
            disabled={props.busy === true}
            onChange={event => { setPassword(event.target.value) }}
            onKeyDown={event => { if (event.key === 'Enter') submit() }}
            style={{ width: '100%' }}
          />
        </label>
        {registering ? (
          <>
            <label style={labelStyle}>
              <span>{props.t('login.confirmPassword')}</span>
              <Input
                type="password"
                value={confirmPassword}
                placeholder={props.t('login.confirmPasswordHint')}
                autoComplete="new-password"
                disabled={props.busy === true}
                onChange={event => { setConfirmPassword(event.target.value) }}
                onKeyDown={event => { if (event.key === 'Enter') submit() }}
                style={{ width: '100%' }}
              />
            </label>
            <label style={labelStyle}>
              <span>{props.t('login.displayName')}</span>
              <Input
                value={displayName}
                placeholder={props.t('login.displayNameHint')}
                disabled={props.busy === true}
                onChange={event => { setDisplayName(event.target.value) }}
                onKeyDown={event => { if (event.key === 'Enter') submit() }}
                style={{ width: '100%' }}
              />
            </label>
          </>
        ) : null}
        {error === undefined || error === ''
          ? null
          : <p role="alert" style={{ margin: 0, color: 'var(--dsw-alias-state-error)', fontSize: 12 }}>{error}</p>}
      </div>
    </Modal>
  )
}
