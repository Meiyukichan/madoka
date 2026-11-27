/**
 * 提示词与具名上下文：静态段、任务 references、验收轮、router / 肖像材料与转义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCEPTANCE_ROUND_INSTRUCTION,
  ASSIGNER_WAKE_INSTRUCTION,
  CASTBOARD_SYSTEM_PROMPT,
  CASTBOARD_TASK_PROTOCOL_XML,
  PLUGIN_NAME,
  PORTRAIT_MAX_LINES,
  PORTRAIT_IDLE_PROMPT,
  ROUTER_IDLE_PROMPT,
  WAKE_INSTRUCTION,
  commentsXml,
  escapeXml,
  escapeXmlAttr,
  castboardAcceptanceXml,
  castboardIssueDelegation,
  castboardIssueContext,
  castboardIssueRouterXml,
  castboardPortraitXml,
  castboardTaskContext,
  castboardTaskProtocolXml,
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
  assert.equal(CASTBOARD_SYSTEM_PROMPT.includes('\n'), false)
  assert.ok(CASTBOARD_SYSTEM_PROMPT.startsWith('Use castboard_task, castboard_issue, castboard_teamwork, and castboard_comment'))
  assert.ok(CASTBOARD_SYSTEM_PROMPT.includes('Only the host acceptance round may move a card to done.'))
})

test('执行协议：五个子块齐全，且不含具体任务数据', () => {
  for (const block of [
    '<before_start',
    '<handoff>',
    '<checklist_rules>',
    '<boundaries',
    '<on_failure',
  ]) {
    assert.ok(CASTBOARD_TASK_PROTOCOL_XML.includes(block), `缺 ${block}`)
  }
  assert.ok(CASTBOARD_TASK_PROTOCOL_XML.includes('capability="report"'))
  assert.ok(!CASTBOARD_TASK_PROTOCOL_XML.includes('task id='), 'protocol 不能带任务数据')
})

test('执行协议：有验收策略时不再声称只有用户能移 done', () => {
  const withAcceptance = castboardTaskProtocolXml(true)
  assert.ok(!withAcceptance.includes('Only the user can move a card to done'))
  assert.ok(withAcceptance.includes('started by the castboard service'))

  const withoutAcceptance = castboardTaskProtocolXml(false)
  assert.ok(withoutAcceptance.includes('Only the user can move a card to done'))
})

test('任务 references：issue 双 id、附件、评论、上次执行、清单与标签', () => {
  const task = taskRecord({
    id: 't-1',
    title: '补检测',
    workspaceId: 'ws-1',
    issueId: '11111111-1111-4111-8111-111111111111',
    source: 'dsh',
    tags: ['example'],
    reference: { dag: 'a -> b', proposal: '落点 X' },
    checklist: [
      checklistItem('能识别 glibc', { checked: true, note: 'bundle.ts:118' }),
      checklistItem('musl 兜底'),
    ],
    executions: [
      { id: 'e-1', trigger: 'manual', outcome: 'failed', startedAt: 1, endedAt: 2, error: 'boom' },
    ],
  })
  const xml = castboardTaskContext(
    task,
    'D:/repo',
    [{ name: 'log.txt', path: 'D:/att/log.txt', type: 'input', description: '栈' }],
    [threadComment({ body: '补一条 <2.17>', authorType: 'user', role: 'assigner', createdAt: 1, threadId: 'session-abcdefghijklmnopqrstuvwx' })],
  )
  assert.ok(xml.includes('<task id="t-1" source="castboard">'))
  assert.ok(xml.includes('<issue id="11111111-1111-4111-8111-111111111111" source="dsh">'))
  assert.ok(xml.includes('castboard_comment (capability: "add"'))
  assert.ok(xml.includes('castboard-issue-comments'))
  assert.ok(xml.includes('role must be assignee'))
  assert.ok(xml.includes('<attachments count="1">'))
  assert.ok(xml.includes('type="input"'))
  assert.ok(xml.includes('path="D:/att/log.txt"'))
  assert.ok(xml.includes('补一条 &lt;2.17&gt;'), '评论正文要转义')
  assert.ok(xml.includes('<reference>') && xml.includes('<proposal>落点 X</proposal>'))
  assert.ok(xml.includes('<tags count="1">'))
  assert.ok(xml.includes('progress="1/2"') && xml.includes('evidence="bundle.ts:118"'))
  assert.ok(xml.includes('<last_execution') && xml.includes('<error>boom</error>'))
  assert.ok(xml.includes('<comments count="1"'))
  assert.ok(!xml.includes('\n\n'), 'task context 子块之间不能有空行')
  assert.ok(xml.includes('by="user"'))
})

test('任务 references：空数据时整块缺席（清单例外）', () => {
  const xml = castboardTaskContext(taskRecord({ id: 't-2', title: '空卡' }), 'D:/repo')
  assert.ok(!xml.includes('<issue id='), '没有 issueId 就不输出 <issue>')
  assert.ok(!xml.includes('<attachments'))
  assert.ok(!xml.includes('<comments count='))
  assert.ok(!xml.includes('<last_execution'))
  assert.ok(!xml.includes('<tags'))
  assert.equal(xml.includes('<checklist progress="0/0"></checklist>'), true)
})

test('验收上下文：close 排在 issue 前；只有 close 时不输出派发块', () => {
  const strategies: AcceptanceStrategy[] = [
    { id: 'a-2', type: 'issue', title: '遗留项', description: '拆 issue' },
    { id: 'a-1', type: 'close', title: '测试通过', description: 'pnpm test' },
  ]
  const xml = castboardAcceptanceXml(taskRecord({ id: 't-3', title: '待验收' }), strategies)
  assert.ok(xml.indexOf('<close_strategies') < xml.indexOf('<issue_strategies'), 'close 必须在前')
  assert.ok(xml.includes('step order="5"'))
  assert.ok(xml.includes('<constraints>'))
  assert.ok(xml.includes('the card has moved to todo or done'))
  assert.ok(!xml.includes('\n\n'), 'acceptance 子块之间不能有空行')

  const onlyClose = castboardAcceptanceXml(taskRecord({ id: 't-4', title: 'x' }), [strategies[1]!])
  assert.ok(!onlyClose.includes('<issue_strategies>'))
  assert.equal(ACCEPTANCE_ROUND_INSTRUCTION, 'Run this acceptance round using the injected castboard-task-acceptance context.')
})

test('router 静态指导：占位符全部替换', () => {
  const xml = castboardIssueRouterXml({
    workspacesCustom: 'C:/home/worklabs/workspaces-custom.json',
    strategyCustom: 'C:/home/worklabs/strategy-custom.json',
    tasksDir: 'C:/home/tasks',
    workspaceIndex: 'C:/home/worklabs/workspaces/index.md',
    portraitDir: 'C:/home/worklabs/workspaces',
  })
  assert.ok(!xml.includes('{{'))
  assert.ok(xml.includes('C:/home/worklabs/workspaces-custom.json'))
  assert.ok(xml.includes('C:/home/worklabs/workspaces/index.md'))
  assert.ok(xml.includes('C:/home/worklabs/workspaces/index.md'))
  assert.ok(xml.includes('castboard_issue (capability="convert")'))
  assert.ok(xml.includes('<delegation limit="1">'))
})

test('issue context：assigner_meta 剔除 title/detail；材料缺席即整块不输出', () => {
  const issue = issueRecord({
    id: '11111111-1111-4111-8111-111111111111',
    title: '诉求',
    detail: '正文',
    urgency: 'urgent',
    cwd: 'D:/p',
    source: 'dsh',
    assignerMeta: { title: '诉求', detail: '很长的正文', acceptance: '能跑' },
  })
  const xml = castboardIssueContext(issue)
  const meta = xml.slice(xml.indexOf('<assigner_meta>'), xml.indexOf('</assigner_meta>'))
  assert.ok(meta.includes('acceptance'))
  assert.ok(!meta.includes('很长的正文'), 'assigner_meta 必须剔除 detail')
  assert.ok(!xml.includes('<input_attachments'))
  assert.ok(!xml.includes('<comments count='))
  assert.ok(!xml.includes('<workspaces_catalog>'))
})

test('comments：回复提示、role、转义与唤醒语', () => {
  const xml = commentsXml('11111111-1111-4111-8111-111111111111', [
    threadComment({
      id: 'c-1',
      body: '看 <b>这里</b>',
      authorType: 'user',
      author: 'alice',
      createdAt: 1,
    }),
  ])
  assert.ok(xml.includes('issue_id="11111111-1111-4111-8111-111111111111"'))
  assert.ok(xml.includes('<reply role="assignee">'), '必须给出回复锚点与 role')
  assert.ok(xml.includes('by="user"'), 'by 是作者类型；账号单独走 author 属性')
  assert.ok(xml.includes('&lt;b&gt;这里&lt;/b&gt;'))

  const assignerXml = commentsXml('11111111-1111-4111-8111-111111111111', [threadComment()], 'assigner')
  assert.ok(assignerXml.includes('<reply role="assigner">'))
  assert.ok(Boolean(WAKE_INSTRUCTION) && Boolean(ASSIGNER_WAKE_INSTRUCTION))
})

test('comments：有附件时在 comment 内输出附件绝对路径', () => {
  const xml = commentsXml('11111111-1111-4111-8111-111111111111', [
    threadComment({ id: 'c-att', body: '验收补充（带附件）' }),
  ], 'assignee', commentId => commentId === 'c-att'
    ? [{ name: 'miku.txt', path: 'C:\\work\\attachments\\issue\\comments\\c-att\\miku.txt' }]
    : [])
  assert.ok(xml.includes('<attachments count="1">'))
  assert.ok(xml.includes('name="miku.txt"'))
  assert.ok(xml.includes('path="C:\\work\\attachments\\issue\\comments\\c-att\\miku.txt"'))
  assert.ok(xml.indexOf('</attachments>') < xml.indexOf('</comment>'))
})

test('comments：渲染器严格按传入条数输出，去重留在读取边界', () => {
  const xml = commentsXml('11111111-1111-4111-8111-111111111111', [
    threadComment({ id: 'local', body: '已验收', role: 'assignee', authorType: 'agent', createdAt: 1_000 }),
    threadComment({ id: 'remote', body: '已验收', role: 'assignee', authorType: 'agent', author: 'bob', origin: 'remote', createdAt: 1_395 }),
    threadComment({ id: 'later', body: '已验收', role: 'assignee', authorType: 'agent', createdAt: 9_000 }),
  ])
  assert.ok(xml.includes('count="3"'))
  assert.equal(xml.match(/<comment /g)?.length, 3)
})

test('task context：评论附件跟在 comment 内，不进全局 attachments', () => {
  const xml = castboardTaskContext(
    taskRecord({ issueId: '11111111-1111-4111-8111-111111111111' }),
    'D:/repo',
    [
      { name: 'input.txt', path: 'C:\\work\\input.txt', type: 'input' },
      {
        name: 'miku.txt',
        path: 'C:\\work\\attachments\\issue\\comments\\c-att\\miku.txt',
        type: 'comment',
        targetType: 'comment',
        targetId: 'c-att',
      },
    ],
    [threadComment({ id: 'c-att', body: '带附件评论' })],
  )
  assert.ok(xml.includes('<attachments count="1">'), '全局附件只应包含非评论目标')
  assert.ok(xml.includes('name="miku.txt"'))
  assert.ok(xml.includes('path="C:\\work\\attachments\\issue\\comments\\c-att\\miku.txt"'))
  assert.ok(xml.indexOf('name="miku.txt"') > xml.indexOf('<comment '))
  assert.ok(xml.indexOf('name="miku.txt"') < xml.indexOf('</comment>'))
})

test('肖像材料：规则替换上限；target 两种模式；每轮指令只定顺序与收尾', () => {
  const rules = castboardPortraitXml(PORTRAIT_MAX_LINES)
  assert.ok(!rules.includes('{{MAX_LINES}}'))
  assert.ok(rules.includes('at most 1000 lines per file'))

  const target = { id: 'w-1', path: 'D:/p', title: 'p', outputFile: 'C:/o.md', indexFile: 'C:/i.md' }
  assert.ok(portraitTargetXml({ ...target, portraitExists: true }).includes('<mode>update</mode>'))
  assert.ok(portraitTargetXml({ ...target, portraitExists: false }).includes('<mode>create</mode>'))
  const instruction = portraitInstruction()
  assert.ok(instruction.includes('index entry'))
  assert.equal(PORTRAIT_IDLE_PROMPT.includes('waiting for a portrait'), true)
})

test('user 消息：router / 分发 / 执行指令', () => {
  assert.ok(routerInstruction('11111111-1111-4111-8111-111111111111').includes('issueId: 11111111-1111-4111-8111-111111111111'))
  assert.ok(routerInstruction('x').includes('conversion only'))
  assert.equal(ROUTER_IDLE_PROMPT.includes('pending issues'), true)

  const dispatch = taskDispatchInstruction(taskRecord({ id: 't-9', title: '补检测' }), {
    text: '拆两件事',
    projectId: '42',
    assignee: 'user-123',
  })
  assert.ok(dispatch.includes('<target project="42" assignee="user-123"/>'))
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
  assert.equal(escapeXml('a\u0000b'), 'ab')
  assert.equal(escapeXmlAttr('a"b\'c\nd'), 'a&quot;b&apos;c&#10;d')
  assert.ok(!CASTBOARD_TASK_PROTOCOL_XML.includes('{{'))
  const guidance = castboardIssueDelegation({ instance: '127.0.0.1:3080' })
  assert.ok(guidance.includes('127.0.0.1:3080'))
  assert.ok(!guidance.includes('{{INSTANCE}}'))
  const escaped = castboardIssueDelegation({ instance: 'a&b' })
  assert.ok(escaped.includes('This host is a&amp;b.'))
  assert.equal(PLUGIN_NAME, '@meiyukichan/dsh-magica-castboard')
})
