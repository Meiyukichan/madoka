/**
 * 鉴权扩展点：样例服务只认 HTTP 协议，企业可以替换整个服务；这份接口用于样例内部
 * 把「签发 headers」与「校验 headers」拆开，避免路由继续写死 JWT 双头。
 */
import type { CurrentUser } from './guard.js'

/** `/auth/token` 可选的设备信息；IP 不作为身份，设备绑定用稳定的 `id`。 */
export interface AuthDevice {
  id?: string
  host?: string
  port?: number
  os?: string
}

/** 一次认证交换的结果；`headers` 原样交给 SDK，不限定 header 名字。 */
export interface AuthGrant {
  accountId: string
  headers: Record<string, string>
  /** epoch ms；`null` = 只能靠后续 401 判断过期。 */
  expiresAt: number | null
  displayName?: string | null
  globalRole?: CurrentUser['globalRole']
}

export interface AuthTokenInput {
  accountId: string
  accountToken: string
  device?: AuthDevice
}

export type RequestHeaders = Record<string, string | string[] | undefined>

export interface AuthProvider {
  /** 账号 + 长期凭据 → 短期请求 headers。 */
  issue(input: AuthTokenInput): Promise<AuthGrant> | AuthGrant
  /** 任意请求 headers → 当前用户；失败抛 401/403 BusinessError。 */
  authenticate(input: { headers: RequestHeaders }): Promise<CurrentUser> | CurrentUser
  /** 撤销/清缓存；无状态实现可以什么都不做。 */
  logout(input: { headers: RequestHeaders }): void | Promise<void>
}
