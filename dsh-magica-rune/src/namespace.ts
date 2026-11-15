/**
 * settings 命名空间常量。
 *
 * 0.2 的 settings namespace **就是 profile 里那条 patch 行的 `id`**
 * （`packages/settings/settings/src/index.ts:317` 的 `entry.options.id`）。
 * 所以它必须与 `cordis.patch.yml` 的 `insert.id` 完全一致，改了前端就写不回去。
 * @module dsh-magica-rune/namespace
 */

export const ABILITY_NS = 'dsh-magica-rune'

/** 前端读取目录数据的 HTTP 路由。 */
export const CATALOG_PATH = '/rune-ability/catalog'
