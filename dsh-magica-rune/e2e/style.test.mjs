/**
 * 视觉与布局：逐条对照 `docs/raw/a.md` §5 的数值。
 *
 * 这里断言的是**运行时计算值**，不是源码字符串——样式表写对了但被别处覆盖也算失败。
 * 唯一的例外是「发丝线 0.5px」：DPR=2 下 Chromium 会把 0.5px 报成 1px，所以
 * 一半断言计算值（≤1px），一半断言注入的样式表里确实是 `0.5px`。
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { groupCategories, launchBrowser, newPage, openAbility } from './harness.mjs'

let browser
let page

/**
 * 把 `--dsw-alias-*` token 解析成实际颜色：插一个探针元素读计算值。
 *
 * 为什么不直接断言 `rgb(...)`：ui-theme 有自己的明暗偏好，同一 token 在两种主题下
 * 取值不同（踩过：系统切深色后整批颜色断言变红）。与 token 比对才是我们真正要验的东西。
 */
async function resolveToken(name) {
  return page.evaluate(variable => {
    const probe = document.createElement('span')
    probe.style.color = `var(${variable})`
    document.body.appendChild(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  }, name)
}

before(async () => {
  browser = await launchBrowser()
  page = await newPage(browser)
  await openAbility(page, process.env.DSH_E2E_URL)
})

after(async () => { await browser?.close() })

describe('骨架与标题', () => {
  it('标题 18px / 600，描述 13px 且是 tertiary', async () => {
    const style = await page.evaluate(() => {
      const title = getComputedStyle(document.querySelector('.rune-title'))
      const desc = getComputedStyle(document.querySelector('.rune-desc'))
      return { title: [title.fontSize, title.fontWeight], desc: [desc.fontSize, desc.color] }
    })
    assert.deepEqual(style.title, ['18px', '600'])
    assert.equal(style.desc[0], '13px')
    assert.equal(style.desc[1], await resolveToken('--dsw-alias-label-tertiary'))
  })

  it('只有一个 section 容器，max-width 760px', async () => {
    const style = await page.evaluate(() => getComputedStyle(document.querySelector('.rune-section')).maxWidth)
    assert.equal(style, '760px')
  })
})

describe('Tab 条', () => {
  it('只有两个 tab：工具 / 技能', async () => {
    const texts = await page.locator('.rune-tab').allTextContents()
    assert.deepEqual(texts.map(text => text.trim()), ['工具', '技能'])
  })

  it('gap 22px、13px/20px、padding 7px 1px 9px', async () => {
    const style = await page.evaluate(() => {
      const tabs = getComputedStyle(document.querySelector('.rune-tabs'))
      const tab = getComputedStyle(document.querySelector('.rune-tab'))
      return { gap: tabs.gap, align: tabs.alignItems, fs: tab.fontSize, lh: tab.lineHeight, pad: tab.padding }
    })
    assert.equal(style.gap, '22px')
    // 新版 Chromium 把 lex-end 的计算值规范化为 low-end（同义关键字），两个都接受\n    assert.ok(['flex-end', 'flow-end'].includes(style.align), 'alignItems=' + style.align)
    assert.equal(style.fs, '13px')
    assert.equal(style.lh, '20px')
    assert.equal(style.pad, '7px 1px 9px')
  })

  it('激活态用 data-active="true"，下划线高 2px', async () => {
    const info = await page.evaluate(() => {
      const active = document.querySelector('.rune-tab[data-active="true"]')
      const after = getComputedStyle(active, '::after')
      return { text: active.textContent.trim(), height: after.height, bottom: after.bottom }
    })
    assert.equal(info.text, '工具')
    assert.equal(info.height, '2px')
    assert.equal(info.bottom, '-1px')
  })

  it('发丝线：计算值 ≤1px，样式表里声明的是 0.5px', async () => {
    const info = await page.evaluate(() => {
      const width = parseFloat(getComputedStyle(document.querySelector('.rune-tabs')).borderBottomWidth)
      const style = document.querySelector('style[data-plugin="@meiyukichan/dsh-magica-rune"]')?.textContent ?? ''
      return { width, declaresHalf: style.includes('0.5px') }
    })
    assert.ok(info.width <= 1, `tabs border-bottom 应为发丝线，实际 ${String(info.width)}px`)
    assert.equal(info.declaresHalf, true, '样式表里应出现 0.5px')
  })
})

describe('搜索行位置', () => {
  it('搜索行是 .rune-body 的直接子元素，且排在「全局」之前', async () => {
    const layout = await page.evaluate(() => {
      const body = document.querySelector('.rune-body')
      const row = document.querySelector('.rune-search-row')
      const zones = Array.from(document.querySelectorAll('.rune-zone'))
      return {
        isDirectChild: row?.parentElement === body,
        rowTop: Math.round(row?.getBoundingClientRect().top ?? -1),
        zoneTop: Math.round(zones[0]?.getBoundingClientRect().top ?? -1),
        marginBottom: getComputedStyle(row).marginBottom,
      }
    })
    assert.equal(layout.isDirectChild, true)
    assert.ok(layout.rowTop < layout.zoneTop, '搜索行必须在局区之上')
    assert.equal(layout.marginBottom, '0px', '间距交给 .rune-body 的 gap，避免叠加')
  })

  it('搜索框高 30px、圆角 6px（raw 字面值）', async () => {
    const style = await page.evaluate(() => {
      const input = getComputedStyle(document.querySelector('.rune-search-input'))
      return { height: input.height, radius: input.borderRadius }
    })
    assert.equal(style.height, '30px')
    assert.equal(style.radius, '6px')
  })
})

describe('工作区下拉', () => {
  it('未选中时高 24px、显示「未选择」、带 data-empty', async () => {
    const info = await page.evaluate(() => {
      const select = document.querySelector('.rune-select')
      const style = getComputedStyle(select)
      return {
        height: style.height, radius: style.borderRadius,
        text: select.textContent.trim(), empty: select.getAttribute('data-empty'),
        color: style.color,
      }
    })
    assert.equal(info.height, '24px')
    assert.equal(info.radius, '8px')
    assert.equal(info.text, '未选择')
    assert.equal(info.empty, 'true')
    assert.equal(info.color, await resolveToken('--dsw-alias-label-tertiary'), '占位态用 tertiary')
  })

  it('浮层：卡片高度不超过 260px，条目多时内部可滚动', async () => {
    await page.locator('.rune-select').first().click()
    await page.locator('[role="menu"]').first().waitFor({ state: 'visible' })
    const menu = await page.evaluate(() => {
      const card = document.querySelector('[role="menu"]')
      const viewport = card?.querySelector('[class*="viewport"]')
      return {
        cardHeight: Math.round(card?.getBoundingClientRect().height ?? -1),
        maxHeight: getComputedStyle(card).maxHeight,
        overflowY: viewport === null || viewport === undefined ? null : getComputedStyle(viewport).overflowY,
        scrollHeight: viewport?.scrollHeight ?? 0,
        clientHeight: viewport?.clientHeight ?? 0,
        items: card?.querySelectorAll('[role^="menuitem"]').length ?? 0,
      }
    })
    await page.keyboard.press('Escape')
    assert.equal(menu.maxHeight, '260px')
    assert.ok(menu.cardHeight <= 260, `卡片高度 ${String(menu.cardHeight)} 超过 260px`)
    assert.equal(menu.overflowY, 'auto')
    if (menu.items >= 8) {
      assert.ok(menu.scrollHeight > menu.clientHeight, '工作区很多时应出现内部滚动')
    }
  })
})

describe('药丸与分组', () => {
  it('药丸高 28px、圆角 6px、13px、等宽字体', async () => {
    const style = await page.evaluate(() => {
      const pill = getComputedStyle(document.querySelector('.rune-pill'))
      const name = getComputedStyle(document.querySelector('.rune-pill-name'))
      return { height: pill.height, radius: pill.borderRadius, fs: pill.fontSize, font: name.fontFamily }
    })
    assert.equal(style.height, '28px')
    assert.equal(style.radius, '6px')
    assert.equal(style.fs, '13px')
    assert.match(style.font, /SF Mono|JetBrains Mono|Consolas|Menlo/i)
  })

  it('分组顺序与 raw 的 FIXED_CATS 一致（按 data-category，语言无关）', async () => {
    const FIXED = ['web', 'workflow', 'file', 'shell', 'image', 'agent', 'job', 'goal', 'misc']
    const categories = await groupCategories(page, 0)
    // 只校验**已知分类**的相对顺序：profile 里可能还有别的插件提供的工具
    // （例如 Lattice 的 20 个工具），它们不属于 raw 的 FIXED_CATS，忽略即可。
    const known = categories.filter(category => FIXED.includes(category))
    assert.deepEqual(known, FIXED.filter(category => known.includes(category)))
  })

  it('分组标题跟随语言（中文界面）', async () => {
    const labels = await page.locator('.rune-zone').nth(0).locator('.rune-group').evaluateAll(
      nodes => nodes.map(node => ({ category: node.getAttribute('data-category'),
        // 标题结构：「色点 span」+「分类名 span」+「计数 span」，标签在**第二个** span 里
        label: node.querySelector('.rune-group-title')?.querySelectorAll('span')[1]?.textContent?.trim() ?? '' })),
    )
    const byCategory = Object.fromEntries(labels.map(item => [item.category, item.label]))
    // 只校验「标题已本地化」：非空；**dsh 原生分类**还必须不等于原始键名
    // （中文界面下不该出现英文键）。其它插件提供的分类（如 Lattice）没有字典条目，
    // 按设计回退成原名，不算失败。具体文案属于字典，不在这里钉死。
    const DSH_CATS = ['web', 'workflow', 'file', 'shell', 'image', 'agent', 'job', 'goal', 'misc']
    assert.ok(labels.length > 0, '至少要有一个分组')
    for (const { category, label } of labels) {
      assert.ok(label.length > 0, `${category} 的标题不能为空`)
      if (DSH_CATS.includes(category ?? '')) assert.notEqual(label, category, `${category} 的标题应已本地化`)
    }
  })

  it('所有 dsh 原生分类的圆点都是同一个 warn 橙', async () => {
    const DSH_CATS = ['web', 'workflow', 'file', 'shell', 'image', 'agent', 'job', 'goal', 'misc']
    const dots = await page.evaluate(() => Array.from(document.querySelectorAll('.rune-zone .rune-group')).map(group => ({
      category: group.getAttribute('data-category'),
      color: group.querySelector('.rune-cat-dot') === null
        ? null
        : getComputedStyle(group.querySelector('.rune-cat-dot')).backgroundColor,
    })))
    const native = dots.filter(dot => DSH_CATS.includes(dot.category ?? '') && dot.color !== null)
    assert.ok(dots.length > 0)
    const warn = await resolveToken('--dsw-alias-state-warn-primary')
    // 只校验 dsh 原生分类：其它插件提供的分类（如 Lattice）按设计有自己的颜色
    for (const dot of native) assert.equal(dot.color, warn, `${dot.category} 应为 warn 橙`)
  })

  it('内置徽标圆角 5px、空态虚线 0.5px（查样式表，因当前无内置禁用项）', async () => {
    const style = await page.evaluate(
      () => document.querySelector('style[data-plugin="@meiyukichan/dsh-magica-rune"]')?.textContent ?? '',
    )
    assert.match(style, /\.rune-badge\s*\{[^}]*border-radius:\s*5px/)
    assert.match(style, /\.rune-empty\s*\{[^}]*0\.5px\s+dashed/)
  })
})

describe('两个 tab 都能渲染', () => {
  it('切到「技能」后仍有分组与药丸', async () => {
    await page.locator('.rune-tab').nth(1).click()
    await page.waitForSelector('.rune-pill')
    const pills = await page.locator('.rune-zone').nth(0).locator('.rune-pill').count()
    assert.ok(pills > 0)
    await page.locator('.rune-tab').nth(0).click()
    await page.waitForFunction(() => document.querySelector('.rune-tab[data-active="true"]')?.textContent.trim() === '工具')
  })
})
