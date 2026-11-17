/**
 * E2E 环境封装：找 Chromium、起/复用 dev 实例、打开「能力管理」页、读写问题清单。
 *
 * 设计要点：
 * - 浏览器：优先 `DSH_E2E_CHROMIUM`，其次 playwright 自己登记的那份，最后扫
 *   `%LOCALAPPDATA%/ms-playwright/chromium-*`（本机缓存的是 1234，playwright 1.61 想要
 *   1228，所以必须显式 `executablePath`，否则 launch 会要求 `playwright install`）。
 * - 服务：`DSH_E2E_URL` 有值就直接复用（开发者自己起的实例），否则自己 spawn
 *   `dsh --profile <profile> --port <port> --no-open`，从 stdout 里抓 `?token=` 那行。
 * - 隔离：E2E 会真的改 `profiles/<profile>/cordis.patch.yml`。`snapshotPatch()` 记快照、
 *   `restorePatch()` 原样写回；每个 spec 文件在 `after()` 里调用，绝不留脏配置。
 * @module dsh-magica-rune/e2e/harness
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

export const PROFILE = process.env.DSH_E2E_PROFILE ?? 'dev'
export const PORT = process.env.DSH_E2E_PORT ?? '3082'
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
export const PATCH_PATH = join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')

const STARTUP_TIMEOUT_MS = 120_000
const WAIT = Number(process.env.DSH_E2E_WAIT ?? 15_000)

/** 找可执行的 Chromium。 */
export function resolveChromium() {
  const override = process.env.DSH_E2E_CHROMIUM
  if (override !== undefined) {
    if (!existsSync(override)) throw new Error(`DSH_E2E_CHROMIUM 不存在: ${override}`)
    return override
  }
  try {
    const bundled = chromium.executablePath()
    if (typeof bundled === 'string' && existsSync(bundled)) return bundled
  } catch { /* playwright 未下载浏览器：继续扫缓存 */ }

  const root = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
    : join(homedir(), '.cache', 'ms-playwright')
  if (!existsSync(root)) throw new Error(`找不到 ms-playwright 目录: ${root}`)
  const relative = process.platform === 'win32'
    ? ['chrome-win64', 'chrome.exe']
    : ['chrome-linux', 'chrome']
  const candidates = readdirSync(root)
    .filter(name => name.startsWith('chromium-') && !name.includes('headless'))
    .sort((a, b) => Number(b.split('-')[1] ?? 0) - Number(a.split('-')[1] ?? 0))
    .map(name => join(root, name, ...relative))
    .filter(path => existsSync(path))
  if (candidates.length === 0) throw new Error(`ms-playwright 下没有可用的 chromium: ${root}`)
  return candidates[0]
}

/** 探一个端口是否空闲。 */
function probePort(port) {
  return new Promise(resolve => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/** 从 `PORT` 起找一个空闲端口（避免上次被 kill 掉的孤儿实例把端口占住）。 */
export async function pickFreePort(start = Number(PORT)) {
  for (let port = start; port < start + 20; port++) if (await probePort(port)) return String(port)
  throw new Error(`找不到空闲端口（${String(start)}-${String(start + 20)}）`)
}

/**
 * 起一个 dev 实例并等到 token 那行；已有 `DSH_E2E_URL` 就直接复用。
 *
 * ⚠️ Windows 上 `dsh` 是 shim，必须走 shell 才能启动；而 `child.kill()` 只杀 cmd，
 * 真正的 node 孙进程会继续占着端口（实测过：留下孤儿实例导致下一轮 E2E 全红）。
 * 所以停止时用 `taskkill /T` 连整棵进程树一起结束，并注册 `exit` 兜底。
 */
export async function startServer() {
  if (process.env.DSH_E2E_URL !== undefined) {
    return { url: process.env.DSH_E2E_URL, port: new URL(process.env.DSH_E2E_URL).port, stop: async () => {} }
  }
  // 端口可用 `DSH_E2E_PORT` 固定：dev profile 的存储租约是「单写者」，同 profile 的
  // 第二个实例会变只读（`/diagnostics` writable:false、写盘 403），这时换端口没用，
  // 但固定端口便于人工核对是哪个进程在跑。
  const port = process.env.DSH_E2E_PORT ?? await pickFreePort()
  const child = spawn('dsh', ['--profile', PROFILE, '--port', port, '--no-open'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })

  const killTree = () => {
    if (child.exitCode !== null || child.pid === undefined) return
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  }
  // 兜底：测试进程被 Ctrl-C / 异常退出时也把服务带走
  process.once('exit', killTree)

  const stop = async () => {
    killTree()
    await new Promise(resolve => setTimeout(resolve, 600))
  }

  const url = await new Promise((resolve, reject) => {
    let output = ''
    let stderr = ''
    const timer = setTimeout(() => {
      reject(new Error(`等待 dsh 启动超时（${STARTUP_TIMEOUT_MS}ms，端口 ${port}）\nstdout:\n${output}\nstderr:\n${stderr}`))
    }, STARTUP_TIMEOUT_MS)
    const onData = chunk => {
      output += String(chunk)
      const matched = /(http:\/\/[^\s]*\?token=[\w-]+)/.exec(output)
      if (matched === null) return
      clearTimeout(timer)
      resolve(matched[1])
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`dsh 提前退出（code=${String(code)}，端口 ${port}）\nstdout:\n${output}\nstderr:\n${stderr}`))
    })
    child.once('error', error => { clearTimeout(timer); reject(error) })
  }).catch(async error => { await stop(); throw error })

  return { url, port, stop }
}

