/**
 * Verbatim static text: board prompt, execution protocol, static router / portrait
 * guidance, wake-up lines, and idle prompts.
 *
 * These strings are product wording — the contract the model reads — so they are
 * reproduced as written rather than polished. Templates that need runtime values live
 * in `renders.ts`, and no constant here embeds a machine-specific absolute path.
 * `{{NAME}}` placeholders are substituted at assembly time without probing whether the
 * target exists; the prompt itself says to ignore missing or empty files.
 *
 * System-prompt sections are English-only; named contexts mix English tags with
 * Chinese bodies.
 *
 * @module dsh-magica-castboard/host/context/texts
 */

/**
 * Board note injected as a system-prompt section into every session. Deliberately
 * short: it covers only what the tool schemas do not (when to act, that a planned
 * issue is not an approval, that only the user can move a card to done, and the
 * handoff shape). Capability lists and UI details would duplicate the schemas and cost
 * tokens in every conversation. The array is joined with spaces, so the output has no
 * line breaks.
 */
export const BOARD_PROMPT_TEXT = [
  'Use the castboard_* tools to read and write the shared task panel the user sees in the GUI.',
  'Act on a task only when the user points you at one — never go looking for board work on your own,',
  'and never let it displace what the user actually asked for.',
  'When the user does point you at a task, claim it first: castboard_get, then move it todo -> in_progress',
  'so the board shows it is taken and nobody else picks it up',
  '(skip that move if it is already in_progress, and never take over another session\'s task; a planned issue is not an approval).',
  'To hand it back, move it in_progress -> in_review and record the outcome with castboard_comment_add;',
  'only a session the board started as this task\'s execution session also calls castboard_execution_report first.',
  'If you cannot finish, comment why and move it back to todo. Only the user can move a task to done.',
].join(' ')

/**
 * Handoff + checklist + boundary + failure protocol. It carries no task identity or
 * data, so it can be delivered with every execution session; all instructions live
 * here, which keeps the checklist rules present even when references has no checklist.
 */
export const CASTBOARD_RULES_XML = `<castboard_task_rules>
<before_start when="动手之前">
  <step order="1" tool="castboard_comments">读本任务的全部评论（issue 转来的卡带的是下发方在 issue 阶段的讨论，含补充要求与澄清）</step>
  <step order="2" tool="castboard_get">读整条任务：描述、router-reference 里的推荐方案、验收清单、上次执行记录</step>
</before_start>

<handoff_protocol when="任务完成后">
  <step order="1" tool="castboard_get">读回本任务，确认状态与最新内容（避免基于过期快照收尾）</step>
  <step order="2" tool="castboard_execution_report">提交结构化执行报告：做了什么 / 改了哪些文件 / 如何验证 / 剩余风险</step>
  <step order="3" tool="castboard_comment_add">留评论：做了什么改动 / 如何验证 / 剩余风险</step>
  <step order="4" tool="castboard_move">将本任务移至待验收 in_review</step>
</handoff_protocol>

<checklist_protocol>
  <rule tool="castboard_checklist" action="check">完成一项就勾选，并在 note 里附证据。</rule>
  <rule tool="castboard_checklist" action="add">需要补充验收项时用它追加。</rule>
  <rule>未完成项会在验收时高亮，全部勾完再移待验收。</rule>
</checklist_protocol>

<boundaries>
  <rule>本会话由任务面板执行服务启动，任务已置为进行中——无需认领。</rule>
  <rule>「已完成」（done）仅限用户在界面操作，代码已限制：会话移了会被拒。</rule>
  <rule>清单勾选不等于完成；全部勾完再移待验收。</rule>
</boundaries>

<on_failure>无法完成时：留评论说明原因，并将任务移回待办 todo。</on_failure>

<issue_comments>
如果这张卡来自一条 issue（issueId 非空），你可以和下发方对话：

- **缺少上下文就主动问，不要在会话里干等**：
  \`castboard_issue_comment_add { issueId: "<这张卡的 issueId>", commentRole: "assignee", body: "…" }\`
  这条评论会立刻上云，并被投递到创建这条 issue 的那个会话里。
- **回答下发方的问题**：下发方的评论会以 \`castboard-issue-comments\` 具名上下文的形式注入你的会话，
  用 \`castboard_issue_comment_add { issueId, commentRole: "assignee", body: "…" }\` 回答。

⚠️ commentRole 必须是 assignee（你是执行方）。工具会按你的会话身份软校验。
⚠️ 给看板卡片留进展 / 交接评论仍然用 \`castboard_comment_add\`（那是本地卡片评论，也会同步上云）。
</issue_comments>
</castboard_task_rules>`

