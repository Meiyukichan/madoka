/**
 * 版本同步：把仓库内所有 `dsh-magica-*` 子包的 version 对齐（仓库约定从 0.2.0-alpha.1 起）。
 *
 * 用法：`pnpm version:set 0.2.0-alpha.2`（不传则读本包当前 version 并向下传播）。
 *
 * @module dsh-magica-spellbook/scripts/set-version
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..')
const selfManifestPath = join(import.meta.dirname, '..', 'package.json')
const selfManifest = JSON.parse(readFileSync(selfManifestPath, 'utf8'))
const version = process.argv[2] ?? selfManifest.version

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`invalid version: ${String(version)}`)
  process.exit(1)
}

let updated = 0
for (const name of readdirSync(root, { withFileTypes: true })) {
  if (!name.isDirectory() || !name.name.startsWith('dsh-magica-')) continue
  const manifestPath = join(root, name.name, 'package.json')
  let text
  try {
    text = readFileSync(manifestPath, 'utf8')
  } catch {
    continue
  }
  const manifest = JSON.parse(text)
  if (manifest.version === version) continue
  manifest.version = version
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`${name.name}: -> ${version}`)
  updated += 1
}

console.log(updated === 0 ? `all packages already at ${version}` : `updated ${updated} package(s) to ${version}`)
