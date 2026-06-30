// ITOTORI-116 — sanitized provider-proof bundle.
//
// The public, redistributable artifact the provider-proof harness emits in
// BOTH recorded mode (no creds) and opt-in live mode. It carries ONLY ids,
// hashes, counts, statuses, structured-output modes, (model, provider)
// pairs, ZDR posture, the token/cost/latency ledger, and the seeded QA
// oracle scoring report. It carries NO raw prompts, NO raw responses, NO
// API keys, NO private corpus text, and NO private asset paths — the harness
// reduces every accepted structured output to an `acceptedOutputHash` +
// item count, and every rejection to a typed `{ path, rule, detail }` triple
// drawn from the shared schema validators (never the offending payload).
//
// This module owns ONLY the wire-shape contract + a strict assertion. Any
// shape divergence throws a typed `ProviderProofBundleValidationError`. The
// harness that produces the bundle lives in apps/itotori; SHARED-025 consumes
// the bundle's `proofId` + ledger as a sanitized provider-proof reference.

export const PROVIDER_PROOF_BUNDLE_SCHEMA_VERSION = "itotori.provider-proof-bundle.v0" as const;

export type ProviderProofMode = "recorded" | "live";
export type ProviderProofRoleName = "draft" | "qa";
export const PROVIDER_PROOF_ROLE_NAMES = ["draft", "qa"] as const;
export type ProviderProofAttemptOutcome = "accepted" | "rejected_schema_invalid";
export type ProviderProofRetryState = "initial" | "repair";
export type ProviderProofTerminalStatus = "accepted" | "rejected_schema_invalid";

/**
 * A reject-before-record diagnostic. Drawn verbatim from the shared
 * draft/QA schema validators (`TranslationDraftResponseValidationError` /
 * `QaResponseValidationError`): a field path, the rule that failed, and a
 * sanitized detail string. It NEVER contains the offending provider
 * response — only the structural reason it was refused.
 */
export type ProviderProofRejection = {
  path: string;
  rule: string;
  detail: string;
};

/**
 * Fallback metadata for ONE attempt — recorded for every accepted OR
 * skipped (schema-rejected) attempt so an audit can see exactly which
 * provider/model/route served, which structured-output mode was used, the
 * retry state + reason, the real token + cost + latency the call carried,
 * and whether the wire posture enforced ZDR. Rejected attempts carry the
 * SAME metadata as accepted ones (the call really happened); only the
 * ledger row + accepted artifact are gated behind schema validation.
 */
export type ProviderProofAttempt = {
  attemptIndex: number;
  retryState: ProviderProofRetryState;
  /** null on the initial attempt; the prior attempt's rejection summary on a repair. */
  retryReason: string | null;
  outcome: ProviderProofAttemptOutcome;
  /** Populated only when `outcome === "rejected_schema_invalid"`. */
  rejection: ProviderProofRejection | null;
  providerProofId: string;
  requestedModelId: string;
  requestedProviderId: string;
  servedModel: string;
  servedProvider: string;
  /** Requested provider preference (routing `order`), joined by `>`. */
  requestedRoute: string;
  /** Real served route: `servedProvider::servedModel`. */
  servedRoute: string;
  /** Structured-output mode actually used (the capability axis exercised). */
  structuredOutputMode: string;
  tokensIn: number;
  tokensOut: number;
  tokenCountSource: string;
  costUsd: string;
  costMicrosUsd: number;
  latencyMs: number;
  zdr: boolean;
  promptHash: string;
};

export type ProviderProofRole = {
  role: ProviderProofRoleName;
  terminalStatus: ProviderProofTerminalStatus;
  /** Proof id of the accepted attempt, or null when the role terminally rejected. */
  acceptedProviderProofId: string | null;
  /** SHA-256 of the accepted structured-output JSON string, or null. */
  acceptedOutputHash: string | null;
  /** drafts.length / findings.length on the accepted output, or null. */
  acceptedItemCount: number | null;
  attempts: ProviderProofAttempt[];
};