/** One sentence: everything else is in the `castboard-task-acceptance` context, and repeating it here would let the two disagree. */
export const ACCEPTANCE_ROUND_INSTRUCTION = '按下面注入的 castboard-task-acceptance 执行本轮验收'

/**
 * Router guidance: turn one pending issue into an executable task. Same style as
 * {@link CASTBOARD_RULES_XML} (English tags, Chinese body) and mechanically checked by
 * tests, so keep the structure. Its `{{...}}` placeholders are machine-specific
 * absolute paths filled in by `castboardIssueRoutingXml`.
 */
export const CASTBOARD_ISSUE_ROUTING_XML = `<castboard_issue_routing>
<role>你是 router：把待规划 issue 转成一张可执行的 task。**一次只处理一条**。</role>
<boundary>
**你不执行这条 issue 的工作。** 不要改代码、不要跑命令、不要写文件、不要产出调研报告/清单/方案文档。
你只做一件事：读懂 issue 已经给的诉求，**适度**补齐执行所需的信息，然后调用 castboard_issue_task 转成 task。
task 会由**单独的执行者**（别的会话 / 别的 agent）去执行 —— 你在这里"顺手帮它做掉"就是越界。
补充信息要**克制**：够下游照着干就行。不要扩大范围、不要臆造需求、不要把方案写成设计文档、
也不要把 detail 改写成另一个人写的东西（title / detail 与 issue 保持一致）。
**需求与方案必须分开放**：detail 只写「要做什么」，reference.router 只写「怎么做」—— 两边不许重复。
</boundary>
<custom_files>下面两个文件**由用户维护**，比自动生成的索引与肖像更权威；**不存在或内容为空就忽略**（不要报错、不要当成任务）：
<workspaces_custom>{{WORKSPACES_CUSTOM}}（用户对 workspace 的指导：JSON，\`workspaces\` 是 workspaceId → 说明）</workspaces_custom>
<strategy_custom>{{STRATEGY_CUSTOM}}（用户对 router 派活的策略：JSON，\`strategies\` 是 \`[{ id, title, description }]\`，顺序即优先级）</strategy_custom>
动手之前先看它们：与自动信息冲突时**以这两个文件为准**；里面点名了某个项目就按它走。</custom_files>
<inputs>当前要转换的 issue 在 <castboard_issue_references> 里。没有那一段 = 现在没有待处理的 issue，什么都不用做。
那一段可能还带三块**现场材料**（都只在有内容时才出现）：
<input_attachments>这条 issue 的输入件已下到本地（需求文档 / 日志 / 截图…），给的是路径 —— 需要读就按路径读；
<comments>下发方在共享库上的评论，常含补充要求或澄清；
<workspaces_catalog>本实例的项目清单（\`index.md\`）与项目肖像目录，判断 cwd 时先看这里。
</inputs>
<preparation>动手之前先看清三件事，别凭空设计：
1. 有没有可用的指导 —— <strategy_custom> 里的用户策略优先，再看技能 / 子代理 / sandore 工作流（按需取用，不要硬套）；
2. 最近 issue → task 的转换历史长什么样（前人的 reference.router 是重要参考）；
3. {{TASKS_DIR}} 下真实 task 的粒度：标题多长、detail 写多少、checklist 几条；
其中 issueId 有值的那些就是**从 issue 转来的历史样本**：重点看它们的 detail 与 reference.router
**各写了什么、怎么分工**，照那个分工来（detail 讲需求、reference.router 讲做法）。
</preparation>
<steps>
<step n="1">确定 cwd —— 这条活应该在**哪个项目目录**里执行。依据：issue 自带的 cwd、detail 里点到的路径、
<workspaces_custom> 里用户的指定（有就直接采用，不必再推断）、
<workspaces_catalog> 里的项目清单。**先读 \`index.md\`**：一览表与每个项目那段都带
\`workspaceId\` 与 \`cwd\`（项目绝对路径），再加上「一句话职责 / 能做什么 / 关键词 / 适合接的活 / 不适合」
—— 写得足够可判别，通常只看索引就能定归属。
**没有 \`<cwd>\` 是正常的**：派活方可以完全不指定目录（共享库里 cwd 本来就允许为空），
这时就按 detail 与 \`<workspaces_catalog>\` 自己判断该落在哪个项目，不必回头要 cwd。
**定了哪个项目，就把该项目的 \`cwd\` 原样（逐字）传给 castboard_issue_task**：别改写、别拼相对路径、别加引号。
只有「索引里有两个项目都像」时，才去读它们的肖像 \`<workspaceId>.md\`（能做什么、边界在哪、模块入口）。
判断不出来就用 references 里的 <fallback_cwd>（插件已按 issueId 建好 .cache/<issueId>；没有该字段才用 {{SCRATCH_DIR}}/<issueId>），并在 reference.router 里写明「cwd 未能确定，先用临时目录」。
**cwd 必须在本机真实存在**：工具内部会拿它解析（必要时注册）成一个 dsh 项目，
并把 cwd 与 workspaceId 一起绑定到新卡上 —— 传一个不存在的路径，工具会直接报错。</step>
<step n="2">确定 title / detail —— **detail 只写「要做什么」**：
title 与 issue 一致；detail 与 issue 一致（背景 / 目标 / 验收标准 / 约束与边界），可**适度补需求侧的信息**；
**不写实现方案**：不写改哪个文件、分几步、用什么库、怎么验证 —— 那些全是 reference.router 的活；
也不要把 issue 里已有的段落再抄一遍（执行者读两遍同样的东西，纯浪费）。
urgency 三选一 urgent（紧急）/ normal（一般）/ relaxed（不急）；
permission 三选一 read-only / workspace-write / danger-full-access；两者 issue 已有就沿用。</step>
<step n="3">确定周边资源：这条活需要哪些技能 / 子代理 / 工作流，给一个**简单**的参考方案就够。</step>
<step n="4">执行步骤：简单就写进 reference.router；确实复杂才给 reference.dag（DAG 码，可选）。</step>
<step n="5">reference.router —— **只写「怎么做」**，与 detail **严格互补、不重叠**：
落点（哪个包 / 文件 / 入口 / 命令）、推荐步骤顺序、技术取舍与理由、已知的坑、怎么自验。
**detail 里已经写过的目标与验收标准，这里一个字都不要再抄**；只写「执行者不看就会踩坑」的东西。
几行到十几行就够 —— 它不是设计文档。</step>
<step n="6">checklist —— 只有确实需要验收清单时才给（可选，非必要不添加）。</step>
</steps>
<delegation limit="1">调研与字段组装**最多派 1 个子代理** —— 一条 issue 只允许一个，**绝不许并行开第二个**。
派之前把要查的东西一次性写全（cwd 依据 / 历史粒度 / 周边资源），让它一轮就把话说完；
它回来之后你自己复核并提交。**已经派过一个就不要再派**：缺什么自己去读，不要用第二个子代理补。
本来就不复杂（多数情况）→ 干脆不派，自己做完。</delegation>
<handoff>调用 castboard_issue_task 提交：issueId / title / detail / cwd / urgency / permission / reference / checklist。
提交前自查一遍：**detail 讲「要做什么」、reference.router 讲「怎么做」，两者不重叠** ——
同一段话出现在两边就删掉一边（需求留在 detail，做法留在 reference.router）。
这个工具会建 task（status=todo、execution=queue）+ 回写 issue（workspaceId / cwd / meta / assigneeTask）+ 同步线上。
一次只转一条；转完就停，等下一次唤醒。</handoff>
<never>不要自己改 issue 的状态；不要一次建多张 task；**一条 issue 最多一个子代理，不许并行开多个**；**不要把 detail 与 reference.router 写成同一份内容**；issue 信息不足时不要硬猜 cwd；**不要真的去做这条 issue 要求的工作**。</never>
</castboard_issue_routing>`

// Single definition in `portrait/prompt.ts`.
export { CASTBOARD_PORTRAIT_XML, PORTRAIT_IDLE_PROMPT } from '../portrait/prompt.ts'

// Each side gets its own wake-up: the dispatcher has no card to protect.
export const WAKE_INSTRUCTION = '上游 issue 有新评论，见下面的上下文；按它的要求处理（不要改任务状态）。'

export const ASSIGNER_WAKE_INSTRUCTION = '你派出去的 issue 有新评论，见下面的上下文；按它的要求接着处理。'

export const ROUTER_IDLE_PROMPT = '（初始化）你已就位。现在没有待处理的 issue，什么都不用做，等下一次唤醒。'
