import { readFileSync } from "node:fs";
import {
  type AuthorizationActor,
  type CatalogExactExternalIdLinkRequest,
  type CatalogExactExternalIdLinkResult,
  type CatalogFuzzyCandidateRequest,
  type CatalogFuzzyCandidateResult,
  type CatalogResolverFixtureInput,
  catalogFuzzyCandidateDiagnosticCodeValues,
  catalogResolverFixtureDiagnosticCodeValues,
  catalogExactExternalIdLinkStatusValues,
  catalogExactExternalIdLinkSchemaVersion,
  catalogFuzzyCandidateSchemaVersion,
  catalogFuzzyCandidateStatusValues,
  ItotoriCatalogFuzzyCandidateGeneratorService,
  type DashboardDecisionReadModel,
  feedbackTypeValues,
  type ManualFeedbackImportInput,
  type ManualFeedbackImportResult,
  type ProjectCostReport,
  type ProjectDashboardStatus,
} from "@itotori/db";
import type { BridgeBundle, BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import { describe, expect, it, vi } from "vitest";
import { runItotoriCliCommand, type ItotoriCliServices } from "../src/cli-handlers.js";
import { ManualFeedbackImportService } from "../src/manual-feedback.js";
import type { ProjectState } from "../src/services/project-workflow.js";

describe("itotori scaffold", () => {
  it("keeps the hello world translation deterministic", () => {
    expect("こんにちは、{player}。".includes("{player}")).toBe(true);
  });
});

describe("ManualFeedbackImportService", () => {
  it("rejects malformed manual feedback JSON before repository import", async () => {
    const importManualFeedback = vi.fn<
      [AuthorizationActor, ManualFeedbackImportInput],
      Promise<ManualFeedbackImportResult>
    >();
    const service = new ManualFeedbackImportService({ importManualFeedback });

    await expect(
      service.importManualFeedback({
        projectId: "project-test",
        targetLocale: "en-US",
        feedbackType: feedbackTypeValues.stylePreference,
        reporter: { role: "playtester" },
        reporterNote: 123,
      }),
    ).rejects.toThrow("manual feedback reporterNote must be a string");

    expect(importManualFeedback).not.toHaveBeenCalled();
  });
});

describe("Itotori CLI handlers", () => {
  it("writes dashboard status from the shared project service", async () => {
    const services = servicesFixture();
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(["dashboard-status", "--output", "status.json"], {
      io: jsonStoreFixture(new Map(), writes),
      migrateDatabase: vi.fn(async () => {}),
      withServices: async (callback) => await callback(services),
    });

    expect(services.projectWorkflow.getDashboardStatus).toHaveBeenCalledTimes(1);
    expect(writes.get("status.json")).toEqual(dashboardStatusFixture);
  });

  it("validates bridge input before calling the import service", async () => {
    const services = servicesFixture();
    const reads = new Map<string, unknown>([["bridge.json", { schemaVersion: "bad" }]]);

    await expect(
      runItotoriCliCommand(["import", "--bridge", "bridge.json", "--project", "project.json"], {
        io: jsonStoreFixture(reads, new Map()),
        migrateDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(services),
      }),
    ).rejects.toThrow("BridgeBundle.schemaVersion");

    expect(services.projectWorkflow.importBridge).not.toHaveBeenCalled();
  });

  it("writes imported project JSON with bridge import status", async () => {
    const services = servicesFixture();
    const bridge = projectFixture().bridge;
    const reads = new Map<string, unknown>([["bridge.json", bridge]]);
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(["import", "--bridge", "bridge.json", "--project", "project.json"], {
      io: jsonStoreFixture(reads, writes),
      migrateDatabase: vi.fn(async () => {}),
      withServices: async (callback) => await callback(services),
    });

    expect(services.projectWorkflow.importBridge).toHaveBeenCalledWith(bridge);
    expect(writes.get("project.json")).toMatchObject({
      projectId: "project-1",
      importStatus: dashboardStatusFixture.importStatus,
    });
  });

  it("accepts v0.2 bridge input before calling the import service", async () => {
    const services = servicesFixture();
    const bridge = bridgeV02Fixture();
    const reads = new Map<string, unknown>([["bridge.json", bridge]]);
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(["import", "--bridge", "bridge.json", "--project", "project.json"], {
      io: jsonStoreFixture(reads, writes),
      migrateDatabase: vi.fn(async () => {}),
      withServices: async (callback) => await callback(services),
    });

    expect(services.projectWorkflow.importBridge).toHaveBeenCalledWith(bridge);
    expect(writes.get("project.json")).toMatchObject({
      projectId: "project-1",
      importStatus: dashboardStatusFixture.importStatus,
    });
  });

  it("imports manual feedback through the feedback service", async () => {
    const services = servicesFixture();
    const feedback = {
      projectId: "project-1",
      targetLocale: "en-US",
      feedbackType: feedbackTypeValues.stylePreference,
      reporter: { role: "playtester" },
      reporterNote: "Tone is too formal.",
    };
    const reads = new Map<string, unknown>([["feedback.json", feedback]]);
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(
      ["import-feedback", "--feedback", "feedback.json", "--output", "feedback-result.json"],
      {
        io: jsonStoreFixture(reads, writes),
        migrateDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(services),
      },
    );

    expect(services.manualFeedback.importManualFeedback).toHaveBeenCalledWith(feedback);
    expect(writes.get("feedback-result.json")).toEqual(manualFeedbackResultFixture);
  });

  it("writes exact catalog external-id link results from fixture requests", async () => {
    const services = servicesFixture();
    const reads = new Map<string, unknown>([
      ["catalog-link-request.json", exactLinkRequestFixture],
    ]);
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(
      [
        "catalog-link-exact",
        "--request",
        "catalog-link-request.json",
        "--output",
        "catalog-link-result.json",
      ],
      {
        io: jsonStoreFixture(reads, writes),
        migrateDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(services),
      },
    );

    expect(services.catalogExactExternalIdLinker.linkExactExternalIds).toHaveBeenCalledWith(
      exactLinkRequestFixture,
    );
    expect(writes.get("catalog-link-result.json")).toEqual(exactLinkResultFixture);
  });

  it("writes fuzzy catalog candidates from fixture requests", async () => {
    const services = servicesFixture();
    const reads = new Map<string, unknown>([
      ["catalog-fuzzy-request.json", fuzzyCandidateRequestFixture],
    ]);
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(
      [
        "catalog-fuzzy-candidates",
        "--request",
        "catalog-fuzzy-request.json",
        "--output",
        "catalog-fuzzy-result.json",
      ],
      {
        io: jsonStoreFixture(reads, writes),
        migrateDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(services),
      },
    );

    expect(services.catalogFuzzyCandidateGenerator.generateFuzzyCandidates).toHaveBeenCalledWith(
      fuzzyCandidateRequestFixture,
    );
    expect(writes.get("catalog-fuzzy-result.json")).toEqual(fuzzyCandidateResultFixture);
  });

  it("writes structured fuzzy invalid diagnostics for malformed JSON input", async () => {
    const services = servicesFixture();
    const repository = {
      getWorkByExternalId: vi.fn(),
      listCatalogCandidateTargetWorks: vi.fn(),
      recordCatalogCandidateMatch: vi.fn(),
      listCatalogCandidateMatches: vi.fn(),
    };
    services.catalogFuzzyCandidateGenerator = new ItotoriCatalogFuzzyCandidateGeneratorService(
      repository,
      { userId: "local-user" },
    );
    const reads = new Map<string, unknown>([
      [
        "catalog-fuzzy-request.json",
        {
          schemaVersion: catalogFuzzyCandidateSchemaVersion,
          sourceFacts: [
            {
              catalogSource: "egs",
              sourceId: "egs-malformed-001",
              title: "Moonlight Refrain",
              externalIds: [null],
            },
          ],
        },
      ],
    ]);
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(
      [
        "catalog-fuzzy-candidates",
        "--request",
        "catalog-fuzzy-request.json",
        "--output",
        "catalog-fuzzy-result.json",
      ],
      {
        io: jsonStoreFixture(reads, writes),
        migrateDatabase: vi.fn(async () => {}),
        withServices: async (callback) => await callback(services),
      },
    );

    expect(writes.get("catalog-fuzzy-result.json")).toEqual(
      expect.objectContaining({
        status: catalogFuzzyCandidateStatusValues.invalid,
        candidates: [],
        diagnostics: [
          expect.objectContaining({
            code: catalogFuzzyCandidateDiagnosticCodeValues.invalidRequest,
            field: "externalIds",
            reasonCode: "invalid_external_id",
          }),
        ],
      }),
    );
    expect(repository.listCatalogCandidateTargetWorks).not.toHaveBeenCalled();
    expect(repository.recordCatalogCandidateMatch).not.toHaveBeenCalled();
  });

  it("writes the combined catalog resolver fixture artifact without database services", async () => {
    const services = servicesFixture();
    const reads = new Map<string, unknown>([["fixtures/catalog-resolver/fixture.json", resolverFixture]]);
    const writes = new Map<string, unknown>();

    await runItotoriCliCommand(["catalog-resolve-fixture"], {
      io: jsonStoreFixture(reads, writes),
      migrateDatabase: vi.fn(async () => {}),
      withServices: async (callback) => await callback(services),
    });

    expect(services.catalogExactExternalIdLinker.linkExactExternalIds).not.toHaveBeenCalled();
    expect(services.catalogFuzzyCandidateGenerator.generateFuzzyCandidates).not.toHaveBeenCalled();
    expect(writes.get("artifacts/catalog/resolver-integration.json")).toMatchObject({
      schemaVersion: "catalog.resolver_fixture.v0.1",
      artifactId: "catalog-resolver-integration-001",
      review: {
        exactLinkIds: ["exact-link:dlsite:RJ349517", "exact-link:dlsite:rj-no-match"],
        exactLinkedWorkIds: ["work-dlsite"],
        fuzzyCandidateIds: ["candidate:egs-moonlight-001:work-moonlight-hd"],
        conflictIds: ["catalog-conflict:manual-duplicate-external-id"],
      },
      diagnostics: [
        expect.objectContaining({
          code: catalogResolverFixtureDiagnosticCodeValues.unsupportedSourcePayload,
        }),
        expect.objectContaining({
          code: "catalog.resolver_fixture.no_match",
          exactLinkId: "exact-link:dlsite:rj-no-match",
        }),
      ],
    });
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
      getDashboardStatus: vi.fn(async () => dashboardStatusFixture),
      getDashboardDecisions: vi.fn(async () => dashboardDecisionsFixture),
      getCostReport: vi.fn(async () => costReportFixture),
      getRuntimeStatus: vi.fn(async () => ({
        finalStatus: "hello_world_passed",
        runtimeReportId: "runtime-1",
        runtimeStatus: "passed",
        fidelityTier: "layout_probe",
        evidenceTier: null,
        textEventCount: 1,
        frameCaptureCount: 1,
        screenshotArtifactCount: 1,
        recordingArtifactCount: 0,
        validationFindingCount: 0,
      })),
      importBridge: vi.fn(async (_bridge: BridgeBundle | BridgeBundleV02) => projectFixture()),
      draftProject: vi.fn(async (project: ProjectState) => project),
      exportPatch: vi.fn(async (project: ProjectState) => ({
        project,
        patchExport: {
          schemaVersion: "0.1.0",
          patchExportId: "patch-1",
          sourceBridgeId: project.bridge.bridgeId,
          sourceBundleHash: project.bridge.sourceBundleHash,
          sourceLocale: project.bridge.sourceLocale,
          targetLocale: project.targetLocale,
          entries: [],
        },
      })),
      ingestRuntimeReport: vi.fn(async (project: ProjectState) => ({
        project,
        result: {
          status: "hello_world_passed",
          bridgeId: project.bridge.bridgeId,
          localeBranchId: project.localeBranchId,
          patchExportId: project.patchExport?.patchExportId,
          patchResultId: "patch-result-1",
          runtimeReportId: "runtime-1",
          dashboard: dashboardStatusFixture,
        },
      })),
      recordFinding: vi.fn(async () => ({ findingId: "finding-1", status: "open" })),
      recordDecision: vi.fn(async () => ({
        decisionId: "019ed004-0000-7000-8000-000000000201",
        eventKind: "triage_decision_recorded",
        recorded: true,
      })),
      recordBenchmarkReport: vi.fn(async () => ({
        benchmarkRunId: "019ed006-0000-7000-8000-00000000f001",
        artifactId: "019ed006-0000-7000-8000-00000000f001",
        status: "passed",
        systemCount: 1,
        findingCount: 0,
      })),
    },
    manualFeedback: {
      importManualFeedback: vi.fn(async () => manualFeedbackResultFixture),
    },
    catalogExactExternalIdLinker: {
      linkExactExternalIds: vi.fn(async () => exactLinkResultFixture),
    },
    catalogFuzzyCandidateGenerator: {
      generateFuzzyCandidates: vi.fn(async () => fuzzyCandidateResultFixture),
      listCatalogCandidateMatches: vi.fn(async () => fuzzyCandidateResultFixture.candidates),
    },
  };
}

function projectFixture(): ProjectState {
  return {
    projectId: "project-1",
    localeBranchId: "locale-1",
    targetLocale: "en-US",
    drafts: {},
    importStatus: dashboardStatusFixture.importStatus,
    bridge: {
      schemaVersion: "0.1.0",
      bridgeId: "bridge-1",
      sourceBundleHash: "hash-1",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: [],
    },
  };
}

function bridgeV02Fixture(): BridgeBundleV02 {
  return JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/localization-bridge-schema/test/examples/bridge-v0.2.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as BridgeBundleV02;
}

const costReportFixture: ProjectCostReport = {
  projectId: "project-1",
  currency: "USD",
  runCount: 0,
  billedMicrosUsd: 0,
  estimatedMicrosUsd: 0,
  zeroRunCount: 0,
  unknownRunCount: 0,
  includesUnknownCost: false,
  totalsByCostKind: ["billed", "provider_estimate", "local_estimate", "zero", "unknown"].map(
    (costKind) => ({
      costKind: costKind as ProjectCostReport["totalsByCostKind"][number]["costKind"],
      runCount: 0,
      amountMicrosUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    }),
  ),
  recentRuns: [],
};

const dashboardStatusFixture: ProjectDashboardStatus = {
  projectId: "project-1",
  projectKey: "project-1",
  name: "project-1",
  status: "runtime_ingested",
  sourceLocale: "ja-JP",
  sourceBundleId: "bridge-1",
  sourceBundleHash: "hash-1",
  sourceBundleRevisionId: "revision-1",
  branchCount: 1,
  unitCount: 1,
  findingCount: 0,
  artifactCount: 3,
  latestEventKind: "patch_result_recorded",
  latestEventAt: "2026-06-17T00:00:00.000Z",
  importStatus: {
    bridgeImportId: "bridge-import:project-1:bridge-1:revision-1",
    projectId: "project-1",
    bridgeId: "bridge-1",
    sourceBundleId: "bridge-1",
    sourceBundleHash: "hash-1",
    sourceBundleRevisionId: "revision-1",
    schemaVersion: "0.1.0",
    sourceLocale: "ja-JP",
    importedAt: "2026-06-17T00:00:00.000Z",
    unitCount: 1,
    assetCount: 1,
    sourceRevisionCount: 4,
    validationFailureCount: 0,
    units: { added: 1, updated: 0, removed: 0, unchanged: 0 },
    assets: { added: 1, updated: 0, removed: 0, unchanged: 0 },
    sourceRevisions: { added: 4, existing: 0 },
    futureReferences: {
      catalogWorkId: null,
      localCorpusEntryId: null,
      readinessProfileId: null,
      completenessStatusId: null,
    },
  },
  cost: costReportFixture,
  localeBranches: [],
};

const dashboardDecisionsFixture: DashboardDecisionReadModel = {
  projectId: "project-1",
  counts: {
    pendingDecisionCount: 0,
    projectFindingDecisionCount: 0,
    localeBranchFindingDecisionCount: 0,
    runtimeValidationDecisionCount: 0,
  },
  pendingDecisions: [],
};

const manualFeedbackResultFixture: ManualFeedbackImportResult = {
  feedbackReportId: "feedback-1",
  feedbackEvidenceId: "evidence-1",
  feedbackSourceId: "source-1",
  dedupeKey: "dedupe-1",
  triageLabel: "style_dispute_candidate",
  reportStatus: "open",
  contextStatus: "contextualized",
  reportCount: 1,
  duplicate: false,
};

const exactLinkRequestFixture: CatalogExactExternalIdLinkRequest = {
  schemaVersion: catalogExactExternalIdLinkSchemaVersion,
  subject: {
    kind: "fixture",
    id: "catalog-008-exact-match",
  },
  externalIds: [
    {
      catalogSource: "dlsite",
      sourceId: "RJ349517",
      externalIdKind: "store_product",
    },
  ],
};

const exactLinkResultFixture: CatalogExactExternalIdLinkResult = {
  schemaVersion: catalogExactExternalIdLinkSchemaVersion,
  status: catalogExactExternalIdLinkStatusValues.linked,
  subject: {
    kind: "fixture",
    id: "catalog-008-exact-match",
  },
  workId: "work-dlsite",
  matches: [
    {
      inputIndex: 0,
      catalogSource: "dlsite",
      sourceId: "RJ349517",
      externalIdKind: "store_product",
      workId: "work-dlsite",
      canonicalTitle: "DLsite-only fixture",
    },
  ],
  diagnostics: [],
};

const fuzzyCandidateRequestFixture: CatalogFuzzyCandidateRequest = {
  schemaVersion: catalogFuzzyCandidateSchemaVersion,
  sourceFacts: [
    {
      catalogSource: "egs",
      sourceId: "egs-777",
      title: "Moonlight Refrain",
      releaseYear: 2021,
    },
  ],
};

const fuzzyCandidateResultFixture: CatalogFuzzyCandidateResult = {
  schemaVersion: catalogFuzzyCandidateSchemaVersion,
  generatorVersion: "deterministic-title-year.v0.1",
  status: catalogFuzzyCandidateStatusValues.generated,
  candidates: [
    {
      candidateId: "candidate-1",
      sourceCatalogSource: "egs",
      sourceId: "egs-777",
      sourceTitle: "Moonlight Refrain",
      sourceProvenanceId: null,
      targetWorkId: "work-moonlight",
      score: 820,
      matchedFields: {},
      status: "review_pending",
      diagnosticCode: "catalog.fuzzy_candidate.generated",
      generatorVersion: "deterministic-title-year.v0.1",
      metadata: { autoMerge: false },
      createdAt: new Date("2026-06-18T00:00:00.000Z"),
      updatedAt: new Date("2026-06-18T00:00:00.000Z"),
    },
  ],
  diagnostics: [],
};

const resolverFixture: CatalogResolverFixtureInput = {
  schemaVersion: "catalog.resolver_fixture.v0.1",
  artifactId: "catalog-resolver-integration-001",
  generatedAt: "2026-06-18T18:00:00.000Z",
  sourceRegistry: [
    {
      sourceRegistryId: "source-registry:dlsite:RJ349517",
      catalogSource: "dlsite",
      sourceId: "RJ349517",
      sourceRecordKind: "recorded_fixture",
      payloadHash: "sha256:payload",
      provenanceHash: "sha256:provenance",
      payloadSchemaVersion: "catalog-source-fixture.v0.1",
      payloadShape: "catalog_source_record",
    },
    {
      sourceRegistryId: "source-registry:unsupported:legacy-payload",
      catalogSource: "steam",
      sourceId: "legacy-payload",
      sourceRecordKind: "recorded_fixture",
      payloadHash: "sha256:unsupported",
      provenanceHash: "sha256:unsupported-provenance",
      payloadSchemaVersion: "legacy-source.v0",
      payloadShape: "legacy_unstructured_dump",
    },
  ],
  exactLinks: [
    {
      exactLinkId: "exact-link:dlsite:RJ349517",
      result: exactLinkResultFixture,
    },
    {
      exactLinkId: "exact-link:dlsite:rj-no-match",
      result: {
        schemaVersion: catalogExactExternalIdLinkSchemaVersion,
        status: "no_match",
        subject: { kind: "fixture", id: "catalog-resolver-no-match" },
        workId: null,
        matches: [],
        diagnostics: [
          {
            code: "catalog.exact_external_id.no_match",
            severity: "info",
            message: "No catalog work has an exact external-id match.",
          },
        ],
      },
    },
  ],
  fuzzyCandidates: {
    ...fuzzyCandidateResultFixture,
    candidates: [
      {
        ...fuzzyCandidateResultFixture.candidates[0],
        candidateId: "candidate:egs-moonlight-001:work-moonlight-hd",
      },
    ],
  },
  conflicts: {
    rows: [
      {
        reviewId: "catalog-conflict:manual-duplicate-external-id",
        catalogRecordId: "work-conflict-a",
        conflictId: "manual-duplicate-external-id",
        candidateIds: [],
        candidateCatalogIds: ["work-conflict-a", "work-conflict-b"],
        exactLinkRefs: [],
        fuzzyScores: [],
        sourceIds: [{ catalogSource: "dlsite", sourceId: "RJCAT010" }],
        provenance: [],
        severity: "error",
        status: "open",
        reasonCode: "duplicate_external_id",
        reasonDetail: "Manual review required.",
        conflictKind: "external_id",
        detectedAt: new Date("2026-06-18T18:00:00.000Z"),
        resolution: null,
      },
    ],
  },
};