/**
 * One token/cost/latency ledger row per ACCEPTED proof id (reject-before-
 * record: rejected attempts never produce a row). Reconciles with the
 * ITOTORI-100 route report keyed on `providerProofId` → served route.
 */
export type ProviderProofLedgerRow = {
  providerProofId: string;
  role: ProviderProofRoleName;
  modelId: string;
  providerId: string;
  servedProvider: string;
  servedModel: string;
  tokensIn: number;
  tokensOut: number;
  tokenCountSource: string;
  costUnit: string;
  costAmount: string;
  costMicrosUsd: number;
  latencyMs: number;
  zdr: boolean;
  promptHash: string;
};

/** A seeded QA defect the oracle scores LLM-QA findings against, by location + label. */
export type ProviderProofSeededDefect = {
  seededDefectId: string;
  bridgeUnitId: string;
  category: string;
  severity: string;
};

export type ProviderProofQaOracleReport = {
  seededDefectCount: number;
  emittedFindingCount: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  /** Fraction of matched findings whose severity equals the seed's severity. */
  severityCalibration: number;
  matchedSeededDefectIds: string[];
  falseNegativeSeededDefectIds: string[];
  falsePositiveBridgeUnitIds: string[];
};

export type ProviderProofZdrPosture = {
  /** `asserted` = account-wide ZDR assertion ran (live); `recorded_fixture` = offline replay. */
  accountAssertion: "asserted" | "recorded_fixture";
  /** Whether the accepted calls carried `provider.zdr=true` on the wire posture. */
  perRequestZdr: boolean;
};

export type ProviderProofBundle = {
  schemaVersion: typeof PROVIDER_PROOF_BUNDLE_SCHEMA_VERSION;
  proofId: string;
  mode: ProviderProofMode;
  fixtureId: string;
  maxRepairAttempts: number;
  zdr: ProviderProofZdrPosture;
  roles: ProviderProofRole[];
  ledger: ProviderProofLedgerRow[];
  qaOracle: ProviderProofQaOracleReport;
};

/**
 * Strict JSON Schema (draft-07) for `ProviderProofBundle`. Producers MUST
 * emit this exact shape; consumers (SHARED-025) MUST validate before
 * trusting a proof id. `additionalProperties:false` everywhere keeps a raw
 * prompt/response from ever riding along.
 */
export const PROVIDER_PROOF_BUNDLE_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "itotori://localization-bridge-schema/provider-proof-bundle.v0",
  title: "ProviderProofBundle",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "proofId",
    "mode",
    "fixtureId",
    "maxRepairAttempts",
    "zdr",
    "roles",
    "ledger",
    "qaOracle",
  ],
  properties: {
    schemaVersion: { const: PROVIDER_PROOF_BUNDLE_SCHEMA_VERSION },
    proofId: { type: "string", minLength: 1 },
    mode: { enum: ["recorded", "live"] },
    fixtureId: { type: "string", minLength: 1 },
    maxRepairAttempts: { type: "integer", minimum: 0 },
    zdr: {
      type: "object",
      additionalProperties: false,
      required: ["accountAssertion", "perRequestZdr"],
      properties: {
        accountAssertion: { enum: ["asserted", "recorded_fixture"] },
        perRequestZdr: { type: "boolean" },
      },
    },
    roles: { type: "array" },
    ledger: { type: "array" },
    qaOracle: { type: "object" },
  },
} as const;

// ---------------------------------------------------------------------------
// Validation surface
// ---------------------------------------------------------------------------

export class ProviderProofBundleValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly rule: string,
    public readonly detail: string,
  ) {
    super(`ProviderProofBundle.${path} failed rule '${rule}': ${detail}`);
    this.name = "ProviderProofBundleValidationError";
  }
}

function fail(path: string, rule: string, detail: string): never {
  throw new ProviderProofBundleValidationError(path, rule, detail);
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
  return value;
}

function assertNullableString(value: unknown, path: string): string | null {
  if (value === null) {
    return null;
  }
  return assertString(value, path);
}

function assertNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(path, "type", "expected non-negative integer");
  }
  return value;
}

function assertFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "type", "expected finite number");
  }
  return value;
}

function assertBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    fail(path, "type", "expected boolean");
  }
  return value;
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
  return value.map((entry, index) => assertString(entry, `${path}[${index}]`));
}

const ATTEMPT_OUTCOMES = ["accepted", "rejected_schema_invalid"] as const;
const RETRY_STATES = ["initial", "repair"] as const;

function assertAttempt(value: unknown, path: string): void {
  const record = assertObject(value, path);
  assertNonNegativeInteger(record.attemptIndex, `${path}.attemptIndex`);
  assertEnum(record.retryState, RETRY_STATES, `${path}.retryState`);
  if (record.retryReason !== null) {
    assertString(record.retryReason, `${path}.retryReason`);
  }
  const outcome = assertEnum(record.outcome, ATTEMPT_OUTCOMES, `${path}.outcome`);
  if (outcome === "rejected_schema_invalid") {
    const rejection = assertObject(record.rejection, `${path}.rejection`);
    assertString(rejection.rule, `${path}.rejection.rule`);
    assertString(rejection.detail, `${path}.rejection.detail`);
    if (typeof rejection.path !== "string") {
      fail(`${path}.rejection.path`, "type", "expected string");
    }
  } else if (record.rejection !== null) {
    fail(`${path}.rejection`, "const", "accepted attempt must carry rejection=null");
  }
  assertString(record.providerProofId, `${path}.providerProofId`);
  assertString(record.requestedModelId, `${path}.requestedModelId`);
  assertString(record.requestedProviderId, `${path}.requestedProviderId`);
  assertString(record.servedModel, `${path}.servedModel`);
  assertString(record.servedProvider, `${path}.servedProvider`);
  assertString(record.requestedRoute, `${path}.requestedRoute`);
  assertString(record.servedRoute, `${path}.servedRoute`);
  assertString(record.structuredOutputMode, `${path}.structuredOutputMode`);
  assertNonNegativeInteger(record.tokensIn, `${path}.tokensIn`);
  assertNonNegativeInteger(record.tokensOut, `${path}.tokensOut`);
  assertString(record.tokenCountSource, `${path}.tokenCountSource`);
  assertString(record.costUsd, `${path}.costUsd`);
  assertNonNegativeInteger(record.costMicrosUsd, `${path}.costMicrosUsd`);
  assertNonNegativeInteger(record.latencyMs, `${path}.latencyMs`);
  assertBoolean(record.zdr, `${path}.zdr`);
  assertString(record.promptHash, `${path}.promptHash`);
}

function assertRole(value: unknown, path: string): void {
  const record = assertObject(value, path);
  assertEnum(record.role, PROVIDER_PROOF_ROLE_NAMES, `${path}.role`);
  const terminal = assertEnum(record.terminalStatus, ATTEMPT_OUTCOMES, `${path}.terminalStatus`);
  assertNullableString(record.acceptedProviderProofId, `${path}.acceptedProviderProofId`);
  assertNullableString(record.acceptedOutputHash, `${path}.acceptedOutputHash`);
  if (record.acceptedItemCount !== null) {
    assertNonNegativeInteger(record.acceptedItemCount, `${path}.acceptedItemCount`);
  }
  if (!Array.isArray(record.attempts) || record.attempts.length === 0) {
    fail(`${path}.attempts`, "minItems", "expected at least one attempt");
  }
  record.attempts.forEach((attempt, index) => assertAttempt(attempt, `${path}.attempts[${index}]`));
  // reject-before-record invariant: a terminally-accepted role MUST name its
  // accepted proof id + output hash; a terminally-rejected role MUST NOT.
  if (terminal === "accepted") {
    assertString(record.acceptedProviderProofId, `${path}.acceptedProviderProofId`);
    assertString(record.acceptedOutputHash, `${path}.acceptedOutputHash`);
  } else if (record.acceptedProviderProofId !== null || record.acceptedOutputHash !== null) {
    fail(
      `${path}.acceptedProviderProofId`,
      "const",
      "rejected role must not name an accepted proof",
    );
  }
}

