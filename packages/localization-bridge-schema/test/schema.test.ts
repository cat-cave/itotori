import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertBridgeBundle,
  assertBridgeBundleV02,
  assertBenchmarkReportV02,
  assertDeltaPackageMetadataV02,
  assertPatchExport,
  assertPatchExportV02,
  assertPatchResultV02,
  assertRuntimeEvidenceReportV02,
  assertRuntimeReport,
  assertRuntimeVerificationReport,
  assertTriageBundleV02,
  evaluatePatchExportCompatibilityV02,
} from "../src/index.js";

const HASH_PATCH_EXPORT_V02_EXAMPLE =
  "sha256:8c8bd1092bba59430737fc36ec0ede41e36b8c94d7759a1313bcfc5aba94941a";
const HASH_BUNDLE_V02_EXAMPLE_TYPO =
  "sha256:530752517d6fe6af8505a362c5da79a034a16bb1c73b9c3b4c2e5bd5c2a2c060";
const HASH_UNIT_DIALOGUE_KNOWN =
  "sha256:fa01799c693dbf37732740572dde0106c2d67bed57a5955528687642896968e1";
const HASH_UNIT_DIALOGUE_KNOWN_TYPO =
  "sha256:ee738430dc6b47e520cbf9de9a54130e50671aa69dfd4d05bc447a9cbb980ea3";

function bridgeV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/bridge-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function triageV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/triage-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function runtimeEvidenceV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/runtime-evidence-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function benchmarkReportV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/benchmark-report-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function traceOnlyReferenceFidelityReport(): Record<string, unknown> {
  return {
    schemaVersion: "0.2.0",
    runtimeReportId: "019ed003-0000-7000-8000-00000000e401",
    sourceBridgeId: "019ed001-0000-7000-8000-000000000001",
    sourceBundleHash: "sha256:fd8dc24ee34b959fbd2beb9af53af65f5a376da5cb392bf4ef7246aff8804647",
    sourceLocale: "en-US",
    targetLocale: "fr-FR",
    adapterName: "utsushi-reference-example",
    adapterVersion: "0.2.0",
    fidelityTier: "reference_fidelity",
    evidenceTier: "E4",
    status: "passed",
    createdAt: "2026-06-17T00:00:00.000Z",
    traceEvents: [
      {
        traceEventId: "019ed003-0000-7000-8000-00000000e411",
        eventKind: "text_observed",
        bridgeUnitRef: {
          bridgeUnitId: "019ed001-0000-7000-8000-000000000201",
          sourceUnitKey: "script/prologue#line-001",
        },
        frame: 12,
        traceKey: "prologue.line.001",
        observedText: "Bonjour, {player}.",
      },
    ],
    branchEvents: [],
    captures: [],
    recordings: [],
    approximations: [],
    validationFindings: [],
    limitations: [],
  };
}

function passedReferenceComparison(): Record<string, unknown> {
  return {
    comparisonId: "019ed003-0000-7000-8000-00000000e421",
    comparisonKind: "reference_runtime",
    status: "passed",
    scope: "script/prologue#line-001 rendered text",
    coveredBridgeUnitRefs: [
      {
        bridgeUnitId: "019ed001-0000-7000-8000-000000000201",
        sourceUnitKey: "script/prologue#line-001",
      },
    ],
    artifactRef: {
      artifactId: "019ed003-0000-7000-8000-00000000e431",
      artifactKind: "reference_comparison",
      uri: "artifacts/utsushi/hello/reference-comparison.json",
      hash: "sha256:9f19ff8b1b206d23c4df42dc35913c9fdb14d5ec4a85139d368c39942c197f51",
      mediaType: "application/json",
      byteSize: 2048,
    },
  };
}

function exampleFixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

