// ITOTORI-019 — DraftArtifactBundle wire schema.
//
// The drafting fixture command (apps/itotori/src/draft/draft-fixture-command.ts)
// writes one of these bundles per run. The bundle is the deterministic,
// fixture-mode summary of the drafting loop's structural outcome:
//
//   - which drafts each source unit produced (or failed to produce);
//   - which provider proof / recorded artifact persisted them;
//   - whether the protected-span validator accepted the result;
//   - whether the retry policy escalated through retry / fallback /
//     terminal rejection;
//   - which ledger entry id captured the cost + provenance.
//
// The schema version is locked to a literal so any change forces a
// downstream consumer migration. There is NO silent fallback: a
// terminal rejection is a typed `retryFallbackState` value, NOT a
// missing draft.
//
// The bundle is intentionally separate from the wire shape of
// `StructuredTranslationDraftOutput` (translation-draft.ts) — the
// agent owns the per-attempt response wire; this bundle owns the
// per-job artifact wire.

export const DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION = "itotori.draft-artifact-bundle.v1" as const;

/**
 * Closed enum of acceptance-time protected-span violation kinds that
 * the drafting fixture command may surface in a terminal-rejection
 * bundle entry. The set MUST match
 * `apps/itotori/src/draft/protected-span-validator.ts`'s
 * `DRAFT_PROTECTED_SPAN_VIOLATION_KINDS`; the schema package owns the
 * wire enum, the validator package owns the runtime kinds, and the
 * downstream `assertDraftArtifactBundle` validates the wire surface.
 */
export const DRAFT_ARTIFACT_BUNDLE_VIOLATION_KINDS = [
  "span_deleted",
  "span_moved",
  "span_duplicated",
  "malformed_markup",
  "capitalization_drift",
  "variable_substituted",
  "glossary_mistranslation",
] as const;
export type DraftArtifactBundleViolationKind =
  (typeof DRAFT_ARTIFACT_BUNDLE_VIOLATION_KINDS)[number];

export const DRAFT_ARTIFACT_BUNDLE_VIOLATION_SPAN_KINDS = [
  "source_unit",
  "markup",
  "variable",
  "glossary",
] as const;
export type DraftArtifactBundleViolationSpanKind =
  (typeof DRAFT_ARTIFACT_BUNDLE_VIOLATION_SPAN_KINDS)[number];

/**
 * Closed enum naming the structural outcome the orchestrator routed
 * the draft through:
 *
 *   - `success`                  — accepted on the first attempt with the
 *                                  primary provider.
 *   - `retried-then-success`     — at least one retryable attempt failed
 *                                  (schema_validation / span_moved / etc.)
 *                                  before the final accepted attempt with
 *                                  the SAME provider.
 *   - `fallback-then-success`    — primary provider failed
 *                                  (provider_capability / unrecoverable
 *                                  error) and a fallback provider produced
 *                                  the accepted draft.
 *   - `terminal-rejection`       — every attempt was rejected; the draft
 *                                  is NOT persisted and the entry records
 *                                  the violation set + the terminal reason.
 */
export const DRAFT_ARTIFACT_RETRY_FALLBACK_STATES = [
  "success",
  "retried-then-success",
  "fallback-then-success",
  "terminal-rejection",
] as const;
export type DraftArtifactRetryFallbackState = (typeof DRAFT_ARTIFACT_RETRY_FALLBACK_STATES)[number];

/**
 * Per-source-unit entry in the bundle. The bundle never omits a
 * source unit — a unit that terminally rejected gets an entry with
 * `retryFallbackState: 'terminal-rejection'` and its violation set.
 *
 * `protectedSpanValidationResult` mirrors the structural validator
 * output: `accepted: true` means the gate's validator passed (this
 * entry's draft persisted); `accepted: false` means at least one
 * violation surfaced (only emitted on `terminal-rejection`).
 *
 * `costLedgerEntryRef` is the `ledger_entry_id` of the draft attempt
 * provider ledger row that funded the accepted draft. For terminal
 * rejections it points at the LAST attempt's ledger row.
 */
export type DraftArtifactProtectedSpanViolation = {
  kind: DraftArtifactBundleViolationKind;
  spanRefId: string;
  spanKind: DraftArtifactBundleViolationSpanKind;
  bridgeUnitId: string;
  detail: string;
};

export type DraftArtifactProtectedSpanValidationResult =
  | { accepted: true }
  | {
      accepted: false;
      violations: DraftArtifactProtectedSpanViolation[];
    };

export type DraftArtifactDraftEntry = {
  sourceUnitId: string;
  draftId: string;
  providerProofId: string;
  protectedSpanValidationResult: DraftArtifactProtectedSpanValidationResult;
  retryFallbackState: DraftArtifactRetryFallbackState;
  costLedgerEntryRef: string;
  draftText?: string;
  terminalReason?: string;
};

