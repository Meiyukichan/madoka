/**
 * 提示词与具名上下文：静态段、任务 references、验收轮、router / 肖像材料与转义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCEPTANCE_ROUND_INSTRUCTION,
  ASSIGNER_WAKE_INSTRUCTION,
  BOARD_PROMPT_TEXT,
  CASTBOARD_RULES_XML,
  PLUGIN_NAME,
  PORTRAIT_MAX_LINES,
  PORTRAIT_IDLE_PROMPT,
  ROUTER_IDLE_PROMPT,
  WAKE_INSTRUCTION,
  commentsXml,
  escapeXml,
  escapeXmlAttr,
  castboardAcceptanceXml,
  castboardIssueCreationGuidance,
  castboardIssueReferences,
  castboardIssueRoutingXml,
  castboardPortraitXml,
  castboardReferences,
  portraitInstruction,
  portraitTargetXml,
  routerInstruction,
  taskDispatchInstruction,
  userInstruction,
} from '../src/host/context/index.ts'
import { effectivePrompt } from '../src/host/ledger/task-derive.ts'
import type { AcceptanceStrategy } from '../src/host/model.ts'
import { checklistItem, issueRecord, taskRecord, threadComment } from './helpers.ts'

test('常驻系统段：单行、开头说明看板工具与用户边界', () => {
  assert.equal(BOARD_PROMPT_TEXT.includes('\n'), false)
  assert.ok(BOARD_PROMPT_TEXT.startsWith('Use the castboard_* tools'))
  assert.ok(BOARD_PROMPT_TEXT.includes('Only the user can move a task to done.'))
})

test('rules：六个子块齐全，且不含具体任务数据', () => {
  for (const block of [
    '<before_start',
    '<handoff_protocol',
    '<checklist_protocol',
    '<boundaries',
    '<on_failure',
    '<issue_comments',
  ]) {
    assert.ok(CASTBOARD_RULES_XML.includes(block), `缺 ${block}`)
  }
  assert.ok(CASTBOARD_RULES_XML.includes('castboard_execution_report'))
  assert.ok(CASTBOARD_RULES_XML.includes('commentRole 必须是 assignee'))
  assert.ok(!CASTBOARD_RULES_XML.includes('task id='), 'rules 不能带任务数据')
})

test('任务 references：issue 双 id、附件、评论、上次执行、清单与标签', () => {
  const task = taskRecord({
    id: 't-1',
    title: '补检测',
    workspaceId: 'ws-1',
    issueId: '11111111-1111-4111-8111-111111111111',
    tags: ['webide'],
    reference: { dag: 'a -> b', router: '落点 X' },
    checklist: [
      checklistItem('能识别 glibc', { checked: true, note: 'bundle.ts:118' }),
      checklistItem('musl 兜底'),
    ],
    executions: [
      { id: 'e-1', trigger: 'manual', outcome: 'failed', startedAt: 1, endedAt: 2, error: 'boom' },
    ],
  })
  const xml = castboardReferences(
    task,
    'D:/repo',
    [{ name: 'log.txt', path: 'D:/att/log.txt', description: '栈' }],
    [threadComment({ body: '补一条 <2.17>', authorType: 'user', role: 'assigner', createdAt: 3, threadId: 'session-abcdefghijklmnopqrstuvwx' })],
  )
  assert.ok(xml.includes('<task id="t-1" source="任务面板执行服务">'))
  assert.ok(xml.includes('<issue id="11111111-1111-4111-8111-111111111111">'))
  assert.ok(xml.includes('castboard_issue_comment_add { issueId: "11111111-1111-4111-8111-111111111111"'))
  assert.ok(xml.includes('<input_attachments count="1" dir="D:/att">'))
  assert.ok(xml.includes('补一条 &lt;2.17&gt;'), '评论正文要转义')
  assert.ok(xml.includes('<router-reference>') && xml.includes('<proposal>落点 X</proposal>'))
  assert.ok(xml.includes('<tags count="1">'))
  assert.ok(xml.includes('progress="1/2"') && xml.includes('evidence="bundle.ts:118"'))
  assert.ok(xml.includes('<last_execution') && xml.includes('<error>boom</error>'))
  assert.ok(xml.includes('<comments_since_last_execution count="1"'))
})

test('任务 references：空数据时整块缺席（清单例外）', () => {
  const xml = castboardReferences(taskRecord({ id: 't-2', title: '空卡' }), 'D:/repo')
  assert.ok(!xml.includes('<issue id='), '没有 issueId 就不输出 <issue>')
  assert.ok(!xml.includes('<input_attachments'))
  assert.ok(!xml.includes('<comments_since_last_execution'))
  assert.ok(!xml.includes('<last_execution'))
  assert.ok(!xml.includes('<tags'))
  assert.equal(xml.includes('<checklist>本任务没有验收清单。</checklist>'), true)
})

test('验收上下文：close 排在 issue 前；只有 close 时不输出派发块', () => {
  const strategies: AcceptanceStrategy[] = [
    { id: 'a-2', type: 'issue', title: '遗留项', description: '拆 issue' },
    { id: 'a-1', type: 'close', title: '测试通过', description: 'pnpm test' },
  ]
  const xml = castboardAcceptanceXml(taskRecord({ id: 't-3', title: '待验收' }), strategies)
  assert.ok(xml.indexOf('<accept_strategies') < xml.indexOf('<dispatch_strategies'), 'close 必须在前')
  assert.ok(xml.includes('step order="5"'))
  assert.ok(xml.includes('<never>'))

  const onlyClose = castboardAcceptanceXml(taskRecord({ id: 't-4', title: 'x' }), [strategies[1]!])
  assert.ok(!onlyClose.includes('<dispatch_strategies when='))
  assert.equal(ACCEPTANCE_ROUND_INSTRUCTION, '按下面注入的 castboard-task-acceptance 执行本轮验收')
})

test('router 静态指导：占位符全部替换', () => {
  const xml = castboardIssueRoutingXml({
    workspacesCustom: 'C:/home/worklabs/workspaces-custom.json',
    strategyCustom: 'C:/home/worklabs/strategy-custom.json',
    scratchDir: 'C:/home/issue-scratch',
    tasksDir: 'C:/home/tasks',
  })
  assert.ok(!xml.includes('{{'))
  assert.ok(xml.includes('C:/home/worklabs/workspaces-custom.json'))
  assert.ok(xml.includes('C:/home/issue-scratch'))
  assert.ok(xml.includes('castboard_issue_task'))
  assert.ok(xml.includes('<delegation limit="1">'))
})

test('issue references：assigner_meta 剔除 title/detail；材料缺席即整块不输出', () => {
  const issue = issueRecord({
    id: '11111111-1111-4111-8111-111111111111',
    title: '诉求',
    detail: '正文',
    urgency: 'urgent',
    cwd: 'D:/p',
    source: 'self',
    assignerMeta: { title: '诉求', detail: '很长的正文', acceptance: '能跑' },
  })
  const xml = castboardIssueReferences(issue)
  const meta = xml.slice(xml.indexOf('<assigner_meta>'), xml.indexOf('</assigner_meta>'))
  assert.ok(meta.includes('acceptance'))
  assert.ok(!meta.includes('很长的正文'), 'assigner_meta 必须剔除 detail')
  assert.ok(!xml.includes('<input_attachments'))
  assert.ok(!xml.includes('<comments count='))
  assert.ok(!xml.includes('<workspaces_catalog>'))

  const withCatalog = castboardIssueReferences(issue, {
    workspacesCatalog: { indexFile: 'C:/w/index.md', portraitDir: 'C:/w/portraits' },
  })
  assert.ok(withCatalog.includes('<workspaces_catalog>'))
})

test('comments：两行注释、role、转义与唤醒语', () => {
  const xml = commentsXml('11111111-1111-4111-8111-111111111111', [
    threadComment({
      id: 'c-1',
      body: '看 <b>这里</b>',
      authorType: 'user',
      author: 'alice',
      createdAt: 1,
    }),
  ])
  assert.ok(xml.includes('issue="11111111-1111-4111-8111-111111111111"'))
  assert.ok(xml.includes('commentRole: "assignee"'), '必须给出回复锚点与 role')
  assert.ok(xml.includes('by="user"'), 'by 是作者类型；账号单独走 author 属性')
  assert.ok(xml.includes('t-…'))
  assert.ok(xml.includes('&lt;b&gt;这里&lt;/b&gt;'))
  assert.ok(Boolean(WAKE_INSTRUCTION) && Boolean(ASSIGNER_WAKE_INSTRUCTION))
})

test('comments：渲染器严格按传入条数输出，去重留在读取边界', () => {
  const xml = commentsXml('11111111-1111-4111-8111-111111111111', [
    threadComment({ id: 'local', body: '已验收', role: 'assignee', authorType: 'agent', createdAt: 1_000 }),
    threadComment({ id: 'remote', body: '已验收', role: 'assignee', authorType: 'agent', author: 'yukino', origin: 'remote', createdAt: 1_395 }),
    threadComment({ id: 'later', body: '已验收', role: 'assignee', authorType: 'agent', createdAt: 9_000 }),
  ])
  assert.ok(xml.includes('count="3"'))
  assert.equal(xml.match(/<comment /g)?.length, 3)
})

test('肖像材料：规则替换上限；target 两种模式；每轮指令是键值行', () => {
  const rules = castboardPortraitXml(PORTRAIT_MAX_LINES)
  assert.ok(!rules.includes('{{MAX_LINES}}'))
  assert.ok(rules.includes('**不超过 1000 行**'))

  const target = { id: 'w-1', path: 'D:/p', title: 'p', outputFile: 'C:/o.md', indexFile: 'C:/i.md' }
  assert.ok(portraitTargetXml({ ...target, portraitExists: true }).includes('<mode>增量更新</mode>'))
  assert.ok(portraitTargetXml({ ...target, portraitExists: false }).includes('<mode>新建</mode>'))
  const instruction = portraitInstruction({ ...target, portraitExists: false })
  assert.ok(instruction.includes('**新建**'))
  assert.equal(PORTRAIT_IDLE_PROMPT.includes('待写肖像'), true)
})

test('user 消息：router / 分发 / 执行指令', () => {
  assert.ok(routerInstruction('11111111-1111-4111-8111-111111111111').includes('issueId: 11111111-1111-4111-8111-111111111111'))
  assert.ok(routerInstruction('x').includes('只做转换'))
  assert.equal(ROUTER_IDLE_PROMPT.includes('待处理的 issue'), true)

  const dispatch = taskDispatchInstruction(taskRecord({ id: 't-9', title: '补检测' }), {
    text: '拆两件事',
    projectId: '42',
    assignee: 'r30038105',
  })
  assert.ok(dispatch.includes('<target project="42" assignee="r30038105"/>'))
  assert.ok(dispatch.includes('<request>拆两件事</request>'))

  // `userInstruction` 是 task-derive.effectivePrompt 的别名：正文为空退标题。
  const task = taskRecord({ id: 't-1', title: '修复', detail: '现象…' })
  const prompt = effectivePrompt(task)
  assert.equal(prompt, '现象…')
  assert.equal(userInstruction(task), prompt)
  const noDetail = taskRecord({ id: 't-1', title: '修复', detail: '' })
  assert.equal(effectivePrompt(noDetail), '修复')
  assert.equal(userInstruction(noDetail), '修复')
})

test('转义与指导：文本与属性分别处理，实例地址被写入', () => {
  assert.equal(escapeXml('<a & b>'), '&lt;a &amp; b&gt;')
  assert.equal(escapeXmlAttr('a"b\'c'), 'a&quot;b\'c')
  assert.ok(!CASTBOARD_RULES_XML.includes('{{'))
  const guidance = castboardIssueCreationGuidance({ instance: '10.0.0.1:3080' })
  assert.ok(guidance.includes('10.0.0.1:3080'))
  assert.ok(!guidance.includes('{{INSTANCE}}'))
  assert.equal(PLUGIN_NAME, '@meiyukichan/dsh-magica-castboard')
})
