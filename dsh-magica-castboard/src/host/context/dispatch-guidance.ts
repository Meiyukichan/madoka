/**
 * Guidance for splitting work into issues and dispatching it.
 *
 * It is injected on demand rather than kept in every session: only a session that is
 * already working and finds more work to hand off needs it. `castboard_issues_help`
 * schedules the body into the next step through the normal named-context mechanism.
 *
 * `{{INSTANCE}}` is substituted at render time because the body must identify this
 * machine: that is how the model tells a local issue (`source = self`) from a remote
 * one (`source = dsh`), and only the assembly layer knows the instance.
 *
 * The body is a stable contract. Paragraph order and tags drive the GUI context rows
 * and how the model reads the text, so editing it edits product behavior.
 *
 * @module dsh-magica-castboard/host/context/dispatch-guidance
 */
import { DISPATCH_GUIDANCE_SECTION } from './sections.ts'

const GUIDANCE_XML = `<castboard_issue_creation_guidance>
<role>你正在执行一个任务，做完（或做到一半）发现**还有别的活要交给别人**：可能是本实例的
另一个会话，也可能是别人的 dsh 实例。把这些活**拆成 issue 分发出去**，用 castboard_issues_create 上库。
issue 是「派给某人/某实例去处理」的工单，不是本任务的一部分 —— 你别自己去做它。</role>
<fields>**每条 issue 需要 5 个必填字段**（字段名就是工具 schema 里的驼峰名），其余全部可选、
由工具自动补默认值：
<projectId>**必填**。目标项目 id，来自第 1 步 \`castboard_issue_groups\` 返回的数字 id。</projectId>
<title>**必填**。一句话标题，1..200 字符。</title>
<detail>**必填**。完整诉求：要做什么、验收标准是什么。</detail>
<assignerMeta>**可选**。附加诉求元数据，工具会连同 title / detail 一起落库。支持以下三个**规划字段**，都在真正转卡时继承：
- \`cron\`：**只给定时任务填**，五段式 cron（分 时 日 月 周），例如 \`0 9 * * 1-5\`。**非定时任务不要填**；不填就是 queue。填了非法 cron 会被丢弃。
- \`checklist\`：需要验收检查项时填，直接传**字符串数组**，例如 \`["页面可打开","接口返回 200"]\`。转成 task 时会生成 \`{id,text,checked:false}\` 检查项；检查项为空或不是字符串数组时整个字段丢弃。
- \`acceptanceStrategies\`：只有需要自动验收时填，传完整对象数组（最多 10 条）：
<acceptanceStrategies_schema>
{ id?: string, title: string, type: "issue" | "close", description: string }
</acceptanceStrategies_schema>
id 可省略（自动生成）；title 1..80 字符；description 1..4000 字符，写验收判定标准。
\`close\`：验收通过后直接进入 \`done\`；\`issue\`：验收结论转为新的待规划 issue。
不确定是否需要自动验收时，整个字段不要填。
其他元数据（如 reference）仍可放在 assignerMeta；兼容旧格式：顶层 title / detail 缺失时，会从 assignerMeta.title / assignerMeta.detail 兜底。</assignerMeta>
<assignee>**必填**。责任人账号（**一个 issue 一个人**），来自 castboard_issue_group_members 的结果。</assignee>
<assigneeInstance>**必填**。对端实例 ip:port，来自 castboard_issue_workspaces（type="index"）的结果。
本机实例是 {{INSTANCE}}；source 默认统一记成 dsh，不再按本机/跨实例区分。</assigneeInstance>
<cwd>**可选** —— 这条活应该在**对端机器**上的哪个项目目录里做（绝对路径，≤500 字符）。
**用户不想指定、或索引里看不出该用哪个目录时，就整项不传**（共享库创建 issue 时 \`cwd\` 本来就可空，
「不需要 cwd」是完全合法的一步，不要为了凑字段编一个目录）。
要传就必须来自 castboard_issue_workspaces 的真实结果（type="index" 的索引或 type="portal" 的肖像），不要凭印象拼。</cwd>
<urgency>可选：runtime | direct | urgent | normal | relaxed（不传 = normal）。</urgency>
<permission>可选：read-only | workspace-write（默认） | danger-full-access。</permission>
<source>**可选**。默认 \`dsh\`。显式传值时，必须已经存在于 \`dsh_teamwork_issue_source\` 字典；
不存在的 code 会直接报错，不会自动注册。</source>
<attachments>可选：交给对方的**输入件**（产物 / 日志 / 规格 / 样例数据）的绝对路径数组，
来自 ask_user_question 的多选（提交前那一节）；没有材料就不传。</attachments>
<dependsOn>可选：本条 issue 依赖的**其他 issue** 的数组（字符串 list）。每一项只能是两种之一：
① **本批某条 issue 的 \`ref\`**（短别名，如 \`["evt-b"]\`）—— 同批创建时用这种，因为 issueId 是工具现铸的，
你事先拿不到；② **库里已有 issue 的真实 issueId**（标准 UUID，通常是别人给你的）。
语义：\`dependsOn\` 里的 issue **必须全部 success**，本条 issue 才能进入规划（router 会话）；
只要有一个没成功，本条就停在待规划列不动，直到依赖跑完（不会标失败、不会退回）。
**一次创建多个 issue 时，先判断它们之间有没有先后依赖**：有依赖的，给**被依赖方**起一个 \`ref\`，
把那个 \`ref\` 填进**依赖方**的 \`dependsOn\`；工具铸完 id 会自动把 ref 翻译成真 issueId。
**你永远不要自己写 issueId、也不要自己编 UUID**（\`issueId\` 不是你能传的字段，传了整批会被参数校验拒掉）。
彼此独立就**不要填**（空数组等于没依赖）。依赖方一定会在被依赖方之后才被规划；
**不许让一条 issue 依赖它自己，也不许让同批两条互相依赖**（成环 = 两边都永远进不了规划，工具会直接拒）。</dependsOn>
</fields>
<tools>
<tool name="castboard_issues_help">本文件（指导）。**调用 castboard_issues_create 之前必须先调它**。</tool>
<tool name="castboard_issue_groups">用户所在的群组/项目列表（无参数）。第 1 步用它确定目标项目组。</tool>
<tool name="castboard_issue_group_members">某个项目下的成员（参数 projectId），**已按派活权限过滤**：
你是这个项目的 owner / creator / manager → 返回全部成员；否则**只返回你自己**（\`restricted: true\`），
说明你只能把活派给你自己的多实例。第 2 步用它确定责任人。</tool>
<tool name="castboard_issue_devices">某个账号名下的**在线设备（= 可派活的实例）**（参数 userId）：
每台一行 \`host\` + \`port\`，实例 id 就是 \`host:port\`。**实例清单只认它**（设备台账），
第 3 步用它拿候选实例 —— 不要拿工作区索引凑（那只覆盖上报过索引的机器）。</tool>
<tool name="castboard_issue_workspaces">工作区（**同一个接口的两种视图，用 \`type\` 选**）：
**\`type="index"\`** = 项目索引（\`index.md\`），第 4 步用它：传 \`userId\` + \`instance\`（第 3 步选定的那台）
→ 拿到**那一台机器**的索引，用来挑 cwd。**没有 instance 就不许拿它挑 cwd**（那是这个人所有机器混在一起的索引）。
**\`type="portal"\`** = 某个工作区的肖像详情（参数 \`instance\` + \`workspaceId\`），索引里看不出该用哪个目录时才用它。</tool>
<tool name="castboard_issue_state">查一条 issue 的现状（参数 issueId）：记录 + 评论 + 已交出来的产物
（产物会下到本地临时目录并给路径）。想知道「对方做到哪了 / 交了什么」时用它。</tool>
<tool name="castboard_issues_create">真正建 issue：参数是 issues 数组（每项 = 5 个必填字段 + 可选 assignerMeta / cwd / urgency /
permission / attachments / ref / dependsOn），外加可选的 taskId。建完会把 issue id 记到那张任务的
derivedIssues 里；回执里每条都带 issueId / source / urgency / permission / dependsOn（有依赖时会看到翻译后的
真实 issueId，可以拿它自查 ref 有没有解析对）。</tool>
</tools>
<order>**严格按下面 1→5 的顺序走，一步都不许跳、不许乱序、不许合并**。
每一步都标了 \`requires\`（必须先拿到什么）与 \`produces\`（这一步定出什么）：
**没拿到 \`requires\` 里的东西，就不许开始这一步；没产出 \`produces\`，就不许进下一步。**
四条硬禁止：
① **不许把不同步骤的 ask_user_question 合并成一个问题**（项目组 / 责任人 / 实例 / cwd 是四次不同的询问，但每一步都可能免问）；
② **该问就问，能免则免**：用户本轮已经明确给出该字段的值 → 直接用；工具只返回一个可行候选 → 直接用；
只有 **2 个及以上可行选项** 时才用 ask_user_question。单候选不是「替用户决定」，是唯一解；
③ **不许用「猜一个合理的值」代替工具结果或用户选择**（项目组 / 账号 / ip:port / cwd / 附件路径都一样）；
④ **不许先调 castboard_issues_create 再补信息**（建之前必须 5 步全走完）。
中途缺信息时，先看是不是只有一个候选或用户已明确指定；两者都不是才停下来问用户，不要用默认值蒙过去。</order>
<given>**免问来源（只认字面，不认推测）**：
- 用户本轮在请求里**明确指定**的字段（例如直接说了项目、责任人、实例或 cwd）；
- 上游 \`<castboard_task_dispatch>\` 的 \`<target project="…" assignee="…" [instance="…"]/>\` 里**出现**的字段；
- 工具结果里**只有一个**可行候选的字段。

以上字段直接采用，不再询问。但**核对照做**：仍要用 \`castboard_issue_groups\` / \`castboard_issue_group_members\` / \`castboard_issue_workspaces\`
（\`type="index"\`）验证它真实存在，查不到就停下来报错，不许改成猜。
「看起来像一个」不算唯一候选，必须以工具返回列表长度为 1 为准；\`restricted: true\` 只说明你只能派给自己，不构成免问。
target 里**没出现**、用户也没明确指定的字段，按对应步骤的规则处理。</given>
<prepare>**动工具之前先想清楚**（不占步骤号，只整理、不调创建工具）：
先确定**到底要分发几条 issue**：一条 issue = 一个独立交付物，一个人拿到它就能做完、能验收。
如果一件事需要两个人并行做，就拆成两条 issue，并在 title / detail 里各自写清范围（谁改哪一块）。
**然后想清楚它们之间有没有先后依赖**：B 必须等 A 做完才能开始时，就是有依赖 ——
给 A 起一个短别名（\`ref\`，如 "evt-a"），把 A 的 ref 填进 B 的 \`dependsOn\`（如 ["evt-a"]）。
彼此独立的就都别填 dependsOn。有依赖时被依赖方的 issueId 会由工具现铸，所以你**只能用 ref 引用**，
不要自己编 issueId。
最后按 \`<fields>\` 的字段清单（5 个必填 + 若干可选），为每条 issue 排好内容
（title + detail 一定要写清楚：做什么、验收标准是什么）。
</prepare>
<steps>
<step n="1" title="确定目标项目组" requires="无（入口）" produces="projectId">
**先调工具**：\`castboard_issue_groups\`（无参数）拿用户所在的群组/项目列表。
拿到列表之后再决定要不要问：**只有 1 个项目就直接用，不必问**；用户本轮已明确指定项目也直接用；
**只有 2 个及以上才用 \`ask_user_question\` 让用户选**，不要自己替用户挑。
问题怎么问：一个问题选一个项目，选项写「项目名（id=…）」，让用户看到就明白选哪个。
选定后把 projectId 记下来 —— 第 2 步的成员查询**只能**用它。
</step>
<step n="2" title="确定每条 issue 的责任人（项目成员）" requires="第 1 步的 projectId" produces="每条 issue 的 assignee（账号）">
**先调工具**：\`castboard_issue_group_members\`（参数 projectId = 上一步选的项目）拿**可分发**成员列表。
拿到成员之后：**只有 1 个可行成员就直接用，不必问**；用户本轮已明确指定责任人（账号或姓名）也直接用；
**只有 2 个及以上才用 \`ask_user_question\`**：**有 N 条 issue 就提 N 个问题**，一个问题只问一条 issue 的责任人。
**选项必须写「姓名 + 账号」**（成员的 \`displayName\` + \`userId\`，例如「冉汆 r30038105」）；
\`displayName\` 为空就只写账号。不要只写账号 —— 用户按名字认人。
每个问题里带上这条 issue 的 title，用户才知道在给哪一条选人。可以都选同一个人。
**注意权限**：结果**已按派活权限过滤** —— 若返回 \`restricted: true\`（只有你自己），说明你不是这个项目的
owner / creator / manager，**只能派给你自己的多实例**，不要试图填别人的账号。
</step>
<step n="3" title="查询该成员有哪些实例" requires="第 2 步每条 issue 的 assignee 账号" produces="每条 issue 的 assigneeInstance（ip:port）">
**先调工具**：\`castboard_issue_devices\`（参数 userId = 该条 issue 的责任人账号）拿这个人的**在线设备（= 实例）**：
每台一行 \`host\` + \`port\`，实例 id 就是 \`host:port\`（\`port\` 为 0 时只有 host）。
**实例清单只来自设备台账**（\`/api/internal/devices\`），不要用工作区索引去凑 —— 那是下一步的事，
而且只覆盖「恰好上报过索引」的机器，刚装好的机器会漏。
拿到实例之后：**只有 1 台在线设备就直接用，不必问**；用户本轮已明确指定实例也直接用；
**只有 2 台及以上才用 \`ask_user_question\`**：每条 issue 各问一次「这条活落到哪台实例」。
**选项必须写「账号 + ip:port」**（例如「r30038105 10.117.145.73:3080」）。
**多条 issue 的实例可以不同**（同一个人的两台机器、或不同的人），所以**逐条问、不要合并成一个问题**。
**这一步只定实例，不要定 cwd** —— 目录信息在下一步按「这台实例」去查。
</step>
<step n="4" title="查询这台实例的 Index（必要时深入 detail）" requires="第 3 步每条 issue 的 assigneeInstance" produces="这台机器上的候选 cwd 列表">
**先调工具，且必须带齐两个参数**：\`castboard_issue_workspaces\`（\`type="index"\`，\`userId\` = 这条 issue 的责任人账号，
\`instance\` = 第 3 步给它选定的那台 \`ip:port\`）—— 这样拿到的才是**那一台机器**的项目索引指导。
**顺序不许倒**：没有 \`instance\` 就去查 index 是错的（拿回来的是这个人所有机器的索引，用户没法按机器选目录）。
读 \`detail\`（\`index.md\`：每个项目一段，带 \`workspaceId\` / \`cwd\` / 职责 / 关键词 / 适合接的活），列出这台机器上可用的目录。
**只有索引看不出该用哪个目录时**，才用同一个工具的另一个视图深入：\`castboard_issue_workspaces\`
（\`type="portal"\`，参数 \`instance\` + \`workspaceId\`）读那个工作区的肖像 —— 不要一上来就逐个翻肖像。
**这一步只读**：产出候选目录，cwd 还没定（下一步由用户选）。
</step>
<step n="5" title="确定每条 issue 的 cwd（可选）" requires="第 4 步这台实例的候选 cwd 列表" produces="每条 issue 的 cwd，或明确不传">
**先看用户是否已经明确指定 cwd**：指定了就直接用，不再问；**候选列表为空就整项不传，也不要问**。
有候选时：**必须用 \`ask_user_question\`**，每条 issue 各问一次「这条活在这台实例的哪个项目目录里做」，
**选项 = 第 4 步索引里列出的 cwd（写「项目名 + cwd 路径」）**，并且**必须额外加一个选项「不需要 cwd」**。
即使只有一个 cwd 候选，也仍然有「这个目录 / 不需要 cwd」两个选择，所以照问；
用户选「不需要 cwd」时整项不传。
**「不需要 cwd」是合法结果，不是失败**：用户选它（或索引里根本没有可用项目）→ 这条 issue **整项不传 \`cwd\`**，
交给对方自己判断目录。共享库创建 issue 时 \`cwd\` 本来就可空 —— **不许**为了「字段必填」编一个目录，
也**不许**把这个问题标成「必填 / 必须选一个路径」再问一遍。
**要传 cwd 就必须逐字来自工具结果**：绝对路径、≤500 字符、对端真实存在。不要自己拼、不要猜、不要写相对路径。
**assigneeInstance 用第 3 步选定的那台**：source 默认统一为 dsh，不再按本机/跨实例区分。
</step>
</steps>
<submit>**信息齐了以后，一次调用 \`castboard_issues_create\`**，把整批 issue 作为 \`issues\` 数组传进去（不要一条一条调）：
**提交前逐条自查**：必填 5 项 —— projectId（第 1 步）/ title / detail / assignee（第 2 步）/ assigneeInstance（第 3 步）；
可选项 —— cwd（第 5 步，**没有就整项不传**）/ urgency / permission / source（默认 dsh，必须已在
dsh_teamwork_issue_source 字典里）/ attachments（有输入件才传）。
**urgency / permission 按每条 issue 的实际情况定**：拿不准就用 \`normal\` + \`workspace-write\`；
只有确实紧急才用 urgent / direct，只有确实只需读才用 read-only。这两项**不需要问用户**，你直接判断。
**只有必填那 5 项缺了才需要回去补**；可选项「用户没选」是正常终态，不要因此卡住或编值。
**再确认一遍依赖**：有先后关系的，被依赖方带上 \`ref\`，依赖方的 \`dependsOn\` 里写那些 ref（或库里已有 issue 的真实 issueId）；
没有依赖就一条都别填。填错的 ref（既不是本批 ref 也不是 UUID）会让整批被拒 —— 这是故意的，
因为一个解析不了的依赖落库后永远查不到，等于静默失效。
**但 UUID 打错一位不会被拦**：形态合法就照发，规划侧查不到就当「没有依赖」静默放过 —— 所以 issueId
只能从工具结果（如 castboard_issue_state / 上一次建 issue 的回执）里**逐字复制**，绝不要手打或凭记忆写。
**有输入件就给 \`attachments\`**：对方接手需要的产物 / 日志 / 规格 / 样例数据的绝对路径数组（input 类型，跟着 issue 一起交过去）。
没有材料就不传（空数组等于没附件）。**别把本机的私密文件、凭据、临时垃圾往里塞。**
\`taskId\` 一般**不用传**：在任务会话里执行时，工具会自己从调用方会话认出你正在执行的那张卡，并把它写成 issue 的
\`assignerTask\`（上游血缘），同时把新 issue 的 id 追加到那张卡的 \`derivedIssues\` 里；只有在独立会话（没有 task）里
才需要你在参数里给出 taskId（拿不准就不要传，宁可没有血缘也不要编一个）。
提交后把结果如实汇报给用户：每条 issue 的 issueId / 责任人 / 实例 / cwd / 紧急度 / 附件数，以及失败原因（如有）。
</submit>
<rules>
**一条 issue 只有一个 assignee**：想两个人做，就拆成两条，各自写清范围，别让两人改同一处。
**能在本实例做完就不要分发**：分发是给「本机做不了 / 该别人做 / 该别的实例做」的活，不是把活推出去。
**不许臆造**：项目名、成员账号、实例 ip:port、cwd、附件路径，都必须来自工具结果或用户的选择；
工具里查不到就问用户，宁可多问一轮，也不要编一个看起来合理的值。
**没有管理权就只能派给自己**：成员列表被过滤成你自己（\`restricted: true\`）时，
\`assignee\` 只能填你自己，跨实例也只能落到你自己的实例上 —— 成员列表就是按这个权限过滤出来的，
别绕过去填别人的账号（工具侧不会替你拦，拦不拦得住取决于对端，别赌）。
**不要传多余字段**：issueId / assigner / status / sourceInstance / assignerTask 由工具填；
你只管 5 个必填（projectId / title / detail / assignee / assigneeInstance）+ 可选（assignerMeta / cwd / urgency / permission / source /
attachments / ref / dependsOn / taskId）。多传的**不会**被静默忽略 —— schema 是
\`additionalProperties: false\`，多一个字段整批都会被参数校验拒掉。
**cwd 是可选项，不是必填项**：用户选「不需要 cwd」就直接不传，别把可选项当成硬门槛去反复追问。
**依赖写清先后，别写成一锅**：只有「B 真的必须等 A 完成」时才填 dependsOn —— 依赖没满足时本条会一直
停在待规划列（不会标失败、不会退回），白等一轮。彼此能并行的就不要互相依赖，让它们同时开跑。
**不要重复建**：同一条活只建一次。提交失败时先看返回的原因（字段不合格 / 连接问题 / 字典缺 source），
改对了再重试 —— 每次调用都会新铸 issue id，无脑重发会产生重复 issue。
**如果回执里带了 \`created\`**（\`ok:false\` 但 \`created\` 非空 = 部分成功：issue 已经建好，只是后续某一步失败），
那些 id **不要再建一遍**，只补做失败的那一步。
**写明验收标准**：每条 issue 的 detail 至少包含「要做什么」和「怎么算做完」，否则对方没法判断什么时候能交。
</rules>

<comments>
建完 issue 之后，你仍然可以随时和执行方对话：

- **主动询问执行方**：\`castboard_issue_comment_add { issueId, commentRole: "assigner", body: "…" }\`
这条评论会立刻上云，并被投递到这条 issue 的执行会话里（执行方会看到你的问题）。
- **回答执行方的提问**：执行方缺上下文时，会用 \`commentRole: "assignee"\` 发评论问你。
那些评论会以 \`castboard-issue-comments\` 具名上下文的形式出现在你的会话里（不必轮询）。
用 \`castboard_issue_comment_add { issueId, commentRole: "assigner", body: "…" }\` 回答即可。
- **你答不了就往上问用户**：执行方问你的问题，你能答就直接答；**确实无法决策**（要用户拍板、
或你手上也没有依据）时，用 \`ask_user_question\` 问用户，拿到答复后再用 \`castboard_issue_comment_add\`
转给执行方 —— **不要自己编一个答案**，那会让执行方拿着假前提往下做。

⚠️ commentRole 必须是 assigner（你是下发方）。工具会按你的会话身份软校验，传错会被纠正并在回执里说明。

⚠️ **你要说的话（验收结论 / 追问 / 补充要求）一律走 \`castboard_issue_comment_add\`，不要用 \`castboard_comment_add\`。**
那个工具是**执行方给自己那张卡**写进展用的，两个理由：
① 它的 \`role\` 固定是 \`assignee\`（「执行方的进展」），而卡片评论的锚点就是这条 issue；
② 于是你写下的那句话会被判成「执行方说的」，交叉路由到**你自己**的会话 —— 表现为「我在卡片上写的验收结论，
以 issue 评论的形式回声给自己，执行方一个字都没收到」；要改卡片状态请用 \`castboard_move\`，要说话请用 issue 评论。
（2026-11-13 真机踩过一次，代价是一整轮验收结论没送出去。）
</comments>
</castboard_issue_creation_guidance>`

export interface DispatchGuidanceFacts {
  readonly instance: string
}

/** Renders the guidance for this machine. */
export function castboardIssueCreationGuidance(facts: DispatchGuidanceFacts): string {
  return GUIDANCE_XML.replaceAll('{{INSTANCE}}', facts.instance)
}

export { DISPATCH_GUIDANCE_SECTION }
