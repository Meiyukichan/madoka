/**
 * Per-round portrait instruction (natural-language user message).
 *
 * The static context carries the rules, and `<castboard_portrait_target>` carries the
 * per-round paths and mode; this prompt only sets the order and the stopping point.
 *
 * @module dsh-magica-castboard/host/context/portrait-instruction
 */

export const PORTRAIT_IDLE_PROMPT =
  'You are ready. There are no projects waiting for a portrait; do nothing and wait for the next wake-up.'

export function portraitInstruction(): string {
  return 'Write or update this project\'s portrait first, then update its index entry using the target below. Stop after both files are written.'
}
