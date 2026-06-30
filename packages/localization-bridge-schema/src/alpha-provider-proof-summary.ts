// ALPHA-008 — sanitized alpha provider-proof summary (redacted provider
// ledger bundle).
//
// This is the README-safe, alpha-facing PROJECTION of a `ProviderProofBundle`
// (ITOTORI-116). The bundle already carries every datum from the REAL call;
// this summary RE-ARRANGES the already-sanitized bundle into the explicit
// evidence shape alpha readiness consumes instead of a prose claim about
// provider support:
//
//   - servedRoutes        : per role, the routed (served) provider + model,
//                           the fallback chain (provider preference order), and
//                           whether OR-side fallback actually moved the serve
//                           off the preferred provider, plus the retry state.
//   - structuredOutputSupport : per role, the structured-output mode the call
//                           used and whether the response passed the strict
//                           shared schema (the support EVIDENCE, not a claim).
//   - dataPolicy          : the ZDR data-policy flags (account assertion +
//                           per-request ZDR), the privacy gate.
//   - cost                : the token/cost ledger restated from the real call;
//                           the only derivation is integer-micros → USD.
//   - redaction           : the standing guarantee that no raw prompt, raw
//                           response, API key, or private corpus text rode in.
//
// It owns NO scoring, routing, or cost math of its own — every value is copied
// or restated from the validated `ProviderProofBundle`. Like the bundle, it
// carries ONLY ids/hashes/counts/routing/cost: NO raw prompts, NO raw
// responses, NO API keys, NO private corpus text. `additionalProperties:false`
// everywhere keeps a raw payload from ever riding along, and a strict
// assertion throws `AlphaProviderProofSummaryValidationError` on any
// divergence.

import {
  PROVIDER_PROOF_ROLE_NAMES,
  type ProviderProofQaOracleReport,
  type ProviderProofMode,
  type ProviderProofRetryState,
  type ProviderProofRoleName,
  type ProviderProofTerminalStatus,
} from "./provider-proof-bundle.js";

export const ALPHA_PROVIDER_PROOF_SUMMARY_SCHEMA_VERSION =
  "itotori.alpha-provider-proof-summary.v0" as const;

/**
 * One routed (served) role. The fallback chain is the provider PREFERENCE
 * order the call carried (OR `provider.order`); `fallbackOccurred` is true
 * when the served provider is not the preferred head of that chain — i.e.
 * OR-side fallback moved the serve, which is recorded as data, never an error.
 */
export type AlphaProviderProofServedRoute = {
  role: ProviderProofRoleName;
  terminalStatus: ProviderProofTerminalStatus;
  /** Accepted proof id, or null when the role terminally rejected. */
  acceptedProviderProofId: string | null;
  requestedModelId: string;
  servedModel: string;
  requestedProviderId: string;
  servedProvider: string;
  /** Provider preference order (the routing `order`); head is the preferred. */
  fallbackChain: string[];
  /** servedProvider !== fallbackChain[0] — OR-side fallback moved the serve. */
  fallbackOccurred: boolean;
  /** Total attempts the role consumed (initial + bounded schema repairs). */
  attemptCount: number;
  /** Retry state of the terminal attempt. */
  retryState: ProviderProofRetryState;
  /** Retry reason of the terminal attempt, or null on an initial-attempt serve. */
  retryReason: string | null;
};

/** Per-role structured-output support EVIDENCE drawn from the real call. */
export type AlphaProviderProofStructuredOutputEvidence = {
  role: ProviderProofRoleName;
  /** Structured-output mode the terminal attempt used (e.g. json_object). */
  structuredOutputMode: string;
  /** Whether the response passed the strict shared schema (was accepted). */
  accepted: boolean;
  /** drafts.length / findings.length on the accepted output, or null. */
  acceptedItemCount: number | null;
  /** SHA-256 of the accepted structured output, or null. */
  acceptedOutputHash: string | null;
};

