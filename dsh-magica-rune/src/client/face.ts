/**
 * client 侧用到的 dsh 运行时表面的结构性声明（与 `shared/dsh.ts` 同一思路：
 * 本仓未安装 dsh 依赖，用结构类型让代码可离线编译；运行时由真实实现满足）。
 *
 * 形状来源：
 * - `ctx.remote.settings.describe/replace` + `{ ok, value / error }` 信封
 *   （`packages/api/settings-controller/src/index.ts:97-139`、`ui-settings/src/client/settings-mirror.ts:183-186`）
 * - `ctx.remote.$on`（白名单见 `packages/api/remotes/src/remote-events.ts`）
 * - `ctx.slots.inject/register`、`ctx.locale.register/bind`
 * @module dsh-magica-rune/client/face
 */

/** remote 调用的统一信封。 */
export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { message: string } }

/** `settings.describe()` 里一条 namespace。 */
export interface SettingsNamespaceView {
  ns: string
  value: unknown
  revision: number
}

/** `ctx.remote.settings`。 */
export interface RemoteSettingsFace {
  describe(): Promise<RemoteResult<{ namespaces: SettingsNamespaceView[] }>>
  replace(
    ns: string,
    section: Record<string, unknown>,
    expectedRevision?: number,
  ): Promise<RemoteResult<{ revision: number }>>
}

/** `ctx.remote`。 */
export interface RemoteFace {
  settings: RemoteSettingsFace
  $on(event: string, listener: (...args: never[]) => void): () => void
}

/** `ctx.locale`。 */
export interface LocaleFace {
  register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string
}

/** `ctx.slots` 的最小子集。 */
export interface SlotsFace {
  inject(key: string, register: () => unknown): void
  register(options: Record<string, unknown>, component: unknown): unknown
}

/** client 插件 ctx 的最小子集。 */
export interface DshContextLike {
  readonly remote: RemoteFace
  readonly locale: LocaleFace
  readonly slots: SlotsFace
  on(event: string, listener: (...args: never[]) => unknown): () => void
  effect(callback: () => (() => void) | void, label?: string): () => void
}
