/**
 * 搜索框：按名字、按分类、跨 zone 同源过滤。
 *
 * 断言全部**按当前 profile 的实际工具自适应**：dev profile 的工具清单会随预设/插件
 * 变化（实测出现过 21 个与 50 个两种），写死 `job_*` 一类名字会随环境漂。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  chooseWorkspaceAt, launchBrowser, newPage, openAbility, pillNames, searchInput, settle,
  startServer, zoneCounts,
} from './harness.mjs'

let server
let browser
let page

async function search(text) {
  await searchInput(page).fill(text)
  await page.waitForTimeout(250)
}

/** 等到 zone 里至少出现 `minimum` 个药丸（清空搜索后 DOM 需要一点时间回来）。 */
async function waitPills(zone = 0, minimum = 1) {
  let names = []
  for (let i = 0; i < 60 && names.length < minimum; i++) {
    await page.waitForTimeout(150)
    names = await pillNames(page, zone)
  }
  return names
}

before(async () => {
  server = await startServer()
  browser = await launchBrowser()
  page = await newPage(browser)
  await openAbility(page, server.url)
  await settle(page)
})

after(async () => {
  await browser?.close()
  await server?.stop()
})

describe('按名字搜索', () => {
  it('搜真实工具名的前缀，结果包含它且是子集', async () => {
    await openAbility(page, server.url)
    await settle(page)
    const names = await waitPills(0)
    assert.ok(names.length > 0, '应有工具')
    const sample = [...names].sort()[0]
    const term = sample.split('_')[0]

    await search(term)
    const filtered = await waitPills(0)
    assert.ok(filtered.length > 0, `搜索 "${term}" 应命中`)
    assert.ok(filtered.length <= names.length, '结果应是全集的子集')
    assert.ok(filtered.includes(sample), `"${term}" 的结果应包含 ${sample}`)
    await search('')
  })

  it('搜不存在的词展示空态', async () => {
    await openAbility(page, server.url)
    await settle(page)
    await search('这个工具不存在zzz')
    await page.waitForTimeout(300)
    assert.equal(await page.locator('.rune-zone').nth(0).locator('.rune-pill').count(), 0)
    const noResults = await page.getByText('无匹配工具').count() + await page.locator('[class*="no-results"]').count()
    assert.ok(noResults > 0, '应有「无匹配」空态文案')
    await search('')
  })
})

describe('按分类搜索', () => {
  it('搜分类展示名，结果都属于该分类', async () => {
    await openAbility(page, server.url)
    await settle(page)
    const first = page.locator('.rune-zone').nth(0).locator('.rune-group').first()
    const category = await first.getAttribute('data-category')
    // 标题节点形如「标签 + 计数(3/3)」，去掉尾部的计数就是分类展示名；
    // 不要假设内部 span 的层级（0.2.1 上是文本节点拼接）。
    const rawTitle = (await first.locator('.rune-group-title').textContent())?.trim() ?? ''
    const label = rawTitle.replace(/\d+\/\d+$/, '').trim()
    assert.ok(category !== null && label.length > 0, '应能读到第一个分类')

    const inCategory = await page.locator('.rune-zone').nth(0)
      .locator(`.rune-group[data-category="${category}"] .rune-pill`)
      .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-name')))
    assert.ok(inCategory.length > 0, `${category} 组里应有工具`)

    await search(label)
    const filtered = await pillNames(page, 0)
    assert.ok(filtered.length > 0, `搜分类名 "${label}" 应命中`)
    for (const name of filtered) assert.ok(inCategory.includes(name), `${name} 不属于 ${category}`)
    await search('')
  })
})

describe('一个框同时过滤两个 zone', () => {
  it('搜索对两个 zone 同源生效，清空后恢复全量', async () => {
    await openAbility(page, server.url)
    await settle(page)
    await chooseWorkspaceAt(page, 0)
    await settle(page)

    const baseline = await waitPills(0)
    assert.ok(baseline.length > 0, '全局 zone 应有工具')
    const baselineWs = await waitPills(1)
    for (const name of baselineWs) assert.ok(baseline.includes(name), `${name} 应属于全局清单（工作区是继承关系）`)

    const term = [...baseline].sort()[0].split('_')[0]
    await search(term)
    const filtered = await waitPills(0)
    assert.ok(filtered.length > 0, `"${term}" 应命中`)
    const filteredWs = await pillNames(page, 1)
    for (const name of filteredWs) assert.ok(filtered.includes(name), `搜索后 ${name} 应仍在全局结果里（同源过滤）`)
    assert.ok(filteredWs.length > 0, '工作区 zone 不应被过滤空')

    await search('')
    const restored = await waitPills(0)
    assert.deepEqual([...restored].sort(), [...baseline].sort(), '清空后应恢复全量')

    const [enabled, total] = (await zoneCounts(page))[0].split('/').map(Number)
    assert.equal(total, restored.length, '计数里的 total 应等于药丸数')
    assert.ok(enabled <= total)
  })
})
