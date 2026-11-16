/**
 * 运维分组（M1 / M2 + 能力探测）。
 *
 * `probe()` 是本 SDK 的"能力闸"来源：把 `/version.endpoints[]` 装进 transport，
 * 之后调未声明的端点直接 `unsupported`（零请求）。第三方自部署服务少了某个端点时，
 * 不会在业务路径上炸，而是在这里被明确识别。
 */

import type { LatticeTransport } from './transport.js'
import { latticeFail, latticeOk, type LatticeResult } from './result.js'
import type { LatticeHealth, LatticeVersion } from './types.js'

/** 协议名（服务端 `/version.protocol`） */
export const LATTICE_PROTOCOL = 'dsh-teamwork/1'

export interface LatticeProbeResult {
  protocol: string
  endpoints: string[]
}

export class LatticeOpsApi {
  constructor(
    private readonly transport: LatticeTransport,
    private readonly options: { strictProtocol?: boolean } = {},
  ) {}

  /** M1 `GET /health`：健康 + 版本 + 时钟（停机中服务端回 503） */
  async health(): Promise<LatticeResult<LatticeHealth>> {
    return this.transport.call<LatticeHealth>('health')
  }

  /** M2 `GET /version`：协议与能力清单 */
  async version(): Promise<LatticeResult<LatticeVersion>> {
    return this.transport.call<LatticeVersion>('version')
  }

  /**
   * 能力探测：校验 `protocol` 并把 `endpoints[]` 装进 transport。
   *
   * `strictProtocol: true` 时协议不匹配直接失败（默认只提示不拦，方便灰度）。
   */
  async probe(): Promise<LatticeResult<LatticeProbeResult>> {
    const result = await this.version()
    if (!result.ok) return result
    const protocol = typeof result.data?.protocol === 'string' ? result.data.protocol : ''
    const endpoints = Array.isArray(result.data?.endpoints) ? result.data.endpoints : []
    if (protocol !== LATTICE_PROTOCOL) {
      const fail = latticeFail({
        status: result.status,
        code: 'incompatible_server',
        reason: `协议不匹配：期望 ${LATTICE_PROTOCOL}，服务端是 ${protocol === '' ? '(空)' : protocol}`,
      })
      if (this.options.strictProtocol === true) return fail
      // 非严格模式：不装能力表（不能拿别人的清单当我们的），但仍把协议问题说出来
      return fail
    }
    this.transport.setCapabilities(endpoints)
    return latticeOk(result.status, { protocol, endpoints })
  }
}
