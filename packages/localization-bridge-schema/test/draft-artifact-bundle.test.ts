// ITOTORI-019 — DraftArtifactBundle schema tests.
//
// Covers the wire-shape contract:
//   - written-outcome bundle round-trips through assertDraftArtifactBundle.
//   - parseDraftArtifactBundle wraps JSON.parse errors as
//     DraftArtifactBundleValidationError (no silent SyntaxError leak).
//   - every entry owns a required, canonical WrittenUnitOutcome.
//   - source-unit and written-outcome identities remain bound one-to-one.

import { describe, expect, it } from "vitest";
import {
  assertDraftArtifactBundle,
  DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION,
  DraftArtifactBundleValidationError,
  parseDraftArtifactBundle,
} from "../src/draft-artifact-bundle.js";

function validBundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION,
    draftJobId: "draft-job-itotori-019-fixture",
    projectId: "project-itotori-019-fixture",
    localeBranchId: "locale-en-US-fixture",
    drafts: [
      {
        sourceUnitId: "unit-01",
        draftId: "draft-01",
        providerProofId: "recorded:bundle-01",
        costLedgerEntryRef: "ledger-01",
        writtenOutcome: validWrittenOutcome(),
      },
    ],
    ledgerSummary: {
      totalCost: "0.00640000",
      totalTokensIn: 512,
      totalTokensOut: 128,
      attemptCount: 1,
      providerProofIds: ["recorded:bundle-01"],
    },
    ...overrides,
  };
}

function validWrittenOutcome(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "outcome-01",
    status: "written",
    unitId: "unit-01",
    targetLocale: "en-US",
    selectedCandidateId: "candidate-01",
    candidates: [
      {
        id: "candidate-01",
        outcomeId: "outcome-01",
        body: "Hello, {player}.",
        producedBy: { modelId: "fixture-model", providerId: "fixture-provider" },
        attemptId: "attempt-01",
        kind: "primary",
      },
    ],
    findings: [],
    qualityFlags: [],
    provenance: { fixture: true },
    writtenAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("DraftArtifactBundle", () => {
  it("accepts a well-formed success bundle", () => {
    expect(() => assertDraftArtifactBundle(validBundle())).not.toThrow();
  });

  it("rejects an unknown schemaVersion", () => {
    expect(() => assertDraftArtifactBundle(validBundle({ schemaVersion: "v0.1" }))).toThrow(
      DraftArtifactBundleValidationError,
    );
  });

  it("requires a canonical written outcome on every entry", () => {
    expect(() =>
      assertDraftArtifactBundle(
        validBundle({
          drafts: [
            {
              sourceUnitId: "unit-01",
              draftId: "draft-01",
              providerProofId: "recorded:bundle-01",
              costLedgerEntryRef: "ledger-01",
              // missing writtenOutcome
            },
          ],
        }),
      ),
    ).toThrow(/writtenOutcome/u);
  });

  it("rejects a written outcome whose selected candidate is blank", () => {
    expect(() =>
      assertDraftArtifactBundle(
        validBundle({
          drafts: [
            {
              sourceUnitId: "unit-01",
              draftId: "draft-01",
              providerProofId: "recorded:bundle-01",
              costLedgerEntryRef: "ledger-01",
              writtenOutcome: validWrittenOutcome({
                candidates: [
                  {
                    id: "candidate-01",
                    outcomeId: "outcome-01",
                    body: "",
                    producedBy: { modelId: "fixture-model", providerId: "fixture-provider" },
                    attemptId: "attempt-01",
                    kind: "primary",
                  },
                ],
              }),
            },
          ],
        }),
      ),
    ).toThrow(/nonBlank/u);
  });

  it("binds each written outcome to its source unit", () => {
    expect(() =>
      assertDraftArtifactBundle(
        validBundle({
          drafts: [
            {
              sourceUnitId: "unit-01",
              draftId: "draft-01",
              providerProofId: "recorded:bundle-01",
              costLedgerEntryRef: "ledger-01",
              writtenOutcome: validWrittenOutcome({ unitId: "other-unit" }),
            },
          ],
        }),
      ),
    ).toThrow(/unitBinding/u);
  });

  it("rejects duplicate source-unit entries", () => {
    expect(() =>
      assertDraftArtifactBundle(
        validBundle({
          drafts: [
            {
              sourceUnitId: "unit-01",
              draftId: "draft-01",
              providerProofId: "recorded:bundle-01",
              costLedgerEntryRef: "ledger-01",
              writtenOutcome: validWrittenOutcome(),
            },
            {
              sourceUnitId: "unit-01",
              draftId: "draft-02",
              providerProofId: "recorded:bundle-02",
              costLedgerEntryRef: "ledger-02",
              writtenOutcome: validWrittenOutcome(),
            },
          ],
        }),
      ),
    ).toThrow(/duplicate sourceUnitId/u);
  });

  it("parseDraftArtifactBundle wraps JSON parse errors", () => {
    expect(() => parseDraftArtifactBundle("not-json")).toThrow(DraftArtifactBundleValidationError);
  });

  it("parseDraftArtifactBundle returns the typed bundle on success", () => {
    const raw = JSON.stringify(validBundle());
    const out = parseDraftArtifactBundle(raw);
    expect(out.schemaVersion).toBe(DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION);
    expect(out.drafts).toHaveLength(1);
    expect(out.ledgerSummary.providerProofIds).toEqual(["recorded:bundle-01"]);
  });

  it("rejects a non-decimal totalCost", () => {
    expect(() =>
      assertDraftArtifactBundle(
        validBundle({
          ledgerSummary: {
            totalCost: "abc",
            totalTokensIn: 0,
            totalTokensOut: 0,
            attemptCount: 0,
            providerProofIds: [],
          },
        }),
      ),
    ).toThrow(/totalCost/u);
  });
});
