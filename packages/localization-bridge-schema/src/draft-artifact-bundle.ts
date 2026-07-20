// ITOTORI-019 — DraftArtifactBundle wire schema.
//
// The artifact boundary projects one canonical WrittenUnitOutcome per source
// unit into the patch-export workflow. It intentionally does not define a
// second terminal state: every entry owns a selected, non-blank target body;
// quality and repair history remain on the outcome as annotations.
//
// This differs from StructuredTranslationDraftOutput: that schema describes a
// single model response, while this bundle records the durable, selected
// outcome together with the provider-ledger evidence that funded it.

import { assertNonBlankTargetText, type NonBlankTargetText } from "./target-text.js";

// v2 replaces the optional-draft, no-text union with the canonical
// WrittenUnitOutcome. v1 input is deliberately rejected: callers must migrate
// rather than preserving a no-text compatibility path.
export const DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION = "itotori.draft-artifact-bundle.v2" as const;

/**
 * One persisted written outcome and the ledger proof that funded its selected
 * candidate. `writtenOutcome.unitId` is bound to `sourceUnitId` at runtime.
 */
export type DraftArtifactDraftEntry = {
  sourceUnitId: string;
  draftId: string;
  providerProofId: string;
  costLedgerEntryRef: string;
  writtenOutcome: WrittenUnitOutcome;
};

export type WrittenOutcomeCandidate = {
  id: string;
  outcomeId: string;
  body: NonBlankTargetText;
  producedBy: { modelId: string; providerId: string };
  attemptId: string;
  kind: "primary" | "repair";
};

export type WrittenQaFinding = {
  id: string;
  outcomeId: string;
  candidateId: string;
  severity: "info" | "minor" | "major" | "critical";
  category: string;
  note: string;
  contested: boolean;
  confidence: number;
};

