import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertAlphaVerticalProofManifestV02,
  assertAssetPolicyBundleV02,
  assertBridgeBundle,
  assertBridgeBundleV02,
  assertBenchmarkReportV02,
  assertContractCompatibilityReportV02,
  assertContractFixtureManifestV02,
  assertContractFixtureV02,
  assertDeltaPackageMetadataV02,
  assertFindingRecordFixtureV02,
  assertPatchExport,
  assertPatchExportV02,
  assertPatchResultV02,
  assertPermissionLocalUserFixtureV02,
  assertRuntimeEvidenceReportV02,
  assertRuntimeReport,
  assertRuntimeVerificationReport,
  assertStyleGuideConversationTranscript,
  assertTriageBundleV02,
  computePatchResultOutputHashRollupV02,
  evaluatePatchExportCompatibilityV02,
  projectStyleGuideConversationToPolicyDraft,
  validateStyleGuideConversationTranscript,
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

function assetPolicyV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/asset-policy-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function benchmarkReportV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/benchmark-report-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function contractFixtureManifestV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/contract-fixtures-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function contractCompatibilityReportV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/contract-compatibility-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function alphaVerticalProofManifestV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL("./examples/alpha-vertical-proof-manifest-v0.2.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

function patchExportFixtureV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/patch-export-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function patchResultFixtureV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/patch-result-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function deltaPackageFixtureV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/delta-package-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function findingFixtureV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/finding-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function sourceIncompatibleFailureFixture(
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

function permissionLocalUserFixtureV02Example(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("./examples/permission-local-user-v0.2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function styleGuideConversationFixture(name: string): Record<string, unknown> {
  return publicFixture(`fixtures/itotori-style-guide/conversations/${name}.json`);
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

function observationHookEventExample(): Record<string, unknown> {
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

function exampleFixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

function publicFixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

function publicFixtureBytes(path: string): Buffer {
  return readFileSync(new URL(`../../../${path}`, import.meta.url));
}

function publicFixtureSha256(path: string): string {
  return createHash("sha256").update(publicFixtureBytes(path)).digest("hex");
}

const PUBLIC_HELLO_GAME_GOLDEN_ARTIFACTS = [
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

const PUBLIC_SEEDED_DEFECT_GOLDEN_ARTIFACTS = [
  {
    path: "fixtures/seeded-localization-defects/expected/benchmark-report-v0.2.en-US.json",
    role: "benchmark-report",
    kind: "benchmark-report-v0.2",
  },
] as const;

function bridgeV02Units(bridge: Record<string, unknown>): Array<Record<string, unknown>> {
  return bridge.units as Array<Record<string, unknown>>;
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function setBenchmarkCountBucket(
  buckets: Array<Record<string, unknown>>,
  bucket: string,
  count: number,
): void {
  const record = buckets.find((candidate) => candidate.bucket === bucket);
  expect(record, `benchmark count bucket ${bucket}`).toBeDefined();
  record!.count = count;
}

function addRawMtlLlmQaCoverage(report: Record<string, unknown>): void {
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

function asTestRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeDefined();
  return value as Record<string, unknown>;
}

function assetPolicyDecisionById(
  assetPolicy: Record<string, unknown>,
  decisionId: string,
): Record<string, unknown> {
  const decisions = assetPolicy.decisions as Array<Record<string, unknown>>;
  const decision = decisions.find((candidate) => candidate.assetPolicyDecisionId === decisionId);
  return asTestRecord(decision, `asset policy decision ${decisionId}`);
}

function assetPolicyAssetRevision(
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

describe("localization bridge schema guards", () => {
  it("has explicit validation expectations for each top-level example fixture", () => {
    const manifest = contractFixtureManifestV02Example();
    assertContractFixtureManifestV02(manifest);
    const expectedTopLevelFixtures = new Set(
      (manifest.validFixtures as Array<{ path: string }>)
        .map((fixture) => fixture.path)
        .filter((path) => path.startsWith("./") && !path.startsWith("./invalid/"))
        .map((path) => path.slice(2)),
    );
    const topLevelFixtures = readdirSync(new URL("./examples", import.meta.url)).filter((entry) =>
      entry.endsWith(".json"),
    );

    expect(new Set(topLevelFixtures)).toEqual(expectedTopLevelFixtures);
  });

  it("validates every committed contract fixture listed in the manifest", () => {
    const manifest = contractFixtureManifestV02Example();
    assertContractFixtureManifestV02(manifest);

    for (const fixture of manifest.validFixtures as Array<{ kind: string; path: string }>) {
      expect(() =>
        assertContractFixtureV02(
          fixture.kind,
          exampleFixture(`./examples/${fixture.path.slice(2)}`),
        ),
      ).not.toThrow();
    }
  });

  it("rejects every invalid contract fixture listed in the manifest with semantic errors", () => {
    const manifest = contractFixtureManifestV02Example();
    assertContractFixtureManifestV02(manifest);

    for (const fixture of manifest.invalidFixtures as Array<{
      kind: string;
      path: string;
      expectedSemanticError: string;
    }>) {
      expect(() =>
        assertContractFixtureV02(
          fixture.kind,
          exampleFixture(`./examples/${fixture.path.slice(2)}`),
        ),
      ).toThrow(new RegExp(fixture.expectedSemanticError));
    }
  });

  it("validates the committed contract compatibility report", () => {
    const report = contractCompatibilityReportV02Example();

    expect(() => assertContractCompatibilityReportV02(report)).not.toThrow();
  });

  it("projects accepted style-guide conversation fixtures into deterministic policy drafts", () => {
    const transcript = styleGuideConversationFixture("accepted");

    expect(() => assertStyleGuideConversationTranscript(transcript)).not.toThrow();

    const draft = projectStyleGuideConversationToPolicyDraft(transcript);
    expect(draft).toEqual({
      localeBranchId: "019ed063-0000-7000-8000-000000000010",
      styleGuideVersionId: "019ed063-0000-7000-8000-000000000030",
      expectedPreviousVersionId: "019ed063-0000-7000-8000-000000000020",
      sourceTranscriptId: "style-guide-conversation-accepted",
      acceptedProposalIds: [
        "019ed063-0000-7000-8000-000000000201",
        "019ed063-0000-7000-8000-000000000202",
        "019ed063-0000-7000-8000-000000000203",
        "019ed063-0000-7000-8000-000000000204",
        "019ed063-0000-7000-8000-000000000205",
      ],
      policy: {
        schemaVersion: "style-guide-policy.v0",
        sections: {
          tone: [
            {
              ruleId: "tone-player-address-warm-direct",
              guidance:
                "Use warm, direct player address in tutorial-adjacent dialogue; avoid slang or sarcasm.",
            },
          ],
          terminology: [
            {
              ruleId: "term-player-placeholder-preserve",
              guidance: "Preserve {player} exactly, including braces, in every target string.",
            },
          ],
          honorifics: [
            {
              ruleId: "honorifics-character-names-preserve",
              guidance:
                "Preserve named-character honorifics unless an explicit speaker note says to localize or omit them.",
            },
          ],
          formatting: [
            {
              ruleId: "formatting-message-window-concise",
              guidance:
                "Keep message-window lines concise and avoid adding extra clauses that expand the line count.",
            },
          ],
          protectedSpans: [
            {
              ruleId: "protected-placeholder-exact",
              guidance:
                "Protected placeholder spans must remain byte-for-byte identical unless a span mapping policy says otherwise.",
            },
          ],
        },
      },
    });
  });

  it("keeps rejected style-guide proposals out of projected policy drafts", () => {
    const transcript = styleGuideConversationFixture("rejected");

    expect(() => assertStyleGuideConversationTranscript(transcript)).not.toThrow();

    expect(projectStyleGuideConversationToPolicyDraft(transcript)).toMatchObject({
      sourceTranscriptId: "style-guide-conversation-rejected",
      acceptedProposalIds: [],
      policy: {
        schemaVersion: "style-guide-policy.v0",
        sections: {
          tone: [],
          terminology: [],
          honorifics: [],
          formatting: [],
          protectedSpans: [],
        },
      },
    });
  });

  it("rejects detached accepted style-guide proposals before projection", () => {
    const transcript = styleGuideConversationFixture("accepted");
    const turns = transcript.turns as Array<Record<string, unknown>>;
    const proposalTurn = asTestRecord(
      turns.find((turn) => turn.turnId === "turn-assistant-proposals"),
      "style-guide proposal turn",
    );
    proposalTurn.proposalIds = [];

    const diagnostics = validateStyleGuideConversationTranscript(transcript);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        turnId: "turn-assistant-proposals",
        field: "$.turns[2].proposalIds",
        rule: "style_guide_conversation.proposal.turn_proposal_id_membership",
        proposalId: "019ed063-0000-7000-8000-000000000201",
      }),
    );
    expect(() => projectStyleGuideConversationToPolicyDraft(transcript)).toThrow(
      /turn_proposal_id_membership/,
    );
  });

  it("reports malformed style-guide transcript diagnostics with turn, field, and rule", () => {
    const transcript = styleGuideConversationFixture("malformed");

    const diagnostics = validateStyleGuideConversationTranscript(transcript);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        turnId: "turn-malformed-assistant",
        field: "$.turns[0].role",
        rule: "style_guide_conversation.turn.role",
      }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        turnId: "turn-malformed-assistant",
        field: "$.proposals[0].rationale",
        rule: "style_guide_conversation.proposal.rationale_required",
        proposalId: "019ed063-0000-7000-8000-000000000221",
      }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        turnId: "turn-malformed-assistant",
        field: "$.proposals[0].edits[0].section",
        rule: "style_guide_conversation.proposal.unsupported_policy_section",
      }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        turnId: "turn-malformed-assistant",
        field: "$.proposals[0].examples[0].redactionStatus",
        rule: "style_guide_conversation.proposal.private_example_redacted",
      }),
    );
    expect(() => assertStyleGuideConversationTranscript(transcript)).toThrow(
      /turn turn-malformed-assistant field .* failed style_guide_conversation\./,
    );
  });

  it("rejects conflicting accepted style-guide proposals before projection", () => {
    const transcript = styleGuideConversationFixture("conflicting");

    const diagnostics = validateStyleGuideConversationTranscript(transcript);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        turnId: "turn-conflict-proposals",
        field: "$.proposals[].edits",
        rule: "style_guide_conversation.projection.conflicting_accepted_edit",
        proposalId: "019ed063-0000-7000-8000-000000000232",
      }),
    );
    expect(() => projectStyleGuideConversationToPolicyDraft(transcript)).toThrow(
      /conflicting_accepted_edit/,
    );
  });

  it("rejects style-guide proposals with conflicting edits in a single proposal", () => {
    const transcript = styleGuideConversationFixture("accepted");
    const proposals = transcript.proposals as Array<Record<string, unknown>>;
    const proposal = asTestRecord(proposals[0], "first style-guide proposal");
    const edits = proposal.edits as Array<Record<string, unknown>>;
    const conflictingEdit = cloneRecord(edits[0]);
    const rule = asTestRecord(conflictingEdit.rule, "style-guide proposal rule");
    rule.guidance = "Use detached, formal player address.";
    edits.push(conflictingEdit);

    const diagnostics = validateStyleGuideConversationTranscript(transcript);

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        turnId: "turn-assistant-proposals",
        field: "$.proposals[0].edits[1]",
        rule: "style_guide_conversation.proposal.conflicting_edits",
        proposalId: "019ed063-0000-7000-8000-000000000201",
      }),
    );
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

  it("accepts the public multi-surface bridge golden snapshot", () => {
    const bridge = publicFixture("fixtures/hello-game/expected/bridge-v0.1.json");

    expect(() => assertBridgeBundle(bridge)).not.toThrow();

    const units = bridge.units as Array<{
      textSurface: string;
      protectedSpans: Array<{ kind: string; raw: string }>;
    }>;
    expect(new Set(units.map((unit) => unit.textSurface))).toEqual(
      new Set([
        "choice_label",
        "database_entry",
        "dialogue",
        "image_text",
        "metadata_text",
        "speaker_name",
        "tutorial_text",
        "ui_label",
      ]),
    );
    expect(units).toHaveLength(11);

    const spanKinds = new Set(
      units.flatMap((unit) => unit.protectedSpans.map((span) => span.kind)),
    );
    expect(spanKinds).toContain("variable_placeholder");
    expect(spanKinds).toContain("control_markup");
  });

  it("rejects malformed v0.1 protected span ranges", () => {
    const bridge = {
      schemaVersion: "0.1.0",
      bridgeId: "019ed000-0000-7000-8000-000000000001",
      sourceBundleHash: "hash",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [
        {
          bridgeUnitId: "019ed000-0000-7000-8000-bridgeun0001",
          sourceUnitKey: "line.001",
          occurrenceId: "occurrence-1",
          sourceHash: "hash",
          sourceLocale: "ja-JP",
          sourceText: "Hello, {player}.",
          speaker: "",
          textSurface: "dialogue",
          protectedSpans: [
            {
              kind: "variable_placeholder",
              raw: "{player}",
              start: 0,
              end: 8,
              preserveMode: "map",
              variableName: "player",
            },
          ],
          patchRef: {
            assetId: "source.json",
            writeMode: "replace",
            sourceUnitKey: "line.001",
          },
        },
      ],
    };

    expect(() => assertBridgeBundle(bridge)).toThrow(/raw must match sourceText byte range/);
  });

  it("accepts the public full-system hello-game v0.2 golden artifact corpus", () => {
    const manifest = publicFixture("fixtures/public/hello-game.manifest.json");
    const manifestFiles = manifest.files as Array<{
      path: string;
      role: string;
      redistributable: boolean;
    }>;

    for (const artifact of PUBLIC_HELLO_GAME_GOLDEN_ARTIFACTS) {
      expect(manifestFiles).toContainEqual(
        expect.objectContaining({
          path: artifact.path,
          role: artifact.role,
          redistributable: true,
        }),
      );
      expect(() =>
        assertContractFixtureV02(artifact.kind, publicFixture(artifact.path)),
      ).not.toThrow();
    }

    const expectedRoles = new Set([
      "patch-export",
      "patch-result",
      "delta-package",
      "runtime-report",
      "benchmark-report",
      "finding",
    ]);
    const manifestRoles = new Set(manifestFiles.map((file) => file.role));
    for (const role of expectedRoles) {
      expect(manifestRoles).toContain(role);
    }

    const bridge = publicFixture("fixtures/hello-game/expected/bridge-v0.2.json");
    const patchExport = publicFixture("fixtures/hello-game/expected/patch-export-v0.2.fr-FR.json");
    const patchResult = publicFixture("fixtures/hello-game/expected/patch-result-v0.2.fr-FR.json");
    const deltaPackage = publicFixture(
      "fixtures/hello-game/expected/delta-package-v0.2.fr-FR.json",
    );
    const runtimeReport = publicFixture(
      "fixtures/hello-game/expected/runtime-report-v0.2.fr-FR.json",
    );
    const benchmarkReport = publicFixture(
      "fixtures/hello-game/expected/benchmark-report-v0.2.fr-FR.json",
    );
    const finding = publicFixture("fixtures/hello-game/expected/finding-v0.2.fr-FR.json");

    expect(() => assertBridgeBundleV02(bridge)).not.toThrow();
    expect(() => assertPatchExportV02(patchExport)).not.toThrow();
    expect(() => assertPatchResultV02(patchResult)).not.toThrow();
    expect(() => assertDeltaPackageMetadataV02(deltaPackage)).not.toThrow();
    expect(() => assertRuntimeEvidenceReportV02(runtimeReport)).not.toThrow();
    expect(() => assertRuntimeReport(runtimeReport)).not.toThrow();
    expect(() => assertBenchmarkReportV02(benchmarkReport)).not.toThrow();
    expect(() => assertFindingRecordFixtureV02(finding)).not.toThrow();

    const bridgeUnits = bridge.units as Array<Record<string, unknown>>;
    const bridgeUnitIds = new Set(bridgeUnits.map((unit) => unit.bridgeUnitId));
    const patchEntries = patchExport.entries as Array<Record<string, unknown>>;
    expect(patchExport.sourceBridgeId).toBe(bridge.bridgeId);
    expect(patchExport.sourceBundleHash).toBe(bridge.sourceBundleHash);
    expect(patchExport.targetLocale).toBe("fr-FR");
    expect(patchEntries).toHaveLength(bridgeUnits.length);
    expect(patchEntries.every((entry) => bridgeUnitIds.has(entry.bridgeUnitId))).toBe(true);

    const sourceCompatibility = asTestRecord(
      patchResult.sourceCompatibility,
      "public patch result source compatibility",
    );
    expect(patchResult.patchExportId).toBe(patchExport.patchExportId);
    expect(sourceCompatibility.status).toBe("compatible");
    expect(sourceCompatibility.compatibleUnits).toHaveLength(patchEntries.length);

    expect(deltaPackage.sourceBridgeId).toBe(bridge.bridgeId);
    expect(deltaPackage.generatedPatchExportId).toBe(patchExport.patchExportId);
    expect(deltaPackage.generatedPatchExportHash).toBe(patchExport.patchExportHash);

    const traceEvents = runtimeReport.traceEvents as Array<{
      bridgeUnitRef: { bridgeUnitId: string };
    }>;
    expect(traceEvents.length).toBeGreaterThan(0);
    expect(traceEvents.every((event) => bridgeUnitIds.has(event.bridgeUnitRef.bridgeUnitId))).toBe(
      true,
    );
    expect(runtimeReport.fidelityTier).toBe("trace_only");

    const fixtureRefs = benchmarkReport.fixtureOrCorpusRefs as Array<Record<string, unknown>>;
    expect(fixtureRefs).toContainEqual(
      expect.objectContaining({
        corpusKind: "public_fixture",
        manifestUri: "fixtures/public/hello-game.manifest.json",
        publicContent: true,
      }),
    );

    const findingRecord = asTestRecord(finding.finding, "public standalone finding");
    expect(findingRecord.affectedRefs).toContainEqual(
      expect.objectContaining({
        subjectKind: "bridge_unit",
        subjectId: bridgeUnits[2]?.bridgeUnitId,
      }),
    );
  });

  it("accepts the public alpha vertical proof manifest fixture", () => {
    const manifest = publicFixture("fixtures/public/hello-game-alpha-vertical-proof.manifest.json");
    const proofPath = "fixtures/alpha-vertical-proof/hello-game-alpha-proof-v0.2.fr-FR.json";
    const proofManifest = publicFixture(proofPath);
    const manifestFiles = manifest.files as Array<{
      path: string;
      role: string;
      sha256: string;
      redistributable: boolean;
    }>;

    expect(manifestFiles).toContainEqual(
      expect.objectContaining({
        path: proofPath,
        role: "alpha-proof-manifest",
        sha256: publicFixtureSha256(proofPath),
        redistributable: true,
      }),
    );
    expect(() => assertAlphaVerticalProofManifestV02(proofManifest)).not.toThrow();
    expect(proofManifest.fixture).toEqual(
      expect.objectContaining({
        fixtureId: "hello-game",
        publicManifestUri: "fixtures/public/hello-game.manifest.json",
        publicRedistribution: "allowed",
      }),
    );
    expect(proofManifest.runtimeTargetIds).toEqual(
      expect.arrayContaining([
        "kaifuu-fixture:patch-apply:fr-FR",
        "utsushi-fixture:web-review:fr-FR",
      ]),
    );
  });

  it.each([
    {
      name: "missing provider proof hash",
      mutate: (proofManifest: Record<string, unknown>) => {
        proofManifest.contentHashes = (
          proofManifest.contentHashes as Array<Record<string, unknown>>
        ).filter((entry) => entry.scope !== "provider_proof");
      },
      semanticError: /contentHashes must include provider_proof/,
    },
    {
      name: "missing bridge unit hashes",
      mutate: (proofManifest: Record<string, unknown>) => {
        proofManifest.contentHashes = (
          proofManifest.contentHashes as Array<Record<string, unknown>>
        ).filter((entry) => entry.scope !== "bridge_unit");
      },
      semanticError: /contentHashes must include bridge_unit/,
    },
    {
      name: "mismatched provider proof content id",
      mutate: (proofManifest: Record<string, unknown>) => {
        const providerHash = (proofManifest.contentHashes as Array<Record<string, unknown>>).find(
          (entry) => entry.scope === "provider_proof",
        );
        expect(providerHash).toBeDefined();
        providerHash!.contentId = "019ed025-0000-7000-8000-000000000202";
      },
      semanticError: /providerProofIds\[0\].*contentHashes/,
    },
    {
      name: "mismatched patch export content id",
      mutate: (proofManifest: Record<string, unknown>) => {
        const patchExportHash = (
          proofManifest.contentHashes as Array<Record<string, unknown>>
        ).find((entry) => entry.scope === "patch_export");
        expect(patchExportHash).toBeDefined();
        patchExportHash!.contentId = "fixtures/hello-game/expected/patch-export-other.json";
      },
      semanticError: /artifactRefs\.patch_export\.hash.*contentHashes/,
    },
  ])("rejects alpha proof manifests with $name", ({ mutate, semanticError }) => {
    const proofManifest = alphaVerticalProofManifestV02Example();
    mutate(proofManifest);

    expect(() => assertAlphaVerticalProofManifestV02(proofManifest)).toThrow(semanticError);
  });

  it("binds alpha proof fixture publicManifestHash to artifact refs and content hashes", () => {
    const proofManifest = alphaVerticalProofManifestV02Example();
    const fixture = asTestRecord(proofManifest.fixture, "alpha proof fixture");
    fixture.publicManifestHash =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    expect(() => assertAlphaVerticalProofManifestV02(proofManifest)).toThrow(
      /fixture\.publicManifestHash.*publicFixtureManifest\.hash/,
    );

    const alignedProofManifest = alphaVerticalProofManifestV02Example();
    const alignedFixture = asTestRecord(alignedProofManifest.fixture, "aligned alpha fixture");
    const artifactRefs = asTestRecord(alignedProofManifest.artifactRefs, "aligned artifact refs");
    const publicFixtureManifestRef = asTestRecord(
      artifactRefs.publicFixtureManifest,
      "aligned public fixture manifest ref",
    );
    const publicFixtureHash = (
      alignedProofManifest.contentHashes as Array<Record<string, unknown>>
    ).find((entry) => entry.scope === "public_fixture_manifest");
    expect(publicFixtureHash).toBeDefined();

    alignedFixture.publicManifestHash =
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    publicFixtureManifestRef.hash = alignedFixture.publicManifestHash;
    publicFixtureHash!.hash = alignedFixture.publicManifestHash;

    expect(() => assertAlphaVerticalProofManifestV02(alignedProofManifest)).not.toThrow();
  });

  it("accepts the public seeded localization defect benchmark report", () => {
    const manifest = publicFixture("fixtures/public/seeded-localization-defects.manifest.json");
    const manifestFiles = manifest.files as Array<{
      path: string;
      role: string;
      redistributable: boolean;
    }>;

    expect(manifestFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "fixtures/seeded-localization-defects/source.json",
          role: "source-game",
          redistributable: true,
        }),
        expect.objectContaining({
          path: "fixtures/seeded-localization-defects/seeded-defect-oracle-v0.1.json",
          role: "metadata",
          redistributable: true,
        }),
        expect.objectContaining({
          path: "fixtures/seeded-localization-defects/false-positive-cases-v0.1.json",
          role: "metadata",
          redistributable: true,
        }),
        expect.objectContaining({
          path: "fixtures/seeded-localization-defects/defect-coverage-matrix-v0.1.json",
          role: "metadata",
          redistributable: true,
        }),
      ]),
    );

    for (const artifact of PUBLIC_SEEDED_DEFECT_GOLDEN_ARTIFACTS) {
      expect(manifestFiles).not.toContainEqual(expect.objectContaining({ path: artifact.path }));
      expect(() =>
        assertContractFixtureV02(artifact.kind, publicFixture(artifact.path)),
      ).not.toThrow();
    }

    const benchmarkReport = publicFixture(
      "fixtures/seeded-localization-defects/expected/benchmark-report-v0.2.en-US.json",
    );
    const findings = benchmarkReport.findingRecords as Array<Record<string, unknown>>;

    expect(() => assertBenchmarkReportV02(benchmarkReport)).not.toThrow();
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ qualitySeverity: "critical", category: "protected_content" }),
        expect.objectContaining({
          qualitySeverity: "neutral",
          adjudicationState: "rejected_false_positive",
        }),
      ]),
    );
  });

  it("keeps the seeded localization defect oracle, coverage matrix, report, manifest, and taxonomy aligned", () => {
    const taxonomy = publicFixture("docs/localization-quality-taxonomy.json");
    const oracle = publicFixture(
      "fixtures/seeded-localization-defects/seeded-defect-oracle-v0.1.json",
    );
    const falsePositiveCases = publicFixture(
      "fixtures/seeded-localization-defects/false-positive-cases-v0.1.json",
    );
    const coverageMatrix = publicFixture(
      "fixtures/seeded-localization-defects/defect-coverage-matrix-v0.1.json",
    );
    const benchmarkReport = publicFixture(
      "fixtures/seeded-localization-defects/expected/benchmark-report-v0.2.en-US.json",
    );

    const categorySubcategories = new Map(
      (taxonomy.categories as Array<Record<string, unknown>>).map((category) => [
        category.id as string,
        new Set(
          (category.subcategories as Array<Record<string, unknown>>).map(
            (subcategory) => subcategory.id as string,
          ),
        ),
      ]),
    );
    const seededDefectKinds = new Map(
      (taxonomy.seededDefectKinds as Array<Record<string, unknown>>).map((kind) => [
        kind.id as string,
        kind,
      ]),
    );
    const seededDefects = oracle.seededDefects as Array<Record<string, unknown>>;
    const seededDefectsById = new Map(
      seededDefects.map((defect) => [defect.seededDefectId as string, defect]),
    );
    const falsePositiveCasesById = new Map(
      (falsePositiveCases.cases as Array<Record<string, unknown>>).map((testCase) => [
        testCase.falsePositiveCaseId as string,
        testCase,
      ]),
    );
    const reportOracleById = new Map(
      (benchmarkReport.seededDefectOracle as Array<Record<string, unknown>>).map((defect) => [
        defect.seededDefectId as string,
        defect,
      ]),
    );
    const reportFindings = benchmarkReport.findingRecords as Array<Record<string, unknown>>;
    const reportFindingsBySeededDefectId = new Map(
      reportFindings
        .filter((finding) => typeof finding.seededDefectId === "string")
        .map((finding) => [finding.seededDefectId as string, finding]),
    );

    for (const seededDefect of seededDefects) {
      const defectId = seededDefect.seededDefectId as string;
      const category = seededDefect.category as string;
      const qualitySubcategory = seededDefect.qualitySubcategory as string;
      expect(
        categorySubcategories.get(category)?.has(qualitySubcategory),
        `${defectId} uses known taxonomy pair ${category}/${qualitySubcategory}`,
      ).toBe(true);

      const seededDefectKind = asTestRecord(
        seededDefectKinds.get(seededDefect.seedKind as string),
        `taxonomy seededDefectKinds.${String(seededDefect.seedKind)}`,
      );
      expect(seededDefectKind).toMatchObject({
        category,
        subcategory: qualitySubcategory,
        expectedRootCause: seededDefect.expectedRootCause,
      });

      const reportOracle = asTestRecord(
        reportOracleById.get(defectId),
        `report oracle ${defectId}`,
      );
      expect(reportOracle).toMatchObject({
        seedKind: seededDefect.seedKind,
        category,
        qualitySubcategory,
        qualitySeverity: seededDefect.qualitySeverity,
        expectedRootCause: seededDefect.expectedRootCause,
      });
      expect(new Set(reportOracle.expectedDetectorKinds as string[])).toEqual(
        new Set(seededDefect.expectedDetectorKinds as string[]),
      );

      const reportFinding = asTestRecord(
        reportFindingsBySeededDefectId.get(defectId),
        `report finding for ${defectId}`,
      );
      expect(reportFinding).toMatchObject({
        category,
        qualitySubcategory,
        qualitySeverity: seededDefect.qualitySeverity,
      });
    }

    for (const coverage of coverageMatrix.coverage as Array<Record<string, unknown>>) {
      const category = coverage.category as string;
      const qualitySubcategory = coverage.qualitySubcategory as string;
      expect(
        categorySubcategories.get(category)?.has(qualitySubcategory),
        `${String(coverage.acceptanceCase)} uses known taxonomy pair`,
      ).toBe(true);

      for (const defectId of (coverage.seededDefectIds as string[] | undefined) ?? []) {
        const seededDefect = asTestRecord(
          seededDefectsById.get(defectId),
          `coverage seeded defect ${defectId}`,
        );
        expect(seededDefect).toMatchObject({ category, qualitySubcategory });
      }

      for (const falsePositiveCaseId of (coverage.falsePositiveCaseIds as string[] | undefined) ??
        []) {
        const falsePositiveCase = asTestRecord(
          falsePositiveCasesById.get(falsePositiveCaseId),
          `coverage false positive ${falsePositiveCaseId}`,
        );
        expect(falsePositiveCase).toMatchObject({
          candidateCategory: category,
          candidateQualitySubcategory: qualitySubcategory,
        });
      }
    }

    for (const falsePositiveCase of falsePositiveCases.cases as Array<Record<string, unknown>>) {
      const finding = asTestRecord(
        reportFindings.find((candidate) =>
          (candidate.affectedRefs as Array<Record<string, unknown>>).some(
            (affectedRef) => affectedRef.subjectId === falsePositiveCase.affectedBridgeUnitId,
          ),
        ),
        `report false positive ${String(falsePositiveCase.falsePositiveCaseId)}`,
      );
      expect(finding).toMatchObject({
        detectorKind: falsePositiveCase.detectorKind,
        category: falsePositiveCase.candidateCategory,
        qualitySubcategory: falsePositiveCase.candidateQualitySubcategory,
        qualitySeverity: falsePositiveCase.qualitySeverity,
        adjudicationState: falsePositiveCase.adjudicationState,
      });
    }

    const fixtureRef = asTestRecord(
      (benchmarkReport.fixtureOrCorpusRefs as Array<Record<string, unknown>>).find(
        (ref) => ref.manifestUri === "fixtures/public/seeded-localization-defects.manifest.json",
      ),
      "seeded benchmark report fixture ref",
    );
    expect(fixtureRef.manifestHash).toBe(
      `sha256:${publicFixtureSha256("fixtures/public/seeded-localization-defects.manifest.json")}`,
    );
  });

  it("accepts the v0.2 bridge surface example", () => {
    const bridge = bridgeV02Example();

    expect(() => assertBridgeBundleV02(bridge)).not.toThrow();

    const units = bridge.units as Array<{ speaker?: { knowledgeState?: string } }>;
    const speakerStates = units.map((unit) => unit.speaker?.knowledgeState).filter(Boolean);
    expect(speakerStates).toContain("parser_unknown");
    expect(speakerStates).toContain("reader_unknown");
  });

  it("rejects duplicate v0.2 bridge unit ids", () => {
    const bridge = bridgeV02Example();
    const units = bridge.units as Array<Record<string, unknown>>;
    const firstUnit = units[0]!;
    const secondUnit = units[1]!;
    units[1] = { ...secondUnit, bridgeUnitId: firstUnit.bridgeUnitId };

    expect(() => assertBridgeBundleV02(bridge)).toThrow(
      /BridgeBundleV02\.units\[1\]\.bridgeUnitId must be unique/,
    );
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
    firstProviderRecord.cost = { costKind: "unknown", currency: "USD" };
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

  it("accepts textless non-font asset policy decisions without fake source text", () => {
    const assetPolicy = assetPolicyV02Example();

    expect(() => assertAssetPolicyBundleV02(assetPolicy)).not.toThrow();

    const uiArtDecision = assetPolicyDecisionById(
      assetPolicy,
      "019ed004-0000-7000-8000-000000000307",
    );
    const videoDecision = assetPolicyDecisionById(
      assetPolicy,
      "019ed004-0000-7000-8000-000000000308",
    );

    expect(uiArtDecision.assetSurfaceKind).toBe("ui_art");
    expect(uiArtDecision.textSourceKind).toBe("not_applicable");
    expect(uiArtDecision.sourceText).toBeUndefined();
    expect(videoDecision.assetSurfaceKind).toBe("video");
    expect(videoDecision.textSourceKind).toBe("not_applicable");
    expect(videoDecision.sourceText).toBeUndefined();
  });

  it("rejects asset policies without locale-branch scope", () => {
    const assetPolicy = assetPolicyV02Example();
    const localeBranch = asTestRecord(assetPolicy.localeBranch, "asset policy locale branch");
    delete localeBranch.localeBranchId;

    expect(() => assertAssetPolicyBundleV02(assetPolicy)).toThrow(/localeBranchId/);
  });

  it("rejects asset policy decisions with dangling asset refs", () => {
    const assetPolicy = assetPolicyV02Example();
    const decisions = assetPolicy.decisions as Array<Record<string, unknown>>;
    const firstDecision = asTestRecord(decisions[0], "first asset policy decision");
    const sourceAssetRef = asTestRecord(
      firstDecision.sourceAssetRef,
      "first asset policy source asset ref",
    );
    sourceAssetRef.assetId = "019ed004-0000-7000-8000-00000000ffff";

    expect(() => assertAssetPolicyBundleV02(assetPolicy)).toThrow(/sourceAssetRef\.assetId/);
  });

  it("rejects asset policy metadata-only records that imply visual runtime validation", () => {
    const assetPolicy = assetPolicyV02Example();
    const decisions = assetPolicy.decisions as Array<Record<string, unknown>>;
    const imageDecision = asTestRecord(decisions[0], "image asset policy decision");
    imageDecision.patchMode = "metadata_only";

    expect(() => assertAssetPolicyBundleV02(assetPolicy)).toThrow(/metadata_only.*metadata_only/);
  });

  it("rejects asset policy completion claims disguised as enum values", () => {
    const assetPolicy = assetPolicyV02Example();
    const decisions = assetPolicy.decisions as Array<Record<string, unknown>>;
    const uiArtDecision = asTestRecord(decisions[1], "ui art asset policy decision");
    uiArtDecision.textSourceKind = "ocr_complete";

    expect(() => assertAssetPolicyBundleV02(assetPolicy)).toThrow(/textSourceKind/);
  });

  it("rejects font substitution patch refs that point at non-font assets", () => {
    const assetPolicy = assetPolicyV02Example();
    const fontDecision = assetPolicyDecisionById(
      assetPolicy,
      "019ed004-0000-7000-8000-000000000304",
    );
    const patchRef = asTestRecord(fontDecision.patchRef, "font asset policy patch ref");
    const imageAssetId = "019ed004-0000-7000-8000-000000000101";
    patchRef.assetId = imageAssetId;
    patchRef.sourceRevision = assetPolicyAssetRevision(assetPolicy, imageAssetId);

    expect(() => assertAssetPolicyBundleV02(assetPolicy)).toThrow(
      /patchRef\.assetId assetKind image.*font_substitution_required/,
    );
  });

  it("rejects asset replacement patch refs outside the asset policy surface kind", () => {
    const assetPolicy = assetPolicyV02Example();
    const uiArtDecision = assetPolicyDecisionById(
      assetPolicy,
      "019ed004-0000-7000-8000-000000000307",
    );
    const patchRef = asTestRecord(uiArtDecision.patchRef, "textless ui art patch ref");
    const audioAssetId = "019ed004-0000-7000-8000-000000000103";
    patchRef.assetId = audioAssetId;
    patchRef.sourceRevision = assetPolicyAssetRevision(assetPolicy, audioAssetId);

    expect(() => assertAssetPolicyBundleV02(assetPolicy)).toThrow(
      /patchRef\.assetId assetKind audio.*asset_replacement_required.*ui_art/,
    );
  });

  it("accepts v0.2 patch exports with explicit source compatibility metadata", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);

    expect(() => assertPatchExportV02(patchExport)).not.toThrow();
  });

  it("accepts reordered target mappings for distinct protected spans", () => {
    const bridge = bridgeV02Example();
    const unit = asTestRecord(bridgeV02Units(bridge)[0], "first v0.2 unit");
    unit.sourceText = "{item} for {player}";
    unit.spans = [
      {
        spanId: "019ed001-0000-7000-8000-000000000831",
        spanKind: "variable_placeholder",
        raw: "{item}",
        startByte: 0,
        endByte: 6,
        preserveMode: "map",
        variableName: "item",
      },
      {
        spanId: "019ed001-0000-7000-8000-000000000832",
        spanKind: "variable_placeholder",
        raw: "{player}",
        startByte: 11,
        endByte: 19,
        preserveMode: "map",
        variableName: "player",
      },
    ];
    const patchExport = patchExportV02Example(bridge, 1);
    const entry = asTestRecord(
      (patchExport.entries as Array<Record<string, unknown>>)[0],
      "first v0.2 patch export entry",
    );
    entry.targetText = "{player} gets {item}";
    entry.protectedSpanMappings = [
      {
        raw: "{player}",
        sourceSpanId: "019ed001-0000-7000-8000-000000000832",
        sourceStartByte: 11,
        sourceEndByte: 19,
        targetStart: 0,
        targetEnd: 8,
      },
      {
        raw: "{item}",
        sourceSpanId: "019ed001-0000-7000-8000-000000000831",
        sourceStartByte: 0,
        sourceEndByte: 6,
        targetStart: 14,
        targetEnd: 20,
      },
    ];

    const report = evaluatePatchExportCompatibilityV02(patchExport, bridge);

    expect(() => assertPatchExportV02(patchExport)).not.toThrow();
    expect(report.status).toBe("compatible");
  });

  it("accepts duplicate raw protected spans when source identities and target ranges are explicit", () => {
    const bridge = bridgeV02Example();
    const unit = asTestRecord(bridgeV02Units(bridge)[0], "first v0.2 unit");
    unit.sourceText = "{name} meets {name}";
    unit.spans = [
      {
        spanId: "019ed001-0000-7000-8000-000000000841",
        spanKind: "variable_placeholder",
        raw: "{name}",
        startByte: 0,
        endByte: 6,
        preserveMode: "map",
        variableName: "name",
      },
      {
        spanId: "019ed001-0000-7000-8000-000000000842",
        spanKind: "variable_placeholder",
        raw: "{name}",
        startByte: 13,
        endByte: 19,
        preserveMode: "map",
        variableName: "name",
      },
    ];
    const patchExport = patchExportV02Example(bridge, 1);
    const entry = asTestRecord(
      (patchExport.entries as Array<Record<string, unknown>>)[0],
      "first v0.2 patch export entry",
    );
    entry.targetText = "{name} and {name}";
    entry.protectedSpanMappings = [
      {
        raw: "{name}",
        sourceSpanId: "019ed001-0000-7000-8000-000000000842",
        sourceStartByte: 13,
        sourceEndByte: 19,
        targetStart: 0,
        targetEnd: 6,
      },
      {
        raw: "{name}",
        sourceSpanId: "019ed001-0000-7000-8000-000000000841",
        sourceStartByte: 0,
        sourceEndByte: 6,
        targetStart: 11,
        targetEnd: 17,
      },
    ];

    const report = evaluatePatchExportCompatibilityV02(patchExport, bridge);

    expect(() => assertPatchExportV02(patchExport)).not.toThrow();
    expect(report.status).toBe("compatible");

    const noIdentityPatchExport = cloneRecord(patchExport);
    const noIdentityEntry = asTestRecord(
      (noIdentityPatchExport.entries as Array<Record<string, unknown>>)[0],
      "first no-identity v0.2 patch export entry",
    );
    noIdentityEntry.protectedSpanMappings = [
      { raw: "{name}", targetStart: 0, targetEnd: 6 },
      { raw: "{name}", targetStart: 11, targetEnd: 17 },
    ];

    expect(evaluatePatchExportCompatibilityV02(noIdentityPatchExport, bridge).status).toBe(
      "incompatible",
    );
  });

  it("reports protected span mapping mismatches for wrong source identity or collapsed duplicates", () => {
    const bridge = bridgeV02Example();
    const unit = asTestRecord(bridgeV02Units(bridge)[0], "first v0.2 unit");
    unit.sourceText = "{name} meets {name}";
    unit.spans = [
      {
        spanId: "019ed001-0000-7000-8000-000000000851",
        spanKind: "variable_placeholder",
        raw: "{name}",
        startByte: 0,
        endByte: 6,
        preserveMode: "map",
        variableName: "name",
      },
      {
        spanId: "019ed001-0000-7000-8000-000000000852",
        spanKind: "variable_placeholder",
        raw: "{name}",
        startByte: 13,
        endByte: 19,
        preserveMode: "map",
        variableName: "name",
      },
    ];
    const patchExport = patchExportV02Example(bridge, 1);
    const entry = asTestRecord(
      (patchExport.entries as Array<Record<string, unknown>>)[0],
      "first v0.2 patch export entry",
    );
    entry.targetText = "{name} and {name}";
    entry.protectedSpanMappings = [
      {
        raw: "{name}",
        sourceSpanId: "019ed001-0000-7000-8000-000000000851",
        sourceStartByte: 0,
        sourceEndByte: 6,
        targetStart: 0,
        targetEnd: 6,
      },
      {
        raw: "{name}",
        sourceSpanId: "019ed001-0000-7000-8000-000000000851",
        sourceStartByte: 0,
        sourceEndByte: 6,
        targetStart: 0,
        targetEnd: 6,
      },
    ];

    const report = evaluatePatchExportCompatibilityV02(patchExport, bridge);

    expect(report.status).toBe("incompatible");
    expect(report.incompatibleUnits).toEqual([
      expect.objectContaining({ reason: "protected_span_mapping_mismatch" }),
    ]);
  });

  it("accepts the committed v0.2 patch export, patch result, and delta metadata fixtures", () => {
    expect(() => assertPatchExportV02(patchExportFixtureV02Example())).not.toThrow();
    expect(() => assertPatchResultV02(patchResultFixtureV02Example())).not.toThrow();
    expect(() => assertDeltaPackageMetadataV02(deltaPackageFixtureV02Example())).not.toThrow();
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
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [
          sourceIncompatibleFailureFixture({
            cause: `source_hash_mismatch: script/prologue#line-001 expected ${HASH_UNIT_DIALOGUE_KNOWN} but found ${HASH_UNIT_DIALOGUE_KNOWN_TYPO}`,
          }),
        ],
        failureCategories: ["source_incompatible"],
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

  it("reports a bridge unit id mismatch as incompatible even when source keys and hashes match", () => {
    const bridge = bridgeV02Example();
    const patchExport = patchExportV02Example(bridge);
    const units = bridgeV02Units(bridge);
    const firstUnit = asTestRecord(units[0], "first v0.2 unit");
    const secondUnit = asTestRecord(units[1], "second v0.2 unit");
    const entries = patchExport.entries as Array<Record<string, unknown>>;
    const firstEntry = asTestRecord(entries[0], "first v0.2 patch export entry");
    firstEntry.bridgeUnitId = secondUnit.bridgeUnitId;

    const report = evaluatePatchExportCompatibilityV02(patchExport, bridge);

    expect(report.status).toBe("incompatible");
    expect(report.sourceBundleHashMatches).toBe(true);
    expect(report.incompatibleUnits).toEqual([
      expect.objectContaining({
        bridgeUnitId: secondUnit.bridgeUnitId,
        actualBridgeUnitId: firstUnit.bridgeUnitId,
        sourceUnitKey: firstUnit.sourceUnitKey,
        expectedSourceHash: firstUnit.sourceHash,
        actualSourceHash: firstUnit.sourceHash,
        reason: "bridge_unit_id_mismatch",
      }),
    ]);
    expect(report.compatibleUnits).toEqual([
      expect.objectContaining({
        bridgeUnitId: secondUnit.bridgeUnitId,
        sourceUnitKey: secondUnit.sourceUnitKey,
        status: "compatible",
      }),
    ]);
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
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [sourceIncompatibleFailureFixture()],
        failureCategories: ["source_incompatible"],
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
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [sourceIncompatibleFailureFixture()],
        failureCategories: ["source_incompatible"],
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
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [sourceIncompatibleFailureFixture()],
        failureCategories: ["source_incompatible"],
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
        adapterId: "kaifuu-reallive",
        status: "failed",
        failures: [
          {
            failureId: "019ed001-0000-7000-8000-00000000fa58",
            category: "patch_write_failed",
            diagnosticCode: "kaifuu.reallive.patchback_offset_overflow",
            cause: "apply_failed: offset would overflow during write",
            assetId: "019ed001-0000-7000-8000-000000000800",
            bridgeUnitId: "019ed001-0000-7000-8000-000000000201",
            adapterId: "kaifuu-reallive",
            command: "patch.write_string_slot",
          },
        ],
        failureCategories: ["patch_write_failed"],
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
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [sourceIncompatibleFailureFixture()],
        failureCategories: ["source_incompatible"],
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
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [sourceIncompatibleFailureFixture()],
        failureCategories: ["source_incompatible"],
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
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [sourceIncompatibleFailureFixture()],
        failureCategories: ["source_incompatible"],
        sourceCompatibility: compatibleWithReason,
      }),
    ).toThrow(/reason is only valid/);

    const bridgeUnitMismatchWithoutActual = cloneRecord(report);
    bridgeUnitMismatchWithoutActual.status = "incompatible";
    const mismatchCompatibleUnits = bridgeUnitMismatchWithoutActual.compatibleUnits as Array<
      Record<string, unknown>
    >;
    const mismatchUnit = asTestRecord(
      mismatchCompatibleUnits.shift(),
      "bridge unit mismatch compatibility unit",
    );
    mismatchUnit.status = "incompatible";
    mismatchUnit.reason = "bridge_unit_id_mismatch";
    bridgeUnitMismatchWithoutActual.incompatibleUnits = [mismatchUnit];
    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000959",
        patchExportId: patchExport.patchExportId,
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [sourceIncompatibleFailureFixture()],
        failureCategories: ["source_incompatible"],
        sourceCompatibility: bridgeUnitMismatchWithoutActual,
      }),
    ).toThrow(/actualBridgeUnitId is required/);

    const mismatchedBundleFlag = cloneRecord(report);
    mismatchedBundleFlag.sourceBundleHashMatches = false;
    expect(() =>
      assertPatchResultV02({
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-000000000955",
        patchExportId: patchExport.patchExportId,
        adapterId: "kaifuu-reallive",
        status: "incompatible_source",
        failures: [sourceIncompatibleFailureFixture()],
        failureCategories: ["source_incompatible"],
        sourceCompatibility: mismatchedBundleFlag,
      }),
    ).toThrow(/sourceBundleHashMatches/);
  });

  describe("PatchResultV02 v0.2 structured failures and partial-write accounting", () => {
    function invalidPatchResultFixture(name: string): Record<string, unknown> {
      return JSON.parse(
        readFileSync(new URL(`./examples/invalid/${name}`, import.meta.url), "utf8"),
      ) as Record<string, unknown>;
    }

    function helloGamePatchResultFixture(): Record<string, unknown> {
      return publicFixture("fixtures/hello-game/expected/patch-result-v0.2.fr-FR.json");
    }

    it("accepts the hello-game v0.2 patch result fixture with touched assets and rollup outputHash", () => {
      expect(() => assertPatchResultV02(helloGamePatchResultFixture())).not.toThrow();
    });

    it("rejects patch-result-v0.2-missing-failure-category fixture with the documented semantic code", () => {
      expect(() =>
        assertPatchResultV02(
          invalidPatchResultFixture("patch-result-v0.2-missing-failure-category.json"),
        ),
      ).toThrow(/kaifuu\.patch_result\.missing_failure_category/);
    });

    it("rejects patch-result-v0.2-output-hash-mismatch fixture with output_hash_drift", () => {
      expect(() =>
        assertPatchResultV02(
          invalidPatchResultFixture("patch-result-v0.2-output-hash-mismatch.json"),
        ),
      ).toThrow(/kaifuu\.patch_result\.output_hash_drift/);
    });

    it("rejects patch-result-v0.2-partial-write fixture with silent_partial_write", () => {
      expect(() =>
        assertPatchResultV02(invalidPatchResultFixture("patch-result-v0.2-partial-write.json")),
      ).toThrow(/kaifuu\.patch_result\.silent_partial_write/);
    });

    it("requires outputHash when status is passed", () => {
      const result = helloGamePatchResultFixture();
      delete result.outputHash;
      expect(() => assertPatchResultV02(result)).toThrow(
        /kaifuu\.patch_result\.passed_requires_output_hash/,
      );
    });

    it("requires touchedAssets when status is passed", () => {
      const result = helloGamePatchResultFixture();
      delete result.touchedAssets;
      expect(() => assertPatchResultV02(result)).toThrow(
        /kaifuu\.patch_result\.passed_requires_touched_assets/,
      );
    });

    it("rejects incompatible_source results with a non-source_incompatible failure", () => {
      const base = invalidPatchResultFixture("patch-result-v0.2-incompatible-status.json");
      const result = {
        ...base,
        status: "incompatible_source",
        failures: [
          {
            failureId: "019ed001-0000-7000-8000-00000000fa11",
            category: "patch_write_failed",
            diagnosticCode: "kaifuu.reallive.patchback_offset_overflow",
            cause: "wrong category for incompatible_source",
            assetId: "019ed001-0000-7000-8000-000000000800",
            bridgeUnitId: "019ed001-0000-7000-8000-000000000201",
            adapterId: "kaifuu-reallive",
            command: "patch.write_string_slot",
          },
        ],
        failureCategories: ["patch_write_failed"],
      };
      expect(() => assertPatchResultV02(result)).toThrow(
        /kaifuu\.patch_result\.incompatible_source_category_required/,
      );
    });

    it("rejects partialWrite without rollbackDiagnosticCode for non-retained dispositions", () => {
      const result = {
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-00000000fb01",
        patchExportId: "019ed001-0000-7000-8000-000000000901",
        adapterId: "kaifuu-reallive",
        status: "failed",
        failures: [
          {
            failureId: "019ed001-0000-7000-8000-00000000fb11",
            category: "patch_write_failed",
            diagnosticCode: "kaifuu.reallive.patchback_offset_overflow",
            cause: "offset overflow",
            assetId: "019ed001-0000-7000-8000-000000000810",
            bridgeUnitId: "019ed001-0000-7000-8000-000000000201",
            adapterId: "kaifuu-reallive",
            command: "patch.write_string_slot",
          },
        ],
        failureCategories: ["patch_write_failed"],
        partialWrite: {
          attemptedAssetIds: ["019ed001-0000-7000-8000-000000000810"],
          writtenAssetIds: [],
          skippedAssetIds: ["019ed001-0000-7000-8000-000000000810"],
          disposition: "rolled_back",
        },
      };
      expect(() => assertPatchResultV02(result)).toThrow(
        /kaifuu\.patch_result\.rollback_diagnostic_required/,
      );
    });

    it("accepts a partialWrite report with retained_partial disposition and no rollback diagnostic", () => {
      const result = {
        schemaVersion: "0.2.0",
        patchResultId: "019ed001-0000-7000-8000-00000000fb02",
        patchExportId: "019ed001-0000-7000-8000-000000000901",
        adapterId: "kaifuu-reallive",
        status: "failed",
        failures: [
          {
            failureId: "019ed001-0000-7000-8000-00000000fb22",
            category: "patch_write_failed",
            diagnosticCode: "kaifuu.reallive.patchback_offset_overflow",
            cause: "mid-write corruption could not be rolled back",
            assetId: "019ed001-0000-7000-8000-000000000810",
            bridgeUnitId: "019ed001-0000-7000-8000-000000000201",
            adapterId: "kaifuu-reallive",
            command: "patch.write_string_slot",
          },
        ],
        failureCategories: ["patch_write_failed"],
        partialWrite: {
          attemptedAssetIds: ["019ed001-0000-7000-8000-000000000810"],
          writtenAssetIds: ["019ed001-0000-7000-8000-000000000810"],
          skippedAssetIds: [],
          disposition: "retained_partial",
        },
      };
      expect(() => assertPatchResultV02(result)).not.toThrow();
    });

    it("rejects failureCategories that include an unobserved category", () => {
      const result = invalidPatchResultFixture("patch-result-v0.2-missing-failure-category.json");
      result.failureCategories = ["patch_write_failed", "adapter_unsupported"];
      expect(() => assertPatchResultV02(result)).toThrow(
        /kaifuu\.patch_result\.unknown_failure_category/,
      );
    });

    it("computes the rollup hash deterministically over sorted touched assets", () => {
      const assets = [
        {
          assetId: "019ed001-0000-7000-8000-0000000000aa",
          outputHash: "sha256:aa".padEnd(71, "a"),
          byteSize: 4,
        },
        {
          assetId: "019ed001-0000-7000-8000-0000000000ab",
          outputHash: "sha256:bb".padEnd(71, "b"),
          byteSize: 4,
        },
      ];
      const first = computePatchResultOutputHashRollupV02(assets);
      const second = computePatchResultOutputHashRollupV02([assets[1]!, assets[0]!]);
      expect(first).toBe(second);
      expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
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

  it("accepts the standalone v0.2 finding and local-user permission fixtures", () => {
    const finding = findingFixtureV02Example();
    const permission = permissionLocalUserFixtureV02Example();

    expect(() => assertFindingRecordFixtureV02(finding)).not.toThrow();
    expect(() => assertPermissionLocalUserFixtureV02(permission)).not.toThrow();
    expect(permission.grants).toContain("feedback.import");
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
    expect(report.runtimeCapabilities).toMatchObject({
      capabilityClass: "instrumented_runtime",
      evidenceTierCeiling: "E3",
    });
    expect(report.controlledPlaybackSession).toMatchObject({
      requestedOperation: "smoke_validation",
      evidenceTier: "E3",
    });

    const captures = report.captures as Array<Record<string, unknown>>;
    const firstCapture = asTestRecord(captures[0], "first runtime capture");
    const artifactRef = asTestRecord(firstCapture.artifactRef, "first capture artifact ref");
    expect(artifactRef.uri).toBe("artifacts/utsushi/hello/frame-0001.png");
    expect(artifactRef.uri).not.toMatch(/^artifacts\/utsushi\/runtime\//);
    expect(firstCapture).not.toHaveProperty("bytes");
    expect(firstCapture).not.toHaveProperty("data");
  });

  it("does not require the managed storage prefix for shared v0.2 runtime artifact refs", () => {
    const report = runtimeEvidenceV02Example();
    const captures = report.captures as Array<Record<string, unknown>>;
    const firstCapture = asTestRecord(captures[0], "first runtime capture");
    const artifactRef = asTestRecord(firstCapture.artifactRef, "first capture artifact ref");
    artifactRef.uri = "artifacts/utsushi/schema-fixture/frame-0001.png";

    expect(() => assertRuntimeEvidenceReportV02(report)).not.toThrow();
  });

  it("accepts typed observation hook events on v0.2 runtime evidence", () => {
    const report = runtimeEvidenceV02Example();
    report.observationHookEvents = [observationHookEventExample()];

    expect(() => assertRuntimeEvidenceReportV02(report)).not.toThrow();
  });

  it("rejects observation hook events without advertised instrumentation hook support", () => {
    const report = runtimeEvidenceV02Example();
    report.observationHookEvents = [observationHookEventExample()];
    const runtimeCapabilities = asTestRecord(
      report.runtimeCapabilities,
      "runtime capability contract",
    );
    const features = runtimeCapabilities.features as Array<Record<string, unknown>>;
    const hookFeature = asTestRecord(
      features.find((feature) => feature.feature === "instrumentation_hooks"),
      "instrumentation hooks feature",
    );
    hookFeature.status = "unsupported";
    delete hookFeature.evidenceTierCeiling;

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(
      /instrumentation_hooks capability/,
    );
  });

  it("rejects observation hook events with invalid observedAt timestamps", () => {
    const report = runtimeEvidenceV02Example();
    const event = observationHookEventExample();
    event.observedAt = "2026-02-30T00:00:00.000Z";
    report.observationHookEvents = [event];

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/observedAt/);
  });

  it("rejects observation hook events with blank redaction rules", () => {
    const report = runtimeEvidenceV02Example();
    const event = observationHookEventExample();
    event.redaction = {
      status: "redacted",
      rules: [" "],
      redactedFields: ["payload.text"],
    };
    report.observationHookEvents = [event];

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/redaction\.rules\[0\]/);
  });

  it("rejects observation hook events whose payload kind does not match eventKind", () => {
    const report = runtimeEvidenceV02Example();
    const event = observationHookEventExample();
    event.eventKind = "error";
    report.observationHookEvents = [event];

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/eventKind must match/);
  });

  it("accepts base controlled playback contracts without jump, snapshot, screenshot, or recording support", () => {
    const report = runtimeEvidenceV02Example();
    report.fidelityTier = "layout_probe";
    report.evidenceTier = "E2";
    report.branchEvents = [];
    report.recordings = [];
    report.runtimeCapabilities = {
      contractVersion: "0.2.0",
      capabilityClass: "launch_capture",
      fidelityTierCeiling: "layout_probe",
      evidenceTierCeiling: "E2",
      features: [
        {
          feature: "static_trace",
          status: "supported",
          evidenceTierCeiling: "E1",
          description: "Static trace.",
          limitations: [],
        },
        {
          feature: "text_trace",
          status: "supported",
          evidenceTierCeiling: "E1",
          description: "Text trace.",
          limitations: [],
        },
        {
          feature: "frame_capture",
          status: "partial",
          evidenceTierCeiling: "E2",
          description: "Capture metadata.",
          limitations: ["No live screenshot API."],
        },
        {
          feature: "jump",
          status: "unsupported",
          description: "Jump is not required.",
          limitations: [],
        },
        {
          feature: "snapshot",
          status: "unsupported",
          description: "Snapshot is not required.",
          limitations: [],
        },
        {
          feature: "screenshot",
          status: "unsupported",
          description: "Screenshot API is not required.",
          limitations: [],
        },
        {
          feature: "recording",
          status: "unsupported",
          description: "Recording is not required.",
          limitations: [],
        },
      ],
      limitations: ["Fixture-scoped launch/capture contract."],
    };
    report.controlledPlaybackSession = {
      sessionId: "019ed003-0000-7000-8000-000000000012",
      adapterName: "utsushi-contract-example",
      adapterVersion: "0.2.0",
      capabilityClass: "launch_capture",
      requestedOperation: "capture",
      status: "passed",
      fidelityTier: "layout_probe",
      evidenceTier: "E2",
      featuresUsed: ["static_trace", "text_trace", "frame_capture"],
      limitations: ["No jump, snapshot, screenshot API, or recording API."],
    };

    expect(() => assertRuntimeEvidenceReportV02(report)).not.toThrow();
  });

  it("rejects controlled playback sessions whose status diverges from report status", () => {
    const report = runtimeEvidenceV02Example();
    report.status = "failed";

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(
      /controlledPlaybackSession\.status must match RuntimeEvidenceReportV02\.status/,
    );
  });

  it("rejects trace-requested controlled playback sessions with capture evidence", () => {
    const report = runtimeEvidenceV02Example();
    const session = asTestRecord(report.controlledPlaybackSession, "controlled playback session");
    session.requestedOperation = "trace";
    report.branchEvents = [];
    report.recordings = [];

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(
      /requestedOperation trace must not carry capture evidence/,
    );
  });

  it("rejects runtime capability contracts that overclaim their class ceiling", () => {
    const report = runtimeEvidenceV02Example();
    const capabilities = asTestRecord(report.runtimeCapabilities, "runtime capability contract");
    capabilities.capabilityClass = "launch_capture";
    capabilities.evidenceTierCeiling = "E3";

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(
      /runtimeCapabilities\.fidelityTierCeiling/,
    );
  });

  it("rejects runtime evidence that uses a feature advertised as unsupported", () => {
    const report = runtimeEvidenceV02Example();
    const capabilities = asTestRecord(report.runtimeCapabilities, "runtime capability contract");
    const features = capabilities.features as Array<Record<string, unknown>>;
    const branchFeature = features.find((feature) => feature.feature === "branch_discovery");
    if (branchFeature === undefined) {
      throw new Error("test fixture missing branch_discovery feature");
    }
    branchFeature.status = "unsupported";
    delete branchFeature.evidenceTierCeiling;

    expect(() => assertRuntimeEvidenceReportV02(report)).toThrow(/branch_discovery capability/);
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
    ["URI scheme", "https://example.invalid/capture.png"],
    ["absolute POSIX path", "/tmp/runtime/frame.png"],
    ["current-directory dot segment", "./capture.png"],
    ["parent-directory dot segment", "../capture.png"],
    ["nested parent-directory dot segment", "artifacts/utsushi/../capture.png"],
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

  it("accepts a runtime evidence report referencing a conformance fixture via the existing reference comparison kind (UTSUSHI-026 smoke)", () => {
    // UTSUSHI-026 introduces the Rust-side ConformanceManifest/Result
    // contract but defers the TypeScript schema mirror to UTSUSHI-030.
    // This smoke test proves the existing bridge schema already
    // accommodates conformance reports through the
    // `conformance_fixture` reference comparison kind without any
    // schema change.
    const report = traceOnlyReferenceFidelityReport();
    report.referenceComparisons = [
      {
        comparisonId: "019ed003-0000-7000-8000-00000000e441",
        comparisonKind: "conformance_fixture",
        status: "passed",
        scope: "utsushi-synthetic text-trace profile",
        coveredBridgeUnitRefs: [
          {
            bridgeUnitId: "019ed001-0000-7000-8000-000000000201",
            sourceUnitKey: "script/prologue#line-001",
          },
        ],
        artifactRef: {
          artifactId: "019ed003-0000-7000-8000-00000000e451",
          artifactKind: "reference_comparison",
          uri: "artifacts/utsushi/runtime/synthetic-run/conformance-reports/text-trace-pass.json",
          hash: "sha256:9f19ff8b1b206d23c4df42dc35913c9fdb14d5ec4a85139d368c39942c197f51",
          mediaType: "application/json",
          byteSize: 2048,
        },
      },
    ];

    expect(() => assertRuntimeEvidenceReportV02(report)).not.toThrow();
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
