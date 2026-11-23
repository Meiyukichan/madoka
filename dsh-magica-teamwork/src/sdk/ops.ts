/**
 * 运维分组（M1 / M2 + 能力探测）。
 *
 * `probe()` 是本 SDK 的"能力闸"来源：把 `/version.endpoints[]` 装进 transport，
 * 之后调未声明的端点直接 `unsupported`（零请求）。第三方自部署服务少了某个端点时，
 * 不会在业务路径上炸，而是在这里被明确识别。
 */

import type { CastboardTransport } from './transport.js'
import { castboardFail, castboardOk, type CastboardResult } from './result.js'
import type { CastboardHealth, CastboardVersion } from './types.js'

/** 协议名（服务端 `/version.protocol`） */
export const CASTBOARD_PROTOCOL = 'dsh-teamwork/1'

export interface CastboardProbeResult {
  protocol: string
  endpoints: string[]
}

export class CastboardOpsApi {
  constructor(
    private readonly transport: CastboardTransport,
    private readonly options: { strictProtocol?: boolean } = {},
  ) {}

  /** M1 `GET /health`：健康 + 版本 + 时钟（停机中服务端回 503） */
  async health(): Promise<CastboardResult<CastboardHealth>> {
    return this.transport.call<CastboardHealth>('health')
  }

  /** M2 `GET /version`：协议与能力清单 */
  async version(): Promise<CastboardResult<CastboardVersion>> {
    return this.transport.call<CastboardVersion>('version')
  }

  /**
   * 能力探测：校验 `protocol` 并把 `endpoints[]` 装进 transport。
   *
   * `strictProtocol: true` 时协议不匹配直接失败（默认只提示不拦，方便灰度）。
   */
  async probe(): Promise<CastboardResult<CastboardProbeResult>> {
    const result = await this.version()
    if (!result.ok) return result
    const protocol = typeof result.data?.protocol === 'string' ? result.data.protocol : ''
    const endpoints = Array.isArray(result.data?.endpoints) ? result.data.endpoints : []
    if (protocol !== CASTBOARD_PROTOCOL) {
      const fail = castboardFail({
        status: result.status,
        code: 'incompatible_server',
        reason: `协议不匹配：期望 ${CASTBOARD_PROTOCOL}，服务端是 ${protocol === '' ? '(空)' : protocol}`,
      })
      if (this.options.strictProtocol === true) return fail
      // 非严格模式：不装能力表（不能拿别人的清单当我们的），但仍把协议问题说出来
      return fail
    }
    this.transport.setCapabilities(endpoints)
    return castboardOk(result.status, { protocol, endpoints })
  }
}
