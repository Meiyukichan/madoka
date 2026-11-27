/**
 * Composable blocks for the issue delegation guidance.
 *
 * The root wrapper is owned by {@link castboardIssueDelegation}; each child block is
 * independent so sections and steps can be edited without touching one template.
 *
 * It is injected on demand rather than kept in every session: only a session that calls
 * `castboard_issue` help needs it. `castboard_issues_help` schedules the body into the
 * next step through the normal named-context mechanism.
 *
 * `facts.instance` is substituted at render time because the body must identify this
 * machine as the default assignment target; source defaults to `dsh`.
 *
 * @module dsh-magica-castboard/host/context/delegation-context
 */
import { ISSUE_DELEGATION_SECTION } from './sections.ts'
import { escapeXml } from './xml-escape.ts'

export interface IssueDelegationFacts {
  readonly instance: string
}

export const ISSUE_DELEGATION_PURPOSE_XML = '<purpose>This guide explains how to create and dispatch issues. An issue is not work for the current session, so do not do it yourself.</purpose>'

export function issueDelegationFieldMapXml(facts: IssueDelegationFacts): string {
  return `<field_map>
<required_fields>
<field name="projectId" from="step 1">Numeric project id returned by castboard_issue_groups.</field>
<field name="title" from="request">Short one-line title.</field>
<field name="detail" from="request">What to do and how it is accepted.</field>
<field name="assignee" from="step 2">Exactly one account returned by group_members.</field>
<field name="assigneeInstance" from="step 3">That assignee's online device, ip:port. This host is ${escapeXml(facts.instance)}.</field>
</required_fields>
<optional_fields>
<field name="cwd" from="step 5">Absolute project path on the target machine. Omit when the user chooses no cwd or there are no candidates; never invent one.</field>
<field name="assignerMeta" from="request">
<subfield name="cron">Only for scheduled work: five-field cron. Omit for queue work.</subfield>
<subfield name="checklist">Optional string array; converted to unchecked checklist items when the issue becomes a task.</subfield>
<subfield name="acceptanceStrategies">Optional array of { title, type: "issue" | "close", description } (max 10). The host mints ids from type + title; do not pass an id. close finishes as done; issue spawns a new planning issue.</subfield>
</field>
<field name="urgency" from="schema default">Use the default unless the request clearly needs otherwise; do not ask the user.</field>
<field name="permission" from="schema default">Use the default unless the request clearly needs otherwise; do not ask the user.</field>
<field name="source" from="schema default">Default: dsh. External sources must already be registered.</field>
<field name="attachments" from="user-picked input files">Absolute paths only. Omit when there are none; never add private files, credentials, or temporary junk.</field>
<field name="ref" from="this batch">Short alias used only when another issue in this batch depends on this one.</field>
<field name="dependsOn" from="this batch or existing issues">A batch ref or an existing issueId UUID. Omit when there is no dependency. Every dependency must reach success before this issue enters planning; self-dependencies and batch cycles are rejected; an unknown ref rejects the whole batch. Never invent a UUID, and copy an existing issue id from tool output: a malformed but valid-looking UUID is accepted and then treated as no dependency.</field>
</optional_fields>
<reserved>issueId, assigner, status, sourceInstance, and assignerTask are filled by the tool; do not pass them.</reserved>
</field_map>`
}


export const ISSUE_DELEGATION_SEQUENCE_XML = '<sequence>Run steps 1→5 in order. Do not start a step before its requires are available, and do not advance without its produces. Never call castboard_issue (capability="create") before all five required fields are resolved.</sequence>'

export const ISSUE_DELEGATION_DECISION_RULES_XML = `<decision_rules>
<rule>Use a value without asking when the user names it in this request.</rule>
<rule>Use a lookup result without asking only when the returned list has exactly one item. This applies to projects, assignees, and instances.</rule>
<rule>When a lookup returns more than one viable candidate, ask in step order, one decision at a time. Never combine dependent choices into one question.</rule>
<rule>cwd is the exception: even when there is one directory, ask the user to choose that directory or "no cwd".</rule>
<rule>Before treating a value as known, verify it exists with the corresponding castboard_teamwork lookup.</rule>
<rule>restricted: true means the member list was permission-filtered to yourself; assign the issue to yourself and do not try to use another account.</rule>
<rule>Fields not covered by these rules follow the step that produces them.</rule>
</decision_rules>`

