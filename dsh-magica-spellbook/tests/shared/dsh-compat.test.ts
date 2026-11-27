import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'

/**
 * dsh 版本兼容守卫：**本包声明的 peer 范围必须覆盖当前安装的真实 dsh 版本**。
 *
 * 为什么需要：我们已把交互/会话类型改成直接引用 `@deepseek-ai/*` 的真实类型，
 * 一旦 dsh 升级超出 peer 上界（或 install 的版本低于下限），类型能编过、但
 * profile 组合期会按 peer 语义禁用插件行。这条测试让"升级 dsh 忘改 peer"当场红。
 */

const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  peerDependencies: Record<string, string>
}

/** 极简 semver：只支持 `>=x.y.z-<pre> <a.b.c-0` 与 `^x.y.z` 两种本仓用到的形式。 */
function parse(version: string): { parts: number[]; pre: string } {
  const [core, pre = ''] = version.split('-')
  const parts = (core ?? '').split('.').map((part) => Number(part))
  return { parts: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0], pre }
}

function compare(a: string, b: string): number {
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < 3; index += 1) {
    const delta = (left.parts[index] ?? 0) - (right.parts[index] ?? 0)
    if (delta !== 0) return delta
  }
  // 同版本号时：无 prerelease > 有 prerelease；两边都有则按字符串比（本仓够用）
  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  return left.pre < right.pre ? -1 : 1
}

function satisfiesOne(version: string, range: string): boolean {
  // `>=A <B`
  const bounded = /^>=\s*(\S+)\s+<\s*(\S+)$/.exec(range.trim())
  if (bounded !== null) {
    const [, min, max] = bounded
    return compare(version, min ?? '0.0.0') >= 0 && compare(version, max ?? '0.0.0') < 0
  }
  // `^A`（只用于 cordis 这类普通版本）
  const caret = /^\^(\S+)$/.exec(range.trim())
  if (caret !== null) {
    const base = caret[1] ?? '0.0.0'
    const { parts } = parse(base)
    const max = `${parts[0] ?? 0}.${(parts[1] ?? 0) + 1}.0-0`
    return compare(version, base) >= 0 && compare(version, max) < 0
  }
  // `>=A`
  const atLeast = /^>=\s*(\S+)$/.exec(range.trim())
  if (atLeast !== null) return compare(version, atLeast[1] ?? '0.0.0') >= 0
  return false
}

/**
 * 本包 peer 用 `A || B || C` 表达三条 0.2 线：0.2.0 线、0.2.1-rc.5 起的
 * 0.2.1 线、0.2.2-rc.1 起的 0.2.2 线。标准 semver 会把 prerelease 限制在
 * 同 [major, minor, patch] 的比较器上，所以不能只写 `>=0.2.0-rc.2 <0.3.0-0`。
 */
function satisfies(version: string, range: string): boolean {
  return range.split('||').some((part) => satisfiesOne(version, part))
}

describe('dsh 版本兼容（peer 范围覆盖已安装版本）', () => {
  it('每个 peer 的已安装版本都落在声明范围内', () => {
    const checked: string[] = []
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      if (name === 'react') continue
      let installed: string
      try {
        installed = (require(`${name}/package.json`) as { version: string }).version
      } catch {
        // optional peer 没装：跳过（这正是 optional 的意义）
        continue
      }
      assert.ok(
        satisfies(installed, range),
        `${name}@${installed} 不在 peer 范围 ${range} 内（升 dsh 后忘了改 package.json？）`,
      )
      checked.push(`${name}@${installed}`)
    }
    assert.ok(checked.length >= 10, `只校验到 ${checked.length} 个包，安装可能不完整`)
  })

  it('peer 范围覆盖 0.2.0 / 0.2.1 / 0.2.2，且不放进 0.1.x / 0.3.x', () => {
    const supported = [
      '0.2.0-rc.2',
      '0.2.0',
      '0.2.1-rc.5',
      '0.2.1',
      '0.2.2-rc.5',
      '0.2.2',
    ]
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      if (name === 'react' || name === '@deepseek-ai/cordis') continue
      for (const version of supported) {
        assert.ok(satisfies(version, range), `${name}: ${version} 应落在 ${range} 内`)
      }
      for (const version of ['0.1.2-rc.1', '0.3.0-rc.1']) {
        assert.ok(!satisfies(version, range), `${name}: ${version} 不应落在 ${range} 内`)
      }
    }
  })

  it('cordis peer 覆盖已安装版本（4.x）', () => {
    const range = manifest.peerDependencies['@deepseek-ai/cordis'] ?? ''
    const installed = (require('@deepseek-ai/cordis/package.json') as { version: string }).version
    assert.ok(satisfies(installed, range), `cordis@${installed} 不在 ${range} 内`)
  })
})
