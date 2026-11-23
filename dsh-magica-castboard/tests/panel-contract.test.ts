/**
 * 面板 ↔ 宿主 的契约回归（源码级 tripwire）。
 *
 * 目录重构后仍然钉住「请求形状」与「根元素 / 样式前缀」；改错时立即红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', 'src', 'client')
const tasks = readFileSync(join(ROOT, 'data', 'endpoints', 'tasks.ts'), 'utf8')
const issues = readFileSync(join(ROOT, 'data', 'endpoints', 'issues.ts'), 'utf8')
const live = readFileSync(join(ROOT, 'data', 'endpoints', 'live.ts'), 'utf8')
const page = readFileSync(join(ROOT, 'features', 'board', 'page.tsx'), 'utf8')
const shellCss = readFileSync(join(ROOT, 'design', 'shell.ts'), 'utf8')
const formsCss = readFileSync(join(ROOT, 'design', 'forms.ts'), 'utf8')
const api = readFileSync(join(ROOT, 'data', 'api.ts'), 'utf8')
const wire = readFileSync(join(import.meta.dirname, '..', 'src', 'shared', 'wire.ts'), 'utf8')

test('移卡 payload 用 host 的 `status` 字段', () => {
  assert.match(tasks, /apiMoveTask[\s\S]*?\/move`,\s*\{\s*status:\s*to\s*\}\)/)
})

test('评论从 `GET /tasks/:id` 读（没有 `/comments` 端点）', () => {
  assert.doesNotMatch(tasks, /\/comments`/)
  assert.match(tasks, /apiTask\(id: string\)/)
  assert.match(tasks, /`\/tasks\/\$\{encodeURIComponent\(id\)\}`/)
})

test('轮询端点只带四个游标', () => {
  assert.match(live, /since/)
  assert.match(live, /issueSince/)
  assert.match(live, /linkSince/)
  assert.match(live, /ixSince/)
})

test('分发提交结构化目标（不是拼人话）', () => {
  assert.match(tasks, /interface DispatchInput/)
  assert.match(tasks, /projectId: string/)
  assert.match(tasks, /assignee: string/)
  assert.match(tasks, /assigneeInstance\?: string/)
})

test('issue 查询用 `projectId` / `userId` 过滤', () => {
  assert.match(issues, /query\.set\('projectId'/)
  assert.match(issues, /query\.set\('userId'/)
})

test('面板根元素与自有样式层使用同一前缀（避免死样式）', () => {
  assert.match(page, /data-castboard-board=""/)
  assert.match(shellCss, /\.lt-page \{/)
})

test('样式层不残留旧前缀', () => {
  assert.doesNotMatch(shellCss, /dsh-atb-/)
  assert.doesNotMatch(shellCss, /dsh-atw-/)
})

test('所有下拉菜单用不透明表面（半透明菜单会让下面内容透出来）', () => {
  for (const css of [shellCss, formsCss]) {
    assert.doesNotMatch(css, /--dsw-specific-menu/)
    assert.doesNotMatch(css, /--dsw-menu-surface-fill/)
  }
  assert.match(shellCss, /\.lt-menu \{[^}]*background: var\(--dsw-alias-bg-layer-2\)/)
  assert.match(formsCss, /\.lt-pop \{[^}]*background: var\(--dsw-alias-bg-layer-2\)/)
  assert.match(formsCss, /\.lt-pop-group \{[^}]*background: var\(--dsw-alias-bg-layer-2\)/)
})

test('接口前缀与宿主一致', () => {
  assert.match(wire, /export const ROUTE_PREFIX = '\/api\/castboard'/)
  assert.match(api, /export const BASE = ROUTE_PREFIX/)
})

const dialogsCss = readFileSync(join(ROOT, 'design', 'dialogs.ts'), 'utf8')
const clientIndex = readFileSync(join(ROOT, 'index.ts'), 'utf8')

test('交互总览挂在全局 shell.overlay，不依赖看板页面是否打开', () => {
  assert.match(clientIndex, /slots\.inject\('shell\.overlay'/)
  assert.match(clientIndex, /InteractionOverlay/)
  // 弹窗不能留在主面板里，否则侧栏入口点了只会改 state、界面无反应。
  assert.doesNotMatch(page, /<InteractionInbox\b/)
})

test('提问卡指标位与 dsh QuestionComposer 一致（单选序号 / 多选勾选框）', () => {
  // dsh：.number 是 20×20、12px/500 的序号座；.checkbox 是 14×14 描边块。
  assert.match(dialogsCss, /\.lt-ix-number \{[^}]*font-size: 12px/)
  assert.match(dialogsCss, /\.lt-ix-number \{[^}]*border-radius: var\(--dsw-radius-xs\)/)
  assert.match(dialogsCss, /\.lt-ix-checkbox::before \{[^}]*width: 14px; height: 14px/)
  // 选项行几何：md 圆角、40px 最小高、8px 左内边距。
  assert.match(dialogsCss, /\.lt-ix-option \{[^}]*min-height: 40px/)
  assert.match(dialogsCss, /\.lt-ix-option \{[^}]*border-radius: var\(--dsw-radius-md\)/)
  // 单选选中态才有底色/描边；多选只体现在勾选框。
  assert.match(dialogsCss, /\.lt-ix-optionSelected \{ border-color: var\(--dsw-alias-border-l2\);/)
})

test('提问卡不再用旧的「序号 + 勾选」双指标', () => {
  assert.doesNotMatch(dialogsCss, /\.lt-ix-(num|check|checkon) \{/)
  assert.doesNotMatch(dialogsCss, /\.lt-ix-input \{/)
})
