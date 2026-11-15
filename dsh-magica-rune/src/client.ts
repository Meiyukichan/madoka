/**
 * client bundle 入口。构建产物是 `window.__ModuleLoader__.load({ id, factory })`
 * 闭包工厂，factory 返回 `module.exports` —— 所以这里必须导出 `apply` 与 `inject`。
 * @module dsh-magica-rune/client-entry
 */

export { apply, inject } from './client/index.ts'
