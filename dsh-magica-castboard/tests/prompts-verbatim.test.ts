/**
 * 提示词/上下文常量的逐字比对。
 *
 * 只做两种归一化：CRLF → LF、源码模板里的转义反引号还原。任何措辞差异都应让测试红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ACCEPTANCE_ROUND_INSTRUCTION,
  ASSIGNER_WAKE_INSTRUCTION,
  BOARD_PROMPT_TEXT,
  CASTBOARD_ISSUE_ROUTING_XML,
  CASTBOARD_PORTRAIT_XML,
  CASTBOARD_RULES_XML,
  PORTRAIT_IDLE_PROMPT,
  ROUTER_IDLE_PROMPT,
  WAKE_INSTRUCTION,
} from '../src/host/context/texts.ts'
import { castboardIssueCreationGuidance } from '../src/host/context/dispatch-guidance.ts'
import {
  commentsXml,
  portraitInstruction,
  portraitTargetXml,
  routerInstruction,
  taskDispatchInstruction,
} from '../src/host/context/renders.ts'

const md = readFileSync(join(import.meta.dirname, 'fixtures', 'prompts.md'), 'utf8')
const blocks = [...md.matchAll(/```(?:xml|text)\r?\n([\s\S]*?)```/g)].map(match => (match[1] ?? '').trim())
const host7Source = readFileSync(join(import.meta.dirname, 'fixtures', 'host7.txt'), 'utf8')

/**
 * 从 `tests/fixtures/host7.txt` 的源码快照里还原分发指导正文。
 *
 * 该文件是一份 `return [ '...', ... ].join('\n')` 的源码快照（模板里可能带
 * `${facts.instance}` / `+ facts.instance +`）；按 JS 求值才能逐字覆盖整段，
 * 包括测试曾经漏掉的新增段落。
 */
function guidanceFromHost7(instance: string): string {
  const lines = host7Source.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === 'return [')
  assert.ok(start >= 0, 'host7.txt 里找不到指导数组起点')
  const end = lines.findIndex((line, index) => index > start && line.trim().startsWith('].join('))
  assert.ok(end > start, 'host7.txt 里找不到指导数组终点')
  const expressions = lines
    .slice(start + 1, end)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('//'))
    .map(line => (line.endsWith(',') ? line.slice(0, -1) : line))
  return new Function(
    'facts',
    `return [${expressions.join(',\n')}].join(String.fromCharCode(10))`,
  )({ instance }) as string
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\\`/g, '`')
}

function blockStartingWith(prefix: string): string {
  const found = blocks.find(block => block.startsWith(prefix))
  assert.ok(found !== undefined, `a1.md 里找不到以 ${prefix} 开头的代码块`)
  return found
}

test('看板系统提示段逐字一致', () => {
  const expected = 'Use the castboard_* tools to read and write the shared task panel the user sees in the GUI. '
    + 'Act on a task only when the user points you at one — never go looking for board work on your own, '
    + 'and never let it displace what the user actually asked for. '
    + 'When the user does point you at a task, claim it first: castboard_get, then move it todo -> in_progress '
    + 'so the board shows it is taken and nobody else picks it up '
    + '(skip that move if it is already in_progress, and never take over another session\'s task; a planned issue is not an approval). '
    + 'To hand it back, move it in_progress -> in_review and record the outcome with castboard_comment_add; '
    + 'only a session the board started as this task\'s execution session also calls castboard_execution_report first. '
    + 'If you cannot finish, comment why and move it back to todo. Only the user can move a task to done.'
  assert.equal(BOARD_PROMPT_TEXT, expected)
})

test('执行协议逐字一致', () => {
  assert.equal(normalize(CASTBOARD_RULES_XML), normalize(blockStartingWith('<castboard_task_rules>')))
})

test('issue routing 指导逐字一致（样例路径替换占位符）', () => {
  const expected = blockStartingWith('<castboard_issue_routing>')
  const actual = normalize(CASTBOARD_ISSUE_ROUTING_XML)
    .replaceAll('{{WORKSPACES_CUSTOM}}', 'C:\\Users\\r30038105\\.dsh\\storages\\castboard\\worklabs\\workspaces-custom.json')
    .replaceAll('{{STRATEGY_CUSTOM}}', 'C:\\Users\\r30038105\\.dsh\\storages\\castboard\\worklabs\\strategy-custom.json')
    .replaceAll('{{SCRATCH_DIR}}', 'C:\\Users\\r30038105\\.dsh\\storages\\castboard\\.cache')
    .replaceAll('{{TASKS_DIR}}', 'C:\\Users\\r30038105\\.dsh\\storages\\castboard\\tasks')
  assert.equal(actual, normalize(expected))
})