function bridgeV02Units(bridge: Record<string, unknown>): Array<Record<string, unknown>> {
  return bridge.units as Array<Record<string, unknown>>;
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function patchExportV02Example(
  bridge: Record<string, unknown>,
  unitCount = 2,
): Record<string, unknown> {
  const units = bridgeV02Units(bridge).slice(0, unitCount);
  return {
    schemaVersion: "0.2.0",
    patchExportId: "019ed001-0000-7000-8000-000000000901",
    sourceBridgeId: bridge.bridgeId,
    sourceGame: cloneRecord(bridge.sourceGame),
    sourceBundleHash: bridge.sourceBundleHash,
    sourceBundleRevision: cloneRecord(bridge.sourceBundleRevision),
    sourceLocale: bridge.sourceLocale,
    targetLocale: "fr-FR",
    hashStrategy: cloneRecord(bridge.hashStrategy),
    patchExportHash: HASH_PATCH_EXPORT_V02_EXAMPLE,
    generatedAt: "2026-06-17T00:00:00.000Z",
    entries: units.map((unit, index) => ({
      entryId: `019ed001-0000-7000-8000-00000000091${index}`,
      bridgeUnitId: unit.bridgeUnitId,
      sourceUnitKey: unit.sourceUnitKey,
      sourceHash: unit.sourceHash,
      sourceRevision: cloneRecord(unit.sourceRevision),
      targetText: index === 0 ? "Bonjour, {player}." : "La porte s'ouvre.",
      protectedSpanMappings:
        index === 0 ? [{ raw: "{player}", targetStart: 9, targetEnd: 17 }] : [],
    })),
  };
}

function asTestRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeDefined();
  return value as Record<string, unknown>;
}

