import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  scanStyleGuideFixtureArtifactPrivacyLeaks,
  STYLE_GUIDE_PRIVACY_PRIVATE_FIXTURE_PATH_RULE,
  STYLE_GUIDE_PRIVACY_RAW_PRIVATE_FIELD_RULE,
} from "@itotori/localization-bridge-schema";
import {
  StyleGuideFixtureFlowRerunError,
  styleGuideFixtureFlowSchemaVersion,
  type StyleGuideFixtureFlowResult,
} from "@itotori/db";
import { runItotoriCliCommand, type ItotoriCliServices } from "../src/cli-handlers.js";

// ITOTORI-138 — CLI output privacy scan. The `style-guide-fixture-flow`
// command writes a persisted `StyleGuideFixtureFlowResult` artifact to disk.
// That output MUST NOT leak raw provider responses, raw HTTP bodies, or
// fixtures/private-local paths — it carries only record ids, counts, the
// dashboard view, and outbox event ids. The scan guard below catches a leak
// injected into the CLI output with a finding naming the exact field path.
describe("style-guide-fixture-flow CLI output privacy", () => {
  it("writes a fixture-flow result that scans clean for privacy leaks", async () => {
    const services = servicesFixture();
    const fixture = styleGuideConversationFixture();
    const reads = new Map<string, unknown>([
      ["fixtures/itotori-style-guide/conversations/accepted.json", fixture],
    ]);
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(["style-guide-fixture-flow"], {
      io: jsonStoreFixture(reads, writes),
      migrateDatabase: vi.fn(async () => {}),
      withServices: async (callback) => await callback(services),
    });

    const output = writes.get("artifacts/itotori/style-guide-fixture-flow.json");
    expect(output).toBeDefined();
    expect(scanStyleGuideFixtureArtifactPrivacyLeaks(output)).toEqual([]);
  });

  it.each([
    {
      leak: "raw provider completion nested in the result",
      mutate: (result: StyleGuideFixtureFlowResult) => {
        (result as Record<string, unknown>).completionText =
          "leaked raw provider completion payload";
      },
      rule: STYLE_GUIDE_PRIVACY_RAW_PRIVATE_FIELD_RULE,
      field: "$.completionText",
    },
    {
      leak: "raw HTTP response body nested under the dashboard view",
      mutate: (result: StyleGuideFixtureFlowResult) => {
        (result.dashboard as Record<string, unknown>).responseBody =
          '{"choices":[{"message":{"content":"leaked"}}]}';
      },
      rule: STYLE_GUIDE_PRIVACY_RAW_PRIVATE_FIELD_RULE,
      field: "$.dashboard.responseBody",
    },
    {
      leak: "fixtures/private-local reference in an outbox affected surface",
      mutate: (result: StyleGuideFixtureFlowResult) => {
        result.outbox.affectedSurfaces.push("fixtures/private-local/secret-style-evidence.json");
      },
      rule: STYLE_GUIDE_PRIVACY_PRIVATE_FIXTURE_PATH_RULE,
      field: "$.outbox.affectedSurfaces[4]",
    },
  ])(
    "the privacy scan catches a leaked $leak injected into the CLI output",
    ({ mutate, rule, field }) => {
      const result = cleanStyleGuideFixtureFlowResult();
      mutate(result);

      const leaks = scanStyleGuideFixtureArtifactPrivacyLeaks(result);

      expect(leaks).toContainEqual(
        expect.objectContaining({
          rule,
          field,
        }),
      );
    },
  );

  it("the privacy scan catches every forbidden raw-private field name in CLI output", () => {
    const forbiddenKeys = [
      "completionText",
      "completion_text",
      "privateText",
      "private_text",
      "promptText",
      "prompt_text",
      "rawContent",
      "raw_content",
      "rawPrivateData",
      "raw_private_data",
      "rawText",
      "raw_text",
      "requestBody",
      "request_body",
      "responseBody",
      "response_body",
    ];
    for (const forbiddenKey of forbiddenKeys) {
      const result = cleanStyleGuideFixtureFlowResult();
      (result as Record<string, unknown>)[forbiddenKey] = "leaked-private-payload";

      const leaks = scanStyleGuideFixtureArtifactPrivacyLeaks(result);

      expect(
        leaks.some(
          (leak) =>
            leak.rule === STYLE_GUIDE_PRIVACY_RAW_PRIVATE_FIELD_RULE &&
            leak.field === `$.${forbiddenKey}`,
        ),
        `forbidden raw-private key ${forbiddenKey} must be caught in CLI output`,
      ).toBe(true);
    }
  });

  it("does not surface private payload on stderr when a fixture-flow rerun is rejected", async () => {
    // The rerun-rejection diagnostic path writes a typed message to stderr.
    // Pin that the emitted stderr carries ONLY the typed code + the public
    // style-guide version id — never a raw provider response or a
    // fixtures/private-local reference.
    const services = servicesFixture();
    const rerunError = new StyleGuideFixtureFlowRerunError({
      projectId: "019ed063-0000-7000-8000-000000000001",
      localeBranchId: "019ed063-0000-7000-8000-000000000010",
      fixtureId: "style-guide-conversation-accepted",
      existingLatestVersionId: "019ed063-0000-7000-8000-000000000030",
    });
    services.styleGuideFixtureFlow.run = vi.fn(async () => {
      throw rerunError;
    });
    const fixture = styleGuideConversationFixture();
    const reads = new Map<string, unknown>([
      ["fixtures/itotori-style-guide/conversations/accepted.json", fixture],
    ]);
    const writes = new Map<string, unknown>();

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const priorExitCode = process.exitCode;
    try {
      await runItotoriCliCommand(["style-guide-fixture-flow"], {
        io: jsonStoreFixture(reads, writes),
        migrateDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(services),
      });

      const emitted = stderr.mock.calls.map((call) => String(call[0])).join("");
      expect(emitted).toContain(rerunError.code);
      expect(emitted).toContain("019ed063-0000-7000-8000-000000000030");
      // No artifact is written when the rerun is rejected.
      expect(writes.has("artifacts/itotori/style-guide-fixture-flow.json")).toBe(false);
      // The emitted stderr must not leak any forbidden payload.
      expect(scanStyleGuideFixtureArtifactPrivacyLeaks({ stderr: emitted })).toEqual([]);
    } finally {
      stderr.mockRestore();
      process.exitCode = priorExitCode;
    }
  });
});

