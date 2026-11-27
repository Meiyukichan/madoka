/**
 * Composable blocks for the acceptance round's `castboard-task-acceptance` context.
 *
 * The root wrapper is owned by {@link castboardAcceptanceXml}; each child block is
 * independent so sections can be reused or reordered without editing one template.
 *
 * @module dsh-magica-castboard/host/context/acceptance-context
 */
import type { AcceptanceStrategy, TaskRecord } from '../model.ts'
import { escapeXml, escapeXmlAttr } from './xml-escape.ts'

/** The card being reviewed. */
export function acceptanceTaskXml(task: TaskRecord): string {
  return `<task id="${escapeXmlAttr(task.id)}">
  <title>${escapeXml(task.title)}</title>
</task>`
}

export const ACCEPTANCE_SITUATION_XML = '<situation>This card has finished execution and is now in review.</situation>'

export const ACCEPTANCE_BOUNDARY_XML = '<boundary>This round is judgment and closing only. Do not write code, modify files, or run commands that change the project.</boundary>'

const ACCEPTANCE_STEP_1_XML = `<step order="1">
Review every close strategy against the execution report, comment evidence, and code facts. If there are no close strategies, this check passes by default.
</step>`

const ACCEPTANCE_STEP_2_XML = `<step order="2">
If any close strategy fails, use castboard_comment (capability="add") to state what is missing, then castboard_task (capability="move") to move the card to todo. Stop here; do not dispatch issues.
</step>`

const ACCEPTANCE_STEP_3_XML = `<step order="3">
If all close strategies pass, review issue strategies and create their issues: read the creation rules with castboard_issue (capability="help") first, then create with castboard_issue (capability="create"). Use dependsOn to express ordering. Skip this step when there are no issue strategies.
</step>`

const ACCEPTANCE_STEP_4_XML = `<step order="4">
Use castboard_comment (capability="add") to record the verdict and the created issue titles / ids.
</step>`

const ACCEPTANCE_STEP_5_XML = `<step order="5">
After the verdict comment, move the card to done with castboard_task (capability="move").
</step>`

/** Ordered acceptance steps. */
export const ACCEPTANCE_STEPS_XML = `<steps>
${ACCEPTANCE_STEP_1_XML}
${ACCEPTANCE_STEP_2_XML}
${ACCEPTANCE_STEP_3_XML}
${ACCEPTANCE_STEP_4_XML}
${ACCEPTANCE_STEP_5_XML}
</steps>`

export const ACCEPTANCE_COMPLETION_XML = '<completion>A round is complete when the verdict comment is written and the card has moved to todo or done. Do not wait for further instructions.</completion>'

export const ACCEPTANCE_CONSTRAINTS_XML = '<constraints>Do not edit execution records, and do not abandon or archive the card. This round only records the verdict, creates follow-up issues, and moves the card to todo or done.</constraints>'

/** Close strategies (can this card be closed?). */
export function acceptanceCloseStrategiesXml(strategies: readonly AcceptanceStrategy[]): string {
  if (strategies.length === 0) return ''
  const lines = ['<close_strategies>']
  for (const strategy of strategies) {
    lines.push(`  <strategy id="${escapeXmlAttr(strategy.id)}" title="${escapeXmlAttr(strategy.title)}">${escapeXml(strategy.description)}</strategy>`)
  }
  lines.push('</close_strategies>')
  return lines.join('\n')
}

/** Issue strategies (what work should still go out?). */
export function acceptanceIssueStrategiesXml(strategies: readonly AcceptanceStrategy[]): string {
  if (strategies.length === 0) return ''
  const lines = ['<issue_strategies>']
  for (const strategy of strategies) {
    lines.push(`  <strategy id="${escapeXmlAttr(strategy.id)}" title="${escapeXmlAttr(strategy.title)}">${escapeXml(strategy.description)}</strategy>`)
  }
  lines.push('</issue_strategies>')
  return lines.join('\n')
}

/**
 * Compose every acceptance child block in order.
 *
 * Close strategies always precede dispatch strategies: first decide whether the card
 * can be closed, then what work should still go out.
 */
export function acceptancePromptBlocks(
  task: TaskRecord,
  strategies: readonly AcceptanceStrategy[],
): string[] {
  return [
    acceptanceTaskXml(task),
    ACCEPTANCE_SITUATION_XML,
    ACCEPTANCE_BOUNDARY_XML,
    ACCEPTANCE_STEPS_XML,
    ACCEPTANCE_COMPLETION_XML,
    ACCEPTANCE_CONSTRAINTS_XML,
    acceptanceCloseStrategiesXml(strategies.filter(strategy => strategy.type === 'close')),
    acceptanceIssueStrategiesXml(strategies.filter(strategy => strategy.type === 'issue')),
  ].filter(block => block !== '')
}

/** Render the complete `castboard-task-acceptance` XML. */
export function castboardAcceptanceXml(
  task: TaskRecord,
  strategies: readonly AcceptanceStrategy[],
): string {
  return ['<castboard_task_acceptance>', ...acceptancePromptBlocks(task, strategies), '</castboard_task_acceptance>'].join('\n')
}
