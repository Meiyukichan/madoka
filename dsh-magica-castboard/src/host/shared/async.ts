/**
 * Concurrency primitives. dsh web is a single Node process with a 4-slot libuv thread
 * pool, so an unbounded `Promise.all` over one-I/O-per-item work starves every HTTP
 * handler, including other plugins'. Batches go through `mapLimit` at 2..4 lanes instead.
 *
 * @module dsh-magica-castboard/host/shared/async
 */

/**
 * Fixed-concurrency batch that preserves input order.
 *
 * A rejection from any item rejects the whole call (handle per-item failures inside
 * `run`); the lane count is at least 1, and an empty input starts no lane.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const total = items.length
  const lanes = Math.min(Math.max(1, Math.floor(limit)), total)
  const slots: R[] = new Array<R>(total)
  let claimed = 0

  // Claiming a slot is synchronous, so two lanes can never run the same item even though
  // each awaits its own work.
  const drainLane = async (): Promise<void> => {
    while (claimed < total) {
      const slot = claimed
      claimed += 1
      slots[slot] = await run(items[slot]!, slot)
    }
  }

  await Promise.all(Array.from({ length: lanes }, () => drainLane()))
  return slots
}
