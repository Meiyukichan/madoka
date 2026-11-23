/**
 * 登录闸门：面板连上本地服务后读取 SDK 登录态，未登录时弹 teamwork 的 DSH 登录框。
 *
 * - 没有 auth 面（501）时静默跳过，面板保持本地模式；
 * - 登录成功后刷新一次看板数据，弹窗关闭；
 * - 允许“暂不登录”，本次挂载内不再打扰。
 *
 * @module dsh-magica-castboard/client/features/auth/gate
 */
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState, type ReactNode } from 'react'

import { ApiError, apiAuthStatus, apiDataPlane, apiLogin, apiRegister, type AuthSnapshot, type DataPlaneStatus } from '../../data/index.ts'
import type { BoardStore } from '../../data/state/index.ts'
import { LoginModal } from './login-modal.tsx'
import { ServiceErrorModal } from './service-error.tsx'

function isMissingFace(error: unknown): boolean {
  return error instanceof ApiError && error.status === 501
}

export function AuthGate(props: {
  store: BoardStore
  t: (key: string, params?: Record<string, string | number>) => string
  children?: ReactNode
}) {
  const [snapshot, setSnapshot] = useState<AuthSnapshot | undefined>(undefined)
  const [service, setService] = useState<DataPlaneStatus | undefined>(undefined)
  const [supported, setSupported] = useState(true)
  const [dismissed, setDismissed] = useState(false)
  const [serviceDismissed, setServiceDismissed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [toast, setToast] = useState<{ key: number; text: string } | undefined>(undefined)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    setError(undefined)

    const load = async (): Promise<void> => {
      if (!alive) return
      attempts += 1
      let retry = false

      try {
        const value = await apiDataPlane()
        if (alive) setService(value)
      } catch (cause: unknown) {
        // Host/runtime is still starting: retry briefly instead of silently giving up.
        if (!(cause instanceof ApiError && (cause.status === 404 || cause.status === 501))) retry = true
      }

      try {
        const value = await apiAuthStatus()
        if (alive) setSnapshot(value)
      } catch (cause: unknown) {
        if (isMissingFace(cause)) {
          if (alive) setSupported(false)
        } else if (!(cause instanceof ApiError && cause.status === 404)) {
          retry = true
        }
      }

      if (alive && retry && attempts < 20) {
        timer = setTimeout(() => { void load() }, 1_000)
      }
    }

    void load()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  const serviceFailed = service !== undefined && service.ok === false
  const needed = !serviceFailed && supported && dismissed === false && snapshot !== undefined && snapshot.state !== 'authenticated'

  const submit = (input: { accountId: string; password: string }): void => {
    setBusy(true)
    setError(undefined)
    apiLogin(input)
      .then(async (value) => {
        setSnapshot(value)
        setDismissed(true)
        setToast({ key: Date.now(), text: props.t('login.successLogin', { account: value.accountId ?? input.accountId }) })
        await props.store.refresh().catch(() => { /* the next poll will retry */ })
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => { setBusy(false) })
  }

  const submitRegister = (input: {
    accountId: string
    password: string
    displayName?: string
  }): void => {
    setBusy(true)
    setError(undefined)
    apiRegister(input)
      .then(async (value) => {
        setSnapshot(value)
        setDismissed(true)
        setToast({ key: Date.now(), text: props.t('login.successRegister', { account: value.accountId ?? input.accountId }) })
        await props.store.refresh().catch(() => { /* the next poll will retry */ })
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => { setBusy(false) })
  }

  return (
    <>
      {props.children}
      <LoginModal
        open={needed}
        state={snapshot?.state === 'login_required' ? 'login_required' : 'anonymous'}
        t={props.t}
        {...(snapshot?.accountId === undefined ? {} : { accountId: snapshot.accountId })}
        busy={busy}
        {...(error === undefined ? {} : { error })}
        onSubmit={submit}
        onRegister={submitRegister}
        onClose={() => { setDismissed(true) }}
      />
      {service !== undefined && service.ok === false ? (
        <ServiceErrorModal
          open={serviceDismissed === false}
          reason={service.reason ?? '本地服务不可用'}
          {...(service.configPath === undefined ? {} : { configPath: service.configPath })}
          t={props.t}
          onClose={() => { setServiceDismissed(true) }}
        />
      ) : null}
      {toast === undefined ? null : (
        <Toast
          key={toast.key}
          text={toast.text}
          tone="success"
          onDone={() => { setToast(undefined) }}
        />
      )}
    </>
  )
}
