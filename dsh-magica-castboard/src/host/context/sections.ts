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
export const ISSUE_ROUTER_ORDER = 150

// Portrait static rules and their per-turn contexts.
export const PORTRAIT_SECTION = 'castboard-project-portrait'
export const PORTRAIT_ORDER = 160
export const PORTRAIT_IDLE_SECTION = 'castboard-project-portrait-idle'
export const PORTRAIT_REMINDER_SECTION = 'castboard-project-portrait-reminder'

// Rules stay static; references carry the card and are re-rendered for every new session.
export const TASK_PROTOCOL_SECTION = 'castboard-task-protocol'
export const TASK_CONTEXT_SECTION = 'castboard-task-context'
export const TASK_ACCEPTANCE_SECTION = 'castboard-task-acceptance'
export const TASK_DISPATCH_SECTION = 'castboard-task-dispatch'

// Router guidance, per-issue router data, on-demand dispatch guidance, and comments
// delivered to a peer session.
export const ISSUE_ROUTER_SECTION = 'castboard-issue-router'
export const ISSUE_ROUTER_REMINDER_SECTION = 'castboard-issue-router-reminder'
export const ISSUE_ROUTER_IDLE_SECTION = 'castboard-issue-router-idle'
export const ISSUE_DELEGATION_SECTION = 'castboard-issue-delegation'
export const ISSUE_COMMENTS_SECTION = 'castboard-issue-comments'
