/**
 * 搜索：一个框同时过滤两个 zone，且**工具名 / 分类标识 / 分类展示名**都能命中。
 *
 * 「一个框同时过滤两侧」是刻意与 raw 不同的设计（raw 每 zone 各一个搜索框），
 * 所以这里把它锁死：任何一边漏过滤，测试就会红。
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  chooseWorkspaceAt, groupCategories, launchBrowser, newPage, openAbility, pillNames, searchInput,
  settle, zoneCounts,
} from './harness.mjs'

let browser
let page

async function search(text) {
  await searchInput(page).fill(text)
  await page.waitForTimeout(250)
}

before(async () => {
  browser = await launchBrowser()
  page = await newPage(browser)
  await openAbility(page, process.env.DSH_E2E_URL)
  await settle(page)
})

after(async () => { await browser?.close() })

describe('按工具名搜索', () => {
  it('搜 job 只剩三个 job 工具', async () => {
    await search('job')
    assert.deepEqual((await pillNames(page, 0)).sort(), ['job_kill', 'job_list', 'job_output'])
    assert.deepEqual(await groupCategories(page, 0), ['job'])
  })
})

describe('按分类搜索', () => {
  it('分类标识（英文 id）能命中：shell → shell 组', async () => {
    await search('shell')
    assert.deepEqual(await groupCategories(page, 0), ['shell'])
    assert.deepEqual(await pillNames(page, 0), ['pwsh'])
  })

  it('分类展示名（中文）能命中：文件 → file 组', async () => {
    await search('文件')
    assert.deepEqual(await groupCategories(page, 0), ['file'])
    assert.deepEqual((await pillNames(page, 0)).sort(), ['edit', 'glob', 'grep', 'read', 'write'])
  })

  it('搜不到时显示空态，且没有药丸', async () => {
    await search('zzz-not-a-tool')
    assert.ok(await page.locator('.rune-empty').count() > 0, '应有空态文案')
    assert.equal(await page.locator('.rune-zone').nth(0).locator('.rune-pill').count(), 0)
  })
})

describe('一个框同时过滤两个 zone', () => {
  it('搜 job 后，工作区 zone 也被过滤成三个', async () => {
    await search('')
    await chooseWorkspaceAt(page, 0)
    await search('job')
    assert.deepEqual(
      (await pillNames(page, 1)).sort(),
      ['job_kill', 'job_list', 'job_output'],
      '工作区 zone 必须同源过滤',
    )
    const counts = await zoneCounts(page)
    assert.equal(counts[1], '3/3')
  })

  it('清空搜索后恢复全量', async () => {
    await search('')
    const [enabled, total] = (await zoneCounts(page))[0].split('/').map(Number)
    assert.equal(enabled, total, '清空后应全部启用（本 spec 不改配置）')
    assert.ok(total > 20, `工具总数应在 20 以上，实际 ${String(total)}`)
  })
})
