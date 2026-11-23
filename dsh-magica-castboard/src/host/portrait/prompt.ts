/**
 * Prompt material for project portraits: static rules delivered as a system-prompt
 * section, plus a per-round target (named context) and instruction (user message).
 *
 * The reader is the model, and its purpose is to let the router decide which workspace
 * an issue belongs in, so the text stays at "what this project can do / its boundaries
 * / keywords" — no code walkthrough, no change history.
 *
 * @module dsh-magica-castboard/host/portrait/prompt
 */

export const PORTRAIT_SECTION = 'castboard-project-portrait'

/** Tool guidance occupies 100–199; routing uses 150. */
export const PORTRAIT_ORDER = 160

/** Both files stay at or below this; the index must settle cwd at a glance. */
export const PORTRAIT_MAX_LINES = 1000

export const PORTRAIT_IDLE_PROMPT =
  '（初始化）你已就位。现在还没有待写肖像的项目，什么都不用做，等下一次唤醒。'

const MAX_LINES_TOKEN = '{{MAX_LINES}}'

// Blocks keep their own layout; newlines are the join character.
const RULE_BLOCKS: readonly string[] = [
  `<castboard_project_portrait>
<role>你是「项目肖像」写手：每轮只处理**一个项目**，产出两个文件 —— 该项目的肖像
\`<workspaceId>.md\`，以及增量更新目录索引 \`index.md\`。</role>`,
  `<purpose>
这份肖像是**给 router 用的指导文件**：router 手里有一条 issue，要靠它判断「这条活
该交给哪个工作区」。所以写的是**这个项目能做什么、边界在哪**，不是代码导读。
给一个没进过这个项目的人看，让他一眼能判断「这条活属于它吗」。
</purpose>`,
  `<index_goal>
index_file 是 router 的**第一判断依据**，目标是：**只看 index.md 就能定下约 80% 的 cwd**。
每个项目**必须**有两个关键字段，缺一条这个条目就是废的：
- \`workspaceId\`：项目的 dsh id，是 **UUID**（36 字符，\`8-4-4-4-12\`），不是 \`ws-xxx\` 这类自造名字；
- \`cwd\`：项目的**绝对路径**。router 会把 cwd **逐字**填进 task —— 写错一个字符，活就派到错的仓库，
或直接因为「路径不存在」被工具拒掉。
**这两个值只能「抄」**：来源是本轮输入（\`workspace_id\` / \`project_path\`）与上下文注入的
\`<castboard_portrait_target>\` —— 两处是同一份真值，**必须一致**。
禁止自造 id、禁止按项目名拼 id、禁止把路径换成相对路径或加引号/反引号/补斜杠、禁止任何「美化」。
拿不准就不写这一条（留「（待补）」），也不要编。
剩下的判据要写得**可判别**，而不是一句口号：
- 一览表的「一句话职责」：一句话说清「做什么 + 给谁用」，能据此排除掉一半项目；
- 本项目那一段：\`能做什么\` / \`关键词\` / \`适合接的活\` / \`不适合（容易误派的近似领域）\` 四条必须填满；
- \`关键词\` 写真实会出现在 issue 描述里的词（产品名、模块名、领域词），不是泛泛的「后端」「工具」。
判据要**互相区分**：相邻项目经常长得很像，正好在「不适合」里点明彼此的差别。
只有两个项目都符合时才需要再由 router 去读肖像 —— index.md 写得越可判别，这一步越少。
</index_goal>`,
  `<boundary>
**只读这一轮给的 project_path**：不要读别的项目、别的盘、别的仓库；不要顺着 import 跑到项目外面去。
**绝不修改那个项目**：不写文件、不改配置、不跑会落地更改的命令（构建 / 安装 / 迁移 / 提交都不行）。
唯一允许写入的是 output_file 与 index_file 这两个文件，其它一律不碰。
无人值守、不能向用户提问：判断不了的就不写，不要猜，不要留 TODO 占位。
</boundary>`,
  `<method>用子代理去读那个项目的代码与文档：README / docs / 清单文件（package.json、pyproject.toml、Cargo.toml 等）
/ 顶层目录 / 关键入口。子代理读，你负责归纳成摘要，写完自己复核一遍再落笔。</method>`,
  `<incremental>
**先看 output_file 是否已存在**（通常 \`workspaces/<workspaceId>.md\`）：
1. 存在 → **增量更新**：先把它读进来，在原有内容上增删改 —— 补上新增的功能，删掉已经不存在的，
顺手修正不准确的地方。**不要从头重写**（那既慢，又会丢掉之前已经核对过的结论）。
2. 不存在 → **新建**一份，按下面的结构写全。
index_file 同理：先读它，只改**属于你的那两处** ——
① \`## 一览\` 表格里本 workspace 那一行（没有就按列数加一行）；
② 下面 \`## <workspaceId>（标题）\` 那一段（没有就按同样的条目格式新建一段）。
别人的行与段落一个字符都不要动，不要重排表格、不要重写整份文件。
准确优先：改写是为了更准，不是为了更长。发现旧结论错了就直接改对。
</incremental>`,
  `<content>
<overview>一句话说清这个项目是干什么的</overview>
<capabilities>**这个项目提供哪些功能/能力**（要点列表，每条一行、动词开头）—— 这是 router 最需要的一节</capabilities>
<modules>主要模块与入口（5–15 条：目录/包 → 它负责什么）</modules>
<stack>语言 / 框架 / 主要依赖 / 构建与包管理方式</stack>
<workflow>怎么跑、怎么测、怎么构建（以仓库里真实存在的脚本为准，不要臆造命令）</workflow>
<boundaries>这个项目**不做什么**、以及容易被误派的近似领域（帮 router 排除）</boundaries>
<keywords>检索关键词：项目名、产品名、领域词（一行，逗号分隔）</keywords>
</content>`,
  `<format>
Markdown，**不超过 ${MAX_LINES_TOKEN} 行**（两个文件各自都不超过）。
不贴大段源码（最多引用几行）、不逐文件罗列、不写变更历史、不写「我读了…」这类过程叙述。
index.md 是**表格**：保持它现有的表头与列序，只补本行。
</format>`,
  '</castboard_project_portrait>',
]

