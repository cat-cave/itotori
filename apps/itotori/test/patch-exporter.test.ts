// ITOTORI-025 — PatchExporter integration tests.
//
// Verifies the exporter:
//   1. Assembles a PatchExportBundle when every preflight check
//      passes, with all provenance fields populated.
//   2. Returns a typed PreflightFailure (and produces NO bundle) when:
//        - the source-bridge hash drifts (stale draft bundle);
//        - any asset decision is unresolved;
//        - any protected span is missing from a draft.
//   3. Honors the no-partial-bundle invariant.
//   4. The Kaifuu handoff helper produces an engine-agnostic payload
//      that mirrors the bundle.

import { describe, expect, it } from "vitest";
import type { AssetDecisionRecord, AuthorizationActor } from "@itotori/db";
import {
  asNonBlankTargetText,
  DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION,
  PATCH_EXPORT_BUNDLE_SCHEMA_VERSION,
  type DraftArtifactBundle,
} from "@itotori/localization-bridge-schema";
import { AssetDecisionPolicyResolver } from "../src/asset-decisions/policy-resolver.js";
import { REALLIVE_SJIS_ADAPTER_ID, UTF8_JSON_ADAPTER_ID } from "../src/gates/index.js";
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

function makeView(
  units: SourceBridgeUnit[] = [makeUnit()],
  overrides: Partial<SourceBridgeView> = {},
): SourceBridgeView {
  return {
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    sourceBridgeHash: SOURCE_BRIDGE_HASH,
    extractorAdapterId: UTF8_JSON_ADAPTER_ID,
    targetLocale: TARGET_LOCALE,
    units,
    ...overrides,
  };
}

function makeBundle(overrides: Partial<DraftArtifactBundle> = {}): DraftArtifactBundle {
  return {
    schemaVersion: DRAFT_ARTIFACT_BUNDLE_SCHEMA_VERSION,
    draftJobId: DRAFT_JOB_ID,
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
  it("assembles a patch-export bundle when every check passes", async () => {
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
        sourceStart: 5,
        sourceEnd: 13,
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
    expect(result.preflightResults).toHaveLength(5);
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

  it("rejects export when a draft loses a protected span", async () => {
    const bundle = makeBundle({
      drafts: [makeDraftEntry({ selectedBody: "Hello, friend." })],
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

  it("exports successfully when an out-of-band span is absent from the draft", async () => {
    const view = makeView([
      makeUnit({
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
    const bundle = makeBundle({
      drafts: [makeDraftEntry({ selectedBody: "Hello." })],
    });
    const exporter = makeExporter({ view, bundle });
    const result = await exporter.export(ACTOR, {
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      draftArtifactBundleId: DRAFT_JOB_ID,
      requestedBy: "exporter-test-actor",
    });
    if ("kind" in result && result.kind === "preflight_failure") {
      throw new Error(`unexpected preflight failure: ${JSON.stringify(result.failingChecks)}`);
    }
    expect(result.drafts[0]?.protectedSpanMappings).toEqual([]);
  });

  it("still rejects export when a non-out-of-band control markup span is dropped", async () => {
    const view = makeView([
      makeUnit({
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
    const bundle = makeBundle({
      drafts: [makeDraftEntry({ selectedBody: "Hello." })],
    });
    const result = await makeExporter({ view, bundle }).export(ACTOR, {
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      draftArtifactBundleId: DRAFT_JOB_ID,
      requestedBy: "exporter-test-actor",
    });
    expectFailure(result);
    expect(result.failingChecks.map((entry) => entry.check)).toContain("protectedSpanCoverage");
  });

  it("keeps the RealLive policy's visible-text export behavior byte-for-byte", async () => {
    const view = makeView(
      [
        makeUnit({
          sourceText: "<reallive.kidoku 5>こんにちは。",
          protectedSpans: [],
        }),
      ],
      { extractorAdapterId: REALLIVE_SJIS_ADAPTER_ID },
    );
    const bundle = makeBundle({
      drafts: [makeDraftEntry({ selectedBody: "<reallive.kidoku 9>Hello." })],
    });
    const result = await makeExporter({ view, bundle }).export(ACTOR, {
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      draftArtifactBundleId: DRAFT_JOB_ID,
      requestedBy: "exporter-test-actor",
    });
    if ("kind" in result && result.kind === "preflight_failure") {
      throw new Error(`unexpected preflight failure: ${JSON.stringify(result.failingChecks)}`);
    }
    expect(JSON.stringify(result.drafts)).toBe(
      '[{"sourceUnitId":"unit-001","draftId":"draft-001","sourceText":"<reallive.kidoku 5>こんにちは。","draftText":"<reallive.kidoku 9>Hello.","protectedSpanMappings":[],"sourceUnitHash":"sha256:unit-001","draftUnitHash":"sha256:8585759d34358c2226bf9acdbde1bff4ef195b65fee49be719c3776183d33a5f"}]',
    );
  });

  it("does not interpret another target policy's literal markup", async () => {
    const view = makeView([
      makeUnit({
        sourceText: "こんにちは。",
        protectedSpans: [],
      }),
    ]);
    const bundle = makeBundle({
      drafts: [makeDraftEntry({ selectedBody: "<reallive.kidoku 9>" })],
    });
    const result = await makeExporter({ view, bundle }).export(ACTOR, {
      projectId: PROJECT_ID,
      localeBranchId: LOCALE_BRANCH_ID,
      draftArtifactBundleId: DRAFT_JOB_ID,
      requestedBy: "exporter-test-actor",
    });
    if ("kind" in result && result.kind === "preflight_failure") {
      throw new Error(`unexpected preflight failure: ${JSON.stringify(result.failingChecks)}`);
    }
    expect(result.drafts[0]?.draftText).toBe("<reallive.kidoku 9>");
  });

  it("rejects a source replay that becomes visible through the selected target policy", async () => {
    const view = makeView(
      [
        makeUnit({
          sourceText: "<reallive.kidoku 5>こんにちは。",
          protectedSpans: [],
        }),
      ],
      { extractorAdapterId: REALLIVE_SJIS_ADAPTER_ID },
    );
    const bundle = makeBundle({
      drafts: [makeDraftEntry({ selectedBody: "<reallive.kidoku 9>こんにちは。" })],
    });
    await expect(
      makeExporter({ view, bundle }).export(ACTOR, {
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        draftArtifactBundleId: DRAFT_JOB_ID,
        requestedBy: "exporter-test-actor",
      }),
    ).rejects.toThrow(/engine-visible source text/u);
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
