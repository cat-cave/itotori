// ITOTORI-025 — PatchExportPreflight tests.
//
// One positive + one negative case per check (five checks → ten
// scenarios), plus a runAll integration scenario verifying the
// result-order contract.

import { describe, expect, it } from "vitest";
import {
  asNonBlankTargetText,
  DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION,
  type DraftArtifactBundle,
} from "@itotori/localization-bridge-schema";
import { PatchExportPreflight } from "../src/patch-export/preflight.js";
import type { PreflightInput } from "../src/patch-export/preflight.js";
import type {
  SourceBridgeAssetRef,
  SourceBridgeUnit,
  SourceBridgeView,
} from "../src/patch-export/source-bridge-view.js";

const PROJECT_ID = "project-itotori-025";
const LOCALE_BRANCH_ID = "locale-branch-en-US";
const TARGET_LOCALE = "en-US";
const SOURCE_BRIDGE_HASH = "sha256:bridge-001";

function makeSourceBridgeUnit(overrides: Partial<SourceBridgeUnit> = {}): SourceBridgeUnit {
  return {
    sourceUnitId: "unit-001",
    sourceText: "こんにちは、{player}。",
    sourceUnitHash: "sha256:unit-001",
    assetRefs: [],
    protectedSpans: [
      {
        spanRef: "span-001",
        sourceStart: 5,
        sourceEnd: 13,
        sourceText: "{player}",
        kind: "variable",
        preservationRule: "verbatim",
      },
    ],
    ...overrides,
  };
}

function makeSourceBridgeView(
  units: SourceBridgeUnit[] = [makeSourceBridgeUnit()],
): SourceBridgeView {
  return {
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceBridgeHash: SOURCE_BRIDGE_HASH,
    targetLocale: TARGET_LOCALE,
    units,
  };
}

function makeDraftBundle(overrides: Partial<DraftArtifactBundle> = {}): DraftArtifactBundle {
  return {
    schemaVersion: DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION,
    draftJobId: "draft-job-001",
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    drafts: [makeDraftEntry()],
    ledgerSummary: {
      totalCost: "0.00000000",
      totalTokensIn: 0,
      totalTokensOut: 0,
      attemptCount: 1,
      providerProofIds: ["proof-001"],
    },
    ...overrides,
  };
}

function makeDraftEntry(
  overrides: {
    sourceUnitId?: string;
    draftId?: string;
    selectedBody?: string;
    targetLocale?: string;
    qualityFlags?: string[];
  } = {},
): DraftArtifactBundle["drafts"][number] {
  const sourceUnitId = overrides.sourceUnitId ?? "unit-001";
  const draftId = overrides.draftId ?? "draft-001";
  const outcomeId = `outcome:${draftId}`;
  const candidateId = `${outcomeId}:selected`;
  return {
    sourceUnitId,
    draftId,
    providerProofId: "proof-001",
    costLedgerEntryRef: "ledger-001",
    writtenOutcome: {
      id: outcomeId,
      status: "written",
      unitId: sourceUnitId,
      targetLocale: overrides.targetLocale ?? TARGET_LOCALE,
      selectedCandidateId: candidateId,
      candidates: [
        {
          id: candidateId,
          outcomeId,
          body: asNonBlankTargetText(overrides.selectedBody ?? "Hello, {player}."),
          producedBy: { modelId: "fixture-model", providerId: "fixture-provider" },
          attemptId: `attempt:${draftId}`,
          kind: "primary",
        },
      ],
      findings: [],
      qualityFlags: overrides.qualityFlags ?? [],
      provenance: { fixture: true },
      writtenAt: "2026-07-11T00:00:00.000Z",
    },
  };
}

function baseInput(overrides: Partial<PreflightInput> = {}): PreflightInput {
  const view = overrides.sourceBridgeView ?? makeSourceBridgeView();
  return {
    draftArtifactBundle: overrides.draftArtifactBundle ?? makeDraftBundle(),
    sourceBridgeView: view,
    declaredSourceBridgeHash: overrides.declaredSourceBridgeHash ?? view.sourceBridgeHash,
    resolveAssetPolicy:
      overrides.resolveAssetPolicy ??
      (async () => ({ policy: "unresolved", reason: "no_decision" })),
    ...(overrides.scoredFindingsReport === undefined
      ? {}
      : { scoredFindingsReport: overrides.scoredFindingsReport }),
    ...(overrides.draftGlossaryRenderings === undefined
      ? {}
      : { draftGlossaryRenderings: overrides.draftGlossaryRenderings }),
  };
}

