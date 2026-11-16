/**
 * teamwork 分组入口：`client.teamwork.project` / `client.teamwork.device`。
 */

import type { LatticeTransport } from '../transport.js'
import { LatticeTeamworkDeviceApi } from './device.js'
import { LatticeTeamworkProjectApi } from './project.js'

export { LatticeTeamworkDeviceApi } from './device.js'
export { LatticeTeamworkProjectApi } from './project.js'
export {
  affectedOf,
  emptyBodyFail,
  invalidBodyCode,
  mapFailure,
  normalizePage,
  pageOfArray,
  pageParams,
} from './shared.js'

export class LatticeTeamworkApi {
  readonly project: LatticeTeamworkProjectApi
  readonly device: LatticeTeamworkDeviceApi

  constructor(transport: LatticeTransport) {
    this.project = new LatticeTeamworkProjectApi(transport)
    this.device = new LatticeTeamworkDeviceApi(transport)
  }
}