function jsonStoreFixture(reads: Map<string, unknown>, writes: Map<string, unknown>) {
  return {
    readJson: vi.fn((path: string) => reads.get(path)),
    writeJson: vi.fn((path: string, value: unknown) => {
      writes.set(path, value);
    }),
  };
}

function servicesFixture(): ItotoriCliServices {
  return {
    projectWorkflow: {
      reset: vi.fn(async () => {}),
      getDashboardStatus: vi.fn(async () => ({
        selectedLocaleBranchId: null,
        currentStyleGuidePolicyVersionId: null,
        branchCount: 0,
        artifactCount: 0,
        localeBranches: [],
        importStatus: { status: "idle" },
      })),
      getDashboardDecisions: vi.fn(async () => []),
      getCostReport: vi.fn(async () => ({ totals: { systemCount: 0, findingCount: 0 } })),
      getCostDrilldown: vi.fn(async () => ({ rows: [] })),
      getBenchmarkReports: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => ({
        finalStatus: "idle",
        runtimeRunId: null,
        runtimeReportId: null,
        runtimeStatus: "idle",
        fidelityTier: null,
        evidenceTier: null,
        textEventCount: 0,
        frameCaptureCount: 0,
        screenshotArtifactCount: 0,
        recordingArtifactCount: 0,
        validationFindingCount: 0,
        traceEvents: [],
        findings: [],
        artifacts: [],
        approximations: [],
        unsupportedCapabilities: [],
        limitations: [],
      })),
      importBridge: vi.fn(async () => ({
        projectId: "project-1",
        localeBranchId: "locale-1",
        targetLocale: "en-US",
        drafts: {},
        importStatus: { status: "idle" },
        bridge: {
          schemaVersion: "0.1.0",
          bridgeId: "bridge-1",
          sourceBundleHash: "hash-1",
          sourceLocale: "ja-JP",
          extractorName: "kaifuu-fixture",
          extractorVersion: "0.0.0",
          units: [],
        },
      })),
      draftProject: vi.fn(async (project) => project),
      ingestRuntimeReport: vi.fn(async (project) => ({ project, result: {} })),
      ingestPatchResult: vi.fn(async (project) => ({ project, result: {} })),
      ingestConformanceReport: vi.fn(async (project) => ({ project, result: {} })),
      recordFinding: vi.fn(async () => ({ findingId: "finding-1", status: "open" })),
      recordDecision: vi.fn(async () => ({
        decisionId: "decision-1",
        eventKind: "triage_decision_recorded",
        recorded: true,
      })),
      recordBenchmarkReport: vi.fn(async () => ({
        benchmarkRunId: "benchmark-1",
        artifactId: "benchmark-1",
        status: "passed",
        systemCount: 0,
        findingCount: 0,
      })),
    },
    manualFeedback: {
      importManualFeedback: vi.fn(async () => ({ accepted: 0, rejected: [] })),
    },
    draftFeedbackBatch: {
      submitBatch: vi.fn(async () => ({
        batchId: "draft-feedback-batch-fixture",
        submittedCount: 0,
        items: [],
        repairCandidateReportIds: [],
        decisionQueueReportIds: [],
        affectedBridgeUnitIds: [],
      })),
    },
    catalogExactExternalIdLinker: {
      linkExactExternalIds: vi.fn(async () => ({ linked: [], rejected: [] })),
    },
    catalogFuzzyCandidateGenerator: {
      generateFuzzyCandidates: vi.fn(async () => ({ candidates: [] })),
      listCatalogCandidateMatches: vi.fn(async () => []),
    },
    styleGuideFixtureFlow: {
      run: vi.fn(async () => cleanStyleGuideFixtureFlowResult()),
    },
    batchPlanner: {
      loadContext: vi.fn(async () => ({
        sourceRevisionId: "bridge-1:bundle-revision",
        glossary: [],
      })),
      persist: vi.fn(async () => {}),
    },
  };
}