/** The selected, immutable draft outcome consumed by patch export. */
export type WrittenUnitOutcome = {
  id: string;
  status: "written";
  unitId: string;
  targetLocale: string;
  selectedCandidateId: string;
  candidates: WrittenOutcomeCandidate[];
  findings: WrittenQaFinding[];
  qualityFlags: string[];
  provenance: unknown;
  writtenAt: string;
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
  const sourceUnitIds = new Set<string>();
  for (const [index, entry] of record.drafts.entries()) {
    assertDraftEntry(entry, `drafts[${index}]`);
    const sourceUnitId = (entry as DraftArtifactDraftEntry).sourceUnitId;
    if (sourceUnitIds.has(sourceUnitId)) {
      throw new DraftArtifactBundleValidationError(
        `drafts[${index}].sourceUnitId`,
        "uniqueItems",
        `duplicate sourceUnitId '${sourceUnitId}'`,
      );
    }
    sourceUnitIds.add(sourceUnitId);
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
    "costLedgerEntryRef",
    "writtenOutcome",
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
  assertWrittenUnitOutcome(record.writtenOutcome, `${label}.writtenOutcome`);
  const writtenOutcome = record.writtenOutcome as WrittenUnitOutcome;
  if (writtenOutcome.unitId !== record.sourceUnitId) {
    throw new DraftArtifactBundleValidationError(
      `${label}.writtenOutcome.unitId`,
      "unitBinding",
      `must equal sourceUnitId '${String(record.sourceUnitId)}'`,
    );
  }
}

function assertWrittenUnitOutcome(
  value: unknown,
  label: string,
): asserts value is WrittenUnitOutcome {
  const record = assertObject(value, label);
  assertOnlyKeys(
    record,
    [
      "id",
      "status",
      "unitId",
      "targetLocale",
      "selectedCandidateId",
      "candidates",
      "findings",
      "qualityFlags",
      "provenance",
      "writtenAt",
    ],
    label,
  );
  assertTrimmedNonEmptyString(record.id, `${label}.id`);
  if (record.status !== "written") {
    throw new DraftArtifactBundleValidationError(`${label}.status`, "const", "expected 'written'");
  }
  assertTrimmedNonEmptyString(record.unitId, `${label}.unitId`);
  assertTrimmedNonEmptyString(record.targetLocale, `${label}.targetLocale`);
  assertTrimmedNonEmptyString(record.selectedCandidateId, `${label}.selectedCandidateId`);
  if (!Array.isArray(record.candidates) || record.candidates.length === 0) {
    throw new DraftArtifactBundleValidationError(
      `${label}.candidates`,
      "minItems",
      "must contain at least one candidate",
    );
  }
  const candidateIds = new Set<string>();
  for (const [index, candidate] of record.candidates.entries()) {
    assertWrittenOutcomeCandidate(
      candidate,
      `${label}.candidates[${index}]`,
      record.id,
      candidateIds,
    );
  }
  if (!candidateIds.has(record.selectedCandidateId)) {
    throw new DraftArtifactBundleValidationError(
      `${label}.selectedCandidateId`,
      "reference",
      "must resolve to a candidate",
    );
  }
  if (!Array.isArray(record.findings)) {
    throw new DraftArtifactBundleValidationError(`${label}.findings`, "type", "expected array");
  }
  const findingIds = new Set<string>();
  for (const [index, finding] of record.findings.entries()) {
    assertWrittenQaFinding(
      finding,
      `${label}.findings[${index}]`,
      record.id,
      candidateIds,
      findingIds,
    );
  }
  if (!Array.isArray(record.qualityFlags)) {
    throw new DraftArtifactBundleValidationError(`${label}.qualityFlags`, "type", "expected array");
  }
  const qualityFlags = new Set<string>();
  for (const [index, flag] of record.qualityFlags.entries()) {
    assertTrimmedNonEmptyString(flag, `${label}.qualityFlags[${index}]`);
    if (qualityFlags.has(flag)) {
      throw new DraftArtifactBundleValidationError(
        `${label}.qualityFlags[${index}]`,
        "uniqueItems",
        `duplicate quality flag '${flag}'`,
      );
    }
    qualityFlags.add(flag);
  }
  if (!("provenance" in record)) {
    throw new DraftArtifactBundleValidationError(
      `${label}.provenance`,
      "required",
      "missing value",
    );
  }
  assertTrimmedNonEmptyString(record.writtenAt, `${label}.writtenAt`);
}

function assertWrittenOutcomeCandidate(
  value: unknown,
  label: string,
  outcomeId: unknown,
  candidateIds: Set<string>,
): void {
  const record = assertObject(value, label);
  assertOnlyKeys(record, ["id", "outcomeId", "body", "producedBy", "attemptId", "kind"], label);
  assertTrimmedNonEmptyString(record.id, `${label}.id`);
  if (candidateIds.has(record.id)) {
    throw new DraftArtifactBundleValidationError(
      `${label}.id`,
      "uniqueItems",
      "duplicate candidate id",
    );
  }
  candidateIds.add(record.id);
  if (record.outcomeId !== outcomeId) {
    throw new DraftArtifactBundleValidationError(
      `${label}.outcomeId`,
      "outcomeBinding",
      "must equal outcome id",
    );
  }
  try {
    assertNonBlankTargetText(record.body, `${label}.body`);
  } catch (error) {
    throw new DraftArtifactBundleValidationError(
      `${label}.body`,
      "targetText",
      error instanceof Error ? error.message : String(error),
    );
  }
  const producedBy = assertObject(record.producedBy, `${label}.producedBy`);
  assertOnlyKeys(producedBy, ["modelId", "providerId"], `${label}.producedBy`);
  assertTrimmedNonEmptyString(producedBy.modelId, `${label}.producedBy.modelId`);
  assertTrimmedNonEmptyString(producedBy.providerId, `${label}.producedBy.providerId`);
  assertTrimmedNonEmptyString(record.attemptId, `${label}.attemptId`);
  if (record.kind !== "primary" && record.kind !== "repair") {
    throw new DraftArtifactBundleValidationError(
      `${label}.kind`,
      "enum",
      "expected primary or repair",
    );
  }
}

function assertWrittenQaFinding(
  value: unknown,
  label: string,
  outcomeId: unknown,
  candidateIds: ReadonlySet<string>,
  findingIds: Set<string>,
): void {
  const record = assertObject(value, label);
  assertOnlyKeys(
    record,
    ["id", "outcomeId", "candidateId", "severity", "category", "note", "contested", "confidence"],
    label,
  );
  assertTrimmedNonEmptyString(record.id, `${label}.id`);
  if (findingIds.has(record.id)) {
    throw new DraftArtifactBundleValidationError(
      `${label}.id`,
      "uniqueItems",
      "duplicate finding id",
    );
  }
  findingIds.add(record.id);
  if (record.outcomeId !== outcomeId) {
    throw new DraftArtifactBundleValidationError(
      `${label}.outcomeId`,
      "outcomeBinding",
      "must equal outcome id",
    );
  }
  assertTrimmedNonEmptyString(record.candidateId, `${label}.candidateId`);
  if (!candidateIds.has(record.candidateId)) {
    throw new DraftArtifactBundleValidationError(
      `${label}.candidateId`,
      "reference",
      "must resolve to a candidate",
    );
  }
  if (!(["info", "minor", "major", "critical"] as const).includes(record.severity as never)) {
    throw new DraftArtifactBundleValidationError(`${label}.severity`, "enum", "invalid severity");
  }
  assertTrimmedNonEmptyString(record.category, `${label}.category`);
  assertTrimmedNonEmptyString(record.note, `${label}.note`);
  if (typeof record.contested !== "boolean") {
    throw new DraftArtifactBundleValidationError(`${label}.contested`, "type", "expected boolean");
  }
  if (
    typeof record.confidence !== "number" ||
    !Number.isFinite(record.confidence) ||
    record.confidence < 0 ||
    record.confidence > 1
  ) {
    throw new DraftArtifactBundleValidationError(
      `${label}.confidence`,
      "range",
      "expected 0 through 1",
    );
  }
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DraftArtifactBundleValidationError(label, "type", "expected object");
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new DraftArtifactBundleValidationError(
        `${label}.${key}`,
        "additionalProperties",
        `unexpected property ${key}`,
      );
    }
  }
}

function assertTrimmedNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DraftArtifactBundleValidationError(label, "minLength", "must be non-blank");
  }
  if (value !== value.trim()) {
    throw new DraftArtifactBundleValidationError(label, "trimmed", "must be trimmed");
  }
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