export const ISSUE_DELEGATION_PREPARE_XML = '<prepare>Before calling tools, decide the batch. One issue is one independently deliverable result that one person can finish and verify. If two people must work in parallel, split it into two issues and state each scope in title and detail. Decide dependencies before creating: when B must wait for A, give A a ref and put that ref in B\'s dependsOn; otherwise omit it.</prepare>'

const DELEGATION_STEP_1_XML = `<step order="1" requires="request" produces="projectId">
Call castboard_teamwork (capability="groups"). Pick the target project.
</step>`

const DELEGATION_STEP_2_XML = `<step order="2" requires="projectId" produces="assignee">
Call castboard_teamwork (capability="group_members") with projectId. Pick exactly one assignee per issue.
</step>`

const DELEGATION_STEP_3_XML = `<step order="3" requires="assignee" produces="assigneeInstance">
Call castboard_teamwork (capability="devices") with the assignee account. Pick one online instance per issue.
</step>`

const DELEGATION_STEP_4_XML = `<step order="4" requires="assigneeInstance" produces="cwd candidates">
Call castboard_teamwork (capability="workspaces", type="index") with userId and instance. Read detail; use type="portal" only when the index cannot decide.
</step>`

const DELEGATION_STEP_5_XML = `<step order="5" requires="cwd candidates" produces="cwd or omit">
Use the user's cwd when given. Omit when there are no candidates. Otherwise ask per issue, including a "no cwd" option.
</step>`

export const ISSUE_DELEGATION_STEPS_XML = `<steps>
${DELEGATION_STEP_1_XML}
${DELEGATION_STEP_2_XML}
${DELEGATION_STEP_3_XML}
${DELEGATION_STEP_4_XML}
${DELEGATION_STEP_5_XML}
</steps>`

export const ISSUE_DELEGATION_SUBMIT_XML = '<submit>Submit the whole batch in one castboard_issue (capability="create") call; pass issues as an array, not one call per issue. Check every item against field_map before submitting. After the call, report each issue\'s id, assignee, instance, cwd, urgency, and attachment count, plus any rejection or failure reason.</submit>'

export const ISSUE_DELEGATION_DISPATCH_RULES_XML = `<dispatch_rules>
<rule>One issue has exactly one assignee. Split parallel work into separate issues.</rule>
<rule>Prefer doing the work locally; dispatch only work that belongs to another session or instance.</rule>
<rule>Never create the same issue twice. Fix validation errors before retrying; every create call mints new issue ids.</rule>
<rule>If the response returns created issues with ok:false, do not create them again; only complete the failed step.</rule>
<rule>Every detail must state what to do and how it will be accepted.</rule>
</dispatch_rules>`

export const ISSUE_DELEGATION_COMMUNICATION_XML = `<communication>
<rule>Talk to the assignee with castboard_comment (capability="add", role="assigner").</rule>
<rule>Assignee comments arrive as the castboard-issue-comments context; reply with the same tool.</rule>
<rule>If you cannot answer the assignee's question, ask the user with ask_user_question, then relay the answer; never invent one.</rule>
</communication>`

/** Ordered top-level context blocks. */
export function issueDelegationPromptBlocks(facts: IssueDelegationFacts): string[] {
  return [
    ISSUE_DELEGATION_PURPOSE_XML,
    issueDelegationFieldMapXml(facts),
    ISSUE_DELEGATION_SEQUENCE_XML,
    ISSUE_DELEGATION_DECISION_RULES_XML,
    ISSUE_DELEGATION_PREPARE_XML,
    ISSUE_DELEGATION_STEPS_XML,
    ISSUE_DELEGATION_SUBMIT_XML,
    ISSUE_DELEGATION_DISPATCH_RULES_XML,
    ISSUE_DELEGATION_COMMUNICATION_XML,
  ]
}

/** Render the complete `castboard-issue-delegation` XML. */
export function castboardIssueDelegation(facts: IssueDelegationFacts): string {
  return ['<castboard_issue_delegation>', ...issueDelegationPromptBlocks(facts), '</castboard_issue_delegation>'].join('\n')
}

export { ISSUE_DELEGATION_SECTION }