export type DraftArtifactLedgerSummary = {
  totalCost: string;
  totalTokensIn: number;
  totalTokensOut: number;
  attemptCount: number;
  providerProofIds: string[];
};

export type DraftArtifactBundle = {
  schemaVersion: typeof DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION;
  draftJobId: string;
  projectId: string;
  localeBranchId: string;
  drafts: DraftArtifactDraftEntry[];
  ledgerSummary: DraftArtifactLedgerSummary;
};

// ---------------------------------------------------------------------------
// Validation surface
// ---------------------------------------------------------------------------

export class DraftArtifactBundleValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly rule: string,
    public readonly detail: string,
  ) {
    super(`DraftArtifactBundle.${path} failed rule '${rule}': ${detail}`);
    this.name = "DraftArtifactBundleValidationError";
  }
}

const DRAFT_ARTIFACT_VIOLATION_KIND_VALUES: ReadonlyArray<string> = [
  ...DRAFT_ARTIFACT_BUNDLE_VIOLATION_KINDS,
];

const DRAFT_ARTIFACT_VIOLATION_SPAN_KIND_VALUES: ReadonlyArray<string> = [
  ...DRAFT_ARTIFACT_BUNDLE_VIOLATION_SPAN_KINDS,
];

export function assertDraftArtifactBundle(value: unknown): asserts value is DraftArtifactBundle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DraftArtifactBundleValidationError("", "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "draftJobId",
    "projectId",
    "localeBranchId",
    "drafts",
    "ledgerSummary",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new DraftArtifactBundleValidationError(
        key,
        "additionalProperties",
        `unexpected top-level property ${key}`,
      );
    }
  }
  if (record.schemaVersion !== DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION) {
    throw new DraftArtifactBundleValidationError(
      "schemaVersion",
      "const",
      `expected ${DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION}, got ${String(record.schemaVersion)}`,
    );
  }
  assertNonEmptyString(record.draftJobId, "draftJobId");
  assertNonEmptyString(record.projectId, "projectId");
  assertNonEmptyString(record.localeBranchId, "localeBranchId");
  if (!Array.isArray(record.drafts)) {
    throw new DraftArtifactBundleValidationError("drafts", "type", "expected array");
  }
  for (const [index, entry] of record.drafts.entries()) {
    assertDraftEntry(entry, `drafts[${index}]`);
  }
  assertLedgerSummary(record.ledgerSummary, "ledgerSummary");
}

function assertDraftEntry(value: unknown, label: string): asserts value is DraftArtifactDraftEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DraftArtifactBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "sourceUnitId",
    "draftId",
    "providerProofId",
    "protectedSpanValidationResult",
    "retryFallbackState",
    "costLedgerEntryRef",
    "draftText",
    "terminalReason",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new DraftArtifactBundleValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  assertNonEmptyString(record.sourceUnitId, `${label}.sourceUnitId`);
  assertNonEmptyString(record.draftId, `${label}.draftId`);
  assertNonEmptyString(record.providerProofId, `${label}.providerProofId`);
  assertNonEmptyString(record.costLedgerEntryRef, `${label}.costLedgerEntryRef`);
  if (
    typeof record.retryFallbackState !== "string" ||
    !(DRAFT_ARTIFACT_RETRY_FALLBACK_STATES as readonly string[]).includes(record.retryFallbackState)
  ) {
    throw new DraftArtifactBundleValidationError(
      `${label}.retryFallbackState`,
      "enum",
      `must be one of [${DRAFT_ARTIFACT_RETRY_FALLBACK_STATES.join(", ")}]`,
    );
  }
  if (record.draftText !== undefined && typeof record.draftText !== "string") {
    throw new DraftArtifactBundleValidationError(
      `${label}.draftText`,
      "type",
      "expected string when present",
    );
  }
  if (record.terminalReason !== undefined && typeof record.terminalReason !== "string") {
    throw new DraftArtifactBundleValidationError(
      `${label}.terminalReason`,
      "type",
      "expected string when present",
    );
  }
  // Terminal rejections MUST carry a terminalReason; success states MUST
  // include the persisted draftText. This invariant is part of the
  // bundle's no-silent-fallback contract.
  if (record.retryFallbackState === "terminal-rejection") {
    if (typeof record.terminalReason !== "string" || record.terminalReason.length === 0) {
      throw new DraftArtifactBundleValidationError(
        `${label}.terminalReason`,
        "required",
        "terminal-rejection entries must include a non-empty terminalReason",
      );
    }
  } else {
    if (typeof record.draftText !== "string") {
      throw new DraftArtifactBundleValidationError(
        `${label}.draftText`,
        "required",
        `${String(record.retryFallbackState)} entries must include the persisted draftText`,
      );
    }
  }
  assertProtectedSpanValidationResult(
    record.protectedSpanValidationResult,
    `${label}.protectedSpanValidationResult`,
  );
}