function styleGuideConversationFixture(): unknown {
  return JSON.parse(
    readFileSync(
      new URL("../../../fixtures/itotori-style-guide/conversations/accepted.json", import.meta.url),
      "utf8",
    ),
  );
}

function cleanStyleGuideFixtureFlowResult(): StyleGuideFixtureFlowResult {
  return {
    schemaVersion: styleGuideFixtureFlowSchemaVersion,
    fixtureId: "style-guide-conversation-accepted",
    projectId: "019ed063-0000-7000-8000-000000000001",
    localeBranchId: "019ed063-0000-7000-8000-000000000010",
    baseStyleGuideVersionId: "019ed063-0000-7000-8000-000000000020",
    projectedStyleGuideVersionId: "019ed063-0000-7000-8000-000000000030",
    suggestionArtifactId: "style-guide-suggestions:style-guide-conversation-accepted",
    acceptedProposalIds: [
      "019ed063-0000-7000-8000-000000000201",
      "019ed063-0000-7000-8000-000000000202",
      "019ed063-0000-7000-8000-000000000203",
      "019ed063-0000-7000-8000-000000000204",
      "019ed063-0000-7000-8000-000000000205",
    ],
    policyRuleCounts: {
      tone: 1,
      terminology: 1,
      honorifics: 1,
      formatting: 1,
      protectedSpans: 1,
    },
    dashboard: {
      selectedLocaleBranchId: "019ed063-0000-7000-8000-000000000010",
      currentStyleGuidePolicyVersionId: "019ed063-0000-7000-8000-000000000030",
      branchCount: 1,
      artifactCount: 3,
      localeBranches: [],
    },
    outbox: {
      styleGuideVersionChangedEventIds: ["event-1", "event-2", "event-3", "event-4"],
      affectedWorkInvalidatedEventIds: ["event-5", "event-6", "event-7", "event-8"],
      affectedSurfaces: ["drafts", "qa_findings", "exports", "benchmarks"],
    },
  };
}
