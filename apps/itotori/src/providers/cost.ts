// ITOTORI-225 — cost normalization + assertion helpers.
//
// The cost-tier abstraction is gone (docs/audits/openrouter-cost-tracking-
// audit-2026-06-25.md §3 N1). Every provider response carries a real
// `usage.cost` (live evidence in docs/openrouter-integration-evidence/
// 2026-06-25.json); we just convert it to integer micros and tag
// `costKind: 'billed'`. No estimation paths. No `unknown` fallback.

import { ModelProviderError, type ProviderCost } from "./types.js";

/**
 * Convert a decimal-USD string (e.g. `"0.00000602"`) into integer micros-
 * USD. We parse the string ourselves to avoid the loss-of-precision risk
 * that `Number(value) * 1_000_000` carries for the tiny per-token costs
 * OpenRouter actually returns (well below 1e-6 USD per token for cheap
 * models). Negative values are rejected up-front because cost cannot be
 * negative; non-finite values likewise.
 */
export function decimalUsdStringToMicros(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ModelProviderError(
      "cost value was an empty string",
      "provider_response_invalid",
      false,
    );
  }
  if (!/^-?\d+(\.\d+)?$/u.test(trimmed)) {
    throw new ModelProviderError(
      `cost value ${JSON.stringify(value)} is not a plain decimal number`,
      "provider_response_invalid",
      false,
    );
  }
  if (trimmed.startsWith("-")) {
    throw new ModelProviderError(
      `cost value ${JSON.stringify(value)} is negative`,
      "provider_response_invalid",
      false,
    );
  }
  const [whole, fractional = ""] = trimmed.split(".");
  // Pad/truncate the fractional part to exactly 6 digits (micros). Round
  // half-up on the 7th digit so we do not silently truncate sub-micro
  // costs to zero.
  const padded = (fractional + "0000000").slice(0, 7);
  const microPart = padded.slice(0, 6);
  const roundingDigit = padded.charAt(6);
  const wholeMicros = Number(whole) * 1_000_000;
  const microsFromFraction = Number(microPart);
  const rounding = Number(roundingDigit) >= 5 ? 1 : 0;
  const total = wholeMicros + microsFromFraction + rounding;
  if (!Number.isFinite(total) || total < 0) {
    throw new ModelProviderError(
      `cost value ${JSON.stringify(value)} did not convert to a finite non-negative micros amount`,
      "provider_response_invalid",
      false,
    );
  }
  return total;
}

/**
 * Convert any usage.cost shape OpenRouter emits — string or number — into
 * integer micros. Numbers go through string-formatting first so the same
 * decimal-string parser handles them.
 */
export function usageCostToMicros(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return decimalUsdStringToMicros(value.toFixed(12));
  }
  if (typeof value === "string") {
    return decimalUsdStringToMicros(value);
  }
  throw new ModelProviderError(
    `cost value must be a number or decimal string, got ${typeof value}`,
    "provider_response_invalid",
    false,
  );
}

/**
 * Return the billed amount in micros-USD for a `ProviderCost`. Throws if
 * the cost is not billed (i.e. zero-cost runs do not have a billable
 * amount to charge against the cap / aggregate). Callers that want to
 * include zero-cost runs in their sums should use `costToMicrosOrZero`
 * instead.
 */
export function assertBilledCost(cost: ProviderCost): bigint {
  if (cost.costKind === "billed") {
    return BigInt(cost.amountMicrosUsd);
  }
  if (cost.costKind === "zero") {
    return 0n;
  }
  // Exhaustive — the type is `'billed' | 'zero'`. This branch is
  // unreachable, but the compile-time exhaustiveness check guards us
  // against future enum widening.
  const _exhaustive: never = cost.costKind;
  throw new ModelProviderError(
    `unsupported costKind: ${String(_exhaustive)}`,
    "provider_response_invalid",
    false,
  );
}

/**
 * Constant for the canonical zero-cost shape. Used by failure paths
 * (failed HTTP, network errors, response validation errors) where no
 * upstream charge occurred.
 */
export const ZERO_COST: ProviderCost = Object.freeze({
  costKind: "zero",
  currency: "USD",
  amountMicrosUsd: 0,
});