/** ZDR data-policy flags — the privacy gate, restated from the bundle. */
export type AlphaProviderProofDataPolicy = {
  /** `asserted` (live, after the account-wide ZDR assertion) or `recorded_fixture`. */
  zdrAccountAssertion: "asserted" | "recorded_fixture";
  /** Whether the accepted calls carried `provider.zdr=true` on the wire posture. */
  perRequestZdr: boolean;
  /** True iff EVERY ledger row's served call carried `zdr=true`. */
  allLedgerRoutesZdr: boolean;
};

/** One token/cost ledger row, restated verbatim from the bundle ledger. */
export type AlphaProviderProofCostRow = {
  providerProofId: string;
  role: ProviderProofRoleName;
  servedProvider: string;
  servedModel: string;
  /** Authoritative full-precision billed amount string from the real call. */
  costAmount: string;
  /** Derived integer micros mirror of the billed amount. */
  costMicrosUsd: number;
  tokensIn: number;
  tokensOut: number;
  tokenCountSource: string;
  latencyMs: number;
};

export type AlphaProviderProofCost = {
  currency: "USD";
  /** Sum of every ledger row's `costMicrosUsd`. */
  totalMicrosUsd: number;
  /** `totalMicrosUsd / 1e6` — the ONLY permitted cost transform. */
  totalUsd: number;
  rows: AlphaProviderProofCostRow[];
};

/**
 * The standing redaction guarantee. All four inclusion flags are the literal
 * `false`: the summary (like the bundle) carries no raw prompt, raw response,
 * API key, or private corpus text — only ids/hashes/counts/routing/cost.
 */
export type AlphaProviderProofRedaction = {
  rawPromptsIncluded: false;
  rawResponsesIncluded: false;
  apiKeysIncluded: false;
  privateCorpusTextIncluded: false;
  note: string;
};

export type AlphaProviderProofSummary = {
  schemaVersion: typeof ALPHA_PROVIDER_PROOF_SUMMARY_SCHEMA_VERSION;
  proofId: string;
  mode: ProviderProofMode;
  fixtureId: string;
  maxRepairAttempts: number;
  dataPolicy: AlphaProviderProofDataPolicy;
  servedRoutes: AlphaProviderProofServedRoute[];
  structuredOutputSupport: AlphaProviderProofStructuredOutputEvidence[];
  cost: AlphaProviderProofCost;
  qaOracle: ProviderProofQaOracleReport;
  redaction: AlphaProviderProofRedaction;
};

// ---------------------------------------------------------------------------
// Strict JSON Schema (draft-07)
// ---------------------------------------------------------------------------

export const ALPHA_PROVIDER_PROOF_SUMMARY_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "itotori://localization-bridge-schema/alpha-provider-proof-summary.v0",
  title: "AlphaProviderProofSummary",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "proofId",
    "mode",
    "fixtureId",
    "maxRepairAttempts",
    "dataPolicy",
    "servedRoutes",
    "structuredOutputSupport",
    "cost",
    "qaOracle",
    "redaction",
  ],
  properties: {
    schemaVersion: { const: ALPHA_PROVIDER_PROOF_SUMMARY_SCHEMA_VERSION },
    proofId: { type: "string", minLength: 1 },
    mode: { enum: ["recorded", "live"] },
    fixtureId: { type: "string", minLength: 1 },
    maxRepairAttempts: { type: "integer", minimum: 0 },
    dataPolicy: { type: "object" },
    servedRoutes: { type: "array" },
    structuredOutputSupport: { type: "array" },
    cost: { type: "object" },
    qaOracle: { type: "object" },
    redaction: { type: "object" },
  },
} as const;

// ---------------------------------------------------------------------------
// Validation surface
// ---------------------------------------------------------------------------

export class AlphaProviderProofSummaryValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly rule: string,
    public readonly detail: string,
  ) {
    super(`AlphaProviderProofSummary.${path} failed rule '${rule}': ${detail}`);
    this.name = "AlphaProviderProofSummaryValidationError";
  }
}

function fail(path: string, rule: string, detail: string): never {
  throw new AlphaProviderProofSummaryValidationError(path, rule, detail);
}

function assertObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "type", "expected object");
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, "type", "expected non-empty string");
  }
  return value as string;
}

function assertNullableString(value: unknown, path: string): string | null {
  return value === null ? null : assertString(value, path);
}

function assertNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(path, "type", "expected non-negative integer");
  }
  return value as number;
}

function assertFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "type", "expected finite number");
  }
  return value as number;
}

function assertBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    fail(path, "type", "expected boolean");
  }
  return value as boolean;
}

function assertLiteralFalse(value: unknown, path: string): false {
  if (value !== false) {
    fail(path, "const", "expected literal false");
  }
  return false;
}

function assertEnum(value: unknown, allowed: readonly string[], path: string): string {
  const text = assertString(value, path);
  if (!allowed.includes(text)) {
    fail(path, "enum", `value '${text}' not in [${allowed.join(", ")}]`);
  }
  return text;
}

function assertStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    fail(path, "type", "expected array");
  }
  return (value as unknown[]).map((entry, index) => assertString(entry, `${path}[${index}]`));
}

const TERMINAL_STATUSES = ["accepted", "rejected_schema_invalid"] as const;
const RETRY_STATES = ["initial", "repair"] as const;

function assertServedRoute(value: unknown, path: string): void {
  const record = assertObject(value, path);
  assertEnum(record.role, PROVIDER_PROOF_ROLE_NAMES, `${path}.role`);
  assertEnum(record.terminalStatus, TERMINAL_STATUSES, `${path}.terminalStatus`);
  assertNullableString(record.acceptedProviderProofId, `${path}.acceptedProviderProofId`);
  assertString(record.requestedModelId, `${path}.requestedModelId`);
  assertString(record.servedModel, `${path}.servedModel`);
  assertString(record.requestedProviderId, `${path}.requestedProviderId`);
  assertString(record.servedProvider, `${path}.servedProvider`);
  assertStringArray(record.fallbackChain, `${path}.fallbackChain`);
  assertBoolean(record.fallbackOccurred, `${path}.fallbackOccurred`);
  assertNonNegativeInteger(record.attemptCount, `${path}.attemptCount`);
  assertEnum(record.retryState, RETRY_STATES, `${path}.retryState`);
  if (record.retryReason !== null) {
    assertString(record.retryReason, `${path}.retryReason`);
  }
}

function assertStructuredOutputEvidence(value: unknown, path: string): void {
  const record = assertObject(value, path);
  assertEnum(record.role, PROVIDER_PROOF_ROLE_NAMES, `${path}.role`);
  assertString(record.structuredOutputMode, `${path}.structuredOutputMode`);
  assertBoolean(record.accepted, `${path}.accepted`);
  if (record.acceptedItemCount !== null) {
    assertNonNegativeInteger(record.acceptedItemCount, `${path}.acceptedItemCount`);
  }
  assertNullableString(record.acceptedOutputHash, `${path}.acceptedOutputHash`);
}

function assertDataPolicy(value: unknown, path: string): void {
  const record = assertObject(value, path);
  assertEnum(
    record.zdrAccountAssertion,
    ["asserted", "recorded_fixture"],
    `${path}.zdrAccountAssertion`,
  );
  assertBoolean(record.perRequestZdr, `${path}.perRequestZdr`);
  assertBoolean(record.allLedgerRoutesZdr, `${path}.allLedgerRoutesZdr`);
}

function assertCostRow(value: unknown, path: string): void {
  const record = assertObject(value, path);
  assertString(record.providerProofId, `${path}.providerProofId`);
  assertEnum(record.role, PROVIDER_PROOF_ROLE_NAMES, `${path}.role`);
  assertString(record.servedProvider, `${path}.servedProvider`);
  assertString(record.servedModel, `${path}.servedModel`);
  assertString(record.costAmount, `${path}.costAmount`);
  assertNonNegativeInteger(record.costMicrosUsd, `${path}.costMicrosUsd`);
  assertNonNegativeInteger(record.tokensIn, `${path}.tokensIn`);
  assertNonNegativeInteger(record.tokensOut, `${path}.tokensOut`);
  assertString(record.tokenCountSource, `${path}.tokenCountSource`);
  assertNonNegativeInteger(record.latencyMs, `${path}.latencyMs`);
}

