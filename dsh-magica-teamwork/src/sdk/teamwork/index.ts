/**
 * teamwork 分组入口：`client.teamwork.project` / `client.teamwork.device`。
 */

import type { CastboardTransport } from '../transport.js'
import { CastboardTeamworkDeviceApi } from './device.js'
import { CastboardTeamworkProjectApi } from './project.js'

export { CastboardTeamworkDeviceApi } from './device.js'
export { CastboardTeamworkProjectApi } from './project.js'
export {
  affectedOf,
  emptyBodyFail,
  invalidBodyCode,
  mapFailure,
  normalizePage,
  pageOfArray,
  pageParams,
} from './shared.js'

export class CastboardTeamworkApi {
  readonly project: CastboardTeamworkProjectApi
  readonly device: CastboardTeamworkDeviceApi

  constructor(transport: CastboardTransport) {
    this.project = new CastboardTeamworkProjectApi(transport)
    this.device = new CastboardTeamworkDeviceApi(transport)
  }
}
