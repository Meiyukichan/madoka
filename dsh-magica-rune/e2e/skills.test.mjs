/**
 * 技能侧 + 目录接口。
 *
 * 两件事：
 * 1. `/rune-ability/catalog` 是页面的数据源，它的**契约**要锁住（含受保护项不下发、
 *    内置 skill 以 `source: bundled` 出现）；
 * 2. 页面里「技能」tab 能正常列出可管理项，且受保护 skill 不出现在可点列表里。
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { launchBrowser, newPage, openAbility, pillNames } from './harness.mjs'

const CATALOG = '/rune-ability/catalog'

let browser
let page

async function catalog() {
  const base = new URL(process.env.DSH_E2E_URL).origin
  const response = await fetch(`${base}${CATALOG}`)
  assert.equal(response.status, 200)
  return response.json()
}

before(async () => {
  browser = await launchBrowser()
  page = await newPage(browser)
  await openAbility(page, process.env.DSH_E2E_URL)
})

after(async () => { await browser?.close() })

describe('目录接口契约', () => {
  it('命名空间与三份名单齐全', async () => {
    const data = await catalog()
    assert.equal(data.ns, 'dsh-magica-rune')
    assert.ok(Array.isArray(data.tools))
    assert.ok(Array.isArray(data.skills))
    assert.ok(Array.isArray(data.workspaces))
    assert.ok(Array.isArray(data.builtinDisabled))
    assert.ok(Array.isArray(data.nonDisableable))
    assert.ok(Array.isArray(data.skillNonDisableable))
    assert.ok(data.nonDisableable.includes('run_code'), 'run_code 恒在受保护名单')
  })

  it('工具里没有受保护项（run_code 不下发）', async () => {
    const data = await catalog()
    const names = data.tools.map(tool => tool.name)
    assert.equal(names.includes('run_code'), false)
    assert.equal(names.length > 20, true)
    for (const tool of data.tools) {
      assert.equal(typeof tool.name, 'string')
      assert.equal(typeof tool.description, 'string')
    }
  })

  it('内置 skill 以 source=bundled 出现在全局目录里', async () => {
    const data = await catalog()
    const bundled = data.skills.find(skill => skill.name === 'dsh-plugins-principles')
    assert.ok(bundled !== undefined, '随包分发的 skill 应出现在全局目录')
    assert.equal(bundled.source, 'bundled')
    assert.ok(bundled.description.length > 20)
  })

  it('目录里的工具数量与页面一致', async () => {
    const data = await catalog()
    const names = await pillNames(page, 0)
    assert.deepEqual(
      [...names].sort(),
      data.tools.map(tool => tool.name).sort(),
      '页面展示的必须就是目录下发的那批（含受保护项过滤后的结果）',
    )
  })
})

describe('技能 tab', () => {
  it('能列出可管理技能，且不含受保护项', async () => {
    await page.locator('.rune-tab').nth(1).click()
    await page.waitForSelector('.rune-pill')
    const names = await pillNames(page, 0)
    assert.ok(names.length > 0, '应至少列出一个技能')
    const data = await catalog()
    for (const name of names) {
      assert.equal(data.skillNonDisableable.includes(name), false, `${name} 是受保护技能，不该出现在可点列表`)
    }
    // 我们的内置 skill 在受保护名单里 → 页面不可禁（也就不显示）
    assert.equal(names.includes('dsh-plugins-principles'), false)
  })
})
