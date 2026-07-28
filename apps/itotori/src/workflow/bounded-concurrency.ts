/** A small FIFO semaphore used for both per-run work and shared provider work. */
export class BoundedConcurrency {
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`concurrency limit must be a positive integer, received ${limit}`);
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.#active < this.limit) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
  }

  private release(): void {
    const next = this.#waiting.shift();
    if (next !== undefined) {
      // Hand the already-counted permit directly to the oldest waiter. A new
      // arrival must not slip into the slot before that waiter resumes.
      next();
      return;
    }
    this.#active -= 1;
  }
}

/** Process an input collection with at most `limit` active operations. */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const outcomes = Array.from({ length: items.length }, () => undefined as unknown as R);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      outcomes[index] = await operation(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return outcomes;
}