/** Fills the line-cap placeholder; no literal cap is hard-coded in this file. */
export function castboardPortraitXml(maxLines: number = PORTRAIT_MAX_LINES): string {
  return RULE_BLOCKS.join('\n').replace(MAX_LINES_TOKEN, String(maxLines))
}

export const CASTBOARD_PORTRAIT_XML: string = castboardPortraitXml()

export interface PortraitTarget {
  /** workspace id (also decides the portrait file name). */
  readonly id: string
  /** The only path this round may read. */
  readonly path: string
  readonly title: string
  readonly outputFile: string
  readonly indexFile: string
  /** Drives the create-vs-update mode. */
  readonly portraitExists: boolean
}

/**
 * Section name for the per-round named context.
 *
 * The user message and this data carry the same truth, but IDs and paths are copied
 * from here: the structured form is not paraphrased as prose.
 */
export const PORTRAIT_TARGET_SECTION = 'castboard-project-portrait-target'

const TARGET_NOTE =
  '<note>下面这些值由宿主从 dsh 项目注册表里取出，是**唯一权威来源**：写进 index.md 时逐字照抄。</note>'

interface TargetXmlField {
  readonly tag: string
  readonly read: (target: PortraitTarget) => string
}

const TARGET_XML_FIELDS: readonly TargetXmlField[] = [
  { tag: 'workspace_id', read: target => target.id },
  { tag: 'cwd', read: target => target.path },
  { tag: 'title', read: target => target.title },
  { tag: 'output_file', read: target => target.outputFile },
  { tag: 'index_file', read: target => target.indexFile },
  { tag: 'mode', read: target => (target.portraitExists ? '增量更新' : '新建') },
]

function encodeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function portraitTargetXml(target: PortraitTarget): string {
  const fields = TARGET_XML_FIELDS.map(field => (
    `<${field.tag}>${encodeXmlText(field.read(target))}</${field.tag}>`
  ))
  return [
    '<castboard_portrait_target>',
    TARGET_NOTE,
    ...fields,
    '</castboard_portrait_target>',
  ].join('\n')
}

interface TargetFact {
  readonly token: string
  readonly read: (target: PortraitTarget) => string
}