/** 浏览器 + 一个 1600×1000、DPR=2 的上下文（DPR=2 才看得出 0.5px 发丝线）。 */
export async function launchBrowser() {
  return chromium.launch({
    headless: true,
    executablePath: resolveChromium(),
    args: process.platform === 'win32' ? ['--disable-gpu'] : [],
  })
}

export async function newPage(browser) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    // 钉死浅色：ui-theme 跟随系统 prefers-color-scheme，而样式断言写的是浅色 token 值。
    // 不钉的话，谁把系统切到深色，整批颜色断言就会红（踩过一次）。
    colorScheme: 'light',
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  // 页面侧的 error 一律打到 stdout：静默失败是排查的最大障碍
  page.on('console', message => {
    const kind = message.type()
    if (kind === 'error' || kind === 'warning') console.log('[page:' + kind + '] ' + message.text().slice(0, 300))
  })
  page.on('pageerror', error => console.log('[page:throw] ' + String(error).slice(0, 300)))
  await page.setDefaultTimeout(WAIT)
  return page
}

// ── 问题清单（profile patch）快照 ───────────────────────────────────

export function snapshotPatch() {
  const original = existsSync(PATCH_PATH) ? readFileSync(PATCH_PATH, 'utf8') : undefined
  return () => {
    if (original === undefined) return
    writeFileSync(PATCH_PATH, original, 'utf8')
  }
}

/** settings 命名空间 = patch 行的 `id`（与 `src/namespace.ts` 的 `ABILITY_NS` 一致）。 */
const ABILITY_ID = 'dsh-magica-rune'

/**
 * 取 profile patch 里**最后一条** `id: <ABILITY_ID>` 的行。
 *
 * 为什么取最后一条：loader 是「后应用的行胜出」。同一个 id 出现多行是真实可能发生的
 * （比如包改名后，配置编辑器会按新 `name` 追加一行、旧行留在上面）。按第一条读会读到
 * 旧行的空值，得到「UI 已禁用、patch 却是 []」这种假失败（踩过）。
 */
function abilityRow() {
  const text = readFileSync(PATCH_PATH, 'utf8')
  const pattern = new RegExp(`^- id:\\s*${ABILITY_ID}\\s*$`, 'm')
  const rows = text.split(/\n(?=- )/).filter(row => pattern.test(row))
  return rows.length === 0 ? '' : rows[rows.length - 1]
}

/**
 * 最小 YAML 子集走查：按缩进沿 `path` 下行，返回该节点下的**字符串列表**。
 * 只处理本 patch 会出现的形态（映射嵌套 + 字符串数组），不引 YAML 依赖。
 */
