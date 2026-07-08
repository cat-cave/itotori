// ITOTORI-025 — PatchExporter integration tests.
//
// Verifies the exporter:
//   1. Assembles a v0.2 PatchExportBundle when every preflight check
//      passes, with all provenance fields populated.
//   2. Returns a typed PreflightFailure (and produces NO bundle) when:
//        - the source-bridge hash drifts (stale draft bundle);
//        - any asset decision is unresolved;
//        - any draft is terminally rejected;
//        - any protected span is missing from a draft.
//   3. Honors the no-partial-bundle invariant.
//   4. The Kaifuu handoff helper produces an engine-agnostic payload
//      that mirrors the v0.2 bundle.

import { describe, expect, it } from "vitest";
import type { AssetDecisionRecord, AuthorizationActor } from "@itotori/db";
import {
  DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION,
  PATCH_EXPORT_BUNDLE_SCHEMA_VERSION,
  type DraftArtifactBundle,
} from "@itotori/localization-bridge-schema";
import { AssetDecisionPolicyResolver } from "../src/asset-decisions/policy-resolver.js";
import {
  PatchExporter,
  type DraftArtifactBundleLoaderPort,
  type PreflightFailure,
  type SourceBridgeViewLoaderPort,
} from "../src/patch-export/exporter.js";
import { PatchExportPreflight } from "../src/patch-export/preflight.js";
import { prepareKaifuuPatchPayload } from "../src/patch-export/kaifuu-handoff.js";
import type { SourceBridgeUnit, SourceBridgeView } from "../src/patch-export/source-bridge-view.js";

const ACTOR: AuthorizationActor = { userId: "exporter-test-actor" };
const PROJECT_ID = "project-itotori-025";
const LOCALE_BRANCH_ID = "locale-branch-en-US";
const TARGET_LOCALE = "en-US";
const SOURCE_BRIDGE_HASH = "sha256:bridge-001";
const DRAFT_JOB_ID = "draft-job-001";
const FIXED_NOW = new Date("2026-06-24T12:00:00Z");

function makeUnit(overrides: Partial<SourceBridgeUnit> = {}): SourceBridgeUnit {
  return {
    sourceUnitId: "unit-001",
    sourceText: "こんにちは、{player}。",
    sourceUnitHash: "sha256:unit-001",
    assetRefs: [
      {
        kind: "bridgeAssetRef",
        ref: "asset.json#title-image",
        assetKind: "image_with_text",
      },
    ],
    protectedSpans: [
      {
        spanRef: "span-001",
        sourceStart: 18,
        sourceEnd: 26,
        sourceText: "{player}",
        kind: "variable",
        preservationRule: "verbatim",
      },
    ],
    ...overrides,
  };
}

function makeView(units: SourceBridgeUnit[] = [makeUnit()]): SourceBridgeView {
  return {
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceBridgeHash: SOURCE_BRIDGE_HASH,
    targetLocale: TARGET_LOCALE,
    units,
  };
}

