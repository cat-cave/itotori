// ITOTORI-019 — DraftArtifactBundle schema tests.
//
// Covers the wire-shape contract:
//   - accepted bundle round-trips through assertDraftArtifactBundle.
//   - parseDraftArtifactBundle wraps JSON.parse errors as
//     DraftArtifactBundleValidationError (no silent SyntaxError leak).
//   - terminal-rejection entries MUST carry terminalReason; success
//     states MUST carry draftText.
//   - violation kind / spanKind enums are closed.

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
        protectedSpanValidationResult: { accepted: true },
        retryFallbackState: "success",
        costLedgerEntryRef: "ledger-01",
        draftText: "Hello, {player}.",
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

describe("DraftArtifactBundle", () => {
  it("accepts a well-formed success bundle", () => {
    expect(() => assertDraftArtifactBundle(validBundle())).not.toThrow();
  });

  it("rejects an unknown schemaVersion", () => {
    expect(() => assertDraftArtifactBundle(validBundle({ schemaVersion: "v0.1" }))).toThrow(
      DraftArtifactBundleValidationError,
    );
  });

  it("requires terminalReason on terminal-rejection entries", () => {
    expect(() =>
      assertDraftArtifactBundle(
        validBundle({
          drafts: [
            {
              sourceUnitId: "unit-01",
              draftId: "draft-01",
              providerProofId: "recorded:bundle-01",
              protectedSpanValidationResult: {
                accepted: false,
                violations: [
                  {
                    kind: "capitalization_drift",
                    spanRefId: "span-1",
                    spanKind: "glossary",
                    bridgeUnitId: "unit-01",
                    detail: "expected Hero observed hero",
                  },
                ],
              },
              retryFallbackState: "terminal-rejection",
              costLedgerEntryRef: "ledger-01",
              // missing terminalReason
            },
          ],
        }),
      ),
    ).toThrow(/terminalReason/u);
  });

  it("requires draftText on non-terminal entries", () => {
    expect(() =>
      assertDraftArtifactBundle(
        validBundle({
          drafts: [
            {
              sourceUnitId: "unit-01",
              draftId: "draft-01",
              providerProofId: "recorded:bundle-01",
              protectedSpanValidationResult: { accepted: true },
              retryFallbackState: "success",
              costLedgerEntryRef: "ledger-01",
              // missing draftText
            },
          ],
        }),
      ),
    ).toThrow(/draftText/u);
  });

  it("rejects an unknown retryFallbackState", () => {
    expect(() =>
      assertDraftArtifactBundle(
        validBundle({
          drafts: [
            {
              sourceUnitId: "unit-01",
              draftId: "draft-01",
              providerProofId: "recorded:bundle-01",
              protectedSpanValidationResult: { accepted: true },
              retryFallbackState: "unknown-state",
              costLedgerEntryRef: "ledger-01",
              draftText: "Hello.",
            },
          ],
        }),
      ),
    ).toThrow(/retryFallbackState/u);
  });

  it("rejects an unknown violation kind", () => {
    expect(() =>
      assertDraftArtifactBundle(
        validBundle({
          drafts: [
            {
              sourceUnitId: "unit-01",
              draftId: "draft-01",
              providerProofId: "recorded:bundle-01",
              protectedSpanValidationResult: {
                accepted: false,
                violations: [
                  {
                    kind: "obscure_new_kind",
                    spanRefId: "span-1",
                    spanKind: "glossary",
                    bridgeUnitId: "unit-01",
                    detail: "synthetic",
                  },
                ],
              },
              retryFallbackState: "terminal-rejection",
              costLedgerEntryRef: "ledger-01",
              terminalReason: "synthetic terminal reason",
            },
          ],
        }),
      ),
    ).toThrow(/violations\[0\]\.kind/u);
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
