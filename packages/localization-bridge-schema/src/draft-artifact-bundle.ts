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

import {
  AgenticLoopBundleValidationError,
  assertWrittenUnitOutcome,
  type WrittenUnitOutcome,
} from "./agentic-loop-bundle.js";

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
  try {
    assertWrittenUnitOutcome(record.writtenOutcome, `${label}.writtenOutcome`);
  } catch (error) {
    if (error instanceof AgenticLoopBundleValidationError) {
      throw new DraftArtifactBundleValidationError(error.path, error.rule, error.detail);
    }
    throw error;
  }
  const writtenOutcome = record.writtenOutcome as WrittenUnitOutcome;
  if (writtenOutcome.unitId !== record.sourceUnitId) {
    throw new DraftArtifactBundleValidationError(
      `${label}.writtenOutcome.unitId`,
      "unitBinding",
      `must equal sourceUnitId '${String(record.sourceUnitId)}'`,
    );
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
