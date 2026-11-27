/**
 * Followup instructions for the resident issue-router session.
 *
 * @module dsh-magica-castboard/host/context/router-instruction
 */

/** Warm-up prompt used only when the router session is created or resumed with nothing to do. */
export const ROUTER_IDLE_PROMPT =
  'You are ready. There are no pending issues; do nothing and wait for the next wake-up.'

export function routerInstruction(issueId: string): string {
  return `Following the castboard-issue-router guidance, convert the issue (issueId: ${issueId}) into a task; conversion only, do not execute it.`
}

/** Retry wake: only remind the existing router which issue still needs conversion. */
export function routerReminder(issueId: string): string {
  return `Continue with the issue (issueId: ${issueId}). It was not converted into a task last turn; do not reopen the full materials — finish the conversion from the existing context and call castboard_issue (capability="convert").`
}
