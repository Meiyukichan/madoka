/**
 * 两级作用域：全局 vs 工作区。
 *
 * 关键语义（raw §7.3）：工作区配置**叠加**在全局之上，且工作区内的 set 已折叠全局，
 * 所以「全局禁用 + 某工作区启用」必须有效，反向同理。
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  chooseWorkspaceAt, launchBrowser, newPage, openAbility, pill, pillNames, readGlobalDisabled,
  readWorkspaceDisabled, settle, zoneCounts,
} from './harness.mjs'

const TOOL = 'read'

let browser
let page

async function waitWorkspaceDisabled(workspaceId, predicate, label) {
  const deadline = Date.now() + 8_000
  let last = {}
  while (Date.now() < deadline) {
    last = readWorkspaceDisabled()
    if (predicate(new Set(last[workspaceId] ?? []))) return
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  assert.fail(`${label}：patch 里是 ${JSON.stringify(last)}`)
}

before(async () => {
  browser = await launchBrowser()
  page = await newPage(browser)
  await openAbility(page, process.env.DSH_E2E_URL)
  await settle(page)
})

after(async () => {
  await browser?.close()
})

describe('工作区 zone', () => {
  it('未选中时下拉显示「未选择」、工作区区不展开', async () => {
    await page.waitForFunction(() => document.querySelector('.rune-select')?.textContent.trim() === '未选择')
    const info = await page.evaluate(() => {
      const select = document.querySelector('.rune-select')
      const zones = document.querySelectorAll('.rune-zone')
      return {
        text: select?.textContent.trim(),
        empty: select?.getAttribute('data-empty'),
        expanded: zones[1]?.querySelector('.rune-zone-toggle')?.getAttribute('aria-expanded'),
      }
    })
    assert.equal(info.text, '未选择')
    assert.equal(info.empty, 'true')
    assert.equal(info.expanded, 'false')
  })

  it('选中工作区后自动展开，并显示同一批能力', async () => {
    await chooseWorkspaceAt(page, 0)
    await page.waitForFunction(() => {
      const zones = document.querySelectorAll('.rune-zone')
      return zones[1]?.querySelector('.rune-zone-toggle')?.getAttribute('aria-expanded') === 'true'
    })
    const global = await pillNames(page, 0)
    const workspace = await pillNames(page, 1)
    assert.deepEqual(workspace, global, '两个 zone 展示同一批能力，只是作用域不同')
  })
})

describe('工作区级禁用不影响全局', () => {
  it('只改工作区计数，全局保持启用，patch 记在 workspaces 下', async () => {
    await chooseWorkspaceAt(page, 0)

    // 前提：TOOL 全局启用
    if (readGlobalDisabled().includes(TOOL)) {
      await pill(page, 0, TOOL).click()
      await new Promise(resolve => setTimeout(resolve, 800))
    }
    assert.equal(readGlobalDisabled().includes(TOOL), false, `前提：${TOOL} 全局启用`)

    const beforeCounts = await zoneCounts(page)
    await pill(page, 1, TOOL).click()
    await new Promise(resolve => setTimeout(resolve, 900))

    const afterCounts = await zoneCounts(page)
    assert.equal(afterCounts[0], beforeCounts[0], '全局计数不应变化')
    assert.notEqual(afterCounts[1], beforeCounts[1], '工作区计数应变化')
    assert.equal(readGlobalDisabled().includes(TOOL), false, '全局仍然启用')

    const workspaces = readWorkspaceDisabled()
    const workspaceId = Object.keys(workspaces).find(id => (workspaces[id] ?? []).includes(TOOL))
    assert.ok(workspaceId !== undefined, `patch 应记录工作区级禁用：${JSON.stringify(workspaces)}`)

    // 复原：在工作区 zone 再点一次
    await pill(page, 1, TOOL).click()
    await waitWorkspaceDisabled(workspaceId, set => !set.has(TOOL), '工作区应恢复')
  })
})