const TARGET_FACTS: readonly TargetFact[] = [
  { token: 'project_path', read: target => target.path },
  { token: 'workspace_id', read: target => target.id },
  { token: 'title', read: target => (target.title === '' ? '（无标题）' : target.title) },
  { token: 'output_file', read: target => target.outputFile },
  { token: 'index_file', read: target => target.indexFile },
]

const MODE_NARRATIVES = {
  existing: '**增量更新**：{file} 已存在 —— 先读它，在原有内容上增删改（补新增、删过时、修正不准确），不要从头重写。',
  fresh: '**新建**：{file} 还不存在 —— 按 castboard-project-portrait 的结构写一份。',
} as const

const INSTRUCTION_INTRODUCTION =
  '请给下面这个项目写一份项目肖像，然后同步更新目录索引。用子代理去读它的代码与文档。'

const PORTRAIT_STEP_TEMPLATE = `1. 肖像：{mode}
   上限 {max_lines} 行；写「能做什么 / 模块入口 / 技术栈 / 怎么跑 / 不做什么 / 关键词」这类摘要，不写细枝末节。`

const INDEX_STEP_TEMPLATE = `2. 索引：读 {index_file}，先把「本项目」的条目写出来，再落到索引里：
   - 一览表里本 workspace 那一行（没有就按列数加一行）；
   - 以及 \`## <workspaceId>（标题）\` 那一段（没有就按同样的条目格式新建一段）；
   每个项目**必须**有的两个关键字段，**只能从下面这两个真值里抄**（同一个值也注在
   具名上下文 \`<castboard_portrait_target>\` 里，两处必须一致），**一个字符都不要改**
   （不自造 id、不加引号/反引号、不换相对路径、不补斜杠）：
   - workspaceId：{workspace_id}
   - cwd（绝对路径）：{project_path}
   router 会把 cwd 逐字填进 task，写错就等于把活派到错的仓库。
   剩下四条（\`能做什么\` / \`关键词\` / \`适合接的活\` / \`不适合（容易误派的近似领域）\`）都要填满 ——
   目标是**只看这份索引就能定下约 80% 的 issue 该给哪个项目**，所以「关键词」要写 issue 里真会出现的词，
   「不适合」要点明它与相邻项目（同类工具、同团队别的仓库）的区别。
   别人的行与段落一个字符都不要动；这个文件同样不超过 {max_lines} 行。`

const BOUNDARY_BLOCK = `边界（务必遵守）：
1. 只读 project_path 下面的内容，不要读别的项目、别的盘，也不要顺着 import 走出去；
2. 不要修改那个项目（不写、不改配置、不跑构建/安装/迁移/提交）；
3. 只有 output_file 与 index_file 两个文件可写，其它一律不碰；
4. 不能向用户提问：判断不了的就不写。`

const CLOSING_TEMPLATE = '做完回一句「已写入 {output_file}」就停，不要做别的事。'

function fillInstructionTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, token: string) => values[token] ?? placeholder)
}

function renderModeNarrative(target: PortraitTarget): string {
  const narrative = target.portraitExists ? MODE_NARRATIVES.existing : MODE_NARRATIVES.fresh
  return narrative.split('{file}').join(target.outputFile)
}

function instructionValues(target: PortraitTarget): Record<string, string> {
  const values: Record<string, string> = {
    mode: renderModeNarrative(target),
    max_lines: String(PORTRAIT_MAX_LINES),
  }
  for (const fact of TARGET_FACTS) values[fact.token] = fact.read(target)
  return values
}

function renderTargetFacts(target: PortraitTarget): string[] {
  return TARGET_FACTS.map(fact => `- ${fact.token}: ${fact.read(target)}`)
}

/**
 * This round's user message. Values are intentionally not XML-escaped: this is natural
 * language, not parsed markup, which is why the target block uses "key: value" lines.
 */
export function portraitInstruction(target: PortraitTarget): string {
  const values = instructionValues(target)
  return [
    INSTRUCTION_INTRODUCTION,
    '',
    '目标：',
    ...renderTargetFacts(target),
    '',
    '两件事，按顺序做：',
    fillInstructionTemplate(PORTRAIT_STEP_TEMPLATE, values),
    fillInstructionTemplate(INDEX_STEP_TEMPLATE, values),
    '',
    BOUNDARY_BLOCK,
    '',
    fillInstructionTemplate(CLOSING_TEMPLATE, values),
  ].join('\n')
}
