/**
 * client 半侧 apply：注册字典、导航图标、controller、设置页。
 *
 * 关键契约（docs/design/03）：
 * - `export const inject` 写的是 **Cordis 服务名**（不是包名）；
 * - slot 注册声明 `locale: NS` → 组件自动拿到 `t`，**组件内不自行订阅 locale**；
 * - 视图状态走 `store:` seat（`defineStore` 工厂），数据 + 写回走 `inject` 的 `hooks`；
 * - `order: 17` 落在「插件」(15) 与「Agent 预设」(20) 之间。
 * @module dsh-magica-rune/client
 */

import type { DshContextLike } from './face.ts'
import { en, NS, zh } from './locales.ts'
import { createAbilityViewStore } from './store.ts'
import { AbilityController } from './controller.ts'
import { setupNavIcon } from './nav-icon.ts'
import { installStyles } from './styles.ts'
import { AbilitySection } from './AbilitySection.tsx'
import { ABILITY_NS } from '../namespace.ts'

/** Cordis 服务依赖（`remote.settings` 是合法 service 名）。 */
export const inject = ['slots', 'locale', 'remote', 'remote.settings']

export function apply(ctx: DshContextLike): void {
  // 样式在工厂执行期注入一次（带 data-plugin，卸载/HMR 由模块系统回收）
  installStyles()

  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-magica-rune: dictionaries')
  ctx.effect(() => setupNavIcon(() => t('nav')), 'dsh-magica-rune: nav icon')

  const controller = new AbilityController(ctx)

  // 外部变更推送 + 重连刷新（`revision` 用于跳过"自己刚写完"的那次）
  ctx.effect(() => {
    const disposers = [
      ctx.remote.$on('settings/document-updated', (...args: never[]) => {
        if (args[0] !== ABILITY_NS) return
        if (args[1] === controller.revision) return
        void controller.load(true)
      }),
      ctx.on('connection/reset', () => { void controller.load(true) }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-magica-rune: settings invalidations')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'ability',
    order: 17,
    // SlotLabel = string | (() => string)；thunk 每次投影重读 → 跟随当前语言
    label: () => t('nav'),
    locale: NS,
    // root scope 用工厂形式：每个 entry 一份实例
    store: createAbilityViewStore,
    inject: () => ({
      hooks: { ability: controller.store },
      load: (silent?: boolean) => controller.load(silent),
      toggle: (
        kind: 'tools' | 'skills', name: string, scope: 'global' | 'workspace', workspaceId?: string,
      ) => controller.toggle(kind, name, scope, workspaceId),
      toggleBatch: (
        kind: 'tools' | 'skills', names: readonly string[],
        scope: 'global' | 'workspace', workspaceId?: string,
      ) => controller.toggleBatch(kind, names, scope, workspaceId),
    }),
  }, AbilitySection))
}