describe("localization bridge schema guards", () => {
  it("has explicit validation expectations for each top-level example fixture", () => {
    const expectedTopLevelFixtures = new Set([
      "benchmark-report-v0.2.json",
      "bridge-v0.2.json",
      "runtime-evidence-v0.2.json",
      "triage-v0.2.json",
    ]);
    const topLevelFixtures = readdirSync(new URL("./examples", import.meta.url)).filter((entry) =>
      entry.endsWith(".json"),
    );

    expect(new Set(topLevelFixtures)).toEqual(expectedTopLevelFixtures);
  });

  it.each([
    {
      path: "./examples/bridge-v0.2.json",
      kind: "bridge-v0.2",
      assertValid: assertBridgeBundleV02,
    },
    {
      path: "./examples/triage-v0.2.json",
      kind: "triage-v0.2",
      assertValid: assertTriageBundleV02,
    },
    {
      path: "./examples/runtime-evidence-v0.2.json",
      kind: "runtime-evidence-v0.2",
      assertValid: assertRuntimeEvidenceReportV02,
    },
    {
      path: "./examples/benchmark-report-v0.2.json",
      kind: "benchmark-report-v0.2",
      assertValid: assertBenchmarkReportV02,
    },
  ])("validates committed $kind example fixture", ({ path, assertValid }) => {
    expect(() => assertValid(exampleFixture(path))).not.toThrow();
  });

  it.each([
    {
      path: "./examples/invalid/bridge-v0.2-dangling-asset-ref.json",
      semanticError: /sourceAssetRef\.assetId.*asset/,
    },
    {
      path: "./examples/invalid/bridge-v0.2-malformed-hash.json",
      semanticError: /canonical sha256 hash string/,
    },
    {
      path: "./examples/invalid/bridge-v0.2-schema-version-0.1.json",
      semanticError: /schemaVersion must be 0\.2\.0/,
    },
  ])("rejects invalid committed bridge fixture $path", ({ path, semanticError }) => {
    expect(() => assertBridgeBundleV02(exampleFixture(path))).toThrow(semanticError);
  });

  it("accepts minimal valid bridge bundles", () => {
    expect(() =>
      assertBridgeBundle({
        schemaVersion: "0.1.0",
        bridgeId: "019ed000-0000-7000-8000-000000000001",
        sourceBundleHash: "hash",
        sourceLocale: "ja-JP",
        extractorName: "kaifuu-fixture",
        extractorVersion: "0.0.0",
        units: [],
      }),
    ).not.toThrow();
  });

  it("accepts the v0.2 bridge surface example", () => {
    const bridge = bridgeV02Example();

    expect(() => assertBridgeBundleV02(bridge)).not.toThrow();

    const units = bridge.units as Array<{ speaker?: { knowledgeState?: string } }>;
    const speakerStates = units.map((unit) => unit.speaker?.knowledgeState).filter(Boolean);
    expect(speakerStates).toContain("parser_unknown");
    expect(speakerStates).toContain("reader_unknown");
  });

  it("keeps raw MTL baselines in the benchmark report schema", () => {
    const report = benchmarkReportV02Example();

    expect(() => assertBenchmarkReportV02(report)).not.toThrow();
    expect(report.systemsCompared).toContainEqual(
      expect.objectContaining({
        systemId: "raw-mtl-baseline",
        systemKind: "raw_mtl_baseline",
      }),
    );
  });

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

  it("rejects benchmark reports whose QA-agent evaluations omit llm_qa findings", () => {
    const report = benchmarkReportV02Example();
    const qaAgentEvaluations = report.qaAgentEvaluations as Array<Record<string, unknown>>;
    const firstEvaluation = asTestRecord(qaAgentEvaluations[0], "first QA-agent evaluation");
    firstEvaluation.findingIds = [];

    expect(() => assertBenchmarkReportV02(report)).toThrow(
      /qaAgentEvaluations\.findingIds.*llm_qa findingRecords/,
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

  it("rejects v0.2 bridge ids that are not UUID7", () => {
    const bridge = bridgeV02Example();
    bridge.bridgeId = "not-a-uuid";

    expect(() => assertBridgeBundleV02(bridge)).toThrow(/UUID7/);
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
      normalization: "utf8-nfc-lf-json-stable-v1",
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
    sourceAsset.normalization = "utf8-nfc-lf-json-stable-v1";

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

  it("accepts v0.2 patch exports with explicit source compatibility metadata", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);

    expect(() => assertPatchExportV02(patchExport)).not.toThrow();
  });

  it("rejects v0.2 patch exports without unit source revisions", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const firstEntry = asTestRecord(
      (patchExport.entries as Array<Record<string, unknown>>)[0],
      "first v0.2 patch export entry",
    );
    delete firstEntry.sourceRevision;

    expect(() => assertPatchExportV02(patchExport)).toThrow(/sourceRevision/);
  });

  it("reports only affected units when a source typo changes one unit hash", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const rerunBridge = cloneRecord(bridge);
    rerunBridge.sourceBundleHash = HASH_BUNDLE_V02_EXAMPLE_TYPO;
    const rerunBundleRevision = asTestRecord(
      rerunBridge.sourceBundleRevision,
      "rerun source bundle revision",
    );
    rerunBundleRevision.value = HASH_BUNDLE_V02_EXAMPLE_TYPO;
    const firstUnit = bridgeV02Units(rerunBridge)[0];
    expect(firstUnit).toBeDefined();
    firstUnit.sourceText = "Hello, {player}!";
    firstUnit.sourceHash = HASH_UNIT_DIALOGUE_KNOWN_TYPO;

    const report = evaluatePatchExportCompatibilityV02(patchExport, rerunBridge);

    expect(report.status).toBe("incompatible");
    expect(report.sourceBundleHashMatches).toBe(false);
    expect(report.incompatibleUnits).toEqual([
      expect.objectContaining({
        sourceUnitKey: "script/prologue#line-001",
        expectedSourceHash: HASH_UNIT_DIALOGUE_KNOWN,
        actualSourceHash: HASH_UNIT_DIALOGUE_KNOWN_TYPO,
        reason: "source_hash_mismatch",
      }),
    ]);
    expect(report.compatibleUnits).toHaveLength(1);

    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000950",
        patchExportId: patchExport.patchExportId,
        status: "incompatible_source",
        failures: [
          `source_hash_mismatch: script/prologue#line-001 expected ${HASH_UNIT_DIALOGUE_KNOWN} but found ${HASH_UNIT_DIALOGUE_KNOWN_TYPO}`,
        ],
        sourceCompatibility: report,
      }),
    ).not.toThrow();
  });

  it("reports all entries compatible when source unit hashes still match", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);

    const report = evaluatePatchExportCompatibilityV02(patchExport, bridge);

    expect(report.status).toBe("compatible");
    expect(report.sourceBundleHashMatches).toBe(true);
    expect(report.compatibleUnits).toHaveLength(2);
    expect(report.incompatibleUnits).toEqual([]);
  });

  it("reports a missing source unit without invalidating unrelated compatible units", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const rerunBridge = cloneRecord(bridge);
    rerunBridge.units = bridgeV02Units(rerunBridge).slice(1);

    const report = evaluatePatchExportCompatibilityV02(patchExport, rerunBridge);

    expect(report.status).toBe("incompatible");
    expect(report.incompatibleUnits).toEqual([
      expect.objectContaining({
        sourceUnitKey: "script/prologue#line-001",
        reason: "missing_source_unit",
      }),
    ]);
    expect(report.compatibleUnits).toHaveLength(1);
  });

  it("reports duplicate source unit keys as incompatible", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge, 1);
    const rerunBridge = cloneRecord(bridge);
    const units = bridgeV02Units(rerunBridge);
    expect(units[0]).toBeDefined();
    expect(units[1]).toBeDefined();
    units[1].sourceUnitKey = units[0].sourceUnitKey;
    const duplicatePatchRef = asTestRecord(units[1].patchRef, "duplicate source unit patch ref");
    duplicatePatchRef.sourceUnitKey = units[1].sourceUnitKey;

    const report = evaluatePatchExportCompatibilityV02(patchExport, rerunBridge);

    expect(report.status).toBe("incompatible");
    expect(report.incompatibleUnits).toEqual([
      expect.objectContaining({
        sourceUnitKey: "script/prologue#line-001",
        reason: "duplicate_source_unit_key",
      }),
    ]);
    expect(report.compatibleUnits).toEqual([]);
  });

  it("rejects incompatible patch results without source compatibility details", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);

    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000951",
        patchExportId: patchExport.patchExportId,
        status: "incompatible_source",
        failures: ["source_hash_mismatch"],
      }),
    ).toThrow(/sourceCompatibility is required/);
  });

  it("rejects patch results whose source compatibility targets a different patch export", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const rerunBridge = cloneRecord(bridge);
    rerunBridge.sourceBundleHash = HASH_BUNDLE_V02_EXAMPLE_TYPO;
    const rerunBundleRevision = asTestRecord(
      rerunBridge.sourceBundleRevision,
      "rerun source bundle revision",
    );
    rerunBundleRevision.value = HASH_BUNDLE_V02_EXAMPLE_TYPO;
    const firstUnit = bridgeV02Units(rerunBridge)[0];
    expect(firstUnit).toBeDefined();
    firstUnit.sourceHash = HASH_UNIT_DIALOGUE_KNOWN_TYPO;
    const report = evaluatePatchExportCompatibilityV02(patchExport, rerunBridge);
    report.patchExportId = "019ed001-0000-7000-8000-000000000902";

    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000956",
        patchExportId: patchExport.patchExportId,
        status: "incompatible_source",
        failures: ["incompatible_source"],
        sourceCompatibility: report,
      }),
    ).toThrow(/sourceCompatibility\.patchExportId.*PatchResultV02\.patchExportId/);
  });

  it("rejects incompatible_source patch results with a compatible source report", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const report = evaluatePatchExportCompatibilityV02(patchExport, bridge);

    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000957",
        patchExportId: patchExport.patchExportId,
        status: "incompatible_source",
        failures: ["incompatible_source"],
        sourceCompatibility: report,
      }),
    ).toThrow(/sourceCompatibility\.status must be incompatible/);
  });

  it("rejects non-incompatible_source patch results with an incompatible source report", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const rerunBridge = cloneRecord(bridge);
    rerunBridge.sourceBundleHash = HASH_BUNDLE_V02_EXAMPLE_TYPO;
    const rerunBundleRevision = asTestRecord(
      rerunBridge.sourceBundleRevision,
      "rerun source bundle revision",
    );
    rerunBundleRevision.value = HASH_BUNDLE_V02_EXAMPLE_TYPO;
    const firstUnit = bridgeV02Units(rerunBridge)[0];
    expect(firstUnit).toBeDefined();
    firstUnit.sourceHash = HASH_UNIT_DIALOGUE_KNOWN_TYPO;
    const report = evaluatePatchExportCompatibilityV02(patchExport, rerunBridge);

    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000958",
        patchExportId: patchExport.patchExportId,
        status: "failed",
        failures: ["apply_failed"],
        sourceCompatibility: report,
      }),
    ).toThrow(/status must be incompatible_source/);
  });

  it("rejects inconsistent v0.2 compatibility reports", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const report = evaluatePatchExportCompatibilityV02(patchExport, bridge);

    const incompatibleWithEmptyUnits = cloneRecord(report);
    incompatibleWithEmptyUnits.status = "incompatible";
    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000952",
        patchExportId: patchExport.patchExportId,
        status: "incompatible_source",
        failures: ["incompatible_source"],
        sourceCompatibility: incompatibleWithEmptyUnits,
      }),
    ).toThrow(/empty incompatibleUnits/);

    const incompatibleInCompatibleUnits = cloneRecord(report);
    const compatibleUnits = incompatibleInCompatibleUnits.compatibleUnits as Array<
      Record<string, unknown>
    >;
    compatibleUnits[0].status = "incompatible";
    compatibleUnits[0].reason = "source_hash_mismatch";
    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000953",
        patchExportId: patchExport.patchExportId,
        status: "incompatible_source",
        failures: ["incompatible_source"],
        sourceCompatibility: incompatibleInCompatibleUnits,
      }),
    ).toThrow(/compatibleUnits\[0\]\.status/);

    const compatibleWithReason = cloneRecord(report);
    const reasonUnits = compatibleWithReason.compatibleUnits as Array<Record<string, unknown>>;
    reasonUnits[0].reason = "source_hash_mismatch";
    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000954",
        patchExportId: patchExport.patchExportId,
        status: "incompatible_source",
        failures: ["incompatible_source"],
        sourceCompatibility: compatibleWithReason,
      }),
    ).toThrow(/reason is only valid/);

    const mismatchedBundleFlag = cloneRecord(report);
    mismatchedBundleFlag.sourceBundleHashMatches = false;
    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000955",
        patchExportId: patchExport.patchExportId,
        status: "incompatible_source",
        failures: ["incompatible_source"],
        sourceCompatibility: mismatchedBundleFlag,
      }),
    ).toThrow(/sourceBundleHashMatches/);
  });

  it("accepts v0.2 delta metadata that traces to a source revision and patch export", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);

    expect(() =>
      assertDeltaPackageMetadataV02({
        schemaVersion: "0.2.0",
        deltaPackageId: "019ed001-0000-7000-8000-000000000960",
        sourceBridgeId: bridge.bridgeId,
        sourceGame: bridge.sourceGame,
        sourceBundleHash: bridge.sourceBundleHash,
        sourceBundleRevision: bridge.sourceBundleRevision,
        generatedPatchExportId: patchExport.patchExportId,
        generatedPatchExportHash: patchExport.patchExportHash,
        targetLocale: patchExport.targetLocale,
        hashStrategy: bridge.hashStrategy,
        createdAt: "2026-06-17T00:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("rejects v0.2 delta metadata whose source bundle revision does not trace its hash", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const sourceBundleRevision = cloneRecord(bridge.sourceBundleRevision) as Record<
      string,
      unknown
    >;
    sourceBundleRevision.value = HASH_BUNDLE_V02_EXAMPLE_TYPO;

    expect(() =>
      assertDeltaPackageMetadataV02({
        schemaVersion: "0.2.0",
        deltaPackageId: "019ed001-0000-7000-8000-000000000961",
        sourceBridgeId: bridge.bridgeId,
        sourceGame: bridge.sourceGame,
        sourceBundleHash: bridge.sourceBundleHash,
        sourceBundleRevision,
        generatedPatchExportId: patchExport.patchExportId,
        generatedPatchExportHash: patchExport.patchExportHash,
        targetLocale: patchExport.targetLocale,
        hashStrategy: bridge.hashStrategy,
      }),
    ).toThrow(/sourceBundleRevision\.value/);
  });

  it("accepts the v0.2 triage event and finding taxonomy example", () => {
    const triage = triageV02Example();

    expect(() => assertTriageBundleV02(triage)).not.toThrow();

    const findings = triage.findings as Array<{
      severity: string;
      qualityCategory?: string;
      provenance: Array<{ provenanceKind: string }>;
    }>;
    const provenanceKinds = new Set(
      findings.flatMap((finding) =>
        finding.provenance.map((provenance) => provenance.provenanceKind),
      ),
    );
    expect(provenanceKinds).toEqual(
      new Set(["source_annotation", "style_guide", "model_output", "patching_cause"]),
    );
    expect(findings.map((finding) => finding.severity)).toContain("P0");
    expect(findings.map((finding) => finding.qualityCategory)).toContain("style");
    expect(findings.some((finding) => finding.severity === finding.qualityCategory)).toBe(false);
  });

  it("rejects triage findings that use confidence instead of evidence", () => {
    const triage = triageV02Example();
    const findings = triage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    firstFinding.confidence = 0.9;

    expect(() => assertTriageBundleV02(triage)).toThrow(/confidence/i);
  });

  it("rejects triage findings without provenance", () => {
    const triage = triageV02Example();
    const findings = triage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    firstFinding.provenance = [];

    expect(() => assertTriageBundleV02(triage)).toThrow(/provenance.*at least one/);
  });

  it("rejects mutable status buckets in append-only triage events", () => {
    const triage = triageV02Example();
    const events = triage.events as Array<Record<string, unknown>>;
    const firstEvent = asTestRecord(events[0], "first v0.2 triage event");
    firstEvent.payload = { status: "closed" };

    expect(() => assertTriageBundleV02(triage)).toThrow(/append-only events/);
  });

  it("rejects triage events that causally link to future events", () => {
    const triage = triageV02Example();
    const events = triage.events as Array<{ causalLinks: Array<Record<string, unknown>> }>;
    const firstEvent = events[0];
    expect(firstEvent).toBeDefined();
    firstEvent.causalLinks = [
      {
        causalLinkId: "019ed002-0000-7000-8000-0000000007ff",
        linkKind: "caused_by",
        targetKind: "event",
        targetId: "019ed002-0000-7000-8000-000000000102",
      },
    ];

    expect(() => assertTriageBundleV02(triage)).toThrow(/prior event/);
  });

  it("rejects triage records with missing task or finding event references", () => {
    const triage = triageV02Example();
    const tasks = triage.tasks as Array<Record<string, unknown>>;
    const firstTask = asTestRecord(tasks[0], "first v0.2 task");
    firstTask.createdByEventId = "019ed002-0000-7000-8000-00000000ffff";

    expect(() => assertTriageBundleV02(triage)).toThrow(/createdByEventId.*existing triage event/);

    const nextTriage = triageV02Example();
    const findings = nextTriage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    firstFinding.firstSeenEventId = "019ed002-0000-7000-8000-00000000ffff";

    expect(() => assertTriageBundleV02(nextTriage)).toThrow(
      /firstSeenEventId.*existing triage event/,
    );
  });

  it("rejects triage causal links whose targets are missing", () => {
    const triage = triageV02Example();
    const events = triage.events as Array<Record<string, unknown>>;
    const firstEvent = asTestRecord(events[0], "first v0.2 triage event");
    firstEvent.causalLinks = [
      {
        causalLinkId: "019ed002-0000-7000-8000-0000000007f1",
        linkKind: "blocks",
        targetKind: "task",
        targetId: "019ed002-0000-7000-8000-00000000ffff",
      },
    ];

    expect(() => assertTriageBundleV02(triage)).toThrow(
      /causalLinks\[0\]\.targetId.*existing triage task/,
    );
  });

  it("rejects task and finding causal links with missing targets for their kind", () => {
    const triage = triageV02Example();
    const tasks = triage.tasks as Array<Record<string, unknown>>;
    const firstTask = asTestRecord(tasks[0], "first v0.2 task");
    firstTask.causalLinks = [
      {
        causalLinkId: "019ed002-0000-7000-8000-0000000007f2",
        linkKind: "blocks",
        targetKind: "finding",
        targetId: "019ed002-0000-7000-8000-00000000ffff",
      },
    ];

    expect(() => assertTriageBundleV02(triage)).toThrow(
      /tasks\[0\]\.causalLinks\[0\]\.targetId.*existing triage finding/,
    );

    const nextTriage = triageV02Example();
    const findings = nextTriage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    firstFinding.causalLinks = [
      {
        causalLinkId: "019ed002-0000-7000-8000-0000000007f3",
        linkKind: "supersedes",
        targetKind: "task",
        targetId: "019ed002-0000-7000-8000-00000000ffff",
      },
    ];

    expect(() => assertTriageBundleV02(nextTriage)).toThrow(
      /findings\[0\]\.causalLinks\[0\]\.targetId.*existing triage task/,
    );
  });

  it("rejects triage findings without evidence records", () => {
    const triage = triageV02Example();
    const findings = triage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    firstFinding.evidence = [];

    expect(() => assertTriageBundleV02(triage)).toThrow(/evidence.*at least one evidence record/);
  });

  it("rejects triage evidence with empty provenance ids", () => {
    const triage = triageV02Example();
    const findings = triage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    const evidence = firstFinding.evidence as Array<Record<string, unknown>>;
    const firstEvidence = asTestRecord(evidence[0], "first v0.2 evidence");
    firstEvidence.provenanceIds = [];

    expect(() => assertTriageBundleV02(triage)).toThrow(
      /evidence\[0\]\.provenanceIds must contain at least one provenance id/,
    );
  });

  it("rejects triage evidence with dangling provenance ids", () => {
    const triage = triageV02Example();
    const findings = triage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    const evidence = firstFinding.evidence as Array<Record<string, unknown>>;
    const firstEvidence = asTestRecord(evidence[0], "first v0.2 evidence");
    firstEvidence.provenanceIds = ["019ed002-0000-7000-8000-00000000ffff"];

    expect(() => assertTriageBundleV02(triage)).toThrow(
      /provenanceIds\[0\] must reference provenance in TriageBundleV02/,
    );
  });

  it("rejects triage evidence linked to provenance from another finding", () => {
    const triage = triageV02Example();
    const findings = triage.findings as Array<Record<string, unknown>>;
    const firstFinding = asTestRecord(findings[0], "first v0.2 finding");
    const evidence = firstFinding.evidence as Array<Record<string, unknown>>;
    const firstEvidence = asTestRecord(evidence[0], "first v0.2 evidence");
    firstEvidence.provenanceIds = ["019ed002-0000-7000-8000-000000000402"];

    expect(() => assertTriageBundleV02(triage)).toThrow(
      /provenanceIds\[0\] must reference provenance on the same finding/,
    );
  });

  it("accepts v0.2 runtime evidence with trace, branch, capture, and recording refs", () => {
    const report = runtimeEvidenceV02Example();

    expect(() => assertRuntimeEvidenceReportV02(report)).not.toThrow();
    expect(() => assertRuntimeReport(report)).not.toThrow();

    const captures = report.captures as Array<Record<string, unknown>>;
    const firstCapture = asTestRecord(captures[0], "first runtime capture");
    const artifactRef = asTestRecord(firstCapture.artifactRef, "first capture artifact ref");
    expect(artifactRef.uri).toBe("artifacts/utsushi/hello/frame-0001.png");
    expect(firstCapture).not.toHaveProperty("bytes");
    expect(firstCapture).not.toHaveProperty("data");
  });

  it("rejects v0.2 runtime evidence that overclaims fixture fidelity", () => {
    const report = runtimeEvidenceV02Example();
    report.fidelityTier = "layout_probe";
    report.evidenceTier = "E4";

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/evidenceTier must not exceed E2/);
  });

  it("rejects E4 reference fidelity without reference comparison evidence", () => {
    const report = traceOnlyReferenceFidelityReport();

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/referenceComparisons/);
  });

  it("accepts E4 reference fidelity with passed reference comparison evidence", () => {
    const report = traceOnlyReferenceFidelityReport();
    report.referenceComparisons = [passedReferenceComparison()];

    expect(() => assertRuntimeEvidenceReportV02(report)).not.toThrow();
    expect(() => assertRuntimeReport(report)).not.toThrow();
  });

  it("rejects v0.2 runtime captures without bridge-unit traceability", () => {
    const report = runtimeEvidenceV02Example();
    const captures = report.captures as Array<Record<string, unknown>>;
    const firstCapture = asTestRecord(captures[0], "first runtime capture");
    delete firstCapture.bridgeUnitRef;

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/bridgeUnitRef/);
  });

  it.each([
    ["embedded data URI", "data:image/png;base64,AAAA"],
    ["absolute POSIX path", "/tmp/runtime/frame.png"],
    ["Windows path", "C:\\runtime\\frame.png"],
  ])("rejects non-portable v0.2 runtime screenshot references: %s", (_label, uri) => {
    const report = runtimeEvidenceV02Example();
    const captures = report.captures as Array<Record<string, unknown>>;
    const firstCapture = asTestRecord(captures[0], "first runtime capture");
    const artifactRef = asTestRecord(firstCapture.artifactRef, "first capture artifact ref");
    artifactRef.uri = uri;

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/reference an artifact|portable/);
  });

  it("rejects v0.2 runtime branch points whose selected option is not listed", () => {
    const report = runtimeEvidenceV02Example();
    const branchEvents = report.branchEvents as Array<Record<string, unknown>>;
    const firstBranchEvent = asTestRecord(branchEvents[0], "first branch event");
    firstBranchEvent.selectedOptionId = "019ed003-0000-7000-8000-00000000ffff";

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/selectedOptionId/);
  });

  it("rejects invalid patch exports", () => {
    expect(() => assertPatchExport({ schemaVersion: "0.1.0" })).toThrow();
  });

  it("accepts runtime reports", () => {
    expect(() =>
      assertRuntimeVerificationReport({
        schemaVersion: "0.1.0",
        runtimeReportId: "019ed000-0000-7000-8000-000000000002",
        adapterName: "utsushi-fixture",
        fidelityTier: "layout_probe",
        status: "passed",
        textEvents: [],
        frameCaptures: [],
        approximations: [],
      }),
    ).not.toThrow();
  });
});
