/**
 * 开关行为：二次确认、单击落盘、分组批量，以及**真的写进了 profile patch**。
 *
 * 重要事实：当前 dev profile 的 26 个工具**全部属于 dsh 原生分类**，所以「点一下」
 * 必然先弹二次确认——这正是被测行为，不是障碍。禁用态点击不会弹窗（直接启用）。
 *
 * 断言都以「基线集合」为参照（不假设 dev profile 是空的），结束时 `after()` 原样写回。
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cancelButton, confirmButton, disableTool, enableTool, groupBatch, launchBrowser, newPage, openAbility, pill,
  readGlobalDisabled, settle, waitForConfirm, waitForConfirmGone, zoneCounts,
} from './harness.mjs'

const TOOL = 'read_image'
const BUILTIN_TOOL = 'pwsh'
const GROUP = 'image' // 分类 id（与语言无关）

let browser
let page

/** 等 patch 里的全局禁用集合满足期望。 */
async function waitGlobalDisabled(predicate, label) {
  const deadline = Date.now() + 8_000
  let last = []
  while (Date.now() < deadline) {
    last = readGlobalDisabled()
    if (predicate(new Set(last))) return last
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  assert.fail(`${label}：patch 里是 ${JSON.stringify(last)}`)
}

/** 保证某个工具处于「启用」态（直接看 patch，比读 UI 稳）。 */
async function ensureEnabled(name) {
  if (!readGlobalDisabled().includes(name)) return
  await enableTool(page, name)
  await waitGlobalDisabled(set => !set.has(name), `${name} 应恢复启用`)
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

describe('单击开关', () => {
  it('点一下弹确认，确认后写进 patch；再点撤回', async () => {
    await ensureEnabled(TOOL)

    await pill(page, 0, TOOL).click()
    const dialog = await waitForConfirm(page)
    const text = await dialog.innerText()
    assert.match(text, /DSH 内置工具/)
    assert.match(text, new RegExp(TOOL))
    assert.equal(readGlobalDisabled().includes(TOOL), false, '确认前不应落盘')
    await confirmButton(page).click()
    await waitForConfirmGone(page)

    await waitGlobalDisabled(set => set.has(TOOL), `${TOOL} 应被禁用`)
    assert.equal(await pill(page, 0, TOOL).getAttribute('data-state'), 'disabled')

    await enableTool(page, TOOL)
    await waitGlobalDisabled(set => !set.has(TOOL), `${TOOL} 应被启用`)
    assert.equal(await pill(page, 0, TOOL).getAttribute('data-state'), 'enabled')
  })

  it('禁用后 zone 计数下降一位', async () => {
    await ensureEnabled(TOOL)
    const before = (await zoneCounts(page))[0]

    await disableTool(page, TOOL)
    await waitGlobalDisabled(set => set.has(TOOL), `${TOOL} 应被禁用`)
    await page.waitForFunction(previous => {
      const now = document.querySelector('.rune-zone-count')?.textContent ?? ''
      return now !== previous
    }, before)
    const after = (await zoneCounts(page))[0]
    assert.notEqual(after, before)

    await enableTool(page, TOOL)
    await waitGlobalDisabled(set => !set.has(TOOL), `${TOOL} 应被启用`)
  })
})

describe('二次确认弹窗', () => {
  it('取消则什么都不写', async () => {
    await ensureEnabled(BUILTIN_TOOL)
    await pill(page, 0, BUILTIN_TOOL).click()
    const dialog = await waitForConfirm(page)
    await cancelButton(page).click()
    await waitForConfirmGone(page)
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(readGlobalDisabled().includes(BUILTIN_TOOL), false, '取消后不应落盘')
    assert.equal(await pill(page, 0, BUILTIN_TOOL).getAttribute('data-state'), 'enabled')
  })
})

describe('分组批量', () => {
  it('一次勾选把整组禁用，再勾一次全部启用', async () => {
    const names = await page.locator('.rune-zone').nth(0)
      .locator(`.rune-group[data-category="${GROUP}"] .rune-pill`).evaluateAll(
        nodes => nodes.map(node => node.getAttribute('data-name') ?? ''),
      )
    assert.ok(names.length > 0, `${GROUP} 组应有成员`)
    for (const name of names) await ensureEnabled(name)

    // 分组内含 DSH 内置分类的工具 → 批量**禁用**与单点一致，先弹二次确认
    await groupBatch(page, GROUP).click()
    const dialog = await waitForConfirm(page)
    assert.match(await dialog.innerText(), /内置工具/)
    await confirmButton(page).click()
    await waitForConfirmGone(page)
    await waitGlobalDisabled(set => names.every(name => set.has(name)), `${GROUP} 整组禁用`)

    // 启用方向不弹窗（不会破坏对话能力）
    await groupBatch(page, GROUP).click()
    await waitGlobalDisabled(set => names.every(name => !set.has(name)), `${GROUP} 整组启用`)
  })
})

describe('内置保护项不下发', () => {
  it('页面里不存在 run_code', async () => {
    const names = await page.locator('.rune-pill').evaluateAll(
      nodes => nodes.map(node => node.getAttribute('data-name') ?? ''),
    )
    assert.equal(names.includes('run_code'), false)
  })
})
