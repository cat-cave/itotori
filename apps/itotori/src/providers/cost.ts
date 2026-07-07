// ITOTORI-225 — cost normalization + assertion helpers.
//
// The cost-tier abstraction is gone (docs/audits/openrouter-cost-tracking-
// audit-2026-06-25.md §3 N1). Every provider response carries a real
// `usage.cost` (live evidence in docs/openrouter-integration-evidence/
// 2026-06-25.json); we carry it VERBATIM as the authoritative full-
// precision `amountUsd` and ALSO derive integer micros (`amountMicrosUsd`)
// as a cap/telemetry mirror, tagging `costKind: 'billed'`. The decimal
// `amountUsd` — not micros — is the value the ledger persists and the
// 1e-9 cost CHECK compares. No estimation paths. No `unknown` fallback.

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
 * ITOTORI-232 — validate a decimal-USD string and return its canonical
 * full-precision form (trailing-zero-trimmed, no leading `+`, no negative).
 * Unlike {@link decimalUsdStringToMicros} this preserves EVERY significant
 * digit, including the sub-micro tail (`0.00000602`) that micros rounding
 * destroys. This is the value that becomes `ProviderCost.amountUsd` and is
 * persisted VERBATIM as the ledger's `cost_amount`. Same validation surface
 * as the micros parser: empty / non-decimal / negative are rejected.
 */
export function decimalUsdStringCanonical(value: string): string {
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
  return normalizeDecimalString(trimmed);
}

/**
 * Strip an insignificant fractional tail and leading zeros so equal values
 * share one representation (`"0.0125000" -> "0.0125"`, `"00.5" -> "0.5"`,
 * `"6.000" -> "6"`). Never drops a significant digit, so
 * `Number(result) === Number(input)` for every finite decimal string.
 */
function normalizeDecimalString(value: string): string {
  const [wholeRaw = "0", fractionalRaw = ""] = value.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/u, "");
  const fractional = fractionalRaw.replace(/0+$/u, "");
  return fractional.length > 0 ? `${whole}.${fractional}` : whole;
}

/**
 * ITOTORI-232 — convert any usage.cost shape OpenRouter emits (string or
 * number) into the canonical full-precision decimal-USD string that
 * becomes {@link ProviderCost.amountUsd}. Numbers are stringified at 12
 * fractional digits (enough to carry every sub-micro cost OpenRouter
 * returns) before validation, so the same parser handles both shapes.
 */
export function usageCostToDecimalString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return decimalUsdStringCanonical(value.toFixed(12));
  }
  if (typeof value === "string") {
    return decimalUsdStringCanonical(value);
  }
  throw new ModelProviderError(
    `cost value must be a number or decimal string, got ${typeof value}`,
    "provider_response_invalid",
    false,
  );
}

/**
 * Return the real cost amount in micros-USD for a `ProviderCost`. Throws if
 * the cost is not billed (i.e. zero-cost runs do not have a billable
 * amount to charge against the cap / aggregate). Callers that want to
 * include zero-cost runs in their sums should use `costToMicrosOrZero`
 * instead.
 *
 * ITOTORI-134 — `provider_estimate` costs carry a deterministic estimate
 * derived from real provider pricing data (cost_details / endpoint pricing).
 * The estimate IS a real expected spend number, so the cost cap / aggregate
 * consumes it directly (fail-safe: an estimate counts toward the budget
 * rather than silently passing). Both `billed` and `provider_estimate`
 * therefore return their `amountMicrosUsd`; `zero` returns 0.
 */
export function assertBilledCost(cost: ProviderCost): bigint {
  if (cost.costKind === "billed" || cost.costKind === "provider_estimate") {
    return BigInt(cost.amountMicrosUsd);
  }
  if (cost.costKind === "zero") {
    return 0n;
  }
  // Exhaustive — the type is `'billed' | 'provider_estimate' | 'zero'`. This
  // branch is unreachable, but the compile-time exhaustiveness check guards us
  // against future enum widening.
  const _exhaustive: never = cost.costKind;
  throw new ModelProviderError(
    `unsupported costKind: ${String(_exhaustive)}`,
    "provider_response_invalid",
    false,
  );
}

/**
 * Return the real cost amount as the canonical FULL-PRECISION decimal-USD
 * string for a `ProviderCost` — the same authoritative representation the
 * ledger persists (`ProviderCost.amountUsd`, the verbatim provider
 * `usage.cost`). Unlike {@link assertBilledCost}, which returns the
 * integer-micros mirror that rounds a `0.00000602` charge to `0.000006`
 * (a 2e-8 error), this preserves EVERY significant digit including the
 * sub-micro tail cheap models bill. Zero-cost runs return `"0"`. Callers
 * that render a per-invocation / per-stage `costUsd` MUST use this so the
 * bundle carries the same precision as the ledger, never the truncated
 * micros form.
 *
 * ITOTORI-134 — `provider_estimate` costs carry a deterministic estimate
 * (cost_details / endpoint pricing) whose `amountUsd` is the derived
 * decimal; it is returned verbatim alongside `billed`.
 */
export function assertBilledCostDecimal(cost: ProviderCost): string {
  if (cost.costKind === "billed" || cost.costKind === "provider_estimate") {
    return cost.amountUsd;
  }
  if (cost.costKind === "zero") {
    return "0";
  }
  // Exhaustive — mirror of assertBilledCost; guards against enum widening.
  const _exhaustive: never = cost.costKind;
  throw new ModelProviderError(
    `unsupported costKind: ${String(_exhaustive)}`,
    "provider_response_invalid",
    false,
  );
}

/**
 * Losslessly add two non-negative decimal-USD strings, returning the sum
 * in canonical full-precision form (trailing-zero-trimmed). Used to roll
 * per-invocation billed costs into a per-stage total WITHOUT rounding to
 * micros: summing `"0.00000602" + "0.00000602"` yields `"0.00001204"`,
 * where the micros mirror would round each addend to `0.000006` and lose
 * the sub-micro tail. Operates on the scaled integer representation via
 * BigInt so there is no floating-point drift. Inputs are validated the
 * same way the canonical parser validates (plain, non-negative decimals).
 */
export function addDecimalUsd(a: string, b: string): string {
  const av = decimalUsdStringCanonical(a);
  const bv = decimalUsdStringCanonical(b);
  const [aWhole, aFrac = ""] = av.split(".");
  const [bWhole, bFrac = ""] = bv.split(".");
  const scale = Math.max(aFrac.length, bFrac.length);
  const aScaled = BigInt(aWhole + aFrac.padEnd(scale, "0"));
  const bScaled = BigInt(bWhole + bFrac.padEnd(scale, "0"));
  const sum = aScaled + bScaled;
  if (scale === 0) {
    return sum.toString();
  }
  const digits = sum.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  return normalizeDecimalString(`${whole}.${frac}`);
}

/**
 * Constant for the canonical zero-cost shape. Used by failure paths
 * (failed HTTP, network errors, response validation errors) where no
 * upstream charge occurred.
 */
export const ZERO_COST: ProviderCost = Object.freeze({
  costKind: "zero",
  currency: "USD",
  amountUsd: "0",
  amountMicrosUsd: 0,
});