function makeBundle(overrides: Partial<DraftArtifactBundle> = {}): DraftArtifactBundle {
  return {
    schemaVersion: DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION,
    draftJobId: DRAFT_JOB_ID,
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    drafts: [
      {
        sourceUnitId: "unit-001",
        draftId: "draft-001",
        providerProofId: "proof-001",
        protectedSpanValidationResult: { accepted: true },
        retryFallbackState: "success",
        costLedgerEntryRef: "ledger-001",
        draftText: "Hello, {player}.",
      },
    ],
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

function loaderFor(
  bundle: DraftArtifactBundle,
  sourceBridgeHash: string = SOURCE_BRIDGE_HASH,
): DraftArtifactBundleLoaderPort {
  return {
    async loadByJobId(_actor, draftJobId) {
      if (draftJobId !== bundle.draftJobId) {
        throw new Error(`unexpected draftJobId=${draftJobId}`);
      }
      return { bundle, sourceBridgeHash };
    },
  };
}

function viewLoaderFor(view: SourceBridgeView): SourceBridgeViewLoaderPort {
  return {
    async loadForLocale(_actor, projectId, localeBranchId) {
      if (projectId !== view.projectId || localeBranchId !== view.localeBranchId) {
        throw new Error(`unexpected project/locale ${projectId}/${localeBranchId}`);
      }
      return view;
    },
  };
}

function assetDecisionRecordFor(
  policy: AssetDecisionRecord["decisionPolicy"],
): AssetDecisionRecord {
  return {
    decisionId: "asset-decision-fixture",
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    assetRef: { kind: "bridgeAssetRef", ref: "asset.json#title-image" },
    assetKind: "image_with_text",
    decisionPolicy: policy,
    decisionRationale: "rationale",
    decidedByUserId: "user-decider",
    decidedAt: new Date("2026-06-24T00:00:00Z"),
    supersededAt: null,
    supersededByDecisionId: null,
    createdAt: new Date("2026-06-24T00:00:00Z"),
  };
}

function makeExporter(
  opts: {
    bundle?: DraftArtifactBundle;
    view?: SourceBridgeView;
    decisionRecords?: AssetDecisionRecord[];
  } = {},
): PatchExporter {
  const bundle = opts.bundle ?? makeBundle();
  const view = opts.view ?? makeView();
  const decisionRecords = opts.decisionRecords ?? [assetDecisionRecordFor("translate_text")];
  const repository = {
    async loadActiveDecisions(): Promise<AssetDecisionRecord[]> {
      return decisionRecords;
    },
  };
  return new PatchExporter({
    preflight: new PatchExportPreflight(),
    draftArtifactBundleLoader: loaderFor(bundle),
    sourceBridgeViewLoader: viewLoaderFor(view),
    assetDecisionResolver: new AssetDecisionPolicyResolver(repository),
    now: () => FIXED_NOW,
  });
}

function expectFailure(
  result: Awaited<ReturnType<PatchExporter["export"]>>,
): asserts result is PreflightFailure {
  if (!("kind" in result) || result.kind !== "preflight_failure") {
    throw new Error(`expected PreflightFailure, got bundle: ${JSON.stringify(result)}`);
  }
}

describe("PatchExporter", () => {
  it("assembles a v0.2 patch-export bundle when every check passes", async () => {
    const exporter = makeExporter();
    const result = await exporter.export(ACTOR, {
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      draftArtifactBundleId: DRAFT_JOB_ID,
      requestedBy: "exporter-test-actor",
    });
    if ("kind" in result && result.kind === "preflight_failure") {
      throw new Error(`unexpected preflight failure: ${JSON.stringify(result.failingChecks)}`);
    }
    expect(result.schemaVersion).toBe(PATCH_EXPORT_BUNDLE_SCHEMA_VERSION);
    expect(result.projectId).toBe(PROJECT_ID);
    expect(result.localeBranchId).toBe(LOCALE_BRANCH_ID);
    expect(result.sourceBridgeHash).toBe(SOURCE_BRIDGE_HASH);
    expect(result.targetLocale).toBe(TARGET_LOCALE);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({
      sourceUnitId: "unit-001",
      draftId: "draft-001",
      sourceText: "こんにちは、{player}。",
      draftText: "Hello, {player}.",
      sourceUnitHash: "sha256:unit-001",
    });
    expect(result.drafts[0]?.protectedSpanMappings).toEqual([
      {
        spanRef: "span-001",
        sourceStart: 18,
        sourceEnd: 26,
        draftStart: 7,
        draftEnd: 15,
        kind: "variable",
        preservationRule: "verbatim",
      },
    ]);
    expect(result.assetDecisions).toHaveLength(1);
    expect(result.assetDecisions[0]).toMatchObject({
      assetRef: "bridgeAssetRef:asset.json#title-image",
      assetKind: "image_with_text",
      policy: "translate_text",
      rationale: "rationale",
    });
    expect(result.assetDecisions[0]?.decisionId).toMatch(/^asset-decision:/);
    expect(result.preflightResults).toHaveLength(6);
    expect(
      result.preflightResults.every((entry) => !entry.blockingExport || entry.status !== "fail"),
    ).toBe(true);
    expect(result.provenance).toEqual({
      draftArtifactBundleId: DRAFT_JOB_ID,
      exportedAt: FIXED_NOW.toISOString(),
      exportedByUserId: "exporter-test-actor",
    });
  });

  it("rejects export and produces no partial bundle on source-bridge hash mismatch", async () => {
    // Simulate a draft bundle that was generated against an older
    // bridge revision: the bundle loader reports the drafted-against
    // hash; the view loader reports the CURRENT bridge hash. They
    // disagree → preflight blocks → no bundle.
    const bundle = makeBundle();
    const currentView = makeView();
    const exporter = new PatchExporter({
      preflight: new PatchExportPreflight(),
      draftArtifactBundleLoader: loaderFor(bundle, "sha256:bridge-001-stale"),
      sourceBridgeViewLoader: viewLoaderFor(currentView),
      assetDecisionResolver: new AssetDecisionPolicyResolver({
        async loadActiveDecisions() {
          return [assetDecisionRecordFor("translate_text")];
        },
      }),
      now: () => FIXED_NOW,
    });
    const result = await exporter.export(ACTOR, {
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      draftArtifactBundleId: DRAFT_JOB_ID,
      requestedBy: "exporter-test-actor",
    });
    expectFailure(result);
    expect(result.failingChecks.map((entry) => entry.check)).toContain("sourceBridgeIntegrity");
    expect(result.failingChecks.every((entry) => entry.blockingExport)).toBe(true);
    expect(result.failingChecks[0]?.detail).toContain("sha256:bridge-001-stale");
  });

  it("rejects export on unresolved asset decision (no partial bundle produced)", async () => {
    const exporter = makeExporter({ decisionRecords: [] });
    const result = await exporter.export(ACTOR, {
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      draftArtifactBundleId: DRAFT_JOB_ID,
      requestedBy: "exporter-test-actor",
    });
    expectFailure(result);
    expect(result.failingChecks.map((entry) => entry.check)).toContain(
      "noUnresolvedAssetDecisions",
    );
    expect(result.failingChecks.every((entry) => entry.blockingExport)).toBe(true);
  });

  it("rejects export when a draft was terminally rejected", async () => {
    const bundle = makeBundle({
      drafts: [
        {
          sourceUnitId: "unit-001",
          draftId: "draft-rejected-unit-001",
          providerProofId: "proof-001",
          protectedSpanValidationResult: { accepted: true },
          retryFallbackState: "terminal-rejection",
          costLedgerEntryRef: "ledger-001",
          terminalReason: "model refused to translate",
        },
      ],
    });
    const exporter = makeExporter({ bundle });
    const result = await exporter.export(ACTOR, {
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      draftArtifactBundleId: DRAFT_JOB_ID,
      requestedBy: "exporter-test-actor",
    });
    expectFailure(result);
    expect(result.failingChecks.map((entry) => entry.check)).toContain("allDraftsAccepted");
  });

  it("rejects export when a draft loses a protected span", async () => {
    const bundle = makeBundle({
      drafts: [
        {
          sourceUnitId: "unit-001",
          draftId: "draft-001",
          providerProofId: "proof-001",
          protectedSpanValidationResult: { accepted: true },
          retryFallbackState: "success",
          costLedgerEntryRef: "ledger-001",
          draftText: "Hello, friend.",
        },
      ],
    });
    const exporter = makeExporter({ bundle });
    const result = await exporter.export(ACTOR, {
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      draftArtifactBundleId: DRAFT_JOB_ID,
      requestedBy: "exporter-test-actor",
    });
    expectFailure(result);
    expect(result.failingChecks.map((entry) => entry.check)).toContain("protectedSpanCoverage");
  });

  it("preserves bundle integrity when all checks pass; Kaifuu handoff mirrors the bundle", async () => {
    const exporter = makeExporter();
    const result = await exporter.export(ACTOR, {
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      draftArtifactBundleId: DRAFT_JOB_ID,
      requestedBy: "exporter-test-actor",
    });
    if ("kind" in result && result.kind === "preflight_failure") {
      throw new Error("unexpected failure");
    }
    const payload = prepareKaifuuPatchPayload(result);
    expect(payload.schemaVersion).toBe(PATCH_EXPORT_BUNDLE_SCHEMA_VERSION);
    expect(payload.units).toHaveLength(1);
    expect(payload.assetDirectives).toHaveLength(1);
    expect(payload.units[0]).toMatchObject({
      sourceUnitId: "unit-001",
      sourceText: "こんにちは、{player}。",
      draftText: "Hello, {player}.",
    });
    expect(payload.provenance.draftArtifactBundleId).toBe(DRAFT_JOB_ID);
    expect(payload.provenance.exportedByUserId).toBe("exporter-test-actor");
    expect(payload.provenance.exportedAt).toBe(FIXED_NOW.toISOString());
  });
});
