// A bounded-concurrency fan-out.
//
// Runs `worker` over `items` with at most `limit` in flight at once, preserving
// each item's result position. The limit is a HARD ceiling: the (limit+1)-th
// item does not begin until one of the in-flight items settles. This is the one
// primitive that bounds the analyst fan-out; the serial fold inside a work item
// is a plain `for await` and never touches this pool. A worker rejection
// propagates (fail-loud) after in-flight work drains.

/** An invalid concurrency limit. */
export class ConcurrencyLimitError extends Error {
  constructor(limit: number) {
    super(`concurrency limit must be a positive integer, got ${limit}`);
    this.name = "ConcurrencyLimitError";
  }
}

/**
 * Map `items` through `worker` with at most `limit` concurrent invocations.
 * Results are returned in input order. The pool never admits more than `limit`
 * workers at once.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ConcurrencyLimitError(limit);
  }
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  async function lane(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  }
  const lanes = Array.from({ length: Math.min(limit, items.length) }, () => lane());
  await Promise.all(lanes);
  return results;
}