function assertCost(value: unknown, path: string): void {
  const record = assertObject(value, path);
  if (record.currency !== "USD") {
    fail(`${path}.currency`, "const", "expected 'USD'");
  }
  assertNonNegativeInteger(record.totalMicrosUsd, `${path}.totalMicrosUsd`);
  assertFiniteNumber(record.totalUsd, `${path}.totalUsd`);
  if (!Array.isArray(record.rows)) {
    fail(`${path}.rows`, "type", "expected array");
  }
  record.rows.forEach((row, index) => assertCostRow(row, `${path}.rows[${index}]`));
}

function assertQaOracle(value: unknown, path: string): void {
  const record = assertObject(value, path);
  for (const field of [
    "seededDefectCount",
    "emittedFindingCount",
    "truePositives",
    "falsePositives",
    "falseNegatives",
  ]) {
    assertNonNegativeInteger(record[field], `${path}.${field}`);
  }
  for (const field of ["precision", "recall", "f1", "severityCalibration"]) {
    assertFiniteNumber(record[field], `${path}.${field}`);
  }
  for (const field of [
    "matchedSeededDefectIds",
    "falseNegativeSeededDefectIds",
    "falsePositiveBridgeUnitIds",
  ]) {
    assertStringArray(record[field], `${path}.${field}`);
  }
}

function assertRedaction(value: unknown, path: string): void {
  const record = assertObject(value, path);
  assertLiteralFalse(record.rawPromptsIncluded, `${path}.rawPromptsIncluded`);
  assertLiteralFalse(record.rawResponsesIncluded, `${path}.rawResponsesIncluded`);
  assertLiteralFalse(record.apiKeysIncluded, `${path}.apiKeysIncluded`);
  assertLiteralFalse(record.privateCorpusTextIncluded, `${path}.privateCorpusTextIncluded`);
  assertString(record.note, `${path}.note`);
}

/**
 * Validate a parsed value against the `AlphaProviderProofSummary` schema.
 * Throws `AlphaProviderProofSummaryValidationError` on the first divergence.
 */
export function assertAlphaProviderProofSummary(
  value: unknown,
): asserts value is AlphaProviderProofSummary {
  const record = assertObject(value, "");
  if (record.schemaVersion !== ALPHA_PROVIDER_PROOF_SUMMARY_SCHEMA_VERSION) {
    fail(
      "schemaVersion",
      "const",
      `expected ${ALPHA_PROVIDER_PROOF_SUMMARY_SCHEMA_VERSION}, got ${String(record.schemaVersion)}`,
    );
  }
  assertString(record.proofId, "proofId");
  assertEnum(record.mode, ["recorded", "live"], "mode");
  assertString(record.fixtureId, "fixtureId");
  assertNonNegativeInteger(record.maxRepairAttempts, "maxRepairAttempts");
  assertDataPolicy(record.dataPolicy, "dataPolicy");
  if (!Array.isArray(record.servedRoutes) || record.servedRoutes.length === 0) {
    fail("servedRoutes", "minItems", "expected at least one served route");
  }
  record.servedRoutes.forEach((route, index) => assertServedRoute(route, `servedRoutes[${index}]`));
  if (!Array.isArray(record.structuredOutputSupport)) {
    fail("structuredOutputSupport", "type", "expected array");
  }
  record.structuredOutputSupport.forEach((entry, index) =>
    assertStructuredOutputEvidence(entry, `structuredOutputSupport[${index}]`),
  );
  assertCost(record.cost, "cost");
  assertQaOracle(record.qaOracle, "qaOracle");
  assertRedaction(record.redaction, "redaction");
}

export function parseAlphaProviderProofSummary(raw: string): AlphaProviderProofSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(
      "",
      "json",
      `alpha provider-proof summary is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertAlphaProviderProofSummary(parsed);
  return parsed;
}
