import { describe, expect, it } from "vitest";
import {
  assertAssetPolicyBundleV02,
  assertBridgeBundleV02,
  assertBenchmarkReportV02,
} from "../src/index.js";
import {
  bridgeV02Example,
  assetPolicyV02Example,
  benchmarkReportV02Example,
  bridgeV02Units,
  addRawMtlLlmQaCoverage,
  asTestRecord,
} from "./schema-test-helpers.js";

describe("localization bridge schema guards", () => {
  it("rejects benchmark provider records without prompt preset identity", () => {
    const report = benchmarkReportV02Example();
    const providerRecords = report.providerModelCostRecords as Array<Record<string, unknown>>;
    const firstProviderRecord = providerRecords[0];
    expect(firstProviderRecord).toBeDefined();
    delete (firstProviderRecord.prompt as Record<string, unknown>).promptPresetId;

    expect(() => assertBenchmarkReportV02(report)).toThrow(/promptPresetId/);
  });

  it("rejects benchmark reports with llm_qa provider runs but no QA-agent evaluation", () => {
    const report = benchmarkReportV02Example();
    report.qaAgentEvaluations = [];

    expect(() => assertBenchmarkReportV02(report)).toThrow(
      /qaAgentEvaluations\.providerRunIds.*llm_qa providerModelCostRecords/,
    );
  });

  it("accepts benchmark reports with separate QA-agent coverage for multiple evaluated systems", () => {
    const report = benchmarkReportV02Example();
    addRawMtlLlmQaCoverage(report);

    expect(() => assertBenchmarkReportV02(report)).not.toThrow();
    expect(report.qaAgentEvaluations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evaluatedSystemId: "raw-mtl-baseline",
          providerRunIds: ["019ed006-0000-7000-8000-000000000104"],
          findingIds: ["019ed006-0000-7000-8000-000000000303"],
        }),
        expect.objectContaining({
          evaluatedSystemId: "itotori-draft",
          providerRunIds: ["019ed006-0000-7000-8000-000000000103"],
          findingIds: ["019ed006-0000-7000-8000-000000000302"],
        }),
      ]),
    );
  });

  it("rejects benchmark reports with only global QA-agent provider run coverage", () => {
    const report = benchmarkReportV02Example();
    const qaAgentEvaluations = report.qaAgentEvaluations as Array<Record<string, unknown>>;
    const firstEvaluation = asTestRecord(qaAgentEvaluations[0], "first QA-agent evaluation");
    firstEvaluation.evaluatedSystemId = "raw-mtl-baseline";
    firstEvaluation.findingIds = [];

    expect(() => assertBenchmarkReportV02(report)).toThrow(
      /qaAgentEvaluations\[0\]\.providerRunIds.*evaluatedSystemId raw-mtl-baseline/,
    );
  });

  it("rejects benchmark reports whose QA-agent evaluations omit llm_qa findings", () => {
    const report = benchmarkReportV02Example();
    const qaAgentEvaluations = report.qaAgentEvaluations as Array<Record<string, unknown>>;
    const firstEvaluation = asTestRecord(qaAgentEvaluations[0], "first QA-agent evaluation");
    firstEvaluation.findingIds = [];

    expect(() => assertBenchmarkReportV02(report)).toThrow(
      /qaAgentEvaluations\.findingIds.*llm_qa findingRecords/,
    );
  });

  it("rejects benchmark reports with QA-agent finding coverage for a different system", () => {
    const report = benchmarkReportV02Example();
    const qaAgentEvaluations = report.qaAgentEvaluations as Array<Record<string, unknown>>;
    const firstEvaluation = asTestRecord(qaAgentEvaluations[0], "first QA-agent evaluation");
    firstEvaluation.evaluatedSystemId = "raw-mtl-baseline";
    firstEvaluation.providerRunIds = [];

    expect(() => assertBenchmarkReportV02(report)).toThrow(
      /qaAgentEvaluations\[0\]\.findingIds.*evaluatedSystemId raw-mtl-baseline/,
    );
  });

  it("rejects benchmark penalty totals that do not match taxonomy severity weights", () => {
    const report = benchmarkReportV02Example();
    const penaltySummary = asTestRecord(report.penaltySummary, "benchmark penalty summary");
    penaltySummary.penaltyTotal = 5;

    expect(() => assertBenchmarkReportV02(report)).toThrow(/penaltyTotal.*qualitySeverity weights/);
  });

  it("rejects benchmark normalized penalties that do not match source-size denominators", () => {
    const report = benchmarkReportV02Example();
    const penaltySummary = asTestRecord(report.penaltySummary, "benchmark penalty summary");
    penaltySummary.penaltyPerThousandSourceChars = 0;

    expect(() => assertBenchmarkReportV02(report)).toThrow(
      /penaltyPerThousandSourceChars.*sourceCharacterCount/,
    );
  });

  it("rejects benchmark timestamps that are not RFC3339 instants", () => {
    const report = benchmarkReportV02Example();
    report.createdAt = "not a timestamp";

    expect(() => assertBenchmarkReportV02(report)).toThrow(/createdAt.*RFC3339/);
  });

  it("rejects benchmark records whose completedAt precedes startedAt", () => {
    const report = benchmarkReportV02Example();
    const providerRecords = report.providerModelCostRecords as Array<Record<string, unknown>>;
    const firstProviderRecord = asTestRecord(providerRecords[0], "first provider record");
    firstProviderRecord.completedAt = "2026-06-17T15:00:09.000Z";

    expect(() => assertBenchmarkReportV02(report)).toThrow(/completedAt.*startedAt/);
  });

  it("accepts skipped benchmark provider records with omitted completion timing", () => {
    const report = benchmarkReportV02Example();
    const providerRecords = report.providerModelCostRecords as Array<Record<string, unknown>>;
    const firstProviderRecord = asTestRecord(providerRecords[0], "first provider record");
    delete firstProviderRecord.completedAt;
    delete firstProviderRecord.latencyMs;
    firstProviderRecord.status = "skipped";
    firstProviderRecord.tokenUsage = { tokenCountSource: "unknown" };
    firstProviderRecord.cost = { costKind: "unknown", currency: "USD" }; // cost-audit-allow: external-system benchmark cost may be genuinely unknowable (audit-3); this test asserts the schema ACCEPTS costKind unknown for an external benchmarked system, distinct from itotori's own billed/zero-only spend.
    const costLedger = asTestRecord(report.costLedger, "benchmark cost ledger");
    costLedger.includesUnknownCost = true;

    expect(() => assertBenchmarkReportV02(report)).not.toThrow();
  });

  it("accepts benchmark provider records that omit completedAt and latencyMs", () => {
    const report = benchmarkReportV02Example();
    const providerRecords = report.providerModelCostRecords as Array<Record<string, unknown>>;
    const firstProviderRecord = asTestRecord(providerRecords[0], "first provider record");
    delete firstProviderRecord.completedAt;
    delete firstProviderRecord.latencyMs;

    expect(() => assertBenchmarkReportV02(report)).not.toThrow();
  });

  // branch-aware benchmark + cost metadata.
  it("accepts a benchmark report that identifies its locale branch on both the report and the cost ledger", () => {
    const report = benchmarkReportV02Example();
    const costLedger = asTestRecord(report.costLedger, "benchmark cost ledger");

    expect(() => assertBenchmarkReportV02(report)).not.toThrow();
    expect(report.localeBranchId).toBe("019ed006-0000-7000-8000-0000000000b1");
    expect(costLedger.localeBranchId).toBe(report.localeBranchId);
  });

  it("rejects a benchmark report that drops its locale-branch identity but keeps it on the cost ledger", () => {
    const report = benchmarkReportV02Example();
    delete report.localeBranchId;

    // The cost ledger still names a branch the report no longer claims: a
    // dropped report-level branch identity must fail, not silently fall back.
    expect(() => assertBenchmarkReportV02(report)).toThrow(
      /costLedger\.localeBranchId must equal BenchmarkReportV02\.localeBranchId/,
    );
  });

  it("rejects a benchmark cost ledger that drops the report's locale-branch identity", () => {
    const report = benchmarkReportV02Example();
    const costLedger = asTestRecord(report.costLedger, "benchmark cost ledger");
    delete costLedger.localeBranchId;

    expect(() => assertBenchmarkReportV02(report)).toThrow(
      /costLedger\.localeBranchId must equal BenchmarkReportV02\.localeBranchId/,
    );
  });

  it("rejects a benchmark cost ledger scoped to a different locale branch than its report (no cross-branch cost merge)", () => {
    const report = benchmarkReportV02Example();
    const costLedger = asTestRecord(report.costLedger, "benchmark cost ledger");
    costLedger.localeBranchId = "019ed006-0000-7000-8000-0000000000b2";

    expect(() => assertBenchmarkReportV02(report)).toThrow(
      /cost cannot be merged across target locale branches/,
    );
  });

  it("rejects a benchmark report whose locale-branch identity is not a UUID7", () => {
    const report = benchmarkReportV02Example();
    report.localeBranchId = "locale-en-us";

    expect(() => assertBenchmarkReportV02(report)).toThrow(
      /BenchmarkReportV02\.localeBranchId must be a UUID7/,
    );
  });

  it("keeps two benchmark reports that share a target locale but belong to different branches distinct", () => {
    const branchA = benchmarkReportV02Example();
    const branchB = benchmarkReportV02Example();
    const branchBLocaleBranchId = "019ed006-0000-7000-8000-0000000000b2";
    branchB.localeBranchId = branchBLocaleBranchId;
    asTestRecord(branchB.costLedger, "branch B cost ledger").localeBranchId = branchBLocaleBranchId;

    // Same target locale, DIFFERENT locale branch: both are valid and the two
    // never collapse onto a single branch (the conflation an end-to-end
    // workflow keyed only by target locale would produce).
    expect(() => assertBenchmarkReportV02(branchA)).not.toThrow();
    expect(() => assertBenchmarkReportV02(branchB)).not.toThrow();
    expect(branchA.targetLocale).toBe(branchB.targetLocale);
    expect(branchA.localeBranchId).not.toBe(branchB.localeBranchId);
    expect(asTestRecord(branchA.costLedger, "branch A cost ledger").localeBranchId).not.toBe(
      asTestRecord(branchB.costLedger, "branch B cost ledger").localeBranchId,
    );
  });

  it("rejects v0.2 bridge ids that are not UUID7", () => {
    const bridge = bridgeV02Example();
    bridge.bridgeId = "not-a-uuid";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/UUID7/);
  });

  it("accepts a producer-declared native scene coordinate rather than requiring a database UUID", () => {
    const bridge = bridgeV02Example();
    const firstUnit = bridgeV02Units(bridge)[0]!;
    const context = asTestRecord(firstUnit.context, "first unit context");
    const route = asTestRecord(context.route, "first unit route");
    route.sceneId = "siglus:scene-0007";

    expect(() => assertBridgeBundleV02(bridge)).not.toThrow();
  });

  it("rejects a blank producer scene coordinate", () => {
    const bridge = bridgeV02Example();
    const firstUnit = bridgeV02Units(bridge)[0]!;
    const context = asTestRecord(firstUnit.context, "first unit context");
    const route = asTestRecord(context.route, "first unit route");
    route.sceneId = "   ";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/producer-declared coordinate/);
  });

  it("rejects raw or unknown v0.2 category values", () => {
    const bridge = bridgeV02Example();
    const units = bridgeV02Units(bridge);
    const firstUnit = units[0];
    expect(firstUnit).toBeDefined();
    firstUnit.surfaceKind = "dialogue_line";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/surfaceKind/);
  });

  it.each([
    ["label placeholder", "sha256:unit-dialogue-known"],
    ["short digest", "sha256:abc123"],
    ["uppercase digest", "sha256:FA01799C693DBF37732740572DDE0106C2D67BED57A5955528687642896968E1"],
    ["missing prefix", "fa01799c693dbf37732740572dde0106c2d67bed57a5955528687642896968e1"],
  ])("rejects malformed v0.2 hashes: %s", (_label, malformedHash) => {
    const bridge = bridgeV02Example();
    bridge.sourceBundleHash = malformedHash;

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/canonical sha256 hash string/);
  });

  it("rejects ambiguous v0.2 hash strategies without per-scope rules", () => {
    const bridge = bridgeV02Example();
    bridge.hashStrategy = {
      algorithm: "sha256",
      normalization: "utf8-lf-json-stable-v1",
      sourceProfileScope: "source_profile",
      sourceBundleScope: "source_bundle",
      sourceAssetScope: "source_asset",
      sourceUnitScope: "source_unit",
      unitHashFields: ["sourceText"],
    };

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/hashStrategy\.sourceProfile/);
  });

  it("rejects v0.2 asset hash rules that do not use byte normalization", () => {
    const bridge = bridgeV02Example();
    const hashStrategy = asTestRecord(bridge.hashStrategy, "v0.2 hash strategy");
    const sourceAsset = asTestRecord(hashStrategy.sourceAsset, "v0.2 source asset hash rule");
    sourceAsset.normalization = "utf8-lf-json-stable-v1";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/hashStrategy\.sourceAsset\.normalization/);
  });

  it("rejects v0.2 unit hash rules without explicit source fields", () => {
    const bridge = bridgeV02Example();
    const hashStrategy = asTestRecord(bridge.hashStrategy, "v0.2 hash strategy");
    const sourceUnit = asTestRecord(hashStrategy.sourceUnit, "v0.2 source unit hash rule");
    sourceUnit.fields = [];

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/hashStrategy\.sourceUnit\.fields/);
  });

  it("rejects v0.1-style raw speaker strings in v0.2 units", () => {
    const bridge = bridgeV02Example();
    const units = bridgeV02Units(bridge);
    const firstUnit = units[0];
    expect(firstUnit).toBeDefined();
    firstUnit.speaker = "Mira";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/speaker must be an object/);
  });

  it("rejects conflated unknown speaker state in v0.2 units", () => {
    const bridge = bridgeV02Example();
    const units = bridgeV02Units(bridge);
    const firstUnit = units[0];
    expect(firstUnit).toBeDefined();
    firstUnit.speaker = { knowledgeState: "unknown" };

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/knowledgeState/);
  });

  it("rejects v0.2 protected spans whose byte ranges do not match source text", () => {
    const bridge = bridgeV02Example();
    const units = bridge.units as Array<{ spans: Array<Record<string, unknown>> }>;
    const firstSpan = units[0]?.spans[0];
    expect(firstSpan).toBeDefined();
    firstSpan.startByte = 0;

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/byte range/);
  });

  it("rejects dangling v0.2 source asset references", () => {
    const bridge = bridgeV02Example();
    const firstUnit = asTestRecord(bridgeV02Units(bridge)[0], "first v0.2 unit");
    const sourceAssetRef = asTestRecord(firstUnit.sourceAssetRef, "first v0.2 source asset ref");
    sourceAssetRef.assetId = "019ed001-0000-7000-8000-00000000ffff";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/sourceAssetRef\.assetId/);
  });

  it("rejects dangling v0.2 patch asset references", () => {
    const bridge = bridgeV02Example();
    const firstUnit = asTestRecord(bridgeV02Units(bridge)[0], "first v0.2 unit");
    const patchRef = asTestRecord(firstUnit.patchRef, "first v0.2 patch ref");
    patchRef.assetId = "019ed001-0000-7000-8000-00000000ffff";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/patchRef\.assetId/);
  });

  it("rejects dangling v0.2 song audio asset references", () => {
    const bridge = bridgeV02Example();
    const songUnit = bridgeV02Units(bridge).find((unit) => {
      const context = asTestRecord(unit.context, "v0.2 unit context");
      return context.song !== undefined;
    });
    expect(songUnit).toBeDefined();
    const context = asTestRecord(songUnit?.context, "v0.2 song unit context");
    const song = asTestRecord(context.song, "v0.2 song context");
    const audioAssetRef = asTestRecord(song.audioAssetRef, "v0.2 song audio asset ref");
    audioAssetRef.assetId = "019ed001-0000-7000-8000-00000000ffff";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/song\.audioAssetRef\.assetId/);
  });

  it("rejects unknown v0.2 policy scopes", () => {
    const bridge = bridgeV02Example();
    const policyRecords = bridge.policyRecords as Array<Record<string, unknown>>;
    const firstPolicyRecord = asTestRecord(policyRecords[0], "first v0.2 policy record");
    firstPolicyRecord.scope = "global";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/policyRecords\[0\]\.scope/);
  });

  it("accepts the v0.2 asset policy fixture across required non-dialogue surfaces", () => {
    const assetPolicy = assetPolicyV02Example();

    expect(() => assertAssetPolicyBundleV02(assetPolicy)).not.toThrow();

    const localeBranch = asTestRecord(assetPolicy.localeBranch, "asset policy locale branch");
    expect(localeBranch.localeBranchId).toBe("019ed004-0000-7000-8000-000000000010");

    const decisions = assetPolicy.decisions as Array<{ assetSurfaceKind: string }>;
    expect(new Set(decisions.map((decision) => decision.assetSurfaceKind))).toEqual(
      new Set(["image_text", "ui_art", "song_title", "font", "credits", "video"]),
    );
  });
});
