/**
 * Run `task` over `items` with at most `limit` tasks in flight.
 *
 * Results are returned in the order of `items`, never in completion order, so
 * anything built from them (reports, summaries) is deterministic.
 *
 * - A task that throws rejects the whole call only after the tasks already
 *   started have settled; no new task is started once one has thrown.
 * - `shouldStart` is checked right before each task is started. Returning
 *   `false` stops the pool from starting more work; the skipped slots are
 *   `undefined` in the returned array.
 * - With `limit === 1` tasks run strictly one after the other, in order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
  shouldStart: (index: number) => boolean = () => true,
): Promise<Array<R | undefined>> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`Concurrency limit must be a positive integer, received ${limit}`);
  }
  const results: Array<R | undefined> = new Array<R | undefined>(items.length).fill(undefined);
  let next = 0;
  let failure: { error: unknown } | undefined;

  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const index = next;
      if (index >= items.length || !shouldStart(index)) return;
      next += 1;
      try {
        results[index] = await task(items[index] as T, index);
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  if (failure) throw failure.error;
  return results;
}
