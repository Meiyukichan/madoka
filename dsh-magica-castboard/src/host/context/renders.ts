/**
 * Dynamic rendering for named contexts and user messages. Static text lives in
 * `texts.ts`; this module only fills task or issue data into templates, and every
 * function is pure.
 *
 * User-controlled strings are always escaped (`escapeXml`, plus `escapeXmlAttr` for
 * attribute values) because one `<` in a title could forge a tag. Empty blocks are
 * omitted entirely — an empty tag reads as "present but empty" — except the checklist,
 * where stating "no checklist" prevents a lost dependency being suspected. Truncated
 * comment lists report both the total (`count`) and what was dropped (`omitted`), and
 * times are absolute (`toISOString()`) so they do not drift between renders.
 *
 * @module dsh-magica-castboard/host/context/renders
 */
import { WELINK_SOURCE } from '../model.ts'
import type {
  AcceptanceStrategy,
  IssueRecord,
  TaskRecord,
  ThreadComment,
} from '../model.ts'
import { effectivePrompt } from '../ledger/task-derive.ts'
import { REFERENCES_SECTION, RULES_SECTION } from './sections.ts'
import { CASTBOARD_ISSUE_ROUTING_XML, CASTBOARD_RULES_XML } from './texts.ts'

// Implementations live in `comment-xml.ts` and `../portrait/prompt.ts`; these re-exports
// keep the context barrel and prompts-verbatim imports stable.
export { commentsXml } from './comment-xml.ts'

