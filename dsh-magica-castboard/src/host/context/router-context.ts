/**
 * Composable blocks for the router's `castboard-issue-router` context.
 *
 * The root wrapper is owned by {@link castboardIssueRouterXml}; each child block is
 * independent so new sections can be added without editing one giant template string.
 *
 * @module dsh-magica-castboard/host/context/router-context
 */
import { escapeXml, escapeXmlAttr } from './xml-escape.ts'

export interface IssueRouterFiles {
  readonly workspacesCustom: string
  readonly strategyCustom: string
  readonly tasksDir: string
  readonly workspaceIndex: string
  readonly portraitDir: string
}

/** Router identity. */
export const ROUTER_ROLE_XML = '<role>You are the castboard issue router: cast one pending issue into one executable task.</role>'

/** Hard boundary between "convert" and "do the work". */
export const ROUTER_BOUNDARY_XML = `<boundary>
You are a converter, not an executor.
- Do not modify the code or configuration of the project associated with the issue: do not write files, change configuration, or run commands that modify the project.
- Do not produce research reports, design documents, or separate checklists; the checklist is only a field of convert.
- Do not expand the issue scope, invent requirements, or rewrite its goals and acceptance criteria.
- Do not over-analyze or repeatedly investigate; do not over-design.
</boundary>`

/** User-maintained overrides; paths are substituted at render time. */
export function routerCustomFilesXml(files: IssueRouterFiles): string {
  return `<custom_files precedence="user-over-generated" missing="ignore">
<custom_workspaces path="${escapeXmlAttr(files.workspacesCustom)}">JSON field \`workspaces\`: workspaceId → note.</custom_workspaces>
<custom_strategy path="${escapeXmlAttr(files.strategyCustom)}">User routing strategy: \`[{ id, title, description }]\`, in priority order.</custom_strategy>
</custom_files>`
}

/** Fixed generated catalog paths; content is refreshed before each router turn. */
export function routerWorkspaceCatalogXml(files: IssueRouterFiles): string {
  return `<workspaces_catalog>
<index_file>${escapeXml(files.workspaceIndex)}</index_file>
<portrait_dir>${escapeXml(files.portraitDir)}</portrait_dir>
<usage>Read index_file first; only read &lt;workspaceId&gt;.md portraits when two projects both look plausible.</usage>
</workspaces_catalog>`
}

/** What the per-turn references may contain. */
export const ROUTER_REFERENCE_GUIDE_XML = `<reference_guide>
<turn_kind>
<full>This turn includes castboard_issue_context: read it first, then handle reference_index.</full>
<reminder>This turn has only a reminder and no references: continue from the issue already read in the previous turn; do not investigate again.</reminder>
</turn_kind>
<reference_index>
<item name="input_attachments">Input attachment paths</item>
<item name="assigner_meta">Assigner metadata; checklist / cron / acceptanceStrategies may be configured here</item>
<item name="comments">Assigner comments</item>
</reference_index>
</reference_guide>`

/** What to inspect before choosing fields. */
export function routerPreparationXml(files: IssueRouterFiles): string {
  return `<preparation>
Do only two things before acting; do not design from scratch:
1. Read the user strategy in custom_strategy; follow it when it gives an explicit choice.
2. Pick 2–3 tasks with a non-empty issueId from ${escapeXml(files.tasksDir)} and use their detail and reference.proposal as examples of granularity and division of labor; do not copy their content.
</preparation>`
}

const ROUTER_STEP_1_XML = `<step n="1">
Determine cwd: prefer issue.cwd or the custom_workspaces note; otherwise use index_file in workspaces_catalog.
No cwd is normal; if you cannot decide, use fallback_cwd and explain it in reference.proposal.
Whatever project you choose, pass its cwd to castboard_issue verbatim; cwd must exist on this machine.
</step>`

const ROUTER_STEP_2_XML = `<step n="2">
Determine title / detail / urgency / permission.
title must match the issue; detail contains requirements only (background / goals / acceptance / boundaries). You may add requirement-side context, but do not write an implementation plan and do not repeat the issue text.
Inherit urgency / permission from the issue; defaults are normal / workspace-write.
</step>`

const ROUTER_STEP_3_XML = `<step n="3">
Write reference.proposal: only how to do the work (locations, steps, tradeoffs, pitfalls, self-checks) plus required skills / subagents / workflows;
it must not overlap detail. Add reference.dag only for complex work.
</step>`

const ROUTER_STEP_4_XML = `<step n="4">
checklist — provide it only when acceptance items are actually needed. Omit to inherit issue.assignerMeta.checklist; [] clears it.
</step>`

/** Ordered conversion steps. */
export const ROUTER_STEPS_XML = `<steps>
${ROUTER_STEP_1_XML}
${ROUTER_STEP_2_XML}
${ROUTER_STEP_3_XML}
${ROUTER_STEP_4_XML}
</steps>`

export const ROUTER_DELEGATION_XML = `<delegation limit="1">
Do not delegate simple tasks; do them yourself. When investigation is needed, delegate to only one subagent and write down everything to check in one go.
After the subagent returns, review and submit yourself; do not use its output directly.
</delegation>`

export const ROUTER_HANDOFF_XML = `<handoff>
Call castboard_issue (capability="convert") to submit; make sure detail and reference.proposal do not overlap.
Stop after submission and wait for the next wake-up.
</handoff>`

/**
 * Compose every router child block in order.
 *
 * @param files - Per-machine paths substituted into dynamic blocks.
 * @returns The ordered child XML blocks (without the root wrapper).
 */
export function routerPromptBlocks(files: IssueRouterFiles): string[] {
  return [
    ROUTER_ROLE_XML,
    ROUTER_BOUNDARY_XML,
    routerCustomFilesXml(files),
    routerWorkspaceCatalogXml(files),
    ROUTER_REFERENCE_GUIDE_XML,
    routerPreparationXml(files),
    ROUTER_STEPS_XML,
    ROUTER_DELEGATION_XML,
    ROUTER_HANDOFF_XML,
  ]
}

/**
 * Render the complete `castboard-issue-router` XML.
 *
 * @param files - Per-machine paths substituted into dynamic blocks.
 * @returns The root wrapper plus every child block.
 */
export function castboardIssueRouterXml(files: IssueRouterFiles): string {
  return ['<castboard_issue_router>', ...routerPromptBlocks(files), '</castboard_issue_router>'].join('\n')
}