function listAt(rowText, path) {
  const stack = []
  // eslint-disable-next-line no-useless-escape
  let target = null
  let found = null
  for (const raw of rowText.split(/\r?\n/)) {
    const body = raw.trim()
    if (body === '' || body.startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    if (target !== null) {
      if (indent > target.indent) {
        const item = /^-\s*(.+)$/.exec(body)
        if (item !== null) {
          target.items.push(item[1].trim().replace(/^['"]|['"]$/g, ''))
          continue
        }
      }
      target = null
    }
    if (body.startsWith('- ') || !body.endsWith(':')) continue
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    stack.push({ indent, key: body.slice(0, -1).trim() })
    const current = stack.map(entry => entry.key)
    const isTarget = current.length === path.length && current.every((key, index) => key === path[index])
    // 注意：命中的对象要单独留引用 —— `target` 会在遇到下一个同级键时被置空，
    // 直接把 `target.items` 返回会拿到空数组（踩过，表现为「写了却读不到」）。
    if (isTarget) {
      target = { indent, items: [] }
      found = target
    }
  }
  return found?.items ?? []
}

/** 走查到映射节点的**子键**（例如 `tools.workspaces` 下的所有 workspaceId）。 */
function keysAt(rowText, path) {
  const stack = []
  let keys = []
  for (const raw of rowText.split(/\r?\n/)) {
    const body = raw.trim()
    if (body === '' || body.startsWith('#') || body.startsWith('- ')) continue
    if (!body.endsWith(':')) continue
    const indent = raw.length - raw.trimStart().length
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack.map(entry => entry.key)
    stack.push({ indent, key: body.slice(0, -1).trim() })
    if (parent.length === path.length && parent.every((key, index) => key === path[index])) {
      keys.push(body.slice(0, -1).trim())
    }
  }
  return keys
}

/** 生效的 `tools.global.disabled` 名单。 */
export function readGlobalDisabled() {
  // 注意路径要带顶层的 config:（行结构：id / name / config → tools → global → disabled）
  return listAt(abilityRow(), ['config', 'tools', 'global', 'disabled'])
}

/** 生效的每个工作区的 `disabled` 名单：`{ [workspaceId]: string[] }`。 */
export function readWorkspaceDisabled() {
  const row = abilityRow()
  const result = {}
  for (const id of keysAt(row, ['config', 'tools', 'workspaces'])) {
    result[id] = listAt(row, ['config', 'tools', 'workspaces', id, 'disabled'])
  }
  return result
}

// ── 页面操作 ────────────────────────────────────────────────────────

/** 等 shell 就绪、关掉「预览版说明」，再点设置。 */
/**
 * 打开设置面板。
 *
 * 入口在 0.2.1 变了：0.2.0 侧边栏底部有「设置」按钮；0.2.1-rc.5 起它收进
 * **账号菜单**（账号菜单 → 设置，快捷键 `Ctrl+Alt+,`），页面上再没有 direkt
 * 的「设置」按钮。两条路径都留着，这样同一套用例能同时跑在两个版本上。
 */
export async function openSettings(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.getByText('新会话', { exact: false }).first().waitFor({ state: 'visible' })
  // 首次启动的「预览版说明」会盖一层 mask，不关掉后面所有点击都被拦截
  const intro = page.getByRole('button', { name: '继续', exact: true })
  if (await intro.count()) await intro.first().click()
  await page.waitForTimeout(200)

  const direct = page.locator('button', { hasText: '设置' })
  if ((await direct.count()) > 0) {
    // 0.2.0 路径
    await direct.nth((await direct.count()) - 1).click()
  } else {
    // 0.2.1 路径：账号菜单 → 设置
    const account = page.locator('[aria-label="账号菜单"]').first()
    await account.click()
    await page.getByRole('menuitem', { name: /设置/ }).first().click()
  }
  await page.waitForSelector('[role="dialog"]', { timeout: WAIT })
}

/**
 * 进入「能力管理」并等到内容就绪。
 *
 * 重试是必要的：dev 实例刚起（或 `lib/` 刚重建）时 client 侧会 HMR 重载一次，
 * 面板会被卸载，表现为「刚打开就没了」。这里按「面板不在就重开」收敛。
 */
export async function openAbility(page, url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    // 就绪判据用「有药丸」：section 容器在 loading 态就已存在，等它会出现竞态。
    if ((await page.locator('.rune-pill').count()) > 0) {
      // 再等一拍，让下拉的 data-empty / 文案落定（catalog 一次请求同时喂两个 zone）
      await page.waitForTimeout(150)
      return
    }
    if (!(await page.locator('[role="dialog"]').count())) {
      // 0.2.0 与 0.2.1 的入口不同（侧边栏按钮 / 账号菜单），统一交给 openSettings
      await openSettings(page, url)
    }
    // 等导航项本身出现再点：对话框已开但 nav 还没渲染时，直接等药丸会白等满超时。
    const nav = page.locator('[role="dialog"] nav button', { hasText: '能力管理' })
    const appeared = await nav.first().waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true).catch(() => false)
    if (appeared) await nav.first().click()
    await page.waitForSelector('.rune-pill', { timeout: 8_000 }).catch(() => {})
  }
  throw new Error('能力管理页始终没有就绪')
}

/**
 * 确保「能力管理」页还在。
 *
 * 0.2.1 上有个已知抖动：**写一次配置后设置面板偶尔整个消失**（插件被重挂/面板被回收），
 * 于是后续断言拿到 MISSING。这里做的是「没了就重开」，让用例不受这个抖动影响；
 * 它不掩盖插件行为（写盘是否生效仍由 patch 断言负责）。
 *
 * @returns 是否重开过
 */
export async function ensureAbility(page, url) {
  if ((await page.locator('.rune-pill').count()) > 0) return false
  await openAbility(page, url)
  return true
}

export const zone = (page, index) => page.locator('.rune-zone').nth(index)

/** 某个 zone 里名为 name 的药丸（按组件挂的 `data-name` 精确定位，不依赖文本）。 */
export const pill = (page, index, name) =>
  zone(page, index).locator(`.rune-pill[data-name="${name}"]`)

/** 某个 zone 里所有药丸的名字。 */
export async function pillNames(page, index = 0) {
  return zone(page, index).locator('.rune-pill-name').allTextContents()
}

export async function zoneCounts(page) {
  return page.locator('.rune-zone-count').allTextContents()
}

export async function groupTitles(page, index = 0) {
  return zone(page, index).locator('.rune-group-title').allTextContents()
}

/** 分组批量勾选框（按 `data-category` 定位，与语言无关）。 */
export const groupBatch = (page, category, index = 0) =>
  zone(page, index).locator(`.rune-group[data-category="${category}"] .rune-batch-toggle input`)

/** 某个 zone 里分组的分类 id 顺序。 */
export async function groupCategories(page, index = 0) {
  return zone(page, index).locator('.rune-group').evaluateAll(
    nodes => nodes.map(node => node.getAttribute('data-category') ?? ''),
  )
}

/** 打开工作区下拉并按**序号**选中（不依赖文本，避免 label 里混入计数等噪音）。 */
export async function chooseWorkspaceAt(page, index = 0) {
  await page.locator('.rune-select').first().click()
  const items = page.locator('[role="menu"] [role^="menuitem"]')
  await items.first().waitFor({ state: 'visible' })
  const label = (await items.nth(index).textContent())?.trim() ?? ''
  await items.nth(index).click()
  // 等触发器显示选中项（未选中时是「未选择」）
  await page.waitForFunction(expected => {
    const select = document.querySelector('.rune-select')
    return select !== null && select.textContent.trim().startsWith(expected)
  }, label)
  return label
}

/**
 * 兜底：关掉残留的「二次确认」弹窗与下拉浮层，避免一个用例的弹窗把后面全挡住。
 *
 * ⚠️ 不能按 `[aria-modal="true"]` 判断——**设置面板本身就是 modal**，
 * 对它按 Escape 会把整个页面关掉（踩过：之后所有用例都超时）。
 * 所以这里只认我们自己的确认按钮，以及 `[role="menu"]`。
 */
export async function settle(page) {
  const cancel = cancelButton(page)
  if ((await cancel.isVisible().catch(() => false))) await cancel.click().catch(() => {})
  if ((await page.locator('[role="menu"]').count()) > 0) await page.keyboard.press('Escape')
  await page.waitForTimeout(100)
}

/**
 * 确认弹窗以「禁用按钮」为锚点，而不是拿 dialog 元素当锚点。
 *
 * 两个坑（都踩过）：
 * 1. `.last()` 在弹窗关闭后会退化成**设置面板本身**，`waitFor({state:'hidden'})` 永远不满足；
 * 2. `filter({ has: getByRole(...) })` 的可见性轮询在弹窗刚挂载/刚卸载的瞬间会漏判。
 *
 * 所以：交互用 `confirmButton()`，等开/等关都等这个**按钮**的可见性。
 */
export function confirmButton(page) {
  // 用组件挂的 data 钩子，而不是 getByRole：确认弹窗嵌在设置面板（另一个 aria-modal）
  // 内部，可访问性树在嵌套 modal 场景下会间歇性查不到，导致 waitFor 超时。
  return page.locator('[data-rune-confirm]')
}

/** 取消按钮（同一个弹窗）。 */
export function cancelButton(page) {
  return page.locator('[data-rune-cancel]')
}

/** 等确认弹窗出现，返回该 dialog 元素（用于读文案）。 */
export async function waitForConfirm(page) {
  const button = confirmButton(page)
  await button.waitFor({ state: 'visible' })
  return page.locator('[role="dialog"][aria-modal="true"]').last()
}

/** 等确认弹窗关闭（按钮消失即视为关闭）。 */
export async function waitForConfirmGone(page) {
  await confirmButton(page).waitFor({ state: 'hidden' })
}

/**
 * 把某个工具在全局 zone 切到「禁用」。
 *
 * 注意：当前工具集**全部属于 dsh 原生分类**，所以点一下一定弹确认（这本身是被测行为）；
 * 这里统一走「点 → 若有确认则确认」的路径。
 */
export async function disableTool(page, name) {
  await pill(page, 0, name).click()
  const button = confirmButton(page)
  if (await button.isVisible().catch(() => false)) {
    await button.click()
    // 必须等它真的消失：退场动画期间点击会落在遮罩上，看起来「点了没反应」。
    await waitForConfirmGone(page)
  }
}

/** 把某个工具在全局 zone 切回「启用」（禁用态点击不会弹确认）。 */
export async function enableTool(page, name) {
  await pill(page, 0, name).click()
}

/** 搜索框：Input 原语的 className 在外层 wrapper 上，真正的输入元素是它的子 input。 */
export const searchInput = page => page.locator('.rune-search-input input').first()
/**
 * 确保实例里**至少有一个 live agent**。
 *
 * 0.2 的工具是按会话（agent）注册的：`tools.schemas()` 的全局视图在没有任何会话时是空的
 * （实测：新起的 dev 实例目录为 0，发一条消息后变成 26）。而能力管理页正是从工具目录
 * 渲染药丸/分组的 —— 没有会话就只剩「暂无工具配置」，所有等 `.rune-pill` 的用例都会超时。
 *
 * 所以 E2E 开跑前先发一条消息把 agent 建出来；不等模型回完（agent 在发送瞬间就创建）。
 */
export async function ensureLiveAgent(url, text = '你好', attempts = 3) {
  const browser = await launchBrowser()
  const page = await newPage(browser)
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.getByText('新会话', { exact: false }).first().waitFor({ state: 'visible' })
    const intro = page.getByRole('button', { name: '继续' })
    if (await intro.count()) await intro.first().click()
    const box = page.locator('[role="textbox"]').first()
    await box.waitFor({ state: 'visible' })
    await box.click()
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
    // 轮询而不是固定等待：会话真正开始跑（工具注册完成）需要几秒到十几秒。
    await page.waitForTimeout(1200)
    // 以「目录里有工具」作为 agent 真的建成的判据：请求失败/未注册时它是 0，
    // 光等固定时间会出现「看起来建好了其实没有」的假阳性。
    let tools = 0
    for (let tick = 0; tick < 50 && tools === 0; tick++) {
      tools = await page.evaluate(async () => {
        const body = await (await fetch('/rune-ability/catalog', { credentials: 'same-origin' })).json()
        return Array.isArray(body.tools) ? body.tools.length : 0
      })
      if (tools === 0) await page.waitForTimeout(500)
    }
    if (tools > 0) {
      // 关键：**保持浏览器开着**。实测关掉页面后 agent 会被 dispose，
      // 工具注册随之消失（catalog 又回到 0），后面的 spec 依旧拿不到药丸。
      return { close: () => browser.close(), tools }
    }
  }
  await browser.close()
  throw new Error('无法建立 live agent：能力目录始终为空（工具按会话注册，没有会话就没有工具）')
}
/** 轮询等待「全局禁用集合」满足期望；返回最后一次读到的数组。 */
export async function waitGlobalDisabled(predicate, label, timeout = 8_000) {
  const deadline = Date.now() + timeout
  let last = []
  while (Date.now() < deadline) {
    last = readGlobalDisabled()
    if (predicate(new Set(last))) return last
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  throw new Error(`${label}：patch 里是 ${JSON.stringify(last)}`)
}

/** 轮询等待「所有工作区禁用集合的并集」满足期望。 */
export async function waitWorkspaceDisabled(predicate, label, timeout = 8_000) {
  const deadline = Date.now() + timeout
  let last = []
  while (Date.now() < deadline) {
    last = Object.values(readWorkspaceDisabled()).flat()
    if (predicate(new Set(last))) return last
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  throw new Error(`${label}：patch 里是 ${JSON.stringify(last)}`)
}