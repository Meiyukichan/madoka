/**
 * 饱和矩阵：**每一个**工具都在「全局 / 工作区」× 「禁用 / 启用」四个方向上走一遍。
 *
 * 为什么要有这层：单点/分组用例只覆盖了一两个工具，而这个插件的核心不变量是
 * 「两级作用域各自独立生效、互不污染」——历史上出过「工作区禁用了但工具还在模型
 * 工具表里」的 bug，根因正是逐名处理与层归属的细节。这里把 25 个工具全部跑一遍，
 * 每个工具都断言四件事：
 *
 *   1. 全局禁用 → patch 的 `tools.global.disabled` 收录它，且**两个 zone** 都显示 disabled
 *   2. 全局启用 → 从 patch 移除
 *   3. 工作区禁用 → patch 的 `tools.workspaces[*].disabled` 收录它，且**全局不受影响**
 *   4. 工作区启用 → 从 patch 移除
 *
 * DSH 内置分类的工具在「全局禁用」时会先弹二次确认，这里一并覆盖。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  chooseWorkspaceAt, confirmButton, ensureAbility, launchBrowser, newPage, openAbility, pill,
  readGlobalDisabled, readWorkspaceDisabled, settle, waitForConfirmGone,
  waitGlobalDisabled, waitWorkspaceDisabled,
} from './harness.mjs'

let browser
let page

before(async () => {
  browser = await launchBrowser()
  page = await newPage(browser)
  await openAbility(page, process.env.DSH_E2E_URL)
})

after(async () => {
  await browser?.close()
})

/** 直接读药丸的 `data-state`（不依赖文本与语言）。 */
const stateOf = async (zoneIndex, name) =>
  pill(page, zoneIndex, name).getAttribute('data-state')

/**
 * 等药丸的 `data-state` 变成期望值。
 *
 * 不能点完立刻断言：patch 落盘与 DOM 重渲染是两条路径，0.2.1 上写入会触发插件重挂，
 * 重挂后要等新实例 render 完才轮询得到（实测 0.4s 内收敛）。直接断言会偶发假失败。
 */
async function waitState(zoneIndex, name, expected, label, timeout = 8_000) {
  const deadline = Date.now() + timeout
  let last = '未读到'
  while (Date.now() < deadline) {
    last = await stateOf(zoneIndex, name).catch(() => 'MISSING')
    if (last === expected) return
    // 面板被回收（0.2.1 的已知抖动）→ 重开，并等**两个 zone** 都渲染完再重读
    if (last === 'MISSING') {
      const reopened = await ensureAbility(page, process.env.DSH_E2E_URL).catch(() => false)
      if (reopened) {
        await page.waitForFunction(
          () => document.querySelectorAll('.rune-zone').length >= 2
            && document.querySelectorAll('.rune-zone .rune-pill').length > 0,
          undefined,
          { timeout: 15_000 },
        ).catch(() => {})
      }
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`${label}：期望 state=${expected}，实际 ${last}`)
}

/** 点一下并处理可能出现的二次确认。 */
async function toggleWithConfirm(zoneIndex, name) {
  await pill(page, zoneIndex, name).click()
  if (await confirmButton(page).isVisible().catch(() => false)) {
    await confirmButton(page).click()
    await waitForConfirmGone(page)
  }
}

describe('全工具矩阵：全局 / 工作区 × 禁用 / 启用', () => {
  it('每个工具在四个方向上都不串台', async () => {
    await settle(page)
    await chooseWorkspaceAt(page, 0)
    await settle(page)

    const names = await page.locator('.rune-zone').nth(0).locator('.rune-pill').evaluateAll(
      nodes => nodes.map(node => node.getAttribute('data-name') ?? '').filter(name => name !== ''),
    )
    assert.ok(names.length >= 20, `工具数偏少（${names.length}），可能没有 live agent`)

    const passed = []
    for (const name of names) {
      // —— 全局：禁用 ——
      await toggleWithConfirm(0, name)
      await waitGlobalDisabled(set => set.has(name), `${name} 全局禁用`)
      await waitState(0, name, 'disabled', `${name}：全局 zone 应显示 disabled`)
      await waitState(1, name, 'disabled', `${name}：工作区 zone 应继承 disabled`)

      // —— 全局：启用 ——
      await toggleWithConfirm(0, name)
      await waitGlobalDisabled(set => !set.has(name), `${name} 全局启用`)
      await waitState(0, name, 'enabled', `${name}：全局 zone 应回到 enabled`)

      // —— 工作区：禁用（不能影响全局） ——
      await toggleWithConfirm(1, name)
      await waitWorkspaceDisabled(set => set.has(name), `${name} 工作区禁用`)
      await waitState(1, name, 'disabled', `${name}：工作区 zone 应显示 disabled`)
      await waitState(0, name, 'enabled', `${name}：工作区禁用不得影响全局 zone`)
      assert.equal(
        readGlobalDisabled().includes(name), false,
        `${name}：工作区禁用不得写进 global.disabled`,
      )

      // —— 工作区：启用 ——
      await toggleWithConfirm(1, name)
      await waitWorkspaceDisabled(set => !set.has(name), `${name} 工作区启用`)
      await waitState(1, name, 'enabled', `${name}：工作区 zone 应回到 enabled`)

      passed.push(name)
    }

    // 收尾自检：全部走完后 patch 应该干净（不留任何禁用项）
    assert.deepEqual(readGlobalDisabled(), [], '全局禁用列表应清空')
    const wsLeft = Object.values(readWorkspaceDisabled()).flat()
    assert.deepEqual(wsLeft, [], '工作区禁用列表应清空')
    console.log(`[matrix] 完成 ${passed.length} 个工具的 4 向切换：${passed.join(', ')}`)
  })
})