export {
  castboardPortraitXml,
  portraitInstruction,
  portraitTargetXml,
  type PortraitTarget,
} from '../portrait/prompt.ts'

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Attribute values are always double-quoted, so quotes need escaping too.
export function escapeXmlAttr(text: string): string {
  return escapeXml(text).replace(/"/g, '&quot;')
}

// No node:path import: slicing is enough, and a bare name has no parent.
function dirnameOf(path: string): string | undefined {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return index > 0 ? path.slice(0, index) : undefined
}

/**
 * Material handed to the executor with a task: a requirements document, log,
 * screenshot, API sample. Named input-attachments because `inputs` already means "user
 * instructions" here, and `input` keeps these distinct from task artifacts.
 */
export interface InputAttachment {
  readonly name: string
  readonly path: string
  readonly description?: string
}

// Cap the injected backlog; a long discussion would blow up the prompt.
const MAX_SINCE_COMMENTS = 20

// Sources whose peer is an agent reachable through issue comments: the local instance
// (`self`), another dsh instance (`dsh`), and the WeLink assistant. Codes added later
// by the shared library's source dictionary have no session, so a question written into
// those issues is never read.
const AGENT_UPSTREAM_SOURCES: readonly string[] = ['self', 'dsh', WELINK_SOURCE]

// `source` is a free-form string (the dictionary can add codes), so normalize before
// matching; otherwise `'DSH'` or `'self '` would slip through.
function hasAgentUpstream(source: string | undefined): boolean {
  if (source === undefined) return false
  const normalized = source.trim().toLowerCase()
  return normalized !== '' && AGENT_UPSTREAM_SOURCES.includes(normalized)
}

export function castboardReferences(
  task: TaskRecord,
  workspacePath: string,
  inputAttachments: readonly InputAttachment[] = [],
  comments: readonly ThreadComment[] = [],
): string {
  const lines: string[] = ['<castboard_task_references>']

  lines.push(`<task id="${escapeXmlAttr(task.id)}" source="任务面板执行服务">`)
  lines.push(`  <title>${escapeXml(task.title)}</title>`)
  lines.push(`  <workspace id="${escapeXmlAttr(task.workspaceId)}">${escapeXml(workspacePath)}</workspace>`)

  // Keep both ids side by side and label each with its tool. An execution session
  // normally sees only the task id and passes it to the issue-comment tool, which then
  // writes to a nonexistent anchor and still reports success. `source` picks who to
  // ask: an agent peer answers through comments, a session-less peer needs the user.
  if (task.issueId !== undefined && task.issueId !== '') {
    const source = task.source
    const sourceAttr = source === undefined || source.trim() === ''
      ? ''
      : ` source="${escapeXmlAttr(source)}"`
    lines.push(`  <issue id="${escapeXmlAttr(task.issueId)}"${sourceAttr}>`)
    lines.push('    这张卡由上面这条 issue 转来。**发 issue 评论要传这个 issue id**：')
    lines.push(`    castboard_issue_comment_add { issueId: "${escapeXmlAttr(task.issueId)}", commentRole: "assignee", body: "…" }`)
    lines.push(`    上面 <task id="${escapeXmlAttr(task.id)}"> 那个是**任务 id**，只能配 castboard_comment_add / castboard_move / castboard_execution_report，`)
    lines.push('    传给 castboard_issue_comment_add 会被拒。')
    if (hasAgentUpstream(source)) {
      lines.push('    **你的直接上游是分发者（一个智能体），不是用户** —— 分发者的上游才是用户：')
      lines.push('    要澄清 / 缺上下文就用上面那个工具问**分发者**，**禁止用 ask_user_question 直接问用户**（那会越过分发者，两端信息对不上）。')
    } else {
      lines.push('    但**它的上游不是智能体**（source 不在 self / dsh / welink 之列），那边没有会话能回你话：')
      lines.push('    要澄清 / 缺上下文就**自己用 ask_user_question 问用户**。')
    }
    lines.push('  </issue>')
  }
  lines.push('</task>')

  if (inputAttachments.length > 0) {
    lines.push('')
    // A batch always lives in one issue directory, so the first file decides it.
    const first = inputAttachments[0]
    const dir = first === undefined ? undefined : dirnameOf(first.path)
    lines.push(dir === undefined
      ? `<input_attachments count="${inputAttachments.length}">`
      : `<input_attachments count="${inputAttachments.length}" dir="${escapeXmlAttr(dir)}">`)
    inputAttachments.forEach((inputAttachment, index) => {
      const attrs = [
        `index="${index + 1}"`,
        `name="${escapeXmlAttr(inputAttachment.name)}"`,
        `path="${escapeXmlAttr(inputAttachment.path)}"`,
      ].join(' ')
      const body = inputAttachment.description === undefined ? '' : escapeXml(inputAttachment.description)
      lines.push(`  <input_attachment ${attrs}>${body}</input_attachment>`)
    })
    lines.push('</input_attachments>')
  }

  // Skip the running entry: that is this round, not the last one.
  const lastExecution = [...task.executions].reverse().find(entry => entry.outcome !== 'running')
  if (lastExecution !== undefined) {
    const attrs = [
      `trigger="${escapeXmlAttr(lastExecution.trigger)}"`,
      `outcome="${escapeXmlAttr(lastExecution.outcome)}"`,
      ...(lastExecution.startedAt !== undefined ? [`started_at="${new Date(lastExecution.startedAt).toISOString()}"`] : []),
      ...(lastExecution.endedAt !== undefined ? [`ended_at="${new Date(lastExecution.endedAt).toISOString()}"`] : []),
    ].join(' ')
    lines.push('')
    if (lastExecution.error === undefined || lastExecution.error === '') {
      lines.push(`<last_execution ${attrs}></last_execution>`)
    } else {
      lines.push(`<last_execution ${attrs}>`)
      lines.push(`  <error>${escapeXml(lastExecution.error)}</error>`)
      lines.push('</last_execution>')
    }
  }

  // With no history since = 0, so a first run also sees comments from before it. New
  // comments on the originating issue arrive through their own named context.
  const since = lastExecution?.endedAt ?? lastExecution?.startedAt ?? 0
  const allSince = comments.filter(comment => comment.createdAt > since)
  if (allSince.length > 0) {
    const omitted = Math.max(0, allSince.length - MAX_SINCE_COMMENTS)
    const shown = omitted > 0 ? allSince.slice(-MAX_SINCE_COMMENTS) : allSince
    lines.push('')
    const sinceAttr = since > 0 ? ` since="${new Date(since).toISOString()}"` : ''
    const omittedAttr = omitted > 0 ? ` omitted="${omitted}"` : ''
    lines.push(`<comments_since_last_execution count="${allSince.length}"${sinceAttr}${omittedAttr}>`)
    for (const comment of shown) {
      // Author type decides `by`, never threadId presence: system messages are neither
      // a person nor this session's agent, and must not read as the agent's own words.
      const by = comment.authorType === 'system'
        ? 'system'
        : comment.threadId !== undefined ? 'agent' : 'user'
      // First 24 characters of the session id tell this session's agent from another
      // one without spending many tokens.
      const threadAttr = comment.threadId !== undefined
        ? ` thread="${escapeXmlAttr(comment.threadId.slice(0, 24))}"`
        : ''
      // Dispatcher vs executor changes what the same sentence means; rows written
      // before this column existed simply omit the attribute.
      const roleAttr = comment.role === null ? '' : ` role="${comment.role}"`
      // The cloud account, without which `by` and `thread` cannot name the person.
      const authorAttr = comment.author !== undefined && comment.author !== ''
        ? ` author="${escapeXmlAttr(comment.author)}"`
        : ''
      lines.push(`  <comment by="${by}"${roleAttr}${threadAttr}${authorAttr} at="${new Date(comment.createdAt).toISOString()}">${escapeXml(comment.body)}</comment>`)
    }
    lines.push('</comments_since_last_execution>')
  }

  const reference = task.reference
  if (reference !== undefined && (reference.dag !== undefined || reference.router !== undefined)) {
    lines.push('')
    lines.push('<router-reference>')
    if (reference.dag !== undefined && reference.dag !== '') {
      lines.push(`  <dag>${escapeXml(reference.dag)}</dag>`)
    }
    if (reference.router !== undefined && reference.router !== '') {
      lines.push(`  <proposal>${escapeXml(reference.router)}</proposal>`)
    }
    lines.push('</router-reference>')
  }

  const tags = task.tags ?? []
  if (tags.length > 0) {
    lines.push('')
    lines.push(`<tags count="${tags.length}">`)
    for (const tag of tags) lines.push(`  <tag>${escapeXml(tag)}</tag>`)
    lines.push('</tags>')
  }

  lines.push('')
  const items = task.checklist ?? []
  if (items.length === 0) {
    lines.push('<checklist>本任务没有验收清单。</checklist>')
  } else {
    const done = items.filter(item => item.checked).length
    lines.push(`<checklist progress="${done}/${items.length}">`)
    items.forEach((item, index) => {
      const attrs = [
        `index="${index + 1}"`,
        `checked="${item.checked ? 'true' : 'false'}"`,
        ...(item.note !== undefined && item.note !== '' ? [`evidence="${escapeXmlAttr(item.note)}"`] : []),
      ].join(' ')
      lines.push(`  <item ${attrs}>${escapeXml(item.text)}</item>`)
    })
    lines.push('</checklist>')
  }

  lines.push('</castboard_task_references>')
  return lines.join('\n')
}

export interface NamedContext {
  readonly name: string
  readonly text: string
}

// Return order is injection order. Instructions are constant while data is re-rendered
// from the card, so a missing checklist never hides the checklist instructions.
export function buildContexts(
  task: TaskRecord,
  workspacePath: string,
  inputAttachments: readonly InputAttachment[] = [],
  comments: readonly ThreadComment[] = [],
): NamedContext[] {
  return [
    { name: RULES_SECTION, text: CASTBOARD_RULES_XML },
    { name: REFERENCES_SECTION, text: castboardReferences(task, workspacePath, inputAttachments, comments) },
  ]
}

// Same function the tool uses to show the execution prompt; a second implementation
// would let what the tool shows and what the session receives diverge. An empty body
// falls back to the title inside `effectivePrompt`.
export function userInstruction(task: TaskRecord): string {
  return effectivePrompt(task)
}

export interface IssueRoutingFiles {
  readonly workspacesCustom: string
  readonly strategyCustom: string
  readonly scratchDir: string
  readonly tasksDir: string
}

// Paths follow `$DSH_HOME` and must not be baked into the constant. The two
// user-maintained files may be missing or empty; the prompt says to ignore them, and
// this function deliberately does not probe.
export function castboardIssueRoutingXml(files: IssueRoutingFiles): string {
  return CASTBOARD_ISSUE_ROUTING_XML
    .replace('{{WORKSPACES_CUSTOM}}', files.workspacesCustom)
    .replace('{{STRATEGY_CUSTOM}}', files.strategyCustom)
    .replace('{{SCRATCH_DIR}}', files.scratchDir)
    .replace('{{TASKS_DIR}}', files.tasksDir)
}

export function routerInstruction(issueId: string): string {
  return `请使用子代理，按照 castboard-issue-routing 的指导，把当前 issue（issueId: ${issueId}）转换成 task。注意：**只做转换，不要执行这条 issue 的工作**（不要改代码/跑命令/写文件，也不要产出方案文档）——读懂它、适度补齐执行所需的信息后调用 castboard_issue_task 即可；task 会由单独的执行者去执行。`
}

/** Retry wake: only remind the existing router which issue still needs conversion. */
export function routerReminder(issueId: string): string {
  return `继续处理 issue（issueId: ${issueId}）。上一轮还没有转成 task；不要重新展开完整材料，直接按已有上下文完成本次转换并调用 castboard_issue_task。`
}

export interface DispatchTarget {
  readonly text: string
  readonly projectId: string
  readonly assignee: string
  readonly assigneeInstance?: string
}

// One-off instruction from a person, unlike the strategy-driven acceptance round. Both
// forbid touching task state or closing the card.
export function taskDispatchInstruction(task: TaskRecord, target: DispatchTarget): string {
  const lines: string[] = ['<castboard_task_dispatch>']
  lines.push(`<task id="${escapeXmlAttr(task.id)}">`)
  lines.push(`  <title>${escapeXml(task.title)}</title>`)
  lines.push('</task>')
  const attrs = [
    `project="${escapeXmlAttr(target.projectId)}"`,
    `assignee="${escapeXmlAttr(target.assignee)}"`,
    target.assigneeInstance !== undefined ? `instance="${escapeXmlAttr(target.assigneeInstance)}"` : '',
  ].filter(part => part !== '').join(' ')
  lines.push(attrs === '' ? '<target/>' : `<target ${attrs}/>`)
  lines.push(`<request>${escapeXml(target.text)}</request>`)
  lines.push('<steps>')
  lines.push('  <step order="1">先用 castboard_issues_help 看建 issue 的规矩（它会往本会话注入完整说明），再用 castboard_issue_groups / castboard_issue_group_members / castboard_issue_workspaces 核对目标。</step>')
  lines.push('  <step order="2">按 <request> 里的要求把活拆成一条或多条 issue，用 castboard_issues_create 建；先后关系用 dependsOn 表达。目标字段（project / assignee / instance）**按 <target> 原样采用，不必再问用户**；<target> 里没有的字段（cwd / 附件）按上面那份指导的第 5、6 步处理 —— 能问就问，问不到（或用户不选）就整项不传，**不许编造**（共享库允许 cwd 为空）。</step>')
  lines.push('  <step order="3">用 castboard_comment_add 汇总派了哪几条 issue（标题 + issueId）。</step>')
  lines.push('</steps>')
  lines.push('<never>不要改本任务的状态（它还留在待验收），也不要自己把它移到 done；不要动代码。</never>')
  lines.push('</castboard_task_dispatch>')
  return lines.join('\n')
}

// Close strategies must be listed and handled before dispatch strategies: first decide
// whether the card can be closed, then what work should still go out. This is also the
// only round allowed to move a card to done.
export function castboardAcceptanceXml(
  task: TaskRecord,
  strategies: readonly AcceptanceStrategy[],
): string {
  const accept = strategies.filter(strategy => strategy.type === 'close')
  const dispatch = strategies.filter(strategy => strategy.type === 'issue')
  const lines: string[] = ['<castboard_task_acceptance>']
  lines.push(`<task id="${escapeXmlAttr(task.id)}">`)
  lines.push(`  <title>${escapeXml(task.title)}</title>`)
  lines.push('</task>')
  lines.push('<context>这张卡刚执行完，现在停在**待验收**。这一轮不写代码，只做判断与收尾：先判能不能收，再决定这张卡去哪一列。</context>')
  lines.push('<steps>')
  lines.push('  <step order="1">先看下面的 <accept_strategies>（验收为完成）：逐条核对执行报告、评论里的证据与代码事实。</step>')
  lines.push('  <step order="2">**只要有一条不满足** → 用 castboard_comment_add 写清缺什么，然后 castboard_move 把这张卡移到 **todo（待办）**'
    + '（系统会自动把它标记为「验收未通过」）。到这一步就结束，不要分发。</step>')
  lines.push('  <step order="3">**全部满足** → 再看 <dispatch_strategies>（分发为 issue）：按它们拆出新的 issue。'
    + '先用 castboard_issues_help 看建 issue 的规矩，再用 castboard_issues_create 建；一张卡可以拆多条，先后关系用 dependsOn 表达。'
    + '没有 <dispatch_strategies> 就跳过这一步。</step>')
  lines.push('  <step order="4">用 castboard_comment_add 汇总：验收结论（通过 / 不通过 + 依据），以及派了哪几条 issue（标题 + issueId）。</step>')
  lines.push('  <step order="5">**全部满足（分发 issue 成功也算成功）** → 最后 castboard_move 把这张卡移到 **done（已完成）**。</step>')
  lines.push('</steps>')
  lines.push('<finish>**完成验收 = 写下验收结论并把卡移到 todo 或 done。** 这两步做完，本轮验收就结束了，'
    + '不需要等待或请求任何额外指令；卡离开待验收列即视为本轮收尾完成。</finish>')
  lines.push('<never>不要改执行记录，也不要替人做「遗弃 / 归档」这类删除性动作。你这一轮只做三件事：结论、新 issue、把卡移到 todo 或 done。</never>')
  if (accept.length > 0) {
    lines.push('<accept_strategies when="先看这里：能不能收">')
    for (const strategy of accept) {
      lines.push(`  <strategy id="${escapeXmlAttr(strategy.id)}" title="${escapeXmlAttr(strategy.title)}">${escapeXml(strategy.description)}</strategy>`)
    }
    lines.push('</accept_strategies>')
  }
  if (dispatch.length > 0) {
    lines.push('<dispatch_strategies when="确认能收之后再按这些拆 issue">')
    for (const strategy of dispatch) {
      lines.push(`  <strategy id="${escapeXmlAttr(strategy.id)}" title="${escapeXmlAttr(strategy.title)}">${escapeXml(strategy.description)}</strategy>`)
    }
    lines.push('</dispatch_strategies>')
  }
  lines.push('</castboard_task_acceptance>')
  return lines.join('\n')
}

export interface IssueReferenceAttachment {
  readonly name: string
  readonly path: string
  readonly description?: string
}

export interface IssueReferenceComment {
  readonly author: string
  readonly content: string
  readonly at?: string
}

export interface IssueReferenceCatalog {
  readonly indexFile: string
  readonly portraitDir: string
}

export interface IssueReferenceExtras {
  readonly attachments?: readonly IssueReferenceAttachment[]
  readonly comments?: readonly IssueReferenceComment[]
  readonly workspacesCatalog?: IssueReferenceCatalog
  /** Per-issue fallback cwd: `<castboard>/.cache/<issueId>`, already created by the host. */
  readonly fallbackCwd?: string
}

export function castboardIssueReferences(
  issue: IssueRecord,
  extras: IssueReferenceExtras = {},
): string {
  const lines: string[] = ['<castboard_issue_references>']
  const push = (name: string, value: string | undefined): void => {
    if (value === undefined || value === '') return
    lines.push(`<${name}>${escapeXml(value)}</${name}>`)
  }
  push('issue_id', issue.id)
  push('title', issue.title)
  push('detail', issue.detail)
  push('urgency', issue.urgency)
  push('permission', issue.permission)
  push('cwd', issue.cwd)
  push('fallback_cwd', extras.fallbackCwd)
  push('workspace_id', issue.workspaceId)
  push('source', issue.source)
  push('assigner', issue.assigner)
  push('assigner_task', issue.assignerTask)
  push('route_attempts', issue.routeAttempts === undefined ? undefined : String(issue.routeAttempts))
  push('route_error', issue.routeError)
  if (issue.assignerMeta !== undefined) {
    // title and detail also live inside the meta and were printed above; emitting them
    // twice can duplicate a multi-thousand-character body.
    const { title: _dupeTitle, detail: _dupeDetail, ...rest } = issue.assignerMeta
    void _dupeTitle
    void _dupeDetail
    if (Object.keys(rest).length > 0) {
      lines.push('<assigner_meta>')
      lines.push(escapeXml(JSON.stringify(rest)))
      lines.push('</assigner_meta>')
    }
  }

  // Paths only: a body can be several megabytes, and the subagent can read the file.
  const attachments = extras.attachments ?? []
  if (attachments.length > 0) {
    const first = attachments[0]
    const dir = first === undefined ? undefined : dirnameOf(first.path)
    lines.push(dir === undefined
      ? `<input_attachments count="${attachments.length}">`
      : `<input_attachments count="${attachments.length}" dir="${escapeXmlAttr(dir)}">`)
    attachments.forEach((attachment, index) => {
      const attrs = [
        `index="${index + 1}"`,
        `name="${escapeXmlAttr(attachment.name)}"`,
        `path="${escapeXmlAttr(attachment.path)}"`,
      ].join(' ')
      const body = attachment.description === undefined || attachment.description === ''
        ? ''
        : escapeXml(attachment.description)
      lines.push(`  <input_attachment ${attrs}>${body}</input_attachment>`)
    })
    lines.push('</input_attachments>')
  }

  // Dropping these would produce a task missing requirements added in discussion.
  const comments = extras.comments ?? []
  if (comments.length > 0) {
    lines.push(`<comments count="${comments.length}">`)
    for (const comment of comments) {
      const at = comment.at === undefined || comment.at === '' ? '' : ` at="${escapeXmlAttr(comment.at)}"`
      lines.push(`  <comment by="${escapeXmlAttr(comment.author)}"${at}>${escapeXml(comment.content)}</comment>`)
    }
    lines.push('</comments>')
  }

  const catalog = extras.workspacesCatalog
  if (catalog !== undefined) {
    lines.push('<workspaces_catalog>')
    lines.push('当前实例的所有工作区信息如下：')
    lines.push(`workspace 清单索引文件：${catalog.indexFile}`)
    lines.push('  一览表（workspaceId / 标题 / cwd 绝对路径 / 一句话职责）+ 每个项目一段')
    lines.push('  （workspaceId / cwd 绝对路径 / 能做什么 / 关键词 / 适合接的活 / 不适合）。')
    lines.push('  **先读它**：索引写得足够可判别，通常只看这份索引就能定下这条 issue 的 cwd。')
    lines.push(`workspace 肖像目录：${catalog.portraitDir}（每个项目一份画像 \`<workspaceId>.md\`：能做什么、边界在哪、模块入口）`)
    lines.push('  只在「索引里有两个项目都像」时才需要翻肖像。')
    lines.push('  **采用哪个项目，就把它的 cwd 原样（逐字）填进 castboard_issue_task** —— 不要改写、不要拼相对路径。')
    lines.push('</workspaces_catalog>')
  }

  lines.push('</castboard_issue_references>')
  return lines.join('\n')
}

