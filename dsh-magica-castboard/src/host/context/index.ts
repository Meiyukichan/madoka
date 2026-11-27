/**
 * Prompt-layer barrel. Three injection channels, chosen per session type at assembly:
 * system-prompt sections (the host-wide board note, or agent-scoped router/portrait
 * rules), named contexts created with the session (execution rules + references), and
 * per-round named contexts followed by a wake-up user message (acceptance rounds,
 * cross-session comments) — injecting without waking leaves the message queued.
 *
 * @module dsh-magica-castboard/host/context
 */
export * from './sections.ts'
export * from './system.ts'
export * from './xml-escape.ts'
export * from './comment-context.ts'
export * from './portrait-context.ts'
export * from './portrait-instruction.ts'
export * from './task-context.ts'
export * from './router-instruction.ts'
export * from './task-instruction.ts'
export * from './acceptance-context.ts'
export * from './acceptance-instruction.ts'
export * from './comment-instruction.ts'
export * from './issue-context.ts'
export * from './router-context.ts'
export * from './delegation-context.ts'
