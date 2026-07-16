// Protected-span occurrence counting — the single canonical copy.
//
// Rehomed from the deleted `services/protected-span-occurrences.ts`: the exact
// repeated-token semantics (a raw required N times must occur >= N times, each
// satisfied occurrence consuming one from a per-raw pool) are preserved so a
// single literal cannot satisfy multiple required repeats. Pure and stateless.

/** Non-overlapping literal occurrences of `raw` in `text`; 0 for empty needle. */
export function countOccurrences(text: string, raw: string): number {
  if (raw.length === 0) {
    return 0;
  }
  let count = 0;
  let searchStart = 0;
  while (searchStart <= text.length) {
    const index = text.indexOf(raw, searchStart);
    if (index < 0) {
      return count;
    }
    count += 1;
    searchStart = index + raw.length;
  }
  return count;
}

/**
 * The required raws whose occurrence count is NOT satisfied by `text`,
 * accounting for repeated tokens: a raw listed N times must occur >= N times,
 * each match consuming one from a per-raw pool.
 */
export function missingRequiredOccurrences(
  requiredRaws: readonly string[],
  text: string,
): string[] {
  const available = new Map<string, number>();
  const missing: string[] = [];
  for (const raw of requiredRaws) {
    const remaining = available.get(raw) ?? countOccurrences(text, raw);
    if (remaining <= 0) {
      missing.push(raw);
      continue;
    }
    available.set(raw, remaining - 1);
  }
  return missing;
}