test('项目肖像静态规则逐字一致', () => {
  const actual = normalize(CASTBOARD_PORTRAIT_XML.replace('{{MAX_LINES}}', '1000'))
  assert.equal(actual, normalize(blockStartingWith('<castboard_project_portrait>')))
})

test('分发指导：必填字段契约（projectId/title/detail/assignee/assigneeInstance）', () => {
  const instance = '10.117.145.73:3080'
  const actual = normalize(castboardIssueCreationGuidance({ instance }))
  assert.ok(actual.includes('<projectId>**必填**'))
  assert.ok(actual.includes('<title>**必填**'))
  assert.ok(actual.includes('<detail>**必填**'))
  assert.ok(actual.includes('<assignerMeta>**可选**'))
  assert.ok(actual.includes('验收通过后直接进入'))
  assert.ok(actual.includes('验收结论转为新的待规划 issue'))
  assert.ok(actual.includes('<assignee>**必填**'))
  assert.ok(actual.includes('<assigneeInstance>**必填**'))
  assert.ok(actual.includes('**提交前逐条自查**：必填 5 项'))
  assert.ok(actual.includes('**你答不了就往上问用户**'))
  assert.ok(actual.includes('**不要自己编一个答案**'))
  assert.ok(actual.includes('只有 1 个项目就直接用'))
  assert.ok(actual.includes('只有 2 个及以上才用'))
  assert.ok(actual.includes('用户本轮已明确指定'))
  assert.ok(actual.includes('即使只有一个 cwd 候选'))
  assert.ok(actual.includes('「不需要 cwd」'))
})

test('固定唤醒语与占位语逐字一致', () => {
  assert.equal(ACCEPTANCE_ROUND_INSTRUCTION, '按下面注入的 castboard-task-acceptance 执行本轮验收')
  assert.equal(WAKE_INSTRUCTION, '上游 issue 有新评论，见下面的上下文；按它的要求处理（不要改任务状态）。')
  assert.equal(ASSIGNER_WAKE_INSTRUCTION, '你派出去的 issue 有新评论，见下面的上下文；按它的要求接着处理。')
  assert.equal(ROUTER_IDLE_PROMPT, '（初始化）你已就位。现在没有待处理的 issue，什么都不用做，等下一次唤醒。')
  assert.equal(PORTRAIT_IDLE_PROMPT, '（初始化）你已就位。现在还没有待写肖像的项目，什么都不用做，等下一次唤醒。')
})

test('issue 评论 XML 逐字一致', () => {
  const xml = commentsXml('6f2b9d41-3c8a-4e77-bb10-5c9d2e1a7f88', [
    { role: 'assigner', authorType: 'user', author: 'r30038105', createdAt: Date.parse('2026-11-16T02:21:10.001Z'), body: '2.17 那台也要覆盖，别只测 2.28。' },
    { role: 'assigner', authorType: 'user', author: 'r30038105', createdAt: Date.parse('2026-11-16T02:24:55.220Z'), body: '另外把 musl 环境也带上。' },
  ] as never)
  const expected = blockStartingWith('<issue_comments')
  assert.equal(normalize(xml), normalize(expected))
})

test('任务分发指令逐字一致', () => {
  const xml = taskDispatchInstruction(
    { id: 't-9f3a1c-7b2', title: '给 dsh-webide 补 glibc bundle 检测' } as never,
    {
      text: '把「musl 环境兜底」和「回归用例」两件事拆出去，交给后端组做。',
      projectId: '42',
      assignee: 'r30038105',
      assigneeInstance: '10.117.145.73:3080',
    },
  )
  assert.equal(normalize(xml), normalize(blockStartingWith('<castboard_task_dispatch>')))
})

test('router 每轮指令逐字一致', () => {
  assert.equal(
    routerInstruction('6f2b9d41-3c8a-4e77-bb10-5c9d2e1a7f88'),
    blockStartingWith('请使用子代理，按照 castboard-issue-routing 的指导').replace(/\r\n/g, '\n'),
  )
})

test('肖像 target 与每轮指令逐字一致', () => {
  const target = {
    id: 'a3f1c9d2-8e4b-4c17-9a55-2d6f7e8b1c03',
    path: 'D:\\projects-code\\optix\\common\\harness\\furina',
    title: 'furina',
    outputFile: 'C:\\Users\\r30038105\\.dsh\\storages\\castboard\\worklabs\\workspaces\\a3f1c9d2-8e4b-4c17-9a55-2d6f7e8b1c03.md',
    indexFile: 'C:\\Users\\r30038105\\.dsh\\storages\\castboard\\worklabs\\workspaces\\index.md',
    portraitExists: true,
  }
  assert.equal(normalize(portraitTargetXml(target)), normalize(blockStartingWith('<castboard_portrait_target>')))
  assert.equal(normalize(portraitInstruction(target)), normalize(blockStartingWith('请给下面这个项目写一份项目肖像')))
})
