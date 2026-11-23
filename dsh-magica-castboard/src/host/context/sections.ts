/**
 * Section names and orders for every named context, kept together because they label
 * GUI context rows and anchor tests; rendering code imports these instead of writing
 * literals. Host-level system sections use `plugin:<package tail>`; the rest use
 * `castboard-*`, matching tool names and ledger files.
 *
 * @module dsh-magica-castboard/host/context/sections
 */

/** The owning plugin name; `contextPlugin` must match, or the GUI attributes the row elsewhere. */
export const PLUGIN_NAME = '@meiyukichan/dsh-magica-castboard'

/** Section name for the board explanation (registering it twice throws; the process mounts it once). */
export const BOARD_PROMPT_SECTION = 'plugin:dsh-magica-castboard'

/**
 * Offset from the `TOOLS_SDK` slot dsh allocates centrally: add it to
 * `systemPrompt.getSectionOrder('TOOLS_SDK')` so dsh can reorder its section table
 * without breaking us. The section lands after the built-in tool sections and before
 * the deliverable file-reference section.
 */
export const BOARD_PROMPT_ORDER_OFFSET = 100

/** Tool guidance conventionally occupies 100–199; 150 keeps the router clear of the execution-session sections. */
export const ISSUE_ROUTING_ORDER = 150

// Single definition in `portrait/prompt.ts`.
export {
  PORTRAIT_MAX_LINES,
  PORTRAIT_ORDER,
  PORTRAIT_SECTION,
  PORTRAIT_TARGET_SECTION,
} from '../portrait/prompt.ts'

// Rules stay static; references carry the card and are re-rendered for every new session.
export const RULES_SECTION = 'castboard-task-rules'
export const REFERENCES_SECTION = 'castboard-task-references'
export const TASK_ACCEPTANCE_SECTION = 'castboard-task-acceptance'

// Router guidance, per-issue router data, on-demand dispatch guidance, and comments
// delivered to a peer session.
export const ISSUE_ROUTING_SECTION = 'castboard-issue-routing'
export const ISSUE_REFERENCES_SECTION = 'castboard-issue-references'
export const DISPATCH_GUIDANCE_SECTION = 'castboard-issue-creation-guidance'
export const ISSUE_COMMENTS_SECTION = 'castboard-issue-comments'