function assertProtectedSpanValidationResult(
  value: unknown,
  label: string,
): asserts value is DraftArtifactProtectedSpanValidationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DraftArtifactBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  if (record.accepted === true) {
    const allowed = new Set(["accepted"]);
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) {
        throw new DraftArtifactBundleValidationError(
          `${label}.${key}`,
          "additionalProperties",
          `unexpected property ${key} on accepted result`,
        );
      }
    }
    return;
  }
  if (record.accepted !== false) {
    throw new DraftArtifactBundleValidationError(`${label}.accepted`, "type", "expected boolean");
  }
  if (!Array.isArray(record.violations)) {
    throw new DraftArtifactBundleValidationError(
      `${label}.violations`,
      "type",
      "expected array when accepted is false",
    );
  }
  for (const [index, violation] of record.violations.entries()) {
    assertViolation(violation, `${label}.violations[${index}]`);
  }
}

function assertViolation(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DraftArtifactBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["kind", "spanRefId", "spanKind", "bridgeUnitId", "detail"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new DraftArtifactBundleValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  if (
    typeof record.kind !== "string" ||
    !DRAFT_ARTIFACT_VIOLATION_KIND_VALUES.includes(record.kind)
  ) {
    throw new DraftArtifactBundleValidationError(
      `${label}.kind`,
      "enum",
      `must be one of [${DRAFT_ARTIFACT_VIOLATION_KIND_VALUES.join(", ")}]`,
    );
  }
  if (
    typeof record.spanKind !== "string" ||
    !DRAFT_ARTIFACT_VIOLATION_SPAN_KIND_VALUES.includes(record.spanKind)
  ) {
    throw new DraftArtifactBundleValidationError(
      `${label}.spanKind`,
      "enum",
      `must be one of [${DRAFT_ARTIFACT_VIOLATION_SPAN_KIND_VALUES.join(", ")}]`,
    );
  }
  assertNonEmptyString(record.spanRefId, `${label}.spanRefId`);
  assertNonEmptyString(record.bridgeUnitId, `${label}.bridgeUnitId`);
  assertNonEmptyString(record.detail, `${label}.detail`);
}

function assertLedgerSummary(
  value: unknown,
  label: string,
): asserts value is DraftArtifactLedgerSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DraftArtifactBundleValidationError(label, "type", "expected object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "totalCost",
    "totalTokensIn",
    "totalTokensOut",
    "attemptCount",
    "providerProofIds",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new DraftArtifactBundleValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
  if (typeof record.totalCost !== "string") {
    throw new DraftArtifactBundleValidationError(
      `${label}.totalCost`,
      "type",
      "expected decimal string",
    );
  }
  if (!/^-?\d+(?:\.\d+)?$/u.test(record.totalCost)) {
    throw new DraftArtifactBundleValidationError(
      `${label}.totalCost`,
      "pattern",
      "expected decimal string",
    );
  }
  assertNonNegativeInteger(record.totalTokensIn, `${label}.totalTokensIn`);
  assertNonNegativeInteger(record.totalTokensOut, `${label}.totalTokensOut`);
  assertNonNegativeInteger(record.attemptCount, `${label}.attemptCount`);
  if (!Array.isArray(record.providerProofIds)) {
    throw new DraftArtifactBundleValidationError(
      `${label}.providerProofIds`,
      "type",
      "expected array",
    );
  }
  for (const [index, id] of record.providerProofIds.entries()) {
    assertNonEmptyString(id, `${label}.providerProofIds[${index}]`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new DraftArtifactBundleValidationError(label, "type", "expected string");
  }
  if (value.length === 0) {
    throw new DraftArtifactBundleValidationError(label, "minLength", "must be non-empty");
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new DraftArtifactBundleValidationError(label, "type", "expected integer");
  }
  if (value < 0) {
    throw new DraftArtifactBundleValidationError(label, "minimum", "must be >= 0");
  }
}

/**
 * Strict-parsing wrapper for raw JSON. JSON parse failures are wrapped
 * in `DraftArtifactBundleValidationError` so callers never see a raw
 * `SyntaxError`.
 */
export function parseDraftArtifactBundle(raw: string): DraftArtifactBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DraftArtifactBundleValidationError(
      "",
      "json",
      `bundle is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertDraftArtifactBundle(parsed);
  return parsed;
}
