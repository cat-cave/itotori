import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { expect } from "vitest";

export const HASH_PATCH_EXPORT_V02_EXAMPLE =
  "sha256:8c8bd1092bba59430737fc36ec0ede41e36b8c94d7759a1313bcfc5aba94941a";
export const HASH_BUNDLE_V02_EXAMPLE_TYPO =
  "sha256:530752517d6fe6af8505a362c5da79a034a16bb1c73b9c3b4c2e5bd5c2a2c060";
export const HASH_UNIT_DIALOGUE_KNOWN =
  "sha256:fa01799c693dbf37732740572dde0106c2d67bed57a5955528687642896968e1";
export const HASH_UNIT_DIALOGUE_KNOWN_TYPO =
  "sha256:ee738430dc6b47e520cbf9de9a54130e50671aa69dfd4d05bc447a9cbb980ea3";

export function bridgeV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/bridge-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

export function triageV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/triage-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

export function runtimeEvidenceV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/runtime-evidence-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

export function assetPolicyV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/asset-policy-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

export function benchmarkReportV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/benchmark-report-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

export function contractFixtureManifestV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/contract-fixtures-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

export function contractCompatibilityReportV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/contract-compatibility-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

export function alphaVerticalProofManifestV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL("./examples/alpha-vertical-proof-manifest-v0.2.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

export function patchExportFixtureV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/patch-export-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

export function patchResultFixtureV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/patch-result-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

export function deltaPackageFixtureV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/delta-package-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

export function findingFixtureV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/finding-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

export function sourceIncompatibleFailureFixture(
  options: { failureId?: string; cause?: string } = {},
): Record<string, unknown> {
  return {
    failureId: options.failureId ?? "019ed001-0000-7000-8000-00000000fa60",
    category: "source_incompatible",
    diagnosticCode: "kaifuu.patch_result.source_incompatible",
    cause: options.cause ?? "source bundle hash drifted; re-extract before re-applying",
    assetId: "019ed001-0000-7000-8000-000000000800",
    bridgeUnitId: "019ed001-0000-7000-8000-000000000201",
    adapterId: "kaifuu-reallive",
    command: "patch.write_string_slot",
  };
}

export function permissionLocalUserFixtureV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/permission-local-user-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

export function traceOnlyReferenceFidelityReport(): Record<string, unknown> {
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

export function passedReferenceComparison(): Record<string, unknown> {
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

export function observationHookEventExample(): Record<string, unknown> {
  return {
    schemaVersion: "0.1.0-alpha",
    eventId: "obs-0001",
    observedAt: "2026-06-17T00:00:00.000Z",
    eventKind: "text",
    runtimeTargetId: "fixture:runtime-target",
    adapterId: {
      name: "utsushi-contract-example",
      version: "0.2.0",
    },
    evidenceTier: "E1",
    environment: {
      runtime: "browser",
      engine: "fixture-engine",
      platform: "linux",
      locale: "fr-FR",
    },
    sourceRevision: {
      sourceId: "fixture-source",
      revisionId: "rev-1",
    },
    bridgeRefs: [
      {
        bridgeUnitId: "019ed001-0000-7000-8000-000000000201",
        sourceUnitKey: "script/prologue#line-001",
      },
    ],
    redaction: {
      status: "not_required",
    },
    payload: {
      payloadKind: "text",
      text: "Bonjour, {player}.",
      speaker: "Narrator",
      textSurface: "dialogue",
    },
  };
}

export function exampleFixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

export function publicFixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

export function publicFixtureBytes(path: string): Buffer {
  return readFileSync(new URL(`../../../${path}`, import.meta.url));
}

export function publicFixtureSha256(path: string): string {
  return createHash("sha256").update(publicFixtureBytes(path)).digest("hex");
}

export const PUBLIC_HELLO_GAME_GOLDEN_ARTIFACTS = [
  {
    path: "fixtures/hello-game/expected/bridge-v0.2.json",
    role: "bridge-bundle",
    kind: "bridge-v0.2",
  },
  {
    path: "fixtures/hello-game/expected/patch-export-v0.2.fr-FR.json",
    role: "patch-export",
    kind: "patch-export-v0.2",
  },
  {
    path: "fixtures/hello-game/expected/patch-result-v0.2.fr-FR.json",
    role: "patch-result",
    kind: "patch-result-v0.2",
  },
  {
    path: "fixtures/hello-game/expected/delta-package-v0.2.fr-FR.json",
    role: "delta-package",
    kind: "delta-package-v0.2",
  },
  {
    path: "fixtures/hello-game/expected/runtime-report-v0.2.fr-FR.json",
    role: "runtime-report",
    kind: "runtime-evidence-v0.2",
  },
  {
    path: "fixtures/hello-game/expected/benchmark-report-v0.2.fr-FR.json",
    role: "benchmark-report",
    kind: "benchmark-report-v0.2",
  },
  {
    path: "fixtures/hello-game/expected/finding-v0.2.fr-FR.json",
    role: "finding",
    kind: "finding-v0.2",
  },
] as const;

export const PUBLIC_SEEDED_DEFECT_GOLDEN_ARTIFACTS = [
  {
    path: "fixtures/seeded-localization-defects/expected/benchmark-report-v0.2.en-US.json",
    role: "benchmark-report",
    kind: "benchmark-report-v0.2",
  },
] as const;

export function bridgeV02Units(bridge: Record<string, unknown>): Array<Record<string, unknown>> {
  return bridge.units as Array<Record<string, unknown>>;
}

export function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function setBenchmarkCountBucket(
  buckets: Array<Record<string, unknown>>,
  bucket: string,
  count: number,
): void {
  const record = buckets.find((candidate) => candidate.bucket === bucket);
  expect(record, `benchmark count bucket ${bucket}`).toBeDefined();
  record!.count = count;
}

export function addRawMtlLlmQaCoverage(report: Record<string, unknown>): void {
  const systems = report.systemsCompared as Array<Record<string, unknown>>;
  const rawMtlSystem = asTestRecord(
    systems.find((system) => system.systemId === "raw-mtl-baseline"),
    "raw MTL benchmark system",
  );
  (rawMtlSystem.providerRunIds as string[]).push("019ed006-0000-7000-8000-000000000104");

  const providerRecords = report.providerModelCostRecords as Array<Record<string, unknown>>;
  const llmQaProviderRecord = asTestRecord(
    providerRecords.find((record) => record.taskKind === "llm_qa"),
    "benchmark llm_qa provider record",
  );
  const rawMtlQaProviderRecord = cloneRecord(llmQaProviderRecord);
  rawMtlQaProviderRecord.providerRunId = "019ed006-0000-7000-8000-000000000104";
  rawMtlQaProviderRecord.systemId = "raw-mtl-baseline";
  rawMtlQaProviderRecord.startedAt = "2026-06-17T15:00:12.000Z";
  rawMtlQaProviderRecord.completedAt = "2026-06-17T15:00:13.000Z";
  rawMtlQaProviderRecord.latencyMs = 1000;
  rawMtlQaProviderRecord.tokenUsage = {
    tokenCountSource: "deterministic_counter",
    promptTokens: 12,
    completionTokens: 8,
    totalTokens: 20,
  };
  rawMtlQaProviderRecord.cost = {
    costKind: "zero",
    currency: "USD",
    amountMicrosUsd: 0,
  };
  providerRecords.push(rawMtlQaProviderRecord);

  const findings = report.findingRecords as Array<Record<string, unknown>>;
  const llmQaFinding = asTestRecord(
    findings.find((finding) => finding.detectorKind === "llm_qa"),
    "benchmark llm_qa finding",
  );
  const rawMtlFinding = cloneRecord(llmQaFinding);
  rawMtlFinding.findingId = "019ed006-0000-7000-8000-000000000303";
  rawMtlFinding.systemId = "raw-mtl-baseline";
  rawMtlFinding.category = "accuracy";
  rawMtlFinding.qualitySubcategory = "mistranslation";
  rawMtlFinding.rootCause = "model_draft_error";
  delete rawMtlFinding.seededDefectId;
  findings.push(rawMtlFinding);

  setBenchmarkCountBucket(
    report.countsByQualitySeverity as Array<Record<string, unknown>>,
    "major",
    3,
  );
  setBenchmarkCountBucket(report.countsByCategory as Array<Record<string, unknown>>, "accuracy", 2);
  setBenchmarkCountBucket(
    report.countsByRootCause as Array<Record<string, unknown>>,
    "model_draft_error",
    2,
  );
  setBenchmarkCountBucket(
    report.countsByDetectorKind as Array<Record<string, unknown>>,
    "llm_qa",
    2,
  );
  setBenchmarkCountBucket(
    report.countsByAdjudicationState as Array<Record<string, unknown>>,
    "confirmed",
    3,
  );
  const penaltySummary = asTestRecord(report.penaltySummary, "benchmark penalty summary");
  penaltySummary.penaltyTotal = 15;
  penaltySummary.penaltyPerThousandSourceChars = 483.87;
  penaltySummary.penaltyPerHundredSourceUnits = 750;

  const qaAgentEvaluations = report.qaAgentEvaluations as Array<Record<string, unknown>>;
  const qaAgentEvaluation = asTestRecord(qaAgentEvaluations[0], "benchmark QA-agent evaluation");
  const rawMtlQaAgentEvaluation = cloneRecord(qaAgentEvaluation);
  rawMtlQaAgentEvaluation.qaAgentEvaluationId = "019ed006-0000-7000-8000-000000000904";
  rawMtlQaAgentEvaluation.evaluatedSystemId = "raw-mtl-baseline";
  rawMtlQaAgentEvaluation.providerRunIds = ["019ed006-0000-7000-8000-000000000104"];
  rawMtlQaAgentEvaluation.findingIds = ["019ed006-0000-7000-8000-000000000303"];
  qaAgentEvaluations.push(rawMtlQaAgentEvaluation);

  const humanEvaluations = report.humanEvaluationResults as Array<Record<string, unknown>>;
  const humanEvaluation = asTestRecord(humanEvaluations[0], "benchmark human evaluation");
  (humanEvaluation.adjudicatedFindingIds as string[]).push("019ed006-0000-7000-8000-000000000303");
}

export function patchExportV02Example(
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
    entries: units.map((unit, index) => {
      const spans = (unit.spans as Array<Record<string, unknown>> | undefined) ?? [];
      const firstSpan = spans[0];
      return {
        entryId: `019ed001-0000-7000-8000-00000000091${index}`,
        bridgeUnitId: unit.bridgeUnitId,
        sourceUnitKey: unit.sourceUnitKey,
        sourceHash: unit.sourceHash,
        sourceRevision: cloneRecord(unit.sourceRevision),
        targetText: index === 0 ? "Bonjour, {player}." : "La porte s'ouvre.",
        protectedSpanMappings:
          index === 0 && firstSpan !== undefined
            ? [
                {
                  raw: "{player}",
                  sourceSpanId: firstSpan.spanId,
                  sourceStartByte: firstSpan.startByte,
                  sourceEndByte: firstSpan.endByte,
                  targetStart: 9,
                  targetEnd: 17,
                },
              ]
            : [],
      };
    }),
  };
}

export function asTestRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeDefined();
  return value as Record<string, unknown>;
}

export function assetPolicyDecisionById(
  assetPolicy: Record<string, unknown>,
  decisionId: string,
): Record<string, unknown> {
  const decisions = assetPolicy.decisions as Array<Record<string, unknown>>;
  const decision = decisions.find((candidate) => candidate.assetPolicyDecisionId === decisionId);
  return asTestRecord(decision, `asset policy decision ${decisionId}`);
}

export function assetPolicyAssetRevision(
  assetPolicy: Record<string, unknown>,
  assetId: string,
): Record<string, unknown> {
  const assets = assetPolicy.assets as Array<Record<string, unknown>>;
  const asset = assets.find((candidate) => candidate.assetId === assetId);
  return cloneRecord(asTestRecord(asset, `asset policy asset ${assetId}`).sourceRevision) as Record<
    string,
    unknown
  >;
}
