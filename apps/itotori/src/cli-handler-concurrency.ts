/**
 * Parse the optional `--concurrency <N>` flag: a client-side bounded-concurrency
 * override for the whole-game localize driver. Returns undefined when absent.
 */
export const MAX_LOCALIZE_CONCURRENCY = 16;

export class ConcurrencyFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyFlagError";
  }
}

export function parseConcurrencyFlag(args: string[]): number | undefined {
  const index = args.indexOf("--concurrency");
  if (index < 0) return undefined;

  const raw = args[index + 1];
  if (raw === undefined || raw.length === 0 || raw.startsWith("--")) {
    const receivedValue = raw === undefined ? "<missing>" : `'${raw}'`;
    throw new ConcurrencyFlagError(
      `--concurrency requires a positive integer value in the valid range [1, ${MAX_LOCALIZE_CONCURRENCY}]; got ${receivedValue}`,
    );
  }

  const parsed = Number.parseInt(raw, 10);
  if (
    !Number.isInteger(parsed) ||
    String(parsed) !== raw ||
    parsed < 1 ||
    parsed > MAX_LOCALIZE_CONCURRENCY
  ) {
    throw new ConcurrencyFlagError(
      `--concurrency '${raw}' must be a positive integer in the valid range [1, ${MAX_LOCALIZE_CONCURRENCY}]`,
    );
  }
  return parsed;
}
