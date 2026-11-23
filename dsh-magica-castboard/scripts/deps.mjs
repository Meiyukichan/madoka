/**
 * 工具链解析：优先本包 `node_modules`，其次兄弟包（本仓 pnpm workspace 尚未安装依赖时的兜底）。
 *
 * 为什么需要它：本仓是 pnpm workspace，但开发机（受限沙箱）里 pnpm 的全局 store 锁不可用，
 * `pnpm install` 会 EPERM。为了在"没装依赖"时也能构建/类型检查，构建脚本按需在
 * 兄弟包里找 esbuild / typescript / react / playwright。装好依赖后本包优先，行为不变。
 *
 * @module dsh-magica-castboard/scripts/deps
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(here, '..')
export const REPO_ROOT = resolve(PKG_ROOT, '..')

/** 兄弟包（按优先级）。 */
const SIBLINGS = ['dsh-magica-spellbook', 'dsh-magica-rune', 'dsh-magica-teamwork']

/** 在本包与兄弟包中查找一个存在的相对路径。 */
export function findInPackages(relative) {
  const candidates = [join(PKG_ROOT, relative), ...SIBLINGS.map(s => join(REPO_ROOT, s, relative))]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return undefined
}

/** 解析一个必需的可执行 JS 入口（找不到就抛，错误里列出找过的位置）。 */
export function requireBin(relative, label) {
  const found = findInPackages(relative)
  if (found === undefined) {
    throw new Error(
      `找不到 ${label}：先在 ${PKG_ROOT} 执行 pnpm install（找过：本包 node_modules 与 ${SIBLINGS.join(' / ')}）`,
    )
  }
  return found
}

/** esbuild 的 bin 入口（跨平台）。 */
export function esbuildBin() {
  return requireBin(join('node_modules', 'esbuild', 'bin', 'esbuild'), 'esbuild')
}

/** typescript 的 tsc 入口。 */
export function tscBin() {
  return requireBin(join('node_modules', 'typescript', 'bin', 'tsc'), 'typescript')
}

/** react 包目录（构建期 external 不需要，但类型检查与 e2e harness 需要）。 */
export function reactDir() {
  return dirname(requireBin(join('node_modules', 'react', 'package.json'), 'react'))
}

/** playwright 包目录。 */
export function playwrightDir() {
  return dirname(requireBin(join('node_modules', 'playwright', 'package.json'), 'playwright'))
}
