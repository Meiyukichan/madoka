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
export * from './texts.ts'
export * from './renders.ts'
export * from './dispatch-guidance.ts'