describe("PatchExportPreflight", () => {
  describe("sourceBridgeIntegrity", () => {
    it("passes when declared hash matches the view hash", () => {
      const preflight = new PatchExportPreflight();
      const result = preflight.sourceBridgeIntegrity(baseInput());
      expect(result.status).toBe("pass");
      expect(result.blockingExport).toBe(false);
    });

    it("blocks export when declared hash drifts from the view hash", () => {
      const preflight = new PatchExportPreflight();
      const result = preflight.sourceBridgeIntegrity(
        baseInput({ declaredSourceBridgeHash: "sha256:stale-bridge-001" }),
      );
      expect(result.status).toBe("fail");
      expect(result.blockingExport).toBe(true);
      expect(result.detail).toContain("sha256:stale-bridge-001");
    });
  });

  describe("noUnresolvedAssetDecisions", () => {
    const assetRef: SourceBridgeAssetRef = {
      kind: "bridgeAssetRef",
      ref: "asset.json#image",
      assetKind: "image_with_text",
    };
    const viewWithAsset = makeSourceBridgeView([makeSourceBridgeUnit({ assetRefs: [assetRef] })]);

    it("passes when every referenced asset has a resolved policy", async () => {
      const preflight = new PatchExportPreflight();
      const result = await preflight.noUnresolvedAssetDecisions(
        baseInput({
          sourceBridgeView: viewWithAsset,
          resolveAssetPolicy: async () => ({
            policy: "translate_text",
            decidedAt: new Date("2026-06-24T00:00:00Z"),
            decidedByUserId: "user-1",
          }),
        }),
      );
      expect(result.status).toBe("pass");
      expect(result.blockingExport).toBe(false);
    });

    it("blocks export when any referenced asset has no decision", async () => {
      const preflight = new PatchExportPreflight();
      const result = await preflight.noUnresolvedAssetDecisions(
        baseInput({
          sourceBridgeView: viewWithAsset,
          resolveAssetPolicy: async () => ({
            policy: "unresolved",
            reason: "no_decision",
          }),
        }),
      );
      expect(result.status).toBe("fail");
      expect(result.blockingExport).toBe(true);
      expect(result.detail).toContain("bridgeAssetRef:asset.json#image");
    });
  });

  describe("protectedSpanCoverage", () => {
    it("passes when every protected span appears in the draft", () => {
      const preflight = new PatchExportPreflight();
      const result = preflight.protectedSpanCoverage(baseInput());
      expect(result.status).toBe("pass");
    });

    it("passes when an out-of-band span is omitted from the draft", () => {
      const view = makeSourceBridgeView([
        makeSourceBridgeUnit({
          sourceText: "<synthetic-control>こんにちは。",
          protectedSpans: [
            {
              spanRef: "span-oob",
              sourceStart: 0,
              sourceEnd: "<synthetic-control>".length,
              sourceText: "<synthetic-control>",
              kind: "markup",
              preservationRule: "markup_well_formed",
              outOfBand: true,
            },
          ],
        }),
      ]);
      const bundle = makeDraftBundle({
        drafts: [makeDraftEntry({ selectedBody: "Hello." })],
      });
      const result = new PatchExportPreflight().protectedSpanCoverage(
        baseInput({ sourceBridgeView: view, draftArtifactBundle: bundle }),
      );
      expect(result.status).toBe("pass");
    });

    it("blocks when a written outcome is missing even if the unit has only out-of-band spans", () => {
      const view = makeSourceBridgeView([
        makeSourceBridgeUnit({
          protectedSpans: [
            {
              spanRef: "span-oob",
              sourceStart: 0,
              sourceEnd: "<control>".length,
              sourceText: "<control>",
              kind: "markup",
              preservationRule: "markup_well_formed",
              outOfBand: true,
            },
          ],
        }),
      ]);
      const result = new PatchExportPreflight().protectedSpanCoverage(
        baseInput({
          sourceBridgeView: view,
          draftArtifactBundle: makeDraftBundle({ drafts: [] }),
        }),
      );
      expect(result.status).toBe("fail");
      expect(result.blockingExport).toBe(true);
      expect(result.detail).toContain("unit-001:no_written_outcome");
    });

    it("blocks duplicate and unknown written outcomes instead of overwriting or ignoring them", () => {
      const bundle = makeDraftBundle({
        drafts: [
          makeDraftEntry(),
          makeDraftEntry({ draftId: "draft-duplicate" }),
          makeDraftEntry({ sourceUnitId: "unknown-unit", draftId: "draft-unknown" }),
        ],
      });
      const result = new PatchExportPreflight().protectedSpanCoverage(
        baseInput({ draftArtifactBundle: bundle }),
      );
      expect(result.status).toBe("fail");
      expect(result.blockingExport).toBe(true);
      expect(result.detail).toContain("duplicate written outcomes: unit-001");
      expect(result.detail).toContain("unknown written outcomes: unknown-unit");
    });

    it("still blocks when a non-out-of-band control markup span is dropped", () => {
      const view = makeSourceBridgeView([
        makeSourceBridgeUnit({
          sourceText: "<control>こんにちは。",
          protectedSpans: [
            {
              spanRef: "span-control",
              sourceStart: 0,
              sourceEnd: "<control>".length,
              sourceText: "<control>",
              kind: "markup",
              preservationRule: "markup_well_formed",
            },
          ],
        }),
      ]);
      const bundle = makeDraftBundle({
        drafts: [makeDraftEntry({ selectedBody: "Hello." })],
      });
      const result = new PatchExportPreflight().protectedSpanCoverage(
        baseInput({ sourceBridgeView: view, draftArtifactBundle: bundle }),
      );
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("unit-001:span-control");
    });

    it("blocks export when a protected span is missing from the draft", () => {
      const preflight = new PatchExportPreflight();
      const bundle = makeDraftBundle({
        drafts: [makeDraftEntry({ selectedBody: "Hello, friend." })], // {player} removed
      });
      const result = preflight.protectedSpanCoverage(baseInput({ draftArtifactBundle: bundle }));
      expect(result.status).toBe("fail");
      expect(result.blockingExport).toBe(true);
      expect(result.detail).toContain("unit-001:span-001");
    });
  });

  describe("qaScoreThreshold", () => {
    it("passes when the score meets the threshold", () => {
      const preflight = new PatchExportPreflight({ qaScoreThreshold: 0.7 });
      const result = preflight.qaScoreThreshold(
        baseInput({ scoredFindingsReport: { overall: 0.85 } }),
      );
      expect(result.status).toBe("pass");
      expect(result.blockingExport).toBe(false);
    });

    it("warns (non-blocking) when the score is below the threshold", () => {
      const preflight = new PatchExportPreflight({ qaScoreThreshold: 0.7 });
      const result = preflight.qaScoreThreshold(
        baseInput({ scoredFindingsReport: { overall: 0.5 } }),
      );
      expect(result.status).toBe("warn");
      expect(result.blockingExport).toBe(false);
      expect(result.detail).toContain("0.5");
    });

    it("warns (non-blocking) when no scored findings report is supplied", () => {
      const preflight = new PatchExportPreflight();
      const result = preflight.qaScoreThreshold(baseInput());
      expect(result.status).toBe("warn");
      expect(result.blockingExport).toBe(false);
      expect(result.detail).toBe("no_report_provided");
    });
  });

  describe("glossaryConsistency", () => {
    it("passes when every glossary term renders consistently across drafts", () => {
      const preflight = new PatchExportPreflight();
      const result = preflight.glossaryConsistency(
        baseInput({
          draftGlossaryRenderings: [
            { termId: "hero", sourceUnitId: "unit-001", renderedTargetForm: "Hero" },
            { termId: "hero", sourceUnitId: "unit-002", renderedTargetForm: "Hero" },
          ],
        }),
      );
      expect(result.status).toBe("pass");
    });

    it("warns (non-blocking) when a glossary term is rendered inconsistently", () => {
      const preflight = new PatchExportPreflight();
      const result = preflight.glossaryConsistency(
        baseInput({
          draftGlossaryRenderings: [
            { termId: "hero", sourceUnitId: "unit-001", renderedTargetForm: "Hero" },
            { termId: "hero", sourceUnitId: "unit-002", renderedTargetForm: "Champion" },
          ],
        }),
      );
      expect(result.status).toBe("warn");
      expect(result.blockingExport).toBe(false);
      expect(result.detail).toContain("hero");
    });
  });

  describe("runAll", () => {
    it("returns one result per check in a fixed order", async () => {
      const preflight = new PatchExportPreflight();
      const results = await preflight.runAll(baseInput());
      expect(results.map((r) => r.check)).toEqual([
        "sourceBridgeIntegrity",
        "noUnresolvedAssetDecisions",
        "protectedSpanCoverage",
        "qaScoreThreshold",
        "glossaryConsistency",
      ]);
    });
  });
});
