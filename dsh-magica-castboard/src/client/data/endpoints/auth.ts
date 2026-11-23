/**
 * 认证面：登录状态、登录、登出。
 *
 * `password` 只在本机 HTTP 通道上发送一次；SDK 落盘的是派生凭据，接口从不回传 token。
 *
 * @module dsh-magica-castboard/client/data/endpoints/auth
 */
import { apiGet, apiPost } from '../api.ts'

export type AuthState = 'authenticated' | 'login_required' | 'anonymous'

export interface AuthSnapshot {
  state: AuthState
  accountId?: string
  displayName?: string
  globalRole?: string
}

export interface DataPlaneStatus {
  ok: boolean
  reason?: string
  configPath?: string
}

export function apiDataPlane(): Promise<DataPlaneStatus> {
  return apiGet<DataPlaneStatus>('/data-plane')
}

export function apiAuthStatus(): Promise<AuthSnapshot> {
  return apiGet<AuthSnapshot>('/auth')
}

export function apiLogin(input: { accountId: string; password: string }): Promise<AuthSnapshot> {
  return apiPost<AuthSnapshot>('/auth/login', input)
}

export function apiRegister(input: {
  accountId: string
  password: string
  displayName?: string
}): Promise<AuthSnapshot> {
  return apiPost<AuthSnapshot>('/auth/register', input)
}

export function apiLogout(): Promise<AuthSnapshot> {
  return apiPost<AuthSnapshot>('/auth/logout')
}
