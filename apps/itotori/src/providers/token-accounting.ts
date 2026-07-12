// general-audit-1 (genaudit1-00 / genaudit1-01) — central token-count law.
//
// PROJECT LAW: token counts come ONLY from real provider call output —
// never approximated, defaulted, or estimated. This is the token-side
// mirror of the cost guard `assertBilledCost` (providers/cost.ts): a
// missing real count is a real failure surfaced as a structured throw,
// never papered over with a `?? estimateTokens(...)` heuristic or a
// `?? 0` coercion.
//
// Before this guard, seven agents and the agentic-loop context probe
// substituted a char/4 estimate (or zero) when `tokenUsage.promptTokens`
// / `completionTokens` was absent. That estimate flowed into the
// durable journal token columns byte-for-byte indistinguishable from a
// provider-reported count — asymmetric with
// cost, which always throws. This module makes the token path symmetric:
// a real count or a typed error, nothing in between.

import { ModelProviderError, type TokenUsage } from "./types.js";

/**
 * Token-count sources that represent a REAL count derived from the actual
 * request/response bytes:
 *
 *   - `provider_reported` — the live OpenRouter `usage` block (the wire
 *     truth) parsed by `normalizeUsage`.
 *   - `deterministic_counter` — recorded / fake providers, which count the
 *     real recorded-or-generated content. A recorded-bundle replay carries
 *     these real counts and flows through unchanged.
 *
 * `estimated` (the char/4 heuristic) and `unknown` (provider omitted the
 * usage block entirely) are NOT real counts and must never be persisted as
 * one.
 */
const REAL_TOKEN_COUNT_SOURCES: ReadonlySet<TokenUsage["tokenCountSource"]> = new Set([
  "provider_reported",
  "deterministic_counter",
]);

/** True iff `source` names a real (non-estimated) token-count provenance. */
export function isRealTokenCountSource(source: TokenUsage["tokenCountSource"]): boolean {
  return REAL_TOKEN_COUNT_SOURCES.has(source);
}

/**
 * Structured failure raised when a provider returns no real token count for
 * a field that a recording path is about to persist. Mirrors
 * `TranslationPartialResultError` / `assertBilledCost`: a typed,
 * non-retryable `provider_response_invalid` error naming the provider run,
 * the missing field, and the (insufficient) provenance the usage block
 * actually carried.
 */
export class MissingProviderTokenCountError extends ModelProviderError {
  constructor(
    readonly providerRunId: string,
    readonly field: "promptTokens" | "completionTokens",
    readonly tokenCountSource: TokenUsage["tokenCountSource"],
  ) {
    super(
      `provider run ${providerRunId} returned no real ${field} ` +
        `(tokenCountSource=${tokenCountSource}); token counts must come from ` +
        `real provider output, never estimated or defaulted`,
      "provider_response_invalid",
      false,
    );
    this.name = "MissingProviderTokenCountError";
  }
}

/**
 * Return a real token count for `field`, or throw
 * {@link MissingProviderTokenCountError}. A value is real only when the
 * usage block carries a numeric count AND its provenance is in
 * {@link REAL_TOKEN_COUNT_SOURCES}. This is the single enforcement point
 * the agents and the agentic-loop probe call instead of `?? estimateTokens`
 * / `?? 0`.
 */
export function assertReportedTokenCount(
  usage: TokenUsage,
  field: "promptTokens" | "completionTokens",
  providerRunId: string,
): number {
  const value = usage[field];
  if (value === undefined || !REAL_TOKEN_COUNT_SOURCES.has(usage.tokenCountSource)) {
    throw new MissingProviderTokenCountError(providerRunId, field, usage.tokenCountSource);
  }
  return value;
}

export type ReportedTokenUsage = {
  tokensIn: number;
  tokensOut: number;
  /**
   * The provenance both counts were drawn from. Threaded to the journal sink
   * so a persisted real count is distinguishable from any (now-rejected)
   * estimate.
   */
  tokenCountSource: TokenUsage["tokenCountSource"];
};

/**
 * Assert real prompt AND completion counts in one call, returning them
 * alongside their shared provenance. Throws on the first missing count.
 */
export function assertReportedTokenUsage(
  usage: TokenUsage,
  providerRunId: string,
): ReportedTokenUsage {
  return {
    tokensIn: assertReportedTokenCount(usage, "promptTokens", providerRunId),
    tokensOut: assertReportedTokenCount(usage, "completionTokens", providerRunId),
    tokenCountSource: usage.tokenCountSource,
  };
}
