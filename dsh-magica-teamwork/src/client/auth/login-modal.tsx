/**
 * Teamwork 登录弹窗：DSH 官方 Modal / Input / Button，纯展示组件，不发请求。
 *
 * 状态与提交由宿主（castboard）通过 props 传入，组件本身不碰 ctx / fetch。
 *
 * @module dsh-magica-teamwork/client/auth
 */
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, type ReactNode } from 'react'

export type LoginState = 'anonymous' | 'login_required'

export interface LoginCredentials {
  accountId: string
  password: string
}

export interface LoginModalProps {
  open: boolean
  /** `anonymous` = 从未登录；`login_required` = 旧会话失效。 */
  state?: LoginState
  lang?: 'zh' | 'en'
  /** 宿主 locale 的翻译函数；省略时退回内置 zh/en 字典。 */
  t?: (key: string, params?: Record<string, string | number>) => string
  busy?: boolean
  error?: string
  accountId?: string
  onSubmit: (input: LoginCredentials) => void
  onClose?: () => void
}

const TEXT = {
  zh: {
    title: '登录 Teamwork',
    anonymous: '连接已就绪。登录后即可同步团队 issue、评论与项目成员。',
    expired: '登录状态已失效，请重新登录后继续同步。',
    account: '账号',
    accountHint: '账号 / 账号',
    password: '密码',
    passwordHint: '密码',
    cancel: '暂不登录',
    submit: '登录',
    submitting: '登录中…',
    required: '请填写账号和密码',
    close: '关闭',
  },
  en: {
    title: 'Sign in to Teamwork',
    anonymous: 'The service is ready. Sign in to sync issues, comments and project members.',
    expired: 'Your session expired. Sign in again to keep syncing.',
    account: 'Account',
    accountHint: 'Employee ID / account',
    password: 'Password',
    passwordHint: 'Password',
    cancel: 'Not now',
    submit: 'Sign in',
    submitting: 'Signing in…',
    required: 'Enter both account and password',
    close: 'Close',
  },
} as const

const labelStyle = {
  display: 'grid',
  gap: 6,
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
} as const

export function LoginModal(props: LoginModalProps): ReactNode {
  const fallback = TEXT[props.lang ?? 'zh']
  const text = {
    title: props.t?.('login.title') ?? fallback.title,
    anonymous: props.t?.('login.anonymous') ?? fallback.anonymous,
    expired: props.t?.('login.expired') ?? fallback.expired,
    account: props.t?.('login.account') ?? fallback.account,
    accountHint: props.t?.('login.accountHint') ?? fallback.accountHint,
    password: props.t?.('login.password') ?? fallback.password,
    passwordHint: props.t?.('login.passwordHint') ?? fallback.passwordHint,
    cancel: props.t?.('login.cancel') ?? fallback.cancel,
    submit: props.t?.('login.submit') ?? fallback.submit,
    submitting: props.t?.('login.submitting') ?? fallback.submitting,
    required: props.t?.('login.required') ?? fallback.required,
    close: props.t?.('login.close') ?? fallback.close,
  }
  const [account, setAccount] = useState(props.accountId ?? '')
  const [password, setPassword] = useState('')
  const [localError, setLocalError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!props.open) return
    setAccount(props.accountId ?? '')
    setPassword('')
    setLocalError(undefined)
  }, [props.open, props.accountId])

  const submit = (): void => {
    if (props.busy === true) return
    if (account.trim() === '' || password === '') {
      setLocalError(text.required)
      return
    }
    setLocalError(undefined)
    props.onSubmit({ accountId: account.trim(), password })
  }

  const error = localError ?? props.error
  return (
    <Modal
      open={props.open}
      onClose={props.onClose ?? (() => { /* login stays open until submitted */ })}
      title={text.title}
      description={props.state === 'login_required' ? text.expired : text.anonymous}
      closeLabel={text.close}
      footer={(
        <>
          {props.onClose === undefined ? null : (
            <Button variant="outline" onClick={props.onClose} disabled={props.busy === true}>{text.cancel}</Button>
          )}
          <Button variant="primary" onClick={submit} disabled={props.busy === true}>
            {props.busy === true ? text.submitting : text.submit}
          </Button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 14, minWidth: 320 }}>
        <label style={labelStyle}>
          <span>{text.account}</span>
          <Input
            value={account}
            placeholder={text.accountHint}
            autoComplete="username"
            data-modal-autofocus
            disabled={props.busy === true}
            onChange={event => { setAccount(event.target.value) }}
            onKeyDown={event => { if (event.key === 'Enter') submit() }}
            style={{ width: '100%' }}
          />
        </label>
        <label style={labelStyle}>
          <span>{text.password}</span>
          <Input
            type="password"
            value={password}
            placeholder={text.passwordHint}
            autoComplete="current-password"
            disabled={props.busy === true}
            onChange={event => { setPassword(event.target.value) }}
            onKeyDown={event => { if (event.key === 'Enter') submit() }}
            style={{ width: '100%' }}
          />
        </label>
        {error === undefined || error === ''
          ? null
          : <p role="alert" style={{ margin: 0, color: 'var(--dsw-alias-state-error)', fontSize: 12 }}>{error}</p>}
      </div>
    </Modal>
  )
}
