/**
 * Bounded-concurrency batch runner for the triage actions.
 * @module dsh-plugin-status-board/shared/batch
 */

/** Largest number of host calls in flight at once. */
export const BATCH_CONCURRENCY = 5

/** One failed item and the reason the host gave. */
export interface BatchFailure {
  readonly id: string
  readonly message: string
}

/** Outcome of one batch: nothing is thrown, a failure never stops the others. */
export interface BatchResult {
  readonly succeeded: readonly string[]
  readonly failed: readonly BatchFailure[]
}

/**
 * Run `task` over `ids` with at most `limit` calls in flight.
 *
 * Each rejection is recorded and the remaining items still run. `onProgress`
 * fires after every settled item with the count settled so far.
 *
 * @param ids - items, processed in order of dispatch.
 * @param task - the host call for one item.
 * @param onProgress - progress observer.
 * @param limit - concurrency ceiling (clamped to at least 1).
 */
export async function runBatch(
  ids: readonly string[],
  task: (id: string) => Promise<void>,
  onProgress?: (settled: number, total: number) => void,
  limit: number = BATCH_CONCURRENCY,
): Promise<BatchResult> {
  const succeeded: string[] = []
  const failed: BatchFailure[] = []
  let cursor = 0
  let settled = 0
  const width = Math.max(1, Math.min(limit, ids.length))

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      const id = ids[index]
      if (id === undefined) return
      try {
        await task(id)
        succeeded.push(id)
      } catch (cause) {
        failed.push({ id, message: cause instanceof Error ? cause.message : String(cause) })
      }
      settled += 1
      onProgress?.(settled, ids.length)
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()))
  return { succeeded, failed }
}