function assertLedgerRow(value: unknown, path: string): void {
  const record = assertObject(value, path);
  assertString(record.providerProofId, `${path}.providerProofId`);
  assertEnum(record.role, PROVIDER_PROOF_ROLE_NAMES, `${path}.role`);
  assertString(record.modelId, `${path}.modelId`);
  assertString(record.providerId, `${path}.providerId`);
  assertString(record.servedProvider, `${path}.servedProvider`);
  assertString(record.servedModel, `${path}.servedModel`);
  assertNonNegativeInteger(record.tokensIn, `${path}.tokensIn`);
  assertNonNegativeInteger(record.tokensOut, `${path}.tokensOut`);
  assertString(record.tokenCountSource, `${path}.tokenCountSource`);
  assertString(record.costUnit, `${path}.costUnit`);
  assertString(record.costAmount, `${path}.costAmount`);
  assertNonNegativeInteger(record.costMicrosUsd, `${path}.costMicrosUsd`);
  assertNonNegativeInteger(record.latencyMs, `${path}.latencyMs`);
  assertBoolean(record.zdr, `${path}.zdr`);
  assertString(record.promptHash, `${path}.promptHash`);
}

function assertQaOracle(value: unknown, path: string): void {
  const record = assertObject(value, path);
  assertNonNegativeInteger(record.seededDefectCount, `${path}.seededDefectCount`);
  assertNonNegativeInteger(record.emittedFindingCount, `${path}.emittedFindingCount`);
  assertNonNegativeInteger(record.truePositives, `${path}.truePositives`);
  assertNonNegativeInteger(record.falsePositives, `${path}.falsePositives`);
  assertNonNegativeInteger(record.falseNegatives, `${path}.falseNegatives`);
  assertFiniteNumber(record.precision, `${path}.precision`);
  assertFiniteNumber(record.recall, `${path}.recall`);
  assertFiniteNumber(record.f1, `${path}.f1`);
  assertFiniteNumber(record.severityCalibration, `${path}.severityCalibration`);
  assertStringArray(record.matchedSeededDefectIds, `${path}.matchedSeededDefectIds`);
  assertStringArray(record.falseNegativeSeededDefectIds, `${path}.falseNegativeSeededDefectIds`);
  assertStringArray(record.falsePositiveBridgeUnitIds, `${path}.falsePositiveBridgeUnitIds`);
}

/**
 * Validate a parsed value against the `ProviderProofBundle` schema. Throws
 * `ProviderProofBundleValidationError` on the first divergence; returns the
 * value with the precise type asserted.
 */
export function assertProviderProofBundle(value: unknown): asserts value is ProviderProofBundle {
  const record = assertObject(value, "");
  if (record.schemaVersion !== PROVIDER_PROOF_BUNDLE_SCHEMA_VERSION) {
    fail(
      "schemaVersion",
      "const",
      `expected ${PROVIDER_PROOF_BUNDLE_SCHEMA_VERSION}, got ${String(record.schemaVersion)}`,
    );
  }
  assertString(record.proofId, "proofId");
  assertEnum(record.mode, ["recorded", "live"], "mode");
  assertString(record.fixtureId, "fixtureId");
  assertNonNegativeInteger(record.maxRepairAttempts, "maxRepairAttempts");
  const zdr = assertObject(record.zdr, "zdr");
  assertEnum(zdr.accountAssertion, ["asserted", "recorded_fixture"], "zdr.accountAssertion");
  assertBoolean(zdr.perRequestZdr, "zdr.perRequestZdr");
  if (!Array.isArray(record.roles) || record.roles.length === 0) {
    fail("roles", "minItems", "expected at least one role");
  }
  record.roles.forEach((role, index) => assertRole(role, `roles[${index}]`));
  if (!Array.isArray(record.ledger)) {
    fail("ledger", "type", "expected array");
  }
  record.ledger.forEach((row, index) => assertLedgerRow(row, `ledger[${index}]`));
  assertQaOracle(record.qaOracle, "qaOracle");
}

export function parseProviderProofBundle(raw: string): ProviderProofBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(
      "",
      "json",
      `provider-proof bundle is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertProviderProofBundle(parsed);
  return parsed;
}
