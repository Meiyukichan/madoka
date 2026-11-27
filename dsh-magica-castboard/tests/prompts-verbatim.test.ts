/**
 * 提示词/上下文常量的逐字比对。
 *
 * 只做两种归一化：CRLF → LF、源码模板里的转义反引号还原。任何措辞差异都应让测试红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACCEPTANCE_ROUND_INSTRUCTION } from '../src/host/context/acceptance-instruction.ts'
import { ASSIGNER_WAKE_INSTRUCTION, WAKE_INSTRUCTION } from '../src/host/context/comment-instruction.ts'
import { CASTBOARD_SYSTEM_PROMPT } from '../src/host/context/system.ts'
import { CASTBOARD_TASK_PROTOCOL_XML } from '../src/host/context/task-context.ts'
import { castboardIssueRouterXml } from '../src/host/context/router-context.ts'
import { castboardIssueDelegation } from '../src/host/context/delegation-context.ts'
import { commentsXml } from '../src/host/context/comment-context.ts'
import { CASTBOARD_PORTRAIT_XML, portraitTargetXml } from '../src/host/context/portrait-context.ts'
import { PORTRAIT_IDLE_PROMPT, portraitInstruction } from '../src/host/context/portrait-instruction.ts'
import { ROUTER_IDLE_PROMPT, routerInstruction } from '../src/host/context/router-instruction.ts'
import { taskDispatchInstruction } from '../src/host/context/task-instruction.ts'


test('看板系统提示段使用四工具与 capability', () => {
  assert.ok(CASTBOARD_SYSTEM_PROMPT.startsWith('Use castboard_task, castboard_issue, castboard_teamwork, and castboard_comment'))
  assert.ok(CASTBOARD_SYSTEM_PROMPT.includes('every call takes a capability'))
  assert.ok(CASTBOARD_SYSTEM_PROMPT.includes('never claim in_progress'))
  assert.ok(CASTBOARD_SYSTEM_PROMPT.includes('Only the host acceptance round may move a card to done.'))
})

test('执行协议使用四工具能力名', () => {
  assert.ok(CASTBOARD_TASK_PROTOCOL_XML.includes('tool="castboard_task" capability="get"'))
  assert.ok(CASTBOARD_TASK_PROTOCOL_XML.includes('tool="castboard_task" capability="report"'))
  assert.ok(CASTBOARD_TASK_PROTOCOL_XML.includes('tool="castboard_comment" capability="add"'))
  assert.ok(CASTBOARD_TASK_PROTOCOL_XML.includes('capability="checklist"'))
  assert.ok(!CASTBOARD_TASK_PROTOCOL_XML.includes('castboard_execution_report'))
})

test('issue routing 指导使用 convert 能力', () => {
  const actual = castboardIssueRouterXml({
    workspacesCustom: 'C:\\Users\\user-123\\.dsh\\storages\\castboard\\worklabs\\workspaces-custom.json',
    strategyCustom: 'C:\\Users\\user-123\\.dsh\\storages\\castboard\\worklabs\\strategy-custom.json',
    tasksDir: 'C:\\Users\\user-123\\.dsh\\storages\\castboard\\tasks',
    workspaceIndex: 'C:\\Users\\user-123\\.dsh\\storages\\castboard\\worklabs\\workspaces\\index.md',
    portraitDir: 'C:\\Users\\user-123\\.dsh\\storages\\castboard\\worklabs\\workspaces',
  })
  assert.ok(actual.startsWith('<castboard_issue_router>'))
  assert.ok(actual.endsWith('</castboard_issue_router>'))
  assert.ok(!actual.includes('{{'))
  assert.ok(actual.includes('castboard_issue (capability="convert")'))
  assert.ok(!actual.includes('castboard_issue_task'))
})

test('项目肖像静态规则包含边界与格式约束', () => {
  const actual = CASTBOARD_PORTRAIT_XML.replace('{{MAX_LINES}}', '1000')
  assert.ok(actual.startsWith('<castboard_project_portrait>'))
  assert.ok(actual.includes('<boundary>'))
  assert.ok(actual.includes('<format>'))
  assert.ok(actual.includes('1000'))
  assert.ok(actual.includes('<language>Write both the portrait and its index entry in English'))
  assert.ok(actual.includes('Routing fit'))
  assert.ok(actual.includes('Not here'))
  assert.ok(actual.includes('Keywords'))
  assert.ok(actual.includes('written in English'))
})

test('分发指导：必填字段契约（projectId/title/detail/assignee/assigneeInstance）', () => {
  const instance = '127.0.0.1:3080'
  const actual = castboardIssueDelegation({ instance })
  assert.ok(actual.includes('<field name="projectId" from="step 1">'))
  assert.ok(actual.includes('<field name="title" from="request">'))
  assert.ok(actual.includes('<field name="detail" from="request">'))
  assert.ok(actual.includes('<field name="assignerMeta" from="request">'))
  assert.ok(actual.includes('close finishes as done'))
  assert.ok(actual.includes('issue spawns a new planning issue'))
  assert.ok(actual.includes('<field name="assignee" from="step 2">'))
  assert.ok(actual.includes('<field name="assigneeInstance" from="step 3">'))
  assert.ok(actual.includes('Check every item against field_map before submitting.'))
  assert.ok(actual.includes("If you cannot answer the assignee's question"))
  assert.ok(actual.includes('never invent one'))
  assert.ok(actual.includes('Use a lookup result without asking only when the returned list has exactly one item.'))
  assert.ok(actual.includes('ask in step order, one decision at a time. Never combine dependent choices into one question.'))
  assert.ok(actual.includes('Use a value without asking when the user names it in this request.'))
  assert.ok(actual.includes('cwd is the exception: even when there is one directory'))
  assert.ok(actual.includes('"no cwd"'))
})

test('固定唤醒语与占位语逐字一致', () => {
  assert.equal(ACCEPTANCE_ROUND_INSTRUCTION, 'Run this acceptance round using the injected castboard-task-acceptance context.')
  assert.equal(WAKE_INSTRUCTION, 'The upstream issue has new comments; handle them as described in the injected context. Do not change task status.')
  assert.equal(ASSIGNER_WAKE_INSTRUCTION, 'The issue you dispatched has new comments; handle them as described in the injected context.')
  assert.equal(ROUTER_IDLE_PROMPT, 'You are ready. There are no pending issues; do nothing and wait for the next wake-up.')
  assert.equal(PORTRAIT_IDLE_PROMPT, 'You are ready. There are no projects waiting for a portrait; do nothing and wait for the next wake-up.')
})

test('issue 评论 XML 使用 castboard_comment', () => {
  const xml = commentsXml('6f2b9d41-3c8a-4e77-bb10-5c9d2e1a7f88', [
    { role: 'assigner', authorType: 'user', author: 'user-123', createdAt: Date.parse('2026-11-16T02:21:10.001Z'), body: '2.17 那台也要覆盖，别只测 2.28。' },
    { role: 'assigner', authorType: 'user', author: 'user-123', createdAt: Date.parse('2026-11-16T02:24:55.220Z'), body: '另外把 musl 环境也带上。' },
  ] as never)
  assert.ok(xml.includes('castboard_comment (capability="add")'))
  assert.ok(xml.includes('<reply role="assignee">'))
  assert.ok(!xml.includes('castboard_issue_comment_add'))
})

test('任务分发指令使用四工具', () => {
  const xml = taskDispatchInstruction(
    { id: 't-9f3a1c-7b2', title: '给 example-project 补 glibc bundle 检测' } as never,
    {
      text: '把「musl 环境兜底」和「回归用例」两件事拆出去，交给后端组做。',
      projectId: '42',
      assignee: 'user-123',
      assigneeInstance: '127.0.0.1:3080',
    },
  )
  assert.ok(xml.includes('castboard_issue (capability="help")'))
  assert.ok(xml.includes('castboard_issue (capability="create")'))
  assert.ok(xml.includes('castboard_comment (capability="add")'))
})

test('router 每轮指令要求转换成 task', () => {
  assert.ok(routerInstruction('6f2b9d41-3c8a-4e77-bb10-5c9d2e1a7f88').includes('convert the issue'))
})

test('肖像 target 与每轮指令逐字一致', () => {
  const target = {
    id: 'a3f1c9d2-8e4b-4c17-9a55-2d6f7e8b1c03',
    path: 'D:\\projects\\example-org\\common\\harness\\demo-project',
    title: 'demo-project',
    outputFile: 'C:\\Users\\user-123\\.dsh\\storages\\castboard\\worklabs\\workspaces\\a3f1c9d2-8e4b-4c17-9a55-2d6f7e8b1c03.md',
    indexFile: 'C:\\Users\\user-123\\.dsh\\storages\\castboard\\worklabs\\workspaces\\index.md',
    portraitExists: true,
  }
  assert.equal(portraitTargetXml(target), `<castboard_portrait_target>
<workspace_id>a3f1c9d2-8e4b-4c17-9a55-2d6f7e8b1c03</workspace_id>
<cwd>D:\\projects\\example-org\\common\\harness\\demo-project</cwd>
<title>demo-project</title>
<output_file>C:\\Users\\user-123\\.dsh\\storages\\castboard\\worklabs\\workspaces\\a3f1c9d2-8e4b-4c17-9a55-2d6f7e8b1c03.md</output_file>
<index_file>C:\\Users\\user-123\\.dsh\\storages\\castboard\\worklabs\\workspaces\\index.md</index_file>
<mode>update</mode>
</castboard_portrait_target>`)
  assert.equal(portraitInstruction(), "Write or update this project's portrait first, then update its index entry using the target below. Stop after both files are written.")
})
