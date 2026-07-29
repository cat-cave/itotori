// DraftArtifactBundle wire schema.
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

/** Returns the selected candidate or reports the one durable selection invariant. */
export function selectedWrittenOutcomeCandidate(
  outcome: WrittenUnitOutcome,
): WrittenOutcomeCandidate {
  const candidate = outcome.candidates.find(
    (candidate) => candidate.id === outcome.selectedCandidateId,
  );
  if (candidate === undefined) {
    throw new Error(
      `written outcome ${outcome.id} has no candidate matching selectedCandidateId ${outcome.selectedCandidateId}`,
    );
  }
  return candidate;
}

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
