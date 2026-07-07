// ITOTORI-144 — Shared duplicate protected-span OCCURRENCE logic.
//
// The standalone protected-span check tool (tool.protected-span-check, in
// agents/examples.ts) and the deterministic pre-export QA suite
// (runDeterministicPreExportQa) MUST agree on how repeated protected-span
// tokens are counted against a target draft. Both consume the single
// implementation below so repeated-token handling cannot drift between the two
// paths. Keep this the ONLY copy — do not re-inline either function.

/**
 * Counts non-overlapping literal occurrences of `raw` in `targetText`. Returns
 * 0 for an empty needle. Shared so the standalone protected-span check and the
 * deterministic pre-export QA count occurrences identically (ITOTORI-144).
 */
export function countProtectedSpanOccurrences(targetText: string, raw: string): number {
  if (raw.length === 0) {
    return 0;
  }
  let count = 0;
  let searchStart = 0;
  while (searchStart <= targetText.length) {
    const index = targetText.indexOf(raw, searchStart);
    if (index < 0) {
      return count;
    }
    count += 1;
    searchStart = index + raw.length;
  }
  return count;
}

/**
 * Returns the protected-span raws from `requiredSpans` whose required occurrence
 * count is NOT satisfied by `targetText`, accounting for REPEATED tokens: if a
 * raw appears N times in `requiredSpans`, the target must contain it at least N
 * times, and each satisfied occurrence consumes one from a per-raw pool so a
 * single literal cannot satisfy multiple required repeats.
 *
 * Shared by the standalone protected-span check tool and the deterministic
 * pre-export QA so the two paths cannot drift on repeated-token handling
 * (ITOTORI-144).
 */
export function missingRequiredProtectedSpanOccurrences(
  requiredSpans: string[],
  targetText: string,
): string[] {
  const availableCounts = new Map<string, number>();
  const missing: string[] = [];
  for (const spanRaw of requiredSpans) {
    const available =
      availableCounts.get(spanRaw) ?? countProtectedSpanOccurrences(targetText, spanRaw);
    if (available <= 0) {
      missing.push(spanRaw);
      continue;
    }
    availableCounts.set(spanRaw, available - 1);
  }
  return missing;
}
